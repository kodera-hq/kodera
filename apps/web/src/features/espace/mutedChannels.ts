import { useCallback, useState } from 'react'
import type { ChannelMenuTarget } from './ChannelContextMenu'
import { useStableHandler } from './useStoreSlice'

export function mutedChannelsStorageKey(org: string, workspaceId: string, userId: string): string {
  return `kodera.muted-channels.${org}:${workspaceId}:${userId}`
}

export function readMutedChannels(org: string, workspaceId: string, userId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(mutedChannelsStorageKey(org, workspaceId, userId))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? new Set(parsed.filter((item): item is string => typeof item === 'string'))
      : new Set()
  } catch {
    return new Set()
  }
}

export function writeMutedChannels(
  org: string,
  workspaceId: string,
  userId: string,
  channels: ReadonlySet<string>
): void {
  try {
    const key = mutedChannelsStorageKey(org, workspaceId, userId)
    if (channels.size === 0) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify([...channels]))
  } catch {
    // Storage unavailable: keep session mute state in memory.
  }
}

export function useMutedChannels(org: string, workspaceId: string, viewerId: string) {
  const muteScopeKey = `${org}:${workspaceId}:${viewerId}`
  const [mutedState, setMutedState] = useState<{
    scope: string
    channels: ReadonlySet<string>
  }>(() => ({
    scope: muteScopeKey,
    channels: readMutedChannels(org, workspaceId, viewerId),
  }))
  if (mutedState.scope !== muteScopeKey) {
    setMutedState({
      scope: muteScopeKey,
      channels: readMutedChannels(org, workspaceId, viewerId),
    })
  }
  const mutedChannels = mutedState.channels
  const isChannelMuted = useCallback((id: string) => mutedChannels.has(id), [mutedChannels])
  const toggleChannelMute = useStableHandler((target: ChannelMenuTarget) => {
    const next = new Set(mutedChannels)
    if (next.has(target.channelId)) next.delete(target.channelId)
    else next.add(target.channelId)
    writeMutedChannels(org, workspaceId, viewerId, next)
    setMutedState({ scope: muteScopeKey, channels: next })
  })
  return { mutedChannels, isChannelMuted, toggleChannelMute }
}
