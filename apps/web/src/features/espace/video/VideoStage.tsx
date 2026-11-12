// The call's video (docs/specs/espace-video-and-screenshare.md): a grid of cameras, or one feed
// in the spotlight with the others in a strip under it. A shared screen takes the spotlight on its
// own; the member pins any other feed there. Its own chunk, loaded once a call has video: a call
// without video never downloads it.
//
// Two presentations. `expanded` sits above the call dock, in the page. `docked` is the
// picture-in-picture thumbnail: the spotlit feed alone, floating in a corner while the member reads
// and writes in any channel of the workspace, which keeps the call (and so this) mounted. Each feed
// can also leave the page in the browser's own picture-in-picture window, where the browser offers
// one.
//
// Every `<video>` is drawn by the call (`attach`), muted: the call's sound plays through its own
// hidden elements. No `style` attribute anywhere: tiles take their shape from classes.

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../../ui/Avatar/Avatar'
import { cx } from '../../../ui/cx'
import { EspaceGlyph, type EspaceGlyphName } from '../../../ui/icons/EspaceGlyph'
import { TOUCH_TARGET } from '../../../ui/touchTarget'
import { Tooltip } from '../../../ui/Tooltip/Tooltip'
import type { VideoFeed } from '../audio/call'

export type StagePresentation = 'expanded' | 'docked'

export interface VideoStageProps {
  feeds: readonly VideoFeed[]
  /** Draws a feed in an element; returns how to stop (`CallController.attachVideo`). */
  attach: (key: string, element: HTMLVideoElement) => () => void
  /** A person's name, as the room gives it. */
  nameOf: (userId: string) => string
  /** Who is speaking now, by Matrix user id: their camera is ringed. */
  speakers: readonly string[]
  presentation: StagePresentation
  onPresentationChange: (presentation: StagePresentation) => void
  /** Whether this browser offers its own picture-in-picture window; detected by default. */
  canPictureInPicture?: boolean
}

function browserPictureInPicture(): boolean {
  return typeof document !== 'undefined' && document.pictureInPictureEnabled === true
}

/** The feed in the spotlight: the one pinned while it lasts, else the first shared screen. */
export function spotlightOf(feeds: readonly VideoFeed[], pinned: string | null): VideoFeed | null {
  return (
    feeds.find((feed) => feed.key === pinned) ??
    feeds.find((feed) => feed.source === 'screen') ??
    null
  )
}

function StageButton({
  label,
  glyph,
  pressed,
  onClick,
}: {
  label: string
  glyph: EspaceGlyphName
  pressed?: boolean
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <Tooltip content={label} names>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
        className={cx(
          'focus-offset flex h-8 w-8 items-center justify-center rounded-md focus-visible:ring focus-visible:ring-offset-2 focus-visible:outline-hidden',
          pressed === true
            ? 'bg-c-on-inverse text-c-inverse'
            : 'bg-c-inverse text-c-on-inverse hover:text-c-on-inverse-dim',
          TOUCH_TARGET
        )}
      >
        <EspaceGlyph name={glyph} />
      </button>
    </Tooltip>
  )
}

interface TileProps {
  feed: VideoFeed
  attach: VideoStageProps['attach']
  label: string
  name: string
  speaking: boolean
  /** The spotlit tile is the large one. */
  large: boolean
  actions?: ReactNode
}

function VideoTile({ feed, attach, label, name, speaking, large, actions }: TileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const element = videoRef.current
    if (element === null) return
    return attach(feed.key, element)
  }, [attach, feed.key])
  return (
    <figure
      aria-label={label}
      data-video-source={feed.source}
      data-speaking={speaking || undefined}
      className={cx(
        'relative m-0 aspect-video min-w-0 overflow-hidden rounded-lg bg-c-inverse',
        speaking && feed.source === 'camera' ? 'ring-2 ring-c-ok-on-dark' : '',
        large ? 'w-full' : ''
      )}
    >
      {/* No caption track: the video is muted, and the call's sound plays elsewhere. */}
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        className={cx(
          'h-full w-full',
          // A screen shows whole, text and all; a camera fills its tile. The member sees their own
          // camera as in a mirror, as every call application shows it.
          feed.source === 'screen' ? 'object-contain' : 'object-cover',
          feed.local && feed.source === 'camera' ? '-scale-x-100' : ''
        )}
      />
      <figcaption className="absolute bottom-2 left-2 flex max-w-[80%] items-center gap-2 rounded-md bg-c-inverse px-2 py-1 text-xs text-c-on-inverse">
        {large ? null : <Avatar name={name} identity={feed.userId} size="xs" />}
        <span className="truncate">{label}</span>
      </figcaption>
      {actions === undefined ? null : (
        <div className="absolute top-2 right-2 flex gap-1">{actions}</div>
      )}
    </figure>
  )
}

