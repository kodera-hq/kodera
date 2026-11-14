import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw/http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { onTrack, type AnalyticsEvent } from '@/analytics/track'
import { server } from '../../mocks/server'
import { problem } from '../../mocks/problem'
import { scenario as defaultPeople } from '../../mocks/overlays/people.default'
import { scenario as enrolmentActive } from '../../mocks/overlays/people.enrolment-active'
import { handlers as qrFailed } from '../../mocks/overlays/people.enrolment-qr-failed'
import { defaultMembers, peopleHandlers } from '../../mocks/overlays/support/people'
import { OnSitePanel } from './OnSitePanel'
import { ORG_ID, renderWithApi, signInSynthetic } from './test-support'

const TOKENS = '*/api/v1/organisations/:org/enrolment-tokens'
const DAY_MS = 24 * 60 * 60 * 1000

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterEach(() => {
  server.resetHandlers()
  stopTracking?.()
  vi.restoreAllMocks()
})
afterAll(() => server.close())
beforeEach(signInSynthetic)

let stopTracking: (() => void) | undefined
function recordEvents(): AnalyticsEvent[] {
  const events: AnalyticsEvent[] = []
  stopTracking = onTrack((event) => events.push(event))
  return events
}

function renderPanel(overlays: Parameters<typeof renderWithApi>[1]) {
  return renderWithApi(
    <OnSitePanel
      organisationId={ORG_ID}
      organisationName="ACME Construction"
      callerRole="org_owner"
    />,
    overlays
  )
}

/** Records every creation body, then lets the scenario's own handler answer. */
function spyOnCreation() {
  const bodies: { max_uses: number; expires_at: string; role: string }[] = []
  const keys: (string | null)[] = []
  const receivedAt: number[] = []
  server.use(
    http.post(TOKENS, async ({ request }) => {
      receivedAt.push(Date.now())
      bodies.push((await request.clone().json()) as (typeof bodies)[number])
      keys.push(request.headers.get('Idempotency-Key'))
      return undefined
    })
  )
  return { bodies, keys, receivedAt }
}

function printSheet(): HTMLElement {
  const sheet = document.body.querySelector<HTMLElement>(':scope > [data-print-sheet]')
  if (sheet === null) throw new Error('No print sheet in the document body.')
  return sheet
}

const paris = (iso: string) => ({
  date: new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' }).format(
    new Date(iso)
  ),
  time: new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short', timeZone: 'Europe/Paris' }).format(
    new Date(iso)
  ),
})

