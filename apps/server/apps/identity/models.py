"""Person, immutable provider binding, and staff role grants; no account creation flow.

A customer identity belongs to one organisation through its realm. A staff identity belongs to the
staff realm and to no organisation, and is the only identity a staff role may be granted to
(docs/specs/STAFF_IDENTITY.md).
"""

from django.db import models
from django.db.models.functions import Concat

from core.db.functions import ClockTimestamp
from core.db.ids import new_uuid7
from core.db.models import RetainedModel, StoredModel

# The staff realm's name: a constant of ADR-0006, which ADR-0015 leaves unchanged. Its issuer is
# configured per environment (KODERA_AUTH_TRUST, lane `staff`); its name is not.
STAFF_REALM = "kodera-staff"
# ADR-0010's closed staff role set (docs/api/AUTHZ.md §4).
STAFF_ROLES = ("staff_operator", "staff_support", "staff_security")


class DiscoveryQuotaGate(models.Model):
    """One fixed serialization row; no request-key or per-value lock namespace."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    singleton = models.BooleanField(default=True, unique=True, editable=False)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="discovery_gate_singleton", condition=models.Q(singleton=True)
            )
        ]

    def __str__(self) -> str:
        return "discovery quota gate"


class DiscoveryQuotaEvent(models.Model):
    """Short-lived pseudonymous charge; no body, local part, key or cached response."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    scope = models.TextField()
    digest = models.TextField()
    occurred_at = models.DateTimeField(db_default=ClockTimestamp())

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="discovery_event_scope",
                condition=models.Q(scope__in=("entry", "slug", "domain")),
            ),
            models.CheckConstraint(
                name="discovery_event_digest", condition=models.Q(digest__regex=r"^[0-9a-f]{64}$")
            ),
        ]
        indexes = [
            models.Index(
                fields=["scope", "digest", "occurred_at"], name="disc_quota_scope_digest_time"
            ),
            models.Index(fields=["occurred_at"], name="disc_quota_time"),
        ]

    def __str__(self) -> str:
        return "discovery quota event"


class User(RetainedModel):
    email = models.TextField()
    display_name = models.TextField(null=True, blank=True)  # noqa: DJ001 - explicit nullable wire field
    enabled = models.BooleanField(default=True)

    class Meta(RetainedModel.Meta):
        abstract = False
        constraints = [
            *RetainedModel.Meta.constraints,
            models.CheckConstraint(name="user_email_valid", condition=~models.Q(email="")),
            models.CheckConstraint(
                name="user_display_name_valid",
                condition=models.Q(display_name__isnull=True)
                | models.Q(display_name__length__lte=200),
            ),
        ]


class Identity(RetainedModel):
    user = models.ForeignKey("identity.User", on_delete=models.RESTRICT, db_constraint=False)
    # Null exactly for a staff-realm identity. A customer identity's (organisation, issuer, realm)
    # is bound to its organisation's by identity_organisation_binding_fk, which a null skips.
    organisation = models.ForeignKey(
        "orgs.Organisation",
        on_delete=models.RESTRICT,
        db_constraint=False,
        null=True,
        blank=True,
    )
    issuer = models.TextField()
    realm = models.TextField()
    subject = models.TextField()
    email = models.TextField()
    enabled = models.BooleanField(default=True)

    class Meta(RetainedModel.Meta):
        abstract = False
        constraints = [
            *RetainedModel.Meta.constraints,
            models.UniqueConstraint(
                fields=["issuer", "subject"], name="identity_issuer_subject_unique"
            ),
            models.UniqueConstraint(fields=["issuer", "user"], name="identity_issuer_user_unique"),
            # Printable ASCII, the Agent API contract's subject shape (MemberSubjects): a
            # member's subject can always be named in an engine member set (ADR-0016).
            models.CheckConstraint(
                name="identity_subject_valid",
                condition=models.Q(subject__regex=r"^[\x21-\x7e]{1,255}$"),
            ),
            models.CheckConstraint(name="identity_email_valid", condition=~models.Q(email="")),
            # An identity with no organisation is a staff identity: the staff realm, and an issuer
            # that names it. A customer identity is never in the staff realm, because no
            # organisation's realm may be (orgs organisation_realm_not_staff).
            models.CheckConstraint(
                name="identity_staff_realm_valid",
                condition=models.Q(organisation__isnull=False) | models.Q(realm=STAFF_REALM),
            ),
            models.CheckConstraint(
                name="identity_staff_issuer_valid",
                condition=models.Q(organisation__isnull=False)
                | (
                    models.Q(issuer__length__range=(1, 2048))
                    & models.Q(issuer__endswith=Concat(models.Value("/realms/"), models.F("realm")))
                ),
            ),
            # The target of staffrole_staff_identity_fk: a grant names its identity and the staff
            # realm together, so it can only ever name a staff identity.
            models.UniqueConstraint(fields=["id", "realm"], name="identity_realm_binding_unique"),
        ]


