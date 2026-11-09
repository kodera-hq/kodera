# One-step workspace creation, billing off

**Status:** Proposed · **Owner:** API seat

Payments come later; a working product comes first. On a deployment that does not bill, an
organisation's owner creates its workspace in one step, like opening a Discord server: a name, an
address, one button. This document is Core's part of that change. It grows one section per slice:
§2 is the billing switch (slice C1), §3 the agreements recorded without an order and the workspace
guard that reads them (C2a), §4 the `createTenant` operation (C2b), §5 the operator's `tenant_status`
command (C3).

## 1. What changes for a deployment that bills

Nothing. `KODERA_BILLING_ENABLED` unset means billing on, and every billing path answers as it
did. The status summary gains two members, `billing_enabled: true` and
`workspace_pack_code: null`. `createTenant` answers `409 billing-enabled`.

## 2. The billing switch (C1)

### 2.1 The setting

`KODERA_BILLING_ENABLED` is `true`, `false` or unset; unset (or empty) means `true`. Any other
value stops the process at start, naming the variable (`config/environment.py`
`billing_enabled`). Every profile that serves, settles or tests parses it itself — `deploy`,
`deploy_operator`, `customer_http` (and so `e2e`), `job_queue` — because
`deploy_operator` does not inherit `base`. `base` sets `True` for the profiles that read no
environment, and `test` pins `True` whatever the environment says; a test turns it. Code reads it from `settings` at call time (`apps/billing/switch.py`), so a test can
turn it.

### 2.2 What billing off refuses

With `KODERA_BILLING_ENABLED=false`, nothing that charges runs, and nothing is written:

| Operation | Answer |
| --- | --- |
| `placeOrder` | `409 billing-disabled` |
| `createPaymentLink` | `409 billing-disabled`; no provider is called |
| `manage.py settle_complimentary_order` | exits non-zero, `billing is disabled on this deployment; nothing written` |

The refusal comes after the caller is judged: 401 without a token, then 403 or 404 exactly as
billing on answers them, each audited as before. An answer the replay store already holds under
the key is replayed whatever the switch says (CONVENTIONS.md §8). The refusal itself is **not**
stored against the `Idempotency-Key`: once billing is on again, the same request is judged on its
merits. Read routes (orders, invoices, payment links, the catalogue, the legal documents) keep
answering.

The services refuse too (`place_order`, `issue_link`, `settle_complimentary`), so no future caller
can charge past the switch.

**The switch stops new charges only.** An order placed before it keeps its course: its
cancellation and credit note, its lapse (`cancel_unpaid_orders`), the confirmation mail, and a
payment link still active at the provider. Turn billing off only once no order is `placed` or
`awaiting_payment`; staging has none (no order can complete there).

### 2.3 One source for the console

`GET /organisations/{id}/status-summary`, which the console's home already reads, serves:

- `billing_enabled` — the switch, so the console never carries a build variable that could drift
  from Core;
- `workspace_pack_code` — with billing off, the pack an unbilled workspace is created on
  (`workspace`, `apps/billing/switch.py` `UNBILLED_PACK`), so the console reads the documents in
  force for it and never names a pack itself; `null` while billing is on.

### 2.4 Acceptance

`tests/test_billing_switch.py`, against PostgreSQL:

1. Unset or `true`: the switch reads on, and the status summary says `billing_enabled: true`,
   `workspace_pack_code: null`. The billing suites pass unchanged.
2. `false`: `placeOrder` with a valid body answers 409 `billing-disabled`, and the counts of
   Order, Tenant, Invoice, Acceptance and stored replays are unchanged; a retry with the same key
   after billing is turned back on is judged afresh and creates the order, and an order stored
   before the switch is replayed after it. `createPaymentLink`
   answers 409 and calls no provider. `settle_complimentary_order` exits non-zero and writes
   nothing. The summary says `billing_enabled: false`, `workspace_pack_code: "workspace"`.
