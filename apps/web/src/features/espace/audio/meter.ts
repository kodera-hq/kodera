// How loud the member's own microphone is, read in this browser: the level a meter draws and the
// speaking ring follows (spec 11, « Hearing yourself in an audio room »). It reads the call's own
// capture, never a copy of it: a cloned track would keep the microphone, and the browser's
// recording indicator, on after the call stops its capture. The analyser is connected to nothing
// that plays, so the member never hears themselves.

/** A level reader for one call. */
export interface MicMeter {
  /** The level of `track` now: the RMS of its latest samples, 0 (silence) to 1 (full scale). */
  level(track: MediaStreamTrack): number
  /** Lets go of the audio graph and its context. The meter reads 0 from then on. */
  close(): void
}

/** The analyser's window: about 20 ms at 48 kHz, short enough to follow speech. */
const WINDOW = 1024

/** A meter that reads nothing: where the browser has no Web Audio, or it could not start. */
export const SILENT_METER: MicMeter = Object.freeze({
  level: () => 0,
  close: () => undefined,
})

/**
 * A Web Audio meter. Make it from the member's click (a join): a context made outside a gesture
 * may start suspended, and a suspended analyser reads silence. One the browser suspends later
 * (iOS, when the microphone switches its audio session, or a page sent to the background) is
 * asked to resume.
 */
export function webAudioMeter(createContext?: () => AudioContext): MicMeter {
  // jsdom, or a browser without Web Audio: the call works, the meter stays still.
  if (createContext === undefined && typeof AudioContext === 'undefined') return SILENT_METER
  let context: AudioContext
  let analyser: AnalyserNode
  try {
    context = createContext === undefined ? new AudioContext() : createContext()
    analyser = context.createAnalyser()
    analyser.fftSize = WINDOW
  } catch {
    return SILENT_METER
  }
  const samples = new Float32Array(WINDOW)
  let source: MediaStreamAudioSourceNode | null = null
  let reading: MediaStreamTrack | null = null
  // A capture this context could not read (Firefox refuses one at another sample rate): not tried
  // again on every frame. A new capture is tried afresh.
  let refused: MediaStreamTrack | null = null
  let resuming = false
  let closed = false

  const wake = () => {
    if (resuming || context.state === 'running' || context.state === 'closed') return
    resuming = true
    const done = () => {
      resuming = false
    }
    try {
      context.resume().then(done, done)
    } catch {
      done()
    }
  }

  const detach = () => {
    try {
      source?.disconnect()
    } catch {
      // Already disconnected.
    }
    source = null
    reading = null
  }

  return {
    level(track) {
      if (closed || track.readyState === 'ended' || track === refused) return 0
      if (track !== reading) {
        detach()
        try {
          // The same track, in a stream of its own: not `track.clone()` (see the file's head).
          source = context.createMediaStreamSource(new MediaStream([track]))
          source.connect(analyser)
          reading = track
        } catch {
          detach()
          refused = track
          return 0
        }
      }
      wake()
      try {
        analyser.getFloatTimeDomainData(samples)
      } catch {
        return 0
      }
      let sum = 0
      for (const sample of samples) sum += sample * sample
      return Math.min(1, Math.sqrt(sum / samples.length))
    },
    close() {
      if (closed) return
      closed = true
      detach()
      void context.close().catch(() => undefined)
    },
  }
}
