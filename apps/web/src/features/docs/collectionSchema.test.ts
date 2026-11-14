import { describe, expect, it } from 'vitest'
import { collectionMessages, getCollectionCopy } from './collectionMessages'
import {
  computeCollectionRollups,
  createDefaultCollectionSchema,
  filterAndSortCollectionRows,
  formatRollupNumber,
  fromWireWorkspaceCollection,
  fromWireWorkspaceCollectionRow,
  toWireCollectionProperty,
  toWireCollectionValue,
  toWireCollectionView,
  toWireWorkspaceCollectionRowValues,
  validateCollectionDate,
  validateCollectionPropertyValue,
  validateCollectionSchema,
  validateCollectionUrl,
  type CollectionPropertyDef,
  type EnrichedCollectionRow,
} from './collectionSchema'

describe('collectionSchema validation, rollups, filtering, sorting, and Core 0.44.0 wire adapters', () => {
  it('maintains complete FR and EN key parity in collectionMessages', () => {
    const frKeys = Object.keys(collectionMessages.fr).sort()
    const enKeys = Object.keys(collectionMessages.en).sort()
    expect(frKeys).toEqual(enKeys)
    expect(Object.keys(collectionMessages.fr.propertyTypes).sort()).toEqual(
      Object.keys(collectionMessages.en.propertyTypes).sort()
    )
    expect(Object.keys(collectionMessages.fr.defaultSchema).sort()).toEqual(
      Object.keys(collectionMessages.en.defaultSchema).sort()
    )
    expect(getCollectionCopy('fr-FR').viewBoard).toBe('Kanban')
    expect(getCollectionCopy('en-GB').viewTable).toBe('Table')
  })

  it('strictly validates URLs allowing only http:// and https:// without credentials', () => {
    expect(validateCollectionUrl(null)).toEqual({ ok: true, value: null })
    expect(validateCollectionUrl('   ')).toEqual({ ok: true, value: null })
    expect(validateCollectionUrl('https://docs.kodera.io/runbooks/1')).toEqual({
      ok: true,
      value: 'https://docs.kodera.io/runbooks/1',
    })
    expect(validateCollectionUrl('http://localhost:8080/health')).toEqual({
      ok: true,
      value: 'http://localhost:8080/health',
    })

    // Dangerous schemes refused
    expect(validateCollectionUrl('javascript:alert(1)')).toEqual({
      ok: false,
      reason: 'disallowed_protocol',
    })
    expect(validateCollectionUrl('  JaVaScRiPt:void(0) ')).toEqual({
      ok: false,
      reason: 'disallowed_protocol',
    })
    expect(validateCollectionUrl('data:text/html,<script>alert(1)</script>')).toEqual({
      ok: false,
      reason: 'disallowed_protocol',
    })
    expect(validateCollectionUrl('vbscript:msgbox(1)')).toEqual({
      ok: false,
      reason: 'disallowed_protocol',
    })
    expect(validateCollectionUrl('file:///etc/passwd')).toEqual({
      ok: false,
      reason: 'disallowed_protocol',
    })

    // Embedded credentials and control characters refused
    expect(validateCollectionUrl('https://admin:secret@kodera.io/path')).toEqual({
      ok: false,
      reason: 'credentials_forbidden',
    })
    expect(validateCollectionUrl('https://kodera.io/\u0000bad')).toEqual({
      ok: false,
      reason: 'invalid_url',
    })
    expect(validateCollectionUrl('not a url')).toEqual({
      ok: false,
      reason: 'invalid_url',
    })
  })

  it('validates ISO calendar dates including leap-year boundaries', () => {
    expect(validateCollectionDate(null)).toEqual({ ok: true, value: null })
    expect(validateCollectionDate('2026-11-20')).toEqual({ ok: true, value: '2026-11-20' })
    expect(validateCollectionDate('2024-02-29')).toEqual({ ok: true, value: '2024-02-29' })

    expect(validateCollectionDate('2026-02-29')).toEqual({ ok: false, reason: 'invalid_date' })
    expect(validateCollectionDate('2026-02-30')).toEqual({ ok: false, reason: 'invalid_date' })
    expect(validateCollectionDate('2026-13-01')).toEqual({ ok: false, reason: 'invalid_date' })
    expect(validateCollectionDate('20/11/2026')).toEqual({ ok: false, reason: 'invalid_date' })
  })

  it('validates all typed page properties (status, select, multi_select, assignee, due_date, priority, number, checkbox, url, tags, text)', () => {
    const schema = createDefaultCollectionSchema('en')
    const byId = new Map<string, CollectionPropertyDef>(schema.properties.map((p) => [p.id, p]))
    byId.set('category', {
      id: 'category',
      name: 'Category',
      kind: 'select',
      options: [{ id: 'infra', label: 'Infrastructure' }],
    })
    byId.set('components', {
      id: 'components',
      name: 'Components',
      kind: 'multi_select',
      options: [
        { id: 'api', label: 'API' },
        { id: 'web', label: 'Web' },
      ],
    })
    byId.set('notes', { id: 'notes', name: 'Notes', kind: 'text' })

    expect(validateCollectionPropertyValue(byId.get('status')!, 'done')).toEqual({
      ok: true,
      cell: { kind: 'status', value: 'done' },
    })
    expect(validateCollectionPropertyValue(byId.get('status')!, 'nonexistent')).toEqual({
      ok: false,
      reason: 'unknown_option',
    })

    expect(validateCollectionPropertyValue(byId.get('category')!, 'infra')).toEqual({
      ok: true,
      cell: { kind: 'select', value: 'infra' },
    })

    expect(
      validateCollectionPropertyValue(byId.get('components')!, ['api', 'web', 'api'])
    ).toEqual({
      ok: true,
      cell: { kind: 'multi_select', value: ['api', 'web'] },
    })

    expect(validateCollectionPropertyValue(byId.get('priority')!, 'urgent')).toEqual({
      ok: true,
      cell: { kind: 'priority', value: 'urgent' },
    })

    expect(validateCollectionPropertyValue(byId.get('assignee')!, 'member-uuid-1')).toEqual({
      ok: true,
      cell: { kind: 'assignee', value: 'member-uuid-1' },
    })

    expect(validateCollectionPropertyValue(byId.get('due_date')!, '2026-12-01')).toEqual({
      ok: true,
      cell: { kind: 'due_date', value: '2026-12-01' },
    })

    expect(validateCollectionPropertyValue(byId.get('estimate')!, '12.5')).toEqual({
      ok: true,
      cell: { kind: 'number', value: 12.5 },
    })
    expect(validateCollectionPropertyValue(byId.get('estimate')!, Number.NaN)).toEqual({
      ok: false,
      reason: 'invalid_number',
    })

    expect(validateCollectionPropertyValue(byId.get('verified')!, true)).toEqual({
      ok: true,
      cell: { kind: 'checkbox', value: true },
    })
    expect(validateCollectionPropertyValue(byId.get('verified')!, 'yes')).toEqual({
      ok: false,
      reason: 'invalid_checkbox',
    })

    expect(
      validateCollectionPropertyValue(byId.get('reference_url')!, 'https://kodera.io/spec')
    ).toEqual({
      ok: true,
      cell: { kind: 'url', value: 'https://kodera.io/spec' },
    })
    expect(
      validateCollectionPropertyValue(byId.get('reference_url')!, 'javascript:alert(1)')
    ).toEqual({
      ok: false,
      reason: 'disallowed_protocol',
    })

    expect(validateCollectionPropertyValue(byId.get('tags')!, ['security', 'ops'])).toEqual({
      ok: true,
      cell: { kind: 'tags', value: ['security', 'ops'] },
    })

    expect(validateCollectionPropertyValue(byId.get('notes')!, 'Ready for review')).toEqual({
      ok: true,
      cell: { kind: 'text', value: 'Ready for review' },
    })
  })

  it('validates collection schema uniqueness and view references', () => {
    const valid = createDefaultCollectionSchema('fr')
    expect(validateCollectionSchema(valid.properties, valid.views)).toEqual({ ok: true })

    // Duplicate property ID
    expect(
      validateCollectionSchema([
        { id: 'status', name: 'Status', kind: 'text' },
        { id: 'status', name: 'Second', kind: 'number' },
      ])
    ).toEqual({ ok: false, reason: 'duplicate_property_id' })

    // Board grouping by non-select property refused
    expect(
      validateCollectionSchema(valid.properties, [
        {
          id: 'bad_board',
          name: 'Board',
          kind: 'board',
          groupByPropertyId: 'estimate',
          showEmptyGroups: true,
        },
      ])
    ).toEqual({ ok: false, reason: 'invalid_view_reference' })
  })

  it('filters, sorts deterministically with documentId tie-break, and computes rollups', () => {
    const schema = createDefaultCollectionSchema('en')
    const members = [
      { id: 'u-alice', name: 'Alice Martin' },
      { id: 'u-bruno', name: 'Bruno Bernard' },
    ]
    const rows: EnrichedCollectionRow[] = [
      {
        documentId: 'doc-b',
        title: 'API Gateway Hardening',
        updatedAt: '2026-11-10T10:00:00Z',
        role: 'editor',
        values: {
          status: { kind: 'status', value: 'done' },
          priority: { kind: 'priority', value: 'high' },
          assignee: { kind: 'assignee', value: 'u-alice' },
          due_date: { kind: 'due_date', value: '2026-11-18' },
          verified: { kind: 'checkbox', value: true },
          estimate: { kind: 'number', value: 8 },
          tags: { kind: 'tags', value: ['security', 'architecture'] },
        },
      },
      {
        documentId: 'doc-a',
        title: 'Backup Runbook',
        updatedAt: '2026-11-11T10:00:00Z',
        role: 'editor',
        values: {
          status: { kind: 'status', value: 'done' },
          priority: { kind: 'priority', value: 'high' },
          assignee: { kind: 'assignee', value: 'u-bruno' },
          due_date: { kind: 'due_date', value: '2026-11-20' },
          verified: { kind: 'checkbox', value: false },
          estimate: { kind: 'number', value: 4 },
          tags: { kind: 'tags', value: ['ops'] },
        },
      },
      {
        documentId: 'doc-c',
        title: 'Incident Triage Guide',
        updatedAt: '2026-11-12T10:00:00Z',
        role: 'editor',
        values: {
          status: { kind: 'status', value: 'in_progress' },
          priority: { kind: 'priority', value: 'urgent' },
          assignee: { kind: 'assignee', value: 'u-alice' },
          due_date: { kind: 'due_date', value: null },
          verified: { kind: 'checkbox', value: true },
          estimate: { kind: 'number', value: 3 },
          tags: { kind: 'tags', value: ['ops', 'security'] },
        },
      },
    ]

    // Tie-break by documentId when sorting by priority asc (`doc-a` and `doc-b` both have `high`)
    const byPriority = filterAndSortCollectionRows(
      rows,
      schema.properties,
      { searchQuery: '', statusId: null, priorityId: null, assigneeId: null, tagId: null },
      { propertyId: 'priority', direction: 'asc' },
      members
    )
    expect(byPriority.map((r) => r.documentId)).toEqual(['doc-a', 'doc-b', 'doc-c'])

    // Multi-chip filtering by assignee + tag + search query
    const filtered = filterAndSortCollectionRows(
      rows,
      schema.properties,
      {
        searchQuery: 'alice',
        statusId: null,
        priorityId: null,
        assigneeId: 'u-alice',
        tagId: 'security',
      },
      { propertyId: 'estimate', direction: 'desc' },
      members
    )
    expect(filtered.map((r) => r.documentId)).toEqual(['doc-b', 'doc-c'])

    // Rollups across all 3 rows: 2/3 done (67%), 2/3 verified (67%), sum=15, avg=5
    const rollups = computeCollectionRollups(rows, rows.length, schema.properties)
    expect(rollups.totalCount).toBe(3)
    expect(rollups.filteredCount).toBe(3)
    expect(rollups.doneCount).toBe(2)
    expect(rollups.donePercent).toBe(67)
    expect(rollups.checkboxByProperty['verified']?.checkedCount).toBe(2)
    expect(rollups.checkboxByProperty['verified']?.checkedPercent).toBe(67)
    expect(rollups.numericByProperty['estimate']).toEqual({
      propertyId: 'estimate',
      propertyName: 'Effort',
      count: 3,
      sum: 15,
      avg: 5,
    })
    expect(formatRollupNumber(15)).toBe('15')
    expect(formatRollupNumber(3.3333)).toBe('3.33')
    expect(formatRollupNumber(null)).toBe('—')
  })

  it('round-trips Core 0.44.0 wire collections and rows and sanitizes unsafe URLs on read', () => {
    const schema = createDefaultCollectionSchema('en')
    const wireProps = schema.properties.map(toWireCollectionProperty)
    const wireViews = schema.views.map(toWireCollectionView)

    expect(wireProps.find((p) => p.id === 'status')?.type).toBe('select')
    expect(wireProps.find((p) => p.id === 'tags')?.type).toBe('multi_select')
    expect(wireProps.find((p) => p.id === 'assignee')?.type).toBe('person')
    expect(wireProps.find((p) => p.id === 'due_date')?.type).toBe('date')
    expect(wireViews.map((v) => v.type)).toEqual(['table', 'board', 'list'])

    const hydrated = fromWireWorkspaceCollection({
      id: schema.id,
      title: schema.title,
      properties: [
        ...wireProps,
        { id: 'summary', name: 'Summary', type: 'CollectionTextProperty' },
      ],
      views: [
        ...wireViews,
        {
          id: 'alt_board',
          name: 'Priority Board',
          type: 'CollectionBoardView',
          groupByPropertyId: 'priority',
          showEmptyGroups: false,
        },
      ],
      role: 'editor',
      updatedAt: schema.updatedAt,
    })

    expect(hydrated.properties.find((p) => p.id === 'status')?.kind).toBe('status')
    expect(hydrated.properties.find((p) => p.id === 'summary')?.kind).toBe('text')
    expect(hydrated.views.find((v) => v.id === 'alt_board')?.kind).toBe('board')

    const wireRowValues = toWireWorkspaceCollectionRowValues({
      status: { kind: 'status', value: 'done' },
      estimate: { kind: 'number', value: 13 },
    })
    expect(wireRowValues['status']).toEqual({ type: 'select', value: 'done' })
    expect(toWireCollectionValue({ kind: 'checkbox', value: true })).toEqual({
      type: 'checkbox',
      value: true,
    })

    const parsedRow = fromWireWorkspaceCollectionRow(
      {
        documentId: 'doc-1',
        values: {
          ...wireRowValues,
          reference_url: { type: 'url', value: 'javascript:alert(1)' },
        },
        updatedAt: '2026-11-13T12:00:00Z',
      },
      hydrated.properties
    )
    expect(parsedRow.values['status']).toEqual({ kind: 'status', value: 'done' })
    expect(parsedRow.values['estimate']).toEqual({ kind: 'number', value: 13 })
    expect(parsedRow.values['reference_url']).toEqual({ kind: 'url', value: null })
  })
})