export default function VideoStage({
  feeds,
  attach,
  nameOf,
  speakers,
  presentation,
  onPresentationChange,
  canPictureInPicture = browserPictureInPicture(),
}: VideoStageProps) {
  const { t } = useTranslation()
  const [pinned, setPinned] = useState<string | null>(null)
  if (feeds.length === 0) return null
  const spotlight = spotlightOf(feeds, pinned)

  const labelOf = (feed: VideoFeed) => {
    if (feed.local) {
      return feed.source === 'screen'
        ? t('console.workspace.audio.label-your-screen')
        : t('console.workspace.audio.label-your-camera')
    }
    const name = nameOf(feed.userId)
    return feed.source === 'screen'
      ? t('console.workspace.audio.label-screen-of', { name })
      : t('console.workspace.audio.label-camera-of', { name })
  }
  const openPictureInPicture = (event: MouseEvent<HTMLButtonElement>) => {
    // The tile's own video, the button's neighbour. From the click: the browser opens its window
    // from a gesture only.
    const element = event.currentTarget.closest('figure')?.querySelector('video')
    void element?.requestPictureInPicture?.().catch(() => undefined)
  }
  const tile = (feed: VideoFeed, large: boolean, docked = false) => (
    <VideoTile
      key={feed.key}
      feed={feed}
      attach={attach}
      label={labelOf(feed)}
      name={nameOf(feed.userId)}
      speaking={speakers.includes(feed.userId)}
      large={large}
      actions={
        <>
          {docked ? null : (
            <StageButton
              label={t(
                spotlight?.key === feed.key && pinned === feed.key
                  ? 'console.workspace.audio.action-unspotlight'
                  : 'console.workspace.audio.action-spotlight'
              )}
              glyph="spotlight"
              pressed={pinned === feed.key}
              onClick={() => setPinned(pinned === feed.key ? null : feed.key)}
            />
          )}
          {canPictureInPicture ? (
            <StageButton
              label={t('console.workspace.audio.action-picture-in-picture')}
              glyph="picture-in-picture"
              onClick={openPictureInPicture}
            />
          ) : null}
        </>
      }
    />
  )

  const label = t('console.workspace.audio.label-stage')
  if (presentation === 'docked') {
    const shown = spotlight ?? feeds[0]!
    return (
      <section
        aria-label={label}
        data-stage="docked"
        className="fixed right-4 bottom-4 z-40 flex w-[320px] flex-col gap-2 rounded-lg bg-c-inverse p-2 shadow-pop shadow-c-shadow-2"
      >
        {tile(shown, true, true)}
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-c-on-inverse-dim">
            {feeds.length > 1 ? `${labelOf(shown)} · +${feeds.length - 1}` : labelOf(shown)}
          </span>
          <StageButton
            label={t('console.workspace.audio.action-expand-stage')}
            glyph="expand"
            onClick={() => onPresentationChange('expanded')}
          />
        </div>
      </section>
    )
  }

  const others = feeds.filter((feed) => feed.key !== spotlight?.key)
  return (
    <section aria-label={label} data-stage="expanded" className="mx-2 flex flex-col gap-2">
      <div className="flex justify-end">
        <StageButton
          label={t('console.workspace.audio.action-dock-stage')}
          glyph="shrink"
          onClick={() => onPresentationChange('docked')}
        />
      </div>
      {spotlight === null ? (
        <ul
          className={cx(
            'm-0 grid list-none gap-2 p-0',
            feeds.length === 1 ? 'grid-cols-1' : 'grid-cols-2 narrow:grid-cols-1',
            feeds.length > 4 ? 'lg:grid-cols-3' : ''
          )}
        >
          {feeds.map((feed) => (
            <li key={feed.key} className="min-w-0">
              {tile(feed, false)}
            </li>
          ))}
        </ul>
      ) : (
        <>
          {tile(spotlight, true)}
          {others.length === 0 ? null : (
            <ul className="m-0 grid list-none grid-cols-4 gap-2 p-0 narrow:grid-cols-2">
              {others.map((feed) => (
                <li key={feed.key} className="min-w-0">
                  {tile(feed, false)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
