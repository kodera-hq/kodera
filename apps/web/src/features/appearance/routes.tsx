import { createRoute } from '@tanstack/react-router'
import { orgRoute } from '../../app/org-route'
import { AppearanceScreen } from './AppearanceScreen'

// `/{org}/appearance` — « Apparence », the account menu's theme choice in both
// layouts (`src/app/accountItems.ts`). Under the organisation so the shell is
// drawn around it, like « Sécurité et connexion »; the choice itself belongs
// to the browser, not the organisation. Every role has an account, so no
// role gate.
export const appearanceRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'appearance',
  component: AppearanceScreen,
})
