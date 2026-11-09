"""Reserve the first-party Community host; refuse existing collisions before changing guards."""

from django.db import migrations, models

RESERVED = (
    "community",
    "www",
    "api",
    "app",
    "auth",
    "identity",
    "mail",
    "status",
    "staff",
    "admin",
    "kodera",
    "kodera-staff",
    "notify",
    "staging",
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
        cursor.execute("SELECT 1 FROM tenancy_tenant WHERE slug = %s LIMIT 1", ["community"])
        if cursor.fetchone():
            raise RuntimeError(
                "Resolve the existing community slug before reserving the platform host"
            )


class Migration(migrations.Migration):
    dependencies = [("tenancy", "0004_validate_reserved_platform_labels")]
    operations = [
        migrations.RunPython(refuse_held_community, migrations.RunPython.noop),
        migrations.RemoveConstraint(model_name="tenant", name="tenancy_tenant_slug_not_reserved"),
        migrations.AddConstraint(
            model_name="tenant",
            constraint=models.CheckConstraint(
                name="tenancy_tenant_slug_not_reserved",
                condition=~models.Q(slug__in=RESERVED) & ~models.Q(slug__startswith="xn--"),
            ),
        ),
    ]
