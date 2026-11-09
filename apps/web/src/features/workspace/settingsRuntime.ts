import { useSyncExternalStore } from 'react'
import type { AudioSettingsCall } from '../espace/AudioSettings'
import type { MemberView } from '../espace/matrix/store'

export interface WorkspaceSettingsRuntime {
  org: string
  userId: string
  displayName: string
  members: readonly MemberView[]
  call: AudioSettingsCall | null
  invite: ((userId: string) => Promise<void>) | undefined
  memberRole: (userId: string) => string
}
let active: WorkspaceSettingsRuntime | undefined
let epoch = 0
export function getWorkspaceSettingsEpoch() {
  return epoch
}
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function clearWorkspaceSettingsRuntime() {
  epoch += 1
  active = undefined
  for (const listener of listeners) listener()
}
export function registerWorkspaceSettingsRuntime(
  runtime: WorkspaceSettingsRuntime,
  registrationEpoch = epoch
) {
  if (registrationEpoch !== epoch) return () => {}
  active = runtime
  for (const listener of listeners) listener()
  return () => {
    if (active !== runtime) return
    // Preserve identity for account settings on console routes; room actions expire immediately.
    const roles = new Map(
      runtime.members.map((member) => [member.userId, runtime.memberRole(member.userId)])
    )
    active = {
      ...runtime,
      call: null,
      invite: undefined,
      memberRole: (userId) => roles.get(userId) ?? 'member',
    }
    for (const listener of listeners) listener()
  }
}
export function useWorkspaceSettingsRuntime() {
  return useSyncExternalStore(
    subscribe,
    () => active,
    () => undefined
  )
}

/** Open portals must retire with their authentication owner, even if the shell stays mounted. */
export function useWorkspaceSettingsEpoch() {
  return useSyncExternalStore(
    subscribe,
    () => epoch,
    () => 0
  )
}
