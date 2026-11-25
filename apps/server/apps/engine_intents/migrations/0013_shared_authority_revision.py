from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("engine_intents", "0012_workspace_moderation"),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddField(
            model_name="enginememberset",
            name="shared_authority_revision",
            field=models.BigIntegerField(null=True),
        ),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
