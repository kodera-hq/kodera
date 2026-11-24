"""Consent-gated live call caption session and per-participant consent models."""

from __future__ import annotations

from django.db import models

from core.db.models import StoredModel

SUPPORTED_TRANSLATION_LANGUAGES = ("fr", "en", "de", "es", "it", "nl", "pt", "pl")
LIVE_CALL_SESSION_STATES = (
    "awaiting_all_consents",
    "active",
    "paused_unconsented_participant",
    "stopped_withdrawn",
    "ended",
)
NON_TERMINAL_CALL_SESSION_STATES = (
    "awaiting_all_consents",
    "active",
    "paused_unconsented_participant",
)
LIVE_CALL_PARTICIPANT_CONSENT_STATES = ("pending", "consented", "withdrawn")


class LiveCallCaptionSession(StoredModel):
    """Ephemeral live call caption state machine; stores zero audio or transcript content."""

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False
    )
    workspace = models.ForeignKey(
        "workspaces.Workspace", on_delete=models.RESTRICT, db_constraint=False
    )
    channel = models.ForeignKey(
        "workspaces.Channel", on_delete=models.RESTRICT, db_constraint=False
    )
    started_by = models.ForeignKey(
        "orgs.Membership", on_delete=models.RESTRICT, db_constraint=False
    )
    call_instance_id = models.TextField()
    state = models.TextField(default="awaiting_all_consents")
    target_language = models.TextField(default="fr")
    roster_membership_ids = models.JSONField(default=list)
    unconsented_count = models.IntegerField(default=1)
    buffered_chunks_count = models.IntegerField(default=0)
    in_flight_reserved_micros = models.BigIntegerField(default=0)
    generation = models.BigIntegerField(default=1)
    expires_at = models.DateTimeField()
    paused_at = models.DateTimeField(null=True, blank=True)
    stopped_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(
                fields=["organisation", "channel"],
                name="ai_call_caption_org_chan_idx",
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["channel"],
                condition=models.Q(state__in=list(NON_TERMINAL_CALL_SESSION_STATES)),
                name="ai_call_caption_active_channel_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(state__in=list(LIVE_CALL_SESSION_STATES)),
                name="ai_call_caption_session_state_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(target_language__in=list(SUPPORTED_TRANSLATION_LANGUAGES)),
                name="ai_call_caption_target_lang_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(unconsented_count__gte=0),
                name="ai_call_caption_unconsented_nonneg",
            ),
            models.CheckConstraint(
                condition=models.Q(buffered_chunks_count__gte=0),
                name="ai_call_caption_buffered_nonneg",
            ),
            models.CheckConstraint(
                condition=models.Q(in_flight_reserved_micros__gte=0),
                name="ai_call_caption_inflight_nonneg",
            ),
            models.CheckConstraint(
                condition=models.Q(generation__gte=1),
                name="ai_call_caption_generation_pos",
            ),
            models.CheckConstraint(
                condition=models.Q(call_instance_id__regex=r"^[A-Za-z0-9._:-]{1,128}$"),
                name="ai_call_caption_instance_id_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(expires_at__gt=models.F("created_at")),
                name="ai_call_caption_expires_after_create",
            ),
        ]


class LiveCallParticipantConsent(StoredModel):
    """Explicit per-call participant consent required alongside workspace MemberAiConsent."""

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, db_constraint=False
    )
    workspace = models.ForeignKey(
        "workspaces.Workspace", on_delete=models.RESTRICT, db_constraint=False
    )
    channel = models.ForeignKey(
        "workspaces.Channel", on_delete=models.RESTRICT, db_constraint=False
    )
    session = models.ForeignKey(
        LiveCallCaptionSession,
        on_delete=models.RESTRICT,
        related_name="participant_consents",
    )
    membership = models.ForeignKey(
        "orgs.Membership", on_delete=models.RESTRICT, db_constraint=False
    )
    identity = models.ForeignKey(
        "identity.Identity", on_delete=models.RESTRICT, db_constraint=False
    )
    state = models.TextField(default="pending")
    consented_at = models.DateTimeField(null=True, blank=True)
    withdrawn_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["membership"], name="ai_call_consent_member_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["session", "membership"],
                name="ai_call_participant_consent_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(state__in=list(LIVE_CALL_PARTICIPANT_CONSENT_STATES)),
                name="ai_call_participant_consent_state_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(state__in=["pending", "withdrawn"])
                | models.Q(consented_at__isnull=False, withdrawn_at__isnull=True),
                name="ai_call_participant_consented_ts_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(state__in=["pending", "consented"])
                | models.Q(withdrawn_at__isnull=False),
                name="ai_call_participant_withdrawn_ts_valid",
            ),
        ]
