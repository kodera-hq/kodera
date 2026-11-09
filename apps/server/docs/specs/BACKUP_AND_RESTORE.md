# Backup and restore

**Status:** Proposed · **Owner:** Lours

What is backed up, where it goes, why a compromised tenant cannot destroy it, how often we prove it restores, and the recovery numbers we are willing to put in a contract.

The governing sentence: **an untested backup is not a backup, and a deletable backup is not a backup either.** Everything below follows from those two.

Companion specs: [`SLO.md`](SLO.md) (availability, which is a different promise from durability), [`OBSERVABILITY_STACK.md`](OBSERVABILITY_STACK.md) (the freshness and drill alerts), [`RUNBOOK_INDEX.md`](RUNBOOK_INDEX.md).

---

## 1. Storage model: append-only, locked, pruned from elsewhere

One **Scaleway Object Storage bucket per tenant**, in the tenant's own Scaleway project, `fr-par`. `restic` as the repository format.

### 1.1 The tenant VM's key cannot delete

The API key rendered onto the tenant VM has exactly three rights on its bucket: **`Put`, `List`, `Get`. No `Delete`, no lifecycle administration, no bucket-policy administration.**

This is the whole point. Ransomware on a tenant VM, a compromised agent, or an operator error on that host can write garbage into the repository; none of them can remove what is already there. The blast radius of a tenant compromise stops at "new snapshots are worthless", never at "old snapshots are gone".

Consequences that must be designed around rather than discovered:

- `restic backup` works with `Put`/`List`/`Get`. `restic forget --prune`, `restic check --read-data` repairs, and repository rebuilds all need delete rights and therefore **never run on the tenant VM**.
- `restic unlock` also needs delete. A stale lock left by an interrupted run on the host cannot be cleared from the host. The nightly job on the VM must therefore use a per-host lock discipline that does not depend on removing a repository lock, and lock removal is a worker operation.
- The tenant's own restore path reads with `Get`; restoring never needs delete.

### 1.2 Object Lock

**Object Lock in `COMPLIANCE` mode, retention ≥ 30 days**, set at bucket creation — Object Lock cannot be enabled on an existing bucket, so a bucket created without it is recreated, not patched. `COMPLIANCE`, not `GOVERNANCE`: governance mode can be bypassed by a sufficiently privileged identity, and the identity most likely to be compromised is ours.

The consequence we accept knowingly: for the retention period, **we cannot delete a tenant's backups either** — not for a mistaken write, not on request, not for cost. Deletion of a tenant's data at the end of the relationship therefore happens in two stages: active stores are deleted first, while backups expire only when their lock does. The initial active-store deletion attestation must bind an immutable, content-addressed canonical manifest of every backup object identifier, version and lock expiry, name the durable manifest reference and digest, and state the last expiry. That manifest remains available as evidence even if ordinary pruning removes source objects before the final job runs. A final deletion certificate is issued only after resolving the manifest and proving every member is purged. Retention is also the floor on how far back a restore can reach; a tenant contracting for longer history gets a longer lock, not a second bucket.

The same attestation seals a separate immutable scope union of every export linked to the accepted
delete, irrespective terminal state, including each issued write slot and accepted encrypted
temporary/final object version; an unused slot carries its
never-accepted proof at sealing. Both scope references and digests live with the never-deleted
certificate for its full lifetime. Physical purge never rewrites them. The final certificate
resolves both scopes and records a separate immutable final-purge evidence reference and digest
proving every member absent; a later purge of operational `Export` rows can never erase an
artefact obligation.

The exit backup is taken only after termination has synchronously closed ordinary write admission,
the decommission preparation has disabled clients, stopped every remaining ingress and drained all
pre-fence DB, object and document mutations to authenticated terminal evidence. Its manifest binds
source high-water marks covering that drain. It uses a pre-registered slot, a capability bound to
the exit, current backup fence and an absolute deadline no later than natural expiry, and an
accepted-write journal. Every store acceptance checks trusted time against that deadline and the
current effective cutoff, refusing at equality even when the expiry writer is unavailable. The
expiry writer or a validated earlier-deletion instruction also closes final-backup admission and
advances that fence: a later store write is refused, while an object accepted before the fence but acknowledged afterwards remains in
the immutable backup scope and final purge obligation. No failure compensation may restart ordinary
service after termination. At either natural recovery expiry or an earlier-deletion instruction,
the cutoff transaction fences unfinished export/decommission work and creates a parent durable
reconciliation obligation with one cancel job child per selected non-terminal job and a reap-only
job child for any relevant terminal job with an unended/live claim across any fence. Each job child
has one session child per relevant historical claim, or one sentinel for proven no-claim history.
It does not infer a store result. After every session child and its live locks are proved gone, cancellation
transfers that job's open dispatch to its child and releases its reservation. A later evidence
writer resolves all children and reconciles every slot with the accepted-write journal and a fresh
store read before sealing accepted versions or canonical no-write. Unavailable evidence leaves the
parent open without a bounded attempt budget and blocks the durable attestation/status finalizer,
not the access cutoff or completed destruction. These fields, writers and race tests are owed
runtime work, not behavior implemented by this specification-only increment.

