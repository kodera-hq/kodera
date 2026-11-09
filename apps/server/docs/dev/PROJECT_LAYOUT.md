# Project layout

**Status:** Proposed · **Owner:** API seat

Where code goes, and the two rules that keep it there: an application owns its models, and nothing crosses an application boundary except through a service function.

## 1. Tree

```text
kodera-server/
├── contracts/                     # hand-authored interface files (owned by the contracts workstream)
├── docs/
├── core/                          # shared kernel; depends on no application
│   ├── db/                        # base model, UUIDv7 default, soft-delete manager, money field, encrypted field
│   ├── api/                       # pagination, problem+json renderer, idempotency, ETag, filters, throttles
│   ├── auth/                      # authenticators, JWKS cache, principal objects, permission primitives
│   ├── events/                    # audit writer, action registry, redaction
│   ├── jobs/                      # queue adapter, lease, step runner, retry classes, orphan sweeper
│   ├── observability/             # structlog processors, context binding, tracing helpers, metrics
│   └── types/                     # shared value objects: Slug, Money, Urn, Regime
├── apps/
│   ├── orgs/                      # Organisation, Membership, Invitation, Contact, DpaAcceptance
│   ├── identity/                  # User, Identity, EnrolmentToken, realm bindings
│   ├── catalog/                   # Plan, Price
│   ├── billing/                   # Subscription, Invoice, InvoiceLine, CreditNote, Payment, PaymentLink, dunning
│   ├── tenancy/                   # Tenant, Host, Ip, MaintenanceWindow, Secret
│   ├── domains/                   # Domain and its state machine
│   ├── releases/                  # Release, TenantRelease
│   ├── jobs/                      # Job, JobStep, the job kinds' orchestration
│   ├── agents/                    # Agent, the agent API surface
│   ├── audit/                     # AuditEvent, export
│   ├── observability/             # Probe, StatusComponent, Notification
│   └── support/                   # SupportTicket (stored until a helpdesk exists), later SupportTicketLink, Export, DeletionCertificate
├── worker/                        # the provisioning worker process; no inbound network (ADR-0003)
│   ├── runner/                    # lease renewal, step execution, compensation
│   ├── steps/                     # one module per step family: tofu, ansible, keycloak, scaleway, dns, restic
│   └── credentials/               # per-job credential loading; the only place that touches Secret Manager
├── config/                        # Django project: settings per environment, urls, asgi, wsgi
└── tests/                         # cross-cutting tests: contract, chaos, architecture rules
```

Every application has the same internal shape:

```text
apps/<app>/
├── models.py            # or models/ when it exceeds a screenful per entity
├── services.py          # the ONLY public entry point for other applications
├── selectors.py         # read-side queries, organisation-scoped by construction
├── api/
│   ├── serializers.py
│   ├── views.py
│   ├── permissions.py   # declares x-kodera-scope and x-kodera-authz, per operation
│   └── urls.py
├── events.py            # the audit actions this application may emit
├── migrations/
└── tests/
```

## 2. The layers

| Layer | May import | May not | Holds |
|---|---|---|---|
| `core/` | Django, third-party libraries | any `apps/*`, `worker/*` | Primitives with no domain meaning |
| `apps/<app>/models.py` | `core/`, its own application | any other application | Tables, constraints, invariants expressible in the database |
| `apps/<app>/services.py` | `core/`, its own models, **other applications' `services.py` and `selectors.py`** | other applications' models, serializers, views | Business operations, transactions, audit writes, job creation |
| `apps/<app>/selectors.py` | `core/`, its own models | other applications' models | Scoped reads |
| `apps/<app>/api/` | `core/api`, its own services and selectors | any models directly, other applications' anything | HTTP shape only |
| `worker/` | `core/`, `apps/*/services.py` | `apps/*/models.py`, `apps/*/api/` | Step implementations, credential loading |
| `config/` | everything | — | Wiring |

**The rule: no cross-application model import.** `apps/billing/` never writes `from apps.tenancy.models import Tenant`. It calls `apps.tenancy.services.get_tenant_for_billing(...)` or `apps.tenancy.selectors.tenant_by_id(...)`. Foreign keys across applications are declared as string references (`"tenancy.Tenant"`), which Django resolves without an import.

Why: the boundary is what lets `billing` be reasoned about without loading tenancy's invariants, what makes a service function the place where an audit row is written, and what stops a view from quietly bypassing organisation scoping.

Enforcement, in `tests/architecture/test_application_boundaries.py` and `tests/architecture/test_view_scopes.py`. These tests run in CI on every pull request that is ready for review, in the `Tests` jobs (`make test` locally); they are cheap and they are the only thing that keeps the boundary real once the codebase is large. Each check is proven able to fail by a test that builds a violating tree and asserts the lines it reports.

