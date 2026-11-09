import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ComponentsCard } from './ComponentsCard'
import type { StatusComponent } from './components'

const web: StatusComponent = {
  id: 'c-1',
  scope: 'platform',
  key: 'web',
  name: 'Web',
  state: 'operational',
  since: '2026-12-03T10:00:00Z',
}

const calls: StatusComponent = {
  id: 'c-2',
  scope: 'tenant',
  key: 'calls',
  name: 'Calls',
  state: 'degraded',
  since: '2026-12-03T10:58:00Z',
}

describe('ComponentsCard', () => {
  it('shows the customer-facing name and state of every component', () => {
    render(
      <ComponentsCard
        components={[web, calls]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onOpenHistory={vi.fn()}
      />
    )
    expect(screen.getByText('Site web')).toBeInTheDocument()
    expect(screen.getByText('Opérationnel')).toBeInTheDocument()
    expect(screen.getByText('Appels vidéo')).toBeInTheDocument()
    expect(screen.getByText('Perturbé')).toBeInTheDocument()
  })

  it('shows an inline error with its own retry when the fetch failed, without hiding the history link condition', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(
      <ComponentsCard
        components={undefined}
        isLoading={false}
        isError={true}
        onRetry={onRetry}
        onOpenHistory={vi.fn()}
      />
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('opens the history view from its own link', async () => {
    const user = userEvent.setup()
    const onOpenHistory = vi.fn()
    render(
      <ComponentsCard
        components={[web]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onOpenHistory={onOpenHistory}
      />
    )
    await user.click(screen.getByText('Historique sur sept jours'))
    expect(onOpenHistory).toHaveBeenCalled()
  })

  it('draws no history link when no history is offered', () => {
    render(
      <ComponentsCard components={[web]} isLoading={false} isError={false} onRetry={vi.fn()} />
    )
    expect(screen.queryByText('Historique sur sept jours')).toBeNull()
  })

  it('never renders a component as operational when its state is unrecognised', () => {
    render(
      <ComponentsCard
        components={[{ ...web, state: 'something-new' as StatusComponent['state'] }]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onOpenHistory={vi.fn()}
      />
    )
    expect(screen.getByText('État inconnu')).toBeInTheDocument()
    expect(screen.queryByText('Opérationnel')).not.toBeInTheDocument()
  })
})
