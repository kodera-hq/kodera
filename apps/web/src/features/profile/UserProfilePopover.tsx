// A member's Kodera Passport, opened from their avatar, their name, a mention of them or their row
// in the member list: the card (`PassportCard`) with its accent, portrait, pills and bio, and
// under it what one can do with them in one press: copy their id, mention them, write to them.

import * as Popover from '@radix-ui/react-popover'
import { useCallback, useId, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { ActionIcon, type ActionIconName } from '../../ui/icons/ActionIcons'
import { CloseIcon } from '../../ui/icons/Close'
import { MentionIcon, SendIcon } from '../../ui/icons/Composer'
import { Tooltip } from '../../ui/Tooltip/Tooltip'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import { useAvatarSrc } from '../espace/useAvatarSrc'
import { useStoreSlice } from '../espace/useStoreSlice'
import type { ProfilePresence } from './localProfile'
import { EMPTY_PASSPORT, type Passport } from './passport'
import { PassportCard } from './PassportCard'
import { usePassportServices, type PassportServices } from './passportContext'
import { profileMessages } from './profileMessages'

export type MemberProfileRole = 'maintainer' | 'core' | 'partner' | 'member' | 'admin'
export interface MemberProfile {
  userId: string
  name: string
  presence: ProfilePresence
  role: MemberProfileRole
  status?: string
  /** Their avatar in the room, an `mxc://` address. */
  avatarMxc?: string | undefined
}

const CARD_TOOL = cx(
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-c-ink-3',
  'hover:bg-c-sunken hover:text-c-ink focus-visible:ring focus-visible:outline-hidden',
  'disabled:cursor-not-allowed disabled:text-c-on-disabled disabled:hover:bg-transparent',
  TOUCH_TARGET
)

function CardTool({
  icon,
  label,
  onClick,
}: {
  icon: ActionIconName | ReactElement
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip content={label} names>
      <button type="button" aria-label={label} onClick={onClick} className={CARD_TOOL}>
        {typeof icon === 'string' ? <ActionIcon name={icon} /> : icon}
      </button>
    </Tooltip>
  )
}

const noSubscription = () => () => {}
const noSnapshot = () => null

function usePassport(services: PassportServices | null, userId: string): Passport {
  const read = useCallback(() => services?.getPassport?.(userId), [services, userId])
  return (
    useStoreSlice(
      services?.subscribe ?? noSubscription,
      services?.getSnapshot ?? noSnapshot,
      read
    ) ?? EMPTY_PASSPORT
  )
}

/** The one-line message field under the card: Enter or the send icon writes to the member. */
function DirectField({
  member,
  send,
}: {
  member: MemberProfile
  send: (userId: string, text: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const fieldId = useId()
  const [text, setText] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const body = text.trim()
    if (body === '' || state === 'sending') return
    setState('sending')
    send(member.userId, body).then(
      () => {
        setText('')
        setState('sent')
      },
      () => setState('failed')
    )
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <label htmlFor={fieldId} className="sr-only">
        {t('console.workspace.passport.dm-label', { name: member.name })}
      </label>
      <div className="flex items-center gap-1 rounded-lg border border-c-border-input bg-c-muted pl-2 focus-within:ring">
        <input
          id={fieldId}
          value={text}
          maxLength={2000}
          autoComplete="off"
          placeholder={t('console.workspace.passport.dm-placeholder', { name: member.name })}
          onChange={(event) => {
            setText(event.target.value)
            if (state !== 'sending') setState('idle')
          }}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm text-c-ink outline-hidden placeholder:text-c-placeholder"
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          icon={<SendIcon />}
          iconOnly
          aria-label={t('console.workspace.passport.dm-send', { name: member.name })}
          disabled={text.trim() === '' || state === 'sending'}
        />
      </div>
      <p role="status" className="text-xs text-c-ink-2 empty:sr-only">
        {state === 'sent'
          ? t('console.workspace.passport.dm-sent')
          : state === 'failed'
            ? t('console.workspace.passport.dm-error')
            : ''}
      </p>
    </form>
  )
}

function PassportContent({
  member,
  title,
  onMention,
  onClose,
}: {
  member: MemberProfile
  title: string
  onMention: (() => void) | undefined
  onClose: () => void
}) {
  const { i18n } = useTranslation()
  const copy = profileMessages(i18n.resolvedLanguage)
  const services = usePassportServices()
  const passport = usePassport(services, member.userId)
  const avatarSrc = useAvatarSrc(services?.avatars, member.avatarMxc)
  const [feedback, setFeedback] = useState('')
  const bio = member.status || passport.bio
  return (
    <PassportCard
      name={member.name}
      userId={member.userId}
      avatarSrc={avatarSrc}
      presenceLabel={member.presence === 'offline' ? undefined : copy[member.presence]}
      accent={passport.accent}
      role={copy[member.role]}
      tags={passport.tags}
      bio={bio}
      headingId={title}
      corner={
        <Tooltip content={copy.close} names>
          <button
            type="button"
            aria-label={copy.close}
            onClick={onClose}
            className={cx(CARD_TOOL, 'bg-c-elevated')}
          >
            <CloseIcon />
          </button>
        </Tooltip>
      }
    >
      <div className="flex flex-col gap-2 border-t border-c-border-soft pt-3">
        <div className="flex items-center gap-1">
          <CardTool
            icon="copy"
            label={copy.copy}
            onClick={() => {
              if (!navigator.clipboard) {
                setFeedback(copy.copyError)
                return
              }
              void navigator.clipboard
                .writeText(member.userId)
                .then(() => setFeedback(copy.copied))
                .catch(() => setFeedback(copy.copyError))
            }}
          />
          {onMention ? (
            <CardTool icon={<MentionIcon />} label={copy.mention} onClick={onMention} />
          ) : null}
        </div>
        {feedback ? (
          <p role="status" className="text-xs text-c-ink-2">
            {feedback}
          </p>
        ) : null}
        {services?.sendDirect === undefined || onMention === undefined ? null : (
          <DirectField member={member} send={services.sendDirect} />
        )}
      </div>
    </PassportCard>
  )
}

export function UserProfilePopover({
  member,
  trigger,
  anchor,
  onAnchorClose,
  onMention,
}: {
  member: MemberProfile
  /** The control that opens the card, or `anchor` for a card opened from elsewhere. */
  trigger?: ReactElement | undefined
  /** A card opened on an element it does not own (a mention pill): open while it is set. */
  anchor?: HTMLElement | undefined
  onAnchorClose?: (() => void) | undefined
  /** Absent for the member's own card, and where they may not write: no mention, no message. */
  onMention?: ((member: MemberProfile) => void) | undefined
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = anchor === undefined ? ownOpen : true
  const setOpen = (next: boolean) => {
    if (anchor === undefined) setOwnOpen(next)
    else if (!next) onAnchorClose?.()
  }
  const mentioning = useRef(false)
  const title = useId()
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {anchor === undefined ? (
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      ) : (
        <Popover.Anchor virtualRef={{ current: anchor }} />
      )}
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
          side={anchor === undefined ? 'left' : 'top'}
          align="start"
          sideOffset={8}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            if (mentioning.current) {
              event.preventDefault()
              mentioning.current = false
              onMention?.(member)
            } else if (anchor !== undefined && anchor.isConnected) {
              event.preventDefault()
              anchor.focus()
            }
          }}
          className="z-50 w-shell-sidebar-width max-w-full overflow-hidden rounded-xl border border-c-border bg-c-elevated shadow-pop shadow-c-shadow-2"
        >
          <PassportContent
            member={member}
            title={title}
            onClose={() => setOpen(false)}
            onMention={
              onMention === undefined
                ? undefined
                : () => {
                    mentioning.current = true
                    setOpen(false)
                  }
            }
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
