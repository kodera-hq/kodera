# Core API conventions

**Status:** Proposed · **Owner:** API seat

Normative rules for every endpoint of the Core API. A reviewer checks a pull request against this document; a rule that cannot be checked mechanically names the test that checks it. The API is consumed by `kodera-web` and by staff tooling only (console ADR-0003); the Agent API is a separate contract with its own conventions (§14).

**Local diagnostic exception.** The bootstrap's `/health/live` and
`/health/ready` are unauthenticated local operational probes governed by
[`RUNTIME_BOOTSTRAP.md`](../dev/RUNTIME_BOOTSTRAP.md). They return only its fixed
minimal health objects, without environment or exception details. They are
outside the `/api/v1/` business OpenAPI, request-ID and problem-body machinery;
no business endpoint's authentication, request-ID or contract requirement is
waived. These local probes do not establish a customer-ready API.

## 1. Resources and URLs

- Base path: `/api/v1/`. The version is in the URL, never in a header, never in a query parameter.
- Resources are plural nouns in `kebab-case`: `/api/v1/organisations`, `/api/v1/payment-links`, `/api/v1/tenant-releases`.
- Identifiers in paths are UUIDv7 values (§4) or, where a stable human key exists, the slug: `/api/v1/tenants/{tenant_slug}`. A resource exposes exactly one addressing scheme.
- Nesting is one level deep at most, and only when the child cannot exist without the parent: `/api/v1/tenants/{slug}/domains`, `/api/v1/invoices/{id}/lines`. Anything deeper is a top-level resource with a filter.
- Actions that are not CRUD are sub-resources in the imperative, `POST` only: `POST /api/v1/tenants/{slug}/actions/suspend`, `POST /api/v1/domains/{id}/actions/verify`. They MUST create a `Job` and return it (§7).
- No verbs anywhere else in a path. No `/api/v1/getTenant`, no `?action=`.

| Method | Meaning | Body | Idempotent |
|---|---|---|---|
| `GET` | Read a collection or a resource | none | yes |
| `POST` | Create, or run an action sub-resource | full representation or action payload | via `Idempotency-Key` (§8) |
| `PATCH` | Partial update | changed fields only | via `If-Match` (§10) |
| `DELETE` | Soft-delete (`deleted_at` set, `purge_after` computed) | none | yes |

`PUT` is not used. Replacement semantics are a `PATCH` with every field.

`POST /api/v1/auth/discover` (`discoverRealm`) is the named read-only lookup exception: it
creates no business resource or job. Its required compatibility key is validated and discarded;
every request reads current authority independently. See §8, §11 and
[`REALM_DISCOVERY.md`](../specs/REALM_DISCOVERY.md).

`POST /api/v1/invitations/preview` (`previewInvitation`) is the second: a read of the invitation
card, sent as a `POST` only so that the invitation token travels in a body rather than a URL. It
writes nothing and takes no `Idempotency-Key` (§8,
[`INVITATIONS.md`](../specs/INVITATIONS.md) §3).

## 2. Representations

- JSON only. `Content-Type: application/json; charset=utf-8`. Request bodies with another media type are rejected `415`.
- Field names are `snake_case`. Enum values are `snake_case` strings, never integers.
- Booleans are named for the true state: `is_active`, `mfa_required`. Never `disabled`, never a nullable boolean.
- Unknown fields in a request body are rejected `422` with `type: .../validation-error` and a `errors[].pointer`. Silent ignoring is forbidden.
- Every resource carries `id`, `created_at`, `updated_at`. Mutable resources also carry `etag` (§10).
- Collections are always wrapped: `{"data": [...], "next_cursor": "…", "has_more": false}`. A bare JSON array is never returned.
- `null` means "absent"; an omitted key in a `PATCH` means "unchanged". A `PATCH` clearing a field sends `null` explicitly.

## 3. Time

- Except for caller_assurance.enrollment_window.evaluated_at_ms and valid_before_ms, every payload timestamp is RFC 3339 with an explicit `Z` offset, in UTC, with second or millisecond precision. Those two version1 coordinates alone use nonnegative integer milliseconds at most 9007199254740991 on the declared Core time axis; they convey no qualified browser deadline, renewed duration or clock-evidence guarantee.
- Local time never appears in a payload. A wall-clock policy field such as a maintenance window carries its IANA zone as a separate field: `{"maintenance_window": "TUE 07:00-09:00", "maintenance_timezone": "Europe/Paris"}`.
- Durations are integer seconds in a field suffixed `_s`; ages likewise (`backup_age_s`). ISO 8601 durations are not used.
- Dates without a time (invoice period bounds, VAT points) are `YYYY-MM-DD` in fields suffixed `_date`.

## 4. Identifiers

- Primary keys are server-generated UUIDv7 values, stored in PostgreSQL's native
  `uuid` type and rendered in the canonical 36-character lower-case form. They
  are opaque identifiers, not timestamps or authorisation controls (ADR-0009).
  Sequential integers are never exposed.
