"""Caseless document-title keys, independent of the database's LC_CTYPE.

PostgreSQL ``lower()`` follows the cluster's ctype: under ``C`` it folds ASCII only, so
``[[équipe]]`` would never reach ``Équipe``. Titles and wiki-link targets are therefore
compared on a key computed here: NFC, Unicode full case folding, NFC again. The collaboration
service computes the same key from ``yjs_collab/title-key-table.mjs``, generated from this
module by ``apps/docs/title_key_table.py``; a test keeps both in step.
"""

import unicodedata

# Unicode's worst-case caseless expansion (U+FDFA under NFKC_Casefold) is 18 code points;
# NFC + full case folding stays within that bound across every non-surrogate code point.
KEY_EXPANSION = 18
MAX_KEY_LENGTH = 255 * KEY_EXPANSION


def key(value: str) -> str:
    return unicodedata.normalize("NFC", unicodedata.normalize("NFC", value).casefold())
