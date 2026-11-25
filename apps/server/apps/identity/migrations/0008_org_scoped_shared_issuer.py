"""Scope principal uniqueness by organisation while retaining staff NULLS NOT DISTINCT uniqueness."""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("identity", "0007_passport_magic_link"),
        ("orgs", "0036_self_serve_shared_realm"),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RemoveConstraint(
            model_name="identity",
            name="identity_issuer_subject_unique",
        ),
        migrations.RemoveConstraint(
            model_name="identity",
            name="identity_issuer_user_unique",
        ),
        migrations.AddConstraint(
            model_name="identity",
            constraint=models.UniqueConstraint(
                fields=("organisation", "issuer", "subject"),
                name="identity_issuer_subject_unique",
                nulls_distinct=False,
            ),
        ),
        migrations.AddConstraint(
            model_name="identity",
            constraint=models.UniqueConstraint(
                fields=("organisation", "issuer", "user"),
                name="identity_issuer_user_unique",
                nulls_distinct=False,
            ),
        ),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
