import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ConfirmDestructive } from '../../ui/ConfirmDestructive/ConfirmDestructive'

/** The organisation whose workspace `pathname` is (`/{org}/workspace…`), or none. */
function workspaceOf(pathname: string): string | null {
  const [, org, area] = pathname.split('/')
  return area === 'workspace' && org !== undefined && org !== '' ? org : null
}

/**
 * Whether a navigation keeps the Espace view mounted: it stays in the same organisation's
 * workspace, where choosing a channel only changes the address (`src/features/workspace/routes.tsx`).
 * Anything else, another Console page or another organisation, unmounts the view and so ends
 * its call.
 */
export function staysInWorkspace(currentPathname: string, nextPathname: string): boolean {
  const here = workspaceOf(currentPathname)
  return here !== null && workspaceOf(nextPathname) === here
}

/**
 * Asks before a navigation that would end the member's call (`live`): the call belongs to the
 * view, which leaves it when it unmounts. Staying resets the navigation and leaves the call as it
 * is; confirming lets it go on, and the unmount leaves the call. Back, Forward, links and
 * programmatic navigation all go through the router's history, so all of them ask; closing the
 * tab or reloading raises the browser's own prompt instead, while the call is live.
 *
 * Three ways out go through unasked. A redirect from a route's `beforeLoad` or loader (an
 * authentication redirect among them): the router follows it with `ignoreBlocker`. A navigation
 * that unmounts the view in the same commit, such as the layout's `<Navigate to="/login">` on
 * sign-out: there is no screen left to ask from. And a document navigation (`reloadDocument`, or
 * an absolute `href` such as the sign-in): the router hands the blocker the current location as
 * both `current` and `next`, which reads as staying here, and then skips the browser's prompt.
 */
export function LeaveCallGuard({ live }: { live: boolean }) {
  const { t } = useTranslation()
  // The control the member left from, to return to when they stay.
  const opener = useRef<HTMLElement | null>(null)
  // Whether the guard can still draw its question. A layout effect's cleanup runs while React
  // removes the view, before the effects of what replaces it: a `<Navigate>` mounted in the same
  // commit navigates from its own effect, and would otherwise be held by a blocker whose removal
  // (`useBlocker`'s plain effect) comes later, with no dialog to answer it.
  const alive = useRef(false)
  // The answer to a navigation held while the question shows, read when the view goes.
  const pendingReset = useRef<(() => void) | undefined>(undefined)
  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      // Going while it asks, the guard gives the held navigation up: left waiting, it would never
      // finish, and after Back the address would name a page that is not on screen.
      pendingReset.current?.()
    }
  }, [])

  const shouldBlockFn = useCallback(
    ({ current, next }: { current: { pathname: string }; next: { pathname: string } }) => {
      if (!alive.current) return false
      if (staysInWorkspace(current.pathname, next.pathname)) return false
      const focused = document.activeElement
      opener.current = focused instanceof HTMLElement && focused !== document.body ? focused : null
      return true
    },
    []
  )
  const blocker = useBlocker({
    shouldBlockFn,
    disabled: !live,
    enableBeforeUnload: true,
    withResolver: true,
  })

  // The call ended while the question was asked: nothing is left to end, so the question goes.
  // The member stays where they were, and may leave again unasked.
  // `reset` exists only while a navigation waits on the question.
  const { reset } = blocker
  useLayoutEffect(() => {
    pendingReset.current = reset
  }, [reset])
  useEffect(() => {
    if (!live) reset?.()
  }, [live, reset])

  if (blocker.status !== 'blocked') return null
  return (
    <ConfirmDestructive
      defaultOpen
      initialFocus="title"
      returnFocusTo={opener}
      title={t('console.workspace.audio.confirm-leave-title')}
      consequence={t('console.workspace.audio.confirm-leave-body')}
      cancelLabel={t('console.workspace.audio.action-stay')}
      confirmLabel={t('console.workspace.audio.action-confirm-leave')}
      closeLabel={t('console.common.action-close')}
      // Confirming closes the dialog too: `reset` after `proceed` changes nothing, the
      // navigation's answer is already given.
      onConfirm={() => blocker.proceed()}
      onOpenChange={(open) => {
        if (!open) blocker.reset()
      }}
    />
  )
}
