"""Identifier-only audit port for application services in more than one runtime."""

from django.db import migrations

FORWARD = r'''
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION audit_workspace_resource_event(p_id uuid,p_action text,p_organisation uuid,
                                              p_target uuid,p_actor uuid,p_request text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_action IS NULL OR length(p_action)>100
     OR p_action !~ '^workspace(\.[a-z][a-z0-9_]*){1,3}$'
     OR p_id IS NULL OR p_organisation IS NULL OR p_target IS NULL OR p_actor IS NULL
  THEN RAISE EXCEPTION 'workspace audit action refused' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.identity_identity WHERE id=p_actor AND organisation_id=p_organisation)
  THEN RAISE EXCEPTION 'workspace audit actor scope refused' USING ERRCODE='23514'; END IF;
  IF p_request IS NOT NULL AND p_request !~ '^[A-Za-z0-9_-]{8,64}$'
  THEN RAISE EXCEPTION 'workspace audit request id refused' USING ERRCODE='23514'; END IF;
  INSERT INTO public.audit_auditevent(id,action,actor_type,actor_id,actor_label,organisation_id,
                                    target_urn,request_id,retention_class,metadata)
  VALUES(p_id,p_action,'tenant',p_actor,'urn:kodera:identity:'||p_actor,p_organisation,
         'urn:kodera:workspace-resource:'||p_target,p_request,'standard','{}'::jsonb);
END $$;
REVOKE ALL ON FUNCTION audit_workspace_resource_event(uuid,text,uuid,uuid,uuid,text) FROM PUBLIC;
'''
REVERSE = r'''
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP FUNCTION audit_workspace_resource_event(uuid,text,uuid,uuid,uuid,text);
'''


class Migration(migrations.Migration):
    dependencies = [('audit', '0002_guards'), ('identity', '0006_discovery_quotas')]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