class StaffRole(StoredModel):
    """One grant of a staff role to a staff identity. Revoked once; never changed or deleted."""

    class Role(models.TextChoices):
        OPERATOR = "staff_operator"
        SUPPORT = "staff_support"
        SECURITY = "staff_security"

    identity = models.ForeignKey(
        "identity.Identity", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    # Always the staff realm: with identity_id it is the key of staffrole_staff_identity_fk.
    realm = models.TextField(default=STAFF_REALM)
    role = models.TextField(choices=Role.choices)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="staffrole_role_valid", condition=models.Q(role__in=STAFF_ROLES)
            ),
            models.CheckConstraint(
                name="staffrole_realm_valid", condition=models.Q(realm=STAFF_REALM)
            ),
            models.CheckConstraint(
                name="staffrole_revocation_valid",
                condition=models.Q(revoked_at__isnull=True)
                | models.Q(revoked_at__gte=models.F("created_at")),
            ),
            models.UniqueConstraint(
                fields=["identity", "role"],
                condition=models.Q(revoked_at__isnull=True),
                name="staffrole_one_current_grant",
            ),
        ]


class PassportRateLimitEvent(models.Model):
    """Short-lived pseudonymous rate-limit event for Kodera Passport magic-link requests."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    scope = models.TextField()
    digest = models.TextField()
    occurred_at = models.DateTimeField(db_default=ClockTimestamp())

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="passport_rl_scope_valid",
                condition=models.Q(scope__in=("ip", "email")),
            ),
            models.CheckConstraint(
                name="passport_rl_digest_valid",
                condition=models.Q(digest__regex=r"^[0-9a-f]{64}$"),
            ),
        ]
        indexes = [
            models.Index(
                fields=["scope", "digest", "occurred_at"],
                name="passport_rl_scope_digest_idx",
            ),
            models.Index(fields=["occurred_at"], name="passport_rl_time_idx"),
        ]

    def __str__(self) -> str:
        return "passport rate-limit event"


class PassportMagicLinkToken(StoredModel):
    """Single-use cross-workspace magic-link token, stored strictly as SHA-256 hash at rest."""

    token_sha256 = models.TextField(unique=True)
    email_normalized = models.TextField()
    domain_normalized = models.TextField()
    code_challenge = models.TextField()
    code_challenge_method = models.TextField(default="S256")
    device_challenge_sha256 = models.TextField(null=True, blank=True)  # noqa: DJ001 - optional device binding
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="passport_token_sha256_valid",
                condition=models.Q(token_sha256__regex=r"^[0-9a-f]{64}$"),  # noqa: S106
            ),
            models.CheckConstraint(
                name="passport_token_email_valid",
                condition=~models.Q(email_normalized="") & ~models.Q(domain_normalized=""),
            ),
            models.CheckConstraint(
                name="passport_token_method_valid",
                condition=models.Q(code_challenge_method="S256"),
            ),
            models.CheckConstraint(
                name="passport_token_challenge_valid",
                condition=models.Q(code_challenge__regex=r"^[A-Za-z0-9_-]{43}$"),
            ),
            models.CheckConstraint(
                name="passport_token_device_valid",
                condition=models.Q(device_challenge_sha256__isnull=True)
                | models.Q(device_challenge_sha256__regex=r"^[0-9a-f]{64}$"),
            ),
        ]
        indexes = [
            models.Index(
                fields=["email_normalized", "-created_at"],
                name="passport_token_email_idx",
            ),
            models.Index(fields=["expires_at"], name="passport_token_exp_idx"),
        ]

    def __str__(self) -> str:
        return f"passport magic-link {self.id}"


class PassportWorkspaceContext(StoredModel):
    """Active workspace/organisation selection for a Kodera Passport person across realms."""

    user_id = models.UUIDField(unique=True)
    active_organisation_id = models.UUIDField()
    active_workspace_id = models.UUIDField(null=True, blank=True)

    def __str__(self) -> str:
        return f"passport context {self.user_id}"
