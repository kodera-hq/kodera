# Customer HTTP acceptance preparation

Status: Host PostgreSQL qualification passed at frozen3191a7a2fd9df9ed012483805f400c06b3519fcf with554 tests and four schema/five HTTP semantic mutations. Local image qualification subsequently passed at `a11bd17857e1e430ffe72e7d0feca5e3766062a6`:37 actual READ WRITE42501 statements, two semantic startup denials with SQLSTATE null, four provider/image HTTP cases, and real database outage/same-process persisted recovery. All38 image/build inputs remain bound unchanged; source integrity and independent owned-resource cleanup passed. This uses synthetic data and the fixed local WSGI server, not a production serving process or deployment. Preparation outcomes below preserve their historical pre-implementation revisions.

This specification follows the integration lead's customer HTTP binding at SHA-256 `7536d1848bbc3056d2c3b07d2784d133a04c721be6f1b966523aa09c70458b07` and the frozen customer authority technical admission at SHA-256 `4975a4552da7187d3ad6b15b97ca4372f3f0f28e75fb22eebd46d22045b98380`. The binding explicitly overrides the wider proposed ETag timestamp wording for GET /me: hash the complete serialized projection only. Actual schema name is OrganisationCreateRequest. Tenant-order availability remains outside organisation slug scope.

## Implementation seams required by the tests

Use exact GET /api/v1/me. The route must return the existing RFC9457 types, no-store and correlated request ID, plus fully persisted Me on success. No anonymous identity creation, request-selected person, token-derived role/email authority or write route is part of this package.

A small public loader at services/identity/trusted_issuers.py exposes `load_trust(raw: str | None)` and `TrustConfigurationError`. It parses the top-level JSON array into immutable trusted entries consumed by the real authenticator through the Django KODERA_AUTH_TRUST setting. The local environment variable of that name is raw JSON; the future explicit config.settings.customer_http profile calls the loader once at initialization. `public_jwks` is an object. The loader uses the existing public IssuerKeySnapshot parser; it rejects malformed/duplicate JSON, unknown fields, nonexact primitive types, invalid lanes, duplicate issuers, private keys, more than8 entries or more than65536 UTF-8 bytes. Absent/empty configuration admits no issuer. Its exception has only the safe message `public trust configuration refused`, no chained raw parser detail. The tests exercise this actual loader, not a test implementation.

HTTP tests install snapshots only by calling that loader and setting the real Django configuration; they do not replace authentication, JWT verification, selectors, principals or database results. The existing cryptographic test helpers issue real synthetic RSA/EC signatures, and the original real provider flow supplies separately executed image tokens. A staff lane with a valid signature returns403 without a customer grant. The endpoint label identity:read does not become a JWT scope requirement.

The eventual explicit HTTP profile includes the qualified persistence settings and registers the route/trust wiring; the existing diagnostics-only dev image remains unchanged until the separately reviewed HTTP image increment. No tests assume that profile already exists.

## Actual database fixture and HTTP assertions

Use Django's actual client/URL resolver with migrated PostgreSQL and the existing valid anchor fixture: two organisations with distinct issuers and owners, independent non-owner users, and explicitly linked identities where the test calls for them. All writes are fixture transactions under the owned migration role. Tokens select exact issuer+subject only; changed email/role claims never update or link a person.

Cover all four role positives; unknown/disabled/deleted identities and people403 `identity-unknown` without a Bearer challenge (`AUTHZ.md` §2 step 6, contract 0.28.0); missing/invited/suspended/removed current memberships403; active/suspended organisation positives and prospect/closed/deleted organisation403; issuer-specific identical subject/kid controls; retained-key model coverage by reference; all admitted switcher omission/description predicates; role changes and revocation on repeated identical tokens; stable counts/fields across reads; correlated safe problems; canonical sorted payload/ETag and conditional wildcard/weak/list handling only after current authority. The projection omits unbacked optional staff/MFA/contact-verification/login/locale fields. Missing or expired trust denies401 without network.

Two request-thread execute wrappers are observation/barrier tools only: they execute the real SQL and never replace results. One pauses before the first authority SELECT, after BEGIN/transaction setup, commits revocation on another connection and requires403. The other pauses after that first SELECT establishes a snapshot, commits a role/contact change and requires the whole old projection followed by the whole new projection next request. The first SELECT must name the Identity table; effective Repeatable Read/READ ONLY are inspected only after it. A GUC-inspection SELECT before authority must fail. Threads/connections use bounded cleanup and no timeout is treated as a valid domain refusal.