- An organisation slug matches `^[a-z0-9]([a-z0-9-]{3,18}[a-z0-9])$`: 5–20 lower-case ASCII letters, digits and inner hyphens, first and last alphanumeric. It is the organisation's Keycloak realm name (ADR-0006), so the constraint is a database check (`organisation_slug_valid`), not a serializer rule.
- A tenant slug matches `^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$`: 3–32 characters, a valid DNS label. It is simultaneously the tenant's DNS label and its Scaleway project name.
- Both rules are the owner's. The organisation minimum of five is the owner's answer (decision register row SLUG-MIN-ANSWER in `design specification`), superseding the technical lead's own call of two (register row SLUG-MIN); the tenant rule of 3–32 is owner-confirmed (register row TENANT-SLUG).
- The contract spells both patterns with the absolute end assertion `(?![\s\S])` in place of `$`: JSON Schema matches a pattern by search, and `$` also matches before a final newline.
- Audit and cross-service references use the URN form defined in [`../domain/AUDIT_TAXONOMY.md`](../domain/AUDIT_TAXONOMY.md): `urn:kodera:<type>:<id>`.

## 5. Money

- A monetary amount is always two fields: an integer in the currency's minor units, and an ISO 4217 code.

```json
{"amount_minor": 79000, "currency": "EUR"}
```

- `790.00 EUR` is `79000`. Floats are forbidden in every layer: serializer, database column (`BIGINT`), and client. A pull request introducing a `FloatField` or a `DecimalField` for money is rejected.
- Percentages that are exact by definition (VAT rate, discount) are integer basis points: `vat_rate_bp: 2000` is 20 %, `discount_bp: 1000` is −10 %.
- Every amount-bearing object states whether it is inclusive or exclusive of tax in its field name: `subtotal_excl_tax_minor`, `tax_minor`, `total_incl_tax_minor`. There is no ambiguous `amount` on an invoice.

## 6. Errors

Every non-2xx response is `application/problem+json` (RFC 9457). The `type` registry is **closed**: a new value is a pull request that adds a row to the table below and to `contracts/core-api.openapi.yaml`. A response whose `type` is not in the registry fails the contract test.

```json
{
  "type": "https://kodera.io/problems/idempotency-key-reuse",
  "title": "Idempotency key reused with a different body",
  "status": 409,
  "detail": "Key 8f2b… was first used with a different request body.",
  "instance": "/api/v1/tenants",
  "request_id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
}
```

`type` is an absolute URI under `https://kodera.io/problems/`. `title` is a stable, human-readable string in English; the console never displays it and never parses it — it switches on `type` and renders its own French copy. Extension members are documented per type below.

| `type` suffix | Status | When | Extension members |
|---|---|---|---|
| `validation-error` | 422 | Body failed schema or business validation | `errors[]: {pointer, code, detail}` |
| `malformed-request` | 400 | Unparseable JSON, wrong media type, bad query parameter, an `Idempotency-Key` outside §8's rule | `errors[]`, except for a bad header, which no body pointer can name |
| `unauthenticated` | 401 | No token, expired token, unverifiable signature | `www_authenticate_reason` |
| `mfa-required` | 403 | A token whose `amr` carries no second factor, on a write the API re-asserts it for: every staff write ([`AUTHZ.md`](AUTHZ.md) §3) and `consumeOwnerClaim` (§4) | `required_amr[]` |
| `forbidden` | 403 | Authenticated but the role or scope does not allow it | `required_scope`, `resource` |
| `identity-unknown` | 403 | A customer token that verifies ([`AUTHZ.md`](AUTHZ.md) §2, steps 1–5) but whose `(iss, sub)` names no enabled, undeleted customer identity of an enabled, undeleted person (step 6); no `WWW-Authenticate`, since signing in again cannot help | — |
| `not-found` | 404 | Resource absent, or present but invisible to this principal | — |
| `method-not-allowed` | 405 | Method not defined on the path | `allowed[]` |
| `conflict` | 409 | Generic state conflict (see the specific types below first) | `reason` |
| `slug-taken` | 409 | The staff intake asked for a slug an organisation already holds, or one a concurrent intake reserved first (`createOrganisation`); or an order or `createTenant` asked for a slug a tenant holds or held | `suggestions[]` (`createTenant` only) |
| `order-in-progress` | 409 | `placeOrder` for an organisation that has an order `placed` or `awaiting_payment` (one order in flight per organisation) | — |
| `invoice-issued` | 409 | `cancelOrder` on an order whose invoice has a payment received or a debit still settling: only a partial credit with a refund corrects it | — |
| `billing-disabled` | 409 | `placeOrder` or `createPaymentLink` on a deployment that does not bill (`KODERA_BILLING_ENABLED=false`, [`../specs/QUICK_WORKSPACE.md`](../specs/QUICK_WORKSPACE.md) §2.2); never stored against the key | — |
| `billing-enabled` | 409 | `createTenant` on a deployment that bills ([`../specs/QUICK_WORKSPACE.md`](../specs/QUICK_WORKSPACE.md) §4); never stored against the key | — |
| `tenant-exists` | 409 | `createTenant` for an organisation that already holds a tenant that is not `deleted` (one workspace per organisation on a deployment that does not bill) | — |
| `idempotency-key-missing` | 400 | A `POST` that takes `Idempotency-Key` sent without it (§8) | — |
| `idempotency-key-reuse` | 409 | Same `Idempotency-Key`, different body hash (§8) | `first_seen_at` |
| `idempotency-key-in-flight` | 409 | Same key, request still running (§8) | `retry_after_s` |
| `precondition-failed` | 412 | `If-Match` did not match the current ETag (§10) | `current_etag` |
| `precondition-required` | 428 | `PATCH` without `If-Match` (§10) | — |
| `payload-too-large` | 413 | Body over the endpoint's limit | `limit_bytes` |
| `unsupported-media-type` | 415 | Not `application/json` | `supported[]` |
| `rate-limited` | 429 | Bucket exhausted (§11) | `scope`, `limit`, `reset_at` |
| `invalid-state-transition` | 409 | The transition is not in the state machine's allowed table | `from`, `to`, `allowed[]` |
| `tenant-locked` | 409 | A job holds the tenant's advisory lock | `job_id`, `retry_after_s` |
| `quota-exceeded` | 409 | Plan, capacity tier, or Scaleway quota would be exceeded | `quota`, `limit`, `current` |
| `domain-verification-failed` | 409 | A domain check failed; see the domain state machine | `check`, `observed`, `expected` |
| `domain-state-conflict` | 409 | The domain is not in a state that allows the operation ([`../domain/DOMAIN_STATE_MACHINE.md`](../domain/DOMAIN_STATE_MACHINE.md)) | `state`, `allowed[]` |
| `last-owner-protected` | 409 | The last `org_owner` of an organisation would be removed or demoted (`AUTHZ.md` §4) | `organisation_id` |
| `owner-claim-expired` | 410 | An owner claim presented after its `expires_at` (`AUTHZ.md` §4, `bootstrap`) | `organisation_id` |
| `owner-claim-revoked` | 410 | An owner claim presented after its revocation | `organisation_id` |
| `invitation-expired` | 410 | An invitation accepted or resent after its `expires_at` ([`../specs/INVITATIONS.md`](../specs/INVITATIONS.md) §3) | — |
| `invitation-revoked` | 410 | An invitation accepted or resent after an administrator revoked it | — |
| `owner-claim-consumed` | 409 | An owner claim presented after its consumption, other than as a replay of the consuming request (§8) | `organisation_id` |
| `owner-claim-identity-mismatch` | 403 | An owner claim of the caller's organisation bound to another identity of the same realm; the declared `403`-over-`404` case of `AUTHZ.md` §6 | `organisation_id` |
| `owner-claim-contact-unverified` | 403 | The claimant's contact in the realm is not verified | `organisation_id` |
| `payment-required` | 402 | Organisation suspended for non-payment (billing dunning) | `invoice_id`, `suspended_at` |
| `subscription-required` | 402 | The action needs an active subscription the organisation lacks | `required_plan` |
| `dpa-not-accepted` | 409 | Provisioning attempted before a `DpaAcceptance` exists | `dpa_version` |
| `not-implemented` | 501 | Declared in the contract, not yet built | `tracking` |
| `upstream-unavailable` | 502 | A third party this operation depends on (billing, payment, helpdesk) did not answer | `upstream`, `retry_after_s` |
| `service-unavailable` | 503 | Dependency down, or maintenance | `retry_after_s` |
| `intake-closed` | 503 | This database does not admit the staff intake yet: its identity and mail cutover is not declared final ([`../specs/FIRST_OWNER_BOOTSTRAP.md`](../specs/FIRST_OWNER_BOOTSTRAP.md) §3.8). Answered before the `Idempotency-Key` is read, and not stored | — |
| `internal-error` | 500 | Unhandled | — |

