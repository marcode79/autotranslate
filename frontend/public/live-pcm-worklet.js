class LivePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.phase = 0;
    this.samplesPerChunk = 1600;
    this.ratio = sampleRate / 16000;
  }

  process(inputs, outputs) {
    const channels = inputs[0];
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!channels?.length) return true;

    const length = channels[0].length;
    for (let i = 0; i < length; i += 1) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      sample /= channels.length;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        this.pending.push(Math.max(-1, Math.min(1, sample)));
      }
    }

    while (this.pending.length >= this.samplesPerChunk) {
      const pcm = new Int16Array(this.samplesPerChunk);
      for (let i = 0; i < pcm.length; i += 1) {
        const value = this.pending[i];
        pcm[i] = value < 0 ? value * 32768 : value * 32767;
      }
      this.pending.splice(0, this.samplesPerChunk);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("live-pcm-processor", LivePcmProcessor);
