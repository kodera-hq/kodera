import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ContractCard } from './ContractCard'
import { SupportCard } from './SupportCard'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}))

// The contract and support cards are `Card tone="inverse"`. Their loading block
// must paint the inverse role: the default `bg-c-muted-2` is a pale bar on the
// dark card, and a caller's `bg-*` class cannot override it (`src/ui/cx.ts`
// does not merge). No visual baseline covers a loading state, so this does.
describe('home inverse cards, loading', () => {
  it.each([
    ['contract', () => <ContractCard subscription={undefined} />],
    ['support', () => <SupportCard org="acme-sa" helpContext={undefined} />],
  ])('the %s card paints its skeleton block with the inverse role', (_name, card) => {
    render(card())
    const block = screen.getByRole('status').querySelector('[aria-hidden="true"]')
    expect(block).not.toBeNull()
    expect([...block!.classList]).toContain('bg-c-inverse-2')
    expect([...block!.classList]).not.toContain('bg-c-muted-2')
  })
})