3. A member placing an order with billing off still gets 403, not 409.
4. Any value other than `true`, `false` or empty is refused, naming the variable.

A mutation that flips the default to off fails case 1.

## 3. The agreements without an order, and the workspace guard (C2a)

### 3.1 The record

On a deployment that does not bill, the owner accepts the CGV and the DPA when the workspace is
created, with no order. `record_agreements` takes `order_id=None` and the tenant the workspace is
created with; each `Acceptance` then names that tenant (`tenant_id`) and no order. With an order,
an acceptance names the order only, as before. The database holds both rules
(`apps/legal/migrations/0004_acceptance_tenant.py`): exactly one of `order_id` and `tenant_id` is
set (`legal_acceptance_order_or_tenant`), and a document version is accepted once per tenant
(`legal_acceptance_once_per_tenant`). The `dpa.accepted` audit row carries `order_id: null`.
`record_agreements` refuses a tenant of another organisation. It checks this in code, not with a
foreign key, because a key would keep the tenant row from its own purge: an acceptance is kept
longer than the tenant.

### 3.2 The guard

No workspace before the customer's CGV and DPA are accepted (the G1 ruling). Both workspace
operations, `getWorkspace`'s `can_initialise` and `initialiseWorkspace`, now ask
`has_accepted_agreements` (`apps/legal/services.py`), true when either:

- **with an order**, as before: an order not cancelled whose DPA is accepted
  (`has_committed_order`); or
- **without one**, as a deployment that does not bill records them: acceptances with no order of
  **both** `cgv` and `dpa`, naming the **same** tenant of the organisation that is not `deleted`
  (`apps/tenancy/selectors.py` `tenants_not_deleted`), the DPA still `accepted`. The branch reads
  the same with billing on, so an organisation that created its workspace unbilled keeps it.

The second branch reads the acceptances, never the DPA's `tenant_id`: the paid path names the
tenant on the DPA too, so a cancelled order whose tenant has moved past `ordered` would otherwise
count. For it, the API writer role gains `SELECT` on `legal_legaldocument`, which is public. On
`legal_acceptance` it gains `SELECT` on only the columns that say what was accepted, for which
tenant and DPA: never who accepted, nor from where (`dev/api_writer_role.py`).

### 3.3 Acceptance

`tests/test_accepted_agreements.py` and `tests/test_workspace_writer_role.py`, against PostgreSQL:

1. The paid path is unchanged: the order suites and the workspace onboarding suites pass unedited,
   and an order's acceptances name no tenant.
2. An unbilled acceptance names its tenant and no order; one with both or neither, or a second of
   the same document for one tenant, is refused by the database.
3. The guard is false:
   - with nothing accepted;
   - with the CGV alone, or the DPA alone;
   - with the CGV for one tenant and the DPA for another;
   - with a DPA that is not `accepted`;
   - for a deleted tenant;
   - for a cancelled order whose tenant moved to `provisioning`.

   It is true for both agreements accepted for a live tenant, and for an order as before.
   `record_agreements` refuses another organisation's tenant.
4. The workspace is initialised on agreements accepted without an order, through the real views
   and under the API writer role. Under the role, an organisation with nothing accepted still reads
   `can_initialise: false` and is refused 409.

## 4. `createTenant` (C2b)

`POST /api/v1/organisations/{organisation_id}/tenants`, the owner's one step to a workspace on a
deployment that does not bill. The service is `apps/billing/unbilled.py`, beside the switch and
`placeOrder`, since it is the other way a tenant is created; its route is
`apps/billing/api/create_tenant.py`, which the tenants path dispatches `POST` to.

### 4.1 The request and the answer

The body is the contract's `TenantCreation`: `name` (1 to 200 printable characters), `slug`,
`locale` (`fr` by default) and `legal_acceptances`, the CGV and the DPA once each, each at the
version the screen showed. The answer is `201` with `{tenant, workspace_id}` and
`Location: /api/v1/tenants/{id}`, through the replay store: the same key and body replay it, and
another body under the key is `409 idempotency-key-reuse`.