### 1.3 Pruning happens on the worker

Retention enforcement runs **only from the provisioning worker**, with the tenant's one provider API key: the expiring key a person issues per tenant at the human-controlled boundary of ADR-0005, whose policy names only that tenant's project and grants delete rights there, loaded into memory for each job through the approved job secret path and never written to disk ([`../security/THREAT_MODEL.md`](../security/THREAT_MODEL.md) §5, [`../domain/MODEL.md`](../domain/MODEL.md) invariant 16). The key is per tenant, not per job; what is per job is its exposure in worker memory.

| Job | Frequency | Holds delete rights |
|---|---|---|
| `backup` (on the tenant VM, via the agent) | nightly | no |
| `backup-verify` (worker) | nightly, after the tenant window | no (`Get`/`List` only) |
| `backup-prune` (worker) | weekly | yes, scoped to one tenant's bucket |
| `restore-drill` (worker) | monthly per tenant | no |

A prune can only remove objects whose lock has expired; the lock is the backstop under the retention policy, not a duplicate of it.

`backup-prune`, the purge of a deleted tenant's bucket once its last lock expires and final-certificate issuance after that purge are infrastructure mutations under ADR-0004 and so must run as jobs; none is a kind of [`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md) yet, and all become job kinds in a follow-up. Ordinary pruning may remove an expired source object but never the deletion evidence store's immutable manifest; every removal remains checkable against that manifest. Because `DeletionCertificate` is never deleted, its content-addressed manifest remains immutable and resolvable for the certificate's full lifetime; there is no shorter, separate “evidence retention” clock. The purge runs with the tenant's key, which the operator revokes only after it; whether that key's expiry always falls after the last object's lock is an open question.

**The fleet control host holds no age identity and no cross-tenant key.** An identity that can decrypt every tenant's secrets is a single object whose theft is a fleet-wide breach. One such object does exist, and this section does not pretend otherwise: the shared ops age identity of ADR-0003 is not target-isolated and decrypts every bundle encrypted to it. It is never on this host, it is loaded into worker memory only for the duration of one job, and it is acceptable for `lab` and `staging` only; every other class waits for target-isolated decryption and one-job secret delivery (ADR-0003, ADR-0012). Everything else is per job, per tenant, time-boxed, or not at all.

---

## 2. What is backed up

Per tenant, nightly, in one `restic` snapshot set with a tenant tag:

| Item | Source | How | Why it is in the set |
|---|---|---|---|
| **Application database** | tenant Postgres | `pg_dump` streamed into `restic`, never a file copy of the data directory | the only consistent form; a copied data directory of a running server restores to nothing reliable |
| **Tenant secrets** | rendered `env.d/*`, agent credentials, probe identity, media API secret | encrypted at rest on the host (mode 600) and again inside the repository | a restore that cannot re-authenticate is not a restore |
| **Media server configuration** | the rendered LiveKit YAML | file | it carries the participant and idle caps and the API key that must match the application's; the pair is the thing being backed up, not the file |
| **Edge configuration** | the reverse-proxy templates and the per-host configuration, the ACME host list | files | reconstructing an edge by hand during an incident is where certificate outages come from |
| **Collaborative-document bodies** | the tenant's S3 bucket for document content | `rclone sync` into the same repository, bucket versioning on at the source | **these are not in the database.** A database dump backs up metadata and no document content; a restore that produces empty documents passes a naive check and fails the customer |
| **Realtime provider state** | the collaboration provider's persisted state | file | avoids losing in-flight edits at the moment of a restore |
| **Tenant profile identity** | the profile commit SHA, image digests, the rendered configuration checksums | small manifest | the restore must reproduce the *same* versions; a restore onto newer images is a migration, not a restore |

