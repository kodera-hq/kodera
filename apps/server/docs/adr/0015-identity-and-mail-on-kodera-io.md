# ADR-0015: Identity and mail of the Kodera offer use `kodera.io`

**Status:** Proposed
**Owner:** Security seat
**Deciders:** zôÖma, the product owner, who decided that the identity service and the mail of the
Kodera offer move to `kodera.io`; Lours, who chose the hostnames and the sending names this record
states.

## Context

ADR-0006 (Accepted) puts the production identity service of the offer at `id.kodera.io`. Three
facts have moved since:

- **The deployed service already uses other names.** The Keycloak deployment serves
  `auth.kodera.io` and `auth.staging.kodera.io`, with the administration console on
  `auth-admin.kodera.io` and `auth-admin.staging.kodera.io` (`identity realm tooling`
  `deploy/.env.example`, `inventory-prod.yaml.example`). Measured on 2026-10-05: `auth.kodera.io`,
  `auth-admin.kodera.io` and `auth.staging.kodera.io` are active in DNS while `id.kodera.io`
  is NXDOMAIN. Core, the console contract and Fleet still say `id.kodera.io`.
- **The offer is sold as Kodera.** The console's support address is `hello@kodera.io`, and the public
  landing page sends its mail from `kodera.io` through Transactional Email, in the provider project
  `kodera-landing` (`kodera-landing` `RUNBOOK.md`).
- **Mail has no scheme under the offer's name.** Core platform mail (invitations, domain instructions,
  federation runbooks) is described in the contract as sent "from the platform's own sending domain",
  which no document names. No sending code existed when this record was proposed; Core's outbox
  sender (`../specs/OUTBOX_MAIL_SENDER.md`) now sends the outbox's `message` deliveries over SMTP.
  Tenant mail is described as `{slug}.mail.kodera.io` (`../domain/JOB_CATALOGUE.md` `provision`
  step 7, Fleet `docs/NAMING.md`); none exists (`mail.kodera.io` NXDOMAIN, 2026-10-05). The
  operator reports that the identity service has a Transactional Email domain `kodera.io`,
  recorded in no repository. Inbound mail on the apex `kodera.io` domain is not routed to
  user mailboxes; transactional sending uses dedicated subdomains.

Provider rules that shape the mail scheme:

- One name carries at most one SPF record; two records are a permanent SPF error, which happened once
  on `kodera.io` (`kodera-landing` `RUNBOOK.md`). SPF is not inherited by a subdomain.
- A Transactional Email domain is a project resource, and every sending key of a project can send as
  every domain of that project. A key cannot be limited to one domain (ADR-0014, Provider-specific
  rules).
- A name that is a CNAME can carry no other record, so no SPF record beside it.

The cost of a rename grows with the first customer. `Organisation.issuer` must end with
`/realms/<realm>` (`apps/orgs/models.py`), an update of it is refused by the trigger "Organisation
issuer is immutable" (`apps/orgs/migrations/0002_integrity.py`), and `identity_identity` holds a
foreign key on `(organisation_id, issuer, realm)`. Changing the host of a stored issuer is therefore a
data migration that the schema forbids. When this record was proposed, the offer had no customer:
the one live realm with users was `legacy-probe`, with one client, and the staging realm was
`kodera-dev`; neither was a customer organisation's realm. `legacy-probe` has since been renamed
`kodera-probe` (2026-10-06), an owner decision outside this record.

Measured on 2026-10-14, after this record was proposed: `identity realm tooling` pull request #42
(`cc0dc9b`, 2026-10-06) moved the identity service to `auth.kodera.io` and `auth.staging.kodera.io`,
with the administration console on `auth-admin.kodera.io` and `auth-admin.staging.kodera.io`
(`KC_HOSTNAME` and `KC_HOSTNAME_ADMIN` in `deploy/.env.example`, the staging names in
`inventory-prod.yaml.example`). Measured per step of the Migration order:

