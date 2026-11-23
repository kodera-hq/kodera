"""Admit bounded async voice-note audio MIME types (audio/ogg, audio/webm, audio/mp4)."""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"


class Migration(migrations.Migration):
    dependencies = [
        ("media", "0004_preview_admission"),
    ]

    operations = [
        migrations.RunSQL(TIMEOUTS, migrations.RunSQL.noop),
        migrations.RemoveConstraint(
            model_name="attachment",
            name="media_attachment_mime_valid",
        ),
        migrations.AddConstraint(
            model_name="attachment",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    content_type__in=[
                        "image/jpeg",
                        "image/png",
                        "image/webp",
                        "image/gif",
                        "application/pdf",
                        "text/plain",
                        "application/octet-stream",
                        "audio/ogg",
                        "audio/webm",
                        "audio/mp4",
                    ]
                ),
                name="media_attachment_mime_valid",
            ),
        ),
        migrations.RunSQL(migrations.RunSQL.noop, TIMEOUTS),
    ]
