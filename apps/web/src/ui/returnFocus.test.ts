import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeAutoFocusHandler } from './returnFocus'

describe('overlay return focus', () => {
  let container: HTMLDivElement
  let first: HTMLButtonElement
  let second: HTMLButtonElement

  beforeEach(() => {
    container = document.createElement('div')
    first = document.createElement('button')
    second = document.createElement('button')
    first.textContent = 'Avant'
    second.textContent = 'Après'
    container.append(first, second)
    document.body.append(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('returns focus to the current target even when the ref changes after opening', () => {
    const target: { current: HTMLElement | null } = { current: first }
    const onClose = closeAutoFocusHandler(target)
    first.focus()

    target.current = second
    const closeEvent = new Event('closeAutoFocus', { cancelable: true })
    onClose(closeEvent)

    expect(second).toHaveFocus()
    expect(first).not.toHaveFocus()
    expect(closeEvent.defaultPrevented).toBe(true)
  })

  it('leaves focus and default restoration alone when the ref becomes empty before closing', () => {
    const target: { current: HTMLElement | null } = { current: first }
    const onClose = closeAutoFocusHandler(target)
    second.focus()

    target.current = null
    const closeEvent = new Event('closeAutoFocus', { cancelable: true })
    onClose(closeEvent)

    expect(second).toHaveFocus()
    expect(closeEvent.defaultPrevented).toBe(false)
  })
})
