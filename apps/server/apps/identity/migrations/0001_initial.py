import core.db.ids
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
    ]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.CreateModel(
            name='User',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('deleted_at', models.DateTimeField(blank=True, null=True)),
                ('purge_after', models.DateTimeField(blank=True, null=True)),
                ('email', models.TextField()),
                ('display_name', models.TextField(blank=True, null=True)),
                ('enabled', models.BooleanField(default=True)),
            ],
            options={
                'abstract': False,
                'constraints': [models.CheckConstraint(condition=models.Q(models.Q(('deleted_at__isnull', True), ('purge_after__isnull', True)), models.Q(('deleted_at__isnull', False), ('purge_after__gt', models.F('deleted_at')), ('purge_after__isnull', False)), _connector='OR'), name='user_deletion_valid'), models.CheckConstraint(condition=models.Q(('email', ''), _negated=True), name='user_email_valid'), models.CheckConstraint(condition=models.Q(('display_name__isnull', True), ('display_name__length__lte', 200), _connector='OR'), name='user_display_name_valid')],
            },
        ),
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
