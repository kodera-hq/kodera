import type { BrandName } from '@/ui/icons/BrandIcon'
import type { OfficialExtensionId } from './catalog'

/** Unbranded reference connectors use product glyphs, never another provider's mark. */
export const EXTENSION_BRANDS = {
  'io.kodera.ext.frameio-review-bridge': 'frameio',
  'io.kodera.ext.frameio': 'frameio',
  'io.kodera.ext.renderfarm': 'monitoring',
  'io.kodera.ext.hello-webhook': 'webhook',
  'io.kodera.ext.github': 'github',
  'io.kodera.ext.gitlab': 'gitlab',
  'io.kodera.ext.linear': 'linear',
  'io.kodera.ext.sentry': 'sentry',
  'io.kodera.ext.alertmanager': 'grafana',
  'io.kodera.ext.rss-advisories': 'monitoring',
  'io.kodera.ext.release-assistant': 'documents',
  'io.kodera.ext.github-release-notifier': 'github',
  'io.kodera.ext.uptime-incident-bridge': 'monitoring',
  'io.kodera.ext.docs-collab-announcer': 'documents',
  'io.kodera.ext.openproject': 'documents',
  'io.kodera.ext.calcom': 'webhook',
  'io.kodera.ext.github-repo-tracker': 'github',
  'io.kodera.ext.qonto-treasury-feed': 'qonto',
  'io.kodera.ext.billing-webhooks': 'webhook',
  'io.kodera.ext.notion-workspace-bridge': 'notion',
  'io.kodera.ext.gdrive-document-share': 'googledrive',
  'io.kodera.ext.social-pulse-bridge': 'instagram',
} as const satisfies Record<OfficialExtensionId, BrandName>
