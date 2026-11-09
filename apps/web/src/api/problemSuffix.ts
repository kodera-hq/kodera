// Every area spec's "Error copy rules" section switches on the problem
// type's suffix — "the `type` values below are the registry ... the console
// switches on `type` and never on `title` or `detail`" (docs/specs/
// 00-shell-and-login.md §9) — never on the full `https://kodera.io/
// problems/...` URI written out at each call site. One helper, so every
// screen reads the same suffix off the same closed registry
// (`src/api/generated/problems.ts`) rather than re-deriving or, worse,
// hand-typing the URI.

import type { ProblemType } from './generated/problems'

export function problemSuffix(type: ProblemType): string {
  return type.slice(type.lastIndexOf('/') + 1)
}
