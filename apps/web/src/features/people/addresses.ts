// docs/specs/03-people.md §2.1 and §8: the invitation field takes whatever a
// paste from a spreadsheet or a mail client produces. Normalisation is
// silent; validity and duplicates are counted so the field can say so.

/** §8: at most 200 addresses per submission. */
export const MAX_ADDRESSES = 200

export interface ParsedAddresses {
  /** Distinct valid addresses, first spelling kept, in input order. */
  valid: string[]
  /** Invalid entries as typed, in input order. */
  invalid: string[]
  /** Entries dropped because an earlier one had the same address. */
  duplicates: number
}

// Deliberately loose: the Core API is the authority on deliverability
// (`results[].outcome: invalid_email`). This only catches what is plainly
// not an address — a missing part, a space, an empty domain label.
const ADDRESS = /^[^\s@<>]+@[^\s@<>.]+(\.[^\s@<>.]+)+$/

export function parseAddresses(input: string): ParsedAddresses {
  // "Nom <a@b.fr>" → "a@b.fr", before splitting, so the name's own spaces
  // never produce stray tokens.
  const flattened = input.replace(/[^<>,;\n\t]*<([^<>]*)>/g, ' $1 ')
  const tokens = flattened.split(/[\s,;]+/).filter((token) => token.length > 0)

  const seen = new Set<string>()
  const valid: string[] = []
  const invalid: string[] = []
  let duplicates = 0
  for (const token of tokens) {
    const key = token.toLowerCase()
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)
    if (ADDRESS.test(token)) valid.push(token)
    else invalid.push(token)
  }
  return { valid, invalid, duplicates }
}
