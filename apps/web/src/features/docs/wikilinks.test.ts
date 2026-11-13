import { describe, expect, it } from 'vitest'
import {
  computeLocalBacklinks,
  extractOutgoingWikilinks,
  filterWikilinkCandidates,
  matchWikilinkAutocomplete,
  parseWikilinksInLine,
  resolveWikilinkTarget,
} from './wikilinks'

describe('workspace wikilinks and backlink graph', () => {
  it('parses [[Title]] and [[Title|Alias]] tokens while ignoring code spans and fences', () => {
    const tokens = parseWikilinksInLine(
      'Read [[Architecture Decision]] and [[Incident Runbook|on-call guide]] next.'
    )
    expect(tokens.map((t) => ({ target: t.targetTitle, label: t.displayLabel }))).toEqual([
      { target: 'Architecture Decision', label: 'Architecture Decision' },
      { target: 'Incident Runbook', label: 'on-call guide' },
    ])

    const markdown = [
      'See [[Roadmap]] and `[[Ignored Inline]]` plus [[Roadmap|duplicate]].',
      '```ts',
      'const ignored = "[[Ignored In Fence]]"',
      '```',
      'Also link [[Sécurité Réseau]].',
    ].join('\n')

    expect(extractOutgoingWikilinks(markdown)).toEqual(['Roadmap', 'Sécurité Réseau'])
  })

  it('resolves targets accent-insensitively and computes incoming backlinks without self-links', () => {
    const pages = [
      {
        id: 'doc-arch',
        title: 'Décision Architecture',
        content: 'Self reference [[Décision Architecture]] and outgoing [[Plan Exploitation]].',
      },
      {
        id: 'doc-ops',
        title: 'Plan Exploitation',
        content: 'Implements [[decision architecture]] with rollback notes.',
      },
      {
        id: 'doc-retro',
        title: 'Bilan Incident',
        content: 'Updated [[Décision Architecture]] and [[Décision Architecture|ADR]].',
      },
    ]

    expect(resolveWikilinkTarget(pages, 'decision architecture')?.id).toBe('doc-arch')
    expect(computeLocalBacklinks(pages, 'doc-arch')).toEqual([
      { documentId: 'doc-ops', title: 'Plan Exploitation' },
      { documentId: 'doc-retro', title: 'Bilan Incident' },
    ])
  })

  it('matches active [[ autocomplete triggers and ranks prefix candidates first', () => {
    expect(matchWikilinkAutocomplete('Link to [[run')).toEqual({
      query: 'run',
      fromOffset: 8,
    })
    expect(matchWikilinkAutocomplete('Already closed [[Runbook]] ')).toBeNull()

    const candidates = filterWikilinkCandidates(
      [
        { id: '1', title: 'Service Runbook' },
        { id: '2', title: 'Runbook Database' },
        { id: '3', title: 'Current Page' },
      ],
      'run',
      '3'
    )
    expect(candidates.map((c) => c.id)).toEqual(['2', '1'])
  })
})
