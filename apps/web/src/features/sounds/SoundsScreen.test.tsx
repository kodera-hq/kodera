import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { SOUND_STORAGE_KEY, SoundEngine } from './index'
import { SoundsScreen } from './SoundsScreen'

describe('SoundsScreen (SoundsScreen.tsx)', () => {
  let engine: SoundEngine

  beforeEach(() => {
    localStorage.clear()
    engine = new SoundEngine({
      audioContextFactory: () => null,
    })
  })

  afterEach(() => {
    engine.destroy()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('renders the 6 sound pack radio options with Givre chosen by default and zero nested buttons', () => {
    const { container } = render(<SoundsScreen engine={engine} />)

    expect(
      screen.getByRole('heading', { level: 1, name: 'Ambiance sonore' })
    ).toBeInTheDocument()

    const packGroup = screen.getByRole('radiogroup', { name: 'Signature sonore' })
    const radios = within(packGroup).getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('value'))).toEqual([
      'givre',
      'atelier',
      'souffle',
      'cosmos',
      'luciole',
      'silencieux',
    ])

    const givreRadio = screen.getByRole('radio', { name: 'Givre' })
    expect(givreRadio).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Par défaut')).toBeInTheDocument()

    // Ensure no <button> is ever nested inside another <button>
    expect(container.querySelectorAll('button button')).toHaveLength(0)

    // Verify every Apercu button is a sibling outside the radio item and meets >= 44x44 px (min-h-12 min-w-12)
    const previewButtons = within(packGroup).getAllByRole('button', {
      name: /Écouter un aperçu de/i,
    })
    expect(previewButtons).toHaveLength(6)
    for (const btn of previewButtons) {
      expect(btn).toHaveClass('min-h-12', 'min-w-12')
      expect(btn.closest('[role="radio"]')).toBeNull()
    }
  })

  it('persists pack selection to localStorage and previews packs via sibling Apercu button with polite status feedback', async () => {
    const user = userEvent.setup()
    const previewSpy = vi.spyOn(engine, 'previewPack')
    render(<SoundsScreen engine={engine} />)

    const cosmosRadio = screen.getByRole('radio', { name: 'Cosmos' })
    await user.click(cosmosRadio)

    expect(cosmosRadio).toHaveAttribute('aria-checked', 'true')
    expect(cosmosRadio.parentElement).toHaveClass('border-2', 'border-c-accent-ink')
    expect(JSON.parse(localStorage.getItem(SOUND_STORAGE_KEY)!).pack).toBe('cosmos')

    // Clicking Apercu on Luciole previews Luciole without changing the selected Cosmos radio
    const previewLuciole = screen.getByRole('button', {
      name: 'Écouter un aperçu de Luciole',
    })
    await user.click(previewLuciole)

    expect(previewSpy).toHaveBeenCalledWith('luciole')
    expect(cosmosRadio).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Aperçu sonore en cours : Luciole.')
  })

  it('updates master mode, master volume slider, and the 4 category switches', async () => {
    const user = userEvent.setup()
    render(<SoundsScreen engine={engine} />)

    // Switch master mode to Essentiels uniquement
    const essentialRadio = screen.getByRole('radio', { name: 'Essentiels uniquement' })
    await user.click(essentialRadio)
    expect(engine.getPreferences().masterMode).toBe('essential')

    // Adjust master volume slider
    const slider = screen.getByRole('slider', { name: 'Volume principal' })
    fireEvent.change(slider, { target: { value: '45' } })
    expect(engine.getPreferences().masterVolume).toBeCloseTo(0.45, 2)

    // Toggle category switch
    const workspaceSwitch = screen.getByRole('switch', {
      name: 'Espace de travail et rappels',
    })
    expect(workspaceSwitch).toHaveAttribute('aria-checked', 'true')
    await user.click(workspaceSwitch)
    expect(workspaceSwitch).toHaveAttribute('aria-checked', 'false')
    expect(engine.getPreferences().categories.workspace).toBe(false)
  })

  it('displays the polite InlineAlert warning when localStorage refuses writes', async () => {
    const user = userEvent.setup()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })

    render(<SoundsScreen engine={engine} />)
    await user.click(screen.getByRole('radio', { name: 'Souffle' }))

    expect(screen.getByRole('radio', { name: 'Souffle' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      /Ce navigateur ne conserve pas ce réglage/
    )
  })
})
