# ADR-0014: Shared-plan tenants run in their own `tenant-shared-prod` environment class

**Status:** Proposed
**Owner:** Security seat
**Deciders:** zôÖma, Security seat, Infra seat

## Context

The product sells a shared entry plan beside the dedicated instance. Fleet ADR-0006 records its
hosting model: tenants of the entry plan share application hosts, one media host and one managed
PostgreSQL, all in one shared provider project. A provider project per shared tenant was dropped
for cost. ADR-0013 sets how those hosts are filled.

That shared project fits none of the five closed environment classes of ADR-0012:

- An active `tenant-prod` target has exactly one tenant and exactly one `provider-project`
  allocation with the `tenant-project` role (`ENVIRONMENT_ALLOCATION.md` §1.1). Fleet enforces the
  same rule in its environment policy.
- `platform-prod` forbids a customer tenant, and Fleet refuses any tenant runtime or tenant backup
  in it. That rule keeps customer data out of the platform's boundary.
- ADR-0005 restricts the provisioning credential to one tenant's project and verifies that an
  operation outside that project is denied. A credential for a project that holds several tenants
  either cannot be issued under that rule, or gives a job for one tenant authority over the
  infrastructure of the others.

A shared record therefore either fails the environment gate or needs the gate bypassed. Nothing
ties a shared host to a class either, so a production tenant and a lab tenant could share one.

In the shared model the boundary between tenants is on the host, not at the project. A tenant that
escapes its container lands on the machine that runs the other tenants, whichever project their
buckets live in. The isolation effort goes to the host, and the environment model has to say so
explicitly instead of stretching a one-tenant class.

## Decision

