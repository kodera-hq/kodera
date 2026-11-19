"""Index the two title buckets touched by document creation and renaming."""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("docs", "0008_privacy_cutoff_guards")]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddIndex(
            model_name="documentlink",
            index=models.Index(fields=["target_title"], name="docs_link_title_lookup"),
        ),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