### 4.2 Who, and in what order

Owner only: the request accepts the customer's agreements (`docs/api/AUTHZ.md` §5). Checked in
this order; a stored answer is replayed, an unstored refusal is judged afresh on retry:

| # | Check | Answer | Stored |
|---|---|---|---|
| 1 | The caller is not the owner | `403`, recorded as `authz.denied` with `tenant:create`, for another member's role and for a staff token; `404` for anyone else | no |
| 2 | Billing is on | `409 billing-enabled`; an answer already stored under the key is replayed first | no |
| 3 | The body is not a JSON object, or not of the contract's shape | `400`, or `422` naming each member | yes |
| 4 | Under the organisation lock: the caller, read again, is no longer the owner; the switch, read again, is on | as checks 1 and 2 | no |
| 5 | The organisation is not `active` | `409 invalid-state-transition`, `allowed_states: [active]` | yes |
| 6 | Its setup is not `ready` | `409 invalid-state-transition`, `allowed_states: [ready]` | yes |
| 7 | It holds a tenant that is not `deleted` | `409 tenant-exists` | yes |
| 8 | The offer is not configured: the pack not on sale, its tier missing, or no CGV or DPA in force for the locale sent | `503 service-unavailable`, `Retry-After: 60` | no |
| 9 | The slug fails the pattern or is reserved | `422` at `/slug`, code `format` | yes |
| 10 | A tenant holds or held the slug | `409 slug-taken`, with up to three free `suggestions` | yes |
| 11 | The DPA, then the CGV, sent at a version not in force | `422` at `/legal_acceptances`, `dpa_not_in_force` or `cgv_not_in_force`, the version in force in `detail` | yes |

Check 1 runs before the replay store, so a caller who lost the role is never served a replay.
Check 4 runs again inside the step because the agreements are signed on the caller's authority:
an owner demoted while the request waited for the lock signs nothing. It also catches a stored
answer that expired between check 2 and the store's own look.

The organisation lock is the first statement of the step, before check 4, so of two creations at
once one is `201` and the other `409 tenant-exists`, whatever their slugs. The database lets an
organisation own more than one tenant, as the domain model does; this lock is the one-workspace
rule's only guard.

### 4.3 What it writes, in one transaction

1. The tenant, `ordered`, on the unbilled offer of `apps/billing/switch.py`: pack `workspace`, tier
   `S`, the pack's applications and profile, the organisation's realm.
