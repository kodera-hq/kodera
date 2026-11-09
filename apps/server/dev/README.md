# The development stack

Status: Local runtime bootstrap; business API, authentication and jobs remain unimplemented.

The reproducible bootstrap acceptance uses a private image build context,
uniquely named containers, loopback ephemeral ports and synthetic PostgreSQL.
It stops only its own database to test readiness failure and recovery, then
removes only resources carrying its ownership label. Existing containers and
volumes are left alone.

```bash
uv sync --python 3.12 --locked
.venv/bin/python dev/accept_runtime.py
```

The helper prints the image identity, selected ports and test result. A passed
run proves local health/database behavior, not the complete first slice or
customer-release readiness. The written contract is
[`RUNTIME_BOOTSTRAP.md`](../docs/dev/RUNTIME_BOOTSTRAP.md).

## Manual local API

Use a distinct project name and available ports when several worktrees exist.
This starts only the application database and the API; the optional identity
and mail fixtures are not dependencies of the implemented probes.

```bash
CORE_DB_PORT=15439 CORE_API_PORT=18009 \
  docker compose -p core-local-review --profile app up --build -d db api
curl http://127.0.0.1:18009/health/live
curl http://127.0.0.1:18009/health/ready
```

Port choices above are examples, not a reservation. The acceptance helper
avoids fixed-port conflicts automatically. Published ports bind to loopback;
the development server listens inside its container. This is not a deployment
configuration. Code changes require rebuilding the image: there is no source
bind mount.

## Test database

`make test` runs the suite against `test-db`, a disposable Postgres in the
`test` compose profile, never against `db`. It runs with `fsync=off`, because a
test's teardown `TRUNCATE` otherwise waits on disk syncs under the 2 s
`statement_timeout`. It keeps its data on a tmpfs and declares no volume, so
stopping it discards only its own data and `db` keeps default durability.

`make test` and `make first-slice-scenarios` check first that a Postgres server
answers the test credentials on the test database port, and stop with a message
that says what they found instead — nothing listening, a listener that is not
Postgres, or a server that rejects the credentials — and names `make test-db`.
They never start the container themselves.

A second worktree needs its own project name as well as its own port. Without
`-p`, compose uses `kodera-server` from `compose.yaml` and recreates the first
worktree's `test-db`, discarding its tmpfs data mid-run.

```bash
make test-db test                          # project kodera-server, port 5434
make test-db test COMPOSE="docker compose -p core-wt2" CORE_TEST_DB_PORT=15440
docker compose --profile test stop test-db            # discards the first worktree's test data
docker compose -p core-wt2 --profile test stop test-db  # the second's: `-p` again, or this stops the first's
```

Compose interpolates `.env` only into each service's explicit variables.
Neither application service receives a bulk environment file. The API image
contains only its runtime and configuration sources, with no `.env`, Git
metadata or worker files. The settings module never reads `.env` itself.
Do not source the backing-services environment into an API process: local
identity admin variables, SSH agent sockets and secrets-file references are
refused too. Host-side tools need a clean environment; the acceptance helper
constructs one automatically.

## First-slice bootstrap acceptance

Scenario state is authoritative in `tests/first_slice/scenarios.toml`, and
`make first-slice-scenarios` enforces it; see
[`first-slice-acceptance-harness.md`](../docs/testing/first-slice-acceptance-harness.md).
The report below is superseded for state and remains the evidence record.

`make check-first-slice-expected-red` is the lightweight G1 planning gate: it requires all 33
identifiers, zero passing, 32 strict expected failures and the sole scenario blocked on audited
one-time redelivery after identity erasure. It prints that runtime acceptance remains unmet.
`make mutate-first-slice-expected-red` weakens each of its four guards in a disposable copy and
requires the named counterexample while an intact control stays green.

`make acceptance-first-slice` reports the 33 mandatory scenarios. Seven of them,
FS-BOOT-01..07, are driven by `dev/first_slice_bootstrap.py` against a real
disposable PostgreSQL it starts itself from
`dev/first_slice_bootstrap.compose.yaml`, under its **own** compose project
`fsboot-acceptance` on port 55432. That separation is deliberate:
`docker compose down -v` removes every named volume of the project it is given,
so a harness that tore down the development project would take another
worktree's database with it. This project owns one container and no named
volume, and the harness tears down nothing else. It also tears its own project
down when the run ends, so do not point `make test` at port 55432 while an
acceptance run is in flight: the run owns that database and will remove it.

FS-BOOT-06 additionally boots the real local identity provider through
`dev/identity_fixture.py` and verifies its token with the real
`services/identity/access_tokens.py`. It reports `blocked`, because no realm
definition here configures a second factor and faking one would defeat the
scenario. Expect the full run to take several minutes and to return nonzero.

Run Python targets under `env -u SSH_AUTH_SOCK`: `config/environment.py`
refuses an API process that carries an SSH agent socket or a cloud-credential
variable, and that refusal is a control, not an inconvenience to work around.

