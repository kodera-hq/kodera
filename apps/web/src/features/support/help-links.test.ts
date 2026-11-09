// Every support action in the console reaches the Aide page through one typed
// builder (`./helpHref.ts`, `./HelpLink.tsx`), and
// `tests/e2e/06-support.spec.ts` opens each action from its own screen and
// proves it lands on Aide rather than the placeholder (SI-04, SH-05).
//
// What this guard checks, exactly — and so what it can and cannot catch:
// 1. No file outside `src/features/support/` writes the help route by hand:
//    no string or template literal with a `help` path segment (`/help`,
//    `/help?…`, `/help#…`, a bare `'help'` joined into a path). The one
//    exception is the sidebar's router target.
// 2. No `const|let|var x = helpHref(…)` or `= supportHref(…)` in those
//    files, so a built link is not kept in a plain variable for two buttons;
//    and no aliased import of `HelpLink`, `helpHref` or `supportHref`
//    (`import { helpHref as h }`), which would hide a use from the count.
// 3. File by file, the number of builder uses (`helpHref(`, `supportHref(`,
//    `<HelpLink`) and of support callbacks passed down to a component
//    (`onContactSupport`, `onSupport`, `onOpenTicket`, `onTalkToUs`) matches
//    the table below. A new support action — a new call, a new button calling
//    a drawer's callback — changes a count and fails until the table and the
//    end-to-end table in `06-support.spec.ts` are updated together.
// Not judged: a result held by `useMemo` or in an object, a navigation to
// `supportRoute.fullPath`, a path pieced together from template segments that
// never spell `help`, and a second call in one file that replaces a removed
// one. The end-to-end table is what proves each action lands.
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..')
const SRC = join(ROOT, 'src')

