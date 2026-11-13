# Extensions, native workspace imports and optional digests

Status: Implemented source; customer console/provider cutover remains held.

Issue #85 covers the dispatcher/importers. This lane also implements the requested opt-in
metadata digest and narrowly additive SDK rotation helpers. It introduces no infrastructure
credential, default app-secret provider, SMTP transport or live provider operation.

## Dispatcher and authority

Installation, rotation, queue, reconciliation and inspection services require current workspace
owner/admin authority. Organisation, workspace and current actor locks serialize revocation;
dispatch checks the creator's current owner/admin membership and identity again. A revoked or
cut-off workspace cannot start another installation or send a queued delivery. The API image
contains only inert model registration; it receives no dispatcher, importer, mail or operator code.

`manage_extension` supports install/rotate/revoke/inspect/enqueue/reconcile. The organisation
and installation are explicit; an authenticated customer access token arrives on stdin, never
argv, logs or persistence. Admission uses Core's existing pinned trust and customer-lane guard.
`dispatch_extensions --once --max-jobs N` loads the explicitly configured
`KODERA_EXTENSION_SECRET_PROVIDER_FACTORY` afresh per claimed job. No provider is inferred;
without one, dispatch refuses before claiming. Signing keys never enter database rows or the
process environment. The factory must implement the approved deployment's application-secret
lookup and generation provisioning before production cutover.

Each delivery has a stable id, immutable scoped event bytes/digest, hashed idempotency key,
lease fence, bounded attempts and inspectable outcome. The primary signature stays exactly
`v1=HMAC-SHA256(timestamp + '.' + rawBody)`. The signed v2 body additionally binds organisation,
installation, delivery id, event type and key generation. During at most 24 hours of absolute
grace, a separate `X-Kodera-Previous-Signature-256` header carries the old-key signature over the
same bytes. Reused key material refuses. Existing v1 SDK functions are unchanged; the additive
SDK helper validates trusted generation/scope/grace and rejects in-process replay. Receivers
must persist delivery ids with their effects for durable idempotency. New key distribution and
receiver adoption remain an explicit cutover; legacy receivers need the current key.

Every attempt uses `apps.media.outbound.request`, with one complete public DNS resolution,
pinned TCP address, TLS hostname validation, a five-second absolute deadline, no redirects and
a 32-KiB response bound. Known retry responses use bounded exponential backoff, at most eight
attempts. Lost responses, unexpected transport errors and expired in-flight leases enter
`needs_reconciliation`; they are never blindly retried or called successful. Current owner/admin
observation plus `urn:kodera:evidence:UUID` explicitly releases, confirms or abandons an ambiguous
attempt. That attestation is labelled as such and is retained immutably with its attempt binding.

## Offline native imports

`import_workspace --organisation UUID --source slack|discord|notion --archive PATH` takes its
customer token on stdin and processes at most 25 new/refused objects per invocation. Repeated
invocations resume using durable workspace/source/object digest mappings. Exact reruns reuse
native ids and preserve local edits; changed source objects conflict. Current access is checked
on every item and replay. Quota or permission refusals never leave a partially written page/row.

Supported inputs are Slack channel exports with users/channel manifests and dated JSON files;
a Discord channel JSON export; and Notion Markdown/CSV ZIP trees. Native pages retain source
author names/ids and timestamps as explicit imported attribution; the actual Core creator stays
the authenticated member. Folder/channel hierarchy becomes native parent links. CSV columns
infer bounded text/number/checkbox/date properties and create real table Collections with native
row pages. The existing document create/patch and Collection services enforce Yjs, permissions,
tree rules, database quotas and conditional row writes.

ZIP input is capped at 20 MiB, 40 MiB expanded, 2 MiB per entry, 1000 entries and 100:1 compression;
normalized paths, duplicates, traversal, symlinks and encrypted archives are rejected. At most
500 normalized objects and 200 CSV data rows are accepted. Imported HTML/SVG and remote images
never execute or fetch; active blocks are stripped, links/mentions are inert, and unsupported
attachments are counted as omitted. Rich platform blocks, reactions and attachments are not
reconstructed. Native import golden fixtures use synthetic data only.

## Opt-in digest and existing outbox

