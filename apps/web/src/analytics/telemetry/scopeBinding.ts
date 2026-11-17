import type { AuthLifetime } from '../../auth/AuthProvider'
import type * as Consent from './consent'

/** The owner and its authority must both survive the optional consent module's import. */
export function deferTelemetryScopeBinding(
  scope: Consent.TelemetryScope,
  lifetime: AuthLifetime,
  loadConsent?: () => Promise<Pick<typeof Consent, 'bindTelemetryScope'>>
): () => void {
  const stamp = lifetime.getRetirementStamp()
  let live = true
  let clear: (() => void) | undefined
  void (loadConsent ? loadConsent() : import('./consent'))
    .then(({ bindTelemetryScope }) => {
      if (live && lifetime.hasUsableCredential() && lifetime.getRetirementStamp() === stamp)
        clear = bindTelemetryScope(scope, lifetime)
    })
    .catch(() => undefined)
  return () => {
    live = false
    clear?.()
  }
}