- step 3, identity part: the four identity hostnames are active in DNS; `auth.kodera.io` and
  `auth.staging.kodera.io` carry an SPF record for the provider and a DMARC record reporting
  to `support@kodera.io`; `identity realm tooling` `ADMINISTRATION.md` documents their
  mail projects. The `notify.*` part is not measured here;
- steps 4 and 7, Keycloak part: the hostnames above are in place, and the relying parties of realm
  `kodera-probe` outside the offer use the issuer `https://auth.kodera.io/realms/kodera-probe`
  (`identity realm tooling` `README.md`). The Core, console and Fleet parts are not measured here;
- step 8, DNS part: the `auth.*` and `auth-admin.*` names of `kodera.io`, staging included, are
  NXDOMAIN.

These changes were made outside this record's order. Whether step 1's precondition was checked
before them is not recorded in this repository.

## Decision

### Identity hostnames

This replaces the first statement of ADR-0006's Decision ("The production identity service for this
offer is Keycloak at `id.kodera.io`"), and only that statement.

| environment | public hostname | administration hostname |
|---|---|---|
| production | `auth.kodera.io` | `auth-admin.kodera.io` |
| staging | `auth.staging.kodera.io` | `auth-admin.staging.kodera.io` |

- The issuer of a realm `R` is `https://auth.kodera.io/realms/R` in production and
  `https://auth.staging.kodera.io/realms/R` in staging.
- The public hostname serves the realms. The administration hostname serves the administration
  console and the `master` realm, and the public hostname refuses both, as the deployment does today.
- Every realm of an instance is served under that instance's one public hostname. No realm of the
  offer keeps a `kodera.io` issuer through a per-realm frontend URL.
- After the migration below, no relying party of the offer trusts an issuer on a `kodera.io`
  name.
- Realm names are not changed by this record.
- **Realm `kodera-probe` gathers every realm of the applications outside the Kodera offer.** It is
  hosted on the same identity server as the offer's realms and served under the same public
  hostname. It is neither the staff realm nor a customer organisation's realm.

Every other statement of ADR-0006 stands unchanged:

- one `kodera-staff` staff realm and one realm per paid customer organisation, and a customer's console,
  Visio and later admitted applications use that customer's realm;
- a tenant slug is a DNS label and a Scaleway project name and never a realm name; the realm is named
  from the organisation slug, and a second tenant of the same organisation reuses that realm;
- staff authenticate through the staff realm; tenant roles remain Core database memberships, and a
  token does not grant an organisation role by itself;
- the Core API derives the organisation from the verified issuer and never accepts a realm or
  organisation identifier supplied by the browser as an authorisation fact;
- the browser discovers the realm at runtime and uses Authorization Code with PKCE; tenant access
  tokens remain in memory;
- the API holds no Keycloak master-realm credential; realm creation and template changes run through
  the worker, and delegated people administration uses a per-realm service account with only the
  reviewed realm-management roles;
- the Keycloak database and backups live in Paris and run as a shared production service with a
  separate staging deployment; identity backups use separate recipients and retention from tenant
  backups;
- tenant administrators and all staff use mandatory MFA, with no SMS factor in the initial baseline;
- the public free demo keeps its identity boundary until its own migration specification;
- work from another identity implementation is reused only as reviewed components or runbooks;
- and every Consequence ADR-0006 lists.

### Sending domains

Each system that sends mail for the offer sends from its own domain. Each domain carries exactly one
SPF record of its own, its own Transactional Email domain with its own DKIM record, and its own DMARC
record at `_dmarc.<domain>`. No domain below receives mail.

- **Replies, bounces and DMARC reports go to `support@kodera.io`.** For the identity, Core platform
  and tenant domains, the reply address of every message, the bounces and the DMARC aggregate
  reports (`rua=mailto:support@kodera.io`) go to `support@kodera.io`. That address is an alias of
  the `hello@kodera.io` mailbox hosted at Gandi. It sits in the same
  organisational domain as every domain below, so no external-destination DMARC record is needed.
  The landing page keeps `hello@kodera.io`.

