import { lazy, Suspense, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

const LazyWorkspaceCollaborativeDocs = lazy(() => import('./WorkspaceCollaborativeDocs'))

export interface DocsWorkspacePanelProps {
  readonly workspacePagesSlot?: ReactNode
  readonly tenantSlug: string
  readonly channelId: string
  readonly channelName: string
}

export function DocsWorkspacePanel({ workspacePagesSlot }: DocsWorkspacePanelProps) {
  const { t } = useTranslation()
  return (
    workspacePagesSlot ?? (
      <Suspense fallback={<p role="status">{t('console.docs.collab.editor-loading')}</p>}>
        <LazyWorkspaceCollaborativeDocs initialSurface="drive" />
      </Suspense>
    )
  )
}
