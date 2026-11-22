import { useEffect, useMemo, useRef, useState } from 'react'
import type { Workspace, WorkspaceChannel } from '../workspace/workspace'
import { activeJoinTargetIds, type EspaceStoreLike } from './liveViewModel'
import type { EspaceSnapshot } from './matrix/store'

export interface UseEspaceJoinSyncOptions {
  activeStore: EspaceStoreLike
  workspace: Workspace
  snapshot: EspaceSnapshot
  activeChannel: WorkspaceChannel | null | undefined
  activeRoomId: string | null
}

export function useEspaceJoinSync({
  activeStore,
  workspace,
  snapshot,
  activeChannel,
  activeRoomId,
}: UseEspaceJoinSyncOptions): { joinRefused: boolean } {
  const joinTargets = useMemo(
    () => activeJoinTargetIds(workspace, snapshot.channels, activeChannel),
    [workspace, snapshot.channels, activeChannel]
  )
  const joinTargetsKey = joinTargets.join(' ')
  const fallbackJoinRuntime = useRef<{
    store: EspaceStoreLike | null
    attempted: Set<string>
    seenInvites: Set<string>
    targets: readonly string[]
    running: boolean
    cancelled: boolean
  }>({
    store: null,
    attempted: new Set(),
    seenInvites: new Set(),
    targets: [],
    running: false,
    cancelled: false,
  })
  const [fallbackRefused, setFallbackRefused] = useState<{
    store: EspaceStoreLike
    rooms: ReadonlySet<string>
  }>(() => ({ store: activeStore, rooms: new Set() }))
  if (fallbackRefused.store !== activeStore) {
    setFallbackRefused({ store: activeStore, rooms: new Set() })
  }
  const joinedRoomIdsKey = useMemo(
    () => snapshot.rooms.map((item) => item.roomId).join(' '),
    [snapshot.rooms]
  )
  const invitedRoomIdsKey = useMemo(
    () => snapshot.invites.map((item) => item.roomId).join(' '),
    [snapshot.invites]
  )
  useEffect(() => {
    return () => {
      if (fallbackJoinRuntime.current.store === activeStore) {
        fallbackJoinRuntime.current.cancelled = true
      }
    }
  }, [activeStore])
  useEffect(() => {
    const targets = joinTargetsKey === '' ? [] : joinTargetsKey.split(' ')
    if (activeStore.ensureJoined !== undefined) {
      activeStore.ensureJoined(targets)
      return
    }
    const { join } = activeStore
    if (join === undefined || snapshot.status !== 'live') return
    if (fallbackJoinRuntime.current.store !== activeStore) {
      fallbackJoinRuntime.current = {
        store: activeStore,
        attempted: new Set(),
        seenInvites: new Set(),
        targets: [],
        running: false,
        cancelled: false,
      }
    }
    const runtime = fallbackJoinRuntime.current
    runtime.cancelled = false
    runtime.targets = targets
    const joined = new Set(joinedRoomIdsKey === '' ? [] : joinedRoomIdsKey.split(' '))
    for (const roomId of joined) runtime.attempted.add(roomId)
    const currentInvites = new Set(invitedRoomIdsKey === '' ? [] : invitedRoomIdsKey.split(' '))
    for (const seenId of runtime.seenInvites) {
      if (!currentInvites.has(seenId)) runtime.seenInvites.delete(seenId)
    }
    for (const inviteId of currentInvites) {
      if (!runtime.seenInvites.has(inviteId)) {
        runtime.seenInvites.add(inviteId)
        runtime.attempted.delete(inviteId)
      }
    }
    if (runtime.running) return
    runtime.running = true
    void (async () => {
      try {
        while (!runtime.cancelled && runtime.store === activeStore) {
          const currentSnap = activeStore.getSnapshot()
          if (currentSnap.status !== 'live') break
          const nextRoomId = runtime.targets.find(
            (roomId) =>
              !runtime.attempted.has(roomId) && !currentSnap.rooms.some((r) => r.roomId === roomId)
          )
          if (nextRoomId === undefined) break
          runtime.attempted.add(nextRoomId)
          try {
            await join.call(activeStore, nextRoomId)
          } catch (error: unknown) {
            const err = error as { errcode?: unknown; httpStatus?: unknown } | null
            if (!runtime.cancelled && (err?.errcode === 'M_FORBIDDEN' || err?.httpStatus === 403)) {
              setFallbackRefused((current) => {
                if (current.store !== activeStore || current.rooms.has(nextRoomId)) return current
                const next = new Set(current.rooms)
                next.add(nextRoomId)
                return { store: activeStore, rooms: next }
              })
            }
          }
        }
      } finally {
        runtime.running = false
      }
    })()
  }, [activeStore, joinTargetsKey, snapshot.status, joinedRoomIdsKey, invitedRoomIdsKey])

  const resolvedActiveChannel =
    activeChannel !== null && activeChannel !== undefined
      ? snapshot.channels.get(activeChannel.id)
      : undefined
  const resolvedActiveRoomId =
    resolvedActiveChannel?.state === 'resolved' ? resolvedActiveChannel.roomId : null
  const joinRefused =
    activeRoomId === null &&
    resolvedActiveRoomId !== null &&
    !snapshot.invites.some((invite) => invite.roomId === resolvedActiveRoomId) &&
    (activeStore.getJoinState?.(resolvedActiveRoomId) === 'refused' ||
      (fallbackRefused.store === activeStore && fallbackRefused.rooms.has(resolvedActiveRoomId)))

  return { joinRefused }
}
