import { afterEach, describe, expect, it, vi } from 'vitest'
import { SILENT_METER, webAudioMeter } from './meter'

/** A Web Audio context that hands out what was asked of it, and samples at `amplitude`. */
function fakeContext(amplitude = 0.5) {
  const sources: {
    stream: { tracks: MediaStreamTrack[] }
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }[] = []
  const analyser = {
    fftSize: 0,
    getFloatTimeDomainData: vi.fn((samples: Float32Array) => {
      // A square wave: its RMS is its amplitude.
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = index % 2 === 0 ? amplitude : -amplitude
      }
    }),
  }
  const context = {
    state: 'running' as AudioContextState | 'interrupted',
    resume: vi.fn(async () => {
      context.state = 'running'
    }),
    createAnalyser: vi.fn(() => analyser),
    createMediaStreamSource: vi.fn((stream: { tracks: MediaStreamTrack[] }) => {
      const source = { stream, connect: vi.fn(), disconnect: vi.fn() }
      sources.push(source)
      return source
    }),
    close: vi.fn(async () => undefined),
  }
  return { context, analyser, sources, make: () => context as unknown as AudioContext }
}

/** A capture that refuses to be copied: the meter must read the call's own. */
function capture(): MediaStreamTrack {
  return {
    readyState: 'live',
    clone: () => {
      throw new Error('a copy would keep the microphone on')
    },
  } as unknown as MediaStreamTrack
}

class FakeMediaStream {
  constructor(readonly tracks: MediaStreamTrack[]) {}
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('webAudioMeter', () => {
  it('reads the RMS of the track itself, through an analyser that plays nowhere', () => {
    vi.stubGlobal('MediaStream', FakeMediaStream)
    const fake = fakeContext(0.5)
    const meter = webAudioMeter(fake.make)
    const track = capture()
    expect(meter.level(track)).toBeCloseTo(0.5)
    expect(fake.analyser.fftSize).toBe(1024)
    const [source] = fake.sources
    // The call's own track, in a stream of its own.
    expect(source!.stream.tracks).toEqual([track])
    // Into the analyser and nothing else: not the speakers.
    expect(source!.connect).toHaveBeenCalledWith(fake.analyser)
    expect(source!.connect).toHaveBeenCalledTimes(1)
    expect(source!.disconnect).not.toHaveBeenCalled()
    // A second read of the same track builds nothing new.
    meter.level(track)
    expect(fake.sources).toHaveLength(1)
  })

  it('follows a new capture, letting go of the old one', () => {
    vi.stubGlobal('MediaStream', FakeMediaStream)
    const fake = fakeContext()
    const meter = webAudioMeter(fake.make)
    meter.level(capture())
    meter.level(capture())
    expect(fake.sources).toHaveLength(2)
    expect(fake.sources[0]!.disconnect).toHaveBeenCalledTimes(1)
  })

  it('reads 0 from a capture that has ended, and once closed', () => {
    vi.stubGlobal('MediaStream', FakeMediaStream)
    const fake = fakeContext()
    const meter = webAudioMeter(fake.make)
    const ended = { ...capture(), readyState: 'ended' } as MediaStreamTrack
    expect(meter.level(ended)).toBe(0)
    const track = capture()
    meter.level(track)
    meter.close()
    expect(fake.sources[0]!.disconnect).toHaveBeenCalledTimes(1)
    expect(fake.context.close).toHaveBeenCalledTimes(1)
    expect(meter.level(track)).toBe(0)
    meter.close()
    expect(fake.context.close).toHaveBeenCalledTimes(1)
  })

  it('reads 0 where the browser has no Web Audio, or it will not start', () => {
    vi.stubGlobal('AudioContext', undefined)
    expect(webAudioMeter()).toBe(SILENT_METER)
    const broken = webAudioMeter(() => {
      throw new Error('too many contexts')
    })
    expect(broken.level(capture())).toBe(0)
  })

  it('tries a capture it could not read only once, and a new one afresh', () => {
    vi.stubGlobal('MediaStream', FakeMediaStream)
    const fake = fakeContext()
    fake.context.createMediaStreamSource.mockImplementationOnce(() => {
      throw new DOMException('another sample rate', 'NotSupportedError')
    })
    const meter = webAudioMeter(fake.make)
    const refused = capture()
    for (let frame = 0; frame < 5; frame += 1) expect(meter.level(refused)).toBe(0)
    expect(fake.context.createMediaStreamSource).toHaveBeenCalledTimes(1)
    // The microphone turned on again: a new capture, read.
    expect(meter.level(capture())).toBeCloseTo(0.5)
  })

  it('asks a context the browser suspended to resume, once at a time', async () => {
    vi.stubGlobal('MediaStream', FakeMediaStream)
    const fake = fakeContext()
    const meter = webAudioMeter(fake.make)
    const track = capture()
    meter.level(track)
    expect(fake.context.resume).not.toHaveBeenCalled()
    // iOS, after the microphone switched its audio session; the browser takes its time.
    let resumed = () => undefined as void
    fake.context.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resumed = () => {
            fake.context.state = 'running'
            resolve()
          }
        })
    )
    fake.context.state = 'interrupted'
    meter.level(track)
    meter.level(track)
    meter.level(track)
    // Asked once, not on every frame while it resumes.
    expect(fake.context.resume).toHaveBeenCalledTimes(1)
    resumed()
    await Promise.resolve()
    meter.level(track)
    expect(fake.context.resume).toHaveBeenCalledTimes(1)
    // Suspended again, later: asked again.
    fake.context.state = 'suspended'
    meter.level(track)
    expect(fake.context.resume).toHaveBeenCalledTimes(2)
  })

  it('reads 0 when the analyser throws, rather than breaking the frame', () => {
    vi.stubGlobal('MediaStream', FakeMediaStream)
    const fake = fakeContext()
    fake.analyser.getFloatTimeDomainData.mockImplementation(() => {
      throw new Error('detached')
    })
    expect(webAudioMeter(fake.make).level(capture())).toBe(0)
  })
})
