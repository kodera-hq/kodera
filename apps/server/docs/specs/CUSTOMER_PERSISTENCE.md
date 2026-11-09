# Customer persistence anchors

**Status:** Implemented locally; independent review pending · **Owner:** API seat

## Admission and boundary

This is the first persistence increment on parent `cc3991783bb82770d4a9faeb818959201fb1167e`. The independently reviewed technical direction is bound to SHA-256 `4975a4552da7187d3ad6b15b97ca4372f3f0f28e75fb22eebd46d22045b98380`; the integration lead separately selected the exact UUID dependency. This document records the implementation and acceptance boundary. No generator, model, migration or dependency installation starts until the combined parent's runtime qualifies and the integration lead admits implementation.

The combined parent and executable acceptance were independently reviewed before their implementation phases. The bounded customer schema is now implemented and qualified locally: 454 tests pass, including the existing parent tests, generator, real model/migration/barrier acceptance and the coordinator controls. Four actual PostgreSQL schema weakenings are caught by their targeted semantic assertions. Independent final code review and publication remain separate; this is no customer API or release-readiness claim.

Implement five customer anchors only: `identity.User`, `identity.Identity`, `orgs.Organisation`, `orgs.Membership` and `orgs.SlugReservation`. No business HTTP route, staff authority, first-owner intake/claim, tenant, operation, provider worker, billing, purge or write service enters this increment. Synthetic fixture insertion into an owned acceptance database is not an account-creation or bootstrap API.

## Shared identifier callable

`core.db.ids.new_uuid7()` MUST be the single callable used for model defaults. It MUST return a native UUID-compatible version7 value with RFC variant and lowercase canonical string representation. Use `uuid6==2025.0.1` from wheel SHA-256 `80530ce4d02a93cdf82e7122ca0da3ebbbc269790ec1cb902481fa3e9cc9ff99`; no hand-written bit algorithm or arbitrary alternative distribution.

The adapter MUST own `_generation_lock`, a process-local threading.Lock held around the dependency's entire uuid7 call. It MUST replace only that lock in an after-fork child callback. It MUST NOT reset the dependency's private timestamp or claim global generation/commit order. The implementation MAY use a normal module import so acceptance can instrument the dependency call; no externally configurable factory is needed. A child-progress test with the parent lock held qualifies only that lock lifecycle, not arbitrary post-thread forking as a production model.

Actual equal/backward-clock, concurrent-thread and separate-process tests follow the dependency's semantics. Primary-key uniqueness is the final collision guard; collision MUST NOT update another object. Business ordering MUST use stored timestamps and a deterministic identifier tie-breaker, never decode UUID time as business authority.

## Tables and migration sequence

Use the existing application layout and string FKs. Stage User first, organisation anchors next, Identity's organisation binding afterward, with explicit migration dependencies. The completed migration package MUST contain every constraint before an API can use these tables. Models MUST NOT import another application's models, implement business save hooks, or use signals.

All five tables have immutable native UUID primary keys and UTC created_at/updated_at. User/Identity/Organisation/Membership have paired deleted_at/purge_after: both absent, or both present with purge_after strictly later. The acceptance interval is synthetic and defines no production retention policy.

