import type { BrowserContext, Request, Response, Route } from '@playwright/test'
import { exactOrigin, guard } from './oracles/shared'

/** Finish Core response reads before Matrix SSO replaces the browser document. */
export async function installMatrixNavigationBarrier(
  context: BrowserContext,
  apiOrigin: string,
  homeserverOrigin: string
) {
  const api = exactOrigin(apiOrigin)
  const homeserver = exactOrigin(homeserverOrigin)
  const pending = new Map<Request, { done: Promise<void>; finish(): void }>()
  let failed = false
  const started = (request: Request) => {
    const url = new URL(request.url())
    if (url.origin !== api || !/^\/api(?:\/|$)/.test(url.pathname)) return
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    pending.set(request, { done, finish })
  }
  const finish = (request: Request) => {
    pending.get(request)?.finish()
    pending.delete(request)
  }
  const responded = (response: Response) => {
    const request = response.request()
    if (!pending.has(request)) return
    void response
      .body()
      .catch(() => {
        failed = true
      })
      .finally(() => finish(request))
  }
  const matcher = (url: URL) =>
    url.origin === homeserver && url.pathname === '/_matrix/client/v3/login/sso/redirect'
  const navigate = async (route: Route) => {
    while (pending.size) await Promise.all([...pending.values()].map((request) => request.done))
    guard(!failed, 'WAVE2_CORE_RESPONSE_BARRIER')
    await route.continue()
  }
  context.on('request', started)
  context.on('response', responded)
  context.on('requestfailed', finish)
  await context.route(matcher, navigate)
  return async () => {
    context.off('request', started).off('response', responded).off('requestfailed', finish)
    await context.unroute(matcher, navigate)
  }
}
