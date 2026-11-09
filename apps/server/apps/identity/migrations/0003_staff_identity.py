import django.db.models.deletion
import django.db.models.functions.text
from django.db import migrations, models

import core.db.ids

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

FORWARD = r"""
ALTER TABLE identity_staffrole ADD CONSTRAINT staffrole_staff_identity_fk FOREIGN KEY (identity_id,realm) REFERENCES identity_identity(id,realm) ON DELETE RESTRICT;

CREATE FUNCTION staffrole_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='staffrole_delete_refused', MESSAGE='A staff role grant is retained';
  END IF;
  IF (NEW.id,NEW.identity_id,NEW.realm,NEW.role,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.identity_id,OLD.realm,OLD.role,OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='staffrole_immutable_grant', MESSAGE='A staff role grant is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='staffrole_revocation_final', MESSAGE='A staff role revocation is final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_staffrole_change BEFORE UPDATE OR DELETE ON identity_staffrole FOR EACH ROW EXECUTE FUNCTION staffrole_change();
"""

REVERSE = r"""
DROP TRIGGER a_staffrole_change ON identity_staffrole;
DROP FUNCTION staffrole_change();
ALTER TABLE identity_staffrole DROP CONSTRAINT staffrole_staff_identity_fk;
"""


class Migration(migrations.Migration):
    """Staff identities and staff role grants (docs/specs/STAFF_IDENTITY.md).

    An identity's organisation becomes nullable, null exactly for a staff-realm identity; the
    composite organisation binding keeps holding every customer identity, because a foreign key
    with a null column is not checked (MATCH SIMPLE). StaffRole grants a staff role to a staff
    identity only: its (identity_id, realm) references the identity's, and its realm is the
    staff realm. The finite lock and statement timeouts are set first in both directions.
    """

    dependencies = [
        ("identity", "0002_initial"),
        ("orgs", "0006_organisation_realm_not_staff"),
    ]

    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=migrations.RunSQL.noop),
        migrations.AlterField(
            model_name="identity",
            name="organisation",
            field=models.ForeignKey(
                blank=True,
                db_constraint=False,
                null=True,
                on_delete=django.db.models.deletion.RESTRICT,
                to="orgs.organisation",
            ),
        ),
        migrations.AddConstraint(
            model_name="identity",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("organisation__isnull", False), ("realm", "kodera-staff"), _connector="OR"
                ),
                name="identity_staff_realm_valid",
            ),
        ),
        migrations.AddConstraint(
            model_name="identity",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("organisation__isnull", False),
                    models.Q(
                        ("issuer__length__range", (1, 2048)),
                        (
                            "issuer__endswith",
                            django.db.models.functions.text.Concat(
                                models.Value("/realms/"), models.F("realm")
                            ),
                        ),
                    ),
                    _connector="OR",
                ),
                name="identity_staff_issuer_valid",
            ),
        ),
        migrations.AddConstraint(
            model_name="identity",
            constraint=models.UniqueConstraint(
                fields=("id", "realm"), name="identity_realm_binding_unique"
            ),
        ),
        migrations.CreateModel(
            name="StaffRole",
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
                ("realm", models.TextField(default="kodera-staff")),
                (
                    "role",
                    models.TextField(
                        choices=[
                            ("staff_operator", "Operator"),
                            ("staff_support", "Support"),
                            ("staff_security", "Security"),
                        ]
                    ),
                ),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                (
                    "identity",
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
                        condition=models.Q(
                            ("role__in", ("staff_operator", "staff_support", "staff_security"))
                        ),
                        name="staffrole_role_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("realm", "kodera-staff")),
                        name="staffrole_realm_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("revoked_at__isnull", True),
                            ("revoked_at__gte", models.F("created_at")),
                            _connector="OR",
                        ),
                        name="staffrole_revocation_valid",
                    ),
                    models.UniqueConstraint(
                        condition=models.Q(("revoked_at__isnull", True)),
                        fields=("identity", "role"),
                        name="staffrole_one_current_grant",
                    ),
                ],
            },
        ),
        migrations.RunSQL(FORWARD, reverse_sql=REVERSE),
        migrations.RunSQL(sql=migrations.RunSQL.noop, reverse_sql=TIMEOUTS),
    ]
