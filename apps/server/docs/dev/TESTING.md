# Testing strategy

**Status:** Proposed · **Owner:** API seat

Every task has an acceptance test before code exists. This document says what kinds of tests we write, what each is allowed to fake, and which gates block a merge.

## 1. Tiers

| Tier | Runs against | Speed budget | What it proves | Marker |
|---|---|---|---|---|
| Unit | No database, no network | < 1 s per file | Pure logic: money arithmetic, state-machine tables, redaction, cursor encoding, URN parsing | default |
| Integration | **Real Postgres**, no external network | < 10 s per file | Constraints, transactions, triggers, service functions, queries, scoping | `@pytest.mark.db` |
| API | Real Postgres, test client | < 10 s per file | Status codes, problem types, headers, pagination, permissions | `@pytest.mark.api` |
| Contract | The committed OpenAPI file against a live test instance | minutes | The implementation matches the contract | `@pytest.mark.contract` |
| Worker | Real Postgres, **fake `tofu` and `ansible-playbook` on `PATH`** | minutes | Steps, idempotency, compensation, leases | `@pytest.mark.worker` |
| Chaos | Real Postgres, fake tooling, a killed process | minutes | Orphan recovery and mid-apply safety | `@pytest.mark.chaos` |
| Architecture | The import graph and the URL map | seconds | Layer rules, declared scopes, registry completeness | `@pytest.mark.arch` |

No test tier mocks the database. SQLite is never used: the model depends on Postgres constraints, partial unique indexes, triggers, advisory locks and `jsonb`, and a test that does not exercise them proves nothing. Every tier runs on every pull request that is ready for review (a draft runs only the cheap gates, and its `ci-ok` is red, until it is marked ready, which starts the full run); the full suite is the merge gate.

## 2. Integration tests use a real Postgres

- The database is the same major version as production: locally the disposable `test-db` compose service (`make test-db test`: its own `test` profile and port, data on a tmpfs), in CI the job's service container. Both run with `fsync=off`, because with fsync on a test's teardown `TRUNCATE` waits on disk syncs under the 2 s `statement_timeout`. The development database `db` keeps default durability; do not point the suite at it. `tests/test_runtime.py` fails on a server that fsyncs.
- Tests run inside a transaction that is rolled back, except tests of triggers, advisory locks and `ON CONFLICT` behaviour, which need real commits and use a truncating fixture.
- Test ordering is randomised. A test that depends on another test's rows fails on the first randomised run rather than in a month.
- Time is controlled by a time-travel fixture, never by sleeping. A test that sleeps is rejected.
- Factories build valid aggregates and never bypass service functions when the thing under test is a service.
- **No real customer data, ever**, in a fixture, a factory or a snapshot. Fixtures use obviously synthetic values; a lint rule rejects anything that looks like a real address or a real domain we do not own.

## 3. Contract tests

The committed `contracts/core-api.openapi.yaml` is the input, not the output ([`../api/CONVENTIONS.md`](../api/CONVENTIONS.md) §15).

- A property-based contract runner drives every operation in the file against a live test instance, checking that every response validates against its declared schema, that undeclared status codes never occur, and that every error body is a registered problem type.
- Stateful sequences check the rules that span requests: an `Idempotency-Key` replayed returns the identical body; a `PATCH` without `If-Match` returns `428`; a cursor from one filter set is rejected against another; a `429` carries `Retry-After`.
- A separate test asserts the generated specification equals the committed one, and fails the build on divergence rather than rewriting either.
- A breaking-change check compares against the specification on the main branch.
- The mock package the console consumes is generated from the same file, so a console mock cannot drift from the contract.

## 4. Worker tests against fake tooling

The worker never runs real infrastructure tooling in a test. `tests/fakes/bin/` contains executables named `tofu`, `ansible-playbook`, `restic` and `kcadm.sh`, put first on `PATH` by a fixture. Each fake:

- records every invocation with its arguments to a journal the test asserts against;
- returns canned output selected by a scenario file, including the exit codes that matter (`tofu plan -detailed-exitcode` returning 2 for drift, a lock error, a partial apply);
- can be told to hang, so timeout handling is exercised;
- can be told to fail on the *second* invocation, which is how compensation paths get covered.