- A test fails on any module under `apps/<a>/` importing `apps.<b>.models` where `a ≠ b`, or reading it through a name an import bound.
- A test fails on any `apps/<app>/models.py` or `models` package module importing anything of another application (the `models.py` row's "May not" column).
- A test fails on any `apps/*/api/` module importing a `models` module of any application, its own included, or anything of another application, or reading one through a name an import bound (the `api/` row's "May not" column). It also fails when the only modules under `apps/*/api/` are `__init__.py`, so a tree of empty packages cannot pass.
- A test fails on any `core/` module importing `apps` or `worker`. It also fails when the only modules under `core/` are `__init__.py`.
- A test fails on any `worker/` module importing an application's `models` or `api` module (the `worker/` row's "May not" column). It also fails when the only modules under `worker/` are `__init__.py`.
- In `tests/architecture/test_view_scopes.py`, a test fails on a routed view that does not declare its scope. A view is every callable a URL pattern reaches, through any depth of `include()`, DRF or plain Django, in every urlconf a module of `config/settings/` names as its `ROOT_URLCONF` (today `config.urls` and `config.customer_urls`), as each urlconf builds its patterns under the test settings. A view declares, with `core.api.scopes.declares`, one `Operation` per HTTP method it serves — the method, the `operationId` and its `x-kodera-scope`. By convention the `Operation` is defined in the application's `api/permissions.py`; the test does not check where it is defined. The test fails on a view with no declaration; on a scope that is not `<resource>:<verb>`, whose resource is not a row of the `../api/AUTHZ.md` §5 matrix or whose verb is not in its closed set; on an `operationId` the contract does not have; on a scope, method or path that differs from the contract's; on a regex route, whose contract path it cannot read; on a class-based view or viewset accepting a method it declares nothing for, an explicit `head` or `options` handler and a viewset's handler outside its action map included; and on a settings module whose `ROOT_URLCONF` is not a string literal. A route under `agent/v1/` is held to `contracts/agent-api.openapi.yaml` instead: its operations carry no `x-kodera-scope`, so the view declares the scope `agent`; the test fails when that operation is not in the agent contract, when its `x-kodera-authz` does not admit the agent, when its method or path differ, or when a customer route declares `agent`. The only exemption is the closed list `EXEMPT` in the test, of routes and the view each reaches, today the two probes of `core/health.py` at `health/live` and `health/ready`; each entry must be routed there and be a DRF view, `AllowAny` and nothing else, with no authentication class, no declaration and no method but `GET`, so an undeclared `AllowAny` view, or a probe routed at another path, fails as a view without a scope. Outside that list the test reads no permission or authentication class: a view that declares a matching operation passes whatever it lets in. One class routed at several paths, such as a router's list and detail routes, cannot pass yet: every route is held to all of the class's operations. It fails rather than passes, and the check is to be extended with the first such route. Not seen: the methods a plain function view handles; a method a class serves other than through a handler on the class — an overridden `dispatch`, `http_method_names` passed to `as_view()`, or a handler set on the instance; a decorator built with `functools.wraps` above the declaration, which copies the mark (and a class view's `view_class` or `cls`) to its wrapper, so a method the wrapper adds is not seen (a decorator that builds a new view instead, such as DRF's `api_view`, drops the mark, and the view fails as one without a scope); a route a urlconf adds only under settings other than the test settings; a `ROOT_URLCONF` set other than by assignment in `config/settings/` (through `globals()`, or imported from elsewhere); a urlconf a middleware selects per request through `request.urlconf`; a urlconf's `handler400`, `handler403`, `handler404` and `handler500` views, which no pattern reaches; the roles of `x-kodera-authz`, which the declaration does not carry; and whether the permission layer enforces the declared scope at run time, which is not built (`../api/AUTHZ.md` §5).

Not yet enforced, and applied by a reviewer by hand until they are (§6 here, `../api/AUTHZ.md` §10 for the scope):

- **The "May import" column of every row.** No test holds a layer to its allow-list; each test above checks a "May not" column only. The tree already departs from it: `apps/identity/api/views.py` imports `core.db.ids`, not only `core/api`, and it and `apps/identity/services.py` import a top-level `services/` package that neither §1 nor this table lists.
- **`services.py` imports no other application's serializers or views.** The `services.py` row's ban on other applications' models is the first test above; the rest of the row has no test.

None of these checks sees an import built at run time (`importlib`, `__import__`, `getattr` with a string), a bound name assigned to another name, or the names a star import binds; and a model another application re-exports from a module that is not its models reads as an import of that module.

## 3. The services layer

A service function is the unit of business change. It:

1. takes a **principal** and plain values, never a request or a serializer;
2. opens **one transaction**;
3. validates invariants the database cannot express;
4. writes the desired-state change;
5. writes the `AuditEvent`;
6. creates the `Job` when infrastructure must move;
7. returns a domain object or raises a domain error that the API layer maps to a problem type.

```python
def suspend_tenant(*, principal: Principal, tenant_id: UUID, reason: SuspensionReason) -> Job: ...
```

Rules:

- Service functions are keyword-only, typed, and checked by the strict type checker.
- A service never raises an HTTP exception and never imports from `rest_framework`.
- A service that mutates infrastructure returns the `Job`; the view turns it into `202` ([`../api/CONVENTIONS.md`](../api/CONVENTIONS.md) §7).
- Nothing outside `services.py` calls `.save()`, `.create()`, `.update()` or `.delete()` on a model of another application, and nothing at all does so in a view.
- Model `save()` overrides are forbidden for business logic; a model may normalise its own fields and nothing more. Signals are forbidden outright: they hide the transaction boundary that ADR-0004 depends on.

## 4. The worker

The worker is a separate process and a separate deployment with no inbound network. It shares the codebase so that job steps can call services, and it is kept honest by three rules:

- It imports `apps/*/services.py` only. A step that needs a query asks for a selector.
- Every credential it uses is loaded by `worker/credentials/` when it is needed, and dropped at the end of the lifetime the table of `SETTINGS_AND_SECRETS.md` §4 gives that credential (ADR-0003, ADR-0004). No other package may import that module, except, by lane decision W5, the realm delivery's one-shot command and its admin client until the scheduler lands; `tests/architecture/test_adr_0003.py` holds the importers to that closed list and proves no API module reaches the package.
- `worker/steps/` modules are pure with respect to the database: they take the values a step needs and return a result; persisting the result is the runner's job. This is what makes a step re-runnable in a test against fake tooling.

## 5. Naming

| Thing | Convention | Example |
|---|---|---|
| Application | lower, plural where it names a collection of entities | `domains`, `billing` |
| Model | singular `PascalCase` | `InvoiceLine` |
| Service function | verb phrase, imperative | `issue_invoice`, `verify_domain` |
| Selector | noun phrase | `active_tenants_for_organisation` |
| Job kind | lower snake, matches [`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md) | `rotate_secret` |
| Audit action | `<domain>.<past_tense>` | `tenant.suspended` |
| Problem type | kebab, matches the registry | `invalid-state-transition` |
| Setting | upper snake, prefixed by area | `KODERA_JWKS_CACHE_TTL_S` |

## 6. What a reviewer checks

- [ ] New code is in the right layer, and the layer's import rules hold.
- [ ] Nothing imports another application's models, serializers or views.
- [ ] Business change happens in a service function that opens the transaction and writes the audit row.
- [ ] No signal, no business logic in `save()`.
- [ ] The worker touches services, not models; credentials are loaded per job.
- [ ] A new application is added to the tree above and to the architecture tests.

## Changelog

- First version. Fixes part of assessment item C7: the twelve applications, the shared kernel, the services and selectors layers, the worker's boundary, and the architecture tests that enforce the no-cross-application-model-import rule.
- `permissions.py` declares both endpoint extensions, not only the scope (`../api/AUTHZ.md` §5).
- Reformats the `suspend_tenant` stub to what `ruff format` produces, for the same reason as `MIGRATIONS.md`.
- §2 lists the architecture tests that exist and run in CI — the cross-application models rule, the `models.py` row, the `api/` row and the `core/` row — and names what they do not check yet: the "May import" allow-lists, the rest of the `services.py` row, the `worker/` row, to come with `worker/`, and the view-scope test, issue #116. §4 no longer claims a test for `worker/credentials/`, and takes each credential's lifetime from the table of `SETTINGS_AND_SECRETS.md` §4 instead of giving every one a job's. The earlier text listed five tests as running in CI when one did.
- §2 lists the `worker/` row's test as running, now that `worker/` has modules (G1.5-A); §4 names the test that holds `worker/credentials/` to its importers.
- §2 lists the view-scope test, issue #116, as running: `tests/architecture/test_view_scopes.py` checks that every routed view declares, through `core.api.scopes.declares`, the operation it serves and that operation's `x-kodera-scope`, against the §5 matrix of `../api/AUTHZ.md` and the contract, with `core/health.py` as the only, closed exemption.
