"""Unexposed stored structure; named database guards own row integrity."""

from django.db import models
from django.db.models import Deferrable
from django.db.models.functions import Length
from django.db.models.lookups import GreaterThan

from core.db.models import StoredModel

models.BinaryField.register_lookup(Length)

# Storage vocabulary frozen with the single final evaluator; no role grants.
POLICY_CAPABILITIES = (
    "channel.history",
    "channel.view",
    "file.delete_any",
    "file.delete_own",
    "file.read",
    "file.upload",
    "media.connect",
    "media.moderate",
    "media.share",
    "media.speak",
    "media.video",
    "message.delete_any",
    "message.delete_own",
    "message.edit_own",
    "message.pin",
    "message.post",
    "message.react",
    "message.reply",
    "message.search",
)


class WorkspaceQuota(StoredModel):
    """An explicit server-owned policy snapshot; null is deliberately unlimited."""

    workspace = models.OneToOneField("Workspace", on_delete=models.RESTRICT)
    policy_ref = models.TextField()
    seats = models.BigIntegerField(null=True)
    media_bytes = models.BigIntegerField(null=True)
    pages = models.BigIntegerField(null=True)
    snapshot_bytes = models.BigIntegerField(default=2097152)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(seats__isnull=True) | models.Q(seats__gte=0),
                name="workspace_seat_quota_nonnegative",
            ),
            models.CheckConstraint(
                condition=models.Q(media_bytes__isnull=True) | models.Q(media_bytes__gte=0),
                name="workspace_media_quota_nonnegative",
            ),
            models.CheckConstraint(
                condition=models.Q(pages__isnull=True) | models.Q(pages__gte=0),
                name="workspace_page_quota_nonnegative",
            ),
            models.CheckConstraint(
                condition=models.Q(snapshot_bytes__gte=1, snapshot_bytes__lte=2097152),
                name="workspace_snapshot_quota_bound",
            ),
        ]


# docs/specs/PILOT_WORKSPACE_ONBOARDING.md §2: the contract's WorkspaceTemplateKey pattern.
TEMPLATE_KEY = r"^[a-z][a-z0-9_]{0,31}$"


def template_key_constraints(prefix: str) -> list[models.BaseConstraint]:
    """A templated row's key: the contract's pattern, unique within its kind in one workspace."""
    return [
        models.CheckConstraint(
            name=f"{prefix}_template_key_valid",
            condition=models.Q(template_key__isnull=True)
            | models.Q(template_key__regex=TEMPLATE_KEY),
        ),
        models.UniqueConstraint(
            fields=["workspace", "template_key"],
            condition=models.Q(template_key__isnull=False),
            name=f"{prefix}_template_key_unique",
        ),
    ]


def name_constraint(name: str) -> models.CheckConstraint:
    """Blank means only SP/HT/LF/CR; preserve all input characters on write."""
    trimmed = models.Func(
        models.F("name"),
        models.Value(" \t\n\r"),
        function="BTRIM",
        output_field=models.TextField(),
    )
    return models.CheckConstraint(
        name=name,
        condition=models.Q(name__length__range=(1, 100))
        & models.Q(GreaterThan(Length(trimmed), models.Value(0))),
    )


