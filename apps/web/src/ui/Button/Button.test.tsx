import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './Button'

describe('Button', () => {
  it('is a button with the label the caller gave it', () => {
    render(<Button>Inviter des personnes</Button>)

    expect(screen.getByRole('button', { name: 'Inviter des personnes' })).toBeVisible()
  })

  it('does not submit the form it happens to sit in unless asked', () => {
    // The default `type` of a `<button>` is `submit`, so every secondary action
    // on a form is an accidental submit until someone notices.
    render(<Button>Annuler</Button>)

    expect(screen.getByRole('button', { name: 'Annuler' })).toHaveAttribute('type', 'button')
  })

  it('keeps its name and its label node while loading, and says it is busy', () => {
    // The label stays in the DOM: that is what preserves the width the design
    // asks for, and what keeps the accessible name from vanishing mid-wait.
    render(<Button loading>Envoyer</Button>)

    const button = screen.getByRole('button', { name: 'Envoyer' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('data-loading')
    expect(screen.getByText('Envoyer')).toBeInTheDocument()
  })

  it('stays focusable while loading, so the wait does not throw focus to the body', () => {
    // The native `disabled` attribute would blur the button the instant it is
    // set, dropping a keyboard user back to the top of the page, and it removes
    // the element from the accessibility tree — which is what makes `aria-busy`
    // on a disabled button an announcement nobody hears.
    render(<Button loading>Envoyer</Button>)

    const button = screen.getByRole('button', { name: 'Envoyer' })
    expect(button).not.toBeDisabled()

    button.focus()

    expect(button).toHaveFocus()
  })

  it('cannot be activated while it is loading', () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Envoyer
      </Button>
    )

    screen.getByRole('button', { name: 'Envoyer' }).click()

    expect(onClick).not.toHaveBeenCalled()
  })

  it('is disabled when the caller disables it', () => {
    render(<Button disabled>Supprimer</Button>)

    expect(screen.getByRole('button', { name: 'Supprimer' })).toBeDisabled()
  })

  it('hides the icon from assistive technology so it cannot become the name', () => {
    // An `<svg>` with a `<title>` contributes that title to the accessible name
    // unless it is hidden, which is how a decorative glyph ends up renaming the
    // action a screen reader announces.
    render(
      <Button
        icon={
          <svg viewBox="0 0 16 16">
            <title>Signe plus</title>
          </svg>
        }
      >
        Ajouter
      </Button>
    )

    expect(screen.getByRole('button')).toHaveAccessibleName('Ajouter')
  })

  it('takes its name from the caller when the icon is all there is', () => {
    render(<Button icon={<svg viewBox="0 0 16 16" />} aria-label="Plus d’actions" />)

    expect(screen.getByRole('button')).toHaveAccessibleName('Plus d’actions')
  })

  it('renders the caller element with asChild, so a link can look like a button', () => {
    render(
      <Button asChild variant="secondary">
        <a href="/factures">Voir les factures</a>
      </Button>
    )

    const link = screen.getByRole('link', { name: 'Voir les factures' })
    expect(link).toHaveAttribute('href', '/factures')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('disables the caller element too, since an anchor has no disabled attribute', () => {
    // `disabled` on a `<Slot>` is dropped on the floor: an `<a>` does not
    // support it, so the styling says "unavailable" while the link still
    // navigates and still answers `Tab`.
    const onClick = vi.fn()
    render(
      <Button asChild disabled onClick={onClick}>
        <a href="/factures">Voir les factures</a>
      </Button>
    )

    const link = screen.getByRole('link', { name: 'Voir les factures' })
    expect(link).toHaveAttribute('aria-disabled', 'true')
    expect(link).toHaveAttribute('data-disabled')
    expect(link).toHaveAttribute('tabindex', '-1')

    link.click()

    expect(onClick).not.toHaveBeenCalled()
  })

  it('forwards its ref, so a form can move focus to it', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<Button ref={ref}>Réessayer</Button>)

    ref.current?.focus()

    expect(screen.getByRole('button', { name: 'Réessayer' })).toHaveFocus()
  })

  it('stops a loading click from reaching the row it sits in', () => {
    // The native `disabled` attribute would also stop the parent from ever
    // seeing the click. `loading` deliberately keeps the button in the tree
    // and focusable, so the guard has to do that work itself with
    // `stopPropagation` — this proves the row does not act on a click the
    // button refused.
    const onParentClick = vi.fn()
    const onButtonClick = vi.fn()
    render(
      // A stand-in for the row or card a real button sits in, not a control of
      // its own — the a11y rules below are about a person operating this
      // element, and nobody does; the spy is standing in for delegated markup
      // event handling.
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={onParentClick}>
        <Button loading onClick={onButtonClick}>
          Envoyer
        </Button>
      </div>
    )

    screen.getByRole('button', { name: 'Envoyer' }).click()

    expect(onButtonClick).not.toHaveBeenCalled()
    expect(onParentClick).not.toHaveBeenCalled()
  })

  it('stops a disabled asChild click from reaching the row it sits in', () => {
    // An `<a>` has no `disabled` attribute to stop the browser's own click
    // from bubbling, so this primitive's own guard is the only thing that can
    // stop the row from acting on a link it rendered as unavailable.
    const onParentClick = vi.fn()
    const onButtonClick = vi.fn()
    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={onParentClick}>
        <Button asChild disabled onClick={onButtonClick}>
          <a href="/factures">Voir les factures</a>
        </Button>
      </div>
    )

    screen.getByRole('link', { name: 'Voir les factures' }).click()

    expect(onButtonClick).not.toHaveBeenCalled()
    expect(onParentClick).not.toHaveBeenCalled()
  })

  it('lets an active click reach the row it sits in', () => {
    // The guard above must not swallow every click — only the ones the
    // button itself refused.
    const onParentClick = vi.fn()
    const onButtonClick = vi.fn()
    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={onParentClick}>
        <Button onClick={onButtonClick}>Envoyer</Button>
      </div>
    )

    screen.getByRole('button', { name: 'Envoyer' }).click()

    expect(onButtonClick).toHaveBeenCalledTimes(1)
    expect(onParentClick).toHaveBeenCalledTimes(1)
  })

  it('ignores Enter and Space while loading, and keeps focus where it was', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Envoyer
      </Button>
    )

    const button = screen.getByRole('button', { name: 'Envoyer' })
    button.focus()

    await user.keyboard('{Enter}')
    expect(onClick).not.toHaveBeenCalled()
    expect(button).toHaveFocus()

    await user.keyboard('[Space]')
    expect(onClick).not.toHaveBeenCalled()
    expect(button).toHaveFocus()
  })

  it('reaches onClick with Enter and with Space when enabled', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Envoyer</Button>)

    const button = screen.getByRole('button', { name: 'Envoyer' })
    button.focus()

    await user.keyboard('{Enter}')
    expect(onClick).toHaveBeenCalledTimes(1)

    await user.keyboard('[Space]')
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('does not activate on Enter and is skipped by Tab when asChild and disabled', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <>
        <button type="button">Avant</button>
        <Button asChild disabled onClick={onClick}>
          <a href="/factures">Voir les factures</a>
        </Button>
        <button type="button">Après</button>
      </>
    )

    const link = screen.getByRole('link', { name: 'Voir les factures' })
    expect(link).toHaveAttribute('tabindex', '-1')

    // Tab order skips straight from "Avant" to "Après" — the disabled link
    // is never a stop along the way, which is what `tabIndex={-1}` is for.
    await user.click(screen.getByRole('button', { name: 'Avant' }))
    await user.tab()
    expect(screen.getByRole('button', { name: 'Après' })).toHaveFocus()

    // A disabled asChild link still answers a native click by navigating —
    // that guard is `onClick`'s job, proven elsewhere. Enter on a focused
    // element is a keyboard activation this primitive must refuse the same
    // way, whether or not Tab would ever have put focus there on its own.
    link.focus()
    await user.keyboard('{Enter}')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('concatenates the caller class with the variant classes', () => {
    // Concatenation is all this proves. Which of two conflicting utilities wins
    // is decided by the order of the rules in the stylesheet, not by the order
    // of the names in the attribute — see `src/ui/cx.ts`.
    render(<Button className="w-full">Continuer</Button>)

    const button = screen.getByRole('button', { name: 'Continuer' })
    expect(button).toHaveClass('w-full')
    expect(button).toHaveClass('inline-flex')
  })

  describe('iconOnly', () => {
    it('is a square named by its aria-label, with no text, and its name as a tooltip on focus', async () => {
      const user = userEvent.setup()
      render(
        <Button iconOnly size="sm" icon={<svg data-testid="glyph" />} aria-label="Envoyer">
          Envoyer
        </Button>
      )
      await user.tab()
      const button = screen.getByRole('button', { name: 'Envoyer' })
      expect(button).toHaveFocus()
      expect(button).toHaveTextContent('')
      expect(button).toHaveClass('h-8', 'w-8')
      expect(button).not.toHaveClass('px-4')
      expect(await screen.findByRole('tooltip', { hidden: true })).toHaveTextContent('Envoyer')
      expect(button).toHaveAccessibleDescription('')
    })

    it('refuses to draw without a name or an icon', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(() => render(<Button iconOnly icon={<svg />} />)).toThrow(/aria-label/)
      expect(() => render(<Button iconOnly icon={<svg />} aria-label="  " />)).toThrow(/aria-label/)
      expect(() => render(<Button iconOnly aria-label="Envoyer" />)).toThrow(/icon/)
      expect(() => render(<Button iconOnly icon={false} aria-label="Envoyer" />)).toThrow(/icon/)
      expect(() =>
        render(
          <Button iconOnly asChild icon={<svg />} aria-label="Envoyer">
            <a href="/x">Envoyer</a>
          </Button>
        )
      ).toThrow(/asChild/)
    })

    it('keeps its name and is busy while loading', () => {
      render(<Button iconOnly loading icon={<svg />} aria-label="Envoyer" />)
      const button = screen.getByRole('button', { name: 'Envoyer' })
      expect(button).toHaveAttribute('aria-busy', 'true')
      expect(button).toHaveAttribute('aria-disabled', 'true')
      expect(button).toHaveClass('w-10')
    })
  })
})
