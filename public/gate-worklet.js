// Gate decisions run on the audio rendering thread, including background tabs.
class AiqGate extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.threshold = this.clamp(options.processorOptions?.threshold ?? 0.018);
    this.envelope = 0;
    this.hold = 0;
    this.gain = 0;
    this.open = false;
    this.alive = true;
    this.samples = 0;
    this.ring = new Float32Array(Math.max(1, Math.round(sampleRate * 0.012)));
    this.position = 0;
    this.calibration = null;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'threshold') this.threshold = this.clamp(data.value);
      if (data.type === 'dispose') this.alive = false;
      if (data.type === 'calibrate') this.calibration = { remaining: sampleRate * 3, values: [] };
    };
  }
  clamp(value) { return Number.isFinite(value) ? Math.min(0.1, Math.max(0, value)) : 0.018; }
  process(inputs, outputs) {
    if (!this.alive) return false;
    const output = outputs[0]?.[0];
    if (!output) return true;
    const input = inputs[0]?.[0];
    const frames = output.length;
    let energy = 0;
    if (input) for (let i = 0; i < frames; i++) energy += input[i] * input[i];
    const rms = Math.sqrt(energy / frames);
    this.envelope = Math.max(rms, this.envelope * Math.exp(-frames / (sampleRate * 0.08)));
    if (this.threshold === 0 || this.envelope >= this.threshold || (this.open && this.envelope >= this.threshold * 0.6)) {
      this.open = true;
      this.hold = sampleRate * 0.35;
    } else {
      this.hold -= frames;
      if (this.hold <= 0) this.open = false;
    }
    const target = this.open ? 1 : 0;
    const coefficient = Math.exp(-1 / (sampleRate * (this.open ? 0.004 : 0.08)));
    for (let i = 0; i < frames; i++) {
      const delayed = this.ring[this.position];
      this.ring[this.position] = input ? input[i] : 0;
      this.position = (this.position + 1) % this.ring.length;
      this.gain = target + (this.gain - target) * coefficient;
      output[i] = delayed * this.gain;
    }
    if (this.calibration) {
      this.calibration.values.push(rms);
      this.calibration.remaining -= frames;
      if (this.calibration.remaining <= 0) {
        const values = this.calibration.values.sort((a, b) => a - b);
        const floor = values[Math.floor(values.length * 0.9)] || 0;
        this.threshold = Math.min(0.06, Math.max(0.003, floor * 2.2));
        this.calibration = null;
        this.port.postMessage({ type: 'calibrated', threshold: this.threshold });
      }
    }
    this.samples += frames;
    if (this.samples >= sampleRate / 10) {
      this.samples = 0;
      this.port.postMessage({ type: 'level', rms, open: this.open, enabled: this.threshold > 0 });
    }
    return true;
  }
}
registerProcessor('aiq-gate-v6', AiqGate);
