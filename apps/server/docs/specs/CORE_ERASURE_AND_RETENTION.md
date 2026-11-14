# Core erasure and statutory retention

Status: Source implementation under review with focused disposable PostgreSQL
qualification. Hosted checks and final independent review remain required before merge. No provider, live account or production erasure is authorised
by this document.

## Scope and authority

The workspace worker accepts a validated controller instruction reference, its
SHA-256 digest, an explicit recovery deadline and a current enabled
`staff_operator` identity. A reference/digest is evidence binding, not automatic
legal validation. No HTTP authentication, deletion endpoint, provider credential
or live adapter is introduced here. The existing HTTP deletion refusal remains
until a worker and its actual provider proof adapters are configured.

`privacy_begin_erasure` locks the organisation, refuses the default community,
requires active deliveries to drain, and captures the cutoff with the database
clock. It records an immutable detached `PrivacyErasure` journal, closes Core
organisation authority, disables scoped identities, revokes agent credentials and
expires every affected private export. Account archives containing the workspace's
members are conservatively revoked as well. The inventory preserves only attachment
UUIDs, affected private export UUIDs and their immutable original request expiry
evidence, plus exact extension receiver references
when that application is present; it does not retain document names, addresses,
endpoint URLs, content or provider secrets.

The cutoff and affected writes serialize on the same organisation row. Triggers
refuse post-cutoff document, collection, media, notification, identity,
membership, invitation, workspace, export, mail delivery and engine mutations.
Authority-revision-only fan-out remains possible so another organisation's activity
cannot resurrect or become blocked by the erased workspace. A shared person's
other active organisation/account remains usable.

## Actual Core erasure

At the explicit recovery deadline, the worker deletes collection rows and
collections, wikilinks and grants, Yjs journal bytes and snapshots, and document
children before parents. It deletes push outboxes before sealed subscriptions,
notification entries and attachment metadata. It scrubs scoped identity contacts,
unshared global person contacts, organisation contacts, intake sealing,
invitation contacts/tokens, support text and outbox sealing. It removes the mutable
billing profile and moderation report text and scrubs channel/category names.
Accounting and accepted contractual records are never selected by this tenant
purge. Scoped row counts and aggregate-only audit events commit with the deletion.
A refusal rolls the transaction back; resumption after a successful Core purge is
idempotent.

Remaining stable row identifiers support referential integrity and aggregate audit.
The subject mapping and engine sets are held only while the actual provider adapters
need them to resume remote erasure. Once all required external absence proofs are
present, the completion function removes scoped engine command/set/subject history
and credentials, clears outbox account identifiers and replaces the disabled Core
subject with its non-login tombstone. It then commits `complete` and an audit event.
It does not claim that pseudonymous audit or lawful statutory identifiers are
anonymous, nor erase records that have their own retention authority.

## External proof boundaries

Four domains are required even when their local inventory is empty: `matrix`,
`objects`, `identity_provider` and `private_exports`. A missing adapter never means
an empty complete source. `ErasureAdapter` is a trusted worker implementation,
not an HTTP request parameter. It must fence writes, erase the entire inventory,
perform fresh authenticated complete-scope absence readback and verify its proof.
The journal binds request, organisation, exact cutoff, inventory digest, adapter
revision, evidence digest and observation time. Wrong scope, revision, clock,
request or inventory refuses. No Matrix, object-store or identity-provider adapter
is configured by default. Synthetic adapter controls certify only local refusal
and completion logic.

Private export erasure must remove the entire `privacy/<request-uuid>/` subtree,
including frozen sources, manifests, chunks and archive, and revoke delivery.
Deleting only the final ZIP is insufficient. The separate private-volume runtime
provides its own concrete storage implementation and qualification. Admission refuses
missing/malformed legacy request bindings, a future creation time, or an original
window over 24 hours. The map preserves original `request_snapshot.expires_at`,
never a shortened current row TTL; its exact keys match the export UUID inventory.

