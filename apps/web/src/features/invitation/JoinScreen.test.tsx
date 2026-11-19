import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import JoinScreen from './JoinScreen'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
    ...rest
  }: {
    children: ReactNode
    to: string
    className?: string
  }) => (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  ),
}))

describe('JoinScreen (issue 221)', () => {
  it('renders the Kodera wordmark and a recovery link back to workspace when the invite fragment is missing', () => {
    window.location.hash = ''
    const { container } = render(<JoinScreen />)
    expect(screen.getByText('Kodera')).toBeInTheDocument()
    const homeLink = screen.getByTestId('join-recovery-home')
    expect(homeLink).toHaveAttribute('href', '/')
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })
})
