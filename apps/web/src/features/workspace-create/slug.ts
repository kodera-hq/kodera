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

const ORG_SLUG_MAX = 20
const ORG_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{3,18}[a-z0-9]$/

export function isOrganisationSelfServeSlug(value: string): boolean {
  return ORG_SLUG_PATTERN.test(value) && value !== 'community' && !value.startsWith('xn--')
}

export function deriveOrganisationSlug(name: string): string {
  const base = deriveSlug(name).slice(0, ORG_SLUG_MAX).replace(/-+$/g, '')
  if (base.length === 0) return ''
  if (base.length < 5) return `${base}-team`.slice(0, ORG_SLUG_MAX).replace(/-+$/g, '')
  return base
}