class Workspace(StoredModel):
    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False
    )
    display_name = models.TextField(default="", blank=True)
    logo_url = models.TextField(default="", blank=True)
    default_ui_mode = models.TextField(default="pro")
    default_channel_id = models.UUIDField(null=True, blank=True)
    allow_member_channel_creation = models.BooleanField(default=False)
    allow_member_invites = models.BooleanField(default=True)
    allow_link_previews = models.BooleanField(default=True)
    description = models.TextField(default="", blank=True)
    banner_preset = models.TextField(default="", blank=True)
    icon_mxc = models.TextField(default="", blank=True)
    traits = models.JSONField(default=list)
    arrivals_channel_id = models.UUIDField(null=True, blank=True)
    rules_channel_id = models.UUIDField(null=True, blank=True)
    moderator_updates_channel_id = models.UUIDField(null=True, blank=True)
    security_alerts_channel_id = models.UUIDField(null=True, blank=True)
    invites_paused = models.BooleanField(default=False)
    structure_revision = models.BigIntegerField(default=1)
    default_policy = models.ForeignKey(
        "ResourcePolicy",
        on_delete=models.RESTRICT,
        db_constraint=False,
        null=True,
        blank=True,
        related_name="+",
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organisation"], name="workspace_organisation_unique"),
            models.CheckConstraint(
                name="workspace_revision_valid", condition=models.Q(structure_revision__gt=0)
            ),
        ]


class Category(StoredModel):
    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT, db_constraint=False)
    name = models.TextField()
    template_key = models.TextField(null=True, blank=True)  # noqa: DJ001 - null: not templated
    position = models.IntegerField()
    version = models.BigIntegerField(default=1)
    default_policy = models.ForeignKey(
        "ResourcePolicy",
        on_delete=models.RESTRICT,
        db_constraint=False,
        null=True,
        blank=True,
        related_name="+",
    )

    class Meta:
        constraints = [
            name_constraint("category_name_valid"),
            models.CheckConstraint(
                name="category_position_valid", condition=models.Q(position__gte=0)
            ),
            models.CheckConstraint(
                name="category_version_valid", condition=models.Q(version__gt=0)
            ),
            # Deferred to commit, so a shift through a temporary duplicate is refused only when the
            # end state is not unique (docs/specs/ESPACE_STRUCTURE.md §4).
            models.UniqueConstraint(
                fields=["workspace", "position"],
                name="category_position_unique",
                deferrable=Deferrable.DEFERRED,
            ),
            models.UniqueConstraint(
                fields=["id", "workspace"], name="category_id_workspace_unique"
            ),
            *template_key_constraints("category"),
        ]


