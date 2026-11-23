import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { ClaimWorkspaceSummary } from './ClaimWorkspaceSummary'
import { FirstRunOnboardingModal } from './FirstRunOnboardingModal'
import {
  CONNECTOR_IDS,
  InstantClaimError,
  instantClaimWorkspace,
  localClaim,
  normalizeCustomization,
  slugifyChannelKey,
  TEMPLATE_CHANNEL_BLUEPRINTS,
  TEMPLATE_CHANNELS,
  type InstantClaimPayload,
} from './instantClaimClient'
import { OnboardingActivationChecklist } from './OnboardingActivationChecklist'
import {
  ACTIVATION_STORAGE_PREFIX,
  ACTIVATION_TASK_IDS,
  activationChecklistStorageKey,
  completeActivationTask,
  dismissActivationChecklist,
  readActivationChecklist,
} from './onboardingState'
import {
  CUSTOMIZABLE_PERSONA_IDS,
  getTemplatePersona,
  listCustomizablePersonas,
} from './TemplatePersonaCatalog'

const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../../api/client', async () => ({
  ...(await vi.importActual('../../api/client')),
  coreApi: () => ({ POST: post }),
}))

beforeEach(() => {
  localStorage.clear()
  post.mockReset()
})

describe('TemplatePersonaCatalog 6-persona contract', () => {
  it('provides 1:1 blueprint keys, explicit text/audio kinds, < 45 s setup badge, roles, Docs/Collections, and valid connectors for all 6 personas', () => {
    const personas = listCustomizablePersonas()
    expect(personas).toHaveLength(6)
    expect(personas.map((p) => p.templateId)).toEqual([...CUSTOMIZABLE_PERSONA_IDS])

    for (const persona of personas) {
      expect(persona.isCustomizablePersona).toBe(true)
      expect(persona.estimatedSetupSeconds).toBe(45)
      expect(persona.starterChannels).toEqual(TEMPLATE_CHANNEL_BLUEPRINTS[persona.templateId])
      expect(persona.starterChannels.map((ch) => ch.name)).toEqual(
        TEMPLATE_CHANNELS[persona.templateId]
      )
      expect(persona.starterTextChannels.length).toBeGreaterThanOrEqual(1)
      expect(persona.recommendedRoles.fr.length).toBeGreaterThan(0)
      expect(persona.recommendedRoles.en.length).toBeGreaterThan(0)
      expect(persona.starterDocsSummary.fr.length).toBeGreaterThan(0)
      expect(persona.starterDocsSummary.en.length).toBeGreaterThan(0)
      expect(persona.starterCollectionsSummary.fr.length).toBeGreaterThan(0)
      expect(persona.starterCollectionsSummary.en.length).toBeGreaterThan(0)
      for (const connector of persona.defaultConnectors) {
        expect(CONNECTOR_IDS).toContain(connector)
      }
      expect(getTemplatePersona(persona.templateId)).toBe(persona)
    }

    // Core templates.py parity checks: explicit audio kinds regardless of index
    const coop = getTemplatePersona('association-coop')
    expect(coop.starterChannels.find((ch) => ch.templateKey === 'foyer')?.kind).toBe('audio')
    expect(coop.starterChannels.find((ch) => ch.templateKey === 'assemblee')?.kind).toBe('audio')

    const tech = getTemplatePersona('tech-studio')
    expect(tech.starterChannels.map((ch) => `${ch.kind}:${ch.templateKey}`)).toEqual([
      'text:general',
      'text:releases',
      'text:incidents',
      'audio:standup',
      'audio:pairing',
    ])
  })

  it('validates and normalizes custom channel names 1:1 with Core rules at both UI and instantClaimClient boundaries', async () => {
    expect(slugifyChannelKey('ø')).toBeNull()
    expect(slugifyChannelKey('Ａ')).toBeNull()
    expect(slugifyChannelKey('design\u00adsync')).toBeNull()
    expect(slugifyChannelKey('---')).toBeNull()
    expect(slugifyChannelKey('a'.repeat(65))).toBeNull()
    expect(slugifyChannelKey('line1\nline2')).toBeNull()

    expect(slugifyChannelKey('99z Roadmap')).toBe('c-99z-roadmap')
    expect(slugifyChannelKey('Design Sync!')).toBe('design-sync')
    expect(slugifyChannelKey('Équipe Produit')).toBe('equipe-produit')
    expect(slugifyChannelKey('a'.repeat(40))).toBe('a'.repeat(32))

    // Direct client boundary rejects soft-hyphen and colliding derived keys
    await expect(
      instantClaimWorkspace({
        organizationName: 'Studio Boundary',
        slug: 'studio-boundary',
        hostingMode: 'cloud',
        templateId: 'tech-studio',
        themeId: 'givre',
        soundPackId: 'givre',
        enabledConnectors: [],
        customization: {
          includeAudioChannels: true,
          includeCollections: true,
          includeStarterDocs: true,
          additionalChannels: [
            { categoryKey: 'engineering', name: 'design\u00adsync', kind: 'text' },
          ],
        },
      })
    ).rejects.toBeInstanceOf(InstantClaimError)

    expect(
      normalizeCustomization(
        {
          includeAudioChannels: true,
          includeCollections: true,
          includeStarterDocs: true,
          additionalChannels: [
            { categoryKey: 'engineering', name: 'Design Sync!', kind: 'text' },
            { categoryKey: 'engineering', name: 'design--sync', kind: 'text' },
          ],
        },
        'tech-studio'
      )
    ).toBeNull()

    // Direct client boundary normalizes raw display names and >32-char names before transmitting
    const capturedBodies: unknown[] = []
    const claimed = await instantClaimWorkspace(
      {
        organizationName: 'Studio Boundary',
        slug: 'studio-boundary',
        hostingMode: 'cloud',
        templateId: 'tech-studio',
        themeId: 'givre',
        soundPackId: 'givre',
        enabledConnectors: ['github-webhook'],
        customization: {
          includeAudioChannels: true,
          includeCollections: true,
          includeStarterDocs: true,
          excludedChannelKeys: ['releases', 'releases'],
          additionalChannels: [
            { categoryKey: 'voice', name: 'Design Sync!', kind: 'audio' },
            { categoryKey: 'engineering', name: 'x'.repeat(40), kind: 'text' },
          ],
        },
      },
      {
        post: async (_path, init) => {
          capturedBodies.push(init.body)
          return {
            response: { status: 201 },
            data: {
              workspaceId: 'ws-norm-1',
              workspaceUrl: 'https://studio-boundary.kodera.io',
              invitationUrl: 'https://studio-boundary.kodera.io/invite?signed=1',
              channels: [{ id: 'ch-1', name: 'general', kind: 'text' }],
              enabledConnectors: ['github-webhook'],
            },
          }
        },
      }
    )

    expect(capturedBodies).toEqual([
      expect.objectContaining({
        customization: {
          includeAudioChannels: true,
          includeCollections: true,
          includeStarterDocs: true,
          excludedChannelKeys: ['releases'],
          additionalChannels: [
            { categoryKey: 'voice', name: 'design-sync', kind: 'audio' },
            { categoryKey: 'engineering', name: 'x'.repeat(32), kind: 'text' },
          ],
        },
      }),
    ])
    expect(claimed.payload.customization?.additionalChannels).toEqual([
      { categoryKey: 'voice', name: 'design-sync', kind: 'audio' },
      { categoryKey: 'engineering', name: 'x'.repeat(32), kind: 'text' },
    ])

    // localClaim rejects unexpected keys, derived-key collisions, and soft hyphen (\u00ad) identically to cloud
    const baseLocalPayload = {
      organizationName: 'Studio Local',
      slug: 'studio-local',
      hostingMode: 'self-host' as const,
      templateId: 'tech-studio' as const,
      themeId: 'givre' as const,
      soundPackId: 'givre' as const,
      enabledConnectors: [],
    }

    expect(() =>
      localClaim({
        ...baseLocalPayload,
        customization: {
          includeAudioChannels: true,
          includeCollections: true,
          includeStarterDocs: true,
          unexpectedFlag: true,
        } as unknown as InstantClaimPayload['customization'],
      })
    ).toThrow(InstantClaimError)

    expect(() =>
      localClaim({
        ...baseLocalPayload,
        customization: {
          includeAudioChannels: true,
          includeCollections: true,
          includeStarterDocs: true,
          additionalChannels: [
            { categoryKey: 'engineering', name: 'Design Sync!', kind: 'text' },
            { categoryKey: 'engineering', name: 'design--sync', kind: 'text' },
          ],
        },
      })
    ).toThrow(InstantClaimError)

    expect(() =>
      localClaim({
        ...baseLocalPayload,
        customization: {
          includeAudioChannels: true,
          includeCollections: true,
          includeStarterDocs: true,
          additionalChannels: [
            { categoryKey: 'engineering', name: 'design\u00adsync', kind: 'text' },
          ],
        },
      })
    ).toThrow(InstantClaimError)
  })
})

