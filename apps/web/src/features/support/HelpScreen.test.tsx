// SI-04 / OL-16 / SH-05: `/{org}/help` was the placeholder « Cette page n'est
// pas encore disponible », and every support action in the console led to
// it. The interim page (06-support.md §4.0) gives the one support address,
// what to put in the message, and links that exist — and nothing it cannot
// source: no ticket form, no response time, no hours, no phone number.
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { SUPPORT_EMAIL } from '../../app/supportContact'
import { HelpScreen } from './HelpScreen'

const f = vi.hoisted(() => ({ role: 'org_owner' }))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useLoaderData: () => ({
      membership: {
        role: f.role,
        organisation: { id: 'org-id', slug: 'acme-sa', name: 'ACME SAS' },
      },
    }),
  },
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string
    params: { org: string }
    children: ReactNode
  }) => (
    <a href={to.replace('$org', params.org)} {...rest}>
      {children}
    </a>
  ),
}))

function mailOf(link: HTMLElement) {
  const href = link.getAttribute('href') ?? ''
  const [target, query = ''] = href.split('?')
  const params = new URLSearchParams(query)
  return { target, subject: params.get('subject'), body: params.get('body') ?? '' }
}

function includeList() {
  return within(screen.getByRole('list'))
    .getAllByRole('listitem')
    .map((item) => item.textContent)
}

beforeEach(() => {
  f.role = 'org_owner'
})

describe('the Aide page', () => {
  it('is a page, not the placeholder, and gives the support address as text', () => {
    render(<HelpScreen search={{}} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Aide' })).toBeInTheDocument()
    expect(
      screen.getByText('Une question, un problème : écrivez-nous, nous vous répondons par e-mail.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copier' })).toBeInTheDocument()
    expect(screen.queryByText("Cette page n'est pas encore disponible.")).toBeNull()
    expect(screen.getByText(new RegExp(`Écrivez-nous à ${SUPPORT_EMAIL}\\.`))).toBeInTheDocument()
    // Owner ruling A: the team answers, with no time commitment.
    expect(screen.getByText(/Nous vous répondons/)).toBeInTheDocument()
  })

  // A webmail user has no mail app to open: the address is copyable, and the
  // hint says the button opens one only if there is one.
  it('copies the address for a customer with no mail app, and says the button needs one', async () => {
    const user = userEvent.setup()
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    render(<HelpScreen search={{}} />)
    await user.click(screen.getByRole('button', { name: 'Copier' }))
    expect(write).toHaveBeenCalledWith(SUPPORT_EMAIL)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copié' })).toBeInTheDocument())
    expect(
      screen.getByText(
        "Si une messagerie est configurée sur cet appareil, ce bouton l'ouvre avec ces informations déjà indiquées ; sinon, copiez l'adresse. Ne nous envoyez jamais votre mot de passe."
      )
    ).toBeInTheDocument()
  })

  it('says so when the copy fails, and the address stays readable', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    render(<HelpScreen search={{}} />)
    await user.click(screen.getByRole('button', { name: 'Copier' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "La copie a échoué. Sélectionnez l'adresse pour la copier."
    )
  })

  it('with no subject, asks for the page and, for a problem, the time', () => {
    render(<HelpScreen search={{}} />)
    expect(includeList()).toEqual([
      'Le nom de votre organisation : ACME SAS',
      'La page sur laquelle vous étiez',
      "S'il s'agit d'un problème, l'heure à laquelle c'est arrivé",
    ])
    const mail = mailOf(screen.getByRole('link', { name: 'Écrire un e-mail' }))
    expect(mail.target).toBe(`mailto:${SUPPORT_EMAIL}`)
    expect(mail.subject).toBe("Demande d'aide — ACME SAS")
    expect(mail.body.split('\n')).toEqual([
      'Organisation : ACME SAS (acme-sa)',
      'Page concernée :',
      'Heure du problème, le cas échéant :',
      '',
      'Votre question, ou ce qui se passe :',
      '',
    ])
  })

  it('for a problem, names it and asks when it happened and what happens', () => {
    render(<HelpScreen search={{ state: 'suspended' }} />)
    expect(includeList()).toEqual([
      'Le nom de votre organisation : ACME SAS',
      'Le sujet : Votre instance est suspendue',
      "L'heure à laquelle c'est arrivé, même approximative",
    ])
    const mail = mailOf(screen.getByRole('link', { name: 'Écrire un e-mail' }))
    expect(mail.subject).toBe('Votre instance est suspendue — ACME SAS')
    expect(mail.body.split('\n')).toEqual([
      'Organisation : ACME SAS (acme-sa)',
      'Sujet : Votre instance est suspendue',
      'Heure du problème :',
      '',
      'Que se passe-t-il ?',
      '',
    ])
  })

  it('for a question, asks for the question and not the time of a problem', () => {
    render(<HelpScreen search={{ topic: 'change-plan' }} />)
    expect(includeList()).toEqual([
      'Le nom de votre organisation : ACME SAS',
      'Le sujet : Changement de formule',
      'Votre question, en quelques mots',
    ])
    const mail = mailOf(screen.getByRole('link', { name: 'Écrire un e-mail' }))
    expect(mail.body.split('\n')).toEqual([
      'Organisation : ACME SAS (acme-sa)',
      'Sujet : Changement de formule',
      '',
      'Votre question :',
      '',
    ])
    expect(mail.body).not.toMatch(/Heure|Que se passe-t-il/)
  })

  it('states no response time, business hours or phone number, and offers no form', () => {
    const { container } = render(<HelpScreen search={{}} />)
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/heures? ouvrées|du lundi au vendredi|\d{1,2} ?h ?[–-]/)
    expect(text).not.toMatch(/téléphone|appelez|\+33|0\d( ?\d{2}){4}/i)
    expect(container.querySelector('form, textarea, input')).toBeNull()
  })

  it('describes the status link as true on every visit', () => {
    render(<HelpScreen search={{}} />)
    expect(screen.getByText('Les perturbations en cours y sont signalées.')).toBeInTheDocument()
  })

  it.each([
    ['org_owner', true],
    ['org_admin', true],
    ['org_billing', true],
    ['org_member', false],
  ])('for %s links to status, and to invoices only where the role reads them', (role, invoices) => {
    f.role = role
    render(<HelpScreen search={{}} />)
    expect(screen.getByRole('link', { name: "Voir l'état de votre instance" })).toHaveAttribute(
      'href',
      '/acme-sa/status'
    )
    const link = screen.queryByRole('link', { name: 'Voir vos factures' })
    expect(link !== null).toBe(invoices)
    if (link !== null) expect(link).toHaveAttribute('href', '/acme-sa/invoices')
  })
})
