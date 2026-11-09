// Signs a spec straight into an organisation through the mock identity
// provider (ADR-0007), the same round trip `tests/e2e/00-smoke.spec.ts`
// drives by hand. Support code, no assertions (docs/dev/TESTING.md §2):
// every spec past the login screens itself needs an authenticated session
// before its own Given, and repeating the click sequence in each one would
// make a change to the mock-idp page a multi-file edit.
/// <reference lib="dom" />

import type { Page } from '@playwright/test'

export async function signIn(page: Page, org: string, path = '/home'): Promise<void> {
  await page.goto(`/${org}${path}`)
  await page.getByRole('button', { name: 'Continuer' }).click()
  await page.waitForURL((url) => url.pathname === new URL(`/${org}${path}`, url.origin).pathname)
}

// The existing home journeys first establish the worker's controlled page.
export async function signInToOrg(page: Page, org: string): Promise<void> {
  await page.goto('/')
  await signIn(page, org)
  await page.waitForURL((url) => url.pathname === `/${org}/home`)
}
