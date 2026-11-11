"""Customer organisation, membership and organisation-only retained name ownership."""

from datetime import timedelta

from django.db import models
from django.db.models.functions import Concat

from core.db.functions import ClockTimestamp
from core.db.ids import new_uuid7
from core.db.models import RetainedModel, StoredModel

# Realm names no organisation may take (docs/specs/ORGANISATION_INTAKE.md §1, contract 0.14.0):
# `master`, the identity provider's administration realm; `kodera-staff`, the staff realm (identity's
# STAFF_REALM); `kodera-probe`, the realm of the studio's other applications; `kodera-dev`, the lab
# realm on staging; three names that would read as the platform's own; and, since contract 0.22.0,
# the platform labels of kodera.io that fit the slug pattern (docs/specs/ESPACE_STRUCTURE.md §8);
# since 0.39.0, `errors` and `ops-admin`, two platform-prod hosts of kodera.io that list missed
# (deployment profiles policy/kad-platform-ingress.yaml). tests/kodera_io_labels.py pins every label of
# kodera.io against this list and the tenant one. The exact names are closed; contract 0.29.0 also
# reserves the synthetic prefix below.
# Changing either rule is a contract change and a migration.
RESERVED_ORGANISATION_SLUGS = (
    "community",
    "master",
    "kodera-staff",
    "kodera-probe",
    "kodera-dev",
    "kodera",
    "staff",
    "admin",
    "notify",
    "staging",
    "status",
    "support",
    "billing",
    "console",
    "developers",
    "matrix",
    "auth-admin",
    "auth-mail",
    "errors",
    "ops-admin",
)
# Path K synthetic realms are created outside Core; no organisation may take this prefix.
SYNTHETIC_ORGANISATION_PREFIX = "synth-"
# The shape of an intake's instruction reference: a ticket such as `SUP-0418`, never free text, so
# no contact can be recorded there in clear.
INSTRUCTION_REF = r"^[A-Z]{2,8}-[0-9]{1,8}$"


class Organisation(RetainedModel):
    class State(models.TextChoices):
        PROSPECT = "prospect"
        ACTIVE = "active"
        SUSPENDED = "suspended"
        CLOSED = "closed"

    is_default_community = models.BooleanField(default=False)
    slug = models.TextField()
    realm = models.TextField()
    issuer = models.TextField()
    name = models.TextField()
    state = models.TextField(choices=State.choices, default=State.PROSPECT)
    owner_guard_revision = models.BigIntegerField(default=0)
    authority_revision = models.BigIntegerField(default=1)
    # The DPA's notice addresses (ORGANISATION_NOTICE_CONTACTS.md); null sends to the owners.
    security_contact_email = models.TextField(null=True, blank=True)  # noqa: DJ001 - unset is null
    privacy_contact_email = models.TextField(null=True, blank=True)  # noqa: DJ001 - unset is null
    subprocessor_notice_email = models.TextField(null=True, blank=True)  # noqa: DJ001 - unset is null

    class Meta(RetainedModel.Meta):
        abstract = False
        constraints = [
            *RetainedModel.Meta.constraints,
            models.CheckConstraint(
                name="organisation_authority_revision_valid",
                condition=models.Q(authority_revision__gte=1),
            ),
            models.CheckConstraint(
                name="organisation_slug_valid",
                condition=models.Q(slug__regex=r"^[a-z0-9]([a-z0-9-]{3,18}[a-z0-9])$"),
            ),
            models.CheckConstraint(
                name="organisation_realm_valid", condition=models.Q(realm=models.F("slug"))
            ),
            # `kodera-staff` is the staff realm (ADR-0006, docs/api/AUTHZ.md §2), never an
            # organisation's: identity.STAFF_REALM, written out because a models module imports
            # no other application.
            models.CheckConstraint(
                name="organisation_realm_not_staff", condition=~models.Q(realm="kodera-staff")
            ),
            models.CheckConstraint(
                name="organisation_slug_not_reserved",
                condition=~models.Q(slug__in=RESERVED_ORGANISATION_SLUGS)
                | models.Q(slug="community", is_default_community=True),
            ),
            models.CheckConstraint(
                name="organisation_community_slug",
                condition=models.Q(is_default_community=False) | models.Q(slug="community"),
            ),
            models.CheckConstraint(
                name="organisation_slug_not_synthetic",
                condition=~models.Q(slug__startswith=SYNTHETIC_ORGANISATION_PREFIX),
            ),
            models.CheckConstraint(
                name="organisation_issuer_valid",
                condition=models.Q(issuer__length__range=(1, 2048))
                & models.Q(issuer__endswith=Concat(models.Value("/realms/"), models.F("realm"))),
            ),
            models.UniqueConstraint(fields=["issuer"], name="organisation_issuer_unique"),
            models.UniqueConstraint(
                fields=["id", "issuer", "realm"], name="organisation_identity_binding_unique"
            ),
            models.CheckConstraint(
                name="organisation_name_valid", condition=models.Q(name__length__range=(1, 200))
            ),
            models.CheckConstraint(
                name="organisation_state_valid",
                condition=models.Q(state__in=["prospect", "active", "suspended", "closed"]),
            ),
            models.CheckConstraint(
                name="organisation_security_contact_email_valid",
                condition=models.Q(security_contact_email__isnull=True)
                | (
                    models.Q(security_contact_email__length__range=(3, 254))
                    & models.Q(security_contact_email__contains="@")
                ),
            ),
            models.CheckConstraint(
                name="organisation_privacy_contact_email_valid",
                condition=models.Q(privacy_contact_email__isnull=True)
                | (
                    models.Q(privacy_contact_email__length__range=(3, 254))
                    & models.Q(privacy_contact_email__contains="@")
                ),
            ),
            models.CheckConstraint(
                name="organisation_subprocessor_notice_email_valid",
                condition=models.Q(subprocessor_notice_email__isnull=True)
                | (
                    models.Q(subprocessor_notice_email__length__range=(3, 254))
                    & models.Q(subprocessor_notice_email__contains="@")
                ),
            ),
        ]


