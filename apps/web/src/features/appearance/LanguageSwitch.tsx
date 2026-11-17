import { useTranslation } from 'react-i18next'
import { keepLanguagePreference } from '../../i18n/languagePreference'
import { Button } from '../../ui/Button/Button'
import { ButtonGroup } from '../../ui/ButtonGroup/ButtonGroup'

export function LanguageSwitch() {
  const { t, i18n } = useTranslation()
  const active = (i18n.resolvedLanguage ?? i18n.language).split('-')[0]

  return (
    <ButtonGroup aria-label={t('console.shell.account.action-language')}>
      {(['fr', 'en'] as const).map((locale) => (
        <Button
          key={locale}
          type="button"
          variant={active === locale ? 'primary' : 'secondary'}
          aria-pressed={active === locale}
          lang={locale}
          onClick={() => {
            keepLanguagePreference(locale)
            void i18n.changeLanguage(locale)
          }}
        >
          {locale === 'fr'
            ? t('console.shell.account.language-fr')
            : t('console.shell.account.language-en')}
        </Button>
      ))}
    </ButtonGroup>
  )
}
