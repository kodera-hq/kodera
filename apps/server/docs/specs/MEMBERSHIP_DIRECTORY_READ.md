# Current membership directory

Status: Bounded local implementation; publication and runtime deployment held.
Owner: Core

## Contract and authority

`GET /api/v1/organisations/{organisation_id}/memberships` implements `listMemberships`, scope `membership:read`. Cryptographic customer verification precedes exact persisted enabled identity/person resolution, issuer-bound target comparison, current accepted active membership grant and owner/admin/member directory role. Billing and staff are denied. A verified person's identity in another realm grants no target authority. Active and suspended organisations remain readable under the existing grant policy. Every continuation rechecks current authority; cursors never grant access.

The operation owns one outer PostgreSQL READ ONLY REPEATABLE READ transaction and refuses an inherited transaction. Identity resolution is its first snapshot query. All membership/contact data is materialised before returning; serialization performs no ORM work. GET performs no writes, audit/session updates, provider calls or queue work.

## Population and projection

Only non-deleted invited, active or suspended memberships with a non-deleted person are listed. Removed and deleted relationships are excluded, including when filtered; `state=removed` is an empty successful page. Disabled people remain descriptive stored relationships, not evidence of provider access. Rows contain exactly id, organisation_id, email, display_name, role, state, created_at and updated_at. Public timestamps use UTC milliseconds. Unavailable person/identity IDs, source, account kind, MFA and last-seen facts are omitted. Email uses Django EmailValidator with an empty domain allowlist, maximum 320 characters, and no CR/LF; valid bytes are preserved. Invalid stored contact data causes a safe 500 rather than a fabricated value. Display names retain the nullable 200-character contract.

## Finite input and pagination

Only cursor, limit, role and state query keys are accepted, each at most once. Raw query strings are at most 2048 characters. Limit defaults 50; explicit ASCII canonical decimal 1–200 (no leading zero) is accepted. Roles and states use the contract enums; filters combine with AND. Empty/unknown/duplicate/oversized inputs refuse 400 after current authority. Targets require canonical hyphenated 36-character UUID syntax (case-insensitive). Malformed targets refuse 400 after authentication and identity resolution; foreign or unknown valid UUIDs refuse 404 before query validation.

The dedicated `KODERA_MEMBERSHIP_CURSOR_KEY` input is exactly 64 lowercase hexadecimal characters representing 32 bytes. Missing, wrong-type or malformed input causes safe 500 for the directory alone; there is no public/default/settings-secret fallback. Configuration stores the raw optional input without preventing other endpoints from starting. Tests use synthetic values only; this work provisions no key.

Cursor v1 is canonical unpadded URL-safe base64 over a 69-byte binary payload and 32-byte HMAC-SHA256. Payload fields are version 1, person UUID, organisation UUID, role index, state index, limit, last-returned membership UUID and initial eligible maximum membership UUID. A domain-separated MAC authenticates all payload bytes. Wire bound 512 ASCII characters is enforced before decoding; this format emits 135. Role/state index 0 means no filter. Payload contains no contact, subject or bearer data. Decoding requires version/shape/signature/canonical encoding, current person/org/filter/limit binding and last UUID no greater than ceiling. No expiry is promised; rotation invalidates prior cursors. A refreshed bearer for the same person remains valid.

Ascending immutable membership UUID keyset reads use limit+1 and the first page's eligible maximum UUID ceiling. `has_more` is true exactly when another eligible row was observed; only then is `next_cursor` nonnull, otherwise null. Inserts above the ceiling are excluded, deletions do not duplicate prior rows. Each page has its own coherent snapshot; no historical cross-page snapshot or arbitrary backdated-insert exclusion is promised.

## Responses and acceptance

Collections use no-store, correlation IDs and no ETag. Conditional headers always produce a fresh 200 or current denial, never 304. Non-GET methods refuse 405/Allow GET. Authentication/authority/input/unavailable responses are safe RFC 9457-shaped 401/403/404/400/500 bodies; SQL, secrets and identity facts are never reflected.

Runnable acceptance, using the existing frozen environment and an explicitly owned synthetic PostgreSQL database:

```sh
python -m pytest -q tests/test_membership_directory_http.py tests/test_membership_directory_pagination.py tests/test_membership_directory_transactions.py
python dev/mutate_membership_directory.py --report /absolute/owned/evidence/mutations.json
```

Acceptance includes independently seeded complete expected row sets; omissions; owner/admin/member positives and billing/staff/revocation negatives; malformed query/cursor/key bounds; exact page sizes and terminal behavior; tamper/rebinding/refresh controls; separate-connection snapshot barriers; actual READ WRITE SQLSTATE 42501 write refusals; query-free serialization; all-five-table unchanged snapshots; unchanged existing customer/detail regressions. Source mutation cases bind named semantic assertions for target, billing, grant, population, invented optional facts, cursor integrity/binding, conditional authority, snapshot isolation and READ ONLY. Image-source registration is an exact allowlist/inventory test only, not image qualification.

## Changelog

- Specify the current stored membership read, bounded continuation and local acceptance.
