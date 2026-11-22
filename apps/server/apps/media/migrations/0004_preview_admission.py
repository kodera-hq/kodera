from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("media", "0003_attachment_scope_binding")]
    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.CreateModel(
            name="PreviewAdmission",
            fields=[
                ("key", models.CharField(max_length=80, primary_key=True, serialize=False)),
                ("expires_at", models.DateTimeField(db_index=True)),
                ("hits", models.PositiveSmallIntegerField(default=0)),
            ],
        ),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