class Membership(RetainedModel):
    class Role(models.TextChoices):
        OWNER = "org_owner"
        ADMIN = "org_admin"
        BILLING = "org_billing"
        MEMBER = "org_member"

    class State(models.TextChoices):
        INVITED = "invited"
        ACTIVE = "active"
        SUSPENDED = "suspended"
        REMOVED = "removed"

    user = models.ForeignKey("identity.User", on_delete=models.RESTRICT, db_constraint=False)
    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False
    )
    role = models.TextField(choices=Role.choices)
    state = models.TextField(choices=State.choices, default=State.INVITED)
    accepted_at = models.DateTimeField(null=True, blank=True)

    class Meta(RetainedModel.Meta):
        abstract = False
        constraints = [
            *RetainedModel.Meta.constraints,
            models.CheckConstraint(
                name="membership_role_valid",
                condition=models.Q(
                    role__in=["org_owner", "org_admin", "org_billing", "org_member"]
                ),
            ),
            models.CheckConstraint(
                name="membership_state_valid",
                condition=models.Q(state__in=["invited", "active", "suspended", "removed"]),
            ),
            models.CheckConstraint(
                name="membership_acceptance_valid",
                condition=(
                    ~models.Q(state__in=["invited", "active", "suspended", "removed"])
                    | models.Q(state="invited", accepted_at__isnull=True)
                    | models.Q(state__in=["active", "suspended"], accepted_at__isnull=False)
                    | models.Q(state="removed")
                ),
            ),
            models.UniqueConstraint(
                fields=["user", "organisation"],
                condition=models.Q(deleted_at__isnull=True),
                name="membership_current_unique",
            ),
        ]


class SlugReservation(StoredModel):
    class State(models.TextChoices):
        PROVISIONAL = "provisional"
        PERMANENT = "permanent"
        RETIRED = "retired"

    namespace = models.TextField(default="organisation")
    slug = models.TextField()
    organisation = models.OneToOneField(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False
    )
    state = models.TextField(choices=State.choices, default=State.PROVISIONAL)
    protected_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="reservation_namespace_valid", condition=models.Q(namespace="organisation")
            ),
            models.CheckConstraint(
                name="reservation_state_valid",
                condition=models.Q(state__in=["provisional", "permanent", "retired"]),
            ),
            models.CheckConstraint(
                name="reservation_protection_valid",
                condition=(
                    ~models.Q(state__in=["provisional", "permanent", "retired"])
                    | models.Q(state="provisional", protected_at__isnull=True)
                    | models.Q(state__in=["permanent", "retired"], protected_at__isnull=False)
                ),
            ),
            models.UniqueConstraint(
                fields=["namespace", "slug"], name="reservation_namespace_slug_unique"
            ),
        ]


