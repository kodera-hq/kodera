# Private export runtime

Status: Concrete private-volume, frozen-source and worker execution adapters implemented;
full data coverage, HTTP delivery and deployment qualification remain held.

The worker needs concrete restart-safe storage and frozen source adapters for the signed
archive protocol. A private local volume is an explicit self-host deployment option, never
an inferred fallback for an absent bucket. Its service-owned root and every directory must
be private. Reads and writes refuse symbolic links, nonregular files, path traversal,
oversized objects, different immutable replacements and expired content. Each object commits
its expiry and bytes together. Cooperative service writers serialize with a parent-directory
lock and publish one fsynced inode by atomic rename; directory creation fsyncs its parent.
The filesystem must support these POSIX guarantees. Expiry denies reads; supervised collection removes expired
objects. It does not prove erasure from volume snapshots or backups.

Source snapshots persist a canonical manifest and bounded entry bodies on that private
volume. Bodies use content-addressed keys. A restart reads the first committed source snapshot
rather than recapturing changed data; interrupted captures may select a later complete snapshot
without colliding with abandoned bodies. Concurrent captures reuse the same winning manifest.
The manifest binds the request, source, resource identifiers, entry names and hashes. Every
resume checks current resource disclosure authority. Missing sources remain an admission
failure: messages and media require explicit tenant-store integrations, including when
media binaries are excluded. Native document exports must include the actual persisted
Yjs snapshot and updates, rather than treating an older Markdown projection as current.

`CoreSources.capture` supplies bounded explicit projections of identity, memberships,
creator-owned documents, Collections and billing metadata. These projections do not account
for every personal record in all installed applications: other people's documents may retain
the requester's contributions, billing has additional payment/line facts, and extensions have
their own payloads. `CoreSources.adapters` therefore refuses with 503 unless every Core section
has an explicitly supplied completeness supplement. No default supplement exists. Supplements
use separate resource kinds and authorizers; they cannot override a denial for a Core resource
or relabel a full Core document as an allowed contribution. Matrix and media sources are still
separately required. A test fixture with explicit empty supplementary/external controls proves
only its synthetic world, never production coverage.

The request inventory includes orphan source bodies and abandoned staging files. An interrupted
expiry header conservatively holds staging for the maximum admitted lifetime from its write.
Oversized orphan sets use bounded expiry pages; an incomplete page never proves full erasure.
Final erasure evidence requires a complete empty inventory after the durable cutoff. Volume
snapshots and backups require their own erasure evidence. The API receives no new provider,
signing-key or volume access, and no HTTP export endpoint is activated by these worker modules.

Acceptance requires real filesystem restart, immutable retry, expiry and collection proofs;
named path/symlink/permissions/size/tamper refusals; real signed archive generation after a
new worker instance; resource revocation refusal; and PostgreSQL scope-isolation tests for
Core producers. The API must never hold a volume, object-store or signing credential.
No runtime is reported deployed merely because its source tests pass.
