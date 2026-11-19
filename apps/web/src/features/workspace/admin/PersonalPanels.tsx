// The personal sections that point elsewhere for their full screen: sign-in security lives on
// its own page (two-factor enrolment, devices), notifications pair this browser's push switch
// with the interface sounds set under « Voix & audio ».

import { Link } from '@tanstack/react-router'
import { isStubArea } from '../../../app/stubAreas'
import { PushSwitch } from '../../notifications/NotificationCenter'
import { Panel, useAdminCopy } from './shared'

const LINK =
  'self-start rounded-md border border-c-border px-4 py-3 text-sm font-medium text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'

export function SecuritySection({ org, onNavigate }: { org: string; onNavigate: () => void }) {
  const copy = useAdminCopy()
  return (
    <Panel title={copy.securityTwoFactor} hint={copy.securityHint}>
      <ul className="list-disc pl-5 text-sm text-c-ink-2">
        <li>{copy.securityMfa}</li>
        <li>{copy.securityDevices}</li>
        <li>{copy.securitySessions}</li>
      </ul>
      {isStubArea('security') ? (
        <p className="text-sm text-c-ink-3">{copy.securityLater}</p>
      ) : (
        <Link to="/$org/security" params={{ org }} onClick={onNavigate} className={LINK}>
          {copy.securityOpen}
        </Link>
      )}
    </Panel>
  )
}

export function NotificationsSection({ onOpenAudio }: { onOpenAudio: () => void }) {
  const copy = useAdminCopy()
  return (
    <div className="flex flex-col gap-6">
      <Panel title={copy.notificationsPush} hint={copy.notificationsHint}>
        <PushSwitch />
      </Panel>
      <Panel title={copy.notificationsSounds} hint={copy.notificationsSoundsHint}>
        <button type="button" onClick={onOpenAudio} className={LINK}>
          {copy.notificationsOpenSounds}
        </button>
      </Panel>
    </div>
  )
}
