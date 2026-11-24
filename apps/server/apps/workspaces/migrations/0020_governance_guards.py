"""Freeze scopes, bilateral approval and retained revocation evidence at storage boundaries."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE FUNCTION public.channel_governance_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='workspaces_partnerchannelagreement' THEN
  IF NOT EXISTS(SELECT 1 FROM public.workspaces_channel c JOIN public.workspaces_workspace w ON w.id=c.workspace_id WHERE c.id=NEW.channel_id AND w.organisation_id=NEW.organisation_id)
   OR NOT EXISTS(SELECT 1 FROM public.workspaces_channel c JOIN public.workspaces_workspace w ON w.id=c.workspace_id WHERE c.id=NEW.partner_channel_id AND w.organisation_id=NEW.partner_organisation_id)
  THEN RAISE EXCEPTION 'partner channel organisation scope refused' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM public.workspaces_partnerchannelagreement a WHERE a.id<>NEW.id AND (a.channel_id IN (NEW.channel_id,NEW.partner_channel_id) OR a.partner_channel_id IN (NEW.channel_id,NEW.partner_channel_id)))
  THEN RAISE EXCEPTION 'a channel already has an agreement' USING ERRCODE='23514'; END IF;
  IF NEW.state IN ('proposed','active') AND EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference IN (NEW.organisation_id,NEW.partner_organisation_id))
  THEN RAISE EXCEPTION 'partner authority after privacy cutoff refused' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND (NEW.state<>'proposed' OR NEW.revision<>1)
   OR TG_OP='UPDATE' AND (
    (to_jsonb(NEW)-ARRAY['state','revision','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','updated_at'])
    OR NEW.revision<>OLD.revision+1 OR OLD.state='revoked'
    OR NOT (OLD.state='proposed' AND NEW.state IN ('active','revoked')
      OR OLD.state='active' AND NEW.state IN ('suspended','revoked')
      OR OLD.state='suspended' AND NEW.state IN ('proposed','revoked')))
  THEN RAISE EXCEPTION 'partner transition or immutable scope refused' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='workspaces_singlechannelguestgrant' THEN
  IF NOT EXISTS(SELECT 1 FROM public.workspaces_channel c JOIN public.workspaces_workspace w ON w.id=c.workspace_id WHERE c.id=NEW.single_channel_id AND w.organisation_id=NEW.organisation_id AND (NOT NEW.allow_calls OR c.kind='audio'))
  THEN RAISE EXCEPTION 'guest channel organisation scope refused' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND (
      NEW.expires_at>NEW.created_at+interval '30 days'
      OR NEW.matrix_user_id !~ '^@[^[:space:]:]+:[a-z0-9.-]+$'
      OR NEW.matrix_room_id !~ '^![^[:space:]:]+:[a-z0-9.-]+$'
      OR EXISTS(SELECT 1 FROM public.identity_identity i JOIN public.orgs_membership m ON m.user_id=i.user_id WHERE i.id=NEW.guest_identity_id AND m.state<>'removed')
      OR EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference=NEW.organisation_id)
      OR EXISTS(SELECT 1 FROM public.orgs_accounterasure a JOIN public.identity_identity i ON i.user_id=a.user_reference WHERE i.id=NEW.guest_identity_id))
  THEN RAISE EXCEPTION 'guest principal, expiry or cutoff refused' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['revoked_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','updated_at'])
    OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  THEN RAISE EXCEPTION 'guest scope and revocation are immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='workspaces_partnerchannelagreementrevision' THEN
  IF TG_OP='UPDATE' OR NOT EXISTS(SELECT 1 FROM public.workspaces_partnerchannelagreement a WHERE a.id=NEW.agreement_id AND a.state=NEW.state AND a.revision=NEW.revision
    AND NEW.acting_organisation_id IN (a.organisation_id,a.partner_organisation_id)
    AND (NEW.state<>'active' OR NEW.acting_organisation_id=a.partner_organisation_id)
    AND (NEW.state<>'proposed' OR NEW.acting_organisation_id=a.organisation_id))
  THEN RAISE EXCEPTION 'bilateral revision evidence refused' USING ERRCODE='23514'; END IF;
 ELSE
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'governance evidence is append only' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER governance_scope BEFORE INSERT OR UPDATE ON public.workspaces_partnerchannelagreement FOR EACH ROW EXECUTE FUNCTION public.channel_governance_guard();
CREATE TRIGGER governance_scope BEFORE INSERT OR UPDATE ON public.workspaces_singlechannelguestgrant FOR EACH ROW EXECUTE FUNCTION public.channel_governance_guard();
CREATE TRIGGER governance_scope BEFORE INSERT OR UPDATE ON public.workspaces_partnerchannelagreementrevision FOR EACH ROW EXECUTE FUNCTION public.channel_governance_guard();
CREATE TRIGGER governance_scope BEFORE INSERT OR UPDATE ON public.workspaces_sessioneviction FOR EACH ROW EXECUTE FUNCTION public.channel_governance_guard();
"""
REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.workspaces_partnerchannelagreement)
 OR EXISTS(SELECT 1 FROM public.workspaces_singlechannelguestgrant)
 THEN RAISE EXCEPTION 'governance rollback refuses retained authority'; END IF;
END $$;
DROP TRIGGER governance_scope ON public.workspaces_sessioneviction;
DROP TRIGGER governance_scope ON public.workspaces_partnerchannelagreementrevision;
DROP TRIGGER governance_scope ON public.workspaces_singlechannelguestgrant;
DROP TRIGGER governance_scope ON public.workspaces_partnerchannelagreement;
DROP FUNCTION public.channel_governance_guard();
"""


class Migration(migrations.Migration):
    dependencies = [('workspaces', '0019_partner_channels_and_guests')]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
