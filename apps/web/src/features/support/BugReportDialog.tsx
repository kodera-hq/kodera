import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../api/client'
import type { components } from '../../api/schema'
import { Button } from '../../ui/Button/Button'
import { Checkbox } from '../../ui/Checkbox/Checkbox'
import { Dialog } from '../../ui/Dialog/Dialog'
import { FieldError } from '../../ui/FieldError/FieldError'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { submitBugReport } from './bugReportClient'
import { bugReportCopy } from './bugReportMessages'
import {
  BUG_COMPONENTS,
  blurScreenshotFile,
  buildOutgoingBugReportPayload,
  detectBuildId,
  detectDeviceClass,
  inspectBugReportNote,
  isValidBuildId,
  isValidErrorCode,
  MAX_BUG_NOTE_LENGTH,
  revokeScreenshotPreview,
} from './bugReportScrubber'
import type {
  BlurredScreenshotAttachment,
  BugComponent,
  BugDeviceClass,
} from './bugReportScrubber'

export interface BugReportLifetimeGuard {
  hasUsableCredential(): boolean
  getRetirementStamp(): object
}

export interface BugReportDialogProps {
  organisationId: string
  organisationSlug?: string | undefined
  tenantSlug?: string | undefined
  defaultComponent?: BugComponent | undefined
  defaultErrorCode?: string | undefined
  buildId?: string | undefined
  deviceClass?: BugDeviceClass | undefined
  lifetime?: BugReportLifetimeGuard | undefined
  blurScreenshot?: ((file: Blob) => Promise<BlurredScreenshotAttachment>) | undefined
  container?: HTMLElement | null | undefined
}

