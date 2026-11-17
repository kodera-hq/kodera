import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AnyRouter } from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { track } from '../../analytics/track'
import { startTelemetry } from '../../analytics/telemetry/bootstrap'
import { hasTelemetryConsent, setTelemetryScope } from '../../analytics/telemetry/consent'
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
  setTelemetryScope(undefined)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await i18n.changeLanguage('fr')
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
  render(<TelemetryConsentPanel />)
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
  expect(JSON.parse(request.mock.calls[1]![1].body).distinct_id).not.toBe(
    JSON.parse(first.body).distinct_id
  )
})
it.each([
  ['', 'https://eu.i.posthog.com'],
  ['key', 'https://us.i.posthog.com'],
])('disables consent for an unconfigured or refused deployment', (key, host) => {
  vi.stubEnv('VITE_POSTHOG_KEY', key)
  vi.stubEnv('VITE_POSTHOG_HOST', host)
  render(<TelemetryConsentPanel />)
  expect(screen.getByRole('switch')).toBeDisabled()
  expect(screen.getByText('Optional diagnostics are unavailable on this deployment.')).toBeVisible()
})
