import type { ChannelSearchEntry } from '../workspace/ChannelSearch'

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/** Stable subsequence ranking: contiguous names first, then fewer gaps. No expression from input. */
export function fuzzyEntries(
  entries: readonly ChannelSearchEntry[],
  query: string
): ChannelSearchEntry[] {
  const needle = fold(query.trim())
  if (!needle) return [...entries]
  return entries
    .flatMap((entry, index) => {
      const text = fold(`${entry.label} ${entry.category ?? ''}`)
      const contiguous = text.indexOf(needle)
      if (contiguous >= 0) return [{ entry, index, score: contiguous }]
      let at = 0
      let first = -1
      for (const char of needle) {
        at = text.indexOf(char, at)
        if (at < 0) return []
        if (first < 0) first = at
        at++
      }
      return [{ entry, index, score: 1000 + at - first + first }]
    })
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ entry }) => entry)
}
