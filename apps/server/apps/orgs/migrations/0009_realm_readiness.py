import django.db.models.deletion
from django.db import migrations, models

import core.db.functions
import core.db.ids

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

FORWARD = r"""
ALTER TABLE orgs_realmreadiness ADD CONSTRAINT realm_readiness_organisation_binding_fk FOREIGN KEY (organisation_id,issuer,realm) REFERENCES orgs_organisation(id,issuer,realm) ON DELETE RESTRICT;
ALTER TABLE orgs_realmreadiness ADD CONSTRAINT realm_readiness_recorder_staff_fk FOREIGN KEY (recorded_by_identity_id,recorded_by_realm) REFERENCES identity_identity(id,realm) ON DELETE RESTRICT;

CREATE FUNCTION realm_readiness_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.revoked_at IS NULL
     AND (NEW.id, NEW.organisation_id, NEW.issuer, NEW.realm, NEW.job_id, NEW.recorded_by_identity_id, NEW.recorded_by_realm, NEW.recorded_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.organisation_id, OLD.issuer, OLD.realm, OLD.job_id, OLD.recorded_by_identity_id, OLD.recorded_by_realm, OLD.recorded_at)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='realm_readiness_immutable', MESSAGE='A realm readiness fact is never deleted, and only its revocation is ever set, once';
END $$;
CREATE TRIGGER a_realm_readiness_change BEFORE UPDATE OR DELETE ON orgs_realmreadiness FOR EACH ROW EXECUTE FUNCTION realm_readiness_change();
"""

REVERSE = r"""
DROP TRIGGER a_realm_readiness_change ON orgs_realmreadiness;
DROP FUNCTION realm_readiness_change();
ALTER TABLE orgs_realmreadiness DROP CONSTRAINT realm_readiness_recorder_staff_fk;
ALTER TABLE orgs_realmreadiness DROP CONSTRAINT realm_readiness_organisation_binding_fk;
"""


class Migration(migrations.Migration):
    """The realm-ready fact (docs/specs/REALM_DISCOVERY.md, FIRST_OWNER_BOOTSTRAP.md §5.4 PC-8).

    (organisation_id, issuer, realm) references the organisation's own (id, issuer, realm), unique
    there as organisation_identity_binding_unique, so a fact names its organisation's exact issuer
    and realm or nothing. The recorder is a staff identity, by (id, realm) as for the intake. One
    fact per realm_create job. The trigger refuses a DELETE and every UPDATE but the one that sets
    revoked_at, once. job_id carries no foreign key: the queue is another application. The finite
    lock and statement timeouts are set first in both directions.
    """

    dependencies = [
        ("identity", "0003_staff_identity"),
        ("orgs", "0008_reserved_slugs_and_instruction_ref"),
    ]

    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=migrations.RunSQL.noop),
        migrations.CreateModel(
            name="RealmReadiness",
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
                ("job_id", models.UUIDField()),
                ("recorded_by_realm", models.TextField(default="kodera-staff")),
                (
                    "recorded_at",
                    models.DateTimeField(db_default=core.db.functions.ClockTimestamp()),
                ),
                ("revoked_at", models.DateTimeField(null=True)),
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
                    models.UniqueConstraint(fields=("job_id",), name="realm_readiness_job_unique"),
                    models.CheckConstraint(
                        condition=models.Q(("recorded_by_realm", "kodera-staff")),
                        name="realm_readiness_recorder_staff_realm",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("revoked_at__isnull", True))
                        | models.Q(("revoked_at__gte", models.F("recorded_at"))),
                        name="realm_readiness_revocation_valid",
                    ),
                ],
            },
        ),
        migrations.RunSQL(sql=FORWARD, reverse_sql=REVERSE),
        migrations.RunSQL(sql=migrations.RunSQL.noop, reverse_sql=TIMEOUTS),
    ]
