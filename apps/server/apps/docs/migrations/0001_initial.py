import core.db.ids
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('identity', '0006_discovery_quotas'),
        ('orgs', '0021_remove_organisation_organisation_slug_not_reserved_and_more'),
        ('workspaces', '0010_moderation_scope_guards'),
    ]

    operations = [
        migrations.CreateModel(
            name='Document',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('deleted_at', models.DateTimeField(blank=True, null=True)),
                ('purge_after', models.DateTimeField(blank=True, null=True)),
                ('visibility', models.TextField(default='workspace')),
                ('title', models.TextField()),
                ('markdown', models.TextField(default='')),
                ('revision', models.BigIntegerField(default=1)),
                ('channel', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, to='workspaces.channel')),
                ('creator', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='orgs.membership')),
                ('parent', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, to='docs.document')),
                ('workspace', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='workspaces.workspace')),
            ],
            options={
                'abstract': False,
            },
        ),
        migrations.CreateModel(
            name='DocumentGrant',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('role', models.TextField()),
                ('document', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='docs.document')),
                ('membership', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='orgs.membership')),
            ],
        ),
        migrations.CreateModel(
            name='DocumentLink',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('target_title', models.TextField()),
                ('source', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='outgoing_links', to='docs.document')),
                ('target', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, related_name='incoming_links', to='docs.document')),
            ],
        ),
        migrations.CreateModel(
            name='DocumentSnapshot',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('sequence', models.BigIntegerField(default=0)),
                ('head_sequence', models.BigIntegerField(default=0)),
                ('state', models.BinaryField()),
                ('document', models.OneToOneField(on_delete=django.db.models.deletion.RESTRICT, to='docs.document')),
            ],
        ),
        migrations.CreateModel(
            name='DocumentUpdate',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('sequence', models.BigIntegerField()),
                ('state', models.BinaryField()),
                ('actor', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='identity.identity')),
                ('document', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='docs.document')),
            ],
        ),
        migrations.AddIndex(
            model_name='document',
            index=models.Index(fields=['workspace', 'parent', '-id'], name='docs_tree_page'),
        ),
        migrations.AddConstraint(
            model_name='document',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('deleted_at__isnull', True), ('purge_after__isnull', True)), models.Q(('deleted_at__isnull', False), ('purge_after__gt', models.F('deleted_at')), ('purge_after__isnull', False)), _connector='OR'), name='document_deletion_valid'),
        ),
        migrations.AddConstraint(
            model_name='document',
            constraint=models.CheckConstraint(condition=models.Q(('visibility__in', ['workspace', 'restricted'])), name='docs_visibility_valid'),
        ),
        migrations.AddConstraint(
            model_name='document',
            constraint=models.CheckConstraint(condition=models.Q(('title__length__range', (1, 255)), ('title__regex', '\\S')), name='docs_title_valid'),
        ),
        migrations.AddConstraint(
            model_name='document',
            constraint=models.CheckConstraint(condition=models.Q(('markdown__length__lte', 262144)), name='docs_markdown_bound'),
        ),
        migrations.AddConstraint(
            model_name='document',
            constraint=models.CheckConstraint(condition=models.Q(('revision__gte', 1)), name='docs_revision_valid'),
        ),
        migrations.AddConstraint(
            model_name='document',
            constraint=models.CheckConstraint(condition=models.Q(('parent_id', models.F('id')), _negated=True), name='docs_parent_not_self'),
        ),
        migrations.AddConstraint(
            model_name='document',
            constraint=models.UniqueConstraint(models.Func('title', function='lower'), models.F('workspace'), condition=models.Q(('deleted_at__isnull', True)), name='docs_active_title_unique'),
        ),
        migrations.AddConstraint(
            model_name='document',
            constraint=models.UniqueConstraint(fields=('id', 'workspace'), name='docs_workspace_binding'),
        ),
        migrations.AddConstraint(
            model_name='documentgrant',
            constraint=models.UniqueConstraint(fields=('document', 'membership'), name='docs_grant_unique'),
        ),
        migrations.AddConstraint(
            model_name='documentgrant',
            constraint=models.CheckConstraint(condition=models.Q(('role__in', ['editor', 'viewer'])), name='docs_grant_role_valid'),
        ),
        migrations.AddIndex(
            model_name='documentlink',
            index=models.Index(fields=['target', '-id'], name='docs_backlinks'),
        ),
        migrations.AddConstraint(
            model_name='documentlink',
            constraint=models.UniqueConstraint(fields=('source', 'target_title'), name='docs_link_unique'),
        ),
        migrations.AddConstraint(
            model_name='documentlink',
            constraint=models.CheckConstraint(condition=models.Q(('target_title__length__range', (1, 255))), name='docs_link_title_bound'),
        ),
        migrations.AddConstraint(
            model_name='documentsnapshot',
            constraint=models.CheckConstraint(condition=models.Q(('head_sequence__gte', models.F('sequence')), ('sequence__gte', 0)), name='docs_snapshot_sequence_valid'),
        ),
        migrations.AddConstraint(
            model_name='documentupdate',
            constraint=models.UniqueConstraint(fields=('document', 'sequence'), name='docs_update_sequence_unique'),
        ),
        migrations.AddConstraint(
            model_name='documentupdate',
            constraint=models.CheckConstraint(condition=models.Q(('sequence__gte', 1)), name='docs_update_sequence_valid'),
        ),
    ]
