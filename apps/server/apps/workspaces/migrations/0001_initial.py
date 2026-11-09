"""Create structure rows and named scalar/unique constraints before cross-table guards."""

import core.db.ids
from django.db import migrations, models
from django.db.models.functions import Length
from django.db.models.lookups import GreaterThan


def stored_fields():
    return [
        ("id", models.UUIDField(default=core.db.ids.new_uuid7, editable=False,
                                primary_key=True, serialize=False)),
        ("created_at", models.DateTimeField(auto_now_add=True)),
        ("updated_at", models.DateTimeField(auto_now=True)),
    ]


def name_constraint(name):
    trimmed = models.Func(
        models.F("name"), models.Value(" \t\n\r"),
        function="BTRIM", output_field=models.TextField(),
    )
    return models.CheckConstraint(
        name=name,
        condition=models.Q(name__length__range=(1, 100))
        & models.Q(GreaterThan(Length(trimmed), models.Value(0))),
    )


class Migration(migrations.Migration):
    initial = True
    dependencies = [("orgs", "0003_organisation_slug_minimum_five")]
    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.CreateModel(
            name="Workspace",
            fields=[
                *stored_fields(),
                ("organisation", models.ForeignKey(
                    to="orgs.organisation", on_delete=models.RESTRICT, db_constraint=False,
                )),
                ("structure_revision", models.BigIntegerField(default=1)),
            ],
            options={"constraints": [
                models.UniqueConstraint(
                    fields=["organisation"], name="workspace_organisation_unique",
                ),
                models.CheckConstraint(
                    name="workspace_revision_valid", condition=models.Q(structure_revision__gt=0),
                ),
            ]},
        ),
        migrations.CreateModel(
            name="Category",
            fields=[
                *stored_fields(),
                ("workspace", models.ForeignKey(
                    to="workspaces.workspace", on_delete=models.RESTRICT, db_constraint=False,
                )),
                ("name", models.TextField()),
                ("position", models.IntegerField()),
                ("version", models.BigIntegerField(default=1)),
            ],
            options={"constraints": [
                name_constraint("category_name_valid"),
                models.CheckConstraint(
                    name="category_position_valid", condition=models.Q(position__gte=0),
                ),
                models.CheckConstraint(
                    name="category_version_valid", condition=models.Q(version__gt=0),
                ),
                models.UniqueConstraint(
                    fields=["workspace", "position"], name="category_position_unique",
                ),
                models.UniqueConstraint(
                    fields=["id", "workspace"], name="category_id_workspace_unique",
                ),
            ]},
        ),
        migrations.CreateModel(
            name="Channel",
            fields=[
                *stored_fields(),
                ("workspace", models.ForeignKey(
                    to="workspaces.workspace", on_delete=models.RESTRICT, db_constraint=False,
                )),
                ("category", models.ForeignKey(
                    to="workspaces.category", on_delete=models.RESTRICT,
                    db_constraint=False, null=True, blank=True,
                )),
                ("kind", models.TextField(choices=[("text", "Text"), ("audio", "Audio")])),
                ("name", models.TextField()),
                ("topic", models.TextField(default="", blank=True)),
                ("position", models.IntegerField()),
                ("version", models.BigIntegerField(default=1)),
            ],
            options={"constraints": [
                models.CheckConstraint(
                    name="channel_kind_valid", condition=models.Q(kind__in=["text", "audio"]),
                ),
                name_constraint("channel_name_valid"),
                models.CheckConstraint(
                    name="channel_topic_valid", condition=models.Q(topic__length__range=(0, 1024)),
                ),
                models.CheckConstraint(
                    name="channel_position_valid", condition=models.Q(position__gte=0),
                ),
                models.CheckConstraint(
                    name="channel_version_valid", condition=models.Q(version__gt=0),
                ),
                models.UniqueConstraint(
                    fields=["workspace", "category", "position"],
                    name="channel_position_unique", nulls_distinct=False,
                ),
            ]},
        ),
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
