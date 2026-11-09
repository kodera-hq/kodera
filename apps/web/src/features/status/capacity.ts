// The capacity gauge's tier and visibility rules (docs/specs/02-status.md
// §4.2, §8). The server computes every figure here — `used`, `included`,
// `pct`, `threshold_pct`, `upgrade_prompt` — this module only decides which
// of the gauge's three visual tiers a reading falls into and whether the
// gauge should render at all; it never divides.

import type { components } from '@/api/schema'

export type CapacityDimension = components['schemas']['CapacityDimension']
export type CapacityGauge = components['schemas']['CapacityGauge']
export type CapacityTier = 'normal' | 'warning' | 'full'

/**
 * `threshold_pct` comes from the response, never a constant held here
 * (§4.2: "read from the response, not held in the front end"). 100 % is
 * always `full`, regardless of where the threshold sits.
 */
export function capacityTier(pct: number, thresholdPct: number): CapacityTier {
  if (pct >= 100) return 'full'
  if (pct >= thresholdPct) return 'warning'
  return 'normal'
}

/**
 * §8: "Capacity `limit` of 0 or missing → the gauge is hidden entirely
 * rather than showing 0 %." `included` is the contract's name for that
 * limit.
 */
export function hasCapacityLimit(dimension: CapacityDimension): boolean {
  return dimension.included > 0
}
