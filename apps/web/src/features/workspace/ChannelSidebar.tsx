// The workspace's categories and channels (docs/specs/11-workspace.md §4.1), drawn as a column
// beside the channel in the wide layout and inside the « Salons » drawer on a phone.
//
// A category is a disclosure button over its list; a text channel whose room exists is a router
// link, so choosing one is a route change and `RouteFocus` announces it and moves focus to its
// heading. A channel whose room does not exist yet (quick-workspace SPEC W2) is drawn greyed, says
// so, and cannot be chosen; an audio channel is joined from the live workspace, so here it is only
// named. Everything is reached with `Tab`: a list this short needs no roving focus of its own.

import { Link, useNavigate } from '@tanstack/react-router'
import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../../ui/cx'
import { EspaceGlyph } from '../../ui/icons/EspaceGlyph'
import { CURRENT_BAR_ACCENT } from '../../ui/currentBar'
import { TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'
import { ChannelSearch } from './ChannelSearch'
import type { ChannelSearchEntry } from './ChannelSearch'
import { OrganisationHeader } from './OrganisationHeader'
import { categoryLabel, channelLabel, channelUsable } from './workspace'
import type { Workspace, WorkspaceCategory, WorkspaceChannel } from './workspace'

const ROW =
  'relative flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-sm transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring'

interface ChannelLinkProps {
  org: string
  channel: WorkspaceChannel
  current: boolean
  onNavigate?: () => void
}

/** A channel nothing can be done with here: its room is being prepared, or it is an audio
 * channel, joined from the live workspace. */
function ChannelEntry({ channel }: { channel: WorkspaceChannel }) {
  const { t } = useTranslation()
  const preparing = !channelUsable(channel)
  return (
    <li
      className={cx(
        ROW,
        TOUCH_TARGET_HEIGHT,
        'border border-transparent font-medium',
        preparing ? 'text-c-ink-3' : 'text-c-ink-2'
      )}
    >
      <span aria-hidden="true" className="text-c-ink-3">
        {channel.kind === 'audio' ? <EspaceGlyph name="speaker" /> : '#'}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {channelLabel(channel, t)}
        {/* The glyph is decoration: the kind is said in words. */}
        {channel.kind === 'audio' ? (
          <span className="sr-only">, {t('console.workspace.search.label-audio')}</span>
        ) : null}
      </span>
      {channel.lifecycle === 'archived' ? (
        <span className="text-xs">{t('console.workspace.channel.label-archived')}</span>
      ) : null}
      {preparing ? (
        <span className="text-xs">{t('console.workspace.channel.label-preparing')}</span>
      ) : null}
    </li>
  )
}

function ChannelRow({ org, channel, current, onNavigate }: ChannelLinkProps) {
  return channel.kind === 'text' && channelUsable(channel) ? (
    <ChannelLink
      org={org}
      channel={channel}
      current={current}
      {...(onNavigate === undefined ? {} : { onNavigate })}
    />
  ) : (
    <ChannelEntry channel={channel} />
  )
}

function ChannelLink({ org, channel, current, onNavigate }: ChannelLinkProps) {
  const { t } = useTranslation()
  return (
    <li>
      <Link
        to="/$org/workspace/$channelId"
        params={{ org, channelId: channel.id }}
        aria-current={current ? 'page' : undefined}
        {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
        className={cx(
          ROW,
          TOUCH_TARGET_HEIGHT,
          // The dark workspace reference's current channel (docs/specs/workspace-dark-roles.md):
          // the tinted row and a 3 px `c-accent-ink` start bar, so it is told apart by more than
          // its colour; no edge (the console sidebar keeps its own rule). The transparent border
          // keeps every label where it was.
          'border border-transparent',
          current
            ? `bg-c-accent-soft font-semibold text-c-accent-ink ${CURRENT_BAR_ACCENT}`
            : 'font-medium text-c-ink-2 hover:bg-c-muted'
        )}
      >
        <span aria-hidden="true" className={current ? 'text-c-accent-ink' : 'text-c-ink-3'}>
          #
        </span>
        <span className="min-w-0 flex-1 truncate">{channelLabel(channel, t)}</span>
        {channel.lifecycle === 'archived' ? (
          <span className="text-xs text-c-ink-3">
            {t('console.workspace.channel.label-archived')}
          </span>
        ) : null}
      </Link>
    </li>
  )
}

interface CategoryGroupProps {
  org: string
  category: WorkspaceCategory
  currentId: string | undefined
  onNavigate?: () => void
}

function CategoryGroup({ org, category, currentId, onNavigate }: CategoryGroupProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const listId = useId()
  const channels = category.channels
  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className={cx(ROW, TOUCH_TARGET_HEIGHT, 'font-semibold text-c-ink-3 hover:bg-c-muted')}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={cx(
            'h-4 w-4 shrink-0 transition-transform duration-fast',
            !open && '-rotate-90'
          )}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        <span className="min-w-0 flex-1 truncate text-left">{categoryLabel(category, t)}</span>
      </button>
      <div id={listId} hidden={!open}>
        {channels.length === 0 ? (
          <p className="px-2 py-1 text-sm text-c-ink-3">
            {t('console.workspace.sidebar.empty-category')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {channels.map((channel) => (
              <ChannelRow
                key={channel.id}
                org={org}
                channel={channel}
                current={channel.id === currentId}
                {...(onNavigate === undefined ? {} : { onNavigate })}
              />
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

export interface ChannelSidebarProps {
  org: string
  organisationName: string
  workspace: Workspace
  currentId: string | undefined
  /** `column` beside the channel; `drawer` inside the narrow layout's « Salons » sheet, whose
   * title already names the list. */
  variant: 'column' | 'drawer'
  /** Called when a channel is chosen, so the drawer can close. */
  onNavigate?: () => void
  actionSlot?: ReactNode
}

export function ChannelSidebar({
  org,
  organisationName,
  workspace,
  currentId,
  variant,
  onNavigate,
  actionSlot,
}: ChannelSidebarProps) {
  const { t } = useTranslation()
  const headingId = useId()
  const routerNavigate = useNavigate()
  const uncategorised = workspace.uncategorised_channels
  const navigate = onNavigate === undefined ? {} : { onNavigate }
  // Only what a row would open: a text channel whose room exists.
  const openable = (channels: readonly WorkspaceChannel[]) =>
    channels.filter((channel) => channel.kind === 'text' && channelUsable(channel))
  const searchEntries: ChannelSearchEntry[] = [
    ...workspace.categories.flatMap((category) =>
      openable(category.channels).map((channel) => ({
        id: channel.id,
        label: channelLabel(channel, t),
        kind: 'text' as const,
        category: categoryLabel(category, t),
      }))
    ),
    ...openable(uncategorised).map((channel) => ({
      id: channel.id,
      label: channelLabel(channel, t),
      kind: 'text' as const,
    })),
  ]

  function openFromSearch(entry: ChannelSearchEntry): HTMLElement | null {
    void routerNavigate({ to: '/$org/workspace/$channelId', params: { org, channelId: entry.id } })
    // The channel's heading: `RouteFocus` focuses it after the navigation, so both agree.
    return document.querySelector<HTMLElement>('[data-route-heading]')
  }

  return (
    <nav
      aria-labelledby={headingId}
      className={cx(
        'flex flex-col gap-4',
        variant === 'column' &&
          'order-first w-shell-sidebar-width shrink-0 overflow-y-auto border-r border-c-border-soft bg-c-sunken p-3'
      )}
    >
      {variant === 'column' ? (
        // The organisation, then the search, as on the reference screen (p02): the drawer's own
        // title already names the list, and the phone's top bar carries the organisation.
        <div className="flex flex-col gap-3">
          <OrganisationHeader name={organisationName} slug={org} />
          <h2 id={headingId} className="sr-only">
            {t('console.workspace.sidebar.title')}
          </h2>
          <ChannelSearch entries={searchEntries} onChoose={openFromSearch} shortcut />
        </div>
      ) : (
        <div className="flex flex-col gap-1 px-2">
          <p className="truncate text-md font-semibold text-c-ink">{organisationName}</p>
          <h2 id={headingId} className="sr-only">
            {t('console.workspace.sidebar.title')}
          </h2>
        </div>
      )}
      {actionSlot}
      <ul className="flex flex-col gap-3">
        {workspace.categories.map((category) => (
          <CategoryGroup
            key={category.id}
            org={org}
            category={category}
            currentId={currentId}
            {...navigate}
          />
        ))}
        {uncategorised.length === 0 ? null : (
          <li>
            <ul className="flex flex-col gap-1">
              {uncategorised.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  org={org}
                  channel={channel}
                  current={channel.id === currentId}
                  {...navigate}
                />
              ))}
            </ul>
          </li>
        )}
      </ul>
    </nav>
  )
}
