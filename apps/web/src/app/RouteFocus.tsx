// What happens after a route change inside the organisation's layout
// (docs/specs/00-shell-and-login.md §10): the page is announced in a polite
// live region, and keyboard focus moves to the page's `h1`. Without it a
// person who follows a navigation link stays on the link, and a screen reader
// says nothing about the page that replaced the one they were reading.
//
// One component, mounted once beside the shell, rather than a heading
// component every screen would have to adopt: it finds the `h1` the screen
// already draws.
//
// - A route change is a change of the path the router has finished loading.
//   The page the layout first shows is not one (the browser announces a page
//   load itself), nor is a redirect on the way to it, nor a change of search
//   parameters or hash.
// - The second-factor guard redirects from an effect, once the layout is
//   mounted, and draws no page until it has. The layout says so
//   (`redirecting`): an address that was never drawn is neither arrived on nor
//   left, so the person it sends to the enrolment guide has arrived there.
// - The announcement is the page's title, which the layout passes. It needs no
//   data, so it is made at once, and a page with no `h1` is still announced.
// - A screen that announces the change itself is not announced a second time:
//   a step of the order wizard is said by the wizard's own region (« Étape 2
//   sur 4 … »), and two regions speaking at once are one too many. Focus moves
//   all the same.
// - The heading is the first `h1` of `main` that a person can see. The order
//   flow keeps its name in a visually hidden `h1` above each step's title;
//   focus there would be focus nobody can see.
// - The `h1` often arrives with the screen's first read. Focus moves when it
//   is there — unless the person has pressed a key, pressed a pointer or
//   scrolled in the meantime: focus is never taken back from someone who has
//   moved on. The wait ends after five seconds whatever happens: a person can
//   move on without any of those three, and a heading that arrives later than
//   that is no longer where they are.
// - A navigation that starts in the account menu or in a sheet closes it, and
//   the menu hands focus back to its own trigger as it goes, one task later.
//   Focus moves to the heading after that, not before, or it would end on the
//   trigger.
// - The heading takes `tabindex="-1"`: a script can focus it, `Tab` never
//   stops on it, and the shell's tab order is unchanged.
// - A change a screen asked to keep focus for (`routeFocusHold.ts`: the
//   workspace's `Alt` and arrow keys) neither moves focus nor is announced:
//   the person is writing, and the screen says where they are.

import { useRouter, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepsFocus, releaseRouteFocus } from './routeFocusHold'

/** What the person does that means "I am somewhere else now". A focus that
 * moves is deliberately not one of them: a closing menu moves focus back to
 * its trigger after the navigation, and the heading must still win. */
const MOVED_ON = ['keydown', 'pointerdown', 'wheel'] as const

/** How long a heading may take to arrive and still take focus. */
const HEADING_WAIT_MS = 5_000

/** The first `h1` of `main` drawn where a person can see it. `sr-only` is the
 * one way this codebase hides text from sight and keeps it for a screen
 * reader. */
function visibleHeading(): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('main h1')).find(
    (heading) => heading.closest('.sr-only') === null
  )
}

function focusHeading(): boolean {
  const heading = visibleHeading()
  if (heading === undefined) return false
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
  // `src/index.css` draws no ring on it: it is where reading resumes, not a
  // control.
  heading.setAttribute('data-route-heading', '')
  heading.focus()
  return true
}

/** Focuses the page's `h1` once anything closing behind the navigation has
 * returned focus, or as soon as the screen draws one, for as long as the wait
 * lasts. Returns what cancels it. */
function focusHeadingWhenDrawn(): () => void {
  const observer = new MutationObserver(() => {
    if (focusHeading()) stop()
  })
  // A closing menu or sheet restores focus to its trigger from a zero-delay
  // timer it set when it closed, which was before this route settled. A
  // zero-delay timer set now runs after that one.
  const timer = window.setTimeout(() => {
    if (focusHeading()) stop()
    else observer.observe(document.body, { childList: true, subtree: true })
  }, 0)
  const end = window.setTimeout(stop, HEADING_WAIT_MS)
  function stop() {
    window.clearTimeout(timer)
    window.clearTimeout(end)
    observer.disconnect()
    for (const type of MOVED_ON) document.removeEventListener(type, stop, true)
  }
  for (const type of MOVED_ON) document.addEventListener(type, stop, true)
  return stop
}

export interface RouteFocusProps {
  /** The current page's title, as a route change announces it. */
  title: string
  /** True for a change, from one path to another, that the screen on both
   * sides of it announces in a live region of its own. Focus still moves;
   * nothing is said here. */
  announcedByScreen?: (from: string, to: string) => boolean
  /** True while the layout draws no page for the current address because it
   * is sending the person elsewhere. Such an address is not a page: it is
   * never the one arrived on, and going through it is no route change. */
  redirecting?: boolean
}

export function RouteFocus({ title, announcedByScreen, redirecting = false }: RouteFocusProps) {
  const { t } = useTranslation()
  const router = useRouter()
  // The path the router has finished loading; `undefined` while a navigation
  // is in flight, when the resolved location is still the page being left.
  const settled = useRouterState({
    select: (state) =>
      state.resolvedLocation?.pathname === state.location.pathname
        ? state.location.pathname
        : undefined,
  })
  // The page already on screen. It starts as the one this layout was opened
  // on, so arriving — a sign-in, a reload, a bookmark — moves nothing; or as
  // none, when the layout opened on an address it is redirecting away from.
  const [shown, setShown] = useState(() =>
    redirecting ? undefined : router.state.location.pathname
  )
  // The number of route changes so far: each one moves focus.
  const [changes, setChanges] = useState(0)
  // `count` is the number of announcements so far. A new one each time, so two
  // pages with one title are two announcements: a region whose text did not
  // change announces nothing.
  const [announcement, setAnnouncement] = useState({ count: 0, text: '' })

  // State adjusted while rendering, not in an effect: the announcement and the
  // page it names are drawn in the same pass. `title` follows the address,
  // which has already changed by the time the route settles.
  if (settled !== undefined && settled !== shown && !redirecting) {
    setShown(settled)
    // With no page shown before it, this one is where the person arrived.
    if (shown !== undefined && !keepsFocus(settled)) {
      setChanges(changes + 1)
      // A change the screen announces itself leaves this region exactly as it
      // is: writing to it, even the same words, would be a second announcement.
      if (announcedByScreen?.(shown, settled) !== true) {
        setAnnouncement({
          count: announcement.count + 1,
          text: t('console.common.a11y-page-loaded', { title }),
        })
      }
    }
  }

  useEffect(() => {
    if (changes === 0) return
    return focusHeadingWhenDrawn()
  }, [changes])

  useEffect(() => {
    if (settled !== undefined) releaseRouteFocus(settled)
  }, [settled])

  return (
    <p role="status" aria-live="polite" className="sr-only">
      {announcement.count === 0 ? null : <span key={announcement.count}>{announcement.text}</span>}
    </p>
  )
}
