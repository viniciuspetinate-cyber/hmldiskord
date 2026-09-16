(function(){
  'use strict';

  // Transporte de tela pelo Cloudflare Realtime SFU. O segredo do aplicativo
  // permanece no Worker; o navegador envia apenas a sessão já criada no login.
  class ScreenSFU {
    constructor(options){
      this.endpoint = options.endpoint.replace(/\/$/, '');
      this.token = options.token;
      this.room = options.room;
      this.iceServers = options.iceServers || [{urls:'stun:stun.cloudflare.com:3478'}];
      this.onState = options.onState || function(){};
      this.controller = new AbortController();
      this.closed = false;
    }

    async request(path, body, closing){
      const token = typeof this.token === 'function' ? this.token() : this.token;
      if (!token) throw new Error('Sessão de login indisponível.');
      const timeout = AbortSignal.timeout(9000);
      const signal = closing ? AbortSignal.timeout(10000) : AbortSignal.any([this.controller.signal, timeout]);
      const response = await fetch(this.endpoint + path, {
        method:'POST',
        headers:{'Content-Type':'application/json', Authorization:'Bearer ' + token},
        body:JSON.stringify(body),
        signal
      });
      const data = await response.json().catch(function(){ return {}; });
      if (!response.ok) throw new Error(data.error || 'SFU HTTP ' + response.status);
      return data;
    }

    async open(role){
      if (this.closed || this.pc) throw new Error('Transporte SFU já utilizado.');
      this.pc = new RTCPeerConnection({iceServers:this.iceServers,bundlePolicy:'max-bundle'});
      this.pc.addEventListener('connectionstatechange', () => this.onState(this.pc.connectionState));
      this.session = await this.request('/v1/sessions', {role,room:this.room});
      if (this.closed) throw new Error('Transporte SFU encerrado.');
    }

    async negotiate(data){
      if (!data.sessionDescription) return;
      await this.pc.setRemoteDescription(data.sessionDescription);
      if (data.sessionDescription.type === 'offer'){
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await this.request('/v1/renegotiate', {
          capability:this.session.capability,
          sessionDescription:this.pc.localDescription.toJSON()
        });
      }
    }

    waitForConnected(timeoutMs){
      if (['connected','completed'].includes(this.pc.iceConnectionState)) return Promise.resolve();
      return new Promise((resolve,reject) => {
        const finish = error => {
          clearTimeout(timer);
          this.pc.removeEventListener('iceconnectionstatechange', changed);
          this.pc.removeEventListener('connectionstatechange', changed);
          error ? reject(error) : resolve();
        };
        const changed = () => {
          if (['connected','completed'].includes(this.pc.iceConnectionState) || this.pc.connectionState === 'connected') finish();
          else if (this.pc.iceConnectionState === 'failed' || this.pc.connectionState === 'failed') finish(new Error('Conexão SFU falhou.'));
        };
        const timer = setTimeout(() => finish(new Error('Tempo esgotado ao conectar ao SFU.')), timeoutMs);
        this.pc.addEventListener('iceconnectionstatechange', changed);
        this.pc.addEventListener('connectionstatechange', changed);
      });
    }

    waitForTracks(tracks, timeoutMs){
      return Promise.all(tracks.map(({mid}) => new Promise((resolve,reject) => {
        const finish = (error,track) => {
          clearTimeout(timer);
          this.pc.removeEventListener('track', received);
          error ? reject(error) : resolve(track);
        };
        const received = event => { if (event.transceiver.mid === mid) finish(null,event.track); };
        const timer = setTimeout(() => finish(new Error('A faixa de vídeo não chegou pelo SFU.')), timeoutMs);
        this.pc.addEventListener('track', received);
      })));
    }

    async publish(stream, options){
      options = options || {};
      try{
        await this.open('publisher');
        const video = stream.getVideoTracks()[0];
        if (!video || video.readyState !== 'live') throw new Error('A tela não forneceu vídeo ativo.');
        const tracks = [video].concat(stream.getAudioTracks().slice(0,1));
        const transceivers = tracks.map(track => this.pc.addTransceiver(track,{direction:'sendonly',streams:[stream]}));
        await this.pc.setLocalDescription(await this.pc.createOffer());
        const data = await this.request('/v1/publish', {
          capability:this.session.capability,
          sessionDescription:this.pc.localDescription.toJSON(),
          tracks:transceivers.map((t,i) => ({mid:t.mid,trackName:i === 0 ? 'screen-video' : 'screen-audio'}))
        });
        // A publicação só é divulgada aos espectadores depois que o emissor
        // realmente conectou ao SFU. A referência oficial da Cloudflare também
        // espera o ICE conectado antes de compartilhar os identificadores.
        const connected = this.waitForConnected(7000);
        try{ await this.negotiate(data); await connected; }
        catch(error){ connected.catch(function(){}); throw error; }
        this.videoSender = transceivers[0].sender;
        await this.setQuality({bitrate:options.bitrate,fps:options.fps,degradation:options.degradation});
        this.publication = data.publication;
        return data.publication;
      }catch(error){ await this.close(); throw error; }
    }

    async subscribe(publication){
      try{
        await this.open('subscriber');
        const stream = new MediaStream();
        this.pc.addEventListener('track', event => {
          stream.addTrack(event.track);
          event.track.addEventListener('ended', () => stream.removeTrack(event.track));
          event.track.addEventListener('mute', this.onState);
          event.track.addEventListener('unmute', this.onState);
          this.onState(this.pc.connectionState);
        });
        const data = await this.request('/v1/subscribe', {capability:this.session.capability,publication});
        // Instalar os listeners antes do setRemoteDescription evita perder o
        // evento `track`. Só liberar o stream quando todas as faixas chegaram.
        const tracksReady = this.waitForTracks(data.tracks || [], 6000);
        const connected = this.waitForConnected(7000);
        try{
          await this.negotiate(data);
          await Promise.all([tracksReady,connected]);
        }catch(error){ tracksReady.catch(function(){}); connected.catch(function(){}); throw error; }
        this.remoteStream = stream;
        return stream;
      }catch(error){ await this.close(); throw error; }
    }

    async setQuality(options){
      options = options || {};
      if (!this.videoSender || this.closed) return;
      const parameters = this.videoSender.getParameters();
      if (!parameters.encodings || !parameters.encodings.length) return;
      const bitrate = Number(options.bitrate) || 2000000;
      const fps = Number(options.fps) || 30;
      const scale = Number(options.scale) || 1;
      parameters.encodings[0].maxBitrate = Math.round(Math.max(100000,Math.min(3000000,bitrate)));
      parameters.encodings[0].maxFramerate = Math.max(5,Math.min(30,fps));
      parameters.encodings[0].scaleResolutionDownBy = Math.max(1,Math.min(4,scale));
      parameters.degradationPreference = options.degradation || 'maintain-framerate';
      await this.videoSender.setParameters(parameters);
    }

    async stats(){ return this.pc && !this.closed ? this.pc.getStats() : new Map(); }

    async close(){
      if (this.closed) return;
      this.closed = true;
      this.controller.abort();
      const mids = this.pc ? this.pc.getTransceivers().map(t => t.mid).filter(mid => mid !== null) : [];
      if (this.pc) this.pc.close();
      if (this.remoteStream) this.remoteStream.getTracks().forEach(t => t.stop());
      if (this.session && mids.length){
        try{ await this.request('/v1/close',{capability:this.session.capability,mids},true); }
        catch(_){ this.onState('cleanup-pending'); }
      }
    }
  }

  window.ScreenSFU = ScreenSFU;
})();