Rules:

- `500` bodies carry `request_id` and nothing else. No stack trace, no exception message, no SQL.
- A `403` and a `404` must not let an unauthorised caller distinguish "does not exist" from "not yours": object-level rules in [`AUTHZ.md`](AUTHZ.md) §6 decide which is returned, and the choice is per resource, not per request.
- Validation `pointer` is a JSON Pointer into the request body (`/contacts/0/email`), never a Django field path.

## 7. Asynchronous work

Any request that mutates infrastructure returns `202 Accepted` with the `Job` representation and a `Location` header pointing at it, in the same transaction that wrote the desired state and the audit row (ADR-0004).

```
HTTP/1.1 202 Accepted
Location: /api/v1/jobs/019467a3-0f9c-7da4-a8d3-2ab59f39a673
Content-Type: application/json
```

```json
{"data": {"id": "019467a3-0f9c-7da4-a8d3-2ab59f39a673", "kind": "provision", "status": "queued",
          "tenant_slug": "acme", "created_at": "current baselineT09:30:00Z"}}
```

The console polls `GET /api/v1/jobs/{id}`. Job kinds, steps and terminal states are in [`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md). A `200` from a mutating endpoint means nothing was enqueued.

## 8. Idempotency

Every `POST` — creations and action sub-resources alike — MUST carry `Idempotency-Key`, except `previewInvitation`, a read (below). A `POST` that takes the key and arrives without it is rejected `400 idempotency-key-missing`. `GET`, `PATCH` and `DELETE` MUST NOT carry it.

**Discovery-only exception.** `discoverRealm` requires the dedicated `DiscoveryCompatibilityKey`
parameter: 16–255 printable ASCII characters, with no surrounding whitespace. Missing is
`400 idempotency-key-missing`; invalid is `400 malformed-request`. Validate then discard.
Identical, changed-body and concurrent same-key requests independently consume quotas and
select current data. Persist no key, key digest, body fingerprint, response or in-flight state;
use no key lock, replay header or idempotency conflict. No anonymous replay namespace exists.

**Invitation preview exception.** `previewInvitation` takes no `Idempotency-Key`: it is a read,
so there is no side effect to make safe to retry, and a stored response would keep a card readable
after its invitation was revoked. A key sent anyway is ignored, never stored, and never answered
`Idempotency-Replayed` or `idempotency-key-reuse`.

The following generic replay rules continue to apply to every other `POST`:

- The key is a client-generated string of 16 to 255 visible ASCII characters (`0x21`–`0x7E`), unique per logical operation. A UUIDv4 is expected. A missing or empty key is `400 idempotency-key-missing`; any other value outside this rule is `400 malformed-request`, without `errors[]`. The contract carries the rule as the `IdempotencyKey` parameter's `pattern`.
- The server stores `(principal, method, path, key) → (body_sha256, status, response_body, created_at)` for **24 hours**.
- Same key, same `body_sha256`: the stored response is replayed byte for byte, with `Idempotency-Replayed: true`, whatever its status. The side effect does not happen twice. The contract declares the header (`components.headers.IdempotencyReplayed`) on every response a keyed `POST` can replay: its `2xx` and its `4xx` other than `401` and `429`.
- Same key, different `body_sha256`: `409 idempotency-key-reuse`, with `first_seen_at`, when the stored entry was first recorded, in UTC to the millisecond.
- Same key, first request still in flight: `409 idempotency-key-in-flight` with `retry_after_s`.
- The body hash covers the raw request bytes after removing insignificant whitespace, not the parsed object.
- The replay cache is keyed per principal, so two organisations cannot collide, and it is scoped per path, so the same key on two endpoints is two operations.
- `Job.idempotency_key` is derived from the request key, not equal to it: `sha256` over the canonical JSON array `[principal_urn, method, path, kind, request_key, n]` — `json.dumps(…, separators=(",", ":"), ensure_ascii=True)` — where `n` is the job's position, from 0, among the jobs of the same kind that request creates, in the handler's enqueue order, which MUST be a deterministic function of the request ([`../specs/JOB_QUEUE.md`](../specs/JOB_QUEUE.md) §3.4, which also derives sub-job, compensation and scheduled keys the same way). A JSON array is used rather than a `":"`-joined string because a principal, a path or a client key may contain the delimiter, so two different requests could join to one string. The method and path are in it because the stored response is keyed on them too, so one client key sent to two endpoints never yields the same job. This keeps the queue's unique constraint independent of client key formats, and it means the job row carries a digest rather than anything the caller supplied verbatim.
- `createOrganisation` exposes that durable `realm_create` key as `X-Operation-Ref` on its
  committed `201`, every replay of that success and its `idempotency-key-in-flight` refusal. The
  header is exactly 64 lower-case hexadecimal characters. It is deterministic correlation, not
  proof that the transaction committed, not a resource URL or authorization capability, and no
  lookup by it exists. Authentication, authorization and the intake gate precede derivation. The
  in-flight outcome precedes body comparison, so even a malformed, invalid or changed-body
  contender carries its own prospective reference while the same key is locked; an executed or
  replayed `400`/`422`, key reuse, slug conflict or `5xx` never carries it.
- **The key is generated by the client, one per logical operation**, and the OpenAPI parameter says so machine-readably with `x-kodera-client-generated: true`. A code generator that honours the extension emits a key per request; one that ignores it still sees a required header, which is what the wire needs. Without the marker, every generated call site of a `POST` that takes the key carries a mandatory key argument that no caller should be choosing. The extension changes no wire behaviour, and it is the third and last of the `x-kodera-*` endpoint extensions — the other two are in [`AUTHZ.md`](AUTHZ.md) §5.

## 9. Request correlation

- Every request carries `X-Request-Id`. A client-supplied one matching `^[A-Za-z0-9_-]{8,62}$` is kept under the `c-` namespace (`c-` and the value), so it never passes for an id the server generated, and is not unique, so it never identifies one request on its own; any other value is replaced by a server-generated UUIDv7 ([`../specs/TRUSTED_EDGE.md`](../specs/TRUSTED_EDGE.md) §3). The resulting value is echoed on every response, including errors, and appears in `request_id` on every problem body, every log line and every `AuditEvent`.
- A client-supplied value is never trusted for anything but correlation: it is not used as an idempotency key and never reaches a database index used for authorisation.
- `X-Job-Id` is set on responses that created or advanced a job.

## 10. Concurrency control

- Every mutable resource returns a strong `ETag` computed from `sha256` of the canonical serialisation of the resource's authoritative fields plus its `updated_at`.
- `PATCH` MUST carry `If-Match`. Without it: `428 precondition-required`. With a stale value: `412 precondition-failed` carrying `current_etag`.
- `GET` supports `If-None-Match` and returns `304` with no body.
- `DELETE` MAY carry `If-Match`; when present it is enforced.
- Collections do not carry an ETag.
- The computed customer `GET /me` projection is a scoped exception: its strong ETag hashes the complete canonical response only, without hidden update timestamps. UTF-8 JSON uses sorted object keys, compact separators and unescaped Unicode; identity arrays sort by `id` and organisation entries by `membership_id`. Current authentication, authorization and a coherent projection precede conditional matching. All responses are `no-store`; a revoked grant cannot produce `304`. Other mutable-resource tags retain the timestamp rule.

## 11. Rate limits

Except for `discoverRealm`, whose complete route-local policy follows below, three independent
buckets apply to every request; the first exhausted bucket wins. Limits are per rolling minute unless stated.

| Bucket | Key | Default | Notes |
|---|---|---|---|
| Token | `sub` + `iss` | 600 req/min | The authenticated principal |
| Organisation | `Organisation.id` | 3 000 req/min | Shared by all that organisation's principals |
| IP | client IP from the trusted proxy header | 300 req/min | Applies before authentication |
| Mutation | principal, `POST`/`PATCH`/`DELETE` only | 60 req/min | Protects the job queue |
| Job creation | `Organisation.id`, action sub-resources | 20 req/min, 200 req/day | Protects the worker fleet |
| Unauthenticated | IP | 30 req/min | Login-adjacent and public endpoints |

Every response carries `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds) for the tightest bucket. A `429` carries `Retry-After` in seconds and a `rate-limited` problem body naming the `scope`. Staff principals have their own, higher, table; agent principals are limited per tenant and are exempt from the IP bucket (a tenant VM has one address).

