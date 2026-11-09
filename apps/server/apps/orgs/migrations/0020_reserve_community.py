"""Reserve the first-party Community host; refuse existing collisions before changing guards."""

from django.db import migrations, models

RESERVED = (
    "community",
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
    "errors",
    "ops-admin",
)


def refuse_held_community(apps, schema_editor):
    with schema_editor.connection.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout = '5s'")
        cursor.execute("SELECT 1 FROM orgs_organisation WHERE slug = %s LIMIT 1", ["community"])
        if cursor.fetchone():
            raise RuntimeError(
                "Resolve the existing community slug before reserving the platform host"
            )


class Migration(migrations.Migration):
    dependencies = [("orgs", "0019_validate_reserved_platform_hosts")]
    operations = [
        migrations.RunPython(refuse_held_community, migrations.RunPython.noop),
        migrations.RemoveConstraint(
            model_name="organisation", name="organisation_slug_not_reserved"
        ),
        migrations.AddConstraint(
            model_name="organisation",
            constraint=models.CheckConstraint(
                name="organisation_slug_not_reserved", condition=~models.Q(slug__in=RESERVED)
            ),
        ),
    ]
