"""Compare document titles and wiki-link targets on a key that ignores the cluster's LC_CTYPE.

`lower()` folds ASCII only under the `C` ctype the community profile initialises, so
`Équipe` and `équipe` could coexist and `[[équipe]]` never resolved. The key is
`apps.docs.titles.key` (NFC, Unicode full case folding, NFC), computed via SQL NFC
normalisation and Python `str.casefold()` so no module helper or external callable runs
inside `RunPython`.
"""

from django.db import migrations, models

KEY_EXPANSION = 18
MAX_KEY_LENGTH = 255 * KEY_EXPANSION
SUFFIX_LIMIT = 10_000


def backfill(apps, schema_editor):
    del apps
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, workspace_id, deleted_at, title, normalize(title, NFC) "
            "FROM docs_document ORDER BY id"
        )
        doc_rows = cursor.fetchall()
        folded_inputs = [row[4].casefold() for row in doc_rows]
        if folded_inputs:
            cursor.execute(
                "SELECT normalize(val, NFC) "
                "FROM unnest(%s::text[]) WITH ORDINALITY AS t(val, ord) ORDER BY ord",
                [folded_inputs],
            )
            doc_keys = [r[0] for r in cursor.fetchall()]
        else:
            doc_keys = []

        taken = set()
        pending = []
        key_updates = []
        pre_dedup_keys = {}
        for (doc_id, workspace_id, deleted_at, title, _), title_key in zip(
            doc_rows, doc_keys, strict=True
        ):
            if deleted_at is None:
                pre_dedup_keys[doc_id] = title_key
                if (workspace_id, title_key) in taken:
                    pending.append((doc_id, workspace_id, title))
                    continue
                taken.add((workspace_id, title_key))
            key_updates.append((title_key, doc_id))

        if key_updates:
            cursor.executemany(
                "UPDATE docs_document SET title_key = %s WHERE id = %s",
                key_updates,
            )

        # Titles that only became equal once folded beyond ASCII (possible under the `C`
        # ctype): the oldest keeps its title, later ones gain the first free numeric suffix.
        for doc_id, workspace_id, orig_title in pending:
            chosen_title = ""
            chosen_key = ""
            for number in range(2, SUFFIX_LIMIT):
                suffix = f" ({number})"
                candidate = orig_title[: 255 - len(suffix)].rstrip() + suffix
                cursor.execute("SELECT normalize(%s, NFC)", [candidate])
                cand_nfc = cursor.fetchone()[0]
                cursor.execute("SELECT normalize(%s, NFC)", [cand_nfc.casefold()])
                cand_key = cursor.fetchone()[0]
                if (workspace_id, cand_key) not in taken:
                    chosen_title = candidate
                    chosen_key = cand_key
                    break
            else:
                raise RuntimeError("document title keys cannot be made unique")
            taken.add((workspace_id, chosen_key))
            cursor.execute(
                "UPDATE docs_document SET title = %s, title_key = %s WHERE id = %s",
                [chosen_title, chosen_key, doc_id],
            )

        # Resolved links fold from their target document's pre-dedup title (preserving links
        # such as [[İ]] whose legacy lower() stored "i" under UTF-8 libc, while keeping
        # links aligned with source markdown when a duplicate title gained a numeric suffix).
        cursor.execute(
            "SELECT id, source_id, target_id, target_title, normalize(target_title, NFC) "
            "FROM docs_documentlink ORDER BY id"
        )
        link_rows = cursor.fetchall()
        link_folded_inputs = [row[4].casefold() for row in link_rows]
        if link_folded_inputs:
            cursor.execute(
                "SELECT normalize(val, NFC) "
                "FROM unnest(%s::text[]) WITH ORDINALITY AS t(val, ord) ORDER BY ord",
                [link_folded_inputs],
            )
            link_self_keys = [r[0] for r in cursor.fetchall()]
        else:
            link_self_keys = []

        seen = set()
        duplicates = []
        changed = []
        prior_keys = set()
        for (link_id, source_id, target_id, target_title, _), self_key in zip(
            link_rows, link_self_keys, strict=True
        ):
            target_orig_key = pre_dedup_keys.get(target_id) if target_id is not None else None
            folded = target_orig_key if target_orig_key is not None else self_key
            if (source_id, folded) in seen:
                duplicates.append(link_id)
                continue
            seen.add((source_id, folded))
            if folded != target_title:
                prior_keys.add((source_id, target_title))
                changed.append((link_id, source_id, folded))

        if duplicates:
            cursor.execute("DELETE FROM docs_documentlink WHERE id = ANY(%s)", [duplicates])
        if any((source_id, final_title) in prior_keys for _, source_id, final_title in changed):
            cursor.executemany(
                "UPDATE docs_documentlink SET target_title = %s WHERE id = %s",
                [(f"[{link_id}]", link_id) for link_id, _, _ in changed],
            )
        if changed:
            cursor.executemany(
                "UPDATE docs_documentlink SET target_title = %s WHERE id = %s",
                [(final_title, link_id) for link_id, _, final_title in changed],
            )

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
    del apps
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
            chosen_cand = ""
            chosen_lower = ""
            chosen_key = ""
            for number in range(2, SUFFIX_LIMIT):
                suffix = f" ({number})"
                candidate = orig_title[: 255 - len(suffix)].rstrip() + suffix
                cursor.execute("SELECT lower(%s), normalize(%s, NFC)", [candidate, candidate])
                cand_lower, cand_nfc = cursor.fetchone()
                if (workspace_id, cand_lower) not in taken_lower:
                    cursor.execute("SELECT normalize(%s, NFC)", [cand_nfc.casefold()])
                    chosen_cand = candidate
                    chosen_lower = cand_lower
                    chosen_key = cursor.fetchone()[0]
                    break
            else:
                raise RuntimeError("document titles cannot be made unique under lower(title)")
            taken_lower.add((workspace_id, chosen_lower))
            cursor.execute(
                "UPDATE docs_document SET title = %s, title_key = %s WHERE id = %s",
                [chosen_cand, chosen_key, doc_id],
            )

        cursor.execute(
            "SELECT l.id, l.source_id, l.target_id, l.target_title, "
            "lower(t.title), lower(l.target_title) "
            "FROM docs_documentlink l "
            "LEFT JOIN docs_document t ON t.id = l.target_id "
            "ORDER BY l.id"
        )
        link_rows = cursor.fetchall()
        seen = set()
        duplicates = []
        changed = []
        prior_keys = set()
        for (
            link_id,
            source_id,
            target_id,
            target_title,
            target_db_lower,
            self_db_lower,
        ) in link_rows:
            restored = (
                target_db_lower[:255]
                if target_id is not None and target_db_lower
                else (self_db_lower or target_title)[:255]
            )
            if (source_id, restored) in seen:
                duplicates.append(link_id)
                continue
            seen.add((source_id, restored))
            if restored != target_title:
                prior_keys.add((source_id, target_title))
                changed.append((link_id, source_id, restored))

        if duplicates:
            cursor.execute("DELETE FROM docs_documentlink WHERE id = ANY(%s)", [duplicates])
        if any((source_id, final_title) in prior_keys for _, source_id, final_title in changed):
            cursor.executemany(
                "UPDATE docs_documentlink SET target_title = %s WHERE id = %s",
                [(f"[{link_id}]", link_id) for link_id, _, _ in changed],
            )
        if changed:
            cursor.executemany(
                "UPDATE docs_documentlink SET target_title = %s WHERE id = %s",
                [(final_title, link_id) for link_id, _, final_title in changed],
            )


