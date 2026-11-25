import { track } from '../track'
import { getTelemetryConsentVersion, hasTelemetryConsent } from './consent'
import { codeStack, routeArea, type TelemetryOperation } from './privacy'

export function reportTelemetryError(
  error: unknown,
  source: 'error' | 'rejection' | 'boundary',
  component: 'RouteError' | 'unknown' = 'unknown'
): void {
  try {
    const kind =
      error instanceof Error &&
      ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(error.name)
        ? error.name
        : 'unknown'
    track('client_error', {
      source,
      kind,
      component,
      area: routeArea(location.pathname),
      stack: codeStack(
        error,
        location.origin === 'null' ? `${location.protocol}//${location.host}` : location.origin
      ),
    })
  } catch {
    /* Hostile error objects cannot interrupt the application. */
  }
}
export async function measureTelemetryOperation<T>(
  operation: TelemetryOperation,
  run: () => Promise<T>
): Promise<T> {
  if (!hasTelemetryConsent()) return run()
  const version = getTelemetryConsentVersion()
  const start = performance.now()
  let success = false
  try {
    const result = await run()
    success = true
    return result
  } finally {
    try {
      if (hasTelemetryConsent() && version === getTelemetryConsentVersion())
        track('operation_completed', { operation, duration_ms: performance.now() - start, success })
    } catch {
      /* Diagnostics cannot change the operation's result. */
    }
  }
}
