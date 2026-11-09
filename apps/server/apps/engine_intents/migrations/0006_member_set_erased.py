"""The member set's erased subjects and the recorded subjects' explicit erasure mark (ADR-0018):
nullable columns, added without a rewrite."""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"


class Migration(migrations.Migration):

    dependencies = [
        ('engine_intents', '0005_validate_command_one_set'),
    ]

    operations = [
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.AddField(
            model_name='enginememberset',
            name='erased_subjects',
            field=models.JSONField(null=True),
        ),
        migrations.AddField(
            model_name='engineknownsubject',
            name='erased_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
    ]
