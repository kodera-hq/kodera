// Searching a channel's loaded messages (docs/specs/espace-timeline-scale.md): every word of the
// query must appear in the message's text or its author's name, whatever the case and the accents
// (« eleve » finds « Élève »). Pure: the panel is `MessageSearch.tsx`. The homeserver's own search
// is not asked: a channel's history is searched as far back as it is loaded.

import { nameOf } from './liveViewModel'
import type { MessageView } from './matrix/timeline'

/** A query shorter than this finds nothing: one letter would match almost every message. */
export const MIN_QUERY_LENGTH = 2

/** At most this many results are listed, newest first. */
export const MAX_RESULTS = 50

const MARKS = /\p{M}/gu

/** Text as a search compares it: lower case, accents taken off, spaces collapsed. */
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(MARKS, '').toLocaleLowerCase('fr').replace(/\s+/gu, ' ')
}

/** The query's words, folded; none when the query is too short to search. */
export function queryTerms(query: string): string[] {
  const folded = foldForSearch(query).trim()
  if (folded.length < MIN_QUERY_LENGTH) return []
  return folded.split(' ').filter((term) => term.length > 0)
}

const folded = new WeakMap<MessageView, string>()

function haystackOf(message: MessageView): string {
  let text = folded.get(message)
  if (text === undefined) {
    text = foldForSearch(`${message.body}\n${nameOf(message)}`)
    folded.set(message, text)
  }
  return text
}

export interface SearchResult {
  messages: MessageView[]
  /** More messages matched than are listed. */
  more: boolean
}

/** The loaded messages that hold every word of the query, newest first. Deleted ones never match. */
export function searchMessages(
  timeline: readonly MessageView[],
  query: string,
  limit = MAX_RESULTS
): SearchResult {
  const terms = queryTerms(query)
  const messages: MessageView[] = []
  if (terms.length === 0) return { messages, more: false }
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const message = timeline[index]!
    if (message.redacted) continue
    const haystack = haystackOf(message)
    if (!terms.every((term) => haystack.includes(term))) continue
    if (messages.length === limit) return { messages, more: true }
    messages.push(message)
  }
  return { messages, more: false }
}

/** A message's text cut to a line for a list, on a word where it can be. */
export function excerptOf(body: string, length = 140): string {
  const line = body.replace(/\s+/gu, ' ').trim()
  if (line.length <= length) return line
  const cut = line.lastIndexOf(' ', length)
  return `${line.slice(0, cut > length / 2 ? cut : length)}…`
}
