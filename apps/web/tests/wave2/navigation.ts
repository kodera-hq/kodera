import type { BrowserContext, Request, Response, Route } from '@playwright/test'
import { exactOrigin, guard } from './oracles/shared'

/** Hold discovery until Core reads finish, before Matrix SSO starts document replacement. */
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
    url.origin === homeserver && url.pathname === '/.well-known/matrix/client'
  const navigate = async (route: Route) => {
    do {
      while (pending.size) await Promise.all([...pending.values()].map((request) => request.done))
      await route
        .request()
        .frame()
        .evaluate(async () => {
          await document.fonts.ready
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          })
        })
    } while (pending.size)
    if (failed) await route.abort().catch(() => {})
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
