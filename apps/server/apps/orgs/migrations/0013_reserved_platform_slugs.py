"""Reserve the platform labels of kodera.io as organisation slugs (docs/specs/ESPACE_STRUCTURE.md §8).

`organisation_slug_not_reserved` gains `notify`, `staging`, `status`, `support`, `billing`,
`console`, `developers`, `matrix`, `auth-admin` and `auth-mail`. First the migration reads whether
an organisation already holds one of them, and stops, naming the slugs it found: a slug is the
organisation's realm and is never changed, so no data migration can make such a database
applicable, and an operator must decide. The check is then dropped and added again `NOT VALID`
with the longer list (docs/dev/MIGRATIONS.md §4), and 0014 validates it, which also refuses a
holder created between the read and the new check. Both under finite lock and statement timeouts.
"""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"
PREVIOUS = ("master", "kodera-staff", "kodera-probe", "kodera-dev", "kodera", "staff", "admin")
PLATFORM = (
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


def _check(slugs, *, valid):
    listed = ", ".join(f"'{slug}'" for slug in slugs)
    return (
        "ALTER TABLE orgs_organisation ADD CONSTRAINT organisation_slug_not_reserved CHECK "
        f"(NOT (slug IN ({listed})))" + ("" if valid else " NOT VALID") + ";\n"
    )


DROP = "ALTER TABLE orgs_organisation DROP CONSTRAINT organisation_slug_not_reserved;\n"
FORWARD = TIMEOUTS + "\n" + DROP + _check(PREVIOUS + PLATFORM, valid=False)
REVERSE = TIMEOUTS + "\n" + DROP + _check(PREVIOUS, valid=True)


def refuse_held_labels(apps, schema_editor):
    Organisation = apps.get_model("orgs", "Organisation")  # noqa: N806
    held = sorted(Organisation.objects.filter(slug__in=PLATFORM).values_list("slug", flat=True))
    if held:
        raise RuntimeError(
            "organisations hold newly reserved slugs: " + ", ".join(held) + "; resolve them first"
        )


class Migration(migrations.Migration):
    dependencies = [("orgs", "0012_validate_notice_contacts")]

    operations = [
        # Reading back changes nothing, so the reverse has nothing to undo.
        migrations.RunPython(refuse_held_labels, migrations.RunPython.noop, elidable=False),
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.RunSQL(FORWARD, reverse_sql=REVERSE)],
            state_operations=[
                migrations.RemoveConstraint(
                    model_name="organisation", name="organisation_slug_not_reserved"
                ),
                migrations.AddConstraint(
                    model_name="organisation",
                    constraint=models.CheckConstraint(
                        condition=models.Q(("slug__in", PREVIOUS + PLATFORM), _negated=True),
                        name="organisation_slug_not_reserved",
                    ),
                ),
            ],
        ),
    ]
