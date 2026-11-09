// Owner ruling (2026-09-23): the console gives one support address,
// `SUPPORT_EMAIL`, wherever it tells a customer to write. UX audit OL-13: a
// sentence ending « écrivez-nous » with no address leaves the person with
// nowhere to write. `supportContact.test.ts` keeps a second address out; this
// keeps the first one in.
//
// How the address gets there: a catalogue sentence says `{email}`, and the
// i18n runtime fills it with `SUPPORT_EMAIL` wherever the sentence is rendered
// (`src/i18n/index.ts`, `defaultVariables`). « Le service est momentanément
// indisponible… » alone is rendered from nineteen places in product code; none
// of them has to remember the address, and none can print the bare placeholder.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import i18n from '../i18n'
import en from '../i18n/en.json'
import fr from '../i18n/fr.json'
import { SUPPORT_EMAIL } from './supportContact'

const SRC = join(__dirname, '..')
const PLACEHOLDER = '{{email}}'
const catalogues: Record<'fr' | 'en', Record<string, string>> = { fr, en }

/** French is the source of truth for meaning (docs/specs/README.md §4): a
 * sentence tells the customer to write when its French says « écrivez-nous »
 * or « écrivez à ». « Décrivez votre besoin » and « la page depuis laquelle
 * vous écrivez » are no such sentence. */
// Finite imperative forms, including contact wording; descriptive form prompts
// do not instruct the customer to contact support.
const TELLS_TO_WRITE =
  /(?<!\p{L})(?:écrivez(?:-nous| à )|contactez(?:-nous| (?:le|notre) support))/iu

const WITHOUT_ADDRESS: Record<string, string> = {
  'console.support.help.subtitle': 'the actual Aide page renders its adjacent copyable address',
  'console.domain.new.error-host-taken': 'Domain creation has no production caller',
  'console.domain.certificate.error-failed': 'Domain certificate writes have no production caller',
  'console.federation.domains.error-claimed-elsewhere':
    'Federation domain writes have no production caller',
  'console.federation.overview.action-other-provider':
    'Federation provider setup has no production caller',
  'console.federation.test.error-provider': 'Federation tests have no production caller',
  'console.federation.values.error-generation-failed':
    'Federation value generation has no production caller',
  'console.support.tickets.empty-body': 'the ticket list has no production caller',
}

/** Sentences whose `{email}` is not the support address: the caller's own. */
const CALLER_SUPPLIED = new Set(['console.order.agreements.label-signatory'])

const tellsToWrite = Object.keys(fr).filter((key) => TELLS_TO_WRITE.test(catalogues.fr[key]!))

/** Every key whose sentence carries `{email}` in either language. The runtime
 * fills the placeholder in whichever language is on screen, so an `{email}`
 * written in one catalogue only is as much a sentence to account for as one
 * written in both. */
function keysCarryingEmail(all: Record<string, Record<string, string>>): string[] {
  const keys = new Set(
    Object.values(all).flatMap((catalogue) =>
      Object.keys(catalogue).filter((key) => catalogue[key]!.includes(PLACEHOLDER))
    )
  )
  return [...keys].sort()
}
const carriesEmail = keysCarryingEmail(catalogues)

