# Abuse and origin controls

**Status:** Proposed · **Owner:** API seat

What Core answers at its edge before any view runs: which browser origin may read the customer API,
how many writes one principal may send, and how many LiveKit call tokens one member may ask
room-access for. It complements [`TRUSTED_EDGE.md`](TRUSTED_EDGE.md), which says when Core believes a
client address and how it keeps a caller's request id apart from its own. The code is
`core/api/edge.py` and `room_access/server.py`; the acceptance is
`tests/test_abuse_origin_controls.py`.

## 1. Order

`config/settings/base.py` installs three middlewares first, in this order, for every profile that
serves HTTP:

1. `CallerRequestIdMiddleware` ([`TRUSTED_EDGE.md`](TRUSTED_EDGE.md) §3): every later answer carries
   a safe request id.
2. `ConsoleCorsMiddleware` (§3): outside everything else that can answer, so that an answer made
   before any view, a `429` included, is one the Console can read.
3. `MutationRateLimitMiddleware` (§2): before any view, so that a refused write reaches no handler.

The two profiles that serve no HTTP (`deploy_operator`, `deploy_worker`) install no middleware; no
other settings module names `MIDDLEWARE`.

## 2. The mutation bucket

[`../api/CONVENTIONS.md`](../api/CONVENTIONS.md) §11 gives every authenticated principal a mutation
bucket. Core enforces it on the customer API (`/api/`): `POST`, `PUT`, `PATCH` and `DELETE`.

- **Key.** The verified principal, `(iss, sub)`, and nothing a caller can write. The middleware
  verifies the bearer token exactly as the views do (`verify_configured_token`, then the lane guard
  `core.api.lanes.admit`) and keeps a digest of the pair. It never reads the client address,
  `X-Forwarded-For`, another header, the path or the body: a caller cannot choose a bucket, a
  refreshed token of the same principal lands in the same one, and two principals behind one address
  never share one.
- **Limit.** `KODERA_MUTATION_RATE_PER_MINUTE`, an integer from 1 to 6000, read by the serving
  profiles (`config.environment.mutation_rate_per_minute`). Unset or empty: 60, the documented
  default. Nothing turns the bucket off: `0`, a negative number and anything that is not a number
  stop the process at start, with a message that carries no value.
- **Window.** Rolling 60 seconds. A write is admitted while fewer than the limit of the principal's
  admitted writes fall inside the last minute. A refused write is not recorded, so repeating it does
  not extend the wait.
- **Refusal.** `429` `application/problem+json`, type `rate-limited`, with `Retry-After` in seconds
  (at least 1), the same number as `retry_after_s`, and `scope: "mutation"`, `limit`. It is
  `Cache-Control: no-store` and carries the request's id. The request reaches no view: nothing is
  written, audited or stored against an `Idempotency-Key`, so the same key can be sent again.
- **Admitted writes** carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` for this
  bucket, unless the view already reported a tighter one of its own.
- **A request without a verified principal is not charged and not refused here.** A missing, expired
  or forged token is answered `401` by its view, which a client needs in order to sign in again.
  Answering `429` there would let anyone turn other people's expired tokens into a lockout.
- **The Agent API** (`/agent/`) is another principal with its own credential; it is outside this
  bucket. Reads are never counted.

### 2.1 What the count is, and is not

The window lives in the serving process. There is no shared store: the API role holds no table for
it, and its grants are provisioned by the operator ([`ORGANISATION_INTAKE.md`](ORGANISATION_INTAKE.md)
§4).

- A deployment of N API processes admits at most N times the limit per principal per minute: 120
  with the two workers of `config/gunicorn.py` and the default limit.
- A restart forgets the window.
- At most 50 000 buckets are kept; past it the idle ones go first, then the least recently used.

The bound is finite and stated. It is not the exact shared bucket of CONVENTIONS §11, and the other
buckets of that table (token, organisation, IP, job creation) are not enforced by this middleware.
`discoverRealm` keeps its own shared quotas (CONVENTIONS §11).

### 2.2 The contract

Contract 0.42.0 declares `429` on 20 of its 56 writes. The bucket applies to every write the API
serves, so a write whose operation declares no `429` can answer one. Clients treat `429
rate-limited` with `Retry-After` as possible on every write; the contract owes the missing
declarations.

## 3. Origins

A browser lets a page read a cross-origin answer only when the answer names the page's origin. Core
names an origin only when it is, exactly, one of the Console's own: the comma-separated
`KODERA_CONSOLE_ORIGINS`, the setting realm discovery already admits browsers with, read by the same
parser (`services.identity.discovery_input.allowed_origins`). Each origin is `https://host[:port]`;
`http://localhost:<port>` is admitted only by the local end-to-end profile.

