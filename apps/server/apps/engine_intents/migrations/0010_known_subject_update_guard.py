"""Strengthen `engine_known_subject_change()` so an update must set `erased_at` and never
change the recorded subject's identity (ADR-0011)."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE OR REPLACE FUNCTION engine_known_subject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.organisation_id, NEW.user_id, NEW.subject, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organisation_id, OLD.user_id, OLD.subject, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='engine_known_subject_erasure_final', MESSAGE='A recorded subject''s identity is immutable';
  END IF;
  IF OLD.erased_at IS NOT NULL AND NEW.erased_at IS DISTINCT FROM OLD.erased_at THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='engine_known_subject_erasure_final', MESSAGE='A subject''s erasure is final';
  END IF;
  IF NEW.erased_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='engine_known_subject_erasure_final', MESSAGE='An update to a recorded subject must set erased_at';
  END IF;
  RETURN NEW;
END $$;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE OR REPLACE FUNCTION engine_known_subject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.erased_at IS NOT NULL AND NEW.erased_at IS DISTINCT FROM OLD.erased_at THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='engine_known_subject_erasure_final', MESSAGE='A subject''s erasure is final';
  END IF;
  RETURN NEW;
END $$;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
"""


class Migration(migrations.Migration):
    dependencies = [("engine_intents", "0009_known_subject_erasure_final")]

    operations = [migrations.RunSQL(FORWARD, reverse_sql=REVERSE)]
