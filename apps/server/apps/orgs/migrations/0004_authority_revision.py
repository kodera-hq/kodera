"""Add a distinct authority baseline; it acknowledges no external projection."""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"


class Migration(migrations.Migration):
    dependencies = [("orgs", "0003_organisation_slug_minimum_five")]

    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=migrations.RunSQL.noop),
        migrations.AddField(
            model_name="organisation",
            name="authority_revision",
            field=models.BigIntegerField(default=1),
        ),
        migrations.AddConstraint(
            model_name="organisation",
            constraint=models.CheckConstraint(
                condition=models.Q(authority_revision__gte=1),
                name="organisation_authority_revision_valid",
            ),
        ),
        migrations.RunSQL(sql=migrations.RunSQL.noop, reverse_sql=TIMEOUTS),
    ]
