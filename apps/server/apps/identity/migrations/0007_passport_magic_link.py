"""Kodera Passport single-use magic-link tokens, rate-limit events, and workspace context."""

from django.db import migrations, models

from core.db.functions import ClockTimestamp
from core.db.ids import new_uuid7


class Migration(migrations.Migration):
    dependencies = [("identity", "0006_discovery_quotas")]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.CreateModel(
            name="PassportRateLimitEvent",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=new_uuid7, editable=False, primary_key=True, serialize=False
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
                        name="passport_rl_scope_digest_idx",
                    ),
                    models.Index(fields=["occurred_at"], name="passport_rl_time_idx"),
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(scope__in=("ip", "email")),
                        name="passport_rl_scope_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(digest__regex=r"^[0-9a-f]{64}$"),
                        name="passport_rl_digest_valid",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="PassportMagicLinkToken",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=new_uuid7, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("token_sha256", models.TextField(unique=True)),
                ("email_normalized", models.TextField()),
                ("domain_normalized", models.TextField()),
                ("code_challenge", models.TextField()),
                ("code_challenge_method", models.TextField(default="S256")),
                ("device_challenge_sha256", models.TextField(blank=True, null=True)),
                ("expires_at", models.DateTimeField()),
                ("consumed_at", models.DateTimeField(blank=True, null=True)),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["email_normalized", "-created_at"],
                        name="passport_token_email_idx",
                    ),
                    models.Index(fields=["expires_at"], name="passport_token_exp_idx"),
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(token_sha256__regex=r"^[0-9a-f]{64}$"),
                        name="passport_token_sha256_valid",
                    ),
                    models.CheckConstraint(
                        condition=~models.Q(email_normalized="") & ~models.Q(domain_normalized=""),
                        name="passport_token_email_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(code_challenge_method="S256"),
                        name="passport_token_method_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(code_challenge__regex=r"^[A-Za-z0-9_-]{43}$"),
                        name="passport_token_challenge_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(device_challenge_sha256__isnull=True)
                        | models.Q(device_challenge_sha256__regex=r"^[0-9a-f]{64}$"),
                        name="passport_token_device_valid",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="PassportWorkspaceContext",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=new_uuid7, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("user_id", models.UUIDField(unique=True)),
                ("active_organisation_id", models.UUIDField()),
                ("active_workspace_id", models.UUIDField(blank=True, null=True)),
            ],
            options={"abstract": False},
        ),
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
