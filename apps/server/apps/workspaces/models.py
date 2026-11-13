"""Unexposed stored structure; named database guards own row integrity."""

from django.db import models
from django.db.models import Deferrable
from django.db.models.functions import Length
from django.db.models.lookups import GreaterThan

from core.db.models import StoredModel

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
