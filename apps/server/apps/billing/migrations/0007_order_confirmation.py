"""An order records the outbox delivery of its confirmation (CGV 5.3), and of the notice that a
confirmed order was cancelled, so each is enqueued once."""

from django.db import migrations, models

# First and last: operations reverse in the opposite order, so the reverse is bounded too.
TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0006_one_order_in_flight'),
    ]

    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.AddField(
            model_name='order',
            name='confirmation_delivery_id',
            field=models.UUIDField(blank=True, null=True, unique=True),
        ),
        migrations.AddField(
            model_name='order',
            name='cancellation_notice_delivery_id',
            field=models.UUIDField(blank=True, null=True, unique=True),
        ),
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=TIMEOUTS),
    ]
