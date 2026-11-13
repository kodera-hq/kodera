"""Constrain inbox and subscription recipients to their stored organisation."""

from django.db import migrations

FORWARD = """
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION notification_recipient_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM orgs_membership WHERE id=NEW.membership_id AND organisation_id=NEW.organisation_id) THEN
        RAISE EXCEPTION 'Notification recipient is outside its organisation' USING ERRCODE='23514', CONSTRAINT='notification_recipient_same_org';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER notification_recipient_scope BEFORE INSERT OR UPDATE ON notifications_notification FOR EACH ROW EXECUTE FUNCTION notification_recipient_scope();
CREATE TRIGGER push_recipient_scope BEFORE INSERT OR UPDATE ON notifications_pushsubscription FOR EACH ROW EXECUTE FUNCTION notification_recipient_scope();
"""
REVERSE = """
DROP TRIGGER push_recipient_scope ON notifications_pushsubscription;
DROP TRIGGER notification_recipient_scope ON notifications_notification;
DROP FUNCTION notification_recipient_scope();
"""


class Migration(migrations.Migration):
    dependencies = [("notifications", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
