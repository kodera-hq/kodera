// docs/specs/00-shell-and-login.md §10: "Route change moves focus to the page
// `h1` and announces the page title in a polite live region." UX audit SH-15:
// after a sidebar click, focus stayed on the link and nothing was announced.
// These run a real router on a memory history, so a route change here is what
// the router itself calls one.
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { RouteFocus } from './RouteFocus'
import { keepFocusOnRouteTo, keepsFocus } from './routeFocusHold'

const TITLES: Record<string, string> = {
  '/home': 'Accueil',
  '/help': 'Aide',
  '/invoices': 'Facturation',
  '/invoices/detail': 'Facturation',
  '/slow': 'Applications',
  '/bare': 'Personnes',
  '/kept': 'Apparence',
  '/order/plan': 'Commander votre instance',
  '/order/contacts': 'Commander votre instance',
  '/order/refused': 'Commander votre instance',
  '/guide': 'Sécurité et connexion',
}

/** A flow that announces its own steps, as the order wizard does: a change
 * from one of its steps to another is said by the flow, not by the page. */
const announcedByScreen = (from: string, to: string) =>
  from.startsWith('/order/') && to.startsWith('/order/')

/** What a screen does while its first read is in flight: no heading yet. */
const slow = { arrive: () => {} }

function SlowPage() {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    slow.arrive = () => setLoaded(true)
  }, [])
  return loaded ? (
    <>
      <h1>Vos applications</h1>
      <button type="button">Ouvrir Visio</button>
    </>
  ) : (
    <p>Chargement</p>
  )
}

/** A navigation link by address: the app's registered route types know
 * nothing of this test's own small tree, and an address needs none. */
function Go({ href, children }: { href: string; children: string }) {
  const router = useRouter()
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        void router.navigate({ href })
      }}
    >
      {children}
    </a>
  )
}

/** What the account menu and the phone's sheets do: the entry navigates and
 * closes the menu, and the closing menu hands focus back to its trigger from a
 * zero-delay timer. */
function Menu() {
  const router = useRouter()
  return (
    <button
      type="button"
      onClick={(event) => {
        const trigger = event.currentTarget
        window.setTimeout(() => trigger.focus(), 0)
        void router.navigate({ href: '/help' })
      }}
    >
      Compte
    </button>
  )
}

function Layout() {
  const router = useRouter()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  // What the second-factor guard does (`src/app/org-route.tsx`): an address
  // the person may not see yet draws no page, and an effect sends them on.
  // Later than the real guard does, so that the router has finished loading
  // the guarded address first: the case in which it could be taken for a page.
  const guarded = pathname === '/guarded'
  useEffect(() => {
    if (!guarded) return
    const timer = window.setTimeout(() => void router.navigate({ href: '/guide' }), 20)
    return () => window.clearTimeout(timer)
  }, [guarded, router])
  return (
    <>
      <nav>
        <Menu />
        <Go href="/home">Accueil</Go>
        <Go href="/help">Aide</Go>
        <Go href="/invoices">Facturation</Go>
        <Go href="/invoices/detail">Une facture</Go>
        <Go href="/invoices?page=2">Page suivante</Go>
        <Go href="/slow">Applications</Go>
        <Go href="/bare">Personnes</Go>
        <Go href="/kept">Apparence</Go>
        <Go href="/order/plan">Commander</Go>
        <Go href="/order/contacts">Étape suivante</Go>
        <Go href="/order/refused">Commande refusée</Go>
        <Go href="/guarded">Une page gardée</Go>
      </nav>
      <main id="main-content">{guarded ? null : <Outlet />}</main>
      <RouteFocus
        title={TITLES[pathname] ?? 'Console'}
        announcedByScreen={announcedByScreen}
        redirecting={guarded}
      />
    </>
  )
}

function page(heading: string) {
  return function Page() {
    return (
      <>
        <h1>{heading}</h1>
        <button type="button">Une action</button>
      </>
    )
  }
}

/** What every order screen draws: the flow's name in a heading nobody sees,
 * then the step's own title. */
function step(heading: string) {
  return function Step() {
    return (
      <>
        <h1 className="sr-only">Commander votre instance</h1>
        <h1>{heading}</h1>
        <button type="button">Continuer</button>
      </>
    )
  }
}

