# Private export pipeline

Status: Source implemented and offline signed-archive proofs available; full GDPR export and deletion delivery blocked on explicit integration ports.

The archive builder freezes a scope-bound snapshot for every required source: identity,
memberships, documents, collections, messages, media and billing. Both account and workspace
exports require all seven source implementations. Each source must implement current
resource-level disclosure checks, preserve the frozen snapshot across restart, and scope its
records to the requesting person or the owner's workspace. A Core-only producer is not a
complete GDPR archive. Missing Matrix, media or any other source refuses admission with 503.
`include_media=false` still requires a media provider to account for the omitted binary
content and export its authorized metadata; it never silently drops that source.

No default provider, private bucket, signing key, current authority or public URL is inferred.
Storage is an injected private immutable-object port with enforced expiry. The API never gains
an infrastructure credential. The signer supplies an explicitly trusted key identifier and
Ed25519 public key; the public key must be distributed through an independently trusted
channel. An embedded key identifier alone does not establish trust. Key provisioning,
rotation and the export worker's deployed source/storage adapters remain release dependencies.

`PrivacyExport` stores identifiers, an immutable request snapshot and metadata checkpoints;
archive record bodies are kept in private storage. Request admission and the winning ready checkpoint append identifier-only `export.requested` and
`export.ready` audit rows in the same transaction. Failed CAS attempts cannot duplicate readiness
audits. Each committed checkpoint has a durable
compare-and-swap revision. A failed checkpoint commit can retry the same object without
rewriting different bytes. Chunk keys derive from the request identifier and sequence, not
from a client-supplied storage path. Every entry has a bounded safe archive name, size and
SHA-256. Sources cannot write another section or use ZIP-slip paths. Each resume verifies the
checkpoint chain and prior private objects before progressing. A deterministic ZIP carries a
canonical, domain-separated Ed25519-signed manifest over the scope, source snapshots, expiry
and every entry digest. Only the final durable checkpoint makes an artifact ready.

Current customer identity/person and, for workspace scope, current owner membership are
checked again on every step. Every source must separately reauthorize its captured resources;
a membership check alone is insufficient. Authority is rechecked during final publication and
before and after ready-artifact validation. Revocation, expired requests, missing snapshots,
tampered blobs or signatures and lost checkpoint races never disclose an archive.

The builder bounds pages to 100 entries, individual entries to 2 MiB, total uncompressed data
to 64 MiB and entry/checkpoint counts to 10,000. These are initial bounded pipeline limits,
not claims of unlimited tenant export capacity. Larger exports need an independently reviewed
streaming/partitioning design. Private-object TTL enforcement and expired-checkpoint cleanup
must be implemented and proved by the storage/worker integration before deployment. No
production endpoint or external provider is activated by these source modules.

Deletion is explicitly held by `deletion_hold`: no cutoff proof, external-store erasure proof
or statutory accounting-retention provider is currently configured. It neither deletes data
nor claims a finalizer exists. A future finalizer must revoke live access, prove all active
stores purged, retain only lawfully required accounting snapshots with their authoritative
retention boundary and legal holds, and then prove expiry/purge separately. It must not invent
a ten-year deadline from an invoice issue date or shorten an existing accounting obligation.

Validation uses `tests/test_privacy_archives.py` for real signed ZIPs, restart/replay,
completeness and named refusal mutations, and `tests/test_privacy_journal.py` for actual
PostgreSQL checkpoint and current-authority fences. The storage/source implementations,
operator-controlled key trust and physical deletion/retention evidence remain explicit gaps.
