// Runs on the audio thread. Collects mono samples (already at 16 kHz, the
// rate of the AudioContext) into 100 ms blocks of 16-bit PCM.
class PcmCollector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Int16Array(1600);
    this.fill = 0;
    this.peak = 0;
    this.stopped = false;
    this.port.onmessage = (e) => { if (e && e.data === 'stop') this.stopped = true; };
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        const a = s < 0 ? -s : s;
        if (a > this.peak) this.peak = a;
        this.block[this.fill++] = s < 0 ? s * 32768 : s * 32767;
        if (this.fill === this.block.length) {
          const out = this.block.buffer;
          this.port.postMessage({ pcm: out, peak: this.peak }, [out]);
          this.block = new Int16Array(1600);
          this.fill = 0;
          this.peak = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-collector', PcmCollector);
