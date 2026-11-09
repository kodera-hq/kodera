# Registered-factor signal

**Status:** Core consumer implemented locally; independent review pending · **Owner:** API seat (consumer, Core) · **Producer:** SRE seat (Keycloak)

How Core learns that a person has a **registered second factor**, the fact the contract's
`Identity.mfa_enrolled` names, and how long Core trusts it. Core now consumes the evidence for
`/me` and owner-claim authority; the Console fence and Keycloak producer remain separate work.

This document fixes the claim Keycloak emits, what Core verifies, and the clock rules. It is the
consumer half: the Keycloak producer (mapper or provider, required actions, rollout) stays with the
SRE seat and needs its own reviewed specification and acceptance. The consumer changes no API
contract or deployment asset.

## 1. Decided Core consumer contract

- Registered-factor meaning is kept. A current login's MFA evidence (`amr`) is authentication
  history: it is neither enrollment nor proof that the same credential still exists. Core never
  derives the registered-factor fact from `amr`, `acr`, the realm's policy or an admin API read.
- The signal is a signed, strictly boolean claim, `kodera_mfa_enrolled`, in the Console's access
  token, mapped only to the current subject's existing `/me` `mfa_enrolled` field. Other members'
  field stays omitted.
- Claim consumption requires both that signal (with the Console as `azp`) **and** the existing
  current-login `amr` value `otp`, keeping every existing issuer, audience, subject, organisation
  and contact check. `email_verified` must be the strict signed boolean `true`.
- Missing, false, wrong-type or unreadable evidence holds the guard. A failed read removes earlier
  true evidence.
- The maximum stale-registration window is **330 seconds**. The budget terms below are proof targets,
  not measured guarantees.

## 2. The claim (producer contract)

| Property | Rule |
|---|---|
| Name | `kodera_mfa_enrolled` |
| Type | JSON boolean. Never a string, number, list or null; emitted at most once |
| Token | The access token issued to the Console client, on every issue path: code exchange, refresh-token exchange and SSO/silent sign-in. Never read from the ID token or userinfo |
| Source | Computed from the realm's credential store at issuance. Never from a user attribute (a realm's user profile can let users write attributes; the `kodera-probe` realm import already enables unmanaged attributes), a session note, an identity-provider mapper or a hardcoded-claim mapper. The producer's acceptance proves that no other mapper on the Console client or its scopes emits this name, and that no delegated realm-management role can add one |
| Meaning of `true` | When observed, the subject has at least one **stored** credential of a **counted type**, including one an administrator provisioned. It is not proof of possession: possession is proven only by current-login `amr` containing `otp` together with the recent-login bound (§3). The realm runbooks (identity realm tooling `REALMS.md`) never provision an OTP credential for a user |
| Counted types | Local TOTP is the only counted type in v1. The organisation realm's browser flow is password then OTP, both required, and the current login must carry the exact `amr` value `otp`. WebAuthn, passwordless passkeys, security keys and upstream-provider MFA do not count in v1 |
| Observation | The observation age plus the producer's clock and rounding uncertainty against Core is at most `S = 30 s` before `iat` |
| Failed read | The claim is omitted. A failed read never emits `false` (which would mean "no factor") and never re-emits an earlier `true` |
| Removal or reset | The next issued token reflects it. Tokens already issued stay trusted only until their horizon `H` (§4) |

**Test-only exception.** The local end-to-end stack's organisation realm (`dev/e2e/realms/e2e-pilot.json`)
emits the claim from a hardcoded-claim mapper, `e2e-test-only-registered-factor` (boolean `true`,
access token only), because the stock Keycloak image it runs has no producer. It is never a
producer of record. It holds there only: that realm's browser flow requires an OTP of every user,
and its Console client has no direct-access grant, so every Console token it issues belongs to a
user with a stored OTP credential (`dev/e2e/make_trust.py` refuses the realm otherwise).

Core cannot verify `S`. The producer's evidence is the measured observation-to-`iat` interval across
the three issue paths, including any cache, clock and rounding precision, deletion or reset, and read
failure.