| Model | Required persistence contract |
|---|---|
| User | email, nullable display_name, enabled; email is nonunique contact, not a linking key; no password/staff/verification/MFA field |
| Organisation | slug, realm, issuer, name, state, owner_guard_revision; slug 5–20 lowercase ASCII with alphanumeric ends; realm=slug; exact immutable unique issuer with matching realm suffix; prospect/active/suspended/closed states |
| Identity | restrictive User/Organisation FKs, the organisation null exactly for a staff-realm identity (`STAFF_IDENTITY.md` §1); exact immutable issuer/realm/subject and ownership; subject 1–255 case-sensitive printable ASCII (`\x21-\x7e`, the Agent API contract's subject shape, ADR-0016); email and enabled; permanent UNIQUE(issuer,subject) and UNIQUE(issuer,user), including deleted history; exact composite organisation/issuer/realm database binding; physical DELETE refused |
| Membership | immutable restrictive User/Organisation FKs; org_owner/org_admin/org_billing/org_member; invited/active/suspended/removed; active/suspended require accepted_at, invited requires none; one nondeleted row per person/organisation; removed may retain an acceptance timestamp |
| SlugReservation | namespace='organisation' only, slug, immutable unique Organisation FK, state provisional/permanent/retired, protected_at; all names remain unique while held; immutable namespace/slug/ownership; permanent cannot downgrade, retired cannot leave, protection cannot change once set; physical DELETE refused |

A deferred final-state check MUST require exactly one ownership/slug-matching reservation for every Organisation. Active/suspended organisations require permanent reservations. Provisional has no protected_at; permanent/retired require it. Both Organisation and reservation changes MUST be covered. Do not use a generic unchecked owner UUID or pretend to implement tenant reservations.

An active Organisation MUST have a nondeleted active accepted org_owner Membership at commit. Relevant membership DML, reservation insertion/update and organisation activation MUST write the common owner_guard_revision and queue a deferred final-state check. A row lock alone is insufficient for early Repeatable Read snapshots. Legitimate replacement and two-owner→one-owner transitions MUST commit; all final-owner-removal forms MUST refuse. Identity/User disable is a separate usability predicate, not a rewrite of the count invariant.

An additional measured race requires reservation writes to participate in this same organisation revision. Without that write, early Repeatable Read activation and permanent→retired reservation transactions both committed. The fixed test observes retirement blocked by activation, then 40001 and a fresh final (active, permanent) pair. Deferred reciprocal checks alone did not prevent cross-row write skew.

Use actual SQL restrictive FKs rather than relying on the ORM collector. Physical Identity DELETE and primary-key reassignment MUST be refused explicitly; outgoing RESTRICT alone cannot retain a principal key. Constraint tests run with the owned migration role; they do not claim defense against a DBA disabling triggers. No API owner credentials or broad role grant is introduced here.

`MIGRATIONS.md`'s blanket partial-uniqueness guidance does not apply to the explicitly retained Identity/reservation keys above. Membership's current-row uniqueness remains partial. This implemented retained-key exception does not restore key reuse to satisfy the older proposal. Initial tables are empty, but migration-state, lock/statement timeouts, actual FK actions, constraint validation and reversible schema teardown on an empty owned database remain review requirements. No data backfill or deployment against populated tables is proposed.

## Exact named refusals

Acceptance uses SQLSTATE and constraint names, not a generic exception or a timeout. The migration package MUST expose these stable names where the corresponding refusal applies:

| Boundary | SQLSTATE / constraint |
|---|---|
| Principal identity tuple |23505 / identity_issuer_subject_unique |
| One identity per person/issuer |23505 / identity_issuer_user_unique |
| Identity ownership/principal immutability |23514 / identity_immutable_binding |
| Physical Identity deletion |23514 / identity_delete_refused |
| Identity organisation binding |23503 / identity_organisation_binding_fk |
| Organisation canonical slug |23514 / organisation_slug_valid |
| Membership role enum |23514 / membership_role_valid |
| Active organisation final owner |23514 / organisation_owner_required |
| Organisation final reservation |23514 / organisation_reservation_required |
| Held reservation name |23505 / reservation_namespace_slug_unique |
| Reservation immutable ownership/name |23514 / reservation_immutable_binding |
| Reservation protected transition |23514 / reservation_transition_valid |
| Reservation protection timestamp |23514 / reservation_protection_immutable |
| Reservation physical deletion |23514 / reservation_delete_refused |

Additional stable constraint names used by the expanded acceptance:

- 23514: `{user,identity,organisation,membership,slugreservation}_id_immutable`; `{user,identity,organisation,membership}_deletion_valid`; `membership_immutable_binding`, `membership_state_valid`, `membership_acceptance_valid`; `organisation_immutable_binding`, `organisation_realm_valid`, `organisation_issuer_valid`, `organisation_name_valid`, `organisation_state_valid`; `identity_subject_valid`, `user_email_valid`, `identity_email_valid`, `user_display_name_valid`; `reservation_namespace_valid`, `reservation_state_valid`, `reservation_protection_valid`.
- 23505: `membership_current_unique`, `organisation_issuer_unique`, and the actual table's native `_pkey` constraint.
- 23503: `identity_user_fk`, `membership_user_fk`, `reservation_organisation_fk`, plus the composite identity FK already listed. All actual FKs must use RESTRICT and be validated.
- 23502: required contact/name/role nulls, asserting the exact offending column rather than inventing a named CHECK for NOT NULL.

These are SQL storage checks, not only Django field validators. Bounded text must produce its named CHECK refusal rather than an incidental varchar truncation error. User display_name is nullable with maximum200; Organisation name is nonempty with maximum200; User/Identity email is required/nonempty, with no invented email-linking or provider-verification rule. The issuer limit is2048 and subject limit255; issuer exact suffix and realm=slug are separate checks. No redundant organisation-slug unique index is required to replace the retained reservation name constraint. PostgreSQL40001/40P01 in owner races is acceptable only with barrier evidence, final committed-state inspection and a valid positive control; unrelated timeout/setup errors are not acceptance.

## Executable acceptance and phase limits

`tests/test_customer_ids.py` exercises the actual callable and instruments only the synchronization boundary where needed. `tests/test_customer_persistence_models.py` exercises the real registered models, actual PostgreSQL migrations and named integrity errors. The nonservice registration/callable/migration probes first recorded absent behavior as explicit assertion failures, without dependency installation or database contact. They now pass. Database and generator executions followed their separate implementation/resource admissions.

```sh
python -m pytest tests/test_customer_ids.py::test_shared_callable_exists tests/test_customer_persistence_models.py::test_customer_anchor_models_are_registered
python -m pytest tests/test_customer_ids.py tests/test_customer_persistence_models.py tests/test_customer_persistence_concurrency.py tests/test_customer_persistence_migrations.py
python dev/selftest_customer_ids.py
```

Use a fresh task-owned Python environment after admission. Never mutate a prior review environment. Preserve the existing runtime/kernel suites and source pinning. No workflow, IAM or AGENTS edits are needed to prepare these probes.

The generator qualification used a fresh owned environment with the exact reviewed wheel installed locally without dependencies. Existing pinned test/runtime dependencies were reused read-only from the qualified environment; this is not a fresh installation proof of the complete application lock. Normal lock resolution added only the UUID package; all68 unrelated package records, including artifact identities, are unchanged. The seven nonservice tests use a clean test-process environment so host infrastructure variables do not enter Django; production environment refusal remains unchanged.

`selftest_customer_ids.py` copies the exact generator/tests and local settings into a disposable directory. Each selected baseline must pass before its weakening; removing full-call serialization must produce the named overlap assertion, and removing child reset must produce the named bounded-progress assertion. The runner verifies the exact failing test and diagnostic, uses a fixed environment, and cleans its temporary directory and owned test children. No database, provider, or network process is started.

The model DML, migration and owner-barrier acceptance must be executable and independently reviewed **before model code**. The expanded packet supplies actual-table probes for owner races under Read Committed, early Repeatable Read and Serializable, cross-organisation progress under Read Committed, forward/reverse/reapply migrations, schema state agreement and retained-key/soft-deletion predicates. Actual PostgreSQL execution followed the separately admitted owned service slot; collection and the earlier absence assertions alone did not qualify those database behaviors. The separately scoped HTTP increment will supply the SELECT-only API role, coherent authority snapshot, `/me` projection and AR01–AR20; this model package cannot claim those route checks passed.

## Expanded test-first evidence and database execution

The three model/concurrency/migration files contain 153 cases, now executed against actual PostgreSQL; the coordinator adds five pure controls. The two initial absence probes and two pure connection-cleanup controls remain in the suite. The final 454-test run has zero failures or skips. Source bytes and hashes were archived before the final run, with per-test transaction barriers, final rows, database-role attributes and migration timeout observations retained separately from the initial failures.

The intended owned PostgreSQL command is the second pytest command above, with a fresh task-owned environment and an explicit synthetic loopback database configuration supplied by the separately reviewed runtime harness. Never run it against an arbitrary existing database. The migration test creates its own randomly named `test_customer_migration_*` database through the acceptance migration role, then drops only that exact database without FORCE. Its coordinator sets and verifies 5s lock and 30s statement timeouts before either operation; these are bounded synthetic acceptance settings, not a production migration-policy choice. It never reverses the shared pytest database. The actual migration executor must establish finite nonzero lock/statement timeouts before application DDL. Forward/reverse/reapply compares tables, trigger/functions, validated constraints and performs a valid five-anchor transaction after reapply.

The concurrency tests use distinct actual sessions and verify both early snapshots before changing either owner. They observe the second session blocked by the first database PID before committing the first. The second must refuse with 23514/`organisation_owner_required` or 40001, and a third fresh session must find exactly the retained second owner. No deadlock is intentionally staged, so 40P01, timeouts and barrier failures cannot pass these cases. Separate positive controls prove a different organisation completes while the first guard remains blocked. Cleanup attempts every acquired session even after a rollback failure; incomplete worker cleanup is an explicit failure.

Qualification includes four fixed isolated source/database weakenings through `dev/mutate_customer_persistence.py`, invoked by the owned coordinator’s `--mutations` option. For the owner counterexample, retain SELECT FOR UPDATE serialization and remove only the actual common-row revision write: the contender must still reach the expected lock barrier, then the early-snapshot test must fail its semantic both-removals/retained-owner assertion. Removing the entire guard and failing barrier setup is not this proof. Removing the deferred reservation final-state enforcement must fail the absent/mismatched reservation assertion; removing the actual composite issuer binding must fail its named cross-organisation insertion refusal. Each weakening needs a passing exact baseline and its targeted semantic failure; catalog assertions alone are insufficient. All four cases passed their exact baseline and failed the mutated semantic assertion. The fourth case removes only reservation serialization and reproduces the measured activation/retirement race. Resource-guard and generator selftests each catch two pure weakenings; the inherited token guard mutation suite remains separately passing. No mutation output claims missing-row/authority HTTP acceptance.

## Runtime profile and CI coverage

`config.settings.persistence` registers only the five customer models on the existing local configuration; `config.settings.test` imports that profile. The default development profile and health API image remain unchanged and do not expose these models through HTTP. Local schema commands must explicitly select `--settings=config.settings.persistence`.

The CI job "Migrations are complete" runs `makemigrations --check` through `scripts/ci/check-migrations-complete.py`, which refuses a settings module that leaves out any package with migrations. Since the job queue brought a schema of its own, the profile that installs every such package is `config.settings.job_queue`, this profile plus the queue's three applications ([`JOB_QUEUE.md`](JOB_QUEUE.md) §3.1); `config.settings.persistence` alone is refused there. The pytest case `test_migrations_match_registered_state` also checks migration-state consistency under the persistence test profile.

The initial package stages User, organisation anchors, Identity and its relationships, then the final SQL constraints. Its tables are empty on first application; all FKs are validated and RESTRICT. Reverse order removes the exact constraints, triggers and functions without CASCADE. The migration executor test applies, reverses and reapplies this package only in its own generated database. Test database role attributes are recorded; this migration role is not an API least-privilege credential.

## Dependency lock procedure after admission

1. Verify the reviewed wheel hash again. Create a fresh owned environment using the existing pinned Python runtime; do not install into any original environment.
2. Add exactly uuid6==2025.0.1 to runtime dependencies and resolve the application lock. The lock MUST retain the exact reviewed wheel hash and preserve unrelated versions; inspect every dependency delta before synchronization. No added transitive runtime dependency is expected.
3. Install the reviewed wheel into the owned environment without dependency/build-backend acquisition. Reuse already available locked dependencies; if an artifact is unavailable, report that exact acquisition before broad network access.
4. Record installed distribution metadata, run actual generator acceptance/mutations, then the owned PostgreSQL model qualification. The source/wheel review does not substitute for these executions.

## Changelog

- Defines the bounded customer anchors, shared generator interface and test-first implementation boundary from the reviewed technical decisions.
- Keeps principal and reservation keys retained, distinguishes schema integrity from account authority, and preserves the separate HTTP and bootstrap work.

- Records actual customer-schema qualification, the measured reservation race correction, scoped runtime profile and retained CI coverage limits.
- Narrows the organisation slug check to 5–20 characters, the owner's minimum (register row SLUG-MIN-ANSWER), in migration `orgs.0003`.
- The migrations check's complete profile is `config.settings.job_queue` since the job queue has a schema; this profile registers the five customer models again, after the queue's applications were installed here for a time.
- `Identity.organisation` is nullable for a staff identity, which is in the staff realm; a customer identity keeps its composite binding (`STAFF_IDENTITY.md`, migrations `identity.0003` and `orgs.0006`).
