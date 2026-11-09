"""A message whose template carries no link (an order confirmation) stores none: `link` may be null.

The check keeps its rule for a link that is there; the table holds only messages with one so far.
"""

from django.db import migrations, models

# First and last: operations reverse in the opposite order, so the reverse sets the timeouts
# before its first statement as the forward does.
TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"


class Migration(migrations.Migration):

    dependencies = [
        ('outbox', '0003_messages'),
    ]

    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.RemoveConstraint(
            model_name='outboxmessage',
            name='outbox_message_link_valid',
        ),
        migrations.AlterField(
            model_name='outboxmessage',
            name='link',
            field=models.TextField(null=True),
        ),
        migrations.AddConstraint(
            model_name='outboxmessage',
            constraint=models.CheckConstraint(condition=models.Q(('link__isnull', True), models.Q(('link__length__range', (1, 2048)), models.Q(('link__contains', '#'), _negated=True)), _connector='OR'), name='outbox_message_link_valid'),
        ),
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=TIMEOUTS),
    ]
