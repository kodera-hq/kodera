import core.db.ids
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('orgs', '0021_remove_organisation_organisation_slug_not_reserved_and_more'),
        ('workspaces', '0008_warmpoolallocation'),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.CreateModel(
            name='WorkspaceInviteLink',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('code_digest', models.TextField(unique=True)),
                ('expires_at', models.DateTimeField()),
                ('max_uses', models.IntegerField()),
                ('uses_count', models.IntegerField(default=0)),
                ('revoked_at', models.DateTimeField(blank=True, null=True)),
                ('role', models.TextField(default='org_member')),
                ('channel', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, to='workspaces.channel')),
                ('workspace', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='workspaces.workspace')),
            ],
        ),
        migrations.CreateModel(
            name='WorkspaceInviteRedemption',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('link', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='workspaces.workspaceinvitelink')),
                ('membership', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='orgs.membership')),
            ],
        ),
        migrations.CreateModel(
            name='WorkspaceMemberRestriction',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('banned', models.BooleanField(default=False)),
                ('kicked', models.BooleanField(default=False)),
                ('muted_until', models.DateTimeField(blank=True, null=True)),
                ('membership', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='orgs.membership')),
                ('workspace', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='workspaces.workspace')),
            ],
        ),
        migrations.CreateModel(
            name='WorkspaceModerator',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('membership', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='orgs.membership')),
                ('workspace', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='workspaces.workspace')),
            ],
        ),
        migrations.CreateModel(
            name='WorkspaceAbuseReport',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('event_id', models.TextField(blank=True, default='')),
                ('reason', models.TextField()),
                ('status', models.TextField(default='open')),
                ('resolution', models.TextField(blank=True, null=True)),
                ('channel', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, to='workspaces.channel')),
                ('membership', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.membership')),
                ('reporter', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.membership')),
                ('resolved_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.membership')),
                ('workspace', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='workspaces.workspace')),
            ],
            options={
                'indexes': [models.Index(fields=['workspace', 'status', 'id'], name='workspace_report_queue')],
                'constraints': [models.CheckConstraint(condition=models.Q(('status__in', ['open', 'resolved', 'dismissed'])), name='workspace_report_status_valid')],
            },
        ),
        migrations.AddConstraint(
            model_name='workspaceinvitelink',
            constraint=models.CheckConstraint(condition=models.Q(('max_uses__gt', 0)), name='workspace_invite_capacity_positive'),
        ),
        migrations.AddConstraint(
            model_name='workspaceinvitelink',
            constraint=models.CheckConstraint(condition=models.Q(('uses_count__gte', 0)), name='workspace_invite_uses_nonnegative'),
        ),
        migrations.AddConstraint(
            model_name='workspaceinvitelink',
            constraint=models.CheckConstraint(condition=models.Q(('uses_count__lte', models.F('max_uses'))), name='workspace_invite_uses_within_capacity'),
        ),
        migrations.AddConstraint(
            model_name='workspaceinvitelink',
            constraint=models.CheckConstraint(condition=models.Q(('role__in', ['org_member', 'moderator'])), name='workspace_invite_role_valid'),
        ),
        migrations.AddConstraint(
            model_name='workspaceinvitelink',
            constraint=models.CheckConstraint(condition=models.Q(('code_digest__regex', '^[a-f0-9]{64}$')), name='workspace_invite_digest_valid'),
        ),
        migrations.AddConstraint(
            model_name='workspaceinviteredemption',
            constraint=models.UniqueConstraint(fields=('link', 'membership'), name='workspace_invite_redemption_unique'),
        ),
        migrations.AddConstraint(
            model_name='workspacememberrestriction',
            constraint=models.UniqueConstraint(fields=('workspace', 'membership'), name='workspace_restriction_unique'),
        ),
        migrations.AddConstraint(
            model_name='workspacemoderator',
            constraint=models.UniqueConstraint(fields=('workspace', 'membership'), name='workspace_moderator_unique'),
        ),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
