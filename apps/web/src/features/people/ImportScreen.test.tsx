import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw/http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { server } from '../../mocks/server'
import { problem } from '../../mocks/problem'
import {
  handlers as scrubbed,
  SCRUBBED_IMPORT_ID,
} from '../../mocks/overlays/people.import-completed-scrubbed'
import { scenario as executionPartial } from '../../mocks/overlays/people.import-execution-partial'
import { handlers as fileTooLarge } from '../../mocks/overlays/people.import-file-too-large'
import { scenario as importMixed } from '../../mocks/overlays/people.import-mixed'
import { memberImportHandlers, type MemberImport } from '../../mocks/overlays/support/people'
import { ImportScreen, type ImportScreenProps } from './ImportScreen'
import { ORG_ID, renderWithApi, signInSynthetic } from './test-support'

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
beforeEach(signInSynthetic)
beforeEach(() => {
  // The test runner rebuilds each request as a Node `Request`, and its jsdom
  // shim cannot read a jsdom `File` inside a `FormData`. Tests send the file's
  // name in its place; the mocks never read the multipart body.
  const append = FormData.prototype.append
  vi.spyOn(FormData.prototype, 'append').mockImplementation(function (
    this: FormData,
    name: string,
    value: string | Blob
  ) {
    Reflect.apply(append, this, [name, value instanceof File ? value.name : value])
  })
})

const DROP_LABEL = 'Déposez votre fichier ici, ou parcourez vos dossiers'
const UNAVAILABLE =
  'Le service est momentanément indisponible. Réessayez dans quelques minutes ; si cela persiste, écrivez-nous à support@kodera.io.'
const UPLOAD_FAILED =
  "Le fichier n'a pas pu être envoyé. Vérifiez votre connexion, puis déposez-le à nouveau."

function dropZone() {
  return screen.getByRole('button', { name: DROP_LABEL })
}

function renderImport(
  overlays: Parameters<typeof renderWithApi>[1],
  props: Partial<ImportScreenProps> = {}
) {
  const onImportStarted = vi.fn()
  const onNavigate = vi.fn()
  const view = renderWithApi(
    <ImportScreen
      organisationId={ORG_ID}
      callerRole="org_admin"
      onImportStarted={onImportStarted}
      onNavigate={onNavigate}
      {...props}
    />,
    overlays
  )
  return { ...view, onImportStarted, onNavigate }
}

function csv(
  name = 'equipe.csv',
  content = 'Prénom,Nom,Adresse mail\nJulie,Leroy,julie@acme.fr\n',
  lastModified?: number
) {
  return new File([content], name, {
    type: 'text/csv',
    ...(lastModified === undefined ? {} : { lastModified }),
  })
}

function drop(file: File) {
  fireEvent.drop(screen.getByRole('button', { name: DROP_LABEL }), {
    dataTransfer: { files: [file] },
  })
}

/** Captures what a stubbed `URL.createObjectURL` was handed: the generated file. */
function captureDownloads() {
  const blobs: Blob[] = []
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      blobs.push(blob)
      return 'blob:synthetic'
    },
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: () => undefined,
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
  return blobs
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
}

async function uploadAndMap() {
  drop(csv())
  return screen.findByRole('button', { name: 'Inviter 118 personnes' })
}

