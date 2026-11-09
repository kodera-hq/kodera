"""An acceptance is never changed or deleted, nor is a published document; an accepted DPA only
ever moves to `superseded`, and a superseded one only gains the DPA that superseded it, once: the
evidence a signature rests on stays as it was signed."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION legal_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT=TG_ARGV[0],
    MESSAGE='A legal record is never changed or deleted';
END $$;
CREATE TRIGGER legal_acceptance_immutable BEFORE UPDATE OR DELETE ON legal_acceptance
  FOR EACH ROW EXECUTE FUNCTION legal_append_only_guard('legal_acceptance_immutable');
CREATE TRIGGER legal_legaldocument_immutable BEFORE UPDATE OR DELETE ON legal_legaldocument
  FOR EACH ROW EXECUTE FUNCTION legal_append_only_guard('legal_legaldocument_immutable');

CREATE FUNCTION legal_dpa_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER legal_dpa_immutable BEFORE UPDATE OR DELETE ON legal_dpa
  FOR EACH ROW EXECUTE FUNCTION legal_dpa_guard();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP TRIGGER legal_dpa_immutable ON legal_dpa;
DROP FUNCTION legal_dpa_guard();
DROP TRIGGER legal_legaldocument_immutable ON legal_legaldocument;
DROP TRIGGER legal_acceptance_immutable ON legal_acceptance;
DROP FUNCTION legal_append_only_guard();
"""


class Migration(migrations.Migration):
    dependencies = [("legal", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, reverse_sql=REVERSE)]
