"""Support tickets (docs/specs/SUPPORT_TICKETS.md): the table, its checks and indexes, empty."""

import core.db.ids
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('identity', '0006_discovery_quotas'),
        ('orgs', '0017_invitations'),
        ('tenancy', '0002_guards'),
    ]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.CreateModel(
            name='SupportTicket',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('subject', models.TextField()),
                ('body', models.TextField()),
                ('category', models.TextField()),
                ('severity', models.TextField()),
                ('state', models.TextField(default='open')),
                ('locale', models.TextField()),
                ('reply_to_email', models.TextField(blank=True, null=True)),
                ('contact_email', models.TextField(blank=True, null=True)),
                ('tenant_slug', models.TextField(blank=True, null=True)),
                ('tenant_status', models.TextField(blank=True, null=True)),
                ('pack_code', models.TextField(blank=True, null=True)),
                ('capacity_tier_code', models.TextField(blank=True, null=True)),
                ('mail_enqueued_at', models.DateTimeField(blank=True, null=True)),
                ('mail_refused_at', models.DateTimeField(blank=True, null=True)),
                ('mail_delivery_id', models.UUIDField(blank=True, null=True)),
                ('mail_delivered_at', models.DateTimeField(blank=True, null=True)),
                ('mail_retried_at', models.DateTimeField(blank=True, null=True)),
                ('content_erased_at', models.DateTimeField(blank=True, null=True)),
                ('created_by', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='identity.identity')),
                ('organisation', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.organisation')),
                ('tenant', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='tenancy.tenant')),
            ],
            options={
                'indexes': [models.Index(fields=['organisation', 'created_at'], name='support_ticket_org_recent'), models.Index(fields=['created_by', 'created_at'], name='support_ticket_by_recent'), models.Index(condition=models.Q(('content_erased_at__isnull', True), ('mail_enqueued_at__isnull', True), ('mail_refused_at__isnull', True)), fields=['id'], name='support_ticket_mail_owed'), models.Index(condition=models.Q(('mail_delivery_id__isnull', False)), fields=['id'], name='support_ticket_mail_unsettled'), models.Index(condition=models.Q(('content_erased_at__isnull', True)), fields=['created_at'], name='support_ticket_content_held')],
                'constraints': [models.CheckConstraint(condition=models.Q(('category__in', ('calls', 'documents', 'login', 'domain', 'billing', 'capacity', 'security', 'other'))), name='support_ticket_category_valid'), models.CheckConstraint(condition=models.Q(('severity__in', ('question', 'degraded', 'blocked', 'outage'))), name='support_ticket_severity_valid'), models.CheckConstraint(condition=models.Q(('state__in', ('open', 'pending_customer', 'pending_kodera', 'solved', 'closed'))), name='support_ticket_state_valid'), models.CheckConstraint(condition=models.Q(('locale__in', ('fr', 'en'))), name='support_ticket_locale_valid'), models.CheckConstraint(condition=models.Q(('content_erased_at__isnull', False), ('subject__length__range', (3, 200)), _connector='OR'), name='support_ticket_subject_valid'), models.CheckConstraint(condition=models.Q(('content_erased_at__isnull', False), ('body__length__range', (10, 20000)), _connector='OR'), name='support_ticket_body_valid'), models.CheckConstraint(condition=models.Q(('content_erased_at__isnull', True), models.Q(('body', ''), ('contact_email__isnull', True), ('reply_to_email__isnull', True), ('subject', '')), _connector='OR'), name='support_ticket_content_erased')],
            },
        ),
    ]