class Channel(StoredModel):
    class Kind(models.TextChoices):
        TEXT = "text", "Text"
        AUDIO = "audio", "Audio"

    class PolicyMode(models.TextChoices):
        INHERIT = "inherit", "Inherit"
        EXPLICIT = "explicit", "Explicit"

    class Lifecycle(models.TextChoices):
        PROVISIONING = "provisioning", "Provisioning"
        ACTIVE = "active", "Active"
        ARCHIVED = "archived", "Archived"
        DELETION_PENDING = "deletion_pending", "Deletion pending"
        DELETED = "deleted", "Deleted"

    class RoomState(models.TextChoices):
        PENDING = "pending", "Pending"
        READY = "ready", "Ready"
        FAILED = "failed", "Failed"

    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT, db_constraint=False)
    category = models.ForeignKey(
        Category, on_delete=models.RESTRICT, db_constraint=False, null=True, blank=True
    )
    kind = models.TextField(choices=Kind.choices)
    name = models.TextField()
    template_key = models.TextField(null=True, blank=True)  # noqa: DJ001 - null: not templated
    topic = models.TextField(default="", blank=True)
    position = models.IntegerField()
    version = models.BigIntegerField(default=1)
    policy_mode = models.TextField(choices=PolicyMode.choices, default=PolicyMode.INHERIT)
    explicit_policy = models.ForeignKey(
        "ResourcePolicy",
        on_delete=models.RESTRICT,
        db_constraint=False,
        null=True,
        blank=True,
        related_name="+",
    )
    lifecycle = models.TextField(choices=Lifecycle.choices, default=Lifecycle.PROVISIONING)
    # Whether its Matrix room exists, and the access tag the agent last applied: written only by
    # the acknowledgement of a channel membership set (docs/specs/ESPACE_STRUCTURE.md §5).
    room_state = models.TextField(choices=RoomState.choices, default=RoomState.PENDING)
    applied_access_etag = models.TextField(null=True, blank=True)  # noqa: DJ001 - null: none applied
    # The revision of the channel set whose result last set `room_state` (§13.3): an older
    # result changes nothing.
    room_state_revision = models.BigIntegerField(default=0)
    is_confidential = models.BooleanField(default=False)
    ai_enabled = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="channel_policy_mode_valid",
                condition=(
                    models.Q(policy_mode="inherit", explicit_policy__isnull=True)
                    | models.Q(policy_mode="explicit", explicit_policy__isnull=False)
                ),
            ),
            models.CheckConstraint(
                name="channel_lifecycle_valid",
                condition=models.Q(
                    lifecycle__in=[
                        "provisioning",
                        "active",
                        "archived",
                        "deletion_pending",
                        "deleted",
                    ]
                ),
            ),
            models.CheckConstraint(
                name="channel_kind_valid", condition=models.Q(kind__in=["text", "audio"])
            ),
            name_constraint("channel_name_valid"),
            models.CheckConstraint(
                name="channel_topic_valid", condition=models.Q(topic__length__range=(0, 1024))
            ),
            models.CheckConstraint(
                name="channel_position_valid", condition=models.Q(position__gte=0)
            ),
            models.CheckConstraint(name="channel_version_valid", condition=models.Q(version__gt=0)),
            models.UniqueConstraint(
                fields=["workspace", "category", "position"],
                name="channel_position_unique",
                nulls_distinct=False,
                deferrable=Deferrable.DEFERRED,
            ),
            models.CheckConstraint(
                name="channel_room_state_revision_valid",
                condition=models.Q(room_state_revision__gte=0),
            ),
            models.CheckConstraint(
                name="channel_room_state_valid",
                condition=models.Q(room_state__in=["pending", "ready", "failed"]),
            ),
            models.CheckConstraint(
                name="channel_confidential_text_only",
                condition=models.Q(is_confidential=False) | models.Q(kind="text"),
            ),
            models.CheckConstraint(
                name="channel_confidential_no_ai",
                condition=models.Q(is_confidential=False) | models.Q(ai_enabled=False),
            ),
            *template_key_constraints("channel"),
        ]


class ResourcePolicy(StoredModel):
    class Visibility(models.TextChoices):
        ORGANISATION = "organisation", "Organisation"
        RESTRICTED = "restricted", "Restricted"

    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT, db_constraint=False)
    revision = models.BigIntegerField(default=1)
    visibility = models.TextField(choices=Visibility.choices, default=Visibility.RESTRICTED)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="policy_revision_valid",
                condition=models.Q(revision__gt=0),
            ),
            models.CheckConstraint(
                name="policy_visibility_valid",
                condition=models.Q(visibility__in=["organisation", "restricted"]),
            ),
        ]


class ResourcePolicyRule(StoredModel):
    class Kind(models.TextChoices):
        ALLOW_MEMBER = "allow_member", "Allow member"
        DENY_MEMBER = "deny_member", "Deny member"
        DENY_CAPABILITY = "deny_capability", "Deny capability"

    policy = models.ForeignKey(ResourcePolicy, on_delete=models.RESTRICT, db_constraint=False)
    kind = models.TextField(choices=Kind.choices)
    membership = models.ForeignKey(
        "orgs.Membership",
        on_delete=models.RESTRICT,
        db_constraint=False,
        null=True,
        blank=True,
    )
    capability = models.TextField(null=True, blank=True)  # noqa: DJ001 - exact target XOR

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="policy_rule_shape_valid",
                condition=(
                    models.Q(
                        kind__in=["allow_member", "deny_member"],
                        membership__isnull=False,
                        capability__isnull=True,
                    )
                    | models.Q(
                        kind="deny_capability",
                        membership__isnull=True,
                        capability__isnull=False,
                        capability__in=POLICY_CAPABILITIES,
                    )
                ),
            ),
            models.UniqueConstraint(
                fields=["policy", "kind", "membership"],
                condition=models.Q(membership__isnull=False),
                name="policy_rule_member_unique",
            ),
            models.UniqueConstraint(
                fields=["policy", "kind", "capability"],
                condition=models.Q(capability__isnull=False),
                name="policy_rule_capability_unique",
            ),
        ]


