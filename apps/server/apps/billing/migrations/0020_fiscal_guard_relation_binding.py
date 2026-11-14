"""Admission TEMP objects cannot shadow fiscal authority relations."""

from django.db import migrations

FORWARD = r"""
CREATE OR REPLACE FUNCTION public.billing_fiscal_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'fiscal authority immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kodera-fiscal:'||NEW.issuer_siren,0));
 IF NEW.authority_ref !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=NEW.timezone)
 OR NEW.closed_at<=NEW.starts_at
 OR EXISTS(SELECT 1 FROM public.billing_fiscalperiod WHERE issuer_siren=NEW.issuer_siren
           AND starts_at<NEW.closed_at AND closed_at>NEW.starts_at)
 THEN RAISE EXCEPTION 'fiscal authority invalid or overlapping' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.billing_fiscal_guard() FROM PUBLIC;
"""


REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
-- Back to the fiscal authority guard of billing 0018, before the TEMP-shadowing qualification.
CREATE OR REPLACE FUNCTION billing_fiscal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
REVOKE ALL ON FUNCTION billing_fiscal_guard() FROM PUBLIC;
"""


class Migration(migrations.Migration):
    dependencies = [("billing", "0019_statutory_worker_operations")]
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
