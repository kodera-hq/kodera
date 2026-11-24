import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { MessagingOrganisation } from '../../messaging/organisationContext'
import { MessageRow, type MessageRowProps } from '../MessageRow'
import type { MessageView } from '../matrix/timeline'
import * as aiApi from './aiTranslationApi'
import type * as AiApiModule from './aiTranslationApi'
import { MessageTranslationBlock } from './MessageTranslationBlock'

vi.mock('./aiTranslationApi', async (importOriginal) => {
  const actual = await importOriginal<typeof AiApiModule>()
  return {
    ...actual,
    requestChannelMessageTranslation: vi.fn(),
  }
})

const ORG_ID = '00000000-0000-4000-8000-000000000001'
const CHANNEL_ID = '11111111-1111-4111-8111-111111111111'

const SAMPLE_MESSAGE: MessageView = {
  key: '$evt-101',
  eventId: '$evt-101',
  sender: '@alice:acme.kodera.io',
  senderName: 'Alice Laurent',
  body: 'Déploiement validé pour jeudi matin.',
  ts: 1_700_000_000_000,
  delivery: 'sent',
  edited: false,
  redacted: false,
  replyTo: null,
  reactions: [],
}

function renderRow(overrides: Partial<MessageRowProps> = {}, orgId: string | null = ORG_ID) {
  return render(
    <MessagingOrganisation value={orgId}>
      <MessageRow
        profileRole="member"
        onMention={vi.fn()}
        message={SAMPLE_MESSAGE}
        placement="timeline"
        viewerId="@viewer:acme.kodera.io"
        archived={false}
        expanded={false}
        repliedMessage={undefined}
        threadReplies={[]}
        menuContextKey="ctx-1"
        channelId={CHANNEL_ID}
        allowAiTranslate
        onRetry={vi.fn()}
        onReaction={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onOpenThread={vi.fn()}
        {...overrides}
      />
    </MessagingOrganisation>
  )
}

describe('H3.2 written channel message translation UI', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await i18n.changeLanguage('fr')
  })

  it('translates a channel message ephemerally without mutating the original text, switches language, and hides on toggle', async () => {
    const mockTranslate = vi.mocked(aiApi.requestChannelMessageTranslation)
    mockTranslate
      .mockResolvedValueOnce({
        channelId: CHANNEL_ID,
        eventId: '$evt-101',
        translatedText: 'Deployment validated for Thursday morning.',
        targetLanguage: 'fr',
        sourceLanguage: 'auto',
        provider: 'mistral',
        model: 'mistral-small-latest',
        ephemeral: true,
      })
      .mockResolvedValueOnce({
        channelId: CHANNEL_ID,
        eventId: '$evt-101',
        translatedText: 'Bereitstellung für Donnerstagmorgen bestätigt.',
        targetLanguage: 'de',
        sourceLanguage: 'auto',
        provider: 'mistral',
        model: 'mistral-small-latest',
        ephemeral: true,
      })

    const user = userEvent.setup()
    const { container } = renderRow()

    // Open message menu and trigger "Traduire"
    await user.click(screen.getByRole('button', { name: /actions/iu }))
    const translateItem = await screen.findByRole('menuitem', { name: 'Traduire' })
    await user.click(translateItem)

    expect(await screen.findByTestId('message-translation-text')).toHaveTextContent(
      'Deployment validated for Thursday morning.'
    )
    // Original Matrix message body remains 100% untouched
    expect(screen.getByText('Déploiement validé pour jeudi matin.')).toBeInTheDocument()
    expect(container.querySelector('[style]')).toBeNull()

    // Switch target language to German (de)
    const select = screen.getByTestId('message-translation-language')
    await user.selectOptions(select, 'de')

    await waitFor(() => {
      expect(screen.getByTestId('message-translation-text')).toHaveTextContent(
        'Bereitstellung für Donnerstagmorgen bestätigt.'
      )
    })
    expect(mockTranslate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        organisationId: ORG_ID,
        channelId: CHANNEL_ID,
        text: 'Déploiement validé pour jeudi matin.',
        targetLanguage: 'de',
        eventId: '$evt-101',
      })
    )

    // Clicking "Traduit via IA souveraine · Masquer" hides the ephemeral card cleanly
    const hideToggle = screen.getByRole('button', {
      name: 'Traduit via IA souveraine · Masquer',
    })
    await user.click(hideToggle)
    expect(screen.queryByTestId('message-translation-block')).toBeNull()
    expect(screen.getByText('Déploiement validé pour jeudi matin.')).toBeInTheDocument()
  })

  it('hides the Translate action on confidential/E2EE rooms and on redacted messages', async () => {
    const user = userEvent.setup()

    // 1) Confidential / E2EE room (`allowAiTranslate={false}`)
    const { unmount } = renderRow({ allowAiTranslate: false })
    await user.click(screen.getByRole('button', { name: /actions/iu }))
    expect(screen.queryByRole('menuitem', { name: 'Traduire' })).toBeNull()
    unmount()

    // 2) Redacted message (`redacted: true`) suppresses message actions & Translate
    renderRow({
      allowAiTranslate: true,
      message: { ...SAMPLE_MESSAGE, redacted: true, body: '' },
    })
    expect(screen.queryByRole('button', { name: /actions/iu })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Traduire' })).toBeNull()
    expect(screen.queryByTestId('message-translation-block')).toBeNull()
  })

  it('surfaces 403 policy refusal and 429 budget exhaustion notices cleanly', async () => {
    const mockTranslate = vi.mocked(aiApi.requestChannelMessageTranslation)
    mockTranslate.mockRejectedValueOnce(
      new aiApi.ApiProblem({
        type: 'https://kodera.io/problems/forbidden',
        status: 403,
        title: 'Workspace AI request refused',
      })
    )

    const { unmount } = render(
      <MessageTranslationBlock
        organisationId={ORG_ID}
        channelId={CHANNEL_ID}
        eventId="$evt-403"
        sourceText="Texte confidentiel"
      />
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/Traduction refusée/u)
    unmount()

    mockTranslate.mockRejectedValueOnce(
      new aiApi.ApiProblem({
        type: 'https://kodera.io/problems/rate-limited',
        status: 429,
        title: 'Workspace AI request refused',
      })
    )
    render(
      <MessageTranslationBlock
        organisationId={ORG_ID}
        channelId={CHANNEL_ID}
        eventId="$evt-429"
        sourceText="Bonjour"
      />
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/Budget mensuel IA atteint/u)
  })
})