describe('Import a list (03-people.md §4.3)', () => {
  it('offers the drop zone, the rules and a template built locally', async () => {
    const blobs = captureDownloads()
    renderImport([importMixed()])
    expect(screen.getByRole('heading', { level: 1, name: 'Importer une liste' })).toBeVisible()
    expect(screen.getByRole('button', { name: DROP_LABEL })).toBeVisible()
    expect(screen.getByText('CSV · 5 000 lignes maximum · 2 Mo')).toBeVisible()
    expect(screen.getByText(/Le fichier est supprimé par le serveur/)).toBeVisible()

    // `onUnhandledFrame: 'error'`: a request for the template would fail the test.
    await userEvent.click(screen.getByRole('button', { name: 'Télécharger un modèle' }))
    expect(blobs).toHaveLength(1)
    expect(await readBlob(blobs[0]!)).toContain('E-mail;Prénom;Nom;Rôle')
  })

  it('people/import: separates ready, duplicate and invalid rows before importing', async () => {
    const patches: unknown[] = []
    const contentTypes: (string | null)[] = []
    const { onImportStarted } = renderImport([
      importMixed(),
      [
        http.post('*/api/v1/organisations/:org/member-imports', ({ request }) => {
          contentTypes.push(request.headers.get('Content-Type'))
          return undefined
        }),
        http.patch('*/api/v1/member-imports/:id', async ({ request }) => {
          patches.push(await request.clone().json())
          return undefined
        }),
      ],
    ])
    await uploadAndMap()
    expect(contentTypes[0]).toMatch(/^multipart\/form-data; boundary=/)
    expect(onImportStarted).toHaveBeenCalledWith(expect.any(String))
    expect(screen.getByText('Nous avons trouvé 124 lignes.')).toBeVisible()

    // Each detected column is mapped by recognising its header and sample.
    expect(
      screen.getByRole('combobox', { name: 'Champ pour la colonne Adresse mail' })
    ).toHaveTextContent('E-mail')
    expect(
      screen.getByRole('combobox', { name: 'Champ pour la colonne Prénom' })
    ).toHaveTextContent('Prénom')
    expect(screen.getByRole('combobox', { name: 'Champ pour la colonne Nom' })).toHaveTextContent(
      'Nom'
    )
    expect(
      screen.getByRole('combobox', { name: 'Champ pour la colonne Service' })
    ).toHaveTextContent('Ignorer')
    expect(screen.getByText('Exemple : julie.leroy@acme.fr')).toBeVisible()
    expect(patches[0]).toEqual({
      column_mapping: { email: 2, given_name: 0, family_name: 1, role: null },
      default_role: 'org_member',
    })

    // §10: a list of sentences, the count inside each one.
    const counters = screen.getByText('118 prêtes à être invitées').closest('ul')!
    expect(
      within(counters)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      '118 prêtes à être invitées',
      '4 déjà membres — elles seront ignorées',
      '2 adresses en double dans le fichier — une seule sera conservée',
      '0 adresses illisibles',
    ])
    expect(screen.getByText(/Cette liste est conservée jusqu'au .+ au plus tard/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Inviter 118 personnes' })).toBeEnabled()
  })

  it('resumes on the mapping step when the route remounts it with the import id', async () => {
    const handlers = importMixed()
    const first = renderImport([handlers])
    drop(csv())
    await waitFor(() => expect(first.onImportStarted).toHaveBeenCalled())
    const id = first.onImportStarted.mock.calls[0]![0] as string
    first.unmount()

    renderImport([], { importId: id })
    expect(
      await screen.findByRole('combobox', { name: 'Champ pour la colonne Adresse mail' })
    ).toHaveTextContent('E-mail')
    expect(await screen.findByRole('button', { name: 'Inviter 118 personnes' })).toBeVisible()
    expect(screen.queryByRole('button', { name: DROP_LABEL })).toBeNull()
  })

  it('offers billing as the default role to an owner only', async () => {
    const patches: { default_role?: string }[] = []
    renderImport(
      [
        importMixed(),
        [
          http.patch('*/api/v1/member-imports/:id', async ({ request }) => {
            patches.push((await request.clone().json()) as { default_role?: string })
            return undefined
          }),
        ],
      ],
      { callerRole: 'org_owner' }
    )
    await uploadAndMap()
    await userEvent.click(screen.getByRole('radio', { name: /^Facturation/ }))
    await waitFor(() => expect(patches.at(-1)?.default_role).toBe('org_billing'))
  })

  it('keeps billing away from an administrator', async () => {
    renderImport([importMixed()], { callerRole: 'org_admin' })
    await uploadAndMap()
    expect(screen.getByRole('radio', { name: /^Membre/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /^Administrateur/ })).toBeVisible()
    expect(screen.queryByRole('radio', { name: /Facturation/ })).toBeNull()
  })

  it('asks for the email column before importing', async () => {
    const record: MemberImport = {
      id: '0b0b0b0b-0000-4000-8000-000000000001',
      organisation_id: ORG_ID,
      state: 'uploaded',
      filename: 'liste.csv',
      row_count: 3,
      detected_columns: [
        { index: 0, header: 'Service', sample: 'Chantier' },
        { index: 1, header: 'Ville', sample: 'Lyon' },
      ],
      column_mapping: null,
      staging_expires_at: '2027-03-11T09:12:00Z',
      created_at: '2027-03-04T09:12:00Z',
      rows: [],
    }
    renderImport(
      [
        [
          http.get('*/api/v1/member-imports/:id', () =>
            HttpResponse.json(record, { headers: { ETag: '"no-email-1"' } })
          ),
        ],
      ],
      { importId: record.id }
    )
    await userEvent.click(await screen.findByRole('button', { name: /^Inviter/ }))
    expect(
      await screen.findByText('Indiquez quelle colonne contient les adresses e-mail.')
    ).toBeVisible()
  })

  it('says when no usable address was found and offers the template', async () => {
    renderImport([
      memberImportHandlers({
        summary: { ready: 0, already_member: 0, already_invited: 0, duplicate: 0, invalid: 3 },
      }),
    ])
    drop(csv())
    expect(
      await screen.findByText("Aucune adresse exploitable n'a été trouvée dans ce fichier.")
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Télécharger un modèle' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Inviter/ })).toBeNull()
  })

  it('people/import: lists the failed rows with their line number and reason', async () => {
    const blobs = captureDownloads()
    const executions: unknown[] = []
    renderImport([
      executionPartial(),
      [
        http.post('*/api/v1/member-imports/:id/actions/execute', async ({ request }) => {
          executions.push(await request.clone().json())
          return undefined
        }),
      ],
    ])
    await userEvent.click(await uploadAndMap())

    expect(await screen.findByRole('heading', { name: '114 invitations envoyées' })).toBeVisible()
    expect(screen.getByText("4 n'ont pas pu être envoyées :")).toBeVisible()
    const table = screen.getByRole('table', { name: 'Lignes en échec' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toHaveTextContent('ligne 42')
    expect(rows[0]).toHaveTextContent('jean.martin@acme..fr')
    expect(rows[0]).toHaveTextContent('Adresse invalide')
    expect(rows[1]).toHaveTextContent("Cette boîte aux lettres n'existe pas.")
    expect(rows[2]).toHaveTextContent('Invitation déjà envoyée.')
    expect(
      screen.getByText(/Les lignes encore en échec seront supprimées au plus tard le/)
    ).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: 'Télécharger les lignes en échec' }))
    const file = await readBlob(blobs[0]!)
    expect(file).toContain('42;jean.martin@acme..fr;Adresse invalide')
    expect(file.split('\n').filter((line) => line.trim() !== '')).toHaveLength(5)

    await userEvent.click(screen.getByRole('button', { name: 'Réessayer les 4 lignes en échec' }))
    expect(await screen.findByRole('heading', { name: '118 invitations envoyées' })).toBeVisible()
    expect(executions.at(-1)).toMatchObject({ only_lines: [42, 77, 91, 103] })
  })

  it('confirms a complete import and links to the Invitations tab', async () => {
    const { onNavigate } = renderImport([importMixed()])
    await userEvent.click(await uploadAndMap())
    expect(await screen.findByRole('heading', { name: '118 invitations envoyées' })).toBeVisible()
    // The heading, and the toast that confirms it.
    await waitFor(() => expect(screen.getAllByText('118 invitations envoyées')).toHaveLength(2))
    await userEvent.click(screen.getByRole('button', { name: 'Voir les invitations' }))
    expect(onNavigate).toHaveBeenCalledWith({ to: 'invitations' })
  })

  it('announces the send at its start, never per row', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    renderImport([
      importMixed(),
      [
        http.post('*/api/v1/member-imports/:id/actions/execute', async () => {
          await gate
          return undefined
        }),
      ],
    ])
    await userEvent.click(await uploadAndMap())
    const announced = await screen.findAllByText('Envoi en cours… 0 sur 118')
    expect(announced.some((node) => node.getAttribute('aria-live') === 'polite')).toBe(true)
    release()
    expect(await screen.findByRole('heading', { name: '118 invitations envoyées' })).toBeVisible()
  })

  it('keeps the list and offers one retry when the send fails entirely', async () => {
    const keys: (string | null)[] = []
    let call = 0
    renderImport([
      importMixed(),
      [
        http.post('*/api/v1/member-imports/:id/actions/execute', ({ request }) => {
          keys.push(request.headers.get('Idempotency-Key'))
          call += 1
          return call === 1 ? HttpResponse.error() : undefined
        }),
      ],
    ])
    await userEvent.click(await uploadAndMap())
    expect(
      await screen.findByText(
        "Aucune invitation n'a été envoyée. Votre liste est conservée : réessayez."
      )
    ).toBeVisible()
    expect(screen.getByText('118 prêtes à être invitées')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: 'Inviter 118 personnes' }))
    expect(await screen.findByRole('heading', { name: '118 invitations envoyées' })).toBeVisible()
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
  })

  it('people/import: renders durable counts after personal staging data is scrubbed', async () => {
    renderImport([scrubbed], { importId: SCRUBBED_IMPORT_ID })
    expect(await screen.findByRole('heading', { name: '118 invitations envoyées' })).toBeVisible()
    expect(screen.queryByText(/equipe\.csv/)).toBeNull()
    expect(screen.queryByText(/Exemple/)).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('people/import: names the limit when the file is too large', async () => {
    renderImport([importMixed(), fileTooLarge])
    drop(csv())
    expect(
      await screen.findByText(
        'Le fichier dépasse la limite de 2 Mo ou de 5 000 lignes. Découpez-le en plusieurs fichiers.'
      )
    ).toBeVisible()
    expect(screen.getByText('CSV · 5 000 lignes maximum · 2 Mo')).toBeVisible()
    const zone = screen.getByRole('button', { name: DROP_LABEL })
    expect(zone).not.toHaveAttribute('aria-disabled')
    expect(zone).toHaveAccessibleDescription(expect.stringContaining('2 Mo'))
  })

  it('refuses an oversized or non-CSV file before any request', () => {
    renderImport([importMixed()])
    const big = csv()
    Object.defineProperty(big, 'size', { value: 3 * 1024 * 1024 })
    drop(big)
    expect(
      screen.getByText(
        'Le fichier dépasse la limite de 2 Mo ou de 5 000 lignes. Découpez-le en plusieurs fichiers.'
      )
    ).toBeVisible()
    drop(new File(['x'], 'liste.xlsx', { type: 'application/vnd.ms-excel' }))
    expect(screen.getByText("Ce format n'est pas accepté. Utilisez un fichier CSV.")).toBeVisible()
  })

  it('names the line where the parse stopped, never the server prose', async () => {
    renderImport([
      importMixed(),
      [
        http.post('*/api/v1/organisations/:org/member-imports', () =>
          problem('https://kodera.io/problems/validation-error', {
            detail: 'Unterminated quote.',
            errors: [{ pointer: '/rows/17', code: 'unterminated_quote' }],
          })
        ),
      ],
    ])
    drop(csv())
    expect(
      await screen.findByText(
        "La lecture du fichier s'est arrêtée à la ligne 17. Vérifiez cette ligne, ou repartez du modèle."
      )
    ).toBeVisible()
    expect(screen.queryByText(/Unterminated/)).toBeNull()
    expect(screen.getByRole('button', { name: DROP_LABEL })).toBeVisible()
  })

  it('sends one mapping at a time and ends on the latest choice', async () => {
    let inFlight = 0
    let most = 0
    const bodies: { default_role?: string }[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    renderImport([
      importMixed(),
      [
        http.patch('*/api/v1/member-imports/:id', async ({ request }) => {
          inFlight += 1
          most = Math.max(most, inFlight)
          bodies.push((await request.clone().json()) as { default_role?: string })
          if (bodies.length === 1) await gate
          inFlight -= 1
          return undefined
        }),
      ],
    ])
    drop(csv())
    await waitFor(() => expect(bodies).toHaveLength(1))
    // Three choices while the first guess is still being applied.
    await userEvent.click(await screen.findByRole('radio', { name: /^Administrateur/ }))
    await userEvent.click(screen.getByRole('radio', { name: /^Membre/ }))
    await userEvent.click(screen.getByRole('radio', { name: /^Administrateur/ }))
    release()
    // A first-response render can show the action before the queued latest mapping is sent.
    // Observe that second real request, then wait for its UI acknowledgement.
    await waitFor(() => expect(bodies).toHaveLength(2))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Inviter 118 personnes' })).toBeEnabled()
    )
    expect(most).toBe(1)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]?.default_role).toBe('org_admin')
  })

  it('re-reads and re-applies the mapping once when the record changed underneath', async () => {
    let patches = 0
    renderImport([
      importMixed(),
      [
        http.patch('*/api/v1/member-imports/:id', () => {
          patches += 1
          return patches === 1
            ? problem('https://kodera.io/problems/precondition-failed')
            : undefined
        }),
      ],
    ])
    expect(await uploadAndMap()).toBeVisible()
    expect(patches).toBe(2)
    expect(screen.queryByText(UNAVAILABLE)).toBeNull()
  })

  it('says the mapping failed when the record keeps changing underneath', async () => {
    let patches = 0
    renderImport([
      importMixed(),
      [
        http.patch('*/api/v1/member-imports/:id', () => {
          patches += 1
          return problem('https://kodera.io/problems/precondition-failed')
        }),
      ],
    ])
    drop(csv())
    expect(await screen.findByText(UNAVAILABLE)).toBeVisible()
    expect(patches).toBe(2)
  })

  it('keeps the send and retries only the read when the result cannot be read back', async () => {
    const keys: (string | null)[] = []
    let readFailed = false
    renderImport([
      importMixed(),
      [
        http.post('*/api/v1/member-imports/:id/actions/execute', ({ request }) => {
          keys.push(request.headers.get('Idempotency-Key'))
          return undefined
        }),
        http.get('*/api/v1/member-imports/:id', () => {
          if (keys.length === 0 || readFailed) return undefined
          readFailed = true
          return HttpResponse.error()
        }),
      ],
    ])
    await userEvent.click(await uploadAndMap())
    expect(await screen.findByText(UNAVAILABLE)).toBeVisible()
    expect(
      screen.queryByText(
        "Aucune invitation n'a été envoyée. Votre liste est conservée : réessayez."
      )
    ).toBeNull()
    // The send went through: no second send is offered, only the read again.
    expect(screen.queryByRole('button', { name: 'Inviter 118 personnes' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(await screen.findByRole('heading', { name: '118 invitations envoyées' })).toBeVisible()
    expect(keys).toHaveLength(1)
  })

  it('reuses the upload key for the same file after a network failure, not for another file', async () => {
    const keys: (string | null)[] = []
    const { onImportStarted } = renderImport([
      importMixed(),
      [
        http.post('*/api/v1/organisations/:org/member-imports', ({ request }) => {
          keys.push(request.headers.get('Idempotency-Key'))
          return keys.length <= 2 ? HttpResponse.error() : undefined
        }),
      ],
    ])
    const same = () => csv('equipe.csv', 'a@acme.fr\n', 1)
    drop(same())
    await waitFor(() => expect(dropZone()).not.toHaveAttribute('aria-disabled'))
    expect(screen.getByText(UPLOAD_FAILED)).toBeVisible()
    drop(same())
    await waitFor(() => expect(keys).toHaveLength(2))
    await waitFor(() => expect(dropZone()).not.toHaveAttribute('aria-disabled'))
    drop(csv('autre.csv', 'a@acme.fr\n', 1))
    await waitFor(() => expect(onImportStarted).toHaveBeenCalled())
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0])
  })

  it('takes a new upload key for the same file once the server has answered', async () => {
    const keys: (string | null)[] = []
    const { onImportStarted } = renderImport([
      importMixed(),
      [
        http.post('*/api/v1/organisations/:org/member-imports', ({ request }) => {
          keys.push(request.headers.get('Idempotency-Key'))
          return keys.length === 1
            ? problem('https://kodera.io/problems/validation-error', {
                errors: [{ pointer: '/rows/3', code: 'unterminated_quote' }],
              })
            : undefined
        }),
      ],
    ])
    drop(csv('equipe.csv', 'a@acme.fr\n', 1))
    await waitFor(() => expect(dropZone()).not.toHaveAttribute('aria-disabled'))
    drop(csv('equipe.csv', 'a@acme.fr\n', 1))
    await waitFor(() => expect(onImportStarted).toHaveBeenCalled())
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(keys[0])
  })

  it('stops polling after failed reads, backing off, and offers a retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const record: MemberImport = {
        id: '0b0b0b0b-0000-4000-8000-000000000002',
        organisation_id: ORG_ID,
        state: 'validating',
        filename: 'liste.csv',
        row_count: 124,
        detected_columns: [{ index: 0, header: 'Adresse mail', sample: 'julie@acme.fr' }],
        column_mapping: { email: 0, given_name: null, family_name: null, role: null },
        staging_expires_at: '2027-03-11T09:12:00Z',
        created_at: '2027-03-04T09:12:00Z',
        rows: [],
      }
      const readAt: number[] = []
      let failing = true
      renderImport(
        [
          [
            http.get('*/api/v1/member-imports/:id', () => {
              readAt.push(Date.now())
              if (readAt.length > 1 && failing) return HttpResponse.error()
              return HttpResponse.json(
                failing
                  ? record
                  : {
                      ...record,
                      state: 'ready',
                      summary: {
                        ready: 118,
                        already_member: 4,
                        already_invited: 0,
                        duplicate: 2,
                        invalid: 0,
                      },
                    },
                { headers: { ETag: `"poll-${readAt.length}"` } }
              )
            }),
          ],
        ],
        { importId: record.id }
      )
      await vi.advanceTimersByTimeAsync(60_000)
      // The first read, one poll, then three retries spaced 1 s, 2 s, 4 s.
      expect(readAt).toHaveLength(5)
      const gaps = readAt.slice(2).map((at, index) => at - readAt[index + 1]!)
      expect(gaps[0]).toBeGreaterThanOrEqual(1000)
      expect(gaps[1]).toBeGreaterThanOrEqual(2000)
      expect(gaps[2]).toBeGreaterThanOrEqual(4000)
      expect(screen.getByText(UNAVAILABLE)).toBeVisible()

      failing = false
      fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
      await vi.advanceTimersByTimeAsync(100)
      expect(readAt).toHaveLength(6)
      await waitFor(() => expect(screen.queryByText(UNAVAILABLE)).toBeNull())
    } finally {
      vi.useRealTimers()
    }
  })

  it('disables the upload offline and says why', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    renderImport([importMixed()])
    expect(screen.getByRole('button', { name: DROP_LABEL })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
    expect(screen.getByText(/Votre connexion à Internet est interrompue/)).toBeVisible()
  })
})