describe('FirstRunOnboardingModal 6-persona customizer', () => {
  it('syncs interactive persona cards with the combobox across all 6 personas in preview mode', async () => {
    const user = userEvent.setup()
    render(
      <FirstRunOnboardingModal
        open
        claimMode="preview"
        isDarkTheme={false}
        onSelectTheme={() => {}}
        onComplete={() => {}}
        onDismiss={() => {}}
      />
    )
    const modal = screen.getByRole('dialog')
    await user.type(within(modal).getByRole('textbox', { name: 'Nom de l’espace' }), 'Atelier Six')
    await user.click(within(modal).getByRole('button', { name: 'Continuer' }))

    const combobox = within(modal).getByRole('combobox')
    const personaGroup = within(modal).getByRole('group', { name: 'Profils d’organisation' })

    for (const [templateId, selection] of [
      ['tech-studio', 'studio-tech'],
      ['b2b-advisory', 'conseil-b2b'],
      ['association-coop', 'association-coop'],
      ['open-source-community', 'open-source'],
      ['public-sector', 'secteur-public'],
      ['blank', 'blank'],
    ] as const) {
      const card = personaGroup.querySelector<HTMLButtonElement>(
        `[data-persona-card="${templateId}"]`
      )!
      expect(card).not.toBeNull()
      expect(card).toHaveTextContent('< 45 s')
      await user.click(card)
      expect(card).toHaveAttribute('aria-pressed', 'true')
      expect(combobox).toHaveValue(selection)
      expect(within(modal).getAllByRole('listitem')).toHaveLength(
        TEMPLATE_CHANNELS[templateId].length
      )
    }

    // Selecting via combobox syncs back to the persona card and renders foyer as audio
    await user.selectOptions(combobox, 'association-coop')
    const coopCard = personaGroup.querySelector<HTMLButtonElement>(
      '[data-persona-card="association-coop"]'
    )!
    expect(coopCard).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(modal)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toContain('🔊 foyer')
  })

  it('customizes starter channels, protects the last true text channel even with audio enabled, rejects non-ASCII-alphanumeric names, and sends validated payload on finish', async () => {
    const user = userEvent.setup()
    const onClaimed = vi.fn()
    post.mockResolvedValue({
      response: { status: 201 },
      data: {
        workspaceId: 'ws-custom-1',
        workspaceUrl: 'https://product-team.kodera.io',
        invitationUrl: 'https://product-team.kodera.io/invite?signed=ok',
        channels: [
          { id: 'ch-1', name: 'general', kind: 'text' },
          { id: 'ch-2', name: 'incidents', kind: 'text' },
          { id: 'ch-3', name: 'standup', kind: 'audio' },
          { id: 'ch-4', name: 'pairing', kind: 'audio' },
          { id: 'ch-5', name: 'design-sync', kind: 'audio' },
        ],
        enabledConnectors: ['github-webhook', 'calcom-booking-sync'],
      },
    })

    render(
      <FirstRunOnboardingModal
        open
        claimMode="cloud"
        isDarkTheme={false}
        onSelectTheme={() => {}}
        onClaimed={onClaimed}
        onComplete={() => {}}
        onDismiss={() => {}}
      />
    )
    const modal = screen.getByRole('dialog')
    await user.type(within(modal).getByRole('textbox', { name: 'Nom de l’espace' }), 'Product Team')
    await user.click(within(modal).getByRole('button', { name: 'Continuer' }))

    // Select tech-studio via its persona card
    const personaGroup = within(modal).getByRole('group', { name: 'Profils d’organisation' })
    await user.click(personaGroup.querySelector('[data-persona-card="tech-studio"]')!)

    // Default starter channels match Core templates.py 1:1
    expect(
      within(modal)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['#general', '#releases', '#incidents', '🔊 standup', '🔊 pairing'])

    // Toggle off 'releases' and 'incidents'; 'general' is now the last text channel and must stay enabled even though 2 audio channels are active
    const channelChips = within(modal).getByRole('group', { name: 'Salons de départ' })
    await user.click(channelChips.querySelector('[data-channel-chip="releases"]')!)
    await user.click(channelChips.querySelector('[data-channel-chip="incidents"]')!)
    await user.click(channelChips.querySelector('[data-channel-chip="general"]')!)
    expect(channelChips.querySelector('[data-channel-chip="general"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    // Re-enable 'incidents'
    await user.click(channelChips.querySelector('[data-channel-chip="incidents"]')!)

    // Reject custom channel names with zero ASCII [A-Za-z0-9] ("ø", fullwidth "Ａ")
    const customInput = within(modal).getByRole('textbox', { name: 'Salon personnalisé' })
    const addBtn = within(modal).getByRole('button', { name: 'Ajouter' })
    await user.type(customInput, 'ø')
    expect(addBtn).toBeDisabled()
    await user.clear(customInput)
    await user.type(customInput, 'Ａ')
    expect(addBtn).toBeDisabled()
    await user.clear(customInput)

    // Add a custom audio channel 'Design Sync!' and verify derived key collision ('design--sync') is blocked
    await user.click(within(modal).getByRole('button', { name: /Vocal/ }))
    await user.type(customInput, 'Design Sync!')
    expect(addBtn).not.toBeDisabled()
    await user.click(addBtn)

    await user.type(customInput, 'design--sync')
    expect(addBtn).toBeDisabled()
    await user.clear(customInput)

    expect(
      within(modal)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['#general', '#incidents', '🔊 standup', '🔊 pairing', '🔊 design-sync'])

    // Customize connectors: disable linear-sync & sentry-alerts, enable calcom-booking-sync
    const connectorGroup = within(modal).getByRole('group', { name: 'Connecteurs du template' })
    await user.click(connectorGroup.querySelector('[data-connector-chip="linear-sync"]')!)
    await user.click(connectorGroup.querySelector('[data-connector-chip="sentry-alerts"]')!)
    await user.click(connectorGroup.querySelector('[data-connector-chip="calcom-booking-sync"]')!)

    // Proceed to Step 2 and finish
    await user.click(within(modal).getByRole('button', { name: 'Continuer' }))
    await user.click(within(modal).getByRole('button', { name: 'Ouvrir l’espace' }))

    expect(await screen.findByText('Espace Cloud attribué')).toBeInTheDocument()
    expect(post).toHaveBeenCalledWith(
      '/workspaces/instant-claim',
      expect.objectContaining({
        body: expect.objectContaining({
          slug: 'product-team',
          templateId: 'tech-studio',
          enabledConnectors: ['github-webhook', 'calcom-booking-sync'],
          customization: {
            includeAudioChannels: true,
            includeCollections: true,
            includeStarterDocs: true,
            excludedChannelKeys: ['releases'],
            additionalChannels: [
              {
                categoryKey: 'voice',
                name: 'design-sync',
                kind: 'audio',
              },
            ],
          },
        }),
      })
    )
    expect(onClaimed).toHaveBeenCalledTimes(1)
  })

  it('applies custom starter channel exclusions and digit-leading additions in localClaim preview mode', async () => {
    const user = userEvent.setup()
    const onClaimed = vi.fn()
    render(
      <FirstRunOnboardingModal
        open
        claimMode="preview"
        isDarkTheme={false}
        onSelectTheme={() => {}}
        onClaimed={onClaimed}
        onComplete={() => {}}
        onDismiss={() => {}}
      />
    )
    const modal = screen.getByRole('dialog')
    await user.type(within(modal).getByRole('textbox', { name: 'Nom de l’espace' }), 'Blank Team')
    await user.click(within(modal).getByRole('button', { name: 'Continuer' }))

    const personaGroup = within(modal).getByRole('group', { name: 'Profils d’organisation' })
    await user.click(personaGroup.querySelector('[data-persona-card="blank"]')!)

    await user.type(
      within(modal).getByRole('textbox', { name: 'Salon personnalisé' }),
      '99z-roadmap'
    )
    await user.click(within(modal).getByRole('button', { name: 'Ajouter' }))
    expect(
      within(modal)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['#general', '#c-99z-roadmap'])

    await user.click(within(modal).getByRole('button', { name: 'Continuer' }))
    await user.click(within(modal).getByRole('button', { name: 'Ouvrir l’espace' }))

    expect(onClaimed).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'local',
        channels: [
          { id: 'local-general', name: 'general', kind: 'text' },
          { id: 'local-c-99z-roadmap', name: 'c-99z-roadmap', kind: 'text' },
        ],
      })
    )
  })
})

