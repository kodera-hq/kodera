import type { AnyRouter } from '@tanstack/react-router'
import { onTrack, track } from '../track'
import {
  getTelemetryScope,
  hasTelemetryConsent,
  refreshTelemetryConsent,
  setTelemetryScope,
  subscribeTelemetryConsent,
} from './consent'
import { reportTelemetryError } from './diagnostics'
import { EU_INGESTION_HOST, routeArea, type TelemetryOperation } from './privacy'

export async function startTelemetry(
  router: AnyRouter,
  key: string,
  host: string,
  loadTransport = () => import('./transport')
): Promise<() => void> {
  if (!key.trim() || host !== EU_INGESTION_HOST) return () => {}
  let epoch = 0
  let stopActive = () => {}
  const refresh = () => {
    const current = ++epoch
    stopActive()
    stopActive = () => {}
    if (!hasTelemetryConsent()) return
    void loadTransport()
      .then(({ createTelemetryTransport }) => {
        if (current !== epoch || !hasTelemetryConsent()) return
        const transport = createTelemetryTransport(key, host)
        if (!transport) return
        const untrack = onTrack((event) => transport.capture(event))
        const error = (event: ErrorEvent) => reportTelemetryError(event.error, 'error')
        const rejection = (event: PromiseRejectionEvent) =>
          reportTelemetryError(event.reason, 'rejection')
        window.addEventListener('error', error)
        window.addEventListener('unhandledrejection', rejection)
        const observers: PerformanceObserver[] = []
        let cls = 0
        let clsWindow = 0
        let clsStart = 0
        let clsPrevious = 0
        if (typeof PerformanceObserver !== 'undefined') {
          for (const type of ['largest-contentful-paint', 'layout-shift', 'event', 'resource']) {
            if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue
            try {
              const observer = new PerformanceObserver((list) => {
                if (current !== epoch || !hasTelemetryConsent()) return
                for (const entry of list.getEntries()) {
                  if (type === 'resource') {
                    // Examine a resource path only to select a fixed operation; retain no URL.
                    let operation: TelemetryOperation | undefined
                    try {
                      const path = new URL(entry.name, location.origin).pathname
                      if (/\/_matrix\/client\/[^/]+\/rooms\/[^/]+\/send\//.test(path))
                        operation = 'chat_send'
                      else if (/\/_matrix\/media\/[^/]+\/upload$/.test(path))
                        operation = 'file_upload'
                      else if (/\/_matrix\/.*\/(?:download|thumbnail)\//.test(path))
                        operation = 'file_download'
                      else if (/\/workspace\/documents(?:\/|$)/.test(path)) {
                        track('resource_latency', {
                          operation: 'docs_request',
                          duration_ms: entry.duration,
                        })
                        continue
                      }
                    } catch {
                      continue
                    }
                    if (operation)
                      track('resource_latency', { operation, duration_ms: entry.duration })
                  } else if (type === 'layout-shift') {
                    const shift = entry as PerformanceEntry & {
                      hadRecentInput?: boolean
                      value?: number
                    }
                    if (!shift.hadRecentInput && typeof shift.value === 'number') {
                      if (
                        entry.startTime - clsPrevious > 1000 ||
                        entry.startTime - clsStart > 5000
                      ) {
                        clsStart = entry.startTime
                        clsWindow = 0
                      }
                      clsWindow += shift.value
                      clsPrevious = entry.startTime
                      cls = Math.max(cls, clsWindow)
                      track('web_vital', { metric: 'CLS', value: cls })
                    }
                  } else {
                    const timing = entry as PerformanceEntry & { interactionId?: number }
                    if (type === 'event' && !timing.interactionId) continue
                    track('web_vital', {
                      metric: type === 'event' ? 'interaction_latency' : 'LCP',
                      value: type === 'event' ? entry.duration : entry.startTime,
                    })
                  }
                }
              })
              // No buffered entries: opting in never backfills activity before consent.
              observer.observe({ type, buffered: false })
              observers.push(observer)
            } catch {
              /* Unsupported entry types do not interrupt the application. */
            }
          }
        }
        stopActive = () => {
          untrack()
          transport.stop()
          window.removeEventListener('error', error)
          window.removeEventListener('unhandledrejection', rejection)
          for (const observer of observers) observer.disconnect()
        }
      })
      .catch(() => undefined)
  }
  let navigationStart = performance.now()
  const before = router.subscribe('onBeforeNavigate', (event) => {
    navigationStart = performance.now()
    const scope = getTelemetryScope()
    if (scope && event.toLocation.pathname.split('/')[1] !== encodeURIComponent(scope.slug))
      setTelemetryScope(undefined)
  })
  const resolved = router.subscribe('onResolved', (event) => {
    track('navigation_completed', {
      area: routeArea(event.toLocation.pathname),
      duration_ms: performance.now() - navigationStart,
    })
  })
  const unsubscribe = subscribeTelemetryConsent(refresh)
  window.addEventListener('storage', refreshTelemetryConsent)
  refresh()
  return () => {
    ++epoch
    stopActive()
    unsubscribe()
    before()
    resolved()
    window.removeEventListener('storage', refreshTelemetryConsent)
  }
}