Client IP is taken from the rightmost untrusted hop of `X-Forwarded-For` as computed against the configured proxy list (`KODERA_TRUSTED_EDGE_ADDRESSES`, read only when the direct peer is in it), by `core/api/edge.py`'s `client_address` alone ([`../specs/TRUSTED_EDGE.md`](../specs/TRUSTED_EDGE.md) §2). A pull request that reads `X-Forwarded-For` directly is rejected.

### Discovery-only rate and input policy

`discoverRealm` uses shared database rolling 60-second budgets: 30/IP, 60/canonical slug,
300/exact email domain and 600/global. Charge global/IP before parsing, valid-value buckets
before lookup, including repeated compatibility keys. The client is the direct connection peer or,
when that peer is a configured trusted edge, the rightmost untrusted `X-Forwarded-For` hop
([`../specs/TRUSTED_EDGE.md`](../specs/TRUSTED_EDGE.md) §2); normalize IPv4-mapped addresses and use
full IPv6. With no trusted edge configured, forwarded-IP headers are ignored and every client behind
a proxy shares the proxy's bucket.

Enforce 4096 received body bytes before JSON parsing (`413`), JSON media type (`415`), malformed
or duplicate-key JSON (`400`), and exactly one known string slug/email with the approved ASCII
schema (`422`). Lowercase only the email domain, discard its local part before lookup, quota-key
creation or logging. No membership email or bearer token influences discovery selection.

