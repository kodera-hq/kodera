from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0021_remove_organisation_organisation_slug_not_reserved_and_more"),
        ("tenancy", "0005_reserve_community"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="tenant",
            name="tenancy_tenant_slug_not_reserved",
        ),
        migrations.AddField(
            model_name="tenant",
            name="is_default_community",
            field=models.BooleanField(default=False),
        ),
        migrations.AddConstraint(
            model_name="tenant",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(("is_default_community", True), ("slug", "community")),
                    models.Q(
                        models.Q(
                            (
                                "slug__in",
                                (
                                    "community",
                                    "www",
                                    "api",
                                    "app",
                                    "auth",
                                    "identity",
                                    "mail",
                                    "status",
                                    "staff",
                                    "admin",
                                    "kodera",
                                    "kodera-staff",
                                    "notify",
                                    "staging",
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
                        models.Q(("slug__startswith", "xn--"), _negated=True),
                    ),
                    _connector="OR",
                ),
                name="tenancy_tenant_slug_not_reserved",
            ),
        ),
        migrations.AddConstraint(
            model_name="tenant",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("is_default_community", False), ("slug", "community"), _connector="OR"
                ),
                name="tenancy_tenant_community_binding",
            ),
        ),
    ]
