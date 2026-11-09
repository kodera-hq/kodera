"""The member set's anomaly counts, the head's refusal, and the recorded subjects' contract shape
(ADR-0016). The shape check is added `NOT VALID` here and validated by 0003."""

from django.db import migrations, models


def no_subject_outside_the_contract(apps, schema_editor):
    """The check constraint below would refuse them anyway; this names the reason."""
    known = apps.get_model("engine_intents", "EngineKnownSubject")
    found = known.objects.exclude(subject__regex=r"^[\x21-\x7e]{1,255}$").count()
    if found:
        raise RuntimeError(
            f"{found} recorded subject(s) outside the contract's shape: quarantine them first"
        )


class Migration(migrations.Migration):

    dependencies = [
        ('engine_intents', '0001_initial'),
        ('identity', '0003_staff_identity'),
        ('orgs', '0010_owner_claims'),
    ]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.AddField(
            model_name='enginememberset',
            name='malformed_subjects',
            field=models.PositiveIntegerField(db_default=0, default=0),
        ),
        migrations.AddField(
            model_name='enginememberset',
            name='unnamed_leavers',
            field=models.PositiveIntegerField(db_default=0, default=0),
        ),
        migrations.AddField(
            model_name='enginemembersethead',
            name='refused_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='enginemembersethead',
            name='refused_problem',
            field=models.TextField(blank=True, db_default='', default=''),
        ),
        migrations.RunPython(no_subject_outside_the_contract, migrations.RunPython.noop),
        # Added NOT VALID, validated by 0003 (docs/dev/MIGRATIONS.md §4).
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    "ALTER TABLE engine_intents_known_subject ADD CONSTRAINT "
                    "engine_known_subject_valid CHECK (subject ~ '^[\\x21-\\x7e]{1,255}$') NOT VALID;",
                    reverse_sql="ALTER TABLE engine_intents_known_subject DROP CONSTRAINT "
                    "engine_known_subject_valid;",
                )
            ],
            state_operations=[
                migrations.AddConstraint(
                    model_name='engineknownsubject',
                    constraint=models.CheckConstraint(condition=models.Q(('subject__regex', '^[\\x21-\\x7e]{1,255}$')), name='engine_known_subject_valid'),
                ),
            ],
        ),
        # Last as well, so that the reverse also runs under finite timeouts.
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