Every response is correlated and `Cache-Control: no-store`. Quota headers describe the tightest
evaluated bucket only; omit them when prerequisites fail before evaluation. `429` uses the actual
controlling-stage wait rounded up, at least one second, equal in `Retry-After` and `retry_after_s`.
Route-local dependency/configuration/database failures return `503` with five-second backoff,
not a recovery promise. The dedicated 32-byte HMAC key must be valid before state or lookup;
never fall back to raw/unkeyed values. Limiter and selection each have a two-second database budget.
An uncertain quota commit cannot produce a successful uncharged lookup.

Retain only short-lived quota events, never request keys or responses. Events leave the window
at 60 seconds; healthy cleanup removes them within another 120 seconds. A 10000 retained-event
cap fails closed without evicting live counts. Refused exhausted requests allocate no new events.
The spec defines authoritative writers, privacy and runtime concurrency acceptance; these limits
are policy, not measured capacity.

## 12. Pagination, filtering, sorting

**Cursor pagination only.** Offset pagination is not offered on any endpoint.

```
GET /api/v1/tenants?limit=50&cursor=eyJvIjoiMDFKQks3…
```

```json
{"data": [ … ], "next_cursor": "eyJvIjoiMDFKQks3…", "has_more": true}
```

- `limit`: 1–200, default 50. Above the maximum: `422`.
- `cursor`: opaque, base64url of a signed payload holding the sort key and the tiebreaker `id`. Clients MUST NOT construct or parse it. An unparseable or expired cursor is `400 malformed-request`.
- `next_cursor` is `null` on the last page. The absence of a cursor never means "retry".
- `has_more` is the field a client loops on. A page may be short without being the last one — a filter applied after the fetch, a row that disappeared — so "stop when `data` is short" is a bug and "stop when `has_more` is `false`" is not. This is why the envelope carries a boolean beside the cursor rather than the cursor alone.
- A cursor is only valid together with the `sort` and filters it was issued for; changing either while paging is `400`.
- Total counts are not returned. An endpoint needing one exposes a separate `.../count` sub-resource with its own rate limit.

**Filtering.** Filters are query parameters named after the field, with an optional operator suffix:

| Form | Example | Meaning |
|---|---|---|
| `field=value` | `status=active` | equality |
| `field__in=a,b` | `status__in=active,suspended` | set membership, at most 20 values |
| `field__gte=`, `field__lte=` | `created_at__gte=current baselineT00:00:00Z` | range, timestamps and integers only |
| `field__contains=` | `name__contains=alliance` | case-insensitive substring, allow-listed fields only |
| `q=` | `q=acme` | free-text search over an endpoint-declared field set |

Only fields declared filterable in the OpenAPI file may be filtered; an unknown parameter is `422`, never ignored. Filters combine with AND. There is no OR syntax and no filter expression language.

**Sorting.** `sort=field` ascending, `sort=-field` descending, at most two comma-separated keys, allow-listed per endpoint. The default sort is `-created_at`. Every sort implicitly appends `id` as a tiebreaker so cursors are stable.

## 13. Deprecation

An endpoint, field, or enum value being retired carries, for at least one minor release before removal:

```
Deprecation: true
Sunset: Wed, 30 Jun 2027 23:59:59 GMT
Link: <https://kodera.io/docs/api/changelog#tenants-tier>; rel="deprecation"
```

- `Deprecation` and `Sunset` follow RFC 9745 and RFC 8594; `Sunset` is an HTTP-date, the only place in the API where a non-RFC-3339 time appears other than the two enrollment-window coordinates explicitly named in §3.
- The OpenAPI file marks the operation or schema `deprecated: true` in the same pull request.
- A deprecated field keeps working until the sunset; it is never emptied early.
- Removing anything without a preceding deprecated release is a breaking change: under §15 it needs the `contract:breaking` label and the version increase the policy requires. Nothing in CI checks that a deprecated release preceded it.