2. The DPA for that pack and the tenant: an unaccepted one from the template in force is reused,
   older ones are superseded (`apps/legal/services.py` `prepare_dpa`, `generate_dpa`'s write).
3. The CGV and the DPA checked and accepted for the tenant, with no order (§3.1), with the server's
   clock, the truncated client IP and the user agent; audit `dpa.accepted`.
4. Audit `tenant.ordered`, metadata `{slug, billing: "off"}`.
5. The starter workspace of `initialiseWorkspace`, its audit `workspace.initialised` and the next
   channel set. A workspace the organisation already has, left by an earlier order cancelled after
   it was initialised, is kept as it is, named in the answer, and nothing is re-emitted.

It writes no order, subscription, invoice, billing profile or payment link, and no job. A refusal
after the first write rolls the whole step back: it runs in a savepoint inside the replay store's
transaction, and only the refusal's stored answer remains.

The API writer role gains `INSERT` on `tenancy_tenant`, `legal_dpa` and `legal_acceptance`,
`UPDATE` on the `legal_dpa` columns `prepare_dpa` and `record_agreements` set, and `SELECT` on
`billing_pack` and `billing_capacitytier` (`dev/api_writer_role.py`).

### 4.4 Acceptance

`tests/test_create_tenant.py` and `tests/test_workspace_writer_role.py`, against PostgreSQL:

1. Billing off, an active organisation with a ready setup and no tenant: `201`, and exactly the
   rows of §4.3, each read back, the channel-set head moved on, and no billing row.
2. A DPA already generated is reused; one from a template no longer in force is superseded.
3. The same key and body replay the first answer; another body is a reuse; a new key once a tenant
   exists is `409 tenant-exists`. None writes anything.
4. Each refusal of §4.2 writes nothing: a member who is not the owner, staff, a stranger, billing
   on, an organisation not `active`, a setup not `ready`, a bad or reserved slug, a taken slug,
   a stale CGV and a stale DPA, malformed agreements and bodies, the pack off sale and a template
   missing, an owner demoted after check 1, and billing on when check 2 was skipped. A member is
   refused `403` whatever the switch says.
5. Two creations at once, with different keys and slugs, make one tenant: one `201`, one
   `409 tenant-exists`. The first request to check for a tenant waits until it sees the other
   blocked on the organisation lock (`pg_locks`), and the test asserts it saw that, so it proves
   both were in before the first committed; with the lock taken after the check, or dropped, both
   pass the check and two tenants are written.
6. A workspace left by a cancelled order is kept and named.
7. Under the API writer role: the creation, superseding a DPA from an older template, its replay,
   `tenant-exists` and `slug-taken`.

## 5. The operator's `tenant_status` (C3)

Until the `provision` job runs, a person provisions the tenant and tells Core so. From the operator
image (`--settings config.settings.job_queue`):

- `manage.py tenant_status list [--state S]` prints one line per tenant, oldest first:
  `id slug organisation status apps created_at`. The lead learns of a new workspace with
  `--state ordered`.
- `manage.py tenant_status set --staff-identity <id> --tenant <id> --to <status> --reason <text>`
  moves one tenant, under a current `staff_operator` grant, by the rows of
  `docs/domain/TENANT_STATE_MACHINE.md` §3.1: `provisioning` (T2, or T5 from `failed`), `active` (T3 then T6),
  `failed` (T4), `deleted` (T21). It moves only a tenant no order ever named, the one `createTenant`
  creates: an order's tenant moves with its order. It prints one line, the statuses passed through
  and the staff identity, or refuses with the reason and writes nothing.

It is an **operator override for the pilot**: it does not check T2's, T5's or T6's guards, and records the
reason instead, on each transition's audit row (`tenant.provision_requested`, `tenant.ready`,
`tenant.activated`, `tenant.failed`, `tenant.deleted`, actor `staff`, metadata
`{from, to, override: true, reason}`). The reason is kept with the audit rows, under `standard`
retention: the operator writes the work done in it, never a person's data. Nor does it check the organisation's
state; the operator moves a tenant of a suspended organisation knowingly. The status and its rows commit in one transaction, under the
grant and the tenant row both locked. `getTenantStatus` reflects the move at once. The service is
`apps/tenancy/operator_status.py`, which, with its command, stays out of the API image.

A mistaken creation is deleted while it is still `ordered`. Once it has moved to `provisioning`, this
command has no way out for it: T21 runs from `ordered` only, the decommission jobs do not exist
yet, and the one-live-tenant rule (§4) stops the owner from creating another.

### 5.1 Acceptance

`tests/test_tenant_status_command.py`, against PostgreSQL, on a tenant `createTenant` created:

1. Each allowed move succeeds with its rows: `provisioning` then `active` writes three, in order;
   `failed` after `provisioning`, then `provisioning` again (T5); `deleted` for the unbilled tenant,
   whose slug stays taken.
2. Refused, naming the state it is allowed from, and nothing written: `ordered → active`,
   `ordered → failed`, `active → provisioning`, `provisioning → deleted`; any move of a tenant an
   order names; an unknown tenant; a blank reason, one over 500 characters, one with a control
   character.
3. Without a `staff_operator` grant: refused by the command, and by the service called directly.
4. A repeat is refused (`already active`).
5. `GET /tenants/{id}/status` reads each move at once, `failed` and `deleted` included.

And `list` prints the tenants oldest first, filters by state and refuses an unknown one.