**Explicitly excluded:**

- **ACME account keys and issued certificates.** They re-issue in seconds and a backed-up private key is a liability that outlives the incident. The restore procedure re-issues; the runbook says so and the rate-limit budget accounts for it.
- **Container images.** They come from the digest-pinned mirror, which is itself the artefact store.
- **Host logs.** The published retention is 7 days; backing them up for 30 would contradict it.
- **Media streams.** They are transient by design and no recording is retained unless the recording add-on is explicitly enabled, in which case recordings are a separate, tenant-scoped, lifecycle-managed set with its own retention.

### 2.1 Identity provider, handled separately

The identity provider is shared across tenants, so its dump is a **cross-tenant artefact** and cannot sit in any tenant's bucket:

- Nightly database dump plus a **weekly per-realm export including users**, into a dedicated bucket in the ops project.
- **Different recipients**: encrypted to the identity and security owners only, not to the per-tenant recipient set.
- **Object Lock `COMPLIANCE`, 90 days** — longer than a tenant's 30, because an identity mistake (a realm deleted, a mapper changed, a federation misconfigured) is discovered later than a data loss.
- The per-realm export is deliberately in the portable realm format: it survives a major version bump of the identity provider and doubles as the customer's export artefact on exit.
- **A drill the day before any identity-provider upgrade**, in addition to the monthly one.

Final-organisation offboarding seals a separate `closure_scope = final_organisation` manifest. Its
operator-only source inventory contains the exact version of every per-realm export for that realm
and every shared nightly dump whose contents may include the realm, plus each object's lock expiry.
The permanent customer-readable certificate embeds the exhaustive per-organisation projection
defined in [`../domain/MODEL.md`](../domain/MODEL.md): it proves the closing realm's membership,
slot outcome, lock boundary and absence/refusal evidence while replacing the closure's raw
operator-only manifest/evidence references and global cutoff generation, and every shared capture's
raw global capture/generation identifier, provider-snapshot and write-slot references, realm
catalogues, capabilities, journals and object references/versions with certificate-salted digests.
It rejects an unclassified future
closure or capture field, a duplicate/overlapping classification, or any entry outside the locked closing
organisation. The fresh realm-absence read
defines the upper boundary, but an inventory read alone is not a fence. Before realm deletion, the
offboarding writer closes that realm's identity-backup admission at a durable generation and blocks
new shared dumps while the realm still exists. The durable
`identity_backup_generation_one_open` partial unique index on `(state) WHERE state = 'open'`
permits at most one open generation. The one-shot initializer holds `identity-backup-catalogue`
exclusive, locks and rechecks both the immutable `IdentityBackupCatalogueState` singleton and the
generation table, requires marker absent plus a truly empty table, and atomically inserts exactly one
`open` head and marker or neither. The marker's head id/generation exactly equal that locked inserted
head and its initialization clock is fixed in the same transaction. Concurrent initializers
serialize and every later attempt refuses the existing marker. The marker cannot clear or be
rewritten. Once it exists, any zero-row or zero-open state is a fail-closed reconciliation incident;
bootstrap, recovery and cleanup never invent a replacement. Every dump/export writer acquires the durable global
`identity-backup-catalogue` reservation shared before locking the unique current `open` head, binds
that generation and its deterministic slot, and retains the reservation through registration
commit. A database constraint trigger locks and requires exactly that unique current head and
refuses zero or multiple open rows, a `draining` or `sealed` target, and any stale-open, non-head or
stale direct binding. Snapshot-begin then reacquires the catalogue
reservation shared, while realm creation/deletion holds it exclusive through a known provider
outcome. The writer fixes its realm list and catalogue digest from the
same provider-consistent snapshot that produces the dump bytes before releasing the reservation;
if the provider cannot supply that boundary, the reservation remains held until dump completion.
Offboarding drains or reconciles every registered writer through the cutoff under authenticated
terminal evidence; only then may it delete the realm. New writers after the cutoff either wait or
prove from the fresh realm-absence read that the realm is excluded. Before any object-store write,
a writer commits a deterministic slot and receives a
slot-bound capability. The artefact service records an accepted write in its durable journal before
replying. The writer then inventories and seals every accepted object version through the cutoff,
irrespective of the capture's final logical state, plus authenticated absence or refusal evidence
for every unused slot, before reopening the shared schedule. If storage succeeds and the post-call
fence re-check rejects publication, the capture becomes `refused` but retains the accepted object
reference, version and journal evidence in the sealed manifest.

