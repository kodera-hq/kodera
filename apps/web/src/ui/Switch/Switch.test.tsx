import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Switch } from './Switch'

describe('Switch', () => {
  it('is reachable by its visible label', () => {
    render(<Switch label="Notifications par e-mail" />)

    expect(screen.getByRole('switch', { name: 'Notifications par e-mail' })).toBeVisible()
  })

  it('is off by default and toggles on click', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<Switch label="Notifications par e-mail" onCheckedChange={onCheckedChange} />)

    const toggle = screen.getByRole('switch', { name: 'Notifications par e-mail' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await user.click(toggle)

    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('toggles with the keyboard, Tab then Space', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<Switch label="Notifications par e-mail" onCheckedChange={onCheckedChange} />)

    await user.tab()
    expect(screen.getByRole('switch', { name: 'Notifications par e-mail' })).toHaveFocus()

    await user.keyboard(' ')

    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('marks the field invalid and describes it with the error', () => {
    render(<Switch label="Notifications par e-mail" error="Impossible d’activer pour le moment." />)

    const toggle = screen.getByRole('switch', { name: 'Notifications par e-mail' })
    expect(toggle).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Impossible d’activer pour le moment.')
  })

  it('describes the field with help text', () => {
    render(<Switch label="Mode maintenance" help="Bloque l’accès aux membres." />)

    expect(screen.getByRole('switch', { name: 'Mode maintenance' })).toHaveAccessibleDescription(
      'Bloque l’accès aux membres.'
    )
  })

  it('is disabled when the caller disables it', () => {
    render(<Switch label="Notifications par e-mail" disabled />)

    expect(screen.getByRole('switch', { name: 'Notifications par e-mail' })).toBeDisabled()
  })

  it('forwards its ref, so a form can move focus to it', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<Switch label="Notifications par e-mail" ref={ref} />)

    ref.current?.focus()

    expect(screen.getByRole('switch', { name: 'Notifications par e-mail' })).toHaveFocus()
  })
})
