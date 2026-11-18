import { guard } from './oracles/shared'

/** Always attempt every cleanup; preserve an error already propagating from the test. */
export async function finishCleanup(
  succeeded: boolean,
  cleanups: readonly (() => Promise<unknown>)[],
  marker: string
): Promise<void> {
  const results = await Promise.allSettled(cleanups.map(async (cleanup) => cleanup()))
  if (succeeded)
    guard(
      results.every((result) => result.status === 'fulfilled'),
      marker
    )
}