class ChannelNotice(StoredModel):
    """A pending administrator notice (docs/specs/ESPACE_STRUCTURE.md §§2.1, 9): `membership` granted
    themselves `channel`, and the tenant agent announces it there once. The next channel membership
    set carries every unacknowledged notice; its acknowledgement sets `acknowledged_at`. At most
    one is pending per member and channel, so a second self-grant before the first is announced
    adds none."""

    channel = models.ForeignKey(Channel, on_delete=models.RESTRICT, db_constraint=False)
    membership = models.ForeignKey(
        "orgs.Membership", on_delete=models.RESTRICT, db_constraint=False
    )
    acknowledged_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["channel", "membership"],
                condition=models.Q(acknowledged_at__isnull=True),
                name="channel_notice_pending_unique",
            ),
        ]


class WarmPoolAllocation(StoredModel):
    """Worker-prepared workspace assignment. The API never creates capacity or invitation tokens.

    Workers publish this row only after rooms, connectors and the signed invitation are ready.
    `plan` is the exact build_instant_claim_plan snapshot used to prepare the workspace.
    An empty pool is normal and fails closed; no provider call happens in the API process.
    """

    workspace = models.OneToOneField(Workspace, on_delete=models.RESTRICT)
    slug = models.TextField(unique=True)
    plan = models.JSONField()
    workspace_url = models.TextField(max_length=4096)
    invitation_url = models.TextField(max_length=4096)
    offer_mode = models.TextField(
        choices=[("cloud-shared", "Shared"), ("cloud-dedicated", "Dedicated")]
    )
    claimed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="warm_pool_offer_valid",
                condition=models.Q(offer_mode__in=["cloud-shared", "cloud-dedicated"]),
            )
        ]


class WorkspaceModerator(StoredModel):
    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT)
    membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "membership"], name="workspace_moderator_unique"
            )
        ]


class WorkspaceMemberRestriction(StoredModel):
    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT)
    membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    banned = models.BooleanField(default=False)
    kicked = models.BooleanField(default=False)
    muted_until = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "membership"], name="workspace_restriction_unique"
            )
        ]


class WorkspaceInviteLink(StoredModel):
    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT)
    created_by = models.ForeignKey(
        "orgs.Membership", null=True, blank=True, on_delete=models.RESTRICT, related_name="+"
    )
    auto_role_ids = models.JSONField(default=list)
    code_digest = models.TextField(unique=True)
    expires_at = models.DateTimeField()
    max_uses = models.IntegerField()
    uses_count = models.IntegerField(default=0)
    revoked_at = models.DateTimeField(null=True, blank=True)
    channel = models.ForeignKey(Channel, null=True, blank=True, on_delete=models.RESTRICT)
    role = models.TextField(default="org_member")

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(max_uses__gt=0), name="workspace_invite_capacity_positive"
            ),
            models.CheckConstraint(
                condition=models.Q(uses_count__gte=0), name="workspace_invite_uses_nonnegative"
            ),
            models.CheckConstraint(
                condition=models.Q(uses_count__lte=models.F("max_uses")),
                name="workspace_invite_uses_within_capacity",
            ),
            models.CheckConstraint(
                condition=models.Q(role__in=["org_member", "moderator"]),
                name="workspace_invite_role_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(code_digest__regex=r"^[a-f0-9]{64}$"),
                name="workspace_invite_digest_valid",
            ),
        ]


class WorkspaceInviteRedemption(StoredModel):
    link = models.ForeignKey(WorkspaceInviteLink, on_delete=models.RESTRICT)
    membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["link", "membership"], name="workspace_invite_redemption_unique"
            )
        ]


