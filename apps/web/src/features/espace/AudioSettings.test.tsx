import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { SoundEngine } from '../sounds'
import { AudioSettings, type AudioSettingsCall } from './AudioSettings'
import type { AudioDeviceChoice, AudioDevices } from './audio/devices'

const DEVICES: AudioDevices = {
  inputs: [
    { id: 'mac-mic', label: 'Micro MacBook' },
    { id: 'headset-mic', label: 'Casque Jabra' },
  ],
  outputs: [
    { id: 'speakers', label: 'Haut-parleurs MacBook' },
    { id: 'headset', label: 'Casque Jabra' },
  ],
}

function fakeCall(initial: AudioDeviceChoice = { input: null, output: null }) {
  let choice = initial
  const call = {
    getDeviceChoice: vi.fn(() => choice),
    chooseInput: vi.fn(async (input: string | null) => {
      choice = { ...choice, input }
    }),
    chooseOutput: vi.fn(async (output: string | null) => {
      choice = { ...choice, output }
    }),
  } satisfies AudioSettingsCall
  return call
}

function setup(
  options: {
    call?: ReturnType<typeof fakeCall>
    devices?: AudioDevices
    inputMissing?: boolean
    canChooseOutput?: boolean
    playTone?: (output: string | null) => Promise<void>
    listDevices?: () => Promise<AudioDevices>
    engine?: SoundEngine
  } = {}
) {
  const call = options.call ?? fakeCall()
  let devices = options.devices ?? DEVICES
  const listDevices = vi.fn(options.listDevices ?? (async () => devices))
  let plugged: (() => void) | null = null
  const stopWatching = vi.fn()
  const watchDevices = vi.fn((listener: () => void) => {
    plugged = listener
    return stopWatching
  })
  const playTone = vi.fn(options.playTone ?? (async (_output: string | null) => undefined))
  const meterRef = { current: null as HTMLSpanElement | null }
  const view = (inputMissing: boolean) => (
    <AudioSettings
      call={call}
      inputMissing={inputMissing}
      meterRef={meterRef}
      listDevices={listDevices}
      watchDevices={watchDevices}
      canChooseOutput={options.canChooseOutput ?? true}
      playTone={playTone}
      {...(options.engine === undefined ? {} : { engine: options.engine })}
    />
  )
  const { rerender } = render(view(options.inputMissing ?? false))
  const setInputMissing = (inputMissing: boolean) => rerender(view(inputMissing))
  const replug = (next: AudioDevices) => {
    devices = next
    act(() => plugged?.())
  }
  return {
    call,
    listDevices,
    watchDevices,
    stopWatching,
    playTone,
    meterRef,
    replug,
    setInputMissing,
  }
}

const user = () => userEvent.setup()
const panel = () => screen.getByRole('dialog', { name: 'Réglages audio' })
const field = (name: string) => within(panel()).getByRole('combobox', { name })

async function open() {
  const actor = user()
  await actor.click(screen.getByRole('button', { name: 'Réglages audio' }))
  // The browser's list answers.
  await act(async () => undefined)
  return actor
}

