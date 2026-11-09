# Idempotency replay store

**Status:** Proposed · **Owner:** API seat

The mechanism every `POST` route uses to honour [`../api/CONVENTIONS.md`](../api/CONVENTIONS.md) §8: a client's `Idempotency-Key`, scoped to the principal and the operation, either runs the request's effect once and stores its response, replays that response, or refuses the key. It is the shared building block for `createOrganisation`, `inviteToOrganisation`, `acceptInvitation`, `initialiseWorkspace` and every later `POST`. Its acceptance tests drive a test-only view and the store directly. The routes that use it are `createOrganisation` ([`ORGANISATION_INTAKE.md`](ORGANISATION_INTAKE.md)) and `initialiseWorkspace` ([`PILOT_WORKSPACE_ONBOARDING.md`](PILOT_WORKSPACE_ONBOARDING.md) §6).

## 1. What is implemented, clause by clause

| §8 clause | Here | Where |
|---|---|---|
| A `POST` without `Idempotency-Key` is `400 idempotency-key-missing` | Implemented. An empty header value counts as absent | `core/api/idempotency.py` |
| The key is a client string of 16 to 255 characters | Implemented as 16 to 255 visible ASCII characters (`0x21`–`0x7E`). Any other value is `400 malformed-request`; §6 names no type for it (§5 below) | `core/api/idempotency.py` |
| Stored: `(principal, method, path, key) → (body_sha256, status, response_body, created_at)` | Implemented. The principal is the verified token's `(issuer, subject)` ([`../api/AUTHZ.md`](../api/AUTHZ.md) §1 step 6); the key is stored as its SHA-256, never verbatim; the response is stored as its status, body bytes, `Content-Type` and three optional headers (§2.5) | `core/idempotency/` |
| Kept for 24 hours | Implemented. An entry older than 24 hours by the database clock is absent: it is neither replayed nor refused on, and the next request with its key replaces it. `purge_expired()` deletes expired entries in bounded batches, and `purge_idempotency --once` runs it; scheduling it is the operator's (§2.7, §6) | `core/idempotency/store.py`, `core/idempotency/management/commands/purge_idempotency.py` |
| Same key, same `body_sha256`: replayed byte for byte with `Idempotency-Replayed: true`, the effect does not happen twice | Implemented | both |
| Same key, different `body_sha256`: `409 idempotency-key-reuse` | Implemented, with `first_seen_at` (§6 of the conventions) | both |
| Same key, first request in flight: `409 idempotency-key-in-flight` with `retry_after_s` | Implemented, `retry_after_s: 1` | both |
| The body hash covers the raw bytes after removing insignificant whitespace | Implemented (§2.4) | `core/idempotency/fingerprint.py` |
| Keyed per principal and per path | Implemented | `core/idempotency/store.py` |
| `Job.idempotency_key` derived from the request key | Not here. It is `apps.jobs.keys.derive_key` (`../specs/JOB_QUEUE.md` §3.4); a route derives it from the same key, method and path it hands this store |
| `GET`, `PATCH` and `DELETE` must not carry the key | Not enforced here: the adapter serves `POST` only and refuses to be called for another method. Refusing a key on the other methods is the routes' concern and §6 names no type for it |

ADR-0020 makes this store the first of two tiers. The table above remains an exact statement of the
implemented HTTP receipt: after 24 hours it may expire and a handler may run again. Before an
effect-bearing handler dispatches or commits an effect, its owning domain must also resolve a
durable semantic operation identity. A Job or Order may be that second-tier record. Receipt expiry
must never be the event that authorizes another external or commercial effect.

## 2. Design

### 2.1 Placement

The table is a Django application in the shared kernel, `core.idempotency` (label `idempotency`, table `idempotency_record`, model `IdempotencyRecord`), because every application's `POST` uses it and `../dev/PROJECT_LAYOUT.md` §1 places idempotency in `core/`, which no application owns. The HTTP adapter is `core/api/idempotency.py`, the module an `apps/<app>/api/` view may import under §2 of that document. Neither imports anything of `apps/`, so the `core/` row of the architecture tests holds.

It is installed by `config.settings.job_queue` and `config.settings.test`, the profiles schema commands and the suite run under. `config.settings.customer_http`, the image's customer profile, installs it since `createOrganisation`, its first route ([`ORGANISATION_INTAKE.md`](ORGANISATION_INTAKE.md) §4); `initialiseWorkspace` uses it too. `config.settings.dev` does not.

