/** Caseless document-title keys, byte-identical to `apps/docs/titles.py` `key()`:
 * NFC, Unicode full case folding, NFC. PostgreSQL `lower()` follows the cluster ctype and
 * folds ASCII only under `C`, so titles and wiki-link targets compare on this key instead. */
import { FOLDS } from './title-key-table.mjs'

export function titleKey(value) {
  let folded = ''
  for (const character of value.normalize('NFC')) folded += FOLDS.get(character.codePointAt(0)) ?? character
  return folded.normalize('NFC')
}
