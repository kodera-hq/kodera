import { useEffect } from 'react'
import { coreApi } from '../../api/client'
import type { AuthLifetime } from '../../auth/authLifetimeContext'

const RENEW_MS = 30_000

/** A separate lease per mounted workspace prevents old cleanup from revoking a new session. */
export function useForegroundPresence(
  organisationId: string | undefined,
  membershipActive: boolean | undefined,
  lifetime: AuthLifetime | null
): void {
  useEffect(() => {
    if (import.meta.env.MODE === 'test') return
    if (!organisationId || membershipActive !== true || lifetime === null) return
    if (typeof document === 'undefined' || typeof navigator === 'undefined') return
    let disposed = false
    let lease: { deviceId: string; controller: AbortController; pending: Promise<unknown> } | null =
      null
    let timer: ReturnType<typeof setTimeout> | undefined
    const platform = '__TAURI_INTERNALS__' in window ? 'desktop' : 'web'
    const eligible = () =>
      !disposed &&
      document.visibilityState === 'visible' &&
      navigator.onLine !== false &&
      lifetime.hasUsableCredential()
    const revoke = () => {
      clearTimeout(timer)
      const previous = lease
      lease = null
      if (previous === null) return
      previous.controller.abort()
      // Order deletion after the pending renewal has settled, including aborted requests.
      void previous.pending.finally(async () => {
        try {
          await coreApi().DELETE('/notifications/presence/{device_id}', {
            params: { path: { device_id: previous.deviceId } },
          })
        } catch {
          /* The bounded server TTL also expires an unreachable lease. */
        }
      })
    }
    const renew = () => {
      if (!eligible()) {
        revoke()
        return
      }
      lease ??= {
        deviceId: crypto.randomUUID(),
        controller: new AbortController(),
        pending: Promise.resolve(),
      }
      const current = lease
      current.pending = (async () => {
        try {
          await coreApi().PUT('/notifications/presence/{device_id}', {
            params: { path: { device_id: current.deviceId } },
            body: { platform, ttlSeconds: 60 },
            signal: current.controller.signal,
          })
        } catch {
          /* Presence is best effort when the Core API is offline. */
        }
      })()
      void current.pending.then(() => {
        if (lease === current && eligible()) timer = setTimeout(renew, RENEW_MS)
      })
    }
    const reconcile = () => {
      if (!eligible()) revoke()
      else if (lease === null) renew()
    }
    const unsubscribe = lifetime.subscribe(reconcile)
    document.addEventListener('visibilitychange', reconcile)
    window.addEventListener('online', reconcile)
    window.addEventListener('offline', reconcile)
    reconcile()
    return () => {
      disposed = true
      unsubscribe()
      document.removeEventListener('visibilitychange', reconcile)
      window.removeEventListener('online', reconcile)
      window.removeEventListener('offline', reconcile)
      revoke()
    }
  }, [organisationId, membershipActive, lifetime])
}
