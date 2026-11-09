// docs/specs/11-workspace.md §3: the workspace is its own surface on the rail, « Messages », in no
// console navigation, and a page under its address is drawn in the workspace's layout and titled
// as the workspace.

import { describe, expect, it } from 'vitest'
import { announcedTitleKey, contentTitleKey } from '../../app/contentTitle'
import { railSurfaces, surfaceOf } from '../../app/railModules'
import { navItemsFor } from '../../app/Sidebar'
import type { OrganisationRole } from '../../app/Sidebar'

const ROLES: readonly OrganisationRole[] = ['org_owner', 'org_admin', 'org_billing', 'org_member']

describe('the workspace on the rail', () => {
  it('is drawn before the console', () => {
    expect(railSurfaces()).toEqual([
      expect.objectContaining({
        surface: 'workspace',
        to: '/$org/workspace',
        titleKey: 'console.shell.rail.title-workspace',
        phoneTabBar: 'modules',
      }),
      expect.objectContaining({ surface: 'console', to: '/$org/home' }),
    ])
  })

  it.each(ROLES)('is in no console navigation for %s', (role) => {
    expect(navItemsFor(role).map((item) => item.to)).not.toContain('/$org/workspace')
  })

  it('owns every address under /{org}/workspace and nothing else', () => {
    expect(surfaceOf('/acme-sa/workspace')).toBe('workspace')
    expect(surfaceOf('/acme-sa/workspace/0192f3a4')).toBe('workspace')
    expect(surfaceOf('/acme-sa/home')).toBe('console')
    expect(surfaceOf('/acme-sa/workspaces')).toBe('console')
  })

  it('titles the page and its announcement as the workspace, on every channel', () => {
    for (const path of ['/acme-sa/workspace', '/acme-sa/workspace/0192f3a4']) {
      expect(contentTitleKey(path, 'org_member')).toBe('console.workspace._.title')
      expect(announcedTitleKey(path, 'org_member')).toBe('console.workspace._.title')
    }
  })
})