One part of this decision is not settled: how the IAM half of the bucket-policy check is
specified. It is listed under [Open before acceptance](#open-before-acceptance), and this record
cannot be accepted while it is open.

### A sixth environment class

- The closed list of environment classes gains `tenant-shared-prod`. Its properties, in the columns
  of `ENVIRONMENT_ALLOCATION.md` §1.1:

  | Class | Data | Exposure | Failure mutation | Recovery | Subject kind | Customer tenant |
  |---|---|---|---|---|---|---|
  | `tenant-shared-prod` | `customer-tenant` | `public` | `forbidden` | `production` | `shared-paid-tenants` | members: the canary, and zero or more customers |

  The canary's allocations are the one exception to the data kind: they carry a synthetic data
  kind (Credentials and job scope).


- A `tenant-shared-prod` target binds no tenant, so the immutable tenant binding of
  `ENVIRONMENT_ALLOCATION.md` §1.1 stays empty for its whole life. Tenants join and leave it
  through tenant placement allocations (below).
- A shared target is active from its bootstrap until it is retired. Its hosts and its database are
  built before its first tenant joins. Its canary tenant (Credentials and job scope) is its first
  member and stays a member until the target is retired, so an active target holds no member only
  between its bootstrap and the canary's arrival. It may hold no customer tenant, and it stays
  active when its last customer leaves. The single `active` → `retired` transition of the allocation
  contract (`ENVIRONMENT_ALLOCATION.md` §2.4) is unchanged.
- A `tenant-shared-prod` target owns exactly one active `provider-project` allocation, with the new
  role `shared-tenant-project`. It holds only tenants whose hosting model is `shared`. It holds no
  dedicated tenant and no platform service.
- A tenant has at most one active production target, in `tenant-prod` or in `tenant-shared-prod`.
  Moving a tenant between the two is a migration with its own job, never an edit of the target.
  The two cannot overlap, so the move is an outage: the tenant is out of service from the moment
  it leaves one model until it is rebuilt and restored in the other.
- Every host, media host and managed database allocated to a `tenant-shared-prod` target serves
  that class only. Allocation MUST refuse to place a tenant of another class on it.
- The five existing classes and their rules are unchanged. `tenant-prod` keeps exactly one tenant
  and one project.

### Tenant-owned allocations inside the shared target

- Membership of a tenant in a shared target is a ledger allocation under ADR-0012, not a field
  copied into a host record.
- Each tenant in the shared target owns these allocations. Each one names both the target and the
  owning tenant:
  - one tenant placement, which is the tenant's membership record and names the application host,
    the media host and the managed database the tenant uses;
  - one live backup bucket, which holds the tenant's backups, plus any abandoned bucket that
    still waits for its retention to end (Provider-specific rules);
  - two principals on that bucket: a host principal with `Put`, `List` and `Get`, which include
    listing object versions and reading the bucket's lock configuration, and no delete right, and
    a prune principal that only worker jobs for that tenant load;
  - one data bucket, and one data principal on it (below);
  - one mail principal, which holds the tenant's sending key (Provider-specific rules);
  - one Unix UID and GID;
  - one container network, which Fleet renders as the tenant's ingress network and its internal
    network (Fleet ADR-0006);
  - one database role on the managed PostgreSQL, with the tenant's own database.
- Only those two principals reach the backup bucket, and only the data principal reaches the data
  bucket, each with the rights this record gives it. How that
  is enforced depends on the provider (Provider-specific rules, below).
- The prune principal holds list, read, write and delete, because pruning a backup repository
  rewrites it as well as deleting from it. Worker jobs load it for four uses: the prune, clearing
  a stale repository lock, repairing the repository, and purging the bucket once the tenant has
  left and its last object lock has expired (`BACKUP_AND_RESTORE.md` §1.1 and §1.3).
- The host principal's missing delete right does not make backups append-only by itself: a write
  can still replace an object. Append-only relies on Object Lock in compliance mode
  (`BACKUP_AND_RESTORE.md` §1.2), under which a locked object is neither removed nor replaced
  before its retention ends. The human step that creates the bucket creates it with Object Lock.
- The names of a tenant's database and database role are opaque allocation identifiers, not
  derived from its slug. By default every role on a PostgreSQL instance can read the catalogue of
  roles and databases, so a name derived from the slug would show each tenant who the others are.
  ADR-0012 treats that topology as `fleet-confidential`. A bucket name is exposed in the same way
  only to a principal that can list the project's buckets. A tenant's principals cannot, under
  the rights Provider-specific rules gives them.
- A tenant-owned identity is unique across the class and is never reused after the tenant leaves,
  as ADR-0008 already requires for slugs. Allocation MUST refuse two tenants with the same UID,
  bucket, principal, network or database role.
- The shared target owns its application hosts, its media host, its managed database, its state
  bucket, and the canary's two sentinels: an empty bucket and an empty database. A
  tenant's use of them is its tenant placement, not an `EndpointShareDecision`: that ADR-0012
  mechanism shares an endpoint between targets, and a shared tenant is not a target. Changing a
  placement is a ledger revision that passes the placement check of ADR-0013.
- The data bucket has no Object Lock and holds the content the tenant's applications store. The
  data principal holds put, list, get and delete on it, and the tenant's applications load it.
  Every shared tenant has both, whatever the commercial offer: whether Docs is sold as an option
  or included is a pricing decision outside this record. Drive is not part of the shared offer.
- The data bucket is backed up into the backup bucket on the host, reading with the data
  principal and writing with the host principal. Each tenant's backup runs under that tenant's
  UID and holds only that tenant's two keys. No host-wide process holds the keys of several
  tenants.
- Backup verification and the restore drill use the host principal, which the worker loads for
  both. No tenant has a read-only principal. This deviates from `BACKUP_AND_RESTORE.md` §1.3,
  which verifies with `Get` and `List` only, and from its §3.1, which fetches the drill's snapshot
  with a read-only key. The host principal can write, so a verification or a drill can add an
  object to the bucket. Object Lock keeps it from removing or replacing a locked one.
- A restore and a restore drill name the snapshot by the object version ID and the digest that
  Core recorded for it, never by `latest`. That pins the snapshot object only: a restic snapshot
  also reads index and pack objects by key, and a write under the host principal can add a newer
  version of a key. How a restore pins every object it reads is specified in
  `BACKUP_AND_RESTORE.md` before live execution in this class (Consequences).
- A verification and a drill MUST read without taking a repository lock (restic's global `--no-lock`
  option). Restic writes a lock as an object and removes it when it ends, and the host principal
  cannot remove one. Before live execution in this class, a lab run MUST show, for the restic
  version in use, that every command the verification and the drill use, `restic check` included,
  reads without a lock and leaves no object. A command that cannot is not run under the host
  principal.
- A verification or a drill MUST leave no new object or object version in the bucket, as
  `BACKUP_AND_RESTORE.md` already requires of the drill. A check MUST compare the bucket's
  version listing before and after, and ship with a self-test mutation that proves it can fail.

### Credentials and job scope

- The shared project is bootstrapped once through the human-controlled boundary of ADR-0005, with
  the same steps and evidence. Its provisioning credential is restricted to the shared project, and
  verification proves that an operation outside that project is denied.
- Adding a tenant to the shared target creates its principals and its bucket, and limits the bucket
  to its two bucket principals, through the same human-controlled boundary. The provisioning worker
  gains no right to create or change a principal.
- An audited request in Core opens that per-tenant step. Core records for it each principal's
  provider identifier, key fingerprint and key expiry, the digest of each principal's own policy,
  the digest of the normalised form of the bucket's access policy, the operator, the evidence
  reference and the secret references. It records no secret value.
- That audited request reserves the tenant's slug for good, as project bootstrap does for a
  dedicated tenant under ADR-0008. Core makes it once the customer has paid. For the canary, the
  operator makes it once the target is bootstrapped. The principals and the
  bucket of the step come after it, so no external resource of a shared tenant exists before its
  slug is reserved.
- A job for one shared tenant binds to the shared target, and its projection is a positive
  selection of that tenant's own allocations plus the shared hosts and database its placement
  names. It never contains another tenant's allocations. That job MUST NOT receive the
  project-wide provider credential. Its provider and database credentials are limited to its
  tenant: the one bucket principal its kind needs, and its database role.
- No tenant job reaches a shared host. The requirement is that a job acting for one tenant cannot
  read or change another tenant's containers, volumes or secret files. A shared host runs one
  rootful Docker daemon with `userns-remap` and one UID per tenant (Fleet ADR-0006), and any
  credential that can drive that daemon is host-wide: a credential limited to a tenant's UID
  cannot start that tenant's containers, and one that can is not limited to the tenant. All host
  work, the host steps of an operation for one tenant included, is therefore done by target-level
  jobs, with input from Core's records. No per-tenant SSH certificate principal exists in this
  class. One rootless Docker daemon per tenant stays rejected, as in Fleet ADR-0006. Fleet's rule
  `ENV007` already admits only the shared target's job principal on a host.
- Every host step takes the `target` lock exclusively. One tenant's restore therefore blocks host
  work for every other tenant of the target until it ends (Consequences).
- Each shared host runs one Agent, whose commands come from target-level jobs. Its credential
  towards Core acts for every tenant placed on that host. Core MUST hand an Agent a command,
  and accept a report from it, only for a tenant whose placement names the Agent's host. The
  Agent contract and the authorization model do not carry that rule yet (Consequences). The Agent
  decrypts nothing, since no secret is decrypted on a shared host, and it does not change the
  shared edge, which is target-level work.
- A change to a project-level resource, such as a host, a retained address, the managed database,
  the target's DNS zone or the shared edge, is a target-level job. That includes a change made
  for one tenant: its database and database role, its DNS records, its edge routes and its
  certificates. A shared tenant has no DNS zone of its own: its records live in the target's
  zone.
- Target-level jobs are separate job types. They hold the project credential and an SSH certificate
  valid only on the hosts the job's work needs. A host step of an operation for one tenant gets a
  certificate valid only on the hosts that the tenant's placement names, its application host and
  its media host, so it cannot reach the target's other hosts. A target-level job takes
  tenant-specific input only from Core's validated records, the ledger and the tenant record, never
  from a request body at job time.
- Project-level resources live in one OpenTofu state file per shared target. A shared tenant has
  no state file of its own: its project-level resources are in the target's state.
- The state file lives in a bucket of the shared project that the target owns. Its bucket policy
  names the target's job principal and no tenant principal, and the bucket has its own row in the
  bucket-policy check (Provider-specific rules). It is created and limited during the bootstrap of
  the shared project, before any tenant principal exists.
- Every job on a shared target takes the `target` lock of `JOB_CATALOGUE.md`: a tenant job takes
  it shared, and a target-level job takes it exclusively, so no project-level change runs beside a
  tenant job on the same target.
- No step of a job on a shared target waits on a customer or an operator while the job holds the
  target lock. `add_domain` waits for the customer's DNS outside the lock. One state still holds
  the lock across an operator's decision: a job in `needs_reconciliation` keeps its locks reserved
  (ADR-0004). On a shared target that is a cross-customer condition, and it alerts as one.
- The credential equality rule of ADR-0012 applies unchanged: the effective capability and resource
  sets of a job's credential equal its required sets. A project-wide credential on a tenant job
  fails that rule.
- Live execution in `tenant-shared-prod` is blocked, as in the other production classes of
  ADR-0012, until a separate accepted decision provides isolated decryption and one-job secret
  delivery. For this class the isolation is per tenant, which is stricter than per target: one
  tenant's delivery cannot decrypt another member's bundle. A decryption identity isolated to the
  target only would decrypt every member's secrets. The shared operations age identity of
  ADR-0003 is not accepted for this class.
- A target-level job decrypts only the secrets of the tenants its input names. The tenants its input
  names are derived from Core's placement records, never from a request body. The rebuild of the
  shared media host is the one exception: it decrypts every member's LiveKit key, and no other
  secret of theirs.
- The credential proof of `ENVIRONMENT_ALLOCATION.md` §6 needs a denial outside the tenant as well
  as outside the target. Each shared target holds one synthetic canary tenant, with its own bucket
  and database and no customer data. The denial probe of a tenant's credential reads the canary's
  bucket and database. It never touches another customer's resources.
- The canary is a member like any other tenant. It holds a tenant placement and the tenant-owned
  allocations, it takes the per-tenant human step, and it counts against the tenant cap and the
  resource budget of ADR-0013. Its allocations carry a synthetic data kind, which the class admits
  for the canary only. The denial probe of the canary's own principals goes to two sentinels that
  the target owns, dedicated to that probe and kept empty: a sentinel bucket and a sentinel
  database. No probe touches the target's state bucket, which names every tenant's resources. A
  sentinel that is not empty fails the probe.
- The canary probe tests the canary's configuration, not each customer's. For buckets, the check
  over every bucket of the shared project covers the rest (Provider-specific rules). For
  databases, Fleet MUST provide a check over every tenant database of the target that `CONNECT`
  is revoked from `PUBLIC` and granted to the owning role only. The check MUST ship with a
  self-test mutation that proves it can fail.

### Provider-specific rules

The rules of this section depend on how one provider behaves: Scaleway, the provider ADR-0005 is
written for. The class, the tenant-owned allocations, the job split and the lock rule do not
depend on them. The product owner kept Scaleway for shared targets on 2026-10-01: of the hosting
options under study, only the one that moved both plans to another provider changed the shared
plan, and it was ruled out. Where the dedicated plan is hosted is decided separately and changes
nothing here. This section is the first part a later change of provider replaces. Other decided
text depends on the provider too: a managed PostgreSQL, two principals on one bucket, the
`provider-project` allocation, and the Paris region of ADR-0007. A provider outside France first
needs a decision that supersedes ADR-0007.

- On Scaleway a tenant's host, prune and data principals are three IAM applications: its host
  application, its prune application and its data application. Creating an application, its policy
  or its key needs IAM administration, which ADR-0005 keeps at the human-controlled boundary. That
  is why adding a tenant keeps a human step.
- In IAM, the host application holds the permission sets `ObjectStorageObjectsRead` and
  `ObjectStorageObjectsWrite`, and the prune application and the data application each
  hold those two and `ObjectStorageObjectsDelete`, each scoped to the shared project. None of the
  three holds any other permission set. None of these sets lists the project's buckets.
- Object Storage rights in IAM are granted per project. Every principal that holds them reaches
  every bucket of the project until a bucket policy restricts that bucket, and once a bucket has
  a policy, a principal the policy does not name loses access to it. Each tenant bucket therefore
  carries a bucket policy. The policy is the control, not a convenience.
- The policy MUST use version `2023-04-17`. With that version only the actions a policy explicitly
  allows are permitted, and only when IAM allows them too, so deny statements are useless.
  Version `2012-10-17` is deprecated and the provider does not document how it evaluates. A policy
  of that version fails the check below.
- A tenant's backup bucket policy allows exactly its host and prune applications, and its data
  bucket policy exactly its data application, each with exactly the actions of its principal, and
  nothing else. The host application's actions include two that
  step 5 of the human step below needs: `s3:ListBucketVersions`, which the provider keeps distinct
  from listing objects, and `s3:GetBucketObjectLockConfiguration`.
- The right to put or delete a bucket policy is not something the policy document grants: the
  provider's list of bucket-policy actions has none for it. It comes from IAM permission sets, among
  them `ObjectStorageBucketPolicyFullAccess`, the only one measured, and from the Organisation
  Owner's inherent right. No tenant application, no job principal and no operator outside the
  human-controlled boundary holds that permission set, or another one that puts or deletes a bucket
  policy.
- Reading a bucket policy is not something the policy document grants either: the provider refuses a
  policy that names `s3:GetBucketPolicy`. A permission set reads it.
  `ObjectStorageBucketPolicyFullAccess`, added to `ObjectStorageBucketsRead`, read and replaced the
  policy of each tested bucket, named in it or not. `ObjectStorageReadOnly` read a policy that did
  not name its holder and could not replace, delete or create one (measured, References).
- Organisation Owner credentials never reach a host, a job or a worker.
- The per-tenant human step runs in this order, inside the human-controlled boundary:
    1. create the host, prune, data and mail applications, without keys;
  2. create the backup bucket, with Object Lock, and the data bucket, without;
  3. apply both bucket policies, read each back, and stop if its normalised form differs from the
     applied document's (the bucket-policy check below);
  4. issue the host application's key and the data application's key;
  5. with those keys, verify that neither bucket holds an object or an object version, and that
     the backup bucket's lock configuration is the one specified;
  6. record the step in Core as verified, with that evidence;
  7. only then deliver a key to a host or a job, and issue and record the prune application's
     key and the mail application's key. Core records the step complete only once every key is
     recorded.

  The verification uses the host and data applications' keys because, once the policies apply, only
  the tenant's applications reach its buckets, and the operator is not one of them. It covers two
  things because, between its creation and its policy, a bucket is open to every principal with
  Object Storage rights in the project. Another tenant's application can write an object there,
  which Object Lock then keeps. Its object-write permission set also lets it change the bucket's
  lock configuration, which an emptiness check does not see. The host application's actions
  therefore include listing object versions and reading that configuration. Issuing those two keys
  and using them in step 5 stay under ADR-0005 step 3: the value goes through the approved injection
  path and never enters a terminal transcript, so the verification is run through that path. A
  bucket that fails the verification is abandoned. What the bucket-policy check expects of an
  abandoned bucket during its retention period is set out with the checking application below. This
  verification is the operator's, of the bucket. The credential verification of ADR-0005 step 5
  comes after it, since it needs a delivered key.
- Fleet MUST provide a check over every bucket of the shared project. It is an allow-list with
  two halves, and anything outside the allow-list fails:
  - the policy document: the bucket has a policy, its version is `2023-04-17`, its principals are
    exactly the applications this section gives that bucket, and each has exactly its actions;
  - the IAM side: each tenant application holds exactly the permission sets listed in this section;
    the checking application holds exactly its three, and its live IAM policy equals its recorded
    digest; and in the shared project no principal outside the human-controlled boundary holds a
    permission set that puts or deletes a bucket policy. A rule scoped to the organisation is
    treated as reaching the shared project too, and a policy attached to a group is treated as
    reaching each of its members: both count. How this half is specified so that it can be computed
    is open (Open before acceptance).

  The target's state bucket and its sentinel bucket each have their own row: each policy names
  exactly the target's job principal. No bucket policy names the checking principal: a policy
  cannot grant it a read, and naming it could give it object access, which was not measured.

  The provider rewrites a policy when it stores it: it returns a one-element array as a scalar, and
  it sorted a two-element `Action` array (measured, References). The check and the digest Core
  records therefore use one normalised form of a policy: `Id` dropped; `Action`, `Resource` and the
  principal list each a sorted array, a scalar read as a one-element array, a duplicate entry a
  failure; statements sorted by a `Sid` that each has and that is unique; any key outside `Version`,
  `Statement`, `Sid`, `Effect`, `Principal`, `Action` and `Resource` a failure; keys sorted, no
  whitespace. The digest is the SHA-256 of that form.

  The check MUST ship with a self-test mutation for each half that proves it can fail. For the
  normalisation, a policy that differs only by a scalar for a one-element array, or only by the
  order of a multi-element array, still matches, and an extra action, an extra principal, a missing
  statement, a version other than `2023-04-17` and an unknown key each fail. For the IAM half, an
  extra permission set on the checking application fails; the other mutations of that half are
  part of the open item.
- The check runs automatically and is never a human step. Its principal is one IAM application
  per shared target, the checking application. It is created during the bootstrap of the shared
  project, inside the human-controlled boundary, and Core records its provider identifier, key
  fingerprint, key expiry and the digest of its IAM policy. No bucket policy names it.
- In IAM the checking application holds `ObjectStorageReadOnly`, scoped to the shared project, and
  `IAMPolicyReadOnly` and `IAMGroupReadOnly`, scoped to the organisation, and no other permission
  set. The provider scopes its IAM read permission sets by organisation, not by project. Neither
  `ObjectStorageBucketsRead`, which reads no policy, nor `ObjectStorageBucketPolicyFullAccess`,
  which replaces one, is used. Measured on the provider on 2026-10-02 (References), each set held
  by an application and measured in a throwaway project of the organisation:
  - `ObjectStorageReadOnly` listed the project's buckets and read the policy of the tested bucket,
    which did not name its holder, with the normalised form the operator read. It was denied on
    replacing, deleting or creating a policy. On a bucket with no policy it got
    `NoSuchBucketPolicy`; the check fails on that response and on any other that is not a policy;
  - `IAMPolicyReadOnly` read the rules of a policy, their permission sets and their project or
    organisation scope, with the same permission sets and scope as the operator read. It listed no
    group and read no member;
  - with `IAMGroupReadOnly` added, the application listed groups and read the tested group: its one
    member application and an empty `user_ids` field. Whether it reads a non-empty user membership
    is not measured;
  - with `IAMPolicyReadOnly` alone, updating, creating and deleting a policy and updating a group
    were denied; with both IAM sets, updating a group, adding the application itself to a group and
    removing a member were denied. In both tested configurations the application listed no
    application. `IAMGroupReadOnly` was never tested alone.
- The provider defines these permission sets and can change what each one grants. The check
  compares which sets each principal holds with what Core recorded, never what a set grants. A
  provider change that widens a set the check relies on therefore goes undetected. This is a
  residual risk of the shared plan, which the product owner chose on 2026-10-05 over building a
  probe before acceptance:
  - What goes undetected: a provider change to a permission set the check relies on, those of the
    checking application and those of the tenant applications. If `ObjectStorageReadOnly`,
    `IAMPolicyReadOnly` or `IAMGroupReadOnly` came to grant a write, the checking application's key
    could change bucket policies or IAM. If a set a tenant application holds came to grant putting
    or deleting a bucket policy, that tenant's key could replace or delete the policy of a bucket
    of the shared project, another tenant's included. In both cases the IAM half still passes,
    since every principal holds exactly its recorded sets. A change that narrows a set so that a
    read the check needs is denied is outside this risk: the bucket-policy read then gets a
    response that is not a policy, which fails the check; failing closed on a denied IAM read is
    part of the probe below.
  - Owner: the product owner, who accepts this risk only by ratifying this record, on the same terms
    as the kernel, LiveKit and mail risks. While this record is Proposed, nobody has accepted it.
  - Controls that remain: the policy-document half compares each bucket's live policy with the
    policy this section gives that bucket each time the check runs, whoever changed it, so a policy
    put or deleted through a widened set fails the next run unless it was restored before that run.
    The IAM half fails when a principal holds a set other than its recorded ones, or when the
    checking application's live IAM policy differs from its recorded digest: a change to who holds
    which set is still detected, only a change to what a set grants is not. The checking
    application is created and keyed at the human-controlled boundary, Core records its key
    fingerprint and expiry, and only a target-level job loads its key.
  - Revisit: when kodera-core issue #147, the probe of the provider's permission sets, is
    delivered, it replaces this risk through a change to this record or to its successor. Revisit
    earlier when one of the following occurs: the provider documents a change to a permission set
    this section names; a check run fails on a bucket policy that no recorded job changed; a key of
    the checking application or of a tenant application leaks.
- The checking application reaches more than the policies. This record states that reach; the
  product owner accepts every read its three permission sets grant, measured or not, only by
  ratifying this record. Measured: on the tested bucket, whose policy did not name it,
  `ObjectStorageReadOnly` listed and read no object; on a bucket with no policy it listed and read
  the objects. Such a bucket already fails the check and is open to every principal with Object
  Storage rights in the project. With the two IAM sets, the tested application read the rules of the
  tested policies and the member applications of the tested group, whose `user_ids` field was empty;
  the bucket-policy read measurement (References) read 18 IAM policies outside its throwaway
  project. Since both sets are scoped to the organisation, they are taken to read the IAM policies,
  rules and groups of the whole organisation: the platform's and each dedicated tenant's principals,
  and those of every project of the organisation that is not part of this offer. Not measured: the
  other reads of a bucket, such as object versions, lock configuration and lifecycle, on a bucket
  whose policy does not name it; a policy attached to a user; the user members of a group; a rule
  naming several projects; listing users and API keys with `IAMGroupReadOnly` added; listing beyond
  one page; any region other than `fr-par`.
- A target-level job loads the checking application's key, never a tenant job. It also runs the
  two verifications of the narrowed ADR-0005 that read the same policies: the comparison of each
  tenant application's live IAM policy with its recorded digest in step 5, and the verification of
  the bucket policy at the start of `provision`.
- An abandoned bucket keeps its tenant-owned allocation, marked abandoned, until its last object
  lock expires. Until then the check expects the same policy as on a live bucket of that tenant
  and fails on any difference. Once the bucket is purged and deleted, the check expects it gone. A
  bucket of the shared project with no allocation fails the check.
- Mail permission sets are granted per project too, and the provider's resource-level conditions
  cover IAM, Key Manager and Secret Manager only. By that documentation, a mail credential issued
  in the shared project cannot be limited to one tenant's domain.
- Each shared tenant sends mail from the tenant's domain with one sending key of its own. How that
  domain is named is outside this record and does not block its acceptance. The key belongs to the
  tenant's mail application, which MUST hold exactly one permission set, scoped to the shared
  project: `TransactionalEmailEmailSmtpCreate` when it sends over SMTP, or
  `TransactionalEmailEmailApiCreate` when it sends through the provider's HTTP API. The two are not
  interchangeable. On 2026-10-06 (References) the identity service's staging SMTP login was refused
  (`535 5.7.8 Invalid credentials`) with `TransactionalEmailEmailApiCreate`, which the provider
  describes as not including sending over SMTP, and its mail was delivered with
  `TransactionalEmailEmailSmtpCreate` in its place; the public landing page's mail application
  holds `TransactionalEmailEmailApiCreate` alone and sends through the HTTP API (landing runbook
  §§2.7 and 7.3, References). What else either set grants is not measured. Whether the IAM half of
  the bucket-policy check covers the mail applications is part of its open item. The tenant's
  sending domain is a project-level resource, made by a target-level job.
- The realm of an organisation that holds a shared tenant sends its mail, which `realm_create` and
  `configure_smtp` set up on the identity service, with a sending key of its own. That key belongs
  to the organisation, not to a tenant: a realm exists before any tenant and serves every tenant of
  its organisation, so no tenant's key, rotation or exit can break it. It is an organisation-owned
  mail application in the shared project, created and keyed at the human-controlled boundary like a
  tenant's, with the permission set of the transport it uses. Its life follows the organisation: it
  is issued with the request that opens the organisation's first shared tenant, and revoked when the
  organisation's last shared tenant has left. The identity service therefore holds a credential of
  the shared project. Which domain the realm sends from with that key is outside this record, like
  the tenant's domain.
- The realm sends mail before that request. `realm_create` runs at the organisation's intake, before
  any tenant exists, and the owner claim requires a contact the realm has verified
  (`FIRST_OWNER_BOOTSTRAP.md` §8.2), which the realm verifies by mail. Until the organisation-owned
  key is issued, the realm sends from the identity service's own sending domain, with the key of the
  mail project that holds that domain, as do the realms that belong to no customer organisation
  (ADR-0015). Once the request that opens the organisation's first shared tenant has issued the
  organisation-owned key, a `realm_update` sets the realm's mail to it.
- Outside the shared project, whose cross-domain reach is the accepted risk below, a realm never
  uses a key of a provider project from which another system sends. Every key of a project can send
  as each domain of that project, so a realm on such a key could send as that system, and a
  reputation problem or a leaked key on one would reach the other.
- Every sending key of the shared project, a tenant's or a realm's, can send as every domain of
  that project, not only its own. A leaked key, a compromised tenant backend or a compromised
  identity service can therefore send mail as another shared tenant. This is an
  accepted risk of the shared plan. Its acceptor is the product owner, on the same terms as the
  kernel and LiveKit risks: recorded by the ratifying pull request, and nobody before it.
- The sending key is a provider credential on the shared host that resolves beyond its tenant. It
  is the one exception to the rule that replaces the fourth clause of ADR-0003 (Relationship to
  accepted and proposed decisions); the LiveKit signing secret is outside that rule's scope.
  Fleet MUST carry a preflight assertion that a tenant's key is refused for another tenant's
  domain, kept as a known failing assertion with a recorded exemption.
- A possible future hardening, not part of this decision and not an acceptance or launch gate, is a
  mail relay in the shared project that alone holds the sending key. Each tenant and each realm
  authenticates to it with its own login, and the relay refuses a sender outside that login's domain
  (Postfix `reject_sender_login_mismatch`). The relay becomes a shared component on which every
  shared tenant's mail depends.
- Revisit this risk, and decide on the relay, when one of the following occurs, as for the LiveKit
  risk:
  1. a sending key leaks, a tenant's or a realm's;
  2. a tenant's backend or the identity service is confirmed compromised;
  3. mail sent as one tenant's domain with another tenant's or another organisation's key is found;
  4. a customer contract requires separation of mail senders.

### Host isolation, and what it does not cover

- On a shared host, every container of a tenant runs as that tenant's UID and GID, with its volumes
  and secrets owned by it. `userns-remap`, dropped capabilities, `no-new-privileges`, a read-only
  root filesystem, the default seccomp profile, per-tenant CPU, memory and PID limits, and no Docker
  socket in any tenant container come on top. All of these are requirements of this record. Fleet
  ADR-0006 specifies the rules and the checks for them, except for the seccomp profile and the PID
  limit, which Fleet does not carry yet.
- Core records the per-tenant UID, network and database role as allocations. Fleet MUST enforce
  them on the host.
- These controls separate the tenants' processes and files. They do not limit a credential that
  drives the Docker daemon, which is why no tenant job reaches a shared host (Credentials and job
  scope).
- The kernel is shared. A kernel exploit crosses tenants. This is an accepted risk of the shared
  plan. Its acceptor is the product owner, not a seat: the product owner accepts it by ratifying
  this record. The change that accepts the record edits only its status, so the ratifying pull
  request records the acceptor. While this record is Proposed, nobody has accepted it.
- The public description of the shared plan does not claim kernel-level isolation between
  customers.
- The kernel is not the only component the tenants of one host or one target share. The shared edge,
  the one Docker daemon, the Agent of each host, the shared PostgreSQL instance and target-level
  jobs cross tenants too. This record accepts no risk for them. The threat model has to cover each
  (Consequences).
- Revisit the kernel risk when one of the following occurs: a published container escape affects
  the host kernel in use; a customer contract requires separation from other customers; or a
  tenant outgrows its tier. The answers are a sandboxed runtime or a virtual machine per tenant,
  or a move to the dedicated model.

### Shared LiveKit signing secrets, an accepted risk

- All shared tenants use one LiveKit server. Each tenant has its own LiveKit API key and secret, as
  Fleet ADR-0006 records, so one tenant can be revoked without touching the others.
- A tenant's Meet backend holds its tenant's LiveKit signing secret, because it signs the access
  tokens for its rooms.
- A LiveKit key carries no room namespace. Every signing secret the server accepts can sign a valid
  token for any room on it. Fleet ADR-0006 measured this: one tenant's key lists and joins another
  tenant's room.
- An attacker who compromises one tenant's Meet backend can therefore read that tenant's signing
  secret, sign a token for another shared tenant's room, and join that tenant's call. Fleet ADR-0006
  also records list and administration actions on other tenants' rooms.
- This weakness does not depend on host isolation. The attacker needs no container escape: holding
  one signing secret is enough. The per-tenant UID, network and hardening above do not reduce it.
- The shared credential is a LiveKit API signing secret that generates access tokens. It is not one
  shared access token. Per-tenant keys give per-tenant revocation after a compromise is detected.
  They give no isolation between tenants.
- The shared model provides no cryptographic isolation between tenants at the LiveKit credential
  layer. This is an accepted risk of the shared tier for the initial architecture. Its acceptor is
  the product owner, on the same terms as the kernel risk: recorded by the ratifying pull
  request, and nobody before it. One LiveKit deployment per tenant is not required: it would
  bring back most of the infrastructure cost and operational load the shared plan exists to
  avoid.
- The public description of the shared plan does not claim media isolation. A customer who needs
  it is sold the dedicated model.
- A possible future hardening, not part of this decision and not an acceptance or launch gate, is a
  central LiveKit token broker:
  1. Tenant Meet backends no longer receive a LiveKit signing secret.
  2. Only the broker holds the LiveKit signing secrets.
  3. A tenant backend requests a room token from the broker, authenticated with its tenant identity.
  4. The broker checks that the requested room belongs to that tenant before it signs the token.
  5. A compromised tenant backend can then obtain tokens only for its own tenant's rooms. It can no
     longer sign arbitrary LiveKit tokens.
  6. The LiveKit deployment stays shared, and the shared plan keeps its cost and operational
     advantages.

  The broker becomes a security-sensitive shared component, and the trust boundary moves into it.
  It must enforce strong tenant authentication and authorization itself. Fleet ADR-0006 also names
  one LiveKit process per tenant on the media host as another path.
- Revisit this risk when a compromise of a tenant's Meet backend is confirmed, or when a customer
  contract requires media separation from other customers.

## Open before acceptance

This record cannot be accepted while an item of this section is open. An item is closed by a
reviewed change to this record, made while it is Proposed, that replaces the item with the
decision taken. The change that accepts the record edits only its status, so it cannot close an
item.

Acceptance order:

1. Every item of this section is closed.
2. ADR-0012 and ADR-0013 carry text that agrees with this record before any of the three is
   accepted. For ADR-0012 that is the six-class list and a live-execution gate stated per tenant
   for this class. Neither of the two is accepted while this record has an open item that its
   text depends on.
3. The product owner ratifies the merged text of this record. A status-only change accepts it,
   and the pull request that carries that change records the ratification.

Fleet ADR-0005 and Fleet ADR-0006 each state that they are not accepted before this record.
Accepting this record also fixes its provider-specific rules as written: after acceptance, a
change of provider replaces them through a superseding decision, not through an edit.

The item on the principal that runs the bucket-policy check was closed while this record was
Proposed, by the change that cites the three provider measurements of 2026-10-02 (References). The
first withdrew the answer that named the checking principal in every bucket policy, since the
provider refuses `s3:GetBucketPolicy` in a policy. In the second, both `ObjectStorageReadOnly` and
`AllProductsReadOnly` read a policy that did not name them and could not replace, delete or create
one; the narrower, `ObjectStorageReadOnly`, is the one this record names. In the third,
`IAMPolicyReadOnly` read policy rules but no group, with `IAMGroupReadOnly` added the application
read the tested group's member, and every IAM write tried was denied (Provider-specific rules). The
prepared fallback, `ObjectStorageBucketPolicyFullAccess` held by the checking application, and the
risk it carried are dropped.

One item remains. It states the requirement and what it waits on.

- **The IAM half of the bucket-policy check.** As written, that half forbids principals outside
  the human-controlled boundary any permission set that puts or deletes a bucket policy, but no
  record lists those sets: of the sets that could, only `ObjectStorageBucketPolicyFullAccess` was
  measured. The closing change specifies:
  - an allow-list of principals: every principal that a rule reaches in the shared project,
    through a project or organisation scope, directly or through a group, is one Core records,
    holding exactly its recorded sets. That covers the tenant applications, the checking
    application and the application that holds the project key. Core records which users and
    groups are inside the human-controlled boundary. Any other principal fails. The change says
    whether that allow-list replaces the rule that no principal outside the boundary holds a set
    that puts or deletes a bucket policy;
  - that no permission set the allow-list grants puts or deletes a bucket policy, shown by the
    provider's documentation or by a measurement, `ObjectStorageObjectsWrite` and
    `ObjectStorageObjectsDelete` included;
  - each tenant's mail application and each organisation's realm mail application: either their
    permission set is named and checked, or the check is stated as not covering them;
  - whether `IAMPolicyReadOnly` returns policies attached to a user, and whether `IAMGroupReadOnly`
    returns the user members of a group, each measured or else the check stated as not covering
    it;
  - how the check detects that the provider changed a permission set it relies on: not by the
    closing change. The product owner chose a residual risk, stated with its owner, controls and
    revisit trigger in Provider-specific rules; the probe is kodera-core issue #147;
  - the normalised form of an IAM policy's rules, every field included and a rule naming several
    projects covered, for the check and the digest Core records; listing every page; and a bucket
    of the shared project in a region other than `fr-par` failing the check;
  - one self-test mutation for each of those rules.

  Waits on: the closing change that specifies the rest.

## Relationship to accepted and proposed decisions

- **ADR-0003.** On acceptance, this decision narrows four clauses of ADR-0003, and only for
  `tenant-shared-prod` targets.
  - The provider key "restricted to one tenant project". A target-level job loads a key restricted
    to the shared project. A tenant job receives no project key, only the bucket principal of its
    tenant that its kind needs. The target-level job that runs the bucket-policy check also loads
    the checking application's key. It is the one key of this class not restricted to the shared
    project: its two IAM permission sets read IAM across the organisation. It holds only sets the
    provider describes as read access, and every write tried with them was denied (Provider-specific
    rules).
  - The SSH certificate "with a per-tenant principal". A target-level job uses a certificate
    valid only on the hosts its work needs; for a host step of an operation for one tenant, only
    on the hosts that the tenant's placement names. No per-tenant principal exists in this class:
    no tenant job reaches a shared host. The 8-hour limit stays.
  - Tenant secrets "are decrypted only on the tenant VM they serve". A shared host serves many
    tenants, so no key-unwrap credential exists on it and no secret is decrypted there. A tenant's
    secrets reach the host only as files owned by that tenant's UID, mode 600. Where they are
    decrypted, and by which identity, belongs to the separate decision the live-execution gate
    waits for.
  - "No tenant VM holds a credential that resolves outside its own Scaleway project (TEM subdomain
    and DNS sub-zone are created in the tenant project). Preflight asserts this." In a shared
    project that rule stops separating tenants: a credential that resolves inside the project can
    reach every tenant in it. It is replaced by a rule scoped to what the design delivers: no
    provider credential on a shared host resolves beyond the one tenant it belongs to. The host
    holds no project credential. The provider credentials on it are each tenant's host principal and
    data principal, each limited to one bucket of that tenant, and each tenant's mail sending key,
    which is scoped to the shared project and is the one recorded exemption. Preflight MUST assert
    that, per tenant, against the canary tenant. The rule does not cover every credential on the
    host. Each tenant's LiveKit signing secret is on the host and reaches other tenants' rooms. That
    is the accepted risk of the LiveKit section, and Fleet keeps its room-scope check as a known
    failing assertion with a recorded exemption (Fleet ADR-0006). Each tenant's mail sending key can
    send as every domain of the shared project. That is the accepted mail risk of Provider-specific
    rules, and Fleet MUST keep a known failing assertion for it. A shared tenant has no DNS
    sub-zone: its records live in the target's zone and are written by target-level jobs. Its
    sending domain is made in the shared project by a target-level job.

  The other ADR-0003 controls stay in force: no infrastructure credential in the API process,
  per-job loading, the 8-hour certificate limit, envelope encryption under a key in Key Manager,
  secret files written mode 600, the per-realm service account, hardware-bound human age
  identities, and the shared ops age identity limited to `lab` and `staging`.