## 14. Headers, summary

| Header | Direction | Required | Notes |
|---|---|---|---|
| `Authorization: Bearer <jwt>` | request | yes, except public endpoints | Verified per [`AUTHZ.md`](AUTHZ.md) |
| `Idempotency-Key` | request | on every `POST` but `previewInvitation` | §8 |
| `If-Match` | request | on every `PATCH` | §10 |
| `If-None-Match` | request | optional on `GET` | §10 |
| `X-Request-Id` | both | generated when absent | §9 |
| `Idempotency-Replayed` | response | on a replay | §8 |
| `X-Operation-Ref` | response | bounded `createOrganisation` outcomes | §8 |
| `ETag` | response | on every single-resource response | §10 |
| `Location` | response | on `201` and `202` | §7 |
| `RateLimit-*`, `Retry-After` | response | always / on `429` and `503` | §11 |
| `Deprecation`, `Sunset`, `Link` | response | while deprecated | §13 |

The Agent API (`/agent/v1/`) shares §2, §3, §5 and §9, replaces §8 with `command_id` idempotency, and has its own authenticator ([`AUTHZ.md`](AUTHZ.md) §7). It is not versioned in step with the Core API.

**It shares the RFC 9457 *shape* of §6 but not the registry.** `contracts/agent-api.openapi.yaml` carries its own closed registry under `https://kodera.io/problems/agent/`, of eleven types:

| Agent `type` | Status | When |
|---|---|---|
| `agent/validation-failed` | 400 | Body does not match the schema |
| `agent/unauthenticated` | 401 | Absent, expired or revoked credential |
| `agent/instance-mismatch` | 403 | The body names an instance the credential does not own |
| `agent/instance-decommissioned` | 403 | The tenant is gone; stop and do not retry |
| `agent/not-found` | 404 | No such command or reference for this instance |
| `agent/seq-regression` | 409 | `seq` below one already accepted for the same `boot_id` ([`AUTHZ.md`](AUTHZ.md) §7) |
| `agent/command-already-terminal` | 409 | A different terminal result is already recorded |
| `agent/config-ref-expired` | 410 | The reference expired, or its command finished |
| `agent/error-code-required` | 422 | `failed` reported without an `error_code` |
| `agent/rate-limited` | 429 | Too many requests |
| `agent/internal-error` | 500 | Unhandled failure |

The namespace is deliberate, not an oversight. The two APIs have different clients: the console is a browser application that maps every `type` to a French message key, the agent is a daemon that switches on a short list and retries or stops. Making the agent carry the Core registry's 29 members would give it 20 it can never emit and no way to express `instance-mismatch`, and putting its eleven into §6 would put agent conditions in front of the console.

Where the two name the same condition they use the same word, with one exception: `agent/validation-failed` sits at `400` and covers what §6 splits into `malformed-request` (400) and `validation-error` (422). That split exists because the Core API has business rules that reject a well-formed body; the agent has one body shape per endpoint and no business rules, so one code is the whole truth there. Both registries are closed, and adding a member to either is a pull request against that registry's own table.

## 15. OpenAPI-first workflow

1. `contracts/core-api.openapi.yaml` is **hand-authored and committed**. It is the contract, not an artefact.
2. Implementation follows the file. Serializers, view schemas and enums are written to match it.
3. CI runs the breaking-change gate on every pull request and every push to `main`: `oasdiff` classifies the change between a pull request's merge-base and its head, and the version policy fails a breaking change without the `contract:breaking` label and the version increase `contracts/README.md` §Versioning requires. The rules are in `docs/specs/CONTRACT_VERSION_POLICY.md`.
4. The other gates this workflow is owed are not wired: a specification generated from the running application and diffed against the committed file, `schemathesis` against a live test instance, and publishing the specification with a generated TypeScript client and mock handlers. `contracts/README.md` §Target contract pipeline lists them and says which run.

Checklist a reviewer applies to any endpoint pull request:

- [ ] Path is a plural noun or an `actions/<verb>` sub-resource; nesting at most one level.
- [ ] `snake_case` fields; timestamps RFC 3339 UTC except only the two named version1 enrollment-window coordinates in §3; Sunset remains the §13 HTTP-date exception; money as `*_minor` plus `currency`.
- [ ] Every error path returns a registered problem `type`; no new type without a registry row.
- [ ] `POST` requires `Idempotency-Key` (`previewInvitation` excepted, §8); `PATCH` requires `If-Match`; both are tested.
- [ ] Collection endpoint is cursor-paginated, with declared filter and sort allow-lists.
- [ ] Infrastructure mutation returns `202` with a `Job`, committed in one transaction with the audit row.
- [ ] `contracts/core-api.openapi.yaml` updated in the same pull request, with the version increase and label the `contract-change` job requires.

## Changelog

