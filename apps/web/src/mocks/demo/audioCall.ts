import type { AudioCallLike } from '../../features/espace/EspaceLiveView'
import type { CallSnapshot } from '../../features/espace/audio/call'

/** Exercises call controls locally; never captures media or contacts a voice service. */
export function createLocalAudioCall(viewer: string, peers: readonly string[] = []): AudioCallLike {
  const listeners = new Set<() => void>()
  const idle = (): CallSnapshot => ({
    status: 'idle',
    roomId: null,
    muted: false,
    deafened: false,
    listenOnly: false,
    speakers: [],
    participants: [],
    playbackBlocked: false,
  })
  let snapshot = idle()
  let mutedBeforeDeafen = false
  const update = (next: CallSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  return {
    mode: 'local-preview',
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    async join(roomId) {
      mutedBeforeDeafen = false
      update({
        ...idle(),
        status: 'connected',
        roomId,
        self: viewer,
        participants: [viewer, ...peers],
        speakers: peers[0] !== undefined ? [peers[0]] : [],
      })
    },
    async leave() {
      update(idle())
    },
    async setMuted(muted) {
      if (snapshot.status !== 'connected') return
      update({ ...snapshot, muted, deafened: muted ? snapshot.deafened : false })
    },
    async setDeafened(deafened) {
      if (snapshot.status !== 'connected' || snapshot.deafened === deafened) return
      if (deafened) mutedBeforeDeafen = snapshot.muted
      update({ ...snapshot, deafened, muted: deafened || mutedBeforeDeafen })
    },
    async startAudio() {},
  }
}
