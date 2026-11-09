from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"


class Migration(migrations.Migration):
    """Reserved realm names and the instruction reference's shape (docs/specs/ORGANISATION_INTAKE.md).

    `organisation_slug_not_reserved` refuses the closed list of orgs.models
    RESERVED_ORGANISATION_SLUGS, beside `organisation_realm_not_staff`: `master` would name the
    identity provider's administration realm, and the others are realms the provider already holds
    or names that would read as the platform's own. `intake_instruction_ref_valid` narrows from a
    length to a ticket reference, `^[A-Z]{2,8}-[0-9]{1,8}$`, so no contact can be recorded there.

    A database holding an organisation whose slug is reserved, or an intake whose reference has
    another shape, cannot apply this migration, and for the reasons orgs.0003 gives no data
    migration can make it applicable. Nothing is deployed, so no such database exists outside a
    developer's or a test's own. The finite lock and statement timeouts are set first in both
    directions.
    """

    dependencies = [
        ("orgs", "0007_organisation_intake"),
    ]

    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=migrations.RunSQL.noop),
        migrations.AddConstraint(
            model_name="organisation",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    (
                        "slug__in",
                        (
                            "master",
                            "kodera-staff",
                            "kodera-probe",
                            "kodera-dev",
                            "kodera",
                            "staff",
                            "admin",
                        ),
                    ),
                    _negated=True,
                ),
                name="organisation_slug_not_reserved",
            ),
        ),
        migrations.RemoveConstraint(
            model_name="organisationintake",
            name="intake_instruction_ref_valid",
        ),
        migrations.AddConstraint(
            model_name="organisationintake",
            constraint=models.CheckConstraint(
                condition=models.Q(("instruction_ref__regex", "^[A-Z]{2,8}-[0-9]{1,8}$")),
                name="intake_instruction_ref_valid",
            ),
        ),
        migrations.RunSQL(sql=migrations.RunSQL.noop, reverse_sql=TIMEOUTS),
    ]