export function BugReportDialog({
  organisationId,
  organisationSlug,
  tenantSlug,
  defaultComponent = 'workspace',
  defaultErrorCode = 'UI_REPORTED_ISSUE',
  buildId: buildIdProp,
  deviceClass: deviceClassProp,
  lifetime,
  blurScreenshot = blurScreenshotFile,
  container,
}: BugReportDialogProps) {
  const { i18n } = useTranslation()
  const copy = bugReportCopy(i18n.resolvedLanguage)
  const baseId = useId()
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const resolvedBuildId = useMemo(() => detectBuildId(buildIdProp), [buildIdProp])
  const resolvedDeviceClass = useMemo(
    () => deviceClassProp ?? detectDeviceClass(),
    [deviceClassProp]
  )

  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const [component, setComponent] = useState<BugComponent>(defaultComponent)
  const [errorCode, setErrorCode] = useState<string>(defaultErrorCode)
  const [rawNote, setRawNote] = useState('')
  const [attachment, setAttachment] = useState<BlurredScreenshotAttachment | undefined>(undefined)
  const attachmentRef = useRef<BlurredScreenshotAttachment | undefined>(undefined)
  const [screenshotError, setScreenshotError] = useState(false)
  const [consent, setConsent] = useState(false)
  const [pending, setPending] = useState(false)
  const [submitError, setSubmitError] = useState<'generic' | 'limited' | 'unavailable' | undefined>(
    undefined
  )
  const [receipt, setReceipt] = useState<components['schemas']['BugReportReceipt'] | undefined>(
    undefined
  )

  const updateAttachment = (next: BlurredScreenshotAttachment | undefined) => {
    const previous = attachmentRef.current
    if (previous !== undefined && previous.previewObjectUrl !== next?.previewObjectUrl) {
      revokeScreenshotPreview(previous)
    }
    attachmentRef.current = next
    setAttachment(next)
  }

  useEffect(() => {
    return () => {
      revokeScreenshotPreview(attachmentRef.current)
      attachmentRef.current = undefined
    }
  }, [])

  const fileInputRef = useRef<HTMLInputElement>(null)
  const retryRef = useRef<{ serialized: string; key: string } | undefined>(undefined)

  const noteInspection = useMemo(
    () => inspectBugReportNote(rawNote, { organisationSlug, tenantSlug }),
    [rawNote, organisationSlug, tenantSlug]
  )

  const requiresConsent = noteInspection.sanitizedNote !== '' || attachment !== undefined
  const effectiveConsent = requiresConsent ? consent : false

  const outgoingPayload = useMemo(
    () =>
      buildOutgoingBugReportPayload({
        buildId: resolvedBuildId,
        component,
        errorCode: errorCode.trim(),
        deviceClass: resolvedDeviceClass,
        consent: effectiveConsent,
        sanitizedNote: noteInspection.sanitizedNote,
        attachment,
      }),
    [
      resolvedBuildId,
      component,
      errorCode,
      resolvedDeviceClass,
      effectiveConsent,
      noteInspection.sanitizedNote,
      attachment,
    ]
  )

  const exactJsonPreview = useMemo(
    () => JSON.stringify(outgoingPayload, null, 2),
    [outgoingPayload]
  )

  const validCode = isValidErrorCode(errorCode.trim(), { organisationSlug, tenantSlug })
  const validBuild = isValidBuildId(resolvedBuildId, { organisationSlug, tenantSlug })
  const canSubmit =
    !pending &&
    validBuild &&
    validCode &&
    noteInspection.blockedReasons.length === 0 &&
    !noteInspection.exceedsMaxLength &&
    (!requiresConsent || consent)

  const fallbackStampRef = useRef<object>({})
  const captureStamp = () =>
    lifetime !== undefined ? lifetime.getRetirementStamp() : fallbackStampRef.current
  const isCurrentSession = (stamp: object) =>
    mountedRef.current &&
    (lifetime === undefined ||
      (lifetime.hasUsableCredential() && lifetime.getRetirementStamp() === stamp))

  function handleOpenChange(nextOpen: boolean) {
    openRef.current = nextOpen
    setOpen(nextOpen)
    updateAttachment(undefined)
    if (nextOpen) {
      setComponent(defaultComponent)
      setErrorCode(defaultErrorCode)
      setRawNote('')
      setScreenshotError(false)
      setConsent(false)
      setSubmitError(undefined)
      setReceipt(undefined)
      retryRef.current = undefined
    }
  }

  async function handleScreenshotChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setScreenshotError(false)
    setConsent(false)
    try {
      const blurred = await blurScreenshot(file)
      if (!mountedRef.current || !openRef.current) {
        revokeScreenshotPreview(blurred)
        return
      }
      updateAttachment(blurred)
    } catch {
      if (mountedRef.current) {
        updateAttachment(undefined)
        setScreenshotError(true)
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function handleRemoveScreenshot() {
    updateAttachment(undefined)
    setScreenshotError(false)
    if (noteInspection.sanitizedNote === '') {
      setConsent(false)
    }
  }

  async function handleSubmit() {
    if (!canSubmit) return
    const stamp = captureStamp()
    const serialized = JSON.stringify(outgoingPayload)
    if (retryRef.current?.serialized !== serialized) {
      retryRef.current = { serialized, key: crypto.randomUUID() }
    }
    setPending(true)
    setSubmitError(undefined)
    try {
      const result = await submitBugReport(organisationId, outgoingPayload, retryRef.current.key)
      if (isCurrentSession(stamp)) {
        setReceipt(result)
        setRawNote('')
        updateAttachment(undefined)
        setConsent(false)
        retryRef.current = undefined
      }
    } catch (failure) {
      if (isCurrentSession(stamp)) {
        if (failure instanceof ApiProblem && failure.status === 429) {
          setSubmitError('limited')
        } else if (failure instanceof ApiProblem && failure.status === 503) {
          setSubmitError('unavailable')
        } else {
          setSubmitError('generic')
        }
      }
    } finally {
      if (isCurrentSession(stamp)) {
        setPending(false)
      }
    }
  }

  const componentId = `${baseId}-component`
  const errorCodeId = `${baseId}-error-code`
  const noteId = `${baseId}-note`
  const screenshotId = `${baseId}-screenshot`
  const consentId = `${baseId}-consent`

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      size="lg"
      title={copy.title}
      description={copy.description}
      closeLabel={copy.close}
      {...(container === undefined ? {} : { container })}
      trigger={
        <Button variant="secondary" size="sm" className="self-start">
          {copy.trigger}
        </Button>
      }
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={() => handleOpenChange(false)}>
            {copy.cancel}
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {pending ? copy.submitting : copy.submit}
          </Button>
        </>
      }
    >
      <div className="max-h-[calc(80vh-160px)] overflow-y-auto pr-1">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-3">
            <label htmlFor={componentId} className="flex flex-col gap-1 text-sm font-medium text-c-ink">
              {copy.componentLabel}
              <select
                id={componentId}
                value={component}
                disabled={pending}
                onChange={(event) => setComponent(event.target.value as BugComponent)}
                className="h-10 rounded-sm border border-c-border-input bg-c-surface px-3 text-sm text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              >
                {BUG_COMPONENTS.map((item) => (
                  <option key={item} value={item}>
                    {copy.components[item]}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-col gap-1">
              <label htmlFor={errorCodeId} className="text-sm font-medium text-c-ink">
                {copy.errorCodeLabel}
              </label>
              <input
                id={errorCodeId}
                type="text"
                value={errorCode}
                maxLength={80}
                disabled={pending}
                aria-invalid={validCode ? undefined : true}
                onChange={(event) => setErrorCode(event.target.value)}
                className="h-10 rounded-sm border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
              {validCode ? null : <FieldError>{copy.errorCodeInvalid}</FieldError>}
            </div>
          </div>

          <div className="flex flex-wrap gap-4 rounded-md bg-c-sunken p-3 text-xs text-c-ink-2">
            <span>
              {copy.buildLabel}: <code className="font-mono text-c-ink">{resolvedBuildId}</code>
            </span>
            <span>
              {copy.deviceLabel}:{' '}
              <code className="font-mono text-c-ink">{resolvedDeviceClass}</code>
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={noteId} className="text-sm font-medium text-c-ink">
              {copy.noteLabel}
            </label>
            <textarea
              id={noteId}
              rows={3}
              maxLength={MAX_BUG_NOTE_LENGTH}
              value={rawNote}
              disabled={pending}
              placeholder={copy.notePlaceholder}
              onChange={(event) => {
                setRawNote(event.target.value)
                if (event.target.value.trim() === '' && attachment === undefined) {
                  setConsent(false)
                }
              }}
              className="rounded-sm border border-c-border-input bg-c-surface p-3 text-sm text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
            />
            <p className="text-xs text-c-ink-3">{copy.noteScrubbedHint}</p>
            {noteInspection.exceedsMaxLength ? <FieldError>{copy.noteTooLong}</FieldError> : null}
          </div>

          {noteInspection.blockedReasons.length > 0 ? (
            <InlineAlert kind="error">
              {`${copy.refusalPrefix} ${noteInspection.blockedReasons
                .map((reason) => copy.refusalReasons[reason])
                .join(', ')}.`}
            </InlineAlert>
          ) : null}

          <div className="flex flex-col gap-2">
            <label htmlFor={screenshotId} className="text-sm font-medium text-c-ink">
              {copy.screenshotLabel}
            </label>
            <input
              ref={fileInputRef}
              id={screenshotId}
              type="file"
              accept="image/png,image/webp,image/jpeg"
              disabled={pending}
              onChange={(event) => void handleScreenshotChange(event)}
              className="text-xs text-c-ink-2 file:mr-3 file:rounded-sm file:border file:border-c-border file:bg-c-surface file:px-3 file:py-1 file:text-xs file:font-medium file:text-c-ink"
            />
            {screenshotError ? <InlineAlert kind="error">{copy.screenshotError}</InlineAlert> : null}
            {attachment ? (
              <div className="flex flex-col gap-2 rounded-md border border-c-border bg-c-sunken p-3">
                <img
                  src={attachment.previewObjectUrl}
                  alt={copy.screenshotPreviewAlt}
                  className="max-h-[160px] w-auto self-start rounded-sm border border-c-border"
                />
                <Button
                  variant="tertiary"
                  size="sm"
                  className="self-start"
                  disabled={pending}
                  onClick={handleRemoveScreenshot}
                >
                  {copy.screenshotRemove}
                </Button>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold text-c-ink-2">{copy.payloadPreviewTitle}</h3>
            <pre
              data-testid="bug-report-json-preview"
              className="max-h-[180px] overflow-auto rounded-md border border-c-border bg-c-sunken p-3 font-mono text-xs whitespace-pre-wrap break-all text-c-ink"
            >
              {exactJsonPreview}
            </pre>
          </div>

          <Checkbox
            id={consentId}
            checked={consent}
            disabled={pending || !requiresConsent}
            label={copy.consentLabel}
            help={copy.consentHelp}
            onCheckedChange={(checked) => setConsent(checked === true)}
          />

          {submitError ? (
            <InlineAlert kind="error">
              {submitError === 'limited'
                ? copy.errorRateLimited
                : submitError === 'unavailable'
                  ? copy.errorUnavailable
                  : copy.errorGeneric}
            </InlineAlert>
          ) : null}

          {receipt ? (
            <div role="status" className="flex flex-col gap-1 rounded-md bg-c-sunken p-3 text-xs text-c-ink">
              <p className="font-semibold">{copy.receiptTitle}</p>
              <p>{receipt.status === 'deduplicated' ? copy.receiptDeduplicated : copy.receiptQueued}</p>
              <p className="font-mono">
                {copy.receiptId}: {receipt.id}
              </p>
              <p className="font-mono break-all">
                {copy.receiptFingerprint}: {receipt.dedup_fingerprint}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}
