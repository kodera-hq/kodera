"""Legal documents, DPAs and acceptances, their checks and indexes, on empty tables."""

import core.db.ids
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('orgs', '0003_organisation_slug_minimum_five'),
    ]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.CreateModel(
            name='LegalDocument',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('code', models.TextField()),
                ('version', models.TextField()),
                ('locale', models.TextField()),
                ('title', models.TextField()),
                ('pack_code', models.TextField(blank=True, null=True)),
                ('html_url', models.TextField(blank=True, null=True)),
                ('sha256', models.TextField()),
                ('sub_processors', models.JSONField(blank=True, default=list)),
                ('published_at', models.DateTimeField()),
            ],
            options={
                'constraints': [models.CheckConstraint(condition=models.Q(('code__in', ('cgv', 'dpa', 'sla', 'aup'))), name='legal_document_code_valid'), models.CheckConstraint(condition=models.Q(('locale__in', ('fr', 'en'))), name='legal_document_locale_valid'), models.CheckConstraint(condition=models.Q(('version__regex', '^[0-9A-Za-z.-]{1,20}$')), name='legal_document_version_valid'), models.CheckConstraint(condition=models.Q(('sha256__regex', '^[0-9a-f]{64}$')), name='legal_document_sha256_valid'), models.UniqueConstraint(fields=('code', 'version', 'locale'), name='legal_document_version_unique')],
            },
        ),
        migrations.CreateModel(
            name='Dpa',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('tenant_id', models.UUIDField(blank=True, null=True)),
                ('pack_code', models.TextField()),
                ('locale', models.TextField()),
                ('version', models.TextField()),
                ('sha256', models.TextField()),
                ('sub_processors', models.JSONField(blank=True, default=list)),
                ('state', models.TextField(default='generated')),
                ('accepted_at', models.DateTimeField(blank=True, null=True)),
                ('accepted_by_identity_id', models.UUIDField(blank=True, null=True)),
                ('accepted_by_person_id', models.UUIDField(blank=True, null=True)),
                ('accepted_by_name', models.TextField(blank=True, null=True)),
                ('accepted_by_email', models.TextField(blank=True, null=True)),
                ('accepted_by_role', models.TextField(blank=True, null=True)),
                ('organisation', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.organisation')),
                ('superseded_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='legal.dpa')),
                ('template', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='legal.legaldocument')),
            ],
        ),
        migrations.CreateModel(
            name='Acceptance',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('identity_id', models.UUIDField()),
                ('order_id', models.UUIDField()),
                ('accepted_at', models.DateTimeField()),
                ('accepted_by_name', models.TextField(blank=True, null=True)),
                ('accepted_by_role', models.TextField(blank=True, null=True)),
                ('source_ip_trunc', models.GenericIPAddressField(blank=True, null=True)),
                ('user_agent', models.TextField(blank=True, null=True)),
                ('organisation', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.organisation')),
                ('dpa', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='legal.dpa')),
                ('document', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='legal.legaldocument')),
            ],
        ),
        migrations.AddIndex(
            model_name='dpa',
            index=models.Index(fields=['organisation', '-created_at'], name='legal_dpa_org_idx'),
        ),
        migrations.AddConstraint(
            model_name='dpa',
            constraint=models.CheckConstraint(condition=models.Q(('state__in', ('generated', 'accepted', 'superseded'))), name='legal_dpa_state_valid'),
        ),
        migrations.AddConstraint(
            model_name='dpa',
            constraint=models.CheckConstraint(condition=models.Q(('locale__in', ('fr', 'en'))), name='legal_dpa_locale_valid'),
        ),
        migrations.AddConstraint(
            model_name='dpa',
            constraint=models.CheckConstraint(condition=models.Q(('sha256__regex', '^[0-9a-f]{64}$')), name='legal_dpa_sha256_valid'),
        ),
        migrations.AddConstraint(
            model_name='dpa',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('accepted_at__isnull', True), ('state', 'generated')), models.Q(('state__in', ('accepted', 'superseded')), ('accepted_at__isnull', False), ('accepted_by_identity_id__isnull', False), ('accepted_by_person_id__isnull', False), ('accepted_by_email__isnull', False), ('accepted_by_name__isnull', False)), models.Q(('accepted_at__isnull', True), ('state', 'superseded')), _connector='OR'), name='legal_dpa_accepted_valid'),
        ),
        migrations.AddConstraint(
            model_name='dpa',
            constraint=models.UniqueConstraint(condition=models.Q(('state', 'generated')), fields=('organisation', 'pack_code', 'locale'), name='legal_dpa_one_generated'),
        ),
        migrations.AddConstraint(
            model_name='acceptance',
            constraint=models.UniqueConstraint(fields=('order_id', 'document'), name='legal_acceptance_once_per_order'),
        ),
        migrations.AddConstraint(
            model_name='acceptance',
            constraint=models.CheckConstraint(condition=models.Q(('user_agent__isnull', True), ('user_agent__length__lte', 500), _connector='OR'), name='legal_acceptance_user_agent_valid'),
        ),
    ]
