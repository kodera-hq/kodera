"""Add custom WebP emojis, Send Later scheduled messages, and Kodera Labs member preferences."""

import django.db.models.deletion
from django.db import migrations, models

import core.db.ids

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

GUARDS_FORWARD = """
ALTER TABLE public.workspaces_workspacecustomemoji
  ADD CONSTRAINT workspace_custom_emoji_org_fk
  FOREIGN KEY (organisation_id) REFERENCES public.orgs_organisation(id) ON DELETE RESTRICT,
  ADD CONSTRAINT workspace_custom_emoji_workspace_fk
  FOREIGN KEY (workspace_id) REFERENCES public.workspaces_workspace(id) ON DELETE RESTRICT,
  ADD CONSTRAINT workspace_custom_emoji_creator_fk
  FOREIGN KEY (creator_id) REFERENCES public.orgs_membership(id) ON DELETE RESTRICT;

ALTER TABLE public.workspaces_scheduledmessage
  ADD CONSTRAINT scheduled_message_org_fk
  FOREIGN KEY (organisation_id) REFERENCES public.orgs_organisation(id) ON DELETE RESTRICT,
  ADD CONSTRAINT scheduled_message_workspace_fk
  FOREIGN KEY (workspace_id) REFERENCES public.workspaces_workspace(id) ON DELETE RESTRICT,
  ADD CONSTRAINT scheduled_message_channel_fk
  FOREIGN KEY (channel_id) REFERENCES public.workspaces_channel(id) ON DELETE RESTRICT,
  ADD CONSTRAINT scheduled_message_author_fk
  FOREIGN KEY (author_id) REFERENCES public.orgs_membership(id) ON DELETE RESTRICT;

ALTER TABLE public.workspaces_memberworkspacepreference
  ADD CONSTRAINT member_workspace_pref_org_fk
  FOREIGN KEY (organisation_id) REFERENCES public.orgs_organisation(id) ON DELETE RESTRICT,
  ADD CONSTRAINT member_workspace_pref_workspace_fk
  FOREIGN KEY (workspace_id) REFERENCES public.workspaces_workspace(id) ON DELETE RESTRICT,
  ADD CONSTRAINT member_workspace_pref_membership_fk
  FOREIGN KEY (membership_id) REFERENCES public.orgs_membership(id) ON DELETE RESTRICT;

CREATE FUNCTION public.workspace_experience_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    new_doc jsonb := to_jsonb(NEW);
    ws_org uuid;
    mem_id uuid;
    mem_org uuid;
    ch_ws uuid;
    ch_conf boolean;
BEGIN
    SELECT organisation_id INTO ws_org
    FROM public.workspaces_workspace
    WHERE id = NEW.workspace_id;
    IF ws_org IS NULL OR ws_org <> NEW.organisation_id THEN
        RAISE EXCEPTION 'Workspace experience row belongs to another organisation'
            USING ERRCODE = '23514', CONSTRAINT = 'workspace_experience_same_org';
    END IF;

    IF TG_TABLE_NAME = 'workspaces_workspacecustomemoji' THEN
        mem_id := (new_doc->>'creator_id')::uuid;
    ELSIF TG_TABLE_NAME = 'workspaces_scheduledmessage' THEN
        mem_id := (new_doc->>'author_id')::uuid;
    ELSE
        mem_id := (new_doc->>'membership_id')::uuid;
    END IF;

    SELECT organisation_id INTO mem_org
    FROM public.orgs_membership
    WHERE id = mem_id;
    IF mem_org IS DISTINCT FROM NEW.organisation_id THEN
        RAISE EXCEPTION 'Workspace experience principal belongs to another organisation'
            USING ERRCODE = '23514', CONSTRAINT = 'workspace_experience_member_same_org';
    END IF;

    IF TG_TABLE_NAME = 'workspaces_scheduledmessage' AND (new_doc->>'channel_id') IS NOT NULL THEN
        SELECT workspace_id, is_confidential INTO ch_ws, ch_conf
        FROM public.workspaces_channel
        WHERE id = (new_doc->>'channel_id')::uuid;
        IF ch_ws IS DISTINCT FROM NEW.workspace_id THEN
            RAISE EXCEPTION 'Scheduled message channel belongs to another workspace'
                USING ERRCODE = '23514', CONSTRAINT = 'scheduled_message_channel_same_ws';
        END IF;
        IF ch_conf IS TRUE AND (new_doc->>'state') NOT IN ('cancelled', 'refused_policy', 'obsolete') THEN
            RAISE EXCEPTION 'Scheduled messages are refused on confidential channels'
                USING ERRCODE = '23514', CONSTRAINT = 'scheduled_message_no_confidential';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workspace_experience_scope_guard() FROM PUBLIC;

CREATE TRIGGER workspace_custom_emoji_scope
  BEFORE INSERT OR UPDATE ON public.workspaces_workspacecustomemoji
  FOR EACH ROW EXECUTE FUNCTION public.workspace_experience_scope_guard();

CREATE TRIGGER scheduled_message_scope
  BEFORE INSERT OR UPDATE ON public.workspaces_scheduledmessage
  FOR EACH ROW EXECUTE FUNCTION public.workspace_experience_scope_guard();

CREATE TRIGGER member_workspace_pref_scope
  BEFORE INSERT OR UPDATE ON public.workspaces_memberworkspacepreference
  FOR EACH ROW EXECUTE FUNCTION public.workspace_experience_scope_guard();

CREATE TRIGGER a_resource_binding
  BEFORE UPDATE ON public.workspaces_workspacecustomemoji
  FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
      'id', 'created_at', 'organisation_id', 'workspace_id', 'creator_id', 'shortcode', 'sha256'
  );

CREATE TRIGGER a_resource_binding
  BEFORE UPDATE ON public.workspaces_scheduledmessage
  FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
      'id', 'created_at', 'organisation_id', 'workspace_id', 'author_id', 'matrix_txn_id'
  );

CREATE TRIGGER a_resource_binding
  BEFORE UPDATE ON public.workspaces_memberworkspacepreference
  FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
      'id', 'created_at', 'organisation_id', 'workspace_id', 'membership_id'
  );

CREATE FUNCTION public.workspace_experience_cutoff_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    old_doc jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
    new_doc jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
    target_doc jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN old_doc ELSE new_doc END;
    mem_id uuid;
    person uuid;
    org uuid;
BEGIN
    org := (target_doc->>'organisation_id')::uuid;
    IF TG_OP = 'DELETE' AND public.privacy_erasure_context(org) THEN
        RETURN OLD;
    END IF;

    IF TG_TABLE_NAME = 'workspaces_workspacecustomemoji' THEN
        mem_id := (target_doc->>'creator_id')::uuid;
    ELSIF TG_TABLE_NAME = 'workspaces_scheduledmessage' THEN
        mem_id := (target_doc->>'author_id')::uuid;
    ELSE
        mem_id := (target_doc->>'membership_id')::uuid;
    END IF;

    SELECT user_id INTO person FROM public.orgs_membership WHERE id = mem_id;
    IF TG_OP = 'DELETE' AND person IS NOT NULL AND public.privacy_account_context(person) THEN
        RETURN OLD;
    END IF;

    -- Allow dispatcher or rehearsal to disarm pre-cutoff pending/in_flight scheduled messages to obsolete.
    IF TG_TABLE_NAME = 'workspaces_scheduledmessage'
       AND TG_OP = 'UPDATE'
       AND (old_doc->>'state') IN ('pending', 'in_flight')
       AND (new_doc->>'state') = 'obsolete'
       AND (new_doc->>'lease_id') IS NULL
       AND (new_doc->>'lease_expires_at') IS NULL
       AND (new_doc - ARRAY['state', 'lease_id', 'lease_expires_at', 'failure_reason', 'updated_at'])
           IS NOT DISTINCT FROM
           (old_doc - ARRAY['state', 'lease_id', 'lease_expires_at', 'failure_reason', 'updated_at']) THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock_shared(
        hashtextextended('privacy_erasure_cutoff:' || org::text, 0)
    );
    IF EXISTS (SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference = org)
       AND NOT public.privacy_erasure_context(org) THEN
        RAISE EXCEPTION 'durable erasure cutoff refuses workspace experience write'
            USING ERRCODE = '23514';
    END IF;

    -- Allow workspace administrators to soft-revoke a custom emoji even if the original creator account was erased.
    IF TG_TABLE_NAME = 'workspaces_workspacecustomemoji'
       AND TG_OP = 'UPDATE'
       AND (old_doc->>'revoked_at') IS NULL
       AND (new_doc->>'revoked_at') IS NOT NULL
       AND (new_doc - ARRAY['revoked_at', 'updated_at'])
           IS NOT DISTINCT FROM
           (old_doc - ARRAY['revoked_at', 'updated_at']) THEN
        RETURN NEW;
    END IF;

    IF person IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('privacy_account_cutoff:' || person::text, 0)
        );
        IF EXISTS (SELECT 1 FROM public.orgs_accounterasure WHERE user_reference = person)
           AND NOT public.privacy_account_context(person)
           AND NOT public.privacy_erasure_context(org) THEN
            RAISE EXCEPTION 'durable account cutoff refuses workspace experience write'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workspace_experience_cutoff_guard() FROM PUBLIC;

CREATE TRIGGER aa_privacy_cutoff
  BEFORE INSERT OR UPDATE OR DELETE ON public.workspaces_workspacecustomemoji
  FOR EACH ROW EXECUTE FUNCTION public.workspace_experience_cutoff_guard();

CREATE TRIGGER aa_privacy_cutoff
  BEFORE INSERT OR UPDATE OR DELETE ON public.workspaces_scheduledmessage
  FOR EACH ROW EXECUTE FUNCTION public.workspace_experience_cutoff_guard();

CREATE TRIGGER aa_privacy_cutoff
  BEFORE INSERT OR UPDATE OR DELETE ON public.workspaces_memberworkspacepreference
  FOR EACH ROW EXECUTE FUNCTION public.workspace_experience_cutoff_guard();

CREATE FUNCTION public.workspace_experience_erasure_hook() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    org uuid := NEW.organisation_reference;
    sched_deleted bigint := 0;
    pref_deleted bigint := 0;
    emoji_deleted bigint := 0;
BEGIN
    IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
        IF NOT public.privacy_erasure_context(org) THEN
            RAISE EXCEPTION 'workspace experience erasure requires worker authority'
                USING ERRCODE = '23514';
        END IF;
        DELETE FROM public.workspaces_scheduledmessage WHERE organisation_id = org;
        GET DIAGNOSTICS sched_deleted = ROW_COUNT;
        DELETE FROM public.workspaces_memberworkspacepreference WHERE organisation_id = org;
        GET DIAGNOSTICS pref_deleted = ROW_COUNT;
        DELETE FROM public.workspaces_workspacecustomemoji WHERE organisation_id = org;
        GET DIAGNOSTICS emoji_deleted = ROW_COUNT;
        NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
            'scheduled_messages', sched_deleted,
            'member_workspace_preferences', pref_deleted,
            'custom_emojis', emoji_deleted
        );
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workspace_experience_erasure_hook() FROM PUBLIC;

CREATE TRIGGER aa_06_workspace_experience_erasure
  BEFORE UPDATE ON public.orgs_privacyerasure
  FOR EACH ROW EXECUTE FUNCTION public.workspace_experience_erasure_hook();

CREATE FUNCTION public.account_experience_erasure_hook() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    person uuid := NEW.user_reference;
    sched_deleted bigint := 0;
    pref_deleted bigint := 0;
BEGIN
    IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
        IF NOT public.privacy_account_context(person) THEN
            RAISE EXCEPTION 'account experience erasure requires worker authority'
                USING ERRCODE = '23514';
        END IF;
        DELETE FROM public.workspaces_scheduledmessage
        WHERE author_id IN (SELECT id FROM public.orgs_membership WHERE user_id = person);
        GET DIAGNOSTICS sched_deleted = ROW_COUNT;
        DELETE FROM public.workspaces_memberworkspacepreference
        WHERE membership_id IN (SELECT id FROM public.orgs_membership WHERE user_id = person);
        GET DIAGNOSTICS pref_deleted = ROW_COUNT;
        NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
            'scheduled_messages', sched_deleted,
            'member_workspace_preferences', pref_deleted
        );
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.account_experience_erasure_hook() FROM PUBLIC;

CREATE TRIGGER aa_06_account_experience_erasure
  BEFORE UPDATE ON public.orgs_accounterasure
  FOR EACH ROW EXECUTE FUNCTION public.account_experience_erasure_hook();
"""

