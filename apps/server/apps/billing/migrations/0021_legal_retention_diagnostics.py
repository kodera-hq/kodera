"""Keep legal deletion refusal identifiers without changing due-only purge authority."""

from django.db import migrations

FORWARD = r'''
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE OR REPLACE FUNCTION billing_contract_clock_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.purge_after IS NOT NULL AND OLD.purge_after<clock_timestamp()
   AND public.retention_context('purge',TG_TABLE_NAME,OLD.id) IS NOT NULL THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME IN ('legal_acceptance','legal_dpa') THEN
   RAISE EXCEPTION 'contract record not due or immutable' USING ERRCODE='23514',
    CONSTRAINT=CASE TG_TABLE_NAME WHEN 'legal_acceptance' THEN 'legal_acceptance_immutable' ELSE 'legal_dpa_immutable' END;
  END IF;
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
'''


REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
-- Back to the contract clock guard of billing 0019, without the named legal refusals.
CREATE OR REPLACE FUNCTION billing_contract_clock_guard() RETURNS trigger LANGUAGE plpgsql
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
REVOKE ALL ON FUNCTION billing_contract_clock_guard() FROM PUBLIC;
"""


class Migration(migrations.Migration):
    dependencies = [("billing", "0020_fiscal_guard_relation_binding")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
