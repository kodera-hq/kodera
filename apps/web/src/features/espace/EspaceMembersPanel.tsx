import type { KeyboardEvent, MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { cssProperty } from '../../ui/cssom'
import { CloseIcon } from '../../ui/icons/Close'
import type { profileMessages } from '../profile/profileMessages'
import { UserProfilePopover, type MemberProfile } from '../profile/UserProfilePopover'
import type { MemberView } from './matrix/store'
import { MemberAvatar } from './MemberAvatar'

export interface EspaceSidebarResizerProps {
  testId: string
  ariaLabel: string
  value: number
  min: number
  max: number
  defaultWidth: number
  direction: 'left' | 'right'
  className: string
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void
  onChangeWidth: (next: (current: number) => number) => void
}

export function EspaceSidebarResizer({
  testId,
  ariaLabel,
  value,
  min,
  max,
  defaultWidth,
  direction,
  className,
  onMouseDown,
  onChangeWidth,
}: EspaceSidebarResizerProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onChangeWidth((w) => (direction === 'left' ? Math.max(min, w - 16) : Math.min(max, w + 16)))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onChangeWidth((w) => (direction === 'left' ? Math.min(max, w + 16) : Math.max(min, w - 16)))
    }
  }
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      // A focusable splitter (role="separator" with a value) is interactive in WAI-ARIA.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onMouseDown={onMouseDown}
      onDoubleClick={() => onChangeWidth(() => defaultWidth)}
      onKeyDown={handleKeyDown}
      className={className}
    />
  )
}

export interface EspaceMembersPanelProps {
  id: string
  narrow: boolean
  width: number
  simulation: boolean
  demoRosterLabel: string
  demoPresenceLabel: string
  profileCopy: ReturnType<typeof profileMessages>
  roster: readonly MemberView[]
  memberProfile: (member: MemberView) => MemberProfile
  viewerId: string
  canWrite: boolean
  navigationUnsettled: boolean
  onMention: (member: MemberProfile) => void
  onClose: () => void
}

export function EspaceMembersPanel({
  id,
  narrow,
  width,
  simulation,
  demoRosterLabel,
  demoPresenceLabel,
  profileCopy,
  roster,
  memberProfile,
  viewerId,
  canWrite,
  navigationUnsettled,
  onMention,
  onClose,
}: EspaceMembersPanelProps) {
  const { t } = useTranslation()
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <aside
      id={id}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          onClose()
        }
      }}
      aria-label={t('console.workspace.members.title')}
      ref={cssProperty('width', narrow ? undefined : `${width}px`)}
      className="material-panel row-span-3 row-start-1 flex w-shell-sidebar-width shrink-0 flex-col gap-3 overflow-y-auto border-l border-c-border-soft p-4 narrow:w-full"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-c-ink">{t('console.workspace.members.title')}</h2>
        <Button
          variant="tertiary"
          size="sm"
          icon={<CloseIcon />}
          iconOnly
          aria-label={t('console.common.action-close')}
          onClick={onClose}
        />
      </div>
      <div
        data-testid="espace-members-presence-summary"
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-border-soft bg-c-surface px-3 py-2 text-xs font-medium text-c-ink-2"
      >
        <span className="text-c-ok-ink">
          {simulation
            ? demoRosterLabel
            : t('console.workspace.members.online-count', {
                count: roster.filter((member) => memberProfile(member).presence !== 'offline')
                  .length,
              })}
        </span>
        <span className="text-c-ink-3">
          {simulation ? demoPresenceLabel : profileCopy.offline} (
          {roster.filter((member) => memberProfile(member).presence === 'offline').length})
        </span>
      </div>
      {(['maintainer', 'core', 'admin', 'partner', 'member', 'offline'] as const).map((group) => {
        const members = roster
          .map(memberProfile)
          .filter((member) =>
            group === 'offline'
              ? member.presence === 'offline'
              : member.presence !== 'offline' && member.role === group
          )
        if (members.length === 0) return null
        const label =
          group === 'offline'
            ? profileCopy.offlineGroup
            : group === 'admin'
              ? t('console.workspace.members.admins')
              : profileCopy[group]
        return (
          <section key={group} aria-label={label} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold text-c-ink-3">
              {label} · {members.length}
            </h3>
            <ul className="flex flex-col gap-1">
              {members.map((member) => (
                <li key={member.userId}>
                  <UserProfilePopover
                    member={member}
                    onMention={
                      !canWrite || navigationUnsettled || member.userId === viewerId
                        ? undefined
                        : onMention
                    }
                    trigger={
                      <button
                        type="button"
                        className="flex w-full min-w-0 items-center gap-3 rounded-lg p-2 text-left hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
                      >
                        <MemberAvatar
                          mxc={member.avatarMxc}
                          name={member.name}
                          identity={member.userId}
                          size="lg"
                          presenceGround="sunken"
                          onlineLabel={
                            member.presence === 'offline'
                              ? undefined
                              : member.presence === 'online'
                                ? simulation
                                  ? demoPresenceLabel
                                  : t('console.workspace.presence.online')
                                : profileCopy[member.presence]
                          }
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="truncate text-sm font-medium text-c-ink-2">
                            {member.name}
                          </span>
                          <span className="truncate text-xs text-c-ink-3">
                            {member.status || profileCopy[member.presence]}
                          </span>
                        </span>
                      </button>
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </aside>
  )
}