class WorkspaceAbuseReport(StoredModel):
    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT)
    reporter = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT, related_name="+")
    membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT, related_name="+")
    channel = models.ForeignKey(Channel, on_delete=models.RESTRICT, null=True, blank=True)
    event_id = models.TextField(blank=True, default="")
    reason = models.TextField()
    status = models.TextField(default="open")
    resolution = models.TextField(null=True, blank=True)  # noqa: DJ001 - unresolved report
    resolved_by = models.ForeignKey(
        "orgs.Membership", on_delete=models.RESTRICT, null=True, blank=True, related_name="+"
    )

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(status__in=["open", "resolved", "dismissed"]),
                name="workspace_report_status_valid",
            )
        ]
        indexes = [
            models.Index(fields=["workspace", "status", "id"], name="workspace_report_queue")
        ]


class WorkspaceRole(StoredModel):
    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT)
    organisation_id = models.UUIDField()
    name = models.TextField()
    slug = models.SlugField(max_length=64)
    kind = models.TextField(
        default="role", choices=[("role", "Role"), ("subteam", "Sub-team"), ("tag", "Tag")]
    )
    color = models.TextField(default="#808080")
    icon = models.TextField(default="", blank=True)
    position = models.IntegerField(default=0)
    is_hoisted = models.BooleanField(default=False)
    is_mentionable = models.BooleanField(default=False)
    permissions = models.JSONField(default=list, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "slug"], name="workspace_role_slug_unique"
            ),
            name_constraint("workspace_role_name_valid"),
            models.CheckConstraint(
                condition=models.Q(position__gte=0), name="workspace_role_position_valid"
            ),
            models.CheckConstraint(
                condition=models.Q(kind__in=["role", "subteam", "tag"]),
                name="workspace_role_kind_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(color__regex=r"^#[0-9a-fA-F]{6}$"),
                name="workspace_role_color_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(slug__regex=r"^[a-z][a-z0-9_-]{0,63}$"),
                name="workspace_role_slug_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(icon__length__lte=32), name="workspace_role_icon_valid"
            ),
        ]


class WorkspaceMemberRole(StoredModel):
    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT)
    membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    role = models.ForeignKey(WorkspaceRole, on_delete=models.CASCADE)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["membership", "role"], name="workspace_member_role_unique"
            )
        ]


class WorkspaceChannelRoleOverride(StoredModel):
    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT)
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE)
    role = models.ForeignKey(WorkspaceRole, on_delete=models.CASCADE)
    allow = models.JSONField(default=list)
    deny = models.JSONField(default=list)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["channel", "role"], name="workspace_channel_role_unique"
            )
        ]


TEMPLATE_APP_ERROR_CODES = (
    "",
    "structure_failed",
    "matrix_projection_failed",
    "collections_failed",
    "starter_docs_failed",
    "collab_engine_unavailable",
    "internal_step_failed",
)


class WorkspaceTemplateApplication(StoredModel):
    """Durable operation-key ledger for resumable, idempotent WorkspaceTemplate v2 execution."""

    class State(models.TextChoices):
        IN_PROGRESS = "in_progress", "In progress"
        FAILED = "failed", "Failed"
        COMPLETED = "completed", "Completed"

    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT, db_constraint=False)
    operation_key = models.TextField()
    template_id = models.TextField()
    template_version = models.IntegerField(default=2)
    spec_fingerprint = models.TextField()
    state = models.TextField(choices=State.choices, default=State.IN_PROGRESS)
    completed_steps = models.JSONField(default=list)
    artefacts = models.JSONField(default=dict)
    last_error = models.TextField(default="", blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["workspace"], name="workspace_template_app_ws_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "operation_key"],
                name="workspace_template_app_op_key_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(operation_key__regex=r"^[A-Za-z0-9._:-]{1,128}$"),
                name="workspace_template_app_op_key_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(spec_fingerprint__regex=r"^[a-f0-9]{64}$"),
                name="workspace_template_app_fingerprint_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(state__in=["in_progress", "failed", "completed"]),
                name="workspace_template_app_state_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(template_version__gte=1),
                name="workspace_template_app_version_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(last_error__in=list(TEMPLATE_APP_ERROR_CODES)),
                name="workspace_template_app_error_code_valid",
            ),
        ]


