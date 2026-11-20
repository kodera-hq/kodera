import { useTranslation } from 'react-i18next'
import { LinkButton } from '../ui/LinkButton/LinkButton'
const recoveryCopy = { fr: '← Retour à l’accueil', en: '← Back to home' } as const
export function HomeRecovery() {
  const { i18n } = useTranslation()
  return (
    <LinkButton href="/" variant="secondary">
      {recoveryCopy[i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'fr']}
    </LinkButton>
  )
}
