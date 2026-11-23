import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { ApiProblem } from '../../api/client'
import { BugReportDialog } from './BugReportDialog'
import { submitBugReport } from './bugReportClient'
import type { BlurredScreenshotAttachment } from './bugReportScrubber'

vi.mock('./bugReportClient', () => ({
  submitBugReport: vi.fn(),
}))

const SAMPLE_RECEIPT = {
  id: '22222222-3333-4444-8555-666666666666',
  status: 'queued' as const,
  dedup_fingerprint: 'a'.repeat(64),
  occurrences: 1,
  created_at: '2026-11-23T00:00:00Z',
}

const SAMPLE_BLURRED_FIRST: BlurredScreenshotAttachment = {
  contentType: 'image/webp',
  blurred: true,
  dataBase64: 'UklGRhQAAABXRUJQVlA4IAgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/vuUAAA=',
  previewObjectUrl: 'blob:https://console.kodera.example/preview-first',
  byteLength: 44,
}

const SAMPLE_BLURRED_SECOND: BlurredScreenshotAttachment = {
  contentType: 'image/webp',
  blurred: true,
  dataBase64: 'UklGRhQAAABXRUJQVlA4IAgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/vuUAAA=',
  previewObjectUrl: 'blob:https://console.kodera.example/preview-second',
  byteLength: 44,
}

