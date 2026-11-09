// Ruling E: while a billing dispute holds the ladder (`hold_until` ahead),
// the drawer's "Échéances de règlement" must not list any dated step to come
// — reminders, the formal notice and its 40 € penalty, the suspension. It
// showed the ladder as if no dispute were open.
import { render, screen, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { DunningDrawer } from './DunningDrawer'
import type { DunningView } from './queries'

const LADDER: DunningView['steps'] = [
  { state: 'past_due', due_at: '2027-03-31T23:59:59Z', done: true },
  { state: 'notice', due_at: '2027-04-07T00:00:00Z', done: true },
  { state: 'suspension_notice', due_at: '2027-05-30T00:00:00Z', done: false },
  { state: 'suspended', due_at: '2027-06-06T00:00:00Z', done: false },
]

const LADDER_WITH_FORMAL_NOTICE: DunningView['steps'] = [
  { state: 'past_due', due_at: '2027-03-31T23:59:59Z', done: true },
  { state: 'notice', due_at: '2027-04-07T00:00:00Z', done: true },
  { state: 'formal_notice', due_at: '2027-05-05T00:00:00Z', done: false },
  { state: 'suspension_notice', due_at: '2027-05-30T00:00:00Z', done: false },
  { state: 'suspended', due_at: '2027-06-06T00:00:00Z', done: false },
]

function view(holdUntil: string | null, steps: DunningView['steps'] = LADDER): DunningView {
  return {
    state: 'notice',
    ladder: 'invoice',
    oldest_overdue_invoice_id: 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70',
    days_overdue: 20,
    amount_due: { amount_minor: 538560, currency: 'EUR' },
    hold_until: holdUntil,
    steps,
  }
}

function renderDrawer(dunning: DunningView) {
  render(
    <DunningDrawer
      dunning={dunning}
      loading={false}
      errored={false}
      open
      onOpenChange={vi.fn()}
      onPayNow={vi.fn()}
      onContactSupport={vi.fn()}
    />
  )
  return screen.getByRole('dialog')
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2027-04-20T09:00:00Z'))
})

it('pauses every step still ahead, undated, while a dispute is open', () => {
  const drawer = renderDrawer(view('2027-05-01T00:00:00Z', LADDER_WITH_FORMAL_NOTICE))
  for (const line of [
    "Mise en demeure et pénalités de retard : en pause pendant l'examen de votre contestation.",
    "Préavis de suspension : en pause pendant l'examen de votre contestation.",
    "Suspension des connexions : en pause pendant l'examen de votre contestation.",
  ]) {
    expect(within(drawer).getByText(line)).toBeInTheDocument()
  }
  expect(within(drawer).queryByText(/40 €|mai 2027|juin 2027/)).not.toBeInTheDocument()
  expect(within(drawer).queryByText('À venir')).not.toBeInTheDocument()
  expect(within(drawer).queryByText('En cours')).not.toBeInTheDocument()
  expect(within(drawer).getAllByText('En pause')).toHaveLength(3)
  expect(within(drawer).getByRole('button', { name: 'Payer maintenant' })).not.toHaveClass(
    'bg-c-action'
  )
})

// Outside a hold: a step the ladder has reached but not marked done is under
// way. It read « À venir » with a date already gone.
it('never shows a step whose date has passed as still to come', () => {
  const drawer = renderDrawer(
    view(null, [
      { state: 'past_due', due_at: '2027-03-31T23:59:59Z', done: true },
      { state: 'notice', due_at: '2027-04-07T00:00:00Z', done: true },
      { state: 'notice', due_at: '2027-04-14T00:00:00Z', done: false },
      { state: 'formal_notice', due_at: '2027-04-18T00:00:00Z', done: false },
      { state: 'suspended', due_at: '2027-06-06T00:00:00Z', done: false },
    ])
  )
  const row = (text: RegExp) => within(drawer).getByText(text).closest('li')!
  expect(row(/second rappel/)).toHaveTextContent('En cours')
  expect(row(/mise en demeure/)).toHaveTextContent('En cours')
  expect(row(/mise en demeure/)).not.toHaveTextContent('À venir')
  expect(row(/suspension des connexions/)).toHaveTextContent('À venir')
})

it('lists the dated ladder once the hold has passed', () => {
  const drawer = renderDrawer(view('2027-04-01T00:00:00Z'))
  expect(within(drawer).getAllByText(/6 juin 2027/).length).toBeGreaterThan(0)
  expect(within(drawer).queryByText(/contestation/)).not.toBeInTheDocument()
})
