import { act, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { StrictMode, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { authAdapter } from '../../auth/oidc'
import type { AuthSessionSnapshot } from '../../auth/AuthAdapter'
import { ToastProvider } from '../../ui/Toast/Toast'
import { peopleKeys } from './queries'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { server } from '../../mocks/server'
import { problem } from '../../mocks/problem'
import { scenario as defaultPeople } from '../../mocks/overlays/people.default'
import { scenario as lastOwner } from '../../mocks/overlays/people.last-owner'
import { scenario as ownerPeople } from '../../mocks/overlays/people.owner-role'
import { CALLER_MEMBERSHIP_ID, member } from '../../mocks/overlays/support/people'
import { MemberDrawer } from './MemberDrawer'
import { useMembershipsQuery } from './queries'
import type { OrganisationRole } from './roles'
import { onTrack, type AnalyticsEvent } from '@/analytics/track'
import { ORG_ID, renderWithApi, signInSynthetic } from './test-support'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
beforeEach(signInSynthetic)

describe('role change readback', () => {
  it('locks a committed role until its detail can be read, even when list refresh succeeds', async () => {
    const marc = member('Marc Petit', 'marc.petit@acme.fr', 'org_member')
    const url = '*/api/v1/organisations/:org/memberships/:id'
    const trace: { call: string; status: number; role?: string; ifMatch?: string | null }[] = []
    let serverRole: OrganisationRole = 'org_member'
    let detailReads = 0
    let patches = 0
    renderWithApi(<OpenByName name="Marc Petit" callerRole="org_admin" onClose={vi.fn()} />, [
      defaultPeople(),
      [
        http.get('*/api/v1/organisations/:org/memberships', () => {
          trace.push({ call: 'list', status: 200, role: serverRole })
          return HttpResponse.json({
            data: [{ ...marc, role: serverRole }],
            has_more: false,
            next_cursor: null,
          })
        }),
        http.get(url, () => {
          detailReads += 1
          if (patches > 0) {
            trace.push({ call: 'detail', status: 503 })
            return HttpResponse.json(
              { type: 'about:blank', status: 503, title: 'Temporarily unavailable' },
              { status: 503, headers: { 'Content-Type': 'application/problem+json' } }
            )
          }
          trace.push({ call: 'detail', status: 200, role: serverRole })
          return HttpResponse.json(
            {
              ...marc,
              role: serverRole,
              can_change_role: true,
              can_remove: true,
              blocked_reason: null,
            },
            { headers: { ETag: `"marc-${detailReads}"` } }
          )
        }),
        http.patch(url, async ({ request }) => {
          const change = (await request.json()) as { role: OrganisationRole }
          expect(change).toEqual({ role: 'org_admin' })
          expect(request.headers.get('If-Match')).toBe('"marc-2"')
          patches += 1
          serverRole = change.role
          trace.push({
            call: 'patch-ack',
            status: 200,
            role: serverRole,
            ifMatch: request.headers.get('If-Match'),
          })
          return HttpResponse.json({ ...marc, role: serverRole }, { headers: { ETag: '"marc-3"' } })
        }),
      ],
    ])
    const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
    const role = await within(drawer).findByRole('combobox', { name: 'Rôle' })
    await userEvent.click(role)
    await userEvent.click(await screen.findByRole('option', { name: 'Administrateur' }))
    await waitFor(() => {
      expect(trace.some((call) => call.call === 'detail' && call.status === 503)).toBe(true)
      expect(
        screen.queryByText('Marc Petit est maintenant administrateur.') ??
          screen.queryByText(
            "Le changement de rôle a été enregistré, mais la fiche n'a pas pu être actualisée. Actualisez-la avant toute autre modification."
          )
      ).not.toBeNull()
    })
    expect(patches).toBe(1)
    expect(trace.filter((call) => call.call === 'detail' && call.status === 200)).toHaveLength(2)
    expect(trace.some((call) => call.call === 'list' && call.role === 'org_admin')).toBe(true)
    // Original response objects never mutate when the separate server role changes.
    expect(marc.role).toBe('org_member')
    console.info(
      'ROLE_READBACK_OBSERVED ' +
        JSON.stringify({
          trace,
          serverRole,
          displayedRole: role.textContent,
          roleEditable: !role.hasAttribute('disabled'),
          requestedRoleToast:
            screen.queryByText('Marc Petit est maintenant administrateur.') !== null,
        })
    )
    expect(
      role,
      'committed write with unavailable detail must never leave stale role editable'
    ).toBeDisabled()
    expect(screen.queryByText('Marc Petit est maintenant administrateur.')).toBeNull()
    expect(within(drawer).getByRole('button', { name: 'Actualiser la fiche' })).toBeEnabled()
  })
})

/** Resolves a person's membership id from the list, as the row link does. */
function OpenByName({
  name,
  callerRole,
  onClose,
}: {
  name: string
  callerRole: OrganisationRole
  onClose: () => void
}) {
  const list = useMembershipsQuery(ORG_ID, 'all')
  const id = list.data?.pages[0]?.data.find((m) => m.display_name === name)?.id
  return id === undefined ? null : (
    <MemberDrawer organisationId={ORG_ID} callerRole={callerRole} memberId={id} onClose={onClose} />
  )
}

describe('Member detail (03-people.md §4.5)', () => {
  it('disables the last owner’s role and removal, each with the sentence naming the fix', async () => {
    renderWithApi(
      <MemberDrawer
        organisationId={ORG_ID}
        callerRole="org_owner"
        memberId={CALLER_MEMBERSHIP_ID}
        onClose={vi.fn()}
      />,
      [lastOwner()]
    )
    const drawer = await screen.findByRole('dialog', { name: 'Julie Marchand' })
    expect(within(drawer).getByRole('combobox', { name: 'Rôle' })).toBeDisabled()
    expect(within(drawer).getByRole('button', { name: "Retirer de l'organisation" })).toBeDisabled()
    expect(
      within(drawer).getAllByText(
        "Votre organisation doit conserver au moins un propriétaire. Nommez quelqu'un d'autre avant de modifier ce rôle."
      )
    ).toHaveLength(2)
  })

  it('gives the support address for a staff-managed account', async () => {
    const marc = member('Marc Petit', 'marc.petit@acme.fr', 'org_member')
    renderWithApi(
      <MemberDrawer
        organisationId={ORG_ID}
        callerRole="org_owner"
        memberId={marc.id}
        onClose={vi.fn()}
      />,
      [
        defaultPeople(),
        [
          http.get('*/api/v1/organisations/:org/memberships/:id', () =>
            HttpResponse.json(
              {
                ...marc,
                can_change_role: false,
                can_remove: false,
                blocked_reason: 'staff_managed',
              },
              { headers: { ETag: '"marc-staff-managed"' } }
            )
          ),
        ],
      ]
    )

    const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
    expect(within(drawer).getByRole('combobox', { name: 'Rôle' })).toBeDisabled()
    expect(within(drawer).getByRole('button', { name: "Retirer de l'organisation" })).toBeDisabled()
    expect(
      within(drawer).getAllByText(
        'Ce compte est géré par notre équipe. Écrivez-nous à support@kodera.io pour le modifier.'
      )
    ).toHaveLength(2)
  })

  it('confirms a removal by naming the person, starting on the heading, and Escape cancels', async () => {
    const onClose = vi.fn()
    const deleted: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'DELETE') deleted.push(request.url)
    })
    renderWithApi(<OpenByName name="Marc Petit" callerRole="org_admin" onClose={onClose} />, [
      defaultPeople(),
    ])
    const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
    await userEvent.click(
      await within(drawer).findByRole('button', { name: "Retirer de l'organisation" })
    )
    const confirm = await screen.findByRole('dialog', { name: 'Retirer Marc Petit ?' })
    // Removal ends the person's use of the console, and says plainly that Visio and Docs are not cut.
    expect(confirm).toHaveTextContent('Marc Petit ne pourra plus utiliser la console')
    expect(confirm).toHaveTextContent("Son accès à Visio et à Docs n'est pas encore coupé")
    expect(within(confirm).getByRole('heading', { name: 'Retirer Marc Petit ?' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Retirer Marc Petit ?' })).toBeNull()
    )
    expect(deleted).toEqual([])

    await userEvent.click(within(drawer).getByRole('button', { name: "Retirer de l'organisation" }))
    await userEvent.click(await screen.findByRole('button', { name: 'Retirer Marc Petit' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(deleted).toHaveLength(1)
    server.events.removeAllListeners()
  })

  it('offers an owner billing and ownership, ownership behind a confirmation', async () => {
    renderWithApi(<OpenByName name="Marc Petit" callerRole="org_owner" onClose={vi.fn()} />, [
      ownerPeople(),
    ])
    const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
    await userEvent.click(await within(drawer).findByRole('combobox', { name: 'Rôle' }))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toEqual(['Propriétaire', 'Administrateur', 'Facturation', 'Membre'])
    await userEvent.click(screen.getByRole('option', { name: 'Propriétaire' }))
    expect(
      await screen.findByRole('dialog', { name: 'Nommer Marc Petit propriétaire ?' })
    ).toHaveTextContent('la facturation, les rôles et la suppression')
  })

  it('offers an administrator only member and administrator', async () => {
    renderWithApi(<OpenByName name="Marc Petit" callerRole="org_admin" onClose={vi.fn()} />, [
      defaultPeople(),
    ])
    const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
    await userEvent.click(await within(drawer).findByRole('combobox', { name: 'Rôle' }))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toEqual(['Administrateur', 'Membre'])
  })

  it('tells an administrator why a billing membership is out of reach', async () => {
    renderWithApi(<OpenByName name="Camille Bernard" callerRole="org_admin" onClose={vi.fn()} />, [
      defaultPeople(),
    ])
    const drawer = await screen.findByRole('dialog', { name: 'Camille Bernard' })
    expect(await within(drawer).findByRole('combobox', { name: 'Rôle' })).toBeDisabled()
    expect(
      within(drawer).getAllByText(
        'Seul un propriétaire peut attribuer ou retirer les rôles propriétaire et facturation.'
      )
    ).toHaveLength(2)
  })

  it('changes a role, confirms it, and keeps the drawer in step', async () => {
    const events: AnalyticsEvent[] = []
    const stop = onTrack((event) => events.push(event))
    renderWithApi(<OpenByName name="Marc Petit" callerRole="org_admin" onClose={vi.fn()} />, [
      defaultPeople(),
    ])
    const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
    await userEvent.click(await within(drawer).findByRole('combobox', { name: 'Rôle' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Administrateur' }))
    expect(await screen.findByText('Marc Petit est maintenant administrateur.')).toBeVisible()
    await waitFor(() =>
      expect(within(drawer).getByRole('combobox', { name: 'Rôle' })).toHaveTextContent(
        'Administrateur'
      )
    )
    expect(events).toContainEqual({
      name: 'people_role_changed',
      properties: { from: 'org_member', to: 'org_admin' },
    })
    stop()
  })

  it('changes a role against a tag read just before the change, not the cached one', async () => {
    const marc = member('Marc Petit', 'marc.petit@acme.fr', 'org_member')
    let version = 0
    const ifMatch: (string | null)[] = []
    const url = '*/api/v1/organisations/:org/memberships/:id'
    renderWithApi(
      <MemberDrawer
        organisationId={ORG_ID}
        callerRole="org_admin"
        memberId={marc.id}
        onClose={vi.fn()}
      />,
      [
        defaultPeople(),
        [
          http.get(url, () => {
            version += 1
            return HttpResponse.json(
              { ...marc, can_change_role: true, can_remove: true, blocked_reason: null },
              { headers: { ETag: `"marc-${version}"` } }
            )
          }),
          http.patch(url, async ({ request }) => {
            ifMatch.push(request.headers.get('If-Match'))
            const body = (await request.json()) as { role: 'org_admin' }
            marc.role = body.role
            return HttpResponse.json(marc, { headers: { ETag: '"marc-patched"' } })
          }),
        ],
      ]
    )
    const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
    await userEvent.click(await within(drawer).findByRole('combobox', { name: 'Rôle' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Administrateur' }))
    expect(await screen.findByText('Marc Petit est maintenant administrateur.')).toBeVisible()
    // The drawer's own read was `"marc-1"`; the change read the record again.
    expect(ifMatch).toEqual(['"marc-2"'])
  })

  it('re-reads the person and says so when someone else changed them first', async () => {
    const marc = member('Marc Petit', 'marc.petit@acme.fr', 'org_member')
    const url = '*/api/v1/organisations/:org/memberships/:id'
    renderWithApi(
      <MemberDrawer
        organisationId={ORG_ID}
        callerRole="org_admin"
        memberId={marc.id}
        onClose={vi.fn()}
      />,
      [
        defaultPeople(),
        [
          http.get(url, () =>
            HttpResponse.json(
              { ...marc, can_change_role: true, can_remove: true, blocked_reason: null },
              { headers: { ETag: `"marc-${marc.role}"` } }
            )
          ),
          http.patch(url, () => {
            // Another administrator's change landed between the read and the write.
            marc.role = 'org_admin'
            return problem('https://kodera.io/problems/precondition-failed', {
              currentEtag: '"marc-org_admin"',
            })
          }),
        ],
      ]
    )
    const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
    await userEvent.click(await within(drawer).findByRole('combobox', { name: 'Rôle' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Administrateur' }))
    expect(
      await within(drawer).findByText(
        "Cette personne vient d'être modifiée par quelqu'un d'autre. Vérifiez sa fiche, puis réessayez."
      )
    ).toBeVisible()
    await waitFor(() =>
      expect(within(drawer).getByRole('combobox', { name: 'Rôle' })).toHaveTextContent(
        'Administrateur'
      )
    )
  })

  it('returns focus to the person’s row in the list when it closes', async () => {
    function ListWithDrawer() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type="button" data-member-id={CALLER_MEMBERSHIP_ID}>
            Julie Marchand
          </button>
          {open ? (
            <MemberDrawer
              organisationId={ORG_ID}
              callerRole="org_admin"
              memberId={CALLER_MEMBERSHIP_ID}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </>
      )
    }
    renderWithApi(<ListWithDrawer />, [defaultPeople()])
    await screen.findByRole('dialog', { name: 'Julie Marchand' })
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Julie Marchand' })).toHaveFocus()
    )
  })
})

describe('Suspension and removal (contract 0.18.0)', () => {
  it('suspends after a confirmation, then restores access', async () => {
    renderWithApi(<OpenByName name="Marc Petit" callerRole="org_admin" onClose={vi.fn()} />, [
      defaultPeople(),
    ])
    const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
    await userEvent.click(
      await within(drawer).findByRole('button', { name: 'Suspendre dans la console' })
    )
    const confirm = await screen.findByRole('dialog', {
      name: 'Suspendre Marc Petit dans la console ?',
    })
    // Not a security control yet (Core release gate): Visio and Docs are said to stay open.
    expect(confirm).toHaveTextContent("Son accès à Visio et à Docs n'est pas encore coupé")
    await userEvent.click(within(confirm).getByRole('button', { name: 'Suspendre Marc Petit' }))
    expect(await screen.findByText('Suspension de Marc Petit enregistrée.')).toBeVisible()
    await userEvent.click(
      await within(drawer).findByRole('button', { name: 'Réactiver dans la console' })
    )
    expect(await screen.findByText('Réactivation de Marc Petit enregistrée.')).toBeVisible()
    expect(
      await within(drawer).findByRole('button', { name: 'Suspendre dans la console' })
    ).toBeVisible()
  })

  it('does not offer to suspend the last owner', async () => {
    renderWithApi(
      <MemberDrawer
        organisationId={ORG_ID}
        callerRole="org_owner"
        memberId={CALLER_MEMBERSHIP_ID}
        onClose={vi.fn()}
      />,
      [lastOwner()]
    )
    const drawer = await screen.findByRole('dialog', { name: 'Julie Marchand' })
    expect(within(drawer).getByRole('button', { name: 'Suspendre dans la console' })).toBeDisabled()
  })

  it.each([
    [
      412,
      'https://kodera.io/problems/precondition-failed',
      "Cette personne vient d'être modifiée par quelqu'un d'autre. Vérifiez sa fiche, puis réessayez.",
      true,
    ],
    [
      404,
      'https://kodera.io/problems/not-found',
      "Cette personne vient d'être modifiée par quelqu'un d'autre. Vérifiez sa fiche, puis réessayez.",
      true,
    ],
    [
      409,
      'https://kodera.io/problems/last-owner-protected',
      "Votre organisation doit conserver au moins un propriétaire. Nommez quelqu'un d'autre avant de modifier ce rôle.",
      false,
    ],
    [
      403,
      'https://kodera.io/problems/forbidden',
      "Cette modification n'est pas possible pour le moment. Si cela vous semble anormal, écrivez-nous à support@kodera.io.",
      false,
    ],
  ] as const)(
    'removes under the tag of a fresh read, and says why a %s refusal happened',
    async (_, type, sentence, rereads) => {
      const marc = member('Marc Petit', 'marc.petit@acme.fr', 'org_member')
      const url = '*/api/v1/organisations/:org/memberships/:id'
      const ifMatch: (string | null)[] = []
      let reads = 0
      renderWithApi(
        <MemberDrawer
          organisationId={ORG_ID}
          callerRole="org_owner"
          memberId={marc.id}
          onClose={vi.fn()}
        />,
        [
          defaultPeople(),
          [
            http.get(url, () => {
              reads += 1
              return HttpResponse.json(
                { ...marc, can_change_role: true, can_remove: true, blocked_reason: null },
                { headers: { ETag: `"marc-${reads}"` } }
              )
            }),
            http.delete(url, ({ request }) => {
              ifMatch.push(request.headers.get('If-Match'))
              return problem(type)
            }),
          ],
        ]
      )
      const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
      await userEvent.click(
        await within(drawer).findByRole('button', { name: "Retirer de l'organisation" })
      )
      const confirm = await screen.findByRole('dialog', { name: 'Retirer Marc Petit ?' })
      await userEvent.click(within(confirm).getByRole('button', { name: 'Retirer Marc Petit' }))
      expect(await within(drawer).findByText(sentence)).toBeVisible()
      // The drawer's own read was `"marc-1"`; the removal read the record again.
      expect(ifMatch).toEqual(['"marc-2"'])
      // A record that moved or went is read once more, so the drawer shows the server's version.
      if (rereads) await waitFor(() => expect(reads).toBe(3))
      else {
        // Long enough for a refetch to have landed, had one been started.
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(reads).toBe(2)
      }
    }
  )

  it('re-reads the person when a suspension meets a newer change', async () => {
    const marc = member('Marc Petit', 'marc.petit@acme.fr', 'org_member')
    const url = '*/api/v1/organisations/:org/memberships/:id'
    let reads = 0
    renderWithApi(
      <MemberDrawer
        organisationId={ORG_ID}
        callerRole="org_owner"
        memberId={marc.id}
        onClose={vi.fn()}
      />,
      [
        defaultPeople(),
        [
          http.get(url, () => {
            reads += 1
            return HttpResponse.json(
              { ...marc, can_change_role: true, can_remove: true, blocked_reason: null },
              { headers: { ETag: `"marc-${reads}"` } }
            )
          }),
          http.patch(url, () => problem('https://kodera.io/problems/precondition-failed')),
        ],
      ]
    )
    const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
    await userEvent.click(
      await within(drawer).findByRole('button', { name: 'Suspendre dans la console' })
    )
    const confirm = await screen.findByRole('dialog', {
      name: 'Suspendre Marc Petit dans la console ?',
    })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Suspendre Marc Petit' }))
    expect(
      await within(drawer).findByText(
        "Cette personne vient d'être modifiée par quelqu'un d'autre. Vérifiez sa fiche, puis réessayez."
      )
    ).toBeVisible()
    await waitFor(() => expect(reads).toBe(3))
  })

  it('says the person changed when they were removed before the fresh read', async () => {
    const marc = member('Marc Petit', 'marc.petit@acme.fr', 'org_member')
    const url = '*/api/v1/organisations/:org/memberships/:id'
    let reads = 0
    const deleted: string[] = []
    renderWithApi(
      <MemberDrawer
        organisationId={ORG_ID}
        callerRole="org_owner"
        memberId={marc.id}
        onClose={vi.fn()}
      />,
      [
        defaultPeople(),
        [
          http.get(url, () => {
            reads += 1
            // Another administrator removed Marc after the drawer opened.
            if (reads > 1) return problem('https://kodera.io/problems/not-found')
            return HttpResponse.json(
              { ...marc, can_change_role: true, can_remove: true, blocked_reason: null },
              { headers: { ETag: '"marc-1"' } }
            )
          }),
          http.delete(url, ({ request }) => {
            deleted.push(request.url)
            return HttpResponse.json({ ...marc, state: 'removed' })
          }),
        ],
      ]
    )
    const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
    await userEvent.click(
      await within(drawer).findByRole('button', { name: "Retirer de l'organisation" })
    )
    const confirm = await screen.findByRole('dialog', { name: 'Retirer Marc Petit ?' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Retirer Marc Petit' }))
    expect(
      await within(drawer).findByText(
        "Cette personne vient d'être modifiée par quelqu'un d'autre. Vérifiez sa fiche, puis réessayez."
      )
    ).toBeVisible()
    expect(deleted).toEqual([])
  })

  it('offers no second removal while the first is in flight', async () => {
    const marc = member('Marc Petit', 'marc.petit@acme.fr', 'org_member')
    const url = '*/api/v1/organisations/:org/memberships/:id'
    let release: () => void = () => undefined
    const deleted: string[] = []
    renderWithApi(
      <MemberDrawer
        organisationId={ORG_ID}
        callerRole="org_owner"
        memberId={marc.id}
        onClose={vi.fn()}
      />,
      [
        defaultPeople(),
        [
          http.get(url, () =>
            HttpResponse.json(
              { ...marc, can_change_role: true, can_remove: true, blocked_reason: null },
              { headers: { ETag: '"marc-1"' } }
            )
          ),
          http.delete(url, async ({ request }) => {
            deleted.push(request.url)
            await new Promise<void>((resolve) => (release = resolve))
            return HttpResponse.json({ ...marc, state: 'removed' })
          }),
        ],
      ]
    )
    const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
    const removeButton = await within(drawer).findByRole('button', {
      name: "Retirer de l'organisation",
    })
    await userEvent.click(removeButton)
    const confirm = await screen.findByRole('dialog', { name: 'Retirer Marc Petit ?' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Retirer Marc Petit' }))
    await waitFor(() => expect(deleted).toHaveLength(1))
    expect(removeButton).toBeDisabled()
    release()
    await waitFor(() => expect(removeButton).toBeEnabled())
    expect(deleted).toHaveLength(1)
  })

  it.each([
    [
      'removes',
      async (drawer: HTMLElement) => {
        await userEvent.click(
          await within(drawer).findByRole('button', { name: "Retirer de l'organisation" })
        )
        const confirm = await screen.findByRole('dialog', { name: 'Retirer Marc Petit ?' })
        await userEvent.click(within(confirm).getByRole('button', { name: 'Retirer Marc Petit' }))
      },
    ],
    [
      'suspends',
      async (drawer: HTMLElement) => {
        await userEvent.click(
          await within(drawer).findByRole('button', { name: 'Suspendre dans la console' })
        )
        const confirm = await screen.findByRole('dialog', {
          name: 'Suspendre Marc Petit dans la console ?',
        })
        await userEvent.click(within(confirm).getByRole('button', { name: 'Suspendre Marc Petit' }))
      },
    ],
    [
      'changes the role of',
      async (drawer: HTMLElement) => {
        await userEvent.click(await within(drawer).findByRole('combobox', { name: 'Rôle' }))
        await userEvent.click(await screen.findByRole('option', { name: 'Administrateur' }))
      },
    ],
  ] as const)(
    '%s nobody when the person changed since they were shown, and shows them again',
    async (_, act) => {
      const marc = member('Marc Petit', 'marc.petit@acme.fr', 'org_member')
      const url = '*/api/v1/organisations/:org/memberships/:id'
      let reads = 0
      const written: string[] = []
      renderWithApi(
        <MemberDrawer
          organisationId={ORG_ID}
          callerRole="org_owner"
          memberId={marc.id}
          onClose={vi.fn()}
        />,
        [
          defaultPeople(),
          [
            http.get(url, () => {
              reads += 1
              // The drawer's read shows an active member; by the action's read, someone else
              // suspended them.
              const state = reads === 1 ? 'active' : 'suspended'
              return HttpResponse.json(
                { ...marc, state, can_change_role: true, can_remove: true, blocked_reason: null },
                { headers: { ETag: `"marc-${reads}"` } }
              )
            }),
            http.patch(url, ({ request }) => {
              written.push(request.method)
              return HttpResponse.json(marc, { headers: { ETag: '"marc-patched"' } })
            }),
            http.delete(url, ({ request }) => {
              written.push(request.method)
              return HttpResponse.json({ ...marc, state: 'removed' })
            }),
          ],
        ]
      )
      const drawer = await screen.findByRole('dialog', { name: 'Marc Petit' })
      await act(drawer)
      expect(
        await within(drawer).findByText(
          "Cette personne vient d'être modifiée par quelqu'un d'autre. Vérifiez sa fiche, puis réessayez."
        )
      ).toBeVisible()
      expect(written).toEqual([])
      // The drawer shows the person as the server holds them now.
      expect(
        await within(drawer).findByRole('button', { name: 'Réactiver dans la console' })
      ).toBeVisible()
    }
  )

  it('gives the suspend button the reason it is unavailable', async () => {
    renderWithApi(
      <MemberDrawer
        organisationId={ORG_ID}
        callerRole="org_owner"
        memberId={CALLER_MEMBERSHIP_ID}
        onClose={vi.fn()}
      />,
      [lastOwner()]
    )
    const drawer = await screen.findByRole('dialog', { name: 'Julie Marchand' })
    expect(
      within(drawer).getByRole('button', { name: 'Suspendre dans la console' })
    ).toHaveAccessibleDescription(
      "Votre organisation doit conserver au moins un propriétaire. Nommez quelqu'un d'autre avant de modifier ce rôle."
    )
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Real client and query cache; every reply is an independent wire object. */
function readbackFixture() {
  const original = member('Marc Petit', 'marc.petit@acme.fr', 'org_member')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const listeners = new Set<() => void>()
  let session: AuthSessionSnapshot = {
    status: 'ready',
    generation: 7,
    credentialGeneration: 1,
    user: { realm: 'acme-sa' },
  }
  vi.spyOn(authAdapter, 'getSnapshot').mockImplementation(() => session)
  vi.spyOn(authAdapter, 'subscribe').mockImplementation((listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  })
  vi.spyOn(authAdapter, 'getAccessToken').mockImplementation(() =>
    session.status === 'ready' ? 'synthetic' : undefined
  )
  const success: { key: readonly unknown[]; value: Record<string, unknown> }[] = []
  const observeCache = (observed: QueryClient) =>
    observed.getQueryCache().subscribe((event) => {
      if (
        event.type === 'updated' &&
        event.action.type === 'success' &&
        event.query.queryKey[0] === 'people' &&
        event.query.queryKey[2] === 'member'
      ) {
        const data = event.query.state.data as { value: Record<string, unknown> }
        success.push({ key: [...event.query.queryKey], value: structuredClone(data.value) })
      }
    })
  observeCache(client)
  const state = {
    role: 'org_member' as OrganisationRole,
    gets: 0,
    patches: 0,
    read: undefined as ((request: Request) => Response | Promise<Response>) | undefined,
    patch: undefined as (() => Response | Promise<Response>) | undefined,
  }
  const reply = (change: Record<string, unknown> = {}, tag: string | null = '"current"') =>
    HttpResponse.json(
      {
        ...original,
        role: state.role,
        can_change_role: true,
        can_remove: true,
        blocked_reason: null,
        ...change,
      },
      { headers: tag === null ? {} : { ETag: tag } }
    )
  const unavailable = () =>
    HttpResponse.json({ status: 503, title: 'Unavailable' }, { status: 503 })
  server.use(
    http.get('*/api/v1/organisations/:org/memberships/:id', ({ request }) => {
      state.gets += 1
      return state.read?.(request) ?? reply()
    }),
    http.patch('*/api/v1/organisations/:org/memberships/:id', async ({ request }) => {
      const body = (await request.json()) as { role: OrganisationRole }
      expect(request.headers.get('If-Match')).toBe('"current"')
      state.patches += 1
      state.role = body.role
      return (
        state.patch?.() ??
        HttpResponse.json({ ...original, role: state.role }, { headers: { ETag: '"committed"' } })
      )
    })
  )
  const onClose = vi.fn()
  const defaultProps = {
    organisationId: ORG_ID,
    memberId: original.id,
    callerRole: 'org_admin' as OrganisationRole,
    onClose,
  }
  const tree = (props = defaultProps, strict = false, currentClient = client) => (
    <QueryClientProvider client={currentClient}>
      <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
        {strict ? (
          <StrictMode>
            <MemberDrawer {...props} />
          </StrictMode>
        ) : (
          <MemberDrawer {...props} />
        )}
      </ToastProvider>
    </QueryClientProvider>
  )
  const mount = (strict = false) => {
    const view = render(tree(defaultProps, strict))
    return {
      ...view,
      replace: (props: Partial<typeof defaultProps>) =>
        view.rerender(tree({ ...defaultProps, ...props }, strict)),
      replaceClient: (replacement: QueryClient) => {
        observeCache(replacement)
        view.rerender(tree(defaultProps, strict, replacement))
      },
    }
  }
  const choose = async () => {
    await userEvent.click(await screen.findByRole('combobox', { name: 'Rôle' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Administrateur' }))
  }
  const rotate = (change: Partial<AuthSessionSnapshot>) =>
    act(() => {
      session = { ...session, ...change }
      for (const listener of [...listeners]) listener()
    })
  return { original, client, success, state, reply, unavailable, mount, choose, rotate, onClose }
}

const SAVED_UNAVAILABLE =
  "Le changement de rôle a été enregistré, mais la fiche n'a pas pu être actualisée. Actualisez-la avant toute autre modification."
const UNCONFIRMED =
  "Le résultat du changement de rôle n'a pas pu être confirmé. Actualisez la fiche avant de réessayer."

/** Release the whole held handler before asserting that no late publication followed. */
async function releaseReply(held: ReturnType<typeof deferred<Response>>, response: Response) {
  await act(async () => {
    held.resolve(response)
    await held.promise
    await new Promise((done) => setTimeout(done, 0))
  })
}

describe('role change readback recovery boundaries', () => {
  it('announces the saved ACK while pending, then retries only GET and keeps authoritative permissions', async () => {
    const f = readbackFixture()
    const events: AnalyticsEvent[] = []
    const stop = onTrack((event) => events.push(event))
    f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    const held = deferred<Response>()
    f.state.read = () => (f.state.patches ? held.promise : f.reply())
    await f.choose()
    expect(
      await screen.findByText('Le changement de rôle a été enregistré. Chargement')
    ).toBeVisible()
    expect(screen.queryByText('Marc Petit est maintenant administrateur.')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Rôle' })).toBeDisabled()
    await releaseReply(held, f.unavailable())
    expect(await screen.findByText(SAVED_UNAVAILABLE)).toBeVisible()
    f.state.read = () => f.unavailable()
    const retry = screen.getByRole('button', { name: 'Actualiser la fiche' })
    for (let step = 0; step < 12 && document.activeElement !== retry; step += 1)
      await userEvent.tab()
    expect(retry).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByText(SAVED_UNAVAILABLE)).toBeVisible()
    f.state.read = () =>
      f.reply({ can_change_role: false, can_remove: false, blocked_reason: 'staff_managed' })
    await userEvent.click(screen.getByRole('button', { name: 'Actualiser la fiche' }))
    expect(await screen.findByText('Marc Petit est maintenant administrateur.')).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveTextContent('Administrateur')
    expect(screen.getByRole('combobox', { name: 'Rôle' })).toBeDisabled()
    expect(f.state.patches).toBe(1)
    expect(events.filter((event) => event.name === 'people_role_changed')).toHaveLength(1)
    expect(
      f.success.every(
        (event) => event.value['id'] === f.original.id && event.value['organisation_id'] === ORG_ID
      )
    ).toBe(true)
    stop()
  })

  it.each([
    'lost reply',
    'malformed ACK',
    'wrong member ACK',
    'wrong organisation ACK',
    'wrong role ACK',
    'server failure',
  ])('does not attribute success or repeat PATCH after %s', async (kind) => {
    const f = readbackFixture()
    const events: AnalyticsEvent[] = []
    const stop = onTrack((event) => events.push(event))
    f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    f.state.read = () => (f.state.patches ? f.unavailable() : f.reply())
    f.state.patch = () => {
      if (kind === 'lost reply') return HttpResponse.error()
      if (kind === 'server failure') return HttpResponse.json({ status: 500 }, { status: 500 })
      if (kind === 'malformed ACK') return HttpResponse.json({})
      return f.reply(
        kind === 'wrong member ACK'
          ? { id: crypto.randomUUID() }
          : kind === 'wrong organisation ACK'
            ? { organisation_id: crypto.randomUUID() }
            : { role: 'org_member' }
      )
    }
    await f.choose()
    expect(await screen.findByText(UNCONFIRMED)).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Rôle' })).toBeDisabled()
    f.state.read = () => f.reply()
    await userEvent.click(screen.getByRole('button', { name: 'Actualiser la fiche' }))
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveTextContent('Administrateur')
    )
    expect(screen.queryByText(UNCONFIRMED)).toBeNull()
    expect(screen.queryByText('Marc Petit est maintenant administrateur.')).toBeNull()
    expect(events.filter((event) => event.name === 'people_role_changed')).toHaveLength(0)
    expect(f.state.patches).toBe(1)
    stop()
  })

  it.each([
    ['wrong member', { id: 'a-different-member' }],
    ['wrong organisation', { organisation_id: 'a-different-org' }],
    ['unsupported role', { role: 'super_admin' }],
    ['unsupported state', { state: 'enabled' }],
    ['permission type', { can_change_role: 'true' }],
    ['missing permission', { can_remove: undefined }],
    ['invalid date', { created_at: 'not-a-date' }],
    ['invalid display name', { display_name: {} }],
    ['unknown blocked reason', { blocked_reason: 'guess' }],
  ] as const)(
    'refuses %s before any background cache success or pre-write PATCH',
    async (_, change) => {
      const f = readbackFixture()
      f.mount()
      await screen.findByRole('combobox', { name: 'Rôle' })
      expect(f.success).toHaveLength(1)
      f.state.read = () => f.reply(change)
      await act(async () => {
        await f.client.invalidateQueries({ queryKey: peopleKeys.member(ORG_ID, f.original.id) })
      })
      expect(f.success).toHaveLength(1)
      await waitFor(() => expect(screen.getByRole('combobox', { name: 'Rôle' })).toBeDisabled())
      expect(f.state.patches).toBe(0)
      // A deliberate refresh under the same invalid reply cannot transiently poison the cache.
      await act(async () => {
        await f.client.refetchQueries({ queryKey: peopleKeys.member(ORG_ID, f.original.id) })
      })
      expect(f.success).toHaveLength(1)
    }
  )

  it('validates a pre-write reply before its ID can choose the PATCH target', async () => {
    const f = readbackFixture()
    f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    f.state.read = () => f.reply({ id: crypto.randomUUID() })
    await f.choose()
    expect(await screen.findByText("Le rôle n'a pas pu être modifié. Réessayez.")).toBeVisible()
    expect(f.state.patches).toBe(0)
    expect(f.success).toHaveLength(1)
  })

  it('refuses a missing or weak read tag before cache publication', async () => {
    const f = readbackFixture()
    f.state.read = () => f.reply({}, null)
    f.mount()
    expect(await screen.findByRole('button', { name: 'Réessayer' })).toBeVisible()
    expect(f.success).toHaveLength(0)
    f.state.read = () => f.reply({}, 'W/"weak"')
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => expect(f.state.gets).toBe(2))
    expect(f.success).toHaveLength(0)
  })

  it('shows the actual different role without attributing the requested current role', async () => {
    const f = readbackFixture()
    f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    f.state.read = () => f.reply(f.state.patches ? { role: 'org_member' } : {})
    await f.choose()
    expect(
      await screen.findByText(
        "Cette personne vient d'être modifiée par quelqu'un d'autre. Vérifiez sa fiche, puis réessayez."
      )
    ).toBeVisible()
    expect(screen.getByText('Le changement de rôle a été enregistré.')).toBeVisible()
    expect(screen.queryByText('Marc Petit est maintenant administrateur.')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveTextContent('Membre')
    expect(f.state.patches).toBe(1)
  })

  it.each([
    ['wrong member', { id: 'unrelated' }, '"current"'],
    ['wrong org', { organisation_id: 'unrelated' }, '"current"'],
    ['nonboolean advice', { can_remove: 'true' }, '"current"'],
    ['missing tag', {}, null],
  ] as const)('keeps an ACK truthful without caching a %s readback', async (_, change, tag) => {
    const f = readbackFixture()
    f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    f.state.read = () => (f.state.patches ? f.reply(change, tag) : f.reply())
    await f.choose()
    expect(await screen.findByText(SAVED_UNAVAILABLE)).toBeVisible()
    expect(f.success).toHaveLength(1)
    expect(screen.getByRole('combobox', { name: 'Rôle' })).toBeDisabled()
    expect(screen.queryByText('Marc Petit est maintenant administrateur.')).toBeNull()
    expect(f.state.patches).toBe(1)
  })

  it.each(['forbidden', 'not-found'] as const)(
    'keeps readback %s from reusing old editable permissions',
    async (kind) => {
      const f = readbackFixture()
      f.mount()
      await screen.findByRole('combobox', { name: 'Rôle' })
      f.state.read = () =>
        f.state.patches ? problem(`https://kodera.io/problems/${kind}`) : f.reply()
      await f.choose()
      expect(await screen.findByText(SAVED_UNAVAILABLE)).toBeVisible()
      expect(screen.getByRole('combobox', { name: 'Rôle' })).toBeDisabled()
      expect(screen.getByRole('button', { name: "Retirer de l'organisation" })).toBeDisabled()
      expect(f.success).toHaveLength(1)
      expect(f.state.patches).toBe(1)
    }
  )

  it('honours newly read last-owner advice before sending any PATCH', async () => {
    const f = readbackFixture()
    f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    f.state.read = () =>
      f.reply({ can_change_role: false, can_remove: false, blocked_reason: 'last_owner' })
    await f.choose()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Rôle' })).toBeDisabled())
    expect(
      screen.getAllByText(
        "Votre organisation doit conserver au moins un propriétaire. Nommez quelqu'un d'autre avant de modifier ce rôle."
      ).length
    ).toBeGreaterThan(0)
    expect(f.state.patches).toBe(0)
  })

  it('retires a pre-write GET on credential rotation without sending PATCH', async () => {
    const f = readbackFixture()
    f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    const held = deferred<Response>()
    f.state.read = () => held.promise
    await f.choose()
    f.state.read = () => f.reply()
    f.rotate({ credentialGeneration: 2 })
    await releaseReply(held, f.reply())
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Rôle' })).toBeEnabled())
    expect(f.state.patches).toBe(0)
  })

  it('preserves the stable ACK on credential rotation and lets the new credential retry GET', async () => {
    const f = readbackFixture()
    f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    const old = deferred<Response>()
    f.state.read = () => (f.state.patches ? old.promise : f.reply())
    await f.choose()
    await screen.findByText('Le changement de rôle a été enregistré. Chargement')
    f.rotate({ credentialGeneration: 2 })
    expect(await screen.findByText(SAVED_UNAVAILABLE)).toBeVisible()
    const newer = deferred<Response>()
    f.state.read = () => newer.promise
    await userEvent.click(screen.getByRole('button', { name: 'Actualiser la fiche' }))
    await releaseReply(old, f.reply({ role: 'org_member' }))
    expect(screen.getByRole('button', { name: 'Actualiser la fiche' })).toHaveAttribute(
      'aria-busy',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Actualiser la fiche' })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Actualiser la fiche' })).not.toBeDisabled()
    expect(f.success).toHaveLength(1)
    await releaseReply(newer, f.reply())
    expect(await screen.findByText('Marc Petit est maintenant administrateur.')).toBeVisible()
    expect(f.state.patches).toBe(1)
    expect(f.success.filter((event) => event.value['role'] === 'org_member')).toHaveLength(1)
  })

  it('keeps an issued PATCH receipt stable but publishes its new GET only under the renewed credential key', async () => {
    const f = readbackFixture()
    const events: AnalyticsEvent[] = []
    const stop = onTrack((event) => events.push(event))
    f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    const ack = deferred<Response>()
    f.state.patch = () => ack.promise
    await f.choose()
    await waitFor(() => expect(f.state.patches).toBe(1))
    const afterRotation = f.success.length
    f.rotate({ credentialGeneration: 2 })
    await releaseReply(ack, f.reply())
    expect(await screen.findByText('Marc Petit est maintenant administrateur.')).toBeVisible()
    expect(f.success.slice(afterRotation).every((event) => event.key.at(-1) === 2)).toBe(true)
    expect(events.filter((event) => event.name === 'people_role_changed')).toHaveLength(1)
    expect(f.state.patches).toBe(1)
    stop()
  })

  it('does not let a late pre-write response cross member, organisation or replacement session', async () => {
    const f = readbackFixture()
    const view = f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    const held = deferred<Response>()
    f.state.read = () => held.promise
    await f.choose()
    f.state.read = () => f.reply({ id: 'other-member', organisation_id: 'other-org' })
    view.replace({ memberId: 'other-member', organisationId: 'other-org' })
    f.rotate({ generation: 8, credentialGeneration: 2 })
    await releaseReply(held, f.reply())
    await waitFor(() =>
      expect(f.success.some((event) => event.value['id'] === 'other-member')).toBe(true)
    )
    expect(f.state.patches).toBe(0)
    expect(f.onClose).not.toHaveBeenCalled()
    expect(f.success.filter((event) => event.value['id'] === f.original.id)).toHaveLength(1)
  })

  it('cannot recreate cleared query data from an old response and can still recover', async () => {
    const f = readbackFixture()
    f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    const old = deferred<Response>()
    f.state.read = () => (f.state.patches ? old.promise : f.reply())
    await f.choose()
    await screen.findByText('Le changement de rôle a été enregistré. Chargement')
    act(() => f.client.clear())
    expect(await screen.findByText(SAVED_UNAVAILABLE)).toBeVisible()
    f.state.read = () => f.reply()
    await userEvent.click(screen.getByRole('button', { name: 'Actualiser la fiche' }))
    expect(await screen.findByText('Marc Petit est maintenant administrateur.')).toBeVisible()
    const accepted = f.success.length
    await releaseReply(old, f.reply({ role: 'org_member' }))
    expect(f.success).toHaveLength(accepted)
    expect(f.state.patches).toBe(1)
  })

  it('keeps ACK truth after a clear during PATCH but requires deliberate GET-only recovery', async () => {
    const f = readbackFixture()
    f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    const ack = deferred<Response>()
    f.state.patch = () => ack.promise
    await f.choose()
    await waitFor(() => expect(f.state.patches).toBe(1))
    act(() => f.client.clear())
    const accepted = f.success.length
    await releaseReply(ack, f.reply())
    expect(await screen.findByText(SAVED_UNAVAILABLE)).toBeVisible()
    expect(f.success).toHaveLength(accepted)
    await userEvent.click(screen.getByRole('button', { name: 'Actualiser la fiche' }))
    expect(await screen.findByText('Marc Petit est maintenant administrateur.')).toBeVisible()
    expect(f.state.patches).toBe(1)
  })

  it.each(['replacement session', 'pending auth', 'close'] as const)(
    'does not publish a held ACK after %s',
    async (boundary) => {
      const f = readbackFixture()
      const events: AnalyticsEvent[] = []
      const stop = onTrack((event) => events.push(event))
      f.mount()
      await screen.findByRole('combobox', { name: 'Rôle' })
      const ack = deferred<Response>()
      f.state.patch = () => ack.promise
      await f.choose()
      await waitFor(() => expect(f.state.patches).toBe(1))
      if (boundary === 'close') await userEvent.keyboard('{Escape}')
      else if (boundary === 'pending auth') f.rotate({ status: 'pending' })
      else f.rotate({ generation: 8, credentialGeneration: 2 })
      // Let any legitimate replacement owner's initial query finish first.
      if (boundary === 'replacement session')
        await waitFor(() =>
          expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveTextContent('Administrateur')
        )
      const accepted = f.success.length
      await releaseReply(ack, f.reply())
      expect(f.success).toHaveLength(accepted)
      expect(events.filter((event) => event.name === 'people_role_changed')).toHaveLength(0)
      expect(screen.queryByText('Marc Petit est maintenant administrateur.')).toBeNull()
      expect(f.state.patches).toBe(1)
      expect(f.onClose).toHaveBeenCalledTimes(boundary === 'close' ? 1 : 0)
      stop()
    }
  )

  it('retires the old QueryClient owner without deadlocking a replacement client', async () => {
    const f = readbackFixture()
    const view = f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    const held = deferred<Response>()
    f.state.read = () => (f.state.patches ? held.promise : f.reply())
    await f.choose()
    await screen.findByText('Le changement de rôle a été enregistré. Chargement')
    f.state.read = () => f.reply()
    view.replaceClient(new QueryClient({ defaultOptions: { queries: { retry: false } } }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Rôle' })).toBeEnabled())
    const accepted = f.success.length
    await releaseReply(held, f.reply({ role: 'org_member' }))
    expect(f.success).toHaveLength(accepted)
    expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveTextContent('Administrateur')
    expect(screen.queryByText('Marc Petit est maintenant administrateur.')).toBeNull()
    expect(f.state.patches).toBe(1)
  })

  it('survives StrictMode remount with unique ownership and ignores the closed owner’s whole reply', async () => {
    const f = readbackFixture()
    const first = f.mount(true)
    await screen.findByRole('combobox', { name: 'Rôle' })
    const held = deferred<Response>()
    f.state.read = () => (f.state.patches ? held.promise : f.reply())
    await f.choose()
    await screen.findByText('Le changement de rôle a été enregistré. Chargement')
    first.unmount()
    f.state.read = () => f.reply()
    f.mount(true)
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveTextContent('Administrateur')
    )
    const accepted = f.success.length
    await releaseReply(held, f.reply({ role: 'org_member' }))
    expect(f.success).toHaveLength(accepted)
    expect(screen.getByRole('combobox', { name: 'Rôle' })).toBeEnabled()
    expect(screen.queryByText('Marc Petit est maintenant administrateur.')).toBeNull()
    expect(f.onClose).not.toHaveBeenCalled()
    expect(new Set(f.success.map((event) => JSON.stringify(event.key))).size).toBe(2)
  })
})

describe('role change readback review regressions', () => {
  it.each([
    [
      'forbidden',
      "Cette modification n'est pas possible pour le moment. Si cela vous semble anormal, écrivez-nous à support@kodera.io.",
    ],
    [
      'not-found',
      "Cette personne vient d'être modifiée par quelqu'un d'autre. Vérifiez sa fiche, puis réessayez.",
    ],
  ] as const)(
    'retires the obsolete %s refusal after owned GET-only recovery',
    async (kind, oldFailure) => {
      const f = readbackFixture()
      const events: AnalyticsEvent[] = []
      const stop = onTrack((event) => events.push(event))
      f.mount()
      await screen.findByRole('combobox', { name: 'Rôle' })
      f.state.read = () =>
        f.state.patches ? problem(`https://kodera.io/problems/${kind}`) : f.reply()
      await f.choose()
      expect(await screen.findByText(SAVED_UNAVAILABLE)).toBeVisible()
      expect(screen.getByText(oldFailure)).toBeVisible()
      f.state.read = () => f.reply()
      await userEvent.click(screen.getByRole('button', { name: 'Actualiser la fiche' }))
      expect(await screen.findByText('Marc Petit est maintenant administrateur.')).toBeVisible()
      expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveTextContent('Administrateur')
      expect(screen.getByRole('combobox', { name: 'Rôle' })).toBeEnabled()
      expect(f.state.patches).toBe(1)
      expect(f.state.gets).toBe(4)
      expect(events.filter((event) => event.name === 'people_role_changed')).toHaveLength(1)
      console.info(
        'ROLE_RECOVERY_REFUSAL ' +
          JSON.stringify({
            kind,
            patches: f.state.patches,
            reads: f.state.gets,
            currentRole: screen.getByRole('combobox', { name: 'Rôle' }).textContent,
            currentRoleEditable: !screen
              .getByRole('combobox', { name: 'Rôle' })
              .hasAttribute('disabled'),
            staleRefusalStillVisible: screen.queryByText(oldFailure) !== null,
          })
      )
      expect(
        screen.queryByText(oldFailure),
        'a validated recovery must retire its obsolete refusal'
      ).toBeNull()
      stop()
    }
  )

  it('keeps the keyboard refresh action focusable while its GET is loading', async () => {
    const f = readbackFixture()
    f.mount()
    await screen.findByRole('combobox', { name: 'Rôle' })
    f.state.read = () => (f.state.patches ? f.unavailable() : f.reply())
    await f.choose()
    await screen.findByText(SAVED_UNAVAILABLE)
    const retry = screen.getByRole('button', { name: 'Actualiser la fiche' })
    for (let step = 0; step < 12 && document.activeElement !== retry; step += 1)
      await userEvent.tab()
    expect(retry).toHaveFocus()
    const held = deferred<Response>()
    f.state.read = () => held.promise
    const before = f.state.gets
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(retry).toHaveAttribute('aria-busy', 'true'))
    expect(retry).toHaveAccessibleName('Actualiser la fiche')
    const observed = {
      nativeDisabled: retry.hasAttribute('disabled'),
      ariaDisabled: retry.getAttribute('aria-disabled'),
      focused: document.activeElement === retry,
      reads: f.state.gets - before,
      patches: f.state.patches,
    }
    await userEvent.keyboard('{Enter}{Enter}')
    const repeatedReads = f.state.gets - before
    // Release the actual whole request even when a predecessor invariant will fail below.
    await releaseReply(held, f.reply())
    expect(await screen.findByText('Marc Petit est maintenant administrateur.')).toBeVisible()
    console.info('ROLE_REFRESH_LOADING ' + JSON.stringify({ ...observed, repeatedReads }))
    expect(
      observed.nativeDisabled,
      'loading must preserve Button focusability without native disabled'
    ).toBe(false)
    expect(observed.ariaDisabled).toBe('true')
    expect(observed.focused).toBe(true)
    expect(observed.reads).toBe(1)
    expect(repeatedReads).toBe(1)
    expect(f.state.patches).toBe(1)
    expect(f.onClose).not.toHaveBeenCalled()
  })
})
