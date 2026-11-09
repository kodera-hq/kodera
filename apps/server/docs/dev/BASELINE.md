# Core tech baseline

Status: The local bootstrap installs the exact Django, DRF, settings-parser and
PostgreSQL-driver pins in `pyproject.toml`. Remaining capabilities in this
baseline are not implemented by that slice; see
[`RUNTIME_BOOTSTRAP.md`](RUNTIME_BOOTSTRAP.md).

Frozen. Every entry below is a decision already taken; changing one is a pull
request that says why, not a preference expressed in a new module. The point is
that a reader of any file in this repository can predict what they will find,
and that an agent given a task does not get to pick a library.

Anything genuinely new — a queue, a cache, a second datastore, a background
runtime — is an ADR in [`../adr/`](../adr/), not an addition to this table.

## Language and toolchain

| Choice | Why |
|---|---|
| Python 3.12 | The last version every dependency in this list supports without a caveat; `tomllib`, better error messages, and typing features `services/` relies on. |
| `uv` | One tool for the interpreter, the virtualenv, the resolver and the lock. Fast enough that CI installs from scratch rather than nursing a cache. |
| `ruff` (lint + format) | One binary replaces flake8, isort, pyupgrade, bandit and black. A single formatter ends style discussion; `S` rules mean the security lint is not a separate job somebody skips. |
| `mypy --strict` on `services/` and on the job queue — `apps/jobs/`, `apps/outbox/`, `apps/audit/`, `core/db/` — with `django-stubs` | Strict where the money and the infrastructure mutations live. Other views and models get the non-strict baseline: the strictness is aimed at the code where a wrong type provisions the wrong thing. |

## Web

| Choice | Why |
|---|---|
| Django 6.1 | The batteries this control plane actually needs — ORM, migrations, admin, auth plumbing — with a release cadence we can follow. |
| Django REST Framework | The console is the only consumer and it wants a plain, versioned REST surface; DRF is the least surprising way to serve one. |
| `drf-spectacular` | Generates the OpenAPI document CI diffs against the hand-authored `contracts/core-api.openapi.yaml`. Divergence fails the build instead of reaching the console as a surprise. |
| `psycopg` 3 with a connection pool | Current driver, native async path, and a pool the API needs under a worker fleet reconnecting per job. |
| `django-environ` | Settings from the environment, typed and with defaults. A misspelled variable name is silently ignored, which is why `.env.example` documents every one. |

## Jobs

| Choice | Why |
|---|---|
| A queue built in this repository on its own PostgreSQL tables (`apps.jobs`, [`../specs/JOB_QUEUE.md`](../specs/JOB_QUEUE.md)); no queue library | A Postgres-backed queue means a job and the desired-state change it effects commit in one transaction (ADR-0004). No second datastore to run, back up, or lose a job in. This entry named "Procrastinate 3.x, pinned to the minor" until the queue was implemented; Procrastinate was never a dependency of this repository. ADR-0004 asks for "Procrastinate or an equivalent Postgres-backed queue", and the equivalent is what the specification describes: the job row itself carries the status set, the lease, the fence and the place in request order, beside its own lock reservations, dispatch records and reconciliation decisions, each guarded in the database and read by name by the acceptance tests. Those records and their writers are the queue. A library's job table would have been a second one beside them, and ADR-0004 already excludes the library's heartbeat-driven recovery for jobs with external effects. |
| Postgres as the queue | Already the system of record. Adding Redis or RabbitMQ would add a component that can disagree with the database about what is true. |

## Contracts and payloads

| Choice | Why |
|---|---|
| `pydantic` v2 for `x-kodera` and agent payloads | Tenant profiles and agent heartbeats are untrusted, executable input. Parsing them into typed objects at the boundary is the difference between a rejected payload and an interesting `KeyError` in a worker. |
| `httpx` | One HTTP client, sync and async, that `respx` can mock precisely in tests. |

## Observability

| Choice | Why |
|---|---|
| `structlog` + `django-structlog` | Structured logs with a request id from the first commit. Reconstructing a job across API and worker from prose logs is not possible. |
| OpenTelemetry, exported to Alloy | Vendor-neutral instrumentation; the backend can change without touching application code. |

## Tests

| Choice | Why |
|---|---|
| `pytest` + `pytest-django` | Fixtures compose; the alternative does not. |
| `pytest-cov` | Coverage is a map of what is untested, not a target to hit. |
| `pytest-randomly` | Randomised order every run. Order dependence is a bug and this is how it gets found. |
| `time-machine` | Leases, timeouts and retries are time-dependent, so time is something tests control rather than wait for. |
| `respx` | Scaleway, Keycloak, DNS and billing calls are asserted against, not reached. |
| `schemathesis` | Drives the OpenAPI contract against a live test API, so the document and the implementation cannot drift quietly. |

## What is deliberately absent

- **Node.** Nothing in this repository builds a frontend. The console is its
  own repository with its own baseline.
- **Celery, Redis, RabbitMQ.** See ADR-0004.
- **Kubernetes.** See ADR-0002.
- **An ORM-level multi-tenancy library.** Tenancy here is a business object
  with its own lifecycle, not a schema-switching trick. Identity is not part of
  that object: a tenant authenticates against its organisation's realm
  (ADR-0006).

## Commands

```bash
# Toolchain (installs the dev group from pyproject.toml)
uv sync

# Lint and format
uv run ruff check .
uv run ruff format .
uv run ruff format --check --diff .    # what CI runs

# Types
uv run mypy .

# Tests, against the disposable fsync-off test database (docs/dev/TESTING.md)
docker compose --profile test up -d --wait test-db
DATABASE_URL=postgres://kodera:kodera@127.0.0.1:5434/kodera_server uv run pytest
DATABASE_URL=postgres://kodera:kodera@127.0.0.1:5434/kodera_server uv run pytest --cov --cov-report=term-missing

# Local gates, in one pass over the whole tree
uv run pre-commit install
uv run pre-commit run --all-files

# Development stack (Postgres, Keycloak, Mailpit)
cp .env.example .env
docker compose up -d
docker compose --profile app up -d db api  # local probes only; worker is absent

# Isolated acceptance creates and removes only its own disposable resources
.venv/bin/python dev/accept_runtime.py
```

`make lint`, `make typecheck`, `make test`, `make up`, `make down` and
`make precommit` wrap the same commands. See [`../../dev/README.md`](../../dev/README.md)
for the stack itself.

## Where the pins live

| Concern | File |
|---|---|
| Python version, dev tools, ruff, mypy, pytest, coverage | [`../../pyproject.toml`](../../pyproject.toml) |
| Local hooks and their exact revisions | [`../../.pre-commit-config.yaml`](../../.pre-commit-config.yaml) |
| CI gates and pinned tool versions | [`../../../../.github/workflows/ci-server.yml`](../../../../.github/workflows/ci-server.yml) |
| Development service images | [`../../compose.yaml`](../../compose.yaml) |
| Local process and backing-service environment examples | [`../../.env.example`](../../.env.example) |

Source: the engineering methodology and core tech baseline in the internal
architecture baseline.
