export function channelStorageKey(org: string, userId: string): string {
  return `kodera:last-channel:${encodeURIComponent(org)}:${encodeURIComponent(userId)}`
}
export function readLastChannel(org: string, userId: string): string | undefined {
  try {
    return localStorage.getItem(channelStorageKey(org, userId)) || undefined
  } catch {
    return undefined
  }
}
export function saveLastChannel(org: string, userId: string, channelId: string): void {
  try {
    localStorage.setItem(channelStorageKey(org, userId), channelId)
  } catch {
    /* Navigation works when browser storage is unavailable. */
  }
}
