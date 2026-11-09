// One incident, one banner (docs/specs/00-shell-and-login.md §4.5). The
// Applications screen draws its own incident banner above its cards
// (02-status.md §4.3), with the detail the shell's slot cannot carry: the
// incident's own next-update time. While that banner is on the page, the
// shell's slot does not announce the same incident a second time; it falls
// through to the next banner in its precedence instead (`./bannerPrecedence.ts`).
//
// A claim names the component the page's banner is about, and the shell yields
// only for that component: if the page and the shell's summary disagree on
// what is affected, the shell keeps its own banner. A claim, not a route check:
// the page banner depends on the tenant status call, not on the URL, and a
// slot that went quiet on `/status` while the page showed nothing would hide
// the incident altogether.

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

interface ClaimContextValue {
  claimed: readonly string[]
  claim: (componentKey: string) => () => void
}

const ClaimContext = createContext<ClaimContextValue | null>(null)

export function IncidentBannerClaimProvider({ children }: { children: ReactNode }) {
  const [claims, setClaims] = useState<ReadonlyMap<string, number>>(new Map())
  // Stable, so a page's claim is taken once and released once, not re-taken
  // every time the set it changed comes back around.
  const claim = useCallback((componentKey: string) => {
    const change = (delta: number) =>
      setClaims((current) => {
        const next = new Map(current)
        const count = (next.get(componentKey) ?? 0) + delta
        if (count > 0) next.set(componentKey, count)
        else next.delete(componentKey)
        return next
      })
    change(1)
    return () => change(-1)
  }, [])
  const claimed = useMemo(() => [...claims.keys()].sort(), [claims])
  const value = useMemo<ClaimContextValue>(() => ({ claimed, claim }), [claimed, claim])
  return <ClaimContext.Provider value={value}>{children}</ClaimContext.Provider>
}

const NONE: readonly string[] = []

/** The components whose incident a page is showing itself; the shell slot reads it. */
export function useIncidentBannerClaims(): readonly string[] {
  return useContext(ClaimContext)?.claimed ?? NONE
}

/** A page calls this with the component its own incident banner names, or
 * `undefined` while it shows none. Outside the shell (a component test, a
 * story) there is no slot to yield, and the call does nothing. Layout effect,
 * so the shell's copy is gone before the page paints rather than one frame
 * after. */
export function useClaimIncidentBanner(componentKey: string | undefined): void {
  const claim = useContext(ClaimContext)?.claim
  useLayoutEffect(() => {
    if (componentKey === undefined || claim === undefined) return
    return claim(componentKey)
  }, [componentKey, claim])
}
