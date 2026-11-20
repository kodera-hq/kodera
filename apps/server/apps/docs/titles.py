"""Caseless document-title keys, independent of the database's LC_CTYPE.

PostgreSQL ``lower()`` follows the cluster's ctype: under ``C`` it folds ASCII only, so
``[[équipe]]`` would never reach ``Équipe``. Titles and wiki-link targets are therefore
compared on a key computed here: NFC, Unicode full case folding, NFC again. The collaboration
service computes the same key from ``yjs_collab/title-key-table.mjs``, generated from this
function by ``scripts/title_key_table.py``; a test keeps both in step.
"""

import unicodedata

# Full case folding expands a character to at most three code points; with its canonical
# decomposition no character's key exceeds four (measured over every code point by a test).
KEY_EXPANSION = 4
MAX_KEY_LENGTH = 255 * KEY_EXPANSION


def key(value: str) -> str:
    return unicodedata.normalize("NFC", unicodedata.normalize("NFC", value).casefold())
