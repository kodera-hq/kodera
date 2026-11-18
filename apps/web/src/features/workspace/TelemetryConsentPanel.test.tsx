import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AnyRouter } from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { track } from '../../analytics/track'
import { startTelemetry } from '../../analytics/telemetry/bootstrap'
import {
  hasTelemetryConsent,
  setTelemetryConsent,
  setTelemetryScope,
} from '../../analytics/telemetry/consent'
import { createTelemetryTransport } from '../../analytics/telemetry/transport'
import i18n from '../../i18n'
import { TelemetryConsentPanel } from './TelemetryConsentPanel'

let dispose = () => {}
beforeEach(async () => {
  await i18n.changeLanguage('en')
  localStorage.clear()
  setTelemetryScope({ person: 'person', workspace: 'workspace', slug: 'sample' })
  vi.stubEnv('VITE_POSTHOG_KEY', 'public-project-key')
  vi.stubEnv('VITE_POSTHOG_HOST', 'https://eu.i.posthog.com')
})
afterEach(async () => {
  dispose()
  act(() => {
    setTelemetryScope(undefined)
  })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await act(async () => {
    await i18n.changeLanguage('fr')
  })
})
it('makes consent explicit and immediately stops and wipes the diagnostic session', async () => {
  const request = vi.fn().mockImplementation(() => new Promise(() => {}))
  vi.stubGlobal('fetch', request)
  const router = { subscribe: () => () => {} } as unknown as AnyRouter
  dispose = await startTelemetry(
    router,
    'public-project-key',
    'https://eu.i.posthog.com',
    async () => ({ createTelemetryTransport })
  )
  const { container } = render(<TelemetryConsentPanel />)
  const user = userEvent.setup()
  const toggle = screen.getByRole('switch', {
    name: 'Allow optional diagnostics for this workspace',
  })
  expect(toggle).not.toBeChecked()
  expect(request).not.toHaveBeenCalled()
  await user.click(toggle)
  expect(toggle).toBeChecked()
  expect(hasTelemetryConsent()).toBe(true)
  track('channel_joined', { kind: 'chat' })
  expect(request).toHaveBeenCalledOnce()
  const first = request.mock.calls[0]![1]
  await user.click(toggle)
  expect(toggle).not.toBeChecked()
  expect(first.signal.aborted).toBe(true)
  expect(screen.getByRole('status')).toHaveTextContent('local diagnostic session data is cleared')
  track('channel_joined', { kind: 'chat' })
  expect(request).toHaveBeenCalledOnce()
  await user.click(toggle)
  track('channel_joined', { kind: 'chat' })
  expect(JSON.parse(request.mock.calls[1]![1].body).distinct_id).toBe(
    JSON.parse(first.body).distinct_id
  )
  expect(container.querySelectorAll('[style]')).toHaveLength(0)
})
it.each([
  ['', 'https://eu.i.posthog.com'],
  ['key', 'https://us.i.posthog.com'],
])(
  'disables consent and explains truthfully in FR and EN that 0 network bytes are sent when unconfigured (%s, %s)',
  async (key, host) => {
    setTelemetryConsent(true)
    vi.stubEnv('VITE_POSTHOG_KEY', key)
    vi.stubEnv('VITE_POSTHOG_HOST', host)

    await i18n.changeLanguage('fr')
    const { rerender } = render(<TelemetryConsentPanel />)
    const frSwitch = screen.getByRole('switch', {
      name: 'Autoriser les diagnostics facultatifs pour cet espace',
    })
    expect(frSwitch).toBeDisabled()
    expect(frSwitch).not.toBeChecked()
    expect(
      screen.getByText(/La télémétrie est désactivée et non configurée sur cette instance.*0 octet/)
    ).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Les diagnostics facultatifs sont indisponibles sur cette installation (0 octet réseau transmis).'
    )
    expect(screen.queryByText(/service d’analyse européen/)).toBeNull()
    expect(screen.queryByText(/déjà transmises/)).toBeNull()

    await act(async () => {
      await i18n.changeLanguage('en')
    })
    rerender(<TelemetryConsentPanel />)
    const enSwitch = screen.getByRole('switch', {
      name: 'Allow optional diagnostics for this workspace',
    })
    expect(enSwitch).toBeDisabled()
    expect(enSwitch).not.toBeChecked()
    expect(
      screen.getByText(/Telemetry is disabled and unconfigured on this instance.*0 network bytes/)
    ).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Optional diagnostics are unavailable on this deployment (0 network bytes transmitted).'
    )
    expect(screen.queryByText(/EU analytics service/)).toBeNull()
    expect(screen.queryByText(/already delivered/)).toBeNull()
  }
)
