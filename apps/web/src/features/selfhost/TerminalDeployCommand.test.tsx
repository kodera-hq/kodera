import { describe, it, expect } from 'vitest'
import { buildTerminalDeployCommand } from './TerminalDeployCommand'
describe('terminal deploy command', () => {
  it('quotes validated operator inputs without executing a shell', () => {
    expect(
      buildTerminalDeployCommand(
        'chat.example.org',
        'https://id.example.org/realms/studio',
        'support@example.org'
      )
    ).toContain('--trust-file public-trust.json')
    for (const host of ['localhost', '127.0.0.1', 'chat.example.org;id', 'a.local'])
      expect(
        buildTerminalDeployCommand(host, 'https://id.example.org/x', 'support@example.org')
      ).toBeNull()
    for (const issuer of [
      'http://id.example.org/x',
      "https://id.example.org/'$(id)",
      'https://u:p@id.example.org/x',
      'https://localhost/x',
    ])
      expect(
        buildTerminalDeployCommand('chat.example.org', issuer, 'support@example.org')
      ).toBeNull()
  })
})
