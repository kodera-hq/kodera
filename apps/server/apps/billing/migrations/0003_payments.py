"""Payment links, payments and the ledger of provider events, on empty tables."""

import core.db.functions
import core.db.ids
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0002_invoice_guards'),
        ('orgs', '0003_organisation_slug_minimum_five'),
    ]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.CreateModel(
            name='PaymentLink',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('provider', models.TextField()),
                ('provider_ref', models.TextField()),
                ('url', models.TextField()),
                ('state', models.TextField(default='active')),
                ('amount_minor', models.BigIntegerField()),
                ('currency', models.TextField()),
                ('expires_at', models.DateTimeField()),
                ('used_at', models.DateTimeField(blank=True, null=True)),
                ('invoice', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='payment_links', to='billing.invoice')),
                ('organisation', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.organisation')),
            ],
        ),
        migrations.CreateModel(
            name='Payment',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('provider', models.TextField()),
                ('provider_ref', models.TextField()),
                ('state', models.TextField(default='pending')),
                ('amount_minor', models.BigIntegerField()),
                ('currency', models.TextField()),
                ('last_event_at', models.DateTimeField(blank=True, null=True)),
                ('allocated', models.BooleanField(default=False)),
                ('invoice', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='payments', to='billing.invoice')),
                ('organisation', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.organisation')),
                ('payment_link', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, related_name='payments', to='billing.paymentlink')),
            ],
        ),
        migrations.CreateModel(
            name='ProviderEvent',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('provider', models.TextField()),
                ('event_id', models.TextField()),
                ('kind', models.TextField()),
                ('payment_ref', models.TextField()),
                ('link_ref', models.TextField(blank=True, null=True)),
                ('amount_minor', models.BigIntegerField()),
                ('currency', models.TextField()),
                ('occurred_at', models.DateTimeField()),
                ('received_at', models.DateTimeField(db_default=core.db.functions.ClockTimestamp())),
                ('outcome', models.TextField(default='received')),
            ],
            options={
                'indexes': [models.Index(fields=['provider', 'payment_ref', 'occurred_at'], name='billing_providerevent_pay_idx')],
                'constraints': [models.UniqueConstraint(fields=('provider', 'event_id'), name='billing_providerevent_unique'), models.CheckConstraint(condition=models.Q(('kind__in', ('payment.succeeded', 'payment.failed', 'payment.reversed'))), name='billing_providerevent_kind_valid'), models.CheckConstraint(condition=models.Q(('outcome__in', ('received', 'applied', 'stale', 'deferred', 'unmatched', 'mismatch', 'ignored'))), name='billing_providerevent_outcome_valid')],
            },
        ),
        migrations.AddConstraint(
            model_name='paymentlink',
            constraint=models.UniqueConstraint(fields=('provider', 'provider_ref'), name='billing_paymentlink_ref_unique'),
        ),
        migrations.AddConstraint(
            model_name='paymentlink',
            constraint=models.UniqueConstraint(condition=models.Q(('state', 'active')), fields=('invoice',), name='billing_paymentlink_one_active'),
        ),
        migrations.AddConstraint(
            model_name='paymentlink',
            constraint=models.CheckConstraint(condition=models.Q(('state__in', ('active', 'used', 'expired', 'cancelled'))), name='billing_paymentlink_state_valid'),
        ),
        migrations.AddConstraint(
            model_name='paymentlink',
            constraint=models.CheckConstraint(condition=models.Q(('amount_minor__gt', 0)), name='billing_paymentlink_amount_valid'),
        ),
        migrations.AddConstraint(
            model_name='payment',
            constraint=models.UniqueConstraint(fields=('provider', 'provider_ref'), name='billing_payment_ref_unique'),
        ),
        migrations.AddConstraint(
            model_name='payment',
            constraint=models.CheckConstraint(condition=models.Q(('state__in', ('pending', 'succeeded', 'failed', 'reversed'))), name='billing_payment_state_valid'),
        ),
        migrations.AddConstraint(
            model_name='payment',
            constraint=models.CheckConstraint(condition=models.Q(('amount_minor__gt', 0)), name='billing_payment_amount_valid'),
        ),
    ]
