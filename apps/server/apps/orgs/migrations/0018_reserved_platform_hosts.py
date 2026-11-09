"""Reserve `errors` and `ops-admin` as organisation slugs (contract 0.39.0).

Both are platform-prod hosts of kodera.io (deployment profiles policy/kad-platform-ingress.yaml) that fit
the slug pattern, and 0013's list missed them. `organisation_slug_not_reserved` gains them. First
the migration reads whether an organisation already holds one, and stops, naming the slugs it
found: a slug is the organisation's realm and is never changed, so no data migration can make such
a database applicable, and an operator must decide. The check is then dropped and added again
`NOT VALID` with the longer list (docs/dev/MIGRATIONS.md §4), and 0019 validates it, which also
refuses a holder created between the read and the new check. Every step runs under finite lock
and statement timeouts.
"""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"
# The list as 0013 left it.
PREVIOUS = (
    "master",
    "kodera-staff",
    "kodera-probe",
    "kodera-dev",
    "kodera",
    "staff",
    "admin",
    "notify",
    "staging",
    "status",
    "support",
    "billing",
    "console",
    "developers",
    "matrix",
    "auth-admin",
    "auth-mail",
)
HOSTS = ("errors", "ops-admin")


def _check(slugs, *, valid):
    listed = ", ".join(f"'{slug}'" for slug in slugs)
    return (
        "ALTER TABLE orgs_organisation ADD CONSTRAINT organisation_slug_not_reserved CHECK "
        f"(NOT (slug IN ({listed})))" + ("" if valid else " NOT VALID") + ";\n"
    )


DROP = "ALTER TABLE orgs_organisation DROP CONSTRAINT organisation_slug_not_reserved;\n"
FORWARD = TIMEOUTS + "\n" + DROP + _check(PREVIOUS + HOSTS, valid=False)
REVERSE = TIMEOUTS + "\n" + DROP + _check(PREVIOUS, valid=True)


def refuse_held_hosts(apps, schema_editor):
    schema_editor.execute(TIMEOUTS)
    # Read through this migration's connection, as 0015 does.
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "SELECT slug FROM orgs_organisation WHERE slug = ANY(%s) ORDER BY slug", [list(HOSTS)]
        )
        held = [slug for (slug,) in cursor.fetchall()]
    if held:
        raise RuntimeError(
            "organisations hold newly reserved slugs: " + ", ".join(held) + "; resolve them first"
        )


class Migration(migrations.Migration):
    dependencies = [("orgs", "0017_invitations")]

    operations = [
        # Reading back changes nothing, so the reverse has nothing to undo.
        migrations.RunPython(refuse_held_hosts, migrations.RunPython.noop, elidable=False),
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.RunSQL(FORWARD, reverse_sql=REVERSE)],
            state_operations=[
                migrations.RemoveConstraint(
                    model_name="organisation", name="organisation_slug_not_reserved"
                ),
                migrations.AddConstraint(
                    model_name="organisation",
                    constraint=models.CheckConstraint(
                        condition=models.Q(("slug__in", PREVIOUS + HOSTS), _negated=True),
                        name="organisation_slug_not_reserved",
                    ),
                ),
            ],
        ),
    ]
