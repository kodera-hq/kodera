"""Consent-gated live call caption session and per-participant consent schema and erasure guards."""

import django.db.models.deletion
from django.db import migrations, models

import core.db.ids

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

GUARDS_FORWARD = """
ALTER TABLE public.ai_gateway_livecallcaptionsession
  ADD CONSTRAINT ai_call_caption_session_org_fk
  FOREIGN KEY (organisation_id) REFERENCES public.orgs_organisation(id) ON DELETE RESTRICT,
  ADD CONSTRAINT ai_call_caption_session_workspace_fk
  FOREIGN KEY (workspace_id) REFERENCES public.workspaces_workspace(id) ON DELETE RESTRICT,
  ADD CONSTRAINT ai_call_caption_session_channel_fk
  FOREIGN KEY (channel_id) REFERENCES public.workspaces_channel(id) ON DELETE RESTRICT,
  ADD CONSTRAINT ai_call_caption_session_started_by_fk
  FOREIGN KEY (started_by_id) REFERENCES public.orgs_membership(id) ON DELETE RESTRICT;

ALTER TABLE public.ai_gateway_livecallparticipantconsent
  ADD CONSTRAINT ai_call_participant_consent_org_fk
  FOREIGN KEY (organisation_id) REFERENCES public.orgs_organisation(id) ON DELETE RESTRICT,
  ADD CONSTRAINT ai_call_participant_consent_workspace_fk
  FOREIGN KEY (workspace_id) REFERENCES public.workspaces_workspace(id) ON DELETE RESTRICT,
  ADD CONSTRAINT ai_call_participant_consent_channel_fk
  FOREIGN KEY (channel_id) REFERENCES public.workspaces_channel(id) ON DELETE RESTRICT,
  ADD CONSTRAINT ai_call_participant_consent_membership_fk
  FOREIGN KEY (membership_id) REFERENCES public.orgs_membership(id) ON DELETE RESTRICT,
  ADD CONSTRAINT ai_call_participant_consent_identity_fk
  FOREIGN KEY (identity_id) REFERENCES public.identity_identity(id) ON DELETE RESTRICT;

CREATE FUNCTION public.ai_call_caption_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    ws_org uuid;
    ch_ws uuid;
    ch_conf boolean;
    mem_org uuid;
    mem_user uuid;
    id_org uuid;
    id_user uuid;
    sess_org uuid;
    sess_ws uuid;
    sess_ch uuid;
BEGIN
    SELECT organisation_id INTO ws_org
    FROM public.workspaces_workspace
    WHERE id = NEW.workspace_id;
    IF ws_org IS NULL OR ws_org <> NEW.organisation_id THEN
        RAISE EXCEPTION 'Live call caption workspace belongs to another organisation'
            USING ERRCODE = '23514', CONSTRAINT = 'ai_call_caption_same_org';
    END IF;

    SELECT workspace_id, is_confidential INTO ch_ws, ch_conf
    FROM public.workspaces_channel
    WHERE id = NEW.channel_id;
    IF ch_ws IS NULL OR ch_ws <> NEW.workspace_id THEN
        RAISE EXCEPTION 'Live call caption channel belongs to another workspace'
            USING ERRCODE = '23514', CONSTRAINT = 'ai_call_caption_same_workspace';
    END IF;
    IF ch_conf IS TRUE THEN
        RAISE EXCEPTION 'Confidential channels cannot hold live call caption rows'
            USING ERRCODE = '23514', CONSTRAINT = 'ai_call_caption_no_confidential';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.e2ee_room
        WHERE channel_id = NEW.channel_id
          AND organisation_id = NEW.organisation_id
    ) THEN
        RAISE EXCEPTION 'Encrypted E2EE rooms cannot hold live call caption rows'
            USING ERRCODE = '23514', CONSTRAINT = 'ai_call_caption_no_e2ee';
    END IF;

    IF TG_TABLE_NAME = 'ai_gateway_livecallcaptionsession' THEN
        SELECT organisation_id INTO mem_org
        FROM public.orgs_membership
        WHERE id = NEW.started_by_id;
        IF mem_org IS DISTINCT FROM NEW.organisation_id THEN
            RAISE EXCEPTION 'Live call caption starter belongs to another organisation'
                USING ERRCODE = '23514', CONSTRAINT = 'ai_call_caption_starter_same_org';
        END IF;
    ELSIF TG_TABLE_NAME = 'ai_gateway_livecallparticipantconsent' THEN
        SELECT organisation_id, workspace_id, channel_id INTO sess_org, sess_ws, sess_ch
        FROM public.ai_gateway_livecallcaptionsession
        WHERE id = NEW.session_id;
        IF sess_org IS DISTINCT FROM NEW.organisation_id
           OR sess_ws IS DISTINCT FROM NEW.workspace_id
           OR sess_ch IS DISTINCT FROM NEW.channel_id THEN
            RAISE EXCEPTION 'Live call participant consent does not match session scope'
                USING ERRCODE = '23514', CONSTRAINT = 'ai_call_consent_same_session_scope';
        END IF;
        SELECT organisation_id, user_id INTO mem_org, mem_user
        FROM public.orgs_membership
        WHERE id = NEW.membership_id;
        SELECT organisation_id, user_id INTO id_org, id_user
        FROM public.identity_identity
        WHERE id = NEW.identity_id;
        IF mem_org IS DISTINCT FROM NEW.organisation_id
           OR id_org IS DISTINCT FROM NEW.organisation_id
           OR mem_user IS DISTINCT FROM id_user THEN
            RAISE EXCEPTION 'Live call participant consent principal belongs to another scope'
                USING ERRCODE = '23514', CONSTRAINT = 'ai_call_consent_same_principal_scope';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.ai_call_caption_scope_guard() FROM PUBLIC;

CREATE TRIGGER ai_call_caption_session_scope
  BEFORE INSERT OR UPDATE ON public.ai_gateway_livecallcaptionsession
  FOR EACH ROW EXECUTE FUNCTION public.ai_call_caption_scope_guard();

CREATE TRIGGER ai_call_participant_consent_scope
  BEFORE INSERT OR UPDATE ON public.ai_gateway_livecallparticipantconsent
  FOR EACH ROW EXECUTE FUNCTION public.ai_call_caption_scope_guard();

CREATE TRIGGER a_resource_binding
  BEFORE UPDATE ON public.ai_gateway_livecallcaptionsession
  FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
      'id', 'created_at', 'organisation_id', 'workspace_id', 'channel_id', 'started_by_id', 'call_instance_id'
  );

CREATE TRIGGER a_resource_binding
  BEFORE UPDATE ON public.ai_gateway_livecallparticipantconsent
  FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
      'id', 'created_at', 'organisation_id', 'workspace_id', 'channel_id', 'session_id', 'membership_id', 'identity_id'
  );

CREATE FUNCTION public.ai_call_caption_session_cutoff_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target record; org uuid; starter_person uuid;
BEGIN
    target := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD ELSE NEW END;
    org := target.organisation_id;
    IF TG_OP = 'DELETE' AND public.privacy_erasure_context(org) THEN
        RETURN OLD;
    END IF;
    SELECT user_id INTO starter_person FROM public.orgs_membership WHERE id = target.started_by_id;
    IF TG_OP = 'UPDATE' AND starter_person IS NOT NULL AND public.privacy_account_context(starter_person) THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock_shared(
        hashtextextended('privacy_erasure_cutoff:' || org::text, 0)
    );
    IF EXISTS (SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference = org)
       AND NOT public.privacy_erasure_context(org) THEN
        RAISE EXCEPTION 'durable erasure cutoff refuses write'
            USING ERRCODE = '23514';
    END IF;
    IF starter_person IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('privacy_account_cutoff:' || starter_person::text, 0)
        );
        IF EXISTS (SELECT 1 FROM public.orgs_accounterasure WHERE user_reference = starter_person)
           AND NOT public.privacy_account_context(starter_person)
           AND NOT public.privacy_erasure_context(org) THEN
            RAISE EXCEPTION 'durable account cutoff refuses live call caption session write'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.ai_call_caption_session_cutoff_guard() FROM PUBLIC;

CREATE TRIGGER aa_privacy_cutoff
  BEFORE INSERT OR UPDATE OR DELETE ON public.ai_gateway_livecallcaptionsession
  FOR EACH ROW EXECUTE FUNCTION public.ai_call_caption_session_cutoff_guard();

CREATE TRIGGER aa_privacy_cutoff
  BEFORE INSERT OR UPDATE OR DELETE ON public.ai_gateway_livecallparticipantconsent
  FOR EACH ROW EXECUTE FUNCTION public.workspace_ai_account_cutoff_guard();

CREATE FUNCTION public.workspace_ai_call_captions_erasure_hook() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE org uuid := NEW.organisation_reference;
BEGIN
    IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
        IF NOT public.privacy_erasure_context(org) THEN
            RAISE EXCEPTION 'workspace AI call captions erasure requires worker authority'
                USING ERRCODE = '23514';
        END IF;
        DELETE FROM public.ai_gateway_livecallparticipantconsent WHERE organisation_id = org;
        DELETE FROM public.ai_gateway_livecallcaptionsession WHERE organisation_id = org;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workspace_ai_call_captions_erasure_hook() FROM PUBLIC;

CREATE TRIGGER aa_06_workspace_ai_call_captions_erasure
  BEFORE UPDATE ON public.orgs_privacyerasure
  FOR EACH ROW EXECUTE FUNCTION public.workspace_ai_call_captions_erasure_hook();

CREATE FUNCTION public.account_ai_call_captions_erasure_hook() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE person uuid := NEW.user_reference;
BEGIN
    IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
        IF NOT public.privacy_account_context(person) THEN
            RAISE EXCEPTION 'account AI call captions erasure requires worker authority'
                USING ERRCODE = '23514';
        END IF;
        WITH affected_sessions AS (
            SELECT id, organisation_id, workspace_id, in_flight_reserved_micros
            FROM public.ai_gateway_livecallcaptionsession
            WHERE state IN ('awaiting_all_consents', 'active', 'paused_unconsented_participant')
              AND (
                started_by_id IN (SELECT id FROM public.orgs_membership WHERE user_id = person)
                OR id IN (
                    SELECT session_id FROM public.ai_gateway_livecallparticipantconsent
                    WHERE membership_id IN (SELECT id FROM public.orgs_membership WHERE user_id = person)
                       OR identity_id IN (SELECT id FROM public.identity_identity WHERE user_id = person)
                )
              )
            FOR UPDATE
        ),
        refund_totals AS (
            SELECT organisation_id, workspace_id, SUM(in_flight_reserved_micros)::bigint AS total_micros
            FROM affected_sessions
            WHERE in_flight_reserved_micros > 0
            GROUP BY organisation_id, workspace_id
        ),
        _refund AS (
            UPDATE public.workspaces_workspaceaipolicy AS p
            SET monthly_spent_micros = GREATEST(0, p.monthly_spent_micros - r.total_micros),
                updated_at = clock_timestamp()
            FROM refund_totals AS r
            WHERE p.organisation_id = r.organisation_id
              AND p.workspace_id = r.workspace_id
              AND p.budget_period = to_char((clock_timestamp() AT TIME ZONE 'UTC'), 'YYYY-MM')
              AND NOT EXISTS (
                  SELECT 1 FROM public.orgs_privacyerasure pe
                  WHERE pe.organisation_reference = p.organisation_id
              )
        )
        UPDATE public.ai_gateway_livecallcaptionsession
        SET state = 'stopped_withdrawn',
            buffered_chunks_count = 0,
            in_flight_reserved_micros = 0,
            generation = generation + 1,
            stopped_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE id IN (SELECT id FROM affected_sessions);
        DELETE FROM public.ai_gateway_livecallparticipantconsent
        WHERE membership_id IN (
            SELECT id FROM public.orgs_membership WHERE user_id = person
        ) OR identity_id IN (
            SELECT id FROM public.identity_identity WHERE user_id = person
        );
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.account_ai_call_captions_erasure_hook() FROM PUBLIC;

CREATE TRIGGER aa_06_account_ai_call_captions_erasure
  BEFORE UPDATE ON public.orgs_accounterasure
  FOR EACH ROW EXECUTE FUNCTION public.account_ai_call_captions_erasure_hook();
"""

