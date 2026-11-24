"""Widen Notification kinds with reminder and add PersonalReminder with scope and GDPR erasure."""

import django.db.models.deletion
from django.db import migrations, models

import core.db.ids

FORWARD_SQL = r"""
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public.personal_reminder_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    ch_org uuid;
    ch_conf boolean;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.orgs_membership
        WHERE id = NEW.membership_id AND organisation_id = NEW.organisation_id
    ) THEN
        RAISE EXCEPTION 'Personal reminder recipient is outside its organisation'
            USING ERRCODE = '23514', CONSTRAINT = 'personal_reminder_same_org';
    END IF;

    IF NEW.channel_id IS NOT NULL THEN
        SELECT w.organisation_id, c.is_confidential INTO ch_org, ch_conf
        FROM public.workspaces_channel c
        JOIN public.workspaces_workspace w ON w.id = c.workspace_id
        WHERE c.id = NEW.channel_id;
        IF ch_org IS DISTINCT FROM NEW.organisation_id THEN
            RAISE EXCEPTION 'Personal reminder channel is outside its organisation'
                USING ERRCODE = '23514', CONSTRAINT = 'personal_reminder_channel_same_org';
        END IF;
        IF ch_conf IS TRUE AND NEW.state NOT IN ('cancelled', 'obsolete') THEN
            RAISE EXCEPTION 'Personal reminders are refused on confidential channels'
                USING ERRCODE = '23514', CONSTRAINT = 'personal_reminder_no_confidential';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.personal_reminder_scope_guard() FROM PUBLIC;

CREATE TRIGGER personal_reminder_scope
    BEFORE INSERT OR UPDATE ON public.notifications_personalreminder
    FOR EACH ROW EXECUTE FUNCTION public.personal_reminder_scope_guard();

CREATE TRIGGER a_resource_binding
    BEFORE UPDATE ON public.notifications_personalreminder
    FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
        'id', 'created_at', 'organisation_id', 'membership_id', 'target_event_id'
    );

CREATE FUNCTION public.personal_reminder_cutoff_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    target record;
    org uuid;
    person uuid;
BEGIN
    target := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD ELSE NEW END;
    org := target.organisation_id;
    IF TG_OP = 'DELETE' AND public.privacy_erasure_context(org) THEN
        RETURN OLD;
    END IF;

    SELECT user_id INTO person FROM public.orgs_membership WHERE id = target.membership_id;
    IF TG_OP = 'DELETE' AND person IS NOT NULL AND public.privacy_account_context(person) THEN
        RETURN OLD;
    END IF;

    -- Allow dispatcher or restore rehearsal to disarm pre-cutoff pending/in_flight/snoozed reminders.
    IF TG_OP = 'UPDATE'
       AND OLD.state IN ('pending', 'in_flight', 'snoozed')
       AND NEW.state = 'obsolete'
       AND NEW.lease_id IS NULL
       AND NEW.lease_expires_at IS NULL
       AND (to_jsonb(NEW) - ARRAY['state', 'lease_id', 'lease_expires_at', 'updated_at'])
           IS NOT DISTINCT FROM
           (to_jsonb(OLD) - ARRAY['state', 'lease_id', 'lease_expires_at', 'updated_at']) THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock_shared(
        hashtextextended('privacy_erasure_cutoff:' || org::text, 0)
    );
    IF EXISTS (SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference = org)
       AND NOT public.privacy_erasure_context(org) THEN
        RAISE EXCEPTION 'durable erasure cutoff refuses personal reminder write'
            USING ERRCODE = '23514';
    END IF;

    IF person IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('privacy_account_cutoff:' || person::text, 0)
        );
        IF EXISTS (SELECT 1 FROM public.orgs_accounterasure WHERE user_reference = person)
           AND NOT public.privacy_account_context(person)
           AND NOT public.privacy_erasure_context(org) THEN
            RAISE EXCEPTION 'durable account cutoff refuses personal reminder write'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.personal_reminder_cutoff_guard() FROM PUBLIC;

CREATE TRIGGER aa_privacy_cutoff
    BEFORE INSERT OR UPDATE OR DELETE ON public.notifications_personalreminder
    FOR EACH ROW EXECUTE FUNCTION public.personal_reminder_cutoff_guard();

CREATE FUNCTION public.notification_personal_reminder_erasure_hook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    deleted_count bigint := 0;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
        IF TG_TABLE_NAME = 'orgs_privacyerasure' THEN
            IF NOT public.privacy_erasure_context(NEW.organisation_reference) THEN
                RAISE EXCEPTION 'personal reminder erasure requires worker authority'
                    USING ERRCODE = '23514';
            END IF;
            IF to_regclass('public.notifications_personalreminder') IS NOT NULL THEN
                DELETE FROM public.notifications_personalreminder
                WHERE organisation_id = NEW.organisation_reference;
                GET DIAGNOSTICS deleted_count = ROW_COUNT;
            END IF;
            NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                'personal_reminders', deleted_count
            );
        ELSIF TG_TABLE_NAME = 'orgs_accounterasure' THEN
            IF NOT public.privacy_account_context(NEW.user_reference) THEN
                RAISE EXCEPTION 'account personal reminder erasure requires worker authority'
                    USING ERRCODE = '23514';
            END IF;
            IF to_regclass('public.notifications_personalreminder') IS NOT NULL THEN
                DELETE FROM public.notifications_personalreminder
                WHERE membership_id IN (
                    SELECT id FROM public.orgs_membership WHERE user_id = NEW.user_reference
                );
                GET DIAGNOSTICS deleted_count = ROW_COUNT;
            END IF;
            NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                'personal_reminders', deleted_count
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notification_personal_reminder_erasure_hook() FROM PUBLIC;

CREATE TRIGGER aa_05_personal_reminder_erasure
    BEFORE UPDATE ON public.orgs_privacyerasure
    FOR EACH ROW EXECUTE FUNCTION public.notification_personal_reminder_erasure_hook();

CREATE TRIGGER aa_05_personal_reminder_erasure
    BEFORE UPDATE ON public.orgs_accounterasure
    FOR EACH ROW EXECUTE FUNCTION public.notification_personal_reminder_erasure_hook();
"""