- **ADR-0004.** On acceptance, this decision narrows three clauses of ADR-0004, and only for
  `tenant-shared-prod` targets.
  - "Every infrastructure mutation is a job", where ADR-0004 counts a storage bucket among the
    infrastructure mutations. For a shared tenant, creating its bucket, applying the bucket's
    policy and deleting the bucket are steps at the human-controlled boundary, not jobs. So are
    creating the target's state bucket and its sentinel bucket and applying their policies. Pruning
    and purging its objects stay worker jobs.
  - "One OpenTofu state file per tenant". A shared tenant has no state file. A shared target has
    one, which holds its project-level resources, those made for one tenant included. The
    per-tenant advisory lock stays: a tenant job still takes its tenant's lock.
  - Drift detection "per tenant, stored on `Tenant.observed`". The nightly plan of a shared
    target runs against the target's state file, and its result belongs to no tenant. Where it is
    recorded is a follow-up to `MODEL.md`, not designed here.

  The rest of ADR-0004 is extended, not changed. A shared target uses the existing `target` lock
  class, as ADR-0004 already takes a per-organisation lock for a resource an organisation's
  tenants share. A job in `needs_reconciliation` keeps its lock set reserved, as ADR-0004
  requires; Consequences states what that costs on a shared target.
- **ADR-0005.** On acceptance, this decision narrows these ADR-0005 clauses, and only for
  `tenant-shared-prod` targets. ADR-0005 is not superseded as a whole.
  - Step 1: the bootstrap request is made once for the shared target, before its first tenant, not
    for an `ordered` tenant. Core creates a separate audited request for each shared tenant's
    human step, in the way step 1 creates one for a tenant project.
  - Step 2: the operator creates the shared project, its IAM application, a policy restricted to
    that project and its expiring key once, and creates the target's state bucket and its sentinel
    bucket with their policies. Once too, the operator creates the checking application, its
    policy, scoped as Provider-specific rules sets out, partly beyond the shared project, and its
    expiring key. For each tenant, the operator then creates the tenant's principals
    and its bucket and limits the bucket to its bucket principals, as Provider-specific rules sets
    out.
  - Step 4: for the shared project, Core records what step 4 lists, and the checking application's
    provider identifier, key fingerprint, key expiry and IAM policy digest. For each tenant, Core
    records each principal's provider identifier, key fingerprint and key expiry, the digest of each
    application's IAM policy, the digest of the normalised bucket policy, the operator, the evidence
    reference and the secret references.
  - Step 5: verification proves that the project key is denied outside the shared project, that each
    tenant application's live IAM policy equals its recorded digest, and that each tenant principal
    is denied on the canary tenant's bucket. It probes no other customer's resources. The comparison
    with the live IAM policy is run by the checking application (Provider-specific rules): a
    credential restricted to the shared project cannot read it. The checking application's key is
    not the project key: its IAM sets read beyond the shared project by design (Provider-specific
    rules).
  - Step 6: target-level jobs load the project key; the target-level job that runs the bucket-policy
    check also loads the checking application's key. Tenant jobs load only their tenant's
    credentials.
  - The `provision` clause: `provision` of a shared tenant begins by verifying the target's
    accepted bootstrap and the tenant's verified principals and bucket access policy. The
    comparison with the live policies is run by the checking application (Provider-specific
    rules).

  Step 3 stays in force unchanged: the one-job secret injection. So do the human-controlled
  boundary and the rule against unattended project creation.