**Federation.** A user brokered through Google, Microsoft or another upstream provider must register
local TOTP and use it for the current Keycloak login before consuming a claim. Upstream MFA does not
substitute for local enrollment or the signed `otp` authentication evidence.

## 3. What Core verifies

The access-token verifier (`services/identity/access_tokens.py`) adds two facts to
`VerifiedAccessToken`, without changing whether a token verifies:

- `authorized_party`: the `azp` claim if it is a string, otherwise `None`.
- `mfa_enrolled`: the `kodera_mfa_enrolled` claim if it is exactly a JSON boolean (`type(x) is bool`;
  JSON `1` loads as `int`), otherwise `None`. A malformed claim does not invalidate the token. The
  existing `email_verified` reader, which rejects the whole token on a malformed value, is not the
  model here. A duplicated key still rejects the whole token, as every duplicate does today.

The expected `azp` is trusted configuration (one setting, compared exactly), not the literal
`console`: the Console's client ID is deployment configuration. Unset, the fact is never true.

The **registered-factor fact** is true only when all hold:

- the lane is `customer` (defence in depth: `/me` and consumption already refuse staff before reading the fact, so no row can isolate it);
- `email_verified is True` as a strict signed boolean;
- `mfa_enrolled is True`;
- `authorized_party` equals the configured Console client;
- the current-login `amr` contains the exact value `otp`;
- `iat ≤ now + 2 s`: a token issued in the database clock's future is unknown, and Core counts it in a metric that carries no token claim;
- `now < H` (§4).

Otherwise the fact is unknown, which every guard treats as not enrolled.

### Readers

- **`GET /me`.** `mfa_enrolled` appears only on the `identities[]` entry of the token's own
  `(issuer, subject)`:
  - `true` when the fact is true;
  - `false` when the claim is a valid `false` and every other condition holds;
  - omitted otherwise.

  `read_customer` takes one `database_now()` inside its existing REPEATABLE READ transaction and
  passes the fact to the serializer, which keeps its "no inferred MFA" rule (the value is copied,
  never computed); the content ETag changes at `H` on its own.

  `/me` is readable only with an active or suspended membership. A first owner of a prospect
  organisation gets `403` from `/me`, so the claim page cannot preflight the field; consumption's
  `mfa-required` is that person's only signal.
- **Other surfaces stay omitted.** `listMemberships`' `mfa_enrolled` (other members) and
  `BootstrapCallerAssurance.mfa_enrolled` are not filled from this signal.
- **Claim consumption** (`apps/orgs/claim_consumption.py`, `_facts`) refuses with the existing
  `mfa-required` unless the registered-factor fact is true **and** the current-login proof holds.
  - The v1 customer set is exactly `{"otp"}`. Broader staff authentication values in
    `apps/identity/staff.py` do not widen this claim-consumption rule.
  - Current-login `amr` is session-scoped: Keycloak repeats the session's original `amr` on
    refresh and on every SSO sign-in, for up to the session's lifetime. Consumption therefore also
    requires a **recent authentication**: a signed integer `auth_time` with
    `auth_time ≤ now + 2 s` and `now − auth_time ≤ 320 s`, both inclusive
    (`RECENT_AUTHENTICATION_BOUND_S`). The ceiling is 330 s: 300 s plus the verifier's 30 s leeway
    granted once more for provider clock skew. The bound reserves the commit-lag budget
    `C = 10 s` of §4 (`COMMIT_LAG_BUDGET_S`) out of it, so a commit lands within 330 s of the
    login while the read-to-commit lag stays within `C`, a target that is not enforced (§4).
  - The **same** bound applies at the decisive read (the same `database_now()` read as the fact)
    and at the final read before COMMIT: `_facts` lowers the horizon `H` that the post-write read
    checks (§4) to `auth_time + 320 s`. A late claim is therefore refused at the decision, a
    deterministic `403 mfa-required`; only a login that crosses 320 s between the two reads answers
    `503` with nothing committed, like `H` itself. The commit stays one transaction: crossing rolls
    it back.
  - The verifier never refuses a token over `auth_time`: it keeps the signature check and carries
    any signed JSON scalar unjudged (a container as absent). The policy is this guard's alone, on
    the database clock: a missing, non-integer (string, float or boolean) or more than 2 s future
    `auth_time`, or an older one, refuses with the same `403 mfa-required`, never `401`. Each is
    counted by `observe_recent_authentication_reason`, whose closed enum is `auth_time_missing`,
    `future_auth_time` and `stale_authentication`.
  - The Console makes that login for this step: its owner-claim authorization request alone
    carries `max_age=0`, so every claim forces a new sign-in; ordinary sign-ins do not.
  - **Dependency.** Core bounds the login's age, not which factors that login ran. The guard
    relies on the organisation realm's flow re-running OTP on every re-authentication, so that a
    recent `auth_time` comes with a freshly executed `otp`.
    - The realm configuration is held by realm-apply's `check` on identity realm tooling main
      (`tools/realm-apply.sh`): it refuses an organisation realm whose browser-forms step
      `auth-otp-form` is not `REQUIRED`.
    - The behaviour was proven on real Keycloak 26.0.7 by a recorded run of the lab case
      `max_age-0-reauth`, added by identity realm tooling #59 under `tools/lab/mfa/`: from an existing SSO
      session, a `max_age=0` sign-in showed the OTP page, moved `auth_time` and yielded
      `amr == ["pwd", "otp"]`. It is a manual lab run, not CI; the SRE re-runs it as lab GO item 3.
    `/me`'s `mfa_enrolled` does not read `auth_time`.

