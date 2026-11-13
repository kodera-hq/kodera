"""Refuse an uploader from another organisation at the database boundary."""

from django.db import migrations

FORWARD = """
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION media_attachment_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM orgs_membership WHERE id=NEW.uploader_id AND organisation_id=NEW.organisation_id) THEN
        RAISE EXCEPTION 'Attachment uploader is outside its organisation' USING ERRCODE='23514', CONSTRAINT='media_attachment_same_org';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER media_attachment_scope BEFORE INSERT OR UPDATE ON media_attachment FOR EACH ROW EXECUTE FUNCTION media_attachment_scope();
"""
REVERSE = """
DROP TRIGGER media_attachment_scope ON media_attachment;
DROP FUNCTION media_attachment_scope();
"""


class Migration(migrations.Migration):
    dependencies = [("media", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
