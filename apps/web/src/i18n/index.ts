// i18next runtime, wired to the generated catalogues. French is the product's
// default language (docs/dev/I18N.md); English is the second one.
//
// fr.json / en.json are generated from docs/specs/copy/{fr,en}.md by
// `npm run i18n:generate` and must never be hand-edited — see the "Generated
// catalogues" section of docs/dev/I18N.md.
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import { SUPPORT_EMAIL } from '../app/supportContact'
import en from './en.json'
import fr from './fr.json'

// `keyof typeof fr` rather than `keyof typeof en`: parity between the two
// catalogues is enforced at generation time (scripts/i18n/generate.ts), so
// either one names the same key set. `fr` is the default language.
export type MessageKey = keyof typeof fr

// Module augmentation so `useTranslation()`'s `t()` is typed against the
// catalogue: an unknown key is a type error, not just a runtime throw.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: {
      translation: typeof fr
    }
  }
}

// A key missing from a catalogue renders as the literal key on the page, in
// production, with no error (I18N.md, rule 3) — unless something is watching
// for it. `saveMissing` is what turns the handler on; without it
// `missingKeyHandler` is never called.
//
// In production a thrown error here would take down the whole console over a
// single copy mistake, so it only logs there. In every other environment
// (dev, test, CI) a missing key must be loud, so it throws.
function handleMissingKey(languages: readonly string[], _namespace: string, key: string): void {
  const message =
    `Missing message-catalogue key "${key}" (${languages.join(', ')}). ` +
    'Add it to docs/specs/copy/fr.md and en.md, then run npm run i18n:generate.'
  if (import.meta.env.PROD) {
    console.error(message)
  } else {
    throw new Error(message)
  }
}

void i18n.use(initReactI18next).init({
  lng: 'fr',
  fallbackLng: 'fr',
  supportedLngs: ['fr', 'en'],
  resources: {
    fr: { translation: fr },
    en: { translation: en },
  },
  // The catalogue keys are the full dotted path (`console.people.list.subtitle`);
  // i18next's own `.` namespace/nesting separators would try to read that as
  // nested objects, which the generator deliberately does not produce.
  keySeparator: false,
  nsSeparator: false,
  interpolation: {
    // React already escapes interpolated values when rendering; a second
    // escape pass here would double-encode characters like `&` and `'`
    // that are common in customer-entered names and organisation strings.
    escapeValue: false,
    // The one address a customer is told to write to (`SUPPORT_EMAIL`, owner
    // ruling 2026-09-23). A catalogue sentence that says « écrivez-nous à
    // {email} » gets it here, wherever it is rendered: the most common such
    // sentence is rendered from nineteen places in product code, and a call
    // that forgot the value would print the bare placeholder with nothing to
    // notice it. A sentence whose `{email}` is something else passes its own,
    // which wins; `src/app/supportSentences.test.ts` lists those and checks
    // their calls.
    defaultVariables: { email: SUPPORT_EMAIL },
  },
  returnNull: false,
  saveMissing: true,
  missingKeyHandler: handleMissingKey,
})

export default i18n
