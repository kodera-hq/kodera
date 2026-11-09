"""Reserve Path K synthetic realm names without reassigning existing organisation identities.

Stop on a collision before schema changes. ADD CHECK NOT VALID locks the table briefly and
checks new writes; 0016 validates old rows separately, including a holder racing the precheck.
The precheck, lock and statement all have finite budgets. Reverse drops only this new check.
"""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"
FORWARD = (
    TIMEOUTS + "\nALTER TABLE orgs_organisation ADD CONSTRAINT "
    "organisation_slug_not_synthetic CHECK (slug NOT LIKE 'synth-%') NOT VALID;\n"
)
REVERSE = (
    TIMEOUTS + "\nALTER TABLE orgs_organisation DROP CONSTRAINT organisation_slug_not_synthetic;\n"
)


def refuse_held_prefix(apps, schema_editor):
    schema_editor.execute(TIMEOUTS)
    # Read through this migration connection, with inspectable SQL and no schema
    # authority passed into an ORM callback. No default database alias is consulted.
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "SELECT slug FROM orgs_organisation WHERE slug LIKE %s ORDER BY slug",
            ["synth-%"],
        )
        held = [slug for (slug,) in cursor.fetchall()]
    if held:
        raise RuntimeError(
            "organisations hold newly reserved synthetic slugs: "
            + ", ".join(held)
            + "; resolve them first"
        )


class Migration(migrations.Migration):
    dependencies = [("orgs", "0014_validate_reserved_platform_slugs")]
    operations = [
        migrations.RunPython(refuse_held_prefix, migrations.RunPython.noop, elidable=False),
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.RunSQL(FORWARD, reverse_sql=REVERSE)],
            state_operations=[
                migrations.AddConstraint(
                    model_name="organisation",
                    constraint=models.CheckConstraint(
                        name="organisation_slug_not_synthetic",
                        condition=~models.Q(slug__startswith="synth-"),
                    ),
                ),
            ],
        ),
    ]
