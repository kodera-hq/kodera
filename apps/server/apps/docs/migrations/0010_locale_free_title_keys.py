"""Compare document titles and wiki-link targets on a key that ignores the cluster's LC_CTYPE.

`lower()` folds ASCII only under the `C` ctype the community profile initialises, so
`Équipe` and `équipe` could coexist and `[[équipe]]` never resolved. The key is
`apps.docs.titles.key` (NFC, Unicode full case folding, NFC), frozen below.
"""

import unicodedata

from django.db import migrations, models

KEY_EXPANSION = 18
MAX_KEY_LENGTH = 255 * KEY_EXPANSION
SUFFIX_LIMIT = 10_000
BATCH = 500


def key(value):
    return unicodedata.normalize("NFC", unicodedata.normalize("NFC", value).casefold())


def backfill(apps, schema_editor):
    alias = schema_editor.connection.alias
    documents = apps.get_model("docs", "Document").objects.using(alias)
    document_links = apps.get_model("docs", "DocumentLink").objects.using(alias)
    taken = set()
    pending = []
    keyed = []
    rows = documents.order_by("id").only("id", "workspace_id", "title", "deleted_at")
    for row in rows.iterator(chunk_size=BATCH):
        row.title_key = key(row.title)
        if row.deleted_at is None:
            if (row.workspace_id, row.title_key) in taken:
                pending.append(row)
                continue
            taken.add((row.workspace_id, row.title_key))
        keyed.append(row)
    documents.bulk_update(keyed, ["title_key"], batch_size=BATCH)
    # Titles that only became equal once folded beyond ASCII (possible under the `C`
    # ctype): the oldest keeps its title, later ones gain the first free numeric suffix.
    for row in pending:
        for number in range(2, SUFFIX_LIMIT):
            suffix = f" ({number})"
            title = row.title[: 255 - len(suffix)].rstrip() + suffix
            if (row.workspace_id, key(title)) not in taken:
                break
        else:
            raise RuntimeError("document title keys cannot be made unique")
        taken.add((row.workspace_id, key(title)))
        documents.filter(pk=row.pk).update(title=title, title_key=key(title))
    # Stored link targets were `lower()` of the NFC name; folding that is folding the name.
    seen = set()
    duplicates = []
    changed = []
    links = document_links.order_by("id").only("id", "source_id", "target_title")
    for link in links.iterator(chunk_size=BATCH):
        folded = key(link.target_title)
        if (link.source_id, folded) in seen:
            duplicates.append(link.pk)
            continue
        seen.add((link.source_id, folded))
        if folded != link.target_title:
            link.target_title = folded
            changed.append(link)
    for start in range(0, len(duplicates), BATCH):
        document_links.filter(pk__in=duplicates[start : start + BATCH]).delete()
    document_links.bulk_update(changed, ["target_title"], batch_size=BATCH)
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            """WITH resolved AS (
              SELECT l.id, t.id AS target_id
              FROM docs_documentlink l
              JOIN docs_document s ON s.id=l.source_id
              LEFT JOIN docs_document t ON t.workspace_id=s.workspace_id
                AND t.deleted_at IS NULL AND t.title_key=l.target_title
              WHERE l.target_id IS DISTINCT FROM t.id
            )
            UPDATE docs_documentlink l SET target_id=r.target_id,updated_at=clock_timestamp()
            FROM resolved r WHERE l.id=r.id"""
        )


