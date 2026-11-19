// The call's video (docs/specs/espace-video-and-screenshare.md): a grid of cameras, or one feed
// in the spotlight with the others in a strip under it. A shared screen takes the spotlight on its
// own; the member pins any other feed there. Its own chunk, loaded once a call has video: a call
// without video never downloads it.
//
// Two presentations. `expanded` sits inside the bounded call stage. `docked` is the compact
// picture-in-picture thumbnail: the spotlit feed alone, positioned clear of the composer and call
// controls while the member reads and writes in any channel of the workspace. Each feed can also
// leave the page in the browser's own picture-in-picture window, where the browser offers one.
//
// Every `<video>` is drawn by the call (`attach`), muted: the call's sound plays through its own
// hidden elements. Until frames actually decode (`readyState >= 2 && videoWidth > 0`), the raw
// `<video>` stays hidden behind an avatar + name + speaking ring + connection quality card so an
// un-decoded track never renders as an empty black box. Entering native Picture-in-Picture strips
// `-scale-x-100` so browser placeholder text is never mirrored backwards, and leaving PiP restores
// the member's mirror preference. No `style` attribute anywhere: tiles take their shape from classes.

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ConnectionQualityBars, type SignalQuality } from '../../../ui/AudioDock/AudioDock'
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
  /** Per-participant connection quality, keyed by Matrix user id. */
  qualities?: Readonly<Record<string, SignalQuality>>
  /** Compact mini-preview mode inside the detached floating call pill. */
  compactPreview?: boolean
}

function browserPictureInPicture(): boolean {
  return typeof document !== 'undefined' && document.pictureInPictureEnabled === true
}

