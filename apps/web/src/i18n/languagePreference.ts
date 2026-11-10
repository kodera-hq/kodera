export function readLanguagePreference(): 'fr' | 'en' {
  try {
    return sessionStorage.getItem('console:language') === 'en' ? 'en' : 'fr'
  } catch {
    return 'fr'
  }
}
export function keepLanguagePreference(language: 'fr' | 'en'): void {
  try {
    sessionStorage.setItem('console:language', language)
  } catch {
    /* The current page still changes language when storage is unavailable. */
  }
}
