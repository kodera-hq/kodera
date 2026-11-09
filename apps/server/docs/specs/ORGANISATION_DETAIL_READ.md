# Customer organisation detail read

Status: Admitted bounded runtime implementation; source acceptance is not deployment.

## Runtime boundary

`GET /api/v1/organisations/{organisation_id}` implements the customer-only subset
of `getOrganisation`. It consumes the existing configured public-key trust and
issuer-bound identity and membership selectors. This specification does not ratify
the broad Proposed authorization documents. The OpenAPI staff capability remains
unimplemented in this runtime: staff requests are refused. List, mutation, intake,
bootstrap, billing defaults and Console wiring are outside this slice.

An eligible enabled, non-deleted person and identity must have a current,
non-deleted, accepted active membership in the identity's organisation. Each of
`org_owner`, `org_admin`, `org_billing` and `org_member` may read. Organisation state
must be `active` or `suspended`, without a deletion marker. Token role/contact
claims and request-selected organisation headers confer no authority. The path
is checked against the resolved identity organisation; another membership or
identity belonging to the same person does not broaden the token's scope.

## Representation and conditional requests

The JSON representation contains exactly the persisted `id`, `slug`, `name`,
`state` and `created_at`. Unknown optional fields are omitted, including commercial
defaults. Neither identity data nor internal/deletion fields are exposed. Timestamps
are RFC3339 UTC with millisecond precision; JSON uses sorted keys, compact separators and unescaped Unicode.

The strong ETag is the quoted SHA256 of those canonical fields plus the stored
`updated_at` at full stored precision, following API conventions section 10. A timestamp-only update changes
the ETag even when the visible JSON stays the same. This resource does not inherit
`/me`'s timestamp-free computed-projection exception. GET handles exact, weak,
comma-list and wildcard `If-None-Match` after current authentication, authorization
and the complete coherent projection. A match returns empty304 with ETag. Denials
never carry an ETag or become304. Every routed response carries `Cache-Control:
no-store` and `X-Request-Id`; a caller's id is namespaced or replaced by a new UUIDv7 as
`docs/api/CONVENTIONS.md` §9 says.

## Refusals

| Condition | Status and registered problem |
|---|---|
| Missing/invalid bearer, untrusted issuer |401 `unauthenticated`, with Bearer challenge |
| Verified bearer, unresolved/disabled/deleted identity or person |403 `identity-unknown`, no Bearer challenge (contract 0.28.0) |
| Staff, absent/ineligible grant, prospect/closed/deleted own organisation |403 `forbidden` |
| Foreign or unknown target UUID |404 `not-found`, identical shape |
| Any routed method other than GET |405 `method-not-allowed`, `Allow: GET` |
| Database/service failure, including a pre-existing transaction |500 `internal-error` |

Problems use the existing namespace `https://kodera.io/problems/` and contain
`type`, `title`, `status`, `request_id` (plus `allowed` on405). They contain no SQL,
exception text, token, subject or customer fields. Non-GET method refusal precedes
authentication. Identity eligibility precedes target matching, which precedes
grant resolution; the order cannot disclose foreign-row existence. Malformed UUID
segments and unimplemented routes remain outside this routed handler. Wider rate
limiting and staff audit infrastructure are not implemented by this slice.

## Transaction boundary

The service owns one explicit `REPEATABLE READ READ ONLY` transaction and refuses
a nested transaction instead of inheriting a potentially earlier snapshot. The
identity SELECT is the first snapshot-acquiring statement. Grant and scoped
organisation data are read from the same snapshot, and immutable materialized
values leave it; no lazy queryset escapes. A revocation committed before the first
SELECT denies the request even if BEGIN already ran. A revocation or data change
committed after snapshot acquisition takes effect on the next request; an in-flight
read may return the coherent earlier authorized state.

## Runnable acceptance

Use the installed project environment with an explicitly owned synthetic local
PostgreSQL database. No runtime settings, schema guards, migrations or shared
resources are changed. Infrastructure credential environment variables must be
absent, as required by the existing settings guard.

```sh
python -m pytest tests/test_organisation_detail.py tests/test_organisation_detail_transactions.py
python dev/mutate_organisation_detail.py --report /absolute/owned/evidence/mutations.json
```

The tests exercise all roles, multi-organisation isolation, lifecycle refusals,
staff/method refusal, exact fields, timestamp-sensitive ETags, authorization before
conditional matching, request IDs, safe failure and unchanged persisted rows.
Deterministic two-connection barriers prove snapshot acquisition and coherent
projection with a fresh reader login. That login has SELECT on the four required
authority tables only, no privileged role attributes, no schema creation or
temporary-table capability, and no public application-function execution. Fixture
ACL changes are limited to its disposable pytest database and restored on teardown.
Separate explicit READ WRITE probes must fail with42501 for INSERT, UPDATE, DELETE
and TRUNCATE on every authority table, plus persistent/temporary table creation;
a READ ONLY25006 rejection is not privilege evidence.

The mutation runner independently removes issuer-path scoping, current-grant
checking, field whitelisting, timestamp input, authorization-before-conditional
handling, repeatable-read isolation and read-only transaction mode. Each case runs
an intact positive control in an isolated copy, then requires the named semantic
assertion at pytest exit1; syntax/import/setup failures cannot qualify. The runner
is an explicit local acceptance command; existing CI discovers the endpoint and
transaction tests without workflow changes.
