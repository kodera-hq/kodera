"""Zero-PII in-app bug report collector queue, keyed-HMAC rate limits, and circuit breaker."""

import core.db.ids
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('support', '0001_initial'),
    ]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.CreateModel(
            name='BugReport',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('build_id', models.TextField()),
                ('component', models.TextField()),
                ('error_code', models.TextField()),
                ('device_class', models.TextField()),
                ('consent', models.BooleanField(default=False)),
                ('sanitized_note', models.TextField(blank=True, default='')),
                ('screenshot_content_type', models.TextField(blank=True, null=True)),
                ('screenshot_bytes', models.BinaryField(blank=True, null=True)),
                ('screenshot_sha256', models.TextField(blank=True, null=True)),
                ('dedup_fingerprint', models.TextField()),
                ('occurrences', models.PositiveIntegerField(default=1)),
                ('claimed_at', models.DateTimeField(blank=True, db_default=None, null=True)),
                ('claim_token', models.CharField(blank=True, db_default='', default='', max_length=64)),
                ('dispatched_at', models.DateTimeField(blank=True, db_default=None, null=True)),
                ('github_issue_number', models.PositiveIntegerField(blank=True, db_default=None, null=True)),
                ('dispatch_attempts', models.PositiveIntegerField(db_default=0, default=0)),
                ('last_dispatch_error', models.TextField(blank=True, db_default='', default='')),
            ],
            options={
                'indexes': [models.Index(fields=['dedup_fingerprint', 'created_at'], name='support_bugreport_dedup_24h'), models.Index(condition=models.Q(('dispatched_at__isnull', True)), fields=['created_at'], name='support_bugreport_undispatched'), models.Index(condition=models.Q(('dispatched_at__isnull', False)), fields=['dispatched_at'], name='support_bugreport_dispatched')],
                'constraints': [models.CheckConstraint(condition=models.Q(('component__in', ('workspace', 'messaging', 'calls', 'docs', 'files', 'auth', 'billing', 'settings', 'confidential', 'desktop', 'mobile', 'other'))), name='support_bugreport_component_valid'), models.CheckConstraint(condition=models.Q(('device_class__in', ('web-desktop', 'web-mobile', 'desktop-macos', 'desktop-linux', 'desktop-windows', 'ios', 'android'))), name='support_bugreport_device_valid'), models.CheckConstraint(condition=models.Q(('build_id__length__range', (1, 64))), name='support_bugreport_build_len'), models.CheckConstraint(condition=models.Q(('error_code__length__range', (1, 80))), name='support_bugreport_error_len'), models.CheckConstraint(condition=models.Q(('sanitized_note__length__lte', 2048)), name='support_bugreport_note_len'), models.CheckConstraint(condition=models.Q(('dedup_fingerprint__length', 64)), name='support_bugreport_dedup_len'), models.CheckConstraint(condition=models.Q(('occurrences__gte', 1)), name='support_bugreport_occurrences_pos'), models.CheckConstraint(condition=models.Q(('consent', True), models.Q(('sanitized_note', ''), ('screenshot_bytes__isnull', True), ('screenshot_content_type__isnull', True), ('screenshot_sha256__isnull', True)), _connector='OR'), name='support_bugreport_consent_required'), models.CheckConstraint(condition=models.Q(models.Q(('screenshot_bytes__isnull', True), ('screenshot_content_type__isnull', True), ('screenshot_sha256__isnull', True)), models.Q(('screenshot_bytes__isnull', False), ('screenshot_content_type__in', ('image/png', 'image/webp')), ('screenshot_sha256__length', 64)), _connector='OR'), name='support_bugreport_screenshot_coherent'), models.CheckConstraint(condition=models.Q(('dispatched_at__isnull', True), models.Q(('claim_token', ''), ('claimed_at__isnull', True), ('sanitized_note', ''), ('screenshot_bytes__isnull', True), ('screenshot_content_type__isnull', True), ('screenshot_sha256__isnull', True)), _connector='OR'), name='support_bugreport_dispatched_scrubbed')],
            },
        ),
        migrations.CreateModel(
            name='BugReportCircuitState',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('singleton', models.BooleanField(default=True, unique=True)),
                ('consecutive_failures', models.PositiveIntegerField(default=0)),
                ('opened_until', models.DateTimeField(blank=True, null=True)),
                ('last_failure_at', models.DateTimeField(blank=True, null=True)),
                ('last_error_code', models.TextField(blank=True, default='')),
            ],
            options={
                'constraints': [models.CheckConstraint(condition=models.Q(('singleton', True)), name='support_bugcircuit_singleton')],
            },
        ),
        migrations.CreateModel(
            name='BugReportRateEvent',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('tier', models.TextField()),
                ('bucket_digest', models.TextField()),
            ],
            options={
                'indexes': [models.Index(fields=['tier', 'bucket_digest', 'created_at'], name='support_bugrate_window'), models.Index(fields=['created_at'], name='support_bugrate_created')],
                'constraints': [models.CheckConstraint(condition=models.Q(('tier__in', ('member', 'org', 'global'))), name='support_bugrate_tier_valid'), models.CheckConstraint(condition=models.Q(('bucket_digest__length', 64)), name='support_bugrate_digest_len')],
            },
        ),
    ]
