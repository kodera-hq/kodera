import { useCallback, useContext, useSyncExternalStore } from 'react'
import { QueryClientContext } from '@tanstack/react-query'
import type { WorkspaceRead } from './queries'
import type { Workspace } from './workspace'

/** Chrome observes the bootstrap cache without starting a second request. */
export function useCachedWorkspace(organisationId: string): Workspace | undefined {
  const client = useContext(QueryClientContext)
  const subscribe = useCallback(
    (listener: () => void) => client?.getQueryCache().subscribe(listener) ?? (() => {}),
    [client]
  )
  const snapshot = useCallback(
    () => client?.getQueryData<WorkspaceRead>(['workspace', organisationId])?.workspace,
    [client, organisationId]
  )
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
