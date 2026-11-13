"""Explicit fiscal authority and frozen, detached per-record accounting clocks."""

from django.db import migrations

FORWARD = r'''

SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE FUNCTION retention_new_uuid7() RETURNS uuid LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT (lpad(to_hex(floor(extract(epoch FROM clock_timestamp())*1000)::bigint),12,'0')||
 '7'||substring(replace(gen_random_uuid()::text,'-','') FROM 14 FOR 3)||
 substring(replace(gen_random_uuid()::text,'-','') FROM 17 FOR 16))::uuid $$;
REVOKE ALL ON FUNCTION retention_new_uuid7() FROM PUBLIC;


CREATE FUNCTION retention_canonical_inventory(p_value jsonb,p_depth integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE kind text:=jsonb_typeof(p_value); result text;
BEGIN
 IF p_value IS NULL OR p_depth>16 THEN RAISE EXCEPTION 'inventory canonical shape refused' USING ERRCODE='23514'; END IF;
 IF kind='object' THEN
  SELECT '{'||coalesce(string_agg(to_jsonb(entry.key)::text||':'||public.retention_canonical_inventory(entry.value,p_depth+1),',' ORDER BY entry.key COLLATE "C"),'')||'}'
   INTO result FROM jsonb_each(p_value) entry;
 ELSIF kind='array' THEN
  SELECT '['||coalesce(string_agg(public.retention_canonical_inventory(entry.value,p_depth+1),',' ORDER BY entry.ordinal),'')||']'
   INTO result FROM jsonb_array_elements(p_value) WITH ORDINALITY entry(value,ordinal);
 ELSIF kind='number' AND p_value::text !~ '^-?[0-9]+$' THEN
  RAISE EXCEPTION 'inventory fractional number refused' USING ERRCODE='23514';
 ELSE result:=p_value::text;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION retention_canonical_inventory(jsonb,integer) FROM PUBLIC;
CREATE FUNCTION retention_inventory_digest(p_value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE canonical text:=public.retention_canonical_inventory(p_value,0);
BEGIN
 IF octet_length(canonical)>16777216 THEN RAISE EXCEPTION 'inventory byte bound exceeded' USING ERRCODE='23514'; END IF;
 RETURN encode(sha256(convert_to(canonical,'UTF8')),'hex');
END $$;
REVOKE ALL ON FUNCTION retention_inventory_digest(jsonb) FROM PUBLIC;

CREATE TABLE retention_worker_context (
 backend integer NOT NULL, transaction bigint NOT NULL, purpose text NOT NULL,
 source_table text NOT NULL, source_id uuid NOT NULL, payload jsonb NOT NULL,
 PRIMARY KEY(backend,transaction,purpose,source_table,source_id));
REVOKE ALL ON retention_worker_context FROM PUBLIC;

CREATE FUNCTION retention_context(p_purpose text,p_table text,p_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $$ SELECT payload FROM public.retention_worker_context WHERE backend=pg_backend_pid()
 AND transaction=txid_current() AND purpose=p_purpose AND source_table=p_table AND source_id=p_id $$;
REVOKE ALL ON FUNCTION retention_context(text,text,uuid) FROM PUBLIC;

CREATE FUNCTION billing_fiscal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'fiscal authority immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('kodera-fiscal:'||NEW.issuer_siren,0));
 IF NEW.authority_ref !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone)
 OR NEW.closed_at<=NEW.starts_at
 OR EXISTS(SELECT 1 FROM billing_fiscalperiod WHERE issuer_siren=NEW.issuer_siren
           AND starts_at<NEW.closed_at AND closed_at>NEW.starts_at)
 THEN RAISE EXCEPTION 'fiscal authority invalid or overlapping' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_fiscal_immutable BEFORE INSERT OR UPDATE OR DELETE ON billing_fiscalperiod
FOR EACH ROW EXECUTE FUNCTION billing_fiscal_guard();

CREATE FUNCTION billing_accounting_clock(p_issuer text,p_event timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE period public.billing_fiscalperiod%ROWTYPE;
BEGIN
 SELECT * INTO period FROM public.billing_fiscalperiod WHERE issuer_siren=p_issuer
 AND starts_at<=p_event AND closed_at>p_event FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'explicit fiscal authority absent' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('accounting_event_at',p_event,
 'financial_year_closed_at',period.closed_at,
 'purge_after',((period.closed_at AT TIME ZONE period.timezone)+interval '10 years') AT TIME ZONE period.timezone,
 'retention_authority_ref',period.authority_ref);
END $$;
REVOKE ALL ON FUNCTION billing_accounting_clock(text,timestamptz) FROM PUBLIC;

CREATE FUNCTION billing_retention_clock_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE clock jsonb; parent jsonb; event timestamptz; issuer text; document_number text; initial boolean;
BEGIN
 initial := TG_OP='INSERT';
 IF TG_TABLE_NAME='billing_payment' AND TG_OP='UPDATE' THEN
 IF (NEW.id,NEW.organisation_id,NEW.invoice_id,NEW.provider,NEW.provider_ref,NEW.amount_minor,NEW.currency)
 IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.invoice_id,OLD.provider,OLD.provider_ref,OLD.amount_minor,OLD.currency)
 THEN RAISE EXCEPTION 'payment accounting binding immutable' USING ERRCODE='23514'; END IF;
 END IF;
 clock:=public.retention_context('qualify',TG_TABLE_NAME,NEW.id);
 IF clock IS NOT NULL THEN NEW:=jsonb_populate_record(NEW,clock); RETURN NEW; END IF;

 IF TG_OP='UPDATE' AND OLD.accounting_event_at IS NOT NULL THEN
  IF (NEW.accounting_event_at,NEW.financial_year_closed_at,NEW.purge_after,NEW.retention_authority_ref,NEW.document_number_snapshot)
   IS DISTINCT FROM (OLD.accounting_event_at,OLD.financial_year_closed_at,OLD.purge_after,OLD.retention_authority_ref,OLD.document_number_snapshot)
  THEN RAISE EXCEPTION 'accounting clock immutable' USING ERRCODE='23514', CONSTRAINT=CASE TG_TABLE_NAME WHEN 'billing_invoice' THEN 'billing_invoice_immutable' WHEN 'billing_invoiceline' THEN 'billing_invoiceline_immutable' WHEN 'billing_creditnote' THEN 'billing_creditnote_immutable' WHEN 'billing_creditnoteline' THEN 'billing_creditnote_immutable' ELSE 'billing_payment_retention_immutable' END; END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='billing_invoice' THEN
  -- Preserve the existing transition/check diagnostics before deriving a valid issue clock.
  IF NEW.state<>'draft' AND (NEW.number IS NULL OR NEW.issued_at IS NULL OR NEW.due_at IS NULL) THEN RETURN NEW; END IF;
  IF NEW.state='draft' THEN clock:='{}';
  ELSE
   IF NOT initial AND OLD.state<>'draft' THEN
    RAISE EXCEPTION 'legacy accounting record requires qualification' USING ERRCODE='23514';
   END IF;
   event:=NEW.issued_at; issuer:=NEW.issuer_siren;
   clock:=public.billing_accounting_clock(issuer,event)||jsonb_build_object('document_number_snapshot',NEW.number);
   INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'clock',TG_TABLE_NAME,NEW.id,clock);
   UPDATE public.billing_invoiceline SET
    accounting_event_at=(clock->>'accounting_event_at')::timestamptz,
    financial_year_closed_at=(clock->>'financial_year_closed_at')::timestamptz,
    purge_after=(clock->>'purge_after')::timestamptz,
    retention_authority_ref=clock->>'retention_authority_ref' WHERE invoice_id=NEW.id;
   DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
    AND purpose='clock' AND source_table=TG_TABLE_NAME AND source_id=NEW.id;
  END IF;
 ELSIF TG_TABLE_NAME='billing_invoiceline' THEN
  clock:=public.retention_context('clock','billing_invoice',NEW.invoice_id);
  IF clock IS NULL THEN
   SELECT to_jsonb(i) INTO parent FROM public.billing_invoice i WHERE id=NEW.invoice_id;
   IF parent->>'state'='draft' THEN clock:='{}'; ELSE clock:=parent; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='billing_creditnote' THEN
  clock:=public.billing_accounting_clock(NEW.issuer_siren,NEW.issued_at)||jsonb_build_object('document_number_snapshot',NEW.number);
 ELSIF TG_TABLE_NAME='billing_creditnoteline' THEN
  SELECT to_jsonb(n) INTO clock FROM public.billing_creditnote n WHERE id=NEW.credit_note_id;
 ELSE
  IF TG_OP='UPDATE' AND (NEW.id,NEW.organisation_id,NEW.invoice_id,NEW.provider,NEW.provider_ref,NEW.amount_minor,NEW.currency)
   IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.invoice_id,OLD.provider,OLD.provider_ref,OLD.amount_minor,OLD.currency)
  THEN RAISE EXCEPTION 'payment accounting binding immutable' USING ERRCODE='23514'; END IF;
  IF NEW.last_event_at IS NULL THEN clock:='{}';
  ELSE
   SELECT issuer_siren,number INTO issuer,document_number FROM public.billing_invoice WHERE id=NEW.invoice_id;
   clock:=public.billing_accounting_clock(issuer,NEW.last_event_at)||jsonb_build_object('document_number_snapshot',document_number);
  END IF;
 END IF;
 IF clock='{}'::jsonb THEN
  IF NEW.accounting_event_at IS NOT NULL OR NEW.financial_year_closed_at IS NOT NULL
   OR NEW.purge_after IS NOT NULL OR NEW.retention_authority_ref IS NOT NULL OR NEW.document_number_snapshot IS NOT NULL
  THEN RAISE EXCEPTION 'unissued accounting clock refused' USING ERRCODE='23514', CONSTRAINT=CASE TG_TABLE_NAME WHEN 'billing_invoice' THEN 'billing_invoice_immutable' WHEN 'billing_invoiceline' THEN 'billing_invoiceline_immutable' WHEN 'billing_creditnote' THEN 'billing_creditnote_immutable' WHEN 'billing_creditnoteline' THEN 'billing_creditnote_immutable' ELSE 'billing_payment_retention_immutable' END; END IF;
 ELSE
  -- Derive, never trust a caller-supplied date, then reject contradictory submissions.
  IF (NEW.accounting_event_at IS NOT NULL AND NEW.accounting_event_at IS DISTINCT FROM (clock->>'accounting_event_at')::timestamptz)
   OR (NEW.financial_year_closed_at IS NOT NULL AND NEW.financial_year_closed_at IS DISTINCT FROM (clock->>'financial_year_closed_at')::timestamptz)
   OR (NEW.purge_after IS NOT NULL AND NEW.purge_after IS DISTINCT FROM (clock->>'purge_after')::timestamptz)
   OR (NEW.retention_authority_ref IS NOT NULL AND NEW.retention_authority_ref IS DISTINCT FROM clock->>'retention_authority_ref')
   OR (NEW.document_number_snapshot IS NOT NULL AND NEW.document_number_snapshot IS DISTINCT FROM clock->>'document_number_snapshot')
  THEN RAISE EXCEPTION 'accounting clock mismatch' USING ERRCODE='23514', CONSTRAINT=CASE TG_TABLE_NAME WHEN 'billing_invoice' THEN 'billing_invoice_immutable' WHEN 'billing_invoiceline' THEN 'billing_invoiceline_immutable' WHEN 'billing_creditnote' THEN 'billing_creditnote_immutable' WHEN 'billing_creditnoteline' THEN 'billing_creditnote_immutable' ELSE 'billing_payment_retention_immutable' END; END IF;
  NEW.accounting_event_at:=(clock->>'accounting_event_at')::timestamptz;
  NEW.financial_year_closed_at:=(clock->>'financial_year_closed_at')::timestamptz;
  NEW.purge_after:=(clock->>'purge_after')::timestamptz;
  NEW.retention_authority_ref:=clock->>'retention_authority_ref';
  NEW.document_number_snapshot:=clock->>'document_number_snapshot';
  IF NEW.accounting_event_at IS NULL OR NEW.financial_year_closed_at IS NULL OR NEW.purge_after IS NULL
   OR NEW.retention_authority_ref IS NULL OR NEW.document_number_snapshot IS NULL THEN RAISE EXCEPTION 'complete accounting clock required' USING ERRCODE='23514', CONSTRAINT=CASE TG_TABLE_NAME WHEN 'billing_invoice' THEN 'billing_invoice_immutable' WHEN 'billing_invoiceline' THEN 'billing_invoiceline_immutable' WHEN 'billing_creditnote' THEN 'billing_creditnote_immutable' WHEN 'billing_creditnoteline' THEN 'billing_creditnote_immutable' ELSE 'billing_payment_retention_immutable' END; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_accounting_retention BEFORE INSERT OR UPDATE ON billing_invoice FOR EACH ROW EXECUTE FUNCTION billing_retention_clock_guard();
CREATE TRIGGER a_accounting_retention BEFORE INSERT OR UPDATE ON billing_invoiceline FOR EACH ROW EXECUTE FUNCTION billing_retention_clock_guard();
CREATE TRIGGER a_accounting_retention BEFORE INSERT OR UPDATE ON billing_creditnote FOR EACH ROW EXECUTE FUNCTION billing_retention_clock_guard();
CREATE TRIGGER a_accounting_retention BEFORE INSERT OR UPDATE ON billing_creditnoteline FOR EACH ROW EXECUTE FUNCTION billing_retention_clock_guard();
CREATE TRIGGER a_accounting_retention BEFORE INSERT OR UPDATE ON billing_payment FOR EACH ROW EXECUTE FUNCTION billing_retention_clock_guard();

CREATE FUNCTION billing_statutory_capture() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE payload jsonb:=to_jsonb(NEW); organisation uuid;
BEGIN
 IF NEW.accounting_event_at IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.accounting_event_at IS NOT NULL THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='billing_invoiceline' THEN
  SELECT organisation_id INTO organisation FROM public.billing_invoice WHERE id=NEW.invoice_id;
 ELSIF TG_TABLE_NAME='billing_creditnoteline' THEN
  SELECT organisation_id INTO organisation FROM public.billing_creditnote WHERE id=NEW.credit_note_id;
 ELSE organisation:=(payload->>'organisation_id')::uuid; END IF;
 INSERT INTO public.billing_statutoryrecord(id,created_at,updated_at,source_table,source_id,organisation_reference,
 basis,event_at,financial_year_closed_at,purge_after,authority_ref,qualification_evidence_ref,payload,payload_sha256)
 VALUES(public.retention_new_uuid7(),clock_timestamp(),clock_timestamp(),TG_TABLE_NAME,NEW.id,organisation,'accounting',NEW.accounting_event_at,
 NEW.financial_year_closed_at,NEW.purge_after,NEW.retention_authority_ref,public.retention_context('qualify',TG_TABLE_NAME,NEW.id)->>'qualification_evidence_ref',payload,
 encode(sha256(convert_to(payload::text,'UTF8')),'hex'));
 RETURN NEW;
END $$;
CREATE TRIGGER z_statutory_capture AFTER INSERT OR UPDATE ON billing_invoice FOR EACH ROW EXECUTE FUNCTION billing_statutory_capture();
CREATE TRIGGER z_statutory_capture AFTER INSERT OR UPDATE ON billing_invoiceline FOR EACH ROW EXECUTE FUNCTION billing_statutory_capture();
CREATE TRIGGER z_statutory_capture AFTER INSERT OR UPDATE ON billing_creditnote FOR EACH ROW EXECUTE FUNCTION billing_statutory_capture();
CREATE TRIGGER z_statutory_capture AFTER INSERT OR UPDATE ON billing_creditnoteline FOR EACH ROW EXECUTE FUNCTION billing_statutory_capture();
CREATE TRIGGER z_statutory_capture AFTER INSERT OR UPDATE ON billing_payment FOR EACH ROW EXECUTE FUNCTION billing_statutory_capture();

CREATE FUNCTION billing_statutory_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.payload_sha256 IS DISTINCT FROM encode(sha256(convert_to(NEW.payload::text,'UTF8')),'hex')
   OR NEW.purge_after<=NEW.event_at THEN RAISE EXCEPTION 'statutory snapshot binding refused' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' AND OLD.purge_after<clock_timestamp()
  AND public.retention_context('purge',OLD.source_table,OLD.source_id) IS NOT NULL THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'statutory record immutable or not due' USING ERRCODE='23514';
END $$;
CREATE TRIGGER statutory_immutable BEFORE INSERT OR UPDATE OR DELETE ON billing_statutoryrecord
 FOR EACH ROW EXECUTE FUNCTION billing_statutory_guard();
DO $patch$ DECLARE definition text; BEGIN SELECT pg_get_functiondef('billing_invoice_guard()'::regprocedure) INTO definition; definition:=regexp_replace(definition,'BEGIN',$body$BEGIN
 IF TG_OP='UPDATE' AND public.retention_context('qualify',TG_TABLE_NAME,NEW.id) IS NOT NULL
 AND (to_jsonb(NEW)-ARRAY['accounting_event_at','financial_year_closed_at','purge_after','retention_authority_ref','document_number_snapshot'])
 IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['accounting_event_at','financial_year_closed_at','purge_after','retention_authority_ref','document_number_snapshot'])
 THEN RETURN NEW; END IF;

 IF TG_OP='DELETE' AND OLD.purge_after IS NOT NULL AND OLD.purge_after<clock_timestamp()
 AND public.retention_context('purge',TG_TABLE_NAME,OLD.id) IS NOT NULL THEN RETURN OLD; END IF;
$body$); EXECUTE definition; END $patch$;
ALTER FUNCTION billing_invoice_guard() SECURITY DEFINER; ALTER FUNCTION billing_invoice_guard() SET search_path=pg_catalog,public,pg_temp; REVOKE ALL ON FUNCTION billing_invoice_guard() FROM PUBLIC;
DO $patch$ DECLARE definition text; BEGIN SELECT pg_get_functiondef('billing_invoiceline_guard()'::regprocedure) INTO definition; definition:=regexp_replace(definition,'BEGIN',$body$BEGIN
 IF TG_OP='UPDATE' AND public.retention_context('qualify',TG_TABLE_NAME,NEW.id) IS NOT NULL
 AND (to_jsonb(NEW)-ARRAY['accounting_event_at','financial_year_closed_at','purge_after','retention_authority_ref','document_number_snapshot'])
 IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['accounting_event_at','financial_year_closed_at','purge_after','retention_authority_ref','document_number_snapshot'])
 THEN RETURN NEW; END IF;

 IF TG_OP='DELETE' AND OLD.purge_after IS NOT NULL AND OLD.purge_after<clock_timestamp()
 AND public.retention_context('purge',TG_TABLE_NAME,OLD.id) IS NOT NULL THEN RETURN OLD; END IF;
IF TG_OP='UPDATE' AND public.retention_context('clock','billing_invoice',NEW.invoice_id) IS NOT NULL
 AND (to_jsonb(NEW)-ARRAY['accounting_event_at','financial_year_closed_at','purge_after','retention_authority_ref','document_number_snapshot'])
 IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['accounting_event_at','financial_year_closed_at','purge_after','retention_authority_ref','document_number_snapshot'])
 THEN RETURN NEW; END IF;
$body$); EXECUTE definition; END $patch$;
ALTER FUNCTION billing_invoiceline_guard() SECURITY DEFINER; ALTER FUNCTION billing_invoiceline_guard() SET search_path=pg_catalog,public,pg_temp; REVOKE ALL ON FUNCTION billing_invoiceline_guard() FROM PUBLIC;
DO $patch$ DECLARE definition text; BEGIN SELECT pg_get_functiondef('billing_creditnote_guard()'::regprocedure) INTO definition; definition:=regexp_replace(definition,'BEGIN',$body$BEGIN
 IF TG_OP='UPDATE' AND public.retention_context('qualify',TG_TABLE_NAME,NEW.id) IS NOT NULL
 AND (to_jsonb(NEW)-ARRAY['accounting_event_at','financial_year_closed_at','purge_after','retention_authority_ref','document_number_snapshot'])
 IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['accounting_event_at','financial_year_closed_at','purge_after','retention_authority_ref','document_number_snapshot'])
 THEN RETURN NEW; END IF;

 IF TG_OP='DELETE' AND OLD.purge_after IS NOT NULL AND OLD.purge_after<clock_timestamp()
 AND public.retention_context('purge',TG_TABLE_NAME,OLD.id) IS NOT NULL THEN RETURN OLD; END IF;
$body$); EXECUTE definition; END $patch$;
ALTER FUNCTION billing_creditnote_guard() SECURITY DEFINER; ALTER FUNCTION billing_creditnote_guard() SET search_path=pg_catalog,public,pg_temp; REVOKE ALL ON FUNCTION billing_creditnote_guard() FROM PUBLIC;
DO $patch$ DECLARE definition text; BEGIN SELECT pg_get_functiondef('billing_creditnoteline_guard()'::regprocedure) INTO definition; definition:=regexp_replace(definition,'BEGIN',$body$BEGIN
 IF TG_OP='UPDATE' AND public.retention_context('qualify',TG_TABLE_NAME,NEW.id) IS NOT NULL
 AND (to_jsonb(NEW)-ARRAY['accounting_event_at','financial_year_closed_at','purge_after','retention_authority_ref','document_number_snapshot'])
 IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['accounting_event_at','financial_year_closed_at','purge_after','retention_authority_ref','document_number_snapshot'])
 THEN RETURN NEW; END IF;

 IF TG_OP='DELETE' AND OLD.purge_after IS NOT NULL AND OLD.purge_after<clock_timestamp()
 AND public.retention_context('purge',TG_TABLE_NAME,OLD.id) IS NOT NULL THEN RETURN OLD; END IF;
$body$); EXECUTE definition; END $patch$;
ALTER FUNCTION billing_creditnoteline_guard() SECURITY DEFINER; ALTER FUNCTION billing_creditnoteline_guard() SET search_path=pg_catalog,public,pg_temp; REVOKE ALL ON FUNCTION billing_creditnoteline_guard() FROM PUBLIC;

CREATE FUNCTION billing_payment_retention_delete() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.purge_after IS NOT NULL AND OLD.purge_after<clock_timestamp()
 AND public.retention_context('purge',TG_TABLE_NAME,OLD.id) IS NOT NULL THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'payment retention deletion refused' USING ERRCODE='23514';
END $$;
CREATE TRIGGER payment_retention_delete BEFORE DELETE ON billing_payment FOR EACH ROW EXECUTE FUNCTION billing_payment_retention_delete();

REVOKE ALL ON FUNCTION billing_fiscal_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_retention_clock_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_statutory_capture() FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_statutory_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_payment_retention_delete() FROM PUBLIC;

'''

class Migration(migrations.Migration):
    dependencies = [("billing", "0017_creditnote_accounting_event_at_and_more")]
    operations = [migrations.RunSQL(FORWARD)]
