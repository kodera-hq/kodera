import { describe, expect, it } from 'vitest'
import { rowStatus } from './rowStatus'

describe('rowStatus', () => {
  it('reads the day count from the dunning view when this row is the one it tracks', () => {
    expect(
      rowStatus('overdue', 'inv-1', { oldest_overdue_invoice_id: 'inv-1', days_overdue: 12 })
    ).toEqual({ kind: 'overdue-known', days: 12 })
  })

  it('has no day count for an overdue row the dunning view is not tracking', () => {
    expect(
      rowStatus('overdue', 'inv-2', { oldest_overdue_invoice_id: 'inv-1', days_overdue: 12 })
    ).toEqual({ kind: 'overdue-unknown' })
  })

  it('has no day count when no dunning view was fetched at all', () => {
    expect(rowStatus('overdue', 'inv-1', undefined)).toEqual({ kind: 'overdue-unknown' })
  })

  it('maps the other invoice states directly', () => {
    expect(rowStatus('paid', 'x', undefined)).toEqual({ kind: 'paid' })
    expect(rowStatus('issued', 'x', undefined)).toEqual({ kind: 'open' })
    expect(rowStatus('credited', 'x', undefined)).toEqual({ kind: 'credit-note' })
    expect(rowStatus('void', 'x', undefined)).toEqual({ kind: 'void' })
  })

  // « En retard de 0 jours » read as a defect: zero is "late today".
  it('shows no day count for zero days', () => {
    expect(
      rowStatus('overdue', 'inv-1', { oldest_overdue_invoice_id: 'inv-1', days_overdue: 0 })
    ).toEqual({ kind: 'overdue-unknown' })
  })
})
