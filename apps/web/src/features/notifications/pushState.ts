// Synchronous browser capability and device-key checks for Web Push, split from `./push.ts` so
// `AuthProvider` can inspect local state on sign-out without pulling push teardown into the entry.

export const PUSH_DEVICE_KEY = 'kodera.web.push-device'

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function readStoredPushDeviceId(): string | null {
  try {
    const stored = localStorage.getItem(PUSH_DEVICE_KEY)
    return stored !== null && /^[0-9a-f-]{36}$/iu.test(stored) ? stored : null
  } catch {
    return null
  }
}

export function hasStoredPushDeviceKey(): boolean {
  try {
    return localStorage.getItem(PUSH_DEVICE_KEY) !== null
  } catch {
    return false
  }
}
