// Reactive store for local/optimistic channel & call polls and votes, merged seamlessly with
// synced Matrix `m.room.message` (`io.kodera.poll`), `io.kodera.poll.response`, and
// `io.kodera.poll.end` events. Automatically cleared on sign-out or Matrix session rotation.

import { subscribeMatrixSession } from '@/auth/matrix'
import {
  POLL_END_EVENT,
  POLL_RESPONSE_EVENT,
  castPollVote,
  closeChannelPoll,
  createChannelPoll,
  type ChannelPoll,
  type PollWirePayload,
} from './pollState'

export interface PollEventSink {
  sendEvent?: (roomId: string, eventType: string, content: Record<string, unknown>) => Promise<void>
}

export interface TimelinePollMessage {
  readonly eventId: string
  readonly sender: string
  readonly senderName?: string | undefined
  readonly ts: number
  readonly redacted: boolean
  readonly poll?: PollWirePayload | undefined
  readonly pollResponses?: Readonly<Record<string, readonly number[]>> | undefined
  readonly pollEndedBy?: readonly string[] | undefined
}

export interface DerivePollsOptions {
  readonly sink?: PollEventSink | undefined
  readonly isModerator?: ((userId: string) => boolean) | undefined
}

const EMPTY_POLLS: readonly ChannelPoll[] = []

function selectedIndexesForVoter(poll: ChannelPoll, voterId: string): number[] {
  const indexes: number[] = []
  poll.options.forEach((opt, idx) => {
    if (opt.voterIds.includes(voterId)) {
      indexes.push(idx)
    }
  })
  return indexes
}

class PollRuntimeStore {
  #localPolls = new Map<string, readonly ChannelPoll[]>()
  #overrides = new Map<string, Map<string, readonly number[]>>()
  #closed = new Set<string>()
  #pendingVotes = new Map<string, Map<string, readonly number[]>>()
  #pendingCloses = new Set<string>()
  #requiresClientId = new Set<string>()
  #knownEvents = new Map<string, Set<string>>()
  #version = 0
  #listeners = new Set<() => void>()
  #serial = 0

