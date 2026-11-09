# Public realm discovery

**Status:** Proposed · **Owner:** API seat

The contract policy R1–R5/R6-A is approved by the product owner. The pure input boundary,
persisted quota services, coherent slug-selection service and public HTTP adapter are implemented.
Domain verification writers remain unimplemented. No verified domain association exists, so an
email lookup answers the zero result until its proof producer exists. The service implementation
section records acceptance and operational limits. The K7 candidate adds the pilot realm-ready writer below.

## Purpose and scope

`POST /api/v1/auth/discover` is an anonymous, non-mutating lookup for an eligible organisation's
identity entry. The Core contract is authoritative for wire shapes; API conventions name the
route-only exceptions. The required Idempotency-Key is a validated/discarded compatibility header,
not a replay identity. Other POST operations retain their existing replay behavior.

This spec does not implement organisation creation, claim-bound prospect entry, DNS verification,
realm provisioning or a second identity system. FIRST_OWNER_BOOTSTRAP and accepted identity ADRs
continue to govern their own boundaries. No issuer migration is performed by this contract slice.

## Authoritative facts and writers

| Fact | Required authority |
|---|---|
| Organisation eligibility | Nondeleted active/suspended organisation with worker-confirmed ready customer realm; prospects, closed/deleted, staff and unready realms return zero. |
| Realm readiness | Persisted `orgs.RealmReadiness` binds organisation, exact issuer/realm and creation-job generation, with the staff recorder and ready/revoked state. The pilot writer is `complete_realm_bootstrap`; the authoritative reader is `apps.orgs.realm_readiness.realm_ready`. Unknown is not ready; replacement or explicit revocation invalidates the generation. A future worker must preserve the same authority. |
| Verified domain association | Staff requests an organisation/domain association; separately admitted verification worker activates it after the domain controller installs a persistent organisation-bound DNS TXT proof. |
| Proof freshness | Unverified enrollment expires after 30 minutes. Recheck the installed token every 24 hours; success advances freshness by seven days, transient failure never extends it. Expiry hides the association until a successful recheck. Explicit removal or authoritative negative check revokes immediately; re-enrollment requires a fresh proof. |
| Shared-domain bound | At most 20 active verified organisation associations per exact domain, each separately proved. No inference from member/billing email, tenant web domains or federation settings. |

The pilot readiness reader counts an unrevoked fact only while its creation job is the latest
`realm_create` and has succeeded, the binding still matches the organisation, and the issuer has
an unexpired customer-lane trust entry. Merely finding a fact row proves nothing. The
owner-approved transaction reconciliation in FIRST_OWNER_BOOTSTRAP §5.5 specifies the separate
recording transaction and this latest-job visibility rule.

The endpoint only reads persisted facts, with no DNS/provider call. Realm readiness is distinct
from workspace readiness: this lookup cannot prove that messaging, files, media or starter
structure are usable. Claim-bound first-owner entry stays separate; generic discovery excludes
prospects. The issuer is the organisation's realm at the deployment's configured identity provider,
`{identity provider}/realms/{slug}` as `organisation_issuer` derives it from `KODERA_STAFF_ISSUER`
(staging: `https://auth.staging.kodera.io/realms/{slug}`), with the corresponding well-known URL.
No host is fixed in code; the contract's examples show `https://id.kodera.io`.

## Wire and selection

Enforce the 4096-byte cap on received body bytes before parsing, require JSON media type and reject
malformed JSON or duplicate keys. The dedicated compatibility key is 16–255 printable ASCII
characters without surrounding whitespace. Require exactly one known string field: canonical
5–20-character slug or approved ASCII email. No server URL parsing, slug case repair, quoted
mailbox, Unicode conversion, address literal or domain suffix/wildcard matching. Lowercase the
email domain only; discard the local part before lookup, quota-key creation or logging.

Ignore Authorization entirely on this public operation. A current coherent database snapshot
selects eligible organisations. Zero is exactly:

```json
{"realm":null,"issuer":null,"openid_configuration_url":null,"organisation":null,"candidates":[]}
```