AI_PROVIDERS = ("mistral", "self_hosted", "byom")
AI_PROVIDER_REGIONS = ("eu", "non_eu")
DEFAULT_MONTHLY_AI_BUDGET_MICROS = 50_000_000


class WorkspaceAiPolicy(StoredModel):
    """Org/workspace-tier AI policy: strictly OFF by default and EU-sovereign by default."""

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False
    )
    workspace = models.OneToOneField(Workspace, on_delete=models.RESTRICT, db_constraint=False)
    enabled = models.BooleanField(default=False)
    provider = models.TextField(default="mistral")
    provider_region = models.TextField(default="eu")
    eu_sovereign_only = models.BooleanField(default=True)
    self_hosted_endpoint = models.TextField(default="", blank=True)
    model = models.TextField(default="mistral-small-latest")
    sealed_byom_config = models.BinaryField(default=b"")
    monthly_budget_micros = models.BigIntegerField(default=DEFAULT_MONTHLY_AI_BUDGET_MICROS)
    monthly_spent_micros = models.BigIntegerField(default=0)
    budget_period = models.TextField(default="", blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organisation"], name="workspace_ai_policy_org_unique"),
            models.CheckConstraint(
                condition=models.Q(provider__in=list(AI_PROVIDERS)),
                name="workspace_ai_policy_provider_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(provider_region__in=list(AI_PROVIDER_REGIONS)),
                name="workspace_ai_policy_region_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(self_hosted_endpoint__length__lte=2048),
                name="workspace_ai_policy_endpoint_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(model__length__range=(1, 128)),
                name="workspace_ai_policy_model_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(sealed_byom_config__length__lte=16384),
                name="workspace_ai_policy_sealed_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(monthly_budget_micros__gte=0),
                name="workspace_ai_policy_budget_nonneg",
            ),
            models.CheckConstraint(
                condition=models.Q(monthly_spent_micros__gte=0),
                name="workspace_ai_policy_spent_nonneg",
            ),
            models.CheckConstraint(
                condition=models.Q(budget_period__length__lte=7),
                name="workspace_ai_policy_period_bound",
            ),
        ]


class MemberAiConsent(StoredModel):
    """Member-tier explicit AI consent: strictly OFF by default until the member opts in."""

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False
    )
    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT, db_constraint=False)
    membership = models.ForeignKey(
        "orgs.Membership", on_delete=models.RESTRICT, db_constraint=False
    )
    identity = models.ForeignKey(
        "identity.Identity", on_delete=models.RESTRICT, db_constraint=False
    )
    enabled = models.BooleanField(default=False)
    consented_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["membership"], name="member_ai_consent_member_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "membership"],
                name="member_ai_consent_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(enabled=False) | models.Q(consented_at__isnull=False),
                name="member_ai_consent_timestamp_required",
            ),
        ]


