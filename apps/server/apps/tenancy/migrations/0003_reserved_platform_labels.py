"""Reserve the platform labels of kodera.io as tenant slugs (ADR-0023, contract 0.38.0).

A tenant's slug names its Matrix homeserver, `{slug}.{matrix domain}`, so the labels organisation
slugs already reserve (`orgs.0013`) are reserved for tenants too: `notify`, `staging`, `support`,
`billing`, `console`, `developers`, `matrix`, `auth-admin` and `auth-mail` (`status` was reserved
already), and `errors` and `ops-admin`, platform-prod hosts of kodera.io (deployment profiles
policy/kad-platform-ingress.yaml) that organisation slugs do not reserve yet. First the migration reads whether a tenant already holds one of them, and stops, naming
the slugs it found: a tenant's slug never changes and a tenant row is never deleted (`0002`), so no
data migration can make such a database applicable, and an operator must decide. The check is
then dropped and added again `NOT VALID` with the longer list (docs/dev/MIGRATIONS.md §4), and
0004 validates it, which also refuses a holder created between the read and the new check. Both
under finite lock and statement timeouts.
"""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"
PREVIOUS = (
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
)
PLATFORM = (
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


def _check(slugs, *, valid):
    listed = ", ".join(f"'{slug}'" for slug in slugs)
    return (
        "ALTER TABLE tenancy_tenant ADD CONSTRAINT tenancy_tenant_slug_not_reserved CHECK "
        f"(NOT (slug IN ({listed})) AND NOT (slug LIKE 'xn--%'))"
        + ("" if valid else " NOT VALID")
        + ";\n"
    )


DROP = "ALTER TABLE tenancy_tenant DROP CONSTRAINT tenancy_tenant_slug_not_reserved;\n"
FORWARD = TIMEOUTS + "\n" + DROP + _check(PREVIOUS + PLATFORM, valid=False)
REVERSE = TIMEOUTS + "\n" + DROP + _check(PREVIOUS, valid=True)


def refuse_held_labels(apps, schema_editor):
    Tenant = apps.get_model("tenancy", "Tenant")  # noqa: N806
    held = sorted(Tenant.objects.filter(slug__in=PLATFORM).values_list("slug", flat=True))
    if held:
        raise RuntimeError(
            "tenants hold newly reserved slugs: " + ", ".join(held) + "; resolve them first"
        )


class Migration(migrations.Migration):
    dependencies = [("tenancy", "0002_guards")]

    operations = [
        # Reading back changes nothing, so the reverse has nothing to undo.
        migrations.RunPython(refuse_held_labels, migrations.RunPython.noop, elidable=False),
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.RunSQL(FORWARD, reverse_sql=REVERSE)],
            state_operations=[
                migrations.RemoveConstraint(
                    model_name="tenant", name="tenancy_tenant_slug_not_reserved"
                ),
                migrations.AddConstraint(
                    model_name="tenant",
                    constraint=models.CheckConstraint(
                        condition=models.Q(
                            models.Q(("slug__in", PREVIOUS + PLATFORM), _negated=True),
                            models.Q(("slug__startswith", "xn--"), _negated=True),
                        ),
                        name="tenancy_tenant_slug_not_reserved",
                    ),
                ),
            ],
        ),
    ]