- **ADR-0006.** On acceptance, this decision narrows two statements of ADR-0006, and only for
  `tenant-shared-prod` targets. Its realm topology is unchanged: a shared tenant authenticates
  against its organisation's realm, and what ADR-0006 says of people stands.
  - "A tenant slug is a DNS label and a Scaleway project name". A shared tenant has no project,
    so its slug is a DNS label and names no project.
  - "What the per-tenant client secret, LiveKit API secret, TEM key and infrastructure separate
    is the tenants' services", which ADR-0006 requires every description of tenant isolation to
    say. A shared tenant has no infrastructure of its own. Its LiveKit secret does not separate
    its media from other tenants', which is the accepted risk of the LiveKit section. Its mail
    sending key does not separate its mail from the other shared tenants' domains, which is the
    accepted mail risk. Its client secret is unaffected. What separates the services of
    shared tenants is the tenant-owned allocations of this record, and a description of their
    isolation says that instead.
- **ADR-0012.** This decision extends ADR-0012's closed class list to six. It also adds the
  `shared-tenant-project` role, to a vocabulary ADR-0012 does not hold: `ENVIRONMENT_ALLOCATION.md`
  §1.1 names the `tenant-project` role, and Fleet's environment policy holds the list of roles.
  The one-tenant, one-project rule of `tenant-prod` is unchanged. ADR-0012 and
  `ENVIRONMENT_ALLOCATION.md` carry the six-class list, and a live-execution gate stated per
  tenant for this class, before ADR-0012 or this record is accepted (Open before acceptance).
