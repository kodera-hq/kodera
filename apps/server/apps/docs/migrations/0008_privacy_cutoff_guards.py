"""The durable erasure and account cutoff guards on this application's own tables.

orgs 0025 and 0029 own the guard functions and the journals; the triggers on the document
tables are installed here, because this application depends on the audit writer and so is
never a dependency of the applications whose schema a Core profile installs on its own.
"""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_document FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_documentgrant FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_documentlink FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_documentsnapshot FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_documentupdate FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_collection FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_collectionrow FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER ab_account_cutoff BEFORE INSERT OR UPDATE ON docs_documentupdate FOR EACH ROW EXECUTE FUNCTION privacy_account_cutoff_guard();

-- The journal stays immutable to every caller; only the erasure worker's own context may
-- remove an update that its snapshot no longer has to cover.
CREATE OR REPLACE FUNCTION public.docs_journal_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET lock_timeout='3s' SET statement_timeout='5s' AS $$
DECLARE covered bigint; head bigint; expected uuid; actual uuid;
BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM public.docs_document d JOIN public.workspaces_workspace w ON w.id=d.workspace_id
 WHERE d.id=OLD.document_id AND public.privacy_erasure_context(w.organisation_id)) THEN RETURN OLD; END IF;

  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'document journal is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN
    SELECT sequence INTO covered FROM docs_documentsnapshot WHERE document_id=OLD.document_id;
    IF covered IS NULL OR covered<OLD.sequence THEN RAISE EXCEPTION 'document update is not covered by a snapshot' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  SELECT head_sequence INTO head FROM docs_documentsnapshot WHERE document_id=NEW.document_id FOR UPDATE;
  IF head IS NULL OR NEW.sequence<>head+1 THEN RAISE EXCEPTION 'document journal sequence refused' USING ERRCODE='23514'; END IF;
  SELECT w.organisation_id INTO expected FROM docs_document d JOIN workspaces_workspace w ON w.id=d.workspace_id WHERE d.id=NEW.document_id;
  SELECT organisation_id INTO actual FROM identity_identity WHERE id=NEW.actor_id;
  IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'document journal actor scope refused' USING ERRCODE='23514'; END IF;
  UPDATE docs_documentsnapshot SET head_sequence=NEW.sequence,updated_at=clock_timestamp() WHERE document_id=NEW.document_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION docs_journal_guard() FROM PUBLIC;
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
-- Back to the body of docs 0002 with the owner rights and finite timeouts docs 0003 gave it.
CREATE OR REPLACE FUNCTION public.docs_journal_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET lock_timeout='3s' SET statement_timeout='5s' AS $$
DECLARE covered bigint; head bigint; expected uuid; actual uuid;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'document journal is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN
    SELECT sequence INTO covered FROM docs_documentsnapshot WHERE document_id=OLD.document_id;
    IF covered IS NULL OR covered<OLD.sequence THEN RAISE EXCEPTION 'document update is not covered by a snapshot' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  SELECT head_sequence INTO head FROM docs_documentsnapshot WHERE document_id=NEW.document_id FOR UPDATE;
  IF head IS NULL OR NEW.sequence<>head+1 THEN RAISE EXCEPTION 'document journal sequence refused' USING ERRCODE='23514'; END IF;
  SELECT w.organisation_id INTO expected FROM docs_document d JOIN workspaces_workspace w ON w.id=d.workspace_id WHERE d.id=NEW.document_id;
  SELECT organisation_id INTO actual FROM identity_identity WHERE id=NEW.actor_id;
  IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'document journal actor scope refused' USING ERRCODE='23514'; END IF;
  UPDATE docs_documentsnapshot SET head_sequence=NEW.sequence,updated_at=clock_timestamp() WHERE document_id=NEW.document_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION docs_journal_guard() FROM PUBLIC;
DROP TRIGGER ab_account_cutoff ON docs_documentupdate;
DROP TRIGGER aa_privacy_cutoff ON docs_collectionrow;
DROP TRIGGER aa_privacy_cutoff ON docs_collection;
DROP TRIGGER aa_privacy_cutoff ON docs_documentupdate;
DROP TRIGGER aa_privacy_cutoff ON docs_documentsnapshot;
DROP TRIGGER aa_privacy_cutoff ON docs_documentlink;
DROP TRIGGER aa_privacy_cutoff ON docs_documentgrant;
DROP TRIGGER aa_privacy_cutoff ON docs_document;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("docs", "0007_materialized_snapshot_quota"),
        ("orgs", "0029_account_erasure_guards"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
