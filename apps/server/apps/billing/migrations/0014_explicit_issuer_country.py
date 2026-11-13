from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0013_billing_documents_vies'),
    ]

    operations = [
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
    ]
