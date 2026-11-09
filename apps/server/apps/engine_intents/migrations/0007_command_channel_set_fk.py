"""The command's channel set gets its database foreign key, added `NOT VALID` and validated by
0008 (docs/dev/MIGRATIONS.md §4): a command naming a missing set would fail every pull of its
credential, so the database refuses one."""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"
ADD = (
    "ALTER TABLE engine_intents_command ADD CONSTRAINT engine_command_channel_set_fk "
    "FOREIGN KEY (channel_set_id) REFERENCES engine_intents_channel_set (id) "
    "DEFERRABLE INITIALLY DEFERRED NOT VALID;"
)
DROP = "ALTER TABLE engine_intents_command DROP CONSTRAINT engine_command_channel_set_fk;"


class Migration(migrations.Migration):
    dependencies = [
        ("engine_intents", "0006_member_set_erased"),
    ]

    operations = [
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.RunSQL(ADD, reverse_sql=DROP)],
            state_operations=[
                migrations.AlterField(
                    model_name="enginecommand",
                    name="channel_set",
                    field=models.ForeignKey(
                        db_index=False,
                        null=True,
                        on_delete=models.deletion.RESTRICT,
                        related_name="+",
                        to="engine_intents.enginechannelset",
                    ),
                ),
            ],
        ),
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
    ]
