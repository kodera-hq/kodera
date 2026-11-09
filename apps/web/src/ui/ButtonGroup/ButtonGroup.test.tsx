import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { Button } from '../Button/Button'
import { ButtonGroup } from './ButtonGroup'

describe('ButtonGroup', () => {
  it('groups its buttons under one accessible name', () => {
    render(
      <ButtonGroup aria-label="Mise en forme">
        <Button>Gras</Button>
        <Button>Italique</Button>
      </ButtonGroup>
    )

    const group = screen.getByRole('group', { name: 'Mise en forme' })
    expect(group).toBeVisible()
    expect(screen.getByRole('button', { name: 'Gras' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Italique' })).toBeVisible()
  })

  it('leaves each button independently reachable — no roving tabindex here', () => {
    // A ButtonGroup is a set of independent actions, not one composite widget:
    // every button keeps its own place in the tab order.
    render(
      <ButtonGroup aria-label="Actions">
        <Button>Modifier</Button>
        <Button>Supprimer</Button>
      </ButtonGroup>
    )

    expect(screen.getByRole('button', { name: 'Modifier' })).not.toHaveAttribute('tabindex')
    expect(screen.getByRole('button', { name: 'Supprimer' })).not.toHaveAttribute('tabindex')
  })

  it('joins the segments when attached, without changing what is in the tree', () => {
    render(
      <ButtonGroup aria-label="Vue" attached>
        <Button variant="secondary">Jour</Button>
        <Button variant="secondary">Semaine</Button>
        <Button variant="secondary">Mois</Button>
      </ButtonGroup>
    )

    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('forwards its ref, so a caller can measure or focus the wrapper', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <ButtonGroup aria-label="Actions" ref={ref}>
        <Button>Continuer</Button>
      </ButtonGroup>
    )

    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('keeps role="group" even if a caller passes a conflicting role', () => {
    // `role` is a valid prop here (`HTMLAttributes`) — a caller's own role
    // must not be able to turn this into something a screen reader no longer
    // reads as a set of related actions.
    render(
      <ButtonGroup aria-label="Actions" role="list">
        <Button>Continuer</Button>
      </ButtonGroup>
    )

    expect(screen.getByRole('group', { name: 'Actions' })).toBeVisible()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('concatenates the caller class with its own layout classes', () => {
    render(
      <ButtonGroup aria-label="Actions" className="w-full">
        <Button>Continuer</Button>
      </ButtonGroup>
    )

    expect(screen.getByRole('group')).toHaveClass('w-full')
    expect(screen.getByRole('group')).toHaveClass('inline-flex')
  })
})
