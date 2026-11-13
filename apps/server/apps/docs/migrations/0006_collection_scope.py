"""Collection ownership, workspace bindings and bounded JSON shapes at the storage boundary."""

from django.db import migrations

FORWARD = r'''
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE INDEX docs_collection_values_gin ON docs_collectionrow USING gin("values" jsonb_path_ops);
ALTER TABLE docs_collection ADD CONSTRAINT docs_collection_schema_bound CHECK(
  jsonb_typeof(properties)='array' AND jsonb_array_length(properties)<=100
  AND jsonb_typeof(views)='array' AND jsonb_array_length(views)<=20
  AND octet_length(properties::text)<=131072 AND octet_length(views::text)<=131072);
ALTER TABLE docs_collectionrow ADD CONSTRAINT docs_collection_values_bound CHECK(
  jsonb_typeof("values")='object' AND octet_length("values"::text)<=1048576);
CREATE FUNCTION docs_collection_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected uuid; actual uuid; entry record; prop jsonb; raw jsonb; kind text; scalar text;
BEGIN
  IF TG_TABLE_NAME='docs_collection' THEN
    SELECT organisation_id INTO expected FROM workspaces_workspace WHERE id=NEW.workspace_id;
    SELECT organisation_id INTO actual FROM orgs_membership WHERE id=NEW.creator_id;
    IF expected IS DISTINCT FROM actual THEN
      RAISE EXCEPTION 'collection creator scope refused' USING ERRCODE='23514'; END IF;
    IF TG_OP='UPDATE' AND (OLD.workspace_id,OLD.creator_id) IS DISTINCT FROM (NEW.workspace_id,NEW.creator_id)
    THEN RAISE EXCEPTION 'collection ownership is immutable' USING ERRCODE='23514'; END IF;
    IF TG_OP='UPDATE' AND NEW.properties IS DISTINCT FROM OLD.properties
       AND EXISTS(SELECT 1 FROM docs_collectionrow WHERE collection_id=OLD.id)
    THEN RAISE EXCEPTION 'populated collection schema is immutable' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT workspace_id INTO expected FROM docs_collection WHERE id=NEW.collection_id AND deleted_at IS NULL;
    SELECT workspace_id INTO actual FROM docs_document WHERE id=NEW.document_id AND deleted_at IS NULL;
    IF expected IS NULL OR expected IS DISTINCT FROM actual THEN
      RAISE EXCEPTION 'collection document scope refused' USING ERRCODE='23514'; END IF;
    IF TG_OP='UPDATE' AND (OLD.collection_id,OLD.document_id) IS DISTINCT FROM (NEW.collection_id,NEW.document_id)
    THEN RAISE EXCEPTION 'collection row ownership is immutable' USING ERRCODE='23514'; END IF;
    FOR entry IN SELECT * FROM jsonb_each(NEW."values") LOOP
      SELECT p INTO prop FROM docs_collection c, jsonb_array_elements(c.properties) p
        WHERE c.id=NEW.collection_id AND p->>'id'=entry.key;
      IF prop IS NULL OR jsonb_typeof(entry.value)<>'object'
         OR NOT entry.value ? 'value' OR NOT entry.value ? 'type'
         OR entry.value->>'type' IS DISTINCT FROM prop->>'type'
      THEN RAISE EXCEPTION 'collection property type refused' USING ERRCODE='23514'; END IF;
      kind := prop->>'type'; raw := entry.value->'value'; scalar := raw #>> '{}';
      IF raw='null'::jsonb AND kind NOT IN ('checkbox','multi_select') THEN CONTINUE; END IF;
      IF (kind='text' AND (jsonb_typeof(raw)<>'string' OR length(scalar)>10000))
         OR (kind='number' AND jsonb_typeof(raw)<>'number')
         OR (kind='checkbox' AND jsonb_typeof(raw)<>'boolean')
         OR (kind IN ('date','url','person','select') AND jsonb_typeof(raw)<>'string')
         OR (kind='multi_select' AND jsonb_typeof(raw)<>'array')
         OR kind NOT IN ('text','number','checkbox','date','url','person','select','multi_select')
      THEN RAISE EXCEPTION 'collection property type refused' USING ERRCODE='23514'; END IF;
      IF kind='select' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prop->'options') o WHERE o->>'id'=scalar)
      THEN RAISE EXCEPTION 'collection select option refused' USING ERRCODE='23514'; END IF;
      IF kind='multi_select' AND (jsonb_array_length(raw)>100 OR EXISTS(
        SELECT 1 FROM jsonb_array_elements(raw) v WHERE jsonb_typeof(v)<>'string'
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prop->'options') o WHERE o->'id'=v)))
      THEN RAISE EXCEPTION 'collection select option refused' USING ERRCODE='23514'; END IF;
      IF kind='person' AND NOT EXISTS(SELECT 1 FROM orgs_membership m
         JOIN workspaces_workspace w ON w.organisation_id=m.organisation_id
         WHERE m.id=scalar::uuid AND w.id=expected AND m.state='active' AND m.deleted_at IS NULL)
      THEN RAISE EXCEPTION 'collection person scope refused' USING ERRCODE='23514'; END IF;
      IF kind='date' AND (scalar !~ '^\d{4}-\d{2}-\d{2}$' OR scalar::date::text<>scalar)
      THEN RAISE EXCEPTION 'collection date refused' USING ERRCODE='23514'; END IF;
      IF kind='url' AND (length(scalar)>2048 OR scalar !~ '^https?://[^/@[:space:]]+')
      THEN RAISE EXCEPTION 'collection URL refused' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER docs_collection_scope BEFORE INSERT OR UPDATE ON docs_collection
  FOR EACH ROW EXECUTE FUNCTION docs_collection_scope_guard();
CREATE TRIGGER docs_collection_row_scope BEFORE INSERT OR UPDATE ON docs_collectionrow
  FOR EACH ROW EXECUTE FUNCTION docs_collection_scope_guard();
'''
REVERSE = r'''
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP TRIGGER docs_collection_row_scope ON docs_collectionrow;
DROP TRIGGER docs_collection_scope ON docs_collection;
DROP FUNCTION docs_collection_scope_guard();
ALTER TABLE docs_collectionrow DROP CONSTRAINT docs_collection_values_bound;
ALTER TABLE docs_collection DROP CONSTRAINT docs_collection_schema_bound;
DROP INDEX docs_collection_values_gin;
'''


class Migration(migrations.Migration):
    dependencies = [("docs", "0005_collection_collectionrow_and_more")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
