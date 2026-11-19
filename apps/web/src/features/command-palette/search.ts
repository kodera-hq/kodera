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
      const text = fold(entry.label)
      const contiguous = text.indexOf(needle)
      if (contiguous >= 0) {
        const boundary = contiguous === 0 || /[\s_/#-]/.test(text[contiguous - 1]!)
        return [
          {
            entry,
            index,
            score:
              (contiguous === 0 ? -200 : boundary ? -100 : 0) +
              contiguous +
              (text.length - needle.length) / 100,
          },
        ]
      }
      let at = 0
      let first = -1
      for (const char of needle) {
        at = text.indexOf(char, at)
        if (at < 0) return []
        if (first < 0) first = at
        at++
      }
      return [
        {
          entry,
          index,
          score:
            1000 +
            first * 2 +
            (at - first - needle.length) * 10 -
            (first === 0 ? 100 : /[\s_/#-]/.test(text[first - 1]!) ? 50 : 0),
        },
      ]
    })
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ entry }) => entry)
}
