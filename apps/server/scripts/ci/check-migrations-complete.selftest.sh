#!/usr/bin/env bash
# Proves the migrations check can fail, and fails for the stated reason.
#
# The job it guards ran `makemigrations --check` under settings that installed
# no app with a schema, so it printed "No changes detected" over a model change
# it could not see. Every case below runs the real check against a copy of the
# tree, mutated one way, and asserts the exit status AND the message: the exit
# status because it is all CI consumes, the message because a check that
# refuses everything would pass an exit-status-only self-test.
#
# The baseline is the unmutated copy and must pass, so each refusal below is
# caused by its mutation and not by the tree. The cases that must pass are
# there for the same reason in the other direction: a check that is too strict
# is a defect too. The suite stops at the first case that fails and names it,
# which is what prove-migrations-check-selftest-binds.sh reads.
#
# Run it through `uv run`, with the database the job provides: the check
# imports Django from that environment. MIGRATIONS_SELFTEST_TREE names the tree
# to copy when this file runs from somewhere else (the binds proof does that).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${MIGRATIONS_SELFTEST_TREE:-$(cd "$here/../.." && pwd)}"
script="$here/check-migrations-complete.py"
settings="config.settings.job_queue"
expected_cases=23

[ -f "$script" ] || { echo "self-test FAILED: $script is missing" >&2; exit 1; }
python -c 'import django' 2>/dev/null \
  || { echo "self-test FAILED: no Django on this interpreter; run it with uv run" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/migrations-check-selftest.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# The tree as the working copy has it, untracked files included and ignored
# ones (the virtualenv among them) left out.
mkdir "$work/base"
git -C "$root" ls-files -z --cached --others --exclude-standard \
  | while IFS= read -r -d '' f; do [ -e "$root/$f" ] && printf '%s\0' "$f"; done \
  | (cd "$root" && tar --null -T - -cf -) \
  | tar -xf - -C "$work/base"
[ -f "$work/base/manage.py" ] || { echo "self-test FAILED: the tree copy has no manage.py" >&2; exit 1; }

cases=0

# fresh <label>: a copy of the tree to mutate.
fresh() {
  cp -R "$work/base" "$work/$1"
}

# replace <file> <before> <after>: one exact occurrence, or the case fails,
# so a mutation cannot silently miss the line it names.
replace() {
  python - "$1" "$2" "$3" <<'EOF'
import sys
path, before, after = sys.argv[1:]
text = open(path, encoding="utf-8").read()
if text.count(before) != 1:
    sys.exit(f"self-test FAILED: expected one {before!r} in {path}, found {text.count(before)}")
open(path, "w", encoding="utf-8").write(text.replace(before, after))
EOF
}

# drop_migration <label> <app> <name>: delete one migration and repoint every
# migration of the app that depended on it to the one it depended on, so the
# case removes that migration alone whatever came after it (a later migration
# would otherwise name a node that no longer exists, and the check would fail
# on the graph instead of on what the case planted).
drop_migration() {
  python - "$work/$1/apps/$2/migrations" "$2" "$3" <<'EOF'
import pathlib, re, sys
directory, app, name = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
target = directory / f"{name}.py"
parents = re.findall(rf'\("{app}", "([0-9]{{4}}_[a-z0-9_]+)"\)', target.read_text(encoding="utf-8"))
if len(parents) != 1:
    sys.exit(f"self-test FAILED: {target} does not depend on exactly one {app} migration")
target.unlink()
node = f'("{app}", "{name}")'
for path in sorted(directory.glob("[0-9][0-9][0-9][0-9]_*.py")):
    text = path.read_text(encoding="utf-8")
    if node in text:
        path.write_text(text.replace(node, f'("{app}", "{parents[0]}")'), encoding="utf-8")
EOF
}

# package <dir>: an empty Python package, parents included.
package() {
  mkdir -p "$1"
  : > "$1/__init__.py"
}

# concrete_models <file> <model>: a models module with one concrete model.
concrete_models() {
  printf '%s\n' 'from django.db import models' '' '' "class $2(models.Model):" \
    '    id = models.BigAutoField(primary_key=True)' \
    '    amount = models.IntegerField()' > "$1"
}

# app_config <file> <dotted name>: an apps.py for that package.
app_config() {
  printf '%s\n' 'from django.apps import AppConfig' '' '' 'class SelftestConfig(AppConfig):' \
    "    name = \"$2\"" > "$1"
}

# installing <label> <module> <app>...: a settings module on top of the
# job-queue settings, which install every app with a schema, that also installs
# the named apps.
installing() {
  local label="$1" module="$2"
  shift 2
  {
    echo 'from .job_queue import *'
    printf 'INSTALLED_APPS = [*INSTALLED_APPS'
    printf ', "%s"' "$@"
    echo ']'
  } > "$work/$label/config/settings/$module.py"
}

# expect <label> <settings> <exit> <needle> [<forbidden>]: run the check on the
# copy; the exit status must match, the needle must be in the output, and the
# forbidden text, when given, must not be. PYTHONPATH is passed through, so a
# case can put a third-party app on the path.
expect() {
  local label="$1" with="$2" want="$3" needle="$4" forbidden="${5:-}" out got=0
  out="$(cd "$work/$label" && python "$script" --root "$work/$label" --settings "$with" 2>&1)" || got=$?
  if [ "$got" -ne "$want" ] || ! grep -qF -- "$needle" <<<"$out" \
    || { [ -n "$forbidden" ] && grep -qF -- "$forbidden" <<<"$out"; }; then
    echo "self-test FAILED: '$label' expected exit $want with \"$needle\"${forbidden:+ and without \"$forbidden\"}, got exit $got:" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  cases=$((cases + 1))
  printf '  ok  %-40s exit %s  %s\n' "$label" "$got" "$needle"
}

silent="No changes detected"

echo "check-migrations-complete self-test"

# Baseline: every app installed, every migration present. core/db has a
# models.py but no apps.py and no migrations, so it is not required.
fresh clean
expect clean "$settings" 0 "$silent"

# The defect itself: a field changed on an orgs model with no migration.
fresh orgs-field-without-migration
replace "$work/orgs-field-without-migration/apps/orgs/models.py" \
  "owner_guard_revision = models.BigIntegerField(default=0)" \
  "owner_guard_revision = models.BigIntegerField(default=1)"
expect orgs-field-without-migration "$settings" 1 "Migrations for 'orgs':" "$silent"

# The same for the other app the old job could not see.
fresh identity-field-without-migration
replace "$work/identity-field-without-migration/apps/identity/models.py" \
  "    display_name = models.TextField(null=True, blank=True)" \
  "    display_name = models.TextField(null=True, blank=False)"
expect identity-field-without-migration "$settings" 1 "Migrations for 'identity':" "$silent"

# An installed app with a concrete model and no migrations/ yet. makemigrations
# without labels skips it and prints "No changes detected": its first migration
# is exactly what this gate is for.
fresh installed-app-without-migrations
package "$work/installed-app-without-migrations/apps/ledger"
app_config "$work/installed-app-without-migrations/apps/ledger/apps.py" apps.ledger
concrete_models "$work/installed-app-without-migrations/apps/ledger/models.py" Entry
installing installed-app-without-migrations selftest_ledger apps.ledger
expect installed-app-without-migrations config.settings.selftest_ledger 1 "Migrations for 'ledger':" "$silent"

# The same with no apps.py at all: Django gives it a default AppConfig, and the
# tree walk does not require it, so only the installed labels can see it.
fresh installed-models-only-app
package "$work/installed-models-only-app/apps/tally"
concrete_models "$work/installed-models-only-app/apps/tally/models.py" Count
installing installed-models-only-app selftest_tally apps.tally
expect installed-models-only-app config.settings.selftest_tally 1 "Migrations for 'tally':" "$silent"

# A settings module that drops orgs, over the same orgs change. Without the
# guard this happens to fail today, but only on Django's system check, because
# identity has a foreign key into orgs: an app nothing points at would pass
# silently. The guard refuses it by name before either.
fresh settings-drop-orgs
replace "$work/settings-drop-orgs/apps/orgs/models.py" \
  "owner_guard_revision = models.BigIntegerField(default=0)" \
  "owner_guard_revision = models.BigIntegerField(default=1)"
printf '%s\n' 'from .job_queue import *' \
  'INSTALLED_APPS = [app for app in INSTALLED_APPS if app != "apps.orgs"]' \
  > "$work/settings-drop-orgs/config/settings/selftest_drop_orgs.py"
expect settings-drop-orgs config.settings.selftest_drop_orgs 2 \
  "does not install apps.orgs, so makemigrations --check cannot see" "$silent"

# The settings the job used before: they install no app with a schema, and there
# makemigrations --check printed "No changes detected" over any model change.
fresh default-settings
expect default-settings config.settings.dev 2 \
  "config.settings.dev does not install apps.audit, apps.billing, apps.docs, apps.engine_intents, apps.extensions, apps.identity, apps.jobs, apps.legal, apps.media, apps.notifications, apps.orgs, apps.outbox, apps.support, apps.tenancy, apps.workspaces, core.idempotency" "$silent"

# The customer schema profile alone: it installs identity and orgs and leaves
# the job queue's three apps out, as every profile the API image starts does
# (docs/specs/JOB_QUEUE.md §3.1). A model change in the queue is invisible
# there, so the check refuses it by name.
fresh customer-profile-without-the-queue
expect customer-profile-without-the-queue config.settings.persistence 2 \
  "config.settings.persistence does not install apps.audit, apps.billing, apps.docs, apps.engine_intents, apps.extensions, apps.jobs, apps.legal, apps.media, apps.notifications, apps.outbox, apps.support, apps.tenancy, apps.workspaces, core.idempotency, core.staff_api, so makemigrations --check cannot see" "$silent"

# An app with an AppConfig and a models.py but no migrations yet, left uninstalled.
fresh app-without-migrations
package "$work/app-without-migrations/apps/ledger"
app_config "$work/app-without-migrations/apps/ledger/apps.py" apps.ledger
concrete_models "$work/app-without-migrations/apps/ledger/models.py" Entry
expect app-without-migrations "$settings" 2 "does not install apps.ledger," "$silent"

# The same with a models/ package instead of a models.py.
fresh models-package-without-migrations
package "$work/models-package-without-migrations/apps/ledger"
app_config "$work/models-package-without-migrations/apps/ledger/apps.py" apps.ledger
package "$work/models-package-without-migrations/apps/ledger/models"
expect models-package-without-migrations "$settings" 2 "does not install apps.ledger," "$silent"

# Migrations outside apps/ count too: the walk is not limited to one directory.
fresh migrations-outside-apps
package "$work/migrations-outside-apps/core/db/migrations"
expect migrations-outside-apps "$settings" 2 "does not install core.db," "$silent"

# And not limited to two levels either.
fresh deep-package
package "$work/deep-package/services/identity/ledger/migrations"
expect deep-package "$settings" 2 "does not install services.identity.ledger," "$silent"

# A dot-directory is not first-party code (a virtualenv lives in one): a
# migrations package there is not an app the settings must install.
fresh walk-skips-dot-directories
package "$work/walk-skips-dot-directories/.cache/vendored/migrations"
expect walk-skips-dot-directories "$settings" 0 "$silent"

# Nor is anything under node_modules.
fresh walk-skips-node-modules
package "$work/walk-skips-node-modules/contracts/lint/node_modules/vendored/migrations"
expect walk-skips-node-modules "$settings" 0 "$silent"

# A third-party app with a concrete model and no migrations, installed from
# outside the tree, is not asked for a migration it cannot have.
fresh third-party-outside-tree
package "$work/outside-site/extapp"
concrete_models "$work/outside-site/extapp/models.py" External
installing third-party-outside-tree selftest_extapp extapp
PYTHONPATH="$work/outside-site" expect third-party-outside-tree config.settings.selftest_extapp 0 \
  "checking the first-party app labels: audit, billing, docs, engine_intents, extensions, idempotency, identity, jobs, legal, media, notifications, orgs, outbox, staff_api, support, tenancy, workspaces"

# The same app installed from a dot-directory inside the tree, where CI's
# virtualenv lives.
fresh third-party-in-dot-directory
package "$work/third-party-in-dot-directory/.venv-site/extapp"
concrete_models "$work/third-party-in-dot-directory/.venv-site/extapp/models.py" External
installing third-party-in-dot-directory selftest_extapp extapp
PYTHONPATH="$work/third-party-in-dot-directory/.venv-site" expect third-party-in-dot-directory \
  config.settings.selftest_extapp 0 "checking the first-party app labels: audit, billing, docs, engine_intents, extensions, idempotency, identity, jobs, legal, media, notifications, orgs, outbox, staff_api, support, tenancy, workspaces"

# A tree where the walk finds nothing must refuse, not pass having looked at nothing.
fresh nothing-to-look-at
for app in "$work/nothing-to-look-at"/apps/*/ "$work/nothing-to-look-at"/core/idempotency/ "$work/nothing-to-look-at"/core/staff_api/; do
  rm -rf "${app}migrations" "${app}apps.py"
done
expect nothing-to-look-at "$settings" 2 "found no package with migrations" "$silent"

# Workspace registration must participate in the unchanged completeness gate.
# Append these cases so existing clause-owner mutation cases keep their order.
fresh settings-drop-workspaces
printf '%s\n' 'from .job_queue import *' \
  'INSTALLED_APPS = [app for app in INSTALLED_APPS if app != "apps.workspaces"]' \
  > "$work/settings-drop-workspaces/config/settings/selftest_drop_workspaces.py"
expect settings-drop-workspaces config.settings.selftest_drop_workspaces 2 \
  "does not install apps.workspaces, so makemigrations --check cannot see" "$silent"

fresh workspaces-field-without-migration
replace "$work/workspaces-field-without-migration/apps/workspaces/models.py" \
  "structure_revision = models.BigIntegerField(default=1)" \
  "structure_revision = models.BigIntegerField(default=2)"
expect workspaces-field-without-migration "$settings" 1 "Migrations for 'workspaces':" "$silent"

# The replay store is a kernel application with a schema (docs/specs/IDEMPOTENCY_REPLAY.md
# §2.1): the walk finds it outside apps/, and a profile leaving it out is refused by name.
fresh settings-drop-idempotency
printf '%s\n' 'from .job_queue import *' \
  'INSTALLED_APPS = [app for app in INSTALLED_APPS if app != "core.idempotency"]' \
  > "$work/settings-drop-idempotency/config/settings/selftest_drop_idempotency.py"
expect settings-drop-idempotency config.settings.selftest_drop_idempotency 2 \
  "does not install core.idempotency, so makemigrations --check cannot see" "$silent"

fresh idempotency-field-without-migration
replace "$work/idempotency-field-without-migration/core/idempotency/models.py" \
  "MAX_PATH = 2048" "MAX_PATH = 4096"
expect idempotency-field-without-migration "$settings" 1 "Migrations for 'idempotency':" "$silent"

fresh unvalidated-constraint
drop_migration unvalidated-constraint billing 0010_validate_payment_constraint
expect unvalidated-constraint "$settings" 2 \
  "unvalidated constraint(s) in migrations: billing.billing_payment_state_valid" "$silent"

fresh append-only-check-without-not-valid
drop_migration append-only-check-without-not-valid billing 0010_validate_payment_constraint
replace "$work/append-only-check-without-not-valid/apps/billing/migrations/0005_stripe_collection.py" \
  "        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    \"ALTER TABLE billing_payment ADD CONSTRAINT billing_payment_state_valid CHECK \"
                    \"(state IN ('pending', 'processing', 'succeeded', 'failed', 'reversed')) NOT VALID;\\n\"
                    \"ALTER TABLE billing_providerevent ADD CONSTRAINT billing_providerevent_kind_valid CHECK \"
                    \"(kind IN ('payment.processing', 'payment.succeeded', 'payment.failed', \"
                    \"'payment.reversed', 'payment.reinstated')) NOT VALID;\",
                    reverse_sql=(
                        \"ALTER TABLE billing_providerevent DROP CONSTRAINT billing_providerevent_kind_valid;\\n\"
                        \"ALTER TABLE billing_payment DROP CONSTRAINT billing_payment_state_valid;\"
                    ),
                )
            ],
            state_operations=[" \
  ""
replace "$work/append-only-check-without-not-valid/apps/billing/migrations/0005_stripe_collection.py" \
  "            ],
        ),
        migrations.RunSQL(" \
  "        migrations.RunSQL("
expect append-only-check-without-not-valid "$settings" 2 \
  "unvalidated constraint(s) in migrations: billing.billing_payment_state_valid" "$silent"

if [ "$cases" -ne "$expected_cases" ]; then
  echo "self-test FAILED: $cases of $expected_cases cases ran" >&2
  exit 1
fi
echo "self-test passed: $cases cases, every baseline passed and every mutation was refused by its own message"
