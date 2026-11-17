import { coreApiUrl } from '../config'

/** Only the configured Core attachment mutations may use this final dispatch policy. */
export function guardCoreDispatch(isCurrent: () => boolean): typeof fetch {
  const transport = globalThis.fetch
  const base = new URL(coreApiUrl(), location.href)
  const prefix = base.pathname.replace(/\/$/, '') + '/organisations/'
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  const attachment = new RegExp(`^${uuid}/workspace/attachments/(?:uploads|${uuid}/complete)$`)
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), base)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (url.origin !== base.origin || url.username || url.password || url.search || url.hash ||
        !url.pathname.startsWith(prefix) || !attachment.test(url.pathname.slice(prefix.length)) ||
        method !== 'POST' || isCurrent() !== true) {
      throw new DOMException('Request context changed.', 'AbortError')
    }
    return transport(input, { ...init, redirect: 'error' })
  }
}
