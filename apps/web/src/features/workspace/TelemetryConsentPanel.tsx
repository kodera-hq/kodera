import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import {
  getTelemetryScope,
  hasTelemetryConsent,
  setTelemetryConsent,
  subscribeTelemetryConsent,
} from '../../analytics/telemetry/consent'
import { Switch } from '../../ui/Switch/Switch'
import { telemetryCopy } from './telemetryMessages'

export function TelemetryConsentPanel() {
  const { i18n } = useTranslation()
  const copy = telemetryCopy(i18n.resolvedLanguage)
  const scope = useSyncExternalStore(subscribeTelemetryConsent, getTelemetryScope, () => undefined)
  const consent = useSyncExternalStore(subscribeTelemetryConsent, hasTelemetryConsent, () => false)
  const configured =
    Boolean(import.meta.env.VITE_POSTHOG_KEY?.trim()) &&
    (!import.meta.env.VITE_POSTHOG_HOST ||
      import.meta.env.VITE_POSTHOG_HOST === 'https://eu.i.posthog.com')
  const active = configured && consent
  return (
    <section
      data-ph-no-capture
      className="flex flex-col gap-3 rounded-lg border border-c-border p-5"
    >
      <h3 className="text-lg font-semibold text-c-ink">{copy.title}</h3>
      <p className="text-sm text-c-ink-2">{configured ? copy.hint : copy.unconfiguredHint}</p>
      <Switch
        label={copy.label}
        checked={active}
        disabled={!configured || !scope}
        onCheckedChange={setTelemetryConsent}
      />
      <p role="status" className="text-xs text-c-ink-3">
        {!configured ? copy.unavailable : active ? copy.enabled : copy.disabled}
      </p>
    </section>
  )
}
