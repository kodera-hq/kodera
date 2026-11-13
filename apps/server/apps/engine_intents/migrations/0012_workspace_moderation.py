from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('engine_intents', '0011_member_set_authority_revision'),
    ]

    operations = [
        migrations.AddField(
            model_name='enginechannelset',
            name='moderation',
            field=models.JSONField(default=dict),
        ),
    ]
