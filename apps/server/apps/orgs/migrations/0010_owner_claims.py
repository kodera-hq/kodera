import core.db.functions
import core.db.ids
import datetime
import django.db.models.deletion
import django.db.models.expressions
from django.db import migrations, models


TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

FORWARD = r"""
ALTER TABLE orgs_organisationintake ADD CONSTRAINT owner_binding_intake_key UNIQUE (id,organisation_id);
ALTER TABLE identity_identity ADD CONSTRAINT owner_binding_identity_key UNIQUE (id,organisation_id,issuer,realm);
ALTER TABLE orgs_membership ADD CONSTRAINT owner_claim_membership_key UNIQUE (id,organisation_id);
ALTER TABLE orgs_ownerbinding ADD CONSTRAINT owner_binding_intake_fk FOREIGN KEY (intake_id,organisation_id) REFERENCES orgs_organisationintake(id,organisation_id) ON DELETE RESTRICT;
ALTER TABLE orgs_ownerbinding ADD CONSTRAINT owner_binding_organisation_fk FOREIGN KEY (organisation_id,issuer,realm) REFERENCES orgs_organisation(id,issuer,realm) ON DELETE RESTRICT;
ALTER TABLE orgs_ownerbinding ADD CONSTRAINT owner_binding_identity_fk FOREIGN KEY (identity_id,organisation_id,issuer,realm) REFERENCES identity_identity(id,organisation_id,issuer,realm) ON DELETE RESTRICT;
ALTER TABLE orgs_ownerbinding ADD CONSTRAINT owner_binding_recorder_staff_fk FOREIGN KEY (recorded_by_identity_id,recorded_by_realm) REFERENCES identity_identity(id,realm) ON DELETE RESTRICT;
ALTER TABLE orgs_ownerclaim ADD CONSTRAINT owner_claim_binding_fk FOREIGN KEY (organisation_id,intended_identity_id) REFERENCES orgs_ownerbinding(organisation_id,identity_id) ON DELETE RESTRICT;
ALTER TABLE orgs_ownerclaim ADD CONSTRAINT owner_claim_consumed_identity_fk FOREIGN KEY (consumed_by_identity_id) REFERENCES identity_identity(id) ON DELETE RESTRICT;
ALTER TABLE orgs_ownerclaim ADD CONSTRAINT owner_claim_membership_fk FOREIGN KEY (membership_id,organisation_id) REFERENCES orgs_membership(id,organisation_id) ON DELETE RESTRICT;
ALTER TABLE orgs_ownerclaim ADD CONSTRAINT owner_claim_revoker_staff_fk FOREIGN KEY (revoked_by_identity_id,revoked_by_realm) REFERENCES identity_identity(id,realm) ON DELETE RESTRICT;
ALTER TABLE orgs_ownerclaim ADD CONSTRAINT owner_claim_verifier_valid CHECK (encode(token_hash,'escape') ~ '^\$argon2id\$v=19\$m=65536,t=3,p=4\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$');

CREATE FUNCTION owner_binding_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP != 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='owner_binding_immutable', MESSAGE='An owner binding is retained and immutable';
  END IF;
  IF EXISTS (SELECT 1 FROM orgs_organisationintake WHERE id=NEW.intake_id AND recorded_by_identity_id=NEW.recorded_by_identity_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='owner_binding_two_person', MESSAGE='The owner binding must be recorded by another staff identity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_owner_binding_change BEFORE INSERT OR UPDATE OR DELETE ON orgs_ownerbinding FOR EACH ROW EXECUTE FUNCTION owner_binding_change();

CREATE FUNCTION owner_claim_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='owner_claim_immutable', MESSAGE='An owner claim is retained';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.state != 'issued' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='owner_claim_initial_issued', MESSAGE='A claim is inserted only as issued';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id,NEW.organisation_id,NEW.intended_identity_id,NEW.token_hash,NEW.expires_at,NEW.issued_at,NEW.delivery_id)
       IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.intended_identity_id,OLD.token_hash,OLD.expires_at,OLD.issued_at,OLD.delivery_id) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='owner_claim_immutable', MESSAGE='Claim issuance facts are immutable';
    END IF;
    IF OLD.state != 'issued' OR NEW.state NOT IN ('consumed','expired','revoked') THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='owner_claim_transition_valid', MESSAGE='Only an issued claim has a terminal transition';
    END IF;
  END IF;
  IF NEW.state = 'consumed' AND NOT EXISTS (
      SELECT 1 FROM orgs_membership m JOIN identity_identity i ON i.user_id=m.user_id
      WHERE m.id=NEW.membership_id AND m.organisation_id=NEW.organisation_id
        AND i.id=NEW.intended_identity_id AND m.role='org_owner' AND m.state='active'
        AND m.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='owner_claim_consumed_membership_valid', MESSAGE='Consumed claim names the intended active owner membership';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_owner_claim_change BEFORE INSERT OR UPDATE OR DELETE ON orgs_ownerclaim FOR EACH ROW EXECUTE FUNCTION owner_claim_change();
"""