beforeEach(async () => {
  vi.mocked(submitBugReport).mockReset().mockResolvedValue(SAMPLE_RECEIPT)
  await i18n.changeLanguage('en')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BugReportDialog', () => {
  it('pre-fills allowlisted fields, previews exact outgoing JSON, and submits metadata-only without consent', async () => {
    const user = userEvent.setup()
    render(
      <BugReportDialog
        organisationId="11111111-2222-4333-8444-555555555555"
        organisationSlug="acme-corp"
        defaultComponent="calls"
        defaultErrorCode="ICE_CANDIDATE_TIMEOUT"
        buildId="web-0.52.0"
        deviceClass="web-desktop"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Report a technical bug' }))

    const preview = screen.getByTestId('bug-report-json-preview')
    const parsedPreview = JSON.parse(preview.textContent ?? '{}')
    expect(parsedPreview).toEqual({
      build_id: 'web-0.52.0',
      component: 'calls',
      error_code: 'ICE_CANDIDATE_TIMEOUT',
      device_class: 'web-desktop',
      consent: false,
    })

    const consentBox = screen.getByRole('checkbox', {
      name: /I explicitly consent to sending the scrubbed note/,
    })
    expect(consentBox).not.toBeChecked()
    expect(consentBox).toBeDisabled()

    const submitBtn = screen.getByRole('button', { name: 'Send diagnostic report' })
    expect(submitBtn).toBeEnabled()
    await user.click(submitBtn)

    expect(submitBugReport).toHaveBeenCalledWith(
      '11111111-2222-4333-8444-555555555555',
      parsedPreview,
      expect.any(String)
    )
    expect(await screen.findByRole('status')).toHaveTextContent(SAMPLE_RECEIPT.id)
  })

  it('scrubs PII live in the JSON preview and keeps Submit disabled until explicit consent is checked', async () => {
    const user = userEvent.setup()
    render(
      <BugReportDialog
        organisationId="11111111-2222-4333-8444-555555555555"
        organisationSlug="acme-corp"
        tenantSlug="acme-tenant"
        buildId="web-0.52.0"
        deviceClass="web-desktop"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Report a technical bug' }))

    const noteField = screen.getByLabelText('Optional diagnostic note (max 500 characters)')
    await user.type(
      noteField,
      'Freeze for alice@acme.example in @alice:matrix.example on acme-corp / acme-tenant'
    )

    const submitBtn = screen.getByRole('button', { name: 'Send diagnostic report' })
    const consentBox = screen.getByRole('checkbox', {
      name: /I explicitly consent to sending the scrubbed note/,
    })
    expect(consentBox).not.toBeChecked()
    expect(consentBox).toBeEnabled()
    expect(submitBtn).toBeDisabled()

    const previewBeforeConsent = JSON.parse(
      screen.getByTestId('bug-report-json-preview').textContent ?? '{}'
    )
    expect(previewBeforeConsent.note).toBe(
      'Freeze for [REDACTED_EMAIL] in [REDACTED_MATRIX_ID] on [REDACTED_ORG] / [REDACTED_TENANT]'
    )
    expect(previewBeforeConsent.consent).toBe(false)

    await user.click(consentBox)
    expect(consentBox).toBeChecked()
    expect(submitBtn).toBeEnabled()

    const previewAfterConsent = JSON.parse(
      screen.getByTestId('bug-report-json-preview').textContent ?? '{}'
    )
    expect(previewAfterConsent.consent).toBe(true)

    await user.click(submitBtn)
    expect(submitBugReport).toHaveBeenCalledWith(
      '11111111-2222-4333-8444-555555555555',
      previewAfterConsent,
      expect.any(String)
    )
  })

  it('blocks submission even with consent when note or error_code contains credentials or URLs', async () => {
    const user = userEvent.setup()
    render(
      <BugReportDialog
        organisationId="11111111-2222-4333-8444-555555555555"
        organisationSlug="acme-corp"
        buildId="web-0.52.0"
        deviceClass="web-desktop"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Report a technical bug' }))

    const errorField = screen.getByLabelText('Diagnostic error code')
    await user.clear(errorField)
    await user.type(errorField, 'ERR_12025550142')
    expect(screen.getByRole('button', { name: 'Send diagnostic report' })).toBeDisabled()

    await user.clear(errorField)
    await user.type(errorField, 'UI_REPORTED_ISSUE')
    expect(screen.getByRole('button', { name: 'Send diagnostic report' })).toBeEnabled()

    const noteField = screen.getByLabelText('Optional diagnostic note (max 500 characters)')
    await user.type(
      noteField,
      ['Failed with access_token=', 'syt_', 'YWxpY2U_sample and //evil.example/exfil'].join('')
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      /API key or secret token.*URL or deep link/
    )

    const consentBox = screen.getByRole('checkbox', {
      name: /I explicitly consent to sending the scrubbed note/,
    })
    await user.click(consentBox)
    expect(screen.getByRole('button', { name: 'Send diagnostic report' })).toBeDisabled()
  })

  it('uses a revocable blob: preview URL and revokes it on replace, remove, close, submit, and unmount', async () => {
    const user = userEvent.setup()
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const blurMock = vi
      .fn()
      .mockResolvedValueOnce(SAMPLE_BLURRED_FIRST)
      .mockResolvedValueOnce(SAMPLE_BLURRED_SECOND)
      .mockResolvedValueOnce(SAMPLE_BLURRED_FIRST)
      .mockResolvedValueOnce(SAMPLE_BLURRED_SECOND)

    const { unmount } = render(
      <BugReportDialog
        organisationId="11111111-2222-4333-8444-555555555555"
        buildId="web-0.52.0"
        deviceClass="web-desktop"
        blurScreenshot={blurMock}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Report a technical bug' }))

    const fileInput = screen.getByLabelText(/Optional blurred screenshot/)
    const rawFile = new File([new Uint8Array([1, 2, 3, 4])], 'capture.png', { type: 'image/png' })
    await user.upload(fileInput, rawFile)

    await waitFor(() => expect(blurMock).toHaveBeenCalledTimes(1))
    const previewImg = screen.getByAltText('Blurred diagnostic screenshot preview')
    expect(previewImg).toHaveAttribute('src', SAMPLE_BLURRED_FIRST.previewObjectUrl)
    expect(previewImg.getAttribute('src')?.startsWith('blob:')).toBe(true)

    // 1. Replacing screenshot revokes the first blob: URL.
    await user.upload(fileInput, rawFile)
    await waitFor(() => expect(blurMock).toHaveBeenCalledTimes(2))
    expect(revokeSpy).toHaveBeenCalledWith(SAMPLE_BLURRED_FIRST.previewObjectUrl)
    expect(screen.getByAltText('Blurred diagnostic screenshot preview')).toHaveAttribute(
      'src',
      SAMPLE_BLURRED_SECOND.previewObjectUrl
    )

    // 2. Removing screenshot revokes the second blob: URL.
    await user.click(screen.getByRole('button', { name: 'Remove screenshot' }))
    expect(revokeSpy).toHaveBeenCalledWith(SAMPLE_BLURRED_SECOND.previewObjectUrl)
    expect(screen.queryByAltText('Blurred diagnostic screenshot preview')).toBeNull()

    // 3. Submitting with screenshot revokes its blob: URL on completion.
    await user.upload(fileInput, rawFile)
    await waitFor(() => expect(blurMock).toHaveBeenCalledTimes(3))
    const consentBox = screen.getByRole('checkbox', {
      name: /I explicitly consent to sending the scrubbed note/,
    })
    await user.click(consentBox)
    await user.click(screen.getByRole('button', { name: 'Send diagnostic report' }))
    await screen.findByRole('status')
    expect(revokeSpy).toHaveBeenCalledTimes(3)

    // 4. Unmounting while an attachment is active revokes the remaining blob: URL.
    await user.upload(fileInput, rawFile)
    await waitFor(() => expect(blurMock).toHaveBeenCalledTimes(4))
    unmount()
    expect(revokeSpy).toHaveBeenCalledTimes(4)
  })

  it('reuses the same Idempotency-Key across unchanged 429 and 503 retries', async () => {
    const user = userEvent.setup()
    vi.mocked(submitBugReport)
      .mockRejectedValueOnce(new ApiProblem({ type: null, status: 429, title: 'Too Many Requests' }))
      .mockRejectedValueOnce(
        new ApiProblem({ type: null, status: 503, title: 'Service Unavailable' })
      )
      .mockResolvedValueOnce({ ...SAMPLE_RECEIPT, status: 'deduplicated', occurrences: 2 })

    render(
      <BugReportDialog
        organisationId="11111111-2222-4333-8444-555555555555"
        buildId="web-0.52.0"
        deviceClass="web-desktop"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Report a technical bug' }))
    const submitBtn = screen.getByRole('button', { name: 'Send diagnostic report' })

    await user.click(submitBtn)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many diagnostic reports were sent recently.'
    )

    await user.click(submitBtn)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The diagnostic triage queue is temporarily full.'
    )

    await user.click(submitBtn)
    expect(await screen.findByRole('status')).toHaveTextContent('occurrence count incremented')

    const calls = vi.mocked(submitBugReport).mock.calls
    expect(calls).toHaveLength(3)
    expect(calls[0]![2]).toBe(calls[1]![2])
    expect(calls[1]![2]).toBe(calls[2]![2])
  })
})
