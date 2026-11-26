export const EU_INGESTION_HOST = 'https://eu.i.posthog.com'

export function isConfiguredEuTelemetry(
  key: string | undefined,
  host: string | undefined
): boolean {
  return Boolean(key?.trim()) && (!host?.trim() || host.trim() === EU_INGESTION_HOST)
}

export function isWorkspaceTelemetryAllowed(policy: {
  planTier?: string | undefined
  hostingMode?: string | undefined
  telemetryEnabled?: boolean | undefined
}): boolean {
  if (policy.telemetryEnabled === false) return false
  if (
    policy.planTier === 'sovereign' ||
    policy.planTier === 'enterprise' ||
    policy.hostingMode === 'cloud-dedicated' ||
    policy.hostingMode === 'cloud_dedicated'
  )
    return policy.telemetryEnabled === true
  return true
}
