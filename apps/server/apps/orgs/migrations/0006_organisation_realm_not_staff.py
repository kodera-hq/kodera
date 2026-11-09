from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"


class Migration(migrations.Migration):
    """No organisation's realm is the staff realm `kodera-staff` (docs/specs/STAFF_IDENTITY.md §1).

    With it, a customer identity can never be in the staff realm either: its realm is its
    organisation's (identity_organisation_binding_fk). A database holding an organisation whose
    slug is `kodera-staff` cannot apply this migration, and for the reasons orgs.0003 gives no data
    migration can make it applicable. Nothing is deployed, so no such database exists outside a
    developer's or a test's own.
    """

    dependencies = [
        ("orgs", "0005_authority_revision_guards"),
    ]

    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=migrations.RunSQL.noop),
        migrations.AddConstraint(
            model_name="organisation",
            constraint=models.CheckConstraint(
                condition=models.Q(("realm", "kodera-staff"), _negated=True),
                name="organisation_realm_not_staff",
            ),
        ),
        migrations.RunSQL(sql=migrations.RunSQL.noop, reverse_sql=TIMEOUTS),
    ]
