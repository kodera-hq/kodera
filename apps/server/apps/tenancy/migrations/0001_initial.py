"""The tenant table an order writes, its checks and its never-reused slug (ADR-0008)."""

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
            name='Tenant',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('slug', models.TextField(unique=True)),
                ('name', models.TextField()),
                ('status', models.TextField(default='ordered')),
                ('status_changed_at', models.DateTimeField()),
                ('pack_code', models.TextField()),
                ('capacity_tier_code', models.TextField()),
                ('apps', models.JSONField()),
                ('region', models.TextField(default='fr-par')),
                ('realm', models.TextField(blank=True, null=True)),
                ('profile_ref', models.TextField(blank=True, null=True)),
                ('locale', models.TextField(default='fr')),
                ('organisation', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.organisation')),
            ],
            options={
                'constraints': [models.CheckConstraint(condition=models.Q(('slug__regex', '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$')), name='tenancy_tenant_slug_valid'), models.CheckConstraint(condition=models.Q(models.Q(('slug__in', ('www', 'api', 'app', 'auth', 'identity', 'mail', 'status', 'staff', 'admin', 'kodera', 'kodera-staff')), _negated=True), models.Q(('slug__startswith', 'xn--'), _negated=True)), name='tenancy_tenant_slug_not_reserved'), models.CheckConstraint(condition=models.Q(('status__in', ('ordered', 'provisioning', 'ready', 'active', 'upgrading', 'maintenance', 'suspended', 'decommissioning', 'deleted', 'failed'))), name='tenancy_tenant_status_valid'), models.CheckConstraint(condition=models.Q(('region', 'fr-par')), name='tenancy_tenant_region_valid'), models.CheckConstraint(condition=models.Q(('locale__in', ('fr', 'en'))), name='tenancy_tenant_locale_valid'), models.CheckConstraint(condition=models.Q(('name__length__range', (1, 200))), name='tenancy_tenant_name_valid')],
            },
        ),
    ]