- First version. Fixes assessment item C1: REST shape, `/api/v1/` URL versioning, RFC 9457 with a closed type registry, cursor pagination, mandatory `Idempotency-Key` with a 24-hour replay cache, `X-Request-Id`, ETag concurrency, layered rate limits, deprecation headers, and the OpenAPI-first CI gates.
- Reconciles with `contracts/core-api.openapi.yaml`: the collection envelope becomes `{data, next_cursor, has_more}` — the contract's shape, kept because `has_more` is what a client can safely loop on and a short page is not a last page; five problem types the contract needed join the closed §6 registry (`mfa-required`, `idempotency-key-missing`, `domain-state-conflict`, `last-owner-protected`, `upstream-unavailable`); a `POST` with no `Idempotency-Key` is now `400 idempotency-key-missing` rather than the generic `400 malformed-request`.
- Corrects §14: the Agent API shares the RFC 9457 *shape* of §6, not its registry. Lists the eleven types of its own closed namespace `https://kodera.io/problems/agent/`, and says why two registries is the right answer for two clients that are a browser application and a daemon.
- Records `x-kodera-client-generated` in §8: the third `x-kodera-*` extension, marking `Idempotency-Key` as a value the client produces per request rather than an argument a generated call site has to take.
- Records the bounded `createOrganisation` `X-Operation-Ref` contract in §8 and §14: the same
  canonical job key on committed/replayed success and in-flight, with no authority or lookup and
  no disclosure on any other outcome.
- Aligns §4 with ADR-0006: a tenant slug is a DNS label and a Scaleway project name; the Keycloak realm name is the organisation slug.
- Replaces the provisional ULID representation with the native UUIDv7 decision
  from ADR-0009 and keeps explicit timestamps authoritative for ordering.
- Adds the five `owner-claim-*` types the first-owner claim of `AUTHZ.md` §4 refuses with, each
  carrying `organisation_id`; the missing second factor reuses `mfa-required` and an organisation
  no longer in `prospect` reuses `invalid-state-transition`, so the registry grows by what is
  genuinely new and no more. Counts 28 `POST` operations in §8 now that `consumeOwnerClaim` is one.
- Delimits the two local bootstrap probes without weakening business endpoint conventions.
- Aligns §4 with ADR-0006: a tenant slug is a DNS label and a Scaleway project name; the Keycloak realm name is the organisation slug.
- Replaces the provisional ULID representation with the native UUIDv7 decision
  from ADR-0009 and keeps explicit timestamps authoritative for ordering.
- Adds the five `owner-claim-*` types the first-owner claim of `AUTHZ.md` §4 refuses with, each
  carrying `organisation_id`; the missing second factor reuses `mfa-required` and an organisation
  no longer in `prospect` reuses `invalid-state-transition`, so the registry grows by what is
  genuinely new and no more. Counts 28 `POST` operations in §8 now that `consumeOwnerClaim` is one.
- §15 says which OpenAPI-first gates CI runs: the breaking-change gate runs; the generated
  specification diff, `schemathesis` and client generation do not. Deletes the claims that the
  gate compares with `main`'s tip and checks a second reviewer and a shipped deprecation.
- §13 no longer says §15 blocks a removal without a preceding deprecated release: the gate
  passes one that carries the `contract:breaking` label and the version increase, and nothing
  checks the deprecation.
- Splits §4's slug rule in two, as contract 0.10.0 does: the organisation slug, the realm name, is 2–20 characters; the tenant slug, the DNS label and Scaleway project name, is a 3–32 character DNS label.
- Narrows §4's organisation slug to 5–20 characters, as contract 0.11.0 does: the owner answered five (register row SLUG-MIN-ANSWER), superseding the lead's own call of two (register row SLUG-MIN), and `organisation_slug_valid` carries it. The tenant rule of 3–32 is unchanged.
- `Job.idempotency_key` derives from the kind and the job's ordinal within the request as well, so one request that creates two jobs cannot collide with itself; the queue specification derives sub-job and scheduled keys.
- `Job.idempotency_key` also derives from the request's method and path, the other two parts of the replay key, and its ordinal counts jobs of the same kind only.
- `Job.idempotency_key` is hashed over a canonical JSON array rather than a `":"`-joined string, which two different requests could collide on, and the ordinal follows a deterministic enqueue order.
- Names `discoverRealm` as the one read-only `POST` exception in §§1, 8 and 11, as contract 0.12.0 does: its required key is validated and discarded, and its rate and input policy is route-local. The generic replay rule and proxy trust apply unchanged to every other operation.
- Follows contract 0.13.0 and closes three reports of [`../specs/IDEMPOTENCY_REPLAY.md`](../specs/IDEMPOTENCY_REPLAY.md) §5: §8 states the key's character rule and that a key outside it is `400 malformed-request`, which §6's row now names; the contract declares `Idempotency-Replayed` and the `first_seen_at` member §6 already gave `idempotency-key-reuse`. §8 no longer counts the `POST` operations, a number every new one made wrong.
- Follows contract 0.14.0: two problem types for the staff intake, `slug-taken` (409) and `intake-closed` (503), the latter answered before the key is read and never stored. The `Problem` schema now declares the `reason` and `required_amr` members this table already gave `conflict` and `mfa-required`.
- Follows contract 0.20.0: two problem types, `order-in-progress` (409), `placeOrder`'s refusal while the organisation has an order placed and not yet paid, and `invoice-issued` (409), `cancelOrder`'s refusal of an order whose invoice is issued.
- Follows contract 0.24.0: `invoice-issued` is answered only for an invoice a payment holds; an unpaid issued invoice is credited by a credit note and the order cancelled.
- Follows contract 0.28.0: one problem type, `identity-unknown` (403), for a customer token that verifies but whose subject Core holds no enabled identity for; `401 unauthenticated` stays the answer to every verification failure.

