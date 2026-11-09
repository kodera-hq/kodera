"""A legal document keeps its text, the bytes its digest covers, so Core can serve it permanently.

The column is added empty: a row published before it has no text and no permanent URL, and the
append-only guard keeps it so. The check makes the digest the text's own, in the database.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("legal", "0002_guards"),
    ]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.AddField(
            model_name="legaldocument",
            name="text",
            field=models.TextField(blank=True, null=True),
        ),
        migrations.RunSQL(
            sql=(
                "ALTER TABLE legal_legaldocument ADD CONSTRAINT legal_document_text_digest "
                "CHECK (text IS NULL OR encode(sha256(convert_to(text, 'UTF8')), 'hex') = sha256)"
            ),
            reverse_sql=(
                "ALTER TABLE legal_legaldocument DROP CONSTRAINT legal_document_text_digest"
            ),
        ),
    ]
