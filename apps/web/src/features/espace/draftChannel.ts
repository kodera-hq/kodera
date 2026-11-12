// What the member has started in the channel shown, as the live view's parts read and change it:
// the composer reads its text, the view reads the open thread, and a keystroke in one field draws
// only that field. Two places keep it, behind one shape: the provider's memory, through the lease
// the view holds on the room shown (`EspaceDraftProvider`), or, where no provider is mounted (a
// local demo, a view rendered on its own), a map the view owns for its store.

import { useMemo } from 'react'
import { EMPTY_DRAFT, type ChannelDraft, type DraftLease } from './EspaceDraftProvider'
import { useStoreSlice } from './useStoreSlice'

export type DraftPatch = Partial<ChannelDraft> | ((previous: ChannelDraft) => Partial<ChannelDraft>)

export interface DraftChannel {
  subscribe: (listener: () => void) => () => void
  /** The draft of the channel shown; the empty one when there is none, or no right to read it. */
  read: () => ChannelDraft
  update: (patch: DraftPatch) => void
  /** Runs `effect` for the channel shown, with `patch` applied; false when it was refused. */
  command: (effect: () => unknown, patch?: Partial<ChannelDraft>) => boolean
}

/** Drafts a view keeps itself, by key (`member\nroom`), for as long as it reads one store. */
export interface LocalDrafts {
  subscribe: (listener: () => void) => () => void
  read: (key: string | null) => ChannelDraft
  update: (key: string | null, patch: DraftPatch) => void
}

export function createLocalDrafts(): LocalDrafts {
  const drafts = new Map<string, ChannelDraft>()
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    read: (key) => (key === null ? undefined : drafts.get(key)) ?? EMPTY_DRAFT,
    update: (key, patch) => {
      if (key === null) return
      const previous = drafts.get(key) ?? EMPTY_DRAFT
      drafts.set(key, {
        ...previous,
        ...(typeof patch === 'function' ? patch(previous) : patch),
      })
      for (const listener of [...listeners]) {
        if (listeners.has(listener)) listener()
      }
    },
  }
}

interface DraftMemoryLike {
  subscribe: (listener: () => void) => () => void
}

/**
 * The draft of the channel shown. With a provider's memory, only its lease reads and writes, and
 * a refused write changes nothing; without one, the view's own map does, under `key`.
 */
export function useDraftChannel(
  memory: DraftMemoryLike | null,
  lease: DraftLease | null,
  local: LocalDrafts,
  key: string | null
): DraftChannel {
  return useMemo<DraftChannel>(() => {
    if (memory !== null) {
      return {
        subscribe: memory.subscribe,
        read: () => lease?.read() ?? EMPTY_DRAFT,
        update: (patch) => {
          lease?.update(patch)
        },
        command: (effect, patch) => lease?.command(effect, patch) ?? false,
      }
    }
    const update = (patch: DraftPatch) => local.update(key, patch)
    return {
      subscribe: local.subscribe,
      read: () => local.read(key),
      update,
      command: (effect, patch) => {
        if (patch !== undefined) update(patch)
        effect()
        return true
      },
    }
  }, [memory, lease, local, key])
}

/** One slice of the draft shown: the part reading it is drawn again only when it changes. */
export function useDraftSlice<Slice>(
  draft: DraftChannel,
  select: (draft: ChannelDraft) => Slice
): Slice {
  return useStoreSlice(draft.subscribe, draft.read, select)
}
