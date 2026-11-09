# Local runtime bootstrap

**Status:** Proposed · **Owner:** API seat

This slice MUST boot a real Django 5.2 LTS and DRF process against disposable
PostgreSQL. It establishes process isolation and truthful dependency checks.
It implements no business API, identity integration, provisioning worker,
owner/order/billing model or complete first-slice acceptance scenario.

## Contract before implementation

| Scenario | Given / When | Required result |
|---|---|---|
| RT-01 | A running local API; GET `/health/live` | HTTP 200, exactly `{"status":"alive"}`; no database query |
| RT-02 | PostgreSQL answers `SELECT 1`; GET `/health/ready` | HTTP 200, exactly `{"status":"ready","database":"reachable"}` |
| RT-03 | PostgreSQL connection or query fails | Readiness returns HTTP 503 with exactly `{"status":"not_ready","database":"unavailable"}`; liveness remains 200; no exception or credential detail reaches the response |
| RT-04 | PostgreSQL becomes available again | The next readiness request retries and returns 200; no stale successful response is cached |
| RT-05 | POST to either probe, or an unspecified business route | 405 for POST; 404 for the absent route; no domain mutation |
| RT-06 | A known infrastructure credential environment variable is present | Startup refuses configuration, including an empty declared credential; diagnostics contain no value |
| RT-07 | Debug is enabled, wildcard/external hosts or an external/non-Postgres database URL is supplied | Startup refuses unsafe local configuration before opening a connection |
| RT-08 | Development compose declarations and resolved configuration are inspected | API/worker have explicit variable allowlists, no bulk env file (including an absent optional file), no repository bind, no privileged mode or Docker socket, and only loopback-published ports |
| RT-09 | An image is built with synthetic `.env`, `.git` and worker-file sentinels beside its source | Those sentinels are absent from the API image; build inputs and COPY sources are allowlisted |
| RT-10 | An isolated real PostgreSQL acceptance database | The database test creates, reads and rolls back synthetic temporary data; it must not silently substitute SQLite or a mocked cursor |
| RT-11 | The separate worker placeholder is explicitly selected | It exits unsuccessfully with a clear not-implemented message; it cannot be reported as a working job processor |

The probes are local runtime diagnostics, outside the proposed business API.
Readiness proves only the application database is reachable. It does not prove
identity, migrations for future models, billing, provisioning, restore, or
customer-release readiness. PostgreSQL connections and statements MUST have
short timeouts, and responses MUST disable caching.

## Executable acceptance

`tests/test_runtime.py` exercises HTTP semantics, real PostgreSQL and refused
configuration. `tests/test_development_boundary.py` reads compose declarations, resolved compose and
build-input policy. Both run under the existing detected pytest CI job; boundary guard self-tests
restore a forbidden mount, bulk environment file or widened image exception
and assert its refusal.
`dev/accept_runtime.py` is the disposable local acceptance helper and MUST create uniquely named resources,
use loopback ephemeral ports, capture exact image digests, and remove only its
own containers/network after checking ownership. It MUST NOT run a blanket
compose shutdown, use a deployment credential, or touch existing containers.
The same helper checks an actual database outage and recovery over HTTP.

Every refusal added by this slice needs a weakening mutation: removing the
credential restriction, accepting an external database, or reporting a failed
database as ready MUST make its named acceptance fail. Restoring a repository
bind or widening image input acceptance MUST fail boundary acceptance.

## Scope and dependency evidence

Runtime dependencies are exact pins in `pyproject.toml`, with transitive hashes
in `uv.lock`. Django 5.2.17 is the supported 5.2 LTS patch selected from the
[official support table](https://www.djangoproject.com/download/). DRF 3.18.1
requires Django 5.2 or newer according to its
[release notes](https://www.django-rest-framework.org/community/release-notes/)
and [published metadata](https://pypi.org/project/djangorestframework/3.18.1/).
PostgreSQL uses the existing major version 16, pinned to an image digest for
local acceptance. This is local development configuration, not a production
container or deployment proposal.

The API MUST NOT load `.env` itself or mount the repository. Known credential
names can be refused at startup; this is not a detector for every possible
secret in an arbitrary environment. Explicit container inputs supply the
stronger process boundary. Fake executables on PATH are test doubles: PATH
precedence is not an egress, credential or execution security boundary.

Configuration refusal identifies matched conventional environment variable
names only, never their values. Nonconventional names are represented by a
fixed placeholder. Unknown runner inputs remain refused until their exact
names and noncredential purpose are verified; CI execution never bypasses
this guard.

The sole reviewed metadata exception is `AZURE_EXTENSION_DIR`, the installed
CLI extension-directory setting documented by the
[CLI extension guide](https://learn.microsoft.com/en-us/cli/azure/azure-cli-extensions-overview).
Its presence alone permits local startup. Core neither reads its value nor
opens that directory or loads extensions. Other `AZURE_` names, including
similarly named suffixes, remain refused; an actual credential beside this
metadata still prevents startup. This exception applies by exact name, not
by a CI flag or by inspecting a potentially sensitive value.

## Changelog

- Defines the first executable local runtime and negative acceptance before
  implementation, while preserving the complete customer-release scope.