- **ADR-0007.** Unchanged. The shared project, its hosts, its database and every backup stay in the
  Paris region.
- **ADR-0008.** Its no-reuse rule is applied to every tenant-owned identity, UIDs included. On
  acceptance, this decision extends its list of events that reserve a slug, and only for
  `tenant-shared-prod`: the audited request that opens a shared tenant's per-tenant step reserves
  its slug for good.
- **ADR-0013.** It decides how shared hosts are filled. This decision decides which class and
  which project they belong to, and its tenant placement is the record the ADR-0013 placement
  check reads. ADR-0013 records a tenant's use of the shared media host and database as that
  placement, and cites this record for the shared project. It counts the canary against its
  tenant cap and its resource budget like any member, and says so before either record is
  accepted.

## Options considered

| Option | Decision |
|---|---|
| Put the shared project in `platform-prod` and relax its tenant ban | Rejected. It places customer data inside the platform's boundary, which the ban exists to prevent. |
| Several `tenant-prod` targets that share one provider project | Rejected. A provider resource has one owner target under ADR-0012, and each target's credential would cover the other tenants. |
| Shared hosts in one project, plus one provider project per tenant for its bucket and keys | Rejected. It brings back one project per customer, which the plan dropped for cost, and a host escape still reaches every tenant's keys on that host. |
| A new `tenant-shared-prod` class, one shared project, tenant-owned allocations and host isolation per tenant | Chosen. It names the real boundary, keeps every existing class unchanged, and keeps provider IAM administration human-controlled. |