Required per job kind ([`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md)):

1. **Happy path** — every step succeeds; the resulting rows and the journal are asserted.
2. **Idempotency proof** — the job is run twice with the same idempotency key; the second run performs no visible action and returns the first result.
3. **Step re-run** — each step is executed twice in isolation; the world after equals the world after one execution. This is the executable form of the "idempotency proof" column.
4. **Compensation** — each step is made to fail; compensation is asserted to run in reverse from the last started step and to be itself re-runnable.
5. **Timeout** — a hanging fake proves the step's timeout fires and the job does not lose its lease while the process is being reaped.
6. **Lease loss** — renewal is blocked; the runner is asserted to stop work rather than continue.

## 5. Chaos test

At least one test kills the worker process mid-`tofu apply` against the fake tooling, then runs the sweeper, and asserts:

- the job becomes `needs_reconciliation`, not `orphaned`, because the apply's dispatch is open without terminal proof, and it emits `job.reconciliation_required` with the unresolved step and operation recorded;
- an expired lease, a stale heartbeat and an unheld advisory lock, alone or together, never move it out of that state, and nothing runs `tofu force-unlock` or repeats the apply;
- its lock reservation stays in force, so a conflicting job on the same tenant is not claimed, even with no database session holding the live lock;
- the killed runner, resumed, cannot record a step or dispatch under its old fence;
- after an operator's `resume` decision is recorded, and only then, the job is claimed again with a higher fence and resumes from the first non-succeeded step, and a force-unlock, if the decision calls for one, is run by the operator and audited once as `job.state_force_unlocked` under a `staff` actor;
- a step with retry class `C` that was in flight is **not** dispatched again automatically;
- the final world equals the world produced by an uninterrupted run.

A companion test, for a kind whose budget allows a second claim, kills the worker after a step is claimed but before it dispatches anything, and asserts that the job becomes `orphaned`, its reservation ends, and it recovers from the first non-succeeded step with no human input (ADR-0004).

A second chaos test kills the worker between the desired-state commit and the first step, proving the outbox property: the job exists, the audit row exists, and nothing was lost.

### 5.1 The job-queue acceptance directory

`tests/job_queue/` holds the queue's acceptance tests, bound row by row to an inventory
([`../specs/JOB_QUEUE.md`](../specs/JOB_QUEUE.md) §9). Every row is `pass` since the queue was
implemented in `apps.jobs`, `apps.outbox` and `apps.audit`: a row is a strict expected failure only
while the thing it needs is missing. Those three applications are installed by
`config.settings.job_queue`, which `config.settings.test` loads and the API image's profiles do
not (§3.1 there); a schema command that must see them, `makemigrations` among them, names that
profile. Two rules of its `conftest.py` can surprise a run that was not about the queue:

- A module of that directory that is skipped or broken at collection fails the run, from the
  repository root too. Fix the import; there is no option that excuses it.
- Every inventory row must produce a call report. Under `CI`, or in a run that narrowed nothing, a
  row without one fails the run. A run you narrowed yourself — `-k`, `-m`, `--deselect`, `--lf`,
  `--ff`, a node id or a path inside the directory, `-x` or `--maxfail` — prints one `NOTICE` line
  naming the rows and exits as it otherwise would: `uv run pytest -k test_runtime` at the repository
  root exits 0. `--collect-only` never fails for this.

The remedy both lines name is the same: run the directory, `uv run pytest tests/job_queue`. The rule
keeps its records in the pytest process, so it must be revisited before `pytest-xdist` is introduced.

Neither rule sees a run that never reports a collector from inside the directory, so
`tests/test_job_queue_inventory.py`, outside it, reads the tracked configuration instead: it fails
when the inventory's twenty-seven identifiers, their functions, the two module names, or a
`python_files`, `testpaths`, `norecursedirs`, `addopts`, `collect_ignore` or rival configuration file
would keep pytest from collecting the rows. If it fails after you touched `pyproject.toml` or added a
`conftest.py` above the directory, its sentence says which setting leaves the directory out. It does
not see an `--ignore` on a command line; CI does, through
`scripts/ci/check-job-queue-rows.py`, which reads the JUnit report of the `Tests` shards,
merged by the `tests-complete` job, and fails unless every inventory row appears in it once, with
the outcome its state gives. CI runs the suite in four shards, a file or a whole directory with a
`conftest.py` at a time, and `tests-complete` refuses the run unless every collected test was
reported exactly once (`.github/scripts/check-test-shards.py`, proven by its self-test).

The self-test also runs every mutant flag of `tests/job_queue/mutants.toml` against the real queue:
one case per flag, which enables that flag, runs the row's owning test and requires it to fail with
the row's exact message. A failing case names the flag. To rerun one flag:

```sh
DATABASE_URL=postgres://kodera:kodera@127.0.0.1:5434/kodera_server uv run pytest \
  "tests/job_queue/test_job_queue_selftest.py::test_every_mutant_flag_is_caught_by_its_owning_test_on_the_real_queue[<flag>]"
```

The whole set, one case per flag, takes about two and a half minutes on a developer's machine; the
row check above also requires each case passed, so CI cannot drop it.

## 6. Every preflight-style check ships a self-test mutation

This is a repository rule (`AGENTS.md`) and it applies to any check that can pass vacuously: preflight phases, deny-list schema validation, the "no credential resolves outside this project" assertion, the secret-absence assertions, the immutability triggers, the architecture rules.

For each such check the pull request adds a **mutation**: a deliberately broken input or a deliberately weakened rule, and a test asserting the check **fails** on it. A check with no mutation is not merged. The mutation lives beside the check, is named for what it breaks, and is exercised in CI, so a check that silently stops working is caught by its own test.

Examples of required mutations:

| Check | Mutation that must fail it |
|---|---|
| Preflight "no credential resolves outside project" | A fixture credential scoped one level too wide |
| Deny-list profile schema | A profile with `privileged: true` |
| Invoice immutability trigger | An `UPDATE` on an issued invoice |
| "No secret in any response schema" | A serializer temporarily exposing `ciphertext` |
| Architecture import rule | A module importing another application's models |
| Banned environment variables in the API process | Setting one of the banned variables |

## 7. Coverage gate

- Line coverage **≥ 90 %** overall, measured across the whole suite, and **≥ 95 %** on `apps/*/services.py`, `worker/runner/`, `worker/steps/`, `core/auth/`, `core/events/` and every money path in `apps/billing/`.
- Branch coverage on state-machine modules is **100 %**: every transition in the tables, and every rejection outside them.
- Coverage may not decrease. A pull request that lowers the overall figure fails, whatever its absolute value.
- Coverage is a floor, not evidence. A reviewer still asks whether the assertions mean anything; a test that calls a function and asserts it did not raise is rejected regardless of the line it covers.

## 8. What must have a test before it merges

- [ ] Every allowed transition, and a generated test that every disallowed pair raises.
- [ ] Every problem type in the registry is produced by at least one test.
- [ ] Every audit action in the registry is emitted by at least one test.
- [ ] Every job kind has the six worker tests of §4.
- [ ] Every invariant listed in [`../domain/MODEL.md`](../domain/MODEL.md) §11 has a named test.
- [ ] Every check that can pass vacuously has its self-test mutation.
- [ ] Every new endpoint has an authorisation test per role in the matrix, including the denial cases.

## Changelog

- First version. Fixes part of assessment item C7: the test tiers with a real Postgres, contract testing driven by the committed specification, worker tests against fake infrastructure tooling on `PATH`, the chaos test for mid-apply worker death, the coverage gate, and the rule that every preflight-style check ships a self-test mutation.
- Rewrites the §5 chaos test for ADR-0004 as accepted: a runner killed mid-apply leaves `needs_reconciliation` with its reservation, no automatic force-unlock and no repeat, and resumes only after an operator's decision under a higher fence; a companion test proves that a runner killed before any dispatch leaves `orphaned` and recovers on its own. The old assertion that a force-unlock "runs exactly once" after a no-live-runner check is removed, because the accepted ADR forbids that path.
- The orphan companion chaos test names a kind whose budget allows the automatic re-run; a kind with a budget of one fails `orphaned_exhausted` instead ([`../specs/JOB_QUEUE.md`](../specs/JOB_QUEUE.md) §5.2).
- §5.1 says what the job-queue acceptance directory's collection and call-report rules do to a run that was not about the queue, and the remedy.
- §5.1: the job-queue rows pass against the implemented queue, and the self-test runs every mutant flag against it; how to rerun one flag, and what the whole set costs.
- §5.1 says which settings profile installs the queue's applications, and that the API image's profiles do not load it.
