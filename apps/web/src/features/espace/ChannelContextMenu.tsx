// The menu a right-click on a channel's row opens (or the context-menu key, or `Shift+F10`, which
// the browser turns into the same `contextmenu` event on the focused row). It is drawn where the
// pointer was, or under the row when the keyboard opened it, and gives the focus back to the row
// when it closes. An action is listed only where the view can carry it out.

import * as RadixDropdownMenu from '@radix-ui/react-dropdown-menu'
import { useTranslation } from 'react-i18next'
import { cssProperty } from '../../ui/cssom'
import { cx } from '../../ui/cx'
import { ActionIcon, type ActionIconName } from '../../ui/icons/ActionIcons'
import { TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'

/** The row the menu was opened on, and where. */
export interface ChannelMenuTarget {
  readonly channelId: string
  readonly label: string
  readonly kind: 'text' | 'audio'
  readonly clientX: number
  readonly clientY: number
  /** The row itself: the focus goes back to it when the menu closes. */
  readonly trigger?: HTMLElement | undefined
}

/** What the view can do with a channel; each absent action is left out of the menu. */
export interface ChannelMenuActions {
  onSettings?: ((target: ChannelMenuTarget) => void) | undefined
  onToggleMute?: ((target: ChannelMenuTarget) => void) | undefined
  /** Whether the channel is muted, which names the toggle. */
  isMuted?: ((channelId: string) => boolean) | undefined
  onInvite?: ((target: ChannelMenuTarget) => void) | undefined
  onCopyLink?: ((target: ChannelMenuTarget) => void) | undefined
  onPermissions?: ((target: ChannelMenuTarget) => void) | undefined
  /** Whether the member administers the channel: only then are its permissions offered. */
  canManage?: ((channelId: string) => boolean) | undefined
}

interface Item {
  key: string
  icon: ActionIconName
  label: string
  run: (target: ChannelMenuTarget) => void
}

/** Where a menu the keyboard opened is drawn: under the row, since the event has no pointer. */
export function menuAnchor(target: ChannelMenuTarget): { x: number; y: number } {
  if (target.clientX !== 0 || target.clientY !== 0 || target.trigger === undefined)
    return { x: target.clientX, y: target.clientY }
  const box = target.trigger.getBoundingClientRect()
  return { x: box.left + 16, y: box.bottom }
}

export function ChannelContextMenu({
  target,
  onClose,
  ...actions
}: ChannelMenuActions & {
  /** The row the menu is open on; `null` while it is closed. */
  target: ChannelMenuTarget | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  if (target === null) return null
  const muted = actions.isMuted?.(target.channelId) === true
  const items: Item[] = [
    ...(actions.onSettings
      ? [
          {
            key: 'settings',
            icon: 'more' as const,
            label: t('console.workspace.channel-menu.action-settings'),
            run: actions.onSettings,
          },
        ]
      : []),
    ...(actions.onToggleMute
      ? [
          {
            key: 'mute',
            icon: muted ? ('bell' as const) : ('bell-off' as const),
            label: t(
              muted
                ? 'console.workspace.channel-menu.action-unmute'
                : 'console.workspace.channel-menu.action-mute'
            ),
            run: actions.onToggleMute,
          },
        ]
      : []),
    ...(actions.onInvite
      ? [
          {
            key: 'invite',
            icon: 'person-plus' as const,
            label: t('console.workspace.channel-menu.action-invite'),
            run: actions.onInvite,
          },
        ]
      : []),
    ...(actions.onCopyLink
      ? [
          {
            key: 'copy',
            icon: 'copy' as const,
            label: t('console.workspace.channel-menu.action-copy-link'),
            run: actions.onCopyLink,
          },
        ]
      : []),
    ...(actions.onPermissions && actions.canManage?.(target.channelId) === true
      ? [
          {
            key: 'permissions',
            icon: 'shield' as const,
            label: t('console.workspace.channel-menu.action-permissions'),
            run: actions.onPermissions,
          },
        ]
      : []),
  ]
  if (items.length === 0) return null
  const { x, y } = menuAnchor(target)
  return (
    <RadixDropdownMenu.Root
      // A new row is a new menu: its highlight and focus start again.
      key={`${target.channelId}:${x}:${y}`}
      open
      modal
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <RadixDropdownMenu.Trigger asChild>
        {/* A point, not a control: what the menu is placed against. */}
        <span
          aria-hidden="true"
          tabIndex={-1}
          data-testid="channel-menu-anchor"
          ref={(element) => {
            cssProperty<HTMLSpanElement>('left', `${x}px`)(element)
            cssProperty<HTMLSpanElement>('top', `${y}px`)(element)
          }}
          className="pointer-events-none fixed h-0 w-0"
        />
      </RadixDropdownMenu.Trigger>
      <RadixDropdownMenu.Portal>
        <RadixDropdownMenu.Content
          aria-label={t('console.workspace.channel-menu.label', { channel: target.label })}
          // Named by its channel, not by the anchor it is placed against.
          aria-labelledby={undefined}
          align="start"
          sideOffset={4}
          onCloseAutoFocus={(event) => {
            if (target.trigger?.isConnected) {
              event.preventDefault()
              target.trigger.focus()
            }
          }}
          className={cx(
            'material-popover z-50 rounded-md border border-c-border p-1 shadow-pop shadow-c-shadow-2',
            'min-w-[200px] focus:outline-hidden'
          )}
        >
          {items.map((item) => (
            <RadixDropdownMenu.Item
              key={item.key}
              onSelect={() => item.run(target)}
              className={cx(
                'flex h-8 cursor-pointer items-center gap-2 rounded-sm px-3 text-sm text-c-ink outline-hidden',
                TOUCH_TARGET_HEIGHT,
                'data-[highlighted]:bg-c-accent-soft data-[highlighted]:text-c-accent-ink',
                'data-[highlighted]:ring-1 data-[highlighted]:ring-c-accent-ink data-[highlighted]:ring-inset'
              )}
            >
              <ActionIcon name={item.icon} />
              {item.label}
            </RadixDropdownMenu.Item>
          ))}
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  )
}