Digests default off. `set_digest_consent` changes only the authenticated member's consent and
version. `schedule_digest` queues one bounded period through the existing sealed outbox. Its
content contains only current-visible changed-page/Collection counts and period metadata;
no document title, message text or attachment is copied into mail. Resource-id bindings and
consent version are checked again at the actual sender boundary. The narrow sender hook holds
organisation/workspace/member/identity/consent fences through the existing bounded SMTP attempt;
a committed revocation wins before sending. Lost SMTP outcomes retain the existing sender's
reconciliation semantics. Other mail templates keep their original path.

The new `workspace_digest` catalogue entry is explicitly draft and `approved = false`. Remote
transport holds it until human copy approval. No transport is configured here; only an owned
local SMTP capture was used to qualify the mechanism. Customer preference/console routes and
UI integration remain a release gate; the commands and backend are usable by an authenticated
operator without inventing a public HTTP contract.

## Nonstatutory expiry and erasure hooks

Delivery event bodies expire after at most seven days. Claims, dispatch and reconciliation
refuse expired/purged work. `purge_extension_payloads --limit N` clears expired bodies under row
locks, preserving only hashed idempotency/event digests and minimal outcome evidence. Expiry
cannot be extended; a purged body cannot be restored. These are not accounting records and no
ten-year statutory rule is applied to them.

`extension_erasure_step(erasure_id, organisation_id, cutoff_at, inventory_sha256, limit)` is
one bounded `SECURITY DEFINER` operation for the separate restricted retention processing role.
`retention.worker_step` calls that exact SQL boundary. The function fixes its search path, revokes
PUBLIC execution, caps the shared payload/metadata row budget at 1,000 and sets local lock and
statement bounds. It grants no raw extension reads or writes and cannot admit a new Core request.
Missing Core journals, private inventory-digest helper or approved intent refuse before mutation.

Every call verifies the immutable Core request, recomputes its inventory digest, and binds the
organisation, exact cutoff and required provider domains. The first call captures an immutable
local admission only when every receiver matches the authoritative inventory. Later progress may
remove a subset of those receivers; a bare local cutoff marker cannot manufacture admission.
It immediately fences installations and digest consent, but respects `purge_not_before` before
erasure-driven payload or metadata deletion. Existing earlier ordinary TTLs are never extended.
Metadata disposal requires local payload absence and all cutoff-bound verified provider receipts,
including `external_extension_receivers`. A single missing receipt holds every metadata row.

The scoped teardown removes decisions/attempts/deliveries, import mappings/reports, digest
linkage and installation endpoints before Core document purge. Immutable admission and cutoff
markers remain to prevent replay drift and resurrection. Ordinary evidence edits/deletes remain
refused. The obsolete owner-ORM cutoff and metadata-purge helpers are removed; all erasure-driven
disposal uses the approved request-bound boundary. The ordinary seven-day expiry command remains
limited to already-expired event bodies. `native_documents_released` reports actual import-mapping
FK absence independently of remote receipts, allowing Core native purge when no local blockers
remain while full completion stays held on provider proof.

Before deleting metadata, capture `receiver_inventory(organisation_id=...)`: each exact receiver
is `urn:kodera:extension-installation:UUID:endpoint-sha256:HASH`. All installations, including
revoked ones, are included conservatively. `external_extension_receivers` is a separate required
proof domain. A cleared local payload or deleted metadata never proves receiver erasure. Native
imported documents use the Docs purge graph. Account-only erasure and complete private exports
also need explicit extension coverage before their lifecycle gates can close. Disposal migrations
are intentionally irreversible because erased payloads cannot be restored.

## Qualification and limits

Focused tests exercise actual pinned PostgreSQL16, native Yjs transforms and local SMTP capture,
plus real shared-egress synthetic DNS/socket/TLS vectors and Python-produced SDK signatures.
See the PR evidence for exact executed counts, refused mutations and remaining integrations.
No external server, cloud credential, customer archive, real mailbox or app secret was contacted.

Production remains held on central audit registry/contract cutover, app-secret provisioning/receiver rollout, public installation and
console/dead-letter contracts, digest preference UI and human copy approval, approved mail
transport, complete external export/erasure providers and operational scheduling. The local
backend and commands do not imply those integrations are deployed or certified.
