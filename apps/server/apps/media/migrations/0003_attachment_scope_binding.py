"""Bind attachments to explicit channel or Matrix DM scopes and guard completed row deletion."""

import django.db.models.deletion
from django.db import migrations, models

ROOM_ID_REGEX = r"^![!-9;-~]{1,128}:[A-Za-z0-9.:-]{1,253}$"

FORWARD_SQL = """
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE OR REPLACE FUNCTION media_attachment_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.orgs_membership
        WHERE id = NEW.uploader_id AND organisation_id = NEW.organisation_id
    ) THEN
        RAISE EXCEPTION 'Attachment uploader is outside its organisation'
            USING ERRCODE = '23514', CONSTRAINT = 'media_attachment_same_org';
    END IF;
    IF NEW.channel_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.workspaces_channel c
        JOIN public.workspaces_workspace w ON w.id = c.workspace_id
        WHERE c.id = NEW.channel_id AND w.organisation_id = NEW.organisation_id
    ) THEN
        RAISE EXCEPTION 'Attachment channel is outside its organisation'
            USING ERRCODE = '23514', CONSTRAINT = 'media_attachment_same_org';
    END IF;
    IF TG_OP = 'UPDATE' AND (
        NEW.channel_id IS DISTINCT FROM OLD.channel_id
        OR NEW.room_id IS DISTINCT FROM OLD.room_id
    ) THEN
        RAISE EXCEPTION 'Attachment scope binding is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'media_attachment_scope_immutable';
    END IF;
    IF TG_OP = 'UPDATE' AND (
        (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
        OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
    ) THEN
        RAISE EXCEPTION 'Attachment terminal state is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'media_attachment_state_immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION media_attachment_delete_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF OLD.completed_at IS NULL AND OLD.upload_expires_at <= clock_timestamp() THEN
        RETURN OLD;
    END IF;
    IF to_regprocedure('public.privacy_erasure_context(uuid)') IS NOT NULL
       AND public.privacy_erasure_context(OLD.organisation_id) THEN
        RETURN OLD;
    END IF;
    IF to_regprocedure('public.privacy_account_context(uuid)') IS NOT NULL
       AND EXISTS (
           SELECT 1 FROM public.orgs_membership m
           JOIN public.orgs_organisation o ON o.id = OLD.organisation_id
           WHERE m.id = OLD.uploader_id
             AND o.is_default_community
             AND public.privacy_account_context(m.user_id)
       ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Attachment deletion requires expired pending status or scoped erasure authority'
        USING ERRCODE = '23514', CONSTRAINT = 'media_attachment_completed_immutable';
END;
$$;
REVOKE ALL ON FUNCTION media_attachment_delete_guard() FROM PUBLIC;

CREATE TRIGGER media_attachment_delete_guard
    BEFORE DELETE ON media_attachment
    FOR EACH ROW EXECUTE FUNCTION media_attachment_delete_guard();
"""

REVERSE_SQL = """
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP TRIGGER media_attachment_delete_guard ON media_attachment;
DROP FUNCTION media_attachment_delete_guard();
CREATE OR REPLACE FUNCTION media_attachment_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM orgs_membership WHERE id=NEW.uploader_id AND organisation_id=NEW.organisation_id) THEN
        RAISE EXCEPTION 'Attachment uploader is outside its organisation' USING ERRCODE='23514', CONSTRAINT='media_attachment_same_org';
    END IF;
    RETURN NEW;
END;
$$;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("media", "0002_attachment_scope"),
        ("workspaces", "0006_espace_structure"),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.AddField(
            model_name="attachment",
            name="channel",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.RESTRICT,
                to="workspaces.channel",
            ),
        ),
        migrations.AddField(
            model_name="attachment",
            name="room_id",
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="attachment",
            name="cancelled_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddConstraint(
            model_name="attachment",
            constraint=models.CheckConstraint(
                condition=~(models.Q(channel__isnull=False) & models.Q(room_id__isnull=False)),
                name="media_attachment_scope_exclusive",
            ),
        ),
        migrations.AddConstraint(
            model_name="attachment",
            constraint=models.CheckConstraint(
                condition=models.Q(room_id__isnull=True) | models.Q(room_id__regex=ROOM_ID_REGEX),
                name="media_attachment_room_id_valid",
            ),
        ),
        migrations.AddConstraint(
            model_name="attachment",
            constraint=models.CheckConstraint(
                condition=~(
                    models.Q(completed_at__isnull=False) & models.Q(cancelled_at__isnull=False)
                ),
                name="media_attachment_completion_cancel_exclusive",
            ),
        ),
        migrations.RunSQL(FORWARD_SQL, reverse_sql=REVERSE_SQL),
    ]
