"""Pin each organisation to its admitted OIDC audience."""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';"


class Migration(migrations.Migration):
    dependencies = [("orgs", "0036_self_serve_shared_realm")]

    operations = [
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.AddField(
            model_name="organisation",
            name="oidc_audience",
            field=models.TextField(default="kodera-server", db_default="kodera-server"),
        ),
        migrations.AddConstraint(
            model_name="organisation",
            constraint=models.CheckConstraint(
                name="organisation_oidc_audience_valid",
                condition=models.Q(oidc_audience__regex=r"^[!-~]{1,255}$"),
            ),
        ),
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
    ]