REVERSE = r"""
DROP TRIGGER a_owner_claim_change ON orgs_ownerclaim;
DROP FUNCTION owner_claim_change();
DROP TRIGGER a_owner_binding_change ON orgs_ownerbinding;
DROP FUNCTION owner_binding_change();
ALTER TABLE orgs_ownerclaim DROP CONSTRAINT owner_claim_verifier_valid;
ALTER TABLE orgs_ownerclaim DROP CONSTRAINT owner_claim_revoker_staff_fk;
ALTER TABLE orgs_ownerclaim DROP CONSTRAINT owner_claim_membership_fk;
ALTER TABLE orgs_ownerclaim DROP CONSTRAINT owner_claim_consumed_identity_fk;
ALTER TABLE orgs_ownerclaim DROP CONSTRAINT owner_claim_binding_fk;
ALTER TABLE orgs_ownerbinding DROP CONSTRAINT owner_binding_recorder_staff_fk;
ALTER TABLE orgs_ownerbinding DROP CONSTRAINT owner_binding_identity_fk;
ALTER TABLE orgs_ownerbinding DROP CONSTRAINT owner_binding_organisation_fk;
ALTER TABLE orgs_ownerbinding DROP CONSTRAINT owner_binding_intake_fk;
ALTER TABLE orgs_membership DROP CONSTRAINT owner_claim_membership_key;
ALTER TABLE identity_identity DROP CONSTRAINT owner_binding_identity_key;
ALTER TABLE orgs_organisationintake DROP CONSTRAINT owner_binding_intake_key;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("identity", "0003_staff_identity"),
        ("orgs", "0009_realm_readiness"),
    ]

    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=migrations.RunSQL.noop),
        migrations.CreateModel(
            name="OwnerBinding",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("issuer", models.TextField()),
                ("realm", models.TextField()),
                ("recorded_by_realm", models.TextField(default="kodera-staff")),
                (
                    "recorded_at",
                    models.DateTimeField(db_default=core.db.functions.ClockTimestamp()),
                ),
                (
                    "identity",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="+",
                        to="identity.identity",
                    ),
                ),
                (
                    "intake",
                    models.OneToOneField(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="+",
                        to="orgs.organisationintake",
                    ),
                ),
                (
                    "organisation",
                    models.OneToOneField(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="+",
                        to="orgs.organisation",
                    ),
                ),
                (
                    "recorded_by_identity",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="+",
                        to="identity.identity",
                    ),
                ),
            ],
            options={
                "constraints": [
                    models.UniqueConstraint(
                        fields=("organisation", "identity"), name="owner_binding_claim_key"
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("recorded_by_realm", "kodera-staff")),
                        name="owner_binding_recorder_staff_realm",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="OwnerClaim",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("token_hash", models.BinaryField()),
                ("expires_at", models.DateTimeField()),
                (
                    "state",
                    models.TextField(
                        choices=[
                            ("issued", "Issued"),
                            ("consumed", "Consumed"),
                            ("expired", "Expired"),
                            ("revoked", "Revoked"),
                        ],
                        default="issued",
                    ),
                ),
                ("issued_at", models.DateTimeField(db_default=core.db.functions.ClockTimestamp())),
                ("delivery_id", models.UUIDField(unique=True)),
                ("consumed_at", models.DateTimeField(null=True)),
                ("revoked_at", models.DateTimeField(null=True)),
                ("revoked_by_realm", models.TextField(default="kodera-staff")),
                (
                    "consumed_by_identity",
                    models.ForeignKey(
                        db_constraint=False,
                        null=True,
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="+",
                        to="identity.identity",
                    ),
                ),
                (
                    "intended_identity",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="+",
                        to="identity.identity",
                    ),
                ),
                (
                    "membership",
                    models.ForeignKey(
                        db_constraint=False,
                        null=True,
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="+",
                        to="orgs.membership",
                    ),
                ),
                (
                    "organisation",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="+",
                        to="orgs.organisation",
                    ),
                ),
                (
                    "revoked_by_identity",
                    models.ForeignKey(
                        db_constraint=False,
                        null=True,
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="+",
                        to="identity.identity",
                    ),
                ),
            ],
            options={
                "constraints": [
                    models.UniqueConstraint(
                        condition=models.Q(("state", "issued")),
                        fields=("organisation",),
                        name="owner_claim_one_issued",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("expires_at__gt", models.F("issued_at")),
                            (
                                "expires_at__lte",
                                django.db.models.expressions.CombinedExpression(
                                    models.F("issued_at"),
                                    "+",
                                    models.Value(datetime.timedelta(days=7)),
                                ),
                            ),
                        ),
                        name="owner_claim_lifetime_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("revoked_by_realm", "kodera-staff")),
                        name="owner_claim_revoker_staff_realm",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            models.Q(
                                ("consumed_at__isnull", True),
                                ("consumed_by_identity__isnull", True),
                                ("membership__isnull", True),
                                ("revoked_at__isnull", True),
                                ("revoked_by_identity__isnull", True),
                                ("state", "issued"),
                            ),
                            models.Q(
                                ("consumed_at__gte", models.F("issued_at")),
                                ("consumed_at__isnull", False),
                                ("consumed_at__lt", models.F("expires_at")),
                                ("consumed_by_identity", models.F("intended_identity")),
                                ("consumed_by_identity__isnull", False),
                                ("membership__isnull", False),
                                ("revoked_at__isnull", True),
                                ("revoked_by_identity__isnull", True),
                                ("state", "consumed"),
                            ),
                            models.Q(
                                ("consumed_at__isnull", True),
                                ("consumed_by_identity__isnull", True),
                                ("membership__isnull", True),
                                ("revoked_at__gte", models.F("expires_at")),
                                ("revoked_at__isnull", False),
                                ("revoked_by_identity__isnull", True),
                                ("state", "expired"),
                            ),
                            models.Q(
                                ("consumed_at__isnull", True),
                                ("consumed_by_identity__isnull", True),
                                ("membership__isnull", True),
                                ("revoked_at__gte", models.F("issued_at")),
                                ("revoked_at__isnull", False),
                                ("revoked_by_identity__isnull", False),
                                ("state", "revoked"),
                            ),
                            _connector="OR",
                        ),
                        name="owner_claim_terminal_fields_valid",
                    ),
                ],
            },
        ),
        migrations.RunSQL(sql=FORWARD, reverse_sql=REVERSE),
        migrations.RunSQL(sql=migrations.RunSQL.noop, reverse_sql=TIMEOUTS),
    ]
