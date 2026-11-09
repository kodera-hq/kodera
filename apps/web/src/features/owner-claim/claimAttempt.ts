export interface ClaimAttemptContext {
  readonly issuer: string
  readonly subject: string
  readonly generation: number
  readonly accessToken: string
  readonly organisationId: string
  readonly organisationSlug: string
}

interface ClaimBody {
  readonly token: string
  readonly display_name?: string | null
}

export interface ClaimAttemptRequest {
  readonly idempotencyKey: string
  readonly body: ClaimBody
}

export type ClaimAttemptOutcome =
  | { readonly kind: 'network' }
  | {
      readonly kind: 'response'
      readonly status: number
      readonly problem?: {
        readonly type: string | null
        readonly retryAfterS?: number | undefined
      }
    }

type Status =
  | 'ready'
  | 'sending'
  | 'waiting'
  | 'uncertain'
  | 'refused'
  | 'terminal'
  | 'success-awaiting-owner-read'
  | 'unresolved'

interface Snapshot {
  readonly status: Status
  readonly retryAt?: number
}

interface Input extends ClaimAttemptRequest {
  readonly context: ClaimAttemptContext
}

const problem = (suffix: string) => `https://kodera.io/problems/${suffix}`

/** Owns consume retry intent only; all authentication and ownership authority stays outside. */
class ClaimAttempt {
  #key: string | undefined
  #body: ClaimBody | undefined
  #context: ClaimAttemptContext | undefined
  #request: ClaimAttemptRequest | undefined
  #status: Status = 'ready'
  #retryAt: number | undefined
  #lastTime = -1

  constructor(input: Input) {
    this.#key = input.idempotencyKey
    this.#body = Object.freeze({ ...input.body })
    this.#context = Object.freeze({ ...input.context })
  }

  snapshot(): Snapshot {
    return Object.freeze({
      status: this.#status,
      ...(this.#retryAt === undefined ? {} : { retryAt: this.#retryAt }),
    })
  }

  #active(context: ClaimAttemptContext): boolean {
    const original = this.#context
    if (original === undefined) return false
    if (
      original.issuer !== context.issuer ||
      original.subject !== context.subject ||
      original.generation !== context.generation ||
      original.accessToken !== context.accessToken ||
      original.organisationId !== context.organisationId ||
      original.organisationSlug !== context.organisationSlug
    ) {
      this.retire()
      return false
    }
    return true
  }

  #acceptTime(now: number): boolean {
    if (!Number.isSafeInteger(now) || now < 0 || now < this.#lastTime) return false
    this.#lastTime = now
    return true
  }

  begin(context: ClaimAttemptContext, now: number): ClaimAttemptRequest | undefined {
    if (!this.#active(context) || this.#status === 'sending') return undefined
    if (!this.#acceptTime(now)) return undefined
    if (
      (this.#retryAt !== undefined && now < this.#retryAt) ||
      this.#body === undefined ||
      this.#key === undefined
    )
      return undefined
    this.#retryAt = undefined
    this.#status = 'sending'
    this.#request = Object.freeze({ idempotencyKey: this.#key, body: this.#body })
    return this.#request
  }

  settle(
    request: ClaimAttemptRequest,
    context: ClaimAttemptContext,
    outcome: ClaimAttemptOutcome,
    now: number
  ): boolean {
    if (!this.#active(context)) return false
    if (this.#status !== 'sending' || request !== this.#request) return false
    if (!this.#acceptTime(now)) return false
    this.#request = undefined
    if (outcome.kind === 'network') {
      this.#status = 'uncertain'
      return true
    }
    const { status, problem: refusal } = outcome
    const type = refusal?.type
    const delay = refusal?.retryAfterS
    if (status === 200 && refusal === undefined) {
      this.#finish('success-awaiting-owner-read')
      return true
    }
    if (
      (status === 503 && type === problem('service-unavailable') && delay === 1) ||
      (status === 409 && type === problem('idempotency-key-in-flight'))
    ) {
      const deadline = now + (delay ?? NaN) * 1000
      if (
        delay === undefined ||
        !Number.isSafeInteger(delay) ||
        delay <= 0 ||
        !Number.isSafeInteger(deadline) ||
        deadline <= now
      ) {
        this.retire()
        return false
      }
      this.#retryAt = deadline
      this.#status = 'waiting'
      return true
    }
    if (
      (status === 403 &&
        [
          problem('mfa-required'),
          problem('owner-claim-contact-unverified'),
          problem('owner-claim-identity-mismatch'),
        ].includes(type ?? '')) ||
      (status === 409 && type === problem('idempotency-key-reuse'))
    ) {
      this.#finish('refused')
      return true
    }
    if (
      (status === 410 &&
        [problem('owner-claim-expired'), problem('owner-claim-revoked')].includes(type ?? '')) ||
      (status === 409 && type === problem('owner-claim-consumed'))
    ) {
      this.#finish('terminal')
      return true
    }
    this.#status = 'uncertain'
    return true
  }

  #finish(status: Status): void {
    this.#key = undefined
    this.#body = undefined
    this.#context = undefined
    this.#request = undefined
    this.#retryAt = undefined
    this.#status = status
  }

  retire(): void {
    this.#finish('unresolved')
  }
}

export function createClaimAttempt(input: Input): ClaimAttempt {
  return new ClaimAttempt(input)
}
