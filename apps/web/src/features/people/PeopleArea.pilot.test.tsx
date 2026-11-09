// The pilot build (`src/app/capabilities.ts`): the addresses of the hidden People surfaces open the
// member list, and never mount the screen that would call an unrouted operation.
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PeopleImportBody, PeopleImportResultBody, PeopleOnSiteBody } from './PeopleArea'

const state = vi.hoisted(() => ({ navigations: [] as unknown[] }))
vi.mock('@tanstack/react-router', () => ({
  Navigate: (props: unknown) => {
    state.navigations.push(props)
    return null
  },
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useParams: () => ({ importId: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d' }),
}))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useParams: () => ({ org: 'acme-sa' }),
    useLoaderData: () => ({ membership: { role: 'org_owner', organisation: { id: 'o-1' } } }),
  },
}))
vi.mock('./OnSitePanel', () => ({ OnSitePanel: () => <p>on-site panel</p> }))
vi.mock('./ImportScreen', () => ({ ImportScreen: () => <p>import screen</p> }))
vi.mock('./PeopleScreen', () => ({ PeopleScreen: () => <p>people screen</p> }))

beforeEach(() => {
  vi.stubEnv('VITE_ENABLE_MSW', '')
  vi.stubEnv('VITE_MOCK_UNSERVED', '')
  state.navigations = []
})
afterEach(() => vi.unstubAllEnvs())

const TO_LIST = { to: '/$org/people', params: { org: 'acme-sa' }, replace: true }

describe('People addresses in the pilot', () => {
  it.each([
    ['/people/on-site', PeopleOnSiteBody],
    ['/people/import', PeopleImportBody],
    ['/people/import/{id}', PeopleImportResultBody],
  ])('%s opens the member list and mounts nothing else', (_address, Body) => {
    const { container } = render(<Body />)
    expect(state.navigations).toEqual([TO_LIST])
    expect(container).toBeEmptyDOMElement()
  })

  it('still mounts the import screen in a mock build asked to show it', () => {
    vi.stubEnv('VITE_ENABLE_MSW', '1')
    vi.stubEnv('VITE_MOCK_UNSERVED', '1')
    const { getByText } = render(<PeopleImportBody />)
    expect(getByText('import screen')).toBeVisible()
    expect(state.navigations).toEqual([])
  })
})
