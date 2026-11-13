import { useTranslation } from 'react-i18next'
import { Avatar } from '@/ui/Avatar/Avatar'
import { StatusPill, type StatusPillState } from '@/ui/StatusPill/StatusPill'
import { cx } from '@/ui/cx'
import type {
  CollabConnectionStatus,
  CollaboratorPeer,
  CursorPaletteSlot,
} from './collabSession'
import type { DocumentAccessRole } from './pageTree'

export const CURSOR_RING_BY_SLOT: Readonly<Record<CursorPaletteSlot, string>> = {
  1: 'border-c-cursor-1',
  2: 'border-c-cursor-2',
  3: 'border-c-cursor-3',
  4: 'border-c-cursor-4',
  5: 'border-c-cursor-5',
  6: 'border-c-cursor-6',
}

export function CollaboratorPresence({
  status,
  role,
  peers,
}: {
  readonly status: CollabConnectionStatus
  readonly role: DocumentAccessRole
  readonly peers: readonly CollaboratorPeer[]
}) {
  const { t } = useTranslation()

  const statusMeta = (): { state: StatusPillState; label: string } => {
    if (role === 'viewer') {
      return { state: 'neutral', label: t('console.docs.collab.status-readonly') }
    }
    switch (status) {
      case 'synced':
        return { state: 'success', label: t('console.docs.collab.status-synced') }
      case 'connecting':
        return { state: 'info', label: t('console.docs.collab.status-connecting') }
      case 'reconnecting':
        return { state: 'warning', label: t('console.docs.collab.status-reconnecting') }
      case 'offline-buffered':
        return { state: 'warning', label: t('console.docs.collab.status-offline') }
      case 'forbidden':
        return { state: 'danger', label: t('console.docs.collab.status-readonly') }
      case 'local':
      case 'closed':
        return { state: 'info', label: t('console.docs.collab.status-local') }
    }
  }

  const pill = statusMeta()

  return (
    <div
      data-testid="docs-collaborator-presence"
      className="flex flex-wrap items-center gap-2"
    >
      <StatusPill state={pill.state} data-testid="docs-collab-status-pill">
        {pill.label}
      </StatusPill>

      {role === 'viewer' && status === 'synced' ? (
        <StatusPill state="success">{t('console.docs.collab.status-synced')}</StatusPill>
      ) : null}

      {peers.length > 0 ? (
        <div
          role="group"
          aria-label={t('console.docs.collab.presence-label')}
          className="flex items-center gap-2"
        >
          <ul className="flex items-center gap-1">
            {peers.slice(0, 6).map((peer) => (
              <li
                key={peer.clientId}
                data-testid={`docs-presence-avatar-${peer.userId}`}
                className={cx(
                  'inline-flex rounded-full border-2 p-0',
                  CURSOR_RING_BY_SLOT[peer.cursorSlot]
                )}
                title={peer.name}
              >
                <Avatar name={peer.name} identity={peer.userId} size="md" />
              </li>
            ))}
          </ul>
          <span className="text-xs font-medium text-c-ink-2">
            {t('console.docs.collab.presence-count', { count: peers.length })}
          </span>
        </div>
      ) : null}
    </div>
  )
}
