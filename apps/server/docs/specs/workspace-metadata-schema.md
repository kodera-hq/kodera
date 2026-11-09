# Workspace structure schema

Status: Proposed. Implemented on this branch; its schema and migration acceptance runs in CI on the tree combined with the membership-authority slice.

Persist workspace, category and channel structure without exposing a command or granting content access. The app is registered by the schema and test profiles (`config.settings.job_queue`, which `config.settings.test` loads, and `config.settings.workspace_metadata_test`) and, since `getWorkspace` and `initialiseWorkspace` ([`PILOT_WORKSPACE_ONBOARDING.md`](PILOT_WORKSPACE_ONBOARDING.md)), by the image's customer profile `config.settings.customer_http` and `config.settings.e2e` built on it; `config.settings.dev` still does not. `tests/test_workspace_test_profiles.py` holds that line. This slice itself added no route, identity role or policy projection; `0005_template_key` adds the starter template's nullable key to categories and channels.

## Stored contract

All three records inherit StoredModel UUIDv7 identity and aware timestamps. Workspace has one unique organisation binding and positive bigint structure_revision, initially 1. Category has a workspace, name, nonnegative integer position and positive bigint version, initially 1. Channel has a workspace, optional category, immutable text/audio kind, name, topic, nonnegative position and positive bigint version, initially 1. Revisions are stored values; authorised monotonic writers and CAS/reorder semantics require a later slice.

Names use PostgreSQL text with character length 1–100 and a nonempty result after BTRIM removes only SP, HT, LF and CR (U+0020, U+0009, U+000A, U+000D). Input is preserved; this is a validity predicate, not a normalization operation. NBSP is deliberately nonblank. Topic is text with length 0–1024. Character limits do not count UTF-8 bytes. Kind is text restricted to text/audio. Named checks emit SQLSTATE 23514, including overlength refusal; varchar/implicit positive-field constraints do not compete with them.

All relationship fields have db_constraint=False and no implicit uniqueness. The migrations provide explicit database constraints. One workspace per organisation, one category per workspace/position, and one channel per workspace/category/position are named unique constraints. Channel sibling uniqueness treats NULL categories as equal. A named unique category (id, workspace_id) pair supports the composite channel category/workspace FK. The independent channel workspace FK also protects uncategorised channels.

Database RESTRICT prevents deleting referenced organisations/workspaces/categories. Empty categories may be deleted and channels may move within a workspace or become uncategorised. Workspace organisation/identity, category workspace/identity and channel workspace/identity/kind are immutable. A named trigger refuses every channel DELETE; a later admitted lifecycle must govern disposal. No content, native room mapping, lifecycle/retention columns, permission grants or readiness signal is introduced.

## Migration ownership and reversibility

0001 depends on orgs.0003_organisation_slug_minimum_five. It creates only the three new tables, primary keys, named checks/uniques and ordinary relationship indexes. 0002 installs four RESTRICT FKs, the no-argument functions workspace_structure_immutable and workspace_channel_delete, and four user triggers:

- workspace_binding_immutable on workspaces_workspace;
- category_binding_immutable on workspaces_category;
- channel_binding_immutable and channel_delete_refused on workspaces_channel.

Both migrations use five-second lock and thirty-second statement timeouts within the migration transaction. Reversing 0002 removes those FKs/functions/triggers. Reversing 0001 then removes the new tables and their owned objects. No shared table, function, index or constraint is rewritten. Reversal is tested only on an empty, disposable database; it is not a production data-erasure procedure.

The test inventories the exact constraint names, kinds and unique indexes; model fields must not introduce a duplicate implicit FK/unique constraint. Primary keys use the normal workspaces_<model>_pkey names. Scalar and relationship constraint diagnostics are specified in tests/test_workspace_metadata_schema.py.

## Acceptance

Fifteen executable tests were written before the model source. They require PostgreSQL major 16 exactly and use transactional pytest isolation with randomized order. They cover real commit/reopen, scalar boundary acceptance/refusal, raw database guards, NULL sibling uniqueness, cross-workspace refusal, atomic rollback, staged migration-object disappearance/reappearance, existing-schema invariance and flush cleanup with the deletion guard still effective. A rolled-back constraint-removal mutation admits the otherwise invalid cross-workspace channel, then verifies refusal after restoration. No in-memory or SQLite result proves this schema.

These tests run in the normal suite (`make test`, and the `Tests` job in CI) against the disposable test database, under `config.settings.test`.
