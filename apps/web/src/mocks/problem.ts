// The one hand-written thing in the mocks: a helper that builds an error response.
//
// Base responses are generated (docs/dev/TESTING.md); overlays are the only mock code
// written by hand, and an overlay's job is to make a screen show a refusal. That
// refusal has to be a problem type the contract registers, which is why `type` is
// `ProblemType` and not `string`: an overlay cannot invent an error the API never
// emits and the message catalogue has no key for.

import { HttpResponse } from 'msw/http'
import { PROBLEM_STATUS, PROBLEM_TITLES, type ProblemType } from './generated/problems'

export interface ProblemFieldError {
  pointer: string
  code: string
  detail?: string
}

export interface ProblemInit {
  /** Staff-facing prose. Never rendered to a customer; useful in a test failure. */
  detail?: string
  /** Path of the failing request, as the contract's `instance` member. */
  instance?: string
  /** Field errors, on `validation-failed`. */
  errors?: ProblemFieldError[]
  /** The states in which the operation would have succeeded, on the conflict types. */
  allowedStates?: string[]
  /** Seconds to wait, on `rate-limited`, `service-unavailable` and `upstream-unavailable`. */
  retryAfterS?: number
  /** The tag to re-read against, on `precondition-failed`. */
  currentEtag?: string
  /** `slug-taken`: up to three free tenant slugs. */
  suggestions?: string[]
}

export function problem(type: ProblemType, init: ProblemInit = {}): Response {
  const status = PROBLEM_STATUS[type]
  const requestId = crypto.randomUUID()

  const body: Record<string, unknown> = {
    type,
    title: PROBLEM_TITLES[type],
    status,
    request_id: requestId,
  }
  if (init.detail !== undefined) body['detail'] = init.detail
  if (init.instance !== undefined) body['instance'] = init.instance
  if (init.errors !== undefined) body['errors'] = init.errors
  if (init.allowedStates !== undefined) body['allowed_states'] = init.allowedStates
  if (init.retryAfterS !== undefined) body['retry_after_s'] = init.retryAfterS
  if (init.currentEtag !== undefined) body['current_etag'] = init.currentEtag
  if (init.suggestions !== undefined) body['suggestions'] = init.suggestions

  const headers: Record<string, string> = {
    'Content-Type': 'application/problem+json',
    'X-Request-Id': requestId,
  }
  if (init.retryAfterS !== undefined) headers['Retry-After'] = String(init.retryAfterS)
  // The contract carries `ETag` on `PreconditionFailed` alongside the body's
  // `current_etag`, so a caller re-reading the resource finds the same tag either way.
  if (init.currentEtag !== undefined) headers['ETag'] = init.currentEtag

  return HttpResponse.json(body, { status, headers })
}
