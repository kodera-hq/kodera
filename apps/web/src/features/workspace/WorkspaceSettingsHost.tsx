import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { OrganisationRole } from '../../app/Sidebar'
import { WORKSPACE_COMMAND_EVENT } from './WorkspaceMenu'
import { isSection, modeOf, type Section, type SettingsMode } from './admin/sections'
import { useWorkspaceSettingsEpoch } from './settingsRuntime'

const WorkspaceSettings = lazy(() => import('./WorkspaceSettings'))
export interface WorkspaceSettingsProps {
  org: string
  organisationId: string
  personId?: string | undefined
  /** The caller's own membership: what decides the workspace roles they were assigned. */
  membershipId?: string | undefined
  organisationName: string
  displayName: string
  role: OrganisationRole
}

/**
 * Keep the conversation mounted, including its draft, scroll position and active call.
 *
 * Two surfaces open from here (issue 211): `settings` (the gear, `Cmd+,`) opens the person's own
 * settings; `admin` (the workspace menu) opens the workspace's administration. A section named
 * by a command opens the surface it belongs to.
 */
export function WorkspaceSettingsHost(props: WorkspaceSettingsProps) {
  const [opening, setOpening] = useState<{ section: Section; mode: SettingsMode }>({
    section: 'profile',
    mode: 'personal',
  })
  const epoch = useWorkspaceSettingsEpoch()
  const [openedEpoch, setOpenedEpoch] = useState<number | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const show = (section: Section, mode: SettingsMode = modeOf(section)) => {
      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      setOpening({ section, mode })
      setOpenedEpoch(epoch)
    }
    const command = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const detail: unknown = event.detail
      if (detail === 'settings') show('profile')
      else if (detail === 'admin') show('overview', 'admin')
      else if (
        typeof detail === 'object' &&
        detail !== null &&
        'command' in detail &&
        (detail.command === 'settings' || detail.command === 'admin') &&
        'section' in detail &&
        isSection(detail.section)
      ) {
        show(detail.section)
      }
    }
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault()
        show('profile')
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
        initialSection={opening.section}
        mode={opening.mode}
        key={`${props.org}:${opening.mode}:${opening.section}`}
        onClose={() => setOpenedEpoch(null)}
        returnFocus={returnFocus}
      />
    </Suspense>
  ) : null
}
