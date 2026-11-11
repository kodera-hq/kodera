import github from './brands/github.svg'
import gitlab from './brands/gitlab.svg'
import sentry from './brands/sentry.svg'
import grafana from './brands/grafana.svg'
import linear from './brands/linear.svg'
import figma from './brands/figma.svg'
import grist from './brands/grist.svg'
import nextcloud from './brands/nextcloud.svg'
import qonto from './brands/qonto.svg'
import notion from './brands/notion.svg'
import googledrive from './brands/googledrive.svg'
import instagram from './brands/instagram.svg'
import frameio from './brands/frameio.svg'

export const BRAND_ICONS = {
  github: { src: github, label: 'GitHub' },
  gitlab: { src: gitlab, label: 'GitLab' },
  sentry: { src: sentry, label: 'Sentry' },
  grafana: { src: grafana, label: 'Grafana' },
  linear: { src: linear, label: 'Linear' },
  figma: { src: figma, label: 'Figma' },
  grist: { src: grist, label: 'Grist' },
  nextcloud: { src: nextcloud, label: 'Nextcloud' },
  qonto: { src: qonto, label: 'Qonto' },
  notion: { src: notion, label: 'Notion' },
  googledrive: { src: googledrive, label: 'Google Drive' },
  instagram: { src: instagram, label: 'Instagram' },
  frameio: { src: frameio, label: 'Frame.io' },
} as const

export type BrandName = keyof typeof BRAND_ICONS | 'webhook' | 'documents' | 'monitoring'

/** Local brand geometry retains its own colors; the surrounding surface uses theme tokens. */
export function BrandIcon({
  name,
  decorative = false,
}: {
  readonly name: BrandName
  readonly decorative?: boolean
}) {
  const entry = name in BRAND_ICONS ? BRAND_ICONS[name as keyof typeof BRAND_ICONS] : undefined
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-md border border-c-border-soft bg-c-surface p-1"
      data-brand={name}
    >
      {entry ? (
        <img
          src={entry.src}
          alt={decorative ? '' : entry.label}
          aria-hidden={decorative || undefined}
          className={name === 'frameio' ? 'h-8 w-12 object-contain' : 'h-8 w-8 object-contain'}
        />
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="h-8 w-8 text-c-accent-ink"
          role={decorative ? undefined : 'img'}
          aria-label={decorative ? undefined : name}
          aria-hidden={decorative || undefined}
        >
          {name === 'documents' ? (
            <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7" />
          ) : name === 'monitoring' ? (
            <path d="M2 12h5l3-8 4 16 3-8h5" />
          ) : (
            <>
              <circle cx="6" cy="17" r="4" />
              <circle cx="18" cy="17" r="4" />
              <circle cx="12" cy="6" r="4" />
              <path d="m8 14 3-5m2 0 3 5M10 18h4" />
            </>
          )}
        </svg>
      )}
    </span>
  )
}
