// Which route changes are steps of the order wizard (docs/specs/01-order.md
// §10). The wizard announces each step in its own live region (« Étape 2 sur
// 4 : Organisation. »), so the organisation layout must not announce the page
// as well (`src/app/RouteFocus.tsx`): it asks here.
//
// Read from the address alone — `/{org}/order/{draftId}/{step}`, as
// `routes.tsx` declares it — because the layout decides while the router
// settles, before the step is drawn.

import { ORDER_STEPS } from './draft'

/** The draft and the step an address names, when it is one of the steps the
 * wizard shows. The quote request is not: `OrderWizard` draws it without the
 * wizard, so nothing there would announce it. */
function wizardStep(pathname: string): { wizard: string } | undefined {
  const [, org, area, draftId, step, ...rest] = pathname.split('/')
  if (area !== 'order' || draftId === undefined || step === undefined || rest.length > 0) {
    return undefined
  }
  if (!(ORDER_STEPS as readonly string[]).includes(step)) return undefined
  // One wizard per organisation and draft: `OrderWizard` is keyed on both.
  return { wizard: `${org}/${draftId}` }
}

/** True when `from` and `to` are two steps of one wizard, which stays on
 * screen across the change and announces it. */
export function isOrderStepChange(from: string, to: string): boolean {
  const before = wizardStep(from)
  const after = wizardStep(to)
  return before !== undefined && after !== undefined && before.wizard === after.wizard
}
