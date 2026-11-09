import django.db.models.deletion
from django.db import migrations, models

import core.db.ids

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

FORWARD = r"""
ALTER TABLE orgs_organisationintake ADD CONSTRAINT intake_organisation_fk FOREIGN KEY (organisation_id) REFERENCES orgs_organisation(id) ON DELETE RESTRICT;
ALTER TABLE orgs_organisationintake ADD CONSTRAINT intake_recorder_staff_fk FOREIGN KEY (recorded_by_identity_id,recorded_by_realm) REFERENCES identity_identity(id,realm) ON DELETE RESTRICT;

CREATE FUNCTION organisation_intake_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='intake_immutable', MESSAGE='An intake record is never changed or deleted';
END $$;
CREATE TRIGGER a_organisation_intake_change BEFORE UPDATE OR DELETE ON orgs_organisationintake FOR EACH ROW EXECUTE FUNCTION organisation_intake_change();
"""

REVERSE = r"""
DROP TRIGGER a_organisation_intake_change ON orgs_organisationintake;
DROP FUNCTION organisation_intake_change();
ALTER TABLE orgs_organisationintake DROP CONSTRAINT intake_recorder_staff_fk;
ALTER TABLE orgs_organisationintake DROP CONSTRAINT intake_organisation_fk;
"""


class Migration(migrations.Migration):
    """The staff intake record (docs/specs/ORGANISATION_INTAKE.md).

    One intake per organisation, recorded by a staff identity: (recorded_by_identity_id,
    recorded_by_realm) references identity_identity(id, realm), and the realm is the staff realm,
    so a customer identity can never be the recorder. The row is a record of fact, refused any
    UPDATE or DELETE by its trigger. bootstrap_job_id carries no foreign key: the job queue is
    another application, installed by profiles this application's migrations must not depend on.
    The finite lock and statement timeouts are set first in both directions.
    """

    dependencies = [
        ("identity", "0003_staff_identity"),
        ("orgs", "0006_organisation_realm_not_staff"),
    ]

    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=migrations.RunSQL.noop),
        migrations.CreateModel(
            name="OrganisationIntake",
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
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("recorded_by_realm", models.TextField(default="kodera-staff")),
                ("instruction_ref", models.TextField()),
                ("sealed_contact", models.BinaryField()),
                ("intended_owner_email_masked", models.TextField()),
                ("bootstrap_job_id", models.UUIDField()),
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
                    models.CheckConstraint(
                        condition=models.Q(("recorded_by_realm", "kodera-staff")),
                        name="intake_recorder_staff_realm",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("instruction_ref__length__range", (1, 200))),
                        name="intake_instruction_ref_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("intended_owner_email_masked__length__range", (3, 320))),
                        name="intake_owner_masked_valid",
                    ),
                    models.UniqueConstraint(
                        fields=("bootstrap_job_id",), name="intake_bootstrap_job_unique"
                    ),
                ],
            },
        ),
        migrations.RunSQL(sql=FORWARD, reverse_sql=REVERSE),
        migrations.RunSQL(sql=migrations.RunSQL.noop, reverse_sql=TIMEOUTS),
    ]
