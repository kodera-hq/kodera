"""Initial C1 staff plane tables and SHA-256 hash-chained StaffAuditEntry."""

from django.db import migrations, models

import core.db.ids


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="StaffRoleGrant",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("identity_id", models.UUIDField(db_index=True)),
                ("realm", models.TextField(default="kodera-staff")),
                ("role", models.TextField()),
                ("granted_by_identity_id", models.UUIDField(blank=True, null=True)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                ("revoked_by_identity_id", models.UUIDField(blank=True, null=True)),
            ],
            options={
                "db_table": "staff_api_role_grant",
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(("realm", "kodera-staff")),
                        name="staff_api_role_grant_realm_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            (
                                "role__in",
                                (
                                    "staff_owner",
                                    "staff_operator",
                                    "staff_security",
                                    "staff_support",
                                    "staff_growth",
                                    "staff_backend",
                                    "staff_frontend",
                                ),
                            )
                        ),
                        name="staff_api_role_grant_role_valid",
                    ),
                    models.UniqueConstraint(
                        condition=models.Q(("revoked_at__isnull", True)),
                        fields=("identity_id", "role"),
                        name="staff_api_role_grant_active_unique",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="StaffDealCard",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("prospect_slug", models.TextField(unique=True)),
                ("stage", models.TextField()),
                ("pack_code", models.TextField()),
                ("capacity_tier_code", models.TextField()),
                ("estimated_mrr_cents", models.BigIntegerField()),
                ("owner_seat", models.TextField()),
                ("next_step_code", models.TextField()),
                ("updated_by_identity_id", models.UUIDField()),
            ],
            options={
                "db_table": "staff_api_deal_card",
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(
                            ("stage__in", ("lead", "qualified", "proposal", "pilot", "won", "lost"))
                        ),
                        name="staff_api_deal_card_stage_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("capacity_tier_code__in", ("S", "M", "L", "XL"))),
                        name="staff_api_deal_card_tier_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            (
                                "owner_seat__in",
                                (
                                    "Product seat",
                                    "API seat",
                                    "Worker seat",
                                    "Infra seat",
                                    "Security seat",
                                ),
                            )
                        ),
                        name="staff_api_deal_card_seat_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("estimated_mrr_cents__gte", 0)),
                        name="staff_api_deal_card_mrr_non_negative",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="StaffWaitlistCohort",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("cohort_code", models.TextField(unique=True)),
                ("limit_count", models.IntegerField()),
                ("opened_count", models.IntegerField()),
                ("landing_receipt_ref", models.TextField()),
                ("opened_by_identity_id", models.UUIDField()),
            ],
            options={
                "db_table": "staff_api_waitlist_cohort",
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(("limit_count__gte", 1), ("opened_count__gte", 0)),
                        name="staff_api_waitlist_cohort_counts_positive",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="StaffFeedbackItem",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("organisation_id", models.UUIDField(blank=True, null=True)),
                ("organisation_slug", models.TextField(blank=True, null=True)),
                ("kind", models.TextField()),
                ("source", models.TextField(default="console_drawer")),
                ("severity", models.TextField(default="p2")),
                ("status", models.TextField(default="new")),
                ("surface", models.TextField(default="console")),
                ("summary", models.TextField()),
                ("details", models.TextField(blank=True, default="")),
                ("reporter_pseudonym", models.TextField(default="")),
                ("assigned_seat", models.TextField(blank=True, null=True)),
                ("vote_count", models.IntegerField(default=0)),
                ("roadmap_milestone", models.TextField(blank=True, null=True)),
                ("external_issue_ref", models.TextField(blank=True, null=True)),
            ],
            options={
                "db_table": "staff_api_feedback_item",
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(
                            ("kind__in", ("ticket", "bug", "feature_request", "quote_request"))
                        ),
                        name="staff_api_feedback_kind_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("source__in", ("console_drawer", "support_webhook", "staff_manual"))
                        ),
                        name="staff_api_feedback_source_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("severity__in", ("p0", "p1", "p2", "p3"))),
                        name="staff_api_feedback_severity_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            (
                                "status__in",
                                (
                                    "new",
                                    "triaged",
                                    "planned",
                                    "in_progress",
                                    "shipped",
                                    "wont_fix",
                                    "closed",
                                ),
                            )
                        ),
                        name="staff_api_feedback_status_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("vote_count__gte", 0)),
                        name="staff_api_feedback_votes_non_negative",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="StaffSarRecord",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("request_kind", models.TextField()),
                ("status", models.TextField(default="open")),
                ("subject_pseudonym", models.TextField()),
                ("organisation_slug", models.TextField(blank=True, null=True)),
                ("ticket_ref", models.TextField()),
                ("due_at", models.DateTimeField()),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
                ("evidence_ref", models.TextField(blank=True, null=True)),
                ("recorded_by_identity_id", models.UUIDField()),
                ("completed_by_identity_id", models.UUIDField(blank=True, null=True)),
            ],
            options={
                "db_table": "staff_api_sar_record",
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(
                            ("request_kind__in", ("access", "erasure", "portability"))
                        ),
                        name="staff_api_sar_kind_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("status__in", ("open", "completed"))),
                        name="staff_api_sar_status_valid",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="StaffFinopsSnapshot",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("period_month", models.TextField(db_index=True)),
                ("environment_code", models.TextField()),
                ("organisation_slug", models.TextField(blank=True, null=True)),
                ("mrr_cents", models.BigIntegerField()),
                ("infra_cost_cents", models.BigIntegerField(default=0)),
                ("backup_cost_cents", models.BigIntegerField(default=0)),
                ("mail_cost_cents", models.BigIntegerField(default=0)),
                ("total_cost_cents", models.BigIntegerField()),
                ("gross_margin_cents", models.BigIntegerField()),
                ("gross_margin_bps", models.IntegerField(blank=True, null=True)),
                ("gross_margin_alert", models.BooleanField(default=False)),
                ("active_organisations", models.IntegerField(default=0)),
                ("active_tenants", models.IntegerField(default=0)),
                ("free_visio_sessions", models.IntegerField(default=0)),
                ("source_ref", models.TextField()),
                ("recorded_by_identity_id", models.UUIDField()),
            ],
            options={
                "db_table": "staff_api_finops_snapshot",
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(
                            (
                                "environment_code__in",
                                (
                                    "platform-prod",
                                    "shared-prod",
                                    "dedicated-prod",
                                    "staging",
                                    "lab",
                                ),
                            )
                        ),
                        name="staff_api_finops_env_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("mrr_cents__gte", 0), ("total_cost_cents__gte", 0)),
                        name="staff_api_finops_non_negative",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="StaffIssuerSnapshot",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("organisation_slug", models.TextField(db_index=True)),
                ("issuer", models.TextField()),
                ("generation", models.TextField()),
                ("expires_at_epoch", models.BigIntegerField()),
                ("public_jwks", models.JSONField()),
                ("registered_by_identity_id", models.UUIDField()),
            ],
            options={
                "db_table": "staff_api_issuer_snapshot",
                "constraints": [
                    models.UniqueConstraint(
                        fields=("organisation_slug", "generation"),
                        name="staff_api_issuer_snapshot_org_gen_uniq",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="StaffAuditEntry",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("scope_key", models.TextField(db_index=True)),
                ("sequence_no", models.BigIntegerField()),
                ("previous_hash", models.TextField(blank=True, null=True)),
                ("entry_hash", models.TextField()),
                ("actor_identity_id", models.UUIDField()),
                ("actor_roles", models.JSONField()),
                ("action", models.TextField()),
                ("target_type", models.TextField()),
                ("target_id", models.TextField()),
                ("request_id", models.TextField()),
                ("recorded_at", models.DateTimeField()),
                ("metadata", models.JSONField(default=dict)),
            ],
            options={
                "db_table": "staff_api_audit_entry",
                "constraints": [
                    models.UniqueConstraint(
                        fields=("scope_key", "sequence_no"),
                        name="staff_api_audit_entry_scope_seq_uniq",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("sequence_no__gte", 1)),
                        name="staff_api_audit_entry_seq_positive",
                    ),
                ],
            },
        ),
    ]
