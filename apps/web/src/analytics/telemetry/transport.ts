import type { AnalyticsEvent } from '../track'
import { EU_INGESTION_HOST, sanitizeTelemetryEvent } from './privacy'

/** Minimal capture API adapter: no SDK, cookies, URL enrichment, DOM readers or queue. */
export function createTelemetryTransport(key: string, host: string, personId: string) {
  if (!key.trim() || !personId.trim() || host !== EU_INGESTION_HOST) return undefined
  let distinctId: string | undefined = personId
  const pending = new Set<AbortController>()
  let windowStart = performance.now()
  let deliveries = 0
  return {
    capture(input: AnalyticsEvent): void {
      if (!distinctId) return
      let event: AnalyticsEvent | undefined
      try {
        event = sanitizeTelemetryEvent(input)
      } catch {
        return
      }
      if (!event) return
      const now = performance.now()
      if (now - windowStart >= 60_000) {
        windowStart = now
        deliveries = 0
      }
      // Bound delivery cost without retaining a queue of interaction or error data.
      if (deliveries >= 60) return
      deliveries += 1
      const controller = new AbortController()
      pending.add(controller)
      try {
        // eslint-disable-next-line no-restricted-globals -- ADR-0015: fixed EU-only capture transport.
        void fetch(`${EU_INGESTION_HOST}/i/v0/e/`, {
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            api_key: key,
            event: event.name,
            distinct_id: distinctId,
            properties: {
              ...event.properties,
              $process_person_profile: false,
              $geoip_disable: true,
            },
          }),
        })
          .catch(() => undefined)
          .finally(() => pending.delete(controller))
      } catch {
        pending.delete(controller)
      }
    },
    stop(): void {
      distinctId = undefined
      for (const controller of pending) controller.abort()
      pending.clear()
    },
  }
}