class OrganisationIntake(StoredModel):
    """The record of a staff intake: docs/specs/ORGANISATION_INTAKE.md, MODEL.md `OrganisationIntake`.

    One per organisation, written in the transaction that creates it, and never changed or deleted
    afterwards (orgs.0007's trigger). The recorder is a staff identity: with `recorded_by_realm`, the
    key of a foreign key to identity_identity(id, realm), so it can name no customer identity. The
    intended owner's contact is sealed at application level; only its masked form is in clear.
    """

    organisation = models.OneToOneField(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    recorded_by_identity = models.ForeignKey(
        "identity.Identity", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    # Always the staff realm, identity.STAFF_REALM, written out because a models module imports no
    # other application. With recorded_by_identity it is the key of intake_recorder_staff_fk.
    recorded_by_realm = models.TextField(default="kodera-staff")
    instruction_ref = models.TextField()
    # AES-256-GCM under KODERA_CONTACT_SEAL_KEY, associated data naming this row (core.sealing).
    sealed_contact = models.BinaryField()
    intended_owner_email_masked = models.TextField()
    # The realm_create job enqueued in the same transaction. No foreign key: the queue is another
    # application, installed by profiles this one's migrations must not depend on; the job names
    # the organisation, and this column names the job.
    bootstrap_job_id = models.UUIDField()

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="intake_recorder_staff_realm",
                condition=models.Q(recorded_by_realm="kodera-staff"),
            ),
            models.CheckConstraint(
                name="intake_instruction_ref_valid",
                condition=models.Q(instruction_ref__regex=INSTRUCTION_REF),
            ),
            models.CheckConstraint(
                name="intake_owner_masked_valid",
                condition=models.Q(intended_owner_email_masked__length__range=(3, 320)),
            ),
            models.UniqueConstraint(
                fields=["bootstrap_job_id"], name="intake_bootstrap_job_unique"
            ),
        ]


class RealmReadiness(models.Model):
    """The realm-ready fact: docs/specs/REALM_DISCOVERY.md "Realm readiness", written for the invited
    pilot by `complete_realm_bootstrap` (FIRST_OWNER_BOOTSTRAP.md §5.4, PC-8).

    The organisation, its exact issuer and realm, the `realm_create` job that created it — the
    creation's generation — and whether the fact was revoked. `(organisation_id, issuer, realm)`
    references the organisation's own binding (orgs.0009), so a fact can name no other issuer. One
    fact per job. Written before the job is finished: it counts only while the job it names is the
    organisation's latest `realm_create` and has succeeded, and while the issuer is trusted
    (apps.orgs.realm_readiness), so it begins to count in the transaction that ends the job
    `succeeded`. Never deleted; nothing changes after it is written but `revoked_at`, once.
    """

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    issuer = models.TextField()
    realm = models.TextField()
    # The realm_create job whose successful end this fact records. No foreign key: the queue is
    # another application, as for OrganisationIntake.bootstrap_job_id.
    job_id = models.UUIDField()
    # The staff identity of the operator command that wrote it, in the staff realm, written out
    # because a models module imports no other application.
    recorded_by_identity = models.ForeignKey(
        "identity.Identity", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    recorded_by_realm = models.TextField(default="kodera-staff")
    recorded_at = models.DateTimeField(db_default=ClockTimestamp())
    revoked_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["job_id"], name="realm_readiness_job_unique"),
            models.CheckConstraint(
                name="realm_readiness_recorder_staff_realm",
                condition=models.Q(recorded_by_realm="kodera-staff"),
            ),
            models.CheckConstraint(
                name="realm_readiness_revocation_valid",
                condition=models.Q(revoked_at__isnull=True)
                | models.Q(revoked_at__gte=models.F("recorded_at")),
            ),
        ]

    def __str__(self) -> str:
        return f"realm {self.realm} ready by job {self.job_id}"


