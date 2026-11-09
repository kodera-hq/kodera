import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { AreaStub } from './AreaStub'

describe('AreaStub', () => {
  it('renders the area title as a heading and the shared placeholder body', () => {
    render(<AreaStub titleKey="console.shell.nav.title-home" />)
    expect(screen.getByRole('heading', { name: 'Accueil' })).toBeInTheDocument()
    expect(screen.getByText("Cette page n'est pas encore disponible.")).toBeInTheDocument()
  })
})
