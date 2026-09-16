(function () {
  'use strict';
  const base = new URL('.', document.currentScript.src);
  const modules = new WeakMap();
  let neuralBinary;
  function loadModule(context, file) {
    let cache = modules.get(context);
    if (!cache) { cache = new Map(); modules.set(context, cache); }
    if (!cache.has(file)) {
      cache.set(file, context.audioWorklet.addModule(new URL(file, base).href).catch(error => { cache.delete(file); throw error; }));
    }
    return cache.get(file);
  }
  async function neural(context) {
    if (context.sampleRate !== 48000) throw new Error('RNNoise requer áudio a 48 kHz.');
    if (!neuralBinary) {
      neuralBinary = fetch(new URL('vendor/rnnoise/rnnoise.wasm', base), { signal: AbortSignal.timeout(8000) })
        .then(response => { if (!response.ok) throw new Error('Modelo RNNoise indisponível.'); return response.arrayBuffer(); })
        .catch(error => { neuralBinary = null; throw error; });
    }
    const [binary] = await Promise.all([neuralBinary, loadModule(context, 'vendor/rnnoise/worklet.js')]);
    const node = new AudioWorkletNode(context, '@sapphi-red/web-noise-suppressor/rnnoise', {
      channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
      processorOptions: { wasmBinary: binary, maxChannels: 1 }
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('RNNoise não iniciou a tempo.')), 5000);
        node.port.onmessage = ({ data }) => {
          if (data?.type === 'ready') { clearTimeout(timer); resolve(); }
          if (data?.type === 'error') { clearTimeout(timer); reject(new Error(data.message)); }
        };
        node.onprocessorerror = () => { clearTimeout(timer); reject(new Error('Falha ao iniciar RNNoise.')); };
      });
      return node;
    } catch (error) { node.port.postMessage('destroy'); node.disconnect(); throw error; }
  }
  async function create(context, raw, options = {}) {
    const nodes = [];
    let denoiser, gate, destination;
    let mode = 'native';
    let disposed = false;
    const notify = options.onState || (() => {});
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (denoiser) { denoiser.onprocessorerror = null; denoiser.port.postMessage('destroy'); }
      if (gate) { gate.onprocessorerror = null; gate.port.postMessage({ type: 'dispose' }); gate.port.onmessage = null; }
      for (const node of nodes) { try { node.disconnect(); } catch (_) {} }
      destination?.stream.getTracks().forEach(track => track.stop());
    };
    try {
      if (context.state !== 'running') await context.resume();
      if (context.state !== 'running' || !context.audioWorklet) throw new Error('Processamento adicional indisponível.');
      await loadModule(context, 'gate-worklet.js');
      if (options.mode === 'neural') {
        try { denoiser = await neural(context); nodes.push(denoiser); mode = 'neural'; }
        catch (error) { notify({ type: 'fallback', message: error.message }); }
      }
      const rawTrack = raw.getAudioTracks()[0];
      if (mode === 'neural') {
        try { await rawTrack.applyConstraints({ noiseSuppression: false }); }
        catch (_) { notify({ type: 'fallback', message: 'O navegador manteve seu filtro nativo junto do RNNoise.' }); }
      }
      const source = context.createMediaStreamSource(raw);
      const highpass = context.createBiquadFilter();
      highpass.type = 'highpass'; highpass.frequency.value = 90;
      gate = new AudioWorkletNode(context, 'aiq-gate-v6', {
        channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
        processorOptions: { threshold: options.threshold ?? 0.018 }
      });
      destination = context.createMediaStreamDestination();
      destination.channelCount = 1;
      nodes.push(source, highpass, gate, destination);
      source.connect(highpass);
      if (denoiser) { highpass.connect(denoiser); denoiser.connect(gate); }
      else highpass.connect(gate);
      gate.connect(destination);
      gate.port.onmessage = ({ data }) => { if (!disposed) notify({ ...data, mode }); };
      const failed = () => { if (!disposed) notify({ type: 'error', mode }); };
      gate.onprocessorerror = failed;
      if (denoiser) denoiser.onprocessorerror = failed;
      return {
        stream: destination.stream, track: destination.stream.getAudioTracks()[0], mode,
        setThreshold(value) { gate.port.postMessage({ type: 'threshold', value }); },
        calibrate() { gate.port.postMessage({ type: 'calibrate' }); }, dispose
      };
    } catch (error) {
      dispose();
      try { await raw.getAudioTracks()[0]?.applyConstraints({ noiseSuppression: true }); } catch (_) {}
      notify({ type: 'fallback', message: error.message });
      return { stream: raw, track: raw.getAudioTracks()[0], mode: 'fallback', setThreshold() {}, calibrate() {}, dispose() {} };
    }
  }
  window.AIQAudio = { create };
})();
