"""Deferred integrity readers keep scoped owner rights after a worker function returns."""

from django.db import migrations

FORWARD = """
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
ALTER FUNCTION customer_check_owner() SECURITY DEFINER;
ALTER FUNCTION customer_check_owner() SET search_path=pg_catalog,public,pg_temp;
REVOKE ALL ON FUNCTION customer_check_owner() FROM PUBLIC;
ALTER FUNCTION customer_check_reservation() SECURITY DEFINER;
ALTER FUNCTION customer_check_reservation() SET search_path=pg_catalog,public,pg_temp;
REVOKE ALL ON FUNCTION customer_check_reservation() FROM PUBLIC;
"""

REVERSE = """
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
ALTER FUNCTION customer_check_owner() SECURITY INVOKER;
ALTER FUNCTION customer_check_owner() RESET search_path;
GRANT EXECUTE ON FUNCTION customer_check_owner() TO PUBLIC;
ALTER FUNCTION customer_check_reservation() SECURITY INVOKER;
ALTER FUNCTION customer_check_reservation() RESET search_path;
GRANT EXECUTE ON FUNCTION customer_check_reservation() TO PUBLIC;
"""


class Migration(migrations.Migration):
    dependencies = [("orgs", "0026_erasure_completion")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
