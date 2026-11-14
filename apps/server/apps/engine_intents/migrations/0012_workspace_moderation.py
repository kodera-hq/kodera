from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('engine_intents', '0011_member_set_authority_revision'),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddField(
            model_name='enginechannelset',
            name='moderation',
            field=models.JSONField(default=dict),
        ),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
