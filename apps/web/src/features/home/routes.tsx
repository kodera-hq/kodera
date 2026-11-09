import { createRoute } from '@tanstack/react-router'
import { orgRoute } from '../../app/org-route'
import { Home } from './Home'

// `/{org}/home` — the default screen of every organisation (docs/specs/
// 00-shell-and-login.md §4.6). Full screen: 08-home.md.
export const homeRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'home',
  component: Home,
})
