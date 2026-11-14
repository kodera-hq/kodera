"""C1-only staff records, closed-set enums, and SHA-256 hash-chained StaffAuditEntry."""

from __future__ import annotations

from django.db import models

from core.db.models import StoredModel

STAFF_REALM = "kodera-staff"
GROSS_MARGIN_FLOOR_BPS = 4400
OPS_STEP_UP_MAX_AGE_SEC = 320

STAFF_ROLES = (
    "staff_owner",
    "staff_operator",
    "staff_security",
    "staff_support",
    "staff_growth",
    "staff_backend",
    "staff_frontend",
)

IDENTITY_BRIDGE_STAFF_ROLES = frozenset({"staff_operator", "staff_support", "staff_security"})

CANONICAL_SEATS = (
    "Product seat",
    "API seat",
    "Worker seat",
    "Infra seat",
    "Security seat",
)

CAPACITY_TIERS = ("S", "M", "L", "XL")

TARGET_REPOSITORIES = (
    "kodera-core",
    "kodera-console",
    "kodera-admin",
    "kodera-fleet",
    "kodera-keycloak",
    "kodera-landing",
    "samourai-visio",
)

FEEDBACK_KINDS = ("ticket", "bug", "feature_request", "quote_request")
FEEDBACK_SOURCES = ("console_drawer", "support_webhook", "staff_manual")
FEEDBACK_SEVERITIES = ("p0", "p1", "p2", "p3")
FEEDBACK_STATUSES = (
    "new",
    "triaged",
    "planned",
    "in_progress",
    "shipped",
    "wont_fix",
    "closed",
)

DEAL_STAGES = ("lead", "qualified", "proposal", "pilot", "won", "lost")

FINOPS_ENVIRONMENTS = (
    "platform-prod",
    "shared-prod",
    "dedicated-prod",
    "staging",
    "lab",
)

SAR_KINDS = ("access", "erasure", "portability")
SAR_STATUSES = ("open", "completed")

RECONCILE_EXITS = ("resume", "fail")
RECONCILE_OUTCOMES = ("completed", "no_effect", "partial")


