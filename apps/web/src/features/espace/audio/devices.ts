// The member's microphone and output, as the browser lists them, the choice remembered in this
// browser, and the tone « Tester le son » plays (spec 11, « Choosing the microphone and the
// output »). Nothing here goes into a call: the controller applies the choice (`CallController`).

/** A device the member can choose; `label` is empty when the browser names none. */
export interface AudioDevice {
  id: string
  label: string
}

export interface AudioDevices {
  inputs: readonly AudioDevice[]
  outputs: readonly AudioDevice[]
}

/** The member's choice: a device id each, or null for the system's default. */
export interface AudioDeviceChoice {
  input: string | null
  output: string | null
}

export const NO_CHOICE: AudioDeviceChoice = Object.freeze({ input: null, output: null })
export const NO_DEVICES: AudioDevices = Object.freeze({ inputs: [], outputs: [] })

/** Where the choice is kept, beside the console's other per-browser choices (`console:theme`). */
export const AUDIO_DEVICES_STORAGE_KEY = 'console:audio-devices'

// Chrome's aliases for whatever the system uses: « Par défaut du système » stands for them.
const ALIASES = new Set(['default', 'communications', ''])

function devicesOf(listed: readonly MediaDeviceInfo[], kind: MediaDeviceKind): AudioDevice[] {
  const seen = new Set<string>()
  const devices: AudioDevice[] = []
  for (const device of listed) {
    if (device.kind !== kind || ALIASES.has(device.deviceId) || seen.has(device.deviceId)) continue
    seen.add(device.deviceId)
    devices.push({ id: device.deviceId, label: device.label })
  }
  return devices
}

/** The microphones and outputs the browser lists now; none where it lists nothing. */
export async function listAudioDevices(
  media: Pick<MediaDevices, 'enumerateDevices'> | undefined = globalThis.navigator?.mediaDevices
): Promise<AudioDevices> {
  if (media === undefined) return NO_DEVICES
  try {
    const listed = await media.enumerateDevices()
    return { inputs: devicesOf(listed, 'audioinput'), outputs: devicesOf(listed, 'audiooutput') }
  } catch {
    return NO_DEVICES
  }
}

/** Whether this browser can choose where a page's sound plays. */
export function canChooseOutput(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
}

function idOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && !ALIASES.has(value) ? value : null
}

/** The choice remembered in this browser, or none when there is none, or it cannot be read. */
export function readDeviceChoice(): AudioDeviceChoice {
  try {
    const stored = window.localStorage.getItem(AUDIO_DEVICES_STORAGE_KEY)
    if (stored === null) return NO_CHOICE
    const parsed = JSON.parse(stored) as Record<string, unknown> | null
    return { input: idOf(parsed?.['input']), output: idOf(parsed?.['output']) }
  } catch {
    return NO_CHOICE
  }
}

/** Remembers the choice; false when the browser refused it, and it lasts this page only. */
export function saveDeviceChoice(choice: AudioDeviceChoice): boolean {
  try {
    window.localStorage.setItem(AUDIO_DEVICES_STORAGE_KEY, JSON.stringify(choice))
    return true
  } catch {
    return false
  }
}

/** The tone's length and pitch: short, and plain enough to tell apart from the call. */
export const TEST_TONE_MS = 700
const TEST_TONE_HZ = 440
const TEST_TONE_GAIN = 0.2

interface ToneElement {
  srcObject: MediaProvider | null
  play: () => Promise<void>
  pause: () => void
  setSinkId?: (id: string) => Promise<void>
}

export interface TestToneOptions {
  createContext?: () => AudioContext
  createElement?: () => ToneElement
  /** Waits out the tone; a timer by default, which tests replace. */
  wait?: (ms: number) => Promise<void>
}

/**
 * Plays « Tester le son »'s tone on `output` (the system's default when null), from the member's
 * click. Resolves once it has played, and rejects when it could not: no Web Audio, an output the
 * browser will not play on.
 */
export async function playTestTone(
  output: string | null,
  {
    createContext = () => new AudioContext(),
    createElement = () => new Audio(),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: TestToneOptions = {}
): Promise<void> {
  const context = createContext()
  let element: ToneElement | null = null
  try {
    element = createElement()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const destination = context.createMediaStreamDestination()
    oscillator.frequency.value = TEST_TONE_HZ
    gain.gain.value = TEST_TONE_GAIN
    oscillator.connect(gain)
    // Into a stream an element plays, not to the context's own output: only an element can be
    // sent to the output chosen.
    gain.connect(destination)
    if (output !== null && element.setSinkId !== undefined) await element.setSinkId(output)
    element.srcObject = destination.stream
    oscillator.start()
    await element.play()
    await wait(TEST_TONE_MS)
    oscillator.stop()
  } finally {
    if (element !== null) {
      element.pause()
      element.srcObject = null
    }
    void context.close().catch(() => undefined)
  }
}
