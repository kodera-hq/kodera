// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACCOUNT_ITEMS } from '../../../src/app/accountItems'
import { navItemsFor, type OrganisationRole } from '../../../src/app/Sidebar'
import { isStubArea, STUB_AREAS } from '../../../src/app/stubAreas'

const WEB_ROOT = join(import.meta.dirname, '..', '..', '..')
const SRC_ROOT = join(WEB_ROOT, 'src')

function walkSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...walkSourceFiles(full))
    } else if (
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx') &&
      !entry.endsWith('.stories.tsx')
    ) {
      out.push(full)
    }
  }
  return out
}

function findStubRouteAreas(files: readonly { relPath: string; source: string }[]): string[] {
  const areas: string[] = []
  for (const { relPath, source } of files) {
    if (!relPath.endsWith('/routes.tsx') && !relPath.endsWith('\\routes.tsx')) continue
    if (!/<AreaStub\b/.test(source)) continue
    const parts = relPath.split(/[\\/]/)
    // Expected: src/features/<area>/routes.tsx
    const featureIdx = parts.indexOf('features')
    const area = featureIdx >= 0 ? parts[featureIdx + 1] : undefined
    if (area !== undefined) areas.push(area)
  }
  return [...new Set(areas)].sort()
}

function findUngatedStubLinkViolations(
  files: readonly { relPath: string; source: string }[],
  stubAreas: readonly string[]
): string[] {
  const violations: string[] = []
  for (const { relPath, source } of files) {
    if (relPath.endsWith('/routes.tsx')) continue
    for (const area of stubAreas) {
      const targetPattern = new RegExp(`(['"\`])/\\$org/${area}\\1`, 'g')
      if (!targetPattern.test(source)) continue
      const gatePattern = new RegExp(`\\bisStubArea\\(\\s*(['"\`])${area}\\1\\s*\\)`)
      if (!gatePattern.test(source)) {
        violations.push(
          `${relPath}: references /$org/${area} without gating on isStubArea('${area}')`
        )
      }
    }
  }
  return violations
}

describe('AreaStub reachability guard', () => {
  const realFiles = walkSourceFiles(SRC_ROOT).map((full) => ({
    relPath: relative(WEB_ROOT, full).split(sep).join('/'),
    source: readFileSync(full, 'utf8'),
  }))

  it('keeps STUB_AREAS in exact parity with route files rendering <AreaStub>', () => {
    const routeStubAreas = findStubRouteAreas(realFiles)
    expect(routeStubAreas).toEqual([...STUB_AREAS].sort())
  })

  it('omits stub areas and dead pending entries from navigation menus and gates every /$org/<stub> link', () => {
    for (const item of ACCOUNT_ITEMS) {
      expect(item.kind).not.toBe('pending')
      if (item.kind === 'place') {
        const area = item.to.split('/')[2] ?? ''
        expect(isStubArea(area), `ACCOUNT_ITEMS exposes stub area ${area}`).toBe(false)
      }
    }

    const roles: readonly OrganisationRole[] = [
      'org_owner',
      'org_admin',
      'org_billing',
      'org_member',
    ]
    for (const role of roles) {
      for (const item of navItemsFor(role)) {
        expect(isStubArea(item.area), `Sidebar exposes stub area ${item.area} for ${role}`).toBe(
          false
        )
      }
    }

    expect(findUngatedStubLinkViolations(realFiles, STUB_AREAS)).toEqual([])
  })

  it('self-tests: fails when a route renders <AreaStub> outside STUB_AREAS or a menu links without isStubArea', () => {
    const mutatedRoutes = [
      ...realFiles,
      {
        relPath: 'src/features/audit/routes.tsx',
        source: 'export const r = () => <AreaStub titleKey="console.shell.nav.title-home" />',
      },
    ]
    expect(findStubRouteAreas(mutatedRoutes)).not.toEqual([...STUB_AREAS].sort())

    const ungatedMenu = [
      {
        relPath: 'src/features/workspace/FakeMenu.tsx',
        source: 'export const item = { to: "/$org/federation" }',
      },
    ]
    expect(findUngatedStubLinkViolations(ungatedMenu, STUB_AREAS)).toEqual([
      "src/features/workspace/FakeMenu.tsx: references /$org/federation without gating on isStubArea('federation')",
    ])
  })
})
