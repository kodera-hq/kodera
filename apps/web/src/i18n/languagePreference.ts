// The language a person chose, for this tab and this tab only.
//
// `sessionStorage`, not `localStorage`, is the governed contract, not an
// oversight: `docs/specs/collective-studio-product.md` states that the choice
// survives the authentication reload (the English login choice used to revert
// to French on the way into the workspace) and that this "does not introduce
// account-level language persistence". Tab-scoped storage is exactly that
// promise — it outlives the redirect, it does not outlive the tab, and it
// leaves nothing about the person on a shared device. Three unit suites hold
// the boundary (`./languagePreference.test.ts`,
// `../features/appearance/AppearanceScreen.test.tsx`,
// `../features/login/CommunityWelcome.test.tsx`), and
// `../auth/legacy-worker.test.ts` lists this key among the few the simulated
// storage wipe must preserve. Moving it to `localStorage` is a product
// decision, not a refactor.
//
// One consequence to carry rather than fix here: Playwright's `storageState`
// saves cookies and `localStorage` and never `sessionStorage`, so a restored
// browser context opens in the default language. A test that wants English
// sets it through the application's own mechanism, in every cell, restored or
// not. `<html lang>` follows the active language either way (`./index.ts`).
export function readLanguagePreference(): 'fr' | 'en' {
  try {
    return sessionStorage.getItem('console:language') === 'en' ? 'en' : 'fr'
  } catch {
    return 'fr'
  }
}
export function keepLanguagePreference(language: 'fr' | 'en'): void {
  try {
    sessionStorage.setItem('console:language', language)
  } catch {
    /* The current page still changes language when storage is unavailable. */
  }
}