describe('OnSitePanel (03-people.md §4.4)', () => {
  it('explains the four steps without writing a duration into the copy', async () => {
    const { container } = renderPanel([defaultPeople()])
    expect(screen.getByRole('heading', { level: 2, name: 'Accès sur site' })).toBeInTheDocument()
    const steps = within(container).getAllByRole('listitem')
    expect(steps.slice(0, 4).map((step) => step.textContent)).toEqual([
      'Vous créez des places, par exemple douze.',
      "Vous imprimez la feuille et vous l'affichez.",
      'Chaque personne scanne le code avec son téléphone et enregistre son empreinte ou son visage. Une place par personne.',
      "Le code expire à la date et à l'heure imprimées sur la feuille.",
    ])
    expect(container.textContent).not.toMatch(/72/)
    // No sheet yet: the explanation is the empty state, next to the form.
    expect(
      await screen.findByText(
        "Aucune feuille active. Créez des places pour permettre à vos équipes de s'enregistrer sur place."
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Combien de places ?' })).toHaveValue('12')
    expect(screen.getByText(/Membre — peut participer aux réunions/)).toBeInTheDocument()
  })

  it('people/on-site: prints a sheet with both a code to scan and a code to type', async () => {
    const events = recordEvents()
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined)
    const user = userEvent.setup()
    const { container } = renderPanel([enrolmentActive()])
    const { bodies, keys, receivedAt } = spyOnCreation()

    // The existing sheet: used-of-total and expiry, read from the token.
    const existing = await screen.findByText(
      '12 places · 5 utilisées · expire le 5 mars 2027 à 10:12'
    )
    const existingRow = existing.closest('li') as HTMLElement
    expect(within(existingRow).queryByRole('button', { name: 'Imprimer' })).toBeNull()
    expect(within(existingRow).getByRole('button', { name: 'Désactiver' })).toBeInTheDocument()
    expect(events).toContainEqual({
      name: 'people_enrolment_claimed_view',
      properties: { used: 5, count: 12 },
    })

    const before = Date.now()
    await user.click(screen.getByRole('button', { name: 'Créer 12 places' }))

    const sheet = await within(container).findByRole('region', {
      name: 'Rejoignez la visio de ACME Construction',
    })
    // The contract caps the expiry at 24 hours ahead (EnrolmentTokenCreateRequest).
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ role: 'org_member', max_uses: 12 })
    const expiresAt = Date.parse(bodies[0]?.expires_at ?? '')
    expect(expiresAt - (receivedAt[0] ?? 0)).toBeLessThanOrEqual(DAY_MS)
    expect(expiresAt - before).toBeGreaterThanOrEqual(DAY_MS)
    expect(keys[0]).toBeTruthy()
    expect(events).toContainEqual({ name: 'people_enrolment_created', properties: { count: 12 } })

    const code = within(sheet).getByText(/^enr_7K4P92MB\d{4}$/).textContent ?? ''
    expect(within(sheet).getByRole('img', { name: `Code QR à scanner. Code à saisir : ${code}` }))
    expect(within(sheet).getByText(`https://app.kodera.io/enrol#${code}`)).toBeInTheDocument()
    const { date, time } = paris(bodies[0]?.expires_at ?? '')
    const validity = `Valable jusqu'au ${date} à ${time}. Une place par personne.`
    expect(within(sheet).getByText(validity)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()

    // The printable sheet: a direct child of the body, the code as text, no control.
    const printable = printSheet()
    expect(printable).toHaveTextContent('Rejoignez la visio de ACME Construction')
    expect(printable).toHaveTextContent(
      `Ou saisissez : https://app.kodera.io/enrol#${code}, code ${code}`
    )
    expect(printable).toHaveTextContent(validity)
    expect(printable.querySelector('svg[role="img"]')).not.toBeNull()
    expect(printable.querySelector('[aria-label]')?.getAttribute('aria-label')).toContain(code)
    // Showing a sheet leaves printing alone: any other print still prints the page.
    expect(document.body.className).not.toContain('print:')

    // Isolation holds for the print call only, then the body is as it was.
    let classesDuringPrint = ''
    print.mockImplementation(() => {
      classesDuringPrint = document.body.className
    })
    await user.click(within(sheet).getByRole('button', { name: 'Imprimer' }))
    expect(print).toHaveBeenCalledTimes(1)
    expect(classesDuringPrint).toContain('print:[&>*]:hidden')
    expect(classesDuringPrint).toContain('print:[&>[data-print-sheet]]:block')
    expect(document.body.className).not.toContain('print:')
    expect(events).toContainEqual({ name: 'people_enrolment_printed', properties: {} })

    // The sheet created in this session can be shown and printed again from the list.
    const createdRow = (await screen.findByText(/^12 places · 0 utilisées · expire le/)).closest(
      'li'
    ) as HTMLElement
    expect(within(createdRow).getByRole('button', { name: 'Voir le code' })).toBeInTheDocument()
    expect(within(createdRow).getByRole('button', { name: 'Imprimer' })).toBeInTheDocument()
  })

  it('people/on-site: still gives a usable code when the image fails', async () => {
    const user = userEvent.setup()
    const { container } = renderPanel([defaultPeople(), qrFailed])
    await user.click(await screen.findByRole('button', { name: 'Créer 12 places' }))

    const sheet = await within(container).findByRole('region', {
      name: 'Rejoignez la visio de ACME Construction',
    })
    expect(
      within(sheet).getByText(
        "Le code à scanner n'a pas pu s'afficher. Le code à saisir ci-dessous fonctionne et peut être imprimé."
      )
    ).toBeInTheDocument()
    expect(within(sheet).queryByRole('img')).toBeNull()
    expect(within(sheet).getByText('enr_7K4P92MB0000')).toBeInTheDocument()
    expect(
      within(sheet).getByText('https://app.kodera.io/enrol#enr_7K4P92MB0000')
    ).toBeInTheDocument()
    const printable = printSheet()
    expect(printable).toHaveTextContent(
      'Ou saisissez : https://app.kodera.io/enrol#enr_7K4P92MB0000, code enr_7K4P92MB0000'
    )
    expect(printable.querySelector('svg')).toBeNull()
  })

  it('isolates the sheet until `afterprint` and keeps the body classes it found', async () => {
    const user = userEvent.setup()
    document.body.classList.add('theme-kept', 'print:[&>*]:hidden')
    const during: string[] = []
    const after: string[] = []
    vi.spyOn(window, 'print').mockImplementation(() => {
      during.push(document.body.className)
      window.dispatchEvent(new Event('afterprint'))
      after.push(document.body.className)
    })
    try {
      const { container } = renderPanel([defaultPeople()])
      await user.click(await screen.findByRole('button', { name: 'Créer 12 places' }))
      const sheet = await within(container).findByRole('region', {
        name: 'Rejoignez la visio de ACME Construction',
      })
      await user.click(within(sheet).getByRole('button', { name: 'Imprimer' }))

      expect(during[0]).toContain('print:[&>[data-print-sheet]]:block')
      // `afterprint` ends the isolation before `print()` returns.
      expect(after[0]).not.toContain('print:[&>[data-print-sheet]]:block')
      // A class the page already had is not the panel's to remove.
      expect(document.body.classList).toContain('theme-kept')
      expect(document.body.classList).toContain('print:[&>*]:hidden')
    } finally {
      document.body.classList.remove('theme-kept', 'print:[&>*]:hidden')
    }
  })

  it('lists the active sheets of every page, not only the first', async () => {
    const tokens = Array.from({ length: 130 }, (_, index) => ({
      id: `e1e1e1e1-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      organisation_id: ORG_ID,
      role: 'org_member' as const,
      state: 'active' as const,
      max_uses: index + 1,
      uses: 0,
      label: null,
      fingerprint: '4a1b2c3d4e5f6071',
      expires_at: '2027-03-05T09:12:00Z',
      created_at: '2027-03-04T09:12:00Z',
    }))
    renderPanel([
      peopleHandlers({ callerRole: 'org_owner', members: defaultMembers('org_owner'), tokens }),
    ])
    expect(await screen.findByText(/^130 places · 0 utilisées/)).toBeInTheDocument()
    expect(screen.getByText(/^1 places? · 0 utilisées/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Désactiver' })).toHaveLength(130)
  })

  it('stops reading sheet pages after a bounded number of pages', async () => {
    const cursors: (string | null)[] = []
    renderPanel([
      defaultPeople(),
      [
        http.get(TOKENS, ({ request }) => {
          const cursor = new URL(request.url).searchParams.get('cursor')
          cursors.push(cursor)
          return HttpResponse.json({
            data: [],
            has_more: true,
            next_cursor: String(Number(cursor ?? '0') + 1),
          })
        }),
      ],
    ])
    expect(await screen.findByRole('button', { name: 'Créer 12 places' })).toBeInTheDocument()
    await waitFor(() => expect(cursors.length).toBeGreaterThan(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(cursors.length).toBeLessThanOrEqual(20)
  })

  it('refuses a count outside 1–200 on blur and sends nothing', async () => {
    const user = userEvent.setup()
    renderPanel([defaultPeople()])
    const { bodies } = spyOnCreation()
    const field = screen.getByRole('textbox', { name: 'Combien de places ?' })
    for (const value of ['0', '201', 'douze', '']) {
      fireEvent.change(field, { target: { value } })
      fireEvent.blur(field)
      expect(field).toHaveAccessibleDescription(
        expect.stringContaining('Indiquez un nombre de places compris entre 1 et 200.')
      )
    }
    await user.click(screen.getByRole('button', { name: /^Créer/ }))
    expect(bodies).toHaveLength(0)

    fireEvent.change(field, { target: { value: '30' } })
    fireEvent.blur(field)
    expect(screen.queryByText('Indiquez un nombre de places compris entre 1 et 200.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Créer 30 places' })).toBeInTheDocument()
  })

  it('keeps the count and retries with the same key after a failed creation', async () => {
    const user = userEvent.setup()
    renderPanel([defaultPeople()])
    let fail = true
    const keys: (string | null)[] = []
    server.use(
      http.post(TOKENS, ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key'))
        if (!fail) return undefined
        fail = false
        return problem('https://kodera.io/problems/internal-error')
      })
    )
    await user.click(await screen.findByRole('button', { name: 'Créer 12 places' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le service est momentanément indisponible.'
    )
    await user.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(
      await screen.findByRole('region', { name: 'Rejoignez la visio de ACME Construction' })
    ).toBeInTheDocument()
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  it('disables creation offline and says why', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    renderPanel([defaultPeople()])
    expect(screen.getByRole('button', { name: 'Créer 12 places' })).toBeDisabled()
    expect(screen.getByText(/Votre connexion à Internet est interrompue/)).toBeInTheDocument()
  })

  it('confirms before deactivating, focusing the question; Escape cancels', async () => {
    const user = userEvent.setup()
    renderPanel([enrolmentActive()])
    const deletes: string[] = []
    server.use(
      http.delete(`${TOKENS}/:id`, ({ params }) => {
        deletes.push(String(params['id']))
        return undefined
      })
    )
    const row = (await screen.findByText(/^12 places · 5 utilisées/)).closest('li') as HTMLElement

    await user.click(within(row).getByRole('button', { name: 'Désactiver' }))
    const dialog = await screen.findByRole('dialog', { name: 'Désactiver cette feuille ?' })
    expect(
      within(dialog).getByRole('heading', { name: 'Désactiver cette feuille ?' })
    ).toHaveFocus()
    expect(dialog).toHaveTextContent('Les 7 places non utilisées ne pourront plus être réclamées.')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deletes).toHaveLength(0)

    await user.click(within(row).getByRole('button', { name: 'Désactiver' }))
    const again = await screen.findByRole('dialog', { name: 'Désactiver cette feuille ?' })
    await user.click(within(again).getByRole('button', { name: 'Désactiver' }))
    await waitFor(() => expect(screen.queryByText(/^12 places · 5 utilisées/)).toBeNull())
    expect(deletes).toEqual(['e1e1e1e1-0000-4000-8000-000000000001'])
  })

  it('says the sheet has expired when deactivation conflicts', async () => {
    const user = userEvent.setup()
    renderPanel([enrolmentActive()])
    server.use(
      http.delete(`${TOKENS}/:id`, () => problem('https://kodera.io/problems/conflict'))
    )
    const row = (await screen.findByText(/^12 places · 5 utilisées/)).closest('li') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Désactiver' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Désactiver' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cette feuille a expiré. Créez-en une nouvelle.'
    )
  })
})
