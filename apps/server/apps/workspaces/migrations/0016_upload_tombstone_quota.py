"""Count upload reservations through the bounded post-expiry stream drain window."""

from django.db import migrations

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

FORWARD = """
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
                AND (a.completed_at IS NOT NULL OR
                     a.upload_expires_at + make_interval(secs => 300) > statement_timestamp())),
 'pages', (SELECT count(*) FROM public.docs_document d WHERE d.workspace_id=w.id AND d.deleted_at IS NULL))
FROM public.workspaces_workspace w WHERE w.id=p_workspace;
$$;
REVOKE ALL ON FUNCTION workspace_quota_usage(uuid) FROM PUBLIC;
"""

REVERSE = FORWARD.replace(
    "                AND (a.completed_at IS NOT NULL OR\n"
    "                     a.upload_expires_at + make_interval(secs => 300) > statement_timestamp())",
    "                  AND (a.completed_at IS NOT NULL OR a.upload_expires_at > statement_timestamp())",
)


assert REVERSE != FORWARD  # noqa: S101 - migration direction invariant


class Migration(migrations.Migration):
    dependencies = [("workspaces", "0015_confidential_channel_designation")]
    operations = [
        migrations.RunSQL(TIMEOUTS, migrations.RunSQL.noop),
        migrations.RunSQL(FORWARD, REVERSE),
        migrations.RunSQL(migrations.RunSQL.noop, TIMEOUTS),
    ]
