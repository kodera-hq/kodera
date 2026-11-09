"""A tenant row is never deleted: its slug must keep naming it, and only it (ADR-0008)."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION tenancy_tenant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='tenancy_tenant_slug_permanent',
      MESSAGE='A tenant is never deleted and its slug never changes';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenancy_tenant_slug_permanent BEFORE UPDATE OR DELETE ON tenancy_tenant
  FOR EACH ROW EXECUTE FUNCTION tenancy_tenant_guard();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP TRIGGER tenancy_tenant_slug_permanent ON tenancy_tenant;
DROP FUNCTION tenancy_tenant_guard();
"""


class Migration(migrations.Migration):
    dependencies = [("tenancy", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, reverse_sql=REVERSE)]
