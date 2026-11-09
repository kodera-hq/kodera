"""Identity subjects are printable ASCII, the Agent API contract's subject shape (ADR-0016).

`identity_subject_valid` narrows from `\x01-\x7f` to `\x21-\x7e`. The migration first refuses to
apply while any stored subject is outside the new shape. The new check is added `NOT VALID` here
and validated by the next migration (docs/dev/MIGRATIONS.md §4), both under finite lock and
statement timeouts.
"""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
NEW = r"^[\x21-\x7e]{1,255}$"
OLD = r"^[\x01-\x7f]{1,255}$"

FORWARD = (
    TIMEOUTS
    + "ALTER TABLE identity_identity DROP CONSTRAINT identity_subject_valid;\n"
    + f"ALTER TABLE identity_identity ADD CONSTRAINT identity_subject_valid CHECK (subject ~ '{NEW}') "
    "NOT VALID;\n"
)
# Back to the wider rule, validated as it was: every printable subject satisfies it.
REVERSE = (
    TIMEOUTS
    + "ALTER TABLE identity_identity DROP CONSTRAINT identity_subject_valid;\n"
    + f"ALTER TABLE identity_identity ADD CONSTRAINT identity_subject_valid CHECK (subject ~ '{OLD}') "
    "NOT VALID;\n"
    + "ALTER TABLE identity_identity VALIDATE CONSTRAINT identity_subject_valid;\n"
)


def every_subject_is_printable_ascii(apps, schema_editor):
    """Refuse to apply while any stored subject is outside the narrower shape, naming why."""
    identity = apps.get_model("identity", "Identity")
    found = identity.objects.exclude(subject__regex=NEW).count()
    if found:
        raise RuntimeError(
            f"{found} identity subject(s) outside printable ASCII: resolve them before this migration"
        )


class Migration(migrations.Migration):
    dependencies = [
        ("identity", "0003_staff_identity"),
        ("orgs", "0012_validate_notice_contacts"),
    ]

    operations = [
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.RunPython(every_subject_is_printable_ascii, migrations.RunPython.noop),
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.RunSQL(FORWARD, reverse_sql=REVERSE)],
            state_operations=[
                migrations.RemoveConstraint(model_name="identity", name="identity_subject_valid"),
                migrations.AddConstraint(
                    model_name="identity",
                    constraint=models.CheckConstraint(
                        condition=models.Q(subject__regex=NEW), name="identity_subject_valid"
                    ),
                ),
            ],
        ),
    ]