- Follows contract 0.29.0: ordinary organisation creation reserves the `synth-` prefix (`422 validation-error`, `/slug`, `reserved`) after syntax validation; the output/discovery slug shapes and exact-name exclusions are unchanged.
- Follows contract 0.30.0: `TenantStatusView.capacity` may be `null` (no measured capacity yet), as `OrganisationStatusSummary.capacity` already was; `listTenants`, `getTenant`, `getTenantStatus` and `getOrganisationStatusSummary` are served.
- Follows contract 0.31.0: two problem types, `invitation-expired` (410) and `invitation-revoked` (410), for an invitation accepted or resent after its expiry or its revocation; `resendInvitation` also declares `409` for an invitation already accepted.
- Follows contract 0.32.0: `CreditNoteReason` gains `complimentary`, an order settled with no charge by a staff operator (BILLING_MODEL.md §4.2), and `x-audit-action-registry` gains `order.complimentary` and `agent.revoked`. A client that switches on the reason must read an unknown one as a credit.
- Follows contract 0.32.1: a client-supplied `X-Request-Id` now comes back as `c-<id>`, and one of 63 or 64 characters is replaced by a server-generated id (§9); no known consumer sends one (the console and the native clients only read it). §11 names the trusted edge that qualifies the proxy deployment of `discoverRealm` ([`../specs/TRUSTED_EDGE.md`](../specs/TRUSTED_EDGE.md)).
- Follows contract 0.32.2: `checkSlugAvailability`'s description says its per-principal rate limit is not enforced yet, so it answers no `429` yet, and it is served.
- Follows contract 0.32.3: `countMemberships`' description says it counts `listMemberships`' population, refuses `account_kind` as `malformed-request` until Core stores how an account signs in, and enforces no rate limit yet; `getHelpContext`'s says its articles, incident and `sla` are not composed yet. Both are served, and both refuse staff tokens until the staff lane of the customer reads is built.
- Follows contract 0.33.0: `createSupportTicket` is served. Its description says what is built: the ticket is stored and mailed as plain text to the deployment's support mailbox, its subject, message and addresses are kept until the mail is delivered and at most 14 days, `external_ref` is `null` and `sla` omitted until a helpdesk and per-tier service levels exist, the organisation and tenant must be the caller's, 5 tickets per caller and 20 per organisation in a rolling hour, and staff tokens are refused for now. It declares `409` for a reused or in-flight `Idempotency-Key`, and `503 service-unavailable`, with `Retry-After`, when the deployment names no support mailbox; `contact_email` is at most 200 characters.
- Follows contract 0.34.0: the billing switch ([`../specs/QUICK_WORKSPACE.md`](../specs/QUICK_WORKSPACE.md) §2.2). `OrganisationStatusSummary` gains `billing_enabled` and `workspace_pack_code`, and the problem type `billing-disabled` (409) refuses `placeOrder` and `createPaymentLink` on a deployment that does not bill. With the switch unset, nothing a client sees changes but the two new summary members.
- Follows contract 0.34.1: `can_initialise` and `initialiseWorkspace`'s fourth check also accept the CGV and the DPA accepted with no order, as a deployment that does not bill records them, for one tenant of the organisation that is not `deleted` ([`../specs/QUICK_WORKSPACE.md`](../specs/QUICK_WORKSPACE.md) §3); with an order, nothing changes. Descriptions only.
- Follows contract 0.35.0: `createTenant` (`POST /organisations/{organisation_id}/tenants`), the owner's one step to a workspace on a deployment that does not bill ([`../specs/QUICK_WORKSPACE.md`](../specs/QUICK_WORKSPACE.md) §4): the tenant, the acceptance of the CGV and the DPA for it, and the starter workspace, in one transaction, with no order. The problem types `billing-enabled` and `tenant-exists` (409) are new, and `slug-taken` carries `suggestions` on it. Nothing changes for a deployment that bills but the new refusal.
- Follows contract 0.36.0: the audit action `tenant.failed`, written by the operator's `tenant_status` command when a tenant's provisioning is marked failed ([`../specs/QUICK_WORKSPACE.md`](../specs/QUICK_WORKSPACE.md) §5). No operation or schema of the customer API changes.
- Follows contract 0.37.0: `previewInvitation` (`POST /invitations/preview`), the invitation card the invited account reads before accepting: the organisation's and the inviter's display names, the role and the expiry ([`../specs/INVITATIONS.md`](../specs/INVITATIONS.md) §3). It is a read sent as a `POST` so that its token stays out of URLs: it takes no `Idempotency-Key` and stores nothing, the one `POST` §8's key rule excepts (`discoverRealm` takes its own compatibility key).
- Follows contract 0.37.1: `TenantCreation.name`'s description names every character class `createTenant` refuses, private-use and surrogate characters included, as the code already does (Unicode category C, plus line and paragraph separators). No behaviour changes.
- Follows contract 0.37.2: the normative Espace table names the tenant's `slug` (`Tenant.slug`), not the organisation's, as the homeserver's `server_name`, as `TenantCreation.slug` says and the console derives it (ADR-0023). No path, schema, parameter or response changes.
- Follows contract 0.38.0: the reserved tenant slugs gain the platform labels of `kodera.io` that organisation slugs already reserve, and the platform hosts `errors` and `ops-admin`, since a tenant's slug names its Matrix homeserver (ADR-0023). They are refused `422` at the slug by `placeOrder` and `createTenant`, and answered `reserved` by `checkSlugAvailability`. No problem type changes.
- Follows contract 0.39.0: the reserved organisation slugs gain `errors` and `ops-admin`, platform-prod hosts of `kodera.io` the 0.22.0 list missed. `createOrganisation` refuses them `422 reserved`. No problem type changes.
