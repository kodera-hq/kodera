"""The authority revision a member set was built at: a nullable column, added without a rewrite.

A set recorded at an older revision than its organisation's is behind a membership or identity
write. The canonical community's first visits no longer rebuild the set in the request that makes
them (docs/specs/DEFAULT_COMMUNITY.md): the next agent poll compares this column with the
organisation's revision and rebuilds once for every person who joined since. Null on the sets
recorded before this migration, read as behind. Reversing drops the column and nothing else.
"""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"


class Migration(migrations.Migration):

    dependencies = [
        ('engine_intents', '0010_known_subject_update_guard'),
    ]

    operations = [
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.AddField(
            model_name='enginememberset',
            name='authority_revision',
            field=models.BigIntegerField(null=True),
        ),
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
    ]
