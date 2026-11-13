// Where a « :name: » code may stand, shared by the composer's shortcodes (`emoji.ts`) and the
// drawing of Kodera's own emoji (`koderaShortcodes.ts`), so what is written and what is drawn
// follow one grammar.

/**
 * What a code may not touch before it: a letter or a digit (« 10:100:20 », « a:wave:b »), a slash
 * (a path, as SharePoint's « /:x:/ » links), or a backslash, which is how a code is written as
 * text: a backslash then « :wave: » stays as typed, backslash and all.
 */
export const GUARD_BEFORE = '(?<![\\p{L}\\p{N}/\\\\])'
/** What a code may not touch after it: a letter, a digit or a slash. */
export const GUARD_AFTER = '(?![\\p{L}\\p{N}/])'