## 4. Clock handling

The budget is `S + min((exp − iat) + L, A) + C ≤ 330 s`:

| Term | Value | Meaning |
|---|---|---|
| `S` | 30 s | Producer observation age and clock/rounding uncertainty (§2). `iat ≤ now + 2 s` (§3) detects forward skew above 2 s while a token is young and counts it; it does not bound the trust extension, which stays the producer's guarantee. A producer clock more than 2 s ahead withholds the fact until the gap passes |
| `L` | 30 s | Core's existing verifier leeway on `exp` |
| `A` | 290 s | Core's cap on trust after `iat`, whatever the token lifetime. Core has no maximum `exp − iat` today; this caps it for this fact only |
| `C` | 10 s | Check-to-commit lag: from the decisive clock read to the COMMIT that makes the effect visible. An unmeasured target |

`S + A + C = 330`. The proposal's `A = 300, C = 0` is not used: a decision commits after it is
checked, so `C` is never zero, and any positive `C` is paid out of `A`.

The **horizon** is `H = min(exp + L, iat + A)` = `min(exp + 30, iat + 290)`. Core refuses the fact
**at or after** `H`. With the default 300-second access-token lifetime, `iat + 290` binds: a token aged
290 to 330 seconds still verifies while the fact is unknown. The Console renews 120 seconds before
`exp`, so this dead band is normally unused. The producer specification either keeps the Console
client's lifetime at or below 260 seconds, so that `exp + 30` binds, or accepts the band.

Core's clock is the database clock, `clock_timestamp()`, read through `database_now()`
(`apps/orgs/claim_readiness.py`), the reader claim expiry already uses. It is not `now()`, the
transaction start. Every read of `H` goes through `database_now()`, which is the seam tests patch.
No new clock source, header or endpoint is introduced.

### Where consumption reads the clock

1. **Decisive read.** In `fresh()`, the existing `now = database_now()` that follows `_context` and
   `_bound_role` is the decisive read: it comes after every lock the decision takes. `_facts` moves
   to immediately after it and uses it, before the expiry transition, so the refusal order stays
   contact-unverified, then `mfa-required`, then the terminal claim states, and a caller without the
   fact never writes the `expired` transition.
   - Every one of those locks is non-blocking (`NOWAIT`, `try_lock`, `pg_try_advisory_xact_lock`).
     Contention answers `503 service-unavailable` at once and never waits past `H`.
   - Queue delay before the request reaches those locks is what the decisive read measures.