Database outage acceptance must use an actual unavailable owned connection, never a patched resolver error. An owned temporary loopback listener closes connection attempts, with short libpq/statement bounds; an isolated request connection points at it and must receive500, not401/403/empty200. No shared database is stopped by this test. The separate image runtime still has to qualify a real running API while its owned PostgreSQL becomes unavailable/recoverable.

## Image and least-privilege boundary

The externally supplied owned-image probe input is a small JSON document containing integer loopback api_port, real provider access/ID/refresh/wrong-audience tokens and expected persisted Me. It is prepared only by the existing owned runtime/provider controller. This test packet does not start, build, migrate, provision or stop a service. Tests refuse absent input when deliberately selected; lack of an image run is not a passing mock or a silent skip.

Image tests exercise actual HTTP200 exact persisted payload, nonaccess/wrong-audience401, repeated no-store/ETag behavior and safe bodies. Their network code uses a fixed loopback host/path and HTTPConnection, with no proxy or redirect following. Input contains synthetic owned-fixture material only and must not be logged. Actual source inclusion/excluded-sentinel proof, role provisioning/catalog inspection, reader READ WRITE42501 DML/DDL/escalation negatives, and image PostgreSQL outage/recovery remain explicitly assigned to the existing runtime controller increment; this packet cannot fake them through fixture claims. No API credentials may be owner/provider-admin credentials.

AR01–16/19–20 have executable route/DB assertions in this packet; AR17 reuses the exact separately qualified persistence suite. AR01 real-provider and AR18 image proof require the external image input and reviewed runtime controller. Real MFA, first-owner intake, persistent audit, rate limiting, deployed infrastructure and full first-slice acceptance remain unqualified.

## Execution and evidence

Before route code, run only the nonservice route-presence probe. It must fail with the named `customer GET /api/v1/me is not routed` assertion, not database setup/import/credentials. Collect the complete new suite without a database and report counts separately from outcomes. Parser tests intentionally remain red until the real loader exists. No test uses force_authenticate or mocked authority.

After admitted persistence/HTTP implementation and a service slot, run the actual parser/route/transaction suites against the owned PostgreSQL profile. Then run the external image tests only with its controller-generated input. Run current parent/generator/persistence regressions and the existing targeted semantic mutations after implementation. Required HTTP weakenings are issuer-only omission (subject-only lookup), token-role authority, stale membership, removed identity eligibility and304 before authority; each needs a passing exact baseline and named semantic failure. Test scaffolding does not preclaim those mutation results.

The original preparation increment contained only this specification and tests; the qualified persistence implementation and bounded HTTP source were integrated after separate review. Parallel checkouts retain separate source ownership.

Canonical projection bytes are UTF-8 JSON with sorted object keys, compact comma/colon separators and ensure_ascii=False. Identity arrays are ordered by identity.id and organisation entries by membership_id; the complete returned projection supplies the quoted SHA-256 tag. This wire choice belongs to these acceptance inputs, not a new generic cache framework.

Future execution uses the explicit customer HTTP settings profile selected by its implementation, rather than assuming diagnostics config.settings.dev enables models or the route. The preparation-only absence probe deliberately uses the frozen parent config.settings.test.

Two nonservice subprocess probes exercise the actual config.settings.customer_http environment-to-settings initialization, with Python socket and Django connection entry points refused before Django setup. Valid input yields one parsed trusted entry; invalid lane yields the named safe refusal. No migration, database or provider is started by these probes. They remain unexecuted until the profile exists; the loader unit tests do not substitute for this startup binding.

## Measured preparation outcome

The four new HTTP test modules collect100 cases without PostgreSQL or a service launch. The selected route and loader probes fail with exactly `customer GET /api/v1/me is not routed` and `finite public trust loader is not implemented`. The two named absence failures establish the frozen parent's missing behavior; the other98 cases are unexecuted. Ruff check and formatting pass for the five new Python files. Existing source and environment dependencies were read from the qualified owned persistence environment; no dependency was installed or modified.

Retained preparation logs are `/private/tmp/customer-http-final-collection.log` and `/private/tmp/customer-http-final-absence-red.log`. Neither collection nor test-source review qualifies any actual database authority, snapshot, startup-profile, image, provider or reader-role result.

## Independent preparation review follow-up

