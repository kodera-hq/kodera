import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUDIO_DEVICES_STORAGE_KEY,
  listAudioDevices,
  NO_CHOICE,
  NO_DEVICES,
  playTestTone,
  readDeviceChoice,
  saveDeviceChoice,
  TEST_TONE_MS,
} from './devices'

function listed(...devices: [MediaDeviceKind, string, string][]) {
  return {
    enumerateDevices: vi.fn(async () =>
      devices.map(([kind, deviceId, label]) => ({ kind, deviceId, label }) as MediaDeviceInfo)
    ),
  }
}

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('listAudioDevices', () => {
  it("lists the microphones and outputs by name, without the system's aliases or cameras", async () => {
    const devices = await listAudioDevices(
      listed(
        ['audioinput', 'default', 'Par défaut - Micro MacBook'],
        ['audioinput', 'communications', 'Communications - Micro MacBook'],
        ['audioinput', 'mac-mic', 'Micro MacBook'],
        ['audioinput', 'headset-mic', 'Casque Jabra'],
        ['audioinput', 'headset-mic', 'Casque Jabra'],
        ['videoinput', 'camera', 'FaceTime'],
        ['audiooutput', 'default', 'Par défaut - Haut-parleurs'],
        ['audiooutput', 'speakers', 'Haut-parleurs MacBook']
      )
    )
    expect(devices).toEqual({
      inputs: [
        { id: 'mac-mic', label: 'Micro MacBook' },
        { id: 'headset-mic', label: 'Casque Jabra' },
      ],
      outputs: [{ id: 'speakers', label: 'Haut-parleurs MacBook' }],
    })
  })

  it('keeps a device the browser does not name yet, and lists nothing it cannot', async () => {
    expect((await listAudioDevices(listed(['audioinput', 'mic-1', '']))).inputs).toEqual([
      { id: 'mic-1', label: '' },
    ])
    expect(await listAudioDevices(undefined)).toBe(NO_DEVICES)
    const refusing = {
      enumerateDevices: vi.fn(async () => {
        throw new Error('not allowed')
      }),
    }
    expect(await listAudioDevices(refusing)).toBe(NO_DEVICES)
  })
})

describe('the remembered choice', () => {
  it('is kept in this browser, and read back', () => {
    expect(readDeviceChoice()).toBe(NO_CHOICE)
    expect(saveDeviceChoice({ input: 'headset-mic', output: null })).toBe(true)
    expect(JSON.parse(window.localStorage.getItem(AUDIO_DEVICES_STORAGE_KEY)!)).toEqual({
      input: 'headset-mic',
      output: null,
    })
    expect(readDeviceChoice()).toEqual({ input: 'headset-mic', output: null })
  })

  it('reads as none when it is not one, or storage will not answer', () => {
    for (const stored of ['not json', '42', 'null', '{"input":7,"output":"default"}']) {
      window.localStorage.setItem(AUDIO_DEVICES_STORAGE_KEY, stored)
      expect(readDeviceChoice()).toEqual(NO_CHOICE)
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(readDeviceChoice()).toEqual(NO_CHOICE)
  })

  it('says when storage refused it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(saveDeviceChoice({ input: null, output: 'speakers' })).toBe(false)
  })
})

describe('playTestTone', () => {
  function fakes() {
    const oscillator = {
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }
    const gain = { gain: { value: 1 }, connect: vi.fn() }
    const destination = { stream: { id: 'tone' } }
    const context = {
      createOscillator: vi.fn(() => oscillator),
      createGain: vi.fn(() => gain),
      createMediaStreamDestination: vi.fn(() => destination),
      close: vi.fn(async () => undefined),
    }
    const element = {
      srcObject: null as unknown,
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      setSinkId: vi.fn(async (_id: string) => undefined),
    }
    const wait = vi.fn(async (_ms: number) => undefined)
    const options = {
      createContext: () => context as unknown as AudioContext,
      createElement: () => element as never,
      wait,
    }
    return { oscillator, gain, destination, context, element, wait, options }
  }

  it('plays a short tone on the output chosen, through an element, and lets everything go', async () => {
    const fake = fakes()
    await playTestTone('speakers', fake.options)
    expect(fake.element.setSinkId).toHaveBeenCalledWith('speakers')
    // The sink is set before the tone plays, so not a sample reaches another output.
    expect(fake.element.setSinkId.mock.invocationCallOrder[0]!).toBeLessThan(
      fake.element.play.mock.invocationCallOrder[0]!
    )
    expect(fake.oscillator.connect).toHaveBeenCalledWith(fake.gain)
    // Into the element's stream only: never the context's own output, which no sink can move.
    expect(fake.gain.connect).toHaveBeenCalledTimes(1)
    expect(fake.gain.connect).toHaveBeenCalledWith(fake.destination)
    expect(fake.element.play).toHaveBeenCalledTimes(1)
    expect(fake.wait).toHaveBeenCalledWith(TEST_TONE_MS)
    expect(TEST_TONE_MS).toBeLessThan(1000)
    expect(fake.oscillator.stop).toHaveBeenCalledTimes(1)
    expect(fake.element.pause).toHaveBeenCalled()
    expect(fake.element.srcObject).toBeNull()
    expect(fake.context.close).toHaveBeenCalledTimes(1)
  })

  it("plays on the system's output when none is chosen", async () => {
    const fake = fakes()
    await playTestTone(null, fake.options)
    expect(fake.element.setSinkId).not.toHaveBeenCalled()
    expect(fake.element.play).toHaveBeenCalledTimes(1)
  })

  it('says it could not play, and still lets everything go', async () => {
    const fake = fakes()
    fake.element.setSinkId.mockRejectedValueOnce(new DOMException('gone', 'NotFoundError'))
    await expect(playTestTone('unplugged', fake.options)).rejects.toThrow('gone')
    expect(fake.element.play).not.toHaveBeenCalled()
    expect(fake.context.close).toHaveBeenCalledTimes(1)
  })

  it('lets the audio context go when no element can be made', async () => {
    const fake = fakes()
    const options = {
      ...fake.options,
      createElement: () => {
        throw new Error('no audio element')
      },
    }
    await expect(playTestTone(null, options)).rejects.toThrow('no audio element')
    expect(fake.context.close).toHaveBeenCalledTimes(1)
  })
})