## Consequences

The follow-ups below are those that the author and the reviews of this record found on core
`main` and on Fleet `main`. The list is not claimed to be complete.

- `ENVIRONMENT_ALLOCATION.md` needs the new class row with its empty tenant binding, the
  `shared-tenant-project` role, the tenant placement and the other tenant-owned allocation kinds,
  an owning tenant on those allocations, and the job binding for shared tenants. Its §1.2 makes each
  new kind a contract-version decision with its own collision test, projection rule and self-test
  mutation. It also needs a shared target that is active with no member (§2.4), a projection
  limited to one tenant inside a target (§4), the denial probe against the canary tenant (§6), and
  the gates of this class, tenant-isolated decryption among them (§11). The canary is a member
  with a synthetic data kind that the class admits for it only, and §6 probes the canary's own
  principals against a sentinel bucket and a sentinel database that the target owns and keeps
  empty. The realm mail application of an organisation fits none of its rules: §1.2 gives every
  resource exactly one owner target, while that application belongs to an organisation and outlives
  each of its tenants, and its key is used by the identity service, outside the shared target,
  where §1.2 forbids cross-target consumption of any resource that is not a service endpoint with
  an `EndpointShareDecision`.
- `JOB_CATALOGUE.md` needs the split between tenant jobs and target-level jobs on a shared target,
  every host step as target-level work, `backup` included, since it runs on the host, the mode each
  takes on the `target` lock, the tenant-limited credential, and the rule that no step waits on a
  customer or an operator under the target lock. Its **Credentials** paragraph in §1 restates the
  one-tenant-project key and the per-tenant SSH principal of ADR-0003. In §2, these kinds assume a
  tenant's own project, host or state file and need a shared form:
  - `bootstrap_verify`, which verifies a policy that names exactly one tenant project;
  - `provision` steps 4 to 8, which reserve addresses, create a host, a delegated sub-zone and a
    mail subdomain in the tenant project, and create the bucket from the worker;
  - `add_domain`, which holds its locks while it waits for the customer's DNS, and whose edge
    change is target-level work;
  - `upgrade` and `restore`, whose `maintenance_on` and `maintenance_off` change the edge;
    `suspend` and `resume`, whose edge notice does; `remove_domain`; and a `rotate_secret` of a
    database password or a media key. Each has a target-level part and can no longer be one job;
  - `rotate_secret` step 3, where the Agent renders a secret on the host;
  - `delete` and `drift_check`, which act on the tenant's state file;
  - the migration between the two hosting models, which is not a kind yet and spans two targets,
    where a job binds one;
  - `realm_create` step 5, `configure_smtp`, which sets "the tenant's own mail credentials": a
    realm is set up at intake, before any tenant, and sends with the identity service's key, then
    with its organisation's key once its first shared tenant opens, which `realm_update` sets.

  How `add_domain` is split so that its wait is outside the lock, under ADR-0004's rule that a job
  takes its whole lock set before its first step, is part of that follow-up.
- `UPGRADE_PROCEDURE.md` describes an upgrade as one job that raises maintenance mode and lifts
  it itself. For a shared tenant the edge part is target-level work. `JOB_QUEUE.md` carries the
  `CHECK` that `tenant_id` is null only for the two realm kinds, which refuses a target-level
  job.
- `OBSERVABILITY_STACK.md` §6 and `RUNBOOK_INDEX.md` need an alert and a runbook for a job of a
  shared target in `needs_reconciliation`, as a cross-customer condition.
- `MODEL.md` has no way to say that a tenant is shared. In §5, `Tenant` carries no hosting model and
  one `scaleway_project_id`, its `slug` is described as a project name, as in ADR-0006,
  `ProjectBootstrap` records one project per tenant (invariant 16 in
  §11), a `Host` belongs to a single `tenant_id` with its `shared` role left for a future host under
  ADR-0002, and an `Ip` belongs to a single tenant with at most one `web` and one `media` address
  per tenant. A `CHECK` on `Job.tenant_id` allows no tenant only for the two realm kinds, so a
  target-level job cannot be recorded. In §7, a `Secret` carries the reference the Agent pulls it
  by. In §9, there is one active `Agent` per tenant. `MODEL.md` needs the tenant's
  hosting model, a bootstrap owned by the shared target, the record of the per-tenant human step,
  the slug reserved by the request that opens that step where §1 says provisioning, an Agent
  bound to a shared host, the object version ID and digest of each backup snapshot,
  hosts and addresses owned by that target, target-level jobs, and a place for the drift plan of
  a shared target, which `Tenant.observed` cannot hold.
- `THREAT_MODEL.md` needs the shared class in:
  - assets A3, A5, A13 and A15 in §1: SSH access under a per-tenant principal, tenant secrets in
    plaintext only on the tenant VM with a mail key among them, two retained addresses per tenant,
    and a DNS sub-zone delegated into the tenant project;
  - boundaries B4 and B5 in §2 and attacker P3 in §3: a separate project, VM, NIC, Postgres, Redis,
    LiveKit, bucket and mail key per tenant, an Agent per tenant VM, and root on one
    tenant's host;
  - the preamble and the rows of B4 in §4, where the preamble restates ADR-0006 on what separates
    the tenants' services, and the row of B3 on a credential that resolves outside the tenant's
    project;
  - the worker model in §5: W3 and the credential lifecycle name one tenant project per provider
    key, and the escalation paths say a tenant VM holds no credential outside its own project;
  - the §6 decision "One Scaleway project per tenant";
  - its §7 residual risks: RR11 assumes one expiring key per tenant, and the shared kernel, the
    LiveKit signing secrets that reach another shared tenant's rooms and the mail sending keys
    that reach every domain of the shared project have no entry yet;
  - the cross-tenant components of the shared model, none of which it names: the shared edge, the
    single Docker daemon, the Agent of each shared host, the shared PostgreSQL instance and
    target-level jobs;
  - the realm mail key of each organisation, a credential of the shared project that the identity
    service, a platform service, holds;
  - the checking application's IAM read, scoped to the organisation, which reads the IAM policies,
    rules and groups of every project of the organisation, those outside this offer included.
- `TENANT_STATE_MACHINE.md`: the `provisioning` row of §1 builds hosts and addresses inside the
  tenant's bootstrapped project. In §3, T2 requires a verified `ProjectBootstrap` of the tenant
  itself before `provision`, T26 verifies it under the tenant's exclusive lock, and T21 marks the
  tenant's bootstrap `replaced`. A shared tenant relies on the target's bootstrap plus its own
  human-created principals and bucket.
- `AUDIT_TAXONOMY.md`: §2 has no URN type for an environment target. In §3, Tenancy, the
  `tenant.project_bootstrap_*` actions and `tenant.host_created` target a tenant, while the
  bootstrap of the shared project and its hosts target none. The request that opens a shared
  tenant's human step, and the creation of its principals and bucket, have no action yet.
- `FIRST_OWNER_BOOTSTRAP.md` requires a contact the realm verified before the claim (§8.2) and names
  no sending domain or key for the realm. It needs the realm's mail before the organisation's first
  shared tenant, from the identity service's sending domain, and the `realm_update` that moves it to
  the organisation-owned key.
- `SETTINGS_AND_SECRETS.md` §4 gives the provider API key the scope "one project, one tenant" and
  the SSH certificate "one tenant principal", and scopes the Key Manager unwrap to one key, not
  to one tenant. Its §5 decrypts on the tenant host that serves the secret. On a shared target,
  tenant jobs receive only tenant-limited credentials, only target-level jobs receive the project
  credential, decryption is isolated per tenant, and nothing is decrypted on the host.