When extension tables exist, `external_extension_receivers` becomes an additional
required domain. Its inventory names every installation UUID and the SHA-256 of
its canonical endpoint, including revoked installations and installations without
a completed delivery. The installed extension retention module must expose the
actual cutoff, bounded payload purge, payload-absence and post-proof metadata
teardown hooks. Missing hooks refuse. Actual native-document deletion can progress only when
bounded payload purge is complete and the definer reports actual scoped import
link absence (`native_documents_released`). This fact never proves receiver absence.
External receipts precede removal of import
mappings/reports, digest metadata and endpoint records; mappings are removed before
Core documents so their real `RESTRICT` foreign keys remain effective. Large
metadata batches can remain held and resume; no empty-success default is used.

Provider backups, disaster-recovery copies and statutory evidence require their
own authorised retention/erasure policies. Local source tests do not attest a
remote provider, native device, deployed role or complete production inventory.

## Exact statutory clocks

The authoritative product rule is [BILLING_MODEL](../domain/BILLING_MODEL.md),
including its [Code de commerce L123-22 reference](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006219327/).
This implementation follows that repository rule; it does not create a new legal
retention policy.

`FiscalPeriod` records the legal issuer's SIREN, explicit inclusive start and
exclusive closing instant, IANA timezone and authority reference. Overlap is
serialized and refused. The invoker fiscal trigger fixes its search path and binds
`pg_catalog.pg_timezone_names` and `public.billing_fiscalperiod` explicitly, including
when a separate admission LOGIN creates hostile TEMP shadows. Rows are immutable. There is no default calendar close,
no year inferred from an invoice number, and no automatic historical backfill.
The named closing instant is supplied by the responsible fiscal authority.

Invoice issue fixes its event to `issued_at`; every line receives the same event,
close and deadline atomically before numbering commits. Credit notes and their
lines receive their own issue event and containing fiscal period. A payment has
no accounting clock before its first recorded accounting event; its first
`last_event_at` fixes the clock. Clock fields never move on later reconciliation.
Each accounting deadline is exactly the containing fiscal close plus ten calendar
years in the fiscal timezone. Leap anniversaries use PostgreSQL calendar-year
arithmetic, not a fixed number of seconds or days.

The narrow contract-close function locks the exact linked order, subscription,
accepted DPA and document acceptances. It verifies organisation and tenant links,
current staff authority, acceptance chronology and a one-time close decision.
The subscription must already be cancelled and the order cancelled or fulfilled;
this retention write does not replace cancellation, credit or termination policy.
All receive the same `contract_ended_at`, ten-year UTC calendar anniversary,
closed reason and evidence reference, with `dpa.contract_closed` in that same
transaction. Open contracts have no invented end date/deadline. Staff is the
implemented close actor; tenant/system decision adapters are separate work.

Detached `StatutoryRecord` rows contain a frozen legal snapshot, source UUID/table,
organisation UUID without a foreign key, basis, exact clock and payload digest.
They survive tenant deletion. Neither tenant API grants nor mutable request state
can edit them. Existing issued rows with absent clocks remain explicitly
unqualified: the operator must register the actual fiscal authority and bind the
exact stored event through the narrow qualification command. A missing or
contradictory historical event refuses rather than being guessed. Legacy
qualification readiness must be checked before deployment.

A separate due-only purge function deletes a concrete source row and its detached
snapshot only after that row's deadline. Direct early deletion and snapshot edits
refuse. A later-lived credit, payment, rendered artifact or other foreign-key
dependency can hold a parent; the worker reports this and never rewrites the
parent's own deadline to conceal the dependency. Operators must clear each due
child and its own retained evidence in dependency order. Accounting/provider
reversal events and ancillary statutory evidence still require a complete reviewed
retention schedule; these fields are not a blanket qualification of every billing
or infrastructure evidence table.

## Operator source interfaces

`core/db/retention_worker_role.py` emits reviewable grants for a separate worker.
Its dedicated `kodera_retention_worker` namespace refuses HTTP, collaboration, shared,
system and owner aliases. Processing grants cannot create a cutoff, register a fiscal
period, close a contract or qualify historical records. A separate
`kodera_retention_admission` operator grant set owns those authority decisions.
The source emits no raw deletion, guard/context-table write or
infrastructure credential. Functions are `PUBLIC`-revoked, use a fixed schema and
finite lock/statement timeouts. Trigger exceptions use a private backend/transaction
context written only by those bounded functions, never a caller-settable GUC or
trigger disabling. Role creation and live grants remain operator actions.

