"""An erasure mark is final: once a recorded subject's `erased_at` is set, no role may clear or
move it (ADR-0011). The API writer role holds `UPDATE ("erased_at")` for `mark_erased`, which
only ever sets a null mark."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION engine_known_subject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.erased_at IS NOT NULL AND NEW.erased_at IS DISTINCT FROM OLD.erased_at THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='engine_known_subject_erasure_final', MESSAGE='A subject''s erasure is final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_engine_known_subject_change BEFORE UPDATE ON engine_intents_known_subject FOR EACH ROW EXECUTE FUNCTION engine_known_subject_change();
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP TRIGGER a_engine_known_subject_change ON engine_intents_known_subject;
DROP FUNCTION engine_known_subject_change();
"""


class Migration(migrations.Migration):
    dependencies = [("engine_intents", "0008_validate_command_channel_set_fk")]

    operations = [migrations.RunSQL(FORWARD, reverse_sql=REVERSE)]
