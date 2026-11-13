import core.db.ids
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('orgs', '0021_remove_organisation_organisation_slug_not_reserved_and_more'),
    ]

    operations = [
        migrations.CreateModel(
            name='PushSubscription',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('device_id', models.UUIDField()),
                ('version', models.UUIDField()),
                ('endpoint_digest', models.TextField()),
                ('sealed_subscription', models.BinaryField()),
                ('revoked_at', models.DateTimeField(blank=True, null=True)),
                ('membership', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='orgs.membership')),
                ('organisation', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='orgs.organisation')),
            ],
        ),
        migrations.CreateModel(
            name='PushOutbox',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('subscription_version', models.UUIDField()),
                ('state', models.TextField(default='pending')),
                ('available_at', models.DateTimeField()),
                ('lease_id', models.UUIDField(blank=True, null=True)),
                ('lease_expires_at', models.DateTimeField(blank=True, null=True)),
                ('attempts', models.IntegerField(default=0)),
                ('subscription', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='notifications.pushsubscription')),
            ],
        ),
        migrations.CreateModel(
            name='Notification',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('kind', models.TextField()),
                ('resource_id', models.UUIDField()),
                ('read_at', models.DateTimeField(blank=True, null=True)),
                ('membership', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='orgs.membership')),
                ('organisation', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='orgs.organisation')),
            ],
            options={
                'indexes': [models.Index(fields=['organisation', 'membership', '-id'], name='notification_inbox')],
                'constraints': [models.CheckConstraint(condition=models.Q(('kind__in', ['mention', 'invitation', 'moderation', 'document'])), name='notification_kind_valid')],
            },
        ),
        migrations.AddConstraint(
            model_name='pushsubscription',
            constraint=models.UniqueConstraint(fields=('organisation', 'membership', 'device_id'), name='push_subscription_device_unique'),
        ),
        migrations.AddConstraint(
            model_name='pushsubscription',
            constraint=models.UniqueConstraint(fields=('organisation', 'endpoint_digest'), name='push_subscription_endpoint_unique'),
        ),
        migrations.AddConstraint(
            model_name='pushsubscription',
            constraint=models.CheckConstraint(condition=models.Q(('endpoint_digest__regex', '^[a-f0-9]{64}$')), name='push_endpoint_digest_valid'),
        ),
        migrations.AddIndex(
            model_name='pushoutbox',
            index=models.Index(fields=['state', 'available_at'], name='push_outbox_ready'),
        ),
        migrations.AddConstraint(
            model_name='pushoutbox',
            constraint=models.CheckConstraint(condition=models.Q(('state__in', ['pending', 'in_flight', 'delivered', 'failed', 'obsolete'])), name='push_outbox_state_valid'),
        ),
        migrations.AddConstraint(
            model_name='pushoutbox',
            constraint=models.CheckConstraint(condition=models.Q(('attempts__gte', 0), ('attempts__lte', 10)), name='push_outbox_attempts_bound'),
        ),
        migrations.AddConstraint(
            model_name='pushoutbox',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('lease_expires_at__isnull', False), ('lease_id__isnull', False), ('state', 'in_flight')), models.Q(models.Q(('state', 'in_flight'), _negated=True), ('lease_expires_at__isnull', True), ('lease_id__isnull', True)), _connector='OR'), name='push_outbox_lease_valid'),
        ),
    ]
