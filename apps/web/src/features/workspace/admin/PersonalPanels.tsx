// The personal sections that point elsewhere for their full screen: sign-in security lives on
// its own page (two-factor enrolment, devices), notifications pair this browser's push switch
// with the interface sounds set under « Voix & audio », and the shortcuts tab is a read-only
// reference of the keys the workspace answers to.

import { Link } from '@tanstack/react-router'
import { isStubArea } from '../../../app/stubAreas'
import { PushSwitch } from '../../notifications/NotificationCenter'
import { isMac } from '../ChannelSearch'
import { Panel, useAdminCopy } from './shared'

const LINK =
  'self-start rounded-md border border-c-border px-4 py-3 text-sm font-medium text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'
const KBD = 'rounded-sm border border-c-border-soft bg-c-sunken px-2 py-1 font-mono text-xs text-c-ink-2'

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

/** The workspace's core keyboard shortcuts, read-only: `⌘K`/`Ctrl+K`, `⌘/`/`Ctrl+/`, the Alt
 * channel moves, `↑` to edit one's last message, and `Échap` to close. */
export function ShortcutsSection() {
  const copy = useAdminCopy()
  const mac = isMac()
  const rows: readonly (readonly [string, string])[] = [
    [copy.shortcut.search, mac ? '⌘K' : 'Ctrl+K'],
    [copy.shortcut.members, mac ? '⌘/' : 'Ctrl+/'],
    [copy.shortcut.channel, 'Alt+↑/↓'],
    [copy.shortcut.unread, 'Alt+Shift+↑/↓'],
    [copy.shortcut.edit, '↑'],
    [copy.shortcut.close, copy.escHint],
  ]
  return (
    <Panel title={copy.sections.shortcuts} hint={copy.shortcutsHint}>
      <ul className="flex flex-col gap-2">
        {rows.map(([label, keys]) => (
          <li key={label} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-c-ink-2">{label}</span>
            <kbd className={KBD}>{keys}</kbd>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
