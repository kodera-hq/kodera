import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import type { VideoFeed } from '../audio/call'
import VideoStage, { spotlightOf, type VideoStageProps } from './VideoStage'

const ME = '@me:example.test'
const BOB = '@bob:example.test'
const ANA = '@ana:example.test'

const bobCamera: VideoFeed = { key: 'TR_bob', userId: BOB, source: 'camera', local: false }
const anaCamera: VideoFeed = { key: 'TR_ana', userId: ANA, source: 'camera', local: false }
const myCamera: VideoFeed = { key: 'TR_me', userId: ME, source: 'camera', local: true }
const anaScreen: VideoFeed = { key: 'TR_ana_screen', userId: ANA, source: 'screen', local: false }

const NAMES: Record<string, string> = { [BOB]: 'Bob Martin', [ANA]: 'Ana Silva' }

beforeAll(async () => {
  await i18n.changeLanguage('fr')
})

function setup(props: Partial<VideoStageProps> = {}) {
  const detach = vi.fn()
  const attach = vi.fn((_key: string, _element: HTMLVideoElement) => detach)
  const onPresentationChange = vi.fn()
  const view = render(
    <VideoStage
      feeds={[bobCamera, myCamera]}
      attach={attach}
      nameOf={(id) => NAMES[id] ?? id}
      speakers={[]}
      presentation="expanded"
      onPresentationChange={onPresentationChange}
      canPictureInPicture={false}
      {...props}
    />
  )
  return { ...view, attach, detach, onPresentationChange }
}

describe('the spotlight', () => {
  it('is the feed pinned while it lasts, else the first shared screen, else none', () => {
    expect(spotlightOf([bobCamera, myCamera], null)).toBeNull()
    expect(spotlightOf([anaScreen, bobCamera], null)).toBe(anaScreen)
    expect(spotlightOf([anaScreen, bobCamera], 'TR_bob')).toBe(bobCamera)
    expect(spotlightOf([anaScreen, bobCamera], 'TR_gone')).toBe(anaScreen)
  })
})

describe('VideoStage', () => {
  it('draws each camera in its own muted video, named, and lets them go when it goes', () => {
    const { attach, detach, unmount, container } = setup()
    const stage = screen.getByRole('region', { name: 'Vidéo de l’appel' })
    expect(within(stage).getByRole('figure', { name: 'Caméra de Bob Martin' })).toBeInTheDocument()
    expect(within(stage).getByRole('figure', { name: 'Votre caméra' })).toBeInTheDocument()
    expect(attach.mock.calls.map(([key]) => key)).toEqual(['TR_bob', 'TR_me'])
    for (const [, element] of attach.mock.calls) {
      expect(element).toBeInstanceOf(HTMLVideoElement)
      expect(element.muted).toBe(true)
    }
    // The member's own camera, as in a mirror; never by a `style` attribute.
    expect(attach.mock.calls[1]![1]).toHaveClass('-scale-x-100')
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
    unmount()
    expect(detach).toHaveBeenCalledTimes(2)
  })

  it('puts a shared screen in the spotlight, whole, and lets the member pin another feed', async () => {
    const user = userEvent.setup()
    setup({ feeds: [anaScreen, bobCamera, anaCamera] })
    const screenTile = screen.getByRole('figure', { name: 'Écran partagé par Ana Silva' })
    expect(screenTile.querySelector('video')).toHaveClass('object-contain', 'w-full', 'h-full')
    expect(screenTile).toHaveClass('w-full')

    const bob = screen.getByRole('figure', { name: 'Caméra de Bob Martin' })
    await user.click(within(bob).getByRole('button', { name: 'Mettre en avant' }))
    expect(screen.getByRole('figure', { name: 'Caméra de Bob Martin' })).toHaveClass('w-full')
    expect(
      within(screen.getByRole('figure', { name: 'Caméra de Bob Martin' })).getByRole('button', {
        name: 'Ne plus mettre en avant',
      })
    ).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Ne plus mettre en avant' }))
    expect(screen.getByRole('figure', { name: 'Écran partagé par Ana Silva' })).toHaveClass(
      'w-full'
    )
  })

  it('rings the camera of whoever speaks', () => {
    setup({ speakers: [BOB] })
    expect(screen.getByRole('figure', { name: 'Caméra de Bob Martin' })).toHaveAttribute(
      'data-speaking',
      'true'
    )
    expect(screen.getByRole('figure', { name: 'Votre caméra' })).not.toHaveAttribute(
      'data-speaking'
    )
  })

  it('docks as a floating thumbnail of the spotlit feed, and expands again', async () => {
    const user = userEvent.setup()
    const { onPresentationChange, attach, container } = setup({
      presentation: 'docked',
      feeds: [anaScreen, bobCamera],
    })
    const stage = screen.getByRole('region', { name: 'Vidéo de l’appel' })
    expect(stage).toHaveClass('fixed')
    expect(within(stage).getAllByRole('figure')).toHaveLength(1)
    expect(attach.mock.calls.map(([key]) => key)).toEqual(['TR_ana_screen'])
    expect(within(stage).getByText('Écran partagé par Ana Silva · +1')).toBeInTheDocument()
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
    await user.click(within(stage).getByRole('button', { name: 'Agrandir la vidéo' }))
    expect(onPresentationChange).toHaveBeenCalledWith('expanded')
  })

  it('shrinks to the thumbnail from the expanded stage', async () => {
    const user = userEvent.setup()
    const { onPresentationChange } = setup()
    await user.click(screen.getByRole('button', { name: 'Réduire la vidéo en vignette' }))
    expect(onPresentationChange).toHaveBeenCalledWith('docked')
  })

  it('opens the browser’s picture-in-picture for that tile, only where the browser offers it', async () => {
    const user = userEvent.setup()
    const first = setup()
    expect(screen.queryByRole('button', { name: 'Ouvrir en image dans l’image' })).toBeNull()
    first.unmount()

    setup({ canPictureInPicture: true })
    const bob = screen.getByRole('figure', { name: 'Caméra de Bob Martin' })
    const video = bob.querySelector('video')!
    const request = vi.fn(async () => ({}) as PictureInPictureWindow)
    Object.defineProperty(video, 'requestPictureInPicture', { value: request })
    await user.click(within(bob).getByRole('button', { name: 'Ouvrir en image dans l’image' }))
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('draws nothing without video', () => {
    const { container } = setup({ feeds: [] })
    expect(container).toBeEmptyDOMElement()
    act(() => undefined)
  })
})
