import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { ExtensionsCatalogPanel } from './ExtensionsCatalogPanel'
import { WorkspaceMigratorPanel } from './WorkspaceMigratorPanel'
import {
  encodeInlineArchiveBase64,
  validateCoexistenceBridgeDraft,
  type CoexistenceBridgeRecord,
  type WorkspaceImportDryRunReport,
  type WorkspaceMigratorTransport,
} from './workspaceMigrator'

const ORG_ID = '01950000-0000-7000-8000-000000000010'
const PLAIN_CH_ID = '01950000-0000-7000-8000-000000000011'
const CONF_CH_ID = '01950000-0000-7000-8000-000000000012'

function minimalZipBytes(): Uint8Array<ArrayBuffer> {
  // Valid empty 22-byte ZIP End of Central Directory (PK\x05\x06).
  const out = new Uint8Array(new ArrayBuffer(22))
  out[0] = 0x50
  out[1] = 0x4b
  out[2] = 0x05
  out[3] = 0x06
  return out
}

function makeTransport(overrides: Partial<WorkspaceMigratorTransport> = {}): WorkspaceMigratorTransport {
  const sampleReport: WorkspaceImportDryRunReport = {
    source: 'slack',
    archive_sha256: '000000000000000000000000000000000000000000000000000000000000a1b2',
    dry_run: true,
    counts: {
      channels_total: 2,
      channels_existing: 1,
      channels_to_create: 1,
      messages_total: 18,
      thread_replies_total: 4,
      docs_pages_total: 2,
      collections_total: 0,
      collection_rows_total: 0,
      members_matched: 1,
      members_unmatched: 1,
      already_imported_reused: 0,
      omitted_assets: 1,
    },
    member_mappings: [
      {
        external_id: 'U01ALICE',
        display_name: 'Alice Martin',
        matched_membership_id: '01950000-0000-7000-8000-000000000021',
        local_role_preserved: true,
      },
      {
        external_id: 'U02EXTADMIN',
        display_name: 'External Admin',
        matched_membership_id: null,
        local_role_preserved: true,
      },
    ],
    warnings: ['external_admin_privilege_ignored', 'unsupported_assets_omitted'],
  }

  return {
    previewImport: vi.fn().mockResolvedValue(sampleReport),
    executeImport: vi.fn().mockResolvedValue({
      batch_id: '01950000-0000-7000-8000-000000000030',
      source: 'slack',
      state: 'complete',
      imported: 2,
      reused: 0,
      remaining: 0,
      omitted_assets: 1,
      replayed_messages: 18,
      reused_messages: 0,
      warnings: ['external_admin_privilege_ignored'],
    }),
    listBridges: vi.fn().mockResolvedValue([]),
    createBridge: vi.fn().mockImplementation(async (_orgId, body) => {
      const rec: CoexistenceBridgeRecord = {
        id: '01950000-0000-7000-8000-000000000040',
        workspaceId: '01950000-0000-7000-8000-000000000041',
        channelId: body.channelId,
        creatorMembershipId: '01950000-0000-7000-8000-000000000042',
        source: body.source,
        externalWorkspaceId: body.externalWorkspaceId,
        externalChannelId: body.externalChannelId,
        outboundEndpoint: body.outboundEndpoint,
        active: true,
        revokedAt: null,
        createdAt: '2026-11-23T00:00:00Z',
        updatedAt: '2026-11-23T00:00:00Z',
      }
      return rec
    }),
    revokeBridge: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('workspaceMigrator pure guards', () => {
  it('validates ZIP magic bytes and < 512 KiB inline archive cap', () => {
    expect(encodeInlineArchiveBase64(new Uint8Array(0))).toEqual({
      ok: false,
      code: 'ARCHIVE_EMPTY',
    })
    expect(encodeInlineArchiveBase64(new TextEncoder().encode('<html>disguised</html>'))).toEqual({
      ok: false,
      code: 'ARCHIVE_NOT_ZIP',
    })
    expect(encodeInlineArchiveBase64(new Uint8Array(512 * 1024))).toEqual({
      ok: false,
      code: 'ARCHIVE_INLINE_TOO_LARGE',
    })
    const valid = encodeInlineArchiveBase64(minimalZipBytes())
    expect(valid.ok).toBe(true)
  })

  it('refuses confidential channels, SSRF endpoints, and short secrets on bridge drafts', () => {
    expect(
      validateCoexistenceBridgeDraft({
        channelId: CONF_CH_ID,
        isConfidentialChannel: true,
        externalWorkspaceId: 'T01TEAM',
        externalChannelId: 'C01CHAN',
        outboundEndpoint: 'https://hooks.example.com/bridge',
        signingSecret: 's'.repeat(32),
      })
    ).toEqual({ ok: false, code: 'CHANNEL_CONFIDENTIAL_FORBIDDEN' })

    expect(
      validateCoexistenceBridgeDraft({
        channelId: PLAIN_CH_ID,
        isConfidentialChannel: false,
        externalWorkspaceId: 'T01TEAM',
        externalChannelId: 'C01CHAN',
        outboundEndpoint: 'https://169.254.169.254/latest/meta-data',
        signingSecret: 's'.repeat(32),
      })
    ).toEqual({ ok: false, code: 'SSRF_FORBIDDEN_IP' })

    expect(
      validateCoexistenceBridgeDraft({
        channelId: PLAIN_CH_ID,
        isConfidentialChannel: false,
        externalWorkspaceId: 'T01TEAM',
        externalChannelId: 'C01CHAN',
        outboundEndpoint: 'https://hooks.example.com/bridge',
        signingSecret: 'short',
      })
    ).toEqual({ ok: false, code: 'SECRET_TOO_SHORT' })
  })
})

describe('WorkspaceMigratorPanel & lazy ExtensionsCatalogPanel integration', () => {
  it('simulates zero-mutation dry-run, renders privilege-escalation warnings, and executes bounded import', async () => {
    const user = userEvent.setup()
    const transport = makeTransport()
    try {
      await i18n.changeLanguage('en')
      render(
        <WorkspaceMigratorPanel
          organisationId={ORG_ID}
          channels={[
            { id: PLAIN_CH_ID, label: 'general', isConfidential: false },
            { id: CONF_CH_ID, label: 'vault', isConfidential: true },
          ]}
          transport={transport}
        />
      )

      const fileInput = screen.getByTestId('migrator-archive-file')
      const zipFile = new File([minimalZipBytes()], 'slack-export.zip', {
        type: 'application/zip',
      })
      await user.upload(fileInput, zipFile)
      await user.selectOptions(screen.getByTestId('migrator-map-channel'), PLAIN_CH_ID)

      await user.click(screen.getByRole('button', { name: /Simulate dry-run/i }))

      const reportRegion = await screen.findByTestId('migrator-dry-run-report')
      expect(within(reportRegion).getByText('18')).toBeInTheDocument()
      expect(within(reportRegion).getByText('external_admin_privilege_ignored')).toBeInTheDocument()
      expect(within(reportRegion).getByText(/Alice Martin/i)).toBeInTheDocument()
      expect(within(reportRegion).getByText(/local role preserved/i)).toBeInTheDocument()
      expect(within(reportRegion).getByText(/inert author attribution/i)).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /Execute bounded step/i }))
      expect(await screen.findByTestId('migrator-execution-report')).toHaveTextContent(
        /Replayed Matrix messages: 18/i
      )
    } finally {
      await i18n.changeLanguage('fr')
    }
  })

  it('creates and revokes a non-confidential coexistence bridge while blocking confidential channels', async () => {
    const user = userEvent.setup()
    const transport = makeTransport()
    render(
      <ExtensionsCatalogPanel
        organisationId={ORG_ID}
        defaultMigratorOpen
        migratorTransport={transport}
        channels={[
          { id: PLAIN_CH_ID, label: 'general', isConfidential: false },
          { id: CONF_CH_ID, label: 'secret-room', isConfidential: true },
        ]}
      />
    )

    const panel = await screen.findByTestId('workspace-migrator-panel')
    await user.click(within(panel).getByTestId('migrator-tab-coexistence'))

    await user.selectOptions(within(panel).getByTestId('coexistence-channel-select'), CONF_CH_ID)
    await user.type(within(panel).getByTestId('coexistence-ext-workspace'), 'T01WORKSPACE')
    await user.type(within(panel).getByTestId('coexistence-ext-channel'), 'C01CHANNEL')
    await user.type(
      within(panel).getByTestId('coexistence-outbound-url'),
      'https://hooks.example.com/services/coexistence'
    )
    await user.click(within(panel).getByRole('button', { name: /Générer un secret/i }))
    await user.click(within(panel).getByRole('button', { name: /Activer le pont/i }))

    expect(within(panel).getByTestId('coexistence-bridge-error')).toHaveTextContent(
      /salons confidentiels chiffrés/i
    )
    expect(transport.createBridge).not.toHaveBeenCalled()

    await user.selectOptions(within(panel).getByTestId('coexistence-channel-select'), PLAIN_CH_ID)
    await user.click(within(panel).getByRole('button', { name: /Activer le pont/i }))

    const bridgesList = await within(panel).findByTestId('coexistence-bridges-list')
    expect(bridgesList).toHaveTextContent('T01WORKSPACE/C01CHANNEL')
    expect(bridgesList).toHaveTextContent('Actif')

    await user.click(within(bridgesList).getByRole('button', { name: 'Révoquer' }))
    expect(transport.revokeBridge).toHaveBeenCalledOnce()
    expect(bridgesList).toHaveTextContent('Révoqué')
  })

  it('supports both raw .json and .zip Discord exports while enforcing ZIP headers on Slack and Notion', async () => {
    const user = userEvent.setup()
    const transport = makeTransport()
    const discordJsonText = JSON.stringify({
      channel: { id: '9001', name: 'general' },
      messages: [
        {
          id: '1',
          timestamp: '2026-02-01T10:00:00Z',
          author: { id: '42', name: 'Alice' },
          content: 'Hello from Discord JSON',
        },
      ],
    })
    const discordJsonBytes = new TextEncoder().encode(discordJsonText)

    expect(encodeInlineArchiveBase64(discordJsonBytes, 'discord').ok).toBe(true)
    expect(encodeInlineArchiveBase64(discordJsonBytes, 'slack')).toEqual({
      ok: false,
      code: 'ARCHIVE_NOT_ZIP',
    })
    expect(encodeInlineArchiveBase64(minimalZipBytes(), 'discord').ok).toBe(true)

    render(
      <ExtensionsCatalogPanel
        organisationId={ORG_ID}
        defaultMigratorOpen
        migratorTransport={transport}
      />
    )

    const panel = await screen.findByTestId('workspace-migrator-panel')
    const sourceSelect = within(panel).getByTestId('migrator-source-select')
    const fileInput = within(panel).getByTestId('migrator-archive-file')
    expect(fileInput).toHaveAttribute('accept', '.zip,application/zip')

    await user.selectOptions(sourceSelect, 'discord')
    expect(fileInput).toHaveAttribute(
      'accept',
      '.zip,.json,application/zip,application/json'
    )

    const jsonFile = new File([discordJsonText], 'discord-channel.json', {
      type: 'application/json',
    })
    await user.upload(fileInput, jsonFile)
    expect(within(panel).queryByTestId('migrator-import-error')).not.toBeInTheDocument()

    await user.click(within(panel).getByRole('button', { name: /Simuler à blanc/i }))
    expect(transport.previewImport).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        source: 'discord',
        inlineArchiveBase64: expect.any(String),
      })
    )

    // Switching source away from Discord while holding a raw JSON file surfaces ARCHIVE_NOT_ZIP.
    await user.selectOptions(sourceSelect, 'notion')
    expect(within(panel).getByTestId('migrator-import-error')).toBeInTheDocument()

    // Uploading a Discord .zip archive works seamlessly too.
    await user.selectOptions(sourceSelect, 'discord')
    const zipFile = new File([minimalZipBytes()], 'discord-export.zip', {
      type: 'application/zip',
    })
    await user.upload(fileInput, zipFile)
    expect(within(panel).queryByTestId('migrator-import-error')).not.toBeInTheDocument()
  })
})
