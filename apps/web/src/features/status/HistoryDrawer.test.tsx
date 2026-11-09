import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { HistoryDrawer } from './HistoryDrawer'
import type { HistoryDay } from './HistoryDrawer'

const sevenDays: HistoryDay[] = [
  {
    date: '2026-12-01',
    components: [
      { key: 'web', state: 'operational', degradedMinutes: 0, downMinutes: 0 },
      { key: 'calls', state: 'degraded', degradedMinutes: 42, downMinutes: 0 },
      { key: 'console', state: 'operational', degradedMinutes: 0, downMinutes: 0 },
    ],
  },
  {
    date: '2026-12-02',
    components: [
      { key: 'web', state: 'no_data', degradedMinutes: 0, downMinutes: 0 },
      { key: 'calls', state: 'operational', degradedMinutes: 0, downMinutes: 0 },
      { key: 'console', state: 'operational', degradedMinutes: 0, downMinutes: 0 },
    ],
  },
]

describe('HistoryDrawer', () => {
  it('renders one row per day with the three named components as columns', () => {
    render(
      <HistoryDrawer
        open={true}
        onOpenChange={vi.fn()}
        days={sevenDays}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />
    )
    expect(screen.getByRole('columnheader', { name: 'Site web' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Appels vidéo' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Console' })).toBeInTheDocument()
    expect(screen.getByText('42 minutes de perturbation')).toBeInTheDocument()
  })

  it('shows "Données indisponibles" for a day with no data', () => {
    render(
      <HistoryDrawer
        open={true}
        onOpenChange={vi.fn()}
        days={sevenDays}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />
    )
    expect(screen.getByText('Données indisponibles')).toBeInTheDocument()
  })

  it('shows an error with retry when the fetch failed', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(
      <HistoryDrawer
        open={true}
        onOpenChange={vi.fn()}
        days={[]}
        isLoading={false}
        isError={true}
        onRetry={onRetry}
      />
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('has a caption for the table', () => {
    render(
      <HistoryDrawer
        open={true}
        onOpenChange={vi.fn()}
        days={sevenDays}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />
    )
    expect(screen.getByRole('table')).toHaveAccessibleName('Sept derniers jours')
  })
})
