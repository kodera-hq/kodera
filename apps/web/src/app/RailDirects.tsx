// The module rail's direct conversations (`railDirectsStore.ts`): a crisp « Messages privés » icon
// button, and under it the faces of the people with unread messages, each with its count, and of
// the one on screen. Icons and faces only: each name is the control's accessible name and tooltip.

import { useTranslation } from 'react-i18next'
import { useAvatarSrc } from '../features/espace/useAvatarSrc'
import { Avatar } from '../ui/Avatar/Avatar'
import { cx } from '../ui/cx'
import { ActionIcon } from '../ui/icons/ActionIcons'
import { RAIL_TIP_OFFSET } from '../ui/Rail/Rail'
import { Tooltip } from '../ui/Tooltip/Tooltip'
import { railFaces, useRailDirects, type RailDirect, type RailDirects } from './railDirectsStore'

const RAIL_BUTTON =
  'relative flex h-12 w-12 items-center justify-center rounded-lg transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring focus-visible:ring-c-on-inverse'

function Face({ direct, directs }: { direct: RailDirect; directs: RailDirects }) {
  const { t } = useTranslation()
  const src = useAvatarSrc(directs.avatars, direct.avatarMxc)
  const label =
    direct.unread > 0
      ? `${direct.name}, ${t('console.workspace.directs.rail-unread', { count: direct.unread })}`
      : direct.name
  return (
    <li>
      <Tooltip content={label} side="right" sideOffset={RAIL_TIP_OFFSET} names>
        <button
          type="button"
          aria-label={label}
          aria-current={direct.active ? 'page' : undefined}
          onClick={() => directs.onOpen(direct.roomId)}
          className={cx(RAIL_BUTTON, 'hover:bg-c-inverse-2', direct.active ? 'bg-c-inverse-2' : '')}
        >
          {direct.active ? (
            <span
              aria-hidden="true"
              className="absolute top-4 left-1 h-4 w-1 rounded-sm bg-c-on-inverse"
            />
          ) : null}
          <Avatar
            name={direct.name}
            identity={direct.userId ?? direct.roomId}
            size="lg"
            aria-hidden="true"
            {...(src === undefined ? {} : { src })}
          />
          {direct.unread > 0 ? (
            <span
              aria-hidden="true"
              data-testid="rail-direct-badge"
              className="absolute right-[2px] bottom-[2px] flex h-5 min-w-5 items-center justify-center rounded-full bg-c-bad px-1 text-xs font-bold text-c-on-inverse ring-2 ring-c-inverse"
            >
              {direct.unread > 99 ? '99+' : direct.unread}
            </span>
          ) : null}
        </button>
      </Tooltip>
    </li>
  )
}

export function RailDirectsGroup() {
  const { t } = useTranslation()
  const directs = useRailDirects()
  if (directs === null) return null
  const faces = railFaces(directs.items)
  const title = t('console.workspace.directs.rail-title')
  return (
    <ul aria-label={title} className="flex w-full flex-col items-center gap-1">
      <li>
        <Tooltip content={title} side="right" sideOffset={RAIL_TIP_OFFSET} names>
          <button
            type="button"
            aria-label={title}
            onClick={directs.onOpenAll}
            className={cx(
              RAIL_BUTTON,
              'text-c-on-inverse-dim hover:bg-c-inverse-2 hover:text-c-on-inverse'
            )}
          >
            <ActionIcon name="direct" className="h-5 w-5" />
          </button>
        </Tooltip>
      </li>
      {faces.map((direct) => (
        <Face key={direct.roomId} direct={direct} directs={directs} />
      ))}
    </ul>
  )
}
