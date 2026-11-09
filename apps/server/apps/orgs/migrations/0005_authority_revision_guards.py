"""Version parent users before association writes; advance committed authority."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE FUNCTION organisation_authority_advance() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.authority_revision := 1;
  ELSE
    IF OLD.authority_revision >= 9223372036854775807 THEN
      RAISE EXCEPTION USING ERRCODE='23514',
        CONSTRAINT='organisation_authority_revision_exhausted',
        MESSAGE='Organisation authority revision exhausted';
    END IF;
    NEW.authority_revision := OLD.authority_revision + 1;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION member_authority_user_touch() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE principal_id uuid; target_organisation uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    principal_id := OLD.user_id; target_organisation := OLD.organisation_id;
  ELSE
    principal_id := NEW.user_id; target_organisation := NEW.organisation_id;
  END IF;
  -- One lock order for every association write: the parent user, then every
  -- organisation this write touches in ascending id, the target included, before
  -- the fan-out and the owner guard. No later trigger then takes a lower id after
  -- a higher one, so two writers crossing users between organisations cannot deadlock.
  PERFORM 1 FROM identity_user WHERE id=principal_id FOR NO KEY UPDATE;
  PERFORM 1 FROM orgs_organisation WHERE id IN (
    SELECT organisation_id FROM identity_identity WHERE user_id=principal_id
    UNION
    SELECT organisation_id FROM orgs_membership WHERE user_id=principal_id
    UNION
    SELECT target_organisation
  ) ORDER BY id FOR NO KEY UPDATE;
  -- A tuple write is essential: a row lock alone cannot fence an old RR snapshot.
  -- Parent bindings are immutable; a missing parent is refused by the existing FK.
  UPDATE identity_user SET enabled=enabled WHERE id=principal_id;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE FUNCTION user_authority_fanout() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE principal_id uuid; target_organisation uuid;
BEGIN
  IF TG_OP='DELETE' THEN principal_id := OLD.id;
  ELSE principal_id := NEW.id;
  END IF;
  -- Include retained associations: restoration must not resurrect an old revision.
  FOR target_organisation IN
    SELECT organisation_id FROM identity_identity WHERE user_id=principal_id
    UNION
    SELECT organisation_id FROM orgs_membership WHERE user_id=principal_id
    ORDER BY organisation_id
  LOOP
    UPDATE orgs_organisation SET authority_revision=authority_revision
      WHERE id=target_organisation;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE FUNCTION member_authority_org_touch() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE target_organisation uuid;
BEGIN
  IF TG_OP='DELETE' THEN target_organisation := OLD.organisation_id;
  ELSE target_organisation := NEW.organisation_id;
  END IF;
  -- New associations were not visible in the earlier parent-user fan-out.
  UPDATE orgs_organisation SET authority_revision=authority_revision
    WHERE id=target_organisation;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE TRIGGER aa_organisation_authority_advance BEFORE INSERT OR UPDATE
ON orgs_organisation FOR EACH ROW EXECUTE FUNCTION organisation_authority_advance();
CREATE TRIGGER aa_member_authority_user_touch BEFORE INSERT OR UPDATE OR DELETE
ON orgs_membership FOR EACH ROW EXECUTE FUNCTION member_authority_user_touch();
CREATE TRIGGER aa_member_authority_user_touch BEFORE INSERT OR UPDATE OR DELETE
ON identity_identity FOR EACH ROW EXECUTE FUNCTION member_authority_user_touch();
CREATE TRIGGER d_member_authority_org_touch AFTER INSERT OR UPDATE OR DELETE
ON orgs_membership FOR EACH ROW EXECUTE FUNCTION member_authority_org_touch();
CREATE TRIGGER d_member_authority_org_touch AFTER INSERT OR UPDATE OR DELETE
ON identity_identity FOR EACH ROW EXECUTE FUNCTION member_authority_org_touch();
CREATE TRIGGER d_user_authority_fanout AFTER UPDATE OR DELETE
ON identity_user FOR EACH ROW EXECUTE FUNCTION user_authority_fanout();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP TRIGGER d_user_authority_fanout ON identity_user;
DROP TRIGGER d_member_authority_org_touch ON identity_identity;
DROP TRIGGER d_member_authority_org_touch ON orgs_membership;
DROP TRIGGER aa_member_authority_user_touch ON identity_identity;
DROP TRIGGER aa_member_authority_user_touch ON orgs_membership;
DROP TRIGGER aa_organisation_authority_advance ON orgs_organisation;
DROP FUNCTION member_authority_org_touch();
DROP FUNCTION user_authority_fanout();
DROP FUNCTION member_authority_user_touch();
DROP FUNCTION organisation_authority_advance();
"""


class Migration(migrations.Migration):
    dependencies = [("orgs", "0004_authority_revision")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
