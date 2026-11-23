import { vi } from 'vitest'

function fakeSource() {
  return {
    buffer: null,
    playbackRate: { value: 1 },
    onended: null as (() => void) | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
}

/** Deterministic decoded-buffer transport; time advances only when the test moves it. */
export class FakeVoiceAudioContext {
  static instances: FakeVoiceAudioContext[] = []
  currentTime = 0
  destination = {}
  sources: ReturnType<typeof fakeSource>[] = []
  resume = vi.fn().mockResolvedValue(undefined)
  close = vi.fn().mockResolvedValue(undefined)
  decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => ({ duration: 10 }))

  constructor() {
    FakeVoiceAudioContext.instances.push(this)
  }

  createBufferSource() {
    const source = fakeSource()
    this.sources.push(source)
    return source
  }
}

export function installVoiceAudioContext() {
  FakeVoiceAudioContext.instances = []
  vi.stubGlobal('AudioContext', FakeVoiceAudioContext)
  // JSDOM's Blob omits this browser method; preserve the real bytes for decoder assertions.
  if (typeof Blob.prototype.arrayBuffer !== 'function') {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      value(this: Blob) {
        return new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as ArrayBuffer)
          reader.onerror = () => reject(reader.error)
          reader.readAsArrayBuffer(this)
        })
      },
    })
  }
}
