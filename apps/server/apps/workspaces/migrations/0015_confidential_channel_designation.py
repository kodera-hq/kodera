"""Immutable confidential channel designation and live attachment quota accounting (BUG-0012, BUG-0021)."""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

FORWARD = """
CREATE FUNCTION workspace_channel_confidential_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.is_confidential IS DISTINCT FROM OLD.is_confidential THEN
        RAISE EXCEPTION 'Channel confidential designation is immutable'
            USING ERRCODE='23514', CONSTRAINT='channel_confidential_immutable';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION workspace_channel_confidential_immutable() FROM PUBLIC;
CREATE TRIGGER channel_confidential_immutable
    BEFORE UPDATE ON workspaces_channel
    FOR EACH ROW EXECUTE FUNCTION workspace_channel_confidential_immutable();

CREATE OR REPLACE FUNCTION workspace_quota_usage(p_workspace uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
SELECT jsonb_build_object(
 'seats', (SELECT count(*) FROM public.orgs_membership m WHERE m.organisation_id=w.organisation_id
           AND m.state='active' AND m.accepted_at IS NOT NULL AND m.deleted_at IS NULL)
          +(SELECT count(*) FROM public.orgs_invitation i WHERE i.organisation_id=w.organisation_id
            AND i.state='pending' AND i.expires_at>statement_timestamp()
            AND NOT EXISTS(SELECT 1 FROM public.orgs_membership m JOIN public.identity_user u ON u.id=m.user_id
                           WHERE m.organisation_id=i.organisation_id AND m.state='active'
                           AND m.deleted_at IS NULL AND m.accepted_at IS NOT NULL AND lower(u.email)=i.email)),
 'mediaBytes', (SELECT coalesce(sum(a.size_bytes),0) FROM public.media_attachment a
                WHERE a.organisation_id=w.organisation_id
                  AND (a.completed_at IS NOT NULL OR a.upload_expires_at > statement_timestamp())),
 'pages', (SELECT count(*) FROM public.docs_document d WHERE d.workspace_id=w.id AND d.deleted_at IS NULL))
FROM public.workspaces_workspace w WHERE w.id=p_workspace;
$$;
REVOKE ALL ON FUNCTION workspace_quota_usage(uuid) FROM PUBLIC;
"""

REVERSE = """
CREATE OR REPLACE FUNCTION workspace_quota_usage(p_workspace uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
SELECT jsonb_build_object(
 'seats', (SELECT count(*) FROM public.orgs_membership m WHERE m.organisation_id=w.organisation_id
           AND m.state='active' AND m.accepted_at IS NOT NULL AND m.deleted_at IS NULL)
          +(SELECT count(*) FROM public.orgs_invitation i WHERE i.organisation_id=w.organisation_id
            AND i.state='pending' AND i.expires_at>statement_timestamp()
            AND NOT EXISTS(SELECT 1 FROM public.orgs_membership m JOIN public.identity_user u ON u.id=m.user_id
                           WHERE m.organisation_id=i.organisation_id AND m.state='active'
                           AND m.deleted_at IS NULL AND m.accepted_at IS NOT NULL AND lower(u.email)=i.email)),
 'mediaBytes', (SELECT coalesce(sum(a.size_bytes),0) FROM public.media_attachment a WHERE a.organisation_id=w.organisation_id),
 'pages', (SELECT count(*) FROM public.docs_document d WHERE d.workspace_id=w.id AND d.deleted_at IS NULL))
FROM public.workspaces_workspace w WHERE w.id=p_workspace;
$$;
REVOKE ALL ON FUNCTION workspace_quota_usage(uuid) FROM PUBLIC;

DROP TRIGGER IF EXISTS channel_confidential_immutable ON workspaces_channel;
DROP FUNCTION IF EXISTS workspace_channel_confidential_immutable();
"""


class Migration(migrations.Migration):
    dependencies = [("workspaces", "0014_iam_scope_guards")]

    operations = [
        migrations.RunSQL(TIMEOUTS, migrations.RunSQL.noop),
        migrations.AddField(
            model_name="channel",
            name="is_confidential",
            field=models.BooleanField(default=False),
        ),
        migrations.AddConstraint(
            model_name="channel",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("is_confidential", False),
                    ("kind", "text"),
                    _connector="OR",
                ),
                name="channel_confidential_text_only",
            ),
        ),
        migrations.RunSQL(FORWARD, REVERSE),
        migrations.RunSQL(migrations.RunSQL.noop, TIMEOUTS),
    ]