### 2.2 The transaction

`run_once(scope=…, body_sha256=…, handler=…)` refuses to run inside a caller's transaction (`RuntimeError`): the stored response must commit or roll back with the effect, and nothing else. In its own transaction it:

1. pins `READ COMMITTED`, whatever the session default is, so that step 3 reads with a snapshot taken after step 2;
2. takes `pg_try_advisory_xact_lock(k)`, where `k` is the first eight bytes, as a signed big-endian integer, of SHA-256 over the canonical JSON array `[issuer, subject, method, path, key]` (`json.dumps(…, separators=(",", ":"), ensure_ascii=True)`). Refused: the answer is **in flight**, and nothing else runs. This is the one-integer advisory key space, which PostgreSQL keeps apart from the two-integer space of the job queue's locks (`apps/jobs/locks.py`), so the two cannot exclude each other. Two scopes whose `k` collide only make one of them read as in flight while the other runs;
3. reads the scope's entry. A live entry with the same body hash is **replayed**; a live entry with another body hash is **refused as reuse**; an expired entry is deleted;
4. calls `handler()`, the route's effect, inside the same transaction. It returns a `StoredResponse`;
5. a `2xx` or `4xx` response is inserted and the transaction commits: **executed**. `408` and `429` are the exception: a timeout and a rate limit say "not now" rather than "no", so they are treated as a `5xx`. A `5xx` response rolls the transaction back, the effect with it, and is handed back unstored, so a retry with the same key runs again (the contract's `upstream-unavailable` tells clients to do exactly that). Any other status raises `ValueError`. A handler that raises rolls everything back and the exception propagates.

The lock is released by the commit or the rollback, after which a new snapshot sees the entry: a request that arrives while the first one runs is refused in flight; one that arrives after it is replayed. The unique constraint `idempotency_record_scope_unique` on `(issuer, subject, method, path, key_sha256)` is the backstop: were the lock bypassed, a second insert would wait on the first and then fail, and its effect would roll back with it.

A handler's own `transaction.atomic()` blocks become savepoints of this transaction. A service that insists on an outermost transaction, as `read_organisation` does, cannot be called from a handler; a write service meant for a `POST` must accept being called inside one.

### 2.3 The principal and the scope

The scope is `(issuer, subject, method, path, key)`. `issuer` and `subject` come from the verified token, never from the request body or a header; `method` is `POST`; `path` is the request's path without its query string. Two organisations cannot collide because their realms are two issuers; one key on two paths is two operations. Staff and customers are distinct issuers too.

**The query string is in neither the scope nor the fingerprint.** Two `POST`s that differ only by their query string are one operation to this store, and the second is replayed the first's answer. A route MUST NOT give a query parameter a meaning on `POST`; whatever varies the operation goes in the path or the body.

The route authenticates and authorises the caller against current state **before** it calls the adapter. A replay is therefore never served to a caller who could not make the request now, which is what `FIRST_OWNER_BOOTSTRAP.md` §8.5 requires of `consumeOwnerClaim`.

### 2.4 The fingerprint

`canonical_body(raw)` walks the raw bytes once. Outside a JSON string, the four whitespace bytes of RFC 8259 — space, tab, line feed, carriage return — are dropped. A string starts at an unescaped `"` and ends at the next `"` not escaped by a backslash; everything inside it, whitespace included, is kept. A body that is not JSON is canonicalised by the same rule, so the fingerprint never depends on parsing. `body_sha256` is the lower-case hexadecimal SHA-256 of the result. Key order, number spelling and escapes are significant: `{"a":1,"b":2}` and `{"b":2,"a":1}` are two bodies, as §8 says ("not the parsed object").

Two bodies that are not valid JSON can canonicalise to the same bytes — for instance two unterminated strings, or whitespace between two bare tokens that JSON would refuse. That collision is harmless: a route refuses an invalid body with `400 malformed-request`, the refusal is what is stored, and replaying one invalid body's refusal for another invalid body is the same answer the route would have given.

### 2.5 What is stored, and what is not

An entry holds the scope (with the key as `key_sha256`), `body_sha256`, the response status, its body bytes, its `Content-Type`, and its `Location`, `ETag` and `X-Job-Id` headers when present. Those three are the only response headers a `POST` of the contract sets that belong to the response rather than to the request; `X-Request-Id` and `Cache-Control` are set by the view on every answer, first or replayed. The table has no other column, and a test fails if it gains one.

The request body is never stored, only its hash; nor is any request header. A stored response holds exactly the bytes the first answer sent, so it holds no secret the first answer did not. A route whose response would carry a one-time secret — an owner-claim plaintext, a token — MUST NOT return it through this store: `FIRST_OWNER_BOOTSTRAP.md` §6.3 keeps such values out of replay storage, and they are delivered by their own flow. The first answer and every replay are rendered from the same `StoredResponse`, so they cannot differ but for `Idempotency-Replayed`.

Database guards: the method is `POST`; the status is `2xx` or `4xx`; both digests are 64 lower-case hexadecimal digits; issuer, subject and path are bounded (1–1024, 1–255 and 1–2048 characters, the path starting with `/`); the body is at most 1 MiB. `created_at` is set by the database clock, which is also the clock expiry is measured on, so application hosts with skewed clocks agree.

### 2.6 The HTTP adapter

`respond_once(request, issuer=…, subject=…, request_id=…, handler=…, operation_ref=…)` validates
the key and the optional route-supplied reference, fingerprints `request.body`, runs the store and
renders the outcome: the stored response (plus `Idempotency-Replayed: true` on a replay), or an
`application/problem+json` document with `type`, `title`, `status`, `request_id` and the type's
extension member. A route that supplies a reference gets it back only on an executed/replayed
`201` and `idempotency-key-in-flight`; a malformed reference is rejected before the handler. A
route that omits it remains domain-neutral. Replayed problem documents keep the `request_id` of
the request that produced them: the body is replayed byte for byte, and the response header carries
the current one. The adapter sets neither `X-Request-Id` nor `Cache-Control`; the view does, as every
view of this repository does today.

### 2.7 The purge

An expired entry is inert, but it stays in the table until its key is reused or the purge deletes it. `purge_expired(batch=…)` deletes every entry created at or before one cutoff, the database clock's now less the retention, read once at the start so that a purge has an end. It deletes in batches: each batch is its own transaction, which selects at most `batch` expired entries, oldest first, `FOR UPDATE SKIP LOCKED`, deletes them in one `DELETE` and commits before the next batch starts, as `../dev/MIGRATIONS.md` §3 asks of any bulk write. A row another transaction holds — a request replacing its own expired entry — is skipped, never waited on, and left to the next purge. The purge stops at the first batch smaller than `batch`. `batch` is 1 to 10,000, 1,000 by default. Like `run_once`, it refuses to run inside a caller's transaction (`RuntimeError`), since a caller's transaction would hold every batch's locks until it ended.

`python manage.py purge_idempotency --once [--batch N] --settings=config.settings.job_queue` runs one purge and prints one line of counts, `idempotency purge: deleted D expired entries in B batches`, and never an entry's issuer, subject, path or key. `--once` is required: Core has no scheduler, and how often the purge runs is the operator's (cron). Nothing breaks when it does not run; the table only grows.

## 3. Using it from a route

```python
@declares(CREATE_ORGANISATION)
def create_organisation(request: HttpRequest) -> HttpResponse:
    ...  # request id, authentication, authorisation against current state
    response = respond_once(
        request,
        issuer=verified.issuer,
        subject=verified.subject,
        request_id=request_id,
        handler=lambda: render(create_organisation_service(...)),
    )
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
```

The handler maps the route's domain refusals to `4xx` `StoredResponse`s itself, so that a refusal is replayed like a success (the contract says so of `consumeOwnerClaim`), and lets unexpected failures raise.

**A handler's effects MUST all be in this database.** A `5xx`, a transient `408` or `429`, or an exception rolls the transaction back, and the rollback must undo everything the handler did: that is what makes running the handler again on a retry safe. Any external effect — a mail, an HTTP call, a provider or Keycloak call — is written as an outbox row or a `Job` in the same transaction (ADR-0004, `../specs/JOB_QUEUE.md`) and performed after the commit by the worker. A handler never calls the outside world directly; one that did would repeat that call on every retry, and no rollback would undo it. One route asks the provider before the step instead, outside any transaction, and withdraws what the step does not keep: `createPaymentLink`, whose answer must carry the provider's checkout URL (ADR-0022). It is the only one; its withdrawals, and those of `cancelOrder`, run after the commit in the API process (ADR-0022).

## 4. Acceptance

`tests/test_idempotency_replay.py`, in the normal suite against the disposable test database. Every check is a function that raises an `AssertionError` with a fixed message; the acceptance test runs it unmutated, and each mutant of `MUTANTS` patches one part of the mechanism and requires its owning check to fail with exactly that message. A test fails when a check has no mutant.

| Check | What it proves | Mutants that it catches |
|---|---|---|
| `executes_once_then_replays` | The first request runs the effect once and stores the response; the same key and body replays it byte for byte and runs nothing | lookup never finds the entry |
| `refusal_is_replayed` | A `4xx` from the handler is stored and replayed; a `3xx` raises and is not stored | `4xx` discarded; `3xx` stored |
| `transient_refusal_is_not_stored` | A `408` and a `429` are handed back unstored with their effect rolled back, and a retry runs again | `408` and `429` stored |
| `reuse_is_refused` | Same key, other body: reuse, with the first entry's time, and nothing runs | body hashes not compared |
| `scoped_per_principal` | Another subject, or another issuer, with the same key and path runs its own effect | subject left out of the scope; issuer left out |
| `scoped_per_path` | The same principal and key on another path runs its own effect | path left out of the scope |
| `scoped_per_key` | Another key under the same principal and path runs its own effect | key left out of the scope |
| `whitespace_is_insignificant` | Whitespace outside strings does not change the hash; inside a string it does | canonicalisation skipped; whitespace removed inside strings; backslash escapes ignored |
| `in_flight_is_refused` | Two real connections: while the first request holds its transaction open inside its handler, the second gets in-flight and runs nothing; after the first commits, the key replays | advisory lock bypassed |
| `colliding_lock_keys_answer_in_flight` | Two scopes forced onto one advisory key: while the first runs, the second is in flight, never a replay of the first's response; once the lock is free it runs its own effect | advisory lock bypassed |
| `in_flight_over_http` | A real second connection holding the scope's lock makes the adapter answer `409 idempotency-key-in-flight` with `retry_after_s` | lock key computed over another array |
| `expired_entry_is_replaced` | An entry past 24 hours is neither replayed nor refused on, and is replaced; one just inside is honoured | retention widened; retention zero |
| `purge_removes_only_expired` | `purge_expired` deletes the expired entry and keeps the live one | retention widened; retention zero |
| `server_failure_is_not_stored` | A `5xx` is handed back unstored and its effect rolled back; a raising handler stores nothing; a retry runs again | `5xx` stored; `5xx` committed |
| `own_transaction_required` | Called inside a caller's transaction, the store refuses | the refusal removed |
| `isolation_is_pinned` | The handler runs at `READ COMMITTED` under a `REPEATABLE READ` session default | the pin removed |
| `header_is_validated` | Missing and empty keys are `idempotency-key-missing`; 15 and 256 characters, a space and a non-ASCII key are `malformed-request`; 16 and 255 pass; no refused request reaches the handler | the presence check removed; the length bound removed |
| `invalid_scope_is_malformed` | An oversized path or issuer, an empty subject and a non-ASCII subject are `400 malformed-request`, never a `500`, and reach no handler | the scope's `ValueError` left unhandled |
| `replay_is_marked` | Over HTTP, the replay carries `Idempotency-Replayed: true` and the first answer does not; the bytes, status and three headers are the same | the marker removed |
| `reuse_problem_over_http` | Over HTTP, reuse is a `409` problem with exactly `type`, `title`, `status`, `request_id` and `first_seen_at` in millisecond RFC 3339 `Z`, and nothing runs | the timestamp rendered as Python's default `isoformat` |
| `scope_is_unique` | Two entries of one scope are refused by `idempotency_record_scope_unique` | the constraint dropped |
| `table_guards_refuse` | A `5xx` status, a non-`POST` method, a malformed digest and an oversized body are each refused by their constraint | each constraint dropped |
| `table_holds_only_the_response` | The table's columns are exactly the listed ones, and a stored entry holds no byte of the request body | a column added |

The purge command is tested in `tests/test_purge_idempotency.py`, in the same suite: it deletes only expired entries, in batches of at most `--batch` (five expired entries in batches of two are deleted as 2, 2, 1, and live entries survive); a batch failing after another leaves the first batch's deletions committed; a row another transaction holds is skipped, not waited on, and deleted by the next purge; the command refuses without `--once`, with a batch outside 1–10,000, and inside a caller's transaction, deleting nothing; and its output is the line of counts, exactly.

Not proven here: behaviour under a real HTTP server, and the lock's interaction with connection poolers that do not keep one session per transaction. The intake acceptance drives the real Django route through the framework test client.

## 5. Conflicts with the conventions and the contract

These were reported, not resolved, by this increment. Contract 0.13.0 resolves the first three and the last: it declares `first_seen_at` and `Idempotency-Replayed`, carries the key's character rule as a `pattern` with `400 malformed-request` for a key outside it, and no longer counts the `POST` operations. The decoded-path item stays open.

- **`first_seen_at` is not in the contract.** Conventions §6 gives `idempotency-key-reuse` the extension member `first_seen_at`; the `Problem` schema of `contracts/core-api.openapi.yaml` does not declare it. The adapter emits it, millisecond RFC 3339 `Z`, because the `Problem` schema does not forbid extra members; the contract should declare it.
- **`Idempotency-Replayed` is not in the contract.** Conventions §8 and §14 put it on every replay; no response of the contract declares the header.
- **An invalid key has no problem type.** §8 bounds the key to 16–255 characters and names `idempotency-key-missing` for its absence only. The adapter answers `400 malformed-request`, the §6 type for a bad parameter, without `errors[]`, whose `pointer` addresses the body and cannot name a header.
- **The path is the decoded path.** `JOB_QUEUE.md` §3.4 pins a job key's `path` as the request path "exactly as it was received — percent-encoding untouched". Django exposes the path the WSGI server already decoded, and no portable raw path; the store keys on `request.path`, and a route deriving a job key must use the same value so the two stay paired.
- **The contract's count of `POST` operations differs.** The contract has 28 `POST` operations, as §8 says; the `IdempotencyKey` parameter description says 27. Not a behaviour of this store; noted for whoever edits it next.

## 6. Not done

- Two routes use the store, `createOrganisation` and `initialiseWorkspace` (§2.1).
- The shared store still fingerprints normalized request bytes, not the validated semantic request
  ADR-0020 requires for the durable operation tier. Each effect-bearing domain must implement that
  identity and fingerprint before its effect is admitted.
- The purge is batched and the command exists (§2.7); scheduling it is the operator's (cron). Until an operator schedules it, expired entries are inert until their key is reused or someone runs the command.
- A route must still authenticate and authorise before calling the adapter; nothing here checks that it does.
- `createOrganisation` alone supplies a stable reference in this increment: the canonical
  `realm_create` `Job.idempotency_key`. In-flight refusal precedes body comparison, so its
  prospective reference is present regardless of the contender body, while stored malformed and
  validation refusals and all other excluded outcomes remain headerless. The replay table gains no
  column.

## Changelog

- First version: the replay store of `../api/CONVENTIONS.md` §8 in `core.idempotency`, its HTTP adapter in `core/api/idempotency.py`, and the acceptance checks with one mutant or more each.
- After review: `408` and `429` are not stored; an out-of-bounds scope is `malformed-request`; handler effects must stay in the database, external effects going through the outbox; the query string is outside the scope and the fingerprint; invalid JSON may collide harmlessly; the purge must be scheduled and batched before the first route; checks for per-key scoping, forced lock-key collisions and transient refusals.
- §5 records which of its reports contract 0.13.0 resolved: `first_seen_at`, `Idempotency-Replayed`, the invalid key's `malformed-request` and the operation count; the decoded-path item stays open.
- The purge is batched — at most `--batch` entries per `DELETE`, each batch committed before the next, locked rows skipped — and run by `purge_idempotency --once`; scheduling it is the operator's (§2.7).
- Records ADR-0020's two-tier boundary: this component is the 24-hour response receipt, while an
  effect-bearing domain owns durable semantic operation identity and deduplication.
- Adds the optional, validated route reference boundary and the intake's bounded outcome rules;
  the generic adapter remains domain-neutral when no reference is supplied.
