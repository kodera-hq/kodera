"""Idempotent Stripe webhook delivery ledger with bounded migration DDL timeouts."""

from django.db import migrations, models

from core.db.functions import ClockTimestamp
from core.db.ids import new_uuid7


class Migration(migrations.Migration):
    dependencies = [("billing", "0022_privacy_cutoff_guard")]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.CreateModel(
            name="StripeWebhookDelivery",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=new_uuid7, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("stripe_event_id", models.TextField(unique=True)),
                ("event_type", models.TextField()),
                ("livemode", models.BooleanField(default=False)),
                ("occurred_at", models.DateTimeField()),
                ("received_at", models.DateTimeField(db_default=ClockTimestamp())),
                ("outcome", models.TextField(default="received")),
                ("organisation_id", models.UUIDField(blank=True, null=True)),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["event_type", "-occurred_at"],
                        name="billing_stripewebhook_type_idx",
                    ),
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=~models.Q(stripe_event_id=""),
                        name="billing_stripewebhook_event_id_valid",
                    ),
                    models.CheckConstraint(
                        condition=~models.Q(event_type=""),
                        name="billing_stripewebhook_type_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            outcome__in=(
                                "received",
                                "applied",
                                "ignored",
                                "unmatched",
                                "stale",
                                "deferred",
                                "mismatch",
                            )
                        ),
                        name="billing_stripewebhook_outcome_valid",
                    ),
                ],
            },
        ),
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
