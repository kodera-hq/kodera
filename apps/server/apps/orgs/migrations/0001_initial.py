import core.db.ids
import django.db.models.deletion
import django.db.models.functions.text
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('identity', '0001_initial'),
    ]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.CreateModel(
            name='Organisation',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('deleted_at', models.DateTimeField(blank=True, null=True)),
                ('purge_after', models.DateTimeField(blank=True, null=True)),
                ('slug', models.TextField()),
                ('realm', models.TextField()),
                ('issuer', models.TextField()),
                ('name', models.TextField()),
                ('state', models.TextField(choices=[('prospect', 'Prospect'), ('active', 'Active'), ('suspended', 'Suspended'), ('closed', 'Closed')], default='prospect')),
                ('owner_guard_revision', models.BigIntegerField(default=0)),
            ],
            options={
                'abstract': False,
                'constraints': [models.CheckConstraint(condition=models.Q(models.Q(('deleted_at__isnull', True), ('purge_after__isnull', True)), models.Q(('deleted_at__isnull', False), ('purge_after__gt', models.F('deleted_at')), ('purge_after__isnull', False)), _connector='OR'), name='organisation_deletion_valid'), models.CheckConstraint(condition=models.Q(('slug__regex', '^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])$')), name='organisation_slug_valid'), models.CheckConstraint(condition=models.Q(('realm', models.F('slug'))), name='organisation_realm_valid'), models.CheckConstraint(condition=models.Q(('issuer__length__range', (1, 2048)), ('issuer__endswith', django.db.models.functions.text.Concat(models.Value('/realms/'), models.F('realm')))), name='organisation_issuer_valid'), models.UniqueConstraint(fields=('issuer',), name='organisation_issuer_unique'), models.UniqueConstraint(fields=('id', 'issuer', 'realm'), name='organisation_identity_binding_unique'), models.CheckConstraint(condition=models.Q(('name__length__range', (1, 200))), name='organisation_name_valid'), models.CheckConstraint(condition=models.Q(('state__in', ['prospect', 'active', 'suspended', 'closed'])), name='organisation_state_valid')],
            },
        ),
        migrations.CreateModel(
            name='Membership',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('deleted_at', models.DateTimeField(blank=True, null=True)),
                ('purge_after', models.DateTimeField(blank=True, null=True)),
                ('role', models.TextField(choices=[('org_owner', 'Owner'), ('org_admin', 'Admin'), ('org_billing', 'Billing'), ('org_member', 'Member')])),
                ('state', models.TextField(choices=[('invited', 'Invited'), ('active', 'Active'), ('suspended', 'Suspended'), ('removed', 'Removed')], default='invited')),
                ('accepted_at', models.DateTimeField(blank=True, null=True)),
                ('user', models.ForeignKey(db_constraint=False, on_delete=django.db.models.deletion.RESTRICT, to='identity.user')),
                ('organisation', models.ForeignKey(db_constraint=False, on_delete=django.db.models.deletion.RESTRICT, to='orgs.organisation')),
            ],
            options={
                'abstract': False,
                'constraints': [models.CheckConstraint(condition=models.Q(models.Q(('deleted_at__isnull', True), ('purge_after__isnull', True)), models.Q(('deleted_at__isnull', False), ('purge_after__gt', models.F('deleted_at')), ('purge_after__isnull', False)), _connector='OR'), name='membership_deletion_valid'), models.CheckConstraint(condition=models.Q(('role__in', ['org_owner', 'org_admin', 'org_billing', 'org_member'])), name='membership_role_valid'), models.CheckConstraint(condition=models.Q(('state__in', ['invited', 'active', 'suspended', 'removed'])), name='membership_state_valid'), models.CheckConstraint(condition=models.Q(models.Q(('state__in', ['invited', 'active', 'suspended', 'removed']), _negated=True), models.Q(('accepted_at__isnull', True), ('state', 'invited')), models.Q(('accepted_at__isnull', False), ('state__in', ['active', 'suspended'])), ('state', 'removed'), _connector='OR'), name='membership_acceptance_valid'), models.UniqueConstraint(condition=models.Q(('deleted_at__isnull', True)), fields=('user', 'organisation'), name='membership_current_unique')],
            },
        ),
        migrations.CreateModel(
            name='SlugReservation',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('namespace', models.TextField(default='organisation')),
                ('slug', models.TextField()),
                ('state', models.TextField(choices=[('provisional', 'Provisional'), ('permanent', 'Permanent'), ('retired', 'Retired')], default='provisional')),
                ('protected_at', models.DateTimeField(blank=True, null=True)),
                ('organisation', models.OneToOneField(db_constraint=False, on_delete=django.db.models.deletion.RESTRICT, to='orgs.organisation')),
            ],
            options={
                'constraints': [models.CheckConstraint(condition=models.Q(('namespace', 'organisation')), name='reservation_namespace_valid'), models.CheckConstraint(condition=models.Q(('state__in', ['provisional', 'permanent', 'retired'])), name='reservation_state_valid'), models.CheckConstraint(condition=models.Q(models.Q(('state__in', ['provisional', 'permanent', 'retired']), _negated=True), models.Q(('protected_at__isnull', True), ('state', 'provisional')), models.Q(('protected_at__isnull', False), ('state__in', ['permanent', 'retired'])), _connector='OR'), name='reservation_protection_valid'), models.UniqueConstraint(fields=('namespace', 'slug'), name='reservation_namespace_slug_unique')],
            },
        ),
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
