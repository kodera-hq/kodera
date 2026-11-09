// The workspace's address, derived from its name as the owner types (run-notes quick-workspace
// SPEC §2.1, docs/specs/08-home.md §4.7): lowercase, diacritics dropped, the Latin letters with no
// decomposition spelled out (œ → oe, ß → ss…), every run of other
// characters one hyphen, no hyphen at either end, at most 32 characters. The result may still
// be too short for a tenant slug (3 characters); the form then opens the field instead.

const MAX = 32
/** Letters NFKD leaves whole, which would otherwise become a hyphen in a permanent address. */
const SPELLED: Readonly<Record<string, string>> = {
  œ: 'oe',
  æ: 'ae',
  ß: 'ss',
  ø: 'o',
  ł: 'l',
  đ: 'd',
}

export function deriveSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[œæßøłđ]/g, (letter) => SPELLED[letter] ?? letter)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX)
    .replace(/-+$/g, '')
}