def reverse_backfill(apps, schema_editor):
    alias = schema_editor.connection.alias
    documents = apps.get_model("docs", "Document").objects.using(alias)
    document_links = apps.get_model("docs", "DocumentLink").objects.using(alias)
    # Under a non-C LC_CTYPE (e.g. en_US.UTF-8), distinct 0010 keys such as "i" and
    # "i\u0307" ("İ") collapse to the same PostgreSQL lower(title) ("i"). Deduplicate
    # against the database's own lower() before 0009's Lower("title") unique index returns.
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, workspace_id, title, lower(title) "
            "FROM docs_document WHERE deleted_at IS NULL ORDER BY id"
        )
        active_rows = cursor.fetchall()
        taken_lower = set()
        pending_docs = []
        for doc_id, workspace_id, title, db_lower in active_rows:
            if (workspace_id, db_lower) in taken_lower:
                pending_docs.append((doc_id, workspace_id, title))
            else:
                taken_lower.add((workspace_id, db_lower))
        for doc_id, workspace_id, orig_title in pending_docs:
            for number in range(2, SUFFIX_LIMIT):
                suffix = f" ({number})"
                candidate = orig_title[: 255 - len(suffix)].rstrip() + suffix
                cursor.execute("SELECT lower(%s)", [candidate])
                cand_lower = cursor.fetchone()[0]
                if (workspace_id, cand_lower) not in taken_lower:
                    break
            else:
                raise RuntimeError("document titles cannot be made unique under lower(title)")
            taken_lower.add((workspace_id, cand_lower))
            documents.filter(pk=doc_id).update(title=candidate, title_key=key(candidate))

    seen = set()
    duplicates = []
    changed = []
    prior_keys = set()
    links = (
        document_links.select_related("target")
        .order_by("id")
        .only("id", "source_id", "target_id", "target_title", "target__title")
    )
    for link in links.iterator(chunk_size=BATCH):
        restored = (
            link.target.title.lower()[:255]
            if link.target_id is not None
            else link.target_title[:255]
        )
        if (link.source_id, restored) in seen:
            duplicates.append(link.pk)
            continue
        seen.add((link.source_id, restored))
        if restored != link.target_title:
            prior_keys.add((link.source_id, link.target_title))
            link.target_title = restored
            changed.append(link)
    for start in range(0, len(duplicates), BATCH):
        document_links.filter(pk__in=duplicates[start : start + BATCH]).delete()
    if any((link.source_id, link.target_title) in prior_keys for link in changed):
        staged = []
        for link in changed:
            final_title = link.target_title
            link.target_title = f"[{link.pk}]"
            staged.append((link, final_title))
        document_links.bulk_update(changed, ["target_title"], batch_size=BATCH)
        for link, final_title in staged:
            link.target_title = final_title
    document_links.bulk_update(changed, ["target_title"], batch_size=BATCH)


# The key is a pure function of each row's own title and leaves with the row on erasure,
# so the durable-erasure write fence is lifted only for this derivation, inside the
# migration's transaction, and restored before it commits.
FENCE_OFF = """
ALTER TABLE docs_document DISABLE TRIGGER aa_privacy_cutoff;
ALTER TABLE docs_documentlink DISABLE TRIGGER aa_privacy_cutoff;
"""
FENCE_ON = """
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE docs_document ENABLE TRIGGER aa_privacy_cutoff;
ALTER TABLE docs_documentlink ENABLE TRIGGER aa_privacy_cutoff;
"""


class Migration(migrations.Migration):
    dependencies = [("docs", "0009_link_title_lookup")]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RemoveConstraint(model_name="document", name="docs_active_title_unique"),
        migrations.RemoveConstraint(model_name="documentlink", name="docs_link_title_bound"),
        migrations.AddField(
            model_name="document", name="title_key", field=models.TextField(null=True)
        ),
        migrations.RunSQL(FENCE_OFF, reverse_sql=FENCE_ON),
        migrations.RunPython(backfill, reverse_backfill),
        migrations.RunSQL(FENCE_ON, reverse_sql=FENCE_OFF),
        migrations.AlterField(model_name="document", name="title_key", field=models.TextField()),
        migrations.AddConstraint(
            model_name="document",
            constraint=models.CheckConstraint(
                condition=models.Q(title_key__length__range=(1, MAX_KEY_LENGTH)),
                name="docs_title_key_bound",
            ),
        ),
        migrations.AddConstraint(
            model_name="document",
            constraint=models.UniqueConstraint(
                fields=["workspace", "title_key"],
                condition=models.Q(deleted_at__isnull=True),
                name="docs_active_title_unique",
            ),
        ),
        migrations.AddConstraint(
            model_name="documentlink",
            constraint=models.CheckConstraint(
                condition=models.Q(target_title__length__range=(1, MAX_KEY_LENGTH)),
                name="docs_link_title_bound",
            ),
        ),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';",
        ),
    ]