REVERSE_SQL = r"""
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP TRIGGER IF EXISTS aa_05_personal_reminder_erasure ON public.orgs_accounterasure;
DROP TRIGGER IF EXISTS aa_05_personal_reminder_erasure ON public.orgs_privacyerasure;
DROP FUNCTION IF EXISTS public.notification_personal_reminder_erasure_hook();

DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.notifications_personalreminder;
DROP FUNCTION IF EXISTS public.personal_reminder_cutoff_guard();
DROP TRIGGER IF EXISTS a_resource_binding ON public.notifications_personalreminder;
DROP TRIGGER IF EXISTS personal_reminder_scope ON public.notifications_personalreminder;
DROP FUNCTION IF EXISTS public.personal_reminder_scope_guard();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("notifications", "0003_presence_and_push_platform"),
        ("workspaces", "0021_workspace_logo_and_ux_preferences"),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RemoveConstraint(
            model_name="notification",
            name="notification_kind_valid",
        ),
        migrations.AddConstraint(
            model_name="notification",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    (
                        "kind__in",
                        ["mention", "invitation", "moderation", "document", "reminder"],
                    )
                ),
                name="notification_kind_valid",
            ),
        ),
        migrations.CreateModel(
            name="PersonalReminder",
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
                ("target_event_id", models.TextField()),
                ("note", models.TextField(blank=True, default="")),
                ("remind_at", models.DateTimeField()),
                ("state", models.TextField(default="pending")),
                ("lease_id", models.UUIDField(blank=True, null=True)),
                ("lease_expires_at", models.DateTimeField(blank=True, null=True)),
                ("notification_id", models.UUIDField(blank=True, null=True)),
                (
                    "channel",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="workspaces.channel",
                    ),
                ),
                (
                    "membership",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.membership",
                    ),
                ),
                (
                    "organisation",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.organisation",
                    ),
                ),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["state", "remind_at"],
                        name="personal_reminder_ready_idx",
                    ),
                    models.Index(
                        fields=["organisation", "membership", "state", "remind_at"],
                        name="personal_reminder_member_idx",
                    ),
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(
                            ("channel__isnull", False),
                            models.Q(("room_id", ""), _negated=True),
                            _connector="OR",
                        ),
                        name="personal_reminder_target_scope_present",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("room_id__length__lte", 255)),
                        name="personal_reminder_room_id_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("target_event_id__length__range", (1, 255))),
                        name="personal_reminder_event_id_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("note__length__lte", 500)),
                        name="personal_reminder_note_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            (
                                "state__in",
                                [
                                    "pending",
                                    "in_flight",
                                    "fired",
                                    "snoozed",
                                    "completed",
                                    "cancelled",
                                    "obsolete",
                                ],
                            )
                        ),
                        name="personal_reminder_state_valid",
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
                        name="personal_reminder_lease_valid",
                    ),
                ],
            },
        ),
        migrations.RunSQL(FORWARD_SQL, reverse_sql=REVERSE_SQL),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';",
        ),
    ]
