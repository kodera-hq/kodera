import core.db.ids
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('orgs', '0021_remove_organisation_organisation_slug_not_reserved_and_more'),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.CreateModel(
            name='Attachment',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('filename', models.TextField()),
                ('content_type', models.TextField()),
                ('size_bytes', models.BigIntegerField()),
                ('sha256', models.TextField()),
                ('upload_expires_at', models.DateTimeField()),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('organisation', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='orgs.organisation')),
                ('uploader', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='orgs.membership')),
            ],
            options={
                'constraints': [models.CheckConstraint(condition=models.Q(('size_bytes__gte', 1), ('size_bytes__lte', 26214400)), name='media_attachment_size_bound'), models.CheckConstraint(condition=models.Q(('sha256__regex', '^[a-f0-9]{64}$')), name='media_attachment_checksum_valid'), models.CheckConstraint(condition=models.Q(('content_type__in', ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'application/octet-stream'])), name='media_attachment_mime_valid')],
            },
        ),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
