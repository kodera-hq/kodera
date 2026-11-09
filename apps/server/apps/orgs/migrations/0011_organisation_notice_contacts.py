"""The DPA's three notice addresses on the organisation (docs/specs/ORGANISATION_NOTICE_CONTACTS.md).

Three nullable columns: adding them rewrites nothing. Each check is added `NOT VALID` here and
validated by the next migration (docs/dev/MIGRATIONS.md §4), both under finite lock and statement
timeouts.
"""

from django.db import migrations, models

FIELDS = ("security_contact_email", "privacy_contact_email", "subprocessor_notice_email")


def _check(field: str) -> models.CheckConstraint:
    return models.CheckConstraint(
        name=f"organisation_{field}_valid",
        condition=models.Q(**{f"{field}__isnull": True})
        | (
            models.Q(**{f"{field}__length__range": (3, 254)})
            & models.Q(**{f"{field}__contains": "@"})
        ),
    )


FORWARD = (
    "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
    + "".join(f"ALTER TABLE orgs_organisation ADD COLUMN {field} text NULL;\n" for field in FIELDS)
    + "".join(
        f"ALTER TABLE orgs_organisation ADD CONSTRAINT organisation_{field}_valid CHECK "
        f"({field} IS NULL OR (char_length({field}) BETWEEN 3 AND 254 AND {field} LIKE '%@%')) "
        "NOT VALID;\n"
        for field in FIELDS
    )
)

REVERSE = (
    "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
    + "".join(
        f"ALTER TABLE orgs_organisation DROP CONSTRAINT organisation_{field}_valid;\n"
        for field in reversed(FIELDS)
    )
    + "".join(f"ALTER TABLE orgs_organisation DROP COLUMN {field};\n" for field in reversed(FIELDS))
)


class Migration(migrations.Migration):
    dependencies = [("orgs", "0010_owner_claims")]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.RunSQL(FORWARD, reverse_sql=REVERSE)],
            state_operations=[
                *(
                    migrations.AddField(
                        model_name="organisation",
                        name=field,
                        field=models.TextField(blank=True, null=True),
                    )
                    for field in FIELDS
                ),
                *(
                    migrations.AddConstraint(model_name="organisation", constraint=_check(field))
                    for field in FIELDS
                ),
            ],
        )
    ]
