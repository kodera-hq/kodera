// Activates MSW scenario overlays for a spec, by writing the names to
// `sessionStorage['msw:scenarios']` (docs/dev/TESTING.md §2) — read back by
// `src/mocks/browser.ts` when the worker starts. `addInitScript` runs before
// any page script on every navigation the test makes, so this only needs to
// be called once, before the first `page.goto`, for the whole spec.
//
// The callback below runs inside the browser page, not in this file's own
// Node process — `tsconfig.node.json` carries no DOM lib (BASELINE.md: that
// project is "what runs in Node"), so `window` needs this file's own
// reference to type-check the callback body Playwright serialises into the
// page.
/// <reference lib="dom" />

import type { Page } from '@playwright/test'

export async function useScenario(page: Page, scenarios: readonly string[]): Promise<void> {
  await page.addInitScript((names: readonly string[]) => {
    window.sessionStorage.setItem('msw:scenarios', JSON.stringify(names))
  }, scenarios)
}
