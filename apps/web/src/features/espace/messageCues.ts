import type { EspaceStoreLike } from './liveViewModel'
import type { EspaceSnapshot } from './matrix/store'
import type { SoundPlaybackContext } from '../sounds/types'

type Cue = 'msg_mention' | 'msg_dm' | 'msg_channel_unread'
interface SeenRoom {
  readonly keys: ReadonlySet<string>
  readonly tail: string | null
}

/** Reads every joined room, priming history silently before considering live arrivals. */
export class MessageCueTracker {
  private rooms = new Map<string, SeenRoom>()
  private wasLive = false

  update(
    store: EspaceStoreLike,
    snapshot: EspaceSnapshot,
    play: (cue: Cue, context: SoundPlaybackContext) => void,
    activeRoomId: string | null = null
  ): void {
    const directs = new Set(store.getDirects?.().map((direct) => direct.roomId) ?? [])
    const channelIds = new Map<string, string>()
    for (const [id, resolved] of snapshot.channels) {
      if (resolved.state === 'resolved') channelIds.set(resolved.roomId, id)
    }
    const next = new Map<string, SeenRoom>()
    for (const room of snapshot.rooms) {
      if (room.kind !== 'text') continue
      const timeline = store.getTimeline(room.roomId)
      const previous = this.rooms.get(room.roomId)
      if (snapshot.status === 'live' && this.wasLive && previous !== undefined) {
        const tail = timeline.findIndex((message) => message.key === previous.tail)
        const candidates =
          tail >= 0
            ? timeline.slice(tail + 1)
            : previous.tail === null && store.getHistory?.(room.roomId) !== 'loading'
              ? timeline
              : []
        for (const message of candidates) {
          if (
            room.roomId === activeRoomId ||
            previous.keys.has(message.key) ||
            message.redacted ||
            message.sender === store.getUserId()
          )
            continue
          play(
            message.mentionsMe
              ? 'msg_mention'
              : directs.has(room.roomId)
                ? 'msg_dm'
                : 'msg_channel_unread',
            {
              channelId: channelIds.get(room.roomId) ?? room.roomId,
              roomId: room.roomId,
              senderId: message.sender,
              currentUserId: store.getUserId(),
            }
          )
        }
      }
      next.set(room.roomId, {
        keys: new Set(timeline.map((message) => message.key)),
        tail: timeline.at(-1)?.key ?? null,
      })
    }
    this.rooms = next
    this.wasLive = snapshot.status === 'live'
  }
}
