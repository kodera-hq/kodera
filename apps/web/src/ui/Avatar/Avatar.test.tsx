import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Avatar } from './Avatar'

describe('Avatar', () => {
  it('shows initials from the name when there is no image', () => {
    render(<Avatar name="Henri Duflot" />)

    expect(screen.getByText('HD')).toBeInTheDocument()
  })

  it('is a 32px circle', () => {
    render(<Avatar name="Henri Duflot" />)

    const avatar = screen.getByText('HD')
    expect(avatar).toHaveClass('h-8')
    expect(avatar).toHaveClass('w-8')
    expect(avatar).toHaveClass('rounded-full')
  })

  it('draws the 20 px circle only when asked, for an image too', () => {
    const { rerender } = render(<Avatar name="Henri Duflot" size="xs" />)
    expect(screen.getByText('HD')).toHaveClass('h-5', 'w-5', 'rounded-full')
    expect(screen.getByText('HD')).not.toHaveClass('h-8')
    rerender(<Avatar name="Henri Duflot" size="xs" src="/avatars/henri.jpg" />)
    expect(screen.getByRole('img', { name: 'Henri Duflot' })).toHaveClass('h-5', 'w-5')
  })

  it('draws a person glyph, and no character, for someone with no name, still named', () => {
    render(<Avatar name="9f3c2b1a" anonymous />)
    const avatar = screen.getByRole('img', { name: '9f3c2b1a' })
    expect(avatar.textContent).toBe('')
    expect(avatar.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('takes its accessible name from the person, not the initials alone', () => {
    render(<Avatar name="Henri Duflot" />)

    expect(screen.getByRole('img', { name: 'Henri Duflot' })).toBeInTheDocument()
  })

  it('keeps the name as its accessible name even when a caller passes its own aria-label', () => {
    render(<Avatar name="Henri Duflot" aria-label="Ignoré" />)

    expect(screen.getByRole('img', { name: 'Henri Duflot' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Ignoré' })).toBeNull()
  })

  it('renders a real image when a source is given, with the name as alt text', () => {
    render(<Avatar name="Henri Duflot" src="/avatars/henri.jpg" />)

    const image = screen.getByRole('img', { name: 'Henri Duflot' })
    expect(image.tagName).toBe('IMG')
    expect(image).toHaveAttribute('src', '/avatars/henri.jpg')
  })

  it('styles the admin variant with the dark ground', () => {
    render(<Avatar name="Henri Duflot" variant="admin" />)

    expect(screen.getByText('HD')).toHaveClass('bg-c-inverse')
  })

  it('styles the member variant with the cobalt tint', () => {
    render(<Avatar name="Bruno Petit" variant="member" />)

    expect(screen.getByText('BP')).toHaveClass('bg-c-accent-soft')
  })

  it('styles the pending variant with a dashed border and no fill', () => {
    render(<Avatar name="Carla Dupuis" variant="pending" />)

    const avatar = screen.getByText('CD')
    expect(avatar).toHaveClass('border-dashed')
  })

  it('derives initials from a single-word name', () => {
    render(<Avatar name="Prestataire" />)

    expect(screen.getByText('P')).toBeInTheDocument()
  })
})

describe('workspace member faces', () => {
  it('draws a 40 px stable member tone and names the online dot without visible state text', () => {
    const { container, rerender } = render(
      <Avatar name="Alice" identity="@alice:example.test" size="lg" onlineLabel="en ligne" />
    )
    const face = screen.getByRole('img', { name: 'Alice, en ligne' })
    expect(face).toHaveClass('h-10', 'w-10')
    const tone = face.className
    expect(container.querySelector('[data-online]')).toHaveClass('bg-c-ok', 'ring-c-surface')
    expect(face.textContent).toBe('A')
    rerender(<Avatar name="Alice" identity="@alice:example.test" size="lg" />)
    expect(screen.getByRole('img', { name: 'Alice' }).className).toBe(tone)
    expect(container.querySelector('[data-online]')).toBeNull()
  })
})
