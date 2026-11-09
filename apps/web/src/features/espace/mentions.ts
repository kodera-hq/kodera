// Mentions in the composer (V1 bar M8): « @ » opens a list of the channel's members, the chosen
// name goes into the text as « @Name », and the message carries the named members' ids in its
// `m.mentions`, which is what notifies them. Pure functions: the input is in
// `MentionInput.tsx`.

/** A member the composer can name: the id `m.mentions` carries, the name the text shows. */
export interface MentionCandidate {
  userId: string
  label: string
}

/** How many members the list offers at once. */
export const MENTION_LIMIT = 6

/** Lower case, accents removed: « Élodie » is found by « elo ». */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * The mention being typed at the caret: the « @ » that starts it, at the start of the text or
 * after a space, and the word typed after it. Null when the caret is not in one.
 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]{0,32})$/u.exec(text.slice(0, caret))
  if (match === null) return null
  return { start: match.index + match[1]!.length, query: match[2]! }
}

/** The members whose name, or id, has a word that starts with the query; at most `MENTION_LIMIT`. */
export function matchingMembers(
  members: readonly MentionCandidate[],
  query: string
): MentionCandidate[] {
  const wanted = fold(query)
  return members
    .filter(({ userId, label }) =>
      [...fold(label).split(/\s+/), fold(userId.slice(1))].some((word) => word.startsWith(wanted))
    )
    .slice(0, MENTION_LIMIT)
}

/** The text with the typed mention replaced by « @label », and where the caret goes after it. */
export function insertMention(
  text: string,
  mention: { start: number },
  caret: number,
  label: string
): { text: string; caret: number } {
  const inserted = `@${label} `
  const after = text.slice(caret).replace(/^\s/u, '')
  return {
    text: `${text.slice(0, mention.start)}${inserted}${after}`,
    caret: mention.start + inserted.length,
  }
}

/**
 * The members the text names, as « @label » followed by the end, a space or punctuation. At each
 * « @ » the longest name wins, so « @Henri Duflot » names Henri Duflot, not also an « Henri ».
 */
export function mentionedIn(text: string, members: readonly MentionCandidate[]): string[] {
  const byLength = [...members].sort((a, b) => b.label.length - a.label.length)
  const found = new Set<string>()
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    if (at > 0 && !/\s/u.test(text[at - 1]!)) continue
    const rest = text.slice(at + 1)
    const member = byLength.find(
      ({ label }) =>
        rest.startsWith(label) &&
        (rest.length === label.length || /[\s\p{P}]/u.test(rest[label.length]!))
    )
    if (member !== undefined) found.add(member.userId)
  }
  return [...found]
}
