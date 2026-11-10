import { LinkButton } from '../ui/LinkButton/LinkButton'
import { useTranslation } from 'react-i18next'
import { authMode, mswEnabled } from '../config'
import { isDemoActive } from './interactiveDemo'
import { demoMessages } from './demoMessages'
import { SUPPORT_EMAIL } from './supportContact'

/** Outside the scrolling workspace canvas and never dismissible. */
export function DemoDisclosure({ org }: { org: string }) {
  const { i18n } = useTranslation()
  if (!isDemoActive(org) && !mswEnabled() && authMode() !== 'mock') return null
  const copy = demoMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  return (
    <section
      role="status"
      aria-label={copy.title}
      className="shrink-0 border-b border-c-border-soft bg-c-surface px-4 py-2 text-sm text-c-ink"
    >
      <strong>{copy.title}.</strong> {copy.body} {copy.support}{' '}
      <LinkButton inline href={`mailto:${SUPPORT_EMAIL}`}>
        {SUPPORT_EMAIL}
      </LinkButton>
    </section>
  )
}