  constructor() {
    subscribeMatrixSession(() => {
      this.clearAll()
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getVersion = (): number => this.#version

  recordLocalPoll(params: {
    readonly roomId: string
    readonly payload: PollWirePayload
    readonly createdBy: string
    readonly createdByName: string
    readonly createdAt?: number
    readonly requireClientPollId?: boolean
  }): ChannelPoll {
    const id = `local-poll-${++this.#serial}-${Date.now()}`
    if (params.requireClientPollId === true) {
      this.#requiresClientId.add(id)
    }
    const poll = createChannelPoll({
      id,
      roomId: params.roomId,
      question: params.payload.question,
      options: params.payload.options,
      allowMultiple: params.payload.allowMultiple,
      anonymous: params.payload.anonymous,
      createdBy: params.createdBy,
      createdByName: params.createdByName,
      createdAt: params.createdAt ?? Date.now(),
    })
    const existing = this.#localPolls.get(params.roomId) ?? EMPTY_POLLS
    this.#localPolls.set(params.roomId, [...existing, poll])
    this.#emit()
    return poll
  }

  removeLocalPoll(roomId: string, pollId: string): void {
    const existing = this.#localPolls.get(roomId)
    if (existing !== undefined) {
      const next = existing.filter((entry) => entry.id !== pollId)
      if (next.length === 0) this.#localPolls.delete(roomId)
      else this.#localPolls.set(roomId, next)
    }
    this.#overrides.delete(pollId)
    this.#closed.delete(pollId)
    this.#pendingVotes.delete(pollId)
    this.#pendingCloses.delete(pollId)
    this.#requiresClientId.delete(pollId)
    this.#emit()
  }

  vote(poll: ChannelPoll, optionId: string, voterId: string, sink?: PollEventSink): ChannelPoll {
    const base = this.#applyOverrides(poll)
    const next = castPollVote(base, optionId, voterId)
    const optionIndexes = selectedIndexesForVoter(next, voterId)
    const overrides = this.#overrides.get(poll.id) ?? new Map<string, readonly number[]>()
    overrides.set(voterId, optionIndexes)
    this.#overrides.set(poll.id, overrides)
    this.#syncLocal(next)
    if (poll.id.startsWith('local-poll-')) {
      const byVoter = this.#pendingVotes.get(poll.id) ?? new Map<string, readonly number[]>()
      byVoter.set(voterId, optionIndexes)
      this.#pendingVotes.set(poll.id, byVoter)
    } else if (sink?.sendEvent !== undefined) {
      void sink
        .sendEvent(poll.roomId, POLL_RESPONSE_EVENT, {
          'm.relates_to': { rel_type: 'm.reference', event_id: poll.id },
          pollId: poll.id,
          optionIndexes,
        })
        .catch(() => {
          if (this.#overrides.get(poll.id)?.get(voterId) === optionIndexes) {
            this.#overrides.get(poll.id)?.delete(voterId)
            this.#emit()
          }
        })
    }

    this.#emit()
    return next
  }

  close(poll: ChannelPoll, sink?: PollEventSink, actorMayClose = true): ChannelPoll {
    const base = this.#applyOverrides(poll)
    if (!actorMayClose) return base
    const next = closeChannelPoll(base)
    this.#closed.add(poll.id)
    this.#syncLocal(next)

    if (poll.id.startsWith('local-poll-')) {
      this.#pendingCloses.add(poll.id)
    } else if (sink?.sendEvent !== undefined) {
      void sink
        .sendEvent(poll.roomId, POLL_END_EVENT, {
          'm.relates_to': { rel_type: 'm.reference', event_id: poll.id },
          pollId: poll.id,
        })
        .catch(() => undefined)
    }

    this.#emit()
    return next
  }

  clearRoom(roomId: string): void {
    const locals = this.#localPolls.get(roomId)
    if (locals !== undefined) {
      for (const local of locals) {
        this.#overrides.delete(local.id)
        this.#closed.delete(local.id)
        this.#pendingVotes.delete(local.id)
        this.#pendingCloses.delete(local.id)
        this.#requiresClientId.delete(local.id)
      }
      this.#localPolls.delete(roomId)
    }
    this.#knownEvents.delete(roomId)
    this.#emit()
  }

  clearAll(): void {
    if (
      this.#localPolls.size === 0 &&
      this.#overrides.size === 0 &&
      this.#closed.size === 0 &&
      this.#pendingVotes.size === 0 &&
      this.#pendingCloses.size === 0 &&
      this.#knownEvents.size === 0
    ) {
      return
    }
    this.#localPolls.clear()
    this.#overrides.clear()
    this.#closed.clear()
    this.#pendingVotes.clear()
    this.#pendingCloses.clear()
    this.#requiresClientId.clear()
    this.#knownEvents.clear()
    this.#emit()
  }

  derivePolls(
    roomId: string | null,
    timeline: readonly TimelinePollMessage[],
    fallbackName: string,
    options?: DerivePollsOptions
  ): readonly ChannelPoll[] {
    if (roomId === null) return EMPTY_POLLS
    const synced: ChannelPoll[] = []
    const roomLocals = [...(this.#localPolls.get(roomId) ?? EMPTY_POLLS)]
    const knownEvents = this.#knownEvents.get(roomId) ?? new Set<string>()
    this.#knownEvents.set(roomId, knownEvents)

    for (const msg of timeline) {
      if (msg.redacted || msg.poll === undefined) continue
      const alreadyIngested = knownEvents.has(msg.eventId)
      knownEvents.add(msg.eventId)

      const initialVotesByOptionIndex: Record<number, string[]> = {}
      if (msg.pollResponses !== undefined) {
        for (const [voterId, indexes] of Object.entries(msg.pollResponses)) {
          const valid = msg.poll.allowMultiple ? indexes : indexes.slice(0, 1)
          for (const idx of valid) {
            if (!Number.isInteger(idx) || idx < 0 || idx >= msg.poll.options.length) continue
            const bucket = initialVotesByOptionIndex[idx] ?? []
            bucket.push(voterId)
            initialVotesByOptionIndex[idx] = bucket
          }
        }
      }

      let base = createChannelPoll({
        id: msg.eventId,
        roomId,
        question: msg.poll.question,
        options: msg.poll.options,
        allowMultiple: msg.poll.allowMultiple,
        anonymous: msg.poll.anonymous,
        createdBy: msg.sender,
        createdByName: msg.senderName ?? (msg.sender || fallbackName),
        createdAt: msg.ts,
        initialVotesByOptionIndex,
      })

      if (msg.pollEndedBy !== undefined && msg.pollEndedBy.length > 0) {
        const authorizedClose = msg.pollEndedBy.some(
          (ender) => ender === msg.sender || options?.isModerator?.(ender) === true
        )
        if (authorizedClose) {
          base = closeChannelPoll(base)
        }
      }

      // Reconcile strictly by outbound `clientPollId` when bound (or, for uncorrelated callers,
      // only for non-historical events at/after `local.createdAt` matching the full payload tuple).
      const echoedClientId = msg.poll.clientPollId
      const payloadMatches = (local: ChannelPoll): boolean =>
        local.question === msg.poll!.question &&
        local.allowMultiple === msg.poll!.allowMultiple &&
        local.options.length === msg.poll!.options.length &&
        local.options.every((option, index) => option.label === msg.poll!.options[index])
      const matchIdx = roomLocals.findIndex((local) => {
        if (alreadyIngested || local.createdBy !== msg.sender || !payloadMatches(local)) {
          return false
        }
        if (echoedClientId !== undefined) {
          return local.id === echoedClientId
        }
        if (this.#requiresClientId.has(local.id)) return false
        return msg.ts >= local.createdAt
      })
      if (matchIdx !== -1) {
        const matchedLocal = roomLocals.splice(matchIdx, 1)[0]!
        this.#requiresClientId.delete(matchedLocal.id)
        const localOverrides = this.#overrides.get(matchedLocal.id)
        if (localOverrides !== undefined) this.#overrides.set(msg.eventId, localOverrides)
        this.#overrides.delete(matchedLocal.id)
        if (this.#closed.delete(matchedLocal.id)) this.#closed.add(msg.eventId)

        const pendingVotes = this.#pendingVotes.get(matchedLocal.id)
        if (pendingVotes !== undefined) {
          this.#pendingVotes.delete(matchedLocal.id)
          if (options?.sink?.sendEvent !== undefined) {
            for (const optionIndexes of pendingVotes.values()) {
              void options.sink
                .sendEvent(roomId, POLL_RESPONSE_EVENT, {
                  'm.relates_to': { rel_type: 'm.reference', event_id: msg.eventId },
                  pollId: msg.eventId,
                  optionIndexes,
                })
                .catch(() => undefined)
            }
          }
        }
        if (this.#pendingCloses.delete(matchedLocal.id) && options?.sink?.sendEvent !== undefined) {
          void options.sink
            .sendEvent(roomId, POLL_END_EVENT, {
              'm.relates_to': { rel_type: 'm.reference', event_id: msg.eventId },
              pollId: msg.eventId,
            })
            .catch(() => undefined)
        }
        if (roomLocals.length === 0) this.#localPolls.delete(roomId)
        else this.#localPolls.set(roomId, [...roomLocals])
      }

      const current = this.#applyOverrides(base, true)
      synced.push(current)
    }

    if (synced.length === 0 && roomLocals.length === 0) return EMPTY_POLLS
    return [...synced, ...roomLocals].sort((a, b) => a.createdAt - b.createdAt)
  }

  #applyOverrides(poll: ChannelPoll, retireEcho = false): ChannelPoll {
    const byVoter = this.#overrides.get(poll.id)
    let current = poll
    for (const [voter, indexes] of byVoter ?? []) {
      const actual = selectedIndexesForVoter(poll, voter)
      if (
        retireEcho &&
        actual.length === indexes.length &&
        actual.every((i) => indexes.includes(i))
      ) {
        byVoter?.delete(voter)
        continue
      }
      current = {
        ...current,
        options: current.options.map((option, index) => ({
          ...option,
          voterIds: [
            ...option.voterIds.filter((id) => id !== voter),
            ...(indexes.includes(index) ? [voter] : []),
          ],
        })),
      }
    }
    if (byVoter?.size === 0) this.#overrides.delete(poll.id)
    if (poll.closed) this.#closed.delete(poll.id)
    return this.#closed.has(poll.id) ? closeChannelPoll(current) : current
  }

  #syncLocal(updated: ChannelPoll): void {
    const list = this.#localPolls.get(updated.roomId)
    if (list === undefined) return
    this.#localPolls.set(
      updated.roomId,
      list.map((entry) => (entry.id === updated.id ? updated : entry))
    )
  }

  #emit(): void {
    this.#version += 1
    for (const listener of [...this.#listeners]) {
      listener()
    }
  }
}

export const pollStore = new PollRuntimeStore()
