import * as Popover from '@radix-ui/react-popover'
import { useId, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../ui/Avatar/Avatar'
import { Button } from '../../ui/Button/Button'
import { CloseIcon } from '../../ui/icons/Close'
import { profileMessages } from './profileMessages'
import type { ProfilePresence } from './localProfile'

export type MemberProfileRole = 'maintainer' | 'core' | 'partner' | 'member' | 'admin'
export interface MemberProfile {
  userId: string
  name: string
  presence: ProfilePresence
  role: MemberProfileRole
  status?: string
}
export function UserProfilePopover({
  member,
  trigger,
  onMention,
}: {
  member: MemberProfile
  trigger: ReactElement
  onMention?: ((member: MemberProfile) => void) | undefined
}) {
  const { i18n } = useTranslation()
  const copy = profileMessages(i18n.resolvedLanguage)
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const mentioning = useRef(false)
  const title = useId()
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setFeedback('')
      }}
    >
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setOpen(false)
            }
          }}
          aria-labelledby={title}
          side="left"
          align="start"
          sideOffset={8}
          onCloseAutoFocus={(event) => {
            if (mentioning.current) {
              event.preventDefault()
              mentioning.current = false
              onMention?.(member)
            }
          }}
          className="z-50 w-shell-sidebar-width max-w-full overflow-hidden rounded-xl border border-c-border bg-c-elevated shadow-pop shadow-c-shadow-2"
        >
          <div className="flex items-center justify-between bg-c-accent-soft p-4">
            <Avatar
              name={member.name}
              identity={member.userId}
              size="lg"
              onlineLabel={member.presence === 'offline' ? undefined : copy[member.presence]}
            />
            <Popover.Close asChild>
              <Button
                size="sm"
                variant="tertiary"
                iconOnly
                icon={<CloseIcon />}
                aria-label={copy.close}
              />
            </Popover.Close>
          </div>
          <div className="flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-1">
              <h2 id={title} className="text-lg font-bold text-c-ink">
                {member.name}
              </h2>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-sm bg-c-muted px-2 py-1 font-semibold text-c-ink-2">
                  {copy[member.role]}
                </span>
                <span className="text-c-ink-3">{copy[member.presence]}</span>
              </div>
              {member.status ? <p className="text-sm text-c-ink-2">{member.status}</p> : null}
            </div>
            <div className="flex flex-col gap-2 border-t border-c-border-soft pt-3">
              <p className="font-mono text-xs break-all text-c-ink-2 select-text">
                {member.userId}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(member.userId)
                    .then(() => setFeedback(copy.copied))
                    .catch(() => setFeedback(copy.copyError))
                  if (!navigator.clipboard) setFeedback(copy.copyError)
                }}
              >
                {copy.copy}
              </Button>
              {feedback ? (
                <p role="status" className="text-xs text-c-ink-2">
                  {feedback}
                </p>
              ) : null}
              {onMention ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    mentioning.current = true
                    setOpen(false)
                  }}
                >
                  {copy.mention}
                </Button>
              ) : null}
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
