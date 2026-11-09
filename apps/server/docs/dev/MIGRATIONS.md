# Migrations policy

**Status:** Proposed · **Owner:** API seat

The control plane is a single Postgres database that must stay available while it changes, and whose billing and audit tables are append-only records. Migrations are therefore additive by default, reversible where they touch data, and never allowed to take a long lock on a table the API is reading.

## 1. Rules

1. **Additive only.** A migration adds tables, columns, indexes and constraints. It does not drop or rename in the same release as the code that stops using them.
2. **Expand, migrate, contract** (§2) is the only way to change a column's name, type or nullability.
3. **A new column is nullable, or has a database default that is cheap.** Adding a non-null column with a computed default over a large table is a backfill, not a schema change.
4. **Indexes are created `CONCURRENTLY`** (§4).
5. **Data migrations are reversible `RunPython`** with an explicit reverse function (§3).
6. **One concern per migration file.** A schema change and a backfill are two files, and the backfill is not in the same deployment step as the constraint that depends on it.
7. **No migration references application code.** A `RunPython` uses `apps.get_model`, never an import of a model class, so a migration keeps working after the model changes.
8. **Never edit a migration that has run anywhere.** Fix it forward.
9. **Append-only tables** (`Invoice`, `InvoiceLine`, `CreditNote`, `Payment`, `AuditEvent`, `DeletionCertificate`, `Job`, `JobStep`) may gain columns, never lose them, and their immutability triggers are re-asserted by a test after any migration that touches them.
10. **Every migration is reviewed for its lock.** The pull request states, for each operation, which lock it takes and for how long on a table of production size.

## 2. Expand and contract

Changing anything about an existing column is at least three deployments.

| Phase | Migration | Code | Safe to roll back |
|---|---|---|---|
| **Expand** | Add the new column, nullable, plus a trigger or dual-write in the service layer | Writes both, reads the old | yes |
| **Backfill** | A separate, batched, reversible `RunPython` filling the new column | unchanged | yes |
| **Switch** | Add the constraint (`NOT NULL` via `NOT VALID` then `VALIDATE`, unique via `CONCURRENTLY`) | Reads the new, still writes both | yes |
| **Contract** | Drop the old column and the dual-write | Writes and reads only the new | the drop is not reversible; it ships only after the switch has been live |

A rename is the same sequence: never `ALTER TABLE ... RENAME COLUMN` on a table the API is using, because the old and new code cannot both be right during a rolling deployment.

## 3. Data migrations

```python
def forwards(apps, schema_editor):
    Tenant = apps.get_model("tenancy", "Tenant")
    ...


def backwards(apps, schema_editor): ...


operations = [migrations.RunPython(forwards, backwards, elidable=False)]
```

- `reverse_code` is **mandatory**. `RunPython.noop` is allowed only when the forward operation is genuinely information-preserving and the pull request says why in a comment.
- Batched: work in chunks with a bounded query, committing per chunk, so a long backfill neither holds a transaction open nor blocks vacuum. A migration that rewrites more than roughly ten thousand rows in one statement is rejected.
- Idempotent: re-running the forward function must be harmless, because a partially applied batched migration will be re-run.
- No network. A data migration never calls a provider, Keycloak, or the queue. Anything needing the outside world is a job, not a migration.
- No audit rows. A migration does not write `AuditEvent`; a bulk change that a customer should see is performed by a `system`-actor job that writes its own events.

## 4. Indexes and constraints

- `CREATE INDEX CONCURRENTLY`, with `atomic = False` on the migration class, always, on any table that is not empty.
- A concurrent index build can fail and leave an invalid index; the migration's reverse drops it, and a check reports invalid indexes so a failed build is noticed rather than silently unused.
- Unique constraints on soft-deleted tables are **partial**: `WHERE deleted_at IS NULL`, as [`../domain/MODEL.md`](../domain/MODEL.md) §1 requires.
- Foreign keys and check constraints are added `NOT VALID`, then validated in a second migration. `VALIDATE CONSTRAINT` takes a weak lock; adding a validated constraint takes a strong one.
- Enum-like columns are `text` plus a `CHECK`. Changing the allowed set is an `ALTER ... DROP CONSTRAINT` / `ADD CONSTRAINT NOT VALID` / `VALIDATE` sequence, not a Postgres enum type alteration.

## 5. Locks: what is allowed in a single deployment

| Operation | Lock | Allowed |
|---|---|---|
| `ADD COLUMN` nullable, or with a constant default | brief `ACCESS EXCLUSIVE` | yes |
| `ADD COLUMN` with a volatile or computed default | table rewrite | no — expand and backfill |
| `DROP COLUMN` | brief `ACCESS EXCLUSIVE` | only in a contract phase |
| `ALTER COLUMN TYPE` | table rewrite | no — expand and contract |
| `SET NOT NULL` directly | full scan under a strong lock | no — `CHECK ... NOT VALID`, validate, then set |
| `CREATE INDEX` | blocks writes | no — `CONCURRENTLY` |
| `ADD FOREIGN KEY` validated | strong lock on both tables | no — `NOT VALID` then validate |
| `RENAME` anything | brief lock, but breaks rolling deployments | no |

Every migration sets a `lock_timeout` and a `statement_timeout` so that a migration which would block the API fails fast instead of taking the service down. A migration that trips the timeout is a design problem, not a retry.

## 6. CI gates

- `makemigrations --check --dry-run` fails the build when models and migrations disagree. This is the gate that stops a model change merging without its migration.
- A linter rejects: a migration without `reverse_code`, a non-concurrent `CREATE INDEX` on a non-empty table, an `ALTER COLUMN TYPE`, a `RENAME`, a direct `SET NOT NULL`, a model import inside a migration, and a data migration in the same file as a schema change.
- Migrations are applied forward and then **backward** on an empty database in CI, so a missing reverse is caught before it is needed.
- The full test suite runs against a database built by applying every migration from zero, not by `syncdb`-style creation, so the migration chain itself is tested.
- The pull-request template asks for the lock statement of §1 rule 10; a reviewer checks it against the table in §5.

## 7. Deployment order

1. Apply migrations.
2. Deploy the new code.

This order is only safe because of rule 1: every migration is compatible with the code currently running. A migration that requires the new code is a contract-phase migration and ships after that code is live everywhere.

The worker and the API deploy separately; a migration must be compatible with both the old and the new worker for the length of a deployment.

## 8. What a reviewer checks

- [ ] The change is additive, or it is an explicit phase of an expand-and-contract sequence.
- [ ] Every `RunPython` has a real reverse, is batched, is idempotent, and touches no network.
- [ ] Indexes are concurrent; constraints are added `NOT VALID` and validated separately.
- [ ] Unique constraints on soft-deleted tables are partial.
- [ ] The pull request states the lock each operation takes.
- [ ] `makemigrations --check` is green and the backward run passes.
- [ ] Nothing edits a migration that has already run.

## Changelog

- First version. Fixes part of assessment item C7: additive-only migrations, the expand-and-contract sequence, mandatory reversible batched data migrations, concurrent index creation with `NOT VALID` constraint validation, the lock table, and the CI gates including `makemigrations --check` and a backward run.
- Reformats the `backwards` stub to what `ruff format` produces. The formatter reads Python fenced blocks in Markdown, so a code sample in this handbook is held to the same standard as the code it teaches — which is the point of putting it here.