One match uses top-level fields with empty candidates. Multiple matches use 2–20 distinct
organisations, sorted by slug then id, and null top-level metadata. Realm equals organisation slug
and realm; issuer and well-known URL must derive from that binding. Never fetch caller-provided
URLs. JSON Schema cannot enforce all cross-field, ordering or authority conditions; runtime tests
must do so. Positive metadata intentionally reveals organisation existence; the equal negative
shape is not an enumeration guarantee. No person, membership, verification reason or organisation
state is disclosed. Request bodies/raw lookup values never enter logs, analytics or audit.

## Quotas, trust and independent requests

Refuse from headers alone, before any quota charge or body read: a media type other than
application/json (415), a missing or invalid compatibility key (400), and a browser request whose
`Origin` is not an exact origin in `KODERA_CONSOLE_ORIGINS` or whose `Sec-Fetch-Site` is
`cross-site` (403 forbidden). A native client sends neither header and is admitted. A cross-site
form or `text/plain` beacon is a CORS simple request that needs no preflight: without this order it
would spend the shared global and peer budgets of the clients behind the same address.

Rolling 60-second shared database limits: 30/IP, 60/slug per IP, 300/exact email domain per IP,
600/global. A value bucket is keyed by the client bucket and the value together, so a stranger
exhausting a slug cannot lock its tenant out. Charge global/IP before parsing, valid-value budgets
before lookup. The client is the connection peer or, behind a configured trusted edge, the rightmost
untrusted `X-Forwarded-For` hop (TRUSTED_EDGE.md §2, with its spoof tests); normalize IPv4-mapped
addresses and count one IPv6 /64 as one client. With no trusted edge configured, forwarded-IP
headers are ignored and clients behind a proxy share its peer bucket.
These are policy caps, not capacity measurements.

Identical, changed-body and concurrent same-key submissions independently consume quota and select
current data. Never store responses, keys, key digests, body fingerprints, in-flight records or a
replay namespace. Use no key lock, replay header or idempotency conflict. Withdrawal of proof or
readiness affects the next coherent snapshot even when the key repeats.

Use separately labelled SHA-256 HMAC digests of peer and typed canonical value with a dedicated
32-byte key; no local-part/body/key digests. Each admitted attempt allocates at most one global/IP
and one value event; an exhausted refusal allocates no extra event and never extends its window.
Events leave the window at 60 seconds; healthy cleanup removes them within another 120 seconds.
The 10000 retained-event cap fails closed without evicting live counters. Pseudonymous digests
retain access/retention controls and are not described as anonymous.

Missing/invalid/unavailable HMAC configuration fails locally before quota state or lookup. No raw
or unkeyed fallback. Limiter and selection each use two-second database budgets. Uncertain quota
commit must not produce a successful uncharged lookup; the next request uses actual committed
state. Missing discovery configuration must not stop the process or change existing /me, detail,
directory or health behavior. Database/configuration/cap failure may need operator repair; a retry
hint is not a recovery guarantee.

## Responses

| Status | Meaning |
|---|---|
| 200 | Exact current zero/one/multiple result, including unknown/ineligible input |
| 400 | Missing/invalid compatibility key, malformed JSON or duplicate keys |
| 403 | Browser request from an origin not allowed, or `Sec-Fetch-Site: cross-site`; decided before any charge |
| 413 / 415 / 422 | Received bytes exceed 4096 / unsupported media type / invalid shape or format |
| 429 | Evaluated quota exhausted; actual controlling-stage delay rounded up, minimum one second |
| 500 | Unexpected correlated failure with no input or internal details |
| 503 | Discovery dependency/configuration/database/cap failure; five-second minimum backoff |

Every response carries X-Request-Id and Cache-Control: no-store; problems echo current request
correlation. Retry-After and retry_after_s agree. RateLimit-Limit/Remaining/Reset describe the
tightest evaluated bucket; omit them when a prerequisite failed before evaluation rather than
inventing counters. No Idempotency-Replayed header or discovery idempotency 409 is declared.

## Executable acceptance and remaining proof

