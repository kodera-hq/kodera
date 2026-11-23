import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/Button/Button'
import { StatusPill } from '@/ui/StatusPill/StatusPill'
import {
  defaultWorkspaceMigratorTransport,
  encodeInlineArchiveBase64,
  validateCoexistenceBridgeDraft,
  type ArchiveValidationErrorCode,
  type BridgeFormErrorCode,
  type CoexistenceBridgeRecord,
  type CoexistenceBridgeSource,
  type WorkspaceImportDryRunReport,
  type WorkspaceImportResponse,
  type WorkspaceImportSource,
  type WorkspaceMigratorTransport,
} from './workspaceMigrator'
import { workspaceMigratorCopy } from './workspaceMigratorMessages'

export interface MigratorChannelOption {
  readonly id: string
  readonly label: string
  readonly isConfidential?: boolean | undefined
}

export interface WorkspaceMigratorPanelProps {
  readonly organisationId?: string | undefined
  readonly channels?: readonly MigratorChannelOption[] | undefined
  readonly transport?: WorkspaceMigratorTransport | undefined
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const INPUT_CLASS =
  'h-10 w-full rounded-md border border-c-border-input bg-c-surface px-3 text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden'

const MONO_INPUT_CLASS =
  'h-10 w-full rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden'

export function WorkspaceMigratorPanel({
  organisationId,
  channels = [],
  transport = defaultWorkspaceMigratorTransport,
}: WorkspaceMigratorPanelProps) {
  const { i18n } = useTranslation()
  const copy = workspaceMigratorCopy(i18n.resolvedLanguage)
  const baseId = useId()

  const [activeTab, setActiveTab] = useState<'import' | 'coexistence'>('import')

  // Import simulation & execution state
  const [source, setSource] = useState<WorkspaceImportSource>('slack')
  const [archiveMode, setArchiveMode] = useState<'inline' | 'attachment'>('inline')
  const [selectedArchiveBytes, setSelectedArchiveBytes] = useState<Uint8Array | null>(null)
  const [inlineBase64, setInlineBase64] = useState<string>('')
  const [selectedFileName, setSelectedFileName] = useState<string>('')
  const [attachmentId, setAttachmentId] = useState<string>('')
  const [externalChannelKey, setExternalChannelKey] = useState<string>('general')
  const [mappedChannelId, setMappedChannelId] = useState<string>('')
  const [archiveError, setArchiveError] = useState<ArchiveValidationErrorCode | 'ATTACHMENT' | 'API' | null>(
    null
  )
  const [dryRunReport, setDryRunReport] = useState<WorkspaceImportDryRunReport | null>(null)
  const [executionReport, setExecutionReport] = useState<WorkspaceImportResponse | null>(null)
  const [importBusy, setImportBusy] = useState<boolean>(false)

  // Coexistence bridge state
  const [bridgeSource, setBridgeSource] = useState<CoexistenceBridgeSource>('slack')
  const [bridgeChannelId, setBridgeChannelId] = useState<string>('')
  const [externalWorkspaceId, setExternalWorkspaceId] = useState<string>('')
  const [externalChannelId, setExternalChannelId] = useState<string>('')
  const [outboundEndpoint, setOutboundEndpoint] = useState<string>('')
  const [signingSecret, setSigningSecret] = useState<string>('')
  const [bridgeError, setBridgeError] = useState<BridgeFormErrorCode | 'API' | null>(null)
  const [bridges, setBridges] = useState<readonly CoexistenceBridgeRecord[]>([])
  const [bridgeBusy, setBridgeBusy] = useState<boolean>(false)

  useEffect(() => {
    if (!organisationId || activeTab !== 'coexistence') return
    let cancelled = false
    void (async () => {
      try {
        const list = await transport.listBridges(organisationId)
        if (!cancelled) {
          setBridges(list)
        }
      } catch {
        // Keep empty list until explicit refresh or creation.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [organisationId, activeTab, transport])

  async function handleArchiveFileChange(file: File | undefined) {
    setArchiveError(null)
    setDryRunReport(null)
    setExecutionReport(null)
    if (!file) {
      setSelectedArchiveBytes(null)
      setInlineBase64('')
      setSelectedFileName('')
      return
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    setSelectedArchiveBytes(bytes)
    setSelectedFileName(file.name)
    const encoded = encodeInlineArchiveBase64(bytes, source)
    if (!encoded.ok) {
      setInlineBase64('')
      setArchiveError(encoded.code)
      return
    }
    setInlineBase64(encoded.base64)
  }

  function handleSourceChange(nextSource: WorkspaceImportSource) {
    setSource(nextSource)
    setDryRunReport(null)
    setExecutionReport(null)
    setArchiveError(null)
    if (selectedArchiveBytes) {
      const encoded = encodeInlineArchiveBase64(selectedArchiveBytes, nextSource)
      if (!encoded.ok) {
        setInlineBase64('')
        setArchiveError(encoded.code)
      } else {
        setInlineBase64(encoded.base64)
      }
    }
  }

  function buildChannelMap(): Record<string, string> | undefined {
    const trimmed = externalChannelKey.trim()
    if (!mappedChannelId || !trimmed) return undefined
    return { [trimmed]: mappedChannelId }
  }

  async function runImport(mode: 'preview' | 'execute') {
    if (!organisationId) return
    setArchiveError(null)
    if (archiveMode === 'inline') {
      if (!inlineBase64) {
        setArchiveError('ARCHIVE_EMPTY')
        return
      }
    } else if (!UUID_PATTERN.test(attachmentId.trim())) {
      setArchiveError('ATTACHMENT')
      return
    }

    const channelMap = buildChannelMap()
    const payloadBase =
      archiveMode === 'inline'
        ? { source, inlineArchiveBase64: inlineBase64, ...(channelMap ? { channelMap } : {}) }
        : {
            source,
            attachmentId: attachmentId.trim().toLowerCase(),
            ...(channelMap ? { channelMap } : {}),
          }

    setImportBusy(true)
    try {
      if (mode === 'preview') {
        const report = await transport.previewImport(organisationId, payloadBase)
        setDryRunReport(report)
        setExecutionReport(null)
      } else {
        const report = await transport.executeImport(organisationId, {
          ...payloadBase,
          dryRun: false,
          limit: 25,
        })
        setExecutionReport(report)
      }
    } catch {
      setArchiveError('API')
    } finally {
      setImportBusy(false)
    }
  }

  async function handleCreateBridge() {
    if (!organisationId) return
    setBridgeError(null)
    const selectedChannel = channels.find((item) => item.id === bridgeChannelId)
    const check = validateCoexistenceBridgeDraft({
      channelId: bridgeChannelId,
      isConfidentialChannel: Boolean(selectedChannel?.isConfidential),
      externalWorkspaceId,
      externalChannelId,
      outboundEndpoint,
      signingSecret,
    })
    if (!check.ok) {
      setBridgeError(check.code)
      return
    }
    setBridgeBusy(true)
    try {
      const created = await transport.createBridge(organisationId, {
        channelId: bridgeChannelId,
        source: bridgeSource,
        externalWorkspaceId: externalWorkspaceId.trim(),
        externalChannelId: externalChannelId.trim(),
        outboundEndpoint: check.normalizedEndpoint,
        signingSecret: signingSecret.trim(),
      })
      setBridges((prev) => [created, ...prev.filter((item) => item.id !== created.id)])
      setSigningSecret('')
    } catch {
      setBridgeError('API')
    } finally {
      setBridgeBusy(false)
    }
  }

  async function handleRevokeBridge(bridgeId: string) {
    if (!organisationId) return
    setBridgeError(null)
    setBridgeBusy(true)
    try {
      await transport.revokeBridge(organisationId, bridgeId)
      setBridges((prev) =>
        prev.map((item) =>
          item.id === bridgeId
            ? { ...item, active: false, revokedAt: new Date().toISOString() }
            : item
        )
      )
    } catch {
      setBridgeError('API')
    } finally {
      setBridgeBusy(false)
    }
  }

  async function handleRefreshBridges() {
    if (!organisationId) return
    setBridgeError(null)
    setBridgeBusy(true)
    try {
      const list = await transport.listBridges(organisationId)
      setBridges(list)
    } catch {
      setBridgeError('API')
    } finally {
      setBridgeBusy(false)
    }
  }

  const archiveErrorMessage =
    archiveError === null
      ? null
      : archiveError === 'ATTACHMENT'
        ? copy.attachmentRequired
        : archiveError === 'API'
          ? copy.requestFailed
          : copy.archiveErrors[archiveError]

  const bridgeErrorMessage =
    bridgeError === null
      ? null
      : bridgeError === 'API'
        ? copy.requestFailed
        : copy.bridgeErrors[bridgeError]

  return (
    <div
      data-testid="workspace-migrator-panel"
      className="flex flex-col gap-4 rounded-md border border-c-border bg-c-sunken p-4"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-md font-semibold text-c-ink">{copy.heading}</h3>
        <p className="text-sm font-regular text-c-ink-2">{copy.subtitle}</p>
      </div>

      {!organisationId ? (
        <p
          role="status"
          data-testid="migrator-no-org-hint"
          className="rounded-md border border-c-border-soft bg-c-surface px-3 py-2 text-xs font-medium text-c-ink-2"
        >
          {copy.noOrgHint}
        </p>
      ) : null}

      <div role="tablist" className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'import'}
          data-testid="migrator-tab-import"
          onClick={() => setActiveTab('import')}
          className={
            activeTab === 'import'
              ? 'rounded-full border border-c-accent-ink bg-c-accent-soft px-3 py-1 text-xs font-semibold text-c-accent-ink focus-visible:ring focus-visible:outline-hidden'
              : 'rounded-full border border-c-border-soft bg-c-surface px-3 py-1 text-xs font-medium text-c-ink-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'
          }
        >
          {copy.tabImport}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'coexistence'}
          data-testid="migrator-tab-coexistence"
          onClick={() => setActiveTab('coexistence')}
          className={
            activeTab === 'coexistence'
              ? 'rounded-full border border-c-accent-ink bg-c-accent-soft px-3 py-1 text-xs font-semibold text-c-accent-ink focus-visible:ring focus-visible:outline-hidden'
              : 'rounded-full border border-c-border-soft bg-c-surface px-3 py-1 text-xs font-medium text-c-ink-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'
          }
        >
          {copy.tabCoexistence}
        </button>
      </div>

      {activeTab === 'import' ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor={`${baseId}-source`} className="text-xs font-medium text-c-ink-2">
                {copy.sourceLabel}
              </label>
              <select
                id={`${baseId}-source`}
                data-testid="migrator-source-select"
                value={source}
                onChange={(event) => {
                  handleSourceChange(event.target.value as WorkspaceImportSource)
                }}
                className={INPUT_CLASS}
              >
                <option value="slack">{copy.sources.slack}</option>
                <option value="discord">{copy.sources.discord}</option>
                <option value="notion">{copy.sources.notion}</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={`${baseId}-mode`} className="text-xs font-medium text-c-ink-2">
                {copy.archiveModeLabel}
              </label>
              <select
                id={`${baseId}-mode`}
                data-testid="migrator-archive-mode"
                value={archiveMode}
                onChange={(event) => {
                  setArchiveMode(event.target.value as 'inline' | 'attachment')
                  setArchiveError(null)
                }}
                className={INPUT_CLASS}
              >
                <option value="inline">{copy.modeInline}</option>
                <option value="attachment">{copy.modeAttachment}</option>
              </select>
            </div>
          </div>

          {archiveMode === 'inline' ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${baseId}-file`} className="text-xs font-medium text-c-ink-2">
                {copy.archiveFileLabel}
              </label>
              <input
                id={`${baseId}-file`}
                data-testid="migrator-archive-file"
                type="file"
                accept={
                  source === 'discord'
                    ? '.zip,.json,application/zip,application/json'
                    : '.zip,application/zip'
                }
                onChange={(event) => {
                  void handleArchiveFileChange(event.target.files?.[0])
                }}
                className="rounded-md border border-c-border-input bg-c-surface px-3 py-2 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
              />
              {selectedFileName ? (
                <span className="break-all font-mono text-xs text-c-ink-3">{selectedFileName}</span>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${baseId}-att`} className="text-xs font-medium text-c-ink-2">
                {copy.attachmentIdLabel}
              </label>
              <input
                id={`${baseId}-att`}
                data-testid="migrator-attachment-id"
                type="text"
                spellCheck={false}
                value={attachmentId}
                onChange={(event) => {
                  setAttachmentId(event.target.value)
                  setArchiveError(null)
                }}
                placeholder={copy.attachmentIdPlaceholder}
                className={MONO_INPUT_CLASS}
              />
            </div>
          )}

          {source !== 'notion' && channels.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label htmlFor={`${baseId}-ext-ch`} className="text-xs font-medium text-c-ink-2">
                  {copy.externalChannelNameLabel}
                </label>
                <input
                  id={`${baseId}-ext-ch`}
                  type="text"
                  maxLength={160}
                  value={externalChannelKey}
                  onChange={(event) => setExternalChannelKey(event.target.value)}
                  className={MONO_INPUT_CLASS}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${baseId}-map-ch`} className="text-xs font-medium text-c-ink-2">
                  {copy.targetChannelMapLabel}
                </label>
                <select
                  id={`${baseId}-map-ch`}
                  data-testid="migrator-map-channel"
                  value={mappedChannelId}
                  onChange={(event) => setMappedChannelId(event.target.value)}
                  className={INPUT_CLASS}
                >
                  <option value="">{copy.chooseTargetChannel}</option>
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.label}
                      {channel.isConfidential ? ` ${copy.confidentialSuffix}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          <p className="rounded-md border border-c-border-soft bg-c-surface px-3 py-2 text-xs text-c-ink-2">
            {copy.securityNotice}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!organisationId || importBusy}
              onClick={() => {
                void runImport('preview')
              }}
            >
              {copy.previewButton}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!organisationId || importBusy}
              onClick={() => {
                void runImport('execute')
              }}
            >
              {copy.executeButton}
            </Button>
          </div>

          {archiveErrorMessage ? (
            <div
              role="alert"
              data-testid="migrator-import-error"
              className="rounded-md border border-c-bad bg-c-bad-soft px-3 py-2 text-xs font-medium text-c-bad-ink"
            >
              {archiveErrorMessage}
            </div>
          ) : null}

          {dryRunReport ? (
            <div
              data-testid="migrator-dry-run-report"
              className="flex flex-col gap-3 rounded-md border border-c-border-soft bg-c-surface p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-c-ink">{copy.dryRunTitle}</span>
                <StatusPill state="info">{dryRunReport.source}</StatusPill>
              </div>
              <p className="break-all font-mono text-xs text-c-ink-3">
                {copy.shaLabel} {dryRunReport.archive_sha256}
              </p>

              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {(
                  [
                    [copy.metrics.channelsTotal, dryRunReport.counts.channels_total],
                    [copy.metrics.channelsToCreate, dryRunReport.counts.channels_to_create],
                    [copy.metrics.messagesTotal, dryRunReport.counts.messages_total],
                    [copy.metrics.threadRepliesTotal, dryRunReport.counts.thread_replies_total],
                    [copy.metrics.docsPagesTotal, dryRunReport.counts.docs_pages_total],
                    [copy.metrics.collectionsTotal, dryRunReport.counts.collections_total],
                    [copy.metrics.membersMatched, dryRunReport.counts.members_matched],
                    [copy.metrics.membersUnmatched, dryRunReport.counts.members_unmatched],
                    [copy.metrics.omittedAssets, dryRunReport.counts.omitted_assets],
                  ] as const
                ).map(([label, val]) => (
                  <div
                    key={label}
                    className="flex flex-col gap-1 rounded-md border border-c-border-soft bg-c-sunken p-3"
                  >
                    <dt className="text-xs text-c-ink-2">{label}</dt>
                    <dd className="font-mono text-sm font-semibold text-c-ink">{val}</dd>
                  </div>
                ))}
              </dl>

              {dryRunReport.warnings.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold text-c-ink-2">{copy.warningsHeading}</span>
                  <ul className="flex flex-col gap-1" data-testid="migrator-warnings-list">
                    {dryRunReport.warnings.map((code) => (
                      <li
                        key={code}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-c-border-soft bg-c-sunken px-3 py-2 text-xs text-c-ink"
                      >
                        <StatusPill state="warning">{code}</StatusPill>
                        <span>{copy.warnings[code]}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {dryRunReport.member_mappings.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold text-c-ink-2">
                    {copy.memberMappingsHeading}
                  </span>
                  <ul className="flex flex-col gap-1" data-testid="migrator-member-mappings">
                    {dryRunReport.member_mappings.map((mapping) => (
                      <li
                        key={mapping.external_id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-border-soft bg-c-sunken px-3 py-2 text-xs"
                      >
                        <span className="font-medium text-c-ink">
                          {mapping.display_name}{' '}
                          <span className="break-all font-mono text-c-ink-3">
                            ({mapping.external_id})
                          </span>
                        </span>
                        <StatusPill
                          state={mapping.matched_membership_id ? 'success' : 'neutral'}
                        >
                          {mapping.matched_membership_id
                            ? copy.memberMatched
                            : copy.memberUnmatched}
                        </StatusPill>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          {executionReport ? (
            <div
              data-testid="migrator-execution-report"
              className="flex flex-col gap-2 rounded-md border border-c-ok-border bg-c-ok-soft p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-c-ok-ink">{copy.executionTitle}</span>
                {executionReport.state ? (
                  <StatusPill state="success">{executionReport.state}</StatusPill>
                ) : null}
              </div>
              <p className="font-mono text-xs text-c-ok-ink">
                {copy.metrics.importedBatch}: {executionReport.imported ?? 0} •{' '}
                {copy.metrics.replayedMessages}: {executionReport.replayed_messages ?? 0} •{' '}
                {copy.metrics.remainingBatch}: {executionReport.remaining ?? 0}
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-c-ink">{copy.coexistenceHeading}</span>
            <p className="text-xs text-c-ink-2">{copy.coexistenceSubtitle}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusPill state="info">{copy.guardHmacBadge}</StatusPill>
            <StatusPill state="success">{copy.guardLoopBadge}</StatusPill>
            <StatusPill state="neutral">{copy.guardPlainBadge}</StatusPill>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor={`${baseId}-br-source`} className="text-xs font-medium text-c-ink-2">
                {copy.bridgeSourceLabel}
              </label>
              <select
                id={`${baseId}-br-source`}
                data-testid="coexistence-source-select"
                value={bridgeSource}
                onChange={(event) => {
                  setBridgeSource(event.target.value as CoexistenceBridgeSource)
                  setBridgeError(null)
                }}
                className={INPUT_CLASS}
              >
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={`${baseId}-br-ch`} className="text-xs font-medium text-c-ink-2">
                {copy.bridgeChannelLabel}
              </label>
              <select
                id={`${baseId}-br-ch`}
                data-testid="coexistence-channel-select"
                value={bridgeChannelId}
                onChange={(event) => {
                  setBridgeChannelId(event.target.value)
                  setBridgeError(null)
                }}
                className={INPUT_CLASS}
              >
                <option value="">{copy.chooseBridgeChannel}</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.label}
                    {channel.isConfidential ? ` ${copy.confidentialSuffix}` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={`${baseId}-ext-ws`} className="text-xs font-medium text-c-ink-2">
                {copy.externalWorkspaceLabel}
              </label>
              <input
                id={`${baseId}-ext-ws`}
                data-testid="coexistence-ext-workspace"
                type="text"
                maxLength={128}
                spellCheck={false}
                value={externalWorkspaceId}
                onChange={(event) => {
                  setExternalWorkspaceId(event.target.value)
                  setBridgeError(null)
                }}
                className={MONO_INPUT_CLASS}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={`${baseId}-ext-cid`} className="text-xs font-medium text-c-ink-2">
                {copy.externalChannelLabel}
              </label>
              <input
                id={`${baseId}-ext-cid`}
                data-testid="coexistence-ext-channel"
                type="text"
                maxLength={128}
                spellCheck={false}
                value={externalChannelId}
                onChange={(event) => {
                  setExternalChannelId(event.target.value)
                  setBridgeError(null)
                }}
                className={MONO_INPUT_CLASS}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={`${baseId}-out-url`} className="text-xs font-medium text-c-ink-2">
              {copy.outboundUrlLabel}
            </label>
            <input
              id={`${baseId}-out-url`}
              data-testid="coexistence-outbound-url"
              type="url"
              spellCheck={false}
              value={outboundEndpoint}
              onChange={(event) => {
                setOutboundEndpoint(event.target.value)
                setBridgeError(null)
              }}
              placeholder="https://hooks.example.com/services/bridge"
              className={MONO_INPUT_CLASS}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor={`${baseId}-br-sec`} className="text-xs font-medium text-c-ink-2">
              {copy.signingSecretLabel}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id={`${baseId}-br-sec`}
                data-testid="coexistence-signing-secret"
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={256}
                value={signingSecret}
                onChange={(event) => {
                  setSigningSecret(event.target.value)
                  setBridgeError(null)
                }}
                className="h-10 flex-1 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setBridgeError(null)
                  const bytes = crypto.getRandomValues(new Uint8Array(24))
                  setSigningSecret(
                    `whsec_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
                  )
                }}
              >
                {copy.generateSecretButton}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!organisationId || bridgeBusy}
              onClick={() => {
                void handleCreateBridge()
              }}
            >
              {copy.createBridgeButton}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!organisationId || bridgeBusy}
              onClick={() => {
                void handleRefreshBridges()
              }}
            >
              {copy.refreshBridgesButton}
            </Button>
          </div>

          {bridgeErrorMessage ? (
            <div
              role="alert"
              data-testid="coexistence-bridge-error"
              className="rounded-md border border-c-bad bg-c-bad-soft px-3 py-2 text-xs font-medium text-c-bad-ink"
            >
              {bridgeErrorMessage}
            </div>
          ) : null}

          <div className="flex flex-col gap-2 border-t border-c-border-soft pt-3">
            <span className="text-xs font-semibold text-c-ink-2">{copy.activeBridgesHeading}</span>
            {bridges.length === 0 ? (
              <p className="text-xs text-c-ink-3">{copy.noBridges}</p>
            ) : (
              <ul className="flex flex-col gap-2" data-testid="coexistence-bridges-list">
                {bridges.map((bridge) => (
                  <li
                    key={bridge.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-border-soft bg-c-surface px-3 py-2 text-xs"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="break-all font-mono font-semibold text-c-ink">
                        {bridge.source} • {bridge.externalWorkspaceId}/{bridge.externalChannelId}
                      </span>
                      <span className="break-all font-mono text-c-ink-3">
                        {bridge.outboundEndpoint}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill state={bridge.active ? 'success' : 'neutral'}>
                        {bridge.active ? copy.bridgeActiveBadge : copy.bridgeRevokedBadge}
                      </StatusPill>
                      {bridge.active ? (
                        <Button
                          size="sm"
                          variant="tertiary"
                          disabled={bridgeBusy}
                          onClick={() => {
                            void handleRevokeBridge(bridge.id)
                          }}
                        >
                          {copy.revokeBridgeButton}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
