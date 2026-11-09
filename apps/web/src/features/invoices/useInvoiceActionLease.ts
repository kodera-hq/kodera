import { useLayoutEffect, useRef } from 'react'
import { authAdapter } from '../../auth/oidc'

/** Retire asynchronous invoice actions when their view or login ends. */
export function useInvoiceActionLease(viewKey: string) {
  const current = useRef({ key: viewKey, mounted: false })
  useLayoutEffect(() => {
    current.current = { key: viewKey, mounted: true }
    return () => {
      current.current = { key: viewKey, mounted: false }
    }
  }, [viewKey])
  return () => {
    const view = current.current
    const generation = authAdapter.getSnapshot().generation
    return () =>
      view.key === viewKey &&
      view.mounted &&
      current.current === view &&
      authAdapter.getSnapshot().status === 'ready' &&
      authAdapter.getSnapshot().generation === generation &&
      authAdapter.getAccessToken() !== undefined
  }
}
