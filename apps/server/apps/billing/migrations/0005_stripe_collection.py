"""A payment in flight (SEPA debit submitted), a reinstated chargeback, the provider's customer.

The two checks widen to the new state and event kinds; each is added `NOT VALID` here and
validated by 0010 (docs/dev/MIGRATIONS.md §4).
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0004_order_references'),
    ]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.RemoveConstraint(
            model_name='payment',
            name='billing_payment_state_valid',
        ),
        migrations.RemoveConstraint(
            model_name='providerevent',
            name='billing_providerevent_kind_valid',
        ),
        migrations.AddField(
            model_name='payment',
            name='provider_customer_ref',
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='providerevent',
            name='customer_ref',
            field=models.TextField(blank=True, null=True),
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    "ALTER TABLE billing_payment ADD CONSTRAINT billing_payment_state_valid CHECK "
                    "(state IN ('pending', 'processing', 'succeeded', 'failed', 'reversed')) NOT VALID;\n"
                    "ALTER TABLE billing_providerevent ADD CONSTRAINT billing_providerevent_kind_valid CHECK "
                    "(kind IN ('payment.processing', 'payment.succeeded', 'payment.failed', "
                    "'payment.reversed', 'payment.reinstated')) NOT VALID;",
                    reverse_sql=(
                        "ALTER TABLE billing_providerevent DROP CONSTRAINT billing_providerevent_kind_valid;\n"
                        "ALTER TABLE billing_payment DROP CONSTRAINT billing_payment_state_valid;"
                    ),
                )
            ],
            state_operations=[
                migrations.AddConstraint(
                    model_name='payment',
                    constraint=models.CheckConstraint(condition=models.Q(('state__in', ('pending', 'processing', 'succeeded', 'failed', 'reversed'))), name='billing_payment_state_valid'),
                ),
                migrations.AddConstraint(
                    model_name='providerevent',
                    constraint=models.CheckConstraint(condition=models.Q(('kind__in', ('payment.processing', 'payment.succeeded', 'payment.failed', 'payment.reversed', 'payment.reinstated'))), name='billing_providerevent_kind_valid'),
                ),
            ],
        ),
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