describe('OnboardingActivationChecklist & onboardingState per-org persistence', () => {
  it('persists activation tasks and dismissal per org under kodera.onboarding.activation.v1.<org>', () => {
    expect(activationChecklistStorageKey('Cinema-One')).toBe(
      `${ACTIVATION_STORAGE_PREFIX}cinema-one`
    )
    expect(ACTIVATION_TASK_IDS).toEqual([
      'identity_template',
      'theme_sonic',
      'invite_member',
      'first_message_or_call',
    ])

    expect(readActivationChecklist('cinema-one')).toEqual({
      org: 'cinema-one',
      completed: [],
      dismissed: false,
    })

    expect(completeActivationTask('cinema-one', 'identity_template').completed).toEqual([
      'identity_template',
    ])
    expect(completeActivationTask('cinema-one', 'theme_sonic').completed).toEqual([
      'identity_template',
      'theme_sonic',
    ])
    // Other org remains untouched
    expect(readActivationChecklist('other-org').completed).toEqual([])

    const dismissed = dismissActivationChecklist('cinema-one')
    expect(dismissed.dismissed).toBe(true)
    expect(dismissed.completed).toEqual(['identity_template', 'theme_sonic'])
    expect(readActivationChecklist('other-org').dismissed).toBe(false)
  })

  it('keeps post-claim progress honest (never completing first_message_or_call on Open workspace), verifies clipboard write before completing invite_member, and completes first_message_or_call only on confirmed action', async () => {
    const user = userEvent.setup()
    const writeText = vi
      .fn<(_text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Clipboard blocked'))
      .mockResolvedValueOnce(undefined)
    const onFirstMessageOrCall = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    try {
      const workspace = {
        ...localClaim({
          organizationName: 'Studio Alpha',
          slug: 'studio-alpha',
          hostingMode: 'cloud',
          templateId: 'tech-studio',
          themeId: 'givre',
          soundPackId: 'givre',
          enabledConnectors: ['github-webhook'],
        }),
        mode: 'cloud' as const,
        workspaceUrl: 'https://studio-alpha.kodera.io',
        invitationUrl: 'https://studio-alpha.kodera.io/invite?signed=token',
      }

      // Without onFirstMessageOrCall (post-claim modal summary), Open workspace never fakes 4 / 4
      const view = render(<ClaimWorkspaceSummary workspace={workspace} />)

      const checklist = screen.getByTestId('onboarding-activation-checklist')
      expect(screen.getByTestId('onboarding-activation-progress')).toHaveTextContent('2 / 4')
      expect(
        within(checklist).getByRole('button', { name: 'Écrire ou lancer un appel' })
      ).toBeDisabled()

      const openLink = screen.getByRole('link', { name: 'Ouvrir l’espace' })
      openLink.addEventListener('click', (event) => event.preventDefault())
      await user.click(openLink)
      expect(screen.getByTestId('onboarding-activation-progress')).toHaveTextContent('2 / 4')

      // First invite click: clipboard rejects -> stays at 2 / 4
      await user.click(within(checklist).getByRole('button', { name: 'Inviter un membre' }))
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('onboarding-activation-progress')).toHaveTextContent('2 / 4')
      expect(readActivationChecklist('studio-alpha').completed).toEqual([])

      // Second invite click: clipboard resolves -> advances to 3 / 4 (still not 4 / 4!)
      await user.click(within(checklist).getByRole('button', { name: 'Inviter un membre' }))
      expect(writeText).toHaveBeenCalledTimes(2)
      expect(writeText).toHaveBeenLastCalledWith(
        'https://studio-alpha.kodera.io/invite?signed=token'
      )
      expect(screen.getByTestId('onboarding-activation-progress')).toHaveTextContent('3 / 4')

      // When an explicit onFirstMessageOrCall handler is wired, returning false keeps 3 / 4 and returning true advances to 4 / 4
      view.rerender(
        <ClaimWorkspaceSummary workspace={workspace} onFirstMessageOrCall={onFirstMessageOrCall} />
      )
      await user.click(within(checklist).getByRole('button', { name: 'Écrire ou lancer un appel' }))
      expect(onFirstMessageOrCall).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('onboarding-activation-progress')).toHaveTextContent('3 / 4')

      await user.click(within(checklist).getByRole('button', { name: 'Écrire ou lancer un appel' }))
      expect(onFirstMessageOrCall).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('onboarding-activation-progress')).toHaveTextContent('4 / 4')
      expect(readActivationChecklist('studio-alpha').completed).toEqual([...ACTIVATION_TASK_IDS])

      // Dismiss hides checklist and persists per org
      await user.click(
        within(checklist).getByRole('button', { name: 'Masquer le guide de démarrage' })
      )
      expect(screen.queryByTestId('onboarding-activation-checklist')).toBeNull()
      expect(readActivationChecklist('studio-alpha').dismissed).toBe(true)

      // Standalone checklist without handlers disables actionable buttons rather than faking completion
      render(<OnboardingActivationChecklist org="second-org" />)
      const secondChecklist = screen.getByTestId('onboarding-activation-checklist')
      expect(screen.getByTestId('onboarding-activation-progress')).toHaveTextContent('2 / 4')
      expect(
        within(secondChecklist).getByRole('button', { name: 'Inviter un membre' })
      ).toBeDisabled()
      expect(
        within(secondChecklist).getByRole('button', { name: 'Écrire ou lancer un appel' })
      ).toBeDisabled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