function openAt(path: string) {
  const rootRoute = createRootRoute({ component: Layout })
  const route = (routePath: string, component: () => React.ReactNode) =>
    createRoute({ getParentRoute: () => rootRoute, path: routePath, component })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      route('/home', page('Bonjour Claire')),
      route('/help', page('Aide')),
      route('/invoices', page('Factures')),
      route('/invoices/detail', page('Facture F-2026-0042')),
      route('/slow', SlowPage),
      route('/bare', () => <p>Aucun titre ici</p>),
      // A screen that made its heading focusable itself. Any negative value
      // keeps it out of the tab order; this one is not the `-1` the route
      // change writes, so an overwrite would show.
      route('/kept', () => <h1 tabIndex={-2}>Apparence</h1>),
      route('/order/plan', step('Choisissez votre formule')),
      route('/order/contacts', step('Votre organisation')),
      route('/guarded', page('Une page que la garde ne montre pas')),
      route('/guide', page('Sécurisez votre compte')),
      route('/order/refused', () => (
        <>
          <h1 className="sr-only">Commander votre instance</h1>
          <p>Seul le propriétaire peut commander.</p>
        </>
      )),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(<RouterProvider router={router} />)
  return router
}

/** Every path the router finishes loading from here on, in order. */
function pathsLoaded(router: ReturnType<typeof openAt>): string[] {
  const paths: string[] = []
  router.subscribe('onResolved', (event) => paths.push(event.toLocation.pathname))
  return paths
}

beforeEach(() => {
  // jsdom has no scrolling; the router resets scroll on every navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  slow.arrive = () => {}
})

