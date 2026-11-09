import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { authAdapter } from '../../auth/oidc'
import type { OrderDraft } from './draft'
import type { OrderOwner } from './owner'
import { readEditable, saveEditable, ownerTuple } from './editableStorage'
import type { EditableState } from './editableStorage'

export function isActiveOrderOwner(owner: OrderOwner): boolean {
  const session = authAdapter.getSnapshot()
  return (
    session.status === 'ready' &&
    authAdapter.getAccessToken() !== undefined &&
    session.generation === owner.generation &&
    session.user?.identity?.issuer === owner.issuer &&
    session.user.identity.subject === owner.subject
  )
}
export function useOrderDraft(draftId: string, owner: OrderOwner) {
  const key = JSON.stringify([
    ...ownerTuple(owner),
    owner.membershipId,
    owner.identityId,
    owner.generation,
    draftId,
  ])
  const [stored, setStored] = useState(() => ({ key, ...readEditable(draftId, owner) }))
  const selected = stored.key === key ? stored : { key, ...readEditable(draftId, owner) }
  if (stored.key !== key) setStored(selected)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [key])
  const current = useRef(stored)
  useLayoutEffect(() => {
    current.current = stored
  }, [stored])
  const update = useCallback(
    (patch: Partial<OrderDraft>) => {
      if (
        !mounted.current ||
        current.current.key !== key ||
        !isActiveOrderOwner(owner) ||
        current.current.status === 'held'
      )
        return
      const next: EditableState = saveEditable(
        { ...current.current.draft, ...patch, draftId, createdAt: current.current.draft.createdAt },
        owner
      ) ?? { draft: current.current.draft, status: 'unavailable' }
      const state = { key, ...next }
      current.current = state
      setStored(state)
    },
    [draftId, key, owner]
  )
  return { draft: selected.draft, status: selected.status, update }
}