- `BACKUP_AND_RESTORE.md` places each tenant's bucket in the tenant's own project (§1), speaks of
  the tenant VM's key (§1.1) and prunes with the tenant's one provider key (§1.3). On a shared
  target the host principal and the prune principal take those places. Its §1.3 verifies and its
  §3.1 fetches the drill's snapshot with a read-only key; for a shared tenant both use the host
  principal, and a restore or a drill names the snapshot by the version ID and digest Core recorded,
  never `latest`, and it needs a way to pin every object a restore reads, not only the snapshot
  object, and the before-and-after check that a verification or a drill adds nothing, and the
  lock-free reads they use. Its §2 backs up a bucket for document content: for a shared tenant,
  on the host, under the tenant's UID, reading with the data principal and writing with the host
  principal. The bucket audit of §6 then looks for a delete right on the host principal, and the
  acceptance of §7 needs a shared tenant too. Its §1.2 still says that Object Lock cannot be enabled
  on an existing bucket, which the provider's documentation contradicts.
- `DOMAIN_STATE_MACHINE.md` and `contracts/core-api.openapi.yaml` accept an `A` record to the
  tenant's retained address for a custom domain, apex included, and the media target is the
  tenant's own media address. A shared tenant has no address of its own, and Fleet ADR-0006
  refuses an apex `A` on a shared host's address. The contract also describes a `Tenant` as one
  project, one VM, two retained addresses and one state file.
- `contracts/agent-api.openapi.yaml` and `docs/api/AUTHZ.md` define the Agent as one per tenant
  VM, bound to one tenant. They need the Agent of a shared host, which acts for every tenant
  placed on it, and Core's rule that hands it a command, or accepts its report, only for those
  tenants.
- `OBSERVABILITY_STACK.md` draws one VM and one project per tenant, with a collector on the tenant
  VM that pushes under a per-tenant certificate. `SLO.md` scopes itself to one dedicated tenant
  instance, so the shared plan has no SLO scope. `RUNBOOK_INDEX.md` has host loss and tenant
  creation for a tenant VM only. `README.md` says one state file per tenant.
- ADR-0003, ADR-0004, ADR-0005, ADR-0006 and ADR-0008 are accepted and are not edited
  (`docs/adr/README.md`), so none can point to the clauses this decision narrows or extends. The
  documents that restate those clauses carry that pointer instead: `JOB_CATALOGUE.md`, `MODEL.md`,
  `THREAT_MODEL.md`, `SETTINGS_AND_SECRETS.md` and `BACKUP_AND_RESTORE.md`. The register in
  `docs/adr/README.md` has no way to show a partial narrowing; whether it gains one is a
  follow-up for that file.
- ADR-0012 needs its class list updated to six, and its live-execution gate stated per tenant for
  this class, before it or this record is accepted. ADR-0013 needs the canary counted against its
  cap and budget. It states no acceptance order of its own; the order of this record covers it.
- Fleet `main` carries the class in its environment docs and in its policy check, rules `ENV017`
  to `ENV021`. It differs from this record in these places, each a Fleet follow-up:
  - one IAM application per tenant, where this record gives two principals: `ENV021`, the policy
    role `shared-tenant-application`, Fleet ADR-0005, Fleet ADR-0006, `docs/ENVIRONMENTS.md` and
    the gate specification;
  - an endpoint-sharing decision for a tenant's use of the database and the LiveKit server (Fleet
    ADR-0006), where this record uses the tenant placement;
  - members named in a list on the target, and no tenant placement in the policy or the schemas;
  - `ENV017` refuses a shared target with an empty member list, where this record lets an active
    target hold no member between its bootstrap and its canary's arrival;
  - Fleet ADR-0006 gives a tenant job "a host access limited to its tenant's UID and placement",
    and `docs/ENVIRONMENTS.md` gives it "host access (core ADR-0014)", which `ENV007` refuses and
    this record no longer claims;
  - Fleet ADR-0006 says target-level jobs "carry no tenant payload", and also renders the edge's
    route file from tenant records in a target-level job; this record states the rule as input
    from Core's validated records only;
  - the gate specification adds three allocation kinds and the member list under contract
    version 1, where `ENVIRONMENT_ALLOCATION.md` §1.2 makes each new kind a contract-version
    decision;
  - the gate does not check which job receives which grant, because the job record names no
    tenant;
  - nothing ties a record of this class to the `shared` hosting model, and the tenant schema has
    no hosting-model field;
  - the bucket-policy check of Fleet ADR-0006 is a list of four failures, one of them a grant of
    `s3:PutBucketPolicy`, which is not in the provider's list of bucket-policy actions; it becomes
    the allow-list with two halves, and its measurement moves from the local stand-in to the
    provider;
  - Fleet ADR-0006 runs that check as a target-level job, where this record lets no job principal
    put or delete a bucket policy and gives the check's principal read-only permission sets;
  - the check that a tenant application holds only the listed permission sets does not exist in
    Fleet. Fleet's allocation bundle carries a provider policy digest for a grant (its bundle
    schema, the gate specification and `docs/IAM.md`), and none is recorded for a shared tenant
    application;
  - the gate specification waits for per-target decryption, where this class needs per-tenant;
  - Fleet ADR-0006 asserts in preflight that a tenant's credential is denied on another tenant's
    bucket and database; the probe moves to the canary tenant, which Fleet's policy cannot hold
    yet, since it allows only customer data kinds in this class, where this record admits a
    synthetic data kind for the canary;
  - a data bucket and a data application per shared tenant, backed up under the tenant's UID;
  - a mail application and sending key per shared tenant and per organisation holding one, with the
    preflight exemption, the target's state bucket and sentinel bucket with their rows in the
    bucket-policy check, and the sentinel database;
  - Fleet ADR-0006 revokes `CONNECT` on every tenant database from `PUBLIC` and tests one tenant
    against another; the check over every tenant database of a target does not exist yet;
  - the default seccomp profile and the PID limit appear nowhere in Fleet;
  - database and role names that do not derive from the slug;
  - the order of the per-tenant human step, and Object Lock at bucket creation;
  - Fleet's policy lets a secret prefix and a realm name a member tenant; this record lists
    neither among the tenant-owned allocations;
  - `docs/NAMING.md` names every resource from the slug and per tenant: the IAM application, the
    backup bucket in the tenant's own project, the SSH principal, the mail subdomain, the DNS
    sub-zone and the state object;
  - `docs/IAM.md` is written for the dedicated model: every key's policy names exactly one tenant
    project, each tenant has one worker application and one key, SSH uses a per-tenant principal,
    and every tenant VM holds a registry pull credential and a monitoring push token, two
    credentials that this record's rule on the credentials of a shared host does not name;
  - Fleet ADR-0006 cites this record for a written acceptance of the LiveKit risk; that
    acceptance exists only once this record is ratified.
- Adding a shared tenant keeps a human step for its principals and its bucket. Onboarding a shared
  tenant is not unattended. Each shared tenant has four human-issued keys, host, prune, data and
  mail, and its organisation one more, for its realm's mail. Issuing or replacing any of them is a
  step at the same boundary.
- On the current provider, replacing a tenant's application after a compromise and deleting a
  tenant's bucket at its exit each change or remove a bucket policy. By the provider's
  documentation, only the Organisation Owner is certain to hold that right. Both operations
  therefore need the Organisation Owner.
- The job split and the lock rule have a cost that crosses customers. An operation on one tenant
  that needs a target-level change can no longer be one job: maintenance mode at the edge, an
  edge notice, a domain removal, the rotation of a database password or of a media key. Its
  target-level part waits, exclusively, for every running tenant job of the target. So one
  customer's outage can be extended by another customer's job: a tenant stays in maintenance
  while the job that lifts it waits behind another tenant's job, and behind a job in
  `needs_reconciliation` until an operator decides. Once a target-level job waits, every later
  job on that target waits too. Every host step is target-level
  work as well, so one tenant's restore holds the target lock exclusively and blocks host work for
  every other tenant of the target until it ends. A nightly backup runs on the host, so it is
  exclusive target-level work too: the backups of a target's tenants run one after another, and
  each one blocks every other job on the target while it runs. Onboarding a tenant and adding
  a domain need target-level work as well, so this is routine, not exceptional. The reach is
  every tenant of the target, which the per-host tenant cap of ADR-0013 does not bound.
- Moving a tenant between the shared and the dedicated model takes the tenant out of service for
  a full rebuild and restore.
- Tenant UIDs and GIDs are never reused, and Fleet's grammar gives them the range 20000 to 59999.
  The class therefore has 40 000 tenant identities for its whole life, across all its targets.
- The shared kernel, the LiveKit signing secrets, each able to sign a token for another tenant's
  room, and the mail sending keys, each able to send as another tenant's domain, are accepted
  risks with named triggers, not solved problems. They are accepted when the
  product owner ratifies this record, not before.
- No live provider call is enabled by this documentation change.

## References

- [ADR-0003](0003-api-holds-no-infrastructure-credential.md)
- [ADR-0004](0004-postgres-backed-job-queue.md)
- [ADR-0005](0005-human-controlled-project-bootstrap.md)
- [ADR-0006](0006-kodera-identity-topology.md)
- [ADR-0007](0007-france-only-data-residency.md)
- [ADR-0008](0008-non-reusable-tenant-slugs.md)
- [ADR-0012](0012-core-owns-environment-allocation.md)
- [ADR-0013](0013-shared-hosts-filled-by-resource-budget.md)
- [Environment allocation contract](../specs/ENVIRONMENT_ALLOCATION.md)
- [Job catalogue](../domain/JOB_CATALOGUE.md)
- [Backup and restore](../specs/BACKUP_AND_RESTORE.md)
- Fleet ADR-0005, environment classes: `deployment profiles`,
  `docs/adr/0005-environment-boundaries.md`