/** A literal carrying a `help` path segment, in any letter case. */
const RAW_HELP_PATH = /['"`/]help(?=['"`/?#])/gi
/** A builder use: one per support action built in that file. */
const BUILDER_USE = /\bhelpHref\(|\bsupportHref\(|<HelpLink\b/g
/** A built link stored in a plain variable, or a builder imported under
 * another name. */
const STORED_BUILD =
  /\b(?:const|let|var)\s+\w+\s*=\s*(?:helpHref|supportHref)\(|\b(?:HelpLink|helpHref|supportHref)\s+as\s+\w/g
/** A support callback, wherever it is named, declared or called. */
const SUPPORT_CALLBACK = /\bon(?:ContactSupport|Support|OpenTicket|TalkToUs)\b/g

interface Count {
  raw: number
  builder: number
  callbacks: number
}

const EXPECTED: Record<string, Count> = {
  // contextual desktop header « Aide »
  'src/app/Shell.tsx': { raw: 0, builder: 1, callbacks: 0 },
  // sidebar « Aide » (router target)
  'src/app/Sidebar.tsx': { raw: 1, builder: 0, callbacks: 0 },
  // home: instance-state « Écrire au support »; provisioning « Nous écrire »
  'src/features/home/Home.tsx': { raw: 0, builder: 2, callbacks: 0 },
  // home support card « Écrire au support »
  'src/features/home/SupportCard.tsx': { raw: 0, builder: 1, callbacks: 0 },
  // home capacity at its limit « Nous en parler »
  'src/features/home/CapacityCard.tsx': { raw: 0, builder: 1, callbacks: 0 },
  // invoice detail: payment-link failure « Nous écrire »,
  // « Un problème avec cette facture ? »
  'src/features/invoices/InvoiceDetailScreen.tsx': { raw: 0, builder: 2, callbacks: 0 },
  // invoices: dunning drawer « Nous écrire » (built here, passed down)
  'src/features/invoices/InvoiceListScreen.tsx': { raw: 0, builder: 1, callbacks: 1 },
  // the dunning drawer's one « Nous écrire » button (prop, destructure, use)
  'src/features/invoices/DunningDrawer.tsx': { raw: 0, builder: 0, callbacks: 3 },
  // subscription « Changer de formule »
  'src/features/invoices/SubscriptionScreen.tsx': { raw: 0, builder: 1, callbacks: 0 },
  // order confirmation « Nous écrire »
  'src/features/order/ConfirmationStep.tsx': { raw: 0, builder: 1, callbacks: 0 },
  // status: failed installation's step, provisioning step, stale heartbeat
  // and incident drawer (one handler), capacity « Nous en parler » (4 builder
  // calls); instance state « Nous écrire », provisioning's persistent « Nous
  // écrire » (2 `HelpLink`s); the four callbacks it hands down
  'src/features/status/StatusScreen.tsx': { raw: 0, builder: 6, callbacks: 4 },
  // the status builder: its own declaration and its one `helpHref` call
  'src/features/status/support.ts': { raw: 0, builder: 2, callbacks: 0 },
  // the workspace's stopped setup: « Nous écrire » with the read's reference
  'src/features/workspace/SetupState.tsx': { raw: 0, builder: 1, callbacks: 0 },
  // the components that render a support callback they were given
  'src/features/status/ProvisioningOverview.tsx': { raw: 0, builder: 0, callbacks: 3 },
  // 10: the degraded banner's « Nous écrire » exists only in the pilot build (incidents unserved,
  // `src/app/capabilities.ts`), which no end-to-end project runs. It calls the same
  // `onOpenTicket('incident')` as the incident drawer's row in `06-support.spec.ts`;
  // `src/app/capabilities.pilot.test.tsx` proves the banner calls it.
  'src/features/status/LiveOverview.tsx': { raw: 0, builder: 0, callbacks: 10 },
  'src/features/status/IncidentDrawer.tsx': { raw: 0, builder: 0, callbacks: 3 },
  'src/features/status/CapacityCard.tsx': { raw: 0, builder: 0, callbacks: 3 },
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

function scanned(rel: string): boolean {
  if (rel.startsWith('src/mocks/') || rel.startsWith('src/api/')) return false
  if (rel.startsWith('src/features/support/')) return false
  if (/\.(test|stories)\.tsx?$/.test(rel)) return false
  return extname(rel) === '.ts' || extname(rel) === '.tsx'
}

/** Code only: a comment that names the route is not a link to it. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, ''))
    .join('\n')
}

function countIn(source: string): Count & { stored: number } {
  const body = code(source)
  return {
    raw: [...body.matchAll(RAW_HELP_PATH)].length,
    builder: [...body.matchAll(BUILDER_USE)].length,
    callbacks: [...body.matchAll(SUPPORT_CALLBACK)].length,
    stored: [...body.matchAll(STORED_BUILD)].length,
  }
}

function measure(): { counts: Record<string, Count>; stored: string[] } {
  const counts: Record<string, Count> = {}
  const stored: string[] = []
  for (const path of files(SRC)) {
    const rel = relative(ROOT, path)
    if (!scanned(rel)) continue
    const { stored: kept, ...count } = countIn(readFileSync(path, 'utf8'))
    if (kept > 0) stored.push(rel)
    if (count.raw + count.builder + count.callbacks > 0) counts[rel] = count
  }
  return { counts, stored }
}

describe('support actions', () => {
  it('are built only through the typed builder, where the end-to-end table expects them', () => {
    const { counts, stored } = measure()
    expect(stored).toEqual([])
    expect(counts).toEqual(EXPECTED)
  })

  // The guard's own proof, on the four shapes a review slipped past the
  // previous version of this check, and on the shapes it must not count.
  it.each([
    [
      'a second button reusing a stored link',
      'const link = helpHref(org, {})\n<a href={link} />',
      'stored',
    ],
    ['a hand-written help link with an anchor', 'href={`/${org}/help#faq`}', 'raw'],
    ['a path joined from pieces', "[org, 'help'].join('/')", 'raw'],
    [
      'an extra button calling a drawer callback',
      '<Button onClick={onContactSupport} />',
      'callbacks',
    ],
    ['a new router link to Aide', '<HelpLink org={org} />', 'builder'],
    ['a help path in another letter case', 'href={`/${org}/Help`}', 'raw'],
    [
      'an aliased builder import',
      "import { helpHref as toAide } from '../support/helpHref'",
      'stored',
    ],
  ] as const)('sees %s, as %s', (_name, source, counter) => {
    expect(countIn(source)[counter]).toBe(1)
  })

  it('does not count a comment or a catalogue key', () => {
    const count = countIn(
      [
        '  // registered as `/{org}/help` in routes.tsx',
        '  /* see /help? */',
        "  t('console.shell.nav.title-help')",
        "  t('console.support.help.title')",
      ].join('\n')
    )
    expect(count).toEqual({ raw: 0, builder: 0, callbacks: 0, stored: 0 })
  })
})