`make mutate-first-slice-bootstrap` proves the packet's guards refuse six
weakenings in disposable copies, each by the message that names it.

## Optional fixtures

`compose.yaml` retains PostgreSQL, identity and mail fixtures for later
integration work. `dev/realms/` is synthetic input imported into an empty
identity database. These exports are not evidence that the Core API already
validates tokens or that an organisation lifecycle is implemented. Do not
reset or repurpose a running shared fixture while another task uses it.

The `worker` profile is separate from `app`. It runs the provisioning worker,
`python -m worker run`, from its own image (`Dockerfile.worker`), which carries
no URL, WSGI or API module. Its only network, `worker-db`, is internal and
holds the database alone; its environment is explicit and its only read-only
source mount is `dev/fakebin`. The job runner is not built yet (G1.5-B): the
worker verifies its boundary, reaches the database and exits with
`the job runner is not implemented yet: this worker claims no job`. A started
worker is not a working provisioner.

### The realm exports

`dev/realms/` is mounted read-only into the optional `keycloak` service and
imported once, into an empty identity database, by `start-dev --import-realm`.
Nothing else consumes these files: no environment variable selects them, no
application code reads them, and the token-qualification helper builds its own
throwaway realm rather than reusing them. CI only checks that each export
parses as JSON.

| File | Realm | User | Password |
|---|---|---|---|
| `kodera-staff-realm.json` | `kodera-staff` (staff) | `staff` | `devpassword` |
| `org-acme.json` | `org-acme` | `acme-admin` | `devpassword` |
| `org-bravo.json` | `org-bravo` | `bravo-admin` | `devpassword` |

Each export declares one public `console` client with mandatory PKCE (`S256`)
and no secret, one realm role `admin`, and one user holding it. The direct
access grant is disabled, so the fixture cannot be driven by a password grant
and a credential never passes through it. That is the shape of the export; no
Core API login flow exists against it.

The two non-staff exports are named for organisations rather than tenants
because ADR-0006 records that a realm belongs to a customer organisation and is
shared by every tenant of that organisation. ADR-0003 records that the API holds
no master-realm rights: the decided production path creates a realm from a job,
using a per-realm `realm-management` service account. Neither that job nor that
path is implemented here.

**The import runs only against an empty identity database.** After editing an
export:

```bash
# `docker compose down -v keycloak-db` is the trap: `-v` is not scoped to the
# service named after it. Its own help says it removes "named volumes declared
# in the volumes section of the Compose file" — `db-data`, the application
# database, included. Remove the container, then the identity volume by name.
# The volume name is the compose project name plus `_keycloak-db-data`, so it
# differs per project. Derive it instead of typing it: `make up` uses the
# `name:` in `compose.yaml`, and `-p NAME` overrides that, so repeat whatever
# `-p` you started with on the line below. A hardcoded name resets nothing, or
# removes another worktree's or another project's volume.
project=$(docker compose config | awk '/^name:/ {print $2; exit}')
docker compose -p "$project" rm -sfv keycloak-db
docker volume rm "${project}_keycloak-db-data"
docker compose -p "$project" up -d keycloak
```

Editing a realm in the admin console changes the running container, not the
file. Anything worth keeping is written back into `dev/realms/` by hand, or it
disappears at the next reset.

## Fake provisioning binaries

`dev/fakebin/` contains logging test doubles for `tofu` and
`ansible-playbook`. PATH precedence selects them for ordinary invocations;
it cannot stop an absolute executable path, network call or credential use.
It is not a security boundary. Do not give these fixtures real credentials.

The `FAKE_TOFU_FAIL=1` switch selects deterministic failing output. The fakes
can be exercised directly with synthetic arguments while the worker runtime
is absent. Their documentation-range addresses are sample data, not evidence
that arbitrary network calls from a process are impossible.


## Customer persistence qualification

The [customer persistence spec](../docs/specs/CUSTOMER_PERSISTENCE.md) describes the local five-model schema. It has no business HTTP endpoint or bootstrap flow. Default health settings and the API image remain unchanged; schema commands explicitly use `--settings=config.settings.persistence`, while pytest selects the persistence test profile.

With the existing pinned environment and cached PostgreSQL image available:

```sh
.venv/bin/python dev/accept_persistence.py --mutations
.venv/bin/python dev/selftest_persistence_harness.py
.venv/bin/python dev/selftest_customer_ids.py
```

The coordinator uses one uniquely labelled, bounded container, a 256MiB temporary data filesystem and a loopback-only ephemeral port; it never pulls an image or modifies another container/volume. It checks a 5GiB disk reserve, executes the full test suite and four fixed semantic schema weakenings, records owned per-test metadata, and verifies cleanup. Resource selftests use fake Docker and start no service. Never substitute a shared/customer database for this owned qualification.

The model tests include actual SQL/FK refusals, deferred final-state checks, transaction barriers and an isolated empty-database forward/reverse/reapply. These results do not qualify API reader privileges, customer authentication or `/me`; those remain the subsequent consumer increment.
