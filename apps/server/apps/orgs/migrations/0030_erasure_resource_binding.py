"""Physical payload scope is immutable before either account or organisation cutoff checks."""

from django.db import migrations

FORWARD = r"""
CREATE FUNCTION public.privacy_resource_binding_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE binding text;
BEGIN
 FOREACH binding IN ARRAY TG_ARGV LOOP
  IF NOT (to_jsonb(OLD) ? binding) OR NOT (to_jsonb(NEW) ? binding)
   OR (to_jsonb(NEW)->binding) IS DISTINCT FROM (to_jsonb(OLD)->binding)
  THEN RAISE EXCEPTION 'erasure resource authority binding immutable' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.privacy_resource_binding_guard() FROM PUBLIC;
-- Runs before aa_privacy_cutoff/ab_account_cutoff: a relocation cannot hide OLD scope.
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.media_attachment FOR EACH ROW
 EXECUTE FUNCTION public.privacy_resource_binding_guard('id','organisation_id','uploader_id');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.notifications_notification FOR EACH ROW
 EXECUTE FUNCTION public.privacy_resource_binding_guard('id','organisation_id','membership_id');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.notifications_pushsubscription FOR EACH ROW
 EXECUTE FUNCTION public.privacy_resource_binding_guard('id','organisation_id','membership_id','device_id');
"""


REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DROP TRIGGER a_resource_binding ON public.notifications_pushsubscription;
DROP TRIGGER a_resource_binding ON public.notifications_notification;
DROP TRIGGER a_resource_binding ON public.media_attachment;
DROP FUNCTION public.privacy_resource_binding_guard();
"""


class Migration(migrations.Migration):
    dependencies = [("orgs", "0029_account_erasure_guards")]
    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RunSQL(FORWARD, REVERSE),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
