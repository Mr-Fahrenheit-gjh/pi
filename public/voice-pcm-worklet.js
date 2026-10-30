/* Mono 24kHz, signed PCM16 little-endian. Output is always silence (no feedback). */
class PiVoicePcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pcm = new Int16Array(600); this.used = 0;
    this.phase = 0; this.sum = 0; this.count = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'flush') { this.flush(); this.port.postMessage({ type: 'flushed' }); }
    };
  }
  flush() {
    if (!this.used) return;
    const buffer = new ArrayBuffer(this.used * 2), view = new DataView(buffer);
    for (let i = 0; i < this.used; i++) view.setInt16(i * 2, this.pcm[i], true);
    this.port.postMessage({ type: 'audio', samples: buffer }, [buffer]); this.used = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0; for (const channel of channels) value += channel[i] / channels.length;
      this.sum += value; this.count++; this.phase += 24000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        const mono = Math.max(-1, Math.min(1, this.sum / this.count));
        this.pcm[this.used++] = Math.round(mono * (mono < 0 ? 32768 : 32767));
        this.sum = 0; this.count = 0;
        if (this.used === this.pcm.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('pi-voice-pcm', PiVoicePcm);