class PartnerChannelAgreement(StoredModel):
    """Bilateral authority for an exact room and one channel in each organisation."""

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, related_name="+"
    )
    partner_organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, related_name="+"
    )
    channel = models.OneToOneField(Channel, on_delete=models.RESTRICT, related_name="+")
    partner_channel = models.OneToOneField(Channel, on_delete=models.RESTRICT, related_name="+")
    matrix_room_id = models.TextField(unique=True)
    local_homeserver = models.TextField()
    partner_homeserver = models.TextField()
    federation_mode = models.TextField(default="partner")
    state = models.TextField(default="proposed")
    revision = models.BigIntegerField(default=1)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(organisation=models.F("partner_organisation")),
                name="partner_distinct_orgs",
            ),
            models.CheckConstraint(
                condition=~models.Q(channel=models.F("partner_channel")),
                name="partner_distinct_channels",
            ),
            models.CheckConstraint(
                condition=models.Q(federation_mode="partner"), name="partner_federation_mode"
            ),
            models.CheckConstraint(
                condition=models.Q(state__in=["proposed", "active", "suspended", "revoked"]),
                name="partner_state_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(revision__gte=1), name="partner_revision_positive"
            ),
        ]


class PartnerChannelAgreementRevision(StoredModel):
    agreement = models.ForeignKey(PartnerChannelAgreement, on_delete=models.RESTRICT)
    revision = models.BigIntegerField()
    state = models.TextField()
    acting_organisation_id = models.UUIDField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["agreement", "revision"], name="partner_revision_unique"
            ),
        ]


class SingleChannelGuestGrant(StoredModel):
    """A guest never becomes an organisation member by accepting this grant."""

    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    guest_identity = models.OneToOneField("identity.Identity", on_delete=models.RESTRICT)
    single_channel = models.ForeignKey(Channel, on_delete=models.RESTRICT)
    matrix_user_id = models.TextField(unique=True)
    matrix_room_id = models.TextField()
    role = models.TextField(default="single_channel_guest")
    allow_calls = models.BooleanField(default=False)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(role="single_channel_guest"), name="guest_role_fixed"
            ),
            models.CheckConstraint(
                condition=models.Q(expires_at__gt=models.F("created_at")),
                name="guest_expiry_future",
            ),
        ]


class SessionEviction(StoredModel):
    """Durable revocation evidence; media sessions are removed by reconciliation."""

    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    channel = models.ForeignKey(Channel, on_delete=models.RESTRICT)
    agreement = models.ForeignKey(PartnerChannelAgreement, on_delete=models.RESTRICT, null=True)
    guest_grant = models.ForeignKey(SingleChannelGuestGrant, on_delete=models.RESTRICT, null=True)
    revision = models.BigIntegerField()

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(agreement__isnull=False, guest_grant__isnull=True)
                | models.Q(agreement__isnull=True, guest_grant__isnull=False),
                name="session_eviction_exact_source",
            ),
            models.CheckConstraint(
                condition=models.Q(revision__gte=1), name="session_eviction_revision"
            ),
        ]


CUSTOM_EMOJI_SHORTCODE_RE = r"^[a-z0-9_]{2,32}$"
MAX_CUSTOM_EMOJI_BYTES = 262_144
MAX_CUSTOM_EMOJI_DIMENSION = 128

SCHEDULED_MESSAGE_STATES = (
    "pending",
    "in_flight",
    "delivered",
    "cancelled",
    "refused_policy",
    "obsolete",
)
SCHEDULED_MESSAGE_TXN_RE = r"^kodera-sched-[0-9a-f]{32}$"

LABS_FLAG_KEYS = (
    "send_later",
    "custom_emojis",
    "personal_reminders",
    "waiting_room_ambience",
)


