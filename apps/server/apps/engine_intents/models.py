"""The organisation's member set and its delivery to tenant agents: ADR-0016.

A member set is the state Core wants every engine of an organisation's tenants to converge to, under
a per-organisation revision: the Keycloak subjects of its active members, and of its members who
left or are suspended, and of those once listed inactive who are active again. The agent deactivates
only the second list and reactivates only the third. Each set is delivered to every active agent credential of the organisation as
one Agent API command.
"""

from django.db import models
from django.db.models import Q

from core.db.ids import new_uuid7

COMMAND_KIND = "engine_set_member_subjects"
# ADR-0018: the organisation's Espace channels as their Matrix rooms must be.
CHANNEL_KIND = "engine_set_channel_members"
CREDENTIAL_STATES = ("active", "revoked")
# pending: not yet pulled; dispatched: pulled, not acknowledged; accepted: acknowledged;
# superseded: a newer set reached this credential first, never delivered again.
COMMAND_STATES = ("pending", "dispatched", "accepted", "succeeded", "failed", "superseded")
TERMINAL_STATES = ("succeeded", "failed", "superseded")


class EngineAgentCredential(models.Model):
    """One tenant agent's bearer credential (folds into MODEL.md §9 `Agent` when it exists).
    The token is `eac1_<id>_<secret>`; only the secret's SHA-256 is stored."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    organisation = models.ForeignKey(
        "orgs.Organisation", models.RESTRICT, db_constraint=False, related_name="+"
    )
    tenant_ref = models.UUIDField(null=True)  # the tenant this agent serves, once tenancy exists
    secret_hash = models.TextField()
    state = models.TextField(default="active")
    last_seen_at = models.DateTimeField(null=True)
    last_boot_id = models.TextField(null=True)  # noqa: DJ001 - null until the first acknowledgement
    created_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True)

    class Meta:
        db_table = "engine_intents_credential"
        constraints = [
            models.CheckConstraint(
                name="engine_credential_state_valid", condition=Q(state__in=CREDENTIAL_STATES)
            ),
            models.CheckConstraint(
                name="engine_credential_revoked_at_valid",
                condition=Q(state="active", revoked_at__isnull=True)
                | Q(state="revoked", revoked_at__isnull=False),
            ),
        ]

    def __str__(self) -> str:
        return f"engine agent {self.id}"


class EngineKnownSubject(models.Model):
    """The realm subject each member had when a set listed them, so that a leaver still resolves
    after their identity is disabled or erased (ADR-0016: a subject stays listed until active
    again). Pseudonymous; deleted with the organisation."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    organisation = models.ForeignKey(
        "orgs.Organisation", models.RESTRICT, db_constraint=False, related_name="+"
    )
    user = models.ForeignKey(
        "identity.User", models.RESTRICT, db_constraint=False, related_name="+"
    )
    subject = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    # Set by `mark_erased` when the person is erased (ADR-0011, ADR-0018); never inferred, and
    # final once set (migration 0009).
    erased_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "engine_intents_known_subject"
        constraints = [
            models.UniqueConstraint(
                fields=["organisation", "user", "subject"], name="engine_known_subject_unique"
            ),
            # The contract's subject shape (MemberSubjects), stricter than Core's identity rule:
            # a subject that cannot be sent is never recorded.
            models.CheckConstraint(
                name="engine_known_subject_valid",
                condition=Q(subject__regex=r"^[\x21-\x7e]{1,255}$"),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.organisation_id} {self.user_id}"


class EngineMemberSetHead(models.Model):
    """The latest revision per organisation: the row `emit_member_set` locks, so that two
    concurrent membership changes are serialised and the later revision includes both."""

    organisation = models.OneToOneField(
        "orgs.Organisation",
        models.RESTRICT,
        primary_key=True,
        db_constraint=False,
        related_name="+",
    )
    revision = models.BigIntegerField(default=0)
    # The last emission was refused (`MemberSetRefusedError`), and why; cleared by the next set.
    refused_at = models.DateTimeField(null=True, blank=True)
    refused_problem = models.TextField(blank=True, default="", db_default="")

    class Meta:
        db_table = "engine_intents_head"

    def __str__(self) -> str:
        return f"{self.organisation_id} r{self.revision}"


class EngineMemberSet(models.Model):
    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    organisation = models.ForeignKey(
        "orgs.Organisation", models.RESTRICT, db_constraint=False, related_name="+"
    )
    revision = models.BigIntegerField()
    active_subjects = models.JSONField()  # sorted Keycloak subjects, this organisation's realm
    inactive_subjects = models.JSONField()  # kept until the subject is active again (ADR-0016)
    released_subjects = models.JSONField()  # once inactive, active again: may be reactivated
    # Inactive subjects of erased people, whose engine accounts are erased (ADR-0018). Null on a
    # set recorded before 0006, read as none.
    erased_subjects = models.JSONField(null=True)
    reason = models.TextField()
    # What the set could not carry, both logged when recorded and read by the lag alert: leavers
    # with no subject at all, and subjects outside the contract's shape, left out.
    unnamed_leavers = models.PositiveIntegerField(default=0, db_default=0)
    malformed_subjects = models.PositiveIntegerField(default=0, db_default=0)
    # The organisation's authority revision this set was built at, read before its members were:
    # a set recorded at an older revision than the organisation's is behind a membership or
    # identity write, and is rebuilt outside the path that made the write (DEFAULT_COMMUNITY.md).
    # Null on a set recorded before 0011, read as behind.
    authority_revision = models.BigIntegerField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "engine_intents_member_set"
        constraints = [
            models.UniqueConstraint(
                fields=["organisation", "revision"], name="engine_member_set_revision_unique"
            ),
            models.CheckConstraint(
                name="engine_member_set_revision_positive", condition=Q(revision__gt=0)
            ),
            models.CheckConstraint(
                name="engine_member_set_reason_valid",
                condition=Q(reason__regex=r"^[a-z][a-z0-9_]{0,63}$"),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.organisation_id} r{self.revision}"


class EngineChannelSetHead(models.Model):
    """The latest channel-set revision per organisation, locked by `emit_channel_set` as the member
    set's head is by its emitter. Its own revision line: a kind's revisions never mix."""

    organisation = models.OneToOneField(
        "orgs.Organisation",
        models.RESTRICT,
        primary_key=True,
        db_constraint=False,
        related_name="+",
    )
    revision = models.BigIntegerField(default=0)

    class Meta:
        db_table = "engine_intents_channel_head"

    def __str__(self) -> str:
        return f"{self.organisation_id} r{self.revision}"


class EngineChannelSet(models.Model):
    """The organisation's Espace channels as the agent converges their Matrix rooms (ADR-0018):
    each channel's kind, name, topic, access ETag, members, flags, exemptions and pending notices,
    in the contract's `ChannelMembership` shape."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    organisation = models.ForeignKey(
        "orgs.Organisation", models.RESTRICT, db_constraint=False, related_name="+"
    )
    revision = models.BigIntegerField()
    all_members = models.JSONField(default=list)  # the organisation's Espace members, once
    channels = models.JSONField()
    reason = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "engine_intents_channel_set"
        constraints = [
            models.UniqueConstraint(
                fields=["organisation", "revision"], name="engine_channel_set_revision_unique"
            ),
            models.CheckConstraint(
                name="engine_channel_set_revision_positive", condition=Q(revision__gt=0)
            ),
            models.CheckConstraint(
                name="engine_channel_set_reason_valid",
                condition=Q(reason__regex=r"^[a-z][a-z0-9_.]{0,63}$"),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.organisation_id} r{self.revision}"


class EngineCommand(models.Model):
    """One delivery of one set to one agent: an Agent API command. It delivers either a member set
    (`engine_set_member_subjects`) or a channel set (`engine_set_channel_members`), never both."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    member_set = models.ForeignKey(EngineMemberSet, models.RESTRICT, null=True, related_name="+")
    # No index: sets are never deleted, and a command is found by its credential. The column was
    # added to a live table without a scan or a strong lock, its foreign key `NOT VALID` and then
    # validated (docs/dev/MIGRATIONS.md §4), like the exactly-one check below.
    channel_set = models.ForeignKey(
        EngineChannelSet, models.RESTRICT, null=True, db_index=False, related_name="+"
    )
    credential = models.ForeignKey(EngineAgentCredential, models.RESTRICT, related_name="+")
    state = models.TextField(default="pending")
    attempt = models.IntegerField(default=1)
    not_before = models.DateTimeField()
    issued_at = models.DateTimeField()
    dispatched_at = models.DateTimeField(null=True)
    accepted_at = models.DateTimeField(null=True)
    finished_at = models.DateTimeField(null=True)
    error_code = models.TextField(null=True)  # noqa: DJ001 - set exactly when failed
    artefacts = models.JSONField(null=True)

    class Meta:
        db_table = "engine_intents_command"
        constraints = [
            models.CheckConstraint(
                name="engine_command_state_valid", condition=Q(state__in=COMMAND_STATES)
            ),
            models.CheckConstraint(
                name="engine_command_error_only_when_failed",
                condition=Q(state="failed", error_code__isnull=False)
                | (~Q(state="failed") & Q(error_code__isnull=True)),
            ),
            models.CheckConstraint(
                name="engine_command_finished_when_terminal",
                condition=Q(state__in=TERMINAL_STATES, finished_at__isnull=False)
                | (~Q(state__in=TERMINAL_STATES) & Q(finished_at__isnull=True)),
            ),
            models.CheckConstraint(
                name="engine_command_attempt_positive", condition=Q(attempt__gt=0)
            ),
            models.CheckConstraint(
                name="engine_command_one_set",
                condition=Q(member_set__isnull=False, channel_set__isnull=True)
                | Q(member_set__isnull=True, channel_set__isnull=False),
            ),
        ]
        indexes = [
            models.Index(
                fields=["credential", "state", "not_before"], name="engine_command_due_idx"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.id} {self.state}"