describe('a sentence that tells the customer to write', () => {
  it('detects finite contact instructions while ignoring descriptive field prompts', () => {
    for (const sentence of [
      'Écrivez-nous.',
      'écrivez à notre équipe.',
      'Contactez le support.',
      'Contactez notre support.',
      'Contactez-nous.',
    ])
      expect(TELLS_TO_WRITE.test(sentence)).toBe(true)
    for (const sentence of [
      'Décrivez votre besoin',
      'La page depuis laquelle vous écrivez',
      'Adresse du contact de facturation',
    ])
      expect(TELLS_TO_WRITE.test(sentence)).toBe(false)
    expect(tellsToWrite).toContain('console.order._.error-outcome-held')
    expect(tellsToWrite).toContain('console.home.overview.state-deleted')
  })

  it('has no unbuilt exemption referenced by production source', () => {
    const exempt = new Set(
      Object.keys(WITHOUT_ADDRESS).filter((key) => key !== 'console.support.help.subtitle')
    )
    const files = sources(SRC).filter((path) => !/^(i18n|mocks|api)\//.test(relative(SRC, path)))
    const references: string[] = []
    for (const path of files) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      )
      function visit(node: ts.Node): void {
        if (ts.isStringLiteralLike(node) && exempt.has(node.text))
          references.push(`${relative(SRC, path)} ${node.text}`)
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(files.length).toBeGreaterThanOrEqual(200)
    expect(references).toEqual([])
  })

  it('carries the address placeholder, in both languages', () => {
    const missing = tellsToWrite
      .filter((key) => !(key in WITHOUT_ADDRESS))
      .flatMap((key) =>
        (['fr', 'en'] as const)
          .filter((language) => !catalogues[language][key]?.includes(PLACEHOLDER))
          .map((language) => `${key} (${language}): ${catalogues[language][key]}`)
      )
    expect(missing).toEqual([])
  })

  it('is rendered with the one support address, without the caller passing it', () => {
    const rendered = tellsToWrite
      .filter((key) => !(key in WITHOUT_ADDRESS))
      .flatMap((key) =>
        (['fr', 'en'] as const).map((lng) => {
          // A sentence's other placeholders stay as written; only the address
          // is under test, and only the runtime's own default supplies it.
          const text = i18n.t(key as never, { lng }) as string
          return text.includes(SUPPORT_EMAIL) && !text.includes(PLACEHOLDER) ? undefined : text
        })
      )
      .filter((text) => text !== undefined)
    expect(rendered).toEqual([])
    expect(i18n.t('console.common.error-unavailable')).toBe(
      `Le service est momentanément indisponible. Réessayez dans quelques minutes ; si cela persiste, écrivez-nous à ${SUPPORT_EMAIL}.`
    )
  })

  it('is looked for in a catalogue that has such sentences', () => {
    // A pattern that matched nothing would pass the checks above on anything;
    // one that matched « Décrivez » would ask an address of a field label.
    expect(tellsToWrite.length).toBeGreaterThanOrEqual(20)
    // « écrivez-nous », capitalised or not, and « écrivez à ».
    expect(tellsToWrite).toContain('console.common.error-unavailable')
    expect(tellsToWrite).toContain('console.status.overview.error-step-failed')
    expect(tellsToWrite).toContain('console.support.new.error-submit-failed')
    expect(tellsToWrite).not.toContain('console.order.quote.label-needs')
    expect(tellsToWrite).not.toContain('console.support.new.label-context-screen')
  })

  it('has no exemption that has stopped applying', () => {
    const stale = Object.keys(WITHOUT_ADDRESS).filter(
      (key) => !tellsToWrite.includes(key) || catalogues.fr[key]!.includes(PLACEHOLDER)
    )
    expect(stale).toEqual([])
  })
})

// ── An `{email}` that is not the support address ─────────────────────────
//
// The runtime's default would fill it with the support address, silently, if
// the call forgot its own. So such a sentence is listed, and every call that
// renders it must pass an `email`.
//
// What this check is, and is not. It is syntactic: it reads each call and
// asks whether an `email` property is written in its options. It does not
// know the value. A call that writes `email: undefined` passes here, and the
// runtime then prints the support address in its place — `null` and `''`
// print nothing. The type of the value is what stands between that and the
// screen: today's one caller passes a required string of the Core contract.

interface Finding {
  /** Calls that render the sentence and pass an `email`. */
  given: number
  /** `file:line key`, for a call that passes none, or a key used where no call
   * can be read: a table of keys, a variable. */
  problems: string[]
}

/** Every string literal naming one of `keys` must sit in the first argument of
 * a `t(…)` call whose second argument is an object with an `email` property.
 * Read with the TypeScript parser, not a pattern: a key is often one arm of a
 * conditional, several lines from its options. */
function inspect(path: string, text: string, keys: ReadonlySet<string>): Finding {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const finding: Finding = { given: 0, problems: [] }
  const where = (node: ts.Node) =>
    `${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`

  function isTranslate(call: ts.CallExpression): boolean {
    const callee = call.expression
    if (ts.isIdentifier(callee)) return callee.text === 't'
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 't'
  }

  function passesEmail(call: ts.CallExpression): boolean {
    const options = call.arguments[1]
    return (
      options !== undefined &&
      ts.isObjectLiteralExpression(options) &&
      options.properties.some(
        (property) =>
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          property.name.getText(source) === 'email'
      )
    )
  }

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node) && keys.has(node.text)) {
      // The nearest call this literal is the first argument of, or part of it.
      let child: ts.Node = node
      let parent: ts.Node | undefined = node.parent
      while (parent !== undefined && !ts.isCallExpression(parent)) {
        child = parent
        parent = parent.parent
      }
      if (parent === undefined || !isTranslate(parent) || parent.arguments[0] !== child) {
        finding.problems.push(`${where(node)} ${node.text}: not the key of a t() call`)
      } else if (!passesEmail(parent)) {
        finding.problems.push(`${where(node)} ${node.text}: no email passed`)
      } else {
        finding.given += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return finding
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.(test|stories)\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('a sentence whose {email} is the caller’s own', () => {
  it('is listed, so the support address never stands in for it unnoticed', () => {
    const unlisted = carriesEmail.filter(
      (key) => !tellsToWrite.includes(key) && !CALLER_SUPPLIED.has(key)
    )
    expect(unlisted).toEqual([])
    const stale = [...CALLER_SUPPLIED].filter((key) => !carriesEmail.includes(key))
    expect(stale).toEqual([])
  })

  // The check's own proof, kept: an `{email}` written in English only was
  // read as no `{email}` at all, because only the French catalogue was read.
  it('is found whichever catalogue writes the placeholder', () => {
    const found = keysCarryingEmail({
      fr: { both: 'à {{email}}', 'fr-only': 'à {{email}}', 'en-only': 'à nous', none: 'rien' },
      en: { both: 'at {{email}}', 'fr-only': 'to us', 'en-only': 'at {{email}}', none: 'nothing' },
    })
    expect(found).toEqual(['both', 'en-only', 'fr-only'])
    // And on the real catalogues it finds the sentences it is there for.
    expect(carriesEmail).toContain('console.order.agreements.label-signatory')
    expect(carriesEmail).toContain('console.common.error-unavailable')
    expect(carriesEmail.length).toBeGreaterThanOrEqual(11)
  })

  it('is given that address by every call', () => {
    const files = sources(SRC).filter((path) => {
      const rel = relative(SRC, path)
      return !rel.startsWith('i18n/') && !rel.startsWith('mocks/') && !rel.startsWith('api/')
    })
    const findings = files.map((path) =>
      inspect(relative(SRC, path), readFileSync(path, 'utf8'), CALLER_SUPPLIED)
    )
    expect(findings.flatMap((finding) => finding.problems)).toEqual([])
    // Floors, so a walk or a parser that saw nothing cannot pass.
    expect(files.length).toBeGreaterThanOrEqual(200)
    expect(findings.reduce((sum, finding) => sum + finding.given, 0)).toBeGreaterThanOrEqual(1)
    // And the value the caller passes is the one rendered.
    expect(
      i18n.t('console.order.agreements.label-signatory', {
        person: 'Marie Dupont',
        email: 'marie.dupont@acme.fr',
      })
    ).toBe('Signataire : Marie Dupont · marie.dupont@acme.fr')
  })

  // The check's own proof, kept: each shape it must refuse, and the two it
  // must accept.
  it('is refused without it, or where no call can be read', () => {
    const keys = new Set(['console.order.agreements.label-signatory'])
    const problems = (text: string) => inspect('fixture.tsx', text, keys).problems
    const KEY = 'console.order.agreements.label-signatory'

    expect(problems(`const a = t('${KEY}')`)).toEqual([`fixture.tsx:1 ${KEY}: no email passed`])
    expect(problems(`const a = t('${KEY}', { person })`)).toEqual([
      `fixture.tsx:1 ${KEY}: no email passed`,
    ])
    expect(problems(`const a = t(signed\n ? '${KEY}'\n : 'other.key')`)).toEqual([
      `fixture.tsx:2 ${KEY}: no email passed`,
    ])
    expect(problems(`const KEYS = { signatory: '${KEY}' }`)).toEqual([
      `fixture.tsx:1 ${KEY}: not the key of a t() call`,
    ])
    expect(problems(`const a = t('other.key', { name: label('${KEY}') })`)).toEqual([
      `fixture.tsx:1 ${KEY}: not the key of a t() call`,
    ])

    const accepted = inspect(
      'fixture.tsx',
      `const a = t('${KEY}', { person, email: signatoryEmail })
       const b = i18n.t(ok ? 'other.key' : '${KEY}', { email })`,
      keys
    )
    expect(accepted).toEqual({ given: 2, problems: [] })
  })
})