| system | production domain | staging domain | provider project that holds the domain |
|---|---|---|---|
| Public landing page | `kodera.io` (`hello@kodera.io`), unchanged | — | `kodera-landing`, unchanged |
| Identity service (Keycloak) | `auth.kodera.io` | `auth.staging.kodera.io` | one mail project per environment that holds only this domain |
| Core platform mail | `notify.kodera.io` | `notify.staging.kodera.io` | one mail project per environment that holds only this domain |
| Tenant applications | `{slug}.mail.kodera.io` | — | `tenant-{slug}`, as ADR-0003 requires |

- **One sending domain per project.** No project holds two domains of this table, and a staging
  domain never sits in a production project. Every key of a project can send as each of its domains,
  so this is what keeps a leaked landing, identity, Core or tenant key from sending as another system.
- **A sending domain does not have to sit where its service runs.** Fleet places the identity server
  in the operations project (`docs/NAMING.md`), and the `platform-prod` class groups Core and
  Keycloak (`docs/ENVIRONMENTS.md`). A sending key is a credential the service uses from wherever it
  runs, so the identity and Core domains each sit in a project made for that one domain. Their names
  are set at creation, not here.
- **The mail projects take an ADR-0012 class.** The production identity and Core mail projects are
  of class `platform-prod`; the staging ones are of class `staging`. Each is created through
  the human-controlled boundary of ADR-0005, which this record extends from tenant projects to
  these mail projects.
- **The shared project of ADR-0014 is the one exception, and it is ADR-0014's.** If ADR-0014 places
  several shared tenants' and organisation realms' domains in its shared project, with the
  cross-domain reach of their keys as an accepted risk, that holds there and nowhere else. None of
  the domains of this table sits in the shared project.
- **`auth.kodera.io` and `auth.staging.kodera.io` stay A or AAAA records**, never a CNAME, so that
  their SPF record can sit beside them.
- **The identity domain sends the mail of the realms that belong to no customer organisation**: the
  staff realm, the staging realms, and `kodera-probe`. ADR-0014 (Provider-specific rules) has the
  realm of a customer organisation send from this domain, with the key of its mail project, until
  the request that opens the organisation's first shared tenant issues the organisation-owned key; a
  `realm_update` then moves the realm's mail to that key. Which domain the realm sends from with the
  organisation-owned key is not decided here; ADR-0014 leaves it outside its record too, and
  `configure_smtp` (`../domain/JOB_CATALOGUE.md`) sets it up. Which domain and key the realm of an
  organisation that never opens a shared tenant sends from is not decided here; ADR-0014 does not
  cover it either.
- **The Core platform domain** is the "platform's own sending domain" of the contract, for every
  message Core sends: `inviteToOrganisation`, `resendInvitation`, `shareDomainInstructions`,
  `shareFederationRunbook`, and the owner claim (`../specs/FIRST_OWNER_BOOTSTRAP.md` §6.4). This
  record changes only the domain. How each message reaches the transport stays as the contract,
  `../domain/JOB_CATALOGUE.md` and `../specs/OUTBOX_MAIL_SENDER.md` state it today, including the
  synchronous `200` of `resendInvitation`, which the contract describes as handing one message to
  the mail transport, and the outbox's `message` deliveries, which Core's sender sends over SMTP
  after their commit.
- **The tenant scheme** replaces `{slug}.mail.kodera.io`. The domain is created and verified
  inside the tenant project, as ADR-0003 requires today. A shared tenant has no project of its own;
  how its domain is named stays with ADR-0014. `{slug}.mail.kodera.io` sits beneath the platform
  parent `kodera.io`, and ADR-0012 keeps DNS delegation beneath a platform parent blocked until an
  ownership and delegation model is accepted. This record does not provide that model, so no
  `{slug}.mail.kodera.io` name is delegated to a tenant project before it exists.