AR03 now counts every real SQL execution during a cryptographic denial and requires zero; the observer delegates every actual execution unchanged, and the valid-token control remains outside it. Startup subprocesses explicitly freeze their own clock to the shared synthetic NOW before importing the HTTP configuration and running Django setup. Parent-process time travel is not assumed to cross a subprocess boundary. Python socket and Django connection refusals remain active. These acceptance-only refinements do not enable HTTP behavior.

## HTTP implementation admission

Status: The integration lead has admitted the bounded HTTP consumer after independent review of the acceptance and qualified persistence parent d78f3ad11d45cfde505ae8149c8ab035009e5e7a. A normal local merge preserves both histories. No remote publication or cloud deployment is authorized by this paragraph.

External image probes now live at dev/customer_http_image_acceptance.py and are selected explicitly by the owned controller. Default pytest discovers96 HTTP cases; the controller separately selects4 image cases, which still fail if their required input is absent. No skip or workflow/pytest-configuration bypass is introduced.

Implement only the public loader, verified customer resolver, application selectors, one explicit read-only Repeatable Read service, exact projection serializer and GET view, plus customer_http settings/URLconf. The test profile enables this consumer. The default dev profile and diagnostics URLconf stay separate. Runtime source inclusion lists each admitted file; image acquisition, provider credentials, reader-role setup and runtime controller remain separately owned. Existing token kernel, models, migration integrity and contracts remain exact.

## Implementation and local serving boundary

The customer profile compiles the finite public trust configuration once, while the existing cryptographic verifier rechecks snapshot expiry and exact issuer for every request. Identity selectors resolve the exact issuer/subject and enabled retained person in the first snapshot-acquiring query. Organisation selectors own current persisted membership eligibility and the documented authenticated-person projection exception. The service owns an outer READ ONLY REPEATABLE READ transaction and materializes immutable primitive snapshots before returning. A nested caller transaction is refused rather than inheriting an earlier snapshot. Serializing those values performs no database work.

The explicit GET view verifies authority on every conditional request, hashes only canonical projection bytes and returns safe correlated errors. No business mutation, owner intake, staff implementation, persistent audit or rate limiter is introduced. Plain Django HTTP handling delegates to the existing verified-token service; no anonymous DRF permission default supplies authority. The permission declaration records the contractual customer scope/roles; the current grant is enforced by the actual stored membership selector.

The exact image source allowlist includes the customer runtime, its shared token kernel and model declarations. It excludes migrations, tests, development controllers, worker inputs and arbitrary app/service files. The existing diagnostic runtime context copier includes these two new source directories so its build remains coherent with the Dockerfile; Docker ignore rules still choose each admitted source file. Negative boundary tests cover broadened app/service rules and omitted token-verification source.

Owned local image qualification selects config.settings.customer_http and serves the existing config.wsgi application with Python's fixed wsgiref server. This is a local acceptance server, not a production deployment configuration. Default image CMD and diagnostics-only dev profile remain unchanged. The local server avoids Django runserver's automatic migration-history query, which is outside the five-table reader grant. Migrations run separately with the qualified owner process. Inherited CONN_MAX_AGE=0 closes reader connections at request completion; connect_timeout=2 and statement_timeout=2000 bound the fresh handshake/statement failure used by the separate pause/unpause PostgreSQL image outage test.

Initial implementation validation:44 actual nonservice tests pass, covering finite public loader/startup, actual route registration and exact image/source boundary (including deliberately invalid allowlists). Whole-repository Ruff passes and mypy passes66 source files. These results do not establish PostgreSQL authority, transaction barriers, real provider image behavior or reader-role qualification. Those remain pending the coordinated runtime slot.

## Measured host qualification

Frozen3191a7a2fd9df9ed012483805f400c06b3519fcf passed554 actual default-suite tests against the owned pinned PostgreSQL instance, with zero failures, errors or skips. Both real separate-connection authority/snapshot barriers and the actual unavailable-connection500 case passed. Each of four schema and five HTTP mutations passed its exact baseline and then failed the named semantic assertion. All160 archived source files remained exact after execution; cleanup was independently verified by the exact container name and ownership label. Final Ruff check/formatting passed and mypy passed67 source files. These results apply to the frozen host consumer and are not transferred to the unexecuted image/provider/reader-role controller.

The controller is now normally merged from its independently reviewed freeze. Its separate77 pure cases and11 source weakenings validate controller mechanics; actual image execution remains pending. The normal diagnostic CMD and the exact source image allowlist are unchanged by this controller integration.
