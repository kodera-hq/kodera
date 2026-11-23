class KoderaVoicePeaksProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._bins = new Float32Array(32)
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length > 0) {
      const step = Math.max(1, Math.floor(ch.length / 32))
      for (let i = 0; i < 32; i += 1) {
        let peak = 0
        const base = i * step
        for (let j = 0; j < step && base + j < ch.length; j += 1) {
          const v = Math.abs(ch[base + j])
          if (v > peak) peak = v
        }
        this._bins[i] = Math.min(1, peak * 3.5)
      }
      this.port.postMessage(this._bins)
    }
    return true
  }
}

registerProcessor('kodera-voice-peaks', KoderaVoicePeaksProcessor)
