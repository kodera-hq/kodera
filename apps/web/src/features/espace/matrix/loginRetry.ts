/** Bounded login recovery. Credentials remain in the caller's memory throughout the wait. */
const MAX_WAIT_MS = 15_000
const MAX_RETRIES = 2

export async function retryLimitedLogin(
  first: Response,
  retry: () => Promise<Response>,
  current: () => boolean,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<Response> {
  let response = first
  let remaining = MAX_WAIT_MS
  for (let attempt = 0; response.status === 429 && attempt < MAX_RETRIES; attempt += 1) {
    const delays: number[] = []
    try {
      const body = (await response.clone().json()) as { retry_after_ms?: unknown }
      if (
        typeof body.retry_after_ms === 'number' &&
        Number.isFinite(body.retry_after_ms) &&
        body.retry_after_ms >= 0
      ) {
        delays.push(body.retry_after_ms)
      }
    } catch {
      // A proxy may send HTML; Retry-After still applies.
    }
    const header = response.headers.get('Retry-After')
    if (header !== null) {
      const seconds = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
      if (Number.isFinite(delay) && delay >= 0) delays.push(delay)
    }
    // Honour the longest server instruction; never truncate it into an early retry.
    const delay = Math.max(250, ...(delays.length === 0 ? [1000 * 2 ** attempt] : delays))
    if (!current() || delay > remaining) break
    remaining -= delay
    await wait(delay)
    if (!current()) break
    response = await retry()
  }
  return response
}
