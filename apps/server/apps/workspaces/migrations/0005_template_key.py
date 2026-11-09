"""The starter template's stable row key (PILOT_WORKSPACE_ONBOARDING.md §2), under bounded locks.

Nullable: a row a person creates has none. Guarded by the contract's WorkspaceTemplateKey pattern
and unique within its kind in one workspace.
"""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"
PATTERN = "^[a-z][a-z0-9_]{0,31}$"


def key_field():
    return models.TextField(blank=True, null=True)


def valid(name):
    return models.CheckConstraint(
        condition=models.Q(("template_key__isnull", True), ("template_key__regex", PATTERN), _connector="OR"),
        name=name,
    )


def unique(name):
    return models.UniqueConstraint(
        condition=models.Q(("template_key__isnull", False)),
        fields=("workspace", "template_key"),
        name=name,
    )


class Migration(migrations.Migration):
    dependencies = [("workspaces", "0004_policy_integrity")]
    operations = [
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.AddField(model_name="category", name="template_key", field=key_field()),
        migrations.AddField(model_name="channel", name="template_key", field=key_field()),
        migrations.AddConstraint(model_name="category", constraint=valid("category_template_key_valid")),
        migrations.AddConstraint(model_name="category", constraint=unique("category_template_key_unique")),
        migrations.AddConstraint(model_name="channel", constraint=valid("channel_template_key_valid")),
        migrations.AddConstraint(model_name="channel", constraint=unique("channel_template_key_unique")),
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
    ]
