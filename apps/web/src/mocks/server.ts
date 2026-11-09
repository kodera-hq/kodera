// The msw server for unit tests: Node interception, the generated base handlers, and
// nothing hand-written on top. A test that needs a refusal adds an overlay for the
// duration of that test with `server.use(...)` and builds it with `problem()`.

import { setupServer } from 'msw/node'
import { handlers } from './generated/handlers'

export const server = setupServer(...handlers)
