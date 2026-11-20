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

/**
 * The members whose name, or id, has a word that starts with the query, a query of several words
 * matching the name from one of its words on (« miguel vic »); at most `MENTION_LIMIT`.
 */
export function matchingMembers(
  members: readonly MentionCandidate[],
  query: string
): MentionCandidate[] {
  const wanted = fold(query)
  return members
    .filter(({ userId, label }) =>
      [...nameTails(label), fold(userId.slice(1))].some((word) => word.startsWith(wanted))
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

/** The words that name the whole room, as Element and other Matrix clients write them. */
export const ROOM_MENTION_WORDS = ['salon', 'room'] as const

/** The longest multi-word query followed after an « @ »: a full name, not a paragraph. */
const LONGEST_QUERY = 48

/** The name's words and every run of them that ends the name: « Miguel Victoria », « Victoria ». */
function nameTails(label: string): string[] {
  const folded = fold(label)
  const tails = [folded]
  for (const match of folded.matchAll(/\s+/gu))
    tails.push(folded.slice(match.index + match[0].length))
  return tails
}

/**
 * The mention being typed at the caret, a multi-word name included: « @Miguel Vic » is still one
 * while a member's name goes on that way, and stops being one at the first word no name has, so
 * the list closes and a « : » after it opens the emoji list again.
 */
export function mentionAtWith(
  text: string,
  caret: number,
  members: readonly MentionCandidate[]
): { start: number; query: string } | null {
  const single = mentionAt(text, caret)
  if (single !== null) return single
  const match = new RegExp(`(^|\\s)@([^\\n@]{1,${LONGEST_QUERY}})$`, 'u').exec(text.slice(0, caret))
  if (match === null) return null
  const query = match[2]!
  // A trailing space is still the name being typed (« @Miguel ») only if a longer name follows.
  if (!/\s/u.test(query) || /^\s/u.test(query)) return null
  const wanted = fold(query)
  const continues = members.some(({ label }) =>
    nameTails(label).some((tail) => tail.startsWith(wanted))
  )
  return continues ? { start: match.index + match[1]!.length, query } : null
}

/** Whether a mention query could still be « @salon » or « @room », once a letter of it is typed. */
export function matchesRoomMention(query: string): boolean {
  // Not on a bare « @ »: the list then is the members, and the whole room is asked for by name.
  const wanted = fold(query)
  return (
    wanted !== '' &&
    !/\s/u.test(wanted) &&
    ROOM_MENTION_WORDS.some((word) => word.startsWith(wanted))
  )
}

/**
 * Whether the text names the whole room, « @salon » or « @room » at the start or after a space,
 * ended by the end, a space or punctuation: what `m.mentions.room` carries.
 */
export function mentionsRoom(text: string): boolean {
  return /(^|\s)@(salon|room)(?=$|[\s\p{P}])/iu.test(text)
}

/**
 * The members the text names, as the message's HTML links them (`markdownHtml.ts`): each with
 * the label the text writes, so the pill wraps exactly « @label ».
 */
export function mentionTargetsIn(
  text: string,
  members: readonly MentionCandidate[]
): { userId: string; label: string }[] {
  const named = new Set(mentionedIn(text, members))
  const seen = new Set<string>()
  const targets: { userId: string; label: string }[] = []
  for (const member of members) {
    if (!named.has(member.userId) || seen.has(member.userId)) continue
    seen.add(member.userId)
    targets.push({ userId: member.userId, label: member.label })
  }
  return targets
}