- Fleet ADR-0006, shared entry hosting model: `deployment profiles`,
  `docs/adr/0006-shared-entry-plan.md`
- Fleet environment boundary gate, rules `ENV007` and `ENV017` to `ENV021`:
  `deployment profiles`, `docs/specs/environment-boundary-gate.md`
- [Scaleway: bucket policies](https://www.scaleway.com/en/docs/object-storage/api-cli/bucket-policy/)
- [Scaleway: combining IAM and bucket policies](https://www.scaleway.com/en/docs/object-storage/api-cli/combining-iam-and-object-storage/)
- [Scaleway: permission sets](https://www.scaleway.com/en/docs/iam/policies-permissions/permission-sets/)
- [Scaleway: Object Storage permission sets and bucket-policy actions](https://www.scaleway.com/en/docs/object-storage/reference-content/s3-iam-permissions-equivalence/)
- [Scaleway: products supporting resource-level conditions](https://www.scaleway.com/en/docs/iam/policies-permissions/supported-products-resource-level/)
- Measurement of reading a bucket policy on Scaleway, 2026-10-02: `internal architecture records`,
  `run-notes/2026-10-02-scaleway-bucket-policy-read-measurement.md`
- Second measurement, read-only permission sets and bucket policies on Scaleway, 2026-10-02:
  `internal architecture records`, `run-notes/2026-10-02-scaleway-bucket-policy-read-only-sets.md`
- Third measurement, what two IAM read-only permission sets read on Scaleway, 2026-10-02:
  `internal architecture records`, `run-notes/2026-10-02-scaleway-iam-policy-read-reach.md`
- Measurement of sending mail over SMTP with each mail permission set on Scaleway, 2026-10-06: the
  identity service's staging realm, whose SMTP login was refused with `535 5.7.8 Invalid
  credentials` while its mail application held `TransactionalEmailEmailApiCreate`, and whose test
  mail was delivered once `TransactionalEmailEmailSmtpCreate` replaced it:
  `internal architecture records`, `run-notes/2026-10-06-scaleway-mail-smtp-permission-set.md`.
  Scaleway's permission sets page (above) describes the two sets as creating emails via the API
  and via SMTP.
- Landing runbook, §2.7 (the mail application and its one permission set) and §7.3 (its test send):
  `kodera-hq/kodera-landing`, `RUNBOOK.md`

## Changelog

- Proposes a sixth environment class for shared-plan tenants, one shared provider project with
  tenant-owned allocations inside it, tenant-limited job credentials, and the shared kernel and
  the cross-tenant reach of LiveKit signing secrets as accepted risks.
- Lists in Consequences the core documents the decision changes beyond the allocation contract and
  the job catalogue, checked against `main`.
- Review fixes before acceptance: names the ADR-0003 and ADR-0005 clauses it narrows and extends
  ADR-0004 with a per-target state file and the `target` lock; gives each shared tenant a host
  application and a prune application so its backups stay append-only; records a tenant's use of
  the shared hosts and database as a tenant placement; lets the target bind no tenant; writes future
  checks as requirements; cites the Scaleway bucket-policy rules; extends Consequences.
- Second review round: names four narrowed clauses of ADR-0003 and two of ADR-0004; withdraws the
  claim that a tenant job holds a host access limited to its UID and states the requirement
  instead; makes a change to a project-level resource a target-level job, fed from Core's records;
  states the cost of the lock rule; lets an active target hold zero members; makes the
  live-execution gate per tenant, proved against a canary tenant; gathers the provider-specific
  rules under one heading and turns the bucket-policy check into an allow-list; names the product
  owner as the acceptor of the two risks and limits what the plan may claim; adds Open before
  acceptance and the acceptance order; extends the follow-up lists without claiming them complete.
- Third review round: orders the per-tenant human step so that its verification can be run,
  with the host application's key, and verifies the lock configuration as well; scopes the rule
  that replaces ADR-0003's fourth clause to provider credentials and names the LiveKit signing
  secret as what it leaves out; names the two statements of ADR-0006 and the third clause of
  ADR-0004 it narrows; records the IAM policy digest of each application and lists its
  permission sets; requires a check over every tenant database; no longer puts ADR-0012's
  acceptance first, and brings ADR-0013 into the order; states the full cost of the job split;
  moves the canary's place in the ledger and what a target-level job may decrypt to Open before
  acceptance.
- Closes nine items of Open before acceptance while the record is Proposed, as the product owner
  answered them on 2026-10-01. Mail: one sending key per tenant from the tenant's domain, the
  realm's mail with an organisation-owned key of its own, its reach over the other tenants' domains
  an accepted risk with the product owner as acceptor, and a relay as a future hardening with
  written triggers. Host access: no tenant job reaches a shared host, every host step takes the
  `target` lock exclusively, and no per-tenant SSH principal exists. One Agent per shared host,
  served only for the tenants placed on it. Backup verification and the drill use the host
  principal, and restores name the snapshot's version ID and digest. The slug is reserved by the
  audited request that opens the per-tenant step. The target's state sits in a bucket of the shared
  project, out of every tenant principal's reach and in the bucket-policy check. The canary is a
  member like any other, counted against the cap and budget, and probed through two empty sentinels
  the target owns. A target-level job decrypts only the tenants that its placement-derived input
  names, the rebuild of the media host excepted. Scaleway stays the provider for shared targets.
  Prepares the check's principal without closing it.
- Second answer of the product owner, 2026-10-01: closes the bucket for document content with a data
  bucket and a data principal for every shared tenant, whatever the offer, backed up on the host
  under the tenant's UID with only its two keys; limits a host step's SSH certificate to the hosts
  the tenant's placement names; probes the canary through two empty sentinels; keeps the realm's
  mail off the platform's sending domain; requires lock-free reads for verification and the drill,
  `restic check` included, proved in the lab. The check's principal stays open until the measurement
  on the provider is cited.
- After the provider measurement of 2026-10-02: withdraws the prepared answer that named the
  checking principal in every bucket policy, since the provider refuses `s3:GetBucketPolicy` in a
  policy; records what the measurement showed; prepares a checking application named in no policy,
  whose policy-reading set a second measurement chooses among two read-only sets, with
  `ObjectStorageBucketPolicyFullAccess` and its stated risk as the fallback; requires a normalised
  form for the bucket-policy comparison and its digest, and a read-back at human step 3. The
  check's principal stays open until the second measurement is cited.
- After the second and third provider measurements of 2026-10-02: closes the item on the check's
  principal. The checking application holds `ObjectStorageReadOnly` on the shared project, which
  read a bucket policy that did not name it and could not replace, delete or create one, and
  `IAMPolicyReadOnly` and `IAMGroupReadOnly` on the organisation, which read policy rules and the
  tested group's member; every IAM write tried was denied. Names its key as the one of the class not
  restricted to the shared project, in the ADR-0003 and ADR-0005 clauses. Puts the checking
  application's own sets in the IAM half of the check and counts organisation-scoped rules and
  group-held grants. States what it reaches, measured and not measured. Drops
  `ObjectStorageBucketsRead` and the write-capable fallback. States the rule on bucket-policy rights
  as the right to put or delete a policy. Records that the provider sorted a two-element `Action`
  array, which the normalisation absorbs. Opens one item, after review: the specification of the IAM
  half of the check.
- After the product owner's choice of 2026-10-05 on that item: states the drift of the provider's
  permission sets as a residual risk, with its owner, the controls that remain and its revisit
  trigger, and moves the probe to kodera-core issue #147. States that `IAMGroupReadOnly` was
  measured only with `IAMPolicyReadOnly`, and that the tested group returned one member application
  and an empty `user_ids` field. The rest of the item stays open.
- After the product owner's review of 2026-10-06: drops the premise that the platform's sending
  domain carries the public landing page's mail and states the reason without a domain: outside the
  shared project, a realm never uses a key of a project another system sends from. States what a
  realm sends from before its organisation's first shared tenant. Names the mail permission sets,
  `TransactionalEmailEmailSmtpCreate` for SMTP and `TransactionalEmailEmailApiCreate` for the HTTP
  API. States that the checking application's IAM read reaches the organisation's projects outside
  this offer. Adds `configure_smtp`, the realm key and the organisation-wide IAM read,
  `FIRST_OWNER_BOOTSTRAP.md` and the realm mail application's owner and cross-target use to the
  Consequences.
- After the product owner's review of 2026-10-07: lists the SMTP measurement of 2026-10-06 and the
  landing runbook sections under References and cites them in the text, and aligns the wording on
  the realms that belong to no customer organisation. No decision changes.
- After the product owner's review of 2026-10-08: links the SMTP measurement of 2026-10-06 to
  its run note in `internal architecture records`. No decision changes.
- zôÖma approved the new-class option on 2026-09-28. The text as amended in review has not been
  ratified. Ratification is the product owner's decision on the merged text and is recorded in
  the status-only pull request.
