(function(){
  // Sem sessão válida, o bloco de cima já mandou para a porta e marcou aqui.
  // Blocos <script> são independentes: o `return` de lá não impede este de
  // rodar. Sem esta linha, o app monta tudo — barra lateral, listeners, laço
  // de polling — atrás de um redirecionamento em andamento.
  if (window.__SALA_BARRADO) return;
  const CHAT_CACHE = new Map();
  let CHAT_SENDING = false, MIC_CHANGING = false, STATS_BUSY = false;
  const SCREEN_PROFILES = {
    texto:{label:'Texto · 1080p / 30 fps',width:1920,height:1080,fps:30,bitrate:3000000,hint:'detail',degradation:'maintain-resolution'},
    fluido:{label:'Movimento · 720p / 30 fps',width:1280,height:720,fps:30,bitrate:2000000,hint:'motion',degradation:'maintain-framerate'},
    leve:{label:'Econômico · 540p / 15 fps',width:960,height:540,fps:15,bitrate:900000,hint:'motion',degradation:'maintain-framerate'}
  };
  // RNNoise é o padrão fixo. A interface não oferece troca de filtro; se o
  // módulo não puder iniciar, o próprio mecanismo recupera com o filtro nativo.
  const MIC_PREFS = {device:'',mode:'neural',agc:true};
  try{
    const saved = JSON.parse(localStorage.getItem('local:' + (window.__SALA_NS || '') + 'mic-preferences'));
    if (saved){
      MIC_PREFS.device = typeof saved.device === 'string' ? saved.device : '';
      MIC_PREFS.agc = saved.agc !== false;
    }
  }catch(_){}

  function pararStream(stream){
    if (stream) stream.getTracks().forEach(t => { try{ t.stop(); }catch(_){} });
  }

  function idValido(id){
    return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)
      && !['constructor', 'prototype', '__proto__'].includes(id);
  }

  function presencaValida(e){
    return e && idValido(e.session) && CANAIS_VOZ.some(c => c.id === e.chan)
      && typeof e.name === 'string' && e.name.length > 0 && e.name.length <= 24
      && Number.isFinite(e.ts) && Number.isFinite(e.inc)
      && (e.screenMode === undefined || e.screenMode === 'p2p' || e.screenMode === 'sfu')
      && (e.screenFallback === undefined || typeof e.screenFallback === 'boolean')
      && (e.screenPublication === undefined || (typeof e.screenPublication === 'string' && e.screenPublication.length <= 4096));
  }

  function mensagensValidas(arr){
    if (!Array.isArray(arr)) return [];
    return arr.filter(m => m && typeof m.id === 'string' && m.id.length < 120
      && typeof m.text === 'string' && m.text.length <= 1000
      && typeof m.author === 'string' && m.author.length <= 64 && Number.isFinite(m.ts));
  }

  function mostrarModoMicrofone(){
    const graph = PORTAO.grafo;
    document.getElementById('mic-active').textContent = !VOICE.micTrack ? 'Somente ouvindo' :
      graph?.mode === 'neural' ? 'RNNoise + portão ativos' : graph?.mode === 'native' ? 'Filtro nativo + portão ativos' : 'Filtro nativo do navegador';
    document.getElementById('mic-calibrate').disabled = !graph || graph.mode === 'fallback';
    document.getElementById('mic-calibrate').textContent = 'Calibrar no silêncio';
    if (!graph || graph.mode === 'fallback') pintarEstadoPortao('nativo');
  }

  async function adquirirMicrofone(){
    const audio = { echoCancellation:true, noiseSuppression:true, autoGainControl:MIC_PREFS.agc, channelCount:1 };
    if (MIC_PREFS.device) audio.deviceId = { exact:MIC_PREFS.device };
    const result = await comPrazo(navigator.mediaDevices.getUserMedia({audio}), 12000, 'microfone', pararStream);
    if (result?.__prazo) throw new Error('Microfone sem resposta. Entre novamente para tentar falar.');
    return result;
  }

  async function listarMicrofones(){
    try{
      const select = document.getElementById('mic-device');
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
      select.replaceChildren(new Option('Padrão do sistema', ''));
      devices.forEach((d,i) => select.add(new Option(d.label || 'Microfone ' + (i+1), d.deviceId)));
      if (MIC_PREFS.device && !devices.some(d => d.deviceId === MIC_PREFS.device)) select.add(new Option('Microfone anterior (indisponível)', MIC_PREFS.device));
      select.value = MIC_PREFS.device;
    }catch(_){}
  }

  async function trocarMicrofone(){
    if (!VOICE.joined || MIC_CHANGING) return;
    MIC_CHANGING = true;
    const generation = VOICE.generation;
    let raw, graph;
    const controls = ['mic-device','mic-agc','mic-retry'];
    controls.forEach(id => { document.getElementById(id).disabled = true; });
    try{
      raw = await adquirirMicrofone(); graph = await montarPortao(raw);
      if (!VOICE.joined || VOICE.generation !== generation){ graph.dispose(); pararStream(raw); return; }
      const oldRaw = VOICE.micStream, oldGraph = PORTAO.grafo;
      VOICE.micStream = raw; VOICE.micTrack = graph.track; PORTAO.grafo = graph;
      VOICE.micTrack.enabled = !VOICE.muted;
      await Promise.all(Object.values(VOICE.peers).map(applyLocalTracks));
      oldGraph?.dispose(); pararStream(oldRaw);
      attachAnalyser(SID, graph.stream); mostrarModoMicrofone();
      await safeSet('mic-preferences', JSON.stringify(MIC_PREFS), false);
      VOICE._sig = null; renderVoice(); voiceTick();
    }catch(error){ if (raw && raw !== VOICE.micStream){ graph?.dispose(); pararStream(raw); } showToast('Não foi possível trocar o microfone: ' + error.message); }
    finally{ MIC_CHANGING = false; controls.forEach(id => { document.getElementById(id).disabled = false; }); }
  }

  function detachAnalyser(id){
    const a = VOICE.analysers[id];
    if (a){ try{ a.src.disconnect(); a.an.disconnect(); }catch(_){} delete VOICE.analysers[id]; }
  }

  function assistirSid(){
    return !VOICE.stageHidden && VOICE.stageSid !== SID && idValido(VOICE.stageSid) ? VOICE.stageSid : null;
  }

  function precisaFallbackTela(){
    const sid = assistirSid(), p = sid && VOICE.peers[sid], presence = sid && VOICE.bySession[sid];
    if (!p || presence?.screenMode !== 'sfu') return false;
    const video = p.sfuScreen?.getVideoTracks()[0];
    return !(video && video.readyState === 'live' && !video.muted);
  }

  function querMinhaTela(p){
    // Com publicação no SFU, cada tela sai uma única vez do computador. O mesh
    // P2P continua carregando a voz e serve de retorno automático se o SFU cair.
    const presence = VOICE.bySession[p.sid];
    if (typeof SFU_TELA !== 'undefined' && SFU_TELA && (VOICE.sfuStarting || VOICE.sfuPublication)){
      if (presence?.protocol !== 6) return true;
      return presence.watching === SID && presence.screenFallback === true;
    }
    // v5 clients have no subscription protocol; preserve interoperability during rollout.
    return presence?.protocol !== 6 || presence.watching === SID;
  }

  async function aplicarPerfilTela(){
    const track = VOICE.screenVideoTrack;
    if (!track) return;
    const profile = SCREEN_PROFILES[VOICE.screenProfile];
    try{
      track.contentHint = profile.hint;
      await track.applyConstraints({ width:{ideal:profile.width,max:profile.width}, height:{ideal:profile.height,max:profile.height}, frameRate:{ideal:profile.fps,max:profile.fps} });
    }catch(error){ console.warn('[tela] perfil de captura limitado pelo dispositivo', error); showToast('A origem não aceitou todo o perfil. O limite de envio será aplicado.'); }
    Object.values(VOICE.peers).forEach(p => { p.adaptLevel = 0; p.badSamples = 0; p.goodSamples = 0; });
    if (VOICE.sfuPublisher){
      await VOICE.sfuPublisher.setQuality({bitrate:profile.bitrate,fps:profile.fps,scale:1,degradation:profile.degradation})
        .catch(error => console.warn('[sfu] limite de qualidade', error));
    }
    await Promise.all(Object.values(VOICE.peers).map(applyLocalTracks));
  }

  function tokenSFU(){ return PONTE_PORTA.sessao?.()?.token || ''; }
  function salaSFU(){ return (window.__SALA_ESPACO || 'producao') + ':' + VOICE.chan; }
  function novoSFU(onState){
    return new window.ScreenSFU({
      endpoint:SFU_ENDPOINT,
      token:tokenSFU,
      room:salaSFU(),
      iceServers:VOICE.ice || undefined,
      onState:onState || function(){ updateStage(); }
    });
  }

  async function publicarTelaSFU(stream, operation){
    if (!SFU_TELA) return false;
    const transport = novoSFU(function(state){
      VOICE.sfuState = state;
      updateStage();
    });
    VOICE.sfuPublisher = transport;
    try{
      const profile = SCREEN_PROFILES[VOICE.screenProfile];
      const publication = await transport.publish(stream,{bitrate:profile.bitrate,fps:profile.fps,degradation:profile.degradation});
      if (operation !== VOICE.screenOperation || VOICE.screenStream !== stream){ await transport.close(); return false; }
      VOICE.sfuPublication = publication;
      VOICE.sfuStarting = false;
      VOICE.sfuState = transport.pc?.connectionState || 'connecting';
      window.__SALA_SFU = 'publicando';
      return true;
    }catch(error){
      if (VOICE.sfuPublisher === transport) VOICE.sfuPublisher = null;
      VOICE.sfuPublication = null; VOICE.sfuStarting = false; VOICE.sfuState = 'fallback';
      window.__SALA_SFU = 'fallback: ' + (error.message || 'erro');
      console.warn('[sfu] publicação indisponível; usando P2P', error);
      return false;
    }
  }

  async function definirPerfilTela(value){
    if (!Object.hasOwn(SCREEN_PROFILES, value)) return;
    VOICE.screenProfile = value;
    document.getElementById('screen-profile').value = value;
    await safeSet('screen-profile', value, false);
    VOICE.profileQueue = (VOICE.profileQueue || Promise.resolve()).catch(() => {}).then(aplicarPerfilTela);
    await VOICE.profileQueue;
  }

  async function instalarTela(stream, surface, operation){
    if (operation !== VOICE.screenOperation){ pararStream(stream); return; }
    if (!VOICE.joined){
      const joined = await joinVoice(VOICE.channels[0]?.id || 'voz-geral');
      if (!joined || operation !== VOICE.screenOperation){ pararStream(stream); return; }
    }
    pararStream(VOICE.screenStream);
    VOICE.screenStream = stream; VOICE.screenVideoTrack = stream.getVideoTracks()[0] || null;
    VOICE.screenAudioTrack = stream.getAudioTracks()[0] || null; VOICE.screenSurface = surface;
    if (!VOICE.screenVideoTrack){ pararStream(stream); throw new Error('A origem não forneceu vídeo.'); }
    VOICE.screenVideoTrack.addEventListener('ended', () => { if (VOICE.screenStream === stream) stopScreen(); });
    VOICE.stageHidden = false; VOICE.stageSid = SID;
    VOICE.sfuLastStats = null; VOICE.sfuAdaptLevel = 0; VOICE.sfuBadSamples = 0; VOICE.sfuGoodSamples = 0;
    VOICE.sfuStarting = SFU_TELA;
    await aplicarPerfilTela();
    if (VOICE.screenStream !== stream) return;
    const peloSFU = await publicarTelaSFU(stream, operation);
    if (VOICE.screenStream !== stream) return;
    await Promise.all(Object.values(VOICE.peers).map(applyLocalTracks));
    VOICE._sig = null; renderVoice(); updateStage(); voiceTick();
    if (peloSFU) showToast('Tela conectada ao servidor SFU. Cada transmissão sai uma única vez do seu computador.');
    else if (SFU_TELA) showToast('SFU indisponível. A tela continua pelo modo direto.');
    if (surface === 'monitor' && VOICE.screenAudioTrack) showToast('Áudio do computador com filtro da chamada ativado pelo navegador.');
    else if (!VOICE.screenAudioTrack) showToast('Transmitindo sem áudio da origem.');
  }

  async function colherDiagnostico(){
    if (!VOICE.joined || STATS_BUSY) return;
    STATS_BUSY = true;
    const readings = [];
    try{
      await Promise.all(Object.values(VOICE.peers).map(async p => {
        const pc = p.pc;
        if (!pc || pc.signalingState === 'closed') return;
        try{
          const stats = await pc.getStats();
          if (p.pc !== pc) return;
          const previous = p.lastStats || new Map();
          const sample = { pessoa:p.name, conexao:pc.connectionState, erro:p.mediaError || null, enviandoTela:!!p.send?.scrV?.track };
          let limited = false;
          stats.forEach(s => {
            const old = previous.get(s.id);
            if (s.type === 'transport' && s.selectedCandidatePairId){
              const pair = stats.get(s.selectedCandidatePairId), local = pair && stats.get(pair.localCandidateId);
              if (Number.isFinite(pair?.currentRoundTripTime)) sample.rttMs = Math.round(pair.currentRoundTripTime*1000);
              sample.rota = local?.candidateType === 'relay' ? 'TURN' : local?.candidateType || 'indisponível';
            }
            if (s.type === 'outbound-rtp' && s.kind === 'video' && p.send?.scrV?.track){
              sample.envio = { largura:s.frameWidth, altura:s.frameHeight, fps:s.framesPerSecond, limitacao:s.qualityLimitationReason || 'indisponível' };
              if (old && s.timestamp > old.timestamp) sample.envio.kbps = Math.max(0,Math.round((s.bytesSent-old.bytesSent)*8/(s.timestamp-old.timestamp)));
              limited = ['cpu','bandwidth'].includes(s.qualityLimitationReason);
            }
            if (s.type === 'inbound-rtp' && s.kind === 'video'){
              sample.recebimento = { largura:s.frameWidth, altura:s.frameHeight, fps:s.framesPerSecond, congelamentos:s.freezeCount };
              if (old && s.timestamp > old.timestamp) sample.recebimento.kbps = Math.max(0,Math.round((s.bytesReceived-old.bytesReceived)*8/(s.timestamp-old.timestamp)));
            }
            if (s.type === 'inbound-rtp' && s.kind === 'audio'){
              if (Number.isFinite(s.jitter)) sample.jitterMs = Math.round(s.jitter*1000);
              if (old){ const lost=Math.max(0,(s.packetsLost||0)-(old.packetsLost||0)), received=Math.max(0,(s.packetsReceived||0)-(old.packetsReceived||0));
                if (lost+received>0) sample.perdaAudioPct = Math.round(lost/(lost+received)*1000)/10; }
            }
          });
          p.lastStats = new Map(); stats.forEach(s => p.lastStats.set(s.id,s));
          if (p.send?.scrV?.track){
            p.badSamples = limited ? (p.badSamples || 0)+1 : 0;
            p.goodSamples = limited ? 0 : (p.goodSamples || 0)+1;
            const before = p.adaptLevel || 0;
            if (p.badSamples >= 3){ p.adaptLevel = Math.min(2,before+1); p.badSamples = 0; }
            if (p.goodSamples >= 10){ p.adaptLevel = Math.max(0,before-1); p.goodSamples = 0; }
            if ((p.adaptLevel || 0) !== before) await applyLocalTracks(p);
          }
          readings.push(sample);
        }catch(error){ console.debug('[diagnóstico]', error.message); }
      }));
      const sfu = VOICE.sfuPublisher;
      if (sfu?.pc && !sfu.closed){
        try{
          const stats = await sfu.stats(), previous = VOICE.sfuLastStats || new Map();
          const sample = { pessoa:'Tela via SFU', conexao:sfu.pc.connectionState, rota:'SFU', enviandoTela:true };
          let limited = false;
          stats.forEach(s => {
            const old = previous.get(s.id);
            if (s.type === 'outbound-rtp' && s.kind === 'video'){
              sample.envio = { largura:s.frameWidth, altura:s.frameHeight, fps:s.framesPerSecond, limitacao:s.qualityLimitationReason || 'indisponível' };
              if (old && s.timestamp > old.timestamp) sample.envio.kbps = Math.max(0,Math.round((s.bytesSent-old.bytesSent)*8/(s.timestamp-old.timestamp)));
              limited = ['cpu','bandwidth'].includes(s.qualityLimitationReason);
            }
            if (s.type === 'candidate-pair' && s.state === 'succeeded' && Number.isFinite(s.currentRoundTripTime)) sample.rttMs = Math.round(s.currentRoundTripTime*1000);
          });
          VOICE.sfuLastStats = new Map(); stats.forEach(s => VOICE.sfuLastStats.set(s.id,s));
          VOICE.sfuBadSamples = limited ? (VOICE.sfuBadSamples || 0)+1 : 0;
          VOICE.sfuGoodSamples = limited ? 0 : (VOICE.sfuGoodSamples || 0)+1;
          const before = VOICE.sfuAdaptLevel || 0;
          if (VOICE.sfuBadSamples >= 3){ VOICE.sfuAdaptLevel = Math.min(2,before+1); VOICE.sfuBadSamples = 0; }
          if (VOICE.sfuGoodSamples >= 10){ VOICE.sfuAdaptLevel = Math.max(0,before-1); VOICE.sfuGoodSamples = 0; }
          if ((VOICE.sfuAdaptLevel || 0) !== before){
            const profile = SCREEN_PROFILES[VOICE.screenProfile], scale = [1,1.5,2][VOICE.sfuAdaptLevel || 0];
            await sfu.setQuality({bitrate:profile.bitrate/scale,fps:(VOICE.sfuAdaptLevel || 0)>=2?Math.min(15,profile.fps):profile.fps,scale,degradation:profile.degradation});
          }
          readings.push(sample);
        }catch(error){ console.debug('[diagnóstico SFU]', error.message); }
      }
      window.__SALA_DIAGNOSTICO = { atualizado:new Date().toISOString(), microfone:PORTAO.grafo?.mode || 'nativo', perfil:VOICE.screenProfile, pares:readings };
      const panel = document.getElementById('diagnostic-data');
      if (panel) panel.textContent = JSON.stringify(window.__SALA_DIAGNOSTICO,null,2);
      const bad = readings.some(s => s.erro || (s.rttMs||0)>350 || (s.perdaAudioPct||0)>3 || ['cpu','bandwidth'].includes(s.envio?.limitacao));
      document.getElementById('quality-indicator').textContent = bad ? 'Qualidade limitada · detalhes' : 'Diagnóstico da chamada';
    } finally{ STATS_BUSY = false; }
  }

  function abrirDiagnostico(){
    if (document.getElementById('diagnostic-modal')) return;
    const modal = document.createElement('div'); modal.className = 'modal'; modal.id = 'diagnostic-modal';
    modal.innerHTML = '<div class="modal-card"><div class="modal-header"><span>Diagnóstico da chamada</span><button class="modal-close" aria-label="Fechar">✕</button></div><p class="diagnostic-note">Dados locais desta chamada. Campos ausentes não foram informados pelo navegador. O vídeo reduz a qualidade automaticamente quando há limitação persistente.</p><pre id="diagnostic-data"></pre></div>';
    modal.querySelector('button').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
    modal.querySelector('pre').textContent = JSON.stringify(window.__SALA_DIAGNOSTICO || {estado:'Aguardando estatísticas…'},null,2);
    colherDiagnostico();
  }

  // Marcador de versão: serve para confirmar que o site publicado está mesmo
  // servindo este arquivo, e não uma cópia antiga em cache/CDN.
  const SALA_VERSAO = 'v6 · 2026-09-12';

  // ---------- PONTE COM O PRIMEIRO BLOCO <script> ----------
  // Estas duas moram no bloco de cima, junto do guard de entrada. Blocos
  // <script> diferentes são escopos diferentes, então elas chegam aqui por
  // window — ver o comentário lá. O plano B não depende de nada do outro
  // bloco: se a ponte faltar, sair ainda funciona.
  const PONTE_PORTA = window.__SALA_PORTA || {};
  // Mesma lista do bloco de cima. Repetida de propósito: o plano B tem que
  // funcionar justamente quando a ponte não veio.
  const ESPACOS_SESSAO_LOCAL = ['', 'devsala:', 'hmlsala:'];   // o último é só para limpar

  const apagarSessaoDeTodos = PONTE_PORTA.apagarSessao || function(){
    for (const p of ESPACOS_SESSAO_LOCAL){
      try{ localStorage.removeItem('local:' + p + 'sessao'); }catch(e){}
      try{ localStorage.removeItem('local:' + p + 'nickname'); }catch(e){}
    }
  };

  const voltarParaPorta = PONTE_PORTA.voltar || function(){
    apagarSessaoDeTodos();
    try{ location.replace(PONTE_PORTA.endereco || './'); }
    catch(e){ try{ location.reload(); }catch(e2){} }
  };

  // Login por usuário e senha, em TODOS os ambientes — produção inclusive.
  // Não existe mais senha compartilhada de sala: sem conta, ninguém entra.
  //
  // A TELA de login mudou de lugar: agora é o index.html que pede a conta e
  // grava a sessão. Este endereço fica aqui só porque o arquivo ainda o usa
  // para reconhecer que o modo de login está ligado — e para a tela antiga
  // continuar funcionando se algum dia a porta única for desligada.
  const AUTH_ENDPOINT = 'https://sala-auth.vinicius-petinate.workers.dev';
  window.__SALA_VERSAO = SALA_VERSAO;
  console.info('[sala] versão ' + SALA_VERSAO + ' · espaço de dados: ' + window.__SALA_ESPACO);
  document.getElementById('ver-tag').textContent =
    'versão ' + SALA_VERSAO + (window.__SALA_NS ? ' · espaço ' + (window.__SALA_ESPACO || 'producao') : '');

  // Marca visível de ambiente de teste. Vale para qualquer cópia que não se
  // chame sala.html — devsala.html, teste.html, o que for.
  const EH_DEV = !!window.__SALA_NS;

  // Recursos que nasceram no ambiente de teste e foram aprovados: bip de
  // entrada/saída, placa de captura e a lista de novidades. Ligados em todo
  // lugar, inclusive na produção.
  const RECURSOS_NOVOS = true;

  // A lista de melhorias mora em novidades.js, carregado antes deste script,
  // para o index e as três salas mostrarem exatamente o mesmo texto. Se o
  // arquivo faltar, a lista fica vazia e o painel simplesmente não aparece —
  // em vez de quebrar a sala.
  //
  // Declarada AQUI, e não junto do painel: o botão do cabeçalho é montado
  // antes, e um `const` usado acima da própria linha é ReferenceError.
  const NOVIDADES = window.NOVIDADES_SALA || [];

  // Login vale em qualquer arquivo com o endereço preenchido — produção
  // inclusive. Só entra quem tem conta em SALA_USUARIOS no Worker.
  // Um modo só: conta individual (usuário e senha), validada no Worker.
  const MODO_LOGIN = !!AUTH_ENDPOINT;
  // Conta individual em todos os ambientes, com apelido opcional em todos
  // eles: a conta diz QUEM é, o apelido diz COMO aparecer. O apelido NÃO vai
  // ao Worker — é só nome de exibição, escolhido no navegador.
  const MODO_CONTA = MODO_LOGIN;

  // Gancho para o próximo recurso a ser testado só no dev. NESTE MOMENTO NÃO
  // TEM CONSUMIDOR: tudo o que nasceu no dev foi aprovado e promovido, então
  // produção e dev rodam com as mesmas funções ligadas — a diferença entre eles
  // é o espaço de dados e a cor, nada mais.
  //
  // O jeito de usar: `const RECURSO_NOVO = SO_DEV;` e prender o recurso a essa
  // constante. Os dois arquivos seguem idênticos, e promover é trocar por true.
  const SO_DEV = /^devsala/.test(window.__SALA_ARQUIVO || '');

  // Primeira implantação somente no DEV. Para testar o retorno P2P no console,
  // recarregue após definir window.__AIQ_DISABLE_SFU=true.
  const SFU_TELA = SO_DEV && !!window.ScreenSFU && !window.__AIQ_DISABLE_SFU;
  const SFU_ENDPOINT = window.__AIQ_SFU_ENDPOINT || 'https://aiqcall-sfu.vinicius-petinate.workers.dev';

  // Volume e silêncio por pessoa no canal de voz. Nasceu no dev, foi testado
  // e passou a valer nos três ambientes. Para desligar, ponha false aqui.
  const AUDIO_POR_PESSOA = true;

  // Layout de celular: os painéis laterais viram gavetas e o chat ocupa a tela.
  // Nasceu no dev, foi testado e vale nos três. Para desligar, ponha false.
  const MOBILE_OK = true;
  // A largura tem que casar com o @media do CSS.
  const ESTREITO = () => window.matchMedia('(max-width: 600px)').matches;

  // Volume do áudio da transmissão de tela, independente do volume das vozes.
  // Testado no dev e aprovado; vale nos dois ambientes.
  const VOLUME_TELA = true;

  // Assistir à tela compartilhada é OPCIONAL: o palco não abre sozinho, e em
  // vez dele aparece um convite. Testado no dev e aprovado; vale nos dois
  // ambientes. Para voltar a abrir na cara de todos, ponha false.
  const ASSISTIR_OPCIONAL = true;

  // Portão de ruído no microfone: fecha quando você não está falando, para
  // teclado, ventilador e conversa ao fundo não saírem. Testado no dev e
  // aprovado; vale nos dois ambientes. Para desligar, ponha false.
  //
  // NÃO substitui o noiseSuppression nativo do navegador — soma a ele. Um
  // modelo de rede neural (RNNoise e afins) exigiria DESLIGAR o nativo, porque
  // é treinado em áudio cru; um portão de ganho não tem esse problema.
  const PORTAO_RUIDO = true;

  // Nome fixo por ambiente, igual nos três: quem abre a janela sabe onde está
  // pelo próprio nome, sem depender de selo ou de cor.
  const NOME_POR_AMBIENTE = {
    producao: 'AIQCALL - PROD',
    devsala:  'AIQCALL - DEV',
  };
  const NOME_FIXO = NOME_POR_AMBIENTE[window.__SALA_ESPACO]
    || ('AIQCALL - ' + (window.__SALA_ESPACO || 'SALA').toUpperCase());

  // Canais de voz fixos. Criar canal saiu de todos os ambientes.
  const CANAIS_VOZ = [
    { id: 'voz-geral',  name: 'Geral' },
    { id: 'voz-sala-2', name: 'Sala 2' },
  ];

  // "devsala" -> "dev"; usado no selo e na etiqueta lateral do ambiente
  const AMB = (window.__SALA_ESPACO || '').replace(/sala$/, '') || 'teste';

  if (EH_DEV){
    document.title = '[' + AMB.toUpperCase() + '] ' + document.title;
    document.body.classList.add('ambiente-dev');
    document.body.classList.add('amb-' + (window.__SALA_ESPACO || ''));
    document.body.style.setProperty('--amb-rotulo', JSON.stringify(AMB.toUpperCase()));
    const card = document.querySelector('#gate .card');
    const titulo = card && card.querySelector('h1');
    if (titulo){
      const selo = document.createElement('div');
      selo.className = 'dev-badge';
      selo.textContent = '⚠ ambiente de teste · ' + window.__SALA_ESPACO;
      card.insertBefore(selo, titulo);
      titulo.textContent = 'Entrar na sala de teste';
      const p = card.querySelector('p');
      if (p) p.textContent = 'Esta é uma cópia isolada. As mensagens daqui não aparecem na sala de produção.';
    }
    // o painel de entrada é montado no fim do arquivo, quando NOVIDADES já existe
  }

  // Tela de entrada. Fora do bloco de ambiente de teste porque vale para os
  // três, e sobrescreve os textos dele.
  if (MODO_CONTA){
    const card = document.querySelector('#gate .card');
    const titulo = card && card.querySelector('h1');
    if (titulo){
      titulo.textContent = 'Entrar com sua conta';
      const p = card.querySelector('p');
      if (p) p.textContent = 'Acesso restrito. Use o usuário e a senha que o administrador criou para você.';
    }
    // O campo de apelido vira o de usuário e vem primeiro.
    const nick = document.getElementById('nick-input');
    const pass = document.getElementById('pass-input');
    nick.placeholder = 'Usuário';
    pass.placeholder = 'Senha';
    pass.parentNode.insertBefore(nick, pass);

    // Um terceiro campo em qualquer ambiente: a conta autentica, o apelido
    // decide como a pessoa aparece na sala. Vazio = usa o nome da conta.
    // (Esta tela só aparece se a porta única for desligada; a entrada normal
    // é pelo index.html, que tem o mesmo campo.)
    if (!document.getElementById('alias-input')){
      const alias = document.createElement('input');
      alias.id = 'alias-input';
      alias.maxLength = 24;
      alias.placeholder = 'Apelido (opcional)';
      alias.autocomplete = 'off';
      pass.parentNode.insertBefore(alias, pass.nextSibling);
      alias.addEventListener('keydown', e => { if (e.key === 'Enter') submitNick(); });
    }

    const sair = document.getElementById('leave-btn');
    if (sair) sair.title = 'Sair da conta';
  }

  // Sem criar canais em nenhum ambiente: esconde os botões "+" e as linhas de
  // digitar o nome do canal novo.
  for (const id of ['add-channel-btn', 'add-voice-btn', 'new-channel-row', 'new-voice-row']){
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  // Botão no cabeçalho para reabrir a lista. Fora do bloco de teste de
  // propósito: vale também na produção.
  if (RECURSOS_NOVOS && NOVIDADES.length){
    const cab = document.getElementById('chat-header');
    const btnTela = document.getElementById('share-btn');
    if (cab && btnTela){
      const b = document.createElement('div');
      b.className = 'head-btn first';
      b.id = 'novidades-btn';
      // No celular só o ícone, senão o nome do canal fica sem espaço.
      b.textContent = (MOBILE_OK && ESTREITO()) ? '✨' : '✨ Novidades';
      b.title = 'Ver o que mudou na sala';
      btnTela.classList.remove('first');   // o "empurra para a direita" passa a ser deste
      cab.insertBefore(b, btnTela);
      b.addEventListener('click', abrirModalNovidades);
    }
  }

  // A lista em si mora em novidades.js e é lida no topo deste script, em
  // NOVIDADES. Aqui ficam só o gerador de HTML e o modal.


  // Um gerador só, usado na tela de login e no modal de dentro da sala.
  function htmlNovidades(comTitulo){
    return (comTitulo ? '<h2>✨ Últimas melhorias</h2>' : '') +
      '<div class="sub">O que mudou na sala desde a primeira versão. Atualizada a cada versão publicada.</div>' +
      NOVIDADES.map(g =>
        '<div class="grupo"><h3>' + escapeHtml(g.titulo) + '</h3><ul>' +
        g.itens.map(i => '<li>' + i + '</li>').join('') +
        '</ul></div>'
      ).join('') +
      '<div class="rodape">versão ' + SALA_VERSAO + '<br>espaço de dados: ' + escapeHtml(window.__SALA_ESPACO || 'producao') + '</div>';
  }

  // Montava a lista aberta ao lado da tela de entrada. Essa tela não aparece
  // mais — a entrada é pelo index.html — e mesmo que voltasse, a lista só deve
  // aparecer no clique. Fica desligada, e não apagada, para o dia em que a
  // porta única for desligada e a tela de entrada volte a existir.
  const MOSTRAR_NOVIDADES_NA_ENTRADA = false;

  function montarNovidades(){
    if (!MOSTRAR_NOVIDADES_NA_ENTRADA) return;
    if (!NOVIDADES.length) return;
    const gate = document.getElementById('gate');
    if (!gate || document.getElementById('novidades')) return;
    const painel = document.createElement('div');
    painel.id = 'novidades';
    painel.className = 'novidades-corpo';
    painel.innerHTML = htmlNovidades(true);
    gate.appendChild(painel);
  }

  function abrirModalNovidades(){
    if (document.getElementById('modal-novidades')) return;
    const m = document.createElement('div');
    m.id = 'modal-novidades';
    m.className = 'modal';
    m.innerHTML =
      '<div class="modal-card">' +
        '<div class="modal-header"><span>✨ Últimas melhorias</span>' +
          '<span class="modal-close" id="nov-x">✕</span></div>' +
        '<div class="novidades-corpo" id="nov-corpo"></div>' +
      '</div>';
    document.body.appendChild(m);
    m.querySelector('#nov-corpo').innerHTML = htmlNovidades(false);
    const fechar = () => m.remove();
    m.querySelector('#nov-x').addEventListener('click', fechar);
    m.addEventListener('click', e => { if (e.target === m) fechar(); });   // clicar fora fecha
  }

  const SID = Math.random().toString(36).slice(2,10) + Date.now().toString(36);

  const state = {
    nickname: null,
    serverName: 'Comunidade',
    channels: [],
    activeChannelId: null,
    members: {},
    pedirTudo: false,
    tique: 0,
    sessionId: SID,
  };

  const POLL_MS = 2500;
  const ONLINE_WINDOW_MS = 8000;
  const STALE_MEMBER_MS = 5 * 60 * 1000;

  const VOICE_TICK_MS = 1200;      // cadência enquanto alguém está negociando
  const VOICE_CALMO_MS = 1600;     // com todos conectados; baixo para notar rápido quem entra
  const VOICE_IDLE_TICK_MS = 4000; // fora da chamada, só para mostrar quem está na voz
  const VOICE_STALE_MS = 25000;    // presença expira; folgado porque cada ida ao banco custa ~0,5s
  const PEER_TIMEOUT_MS = 15000;   // nunca conectou nisso -> refaz a negociação
  const PEER_DROP_GRACE_MS = 7000; // 'disconnected' costuma se resolver sozinho; espera antes de refazer
  const MAX_PEER_TRIES = 4;

  // Contador de negociação sempre crescente. Um contador que reinicia do zero
  // trava a reconexão: o outro lado já viu um número maior e descarta a oferta
  // nova como se fosse velha.
  let EPOCH = Date.now() % 1000000;
  function nextEpoch(){ return ++EPOCH; }

  // "Encarnação": muda a cada vez que entro na chamada. Como o sessionId não
  // muda sem recarregar a página, é isso que avisa os outros que eu sou uma
  // conexão nova e que o estado antigo do par deve ser jogado fora.
  let INC = 0;

  // ===================== CONFIGURE O TURN AQUI =====================
  // STUN só descobre o próprio IP público; ele não carrega mídia. Quando os
  // dois lados estão atrás de NAT simétrico, firewall corporativo ou CGNAT de
  // operadora, não existe caminho direto e a conexão simplesmente não fecha.
  // O TURN é um relay: a mídia passa por ele quando o caminho direto falha.
  //
  // Preencha e a sala passa a funcionar nessas redes. Sem isso, alguns pares
  // vão aparecer como "falhou" por mais correções que existam no código.
  // OPÇÃO A — credenciais fixas (coturn próprio, ou Cloudflare com TTL longo).
  // Simples, mas ficam visíveis no código-fonte da página.
  const TURN_SERVERS = [
    // { urls: ['turn:SEU-HOST:3478?transport=udp', 'turn:SEU-HOST:3478?transport=tcp'],
    //   username: 'usuario', credential: 'senha' },
    // { urls: 'turns:SEU-HOST:5349?transport=tcp',   // TLS na 5349: atravessa firewall que só libera HTTPS
    //   username: 'usuario', credential: 'senha' },
  ];

  // OPÇÃO B — credenciais de curta duração buscadas num endpoint. É o modo do
  // Cloudflare, e o único que não deixa a senha do relay exposta na página.
  // Aponte para a Edge Function do Supabase que gera as credenciais.
  // Worker do Cloudflare que gera as credenciais TURN de curta duração.
  // Código dele em cloudflare/turn-worker.js.
  //
  // Se um dia esta URL mudar, é só trocar aqui — nada mais no arquivo depende
  // dela. Deixando em branco, a sala volta a funcionar só com STUN.
  const TURN_ENDPOINT = 'https://sala-turn-api.vinicius-petinate.workers.dev';
  // =================================================================

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ].concat(TURN_SERVERS);

  // Teste: no console, rode  __SALA_SO_RELAY = true  e entre na chamada. Isso
  // proíbe o caminho direto, então a conexão só fecha se o TURN estiver mesmo
  // funcionando. Se conectar, o TURN está certo; se der "falhou", está errado.
  window.__SALA_SO_RELAY = false;

  // Busca as credenciais de curta duração e guarda até perto de expirarem.
  // Se o endpoint falhar, cai para a lista fixa em vez de impedir a chamada.
  let ICE_CACHE = { servers: null, expiraEm: 0 };

  async function resolverIceServers(){
    if (!TURN_ENDPOINT) return ICE_SERVERS;
    if (ICE_CACHE.servers && Date.now() < ICE_CACHE.expiraEm) return ICE_CACHE.servers;
    try{
      // AbortController corta a conexão de verdade; sem ele o navegador
      // continuaria segurando o pedido depois do prazo.
      const corta = new AbortController();
      const alarme = setTimeout(() => corta.abort(), 6000);
      const r = await fetch(TURN_ENDPOINT, { headers: { 'Accept': 'application/json' }, signal: corta.signal })
        .finally(() => clearTimeout(alarme));
      if (window.__anotarRelogio) window.__anotarRelogio(r);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      // O Cloudflare devolve iceServers como um objeto único; outros serviços
      // devolvem uma lista. Aceita os dois formatos.
      const bruto = Array.isArray(j.iceServers) ? j.iceServers
                  : (j.iceServers ? [j.iceServers] : []);
      // A entrada só de STUN vem com username/credential em branco. Campo vazio
      // faz alguns navegadores recusarem a lista inteira, então some com eles.
      const extra = bruto.map(s => {
        const limpo = { urls: s.urls };
        if (s.username) limpo.username = s.username;
        if (s.credential) limpo.credential = s.credential;
        return limpo;
      }).filter(s => s.urls && s.urls.length);
      if (!extra.length) throw new Error('resposta sem iceServers');
      const ttl = Number(j.ttl) > 0 ? Number(j.ttl) : 3600;
      ICE_CACHE.servers = ICE_SERVERS.concat(extra);
      ICE_CACHE.expiraEm = Date.now() + ttl * 800;   // renova a 80% do TTL
      window.__SALA_TURN = 'ok (' + extra.length + ' servidor(es), ttl ' + ttl + 's)';
      return ICE_CACHE.servers;
    }catch(e){
      console.error('[sala] falha ao buscar credenciais TURN:', e);
      // Traduz o erro para algo que sirva de diagnóstico na hora do aperto.
      window.__SALA_TURN = 'FALHOU: ' + (
        e.name === 'AbortError'      ? 'sem resposta em 6s (a rede parece bloquear o servidor)' :
        /Failed to fetch/.test(e.message || '') ? 'não alcancei o servidor (rede bloqueando ou fora do ar)' :
        e.message);
      // Avisa uma vez só: se a função ainda não foi publicada, não faz sentido
      // encher a tela de alerta a cada entrada na chamada.
      if (!ICE_CACHE.avisou){
        ICE_CACHE.avisou = true;
        showToast('Sem servidor TURN configurado — a chamada usa conexão direta e pode falhar em rede corporativa.');
      }
      return ICE_SERVERS;
    }
  }

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function slugify(s){
    return s.toLowerCase().trim()
      .replace(/[^a-z0-9à-ÿ\s-]/g,'')
      .replace(/\s+/g,'-')
      .slice(0,24) || 'canal';
  }

  function colorFor(name){
    const palette = ['#ff9f5b','#5fd98a','#5b9dff','#ff6b9e','#c78cff','#ffd15b','#5be0d9'];
    let h = 0;
    for (let i=0;i<name.length;i++) h = (h*31 + name.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  function initials(name){
    return (name||'?').trim().slice(0,2).toUpperCase();
  }

  function timeFmt(ts){
    const d = new Date(ts);
    return d.toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
  }

  function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

  // Nada aqui pode esperar para sempre. Rede que ENGOLE o pacote (em vez de
  // recusar) deixa um fetch pendurado por minutos, e o pedido de microfone
  // fica parado se a permissão nunca for respondida — nos dois casos a pessoa
  // vê "carregando" sem fim. Melhor seguir sem o recurso do que travar.
  function comPrazo(promessa, ms, nome, aoChegarTarde){
    return new Promise((resolve, reject) => {
      let terminado = false;
      const timer = setTimeout(() => {
        terminado = true;
        console.warn('[sala] prazo excedido:', nome);
        resolve({ __prazo: true });
      }, ms);
      Promise.resolve(promessa).then(valor => {
        if (terminado){ if (aoChegarTarde) aoChegarTarde(valor); return; }
        terminado = true; clearTimeout(timer); resolve(valor);
      }, erro => {
        if (terminado) return;
        terminado = true; clearTimeout(timer); reject(erro);
      });
    });
  }

  async function safeGet(key, shared, retries){
    retries = retries === undefined ? 2 : retries;
    for (let i=0; i<=retries; i++){
      try{
        const r = await window.storage.get(key, shared);
        return r ? r.value : null;
      }catch(e){
        if (i === retries) return null;
        await sleep(400 * (i+1));
      }
    }
    return null;
  }
  async function safeSet(key, value, shared, retries){
    retries = retries === undefined ? 2 : retries;
    for (let i=0; i<=retries; i++){
      try{
        await window.storage.set(key, value, shared);
        return true;
      }catch(e){
        console.error('storage set failed', key, e);
        if (i === retries) return false;
        await sleep(500 * (i+1));
      }
    }
    return false;
  }

  async function safeDelete(key, shared){
    try{ await window.storage.delete(key, shared); return true; }catch(e){ return false; }
  }

  async function safeGetChanged(keys, desde){
    try{ return await window.storage.getChanged(keys, desde); }catch(e){ return null; }
  }

  async function safeGetMany(keys){
    try{ return await window.storage.getMany(keys); }catch(e){ return null; }
  }

  async function safeList(prefix){
    try{ return await window.storage.list(prefix); }catch(e){ return null; }
  }

  async function safeDeleteOlderThan(prefix, ms){
    try{ await window.storage.deleteOlderThan(prefix, ms); return true; }catch(e){ return false; }
  }

  async function safeDeletePrefix(prefix, keepalive){
    try{ await window.storage.deletePrefix(prefix, keepalive); return true; }catch(e){ return false; }
  }

  function showToast(msg){
    let t = document.getElementById('toast');
    if (!t){
      t = document.createElement('div');
      t.id = 'toast';
      t.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#3a2430;color:#ff9f5b;border:1px solid #5a3040;padding:10px 16px;border-radius:8px;font-size:13px;z-index:100;box-shadow:0 8px 24px rgba(0,0,0,0.4);max-width:80vw;text-align:center;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => { t.style.opacity = '0'; }, 5000);
  }

  // ---------- APELIDO ----------
  async function loadNickname(){
    return await safeGet('nickname', false);
  }

  document.getElementById('nick-btn').addEventListener('click', submitNick);
  document.getElementById('nick-input').addEventListener('keydown', e => { if(e.key==='Enter') submitNick(); });
  document.getElementById('pass-input').addEventListener('keydown', e => { if(e.key==='Enter') submitNick(); });

  // Não existe senha de sala: a entrada é sempre por conta individual,
  // validada no Worker. Sem conta, ninguém entra — nem por atalho.

  async function submitNick(){
    const input = document.getElementById('nick-input');
    const val = input.value.trim();
    const err = document.getElementById('nick-err');
    const pass = document.getElementById('pass-input').value;

    if (MODO_LOGIN){
      const btn = document.getElementById('nick-btn');
      if (!val || !pass){
        err.textContent = MODO_CONTA ? 'Preencha usuário e senha.' : 'Preencha a senha e um apelido.';
        return;
      }
      err.textContent = 'Verificando…';
      btn.disabled = true;
      try{
        const corta = new AbortController();
        const alarme = setTimeout(() => corta.abort(), 10000);
        const r = await fetch(AUTH_ENDPOINT, {
          signal: corta.signal,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(MODO_CONTA ? { usuario: val, senha: pass }
                                          : { apelido: val, senha: pass })
        });
        clearTimeout(alarme);
        const j = await r.json().catch(() => ({}));
        // Serviço fora do ar ou mal configurado: avisa e NÃO deixa entrar.
        // A conta é a única porta; não há atalho por senha compartilhada.
        const semServico = !j || (!j.ok && !j.erro) || /nao configurad/.test(j.erro || '');
        if (semServico){
          console.error('[sala] serviço de login indisponível:', j.erro || 'resposta inválida');
          err.textContent = 'Serviço de login indisponível. Tente novamente em instantes.';
          btn.disabled = false;
          return;
        }
        if (!r.ok || !j.ok){
          err.textContent = j.erro === 'usuario ou senha invalidos' ? 'Usuário ou senha inválidos.'
            : (j.erro || 'Não foi possível entrar.');
          btn.disabled = false;
          return;
        }
        // A conta autentica; o apelido (só existe no dev) decide como a pessoa
        // aparece na sala. Sem apelido, aparece com o nome da conta.
        const campoAlias = document.getElementById('alias-input');
        const apelido = (campoAlias && campoAlias.value.trim().slice(0, 24)) || '';
        await safeSet('sessao', JSON.stringify({
          usuario: j.usuario, apelido, exp: j.exp, token: j.token
        }), false);
        state.nickname = apelido || j.usuario;
        err.textContent = '';
        await boot();
      }catch(e){
        console.error('[sala] não consegui falar com o serviço de login', e);
        err.textContent = e.name === 'AbortError'
          ? 'O serviço de login não respondeu. Tente novamente.'
          : 'Não consegui falar com o serviço de login. Verifique sua conexão.';
        btn.disabled = false;
      }
      return;
    }

    // Só chega aqui se AUTH_ENDPOINT estiver vazio — arquivo mal configurado.
    err.textContent = 'Login não configurado neste arquivo. Avise o administrador.';
  }

  // ---------- SAIR DA CONTA ----------
  // NADA de assíncrono entre o clique e a navegação. Duas versões anteriores
  // deste botão falhavam calada: a primeira esperava `leaveVoice()`, que faz
  // três remoções em série no banco; a segunda limitava essa espera a 2s, mas
  // ainda punha um `await` antes de navegar. Qualquer coisa que quebre dentro
  // de uma função `async` some numa promise rejeitada, sem erro na tela e sem
  // sair. Agora a função é síncrona de ponta a ponta.
  //
  // A limpeza da voz continua acontecendo — só não é esperada. Se ela falhar,
  // a presença expira sozinha pelo tempo de vida das chaves.
  function sairDaConta(){
    console.info('[sala] saindo da conta');
    try{ apagarSessaoDeTodos(); }catch(e){ console.warn('[sala] falha ao apagar a sessão', e); }
    try{ window.storage.delete('nickname', false); }catch(e){}
    try{ leaveVoice(); }catch(e){ console.warn('[sala] falha ao encerrar a voz', e); }
    voltarParaPorta();
  }

  // Exposto de propósito: rodar `__SALA_SAIR()` no console separa "o clique não
  // chega no botão" de "a saída em si não funciona", sem precisar adivinhar.
  window.__SALA_SAIR = sairDaConta;

  document.getElementById('leave-btn').addEventListener('click', sairDaConta);

  // ---------- TROCA DE AMBIENTE ----------
  // Volta para a tela de escolha, e NÃO apaga a sessão — é a diferença inteira
  // entre este botão e o "sair". O index, encontrando a sessão válida, mostra
  // direto a lista de ambientes, com o contador de quem está em cada um; não
  // passa pelo login nem pela pergunta do apelido.
  //
  // Por isso ele NÃO usa voltarParaPorta(): aquela função apaga a sessão dos
  // três espaços antes de navegar, que é justamente o que não se quer aqui.
  function irParaEscolhaDeAmbiente(){
    const destino = (window.__SALA_PORTA && window.__SALA_PORTA.endereco) || './';
    console.info('[sala] voltando para a escolha de ambiente');
    try{ location.href = destino; }
    catch(e){ console.warn('[sala] não consegui voltar para a escolha de ambiente', e); }
  }

  document.getElementById('troca-amb-btn')
    .addEventListener('click', irParaEscolhaDeAmbiente);

  // ---------- NOME DO SERVIDOR ----------
  async function loadServerName(){
    // Vem do código, não do banco. A chave 'server-name' deixou de ser usada;
    // apagar aqui evita deixar lixo para trás.
    state.serverName = NOME_FIXO;
    safeDelete('server-name', true);
  }
  function renderServerName(){
    document.getElementById('server-initial').textContent = initials(state.serverName);
    const el = document.getElementById('server-name');
    // Nome fixo: nada de editar. E sem selo ao lado — o próprio nome já diz
    // o ambiente, e a cor continua no ícone da barra e na faixa do topo.
    el.innerHTML = `<span>${escapeHtml(state.serverName)}</span>`;
  }
  // ---------- CANAIS DE TEXTO ----------
  async function loadChannels(bruto){
    const raw = bruto !== undefined ? bruto : await safeGet('channels', true);
    let ch = null;
    if (raw){ try{ ch = JSON.parse(raw); }catch(e){ ch = null; } }
    if (!ch || !Array.isArray(ch) || ch.length === 0){
      ch = [{id:'geral', name:'geral'}];
      await safeSet('channels', JSON.stringify(ch), true);
    }
    ch = ch.filter(c => c && idValido(c.id) && typeof c.name === 'string' && c.name.length <= 64);
    if (!ch.length) ch = [{id:'geral',name:'geral'}];
    state.channels = ch;
    if (!state.activeChannelId || !ch.find(c => c.id === state.activeChannelId)){
      state.activeChannelId = ch[0].id;
    }
  }

  function renderChannels(){
    const list = document.getElementById('channel-list');
    const sig = JSON.stringify([state.channels, state.activeChannelId]);
    if (list._sig === sig) return;
    list._sig = sig;
    list.innerHTML = '';
    state.channels.forEach(c => {
      const div = document.createElement('div');
      div.className = 'channel-item' + (c.id === state.activeChannelId ? ' active' : '');
      div.innerHTML = `<span class="hash">#</span><span>${escapeHtml(c.name)}</span>`;
      div.addEventListener('click', () => switchChannel(c.id));
      list.appendChild(div);
    });
    const activeCh = state.channels.find(c => c.id === state.activeChannelId);
    document.getElementById('active-channel-name').textContent = activeCh ? activeCh.name : '';
  }

  function switchChannel(id){
    if (id === state.activeChannelId) return;
    state.activeChannelId = id;
    state.pedirTudo = true;   // o delta ainda não conhece as mensagens deste canal
    renderChannels();
    loadMessages(true);
  }

  document.getElementById('add-channel-btn').addEventListener('click', () => {
    document.getElementById('new-channel-row').classList.toggle('show');
    document.getElementById('new-channel-input').focus();
  });
  document.getElementById('new-channel-confirm').addEventListener('click', createChannel);
  document.getElementById('new-channel-input').addEventListener('keydown', e => { if(e.key==='Enter') createChannel(); });

  async function createChannel(){
    const input = document.getElementById('new-channel-input');
    const raw = input.value.trim();
    if (!raw) return;
    const id = slugify(raw) + '-' + Math.random().toString(36).slice(2,6);
    const name = slugify(raw);
    const current = await safeGet('channels', true);
    let ch = [];
    try{ ch = JSON.parse(current) || []; }catch(e){ ch = []; }
    ch.push({id, name});
    await safeSet('channels', JSON.stringify(ch), true);
    state.channels = ch;
    input.value = '';
    document.getElementById('new-channel-row').classList.remove('show');
    switchChannel(id);
  }

  // ---------- MENSAGENS ----------
  let lastRenderedCount = -1;
  async function loadMessages(forceScroll, bruto){
    const channel = state.activeChannelId;
    let cache = CHAT_CACHE.get(channel);
    if (!cache){ cache = { legacy: [], recent: [], revision: null, checked: 0, request: 0 }; CHAT_CACHE.set(channel, cache); }
    const request = ++cache.request;
    try{
      const [raw, head] = await Promise.all([
        bruto !== undefined ? Promise.resolve(bruto) : safeGet('messages:' + channel, true),
        window.storage.messageHead(channel)
      ]);
      if (request !== cache.request) return;
      if (raw !== null){ try{ cache.legacy = mensagensValidas(JSON.parse(raw)); }catch(_){} }
      const revision = head.revision;
      if (forceScroll || revision === null || revision !== cache.revision || Date.now() - cache.checked > 60000){
        const rows = await window.storage.recentMessages(channel);
        if (request !== cache.request) return;
        cache.recent = mensagensValidas(rows.map(row => { try{ return JSON.parse(row.value); }catch(_){ return null; } }));
        cache.revision = revision;
        cache.checked = Date.now();
      }
      const unique = new Map();
      for (const message of [...cache.legacy, ...cache.recent]) unique.set(message.id, message);
      const arr = [...unique.values()].sort((a,b) => a.ts - b.ts || a.id.localeCompare(b.id)).slice(-200);
      if (state.activeChannelId === channel) renderMessages(arr, forceScroll);
    }catch(error){ console.warn('[chat] leitura falhou', error); }
  }

  function renderMessages(arr, forceScroll){
    const box = document.getElementById('messages');
    const signature = JSON.stringify([state.activeChannelId, arr]);
    if (box._signature === signature){ if (forceScroll) box.scrollTop = box.scrollHeight; return; }
    box._signature = signature;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    if (!arr.length){ box.innerHTML = '<div class="empty">Nenhuma mensagem ainda. Seja o primeiro a dizer oi 👋</div>'; return; }
    box.innerHTML = arr.map(m => '<div class="msg"><div class="avatar" style="background:' + colorFor(m.author) + '">' + escapeHtml(initials(m.author)) +
      '</div><div class="body"><div class="meta"><span class="who">' + escapeHtml(m.author) + '</span><span class="ts">' + timeFmt(m.ts) +
      '</span></div><div class="text">' + escapeHtml(m.text) + '</div></div></div>').join('');
    if (forceScroll || atBottom) box.scrollTop = box.scrollHeight;
  }

  document.getElementById('send-btn').addEventListener('click', sendMessage);
  document.getElementById('msg-input').addEventListener('keydown', e => { if(e.key==='Enter') sendMessage(); });

  async function sendMessage(){
    const input = document.getElementById('msg-input');
    const button = document.getElementById('send-btn');
    const text = input.value.trim().slice(0,1000);
    if (!text || CHAT_SENDING) return;
    CHAT_SENDING = true;
    const channel = state.activeChannelId;
    const message = { id: crypto.randomUUID(), author: state.nickname, text, ts: window.agoraServidor() };
    input.disabled = true; button.disabled = true; button.textContent = 'Enviando…';
    try{
      const ok = await safeSet('msg:' + channel + ':' + message.id, JSON.stringify(message), true);
      if (!ok){ showToast('Mensagem não enviada. O texto foi mantido para tentar novamente.'); return; }
      if (input.value.trim().slice(0,1000) === text) input.value = '';
      CHAT_CACHE.delete(channel);
      if (state.activeChannelId === channel) await loadMessages(true);
    } finally {
      CHAT_SENDING = false; input.disabled = false; button.disabled = false; button.textContent = 'Enviar'; input.focus();
    }
  }

  // ---------- MEMBROS / PRESENÇA (texto) ----------
  // Uma linha por pessoa (mb:<apelido>) em vez de um mapa numa linha só. Antes
  // todos reescreviam a MESMA linha a cada ciclo, e o banco serializa isso —
  // com gente suficiente virava fila de espera. Agora cada um escreve a sua.
  async function heartbeatAndLoadMembers(){
    const now = window.agoraServidor ? window.agoraServidor() : Date.now();
    const [, rows] = await Promise.all([
      safeSet('mb:' + state.nickname, String(now), true, 1),
      safeList('mb:')
    ]);
    if (!rows) return;
    const members = {};
    for (const r of rows){
      const nome = r.key.slice(3);
      const ts = Number(r.value) || 0;
      if (nome && now - ts <= STALE_MEMBER_MS) members[nome] = ts;
    }
    members[state.nickname] = now;
    state.members = members;
    renderMembers();
  }

  function renderMembers(){
    // compara com carimbos escritos por outras pessoas: relógio do servidor
    const now = window.agoraServidor ? window.agoraServidor() : Date.now();
    const names = Object.keys(state.members).sort();
    const onlineCount = names.filter(n => now - state.members[n] < ONLINE_WINDOW_MS).length;

    document.getElementById('online-count').textContent = onlineCount;
    document.getElementById('members-title').textContent = 'Membros — ' + names.length;

    const list = document.getElementById('members-list');
    list.innerHTML = names.map(n => {
      const on = now - state.members[n] < ONLINE_WINDOW_MS;
      return `
        <div class="member-row ${on ? 'on':'off'}">
          <div class="avatar" style="background:${colorFor(n)}">${escapeHtml(initials(n))}
            <div class="status-dot ${on?'on':'off'}"></div>
          </div>
          <div class="mname">${escapeHtml(n)}${n===state.nickname ? ' (você)':''}</div>
        </div>
      `;
    }).join('');
  }

  document.getElementById('member-toggle-btn').addEventListener('click', () => {
    document.getElementById('members-panel').classList.toggle('hidden');
    sincronizarGavetas();
  });

  // ---------- GAVETAS DO CELULAR ----------
  // No desktop nada disto acontece: a classe não é ligada e os painéis seguem
  // lado a lado. No celular, canais e membros saem do fluxo e viram gavetas.
  if (MOBILE_OK){
    document.body.classList.add('mobile-ok');
    // O painel de membros nasce visível no desktop. Como gaveta, isso o
    // deixaria aberto no carregamento, tapando o chat — então começa fechado.
    if (ESTREITO()) document.getElementById('members-panel').classList.add('hidden');
  }

  // O fundo escuro é um só para as duas gavetas, e precisa saber quando
  // aparecer. A classe do menu é nossa; a de membros é a .hidden que o botão
  // já alternava antes de existir celular, então é traduzida aqui.
  function sincronizarGavetas(){
    if (!MOBILE_OK) return;
    const membrosAbertos = ESTREITO()
      && !document.getElementById('members-panel').classList.contains('hidden');
    document.body.classList.toggle('membros-abertos', membrosAbertos);
  }

  function abrirMenu(v){
    document.body.classList.toggle('menu-aberto', v);
  }

  function fecharGavetas(){
    abrirMenu(false);
    if (ESTREITO()) document.getElementById('members-panel').classList.add('hidden');
    sincronizarGavetas();
  }

  document.getElementById('menu-btn').addEventListener('click', () => {
    // Abrir os canais fecha os membros: duas gavetas abertas ao mesmo tempo
    // não deixariam nada do chat à vista.
    if (ESTREITO()) document.getElementById('members-panel').classList.add('hidden');
    abrirMenu(!document.body.classList.contains('menu-aberto'));
    sincronizarGavetas();
  });

  document.getElementById('gaveta-fundo').addEventListener('click', fecharGavetas);
  window.matchMedia('(max-width: 600px)').addEventListener('change', fecharGavetas);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharGavetas(); });

  // Escolher um canal fecha a gaveta: sem isso a pessoa toca no canal e
  // continua olhando a lista, sem ver que a conversa mudou atrás.
  document.getElementById('sidebar').addEventListener('click', (e) => {
    if (!ESTREITO()) return;
    if (e.target.closest('.channel-item, .voice-item, .vo-row')) fecharGavetas();
  });

  /* =========================================================================
     VOZ EM GRUPO + COMPARTILHAMENTO DE TELA (malha WebRTC)

     Cada participante de um canal de voz abre uma conexão com cada outro.
     Quem tem o sessionId lexicograficamente menor faz a oferta; o outro responde.

     Cada conexão nasce com 3 transceivers em ordem fixa:
        0 = áudio do microfone
        1 = áudio da tela compartilhada
        2 = vídeo da tela compartilhada
     Eles são criados vazios e preenchidos com replaceTrack(), então começar ou
     parar de compartilhar a tela NÃO exige renegociar nada.

     Sinalização pela mesma tabela room_kv, com chaves prefixadas pelo
     destinatário (nunca read-modify-write numa chave compartilhada):
        sdp:<quemResponde>:<quemOferece>:<epoch>:o   -> oferta
        ans:<quemOferece>:<quemResponde>:<epoch>:a   -> resposta
        vp:<canal>:<sessao>                          -> presença no canal de voz
     ========================================================================= */

  const VOICE = {
    generation:0, joining:null, screenOperation:0, screenPending:false, screenProfile:'texto',
    channels: [],
    chan: null,
    joined: false,
    muted: false,
    deafened: false,
    volumeTela: 1,    // 0..1  quanto se ouve o áudio de quem compartilha
    micStream: null, micTrack: null,
    screenStream: null, screenVideoTrack: null, screenAudioTrack: null, screenSurface: null,
    sfuPublisher:null, sfuPublication:null, sfuStarting:false, sfuState:null,
    sfuLastStats:null, sfuAdaptLevel:0, sfuBadSamples:0, sfuGoodSamples:0,
    peers: Object.create(null),        // sessionId -> peer
    presence: {},     // canal -> [entrada]
    bySession: {},    // sessionId -> entrada
    analysers: {},
    sharers: [],
    stageSid: null,
    // Onde assistir é opcional, começa FECHADO: é opção de quem recebe, não
    // imposição de quem compartilha. Nos outros, começa aberto como sempre foi.
    // Quem inicia o próprio compartilhamento abre o palco na hora (ver
    // startScreen), porque quem envia precisa ver o que envia.
    stageHidden: ASSISTIR_OPCIONAL,
    timer: null,
    ticker: null,
    ice: null,
    ultimaFaxina: 0,
    volumes: {},        // nome -> 0..1     quanto se ouve cada pessoa
    silenciados: {},    // nome -> true     quem você escolheu não ouvir
    cadencia: 0,
    conhecidos: null,   // quem já estava no canal, para o bip de entrada/saída
    busy: false,
    speakRaf: null,
    _sig: null,
  };

  function fecharAssinaturaSFU(p){
    if (!p) return;
    clearTimeout(p.sfuRetryTimer); clearTimeout(p.sfuVideoTimer);
    p.sfuRetryTimer = null; p.sfuVideoTimer = null;
    p.sfuRetryAt = 0; p.sfuRetryPublication = null;
    p.sfuOperation = (p.sfuOperation || 0) + 1;
    const transport = p.sfuSubscriber;
    p.sfuSubscriber = null; p.sfuPublication = null; p.sfuScreen = null;
    p.screen = p.p2pScreen || new MediaStream();
    if (transport) transport.close().catch(error => console.warn('[sfu] encerramento de assinatura', error));
  }

  function reagendarAssinaturaSFU(p, publication, delay){
    clearTimeout(p.sfuRetryTimer);
    p.sfuRetryAt = Date.now() + delay;
    p.sfuRetryPublication = publication;
    p.sfuRetryTimer = setTimeout(() => {
      p.sfuRetryTimer = null;
      if (VOICE.peers[p.sid] !== p || assistirSid() !== p.sid) return;
      if (VOICE.bySession[p.sid]?.screenPublication !== publication) return;
      p.sfuRetryAt = 0; p.sfuRetryPublication = null;
      sincronizarAssinaturaSFU();
    }, delay);
  }

  function sincronizarAssinaturaSFU(){
    if (!SFU_TELA) return;
    const sid = assistirSid();
    for (const peer of Object.values(VOICE.peers)){
      if (peer.sid !== sid && (peer.sfuSubscriber || peer.sfuRetryTimer)) fecharAssinaturaSFU(peer);
    }
    const p = sid && VOICE.peers[sid];
    const presence = sid && VOICE.bySession[sid];
    const publication = presence?.sharing === true && presence.screenMode === 'sfu'
      ? presence.screenPublication : null;
    if (!p || !publication){ if (p?.sfuSubscriber) fecharAssinaturaSFU(p); return; }
    if (p.sfuSubscriber && p.sfuPublication === publication) return;
    if (Date.now() < (p.sfuRetryAt || 0) && p.sfuRetryPublication === publication) return;
    if (p.sfuSubscriber) fecharAssinaturaSFU(p);

    const operation = (p.sfuOperation || 0) + 1;
    const transport = novoSFU(function(){ updateStage(); });
    clearTimeout(p.sfuRetryTimer); clearTimeout(p.sfuVideoTimer);
    p.sfuRetryTimer = null; p.sfuVideoTimer = null;
    p.sfuRetryAt = 0; p.sfuRetryPublication = null;
    p.sfuOperation = operation; p.sfuSubscriber = transport; p.sfuPublication = publication;
    p.sfuScreen = null;
    transport.subscribe(publication).then(stream => {
      if (p.sfuOperation !== operation || p.sfuSubscriber !== transport){ transport.close(); return; }
      p.sfuScreen = stream; p.sfuError = null;
      const promoverSFU = () => {
        if (p.sfuOperation !== operation || p.sfuSubscriber !== transport) return;
        const video = stream.getVideoTracks()[0];
        if (!video || video.readyState !== 'live' || video.muted) return;
        if (p.screen !== stream){ p.screen = stream; window.__SALA_SFU = 'assistindo'; updateStage(); }
      };
      stream.getTracks().forEach(track => {
        track.addEventListener('mute', updateStage);
        track.addEventListener('unmute', () => { promoverSFU(); updateStage(); });
        track.addEventListener('ended', updateStage);
      });
      promoverSFU();
      // Uma sessão SFU pode conectar sem entregar a faixa remota (por exemplo,
      // quando o apresentador saiu e voltou enquanto outra tela seguia ativa).
      // Sem este vigia o espectador ficava em "Aguardando o vídeo" para sempre.
      p.sfuVideoTimer = setTimeout(() => {
        if (p.sfuOperation !== operation || p.sfuSubscriber !== transport) return;
        const video = p.sfuScreen?.getVideoTracks()[0];
        if (video && video.readyState === 'live' && !video.muted){ p.sfuVideoTimer = null; return; }
        fecharAssinaturaSFU(p);
        p.sfuError = 'A faixa de vídeo não chegou.';
        reagendarAssinaturaSFU(p, publication, 1200);
        updateStage();
      }, 8000);
      updateStage();
    }).catch(error => {
      if (p.sfuOperation !== operation) return;
      p.sfuSubscriber = null; p.sfuError = error.message || 'Falha no SFU';
      reagendarAssinaturaSFU(p, publication, 1000);
      console.warn('[sfu] assinatura indisponível', error);
      updateStage();
    });
  }

  // Lista fixa, vinda do código. A chave 'voice-channels' no banco não é mais
  // lida; apagar evita deixar lixo para trás.
  async function loadVoiceChannels(){
    VOICE.channels = CANAIS_VOZ;
    if (!VOICE._limpouCanais){ VOICE._limpouCanais = true; safeDelete('voice-channels', true); }
  }

  document.getElementById('add-voice-btn').addEventListener('click', () => {
    document.getElementById('new-voice-row').classList.toggle('show');
    document.getElementById('new-voice-input').focus();
  });
  document.getElementById('new-voice-confirm').addEventListener('click', createVoiceChannel);
  document.getElementById('new-voice-input').addEventListener('keydown', e => { if(e.key==='Enter') createVoiceChannel(); });

  async function createVoiceChannel(){
    const input = document.getElementById('new-voice-input');
    const raw = input.value.trim();
    if (!raw) return;
    const id = 'voz-' + slugify(raw) + '-' + Math.random().toString(36).slice(2,6);
    const current = await safeGet('voice-channels', true);
    let ch = [];
    try{ ch = JSON.parse(current) || []; }catch(e){ ch = []; }
    ch.push({ id, name: raw.slice(0,24) });
    await safeSet('voice-channels', JSON.stringify(ch), true);
    VOICE.channels = ch;
    input.value = '';
    document.getElementById('new-voice-row').classList.remove('show');
    VOICE._sig = null;
    renderVoice();
  }

  // ---------- entrar / sair da chamada ----------
  async function joinVoice(chanId){
    if (!CANAIS_VOZ.some(c => c.id === chanId)) return false;
    if (VOICE.joined && VOICE.chan === chanId) return true;
    if (VOICE.joining) return VOICE.joining.promise;
    if (VOICE.joined) await leaveVoice(true);
    const attempt = { generation:++VOICE.generation, chan:chanId, promise:null };
    VOICE.joining = attempt; VOICE._sig = null; renderVoice();
    attempt.promise = (async () => {
      let raw = null, graph = null;
      const valid = () => VOICE.joining === attempt && VOICE.generation === attempt.generation;
      try{
        await resumeAudio();
        // TURN preparation overlaps the permission prompt, without changing its backend.
        const iceTask = resolverIceServers();
        try{ raw = await adquirirMicrofone(); if (valid()) graph = await montarPortao(raw); }
        catch(error){ if (valid()) showToast('Entrando só para ouvir. ' + error.message); }
        const ice = await iceTask;
        if (!valid()){ graph?.dispose(); pararStream(raw); return false; }
        VOICE.micStream = raw; PORTAO.grafo = graph;
        VOICE.micTrack = graph?.track || raw?.getAudioTracks()[0] || null;
        if (VOICE.micTrack) VOICE.micTrack.enabled = !VOICE.muted;
        VOICE.ice = ice; VOICE.chan = chanId; VOICE.joined = true; VOICE.joining = null; VOICE.conhecidos = null;
        INC++; document.body.classList.add('in-call');
        if (VOICE.micTrack) attachAnalyser(SID, graph?.stream || raw);
        mostrarModoMicrofone(); listarMicrofones(); startSpeakLoop();
        VOICE._sig = null; renderVoice(); restartVoiceTimer(); voiceTick();
        return true;
      }catch(error){ graph?.dispose(); pararStream(raw); console.error('[voz] entrada', error); return false; }
      finally{ if (VOICE.joining === attempt){ VOICE.joining = null; VOICE._sig = null; if(!VOICE.joined)document.body.classList.remove('in-call'); renderVoice(); } }
    })();
    return attempt.promise;
  }

  async function leaveVoice(keepTimer){
    ++VOICE.generation; VOICE.joining = null;
    const chan = VOICE.chan;
    VOICE.joined = false; VOICE.conhecidos = null;
    stopScreen(true); Object.keys(VOICE.peers).forEach(destroyPeer); desmontarPortao();
    pararStream(VOICE.micStream); VOICE.micStream = null; VOICE.micTrack = null;
    detachAnalyser(SID); stopSpeakLoop(); document.body.classList.remove('in-call'); mostrarPainelAudio(false);
    VOICE._sig = null; renderVoice(); updateStage();
    if (!keepTimer) restartVoiceTimer();
    if (chan) await safeDelete('vp:' + chan + ':' + SID, true);
    // SDP/candidate keys are unique per negotiation and expire through existing cleanup.
  }

  // Chrome estrangula setInterval para ~1x por minuto em aba de segundo plano.
  // Com isso a presença expira e a chamada cai sozinha assim que alguém
  // minimiza a janela ou troca de aba — provavelmente a causa mais comum de
  // "caiu do nada". Timer dentro de um Web Worker não sofre esse limite.
  function makeTicker(fn){
    let worker = null, fallback = null;
    try{
      const src = 'let id=null;onmessage=function(e){if(id){clearInterval(id);id=null;}' +
                  'if(e.data>0){id=setInterval(function(){postMessage(1);},e.data);}};';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type:'text/javascript' })));
      worker.onmessage = () => fn();
    }catch(e){ worker = null; }
    return {
      viaWorker: !!worker,
      set(ms){
        if (worker){ worker.postMessage(ms); return; }
        if (fallback) clearInterval(fallback);
        fallback = setInterval(fn, ms);
      }
    };
  }

  // Enquanto há par negociando, o ciclo precisa ser rápido. Depois que todos
  // conectaram, só a presença importa — e aí vale poupar o banco.
  function ajustarCadencia(){
    if (!VOICE.joined) return;
    const pares = Object.values(VOICE.peers);
    const negociando = pares.some(p => !p.pc || p.pc.connectionState !== 'connected');
    const alvo = negociando ? VOICE_TICK_MS : VOICE_CALMO_MS;
    if (VOICE.cadencia !== alvo && VOICE.ticker){
      VOICE.cadencia = alvo;
      VOICE.ticker.set(alvo);
    }
  }

  function restartVoiceTimer(){
    if (!VOICE.ticker){
      VOICE.ticker = makeTicker(voiceTick);
      window.__SALA_TICKER = VOICE.ticker.viaWorker ? 'worker' : 'setInterval';
    }
    VOICE.cadencia = VOICE.joined ? VOICE_TICK_MS : VOICE_IDLE_TICK_MS;
    VOICE.ticker.set(VOICE.cadencia);
  }

  // Volta da rede ou da aba: força um ciclo imediato em vez de esperar o timer.
  window.addEventListener('online', () => { if (VOICE.joined) voiceTick(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && VOICE.joined) voiceTick();
  });

  // ---------- loop de presença + sinalização ----------
  async function voiceTick(){
    if (VOICE.busy){ VOICE.tickAgain = true; return; }
    VOICE.busy = true;
    const generation = VOICE.generation;
    try{
      const now = Date.now();                    // relógio local: só para contas internas
      const agora = window.agoraServidor ? window.agoraServidor() : now;  // comparado entre pessoas

      // Escrever a própria presença e ler a dos outros são independentes: em
      // paralelo o ciclo custa uma ida ao banco em vez de duas.
      const escrevendo = VOICE.joined
        ? safeSet('vp:' + VOICE.chan + ':' + SID, JSON.stringify({
          name: state.nickname, session: SID, chan: VOICE.chan, ts: agora, inc: INC,
            muted: VOICE.muted || !VOICE.micTrack,
            sharing: !!VOICE.screenVideoTrack && (!VOICE.sfuStarting || !!VOICE.sfuPublication),
            screenMode: VOICE.sfuPublication ? 'sfu' : 'p2p',
            screenPublication: VOICE.sfuPublication || undefined,
            protocol:6, watching:assistirSid(), screenFallback:precisaFallbackTela() || undefined
          }), true, 1)
        : Promise.resolve(true);

      // Faxina de sinalização abandonada, no máximo uma vez por minuto. Sem
      // await: não vale atrasar o ciclo por causa de limpeza.
      if (VOICE.joined && now - VOICE.ultimaFaxina > 60000){
        VOICE.ultimaFaxina = now;
        safeDeleteOlderThan('sdp:', 300000);
        safeDeleteOlderThan('ans:', 300000);
        safeDeleteOlderThan('ice:', 300000);
        safeDeleteOlderThan('mb:', STALE_MEMBER_MS * 2);
      }

      const [, rows] = await Promise.all([escrevendo, safeList('vp:')]);
      if (generation !== VOICE.generation) return;
      if (rows){
        const presence = Object.create(null), bySession = Object.create(null);
        for (const r of rows){
          let e = null;
          try{ e = JSON.parse(r.value); }catch(_){ continue; }
          if (!presencaValida(e) || e.ts > agora + 60000) continue;
          if (agora - e.ts > VOICE_STALE_MS){
            if (!VOICE.joined || e.session !== SID) safeDelete(r.key, true);
            continue;
          }
          (presence[e.chan] = presence[e.chan] || []).push(e);
          bySession[e.session] = e;
        }
        VOICE.presence = presence;
        VOICE.bySession = bySession;
      }

      if (VOICE.joined){
        const mine = (VOICE.presence[VOICE.chan] || []).filter(e => e.session !== SID);
        const wanted = new Set(mine.map(e => e.session));

        // Na primeira passada só memoriza quem já estava — senão entrar numa
        // sala cheia dispararia uma salva de bips. Depois disso, um bip por
        // tick para chegadas e um para saídas, mesmo que venham vários juntos.
        if (VOICE.conhecidos === null){
          VOICE.conhecidos = wanted;
        } else {
          let chegou = false, saiu = false;
          for (const s of wanted) if (!VOICE.conhecidos.has(s)) chegou = true;
          for (const s of VOICE.conhecidos) if (!wanted.has(s)) saiu = true;
          VOICE.conhecidos = wanted;
          if (chegou) tocarBip(true);
          if (saiu) tocarBip(false);
        }
        // A presença é só uma DICA de quem está no canal. Se a mídia continua
        // chegando, a pessoa está aí — e derrubar uma conexão saudável porque o
        // Supabase demorou a responder era o que fazia a call inteira cair de
        // uma vez. Quem sai de verdade some pelo estado da conexão, não por isto.
        for (const sid of Object.keys(VOICE.peers)){
          const p = VOICE.peers[sid];
          if (wanted.has(sid)){ p.visto = now; continue; }
          const conectado = p.pc && p.pc.connectionState === 'connected';
          if (conectado && now - (p.visto || p.startedAt || now) < 120000) continue;
          destroyPeer(sid);
        }
        for (const e of mine){
          const atual = VOICE.peers[e.session];
          // Saiu e voltou sem recarregar a página: mesmo sessionId, encarnação
          // nova. O par antigo está morto dos dois lados — recomeça do zero em
          // vez de tentar remendar uma conexão que nunca vai voltar.
          if (atual && atual.inc !== e.inc){ destroyPeer(e.session); }
          if (!VOICE.peers[e.session]) createPeer(e.session, e.name, e.inc);
          else if (atual){ atual.name = e.name; atual.protocol = e.protocol; }
          applyLocalTracks(VOICE.peers[e.session]);
        }
        await signalingPass();
      } else if (Object.keys(VOICE.peers).length){
        Object.keys(VOICE.peers).forEach(destroyPeer);
      }

      renderVoice();
      updateStage();
      ajustarCadencia();
    } finally {
      VOICE.busy = false;
      if (VOICE.tickAgain){ VOICE.tickAgain = false; queueMicrotask(voiceTick); }
    }
  }

  // ---------- peers ----------
  function createPeer(sid, name, inc){
    const p = {
      sid, name, inc, protocol:VOICE.bySession[sid]?.protocol,
      offerer: SID < sid,
      pc: null, send: null,
      epoch: 0, tries: 0, appliedEpoch: -1, quedaEm: 0, mortoEm: 0, visto: 0,
      screen: new MediaStream(), p2pScreen: new MediaStream(), sfuScreen:null,
      audioEl: null,
      startedAt: 0,
      gotMic: false,
      dead: false,
    };
    VOICE.peers[sid] = p;
    buildPc(p);
  }

  function destroyPeer(sid){
    const p = VOICE.peers[sid];
    if (!p) return;
    if (p.sfuSubscriber) fecharAssinaturaSFU(p);
    if (p.pc){ try{ p.pc.close(); }catch(e){} }
    if (p.audioEl){ try{ p.audioEl.srcObject = null; p.audioEl.remove(); }catch(e){} }
    detachAnalyser(sid);
    delete VOICE.peers[sid];
    // Limpa as duas direções: o que ele escreveu para mim E o que eu escrevi
    // para ele. Sobra deste segundo grupo é o que faz uma reconexão pegar uma
    // oferta velha e travar.
    safeDeletePrefix('sdp:' + SID + ':' + sid + ':');
    safeDeletePrefix('ans:' + SID + ':' + sid + ':');
    safeDeletePrefix('sdp:' + sid + ':' + SID + ':');
    safeDeletePrefix('ans:' + sid + ':' + SID + ':');
    VOICE._sig = null;
  }

  function buildPc(p){
    if (p.pc){ try{ p.pc.close(); }catch(e){} }
    const pc = new RTCPeerConnection({
      iceServers: VOICE.ice || ICE_SERVERS,
      bundlePolicy: 'max-bundle',
      iceTransportPolicy: window.__SALA_SO_RELAY ? 'relay' : 'all'
    });
    p.pc = pc;
    p.send = null;
    p.gotMic = false;
    p.startedAt = Date.now();
    p.quedaEm = 0;
    p.p2pScreen = new MediaStream();
    if (!p.sfuSubscriber) p.screen = p.p2pScreen;

    // v6 peers exchange late ICE candidates over the existing key/value table.
    pc.addEventListener('icecandidate', event => {
      if (!event.candidate || p.pc !== pc || !pc._signalEpoch || p.protocol !== 6) return;
      const key = 'ice:' + p.sid + ':' + SID + ':' + pc._signalEpoch + ':' + crypto.randomUUID();
      safeSet(key, JSON.stringify(event.candidate.toJSON()), true, 1);
    });

    pc.addEventListener('track', ev => onRemoteTrack(p, ev));
    pc.addEventListener('connectionstatechange', () => {
      if (p.pc !== pc) return;
      const st = pc.connectionState;
      if (st === 'connected'){
        // Zera o orçamento de tentativas. Sem isso, quatro engasgos ao longo de
        // uma call longa marcavam o par como morto para sempre.
        p.tries = 0; p.dead = false; p.quedaEm = 0;
      } else if (st === 'disconnected'){
        if (!p.quedaEm) p.quedaEm = Date.now();
      }
      VOICE._sig = null;
      renderVoice();
      updateStage();
    });

    if (p.offerer) makeOffer(p);
  }

  async function makeOffer(p){
    const pc = p.pc;
    const epoch = nextEpoch();
    p.epoch = epoch;
    try{
      const tMic  = pc.addTransceiver('audio', { direction:'sendrecv' });
      const tScrA = pc.addTransceiver('audio', { direction:'sendrecv' });
      const tScrV = pc.addTransceiver('video', { direction:'sendrecv' });
      p.send = { mic: tMic.sender, scrA: tScrA.sender, scrV: tScrV.sender };
      await applyLocalTracks(p);

      const offer = await pc.createOffer();
      if (p.pc !== pc) return;
      pc._signalEpoch = epoch;
      await pc.setLocalDescription(offer);
      if (p.protocol !== 6) await waitIce(pc);
      if (p.pc !== pc) return;
      await safeSet('sdp:' + p.sid + ':' + SID + ':' + epoch + ':o', JSON.stringify(pc.localDescription), true, 1);
    }catch(e){
      console.error('makeOffer falhou', e);
    }
  }

  async function acceptOffer(p, desc, epoch){
    // Se a conexão atual já foi negociada, uma oferta nova significa que o outro
    // lado recomeçou — descartamos e montamos uma conexão limpa.
    if (!p.pc || p.pc.currentRemoteDescription || p.pc.signalingState !== 'stable'){
      buildPc(p);
    }
    const pc = p.pc;
    try{
      if (!desc || desc.type !== 'offer' || typeof desc.sdp !== 'string' || desc.sdp.length > 200000) return;
      p.epoch = epoch;
      pc._signalEpoch = epoch;
      await pc.setRemoteDescription(desc);
      const tr = pc.getTransceivers();
      p.send = { mic: tr[0] && tr[0].sender, scrA: tr[1] && tr[1].sender, scrV: tr[2] && tr[2].sender };
      tr.forEach(t => { try{ t.direction = 'sendrecv'; }catch(e){} });
      await applyLocalTracks(p);

      const answer = await pc.createAnswer();
      if (p.pc !== pc) return;
      await pc.setLocalDescription(answer);
      if (p.protocol !== 6) await waitIce(pc);
      if (p.pc !== pc) return;
      await safeSet('ans:' + p.sid + ':' + SID + ':' + epoch + ':a', JSON.stringify(pc.localDescription), true, 1);
      p.appliedEpoch = epoch;
    }catch(e){
      console.error('acceptOffer falhou', e);
    }
  }

  async function signalingPass(){
    const peers = Object.values(VOICE.peers);
    const saudavel = pc => pc && pc.connectionState === 'connected';

    // Quem responde precisa continuar procurando ofertas enquanto o par não
    // estiver saudável. A condição anterior parava de procurar assim que uma
    // oferta era aplicada uma vez — então uma renegociação vinda do outro lado
    // nunca era vista, e o par só voltava quando o watchdog local estourava.
    const waitingOffer  = peers.some(p => !p.offerer && !saudavel(p.pc));
    const waitingAnswer = peers.some(p =>  p.offerer && p.pc && !p.pc.currentRemoteDescription);

    if (waitingOffer){
      const rows = await safeList('sdp:' + SID + ':');

      // Fica só com a oferta mais recente de cada par; as anteriores viram lixo.
      const melhor = {};
      for (const r of (rows || [])){
        const parts = r.key.split(':');           // sdp : eu : ofertante : epoch : o
        const from = parts[2], epoch = Number(parts[3]);
        const p = VOICE.peers[from];
        if (!p || !(epoch > p.appliedEpoch)){ safeDelete(r.key, true); continue; }
        if (melhor[from] && melhor[from].epoch >= epoch){ safeDelete(r.key, true); continue; }
        if (melhor[from]) safeDelete(melhor[from].key, true);
        melhor[from] = { key: r.key, value: r.value, epoch, p };
      }

      // Em paralelo, e não em série: cada acceptOffer espera o ICE (até 4s), e
      // em fila o último par de uma sala grande estouraria o watchdog antes
      // mesmo de ser atendido.
      await Promise.all(Object.values(melhor).map(async item => {
        let desc = null;
        try{ desc = JSON.parse(item.value); }catch(e){ safeDelete(item.key, true); return; }
        await acceptOffer(item.p, desc, item.epoch);
        safeDelete(item.key, true);
      }));
    }

    if (waitingAnswer){
      const rows = await safeList('ans:' + SID + ':');
      for (const r of (rows || [])){
        const parts = r.key.split(':');           // ans : eu : respondente : epoch : a
        const from = parts[2], epoch = Number(parts[3]);
        const p = VOICE.peers[from];
        if (!p || !p.pc){ safeDelete(r.key, true); continue; }
        if (epoch !== p.epoch){ safeDelete(r.key, true); continue; }
        if (p.pc.currentRemoteDescription){ safeDelete(r.key, true); continue; }
        try{ await p.pc.setRemoteDescription(JSON.parse(r.value)); }catch(e){ console.error('setRemote(answer)', e); }
        safeDelete(r.key, true);
      }
    }

    if (peers.some(p => p.protocol === 6 && p.pc && !saudavel(p.pc))){
      const candidates = await safeList('ice:' + SID + ':');
      for (const row of (candidates || [])){
        const parts = row.key.split(':'), peer = VOICE.peers[parts[2]], epoch = Number(parts[3]);
        if (!peer || epoch < peer.epoch){ safeDelete(row.key,true); continue; }
        if (epoch !== peer.epoch || !peer.pc?.remoteDescription) continue;
        const pc = peer.pc;
        try{
          const candidate = JSON.parse(row.value);
          if (typeof candidate.candidate === 'string' && candidate.candidate.length < 4096) await pc.addIceCandidate(candidate);
          safeDelete(row.key,true);
        }catch(error){ if(peer.pc === pc){console.warn('[ICE] candidato recusado',error.name);safeDelete(row.key,true);} }
      }
    }

    // Watchdog. 'failed' é definitivo e refaz na hora; 'disconnected' costuma se
    // resolver sozinho em poucos segundos, então ganha uma carência antes de
    // pagar o custo de uma renegociação inteira.
    const agora = Date.now();
    for (const p of peers){
      if (!p.pc || !VOICE.peers[p.sid]) continue;
      const st = p.pc.connectionState;

      let refazer = false;
      if (st === 'failed') refazer = true;
      else if (st === 'disconnected') refazer = !!p.quedaEm && (agora - p.quedaEm > PEER_DROP_GRACE_MS);
      else if (st !== 'connected') refazer = agora - p.startedAt > PEER_TIMEOUT_MS;
      if (!refazer) continue;

      if (p.tries >= MAX_PEER_TRIES){
        // Não desiste para sempre: se a rede voltar, tenta de novo sozinho em
        // vez de exigir que a pessoa saia e entre na chamada.
        if (!p.mortoEm){ p.mortoEm = agora; p.dead = true; VOICE._sig = null; }
        if (agora - p.mortoEm < 60000) continue;
        p.tries = 0; p.mortoEm = 0; p.dead = false; VOICE._sig = null;
      }

      p.tries++;
      p.appliedEpoch = -1;
      await safeDeletePrefix('sdp:' + SID + ':' + p.sid + ':');
      await safeDeletePrefix('ans:' + SID + ':' + p.sid + ':');
      buildPc(p);
    }
  }

  // Compatibilidade com clientes anteriores à v6, que recebem candidatos no
  // SDP. Candidatos coletados após este prazo não chegam a esses clientes.
  // Entre clientes v6, buildPc/signalingPass entregam candidatos por Trickle ICE.
  function waitIce(pc){
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
      let pronto = false;
      let temUsavel = false;
      let graca = null;

      const encerrar = () => {
        if (pronto) return;
        pronto = true;
        pc.removeEventListener('icecandidate', onCand);
        pc.removeEventListener('icegatheringstatechange', onEstado);
        clearTimeout(graca);
        clearTimeout(teto);
        resolve();
      };
      const onCand = (ev) => {
        if (!ev.candidate){ encerrar(); return; }        // coleta terminou
        if (temUsavel) return;
        if (/ typ (srflx|relay)/.test(ev.candidate.candidate || '')){
          temUsavel = true;
          graca = setTimeout(encerrar, 350);
        }
      };
      const onEstado = () => { if (pc.iceGatheringState === 'complete') encerrar(); };

      pc.addEventListener('icecandidate', onCand);
      pc.addEventListener('icegatheringstatechange', onEstado);
      const teto = setTimeout(encerrar, 2500);           // rede muito ruim: não trava
    });
  }

  function applyLocalTracks(p){
    p.trackQueue = (p.trackQueue || Promise.resolve()).catch(() => {}).then(async () => {
      const pc = p.pc;
      if (!p.send || !pc || pc.signalingState === 'closed' || VOICE.peers[p.sid] !== p) return;
      const send = p.send;
      const screen = querMinhaTela(p);
      const pairs = [[send.mic,VOICE.micTrack],[send.scrA,screen ? VOICE.screenAudioTrack : null],[send.scrV,screen ? VOICE.screenVideoTrack : null]];
      for (const [sender,track] of pairs){
        if (p.pc !== pc) return;
        if (sender && sender.track !== (track || null)) await sender.replaceTrack(track || null);
      }
      if (p.pc === pc && send.scrV?.track) await tuneScreenSender(p);
      p.mediaError = null;
    }).catch(error => {
      console.warn('[mídia] envio falhou', error);
      p.mediaError = error.name || 'Falha de mídia';
      if (Date.now() - (p.mediaToast || 0) > 15000){ p.mediaToast = Date.now(); showToast('Falha ao atualizar uma transmissão. Veja o diagnóstico da chamada.'); }
    });
    return p.trackQueue;
  }

  // Sem isto o navegador derruba a resolução da tela compartilhada para caber
  // num bitrate baixo — é o que deixa texto compartilhado ilegível.
  async function tuneScreenSender(p){
    const sender = p.send?.scrV;
    if (!sender?.track) return;
    const profile = SCREEN_PROFILES[VOICE.screenProfile] || SCREEN_PROFILES.texto;
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    const scale = [1, 1.5, 2][p.adaptLevel || 0];
    parameters.degradationPreference = profile.degradation;
    parameters.encodings[0].maxBitrate = Math.round(profile.bitrate / scale);
    parameters.encodings[0].maxFramerate = (p.adaptLevel || 0) >= 2 ? Math.min(15,profile.fps) : profile.fps;
    parameters.encodings[0].scaleResolutionDownBy = scale;
    await sender.setParameters(parameters);
  }

  function onRemoteTrack(p, ev){
    const track = ev.track;
    let idx = -1;
    try{ idx = p.pc.getTransceivers().indexOf(ev.transceiver); }catch(e){}
    const isMic = idx === 0 || (idx < 0 && track.kind === 'audio' && !p.gotMic);

    if (isMic){
      p.gotMic = true;
      if (!p.audioEl){
        const a = document.createElement('audio');
        a.autoplay = true;
        a.setAttribute('playsinline','');
        document.getElementById('audio-sink').appendChild(a);
        p.audioEl = a;
      }
      const ms = new MediaStream([track]);
      p.audioEl.srcObject = ms;
      aplicarAudioDoPar(p);
      p.audioEl.play().catch(() => showUnblockAudio());
      attachAnalyser(p.sid, ms);
      return;
    }

    // Áudio (1) e vídeo (2) da tela entram no MediaStream persistente do peer.
    // Como o <video> do palco aponta para esse mesmo objeto, as faixas aparecem
    // sozinhas quando o outro lado começa a compartilhar — sem tocar no DOM.
    const p2p = p.p2pScreen || (p.p2pScreen = new MediaStream());
    try{ p2p.addTrack(track); }catch(e){}
    if (!p.sfuScreen || p.screen !== p.sfuScreen) p.screen = p2p;
    track.addEventListener('ended', () => { try{ p2p.removeTrack(track); }catch(e){} });
    track.addEventListener('unmute', updateStage);
    track.addEventListener('mute', updateStage);
    updateStage();
  }

  // ---------- microfone / mudo / silenciar ----------
  function toggleMute(){
    VOICE.muted = !VOICE.muted;
    if (VOICE.micTrack) VOICE.micTrack.enabled = !VOICE.muted;
    if (!VOICE.muted && VOICE.deafened) { setDeafened(false); return; }
    VOICE._sig = null;
    renderVoice();
  }

  function setDeafened(v){
    VOICE.deafened = v;
    aplicarAudioDeTodos();
    const cur = VOICE.sharers.find(s => s.sid === VOICE.stageSid);
    const sv = document.getElementById('stage-video');
    if (sv && cur && !cur.self) sv.muted = v;
    aplicarVolumeTela();
    if (v){
      VOICE.muted = true;
      if (VOICE.micTrack) VOICE.micTrack.enabled = false;
    }
    VOICE._sig = null;
    renderVoice();
  }

  function toggleDeafen(){ setDeafened(!VOICE.deafened); }

  // ---------- volume e silêncio por pessoa (nos três ambientes) ----------
  // A preferência é guardada pelo NOME, não pela sessão: a sessão muda a cada
  // recarregamento da página, e aí o ajuste se perderia toda hora.
  const chaveAudio = (nome) => (nome || '').trim().toLowerCase();

  function volumeDe(nome){
    const v = VOICE.volumes[chaveAudio(nome)];
    return v === undefined ? 1 : v;
  }
  function estaSilenciado(nome){ return !!VOICE.silenciados[chaveAudio(nome)]; }

  function aplicarAudioDoPar(p){
    if (!p || !p.audioEl) return;
    p.audioEl.volume = AUDIO_POR_PESSOA ? volumeDe(p.name) : 1;
    p.audioEl.muted = VOICE.deafened || (AUDIO_POR_PESSOA && estaSilenciado(p.name));
  }
  function aplicarAudioDeTodos(){ Object.values(VOICE.peers).forEach(aplicarAudioDoPar); }

  async function guardarPreferenciasAudio(){
    await safeSet('audio-por-pessoa', JSON.stringify({
      volumes: VOICE.volumes, silenciados: VOICE.silenciados, tela: VOICE.volumeTela
    }), false);
  }
  async function carregarPreferenciasAudio(){
    const raw = await safeGet('audio-por-pessoa', false);
    if (!raw) return;
    try{
      const d = JSON.parse(raw);
      VOICE.volumes = d.volumes || {};
      VOICE.silenciados = d.silenciados || {};
      if (typeof d.tela === 'number') VOICE.volumeTela = Math.max(0, Math.min(1, d.tela));
    }catch(e){}
  }

  // ---------- volume do áudio da tela ----------
  // Um controle só, porque o palco mostra uma transmissão por vez. Mora na
  // barra do palco, e não na lista de pessoas, para deixar claro que mexe no
  // som da tela e não na voz de quem compartilha.
  function aplicarVolumeTela(){
    const sv = document.getElementById('stage-video');
    if (sv) sv.volume = VOLUME_TELA ? VOICE.volumeTela : 1;
    const cx = document.getElementById('stage-vol');
    if (!cx) return;
    if (!VOLUME_TELA){ cx.style.display = 'none'; return; }
    const cur = VOICE.sharers.find(s => s.sid === VOICE.stageSid);
    // Quem compartilha nunca ouve o próprio áudio: o controle não teria efeito
    // nenhum na tela dele. Melhor mostrar desligado que fingir que funciona.
    const proprio = !!(cur && cur.self);
    const faixa = cx.querySelector('input[type=range]');
    const pct = cx.querySelector('.pct');
    const v = Math.round(VOICE.volumeTela * 100);
    if (faixa){
      // Não escrever no campo enquanto a pessoa arrasta: o cursor pularia.
      if (faixa !== document.activeElement && Number(faixa.value) !== v) faixa.value = v;
      faixa.disabled = proprio || VOICE.deafened;
    }
    if (pct) pct.textContent = proprio ? '—' : v + '%';
    cx.title = proprio
      ? 'Você está compartilhando: seu próprio áudio nunca toca aqui'
      : (VOICE.deafened ? 'Você está no modo surdo' : 'Volume do áudio de quem está compartilhando');
  }

  function definirVolumeTela(valor){
    VOICE.volumeTela = Math.max(0, Math.min(1, valor));
    aplicarVolumeTela();
    guardarPreferenciasAudio();
  }

  (function ligarVolumeTela(){
    const cx = document.getElementById('stage-vol');
    if (!cx) return;
    if (!VOLUME_TELA){ cx.style.display = 'none'; return; }
    const faixa = cx.querySelector('input[type=range]');
    if (faixa) faixa.addEventListener('input', () => definirVolumeTela(faixa.value / 100));
  })();

  function definirVolume(nome, valor){
    VOICE.volumes[chaveAudio(nome)] = Math.max(0, Math.min(1, valor));
    aplicarAudioDeTodos();
    guardarPreferenciasAudio();
  }
  function alternarSilencio(nome){
    const k = chaveAudio(nome);
    if (VOICE.silenciados[k]) delete VOICE.silenciados[k];
    else VOICE.silenciados[k] = true;
    aplicarAudioDeTodos();
    guardarPreferenciasAudio();
    return !!VOICE.silenciados[k];
  }

  // ---------- bip de entrada e saída (só no ambiente de teste) ----------
  // Som gerado na hora, sem arquivo: mantém a sala num único HTML e evita
  // depender de um servidor de assets.
  window.__SALA_BIPS = { entrou: 0, saiu: 0 };

  function tocarBip(entrando){
    if (!RECURSOS_NOVOS) return;
    window.__SALA_BIPS[entrando ? 'entrou' : 'saiu']++;
    if (VOICE.deafened) return;   // quem está no modo surdo não ouve nem o bip
    try{
      resumeAudio();
      if (!AC) return;
      const t = AC.currentTime;
      const osc = AC.createOscillator();
      const vol = AC.createGain();
      osc.type = 'sine';
      // sobe quando alguém chega, desce quando alguém sai
      const [de, para] = entrando ? [520, 784] : [660, 392];
      osc.frequency.setValueAtTime(de, t);
      osc.frequency.exponentialRampToValueAtTime(para, t + 0.11);
      // envelope suave: sem isso o corte seco vira um estalo
      vol.gain.setValueAtTime(0.0001, t);
      vol.gain.exponentialRampToValueAtTime(0.50, t + 0.02);
      vol.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      osc.connect(vol);
      vol.connect(AC.destination);
      osc.start(t);
      osc.stop(t + 0.26);
    }catch(e){}
  }

  // ---------- indicador de quem está falando ----------
  let AC = null;
  function resumeAudio(){
    try{
      if (!AC || AC.state === 'closed'){
        const Constructor = window.AudioContext || window.webkitAudioContext;
        try{ AC = new Constructor({ sampleRate:48000, latencyHint:'interactive' }); }
        catch(_){ AC = new Constructor(); }
      }
      return (AC.state === 'suspended' ? AC.resume() : Promise.resolve()).then(() => AC).catch(() => AC);
    }catch(_){ return Promise.resolve(null); }
  }
  // ---------- PORTÃO DE RUÍDO ----------
  // Cadeia: microfone -> passa-alta -> ganho -> faixa que vai para os outros.
  // O passa-alta em 90 Hz tira trepidação de mesa e ronco de ar-condicionado,
  // que o supressor nativo deixa passar. O ganho é o portão em si.
  //
  // A medição é feita DEPOIS do passa-alta: medir antes faria um ronco de
  // 50 Hz manter o portão aberto sem ninguém falar.
  const PORTAO = {
    grafo: null,
    timer: null,
    aberto: true,
    ultimaVoz: 0,
    envelope: 0,          // nível suavizado; ver PORTAO_DECAIMENTO
    limiar: 0.018,        // RMS; o slider vai de 0 a 0.1
    estadoNaTela: null,
  };

  // 350ms: cobre pausa entre palavras sem esticar demais o tempo total até
  // fechar, que é a soma disto com a descida do envelope.
  const PORTAO_ESPERA_MS = 350;
  const PORTAO_HISTERESE = 0.6;   // fecha em 60% do limiar que abre

  // Decidir por quadro solto de RMS não funciona para voz: entre uma vogal e a
  // consoante seguinte o nível cai muito, e o portão bate no meio da fala — foi
  // exatamente o picotado da primeira versão. O envelope segue o pico e cai
  // devagar, então a decisão é sobre a ENERGIA DA FRASE, não sobre 10ms de som.
  // 0.6 por passo de 40ms: cai a um terço em cerca de 80ms. Começou em 0.82 e
  // ficou LENTO DEMAIS — a descida sozinha levava 600ms, e somada à espera dava
  // um segundo de ruído saindo depois de cada frase. O envelope só precisa
  // atravessar o vale de uma sílaba (uns 70ms); segurar a frase é papel da
  // espera, não dele.
  const PORTAO_DECAIMENTO = 0.6;

  async function montarPortao(streamCru){
    await resumeAudio();
    if (!AC || !window.AIQAudio) return { stream:streamCru, track:streamCru.getAudioTracks()[0], mode:'fallback', dispose(){}, setThreshold(){}, calibrate(){} };
    let graph;
    graph = await window.AIQAudio.create(AC, streamCru, {
      threshold:PORTAO.limiar, mode:MIC_PREFS.mode,
      onState(data){
        if (PORTAO.grafo !== graph) return;
        if (data.type === 'level'){
          pintarEstadoPortao(data.enabled ? (data.open ? 'aberto' : 'fechado') : 'desligado');
          document.getElementById('mic-level').value = Math.min(1, data.rms * 10);
        }
        if (data.type === 'calibrated'){
          PORTAO.limiar = data.threshold; atualizarControlePortao();
          safeSet('portao-limiar', String(Math.round(data.threshold * 1000)), false);
          const btn = document.getElementById('mic-calibrate'); btn.disabled = false; btn.textContent = 'Calibrar no silêncio';
          showToast('Calibrado. Se a fala baixa cortar, reduza o isolamento.');
        }
        if (data.type === 'error'){
          MIC_PREFS.mode = 'native';
          showToast('O filtro avançado falhou. Recuperando o microfone com o filtro nativo.');
          trocarMicrofone();
        }
      }
    });
    return graph;
  }

  function desmontarPortao(){
    PORTAO.grafo?.dispose(); PORTAO.grafo = null; PORTAO.estadoNaTela = null;
    document.getElementById('mic-level').value = 0;
  }





  function pintarEstadoPortao(estado){
    if (PORTAO.estadoNaTela === estado) return;   // sem reescrever o DOM a 25 Hz
    PORTAO.estadoNaTela = estado;
    const el = document.getElementById('portao-estado');
    if (!el) return;
    el.textContent = estado;
    el.classList.toggle('aberto', estado === 'aberto');
    el.classList.toggle('desligado', estado === 'desligado');
  }



  function atualizarControlePortao(){
    const faixa = document.getElementById('portao-limiar');
    if (faixa) faixa.value = String(Math.round(PORTAO.limiar * 1000));
  }

  if (PORTAO_RUIDO){
    document.body.classList.add('portao-on');
    const faixa = document.getElementById('portao-limiar');
    if (faixa){
      faixa.addEventListener('input', function(){
        // 0..100 no slider -> 0..0.1 de RMS. O indicador de quem está falando
        // usa 0.025 como referência, então o padrão 18 fica um pouco abaixo.
        PORTAO.limiar = Math.max(0, Math.min(0.1, Number(faixa.value) / 1000));
        PORTAO.grafo?.setThreshold(PORTAO.limiar);
        PORTAO.estadoNaTela = null;
        safeSet('portao-limiar', String(faixa.value), false);
      });
    }
    // Preferência por navegador, como o volume por pessoa.
    (async function(){
      const v = await safeGet('portao-limiar', false);
      if (v !== null && v !== undefined && v !== ''){
        PORTAO.limiar = Number.isFinite(Number(v)) ? Math.max(0,Math.min(0.1,Number(v)/1000)) : 0.018;
        atualizarControlePortao();
      }
    })();
  }

  function attachAnalyser(id, stream){
    detachAnalyser(id);
    try{
      resumeAudio(); if (!AC) return;
      const src = AC.createMediaStreamSource(stream), an = AC.createAnalyser();
      an.fftSize = 512; src.connect(an);
      VOICE.analysers[id] = { src, an, data:new Uint8Array(an.fftSize) };
    }catch(_){}
  }
  function startSpeakLoop(){
    if (VOICE.speakRaf) return;
    const step = () => {
      for (const id in VOICE.analysers){
        const a = VOICE.analysers[id];
        a.an.getByteTimeDomainData(a.data);
        let sum = 0;
        for (let i=0;i<a.data.length;i++){ const v = (a.data[i]-128)/128; sum += v*v; }
        const rms = Math.sqrt(sum / a.data.length);
        const on = rms > 0.025 && !(id === SID && VOICE.muted);
        const el = document.querySelector('.vo-row[data-sid="' + id + '"]');
        if (el) el.classList.toggle('speaking', on);
      }
      VOICE.speakRaf = requestAnimationFrame(step);
    };
    VOICE.speakRaf = requestAnimationFrame(step);
  }
  function stopSpeakLoop(){
    if (VOICE.speakRaf) cancelAnimationFrame(VOICE.speakRaf);
    VOICE.speakRaf = null;
  }

  function showUnblockAudio(){
    document.getElementById('unblock-audio').classList.add('show');
  }
  document.getElementById('unblock-audio').addEventListener('click', () => {
    resumeAudio();
    Object.values(VOICE.peers).forEach(p => { if (p.audioEl) p.audioEl.play().catch(()=>{}); });
    const sv = document.getElementById('stage-video');
    if (sv) sv.play().catch(()=>{});
    document.getElementById('unblock-audio').classList.remove('show');
  });

  // ---------- compartilhar tela ----------
  // modo 'aba'  -> só uma aba do navegador, com o áudio SÓ dela. Não captura o
  //                som da chamada, então não dá eco.
  // System audio is admitted only when the browser confirms restrictOwnAudio.
  // The filter excludes this tab's output, including the voices of other users.
  function suportaIsolamentoTela(){
    try{ return navigator.mediaDevices.getSupportedConstraints?.().restrictOwnAudio === true; }
    catch(_){ return false; }
  }

  function filtrarAudioTela(stream, surface, tab, systemAudio){
    let removed = false;
    for (const track of stream.getAudioTracks()){
      let isolated = false;
      try{ isolated = track.getSettings().restrictOwnAudio === true; }catch(_){}
      // Use the actual chosen surface: the user can select a monitor even when
      // the app suggests a tab. Never publish unverified system/window audio.
      const permitted = surface === 'browser' ? (tab || systemAudio) : (systemAudio && isolated);
      if (!permitted){ stream.removeTrack(track); track.stop(); removed = true; }
    }
    return removed;
  }

  async function startScreen(modo, systemAudio){
    if (VOICE.screenPending) return;
    const operation = ++VOICE.screenOperation;
    VOICE.screenPending = true;
    let stream;
    try{
      const profile = SCREEN_PROFILES[VOICE.screenProfile];
      const tab = modo === 'aba';
      const isolation = suportaIsolamentoTela();
      const includeSystem = !!systemAudio && isolation;
      // This call must happen during the user's click, before awaiting microphone/TURN.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video:{ width:{ideal:profile.width}, height:{ideal:profile.height}, frameRate:{ideal:profile.fps,max:profile.fps}, ...(tab ? {displaySurface:'browser'} : {}) },
        audio: tab || includeSystem ? { echoCancellation:false, noiseSuppression:false, autoGainControl:false, ...(isolation ? {restrictOwnAudio:true} : {}) } : false,
        systemAudio: !tab && includeSystem ? 'include' : 'exclude', windowAudio:'exclude', selfBrowserSurface:'exclude', surfaceSwitching:'exclude'
      });
      const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface || 'desconhecido';
      const removedAudio = filtrarAudioTela(stream, surface, tab, includeSystem);
      await instalarTela(stream, surface, operation);
      if (operation === VOICE.screenOperation && (removedAudio || (systemAudio && !isolation)))
        showToast('Tela sem áudio do computador para evitar retorno da chamada. Para transmitir som, compartilhe uma aba com áudio.');
    }catch(error){
      if (VOICE.screenStream === stream && stream) stopScreen();
      else pararStream(stream);
      if (operation === VOICE.screenOperation) showToast(error.name === 'NotAllowedError' ? 'Compartilhamento cancelado ou sem permissão.' : 'Não foi possível compartilhar: ' + error.message);
    }finally{ if (operation === VOICE.screenOperation) VOICE.screenPending = false; }
  }

  // ---------- câmera / placa de captura ----------
  // Não é compartilhamento de tela: é um dispositivo de vídeo. Mas o resultado
  // entra nos MESMOS transceivers de tela (1 = áudio, 2 = vídeo), então quem
  // assiste vê no palco sem nenhuma mudança do outro lado.
  // Traduz o erro do navegador para algo acionável. "Não funcionou" não ajuda
  // ninguém; saber que a placa está ocupada pelo OBS, sim.
  function explicarErroMidia(e){
    const n = (e && e.name) || '';
    if (n === 'NotReadableError' || n === 'TrackStartError')
      return 'O aparelho está ocupado por outro programa. Feche o OBS, o software da placa (Elgato/AVerMedia), Teams ou Meet e tente de novo — no Windows a placa aceita um programa por vez.';
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError')
      return 'O navegador bloqueou o acesso. Clique no cadeado da barra de endereço e libere Câmera e Microfone para este site.';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError')
      return 'O aparelho sumiu da lista. Confira o cabo USB e se o console está ligado — algumas placas só aparecem com sinal de entrada.';
    if (n === 'OverconstrainedError')
      return 'A placa não aceitou a resolução pedida. Tentei de novo sem exigência e ainda assim falhou.';
    if (n === 'AbortError')
      return 'O driver da placa recusou a abertura. Desconecte e reconecte o USB.';
    return 'Erro do navegador: ' + n + (e && e.message ? ' — ' + e.message : '');
  }

  // Tenta primeiro na qualidade boa; se a placa recusar, tenta de novo sem
  // exigir nada. Muita placa USB só entrega formatos específicos.
  async function abrirDispositivo(idVideo, idAudio){
    const audio = idAudio ? {
      deviceId: { exact: idAudio },
      echoCancellation: false, noiseSuppression: false, autoGainControl: false
    } : false;

    const tentativas = [
      { video: { deviceId: { exact: idVideo }, width: { ideal:SCREEN_PROFILES[VOICE.screenProfile].width }, height: { ideal:SCREEN_PROFILES[VOICE.screenProfile].height }, frameRate: { ideal:SCREEN_PROFILES[VOICE.screenProfile].fps } }, audio },
      { video: { deviceId: { exact: idVideo } }, audio },
      { video: { deviceId: idVideo }, audio: idAudio ? { deviceId: idAudio } : false },
    ];
    let ultimo = null;
    for (const c of tentativas){
      try{ return { stream: await navigator.mediaDevices.getUserMedia(c) }; }
      catch(e){ ultimo = e; console.warn('[sala] tentativa de abrir dispositivo falhou:', e.name, e.message); }
    }
    return { erro: ultimo };
  }

  async function abrirEscolhaDispositivo(){
    let dispositivos = [];
    try{
      dispositivos = await navigator.mediaDevices.enumerateDevices();
      // Os nomes só aparecem depois que a permissão é dada uma vez.
      if (!dispositivos.some(d => d.kind === 'videoinput' && d.label)){
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
        tmp.getTracks().forEach(t => { try{ t.stop(); }catch(e){} });
        dispositivos = await navigator.mediaDevices.enumerateDevices();
      }
    }catch(e){
      showToast(explicarErroMidia(e));
      return;
    }

    const videos = dispositivos.filter(d => d.kind === 'videoinput');
    const audios = dispositivos.filter(d => d.kind === 'audioinput');
    console.info('[sala] dispositivos de vídeo:', videos.map(d => d.label || d.deviceId));
    console.info('[sala] entradas de áudio:', audios.map(d => d.label || d.deviceId));
    if (!videos.length){
      showToast('Nenhum dispositivo de vídeo encontrado. Se a placa é USB, confira o cabo e feche programas que possam estar usando ela.');
      return;
    }

    const opcoes = (lista, rotulo) => lista.map((d, i) =>
      '<option value="' + escapeHtml(d.deviceId) + '">' +
      escapeHtml(d.label || (rotulo + ' ' + (i + 1))) + '</option>').join('');

    const modal = document.createElement('div');
    modal.id = 'modal-captura';
    modal.className = 'modal';
    modal.innerHTML =
      '<div class="modal-card">' +
        '<div class="modal-header"><span>Câmera ou placa de captura</span>' +
          '<span class="modal-close" id="cap-x">✕</span></div>' +
        '<div style="padding:18px">' +
          '<div class="linha"><label>Vídeo</label><select id="cap-video">' + opcoes(videos, 'Câmera') + '</select></div>' +
          '<div class="linha"><label>Áudio</label><select id="cap-audio">' +
            '<option value="">— sem áudio —</option>' + opcoes(audios, 'Entrada') + '</select></div>' +
          '<div class="previa"><video id="cap-previa" autoplay muted playsinline></video>' +
            '<div id="cap-estado">abrindo…</div></div>' +
          '<div class="nota">Numa placa de captura, escolha em Áudio a entrada com o mesmo nome da placa. Esse som vem direto do aparelho, então não gera eco.</div>' +
          '<div class="acoes">' +
            '<button class="cancelar" id="cap-cancelar">Cancelar</button>' +
            '<button class="ok" id="cap-ok" disabled>Transmitir</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    const selVideo = modal.querySelector('#cap-video');
    const selAudio = modal.querySelector('#cap-audio');
    const previa = modal.querySelector('#cap-previa');
    const estado = modal.querySelector('#cap-estado');
    const btnOk = modal.querySelector('#cap-ok');
    let streamPrevia = null;

    const pararPrevia = () => {
      if (streamPrevia){ streamPrevia.getTracks().forEach(t => { try{ t.stop(); }catch(e){} }); streamPrevia = null; }
      previa.srcObject = null;
    };

    // A prévia mostra na hora se a placa abre. Sem isso o erro só apareceria
    // depois de já estar na chamada, na frente de todo mundo.
    const testar = async () => {
      pararPrevia();
      btnOk.disabled = true;
      estado.className = '';
      estado.textContent = 'abrindo…';
      const r = await abrirDispositivo(selVideo.value, selAudio.value);
      if (!modal.isConnected){ if (r.stream) r.stream.getTracks().forEach(t => t.stop()); return; }
      if (r.erro){
        estado.className = 'ruim';
        estado.textContent = explicarErroMidia(r.erro);
        return;
      }
      streamPrevia = r.stream;
      previa.srcObject = r.stream;
      previa.play().catch(()=>{});
      const v = r.stream.getVideoTracks()[0];
      const s = v ? v.getSettings() : {};
      estado.className = 'ok';
      estado.textContent = '✓ ' + (s.width || '?') + 'x' + (s.height || '?') +
        (s.frameRate ? ' · ' + Math.round(s.frameRate) + 'fps' : '') +
        (r.stream.getAudioTracks().length ? ' · com áudio' : ' · sem áudio');
      btnOk.disabled = false;
    };

    // Placas de captura expõem vídeo e áudio com nomes parecidos. Adivinhar o
    // par certo poupa o erro mais comum: transmitir imagem sem som.
    const casarAudio = () => {
      const nome = (videos.find(v => v.deviceId === selVideo.value) || {}).label || '';
      const chave = nome.split(/[({]/)[0].trim().toLowerCase();
      if (chave.length < 4) return;
      const par = audios.find(a => (a.label || '').toLowerCase().includes(chave));
      if (par) selAudio.value = par.deviceId;
    };
    selVideo.addEventListener('change', () => { casarAudio(); testar(); });
    selAudio.addEventListener('change', testar);
    casarAudio();
    testar();

    const fechar = () => { pararPrevia(); modal.remove(); };
    modal.querySelector('#cap-x').addEventListener('click', fechar);
    modal.querySelector('#cap-cancelar').addEventListener('click', fechar);
    btnOk.addEventListener('click', () => {
      const v = selVideo.value, a = selAudio.value;
      // Solta o aparelho ANTES de reabrir para transmitir: no Windows ele
      // aceita um consumidor por vez, e a própria prévia bloquearia.
      pararPrevia();
      modal.remove();
      startCaptura(v, a);
    });
  }

  async function startCaptura(idVideo, idAudio){
    if (VOICE.screenPending) return;
    const operation = ++VOICE.screenOperation; VOICE.screenPending = true;
    let stream;
    try{
      const result = await abrirDispositivo(idVideo, idAudio);
      if (result.erro) throw result.erro;
      stream = result.stream;
      await instalarTela(stream, 'captura', operation);
    }catch(error){
      if (VOICE.screenStream === stream && stream) stopScreen();
      else pararStream(stream);
      if (operation === VOICE.screenOperation) showToast(explicarErroMidia(error));
    }
    finally{ if (operation === VOICE.screenOperation) VOICE.screenPending = false; }
  }

  function stopScreen(quiet){
    ++VOICE.screenOperation; VOICE.screenPending = false;
    const publisher = VOICE.sfuPublisher;
    VOICE.sfuPublisher = null; VOICE.sfuPublication = null; VOICE.sfuStarting = false; VOICE.sfuState = null;
    VOICE.sfuLastStats = null; VOICE.sfuAdaptLevel = 0; VOICE.sfuBadSamples = 0; VOICE.sfuGoodSamples = 0;
    if (publisher) publisher.close().catch(error => console.warn('[sfu] encerramento da publicação', error));
    pararStream(VOICE.screenStream);
    VOICE.screenStream = null; VOICE.screenVideoTrack = null; VOICE.screenAudioTrack = null; VOICE.screenSurface = null;
    Object.values(VOICE.peers).forEach(applyLocalTracks);
    VOICE._sig = null;
    if (!quiet){ renderVoice(); updateStage(); voiceTick(); }
  }

  // Menu com as duas opções. A escolha entre elas é o que decide se vai ter eco,
  // então vale ser explícita em vez de escondida dentro do seletor do Chrome.
  function abrirMenuTela(ancora){
    const old = document.getElementById('menu-tela');
    if (old){ old.remove(); return; }
    const menu = document.createElement('div'); menu.id = 'menu-tela';
    menu.innerHTML = '<label class="mt-config">Qualidade<select id="menu-perfil">' +
      Object.entries(SCREEN_PROFILES).map(([id,p]) => '<option value="'+id+'">'+p.label+'</option>').join('') +
      '</select></label><label class="mt-config mt-audio"><input id="menu-system-audio" type="checkbox" ' + (suportaIsolamentoTela() ? '' : 'disabled') + '> Som do computador com filtro da chamada</label>' +
      '<button class="mt-op" data-modo="aba"><b>Compartilhar uma aba</b><span>O navegador permite escolher o áudio da aba.</span></button>' +
      '<button class="mt-op" data-modo="tela"><b>Compartilhar a tela inteira</b><span>' + (suportaIsolamentoTela() ? 'Som opcional, com isolamento da chamada.' : 'Sem som do computador. Para transmitir som, escolha uma aba.') + '</span></button>' +
      '<button class="mt-op" data-modo="captura"><b>Câmera ou placa de captura</b><span>Console, câmera ou entrada HDMI.</span></button>';
    document.body.appendChild(menu);
    const select = menu.querySelector('#menu-perfil'); select.value = VOICE.screenProfile;
    select.addEventListener('change', () => definirPerfilTela(select.value));
    const rect = ancora.getBoundingClientRect();
    menu.style.top = Math.max(8,Math.min(rect.bottom + 6,innerHeight - menu.offsetHeight - 8)) + 'px';
    menu.style.left = Math.max(8,Math.min(rect.left,innerWidth - 302)) + 'px';
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside); };
    const outside = event => { if (!menu.contains(event.target) && !ancora.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside);
    menu.querySelectorAll('[data-modo]').forEach(button => button.addEventListener('click', () => {
      const mode = button.dataset.modo, audio = menu.querySelector('#menu-system-audio').checked;
      close(); if (mode === 'captura') abrirEscolhaDispositivo(); else startScreen(mode, audio);
    }));
  }

  document.getElementById('share-btn').addEventListener('click', (ev) => {
    if (VOICE.screenVideoTrack) stopScreen();
    else abrirMenuTela(ev.currentTarget);
  });

  // ---------- palco ----------
  // A viewing preference only: never resize capture, renegotiate or touch audio.
  function definirFormatoTela(value, remember = true){
    const mode = value === 'esticar' ? 'esticar' : 'original';
    document.getElementById('stage-video-wrap').dataset.fit = mode;
    document.querySelectorAll('[data-stage-fit]').forEach(select => { select.value = mode; });
    if (remember){
      try{ localStorage.setItem('local:' + (window.__SALA_NS || '') + 'screen-fit', mode); }catch(_){}
    }
  }
  let formatoSalvo = 'original';
  try{ formatoSalvo = localStorage.getItem('local:' + (window.__SALA_NS || '') + 'screen-fit'); }catch(_){}
  definirFormatoTela(formatoSalvo, false);
  document.querySelectorAll('[data-stage-fit]').forEach(select => {
    select.addEventListener('change', () => definirFormatoTela(select.value));
  });

  // O <video> é um nó permanente: nunca recriamos o elemento, só trocamos o
  // srcObject quando muda de quem estamos assistindo. Era exatamente isso que
  // quebrava antes — o render periódico recriava o <video> e o stream sumia.
  function updateStage(){
    const sharers = [];
    if (VOICE.joined && VOICE.screenVideoTrack){
      sharers.push({ sid: SID, name: state.nickname + ' (você)', self: true });
    }
    for (const p of Object.values(VOICE.peers)){
      const e = VOICE.bySession[p.sid];
      const vt = p.screen && p.screen.getVideoTracks()[0];
      // Vale a mídia de verdade, não só a flag de presença: se o vídeo está
      // chegando, mostra — mesmo que a batida de presença tenha atrasado. Era
      // isso que fazia a tela sumir e voltar em rede instável.
      const temVideo = !!(vt && vt.readyState === 'live' && !vt.muted);
      if (e ? e.sharing === true : temVideo) sharers.push({ sid: p.sid, name: p.name, self: false });
    }
    const semNinguemAntes = VOICE.sharers.length === 0;
    VOICE.sharers = sharers;

    // AQUI ESTAVA O BUG: esta linha era a ÚNICA coisa no arquivo que reabria o
    // palco, e só disparava na transição de zero para um compartilhamento. Quem
    // fechava o palco com alguém JÁ compartilhando ficava sem volta — nada mais
    // zerava a flag, e só sair e entrar na voz resolvia.
    //
    // A correção NÃO foi tirar esta linha: foi o convite logo abaixo, que dá o
    // caminho de volta e vale nos três ambientes. A linha continua onde os
    // ambientes ainda abrem o palco sozinhos, que é o comportamento de sempre.
    //
    // Onde assistir é opcional, ela não roda: nada abre sem a pessoa pedir, e a
    // escolha fica grudada — se estava assistindo quando o outro parou, o
    // próximo compartilhamento abre sozinho; se tinha fechado, continua fechado.
    if (!ASSISTIR_OPCIONAL && semNinguemAntes && sharers.length) VOICE.stageHidden = false;

    const shareBtn = document.getElementById('share-btn');
    // No celular só o ícone: "Compartilhar tela" empurraria o nome do canal
    // para fora da tela. O title continua dizendo o que o botão faz.
    const curto = MOBILE_OK && ESTREITO();
    shareBtn.textContent = VOICE.screenVideoTrack
      ? (curto ? '⏹️' : '⏹️ Parar de compartilhar')
      : (curto ? '🖥️' : '🖥️ Compartilhar tela');
    shareBtn.title = VOICE.screenVideoTrack ? 'Parar de compartilhar' : 'Compartilhar tela';
    shareBtn.classList.toggle('live', !!VOICE.screenVideoTrack);

    if (!sharers.some(s => s.sid === VOICE.stageSid)) VOICE.stageSid = sharers[0]?.sid || null;
    const watching = assistirSid();
    if (VOICE.lastWatching !== watching){ VOICE.lastWatching = watching; if (VOICE.joined) queueMicrotask(voiceTick); }
    const fallback = precisaFallbackTela();
    if (VOICE.lastScreenFallback !== fallback){ VOICE.lastScreenFallback = fallback; if (VOICE.joined) queueMicrotask(voiceTick); }
    if (SFU_TELA) queueMicrotask(sincronizarAssinaturaSFU);
    document.getElementById('screen-profile-wrap').hidden = !VOICE.screenVideoTrack;
    const on = sharers.length > 0 && !VOICE.stageHidden;
    document.body.classList.toggle('stage-on', on);

    // Convite: alguém compartilhando + palco fechado.
    const convidar = sharers.length > 0 && VOICE.stageHidden;
    document.body.classList.toggle('convite-on', convidar);
    if (convidar){
      // O próprio nome sai do texto: "Você (você) está compartilhando" é
      // esquisito, e o caso de ter fechado o próprio palco também precisa de
      // uma frase que faça sentido.
      const outros = sharers.filter(function(s){ return !s.self; });
      const texto = outros.length
        ? (outros.length > 1
            ? outros.map(function(s){ return s.name; }).join(', ') + ' estão compartilhando a tela'
            : outros[0].name + ' está compartilhando a tela')
        : 'Você está compartilhando a tela';
      const el = document.getElementById('convite-texto');
      if (el && el.textContent !== texto) el.textContent = texto;
    }
    if (!on){
      document.body.classList.remove('theater');
      const v = document.getElementById('stage-video');
      if (v.srcObject) v.srcObject = null;
      return;
    }

    if (!sharers.find(s => s.sid === VOICE.stageSid)) VOICE.stageSid = sharers[0].sid;
    const cur = sharers.find(s => s.sid === VOICE.stageSid);
    const peer = cur.self ? null : VOICE.peers[cur.sid];
    const want = cur.self ? VOICE.screenStream : (peer && peer.screen);

    const video = document.getElementById('stage-video');
    if (want && video.srcObject !== want){
      video.srcObject = want;
      video.play().catch(() => showUnblockAudio());
    }
    video.muted = cur.self ? true : VOICE.deafened;   // nunca tocar o próprio áudio
    aplicarVolumeTela();

    const title = document.getElementById('stage-title');
    let tag = '';
    if (cur.self){
      // Quem compartilha vê sempre qual áudio está saindo — o toast some em 5s,
      // e mandar o som do sistema inteiro sem perceber é o erro caro aqui.
      if (!VOICE.screenAudioTrack) tag = '<span class="audio-tag">sem áudio</span>';
      else if (VOICE.screenSurface === 'monitor') tag = '<span class="audio-tag ok">áudio com filtro da chamada</span>';
      else if (VOICE.screenSurface === 'captura') tag = '<span class="audio-tag ok">áudio do aparelho</span>';
      else tag = '<span class="audio-tag ok">áudio só da origem</span>';
    }
    const titleHtml = '<span class="rec"></span><span>' + escapeHtml(cur.name) + '</span>' + tag;
    if (title._h !== titleHtml){ title.innerHTML = titleHtml; title._h = titleHtml; }

    const tabs = document.getElementById('stage-tabs');
    const tabsHtml = sharers.length > 1
      ? sharers.map(s => '<span class="stab ' + (s.sid===VOICE.stageSid?'active':'') + '" data-sid="' + escapeHtml(s.sid) + '">' + escapeHtml(s.name) + '</span>').join('')
      : '';
    if (tabs._h !== tabsHtml){
      tabs.innerHTML = tabsHtml;
      tabs._h = tabsHtml;
      tabs.querySelectorAll('.stab').forEach(el => {
        el.addEventListener('click', () => { VOICE.stageSid = el.dataset.sid; updateStage(); });
      });
    }

    let msg = '';
    if (!cur.self){
      const viaSFU = VOICE.bySession[cur.sid]?.screenMode === 'sfu';
      const st = viaSFU ? peer?.sfuSubscriber?.pc?.connectionState : peer?.pc?.connectionState;
      const vt = want && want.getVideoTracks()[0];
      const temVideo = !!(vt && vt.readyState === 'live' && !vt.muted);
      // O caminho P2P temporário já pode estar exibindo a tela enquanto a
      // assinatura SFU termina. Nesse caso não cubra um vídeo válido com aviso.
      if (temVideo) msg = '';
      else if (viaSFU && peer?.sfuError) msg = 'Reconectando a tela pelo servidor…';
      else if (!viaSFU && peer && peer.dead) msg = 'Não foi possível conectar com ' + cur.name + '.\nA rede provavelmente bloqueia P2P — nesse caso é preciso um servidor TURN.';
      else if (st !== 'connected') msg = viaSFU ? 'Conectando a tela pelo servidor…' : 'Conectando com ' + cur.name + '…';
      else if (!vt) msg = 'Aguardando o vídeo…';
      else if (vt.muted) msg = 'Aguardando os primeiros quadros…';
    }
    const status = document.getElementById('stage-status');
    if (status.textContent !== msg) status.textContent = msg;
    status.classList.toggle('show', !!msg);
  }

  document.getElementById('stage-hide').addEventListener('click', () => {
    VOICE.stageHidden = true;
    updateStage();
  });
  document.getElementById('convite-btn').addEventListener('click', () => {
    VOICE.stageHidden = false;
    updateStage();
  });
  document.getElementById('stage-theater').addEventListener('click', () => {
    const on = document.body.classList.toggle('theater');
    document.getElementById('stage-theater').classList.toggle('on', on);
  });
  function goFullscreen(){
    const wrap = document.getElementById('stage-video-wrap');
    if (document.fullscreenElement){ document.exitFullscreen(); return; }
    const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
    if (req){ const r = req.call(wrap); if (r && r.catch) r.catch(()=>{}); }
  }
  document.getElementById('stage-full').addEventListener('click', goFullscreen);
  document.getElementById('stage-video').addEventListener('dblclick', goFullscreen);
  document.getElementById('stage-pip').addEventListener('click', async () => {
    const v = document.getElementById('stage-video');
    try{
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    }catch(e){ showToast('Picture-in-picture indisponível neste navegador.'); }
  });

  // ---------- render da sidebar de voz ----------
  function renderVoice(){
    const sig = JSON.stringify([
      VOICE.channels.map(c => c.id + c.name),
      VOICE.chan, VOICE.joined, !!VOICE.joining, VOICE.muted, VOICE.deafened, !!VOICE.screenVideoTrack,
      Object.keys(VOICE.presence).sort().map(c =>
        c + '|' + VOICE.presence[c].map(e => e.session + e.name + (e.muted?'m':'') + (e.sharing?'s':'')).sort().join(',')
      ).join(';'),
      Object.values(VOICE.peers).map(p => p.sid + ':' + (p.pc ? p.pc.connectionState : '-') + (p.dead?'!':'')).sort().join(','),
      AUDIO_POR_PESSOA ? Object.keys(VOICE.silenciados).sort().join(',') : ''
    ]);
    if (sig === VOICE._sig) return;
    VOICE._sig = sig;

    const list = document.getElementById('voice-list');
    list.innerHTML = VOICE.channels.map(c => {
      const occ = (VOICE.presence[c.id] || []).slice().sort((a,b) => a.name.localeCompare(b.name));
      const isHere = VOICE.joined && VOICE.chan === c.id;
      const rows = occ.map(e => {
        const me = e.session === SID;
        const p = VOICE.peers[e.session];
        let right = '';
        if (isHere && !me && p){
          const st = p.pc ? p.pc.connectionState : 'new';
          if (p.dead) right = '<span class="vstate">falhou</span>';
          else if (st !== 'connected') right = '<span class="vstate">conectando…</span>';
        }
        if (!right){
          const icons = [];
          if (e.sharing) icons.push('<span class="vicon live" title="compartilhando a tela">🖥️</span>');
          if (e.muted) icons.push('<span class="vicon bad" title="microfone desligado">🔇</span>');
          right = icons.join('');
        }
        // Cada pessoa (menos você) ganha controle de quanto ouvir.
        const mudo = AUDIO_POR_PESSOA && !me && estaSilenciado(e.name);
        const vol = Math.round(volumeDe(e.name) * 100);
        const controle = (AUDIO_POR_PESSOA && !me && isHere)
          ? '<div class="vo-som" data-nome="' + escapeHtml(e.name) + '">' +
              '<span class="escutar' + (mudo ? ' mudo' : '') + '" title="' +
                (mudo ? 'Voltar a ouvir' : 'Parar de ouvir esta pessoa') + '">' +
                (mudo ? '🔇' : '🔊') + '</span>' +
              '<input type="range" min="0" max="100" value="' + vol + '"' + (mudo ? ' disabled' : '') + '>' +
              '<span class="pct">' + (mudo ? '—' : vol + '%') + '</span>' +
            '</div>'
          : '';
        return '<div class="vo-row' + (mudo ? ' silenciado' : '') + '" data-sid="' + escapeHtml(e.session) + '">' +
            '<div class="avatar" style="background:' + colorFor(e.name) + '">' + escapeHtml(initials(e.name)) + '</div>' +
            '<span class="vname">' + escapeHtml(e.name) + (me?' (você)':'') + '</span>' + right +
          '</div>' + controle;
      }).join('');
      return '<div class="voice-block">' +
          '<div class="channel-item ' + (isHere?'active':'') + '" data-vchan="' + c.id + '">' +
            '<span class="hash">🔊</span><span>' + escapeHtml(c.name) + '</span>' +
            (occ.length ? '<span class="count">' + occ.length + '</span>' : '') +
          '</div>' +
          (occ.length ? '<div class="voice-occupants">' + rows + '</div>' : '') +
        '</div>';
    }).join('');

    // Os controles de áudio mexem no elemento direto, sem redesenhar a lista:
    // redesenhar no meio de um arraste faria o cursor do slider pular.
    list.querySelectorAll('.vo-som').forEach(bloco => {
      const nome = bloco.dataset.nome;
      const faixa = bloco.querySelector('input[type=range]');
      const pct = bloco.querySelector('.pct');
      const botao = bloco.querySelector('.escutar');
      faixa.addEventListener('input', () => {
        definirVolume(nome, faixa.value / 100);
        pct.textContent = faixa.value + '%';
      });
      botao.addEventListener('click', () => {
        const agoraMudo = alternarSilencio(nome);
        botao.textContent = agoraMudo ? '🔇' : '🔊';
        botao.classList.toggle('mudo', agoraMudo);
        botao.title = agoraMudo ? 'Voltar a ouvir' : 'Parar de ouvir esta pessoa';
        faixa.disabled = agoraMudo;
        pct.textContent = agoraMudo ? '—' : faixa.value + '%';
        const linha = bloco.previousElementSibling;
        if (linha) linha.classList.toggle('silenciado', agoraMudo);
      });
    });

    list.querySelectorAll('[data-vchan]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.vchan;
        if (VOICE.joined && VOICE.chan === id) leaveVoice();
        else joinVoice(id);
      });
    });

    const bar = document.getElementById('call-bar');
    if (VOICE.joining){
      bar.innerHTML = '<div class="call-top">Entrando na voz… <button class="hangup" id="cancel-join">Cancelar</button></div>';
      document.body.classList.add('in-call');
      document.getElementById('cancel-join').addEventListener('click', () => leaveVoice());
    } else if (VOICE.joined){
      const ch = VOICE.channels.find(c => c.id === VOICE.chan);
      const peers = Object.values(VOICE.peers);
      const connected = peers.filter(p => p.pc && p.pc.connectionState === 'connected').length;
      const label = peers.length ? 'Voz conectada · ' + connected + '/' + peers.length : 'Voz conectada';
      bar.innerHTML =
        '<div class="call-top">' +
          '<span class="call-status">🟢 ' + label + '</span>' +
          '<span class="call-where">' + escapeHtml(ch ? ch.name : '') + '</span>' +
          '<button class="hangup" id="hangup-btn">Sair</button>' +
        '</div>' +
        '<div class="call-btns">' +
          '<div class="cbtn ' + (VOICE.muted?'on':'') + '" id="mute-btn">' + (VOICE.muted?'🔇 Mudo':'🎤 Falar') + '</div>' +
          '<div class="cbtn ' + (VOICE.deafened?'on':'') + '" id="deafen-btn">' + (VOICE.deafened?'🔕 Surdo':'🎧 Ouvir') + '</div>' +
          '<div class="cbtn ' + (VOICE.screenVideoTrack?'live':'') + '" id="share-btn-2">' + (VOICE.screenVideoTrack?'⏹️ Parar':'🖥️ Tela') + '</div>' +
        '</div>';
      document.getElementById('hangup-btn').addEventListener('click', () => leaveVoice());
      document.getElementById('mute-btn').addEventListener('click', toggleMute);
      document.getElementById('deafen-btn').addEventListener('click', toggleDeafen);
      document.getElementById('share-btn-2').addEventListener('click', (ev) => {
        if (VOICE.screenVideoTrack) stopScreen(); else abrirMenuTela(ev.currentTarget);
      });
    } else if (bar.innerHTML){
      bar.innerHTML = '';
    }
  }

  window.addEventListener('beforeunload', () => {
    if (!VOICE.joined) return;
    safeDeletePrefix('sdp:' + SID + ':', true);
    safeDeletePrefix('ans:' + SID + ':', true);
    try{ window.storage.delete('vp:' + VOICE.chan + ':' + SID, true); }catch(e){}
  });

  // ---------- BOOT ----------
  async function boot(){
    document.getElementById('gate').style.display = 'none';
    document.getElementById('app').style.display = 'flex';

    document.getElementById('my-name').textContent = state.nickname;
    document.getElementById('my-avatar').style.background = colorFor(state.nickname);
    document.getElementById('my-avatar').textContent = initials(state.nickname);

    if (AUDIO_POR_PESSOA) await carregarPreferenciasAudio();
    aplicarVolumeTela();
    await loadServerName();
    renderServerName();
    await loadChannels();
    renderChannels();
    await loadVoiceChannels();
    await loadMessages(true);
    await heartbeatAndLoadMembers();
    await voiceTick();

    // Um GET só, e trazendo apenas o que mudou. Quem não mudou não vem, e o
    // que não vem simplesmente não é redesenhado.
    let chatPolling=false;
    setInterval(async () => {
      if(chatPolling)return;
      chatPolling=true;
      try{
        const [channels] = await Promise.all([safeGet('channels',true),loadMessages(false)]);
        if(channels!==null){await loadChannels(channels);renderChannels();}
        state.tique++;
        if(state.tique%2===1)await heartbeatAndLoadMembers();
      }finally{chatPolling=false;}
    }, POLL_MS);

    restartVoiceTimer();

    // Restos da versão anterior: a presença de texto virou uma linha por
    // pessoa (mb:<nome>), então o mapa antigo numa linha só não serve mais.
    // Some com ele aqui em vez de deixar isso como tarefa manual.
    safeDelete('members', true);

    // A lista de melhorias NÃO abre sozinha. Abria quando a versão mudava
    // desde a última visita, e virava uma janela na frente de quem só queria
    // conversar. Agora é consulta voluntária: o botão ✨ Novidades do cabeçalho,
    // e o mesmo botão na página inicial.
    //
    // Com isso a chave que guardava a última versão vista não serve mais.
    // Apagar aqui evita deixar lixo no navegador de quem já usou a sala.
    safeDelete('novidades-vistas', false);
  }

  if (RECURSOS_NOVOS) montarNovidades();

  // Persistent controls live outside the frequently re-rendered call bar.
  document.getElementById('mic-agc').checked = MIC_PREFS.agc;
  document.getElementById('mic-device').addEventListener('change', e => { MIC_PREFS.device=e.target.value; trocarMicrofone(); });
  document.getElementById('mic-agc').addEventListener('change', e => { MIC_PREFS.agc=e.target.checked; trocarMicrofone(); });
  document.getElementById('mic-retry').addEventListener('click', trocarMicrofone);
  const audioToggle = document.getElementById('audio-settings-toggle');
  function mostrarPainelAudio(aberto){
    const abertoBool = !!aberto;
    document.body.classList.toggle('mic-settings-open', abertoBool);
    audioToggle.setAttribute('aria-expanded', String(abertoBool));
    audioToggle.textContent = abertoBool ? '⚙ Ocultar ajustes do microfone' : '⚙ Ajustar microfone';
  }
  // O estado vem do próprio botão. Isso evita que um clique duplicado ou uma
  // atualização visual intermediária deixe o painel preso aberto.
  audioToggle.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    mostrarPainelAudio(audioToggle.getAttribute('aria-expanded') !== 'true');
  });
  document.getElementById('mic-calibrate').addEventListener('click', e => {
    if (!PORTAO.grafo || PORTAO.grafo.mode === 'fallback') return;
    e.target.disabled=true; e.target.textContent='Fique 3 segundos em silêncio…';
    PORTAO.grafo.calibrate();
  });
  navigator.mediaDevices?.addEventListener('devicechange', listarMicrofones);
  document.getElementById('screen-profile').innerHTML = Object.entries(SCREEN_PROFILES).map(([id,p]) => '<option value="'+id+'">'+p.label+'</option>').join('');
  try{
    const saved = localStorage.getItem('local:'+(window.__SALA_NS || '')+'screen-profile');
    if (Object.hasOwn(SCREEN_PROFILES,saved)) VOICE.screenProfile=saved;
  }catch(_){}
  document.getElementById('screen-profile').value=VOICE.screenProfile;
  document.getElementById('screen-profile').addEventListener('change', e => definirPerfilTela(e.target.value));
  document.getElementById('quality-indicator').addEventListener('click', abrirDiagnostico);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape'){
      document.getElementById('diagnostic-modal')?.remove();
      document.getElementById('menu-tela')?.remove();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && VOICE.joined) resumeAudio().then(mostrarModoMicrofone);
  });
  setInterval(colherDiagnostico,2500);

  (async function main(){
    if (!window.storage){
      document.getElementById('gate').innerHTML = '<div class="card"><h1>Armazenamento indisponível</h1><p>Este artefato precisa do recurso de armazenamento para funcionar.</p></div>';
      return;
    }
    if (MODO_LOGIN){
      // O login da porta grava a sessão no localStorage. O armazenamento remoto
      // da sala guarda dados de conversa e não deve ser a fonte da identidade;
      // usar safeGet aqui fazia a pessoa passar pela tranca e, em seguida,
      // receber a tela de login/apelido novamente.
      let raw = null;
      try{ raw = localStorage.getItem('local:' + (window.__SALA_NS || '') + 'sessao'); }catch(e){}
      if (!raw){ raw = await safeGet('sessao', false); }
      let s = null;
      try{ s = raw ? JSON.parse(raw) : null; }catch(e){ s = null; }
      if (s && s.usuario && s.exp && s.exp > Math.floor(Date.now()/1000)){
        // O apelido é escolhido no index e vale em qualquer ambiente: a conta
        // diz QUEM é, o apelido diz COMO a pessoa aparece. Sem apelido, aparece
        // com o nome da conta. Quem administra as contas continua sabendo quem
        // é quem — o vínculo apelido/conta está na sessão.
        state.nickname = s.apelido || s.usuario;
        await boot();
      } else {
        // Sessão vencida entre o carregamento e aqui: de volta para a porta.
        voltarParaPorta();
      }
      return;
    }

    const existing = await loadNickname();
    if (existing){
      state.nickname = existing;
      await boot();
    } else {
      document.getElementById('pass-input').focus();
    }
  })();
})();
