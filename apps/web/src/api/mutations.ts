// Every write to the Core API goes through here (ADR-0005), so the three things a
// mutation must not forget live in one place: the request media type the contract
// declares, the idempotency key (added by the client middleware), and the optimistic
// concurrency token that every `PATCH` now requires (`docs/api/CONVENTIONS.md` §10).

import { coreApi } from './client'
import type { paths } from './schema'

/** The verbs that write. `PUT` does not exist in this API (CONSOLE_RECONCILIATION §4.6). */
export type MutationMethod = 'post' | 'patch' | 'delete'

type PathsWith<M extends MutationMethod> = {
  [P in keyof paths]: paths[P] extends { [K in M]: unknown } ? P : never
}[keyof paths]

type OperationOf<M extends MutationMethod, P extends PathsWith<M>> = paths[P][M]

type MediaBody<C> = C extends { 'application/json': infer B }
  ? B
  : C extends { 'application/merge-patch+json': infer B }
    ? B
    : C extends { 'multipart/form-data': infer B }
      ? B
      : never

type BodyOf<O> = O extends { requestBody: { content: infer C } }
  ? MediaBody<C>
  : O extends { requestBody?: { content: infer C } | undefined }
    ? MediaBody<C> | undefined
    : undefined

type ParametersOf<O> = O extends { parameters: infer Q } ? Q : never

/**
 * `Idempotency-Key` is the one header parameter this contract declares, and it is
 * `required: true` on all 27 POSTs — so the generated types make every caller pass a
 * key by hand. The client middleware already puts one on every POST, and a key chosen
 * at the call site is a key somebody will eventually reuse, so it is optional here.
 * A caller with a deliberate retry of the same intent may still supply its own.
 */
type LooseHeaders<Q> = Q extends { header: infer H }
  ? Omit<Q, 'header'> & { header?: Partial<H> }
  : Q

type RequiredKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K
}[keyof T]

/** `params` is required exactly when the operation has a parameter that is. */
type ParamsArg<O> =
  RequiredKeys<LooseHeaders<ParametersOf<O>>> extends never
    ? { params?: LooseHeaders<ParametersOf<O>> }
    : { params: LooseHeaders<ParametersOf<O>> }

/** `body` is required exactly when the operation declares one that is not optional. */
type BodyArg<O> = undefined extends BodyOf<O> ? { body?: BodyOf<O> } : { body: BodyOf<O> }

type ResponsesOf<O> = O extends { responses: infer R } ? R : never

type SuccessOf<O> = ResponsesOf<O>[Extract<keyof ResponsesOf<O>, 200 | 201 | 202 | 204>]

/** Every body a success can carry. `undefined` where the contract declares no content. */
type SuccessBody<O> =
  SuccessOf<O> extends { content: { 'application/json': infer B } } ? B : undefined

/**
 * `If-Match` is required on every `PATCH` (`docs/api/CONVENTIONS.md` §10, closed by
 * CONSOLE_RECONCILIATION §5.6): absent, the API answers `428 precondition-required`;
 * stale, `412 precondition-failed` with the current tag to re-read against. A `PATCH`
 * call that omits `concurrency` is a type error here, not a request that reaches the
 * network and comes back refused.
 */
type ConcurrencyArg<M extends MutationMethod> = M extends 'patch'
  ? { concurrency: string }
  : { concurrency?: string }

export type MutateInit<M extends MutationMethod, P extends PathsWith<M>> = ParamsArg<
  OperationOf<M, P>
> &
  BodyArg<OperationOf<M, P>> &
  ConcurrencyArg<M>

export interface MutationOp<M extends MutationMethod, P extends PathsWith<M>> {
  readonly method: M
  readonly path: P
}

/** Whatever was last read, as long as it carries the `ETag` it was read with. */
export interface Concurrent {
  readonly etag: string
}

/**
 * The optimistic-concurrency token for a `PATCH`: the `ETag` of the representation the
 * change was computed against, round-tripped as `If-Match`. There is no other source
 * for it — a value invented by the client is a value that can never match — so this
 * only ever reads it off the entity the caller already has.
 */
export function concurrencyToken(entity: Concurrent): string {
  return entity.etag
}

/** The media type the contract declares for a body, since `PATCH` is merge-patch here. */
function mediaType(method: MutationMethod): string | undefined {
  if (method === 'patch') return 'application/merge-patch+json'
  if (method === 'post') return 'application/json'
  return undefined
}

/**
 * Send a mutation and return its body, throwing `ApiProblem` on a refusal and
 * `NetworkError` when the API cannot be reached.
 */
export async function mutate<M extends MutationMethod, P extends PathsWith<M>>(
  op: MutationOp<M, P>,
  init: MutateInit<M, P>
): Promise<SuccessBody<OperationOf<M, P>>> {
  // `concurrency` is this module's own field, not one openapi-fetch's `request()` knows —
  // spreading the rest of `init` straight into it would otherwise carry it along as a
  // stray property on the fetch init object.
  const { concurrency, ...rest } = init as MutateInit<M, P> & { concurrency?: string }

  const headers: Record<string, string> = {}
  const contentType = mediaType(op.method)
  const body: unknown = (rest as { body?: unknown }).body
  if (contentType !== undefined && body !== undefined) headers['Content-Type'] = contentType
  if (concurrency !== undefined) headers['If-Match'] = concurrency

  // One cast, here: `coreApi().request` is generic over the same path-and-method pair
  // this function is, and TypeScript cannot see that through the indirection. The
  // call site is fully typed by `MutationOp` and `MutateInit`.
  const request = coreApi().request as (
    method: M,
    path: P,
    init: Record<string, unknown>
  ) => Promise<{ data?: unknown; response: Response }>

  const { data } = await request(op.method, op.path, { ...rest, headers })
  return data as SuccessBody<OperationOf<M, P>>
}
