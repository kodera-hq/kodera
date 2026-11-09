import core.db.ids
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('identity', '0001_initial'),
        ('orgs', '0001_initial'),
    ]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.CreateModel(
            name='Identity',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('deleted_at', models.DateTimeField(blank=True, null=True)),
                ('purge_after', models.DateTimeField(blank=True, null=True)),
                ('issuer', models.TextField()),
                ('realm', models.TextField()),
                ('subject', models.TextField()),
                ('email', models.TextField()),
                ('enabled', models.BooleanField(default=True)),
            ],
            options={
                'abstract': False,
            },
        ),
        migrations.AddField(
            model_name='identity',
            name='organisation',
            field=models.ForeignKey(db_constraint=False, on_delete=django.db.models.deletion.RESTRICT, to='orgs.organisation'),
        ),
        migrations.AddField(
            model_name='identity',
            name='user',
            field=models.ForeignKey(db_constraint=False, on_delete=django.db.models.deletion.RESTRICT, to='identity.user'),
        ),
        migrations.AddConstraint(
            model_name='identity',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('deleted_at__isnull', True), ('purge_after__isnull', True)), models.Q(('deleted_at__isnull', False), ('purge_after__gt', models.F('deleted_at')), ('purge_after__isnull', False)), _connector='OR'), name='identity_deletion_valid'),
        ),
        migrations.AddConstraint(
            model_name='identity',
            constraint=models.UniqueConstraint(fields=('issuer', 'subject'), name='identity_issuer_subject_unique'),
        ),
        migrations.AddConstraint(
            model_name='identity',
            constraint=models.UniqueConstraint(fields=('issuer', 'user'), name='identity_issuer_user_unique'),
        ),
        migrations.AddConstraint(
            model_name='identity',
            constraint=models.CheckConstraint(condition=models.Q(('subject__regex', '^[\\x01-\\x7f]{1,255}$')), name='identity_subject_valid'),
        ),
        migrations.AddConstraint(
            model_name='identity',
            constraint=models.CheckConstraint(condition=models.Q(('email', ''), _negated=True), name='identity_email_valid'),
        ),
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