describe('a route change inside the shell', () => {
  it('leaves focus alone on the page the shell first shows', async () => {
    openAt('/home')
    await screen.findByRole('heading', { level: 1, name: 'Bonjour Claire' })
    // Long enough for a wrongly started focus move to have landed.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(document.body).toHaveFocus()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveAttribute('tabindex')
  })

  it('moves focus to the page heading, which stays out of the tab order', async () => {
    const user = userEvent.setup()
    openAt('/home')
    const link = await screen.findByRole('link', { name: 'Aide' })
    link.focus()

    await user.keyboard('{Enter}')

    const heading = await screen.findByRole('heading', { level: 1, name: 'Aide' })
    await waitFor(() => expect(heading).toHaveFocus())
    // Focusable from a script, never a stop for Tab.
    expect(heading).toHaveAttribute('tabindex', '-1')
    await user.tab()
    expect(screen.getByRole('button', { name: 'Une action' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(heading).not.toHaveFocus()
  })

  it('announces the page in one polite region', async () => {
    const user = userEvent.setup()
    openAt('/home')

    await user.click(await screen.findByRole('link', { name: 'Aide' }))

    const region = screen.getByRole('status')
    await waitFor(() => expect(region).toHaveTextContent('Page Aide chargée.'))
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('announces a page again when the next one carries the same title', async () => {
    const user = userEvent.setup()
    openAt('/home')
    await user.click(await screen.findByRole('link', { name: 'Facturation' }))
    const region = screen.getByRole('status')
    await waitFor(() => expect(region).toHaveTextContent('Page Facturation chargée.'))
    const first = region.firstElementChild

    await user.click(screen.getByRole('link', { name: 'Une facture' }))

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Facture F-2026-0042' })).toHaveFocus()
    )
    expect(region).toHaveTextContent('Page Facturation chargée.')
    // Unchanged text in an unchanged node is not announced a second time.
    expect(region.firstElementChild).not.toBe(first)
  })

  it('waits for a heading that arrives with the page data, and announces without waiting', async () => {
    const user = userEvent.setup()
    openAt('/home')
    const link = await screen.findByRole('link', { name: 'Applications' })
    link.focus()

    await user.keyboard('{Enter}')
    await screen.findByText('Chargement')

    // The announcement needs no data; focus has nowhere to go yet.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Page Applications chargée.')
    )
    expect(link).toHaveFocus()

    act(() => slow.arrive())

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Vos applications' })).toHaveFocus()
    )
  })

  it.each(['keyboard', 'pointer', 'wheel'] as const)(
    'does not take focus back after %s input before the heading arrived',
    async (input) => {
      const user = userEvent.setup()
      openAt('/home')
      const link = await screen.findByRole('link', { name: 'Applications' })
      link.focus()
      await user.keyboard('{Enter}')
      await screen.findByText('Chargement')
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Page Applications chargée.')
      )

      // Let the deferred focus attempt begin waiting before the person's input.
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
      if (input === 'keyboard') await user.tab()
      else if (input === 'pointer') fireEvent.pointerDown(screen.getByText('Chargement'))
      else fireEvent.wheel(screen.getByText('Chargement'), { deltaY: 100 })
      const chosen = document.activeElement
      act(() => slow.arrive())
      await screen.findByRole('heading', { level: 1, name: 'Vos applications' })
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

      expect(chosen).toHaveFocus()
      expect(screen.getByRole('heading', { level: 1 })).not.toHaveFocus()
      expect(screen.getByRole('heading', { level: 1 })).not.toHaveAttribute('tabindex')
    }
  )

  it('still announces a page that has no heading', async () => {
    const user = userEvent.setup()
    openAt('/home')
    const link = await screen.findByRole('link', { name: 'Personnes' })

    await user.click(link)
    await screen.findByText('Aucun titre ici')

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Page Personnes chargée.')
    )
  })

  it('ends on the heading when a closing menu hands focus back to its trigger', async () => {
    const user = userEvent.setup()
    openAt('/home')
    const trigger = await screen.findByRole('button', { name: 'Compte' })

    await user.click(trigger)

    const heading = await screen.findByRole('heading', { level: 1, name: 'Aide' })
    await waitFor(() => expect(heading).toHaveFocus())
    // Still there once every timer of the moment has run.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(heading).toHaveFocus()
  })

  it('does not treat a change of search parameters as a new page', async () => {
    const user = userEvent.setup()
    const router = openAt('/invoices')
    const link = await screen.findByRole('link', { name: 'Page suivante' })
    link.focus()

    await user.keyboard('{Enter}')
    await waitFor(() => expect(router.state.location.searchStr).toBe('?page=2'))
    await waitFor(() => expect(router.state.status).toBe('idle'))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(link).toHaveFocus()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('keeps a heading that is already focusable as it is', async () => {
    const user = userEvent.setup()
    openAt('/home')

    await user.click(await screen.findByRole('link', { name: 'Apparence' }))

    const heading = await screen.findByRole('heading', { level: 1, name: 'Apparence' })
    await waitFor(() => expect(heading).toHaveFocus())
    // Still the screen's own value, not the `-1` a heading with none is given.
    expect(heading).toHaveAttribute('tabindex', '-2')
  })

  // The order flow draws its name in a visually hidden `h1` above each step's
  // own title. Focus on a heading nobody can see is a lost place: a sighted
  // keyboard user would not know where `Tab` starts from.
  it('focuses the first heading a person can see, not a visually hidden one before it', async () => {
    const user = userEvent.setup()
    openAt('/home')

    await user.click(await screen.findByRole('link', { name: 'Commander' }))

    const visible = await screen.findByRole('heading', {
      level: 1,
      name: 'Choisissez votre formule',
    })
    await waitFor(() => expect(visible).toHaveFocus())
    const hidden = screen.getByRole('heading', { level: 1, name: 'Commander votre instance' })
    expect(hidden).not.toHaveAttribute('tabindex')
    expect(hidden).not.toHaveAttribute('data-route-heading')
    // Entering the flow is a route change like any other: it is announced.
    expect(screen.getByRole('status')).toHaveTextContent('Page Commander votre instance chargée.')
  })

  it('leaves focus alone on a page whose only heading is visually hidden', async () => {
    const user = userEvent.setup()
    openAt('/home')
    const link = await screen.findByRole('link', { name: 'Commande refusée' })
    link.focus()

    await user.keyboard('{Enter}')
    await screen.findByText('Seul le propriétaire peut commander.')
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Page Commander votre instance chargée.')
    )
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(link).toHaveFocus()
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveAttribute('tabindex')
  })

  it('moves focus and says nothing when the screen announces the change itself', async () => {
    const user = userEvent.setup()
    openAt('/home')
    await user.click(await screen.findByRole('link', { name: 'Commander' }))
    const region = screen.getByRole('status')
    await waitFor(() => expect(region).toHaveTextContent('Page Commander votre instance chargée.'))
    const said = region.firstElementChild
    // Anything written into the region from here on would be announced.
    const written: MutationRecord[] = []
    const observer = new MutationObserver((records) => written.push(...records))
    observer.observe(region, { childList: true, characterData: true, subtree: true })

    const next = screen.getByRole('link', { name: 'Étape suivante' })
    next.focus()
    await user.keyboard('{Enter}')

    const heading = await screen.findByRole('heading', { level: 1, name: 'Votre organisation' })
    await waitFor(() => expect(heading).toHaveFocus())
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    observer.disconnect()
    expect(written).toEqual([])
    expect(region.firstElementChild).toBe(said)
  })

  // §10: "Arriving … is not one, nor is a redirect on the way to a page." The
  // second-factor guard redirects from an effect, after the layout is mounted:
  // the person has still only arrived, on the one page they were shown.
  it('treats the page a guard sends an arriving person to as the page they arrived on', async () => {
    const user = userEvent.setup()
    const router = openAt('/guarded')
    const loaded = pathsLoaded(router)

    const guide = await screen.findByRole('heading', { level: 1, name: 'Sécurisez votre compte' })
    await waitFor(() => expect(router.state.status).toBe('idle'))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    // The router finished loading the guarded address before the guard moved
    // on: it was a settled path, and still not a page.
    expect(loaded).toEqual(['/guarded', '/guide'])
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(document.body).toHaveFocus()
    expect(guide).not.toHaveAttribute('tabindex')

    // A navigation from there is a route change like any other.
    await user.click(screen.getByRole('link', { name: 'Aide' }))
    const help = await screen.findByRole('heading', { level: 1, name: 'Aide' })
    await waitFor(() => expect(help).toHaveFocus())
    expect(screen.getByRole('status')).toHaveTextContent('Page Aide chargée.')
  })

  it('says nothing when a guard sends a person back to the page they are on', async () => {
    const user = userEvent.setup()
    const router = openAt('/guide')
    await screen.findByRole('heading', { level: 1, name: 'Sécurisez votre compte' })
    await waitFor(() => expect(router.state.status).toBe('idle'))
    const loaded = pathsLoaded(router)
    const link = screen.getByRole('link', { name: 'Une page gardée' })
    link.focus()

    await user.keyboard('{Enter}')
    await waitFor(() => expect(loaded).toEqual(['/guarded', '/guide']))
    await waitFor(() => expect(router.state.status).toBe('idle'))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveFocus()
  })
})

// The wait for a late heading has an end. Without one, a person who moved on
// with no key, pointer or wheel — a screen reader's own cursor, a script —
// would have focus pulled to a heading that arrives a minute later.
describe('a route change a screen asked to keep focus for', () => {
  it('leaves focus where it is and says nothing, for that one change only', async () => {
    const user = userEvent.setup()
    openAt('/home')
    const link = await screen.findByRole('link', { name: 'Aide' })
    link.focus()
    keepFocusOnRouteTo('/help')

    await user.keyboard('{Enter}')
    await screen.findByRole('heading', { level: 1, name: 'Aide' })
    // Long enough for a wrongly started focus move to have landed.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(link).toHaveFocus()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    // Settled, the request is let go: the next change moves focus as usual.
    expect(keepsFocus('/help')).toBe(false)

    await user.click(screen.getByRole('link', { name: 'Facturation' }))
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Factures' })).toHaveFocus()
    )
    expect(screen.getByRole('status')).toHaveTextContent('Page Facturation chargée.')
  })

  it('holds each page on its own, so two quick presses keep focus through both', async () => {
    const user = userEvent.setup()
    openAt('/home')
    const link = await screen.findByRole('link', { name: 'Aide' })
    link.focus()
    keepFocusOnRouteTo('/help')
    keepFocusOnRouteTo('/invoices')

    await user.keyboard('{Enter}')
    await screen.findByRole('heading', { level: 1, name: 'Aide' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(link).toHaveFocus()
    // Only the page that settled is let go: the other is still held.
    expect(keepsFocus('/help')).toBe(false)
    expect(keepsFocus('/invoices')).toBe(true)

    await user.click(screen.getByRole('link', { name: 'Facturation' }))
    await screen.findByRole('heading', { level: 1, name: 'Factures' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(screen.getByRole('heading', { level: 1, name: 'Factures' })).not.toHaveFocus()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(keepsFocus('/invoices')).toBe(false)
  })
})

describe('the wait for a heading that arrives late', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const pass = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  /** Follows the link to a page whose heading has not arrived, and returns the
   * link, which still has focus. */
  async function openSlowPage() {
    const router = openAt('/home')
    await pass(0)
    const link = screen.getByRole('link', { name: 'Applications' })
    link.focus()
    await act(async () => {
      await router.navigate({ href: '/slow' })
    })
    // The zero-delay timer that lets a closing menu hand focus back first.
    await pass(0)
    expect(screen.getByText('Chargement')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Page Applications chargée.')
    expect(link).toHaveFocus()
    return link
  }

  it('lasts five seconds', async () => {
    await openSlowPage()
    await pass(4_999)

    act(() => slow.arrive())
    await pass(0)

    expect(screen.getByRole('heading', { level: 1, name: 'Vos applications' })).toHaveFocus()
  })

  it('ends after five seconds, and focus stays where it is', async () => {
    const link = await openSlowPage()
    await pass(5_000)

    act(() => slow.arrive())
    await pass(0)

    const heading = screen.getByRole('heading', { level: 1, name: 'Vos applications' })
    expect(heading).not.toHaveFocus()
    expect(heading).not.toHaveAttribute('tabindex')
    expect(link).toHaveFocus()
  })

  function trackPendingWait() {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const added = vi.spyOn(document, 'addEventListener')
    const removed = vi.spyOn(document, 'removeEventListener')
    const scheduled = vi.spyOn(window, 'setTimeout')
    const cleared = vi.spyOn(window, 'clearTimeout')
    return { observe, disconnect, added, removed, scheduled, cleared }
  }

  it('cancels a pending heading wait when the layout unmounts', async () => {
    const tracked = trackPendingWait()
    await openSlowPage()
    const bodyIndex = tracked.observe.mock.calls.findLastIndex(
      ([target]) => target === document.body
    )
    expect(bodyIndex).toBeGreaterThanOrEqual(0)
    const observer = tracked.observe.mock.contexts[bodyIndex]
    const endIndex = tracked.scheduled.mock.calls.findIndex(([, delay]) => delay === 5_000)
    expect(endIndex).toBeGreaterThanOrEqual(0)
    const endTimer = tracked.scheduled.mock.results[endIndex]!.value
    const listeners = tracked.added.mock.calls.filter(
      ([type, , capture]) => ['keydown', 'pointerdown', 'wheel'].includes(type) && capture === true
    )
    expect(listeners).toHaveLength(3)

    cleanup()

    expect(tracked.disconnect.mock.contexts).toContain(observer)
    expect(tracked.cleared).toHaveBeenCalledWith(endTimer)
    for (const listener of listeners) expect(tracked.removed).toHaveBeenCalledWith(...listener)
    render(
      <main>
        <h1>Unrelated page</h1>
        <button type="button">Continue reading</button>
      </main>
    )
    screen.getByRole('button', { name: 'Continue reading' }).focus()
    await pass(0)
    const heading = screen.getByRole('heading', { level: 1, name: 'Unrelated page' })
    expect(heading).not.toHaveAttribute('tabindex')
    expect(screen.getByRole('button', { name: 'Continue reading' })).toHaveFocus()
  })

  it('cancels the obsolete wait when another navigation settles', async () => {
    const tracked = trackPendingWait()
    await openSlowPage()
    const bodyIndex = tracked.observe.mock.calls.findLastIndex(
      ([target]) => target === document.body
    )
    expect(bodyIndex).toBeGreaterThanOrEqual(0)
    const observer = tracked.observe.mock.contexts[bodyIndex]
    const listeners = tracked.added.mock.calls.filter(
      ([type, , capture]) => ['keydown', 'pointerdown', 'wheel'].includes(type) && capture === true
    )
    expect(listeners).toHaveLength(3)

    // A script navigation emits no moved-on keyboard or pointer event: the
    // effect cleanup must cancel the first wait when this route settles.
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: 'Personnes' }))
    })
    await pass(0)

    // This destination has no heading either. The obsolete observer cannot
    // stop itself by finding the new heading; only effect cleanup cancels it.
    expect(screen.getByText('Aucun titre ici')).toBeInTheDocument()
    expect(tracked.disconnect.mock.contexts).toContain(observer)
    for (const listener of listeners) expect(tracked.removed).toHaveBeenCalledWith(...listener)
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: 'Aide' }))
    })
    await pass(0)
    expect(screen.getByRole('heading', { level: 1, name: 'Aide' })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('Page Aide chargée.')
  })
})