- Each sending key belongs to a mail application that holds exactly one permission set, scoped to
  the one project that holds its domain, and chosen by transport as ADR-0014 names them:
  `TransactionalEmailEmailSmtpCreate` when it sends over SMTP, or
  `TransactionalEmailEmailApiCreate` when it sends through the provider's HTTP API. The two are not
  interchangeable. On 2026-10-06 the identity service's staging SMTP login was refused
  (`535 5.7.8 Invalid credentials`) with `TransactionalEmailEmailApiCreate`, and its mail was
  delivered with `TransactionalEmailEmailSmtpCreate` in its place (ADR-0014). A realm sends over
  SMTP, so the identity domains' keys hold `TransactionalEmailEmailSmtpCreate`. Core's sender sends
  over SMTP (`../specs/OUTBOX_MAIL_SENDER.md` §6, `KODERA_MAIL_SMTP_URL`, STARTTLS), so the
  `notify.*` keys hold `TransactionalEmailEmailSmtpCreate` too. A Core sender that moves to the
  provider's HTTP API takes `TransactionalEmailEmailApiCreate` instead, never both.
- The identity service's current `kodera.io` Transactional Email domain is replaced by
  `auth.kodera.io`, not extended. Removing it is a product-owner action, after the production
  cutover is verified.

### Migration order

This record changes nothing live: no DNS record, certificate, issuer, realm setting, key or provider
resource. Once it is accepted, the change runs in this order. Each step is its own pull request in
its own repository, or an owner action where stated.

1. **Precondition, before any runtime step.** An operator with database access confirms that no
   `orgs_organisation` row exists on any live Core database, staging included. If one exists, stop:
   its issuer cannot be updated, and the rename needs its own decision.
2. **kodera-core, documents and contract.** Replace `id.kodera.io` in `../api/AUTHZ.md`,
   `../domain/MODEL.md`, `../specs/REALM_DISCOVERY.md`, `../specs/SLO.md` (realm discovery probe),
   and `{slug}.mail.kodera.io` in `../domain/JOB_CATALOGUE.md`. In
   `contracts/core-api.openapi.yaml`, the OpenID Connect discovery URLs, `x-kodera-realm-template`,
   the examples that carry an issuer, a `redirect_uri` or a `logout_uri`, and every other
   occurrence, the exact-issuer rule of `discoverRealm` and the prose of the `keycloakTenant`
   security scheme included; and
   `contracts/examples/federation-provider.json`. With them, the tests that pin those clauses
   (`tests/test_realm_discovery_contract.py`) and the discovery-URL fixture of the realm-topology
   self-test (`scripts/ci/check-realm-topology.selftest.sh`), whose rule reads the realm path,
   not the host. Release the
   contract with a version bump and a `contracts/vX.Y.Z` tag. Nothing at runtime changes: trusted
   issuers come from `KODERA_AUTH_TRUST` and the staff issuer from `KODERA_STAFF_ISSUER`, per
   environment, not from code.
3. **Projects, DNS and Transactional Email, owner actions.** Create the mail projects of the table
   through the human-controlled boundary. In the `kodera.io` zone, snapshot first as the landing
   runbook requires: the four identity hostnames, then the sending records of each domain. Create
   each Transactional Email domain in its project. For each domain, create one application holding
   only the permission set of its transport, scoped to that project, and its key. Stop if a
   project lists more than one Transactional Email domain. The `notify.*` domains and their keys
   are created when Core ships its first sender, not before. Before any DMARC record names
   `support@kodera.io`, create that address as an alias of the `hello@kodera.io` mailbox at Gandi.