When the manifest contains at least one accepted object, `backups_locked_until` is exactly the
maximum accepted-object `lock_until`, and final `backups_purged_at` is non-null and not earlier than
that maximum. When it contains zero accepted objects, including a non-empty no-write-only manifest,
`backups_locked_until` is null; final issuance skips the expiry comparison, reauthenticates every
slot's no-write and terminal proof, and records non-null trusted `backups_purged_at` on completion.
A mixed manifest uses the maximum accepted-object expiry and also reauthenticates every no-write
proof. Organisation/person purge may start after the active-store attestation, but the final
certificate waits until a fresh read proves every accepted object in this realm-bearing manifest and
every deletion-linked export artefact is physically absent. Shared dumps needed for other realms
remain listed until their own lock expires and the object is pruned; the certificate never treats
logical realm deletion as physical purge.
The future runtime acceptance suite must pause a shared dump between snapshot and publish while
offboarding crosses the cutoff, then proves the dump is drained into the sealed manifest or its
publish is refused without dropping an already accepted object version. Future mutations that omit the
write-ahead slot, accepted-write journal, generation re-check or refused-state object version must
fail. A separate race pauses after capture registration but before provider snapshot-begin and
starts realm creation: create-first includes the realm in both list and bytes; snapshot-first
excludes it from both. Removing the shared/exclusive catalogue reservation, using a pre-snapshot
Core realm list, releasing before the snapshot binding is durable, or deleting a realm from the
catalogue while retaining it in dump bytes must each fail.

Closure creation and capture cleanup also hold `identity-backup-catalogue` exclusive from before
they read the capture/closure selection predicate through commit. Closure creation atomically locks
and requires exactly one old `open` head, moves exactly that row to `draining`, creates exactly one
greater monotonic `open` head, fixes the draining generation as its cutoff and selects its
through-cutoff source set under that reservation. Before commit it re-reads the generation set and
proves that exactly one old head transitioned and exactly one new current head exists; zero or
multiple old or new open rows roll the transaction back without writes. Closure sealing reacquires
the reservation exclusive and, before marking
the generation and closure `sealed`, rechecks that every capture at or below the cutoff is in the
sealed source set with its required terminal outcome; no registration can enter the draining
generation. Cleanup locks the capture and every dependent
unfinalized closure and re-reads the complete set immediately before deletion while still holding
the reservation. Closure-first therefore blocks cleanup; cleanup-first commits exclusion before a
later closure selects its source set. Removing or releasing the common reservation early, or
inserting a closure between the final recheck and deletion, must fail.

The raw `IdentityBackupGeneration`, `IdentityBackupCapture` and `IdentityBackupClosure` rows are
bounded operational closure sources, not permanent evidence. Final-organisation finalization first
validates and retains the sealed operator-only exact object/version/expiry scope at the permanent
`backup_manifest_ref`, and copies the safe, exhaustive projection into the customer-readable
finalization-evidence manifest. It then deletes the sealed closure source in that transaction; if
either manifest is unavailable or its digest/scope cannot be verified, it leaves all sources
unchanged and retries. A capture may remain only while its locked object exists or an unfinalized
through-cutoff closure still requires it. Under the common exclusive reservation, trusted cleanup
handles an accepted write only when all five accepted-write fields (`store_accepted_at`,
`accepted_object_ref`, `accepted_object_version`, `lock_until` and
`accepted_write_journal_ref`) are non-null: it authenticates exact object/version absence and, when
a closure selected the capture, requires the exact
object/version/expiry scope in that closure's permanent `DeletionCertificate.backup_manifest_ref`.
For a no-write capture whose same five fields are all null, it authenticates the deterministic
slot's no-accepted-journal/no-object result and terminal no-snapshot/refusal evidence; when selected,
that exact slot, outcome and terminal evidence must already be durable in the closure's permanent
`backup_manifest_ref`. Both branches perform the final no-pending-closure recheck before deletion. An
ordinary expired active-organisation capture selected by no closure needs no deletion certificate.
A partial accepted-write tuple, missing slot or terminal evidence, storage/journal outage, unknown
result or reappearing object writes nothing and retries. `IdentityBackupGeneration.opened_at` never changes. Its `sealed_at` is
null in `open` and `draining`, becomes non-null exactly once on the one-way transition to `sealed`,
and never clears or changes. Generation cleanup holds `identity-backup-catalogue` exclusive through
commit, locks the candidate and unique current head and, immediately before deletion, re-reads both
plus every capture, closure and unfinalized cutoff that could reference the candidate. It deletes
child-last only when the candidate is `sealed`, is not the current head, has zero captures and
closures and no unfinalized cutoff can include it. It refuses an `open`, `draining` or current-head
candidate, a changed head/state, any late child/cutoff or an unavailable recheck without writing.
The idle sole open head remains until closure rotation; cleanup never performs zero-head recovery.
`IdentityBackupCatalogueState.singleton_key` is protected by the durable named constraint
`identity_backup_catalogue_state_singleton_key` with
`CHECK (singleton_key = 'identity-backup-catalogue')`; together with its primary key, no alternate
key or direct second-row insert is possible. `IdentityBackupCatalogueState` is a lifetime
non-personal, initializer-only, system-global control row outside generation rows. Normal cleanup
never touches it; it contains no foreign key, provider/customer identifier or secret, and no
customer API/queryset, certificate projection or retention manifest includes it.
The operator-only backup manifest remains
lifetime-resolvable for final-purge verification; no customer-readable certificate projection or
customer-scoped audit record copies raw realm lists, provider/object references, capture identifiers
or generation identifiers.