2. **Post-write read.** In the replay store's final authority, which runs after the replay-record
   insert and is the last statement before COMMIT (`core/idempotency/store.py`, `_execute`).
   Consumption passes that `final_authority` to `respond_once`. The callback acts only on
   `FinalAuthority("fresh_success")` and does nothing for `successful_replay`, `key_reused` and
   `in_flight`, which `respond_once` also reports.
   - If this read is at or after `H`, the callback raises `ConsumeGuardError("service-unavailable")`.
     It escapes `run_once`'s atomic block, which rolls back every write: the claim, membership,
     reservation, activation, audit rows and the replay record. `consumption_operation` re-raises it
     without a denial audit, and the view answers 503 with `Retry-After`. Any other exception would
     surface as another status.
   - The answer is `503 service-unavailable`, which is not stored, so a retry with the same key runs
     again and then refuses with `mfa-required`.
   - Raising this refusal from inside `fresh()`'s `try` is forbidden: `fresh()` turns it into an
     answer the store keeps, and the effect would commit.
3. **Replay and metadata paths.** `authority()` calls `_facts` on `ReplayAuthority` (status below 400)
   and on `MetadataAuthority` (`in_flight`, `key_reused`). Each of those uses one `database_now()`
   taken after `_bound_role`, the last lock on that path. `_facts` keeps its current precedence there: a caller without
   the fact gets `mfa-required` before `in_flight` or `key_reused`.
4. **What bounds `C`.** Only the COMMIT remains after the post-write read. `statement_timeout` bounds
   statements, not the transaction, and a COMMIT cancelled while waiting on synchronous replication
   is still committed locally. `C = 10 s` is a target that acceptance row 16 observes; it is not
   proven.

A `403 mfa-required` is stored and replayed under its Idempotency-Key, like every 4xx. After a token
renewal the Console retries consumption with a new key.

Logout does not invalidate an issued token at Core: a token stays usable until its own `exp` plus
leeway, and the registered-factor fact until `H`.

## 5. What the bound covers, and Console obligations

The 330-second bound is enforced **only at Core's decisions**: claim consumption, and `/me`, which
drops the field at `H`. Once the Console holds a `/me` answer, no deadline reaches it. Deadline
propagation to the Console stays open, so the Console's guard is advisory and Core's consumption
check is the authority.

The Console (separate work):

- reads `mfa_enrolled` only from the `identities[]` entry matching its own token's `iss` and `sub`,
  and never from the ID token;
- on token replacement, retires the previous `/me` query and any promise or route authority derived
  from it, fences late responses, and fetches `/me` with the current token before reopening a guard
  that reads the field. Invalidation alone is insufficient;
- treats a failed or aborted `/me` read as clearing an earlier `true` to unknown.

Today a successful renewal keeps the Console's cache by design
(`kodera-console` `docs/specs/oidc-reload-bootstrap.md`); that changes for this field when the Core
reader ships.

## 6. Acceptance for the Core implementation

Every guard has at least one row that fails when that guard alone is removed. Tests drive the clock
by patching `database_now()`; a real-time sleep is not acceptance.

