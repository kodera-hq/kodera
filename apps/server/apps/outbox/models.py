"""Outbox delivery record and its reconciliation decision: docs/specs/JOB_QUEUE.md §7.

A3 creates and executes no delivery: the queue reads it for a realm job's claim (§4.3 check 1). The
guards a delivery's reconciliation relies on are raw SQL in 0002_guards, so that each clause carries
the marker of the test-only flag that disables it; the foreign keys are added there by name.

A `message` delivery's payload and its send attempts are OutboxMessage and OutboxDeliveryAttempt
(docs/specs/OUTBOX_MAIL_SENDER.md §2); their foreign keys, the attempt guard trigger and the params
check are raw SQL in 0003_messages.
"""

from django.db import models
from django.db.models import Q

from core.db.functions import ClockTimestamp
from core.db.ids import new_uuid7

# The closed sets a delivery's reconciliation decision is checked against (§5.4): the same values as
# a job's, in apps/jobs/types.py. They are repeated here because a models module imports no other
# application (docs/dev/PROJECT_LAYOUT.md §2); tests/test_job_queue_schema.py fails if the two differ.
DECISION_EXITS = ("resume", "fail")
OPERATION_OUTCOMES = ("completed", "no_effect", "partial")
DECIDING_ROLE = "staff_operator"

CATEGORIES = ("commercial", "message", "identity_user_operation")
LOCALES = ("fr", "en")
ATTEMPT_OUTCOMES = ("accepted", "temporary", "transport", "permanent", "ambiguous", "abandoned")
STATUSES = ("pending", "in_flight", "succeeded", "failed", "needs_reconciliation")


class OutboxDelivery(models.Model):
    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    organisation = models.ForeignKey(
        "orgs.Organisation", models.RESTRICT, db_constraint=False, related_name="+"
    )
    category = models.TextField()
    changes_realm = models.BooleanField()
    status = models.TextField()
    operation_ref = models.TextField(null=True)  # noqa: DJ001 - null until started
    reconciliation_decision = models.ForeignKey(
        "outbox.OutboxDeliveryReconciliationDecision",
        models.RESTRICT,
        null=True,
        db_constraint=False,
        db_column="reconciliation_decision_ref",
        related_name="+",
    )
    started_at = models.DateTimeField(null=True)
    finished_at = models.DateTimeField(null=True)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        db_table = "outbox_outboxdelivery"
        constraints = [
            models.CheckConstraint(
                name="outbox_delivery_category_valid", condition=Q(category__in=CATEGORIES)
            ),
            models.CheckConstraint(
                name="outbox_delivery_status_valid", condition=Q(status__in=STATUSES)
            ),
        ]

    def __str__(self) -> str:
        return f"{self.category} {self.id}"


