import { readLanguagePreference } from './languagePreference'
// i18next runtime, wired to the generated catalogues. French is the product's
// default language (docs/dev/I18N.md); English is the second one.
//
// The catalogues are generated from docs/specs/copy/{fr,en}.md by
// `npm run i18n:generate` and must never be hand-edited — see the "Generated
// catalogues" section of docs/dev/I18N.md.
//
// What a browser downloads is split by namespace (`./namespaces.ts`). The
// default language's entry namespaces are imported here and travel with the
// application; every other catalogue is its own file, fetched by
// `ensureNamespaces` the first time a route that needs it is reached. A route
// is attached to the router only once its namespaces have arrived
// (`src/app/lazyRouteTree.ts`), so no screen renders a key before its text.
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import { SUPPORT_EMAIL } from '../app/supportContact'
import frCommon from './catalogues/fr/common.json'
import frInvitation from './catalogues/fr/invitation.json'
import frLogin from './catalogues/fr/login.json'
import frShell from './catalogues/fr/shell.json'
// The whole catalogue, for its key set only: a type import ships nothing.
import type fr from './fr.json'
import { ENTRY_NAMESPACES, MESSAGE_NAMESPACES } from './namespaces'
import type { MessageNamespace } from './namespaces'

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

type Language = 'fr' | 'en'
type Catalogue = Record<string, string>

// Every catalogue the application does not carry: one file per namespace and
// locale, each behind its own `import()`. The four imported above are left
// out, so the bundler never sees one module both bundled and deferred.
const deferredCatalogues = import.meta.glob<Catalogue>(
  ['./catalogues/*/*.json', '!./catalogues/fr/{common,invitation,login,shell}.json'],
  { import: 'default' }
)

const loaded: Record<Language, Set<MessageNamespace>> = {
  fr: new Set(ENTRY_NAMESPACES),
  en: new Set(),
}
// A fetch under way, by `<locale>/<namespace>`, so that two routes asking for
// one catalogue share one request.
const inFlight = new Map<string, Promise<void>>()

void i18n.use(initReactI18next).init({
  lng: readLanguagePreference(),
  fallbackLng: 'fr',
  supportedLngs: ['fr', 'en'],
  resources: {
    fr: { translation: { ...frCommon, ...frInvitation, ...frLogin, ...frShell } },
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

function activeLanguage(): Language {
  return i18n.language === 'en' ? 'en' : 'fr'
}

function loadCatalogue(language: Language, namespace: MessageNamespace): Promise<void> | undefined {
  if (loaded[language].has(namespace)) return undefined
  const id = `${language}/${namespace}`
  const pending = inFlight.get(id)
  if (pending !== undefined) return pending
  const load = deferredCatalogues[`./catalogues/${id}.json`]
  const request = (
    load === undefined
      ? Promise.reject<Catalogue>(new Error(`No message catalogue for "${id}".`))
      : load()
  )
    .then((catalogue) => {
      i18n.addResourceBundle(language, 'translation', catalogue, true, true)
      loaded[language].add(namespace)
    })
    // A failed fetch is forgotten, so the next request for it tries again.
    .finally(() => inFlight.delete(id))
  inFlight.set(id, request)
  return request
}

function loadAll(language: Language, namespaces: Iterable<MessageNamespace>): Promise<void>[] {
  const pending: Promise<void>[] = []
  for (const namespace of namespaces) {
    const request = loadCatalogue(language, namespace)
    if (request !== undefined) pending.push(request)
  }
  return pending
}

/**
 * Resolves once every given namespace can be rendered in the active language. A route's lazy
 * boundary awaits this before the route exists (`src/app/routeTree.ts`), which is what keeps a
 * screen from ever drawing a bare key.
 */
export async function ensureNamespaces(namespaces: readonly MessageNamespace[]): Promise<void> {
  await Promise.all(loadAll(activeLanguage(), namespaces))
}

/**
 * A lazily imported module, delivered once the namespaces its screens read have arrived with it.
 * Every lazy route boundary goes through this: the pairing is what `npm run i18n:check` reads to
 * prove that no route can be reached without its catalogue (`scripts/i18n/route-namespaces.ts`).
 */
export async function withNamespaces<TModule>(
  namespaces: readonly MessageNamespace[],
  load: () => Promise<TModule>
): Promise<TModule> {
  const [module] = await Promise.all([load(), ensureNamespaces(namespaces)])
  return module
}

/** Whether every given namespace is already there in the active language. */
export function hasNamespaces(namespaces: readonly MessageNamespace[]): boolean {
  const language = activeLanguage()
  return namespaces.every((namespace) => loaded[language].has(namespace))
}

// A change of language first fetches, in the new language, everything this
// page has been given so far, or is being given, in either: the screen in
// front of the person re-renders the moment the language changes, and must
// find its text.
const changeLanguage = i18n.changeLanguage.bind(i18n)
i18n.changeLanguage = (language, callback) => {
  const wanted = new Set<MessageNamespace>([...loaded.fr, ...loaded.en])
  for (const id of inFlight.keys()) {
    const namespace = MESSAGE_NAMESPACES.find((known) => id.endsWith(`/${known}`))
    if (namespace !== undefined) wanted.add(namespace)
  }
  const pending = loadAll(language === 'en' ? 'en' : 'fr', wanted)
  return pending.length === 0
    ? changeLanguage(language, callback)
    : Promise.all(pending).then(() => changeLanguage(language, callback))
}

// The unit suite renders any screen directly, with no route in front of it to
// fetch a namespace, and reads both languages: it gets the whole catalogue up
// front. A literal comparison, so a build folds it away and emits neither
// whole catalogue (`scripts/check-bundle-budget.mjs` fails a build whose
// entry carries one).
if (import.meta.env.MODE === 'test') {
  const [wholeFr, wholeEn] = await Promise.all([import('./fr.json'), import('./en.json')])
  i18n.addResourceBundle('fr', 'translation', wholeFr.default, true, true)
  i18n.addResourceBundle('en', 'translation', wholeEn.default, true, true)
  for (const namespace of MESSAGE_NAMESPACES) {
    loaded.fr.add(namespace)
    loaded.en.add(namespace)
  }
}

/**
 * Resolved once the entry namespaces are there in the language this page opened in: at once in
 * French, after one small fetch in English. The router is not created before it
 * (`src/app/routeTree.ts`), so nothing renders in the meantime.
 */
export const entryCataloguesReady: Promise<void> = ensureNamespaces(ENTRY_NAMESPACES).then(
  async () => {
    // i18next settles `resolvedLanguage` when the language is set, on the catalogues it holds at
    // that moment: for a page opened in English that was the French one alone, and the answer
    // was French. Screens that carry their own two-language copy read it, so it is settled
    // again now that the English catalogue is here.
    if (i18n.resolvedLanguage !== i18n.language) await changeLanguage(i18n.language)
  }
)

export default i18n
