// The demo-only seam for a customer's own mark, and the reason it is a seam
// at all: `Organisation` in the Core contract has no branding field, so the
// console cannot be given one. These assertions are about the SHAPE of that
// arrangement — the registry is empty until the demo seed fills it, the seed
// lives in the mock tree, and the slug it registers is the slug the demo
// overlay actually serves.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearDemoOrganisationMarks,
  demoOrganisationMark,
  registerDemoOrganisationMark,
} from '@/app/demoBranding'
import { DEMO_BRANDED_ORGANISATION_SLUG, installDemoBranding } from '@/mocks/demo/branding'

const root = join(import.meta.dirname, '..', '..', '..')
const read = (relativePath: string) => readFileSync(join(root, relativePath), 'utf8')

afterEach(clearDemoOrganisationMarks)

describe('organisation branding', () => {
  it('has no field in the Core contract to come from', () => {
    // The constraint this whole seam exists because of, asserted against the
    // generated schema rather than described in a comment: if Core ever adds
    // a branding field, this test fails and the seam should be replaced by a
    // real read of it — which is the outcome the pull request asks for.
    const schema = read('src/api/schema.d.ts')
    const organisation = /^ {8}Organisation: \{$.*?^ {8}\};$/ms.exec(schema)?.[0]
    expect(organisation).toBeDefined()
    expect(organisation).toMatch(/slug: string;/)
    for (const field of ['logo', 'branding', 'icon', 'avatar', 'mark', 'brand_']) {
      expect(organisation).not.toContain(field)
    }
  })

  it('answers undefined for every organisation until a seed says otherwise', () => {
    // The production answer. Nothing in `src/` outside the mock tree ever
    // calls the registrar, so this is what a customer's build does.
    expect(demoOrganisationMark(DEMO_BRANDED_ORGANISATION_SLUG)).toBeUndefined()
    expect(demoOrganisationMark('acme-sa')).toBeUndefined()
  })

  it('returns the registered mark for that slug only', () => {
    registerDemoOrganisationMark('vercelli', 'data:image/svg+xml,demo')
    expect(demoOrganisationMark('vercelli')).toBe('data:image/svg+xml,demo')
    expect(demoOrganisationMark('acme-sa')).toBeUndefined()
  })

  it('installs the demo mark as an inline data URI, never as a fetchable asset', () => {
    installDemoBranding()
    const mark = demoOrganisationMark(DEMO_BRANDED_ORGANISATION_SLUG)
    expect(mark).toBeDefined()
    // `?raw` plus `encodeURIComponent`. A plain asset import would give a
    // `/assets/...svg` URL here, and Vite would emit that file into every
    // build — including the ones that tree-shake the module away.
    // `scripts/check-production-bundle.sh` is the other half of this; this is
    // the half that fails in `npm test`.
    expect(mark).toMatch(/^data:image\/svg\+xml,/)
    expect(decodeURIComponent(mark ?? '')).toContain('Groupe Vercelli')
    // And not base64 (`?inline`'s encoding). A base64 payload is a payload no
    // grep can find, which would make the bundle check's search for
    // `Vercelli` pass on a build that is carrying the mark — a check that
    // cannot fail is not a check.
    expect(mark).not.toContain('base64')
    expect(mark).toContain(encodeURIComponent('Groupe Vercelli'))
  })

  it('registers the slug the demo overlay actually serves', () => {
    const overlay = read('src/mocks/overlays/shell.demo-branding.ts')
    expect(overlay).toContain(`slug: '${DEMO_BRANDED_ORGANISATION_SLUG}'`)
    expect(overlay).toContain(`realm: '${DEMO_BRANDED_ORGANISATION_SLUG}'`)
  })

  it('keeps the customer mark in the mock tree, out of the maker brand directory', () => {
    // public/README.md: everything under `public/` is the Kodera set, copied
    // verbatim into every build. A fictional customer's mark there would ship
    // to every tenant as though it were part of the product.
    const publicReadme = read('public/README.md')
    expect(publicReadme).not.toMatch(/vercelli/i)
    expect(() => read('src/mocks/demo/brand/vercelli-mark.svg')).not.toThrow()
    expect(read('src/mocks/demo/brand/vercelli-mark.svg')).toContain('FICTIONAL')
  })
})
