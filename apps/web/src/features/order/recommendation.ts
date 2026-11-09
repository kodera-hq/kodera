// The one arithmetic the console is allowed to do (01-order.md §6): a
// recommendation is advice about a purchase, not a figure presented as
// measured, and the sentence on screen states the rule so the buyer can
// check it themselves. Everything else — totals, VAT, prices — is rendered
// exactly as the Core API returns it (docs/dev/API_CLIENT.md), but for one
// display: a yearly total shown as its monthly equivalent (01-order.md §4.1).
//
// Peak concurrency is estimated at 30% of headcount, rounded up; the
// recommended tier is the first one (by capacity, ascending) whose
// `concurrent_participants_included` covers that peak.

const PEAK_RATIO = 0.3

export interface RecommendableTier {
  code: string
  concurrent_participants_included: number
  available?: boolean
}

function peakFor(headcount: number): number {
  return Math.ceil(headcount * PEAK_RATIO)
}

function byCapacityAscending<T extends RecommendableTier>(tiers: readonly T[]): T[] {
  return [...tiers]
    .filter((tier) => tier.available !== false)
    .sort((a, b) => a.concurrent_participants_included - b.concurrent_participants_included)
}

/**
 * The first tier whose capacity covers 30% of `headcount`, rounded up. The
 * recommendation is advisory (01-order.md §4.1): a buyer may still choose a
 * smaller tier, which is why this returns the tier rather than deciding
 * anything on its own.
 *
 * `undefined` when no tier covers the peak: the largest tier is not a
 * recommendation for a peak it cannot hold (01-order.md §1: "the first tier
 * whose included concurrent participants covers that peak"), and the plan
 * step recommends a quote instead.
 */
export function recommendTier<T extends RecommendableTier>(
  headcount: number,
  tiers: readonly T[]
): T | undefined {
  const peak = peakFor(headcount)
  return byCapacityAscending(tiers).find((tier) => tier.concurrent_participants_included >= peak)
}

export interface HeadcountRange {
  min: number
  max: number
}

/**
 * The headcount range a tier is "designed for" (the sentence
 * `console.order.plan.status-recommendation` renders), derived from the same
 * 30% rule rather than a second, independent figure: the largest headcount
 * whose peak still fits this tier's capacity is `floor(capacity / 0.3)`, and
 * the next tier picks up immediately after it. The largest tier has an upper
 * bound like every other one: past it, no tier covers the peak.
 */
export function headcountRangeFor<T extends RecommendableTier>(
  tier: T,
  tiers: readonly T[]
): HeadcountRange {
  const sorted = byCapacityAscending(tiers)
  const index = sorted.findIndex((candidate) => candidate.code === tier.code)
  const min =
    index <= 0
      ? 1
      : Math.floor(sorted[index - 1]!.concurrent_participants_included / PEAK_RATIO) + 1
  const max = Math.floor(tier.concurrent_participants_included / PEAK_RATIO)
  return { min, max }
}

/**
 * The largest headcount any tier covers: the top of the largest available
 * tier's range, `floor(capacity / 0.3)` — 333 for a 100-participant tier.
 * Above it nothing is recommended and the order is a quote, and every
 * sentence that names the cutoff ("Plus de {max} personnes ?") reads this
 * rather than a number of its own. `undefined` for an empty catalogue.
 */
export function largestCoveredHeadcount<T extends RecommendableTier>(
  tiers: readonly T[]
): number | undefined {
  const largest = byCapacityAscending(tiers).at(-1)
  return largest === undefined ? undefined : headcountRangeFor(largest, tiers).max
}
