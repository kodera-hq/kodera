"""An acceptance recorded without an order: on a deployment that does not bill, the owner accepts
the CGV and the DPA for the one tenant the workspace is created with (docs/specs/QUICK_WORKSPACE.md
§3). Exactly one of `order_id` and `tenant_id` is set, and a document version is accepted once per
tenant. Every row written before has an order, so the check holds for it; the columns are only made
nullable or added empty, and the append-only guard of 0002 fires on no row.

Irreversible once a row without an order exists (createTenant writes them): `order_id` cannot be
made required again, and the append-only guard refuses to delete that row.
"""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"


class Migration(migrations.Migration):

    dependencies = [
        ("legal", "0003_document_text"),
    ]

    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.AlterField(
            model_name="acceptance",
            name="order_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="acceptance",
            name="tenant_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddConstraint(
            model_name="acceptance",
            constraint=models.UniqueConstraint(
                fields=("tenant_id", "document"), name="legal_acceptance_once_per_tenant"
            ),
        ),
        migrations.AddConstraint(
            model_name="acceptance",
            constraint=models.CheckConstraint(
                condition=models.Q(("order_id__isnull", False), ("tenant_id__isnull", True))
                | models.Q(("order_id__isnull", True), ("tenant_id__isnull", False)),
                name="legal_acceptance_order_or_tenant",
            ),
        ),
    ]
