import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { OrganisationRole } from '../../app/Sidebar'
import { WORKSPACE_COMMAND_EVENT } from './WorkspaceMenu'
import { useWorkspaceSettingsEpoch } from './settingsRuntime'

const WorkspaceSettings = lazy(() => import('./WorkspaceSettings'))
export interface WorkspaceSettingsProps {
  org: string
  organisationId: string
  organisationName: string
  displayName: string
  role: OrganisationRole
}

/** Keep the conversation mounted, including its draft, scroll position and active call. */
export function WorkspaceSettingsHost(props: WorkspaceSettingsProps) {
  const epoch = useWorkspaceSettingsEpoch()
  const [openedEpoch, setOpenedEpoch] = useState<number | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const show = () => {
      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      setOpenedEpoch(epoch)
    }
    const command = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === 'settings') show()
    }
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault()
        show()
      }
    }
    window.addEventListener(WORKSPACE_COMMAND_EVENT, command)
    window.addEventListener('keydown', shortcut)
    return () => {
      window.removeEventListener(WORKSPACE_COMMAND_EVENT, command)
      window.removeEventListener('keydown', shortcut)
    }
  }, [epoch])
  return openedEpoch === epoch ? (
    <Suspense fallback={null}>
      <WorkspaceSettings
        {...props}
        key={props.org}
        onClose={() => setOpenedEpoch(null)}
        returnFocus={returnFocus}
      />
    </Suspense>
  ) : null
}
