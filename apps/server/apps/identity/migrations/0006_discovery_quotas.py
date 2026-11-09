"""Bounded pseudonymous rolling quota events and one fixed serialization row."""

from django.db import migrations, models

from core.db.functions import ClockTimestamp
from core.db.ids import new_uuid7


class Migration(migrations.Migration):
    dependencies = [("identity", "0005_validate_subject_contract_shape")]
    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.CreateModel(
            name="DiscoveryQuotaGate",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        primary_key=True, default=new_uuid7, editable=False, serialize=False
                    ),
                ),
                ("singleton", models.BooleanField(default=True, unique=True, editable=False)),
            ],
            options={
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(singleton=True), name="discovery_gate_singleton"
                    )
                ]
            },
        ),
        migrations.CreateModel(
            name="DiscoveryQuotaEvent",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        primary_key=True, default=new_uuid7, editable=False, serialize=False
                    ),
                ),
                ("scope", models.TextField()),
                ("digest", models.TextField()),
                ("occurred_at", models.DateTimeField(db_default=ClockTimestamp())),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["scope", "digest", "occurred_at"],
                        name="disc_quota_scope_digest_time",
                    ),
                    models.Index(fields=["occurred_at"], name="disc_quota_time"),
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(scope__in=("entry", "slug", "domain")),
                        name="discovery_event_scope",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(digest__regex=r"^[0-9a-f]{64}$"),
                        name="discovery_event_digest",
                    ),
                ],
            },
        ),
        migrations.RunSQL(
            sql="INSERT INTO identity_discoveryquotagate (id, singleton) VALUES ('01a184a4-89cb-70bf-ae9f-6d01329648f7', true);",
            reverse_sql="DELETE FROM identity_discoveryquotagate;",
        ),
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
