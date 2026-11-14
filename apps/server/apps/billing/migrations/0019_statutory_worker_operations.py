"""Narrow operator contract close, legacy qualification and due-only hard purge."""

from django.db import migrations

FORWARD = r"""

SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE FUNCTION billing_contract_clock_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.purge_after IS NOT NULL AND OLD.purge_after<clock_timestamp()
   AND public.retention_context('purge',TG_TABLE_NAME,OLD.id) IS NOT NULL THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'contract record not due or immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.contract_ended_at IS NOT NULL AND NEW IS DISTINCT FROM OLD
 THEN RAISE EXCEPTION 'closed contract record immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.contract_ended_at IS NOT NULL OR NEW.purge_after IS NOT NULL OR NEW.close_reason IS NOT NULL OR NEW.close_evidence_ref IS NOT NULL
  THEN RAISE EXCEPTION 'contract close requires authority' USING ERRCODE='23514'; END IF;
 ELSIF (NEW.contract_ended_at,NEW.purge_after,NEW.close_reason,NEW.close_evidence_ref)
 IS DISTINCT FROM (OLD.contract_ended_at,OLD.purge_after,OLD.close_reason,OLD.close_evidence_ref) THEN
  IF OLD.contract_ended_at IS NOT NULL OR public.retention_context('close',TG_TABLE_NAME,NEW.id) IS NULL
   OR NEW.contract_ended_at IS NULL OR NEW.purge_after IS DISTINCT FROM ((NEW.contract_ended_at AT TIME ZONE 'UTC')+interval '10 years') AT TIME ZONE 'UTC'
   OR NEW.close_reason IS NULL OR NEW.close_evidence_ref !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
  THEN RAISE EXCEPTION 'contract clock immutable or incomplete' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_contract_retention BEFORE INSERT OR UPDATE OR DELETE ON billing_order FOR EACH ROW EXECUTE FUNCTION billing_contract_clock_guard();
CREATE TRIGGER a_contract_retention BEFORE INSERT OR UPDATE OR DELETE ON billing_subscription FOR EACH ROW EXECUTE FUNCTION billing_contract_clock_guard();
CREATE TRIGGER a_contract_retention BEFORE INSERT OR UPDATE OR DELETE ON legal_dpa FOR EACH ROW EXECUTE FUNCTION billing_contract_clock_guard();
CREATE TRIGGER a_contract_retention BEFORE INSERT OR UPDATE OR DELETE ON legal_acceptance FOR EACH ROW EXECUTE FUNCTION billing_contract_clock_guard();
CREATE OR REPLACE FUNCTION legal_dpa_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['state', 'superseded_by_id', 'updated_at'];
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('legal_dpa','legal_acceptance')
 AND public.retention_context('close',TG_TABLE_NAME,NEW.id) IS NOT NULL
 AND (to_jsonb(NEW)-ARRAY['contract_ended_at','purge_after','close_reason','close_evidence_ref'])
 IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['contract_ended_at','purge_after','close_reason','close_evidence_ref'])
 THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' AND TG_TABLE_NAME IN ('legal_dpa','legal_acceptance')
 AND public.retention_context('purge',TG_TABLE_NAME,OLD.id) IS NOT NULL
 AND (to_jsonb(OLD)->>'purge_after')::timestamptz<clock_timestamp() THEN RETURN OLD; END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='legal_dpa_immutable',
      MESSAGE='A DPA is never deleted';
  END IF;
  IF OLD.state = 'generated' AND (
       NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
       OR NEW.template_id IS DISTINCT FROM OLD.template_id
       OR NEW.pack_code IS DISTINCT FROM OLD.pack_code OR NEW.locale IS DISTINCT FROM OLD.locale
       OR NEW.version IS DISTINCT FROM OLD.version OR NEW.sha256 IS DISTINCT FROM OLD.sha256
       OR NEW.sub_processors IS DISTINCT FROM OLD.sub_processors) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='legal_dpa_immutable',
      MESSAGE='A DPA keeps the template it was generated from';
  END IF;
  IF OLD.state = 'accepted' AND (
       (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable)
       OR NEW.state NOT IN ('accepted', 'superseded')
       OR (NEW.state = 'accepted' AND NEW.superseded_by_id IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='legal_dpa_immutable',
      MESSAGE='An accepted DPA only ever moves to superseded';
  END IF;
  IF OLD.state = 'superseded' AND (
       (to_jsonb(OLD) - ARRAY['superseded_by_id', 'updated_at'])
         IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['superseded_by_id', 'updated_at'])
       OR (OLD.superseded_by_id IS NOT NULL
           AND NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='legal_dpa_immutable',
      MESSAGE='A superseded DPA never changes';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION legal_dpa_guard() SECURITY DEFINER; ALTER FUNCTION legal_dpa_guard() SET search_path=pg_catalog,public,pg_temp; REVOKE ALL ON FUNCTION legal_dpa_guard() FROM PUBLIC;
CREATE OR REPLACE FUNCTION legal_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('legal_dpa','legal_acceptance')
 AND public.retention_context('close',TG_TABLE_NAME,NEW.id) IS NOT NULL
 AND (to_jsonb(NEW)-ARRAY['contract_ended_at','purge_after','close_reason','close_evidence_ref'])
 IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['contract_ended_at','purge_after','close_reason','close_evidence_ref'])
 THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' AND TG_TABLE_NAME IN ('legal_dpa','legal_acceptance')
 AND public.retention_context('purge',TG_TABLE_NAME,OLD.id) IS NOT NULL
 AND (to_jsonb(OLD)->>'purge_after')::timestamptz<clock_timestamp() THEN RETURN OLD; END IF;

  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT=TG_ARGV[0],
    MESSAGE='A legal record is never changed or deleted';
END $$;
ALTER FUNCTION legal_append_only_guard() SECURITY DEFINER; ALTER FUNCTION legal_append_only_guard() SET search_path=pg_catalog,public,pg_temp; REVOKE ALL ON FUNCTION legal_append_only_guard() FROM PUBLIC;
CREATE OR REPLACE FUNCTION billing_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb;
BEGIN
 IF TG_OP='DELETE' AND TG_TABLE_NAME='billing_billingartifact' THEN
  item:=to_jsonb(OLD);
  IF (item->>'invoice_id' IS NOT NULL AND public.retention_context('purge','billing_invoice',(item->>'invoice_id')::uuid) IS NOT NULL)
   OR (item->>'credit_note_id' IS NOT NULL AND public.retention_context('purge','billing_creditnote',(item->>'credit_note_id')::uuid) IS NOT NULL)
  THEN RETURN OLD; END IF;
 END IF;
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_evidence_immutable',
    MESSAGE='Billing evidence is append-only';
END $$;
ALTER FUNCTION billing_evidence_immutable() SECURITY DEFINER; ALTER FUNCTION billing_evidence_immutable() SET search_path=pg_catalog,public,pg_temp; REVOKE ALL ON FUNCTION billing_evidence_immutable() FROM PUBLIC;

CREATE FUNCTION retention_current_operator(p_actor uuid) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM i.id FROM public.identity_identity i JOIN public.identity_user u ON u.id=i.user_id
 JOIN public.identity_staffrole r ON r.identity_id=i.id WHERE i.id=p_actor AND i.realm='kodera-staff'
 AND i.enabled AND i.deleted_at IS NULL AND u.enabled AND u.deleted_at IS NULL
 AND r.role='staff_operator' AND r.revoked_at IS NULL FOR SHARE OF i,u,r;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION retention_current_operator(uuid) FROM PUBLIC;

CREATE FUNCTION billing_close_contract(p_order uuid,p_ended timestamptz,p_reason text,p_evidence text,p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='10s' AS $$
DECLARE ord public.billing_order%ROWTYPE; sub public.billing_subscription%ROWTYPE;
 dpa public.legal_dpa%ROWTYPE; table_name text; row_id uuid; payload jsonb; deadline timestamptz;
BEGIN
 IF p_ended IS NULL OR p_ended>clock_timestamp() THEN RAISE EXCEPTION 'contract close clock refused' USING ERRCODE='23514'; END IF;
 IF p_reason IS NULL OR p_reason NOT IN ('controller_instruction','contract_ended','unpaid_termination')
 OR p_evidence IS NULL OR p_evidence !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 OR NOT public.retention_current_operator(p_actor)
 THEN RAISE EXCEPTION 'contract close authority refused' USING ERRCODE='23514'; END IF;
 SELECT * INTO ord FROM public.billing_order WHERE id=p_order FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'contract order absent' USING ERRCODE='23514'; END IF;
 SELECT * INTO sub FROM public.billing_subscription WHERE order_id=ord.id FOR UPDATE;
 IF NOT FOUND OR sub.organisation_id<>ord.organisation_id OR sub.tenant_id IS DISTINCT FROM ord.tenant_id
 OR sub.state<>'cancelled' OR ord.state NOT IN ('cancelled','fulfilled') THEN RAISE EXCEPTION 'contract subscription binding' USING ERRCODE='23514'; END IF;
 SELECT * INTO dpa FROM public.legal_dpa WHERE id=ord.dpa_id FOR UPDATE;
 IF NOT FOUND OR dpa.organisation_id<>ord.organisation_id OR dpa.tenant_id IS DISTINCT FROM ord.tenant_id OR dpa.accepted_at IS NULL
 OR dpa.accepted_at>p_ended OR ord.created_at>p_ended OR ord.contract_ended_at IS NOT NULL
 OR sub.contract_ended_at IS NOT NULL OR dpa.contract_ended_at IS NOT NULL
 THEN RAISE EXCEPTION 'contract legal binding or duplicate close' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public.legal_acceptance WHERE order_id=ord.id ORDER BY id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.legal_acceptance WHERE order_id=ord.id AND dpa_id=dpa.id)
 OR EXISTS(SELECT 1 FROM public.legal_acceptance WHERE order_id=ord.id
 AND (organisation_id<>ord.organisation_id OR (dpa_id IS NOT NULL AND dpa_id<>dpa.id) OR accepted_at>p_ended OR contract_ended_at IS NOT NULL))
 THEN RAISE EXCEPTION 'contract acceptance binding' USING ERRCODE='23514'; END IF;
 deadline:=((p_ended AT TIME ZONE 'UTC')+interval '10 years') AT TIME ZONE 'UTC';
 FOR table_name,row_id IN SELECT 'billing_order',ord.id UNION ALL SELECT 'billing_subscription',sub.id
 UNION ALL SELECT 'legal_dpa',dpa.id UNION ALL SELECT 'legal_acceptance',id FROM public.legal_acceptance WHERE order_id=ord.id
 LOOP
  INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'close',table_name,row_id,'{}');
  CASE table_name
   WHEN 'billing_order' THEN
    UPDATE public.billing_order SET contract_ended_at=p_ended,purge_after=deadline,
     close_reason=p_reason,close_evidence_ref=p_evidence WHERE id=row_id
     RETURNING to_jsonb(billing_order.*) INTO payload;
   WHEN 'billing_subscription' THEN
    UPDATE public.billing_subscription SET contract_ended_at=p_ended,purge_after=deadline,
     close_reason=p_reason,close_evidence_ref=p_evidence WHERE id=row_id
     RETURNING to_jsonb(billing_subscription.*) INTO payload;
   WHEN 'legal_dpa' THEN
    UPDATE public.legal_dpa SET contract_ended_at=p_ended,purge_after=deadline,
     close_reason=p_reason,close_evidence_ref=p_evidence WHERE id=row_id
     RETURNING to_jsonb(legal_dpa.*) INTO payload;
   WHEN 'legal_acceptance' THEN
    UPDATE public.legal_acceptance SET contract_ended_at=p_ended,purge_after=deadline,
     close_reason=p_reason,close_evidence_ref=p_evidence WHERE id=row_id
     RETURNING to_jsonb(legal_acceptance.*) INTO payload;
  END CASE;
  INSERT INTO public.billing_statutoryrecord(id,created_at,updated_at,source_table,source_id,organisation_reference,
   basis,event_at,financial_year_closed_at,purge_after,authority_ref,payload,payload_sha256)
   VALUES(public.retention_new_uuid7(),clock_timestamp(),clock_timestamp(),table_name,row_id,ord.organisation_id,'contract',p_ended,NULL,deadline,p_evidence,payload,
   encode(sha256(convert_to(payload::text,'UTF8')),'hex'));
  DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
   AND purpose='close' AND source_table=table_name AND source_id=row_id;
 END LOOP;
 INSERT INTO public.audit_auditevent(id,occurred_at,actor_type,actor_id,actor_label,organisation_id,action,target_urn,retention_class,metadata)
 VALUES(public.retention_new_uuid7(),clock_timestamp(),'staff',p_actor,'urn:kodera:identity:'||p_actor,ord.organisation_id,
 'dpa.contract_closed','urn:kodera:organisation:'||ord.organisation_id,'standard',jsonb_build_object(
 'dpa_acceptance_id',dpa.id,'order_id',ord.id,'subscription_id',sub.id,'organisation_id',ord.organisation_id,
 'contract_ended_at',p_ended,'close_reason',p_reason,'close_evidence_ref',p_evidence));
END $$;
REVOKE ALL ON FUNCTION billing_close_contract(uuid,timestamptz,text,text,uuid) FROM PUBLIC;

CREATE FUNCTION billing_qualify_legacy_accounting(p_table text,p_id uuid,p_event timestamptz,p_evidence text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='10s' AS $$
DECLARE payload jsonb; clock jsonb; table_name text; row_id uuid; issuer text; document_number text;
BEGIN
 IF p_table NOT IN ('billing_invoice','billing_creditnote','billing_payment')
 OR p_evidence IS NULL OR p_evidence !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 THEN RAISE EXCEPTION 'legacy accounting qualification refused' USING ERRCODE='23514'; END IF;
 CASE p_table
  WHEN 'billing_invoice' THEN
   SELECT to_jsonb(t) INTO payload FROM public.billing_invoice t WHERE id=p_id FOR UPDATE;
  WHEN 'billing_creditnote' THEN
   SELECT to_jsonb(t) INTO payload FROM public.billing_creditnote t WHERE id=p_id FOR UPDATE;
  WHEN 'billing_payment' THEN
   SELECT to_jsonb(t) INTO payload FROM public.billing_payment t WHERE id=p_id FOR UPDATE;
  ELSE RAISE EXCEPTION 'null values cannot be formatted as an SQL identifier' USING ERRCODE='22004';
 END CASE;
 IF payload IS NULL OR payload->>'accounting_event_at' IS NOT NULL
 OR (p_table IN ('billing_invoice','billing_creditnote') AND (payload->>'issued_at')::timestamptz IS DISTINCT FROM p_event)
 OR (p_table='billing_payment' AND (payload->>'last_event_at')::timestamptz IS DISTINCT FROM p_event)
 OR p_event IS NULL THEN RAISE EXCEPTION 'legacy accounting event proof mismatch' USING ERRCODE='23514'; END IF;
 IF p_table='billing_payment' THEN SELECT issuer_siren,number INTO issuer,document_number FROM public.billing_invoice WHERE id=(payload->>'invoice_id')::uuid;
 ELSE issuer:=payload->>'issuer_siren'; document_number:=payload->>'number'; END IF;
 clock:=public.billing_accounting_clock(issuer,p_event);
 clock:=clock||jsonb_build_object('qualification_evidence_ref',p_evidence,'document_number_snapshot',document_number);
 FOR table_name,row_id IN SELECT p_table,p_id UNION ALL SELECT 'billing_invoiceline',id FROM public.billing_invoiceline
 WHERE p_table='billing_invoice' AND invoice_id=p_id UNION ALL SELECT 'billing_creditnoteline',id FROM public.billing_creditnoteline
 WHERE p_table='billing_creditnote' AND credit_note_id=p_id LOOP
  INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'qualify',table_name,row_id,clock);
  CASE table_name
   WHEN 'billing_invoice' THEN
    UPDATE public.billing_invoice SET accounting_event_at=p_event,
     financial_year_closed_at=(clock->>'financial_year_closed_at')::timestamptz,
     purge_after=(clock->>'purge_after')::timestamptz,
     retention_authority_ref=clock->>'retention_authority_ref' WHERE id=row_id;
   WHEN 'billing_creditnote' THEN
    UPDATE public.billing_creditnote SET accounting_event_at=p_event,
     financial_year_closed_at=(clock->>'financial_year_closed_at')::timestamptz,
     purge_after=(clock->>'purge_after')::timestamptz,
     retention_authority_ref=clock->>'retention_authority_ref' WHERE id=row_id;
   WHEN 'billing_payment' THEN
    UPDATE public.billing_payment SET accounting_event_at=p_event,
     financial_year_closed_at=(clock->>'financial_year_closed_at')::timestamptz,
     purge_after=(clock->>'purge_after')::timestamptz,
     retention_authority_ref=clock->>'retention_authority_ref' WHERE id=row_id;
   WHEN 'billing_invoiceline' THEN
    UPDATE public.billing_invoiceline SET accounting_event_at=p_event,
     financial_year_closed_at=(clock->>'financial_year_closed_at')::timestamptz,
     purge_after=(clock->>'purge_after')::timestamptz,
     retention_authority_ref=clock->>'retention_authority_ref' WHERE id=row_id;
   WHEN 'billing_creditnoteline' THEN
    UPDATE public.billing_creditnoteline SET accounting_event_at=p_event,
     financial_year_closed_at=(clock->>'financial_year_closed_at')::timestamptz,
     purge_after=(clock->>'purge_after')::timestamptz,
     retention_authority_ref=clock->>'retention_authority_ref' WHERE id=row_id;
  END CASE;
  DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
   AND purpose='qualify' AND source_table=table_name AND source_id=row_id;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION billing_qualify_legacy_accounting(text,uuid,timestamptz,text) FROM PUBLIC;

CREATE FUNCTION billing_purge_due_record(p_table text,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='10s' AS $$
DECLARE payload jsonb; deadline timestamptz;
BEGIN
 IF p_table NOT IN ('billing_invoice','billing_invoiceline','billing_creditnote','billing_creditnoteline','billing_payment',
 'billing_order','billing_subscription','legal_dpa','legal_acceptance') THEN RAISE EXCEPTION 'statutory table refused' USING ERRCODE='23514'; END IF;
 CASE p_table
  WHEN 'billing_invoice' THEN
   SELECT to_jsonb(t) INTO payload FROM public.billing_invoice t WHERE id=p_id FOR UPDATE;
  WHEN 'billing_invoiceline' THEN
   SELECT to_jsonb(t) INTO payload FROM public.billing_invoiceline t WHERE id=p_id FOR UPDATE;
  WHEN 'billing_creditnote' THEN
   SELECT to_jsonb(t) INTO payload FROM public.billing_creditnote t WHERE id=p_id FOR UPDATE;
  WHEN 'billing_creditnoteline' THEN
   SELECT to_jsonb(t) INTO payload FROM public.billing_creditnoteline t WHERE id=p_id FOR UPDATE;
  WHEN 'billing_payment' THEN
   SELECT to_jsonb(t) INTO payload FROM public.billing_payment t WHERE id=p_id FOR UPDATE;
  WHEN 'billing_order' THEN
   SELECT to_jsonb(t) INTO payload FROM public.billing_order t WHERE id=p_id FOR UPDATE;
  WHEN 'billing_subscription' THEN
   SELECT to_jsonb(t) INTO payload FROM public.billing_subscription t WHERE id=p_id FOR UPDATE;
  WHEN 'legal_dpa' THEN
   SELECT to_jsonb(t) INTO payload FROM public.legal_dpa t WHERE id=p_id FOR UPDATE;
  WHEN 'legal_acceptance' THEN
   SELECT to_jsonb(t) INTO payload FROM public.legal_acceptance t WHERE id=p_id FOR UPDATE;
  ELSE RAISE EXCEPTION 'null values cannot be formatted as an SQL identifier' USING ERRCODE='22004';
 END CASE;
 IF payload IS NULL THEN RETURN false; END IF;
 deadline:=(payload->>'purge_after')::timestamptz;
 IF deadline IS NULL OR deadline>=clock_timestamp()
 OR NOT EXISTS(SELECT 1 FROM public.billing_statutoryrecord WHERE source_table=p_table AND source_id=p_id AND purge_after=deadline)
 THEN RAISE EXCEPTION 'statutory record not due or unqualified' USING ERRCODE='23514'; END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'purge',p_table,p_id,'{}');
 BEGIN
  CASE p_table
   WHEN 'billing_invoice' THEN DELETE FROM public.billing_billingartifact WHERE invoice_id=p_id; DELETE FROM public.billing_invoice WHERE id=p_id;
   WHEN 'billing_invoiceline' THEN DELETE FROM public.billing_invoiceline WHERE id=p_id;
   WHEN 'billing_creditnote' THEN DELETE FROM public.billing_billingartifact WHERE credit_note_id=p_id; DELETE FROM public.billing_creditnote WHERE id=p_id;
   WHEN 'billing_creditnoteline' THEN DELETE FROM public.billing_creditnoteline WHERE id=p_id;
   WHEN 'billing_payment' THEN DELETE FROM public.billing_payment WHERE id=p_id;
   WHEN 'billing_order' THEN DELETE FROM public.billing_order WHERE id=p_id;
   WHEN 'billing_subscription' THEN DELETE FROM public.billing_subscription WHERE id=p_id;
   WHEN 'legal_dpa' THEN DELETE FROM public.legal_dpa WHERE id=p_id;
   WHEN 'legal_acceptance' THEN DELETE FROM public.legal_acceptance WHERE id=p_id;
  END CASE;
  -- Force deferred FK checks inside the operation so a dependency is an explicit hold.
  SET CONSTRAINTS ALL IMMEDIATE;
 EXCEPTION WHEN foreign_key_violation THEN
  DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
  AND purpose='purge' AND source_table=p_table AND source_id=p_id;
  RETURN false;
 END;
 DELETE FROM public.billing_statutoryrecord WHERE source_table=p_table AND source_id=p_id;
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='purge' AND source_table=p_table AND source_id=p_id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION billing_purge_due_record(text,uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION billing_contract_clock_guard() FROM PUBLIC;

"""

REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DROP FUNCTION billing_purge_due_record(text,uuid);
DROP FUNCTION billing_qualify_legacy_accounting(text,uuid,timestamptz,text);
DROP FUNCTION billing_close_contract(uuid,timestamptz,text,text,uuid);
DROP FUNCTION retention_current_operator(uuid);

-- The legal and billing evidence guards go back to legal 0002 and billing 0013, with those
-- migrations' SECURITY INVOKER, no search_path of their own and execute rights intact.
CREATE OR REPLACE FUNCTION billing_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_evidence_immutable',
    MESSAGE='Billing evidence is append-only';
END $$;
GRANT EXECUTE ON FUNCTION billing_evidence_immutable() TO PUBLIC;
CREATE OR REPLACE FUNCTION legal_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT=TG_ARGV[0],
    MESSAGE='A legal record is never changed or deleted';
END $$;
GRANT EXECUTE ON FUNCTION legal_append_only_guard() TO PUBLIC;
CREATE OR REPLACE FUNCTION legal_dpa_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['state', 'superseded_by_id', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='legal_dpa_immutable',
      MESSAGE='A DPA is never deleted';
  END IF;
  IF OLD.state = 'generated' AND (
       NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
       OR NEW.template_id IS DISTINCT FROM OLD.template_id
       OR NEW.pack_code IS DISTINCT FROM OLD.pack_code OR NEW.locale IS DISTINCT FROM OLD.locale
       OR NEW.version IS DISTINCT FROM OLD.version OR NEW.sha256 IS DISTINCT FROM OLD.sha256
       OR NEW.sub_processors IS DISTINCT FROM OLD.sub_processors) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='legal_dpa_immutable',
      MESSAGE='A DPA keeps the template it was generated from';
  END IF;
  IF OLD.state = 'accepted' AND (
       (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable)
       OR NEW.state NOT IN ('accepted', 'superseded')
       OR (NEW.state = 'accepted' AND NEW.superseded_by_id IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='legal_dpa_immutable',
      MESSAGE='An accepted DPA only ever moves to superseded';
  END IF;
  IF OLD.state = 'superseded' AND (
       (to_jsonb(OLD) - ARRAY['superseded_by_id', 'updated_at'])
         IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['superseded_by_id', 'updated_at'])
       OR (OLD.superseded_by_id IS NOT NULL
           AND NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='legal_dpa_immutable',
      MESSAGE='A superseded DPA never changes';
  END IF;
  RETURN NEW;
END $$;
GRANT EXECUTE ON FUNCTION legal_dpa_guard() TO PUBLIC;

DROP TRIGGER a_contract_retention ON legal_acceptance;
DROP TRIGGER a_contract_retention ON legal_dpa;
DROP TRIGGER a_contract_retention ON billing_subscription;
DROP TRIGGER a_contract_retention ON billing_order;
DROP FUNCTION billing_contract_clock_guard();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("billing", "0018_statutory_accounting_guards"),
        ("legal", "0005_acceptance_close_evidence_ref_and_more"),
        ("audit", "0003_workspace_resource_writer"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