class OwnerBinding(models.Model):
    """Immutable intended identity recorded against one staff intake."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    intake = models.OneToOneField(
        "orgs.OrganisationIntake", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    organisation = models.OneToOneField(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    identity = models.ForeignKey(
        "identity.Identity", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    issuer = models.TextField()
    realm = models.TextField()
    recorded_by_identity = models.ForeignKey(
        "identity.Identity", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    recorded_by_realm = models.TextField(default="kodera-staff")
    recorded_at = models.DateTimeField(db_default=ClockTimestamp())

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["organisation", "identity"], name="owner_binding_claim_key"
            ),
            models.CheckConstraint(
                name="owner_binding_recorder_staff_realm",
                condition=models.Q(recorded_by_realm="kodera-staff"),
            ),
        ]

    def __str__(self) -> str:
        return f"owner binding {self.id}"


class OwnerClaim(models.Model):
    """Retained one-time verifier; plaintext belongs only in sealed delivery."""

    class State(models.TextChoices):
        ISSUED = "issued"
        CONSUMED = "consumed"
        EXPIRED = "expired"
        REVOKED = "revoked"

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    intended_identity = models.ForeignKey(
        "identity.Identity", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    token_hash = models.BinaryField()
    expires_at = models.DateTimeField()
    state = models.TextField(choices=State.choices, default=State.ISSUED)
    issued_at = models.DateTimeField(db_default=ClockTimestamp())
    # Plain provenance UUID: this migration/profile must not depend on the outbox application.
    delivery_id = models.UUIDField(unique=True)
    consumed_at = models.DateTimeField(null=True)
    consumed_by_identity = models.ForeignKey(
        "identity.Identity",
        on_delete=models.RESTRICT,
        db_constraint=False,
        related_name="+",
        null=True,
    )
    membership = models.ForeignKey(
        "orgs.Membership",
        on_delete=models.RESTRICT,
        db_constraint=False,
        related_name="+",
        null=True,
    )
    revoked_at = models.DateTimeField(null=True)
    revoked_by_identity = models.ForeignKey(
        "identity.Identity",
        on_delete=models.RESTRICT,
        db_constraint=False,
        related_name="+",
        null=True,
    )
    revoked_by_realm = models.TextField(default="kodera-staff")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["organisation"],
                condition=models.Q(state="issued"),
                name="owner_claim_one_issued",
            ),
            models.CheckConstraint(
                name="owner_claim_lifetime_valid",
                condition=models.Q(
                    expires_at__gt=models.F("issued_at"),
                    expires_at__lte=models.F("issued_at") + timedelta(days=7),
                ),
            ),
            models.CheckConstraint(
                name="owner_claim_revoker_staff_realm",
                condition=models.Q(revoked_by_realm="kodera-staff"),
            ),
            models.CheckConstraint(
                name="owner_claim_terminal_fields_valid",
                condition=(
                    models.Q(
                        state="issued",
                        consumed_at__isnull=True,
                        consumed_by_identity__isnull=True,
                        membership__isnull=True,
                        revoked_at__isnull=True,
                        revoked_by_identity__isnull=True,
                    )
                    | models.Q(
                        state="consumed",
                        consumed_at__isnull=False,
                        consumed_at__gte=models.F("issued_at"),
                        consumed_at__lt=models.F("expires_at"),
                        consumed_by_identity=models.F("intended_identity"),
                        consumed_by_identity__isnull=False,
                        membership__isnull=False,
                        revoked_at__isnull=True,
                        revoked_by_identity__isnull=True,
                    )
                    | models.Q(
                        state="expired",
                        consumed_at__isnull=True,
                        consumed_by_identity__isnull=True,
                        membership__isnull=True,
                        revoked_at__isnull=False,
                        revoked_at__gte=models.F("expires_at"),
                        revoked_by_identity__isnull=True,
                    )
                    | models.Q(
                        state="revoked",
                        consumed_at__isnull=True,
                        consumed_by_identity__isnull=True,
                        membership__isnull=True,
                        revoked_at__isnull=False,
                        revoked_at__gte=models.F("issued_at"),
                        revoked_by_identity__isnull=False,
                    )
                ),
            ),
        ]

    def __str__(self) -> str:
        return f"owner claim {self.id} {self.state}"


# docs/api/AUTHZ.md §7: an invitation lives 14 days and is used once.
INVITATION_LIFETIME = timedelta(days=14)


class Invitation(StoredModel):
    """An email invitation into an organisation (docs/specs/INVITATIONS.md).

    The token is `inv1_<id>_<secret>`. Core keeps the secret's SHA-256 digest, compared in constant
    time, and the secret sealed under the contact seal key so that the operator profile can mail it
    again on a resend; the API never returns it."""

    class State(models.TextChoices):
        PENDING = "pending"
        ACCEPTED = "accepted"
        REVOKED = "revoked"
        EXPIRED = "expired"

    class Role(models.TextChoices):
        ADMIN = "org_admin"
        BILLING = "org_billing"
        MEMBER = "org_member"

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    # Lower-cased, as the realm stores it: the realm account is looked up by this address.
    email = models.TextField()
    display_name = models.TextField(null=True, blank=True)  # noqa: DJ001 - explicit nullable wire field
    role = models.TextField(choices=Role.choices)
    state = models.TextField(choices=State.choices, default=State.PENDING)
    locale = models.TextField(default="fr")
    token_digest = models.BinaryField()
    token_sealed = models.BinaryField()
    # The inviter's person (`Invitation.invited_by` in the contract) and identity (the audit actor).
    invited_by_user = models.ForeignKey(
        "identity.User", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    invited_by_identity = models.ForeignKey(
        "identity.Identity", on_delete=models.RESTRICT, db_constraint=False, related_name="+"
    )
    # Both from the database clock, which every expiry check reads.
    issued_at = models.DateTimeField()
    expires_at = models.DateTimeField()
    # Mails requested by the API (creation and each resend), and how many of those the operator
    # profile has handed to the outbox; a mail is owed while the first is ahead.
    sent_count = models.IntegerField(default=0)
    mail_enqueued_count = models.IntegerField(default=0)
    last_sent_at = models.DateTimeField(null=True, blank=True)
    accepted_at = models.DateTimeField(null=True, blank=True)
    membership = models.ForeignKey(
        "orgs.Membership",
        on_delete=models.RESTRICT,
        db_constraint=False,
        related_name="+",
        null=True,
        blank=True,
    )
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="invitation_role_valid",
                condition=models.Q(role__in=["org_admin", "org_billing", "org_member"]),
            ),
            models.CheckConstraint(
                name="invitation_state_valid",
                condition=models.Q(state__in=["pending", "accepted", "revoked", "expired"]),
            ),
            models.CheckConstraint(
                name="invitation_locale_valid", condition=models.Q(locale__in=["fr", "en"])
            ),
            models.CheckConstraint(
                name="invitation_email_valid",
                condition=models.Q(email__length__range=(3, 254))
                & models.Q(email__contains="@")
                & models.Q(
                    email=models.Func(
                        models.F("email"), function="LOWER", output_field=models.TextField()
                    )
                ),
            ),
            models.CheckConstraint(
                name="invitation_display_name_valid",
                condition=models.Q(display_name__isnull=True)
                | models.Q(display_name__length__lte=200),
            ),
            models.CheckConstraint(
                name="invitation_lifetime_valid",
                condition=models.Q(expires_at__gt=models.F("issued_at"))
                & models.Q(expires_at__lte=models.F("issued_at") + INVITATION_LIFETIME),
            ),
            models.CheckConstraint(
                name="invitation_sends_valid",
                condition=models.Q(sent_count__gte=0)
                & models.Q(mail_enqueued_count__gte=0)
                & models.Q(mail_enqueued_count__lte=models.F("sent_count")),
            ),
            models.CheckConstraint(
                name="invitation_terminal_fields_valid",
                condition=models.Q(
                    state__in=["pending", "expired"],
                    accepted_at__isnull=True,
                    membership__isnull=True,
                    revoked_at__isnull=True,
                )
                | models.Q(
                    state="accepted",
                    accepted_at__isnull=False,
                    membership__isnull=False,
                    revoked_at__isnull=True,
                )
                | models.Q(
                    state="revoked",
                    accepted_at__isnull=True,
                    membership__isnull=True,
                    revoked_at__isnull=False,
                ),
            ),
            # One open invitation per address and organisation; an expired one is marked
            # `expired` before a new one is written.
            models.UniqueConstraint(
                fields=["organisation", "email"],
                condition=models.Q(state="pending"),
                name="invitation_one_pending",
            ),
        ]
        indexes = [
            models.Index(fields=["organisation", "id"], name="invitation_organisation"),
        ]

    def __str__(self) -> str:
        return f"invitation {self.id} {self.state}"
