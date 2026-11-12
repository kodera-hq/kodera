import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import '../../i18n'
import { FirstRunOnboardingModal } from './FirstRunOnboardingModal'
import { localClaim, TEMPLATE_CHANNELS, type TemplateId } from './instantClaimClient'

it.each([
  ['audiovisual', 'audiovisual-production'],
  ['studio-tech', 'tech-studio'],
  ['conseil-b2b', 'b2b-advisory'],
  ['secteur-public', 'public-sector'],
  ['proximity', 'proximity'],
] as const)('previews the channels claimed for %s', async (selection, templateId: TemplateId) => {
  const user = userEvent.setup()
  render(
    <FirstRunOnboardingModal
      open
      isDarkTheme={false}
      onSelectTheme={() => {}}
      onComplete={() => {}}
      onDismiss={() => {}}
    />
  )
  const modal = screen.getByRole('dialog')
  await user.type(within(modal).getByRole('textbox', { name: 'Nom de l’espace' }), 'Studio')
  await user.click(within(modal).getByRole('button', { name: 'Continuer' }))
  await user.selectOptions(within(modal).getByRole('combobox'), selection)
  const rows = within(modal)
    .getAllByRole('listitem')
    .map((row) => row.textContent)
  const claimed = localClaim({
    organizationName: 'Studio',
    slug: 'studio',
    hostingMode: 'cloud',
    templateId,
    themeId: 'givre',
    soundPackId: 'silence',
    enabledConnectors: [],
  })
  expect(claimed.channels.map((ch) => ch.name)).toEqual(TEMPLATE_CHANNELS[templateId])
  expect(rows).toHaveLength(claimed.channels.length)
  for (const [index, channel] of claimed.channels.entries()) {
    const text =
      channel.name === 'stage-control'
        ? 'Plateau & Régie'
        : channel.name === 'editing-room'
          ? 'Salle de montage'
          : channel.name
    expect(rows[index]).toContain(text)
  }
})
