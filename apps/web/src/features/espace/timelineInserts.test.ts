import { describe, expect, it } from 'vitest'
import { mergeTimelineInserts, type TimelineInsert } from './EspaceLiveView'

type Row =
  | { kind: 'day'; key: string; day: string; ts: number }
  | { kind: 'new'; key: string }
  | { kind: 'message'; key: string; message: { ts: number } }

const day = (ts: number): Row => ({ kind: 'day', key: `day:${ts}`, day: String(ts), ts })
const msg = (key: string, ts: number): Row => ({ kind: 'message', key, message: { ts } })
const insert = (key: string, ts: number): TimelineInsert => ({ key, ts, node: key })
const keys = (rows: readonly { key: string }[]) => rows.map((row) => row.key)

describe('mergeTimelineInserts', () => {
  it('draws a poll between the two messages around its creation time, not after the last message', () => {
    const rows = [day(1_000), msg('m1', 1_000), msg('m2', 3_000), msg('m3', 5_000)]
    expect(keys(mergeTimelineInserts(rows, [insert('poll', 4_000)]))).toEqual([
      'day:1000',
      'm1',
      'm2',
      'insert:poll',
      'm3',
    ])
  })

  it('orders several inserts by time whatever order they arrive in, and keeps later ones last', () => {
    const rows = [msg('m1', 1_000), msg('m2', 3_000)]
    expect(
      keys(mergeTimelineInserts(rows, [insert('late', 9_000), insert('early', 2_000)]))
    ).toEqual(['m1', 'insert:early', 'm2', 'insert:late'])
  })

  it('never moves an insert across the timeless « new messages » divider, and shows inserts in an empty channel', () => {
    const rows: Row[] = [msg('m1', 1_000), { kind: 'new', key: 'new' }, msg('m2', 3_000)]
    expect(keys(mergeTimelineInserts(rows, [insert('poll', 2_000)]))).toEqual([
      'm1',
      'new',
      'insert:poll',
      'm2',
    ])
    expect(keys(mergeTimelineInserts([], [insert('poll', 2_000)]))).toEqual(['insert:poll'])
  })
})