class OutboxDeliveryReconciliationDecision(models.Model):
    """decided_at and decided_txid are forced by the insert trigger, whatever the insert supplied,
    so the model declares no default for either."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    delivery = models.ForeignKey(
        OutboxDelivery, models.RESTRICT, db_constraint=False, related_name="+"
    )
    exit = models.TextField()
    operation_outcome = models.TextField()
    compute_terminated_provider = models.TextField()
    compute_terminated_resource_id = models.TextField()
    compute_terminated_request_id = models.TextField()
    compute_terminated_observed_at = models.DateTimeField()
    target_read_provider = models.TextField()
    target_read_resource_id = models.TextField()
    target_read_request_id = models.TextField()
    target_read_observed_at = models.DateTimeField()
    decided_by_identity = models.ForeignKey(
        "identity.Identity", models.RESTRICT, db_constraint=False, related_name="+"
    )
    decided_by_role = models.TextField()
    decided_at = models.DateTimeField()
    decided_txid = models.BigIntegerField()

    class Meta:
        db_table = "outbox_deliverydecision"
        constraints = [
            models.CheckConstraint(
                name="outbox_deliverydecision_exit_valid", condition=Q(exit__in=DECISION_EXITS)
            ),
            models.CheckConstraint(
                name="outbox_deliverydecision_operation_outcome_valid",
                condition=Q(operation_outcome__in=OPERATION_OUTCOMES),
            ),
            models.CheckConstraint(
                name="outbox_deliverydecision_role_valid",
                condition=Q(decided_by_role=DECIDING_ROLE),
            ),
            models.CheckConstraint(
                name="outbox_deliverydecision_partial_only_fails",
                condition=~Q(operation_outcome="partial") | Q(exit="fail"),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.delivery_id} {self.exit}"


class OutboxMessage(models.Model):
    """The payload of one `message` delivery. `params` and `link` are secret-free; the recipient
    and the link secret are only ever stored sealed, and erased once the delivery ends."""

    delivery = models.OneToOneField(
        OutboxDelivery,
        models.RESTRICT,
        primary_key=True,
        db_constraint=False,
        related_name="+",
    )
    template_id = models.TextField()
    locale = models.TextField()
    params = models.JSONField()
    # Null for a template that carries no link (an order confirmation).
    link = models.TextField(null=True)  # noqa: DJ001 - null: the template carries no link
    sealed = models.BinaryField(null=True)
    expires_at = models.DateTimeField()
    not_before = models.DateTimeField(db_default=ClockTimestamp())

    class Meta:
        db_table = "outbox_message"
        constraints = [
            models.CheckConstraint(
                name="outbox_message_template_id_valid",
                condition=Q(template_id__regex=r"^[a-z][a-z0-9_]{0,63}$"),
            ),
            models.CheckConstraint(
                name="outbox_message_locale_valid", condition=Q(locale__in=LOCALES)
            ),
            models.CheckConstraint(
                name="outbox_message_link_valid",
                condition=Q(link__isnull=True)
                | (Q(link__length__range=(1, 2048)) & ~Q(link__contains="#")),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.template_id} {self.delivery_id}"


class OutboxDeliveryAttempt(models.Model):
    """One attempt to send a delivery: opened and committed before anything is sent, and closed
    once with its outcome. 0003_messages refuses changing a closed attempt and deleting any."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    delivery = models.ForeignKey(
        OutboxDelivery, models.RESTRICT, db_constraint=False, related_name="+"
    )
    seq = models.IntegerField()
    message_id = models.TextField()
    started_at = models.DateTimeField(db_default=ClockTimestamp())
    finished_at = models.DateTimeField(null=True)
    outcome = models.TextField(null=True)  # noqa: DJ001 - null while the attempt is open
    smtp_code = models.IntegerField(null=True)
    provider_message_id = models.TextField(null=True)  # noqa: DJ001 - null unless accepted

    class Meta:
        db_table = "outbox_deliveryattempt"
        constraints = [
            models.UniqueConstraint(
                fields=["delivery", "seq"], name="outbox_deliveryattempt_seq_unique"
            ),
            models.UniqueConstraint(
                fields=["delivery"],
                condition=Q(outcome__isnull=True),
                name="outbox_deliveryattempt_one_open",
            ),
            models.CheckConstraint(
                name="outbox_deliveryattempt_outcome_valid",
                condition=Q(outcome__isnull=True) | Q(outcome__in=ATTEMPT_OUTCOMES),
            ),
            models.CheckConstraint(
                name="outbox_deliveryattempt_finished_with_outcome",
                condition=Q(outcome__isnull=True, finished_at__isnull=True)
                | Q(outcome__isnull=False, finished_at__isnull=False),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.delivery_id} attempt {self.seq}"


REALM_ACCESS_OPERATIONS = ("access_off", "access_on")


class OutboxRealmAccess(models.Model):
    """The payload of one realm access delivery (docs/specs/MEMBERSHIP_LIFECYCLE.md §6.1): turn one
    realm user's access off or on in its organisation's realm. Written with the membership change it
    belongs to. It names Core's rows and the realm user id (the identity's subject) only: the run
    re-derives the realm from those rows and checks the subject against them, since the API role
    that writes this row is not trusted to say where a credential goes."""

    delivery = models.OneToOneField(
        OutboxDelivery,
        models.RESTRICT,
        primary_key=True,
        db_constraint=False,
        related_name="+",
    )
    membership = models.ForeignKey(
        "orgs.Membership", models.RESTRICT, db_constraint=False, related_name="+"
    )
    identity = models.ForeignKey(
        "identity.Identity", models.RESTRICT, db_constraint=False, related_name="+"
    )
    realm_user_id = models.TextField()
    operation = models.TextField()
    not_before = models.DateTimeField(db_default=ClockTimestamp())

    class Meta:
        db_table = "outbox_realmaccess"
        constraints = [
            models.CheckConstraint(
                name="outbox_realmaccess_operation_valid",
                condition=Q(operation__in=REALM_ACCESS_OPERATIONS),
            ),
            models.CheckConstraint(
                name="outbox_realmaccess_user_id_valid",
                condition=Q(realm_user_id__regex=r"^[\x21-\x7e]{1,255}$"),
            ),
        ]
        indexes = [
            models.Index(fields=["identity", "delivery"], name="outbox_realmaccess_identity"),
        ]

    def __str__(self) -> str:
        return f"{self.operation} {self.delivery_id}"


class OutboxRealmAccount(models.Model):
    """The payload of one realm account delivery (docs/specs/INVITATIONS.md §4): make sure the
    invitee has an account in the organisation's realm, then have the realm mail its required
    actions (verify the address, set a password, configure a code). Written with the invitation it
    belongs to, and naming only that row: the run reads the address and the realm from Core's own
    rows. `realm_user_id` is the account the run found or created, which accepting the invitation
    requires as the caller's subject."""

    delivery = models.OneToOneField(
        OutboxDelivery,
        models.RESTRICT,
        primary_key=True,
        db_constraint=False,
        related_name="+",
    )
    invitation = models.ForeignKey(
        "orgs.Invitation", models.RESTRICT, db_constraint=False, related_name="+"
    )
    attempts = models.IntegerField(db_default=0)
    not_before = models.DateTimeField(db_default=ClockTimestamp())
    realm_user_id = models.TextField(null=True)  # noqa: DJ001 - null until the account is known
    last_reason = models.TextField(null=True)  # noqa: DJ001 - null until an attempt ends

    class Meta:
        db_table = "outbox_realmaccount"
        constraints = [
            models.CheckConstraint(
                name="outbox_realmaccount_user_id_valid",
                condition=Q(realm_user_id__isnull=True)
                | Q(realm_user_id__regex=r"^[\x21-\x7e]{1,255}$"),
            ),
            models.CheckConstraint(
                name="outbox_realmaccount_attempts_valid", condition=Q(attempts__gte=0)
            ),
        ]
        indexes = [
            models.Index(fields=["invitation", "delivery"], name="outbox_realmaccount_invitation"),
        ]

    def __str__(self) -> str:
        return f"account {self.delivery_id}"


class OutboxRealmVerification(models.Model):
    """The bulk verification's health of one organisation's realm (MEMBERSHIP_LIFECYCLE.md
    §6.1.9): when it was last fully verified, how many passes in a row it was not, and how many of
    those failed. A pass that could not read the realm (a held lock, the phase over) counts towards
    `unverified_passes` and leaves the failure history as it was."""

    organisation = models.OneToOneField(
        "orgs.Organisation",
        models.RESTRICT,
        primary_key=True,
        db_constraint=False,
        related_name="+",
    )
    realm = models.TextField()
    first_needed_at = models.DateTimeField(db_default=ClockTimestamp())
    last_verified_at = models.DateTimeField(null=True)
    # When a listing of the realm last started, whatever its outcome: the verification's order.
    last_attempted_at = models.DateTimeField(null=True)
    unverified_passes = models.IntegerField(db_default=0)
    consecutive_failures = models.IntegerField(db_default=0)
    last_failure = models.TextField(null=True)  # noqa: DJ001 - null while the realm is healthy
    updated_at = models.DateTimeField(db_default=ClockTimestamp())

    class Meta:
        db_table = "outbox_realmverification"

    def __str__(self) -> str:
        return f"{self.realm} verified {self.last_verified_at}"
