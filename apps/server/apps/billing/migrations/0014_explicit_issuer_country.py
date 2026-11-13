from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0013_billing_documents_vies'),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddField(
            model_name='creditnote',
            name='issuer_country',
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='invoice',
            name='issuer_country',
            field=models.TextField(blank=True, null=True),
        ),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
