"""Bind issuing Stripe platform account and livemode on paid MarketplaceEntitlement rows."""

from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):
    dependencies = [
        ("extensions", "0014_marketplace_and_widget_actions"),
    ]

    operations = [
        migrations.AddField(
            model_name="marketplaceentitlement",
            name="stripe_account_id",
            field=models.TextField(null=True),
        ),
        migrations.AddField(
            model_name="marketplaceentitlement",
            name="stripe_livemode",
            field=models.BooleanField(null=True),
        ),
        migrations.AddConstraint(
            model_name="marketplaceentitlement",
            constraint=models.CheckConstraint(
                condition=Q(stripe_account_id__isnull=True)
                | Q(stripe_account_id__regex=r"^acct_[A-Za-z0-9_]+$"),
                name="extension_marketplace_stripe_acct_valid",
            ),
        ),
    ]
