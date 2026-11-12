import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { ThemeStudioModal } from './ThemeStudioModal'

const props = {
  open: true,
  currentThemeMode: 'light' as const,
  onSelectCoreTheme: vi.fn(),
  onClose: vi.fn(),
}

it('only announces sharing after the channel acknowledges publication', async () => {
  let resolve!: () => void
  const publish = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done
      })
  )
  render(<ThemeStudioModal {...props} onShareToChannel={publish} />)
  await userEvent.click(screen.getByTestId('theme-share-to-channel-btn'))
  expect(publish).toHaveBeenCalledOnce()
  expect(screen.getByTestId('theme-share-to-channel-btn')).toBeDisabled()
  expect(screen.queryByText('Thème partagé dans le salon actif.')).toBeNull()
  await act(async () => resolve())
  expect(screen.getByTestId('theme-studio-status')).toHaveTextContent(
    'Thème partagé dans le salon actif.'
  )
})

it('reports a rejected publication and never claims success', async () => {
  render(
    <ThemeStudioModal
      {...props}
      onShareToChannel={vi.fn().mockRejectedValue(new Error('offline'))}
    />
  )
  await userEvent.click(screen.getByTestId('theme-share-to-channel-btn'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Le thème n’a pas été publié')
  expect(screen.queryByText('Thème partagé dans le salon actif.')).toBeNull()
})

it('disables sharing when there is no writable text channel', () => {
  render(<ThemeStudioModal {...props} />)
  expect(screen.getByTestId('theme-share-to-channel-btn')).toBeDisabled()
  expect(screen.getByText('Ouvrez un salon texte disponible pour partager ce thème.')).toBeVisible()
})

it('uses English interface copy when English is selected', async () => {
  await i18n.changeLanguage('en')
  render(<ThemeStudioModal {...props} />)
  expect(screen.getByRole('button', { name: 'Reset colours' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Save theme' })).toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Theme name' })).toHaveValue('My theme')
  await i18n.changeLanguage('fr')
})

it('reports storage failure instead of claiming that a theme was saved', async () => {
  render(<ThemeStudioModal {...props} />)
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  await userEvent.click(screen.getByTestId('theme-studio-save-btn'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Le thème n’a pas été sauvegardé')
  write.mockRestore()
})

it('offers Ciel first and keeps every Givre theme one click away', async () => {
  const onSelectCoreTheme = vi.fn()
  render(
    <ThemeStudioModal {...props} currentThemeMode="ciel" onSelectCoreTheme={onSelectCoreTheme} />
  )
  const official = ['ciel', 'ciel-nuit', 'light', 'dark', 'black'].map((theme) =>
    screen.getByTestId(`theme-studio-base-${theme}`)
  )
  expect(official[0]).toHaveAttribute('aria-pressed', 'true')
  for (const [index, theme] of (['ciel-nuit', 'light', 'dark', 'black'] as const).entries()) {
    await userEvent.click(official[index + 1]!)
    expect(onSelectCoreTheme).toHaveBeenLastCalledWith(theme)
  }
  expect(onSelectCoreTheme).toHaveBeenCalledTimes(4)
})

it('records a Ciel theme in a share code by its mode, which the v1 code knows', () => {
  render(<ThemeStudioModal {...props} currentThemeMode="ciel-nuit" />)
  const code = (
    screen.getByRole('textbox', { name: 'Code de partage du thème' }) as HTMLInputElement
  ).value
  const payload = JSON.parse(atob(code.slice('kodera-theme:v1:'.length))) as { baseMode: string }
  expect(payload.baseMode).toBe('dark')
})
