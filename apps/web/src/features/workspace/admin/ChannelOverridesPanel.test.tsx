import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { OverrideState } from '../iamApi'
import '../../../i18n'
import { TriState } from './ChannelOverridesPanel'
import { renderPanel } from './test-support'

function Harness({ initial }: { initial: OverrideState }) {
  const [value, setValue] = useState<OverrideState>(initial)
  return (
    <TriState label="Envoyer des messages" value={value} disabled={false} onChange={setValue} />
  )
}

describe('TriState (allow / inherit / deny)', () => {
  it('keeps only the checked option in the Tab sequence', () => {
    renderPanel(<Harness initial="inherit" />)
    const group = screen.getByRole('radiogroup', { name: 'Envoyer des messages' })
    expect(within(group).getByRole('radio', { name: 'Hériter' })).toHaveAttribute('tabindex', '0')
    expect(within(group).getByRole('radio', { name: 'Autoriser' })).toHaveAttribute('tabindex', '-1')
    expect(within(group).getByRole('radio', { name: 'Refuser' })).toHaveAttribute('tabindex', '-1')
  })

  it('moves selection and focus with the arrow keys, wrapping around at both ends', async () => {
    const user = userEvent.setup()
    renderPanel(<Harness initial="inherit" />)
    const group = screen.getByRole('radiogroup', { name: 'Envoyer des messages' })
    const allow = within(group).getByRole('radio', { name: 'Autoriser' })
    const inherit = within(group).getByRole('radio', { name: 'Hériter' })
    const deny = within(group).getByRole('radio', { name: 'Refuser' })

    inherit.focus()
    await user.keyboard('{ArrowRight}')
    expect(deny).toHaveAttribute('aria-checked', 'true')
    expect(deny).toHaveAttribute('tabindex', '0')
    expect(deny).toHaveFocus()

    // ArrowRight wraps forward from Deny to Allow.
    await user.keyboard('{ArrowRight}')
    expect(allow).toHaveAttribute('aria-checked', 'true')
    expect(allow).toHaveFocus()

    // ArrowLeft wraps backward from Allow to Deny.
    await user.keyboard('{ArrowLeft}')
    expect(deny).toHaveAttribute('aria-checked', 'true')
    expect(deny).toHaveFocus()

    // ArrowDown and ArrowUp follow the same order as ArrowRight and ArrowLeft.
    await user.keyboard('{ArrowDown}')
    expect(allow).toHaveAttribute('aria-checked', 'true')
    expect(allow).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(deny).toHaveAttribute('aria-checked', 'true')
    expect(deny).toHaveFocus()
  })

  it('prevents the arrow keys’ default behaviour while selecting and focusing', () => {
    const onChange = vi.fn()
    renderPanel(
      <TriState label="Envoyer des messages" value="allow" disabled={false} onChange={onChange} />
    )
    const group = screen.getByRole('radiogroup', { name: 'Envoyer des messages' })
    const allow = within(group).getByRole('radio', { name: 'Autoriser' })
    allow.focus()
    // fireEvent returns false when the cancelable keydown was prevented.
    expect(fireEvent.keyDown(allow, { key: 'ArrowRight' })).toBe(false)
    expect(onChange).toHaveBeenLastCalledWith('inherit')
    expect(within(group).getByRole('radio', { name: 'Hériter' })).toHaveFocus()
  })
})
