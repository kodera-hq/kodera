"""Permit only the explicitly marked first-party community reserved name."""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0020_reserve_community"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="organisation",
            name="organisation_slug_not_reserved",
        ),
        migrations.AddField(
            model_name="organisation",
            name="is_default_community",
            field=models.BooleanField(default=False),
        ),
        migrations.AddConstraint(
            model_name="organisation",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(
                        (
                            "slug__in",
                            (
                                "community",
                                "master",
                                "kodera-staff",
                                "kodera-probe",
                                "kodera-dev",
                                "kodera",
                                "staff",
                                "admin",
                                "notify",
                                "staging",
                                "status",
                                "support",
                                "billing",
                                "console",
                                "developers",
                                "matrix",
                                "auth-admin",
                                "auth-mail",
                                "errors",
                                "ops-admin",
                            ),
                        ),
                        _negated=True,
                    ),
                    models.Q(("is_default_community", True), ("slug", "community")),
                    _connector="OR",
                ),
                name="organisation_slug_not_reserved",
            ),
        ),
        migrations.AddConstraint(
            model_name="organisation",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("is_default_community", False), ("slug", "community"), _connector="OR"
                ),
                name="organisation_community_slug",
            ),
        ),
    ]
