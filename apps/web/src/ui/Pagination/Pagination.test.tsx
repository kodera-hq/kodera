import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Pagination } from './Pagination'

describe('Pagination', () => {
  it('shows only a previous and a next control, never a page number or a total', () => {
    render(
      <Pagination
        ariaLabel="Pagination"
        hasPrevious
        hasMore
        previousLabel="Page précédente"
        nextLabel="Page suivante"
        onPrevious={() => {}}
        onNext={() => {}}
      />
    )

    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByText(/\d/)).toBeNull()
  })

  it('disables previous on the first page', () => {
    render(
      <Pagination
        ariaLabel="Pagination"
        hasPrevious={false}
        hasMore
        previousLabel="Page précédente"
        nextLabel="Page suivante"
        onPrevious={() => {}}
        onNext={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: 'Page précédente' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Page suivante' })).not.toBeDisabled()
  })

  it('disables next when has_more is false', () => {
    render(
      <Pagination
        ariaLabel="Pagination"
        hasPrevious
        hasMore={false}
        previousLabel="Page précédente"
        nextLabel="Page suivante"
        onPrevious={() => {}}
        onNext={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: 'Page suivante' })).toBeDisabled()
  })

  it('calls onNext and onPrevious when their buttons are activated', async () => {
    const user = userEvent.setup()
    const onNext = vi.fn()
    const onPrevious = vi.fn()
    render(
      <Pagination
        ariaLabel="Pagination"
        hasPrevious
        hasMore
        previousLabel="Page précédente"
        nextLabel="Page suivante"
        onPrevious={onPrevious}
        onNext={onNext}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Page suivante' }))
    await user.click(screen.getByRole('button', { name: 'Page précédente' }))

    expect(onNext).toHaveBeenCalledOnce()
    expect(onPrevious).toHaveBeenCalledOnce()
  })

  it('announces a page change through a live region the caller sets', () => {
    const { rerender } = render(
      <Pagination
        ariaLabel="Pagination"
        hasPrevious
        hasMore
        previousLabel="Page précédente"
        nextLabel="Page suivante"
        onPrevious={() => {}}
        onNext={() => {}}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('')

    rerender(
      <Pagination
        ariaLabel="Pagination"
        hasPrevious
        hasMore
        previousLabel="Page précédente"
        nextLabel="Page suivante"
        onPrevious={() => {}}
        onNext={() => {}}
        announcement="Page suivante affichée"
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('Page suivante affichée')
  })
})