describe('AudioSettings (« Réglages audio »)', () => {
  it('opens from a named button, and asks the browser for nothing until it does', async () => {
    const { listDevices, watchDevices } = setup()
    expect(listDevices).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    // On the dock's inverse ground: a filled square whose ring is offset, as the controls' are.
    expect(screen.getByRole('button', { name: 'Réglages audio' })).toHaveClass(
      'bg-c-inverse-2',
      'text-c-on-inverse-dim',
      'focus-offset',
      'focus-visible:ring-offset-2'
    )
    await open()
    expect(listDevices).toHaveBeenCalledTimes(1)
    expect(watchDevices).toHaveBeenCalledTimes(1)
    expect(field('Sortie audio')).toHaveTextContent('Par défaut du système')
    expect(within(panel()).getByText('Niveau du micro')).toBeInTheDocument()
  })

  it('lists the microphones by name after the default, and switches to the one chosen', async () => {
    const { call } = setup()
    const actor = await open()
    await actor.click(field('Micro'))
    const names = screen.getAllByRole('option').map((option) => option.textContent)
    expect(names).toEqual(['Par défaut du système', 'Micro MacBook', 'Casque Jabra'])
    await actor.click(screen.getByRole('option', { name: 'Casque Jabra' }))
    expect(call.chooseInput).toHaveBeenCalledWith('headset-mic')
    await waitFor(() => expect(field('Micro')).toHaveTextContent('Casque Jabra'))

    await actor.click(field('Micro'))
    await actor.click(screen.getByRole('option', { name: 'Par défaut du système' }))
    expect(call.chooseInput).toHaveBeenLastCalledWith(null)
  })

  it('keeps showing the microphone in use when the one chosen would not start', async () => {
    const call = fakeCall()
    // The controller keeps the one it had: the choice does not change.
    call.chooseInput.mockImplementation(async () => undefined)
    setup({ call })
    const actor = await open()
    await actor.click(field('Micro'))
    await actor.click(screen.getByRole('option', { name: 'Casque Jabra' }))
    expect(call.chooseInput).toHaveBeenCalledWith('headset-mic')
    await act(async () => undefined)
    expect(field('Micro')).toHaveTextContent('Par défaut du système')
  })

  it('switches the output to the one chosen', async () => {
    const { call } = setup({ call: fakeCall({ input: 'mac-mic', output: null }) })
    const actor = await open()
    expect(field('Micro')).toHaveTextContent('Micro MacBook')
    await actor.click(field('Sortie audio'))
    await actor.click(screen.getByRole('option', { name: 'Casque Jabra' }))
    expect(call.chooseOutput).toHaveBeenCalledWith('headset')
    expect(field('Sortie audio')).toHaveTextContent('Casque Jabra')
  })

  it('names devices the browser does not name yet by their place', async () => {
    setup({
      devices: {
        inputs: [
          { id: 'a', label: '' },
          { id: 'b', label: '' },
        ],
        outputs: [{ id: 'c', label: '' }],
      },
    })
    const actor = await open()
    await actor.click(field('Micro'))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Par défaut du système',
      'Micro 1',
      'Micro 2',
    ])
    await actor.keyboard('{Escape}')
    await actor.click(field('Sortie audio'))
    expect(screen.getByRole('option', { name: 'Sortie 1' })).toBeInTheDocument()
  })

  it('shows the default, and says so, when the microphone chosen is not plugged in', async () => {
    setup({ call: fakeCall({ input: 'unplugged', output: 'gone' }), inputMissing: true })
    await open()
    expect(field('Micro')).toHaveTextContent('Par défaut du système')
    expect(field('Sortie audio')).toHaveTextContent('Par défaut du système')
    // Read with the field it is about.
    expect(field('Micro')).toHaveAccessibleDescription(
      'Le micro choisi n’est pas branché : celui par défaut est utilisé.'
    )
  })

  it('shows the default the call stands in with, even once the chosen microphone is back', async () => {
    const { setInputMissing } = setup({
      call: fakeCall({ input: 'headset-mic', output: null }),
      inputMissing: true,
    })
    await open()
    expect(field('Micro')).toHaveTextContent('Par défaut du système')
    setInputMissing(false)
    expect(field('Micro')).toHaveTextContent('Casque Jabra')
    expect(field('Micro')).not.toHaveAccessibleDescription(/branché/)
  })

  it('shows the microphone picked at once, while the call switches to it', async () => {
    const call = fakeCall()
    let settle = () => undefined as void
    call.chooseInput.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    )
    setup({ call })
    const actor = await open()
    await actor.click(field('Micro'))
    await actor.click(screen.getByRole('option', { name: 'Casque Jabra' }))
    expect(field('Micro')).toHaveTextContent('Casque Jabra')
    // It would not start: back to the one the call kept.
    await act(async () => settle())
    expect(field('Micro')).toHaveTextContent('Par défaut du système')
  })

  it("reads the call's choice again each time it opens", async () => {
    const call = fakeCall()
    setup({ call })
    const actor = await open()
    await actor.keyboard('{Escape}')
    await call.chooseInput('mac-mic')
    await open()
    expect(field('Micro')).toHaveTextContent('Micro MacBook')
  })

  it('keeps the list of the last opening, not one the browser answers late from before', async () => {
    const answers: ((devices: AudioDevices) => void)[] = []
    setup({
      listDevices: () =>
        new Promise<AudioDevices>((resolve) => {
          answers.push(resolve)
        }),
    })
    const actor = await open()
    await actor.keyboard('{Escape}')
    await open()
    const late = { inputs: [{ id: 'old', label: 'Micro ancien' }], outputs: [] }
    await act(async () => answers[1]!(DEVICES))
    await act(async () => answers[0]!(late))
    await actor.click(field('Micro'))
    expect(screen.queryByRole('option', { name: 'Micro ancien' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Casque Jabra' })).toBeInTheDocument()
  })

  it('tests the output shown: the default, when the one chosen is gone', async () => {
    const { playTone } = setup({ call: fakeCall({ input: null, output: 'gone' }) })
    const actor = await open()
    await actor.click(within(panel()).getByRole('button', { name: 'Tester le son' }))
    expect(playTone).toHaveBeenCalledWith(null)
  })

  it('follows a device plugged in while it is open, and stops watching once closed', async () => {
    const { replug, stopWatching } = setup({ call: fakeCall({ input: 'usb-mic', output: null }) })
    const actor = await open()
    expect(field('Micro')).toHaveTextContent('Par défaut du système')
    replug({ ...DEVICES, inputs: [...DEVICES.inputs, { id: 'usb-mic', label: 'Micro USB' }] })
    await waitFor(() => expect(field('Micro')).toHaveTextContent('Micro USB'))
    await actor.keyboard('{Escape}')
    expect(stopWatching).toHaveBeenCalledTimes(1)
  })

  it('says the browser plays on the system output where it cannot choose one', async () => {
    setup({ canChooseOutput: false })
    await open()
    expect(within(panel()).queryByRole('combobox', { name: 'Sortie audio' })).toBeNull()
    expect(
      within(panel()).getByText('Votre navigateur joue le son sur la sortie du système.')
    ).toBeInTheDocument()
    // The test still plays, on the system output.
    expect(within(panel()).getByRole('button', { name: 'Tester le son' })).toBeInTheDocument()
  })

  it('plays the test sound on the output chosen, once at a time', async () => {
    let finish = () => undefined as void
    const { playTone } = setup({
      call: fakeCall({ input: null, output: 'headset' }),
      playTone: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    const actor = await open()
    const button = within(panel()).getByRole('button', { name: 'Tester le son' })
    await actor.click(button)
    expect(playTone).toHaveBeenCalledWith('headset')
    expect(button).toHaveAttribute('aria-busy', 'true')
    await actor.click(button)
    expect(playTone).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(button).not.toHaveAttribute('aria-busy', 'true')
    expect(within(panel()).getByRole('status')).toHaveTextContent('')
  })

  it('says when the test sound could not play, until another output is chosen or it reopens', async () => {
    setup({ playTone: async () => Promise.reject(new DOMException('gone', 'NotFoundError')) })
    const actor = await open()
    const failed = async () => {
      await actor.click(within(panel()).getByRole('button', { name: 'Tester le son' }))
      await waitFor(() =>
        expect(within(panel()).getByRole('status')).toHaveTextContent(
          'Le son de test n’a pas pu être joué sur cette sortie. Choisissez-en une autre, puis réessayez.'
        )
      )
    }
    await failed()
    await actor.click(field('Sortie audio'))
    await actor.click(screen.getByRole('option', { name: 'Casque Jabra' }))
    expect(within(panel()).getByRole('status')).toHaveTextContent('')
    await failed()
    await actor.keyboard('{Escape}')
    await open()
    expect(within(panel()).getByRole('status')).toHaveTextContent('')
  })

  it('hands its meter to the caller, empty until drawn, and hidden from screen readers', async () => {
    const { meterRef } = setup()
    await open()
    const meter = panel().querySelector('[data-panel-meter]')!
    expect(meter).toHaveAttribute('aria-hidden', 'true')
    expect(meterRef.current).toBe(meter.firstElementChild)
    expect(meterRef.current!.style.transform).toBe('scaleX(0)')
  })

  it('exposes the Sonic Identity packs, sibling preview buttons, master mode, and forwards output changes', async () => {
    localStorage.clear()
    const engine = new SoundEngine({
      audioContextFactory: () => null,
    })
    const previewSpy = vi.spyOn(engine, 'previewPack')
    const outputSpy = vi.spyOn(engine, 'setOutputDevice')

    setup({ engine })
    const actor = await open()

    // All six sound packs are rendered as radio options with no nested buttons.
    const packGroup = within(panel()).getByRole('radiogroup', { name: 'Signature sonore' })
    const radios = within(packGroup).getAllByRole('radio')
    expect(radios).toHaveLength(6)
    for (const radio of radios) {
      expect(radio.querySelector('button')).toBeNull()
    }

    // Selecting Cosmos updates the active sound pack.
    await actor.click(within(packGroup).getByRole('radio', { name: 'Cosmos' }))
    expect(engine.getPreferences().pack).toBe('cosmos')

    // Clicking the sibling Aperçu button previews a pack without changing the selection.
    await actor.click(
      within(packGroup).getByRole('button', { name: 'Écouter un aperçu de Atelier' })
    )
    expect(previewSpy).toHaveBeenCalledWith('atelier')
    expect(engine.getPreferences().pack).toBe('cosmos')

    // Selecting a master mode updates the engine's master mode.
    const modeGroup = within(panel()).getByRole('radiogroup', { name: 'Mode sonore' })
    await actor.click(within(modeGroup).getByRole('radio', { name: 'Essentiels uniquement' }))
    expect(engine.getPreferences().masterMode).toBe('essential')

    // Changing the audio output forwards the chosen sink ID to the sound engine.
    await actor.click(field('Sortie audio'))
    await actor.click(screen.getByRole('option', { name: 'Casque Jabra' }))
    expect(outputSpy).toHaveBeenCalledWith('headset')
    engine.destroy()
  })
})

describe('AudioSettings: how the member speaks', () => {
  it('switches to push-to-talk, says which key to hold, and remembers it', async () => {
    const { CallPreferences } = await import('./audio/callPreferences')
    const preferences = new CallPreferences()
    const user = userEvent.setup()
    render(
      <AudioSettings
        call={fakeCall()}
        inputMissing={false}
        meterRef={{ current: null }}
        listDevices={async () => DEVICES}
        watchDevices={() => () => undefined}
        canChooseOutput
        preferences={preferences}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Réglages audio' }))
    const dialog = await screen.findByRole('dialog', { name: 'Réglages audio' })
    expect(within(dialog).getByRole('radio', { name: 'Micro ouvert' })).toBeChecked()
    await user.click(within(dialog).getByRole('radio', { name: 'Appuyer pour parler' }))
    expect(preferences.getSnapshot().inputMode).toBe('push-to-talk')
    expect(
      within(dialog).getByText(
        'Maintenez la touche située sous la touche d’échappement (² sur un clavier français) pour parler.'
      )
    ).toBeInTheDocument()
    window.localStorage.clear()
  })

  it('turns noise suppression off through the call, which applies it to the live microphone', async () => {
    const { CallPreferences } = await import('./audio/callPreferences')
    const preferences = new CallPreferences()
    const user = userEvent.setup()
    const call = {
      ...fakeCall(),
      setNoiseSuppression: vi.fn(async (on: boolean) =>
        preferences.update({ noiseSuppression: on })
      ),
    }
    render(
      <AudioSettings
        call={call}
        inputMissing={false}
        meterRef={{ current: null }}
        listDevices={async () => DEVICES}
        watchDevices={() => () => undefined}
        canChooseOutput
        preferences={preferences}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Réglages audio' }))
    const dialog = await screen.findByRole('dialog', { name: 'Réglages audio' })
    const noise = within(dialog).getByRole('switch', { name: 'Réduction du bruit' })
    expect(noise).toBeChecked()
    await user.click(noise)
    expect(call.setNoiseSuppression).toHaveBeenCalledWith(false)
    await waitFor(() => expect(noise).not.toBeChecked())
    window.localStorage.clear()
  })
})