---

## 3. Restore drill

**Monthly, per tenant, automated, from the worker.** A drill that a human has to remember is a drill that stops happening.

### 3.1 Procedure

1. The worker takes a lease on the tenant, provisions a throwaway environment (a container set with its own database, isolated from the tenant's network path — the drill never writes to production).
2. Fetch the latest snapshot with a read-only key.
3. Restore the database dump; boot the application against it.
4. Restore the configuration bundle; decrypt the secrets with a per-job identity.
5. Restore the document bodies from object storage into the throwaway bucket.
6. Run the assertions in §3.2.
7. Tear down; write a verdict record; publish `kodera_restore_drill_last_ok_timestamp_seconds`.

### 3.2 Pass criteria

All must hold; any failure makes the drill red and raises a Sev-2:

| # | Assertion |
|---|---|
| 1 | The snapshot is younger than **26 hours** and `restic check` on its structure passes |
| 2 | The database restores without error and the row counts for users, rooms and memberships are within 1 % of the values recorded at snapshot time |
| 3 | The application boots against the restored database and its own health endpoint is green |
| 4 | **A document body round-trips**: a known document's content is fetched from the restored object store and matches its checksum. This assertion exists because a database-only drill passes while every document is empty |
| 5 | The restored configuration reproduces the recorded checksums, and the media API secret in the restored media configuration **matches** the one in the restored application environment — a mismatch is invisible at boot and makes every join fail |
| 6 | The restored profile SHA and image digests equal those in the snapshot manifest |
| 7 | The secrets bundle decrypts with the per-job identity and contains every expected key |
| 8 | Total wall-clock time is recorded, and is **within the tenant tier's RTO** |
| 9 | The drill left no writable artefact in the tenant's own project and no object in its bucket |

Criterion 8 is what turns RTO from an aspiration into a measurement: the drill's own duration is the evidence for the number we sell.

### 3.3 Evidence

Each drill writes a verdict record (tenant, snapshot id, duration, per-assertion result, versions restored) to the fleet repository's deploy trail and to `kodera-core` as a `Backup` outcome. **A tenant whose last green drill is older than 40 days is not a supported tenant**, and the alert says so.

---

## 4. RPO and RTO

Per tier. RPO follows from a nightly backup.

**The RTO figures below are provisional.** They are the targets the procedure is designed to hit, not measurements: criterion 8 of the drill (§3.2) is what records a restore's wall-clock time, and §7 makes the first passing drill an acceptance condition for this specification — no drill has produced a duration yet. Each figure becomes measured, and is re-derived from the drill record each quarter, once drills support it; if drills stop supporting a number, the number changes, not the drill. Until a tier has a measured duration behind it, its figure is not quoted to a customer as a measured one.

| Tier | RPO | RTO (provisional) | Basis |
|---|---|---|---|
| **S (Team)** | 24 h | 4 h | rebuild the host from the factory, restore, re-issue certificates |
| **M (Business)** | 24 h | 4 h | as above |
| **L (Business Plus)** | 24 h | **2 h** | same procedure, prioritised; a warm target is not kept, the gain is queue position and a rehearsed operator |
| **XL (Enterprise)** | 24 h | **2 h** | as L |
| Enterprise high-availability option | 24 h | **1 h** | only where the option is contracted; an option on top of a tier, not a tier of its own. This is the option the SLA schedule ties its 99.9 % ladder to ([`SLO.md`](SLO.md) §9), and neither number is offered before it has been measured |

Two honesty statements that belong in the customer-facing text:

- **RPO 24 h means up to a day of application data can be lost** in a full-host loss. Meetings in progress are lost immediately in any case; collaborative documents are the real exposure, and bucket versioning at the source narrows it below the nightly figure without being contractual.
- **RTO is time to restore service, not time to acknowledge.** Outside Business Hours no response time applies at all, so an incident starting on a Friday evening can exceed the RTO without breaching the contract. Selling a number we only honour 45 hours a week is the kind of thing that ends badly; the contract must state the coupling explicitly.

---

## 5. Regional-disaster residual risk

ADR-0007, and ADR-0017's interim placement after it, keep customer data and backups in Paris. Standard Multi-AZ Object
Storage protects the backup floor from an availability-zone failure inside the
region; it is not an off-site geographic copy.

The current design has **no supported whole-region recovery target**. A complete
or prolonged loss of `fr-par` can exceed every provisional tenant RTO in section
4, because the restore source is in the same region. This limitation is stated
in the service description, DPA and SLA instead of being hidden behind an
untested fleet RTO.

The incident procedure for a regional event still preserves evidence, keeps
customers informed, prevents unsafe failover and prepares reconstruction when
Paris service returns. It does not copy customer data out of the hosting region.

A geographic recovery design requires its own ADR and all gates listed in
ADR-0007, which ADR-0017 carries over, before the first replica exists. Logical disasters remain covered by
the canary, soak, safety snapshot, wave discipline and immutable history.

---

## 6. Monitoring hooks

| Condition | Alert | Severity |
|---|---|---|
| Last verified backup older than 26 h | `BackupStale` | 2 |
| Two consecutive failed backup runs | `BackupFailedTwice` | 2 |
| Last green drill older than 40 days | `RestoreDrillStale` | 3 |
| Drill red | `RestoreDrillFailed` | 2 |
| Bucket audit: lock absent, retention < 30 d, or a delete right on a tenant key | `ObjectLockNotEnforced` | 1 |

The bucket audit runs weekly from the worker and compares the live policy against the intended one. It is Sev-1 because it is the only alert that tells us the safety property we sell has quietly stopped being true.

---

## 7. Acceptance

This spec is satisfied when, for one real tenant: a Paris Standard Multi-AZ bucket exists with `COMPLIANCE` lock ≥ 30 days; the host key demonstrably cannot delete (proved by an attempted delete in the self-test, which must fail); a nightly backup has run for 30 consecutive days; a monthly drill has passed with all nine assertions including the document round-trip; and the identity provider's separate 90-day-locked set has been restored into a throwaway instance and every realm's discovery endpoint answered. No geographic-recovery claim is part of this acceptance gate.

---

## Changelog

| Rev | Change |
|---|---|
| 1 | Initial proposal: per-tenant append-only repository with `COMPLIANCE` Object Lock ≥ 30 days, prune restricted to the worker, backup contents and exclusions, separately handled identity-provider dump with 90-day lock, monthly automated restore drill with nine pass criteria, RPO/RTO per tier, disaster-recovery numbers and second-region model, monitoring hooks. |
| 2 | Review fixes: tier RTO figures marked provisional until drill criterion 8 has produced a measurement, and the high-availability row named as the Enterprise option the SLA schedule ties its 99.9 % ladder to ([`SLO.md`](SLO.md) §9). |
| 3 | Aligns the backup design with ADR-0007: Paris Multi-AZ only, no second-country replica or unsupported whole-region recovery target. |
| 4 | Aligns §1.3 with ADR-0003 and ADR-0005 as accepted: the prune key is the tenant's one human-issued provider key, loaded per job, not a key issued per job; and the shared ops age identity, which can decrypt every bundle encrypted to it, is named as the exception it is and limited to `lab` and `staging`, instead of being said not to exist. §1.3 names the prune and the post-delete purge as infrastructure mutations owed as job kinds, and the key-expiry question they raise. |
| 5 | Cites ADR-0017 beside ADR-0007 in §5: the residency promise becomes the European Union, while the interim placement, the backup floor and the geographic-recovery gates carry over unchanged. |
