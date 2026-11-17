import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import type { EspaceStoreLike } from './liveViewModel'
import type { InviteView } from './matrix/store'
import { useStoreSlice } from './useStoreSlice'

const invitationsOf = (snapshot: ReturnType<EspaceStoreLike['getSnapshot']>) => snapshot.invites

function Invitation({
  store,
  invite,
  onSelect,
}: {
  store: EspaceStoreLike
  invite: InviteView
  onSelect: (roomId: string) => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const act = async (accept: boolean) => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try {
      if (accept) {
        await store.acceptInvite?.(invite.roomId)
        onSelect(invite.roomId)
      } else {
        await store.declineInvite?.(invite.roomId)
      }
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="flex flex-col gap-1 px-2 py-1">
      <span className="text-sm text-c-ink">{invite.name}</span>
      {invite.inviter === null ? null : (
        <span className="text-xs break-all text-c-ink-3">{invite.inviter}</span>
      )}
      <div className="flex gap-2">
        {store.acceptInvite === undefined ? null : (
          <Button size="sm" disabled={busy} onClick={() => void act(true)}>
            {t('console.workspace.directs.action-accept')}
          </Button>
        )}
        {store.declineInvite === undefined ? null : (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act(false)}>
            {t('console.workspace.directs.action-decline')}
          </Button>
        )}
      </div>
      {failed ? (
        <p role="status" className="text-xs text-c-bad-ink">
          {t('console.workspace.directs.invite-failed')}
        </p>
      ) : null}
    </li>
  )
}

/** Shared actionable Matrix invitations; accepting never sends a message. */
export function PendingInvitations({
  store,
  onSelect,
}: {
  store: EspaceStoreLike
  onSelect: (roomId: string) => void
}) {
  const { t } = useTranslation()
  const invites = useStoreSlice(store.subscribe, store.getSnapshot, invitationsOf)
  if (invites.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 text-xs font-semibold text-c-ink-3">
        {t('console.workspace.directs.invites', { count: invites.length })}
      </p>
      <ul className="flex flex-col gap-1">
        {invites.map((invite) => (
          <Invitation key={invite.roomId} store={store} invite={invite} onSelect={onSelect} />
        ))}
      </ul>
    </div>
  )
}