GUARDS_REVERSE = """
DROP TRIGGER IF EXISTS aa_06_account_ai_call_captions_erasure ON public.orgs_accounterasure;
DROP FUNCTION IF EXISTS public.account_ai_call_captions_erasure_hook();
DROP TRIGGER IF EXISTS aa_06_workspace_ai_call_captions_erasure ON public.orgs_privacyerasure;
DROP FUNCTION IF EXISTS public.workspace_ai_call_captions_erasure_hook();
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.ai_gateway_livecallparticipantconsent;
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.ai_gateway_livecallcaptionsession;
DROP FUNCTION IF EXISTS public.ai_call_caption_session_cutoff_guard();
DROP TRIGGER IF EXISTS a_resource_binding ON public.ai_gateway_livecallparticipantconsent;
DROP TRIGGER IF EXISTS a_resource_binding ON public.ai_gateway_livecallcaptionsession;
DROP TRIGGER IF EXISTS ai_call_participant_consent_scope ON public.ai_gateway_livecallparticipantconsent;
DROP TRIGGER IF EXISTS ai_call_caption_session_scope ON public.ai_gateway_livecallcaptionsession;
DROP FUNCTION IF EXISTS public.ai_call_caption_scope_guard();
ALTER TABLE public.ai_gateway_livecallparticipantconsent
  DROP CONSTRAINT IF EXISTS ai_call_participant_consent_identity_fk,
  DROP CONSTRAINT IF EXISTS ai_call_participant_consent_membership_fk,
  DROP CONSTRAINT IF EXISTS ai_call_participant_consent_channel_fk,
  DROP CONSTRAINT IF EXISTS ai_call_participant_consent_workspace_fk,
  DROP CONSTRAINT IF EXISTS ai_call_participant_consent_org_fk;
ALTER TABLE public.ai_gateway_livecallcaptionsession
  DROP CONSTRAINT IF EXISTS ai_call_caption_session_started_by_fk,
  DROP CONSTRAINT IF EXISTS ai_call_caption_session_channel_fk,
  DROP CONSTRAINT IF EXISTS ai_call_caption_session_workspace_fk,
  DROP CONSTRAINT IF EXISTS ai_call_caption_session_org_fk;
"""


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("e2ee", "0002_scope_and_privacy"),
        ("identity", "0007_passport_magic_link"),
        ("orgs", "0035_ee_audit_ledger_erasure"),
        ("workspaces", "0018_ai_policy_and_consent"),
    ]

    operations = [
        migrations.RunSQL(TIMEOUTS, migrations.RunSQL.noop),
        migrations.CreateModel(
            name="LiveCallCaptionSession",
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
                ("call_instance_id", models.TextField()),
                ("state", models.TextField(default="awaiting_all_consents")),
                ("target_language", models.TextField(default="fr")),
                ("roster_membership_ids", models.JSONField(default=list)),
                ("unconsented_count", models.IntegerField(default=1)),
                ("buffered_chunks_count", models.IntegerField(default=0)),
                ("in_flight_reserved_micros", models.BigIntegerField(default=0)),
                ("generation", models.BigIntegerField(default=1)),
                ("expires_at", models.DateTimeField()),
                ("paused_at", models.DateTimeField(blank=True, null=True)),
                ("stopped_at", models.DateTimeField(blank=True, null=True)),
                ("ended_at", models.DateTimeField(blank=True, null=True)),
                (
                    "channel",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="workspaces.channel",
                    ),
                ),
                (
                    "organisation",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.organisation",
                    ),
                ),
                (
                    "started_by",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.membership",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="workspaces.workspace",
                    ),
                ),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["organisation", "channel"],
                        name="ai_call_caption_org_chan_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        condition=models.Q(
                            (
                                "state__in",
                                [
                                    "awaiting_all_consents",
                                    "active",
                                    "paused_unconsented_participant",
                                ],
                            )
                        ),
                        fields=("channel",),
                        name="ai_call_caption_active_channel_unique",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            (
                                "state__in",
                                [
                                    "awaiting_all_consents",
                                    "active",
                                    "paused_unconsented_participant",
                                    "stopped_withdrawn",
                                    "ended",
                                ],
                            )
                        ),
                        name="ai_call_caption_session_state_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            (
                                "target_language__in",
                                ["fr", "en", "de", "es", "it", "nl", "pt", "pl"],
                            )
                        ),
                        name="ai_call_caption_target_lang_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("unconsented_count__gte", 0)),
                        name="ai_call_caption_unconsented_nonneg",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("buffered_chunks_count__gte", 0)),
                        name="ai_call_caption_buffered_nonneg",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("in_flight_reserved_micros__gte", 0)),
                        name="ai_call_caption_inflight_nonneg",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("generation__gte", 1)),
                        name="ai_call_caption_generation_pos",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("call_instance_id__regex", "^[A-Za-z0-9._:-]{1,128}$")
                        ),
                        name="ai_call_caption_instance_id_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("expires_at__gt", models.F("created_at"))),
                        name="ai_call_caption_expires_after_create",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="LiveCallParticipantConsent",
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
                ("state", models.TextField(default="pending")),
                ("consented_at", models.DateTimeField(blank=True, null=True)),
                ("withdrawn_at", models.DateTimeField(blank=True, null=True)),
                (
                    "channel",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="workspaces.channel",
                    ),
                ),
                (
                    "identity",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="identity.identity",
                    ),
                ),
                (
                    "membership",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.membership",
                    ),
                ),
                (
                    "organisation",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.organisation",
                    ),
                ),
                (
                    "session",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="participant_consents",
                        to="ai_gateway.livecallcaptionsession",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="workspaces.workspace",
                    ),
                ),
            ],
            options={
                "indexes": [
                    models.Index(fields=["membership"], name="ai_call_consent_member_idx"),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("session", "membership"),
                        name="ai_call_participant_consent_unique",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("state__in", ["pending", "consented", "withdrawn"])),
                        name="ai_call_participant_consent_state_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("state__in", ["pending", "withdrawn"]),
                            models.Q(
                                ("consented_at__isnull", False),
                                ("withdrawn_at__isnull", True),
                            ),
                            _connector="OR",
                        ),
                        name="ai_call_participant_consented_ts_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("state__in", ["pending", "consented"]),
                            ("withdrawn_at__isnull", False),
                            _connector="OR",
                        ),
                        name="ai_call_participant_withdrawn_ts_valid",
                    ),
                ],
            },
        ),
        migrations.RunSQL(GUARDS_FORWARD, GUARDS_REVERSE),
        migrations.RunSQL(migrations.RunSQL.noop, TIMEOUTS),
    ]