`services/identity/discovery_input.py` implements the pure received-byte/parser boundary. It returns
only a typed canonical slug or exact lowercase email domain; compatibility keys and email local
parts are not returned or retained. Refusals carry static status/problem metadata without chaining
JSON exceptions that contain the request. The HTTP adapter must still bound ingestion before
materializing the body, charge global/IP before parsing and value quotas before selection, and map
safe errors into correlated no-store responses. This helper does not expose a route or establish
quota, database, realm readiness, provider or deployed discovery behavior.

Run its input, privacy and byte/media/header boundary acceptance without Django or a database:

```sh
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -B -m pytest -c /dev/null --rootdir=. -p no:cacheprovider tests/test_realm_discovery_input.py
```

`tests/test_realm_discovery_contract.py` reads the actual full contract. It checks narrow unchanged
surface pins, dedicated compatibility semantics, schemas/statuses/headers, mandatory operation
clauses and local references; wire examples and deliberate mutations prove refusal. Existing
`tests/test_customer_read_contract.py` protects the shared slug vocabulary. Pure source-only run
with existing dependencies, independent of Django's plugin/configuration:

```sh
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -B -m pytest -c /dev/null --rootdir=. -p no:cacheprovider tests/test_realm_discovery_contract.py tests/test_customer_read_contract.py
```

This targeted command does not replace normal repository CI, OpenAPI lint, version/breaking-change
checks, authz, attribution checks or Console pin/generation qualification. Contract version 0.12.0
is breaking under the existing pre-launch rule; publication requires contract:breaking metadata.
The surface pin binds the reviewed base and must be deliberately reviewed/rebound when a later
legitimate unrelated contract change is introduced.

Runtime acceptance remains required through actual Core/DB/provider boundaries:

- Unknown/ineligible, single/multiple and current-proof/readiness withdrawal with same-key retries;
  issuer-local subject collision, no bearer-selection influence, local-part and log privacy.
- At B−1 concurrent requests admit at most one further request for each bucket; actual controlling
  retry deadlines, restart/shared state, spoofed headers, no allocation on exhausted refusals.
- Same/different/concurrent key reuse performs fresh quota/selection with zero key/fingerprint/
  response/in-flight persistence and no replay or conflict; instrument real writes/queries.
- Controlled-clock 20-peer/20000-key churn, retention and cap faults; no 24-hour allocation hold.
- Parser/byte/media boundaries, route-local missing HMAC, database failure/commit uncertainty,
  and same-process regression of existing customer reads and health.
- Real claim-bound first-owner entry and worker fact writers; no manual seed or synthetic summary
  constitutes a production writer, browser journey or deployed qualification.

The pure input helper is delivered independently of the public discovery runtime. New
writer/route/limiter paths need their own acceptance; reuse existing identity, queue, audit and
image acceptance. The helper tranche alone establishes no deployed discovery qualification.

## Quota and slug-selection service implementation

Status: Quota and slug-selection services implemented and locally tested. This service tranche
predates the HTTP adapter below and does not implement a domain-proof producer.

The approved policy remains REALM_DISCOVERY.md. This service tranche implements its persisted
rolling quotas and current eligible realm selection by slug, behind the pure input boundary.
Domain selection answers the zero result until the admitted domain-proof producer exists, since no
verified association exists; no contact address, membership email, DNS call or manually asserted
association substitutes for it.

### Storage and transaction authority

Identity owns one fixed quota serialization row and one bounded event table. Entry events count
both global and peer budgets; slug/domain events count the typed value per client bucket. Store a scope,
domain-separated HMAC-SHA256 digest and database timestamp, never raw input, request keys,
fingerprints or responses. The dedicated configuration is exactly 32 bytes, provided as canonical
base64 in KODERA_DISCOVERY_HMAC_KEY. Validate it locally on each operation, without changing
startup or existing operations. Workers must share the same key. Rotation needs a coordinated
drain of the 60-second window; this slice does not perform or authorize rotation.

Use service-owned READ COMMITTED transactions. Lock the one fixed row, sample database time,
purge events at or before the 60-second cutoff, then count/check/insert under the same lock.
An exhausted stage inserts nothing and extends no window. Refuse before exceeding 10000 events;
never evict live events. Missing gate/storage or uncertain commit fails closed.