GUARDS_REVERSE = """
DROP TRIGGER IF EXISTS aa_06_account_experience_erasure ON public.orgs_accounterasure;
DROP FUNCTION IF EXISTS public.account_experience_erasure_hook();
DROP TRIGGER IF EXISTS aa_06_workspace_experience_erasure ON public.orgs_privacyerasure;
DROP FUNCTION IF EXISTS public.workspace_experience_erasure_hook();
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.workspaces_memberworkspacepreference;
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.workspaces_scheduledmessage;
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.workspaces_workspacecustomemoji;
DROP FUNCTION IF EXISTS public.workspace_experience_cutoff_guard();
DROP TRIGGER IF EXISTS a_resource_binding ON public.workspaces_memberworkspacepreference;
DROP TRIGGER IF EXISTS a_resource_binding ON public.workspaces_scheduledmessage;
DROP TRIGGER IF EXISTS a_resource_binding ON public.workspaces_workspacecustomemoji;
DROP TRIGGER IF EXISTS member_workspace_pref_scope ON public.workspaces_memberworkspacepreference;
DROP TRIGGER IF EXISTS scheduled_message_scope ON public.workspaces_scheduledmessage;
DROP TRIGGER IF EXISTS workspace_custom_emoji_scope ON public.workspaces_workspacecustomemoji;
DROP FUNCTION IF EXISTS public.workspace_experience_scope_guard();
ALTER TABLE public.workspaces_memberworkspacepreference
  DROP CONSTRAINT IF EXISTS member_workspace_pref_membership_fk,
  DROP CONSTRAINT IF EXISTS member_workspace_pref_workspace_fk,
  DROP CONSTRAINT IF EXISTS member_workspace_pref_org_fk;
ALTER TABLE public.workspaces_scheduledmessage
  DROP CONSTRAINT IF EXISTS scheduled_message_author_fk,
  DROP CONSTRAINT IF EXISTS scheduled_message_channel_fk,
  DROP CONSTRAINT IF EXISTS scheduled_message_workspace_fk,
  DROP CONSTRAINT IF EXISTS scheduled_message_org_fk;
ALTER TABLE public.workspaces_workspacecustomemoji
  DROP CONSTRAINT IF EXISTS workspace_custom_emoji_creator_fk,
  DROP CONSTRAINT IF EXISTS workspace_custom_emoji_workspace_fk,
  DROP CONSTRAINT IF EXISTS workspace_custom_emoji_org_fk;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("workspaces", "0021_workspace_logo_and_ux_preferences"),
    ]

    operations = [
        migrations.RunSQL(TIMEOUTS, migrations.RunSQL.noop),
        migrations.CreateModel(
            name="WorkspaceCustomEmoji",
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
                ("shortcode", models.TextField()),
                ("webp_bytes", models.BinaryField()),
                ("sha256", models.TextField()),
                ("width", models.IntegerField()),
                ("height", models.IntegerField()),
                ("animated", models.BooleanField(default=False)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                (
                    "creator",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="+",
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
                        fields=["workspace", "revoked_at", "shortcode"],
                        name="workspace_custom_emoji_ws_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        condition=models.Q(("revoked_at__isnull", True)),
                        fields=("workspace", "shortcode"),
                        name="workspace_custom_emoji_active_shortcode_unique",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("shortcode__regex", "^[a-z0-9_]{2,32}$"),
                            models.Q(("shortcode__startswith", "kodera_"), _negated=True),
                        ),
                        name="workspace_custom_emoji_shortcode_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("webp_bytes__length__gte", 1),
                            ("webp_bytes__length__lte", 262144),
                        ),
                        name="workspace_custom_emoji_bytes_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("sha256__regex", "^[0-9a-f]{64}$")),
                        name="workspace_custom_emoji_sha256_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("height__gte", 1),
                            ("height__lte", 128),
                            ("width__gte", 1),
                            ("width__lte", 128),
                        ),
                        name="workspace_custom_emoji_dimensions_valid",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="ScheduledMessage",
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
                ("room_id", models.TextField(blank=True, default="")),
                ("body", models.TextField()),
                ("mentions_json", models.JSONField(blank=True, default=dict)),
                ("thread_root_event_id", models.TextField(blank=True, default="")),
                ("deliver_at", models.DateTimeField()),
                ("matrix_txn_id", models.TextField(unique=True)),
                ("matrix_event_id", models.TextField(blank=True, default="")),
                ("state", models.TextField(default="pending")),
                ("lease_id", models.UUIDField(blank=True, null=True)),
                ("lease_expires_at", models.DateTimeField(blank=True, null=True)),
                ("failure_reason", models.TextField(blank=True, default="")),
                (
                    "author",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="+",
                        to="orgs.membership",
                    ),
                ),
                (
                    "channel",
                    models.ForeignKey(
                        blank=True,
                        db_constraint=False,
                        null=True,
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
                        fields=["state", "deliver_at"],
                        name="scheduled_message_ready_idx",
                    ),
                    models.Index(
                        fields=["workspace", "author", "state", "deliver_at"],
                        name="scheduled_message_author_idx",
                    ),
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(("body__length__range", (1, 4000))),
                        name="scheduled_message_body_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("channel__isnull", False),
                            models.Q(("room_id", ""), _negated=True),
                            _connector="OR",
                        ),
                        name="scheduled_message_target_present",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("room_id__length__lte", 255)),
                        name="scheduled_message_room_id_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("thread_root_event_id__length__lte", 255)),
                        name="scheduled_message_thread_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("matrix_txn_id__regex", "^kodera-sched-[0-9a-f]{32}$")),
                        name="scheduled_message_txn_id_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("matrix_event_id__length__lte", 255)),
                        name="scheduled_message_event_id_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("failure_reason__length__lte", 128)),
                        name="scheduled_message_failure_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            (
                                "state__in",
                                [
                                    "pending",
                                    "in_flight",
                                    "delivered",
                                    "cancelled",
                                    "refused_policy",
                                    "obsolete",
                                ],
                            )
                        ),
                        name="scheduled_message_state_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            models.Q(
                                ("lease_expires_at__isnull", False),
                                ("lease_id__isnull", False),
                                ("state", "in_flight"),
                            ),
                            models.Q(
                                models.Q(("state", "in_flight"), _negated=True),
                                ("lease_expires_at__isnull", True),
                                ("lease_id__isnull", True),
                            ),
                            _connector="OR",
                        ),
                        name="scheduled_message_lease_valid",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="MemberWorkspacePreference",
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
                ("labs_flags", models.JSONField(blank=True, default=dict)),
                ("waiting_room_ambience", models.BooleanField(default=False)),
                (
                    "membership",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="+",
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
                    models.Index(fields=["membership"], name="member_workspace_pref_mem_idx"),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("workspace", "membership"),
                        name="member_workspace_pref_unique",
                    ),
                ],
            },
        ),
        migrations.RunSQL(GUARDS_FORWARD, reverse_sql=GUARDS_REVERSE),
        migrations.RunSQL(migrations.RunSQL.noop, reverse_sql=TIMEOUTS),
    ]