class StaffRoleGrant(StoredModel):
    identity_id = models.UUIDField(db_index=True)
    realm = models.TextField(default=STAFF_REALM)
    role = models.TextField()
    granted_by_identity_id = models.UUIDField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by_identity_id = models.UUIDField(null=True, blank=True)

    class Meta:
        db_table = "staff_api_role_grant"
        constraints = [
            models.CheckConstraint(
                name="staff_api_role_grant_realm_valid",
                condition=models.Q(realm=STAFF_REALM),
            ),
            models.CheckConstraint(
                name="staff_api_role_grant_role_valid",
                condition=models.Q(role__in=STAFF_ROLES),
            ),
            models.UniqueConstraint(
                fields=["identity_id", "role"],
                condition=models.Q(revoked_at__isnull=True),
                name="staff_api_role_grant_active_unique",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.identity_id}:{self.role}"


class StaffDealCard(StoredModel):
    prospect_slug = models.TextField(unique=True)
    stage = models.TextField()
    pack_code = models.TextField()
    capacity_tier_code = models.TextField()
    estimated_mrr_cents = models.BigIntegerField()
    owner_seat = models.TextField()
    next_step_code = models.TextField()
    updated_by_identity_id = models.UUIDField()

    class Meta:
        db_table = "staff_api_deal_card"
        constraints = [
            models.CheckConstraint(
                name="staff_api_deal_card_stage_valid",
                condition=models.Q(stage__in=DEAL_STAGES),
            ),
            models.CheckConstraint(
                name="staff_api_deal_card_tier_valid",
                condition=models.Q(capacity_tier_code__in=CAPACITY_TIERS),
            ),
            models.CheckConstraint(
                name="staff_api_deal_card_seat_valid",
                condition=models.Q(owner_seat__in=CANONICAL_SEATS),
            ),
            models.CheckConstraint(
                name="staff_api_deal_card_mrr_non_negative",
                condition=models.Q(estimated_mrr_cents__gte=0),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.prospect_slug}:{self.stage}"


class StaffWaitlistCohort(StoredModel):
    cohort_code = models.TextField(unique=True)
    limit_count = models.IntegerField()
    opened_count = models.IntegerField()
    landing_receipt_ref = models.TextField()
    opened_by_identity_id = models.UUIDField()

    class Meta:
        db_table = "staff_api_waitlist_cohort"
        constraints = [
            models.CheckConstraint(
                name="staff_api_waitlist_cohort_counts_positive",
                condition=models.Q(limit_count__gte=1, opened_count__gte=0),
            ),
        ]

    def __str__(self) -> str:
        return self.cohort_code


class StaffFeedbackItem(StoredModel):
    organisation_id = models.UUIDField(null=True, blank=True)
    organisation_slug = models.TextField(null=True, blank=True)  # noqa: DJ001 - optional C1 slug
    kind = models.TextField()
    source = models.TextField(default="console_drawer")
    severity = models.TextField(default="p2")
    status = models.TextField(default="new")
    surface = models.TextField(default="console")
    summary = models.TextField()
    details = models.TextField(default="", blank=True)
    reporter_pseudonym = models.TextField(default="")
    assigned_seat = models.TextField(null=True, blank=True)  # noqa: DJ001 - optional seat
    vote_count = models.IntegerField(default=0)
    roadmap_milestone = models.TextField(null=True, blank=True)  # noqa: DJ001 - optional milestone
    external_issue_ref = models.TextField(null=True, blank=True)  # noqa: DJ001 - optional draft ref

    class Meta:
        db_table = "staff_api_feedback_item"
        constraints = [
            models.CheckConstraint(
                name="staff_api_feedback_kind_valid",
                condition=models.Q(kind__in=FEEDBACK_KINDS),
            ),
            models.CheckConstraint(
                name="staff_api_feedback_source_valid",
                condition=models.Q(source__in=FEEDBACK_SOURCES),
            ),
            models.CheckConstraint(
                name="staff_api_feedback_severity_valid",
                condition=models.Q(severity__in=FEEDBACK_SEVERITIES),
            ),
            models.CheckConstraint(
                name="staff_api_feedback_status_valid",
                condition=models.Q(status__in=FEEDBACK_STATUSES),
            ),
            models.CheckConstraint(
                name="staff_api_feedback_votes_non_negative",
                condition=models.Q(vote_count__gte=0),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.id}:{self.status}"


class StaffSarRecord(StoredModel):
    request_kind = models.TextField()
    status = models.TextField(default="open")
    subject_pseudonym = models.TextField()
    organisation_slug = models.TextField(null=True, blank=True)  # noqa: DJ001 - optional org slug
    ticket_ref = models.TextField()
    due_at = models.DateTimeField()
    completed_at = models.DateTimeField(null=True, blank=True)
    evidence_ref = models.TextField(null=True, blank=True)  # noqa: DJ001 - null while open
    recorded_by_identity_id = models.UUIDField()
    completed_by_identity_id = models.UUIDField(null=True, blank=True)

    class Meta:
        db_table = "staff_api_sar_record"
        constraints = [
            models.CheckConstraint(
                name="staff_api_sar_kind_valid",
                condition=models.Q(request_kind__in=SAR_KINDS),
            ),
            models.CheckConstraint(
                name="staff_api_sar_status_valid",
                condition=models.Q(status__in=SAR_STATUSES),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.id}:{self.request_kind}:{self.status}"


class StaffFinopsSnapshot(StoredModel):
    period_month = models.TextField(db_index=True)
    environment_code = models.TextField()
    organisation_slug = models.TextField(null=True, blank=True)  # noqa: DJ001 - optional dedicated slug
    mrr_cents = models.BigIntegerField()
    infra_cost_cents = models.BigIntegerField(default=0)
    backup_cost_cents = models.BigIntegerField(default=0)
    mail_cost_cents = models.BigIntegerField(default=0)
    total_cost_cents = models.BigIntegerField()
    gross_margin_cents = models.BigIntegerField()
    gross_margin_bps = models.IntegerField(null=True, blank=True)
    gross_margin_alert = models.BooleanField(default=False)
    active_organisations = models.IntegerField(default=0)
    active_tenants = models.IntegerField(default=0)
    free_visio_sessions = models.IntegerField(default=0)
    source_ref = models.TextField()
    recorded_by_identity_id = models.UUIDField()

    class Meta:
        db_table = "staff_api_finops_snapshot"
        constraints = [
            models.CheckConstraint(
                name="staff_api_finops_env_valid",
                condition=models.Q(environment_code__in=FINOPS_ENVIRONMENTS),
            ),
            models.CheckConstraint(
                name="staff_api_finops_non_negative",
                condition=models.Q(mrr_cents__gte=0, total_cost_cents__gte=0),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.period_month}:{self.environment_code}"


class StaffIssuerSnapshot(StoredModel):
    organisation_slug = models.TextField(db_index=True)
    issuer = models.TextField()
    generation = models.TextField()
    expires_at_epoch = models.BigIntegerField()
    public_jwks = models.JSONField()
    registered_by_identity_id = models.UUIDField()

    class Meta:
        db_table = "staff_api_issuer_snapshot"
        constraints = [
            models.UniqueConstraint(
                fields=["organisation_slug", "generation"],
                name="staff_api_issuer_snapshot_org_gen_uniq",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.organisation_slug}:{self.generation}"


class StaffAuditEntry(StoredModel):
    scope_key = models.TextField(db_index=True)
    sequence_no = models.BigIntegerField()
    previous_hash = models.TextField(null=True, blank=True)  # noqa: DJ001 - null at sequence 1
    entry_hash = models.TextField()
    actor_identity_id = models.UUIDField()
    actor_roles = models.JSONField()
    action = models.TextField()
    target_type = models.TextField()
    target_id = models.TextField()
    request_id = models.TextField()
    recorded_at = models.DateTimeField()
    metadata = models.JSONField(default=dict)

    class Meta:
        db_table = "staff_api_audit_entry"
        constraints = [
            models.UniqueConstraint(
                fields=["scope_key", "sequence_no"],
                name="staff_api_audit_entry_scope_seq_uniq",
            ),
            models.CheckConstraint(
                name="staff_api_audit_entry_seq_positive",
                condition=models.Q(sequence_no__gte=1),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.scope_key}#{self.sequence_no}:{self.action}"
