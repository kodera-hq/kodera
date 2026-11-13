// How the member speaks in a call, remembered in this browser beside the devices they chose
// (`devices.ts`): voice activity or push-to-talk, and whether the browser's noise suppression
// cleans the microphone (docs/specs/espace-video-and-screenshare.md). Screens read it through
// `subscribe` and `getSnapshot`; the call applies noise suppression (`CallController`).

export type CallInputMode = 'voice' | 'push-to-talk'

export interface CallPreferenceValues {
  /** `voice`: the microphone is on until muted. `push-to-talk`: on only while a key is held. */
  inputMode: CallInputMode
  /** The browser's noise suppression on the microphone; on unless the member turns it off. */
  noiseSuppression: boolean
}

export const CALL_PREFERENCES_STORAGE_KEY = 'console:call-preferences'

export const DEFAULT_CALL_PREFERENCES: CallPreferenceValues = Object.freeze({
  inputMode: 'voice',
  noiseSuppression: true,
})

/** What this browser keeps, checked: anything not of the expected shape is the default. */
export function readCallPreferences(): CallPreferenceValues {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(CALL_PREFERENCES_STORAGE_KEY) ?? 'null'
    )
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
      return DEFAULT_CALL_PREFERENCES
    }
    const { inputMode, noiseSuppression } = stored as Record<string, unknown>
    if (inputMode !== 'voice' && inputMode !== 'push-to-talk') return DEFAULT_CALL_PREFERENCES
    if (typeof noiseSuppression !== 'boolean') return DEFAULT_CALL_PREFERENCES
    return { inputMode, noiseSuppression }
  } catch {
    return DEFAULT_CALL_PREFERENCES
  }
}

function save(values: CallPreferenceValues): void {
  try {
    window.localStorage.setItem(CALL_PREFERENCES_STORAGE_KEY, JSON.stringify(values))
  } catch {
    // Storage refused (private mode, full): the choice still holds for this page.
  }
}

export class CallPreferences {
  #values: CallPreferenceValues = readCallPreferences()
  readonly #listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): CallPreferenceValues => this.#values

  update(patch: Partial<CallPreferenceValues>): void {
    const next = { ...this.#values, ...patch }
    if (
      next.inputMode === this.#values.inputMode &&
      next.noiseSuppression === this.#values.noiseSuppression
    ) {
      return
    }
    this.#values = Object.freeze(next)
    save(this.#values)
    for (const listener of this.#listeners) listener()
  }
}

/** The page's one set of call preferences. */
export const callPreferences = new CallPreferences()
