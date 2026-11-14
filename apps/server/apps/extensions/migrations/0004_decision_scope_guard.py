"""An observation binds one ambiguous attempt to its current owning workspace principal."""
from django.db import migrations

FORWARD=r'''
CREATE FUNCTION extension_decision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Extension decision evidence immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.extensions_deliveryattempt a
   JOIN public.extensions_delivery d ON d.id=a.delivery_id
   JOIN public.extensions_installation i ON i.id=d.installation_id
   JOIN public.workspaces_workspace w ON w.id=i.workspace_id
   JOIN public.orgs_membership m ON m.organisation_id=w.organisation_id
   WHERE a.id=NEW.attempt_id AND a.delivery_id=NEW.delivery_id AND a.outcome='uncertain'
     AND a.number=d.attempts AND d.state='needs_reconciliation' AND m.id=NEW.decided_by_id
     AND m.role IN ('org_owner','org_admin') AND m.state='active' AND m.deleted_at IS NULL AND m.accepted_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Extension decision scope or current authority invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION extension_decision_guard() FROM PUBLIC;
CREATE TRIGGER extension_decision_guard BEFORE INSERT OR UPDATE OR DELETE ON extensions_deliverydecision
 FOR EACH ROW EXECUTE FUNCTION extension_decision_guard();
'''

class Migration(migrations.Migration):
    dependencies=[("extensions","0003_observed_delivery_decisions")]
    operations=[
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
migrations.RunSQL(FORWARD,"DROP TRIGGER extension_decision_guard ON extensions_deliverydecision; DROP FUNCTION extension_decision_guard();"),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