/** True only once the browser has decoded at least one non-empty video frame. */
export function hasDecodedVideoFrame(video: HTMLVideoElement | null): boolean {
  return video !== null && video.readyState >= 2 && video.videoWidth > 0
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

const FRAME_EVENTS = [
  'loadeddata',
  'loadedmetadata',
  'resize',
  'playing',
  'canplay',
  'emptied',
  'ended',
] as const

interface TileProps {
  feed: VideoFeed
  attach: VideoStageProps['attach']
  label: string
  name: string
  speaking: boolean
  quality: SignalQuality | undefined
  /** The spotlit tile is the large one. */
  large: boolean
  compactPreview: boolean
  mirrored: boolean
  actions?: ReactNode
}

function VideoTile({
  feed,
  attach,
  label,
  name,
  speaking,
  quality,
  large,
  compactPreview,
  mirrored,
  actions,
}: TileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [prevKey, setPrevKey] = useState(feed.key)
  const [frameReady, setFrameReady] = useState(false)
  const [inPip, setInPip] = useState(false)
  if (prevKey !== feed.key) {
    setPrevKey(feed.key)
    setFrameReady(false)
    setInPip(false)
  }

  useEffect(() => {
    const element = videoRef.current
    if (element === null) return
    const detach = attach(feed.key, element)
    const syncFrame = () => {
      setFrameReady(hasDecodedVideoFrame(element))
    }
    const onEnterPip = () => setInPip(true)
    const onLeavePip = () => setInPip(false)
    syncFrame()
    if (typeof document !== 'undefined' && document.pictureInPictureElement === element) {
      setInPip(true)
    }
    for (const eventName of FRAME_EVENTS) {
      element.addEventListener(eventName, syncFrame)
    }
    element.addEventListener('enterpictureinpicture', onEnterPip)
    element.addEventListener('leavepictureinpicture', onLeavePip)
    return () => {
      for (const eventName of FRAME_EVENTS) {
        element.removeEventListener(eventName, syncFrame)
      }
      element.removeEventListener('enterpictureinpicture', onEnterPip)
      element.removeEventListener('leavepictureinpicture', onLeavePip)
      detach()
    }
  }, [attach, feed.key])

  const effectiveMirror = mirrored && !inPip && feed.source === 'camera'

  return (
    <figure
      aria-label={label}
      data-video-source={feed.source}
      data-speaking={speaking || undefined}
      className={cx(
        'relative m-0 aspect-video min-w-0 overflow-hidden rounded-lg bg-c-inverse-2',
        speaking && feed.source === 'camera'
          ? 'ring-2 ring-c-ok-on-dark'
          : 'border border-c-on-inverse-dim',
        large ? 'max-h-[400px] w-full' : 'max-h-[320px]'
      )}
    >
      {/* No caption track: the video is muted, and the call's sound plays elsewhere. */}
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        data-video-ready={frameReady ? 'true' : 'false'}
        className={cx(
          'h-full w-full transition-opacity duration-fast',
          // A screen shows whole, text and all; a camera fills its tile. The member sees their own
          // camera as in a mirror unless disabled or currently inside native Picture-in-Picture.
          feed.source === 'screen' ? 'object-contain' : 'object-cover',
          effectiveMirror ? '-scale-x-100' : '',
          frameReady ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      />
      {frameReady ? null : (
        <div
          data-testid="video-avatar-fallback"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-c-inverse-2 p-3 text-c-on-inverse"
        >
          <Avatar
            name={name}
            identity={feed.userId}
            size={compactPreview ? 'md' : 'lg'}
            className={speaking ? 'ring-2 ring-c-ok-on-dark' : ''}
          />
          <div className="flex max-w-full items-center gap-2 px-2">
            <span className="truncate text-xs font-semibold text-c-on-inverse">{name}</span>
            <ConnectionQualityBars quality={quality} status="connected" />
          </div>
        </div>
      )}
      <figcaption className="absolute bottom-2 left-2 z-10 flex max-w-[80%] items-center gap-2 rounded-md bg-c-inverse px-2 py-1 text-xs text-c-on-inverse">
        {large ? null : <Avatar name={name} identity={feed.userId} size="xs" />}
        <span className="truncate">{label}</span>
        {frameReady ? <ConnectionQualityBars quality={quality} status="connected" /> : null}
      </figcaption>
      {actions === undefined ? null : (
        <div className="absolute top-2 right-2 z-10 flex gap-1">{actions}</div>
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
  qualities,
  compactPreview = false,
}: VideoStageProps) {
  const { t } = useTranslation()
  const [pinned, setPinned] = useState<string | null>(null)
  const [mirrorLocal, setMirrorLocal] = useState(true)
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
  const tile = (feed: VideoFeed, large: boolean, docked = false) => {
    const isLocalCamera = feed.local && feed.source === 'camera'
    return (
      <VideoTile
        key={feed.key}
        feed={feed}
        attach={attach}
        label={labelOf(feed)}
        name={nameOf(feed.userId)}
        speaking={speakers.includes(feed.userId)}
        quality={qualities?.[feed.userId]}
        large={large}
        compactPreview={compactPreview}
        mirrored={isLocalCamera ? mirrorLocal : false}
        actions={
          <>
            {isLocalCamera ? (
              <StageButton
                label={t(
                  mirrorLocal
                    ? 'console.workspace.audio.action-mirror-off'
                    : 'console.workspace.audio.action-mirror-on'
                )}
                glyph="mirror"
                pressed={mirrorLocal}
                onClick={() => setMirrorLocal((value) => !value)}
              />
            ) : null}
            {docked || compactPreview ? null : (
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
  }

  const label = t('console.workspace.audio.label-stage')
  const shown = spotlight ?? feeds[0]!
  const singleTileMode = compactPreview || presentation === 'docked'
  const visibleFeeds = singleTileMode ? [shown] : feeds

  return (
    <section
      aria-label={label}
      data-stage={compactPreview ? 'preview' : presentation}
      className={
        compactPreview
          ? 'w-full'
          : presentation === 'docked'
            ? 'fixed top-[68px] right-4 z-30 flex w-[320px] max-w-[calc(100vw-32px)] flex-col gap-2 rounded-lg bg-c-inverse p-2 shadow-pop shadow-c-shadow-2'
            : 'mx-2 flex min-h-0 flex-col gap-2 pt-2'
      }
    >
      {!singleTileMode ? (
        <div className="flex justify-end">
          <StageButton
            label={t('console.workspace.audio.action-dock-stage')}
            glyph="shrink"
            onClick={() => onPresentationChange('docked')}
          />
        </div>
      ) : null}
      <ul
        className={cx(
          'm-0 grid list-none gap-2 p-0',
          singleTileMode || feeds.length === 1
            ? 'grid-cols-1'
            : spotlight !== null
              ? 'grid-cols-4 narrow:grid-cols-2'
              : cx('grid-cols-2 narrow:grid-cols-1', feeds.length > 4 ? 'lg:grid-cols-3' : '')
        )}
      >
        {visibleFeeds.map((feed) => {
          const isSpotlight = !singleTileMode && spotlight?.key === feed.key
          return (
            <li
              key={feed.key}
              className={cx('min-w-0', isSpotlight ? 'order-first col-span-full' : '')}
            >
              {tile(feed, singleTileMode || isSpotlight, singleTileMode)}
            </li>
          )
        })}
      </ul>
      {!compactPreview && presentation === 'docked' ? (
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
      ) : null}
    </section>
  )
}
