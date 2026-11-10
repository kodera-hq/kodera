import { render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { DemoDisclosure } from './DemoDisclosure'
import { demoMessages } from './demoMessages'
import { registerInteractiveDemo } from './interactiveDemo'
import { communityDemo, communityWorkspace } from '../mocks/demo/community'
import { createLocalWorkspaceStore } from '../mocks/demo/workspaceStore'

afterEach(async () => {
  registerInteractiveDemo(undefined)
  vi.unstubAllEnvs()
  await i18n.changeLanguage('fr')
})

it.each(['fr', 'en'] as const)(
  'discloses registered local workspaces in %s without a demo URL flag',
  async (locale) => {
    vi.stubEnv('VITE_ENABLE_MSW', '')
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    registerInteractiveDemo(communityDemo)
    await i18n.changeLanguage(locale)
    render(<DemoDisclosure org="community" />)
    const disclosure = screen.getByRole('status', { name: demoMessages[locale].title })
    expect(disclosure).toHaveTextContent(demoMessages[locale].body)
    expect(within(disclosure).getByRole('link', { name: 'support@kodera.io' })).toHaveAttribute(
      'href',
      'mailto:support@kodera.io'
    )
    expect(within(disclosure).queryByRole('button')).toBeNull()
  }
)

it.each(['mock', 'msw'] as const)(
  'discloses %s mode even without a registered workspace',
  (mode) => {
    vi.stubEnv('VITE_ENABLE_MSW', mode === 'msw' ? '1' : '')
    vi.stubEnv('VITE_AUTH_MODE', mode === 'mock' ? 'mock' : 'oidc')
    render(<DemoDisclosure org="other" />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  }
)

it('does not label a real workspace as a simulation', () => {
  vi.stubEnv('VITE_ENABLE_MSW', '')
  vi.stubEnv('VITE_AUTH_MODE', 'oidc')
  render(<DemoDisclosure org="community" />)
  expect(screen.queryByRole('status')).toBeNull()
})

it.each(['fr', 'en'] as const)(
  'frames seeded support and announcements as examples in %s',
  async (locale) => {
    await i18n.changeLanguage(locale)
    const store = createLocalWorkspaceStore(communityWorkspace(), 'community')
    expect(store.simulation).toBe(true)
    for (const name of ['support', 'announcements']) {
      const room = store.getSnapshot().rooms.find((room) => room.name === name)!
      const messages = store.getTimeline(room.roomId).map((message) => message.body)
      expect(messages[0]).toMatch(/simul/i)
      expect(messages.join(' ')).toContain('support@kodera.io')
      if (name === 'support') expect(messages.join(' ')).toContain('sessionStorage')
    }
  }
)