4. **Staging cutover, together.** identity realm tooling staging: `KC_HOSTNAME` and `KC_HOSTNAME_ADMIN`
   from the inventory's `keycloak_stack_hostname` and `keycloak_stack_hostname_admin`, the `master`
   realm's frontend URL on the administration hostname, certificates for the new names. Realm mail:
   no SMTP setting is tracked today (`identity realm tooling` `README.md`), so the key of step 3 is placed
   on the host as a secret, the realms of the table get their SMTP settings on
   `auth.staging.kodera.io`, and one test message is delivered from that domain. The sender is
   `Kodera <no-reply@auth.staging.kodera.io>`, the staging form of the production sender
   `Kodera <no-reply@auth.kodera.io>`, and the reply address is `support@kodera.io`. With it:
   `KODERA_AUTH_TRUST` and `KODERA_STAFF_ISSUER` on Core staging, which refuses to start when
   the staff issuer is not on the staff lane of the trust list; the console staging build's `VITE_KEYCLOAK_URL`; and in
   deployment profiles, the lab issuer
   `tenants/lab/tenant.yaml` (`oidc_issuer`, on the branch of Fleet pull request #82, not on `main`)
   to `https://auth.staging.kodera.io/realms/kodera-dev`. The issuer of every staging realm changes
   at once, so every relying party of staging changes in the same window.
5. **kodera-console.** zôÖma's lead session takes this step, after the contract tag of step 2.
   Vendor the tagged contract and regenerate what derives from it
   (`contracts/core-api.openapi.yaml`, `src/api/schema.d.ts`, `src/mocks/generated/examples.ts`),
   update the comments, mocks and documents that name `id.kodera.io`
   (`src/auth/sessionExpiry.tsx`, `src/features/login/Handoff.tsx`,
   `src/mocks/overlays/login.two-organisations.ts`, `docs/`), and set `VITE_KEYCLOAK_URL` per
   environment at build time. The production login reads the hostname only from that variable.
6. **deployment profiles.** `docs/NAMING.md` (the tenant mail row and the identity host row),
   `docs/ENVIRONMENTS.md` (the identity row) and `docs/specs/tenant-lifecycle.md` (the mail step).
7. **Production cutover, together.** identity realm tooling production, as in step 4 with the production
   names, the sender `Kodera <no-reply@auth.kodera.io>` and a test message from `auth.kodera.io`;
   its tracked examples (`deploy/.env.example`, `inventory-prod.yaml.example`,
   `deploy/sync/sync.env.example`), its backup and restore tests
   (`deploy/backup/tests/test-restore.sh`, `deploy/backup/tests/mock-bin/restic`) and its documents.
   A search of each of the four repositories for `id.kodera.io`, the `auth.*` and `auth-admin.*`
   names of `kodera.io` and `mail.kodera.io` then finds only history. Re-register at each
   external provider the broker callbacks of `kodera-probe`, which carry the hostname
   (`https://auth.kodera.io/realms/kodera-probe/broker/<alias>/endpoint`); its client's redirect
   URIs carry only application URLs and do not change. With it: `KODERA_AUTH_TRUST` and
   `KODERA_STAFF_ISSUER` on Core production and the console production build.
8. **Retirement, owner action.** Once production is verified: remove the `auth.*` and
   `auth-admin.*` names of `kodera.io` from the offer's configuration and the identity
   service's `kodera.io` Transactional Email domain.

Until step 8, a cutover is rolled back as one unit, by reverting every change of its window:
`KC_HOSTNAME`, `KC_HOSTNAME_ADMIN` and the `master` realm's frontend URL, the realms' SMTP settings,
`KODERA_AUTH_TRUST` and `KODERA_STAFF_ISSUER`, the console build, and in staging the lab
issuer, in production the `kodera-probe` broker callbacks at each provider. Either way the issuer of
every token changes, so every open session ends and its user signs in again. As measured on
2026-10-14 (Context), the `kodera.io` identity names no longer resolve: reverting `KC_HOSTNAME`
and `KC_HOSTNAME_ADMIN` to them no longer restores a working service, so neither window can be
rolled back as one unit today unless those names and their certificates are created again first.

## Relationship to accepted and proposed decisions

- **ADR-0006.** Not edited, and its status does not change: the rest of it stands. On acceptance,
  its first Decision statement is read through this record; every other statement and every
  Consequence is unchanged.
- **ADR-0003.** Unchanged. A tenant's sending domain is still created inside the tenant project; only
  its name changes, and ADR-0003 does not name it.
- **ADR-0005.** Its human-controlled boundary, written for tenant projects, is extended to the
  identity and Core mail projects. Nothing else in it changes.
- **ADR-0012 (Proposed).** Unchanged. The mail projects take its classes `platform-prod` and `staging`,
  and its block on DNS delegation beneath a platform parent holds for `{slug}.mail.kodera.io`.
- **ADR-0014 (Proposed).** The mail of shared tenants and of customer organisations' realms stays
  its item. A customer organisation's realm sends from this record's identity domain only until
  its organisation's first shared tenant, as ADR-0014 states; this record names no other domain
  for them. The permission sets are the two ADR-0014 names. Under this record the platform's
  sending domain (`notify.kodera.io`) and the landing page's (`kodera.io`) are two domains in two
  projects; ADR-0014 no longer says that the platform's sending domain carries the landing page's
  mail.
- **Public Visio** (`visio.kodera.io`) is not part of the offer and is outside this record, its
  identity and its mail included.

## Options considered

| Option | Decision |
|---|---|
| Keep `id.kodera.io`, as ADR-0006 states | Rejected. The offer is sold as Kodera, the deployed service never used that name, and mail would stay on a domain whose MX drops every reply. |
| Align ADR-0006 with the deployed `auth.kodera.io` | Rejected by the product owner, who moved the offer's identity and mail to `kodera.io`. |
| `id.kodera.io` | Rejected. `auth.*` and `auth-admin.*` keep the deployed split between the public and the administration hostname, so only the domain changes. |
| Move realm by realm with a per-realm frontend URL | Rejected. It needs a router, a certificate and a deny rule per extra name, none of which exist, to protect a single realm with users. |
| One sending domain, the `kodera.io` apex, for every system | Rejected. Every key of its project could send as every system, a reputation problem of one system reaches all, and the apex carries one SPF record for all. |
| Mail-only names (`auth-mail.kodera.io`) apart from the identity hostname | Rejected. The sender address stays readable when it matches the service; the cost is the A or AAAA constraint above. |

## Consequences

- One rename of the identity hostname now, before any customer, instead of a data migration that the
  schema forbids later. Revisit this record if the precondition of step 1 finds an organisation row.
- The `kodera.io` zone gains four identity hostnames and the records of four sending domains, plus
  one per tenant. Each change follows the landing runbook's snapshot-first rule.
- A customer's external identity provider registers the `auth.kodera.io` callback. None is configured
  today.
- The console (`app.kodera.io`, `app.staging.kodera.io`) and the identity service
  (`auth.kodera.io`, `auth.staging.kodera.io`) are same-site. The Public Suffix List (version
  2026-10-07) lists `io` but not `kodera.io`, so the registrable domain of all four hosts is
  `kodera.io`, and two `https` origins with the same registrable domain are same-site (HTML
  Standard, "same site"). The cross-site reason for a full redirect after a page reload therefore no
  longer holds: a frame of the identity service embedded in the console is not a third party under
  that definition. Whether Safari and Firefox send the identity service's cookies to that frame is
  not measured here; a test in both browsers decides it before the console relies on restoring a
  session silently. The two remain different origins: the console's requests to the identity
  service are cross-origin and go through CORS.
- Same-site also covers staging, production and the landing page `kodera.io`, so the `SameSite`
  cookie attribute does not separate them. A cookie set with `Domain=kodera.io` reaches every
  `kodera.io` host; a cookie set without a `Domain` attribute reaches only the host that set it
  (RFC 6265, section 5.3). Any `kodera.io` host, staging and the landing page included, can
  therefore set a `Domain=kodera.io` cookie that the production identity service and console
  receive. This record does not decide a mitigation.
- If the identity service ever has to sit behind a CNAME, its sending domain moves to another name
  through a superseding record.
- The console's origins are decided by the product owner: `https://app.staging.kodera.io` in
  staging and `https://app.kodera.io` in production.
- Other `kodera.io` names are not decided here and need their own decision: the APIs
  (`api.kodera.io`, `agent.kodera.io`), problem type URIs,
  the status page, tenant application hosts (`{slug}.visio.kodera.io`,
  `{slug}.docs.kodera.io`), the support address `support@kodera.io` in `../specs/SLO.md`,
  and the certificate contact `ACME_EMAIL=ops@kodera.io` in `identity realm tooling`
  `deploy/.env.example`. Both addresses receive nothing while the MX of `kodera.io` is the
  blackhole.

## References

- ADR-0003, ADR-0005, ADR-0006, ADR-0012, ADR-0014.
- `../domain/JOB_CATALOGUE.md` (`provision` step 7, `realm_create` step `configure_smtp`, Outbox
  deliveries); `../domain/MODEL.md`; `../api/AUTHZ.md`; `../specs/REALM_DISCOVERY.md`;
  `../specs/SLO.md`.
- `apps/orgs/models.py`, `apps/orgs/migrations/0002_integrity.py`, `config/settings/customer_http.py`.
- `identity realm tooling`: `deploy/.env.example`, `inventory-prod.yaml.example`,
  `deploy/docker-compose.pro.yml`, `roles/keycloak_stack/`.
- `kodera-landing`: `RUNBOOK.md` (Transactional Email domain, SPF rule, snapshot-first rule).
- DNS measured with public resolvers on 2026-10-05.

## Changelog

- Proposed: moves the offer's identity hostnames and sending domains to `kodera.io`, superseding
  only the hostname statement of ADR-0006.
- First review: lists every ADR-0006 statement that stands; keeps the send path of each Core message
  as the contract states it; puts the identity and Core domains in mail projects of their own and
  leaves the shared project to ADR-0014; adds keys, secrets, SMTP settings and a test message to the
  cutovers; makes rollback revert a whole window; adds the console, Fleet and Keycloak files the
  order missed.
- Before ratification (review of the merged proposal): sends replies, bounces and DMARC reports to
  `support@kodera.io`; states the cross-site session consequence; states realm `kodera-probe`;
  follows the rename of `legacy-probe` to `kodera-probe`; gives the mail projects their ADR-0012
  classes and extends ADR-0005 to them; acknowledges ADR-0012's delegation block for the tenant
  scheme; names the Keycloak sender; adds the files step 2 missed; lists the certificate contact;
  gives console step 5 to zôÖma's lead session.
- Aligned with ADR-0014 as merged: a customer organisation's realm sends from the identity domain
  until its organisation's first shared tenant, then `realm_update` moves it to the
  organisation-owned key; the sending keys hold the permission set ADR-0014 names for their
  transport.
- Last round before ratification: names the permission set of the `notify.*` keys for Core's SMTP
  sender; states that Core's outbox sender now sends the outbox's `message` deliveries over SMTP;
  leaves undecided the domain and key of the realm of an organisation that never opens a shared
  tenant; paraphrases ADR-0014's rule for a customer organisation's realm, with a pointer to its
  section, instead of quoting it, so that a rewording of ADR-0014 leaves no misquote here.
- Decided console origins: records the console's origins `app.staging.kodera.io` and
  `app.kodera.io`, and reassesses the session consequence from them: the console and the identity
  service are same-site under `kodera.io`, so the cross-site reason for a full redirect no longer
  holds, the browser behaviour of the embedded frame is left to a test, and `SameSite` does not
  separate the `kodera.io` hosts from each other.
- Current base: records, per migration step, what was measured on 2026-10-14 to have been done
  outside the migration order (the identity part of step 3, the Keycloak part of steps 4 and 7, the
  DNS part of step 8), and that a cutover cannot be rolled back as one unit today; adds
  `KODERA_STAFF_ISSUER` beside `KODERA_AUTH_TRUST` in the cutovers and the rollback; adds the
  owner claim to the messages Core sends and cites the outbox sender beside the synchronous `200`
  of `resendInvitation`; extends step 2 to every `id.kodera.io` occurrence of the contract;
  states that any `kodera.io` host can set a cookie the production hosts receive; marks ADR-0012 as
  Proposed; states that ADR-0014 no longer carries the landing-mail premise instead of rebutting
  it.
