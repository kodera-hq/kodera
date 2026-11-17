import { useSyncExternalStore } from 'react'
import type { AudioSettingsCall } from '../espace/AudioSettings'
import type { MemberView } from '../espace/matrix/store'

/**
 * The member's own Matrix profile and the ways to change it, where a live session holds one. The
 * homeserver's profile is what every other client draws, so a name or a picture set here follows
 * the member into every room — unlike the browser-local status, which stays on this device.
 */
export interface WorkspaceSettingsProfile {
  /** The name the homeserver holds, where it holds a human one rather than the account's id. */
  matrixDisplayName: string | undefined
  /** The `mxc://` address the homeserver holds, if any: changes when the avatar does. */
  avatarKey: string | undefined
  /** The avatar as bytes; `null` where there is none. The panel draws the bytes, never a remote
   * address, so the console's `img-src` still names no foreign host. */
  fetchAvatar: (size?: number) => Promise<Blob | null>
  setDisplayName: (displayName: string) => Promise<void>
  setAvatar: (file: Blob, filename: string) => Promise<void>
  clearAvatar: () => Promise<void>
}

export interface WorkspaceSettingsRuntime {
  org: string
  userId: string
  displayName: string
  /** The name the console's own account carries (`Me.display_name`, else the address's local
   * part): a human name to start from when neither this device nor the homeserver holds one. */
  accountName?: string | undefined
  channels?: readonly { id: string; label: string }[] | undefined
  members: readonly MemberView[]
  call: AudioSettingsCall | null
  invite: ((userId: string) => Promise<void>) | undefined
  /** Absent where the session cannot reach the homeserver's profile (demo, signed out). */
  profile?: WorkspaceSettingsProfile | undefined
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
      channels: [],
      // The homeserver's profile is reachable only while its session is: a panel left open after
      // the session ends offers nothing it could not carry out.
      profile: undefined,
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
