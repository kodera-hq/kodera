// docs/specs/00-shell-and-login.md §7: network-layer failure on every
// request — every endpoint answers by aborting the connection, the same
// failure `src/api/client.ts`'s `NetworkError` wraps. Acceptance test 9
// pairs this with the browser's own offline event (Playwright's
// `context.setOffline`); the overlay is what makes an already-open tab's
// IN-FLIGHT and retried requests fail the same way a truly disconnected
// network would, not only the ones a browser-level flag can intercept.

import { http } from 'msw'

const BASE = '*/api/v1'

export const handlers = [http.all(`${BASE}/*`, () => Response.error())]
