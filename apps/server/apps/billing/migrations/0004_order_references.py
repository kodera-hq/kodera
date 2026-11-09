"""An order's DPA and tenant, and a subscription's tenant, become foreign keys.

The columns keep their names (`dpa_id`, `tenant_id`) and their values: the database only gains a
constraint and an index on each, which the order's other applications now provide the tables for.
The constraint is added `NOT VALID` and then validated (docs/dev/MIGRATIONS.md §4).
"""

import django.db.models.deletion
from django.db import migrations, models

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE billing_order ADD CONSTRAINT billing_order_dpa_fk
  FOREIGN KEY (dpa_id) REFERENCES legal_dpa (id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE billing_order ADD CONSTRAINT billing_order_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenancy_tenant (id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE billing_subscription ADD CONSTRAINT billing_subscription_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenancy_tenant (id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE billing_order VALIDATE CONSTRAINT billing_order_dpa_fk;
ALTER TABLE billing_order VALIDATE CONSTRAINT billing_order_tenant_fk;
ALTER TABLE billing_subscription VALIDATE CONSTRAINT billing_subscription_tenant_fk;
CREATE INDEX billing_order_dpa_id_idx ON billing_order (dpa_id);
CREATE INDEX billing_order_tenant_id_idx ON billing_order (tenant_id);
CREATE INDEX billing_subscription_tenant_id_idx ON billing_subscription (tenant_id);
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP INDEX billing_subscription_tenant_id_idx;
DROP INDEX billing_order_tenant_id_idx;
DROP INDEX billing_order_dpa_id_idx;
ALTER TABLE billing_subscription DROP CONSTRAINT billing_subscription_tenant_fk;
ALTER TABLE billing_order DROP CONSTRAINT billing_order_tenant_fk;
ALTER TABLE billing_order DROP CONSTRAINT billing_order_dpa_fk;
"""


def foreign_key(to: str) -> models.ForeignKey:  # type: ignore[type-arg]
    return models.ForeignKey(
        blank=True,
        null=True,
        on_delete=django.db.models.deletion.RESTRICT,
        related_name="+",
        to=to,
    )


class Migration(migrations.Migration):
    dependencies = [
        ("billing", "0003_payments"),
        ("legal", "0001_initial"),
        ("tenancy", "0001_initial"),
    ]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.RunSQL(FORWARD, reverse_sql=REVERSE)],
            state_operations=[
                migrations.RemoveField(model_name="order", name="dpa_id"),
                migrations.RemoveField(model_name="order", name="tenant_id"),
                migrations.RemoveField(model_name="subscription", name="tenant_id"),
                migrations.AddField(model_name="order", name="dpa", field=foreign_key("legal.dpa")),
                migrations.AddField(
                    model_name="order", name="tenant", field=foreign_key("tenancy.tenant")
                ),
                migrations.AddField(
                    model_name="subscription", name="tenant", field=foreign_key("tenancy.tenant")
                ),
            ],
        )
    ]
