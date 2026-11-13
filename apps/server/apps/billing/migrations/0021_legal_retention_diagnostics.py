"""Keep legal deletion refusal identifiers without changing due-only purge authority."""

from django.db import migrations

FORWARD = r'''
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DO $patch$
DECLARE definition text; original text := $original$  RAISE EXCEPTION 'contract record not due or immutable' USING ERRCODE='23514';$original$;
BEGIN
 SELECT pg_get_functiondef('public.billing_contract_clock_guard()'::regprocedure) INTO definition;
 IF (length(definition)-length(replace(definition,original,'')))/length(original) <> 1
 THEN RAISE EXCEPTION 'contract diagnostic patch binding refused'; END IF;
 EXECUTE replace(definition,original,$replacement$  IF TG_TABLE_NAME IN ('legal_acceptance','legal_dpa') THEN
   RAISE EXCEPTION 'contract record not due or immutable' USING ERRCODE='23514',
    CONSTRAINT=CASE TG_TABLE_NAME WHEN 'legal_acceptance' THEN 'legal_acceptance_immutable' ELSE 'legal_dpa_immutable' END;
  END IF;
$replacement$||original);
END $patch$;
'''


class Migration(migrations.Migration):
    dependencies = [("billing", "0020_fiscal_guard_relation_binding")]
    operations = [migrations.RunSQL(FORWARD)]
