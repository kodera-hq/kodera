"""Finish the staged customer schema with actual database constraints."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE identity_identity ADD CONSTRAINT identity_user_fk FOREIGN KEY (user_id) REFERENCES identity_user(id) ON DELETE RESTRICT;
ALTER TABLE identity_identity ADD CONSTRAINT identity_organisation_binding_fk FOREIGN KEY (organisation_id,issuer,realm) REFERENCES orgs_organisation(id,issuer,realm) ON DELETE RESTRICT;
ALTER TABLE orgs_membership ADD CONSTRAINT membership_user_fk FOREIGN KEY (user_id) REFERENCES identity_user(id) ON DELETE RESTRICT;
ALTER TABLE orgs_membership ADD CONSTRAINT membership_organisation_fk FOREIGN KEY (organisation_id) REFERENCES orgs_organisation(id) ON DELETE RESTRICT;
ALTER TABLE orgs_slugreservation ADD CONSTRAINT reservation_organisation_fk FOREIGN KEY (organisation_id) REFERENCES orgs_organisation(id) ON DELETE RESTRICT;

CREATE FUNCTION customer_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT=TG_ARGV[0] || '_id_immutable', MESSAGE='Stored identifier is immutable';
  END IF;
  IF TG_ARGV[0]='identity' THEN
    IF (NEW.user_id,NEW.organisation_id,NEW.issuer,NEW.realm,NEW.subject) IS DISTINCT FROM (OLD.user_id,OLD.organisation_id,OLD.issuer,OLD.realm,OLD.subject) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='identity_immutable_binding', MESSAGE='Principal binding is immutable';
    END IF;
  ELSIF TG_ARGV[0]='membership' THEN
    IF (NEW.user_id,NEW.organisation_id) IS DISTINCT FROM (OLD.user_id,OLD.organisation_id) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='membership_immutable_binding', MESSAGE='Membership binding is immutable';
    END IF;
  ELSIF TG_ARGV[0]='organisation' THEN
    IF NEW.issuer IS DISTINCT FROM OLD.issuer THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='organisation_immutable_binding', MESSAGE='Organisation issuer is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_customer_immutable BEFORE UPDATE ON identity_user FOR EACH ROW EXECUTE FUNCTION customer_immutable('user');
CREATE TRIGGER a_customer_immutable BEFORE UPDATE ON identity_identity FOR EACH ROW EXECUTE FUNCTION customer_immutable('identity');
CREATE TRIGGER a_customer_immutable BEFORE UPDATE ON orgs_organisation FOR EACH ROW EXECUTE FUNCTION customer_immutable('organisation');
CREATE TRIGGER a_customer_immutable BEFORE UPDATE ON orgs_membership FOR EACH ROW EXECUTE FUNCTION customer_immutable('membership');
CREATE TRIGGER a_customer_immutable BEFORE UPDATE ON orgs_slugreservation FOR EACH ROW EXECUTE FUNCTION customer_immutable('slugreservation');

CREATE FUNCTION customer_identity_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='identity_delete_refused', MESSAGE='Principal keys are retained';
END $$;
CREATE TRIGGER customer_identity_delete BEFORE DELETE ON identity_identity FOR EACH ROW EXECUTE FUNCTION customer_identity_delete();

CREATE FUNCTION customer_reservation_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='reservation_delete_refused', MESSAGE='Reservation is retained';
  END IF;
  IF (NEW.namespace,NEW.slug,NEW.organisation_id) IS DISTINCT FROM (OLD.namespace,OLD.slug,OLD.organisation_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='reservation_immutable_binding', MESSAGE='Reservation binding is immutable';
  END IF;
  IF (OLD.state='permanent' AND NEW.state='provisional') OR (OLD.state='retired' AND NEW.state IS DISTINCT FROM OLD.state) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='reservation_transition_valid', MESSAGE='Reservation cannot downgrade';
  END IF;
  IF OLD.protected_at IS NOT NULL AND NEW.protected_at IS DISTINCT FROM OLD.protected_at THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='reservation_protection_immutable', MESSAGE='Protection timestamp is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_customer_reservation_change BEFORE UPDATE OR DELETE ON orgs_slugreservation FOR EACH ROW EXECUTE FUNCTION customer_reservation_change();

CREATE FUNCTION customer_touch_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN org_id := OLD.organisation_id; ELSE org_id := NEW.organisation_id; END IF;
  UPDATE orgs_organisation SET owner_guard_revision=owner_guard_revision+1 WHERE id=org_id;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER b_customer_touch_owner_guard BEFORE INSERT OR UPDATE OR DELETE ON orgs_membership FOR EACH ROW EXECUTE FUNCTION customer_touch_owner_guard();
CREATE TRIGGER c_customer_touch_reservation_guard BEFORE INSERT OR UPDATE ON orgs_slugreservation FOR EACH ROW EXECUTE FUNCTION customer_touch_owner_guard();

CREATE FUNCTION customer_activate_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='active' AND OLD.state IS DISTINCT FROM NEW.state THEN
    NEW.owner_guard_revision := OLD.owner_guard_revision+1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_customer_activate_owner_guard BEFORE UPDATE OF state ON orgs_organisation FOR EACH ROW EXECUTE FUNCTION customer_activate_owner_guard();

CREATE FUNCTION customer_check_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org_id uuid;
BEGIN
  IF TG_TABLE_NAME='orgs_organisation' THEN org_id := NEW.id;
  ELSIF TG_OP='DELETE' THEN org_id := OLD.organisation_id;
  ELSE org_id := NEW.organisation_id; END IF;
  IF EXISTS (SELECT 1 FROM orgs_organisation WHERE id=org_id AND state='active')
    AND NOT EXISTS (SELECT 1 FROM orgs_membership WHERE organisation_id=org_id AND role='org_owner' AND state='active' AND accepted_at IS NOT NULL AND deleted_at IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='organisation_owner_required', MESSAGE='Active organisation requires an owner';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER organisation_owner_required AFTER INSERT OR UPDATE ON orgs_organisation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION customer_check_owner();
CREATE CONSTRAINT TRIGGER organisation_owner_required AFTER INSERT OR UPDATE OR DELETE ON orgs_membership DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION customer_check_owner();

CREATE FUNCTION customer_check_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org_id uuid; org_slug text; org_state text; held_state text; held_slug text;
BEGIN
  IF TG_TABLE_NAME='orgs_organisation' THEN org_id := NEW.id; ELSE org_id := NEW.organisation_id; END IF;
  SELECT slug,state INTO org_slug,org_state FROM orgs_organisation WHERE id=org_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT slug,state INTO held_slug,held_state FROM orgs_slugreservation WHERE organisation_id=org_id;
  IF NOT FOUND OR held_slug IS DISTINCT FROM org_slug OR (org_state IN ('active','suspended') AND held_state<>'permanent') THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='organisation_reservation_required', MESSAGE='Organisation requires its matching held name';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER organisation_reservation_required AFTER INSERT OR UPDATE ON orgs_organisation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION customer_check_reservation();
CREATE CONSTRAINT TRIGGER organisation_reservation_required AFTER INSERT OR UPDATE ON orgs_slugreservation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION customer_check_reservation();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP TRIGGER organisation_reservation_required ON orgs_slugreservation;
DROP TRIGGER organisation_reservation_required ON orgs_organisation;
DROP TRIGGER organisation_owner_required ON orgs_membership;
DROP TRIGGER organisation_owner_required ON orgs_organisation;
DROP TRIGGER b_customer_activate_owner_guard ON orgs_organisation;
DROP TRIGGER c_customer_touch_reservation_guard ON orgs_slugreservation;
DROP TRIGGER b_customer_touch_owner_guard ON orgs_membership;
DROP TRIGGER b_customer_reservation_change ON orgs_slugreservation;
DROP TRIGGER customer_identity_delete ON identity_identity;
DROP TRIGGER a_customer_immutable ON orgs_slugreservation;
DROP TRIGGER a_customer_immutable ON orgs_membership;
DROP TRIGGER a_customer_immutable ON orgs_organisation;
DROP TRIGGER a_customer_immutable ON identity_identity;
DROP TRIGGER a_customer_immutable ON identity_user;
DROP FUNCTION customer_check_reservation();
DROP FUNCTION customer_check_owner();
DROP FUNCTION customer_activate_owner_guard();
DROP FUNCTION customer_touch_owner_guard();
DROP FUNCTION customer_reservation_change();
DROP FUNCTION customer_identity_delete();
DROP FUNCTION customer_immutable();
ALTER TABLE orgs_slugreservation DROP CONSTRAINT reservation_organisation_fk;
ALTER TABLE orgs_membership DROP CONSTRAINT membership_organisation_fk;
ALTER TABLE orgs_membership DROP CONSTRAINT membership_user_fk;
ALTER TABLE identity_identity DROP CONSTRAINT identity_organisation_binding_fk;
ALTER TABLE identity_identity DROP CONSTRAINT identity_user_fk;
"""


class Migration(migrations.Migration):
    dependencies = [("orgs", "0001_initial"), ("identity", "0002_initial")]
    operations = [migrations.RunSQL(FORWARD, reverse_sql=REVERSE)]