The commands use explicit UUIDs, aware timestamps and evidence references:

```text
manage.py erase_core_workspace cutoff --organisation-id ... --actor-identity-id ...
    --instruction-ref DEL-100 --instruction-sha256 ... --purge-not-before ...
manage.py erase_core_workspace resume --request-id ...
manage.py manage_statutory_retention fiscal --issuer-siren ... --starts-at ...
    --closed-at ... --timezone ... --authority-ref FIN-100
manage.py manage_statutory_retention close --source-id ... --event-at ...
    --reason controller_instruction --authority-ref END-100 --actor-identity-id ...
manage.py manage_statutory_retention qualify --source-table billing_invoice
    --source-id ... --event-at ... --authority-ref FIN-101
manage.py manage_statutory_retention purge --source-table billing_invoiceline --source-id ...
```

The default resume command commits real Core deletion and exits unsuccessfully
while unconfigured external domains remain held. An unsuccessful command is not
proof that Core deletion was rolled back: inspect the durable request/progress.
No command supplies or manufactures a provider absence receipt.


## Account scope

Account admission binds the real `VerifiedAccessToken` subject to the persisted
person; no request body person ID is accepted. Explicit `delete` confirmation,
current recent verified authentication, the separate operator's validated instruction,
and an aware recovery deadline are required. A sole active owner must transfer
ownership first. Staff-managed people require a separate policy and are refused.
The transaction takes the person lock and ordered organisation locks, drains any
in-flight push, disables the person's identities, revokes their private exports,
and invokes the existing membership removal, `access_off` and real member/channel
set hooks. Failure to emit the concrete engine erasure protocol rolls back intent
and all authority changes. `protocol_emitted_at` is not a metadata-only replacement
for those hooks: SQL checks the new sets and final known-subject erasure facts.

At the explicitly admitted deadline, account processing deletes only that person's
push queue/subscriptions/inbox and scrubs their own contact fields, authored support
contacts and invitations tied by their actual membership FK. It does not erase
controller-owned workspace docs, Yjs content, uploads, other members' contacts or
accounting/contracts. These do not become ten-year records merely because an account
was erased. Attachments, notifications and subscriptions have immutable physical
identifier/organisation/person authority tuples: neither a workspace nor an account
cutoff can be evaded by moving an OLD payload into a valid NEW live scope.

`AccountErasureScope` and `AccountAbsenceProof` are separate person-scoped types.
Durable immutable receipts bind request, person, original cutoff, inventory digest,
required domain, evidence digest, revision and database observation time after the
recovery deadline. Workspace proofs, wrong person/request/inventory, future evidence
and failed adapter verification refuse. All required domains remain mandatory even
when an inventory is empty: `matrix_accounts`, `identity_provider_accounts`,
`private_exports`, `account_message_outbox`, plus `account_extension_subjects` when
extensions are installed. No account adapter is configured by default. In particular,
sealed mail currently has no authoritative person FK; matching a recipient email is
not a valid ownership inventory. Resolving that binding and supplying a real fenced
person-scoped adapter is a deployment/product integration gate, not an inferred
empty result. The workspace private-volume adapter cannot satisfy account scope.

After actual local purge, concrete protocol emission and all verified account receipts,
`privacy_complete_account_erasure` replaces disabled login subjects with tombstones
and durably commits `complete`. The path is reachable and tested with explicitly
synthetic proof controls and an independent processing LOGIN; this is not production
provider absence evidence. Accepted ADR-0016 keeps the minimal erased realm-subject
denylist and controller-owned history while that organisation exists. A trigger
prevents rebinding an erased realm subject to a new person. No other member's engine
history is removed. Statutory records retain their own exact lawful deadlines.

The source admission service requires the existing operator/membership-lifecycle
profile for its canonical hooks. The processing grant set has account journal reads,
lock-only timestamp UPDATE and only bounded purge/receipt/complete functions; it
cannot admit account intent or read raw personal tables. No HTTP account deletion
success route or new runtime credential is installed by this source change.