class Migration(migrations.Migration):
    dependencies = [("docs", "0009_link_title_lookup")]

    # The key is a pure function of each row's own title and leaves with the row on erasure,
    # so the durable-erasure write fence is lifted only for this derivation, inside the
    # migration's transaction, with deferred constraint timing restored immediately after
    # flushing pending FK checks so subsequent statements keep INITIALLY DEFERRED semantics.
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
        migrations.RunSQL(
            """
            ALTER TABLE docs_document DISABLE TRIGGER aa_privacy_cutoff;
            ALTER TABLE docs_documentlink DISABLE TRIGGER aa_privacy_cutoff;
            """,
            reverse_sql="""
            SET CONSTRAINTS ALL IMMEDIATE;
            SET CONSTRAINTS ALL DEFERRED;
            ALTER TABLE docs_document ENABLE TRIGGER aa_privacy_cutoff;
            ALTER TABLE docs_documentlink ENABLE TRIGGER aa_privacy_cutoff;
            """,
        ),
        migrations.RunPython(backfill, reverse_backfill),
        migrations.RunSQL(
            """
            SET CONSTRAINTS ALL IMMEDIATE;
            SET CONSTRAINTS ALL DEFERRED;
            ALTER TABLE docs_document ENABLE TRIGGER aa_privacy_cutoff;
            ALTER TABLE docs_documentlink ENABLE TRIGGER aa_privacy_cutoff;
            """,
            reverse_sql="""
            ALTER TABLE docs_document DISABLE TRIGGER aa_privacy_cutoff;
            ALTER TABLE docs_documentlink DISABLE TRIGGER aa_privacy_cutoff;
            """,
        ),
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
