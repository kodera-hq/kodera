/** Markers deliberately omit observed values: failures must not disclose credentials or content. */
export function guard(value: unknown, marker: string): asserts value {
  if (!value) throw new Error(marker)
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function exactOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('TARGET_ORIGIN')
  }
  guard(
    ['https:', 'http:'].includes(url.protocol) &&
      url.origin === value &&
      !url.username &&
      !url.password,
    'TARGET_ORIGIN'
  )
  guard(
    url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'TARGET_TLS'
  )
  return url.origin
}

/** Placeholders match one encoded path segment, never a query, slash or wildcard. */
export function pathMatches(pattern: string, pathname: string): boolean {
  guard(pattern.startsWith('/') && !/[?#*]/.test(pattern), 'R1_PATH_TEMPLATE')
  const parts = pattern.split(/(\{[A-Za-z_][A-Za-z_0-9]*\})/)
  const expression = parts
    .map((part) =>
      /^\{\w+\}$/.test(part) ? '[^/?#]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    .join('')
  return new RegExp(`^${expression}$`).test(pathname)
}