| # | Token and clock | Expected |
|---|---|---|
| 1 | Signed `email_verified=true`, claim `true`, configured Console `azp`, `amr` contains `otp`, before `H` | Consumption proceeds; `/me` shows `true` on the token's own identity only |
| 2 | Claim missing | `mfa-required`; `/me` omits the field |
| 3 | Claim `false` | `mfa-required`; `/me` shows `false` |
| 4 | Claim `"true"`, `1`, `null`, `[true]` | `mfa-required`; `/me` omits the field; the token still verifies |
| 5 | Claim duplicated | The token is refused, as any duplicate is |
| 6 | Claim `true`, `azp` missing, another client, or a near-miss of the configured ID | `mfa-required`; `/me` omits the field |
| 7 | Claim `true`, no exact `otp` in `amr` | `mfa-required`: enrollment is not current-login proof |
| 8 | `amr` contains `otp`, claim missing | `mfa-required`: no `amr` substitution |
| 8a | Every other fact valid, but `email_verified` is absent or false; separately, it has a malformed type | Contact refusal for absent/false; the existing verifier returns 401 for a malformed type; no MFA fact substitutes for verified contact |
| 9 | Lifetime 200 s (`exp + 30` binds), clock at `H − 1 s` / at `H` | Proceeds / refused |
| 10 | Lifetime 600 s (`iat + 290` binds), clock at `iat + 289` / at `iat + 290` | Proceeds / refused, although `exp` is in the future |
| 11 | `iat = now + 5 s` | `mfa-required`; `/me` omits the field |
| 12 | `/me` with a valid `true` and with a valid `false`, clock at `H` | The field is omitted in both |
| 13 | Clock past `H` only at the post-write read | `503`, nothing committed or stored; a retry with the same key refuses with `mfa-required` |
| 14 | Replay of a stored `200` with a token past `H` or without the claim; `key_reused` without the claim; `in_flight` driven by calling `authority(MetadataAuthority("in_flight"))` directly, since the organisation lock answers a concurrent consume with 503 first | `mfa-required`, no effect and no stored answer; one denial audited |
| 15 | Two identities of one person, token for one; a prospect first owner | `/me` shows the field on that identity only; the prospect owner gets `403` from `/me` and the decision at consumption |
| 16 | Measurement, not a gate | The interval from the post-write read to COMMIT is recorded in CI, so `C` is observed |
| 17 | Every other fact valid, `auth_time` at `now`, `now − 320 s` / `now − 321 s` | Proceeds / `mfa-required`, counted `stale_authentication` |
| 18 | Signed `auth_time` absent, a string, a float or a boolean; separately `now + 3 s` and `now + 40 s` | `403 mfa-required` over HTTP, never `401`, counted `auth_time_missing` / `future_auth_time`; no effect |
| 19 | Recent at the decisive read (`auth_time + 301 s`); post-write read at `auth_time + 331 s` or `+ 320.5 s` / `+ 319 s`, with `iat + 290` still ahead | `503`, nothing committed or stored / proceeds |
| 20 | Replay of a stored `200`, and a changed body under its key, with a fresh `iat` but `auth_time` older than 320 s | `mfa-required`, no `Idempotency-Replayed`, no `first_seen_at`, receipt unchanged |

## 7. Where it lands, and what stays open

- Verifier facts: `services/identity/access_tokens.py`. `/me`: `apps/identity/**`. Consumption:
  `apps/orgs/claim_consumption.py` and its `respond_once` call, which need lead approval before an
  identity lane changes them.
- This PR makes no contract change. `Identity.mfa_enrolled` is already defined.
- Open, with the SRE seat:
  - the producer (computed from the credential store) and its acceptance;
  - the measured observation-to-`iat` interval;
  - the Console client's token lifetime;
  - the organisation-realm local-TOTP flow and brokered-user enrollment path;
  - evidence owed for the recent-login guard's dependency (§3): identity realm tooling #59, which adds
    the lab case `max_age-0-reauth`, is merged, and the SRE's lab GO (item 3) records its run;
  - rollout.
- Until the producer ships, the claim is absent, the fact is never true, and the guards hold. That is
  the safe default.

## Changelog

- First version. Specifies the signed registered-factor signal and bounded Core consumption.
- Freezes the delegated v1 consumer decision: strict signed `email_verified=true` and
  `kodera_mfa_enrolled=true`, Console-bound `azp`, current-login `amr` containing exact `otp`, a
  maximum 330-second freshness horizon, local TOTP only, and local TOTP for brokered owners.
- Narrows the session-scoped `amr` gap for claim consumption: a recent authentication, one bound
  of `auth_time` + 320 s at the decision and at the final read (330 s ceiling less the 10 s
  commit-lag budget), is required, and the Console's owner-claim sign-in requests `max_age=0`.
  `auth_time` policy moved from the verifier (`401`) to the guard (`403 mfa-required`). That a
  forced login re-runs OTP is the realm's flow: its configuration is held by realm-apply's `check`,
  and the behaviour was shown by a recorded run of the lab case `max_age-0-reauth`
  (identity realm tooling #59). `kodera_mfa_enrolled` is stated as a stored credential, not possession.
- Names the local end-to-end realm's hardcoded `e2e-test-only-registered-factor` as the one
  test-only exception to §2's source rule, and why it holds there.