| Request | Answer |
|---|---|
| `Origin` is a listed origin | `Access-Control-Allow-Origin: <that origin>`, `Access-Control-Allow-Credentials: true`, `Access-Control-Expose-Headers` |
| `Origin` is anything else | no CORS header at all |
| no `Origin` (a native client) | no CORS header at all |
| preflight from a listed origin, for `GET`, `POST`, `PUT`, `PATCH` or `DELETE` | `204`, the grant above, and fixed `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, `Access-Control-Max-Age: 600` |
| any other preflight | `403 forbidden`, no CORS header |

- **Exact match.** `Origin` is compared as a string with each listed origin: no pattern, no suffix,
  no scheme, case or port folding, no `null`.
- **Never `*`, never a reflection.** `Access-Control-Allow-Origin` is absent or a listed origin. The
  preflight's allowed headers are a fixed list (`Authorization`, `Content-Type`, `Idempotency-Key`,
  `If-Match`, `If-None-Match`, `X-Request-Id`), never the ones the browser asked for.
- **Fails closed.** An unset setting lists no origin. A malformed one, a `*` included, lists none
  either.
- **Credentials only for a listed origin.** The API authenticates by bearer token and sets no cookie;
  the header is sent so that a Console that sends credentials is not refused by its browser, and it
  is never sent to another origin.
- **`Vary: Origin` on every answer of the customer API**, with or without an `Origin` header, so no
  cache serves one origin the answer made for another. A preflight also varies on
  `Access-Control-Request-Method` and `Access-Control-Request-Headers`.
- **Scope.** The customer API (`/api/`) only. The Agent API and the diagnostics are not called from a
  page and are answered with no CORS header whatever the origin.

CORS decides what a page may read. It is not an authorisation: every operation still verifies its
token and its grant. `discoverRealm`, which takes no token, keeps its own refusal of an unlisted
origin ([`REALM_DISCOVERY.md`](REALM_DISCOVERY.md)).

## 4. The client address

Neither control above reads a client address. The one quota that does, `discoverRealm`'s, takes it
from `client_address` alone ([`TRUSTED_EDGE.md`](TRUSTED_EDGE.md) §2): the direct peer, or behind a
configured `KODERA_TRUSTED_EDGE_ADDRESSES` the rightmost untrusted `X-Forwarded-For` hop.
`tests/test_trusted_edge.py` fails on any other reader of that header, and the acceptance here fails
a mutation bucket keyed on an address.

## 5. room-access: LiveKit call tokens

`POST /token` of the room-access service ([`../../room_access/README.md`](../../room_access/README.md))
issues a LiveKit token to a joined member of an audio room.

- **Per identity.** One Matrix user's token requests per rolling minute:
  `ROOM_ACCESS_GRANTS_PER_MINUTE`, 1 to 600, default 30. The identity is what Synapse says the
  caller's own token is, so every device and every token of one member share one bucket. It is
  counted once Synapse has named the caller and before the room or LiveKit is asked anything.
- **Per credential, first.** Before Synapse is asked at all, the presented credential, kept as a
  digest, has the same budget: a client looping on one token, valid or not, stops reaching Synapse.
- **Refusal.** `429 {"error": "rate_limited", "retry_after_s": n}` with `Retry-After: n`, in
  room-access's own answer format. No upstream is called.
- **Always on.** A listener built without a limiter gets the default one, and the setting refuses
  `0`.
- **CORS.** `ROOM_ACCESS_ALLOWED_ORIGINS` is a list of exact origins and stops the process on a
  wildcard, `null`, a path or a pattern. `Access-Control-Allow-Origin` is that origin or absent;
  every answer carries `Vary: Origin`.

room-access is one process per tenant VM, so its count is the tenant's.

## 6. Acceptance

`tests/test_abuse_origin_controls.py`:

- one case per rule above, each run against `core/api/edge.py` and against a mutant of it with one
  anchor replaced: a wildcard origin, a reflected origin, a suffix match, credentials for every
  origin, a missing `Vary`, an echoed preflight, CORS on every path, a limiter that never refuses, a
  refused write that still reaches its view, a missing `Retry-After`, a bucket keyed on the token or
  on the client address, an unverified request charged, a setting that turns the bucket off, a
  window that does not roll, unbounded buckets;
- the settings: admitted and refused values; the deployed profile installs the three middlewares in
  order and reads the three settings;
- through the routed views, with real signed tokens: a principal's fourth write of three is refused
  `429` with a conforming body and has changed nothing; the Console can read that refusal and no
  other origin can; a forged token still gets its `401`; real answers, refusals and unrouted paths
  name the Console only; a real preflight is answered before any view;
- with the limiter taken out of `MIDDLEWARE`, and with a limiter that admits everything, the bucket
  check fails by name;
- room-access: the same case-and-mutant pairs for its identity limit, its credential limit, its
  default limiter and its CORS; the refused identity reaches neither the room nor LiveKit; the
  origin and rate settings.

## Changelog

- Specifies the Console-only CORS, the per-principal mutation bucket and the per-identity limit on
  LiveKit call tokens, with what the in-process count does not guarantee.