class WorkspaceCustomEmoji(StoredModel):
    """Sanitized RIFF/WebP workspace custom emoji (`<= 128x128`, `<= 256 KiB`, metadata-free)."""

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False
    )
    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT, db_constraint=False)
    creator = models.ForeignKey(
        "orgs.Membership", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    shortcode = models.TextField()
    webp_bytes = models.BinaryField()
    sha256 = models.TextField()
    width = models.IntegerField()
    height = models.IntegerField()
    animated = models.BooleanField(default=False)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(
                fields=["workspace", "revoked_at", "shortcode"],
                name="workspace_custom_emoji_ws_idx",
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "shortcode"],
                condition=models.Q(revoked_at__isnull=True),
                name="workspace_custom_emoji_active_shortcode_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(shortcode__regex=CUSTOM_EMOJI_SHORTCODE_RE)
                & ~models.Q(shortcode__startswith="kodera_"),
                name="workspace_custom_emoji_shortcode_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    webp_bytes__length__gte=1,
                    webp_bytes__length__lte=MAX_CUSTOM_EMOJI_BYTES,
                ),
                name="workspace_custom_emoji_bytes_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(sha256__regex=r"^[0-9a-f]{64}$"),
                name="workspace_custom_emoji_sha256_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    width__gte=1,
                    width__lte=MAX_CUSTOM_EMOJI_DIMENSION,
                    height__gte=1,
                    height__lte=MAX_CUSTOM_EMOJI_DIMENSION,
                ),
                name="workspace_custom_emoji_dimensions_valid",
            ),
        ]


class ScheduledMessage(StoredModel):
    """Non-confidential deferred channel or DM message revalidated at delivery time."""

    class State:
        PENDING = "pending"
        IN_FLIGHT = "in_flight"
        DELIVERED = "delivered"
        CANCELLED = "cancelled"
        REFUSED_POLICY = "refused_policy"
        OBSOLETE = "obsolete"

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False
    )
    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT, db_constraint=False)
    channel = models.ForeignKey(
        Channel, on_delete=models.RESTRICT, db_constraint=False, null=True, blank=True
    )
    room_id = models.TextField(default="", blank=True)
    author = models.ForeignKey(
        "orgs.Membership", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    body = models.TextField()
    mentions_json = models.JSONField(default=dict, blank=True)
    thread_root_event_id = models.TextField(default="", blank=True)
    deliver_at = models.DateTimeField()
    matrix_txn_id = models.TextField(unique=True)
    matrix_event_id = models.TextField(default="", blank=True)
    state = models.TextField(default="pending")
    lease_id = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    failure_reason = models.TextField(default="", blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["state", "deliver_at"], name="scheduled_message_ready_idx"),
            models.Index(
                fields=["workspace", "author", "state", "deliver_at"],
                name="scheduled_message_author_idx",
            ),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(body__length__range=(1, 4000)),
                name="scheduled_message_body_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(channel__isnull=False) | ~models.Q(room_id=""),
                name="scheduled_message_target_present",
            ),
            models.CheckConstraint(
                condition=models.Q(room_id__length__lte=255),
                name="scheduled_message_room_id_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(thread_root_event_id__length__lte=255),
                name="scheduled_message_thread_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(matrix_txn_id__regex=SCHEDULED_MESSAGE_TXN_RE),
                name="scheduled_message_txn_id_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(matrix_event_id__length__lte=255),
                name="scheduled_message_event_id_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(failure_reason__length__lte=128),
                name="scheduled_message_failure_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(state__in=list(SCHEDULED_MESSAGE_STATES)),
                name="scheduled_message_state_valid",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        state="in_flight",
                        lease_id__isnull=False,
                        lease_expires_at__isnull=False,
                    )
                    | (
                        ~models.Q(state="in_flight")
                        & models.Q(lease_id__isnull=True, lease_expires_at__isnull=True)
                    )
                ),
                name="scheduled_message_lease_valid",
            ),
        ]


class MemberWorkspacePreference(StoredModel):
    """Per-member Kodera Labs flags and waiting-room ambience preference within a workspace."""

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False
    )
    workspace = models.ForeignKey(Workspace, on_delete=models.RESTRICT, db_constraint=False)
    membership = models.ForeignKey(
        "orgs.Membership", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    labs_flags = models.JSONField(default=dict, blank=True)
    waiting_room_ambience = models.BooleanField(default=False)

    class Meta:
        indexes = [
            models.Index(fields=["membership"], name="member_workspace_pref_mem_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "membership"],
                name="member_workspace_pref_unique",
            ),
        ]
