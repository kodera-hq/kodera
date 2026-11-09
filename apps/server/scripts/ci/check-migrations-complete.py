#!/usr/bin/env python3
"""Run `makemigrations --check` only under settings that can see every app.

`makemigrations --check` reports on the apps the settings module installs and
says nothing about the others. The job that ran it used the default settings,
which install neither `apps.identity` nor `apps.orgs`, so a model change there
without its migration printed "No changes detected" and exited 0: the gate
named "Migrations are complete" could not fail for either of the two apps that
have migrations.

So the check refuses to run at all when the settings module leaves out a
package the tree says is a Django app with a schema:

- any first-party package with a `migrations/` package, or
- any package with an `apps.py` and a `models` module.

The tree is walked on disk, not read from `git ls-files`: an app that has not
been staged yet is still an app the settings must install.

Then it passes every installed first-party app's label to `makemigrations`
explicitly. Without labels, `makemigrations` skips an app that has no
`migrations/` package yet, so an installed app's first model would pass as "No
changes detected" — the one case this gate exists for. First-party means the
app's code lives inside the repository and outside a pruned directory, so a
third-party app, including one in a virtualenv under the checkout, is never
asked for a migration it cannot have.

Exit status: 0 when every such app is installed and no migration is missing;
1 from `makemigrations --check` when a migration is missing; 2 when the check
refused to run because it could not see every app.
"""

import argparse
import os
import re
import sys
from collections.abc import Iterable
from pathlib import Path

REFUSED = 2
PRUNED = {"node_modules", "__pycache__"}
ADD_NOT_VALID = re.compile(
    r"\bADD\s+CONSTRAINT\s+(\w+)\b[^;]*?\bNOT\s+VALID\b", re.IGNORECASE | re.DOTALL
)
VALIDATE_CONSTRAINT = re.compile(r"\bVALIDATE\s+CONSTRAINT\s+(\w+)\b", re.IGNORECASE)
APPEND_ONLY_MODELS = {
    "auditevent",
    "creditnote",
    "deletioncertificate",
    "invoice",
    "invoiceline",
    "job",
    "jobstep",
    "payment",
    "providerevent",
}


def pruned(parts: Iterable[str]) -> bool:
    """A path component that is a dot-directory or a vendored/cache directory."""
    return any(part.startswith(".") or part in PRUNED for part in parts)


def schema_packages(root: Path) -> list[str]:
    """Dotted names of every package under root that carries a schema."""
    found = []
    for directory, subdirectories, files in os.walk(root):
        subdirectories[:] = sorted(d for d in subdirectories if not pruned([d]))
        here = Path(directory)
        if here == root:
            continue
        has_migrations = (here / "migrations" / "__init__.py").is_file()
        has_models = "models.py" in files or (here / "models" / "__init__.py").is_file()
        if has_migrations or (has_models and "apps.py" in files):
            found.append(".".join(here.relative_to(root).parts))
    return sorted(found)


def first_party_labels(root: Path, configs: Iterable) -> list[str]:
    """Labels of the installed apps whose code lives in this repository."""
    labels = []
    for config in configs:
        try:
            parts = Path(config.path).resolve().relative_to(root).parts
        except ValueError:
            continue
        if not pruned(parts):
            labels.append(config.label)
    return sorted(labels)


def _iter_sql(operations: Iterable) -> Iterable[str]:
    from django.db import migrations

    for op in operations:
        if isinstance(op, migrations.SeparateDatabaseAndState):
            yield from _iter_sql(op.database_operations)
        elif isinstance(op, migrations.RunSQL):
            sql = op.sql
            if isinstance(sql, (list, tuple)):
                for item in sql:
                    yield item[0] if isinstance(item, (list, tuple)) else str(item)
            else:
                yield str(sql)


def unvalidated_constraints(labels: list[str]) -> list[str]:
    from django.db import migrations, models
    from django.db.migrations.loader import MigrationLoader

    loader = MigrationLoader(None, ignore_no_migrations=True)
    added: set[str] = set()
    validated: set[str] = set()
    direct: set[str] = set()
    for (app_label, _name), migration in sorted(loader.disk_migrations.items()):
        if app_label not in labels:
            continue
        created = {
            op.name.lower() for op in migration.operations if isinstance(op, migrations.CreateModel)
        }
        for op in migration.operations:
            if (
                isinstance(op, migrations.AddConstraint)
                and isinstance(op.constraint, models.CheckConstraint)
                and op.model_name.lower() in APPEND_ONLY_MODELS - created
            ):
                direct.add(f"{app_label}.{op.constraint.name}")
        for statement in _iter_sql(migration.operations):
            for match in ADD_NOT_VALID.finditer(statement):
                added.add(f"{app_label}.{match.group(1)}")
            for match in VALIDATE_CONSTRAINT.finditer(statement):
                validated.add(f"{app_label}.{match.group(1)}")
    return sorted((added - validated) | direct)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--settings", required=True, help="Django settings module to check under")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="repository root (default: the repository holding this script)",
    )
    arguments = parser.parse_args()
    root = arguments.root.resolve()

    required = schema_packages(root)
    if not required:
        print(
            f"refused: found no package with migrations under {root}; "
            "a check that looked at nothing would pass",
            file=sys.stderr,
        )
        return REFUSED

    os.chdir(root)
    sys.path.insert(0, str(root))
    os.environ["DJANGO_SETTINGS_MODULE"] = arguments.settings

    import django
    from django.apps import apps
    from django.core.management import execute_from_command_line

    django.setup()
    configs = apps.get_app_configs()
    installed = {config.name for config in configs}
    missing = [name for name in required if name not in installed]
    if missing:
        print(
            f"refused: {arguments.settings} does not install {', '.join(missing)}, "
            "so makemigrations --check cannot see a model change there; "
            "use settings that install every app with a schema",
            file=sys.stderr,
        )
        return REFUSED

    labels = first_party_labels(root, configs)
    unvalidated = unvalidated_constraints(labels)
    if unvalidated:
        print(
            f"refused: unvalidated constraint(s) in migrations: {', '.join(unvalidated)}",
            file=sys.stderr,
        )
        return REFUSED
    print(f"{arguments.settings} installs every app with a schema: {', '.join(required)}")
    print(f"checking the first-party app labels: {', '.join(labels)}")
    execute_from_command_line(["manage.py", "makemigrations", "--check", "--dry-run", *labels])
    return 0


if __name__ == "__main__":
    sys.exit(main())
