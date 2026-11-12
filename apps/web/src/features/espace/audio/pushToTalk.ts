// Push-to-talk (docs/specs/espace-video-and-screenshare.md): while the mode is on, the microphone
// is off, and on only while the member holds the key below Escape (`Backquote`: « ² » on a
// French keyboard, « ` » on an English one), read by its place, not its letter. Nothing here
// knows about LiveKit: it mutes and unmutes through the call, as the dock's button does.
//
// It never turns a microphone on that the member could not otherwise: not while deafened (unmuting
// would undeafen), not in a listen-only room, not before the call is through. A key typed into a
// text field is the text's, and any way the page loses the key (another window, a hidden tab, the
// mode turned off) lets go of it, so the microphone never stays on with no key held.

import type { CallSnapshot } from './call'

/** The key held to speak, by its physical place: the one below Escape. */
export const PUSH_TO_TALK_CODE = 'Backquote'

export interface PushToTalkCall {
  getSnapshot: () => CallSnapshot
  setMuted: (muted: boolean) => Promise<void>
}

export interface PushToTalkOptions {
  target?: Window
  code?: string
}

function editable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true
  // `isContentEditable`, read from the attribute so it holds where the property is not computed.
  return (
    target.isContentEditable ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  )
}

/** Binds push-to-talk to the page; returns how to unbind it, which mutes when the key is held. */
export function bindPushToTalk(call: PushToTalkCall, options: PushToTalkOptions = {}): () => void {
  const target = options.target ?? window
  const doc = target.document
  const code = options.code ?? PUSH_TO_TALK_CODE
  let held = false

  const mute = () => void call.setMuted(true).catch(() => undefined)
  const release = () => {
    if (!held) return
    held = false
    mute()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== code || event.ctrlKey || event.metaKey || event.altKey) return
    if (editable(event.target)) return
    const snapshot = call.getSnapshot()
    if (snapshot.status !== 'connected' || snapshot.deafened || snapshot.listenOnly) return
    event.preventDefault()
    if (event.repeat || held) return
    held = true
    void call.setMuted(false).catch(() => undefined)
  }
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code === code) release()
  }
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') release()
  }

  target.addEventListener('keydown', onKeyDown, true)
  target.addEventListener('keyup', onKeyUp, true)
  target.addEventListener('blur', release)
  target.addEventListener('pagehide', release)
  doc.addEventListener('visibilitychange', onVisibility)

  // The mode starts silent: the member speaks by holding the key, not before.
  const start = call.getSnapshot()
  if (!start.muted && (start.status === 'connected' || start.status === 'reconnecting')) mute()

  return () => {
    target.removeEventListener('keydown', onKeyDown, true)
    target.removeEventListener('keyup', onKeyUp, true)
    target.removeEventListener('blur', release)
    target.removeEventListener('pagehide', release)
    doc.removeEventListener('visibilitychange', onVisibility)
    release()
  }
}