Limits are 600/global, 30/peer, 60/slug per peer and 300/domain per peer per rolling 60 seconds.
Normalize IPv4-mapped IPv6 and bucket other IPv6 by /64; the peer argument is
`core/api/edge.py`'s `client_address`, the direct peer unless it is a trusted edge. Match exact typed
values. Reset/retry seconds derive from actual event expiry, round up and use at least one second
for exhaustion. Choose the most restrictive evaluated bucket; do not invent unevaluated counters.

The orchestration commits global/peer admission before parsing, then commits typed-value admission
before selecting. Each same/different compatibility key performs these operations again, with no
idempotency storage or locks. Later refusal preserves the earlier committed stage. Use a shared
two-second elapsed database budget for both quota stages and a separate two-second selection
budget. Statement/lock timeouts shrink with remaining time; check transaction completion too.
Late or uncertain completion never returns a successful unconfirmed admission.
An owned connection watchdog covers transaction setup and commit using bounded libpq17+
cancellation, and is joined before the connection can be reused. Cancellation acknowledgement
does not prove rollback after an uncertain commit. Connection establishment uses the configured
two-second connect timeout and elapsed checks; OS/network delays are not a hard wall-clock SLA.
Fired or uncertain cancellation disposes the held connection; a still-live cancellation thread
is explicitly incomplete cleanup and a dependency refusal, never a qualified successful return.

The explicit cleanup command uses the same gate and removes only expired events. Operators must
schedule it at least every 120 seconds before deployment to establish idle-period deletion within
180 seconds. Tests of the command do not prove that scheduling or an operational retention SLA.

### Selection

Own one REPEATABLE READ READ ONLY snapshot, materialize the response inside it and reuse
counting_realm_ready. Require nondeleted active/suspended organisation, canonical slug matching
its realm, the issuer `organisation_issuer(slug)` derives from the configured staff issuer (no
configured staff issuer is a 503 configuration refusal, never a zero), latest successful realm_create
generation, its matching unrevoked readiness fact and unexpired customer-lane trust. No bearer,
person or membership influences this lookup. Return the contractual zero or single shape only;
a domain lookup returns the zero result, which is true while no verified association exists;
domain-dependent multiple selection arrives with the proof producer.

### Runnable acceptance

Write tests before services/models. Pure policy tests run without Django/database plugins.
Real PostgreSQL tests use the migrated identity/orgs/jobs tables and service transactions:

- All four limits, exact window boundaries, controlling retry delays and no writes on exhaustion.
- HMAC configuration before state, labels/peer normalization and no raw inputs in stored values.
- Concurrent requests at B-1 admit one further event, with joined/closed owned connections.
- Shared state across connections, global cap, expired-only cleanup and maintenance command.
- Global/peer charge survives malformed input, typed refusal or selection dependency failure;
  repeated compatibility keys never replay authority or quota decisions.
- Transaction-context, storage failure, elapsed budget and uncertain commit fail closed.
- Real ready/unready, inactive/deleted, trust withdrawal/expiry, fact revocation and newer-job
  replacement; read-only repeatable-read snapshot and committed race withdrawal on next read.

Retain intended missing-API red and actual behavioral failures. Mutations must break named
assertions. Preserve existing parser, contract, customer-read and readiness acceptance. Run lint,
format, type/migration checks and exact independent CTO/SWE reviews. CI remains a separate merge
gate. No provider, DNS, real-tenant, deployment, tool installation or paid execution is involved.

Combined local acceptance ran 627 cases, including 36 migrated PostgreSQL service cases,
30 pure policy/watchdog controls and 561 retained identity/persistence/parser/contract cases,
with no failures, errors or skips; migration drift checks pass. Five isolated semantic faults (window,
HMAC label, peer normalization, quota limit and exception context) fail the unchanged assertions.
The original fixture-start and exception-context failures remain retained outside the source tree.
This evidence does not establish deployment, HTTP headers/ingestion, domain-proof authority or
operational cleanup scheduling.


## HTTP adapter implementation

Status: Implemented and locally qualified. Required CI remains a separate merge gate.

The fixed deployment and local customer profiles expose only POST at `/api/v1/auth/discover`.
The operation ignores Authorization, performs no generic replay and reads the client address
only through `client_address`: the direct peer, or behind a trusted edge the rightmost untrusted
forwarded hop (TRUSTED_EDGE.md §2). A missing or malformed dedicated HMAC key refuses this route
without preventing profile startup or changing existing operations; so does a malformed
`KODERA_CONSOLE_ORIGINS`, for browser requests only. Each of its origins is `https`. Only
`config.settings.e2e`, the local end-to-end stack's API profile, also admits
`http://localhost:<port>` (`KODERA_CONSOLE_LOOPBACK_ORIGINS`), for the stack's Console; in every
other profile a list holding one is malformed (`tests/test_e2e_console_origin.py`).

Header refusals (415, 400 for the compatibility key, 403 for the browser origin) precede the
global/peer charge and the body read, and carry no RateLimit counters. Every 500 logs one line with
the request id and the exception's class name, never its text, the body, a header or a lookup value.

The confirmed global/peer charge precedes one application read of at most 4097 bytes. Gunicorn's
terminated input stream supplies the chunked framing boundary; otherwise Django's request stream
is read with the same bound. The actual received bytes determine the 4096-byte payload limit,
not a Content-Length guess. This qualifies the application's returned-byte bound, not transport
buffering. Bounded body reading and parsing do not consume the shared database allowance: the
remaining allowance after the first charge resumes immediately before the typed charge. The
existing serving timeout remains responsible for body transport time.

Every handled response carries no-store and a safe current request identifier, with UUIDv7 fallback.
Only evaluated quota decisions supply RateLimit headers, including safe failures after committed
charges. Missing/invalid compatibility headers have no body-pointer errors. Body failures use
static safe errors, 413 names the limit, 415 lists application/json and 429/503 synchronize their
retry metadata and Retry-After. Unexpected post-charge failures retain confirmed counters without
private exception context. Non-POST requests return 405/Allow without charging.

Runnable acceptance: `tests/test_discovery_http.py` uses real migrated PostgreSQL, Django Client
and bounded WSGI input probes for ready/zero shapes, auth/forwarded-header ignorance, byte limits,
media/header/body refusals, slow reads, safe staged faults, exact counters/backoff/correlation,
fresh charges on repeated compatibility keys, missing configuration and unchanged health/me.
Deployment-profile and architecture scope checks remain mandatory. Isolated in-memory adapter
faults must fail unchanged ingestion, no-store, request-id and bearer-ignorance assertions. No
provider, live login, client admission, domain proof or deployment qualification follows.

Local acceptance passed 655 cases without failures, errors or skips: 28 HTTP cases plus the
627 retained policy, watchdog, selection, persistence, parser and contract cases. Deployment-profile
and architecture scope acceptance passed 87 cases. Migration drift is zero; targeted type checks,
lint/format and documentation/policy checks pass. Four isolated adapter faults failed their named
unchanged assertions (five failures in total). Product source stayed unchanged during mutation
execution. The earlier runner import-order setup failure remains retained separately and was
corrected without relaxing warnings or test expectations.


## Changelog

- Decides media type, compatibility key and browser origin (Console allowlist plus Fetch Metadata)
  from headers before any charge; keys value quotas per client and IPv6 by /64; derives the issuer
  from the configured staff issuer; answers the zero result for email lookups; logs 500s by request
  id and exception class. Contract 0.26.0.

- Adds the bounded anonymous HTTP adapter, deployment key loading and safe problem/quota headers.

- Implements persisted rolling quotas and coherent slug selection; keeps HTTP/domain-proof
  producers and operational cleanup scheduling explicit dependencies.

- Names the K7 pilot realm-ready record, command writer and counting reader; public discovery and
  domain verification runtime acceptance remain open.

- First version: the realm-discovery contract of `core-api.openapi.yaml` 0.12.0, the policy
  R1–R5/R6-A, its named exceptions in `CONVENTIONS.md` §§1/8/11, and the acceptance the runtime
  owes. `tests/test_realm_discovery_contract.py` asserts the contract side.
