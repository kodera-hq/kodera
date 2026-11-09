// docs/specs/00-shell-and-login.md §5 and §9, UX audits OL-24 and OL-13: what
// the sign-in screen says when discovery does not resolve. An unknown domain
// moved the person to the identifier field under the e-mail subtitle, with the
// e-mail's error sitting under the identifier as if it were the identifier's
// own; a rate limit showed a fixed number of seconds beside a live button; and
// « écrivez-nous » gave no address.
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ApiProblem } from '../../api/client'
import { registerInteractiveDemo } from '../../app/interactiveDemo'
import { createLocalWorkspaceStore } from '../../mocks/demo/workspaceStore'
import { LoginScreen } from './LoginScreen'

const discover = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }))
vi.mock('./useDiscoverRealm', () => ({ useDiscoverRealm: () => discover }))

const UNKNOWN = { realm: null, candidates: [] }
const rateLimited = (retryAfterS: number | undefined) =>
  new ApiProblem({
    type: 'https://kodera.io/problems/rate-limited',
    status: 429,
    title: 'Too many requests',
    retryAfterS,
  })
const unavailable = (retryAfterS: number | undefined = 5) =>
  new ApiProblem({
    type: 'https://kodera.io/problems/service-unavailable',
    status: 503,
    title: 'Service unavailable',
    retryAfterS,
  })
const unavailableSentence = (seconds: number) =>
  `Le service est momentanément indisponible. Réessayez dans ${seconds} ${seconds === 1 ? 'seconde' : 'secondes'} ; si cela persiste, écrivez-nous à support@kodera.io.`

const DOMAIN_UNKNOWN =
  "Aucune organisation n'utilise le domaine unknown-example.fr. Utilisez l'identifiant de votre organisation, ou écrivez-nous à support@kodera.io."
const EMAIL_SUBTITLE = 'Indiquez votre adresse e-mail professionnelle.'
const SLUG_SUBTITLE = "Indiquez l'identifiant de votre organisation."

beforeEach(() => {
  discover.mutateAsync.mockReset()
  discover.isPending = false
})

async function submitEmail(user: ReturnType<typeof userEvent.setup>, email: string) {
  await user.type(screen.getByLabelText('Adresse e-mail'), email)
  await user.click(screen.getByRole('button', { name: 'Continuer' }))
}

describe('an e-mail domain no organisation uses', () => {
  it('explains it above the identifier field, under a subtitle about the identifier', async () => {
    const user = userEvent.setup()
    discover.mutateAsync.mockResolvedValue(UNKNOWN)
    render(<LoginScreen />)
    expect(screen.getByText(EMAIL_SUBTITLE)).toBeInTheDocument()

    await submitEmail(user, 'marie.dupont@unknown-example.fr')

    const slug = await screen.findByLabelText('Identifiant de votre organisation')
    expect(slug).toHaveFocus()
    // The subtitle follows the question on screen.
    expect(screen.getByText(SLUG_SUBTITLE)).toBeInTheDocument()
    expect(screen.queryByText(EMAIL_SUBTITLE)).toBeNull()
    // Said once, with the address to write to, before the field it leads to —
    // and not as that field's own error.
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(DOMAIN_UNKNOWN)
    expect(alert.compareDocumentPosition(slug) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(slug).not.toHaveAttribute('aria-invalid', 'true')
    expect(slug).not.toHaveAccessibleDescription(DOMAIN_UNKNOWN)
  })

  it('keeps the address typed for the way back', async () => {
    const user = userEvent.setup()
    discover.mutateAsync.mockResolvedValue(UNKNOWN)
    render(<LoginScreen />)
    await submitEmail(user, 'marie.dupont@unknown-example.fr')
    await screen.findByLabelText('Identifiant de votre organisation')

    await user.click(screen.getByRole('button', { name: 'Utiliser une adresse e-mail' }))

    expect(screen.getByLabelText('Adresse e-mail')).toHaveValue('marie.dupont@unknown-example.fr')
    expect(screen.getByText(EMAIL_SUBTITLE)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('gives way to what the identifier itself returns', async () => {
    const user = userEvent.setup()
    discover.mutateAsync.mockResolvedValue(UNKNOWN)
    render(<LoginScreen />)
    await submitEmail(user, 'marie.dupont@unknown-example.fr')

    await user.type(await screen.findByLabelText('Identifiant de votre organisation'), 'acme-sa')
    await user.click(screen.getByRole('button', { name: 'Continuer' }))

    const alert = await screen.findByText(
      'Cet identifiant ne correspond à aucune organisation. Vérifiez votre e-mail de bienvenue.'
    )
    expect(alert).toBeInTheDocument()
    expect(screen.queryByText(DOMAIN_UNKNOWN)).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    // What was typed is still there to correct: the field used to be emptied.
    expect(screen.getByLabelText('Identifiant de votre organisation')).toHaveValue('acme-sa')
  })
})

it('shows the identifier subtitle and no alert when the person chooses the identifier', async () => {
  const user = userEvent.setup()
  render(<LoginScreen />)

  await user.click(
    screen.getByRole('button', { name: "Utiliser l'identifiant de votre organisation" })
  )

  expect(screen.getByLabelText('Identifiant de votre organisation')).toHaveFocus()
  expect(screen.getByText(SLUG_SUBTITLE)).toBeInTheDocument()
  expect(screen.queryByRole('alert')).toBeNull()
})

describe('an address the contract would refuse', () => {
  const INVALID =
    "Cette adresse n'est pas valide. Vérifiez qu'elle ne contient ni espace ni lettre accentuée."
  const INCOMPLETE =
    "Cette adresse ne semble pas complète. Vérifiez qu'elle contient un @ et un nom de domaine."

  it.each([
    ['an accented letter', 'élise.martin@acme.fr'],
    ['a space', 'marie dupont@acme.fr'],
    ['two dots in a row', 'marie..dupont@acme.fr'],
    ['two @', 'marie@dupont@acme.fr'],
  ])('says so before sending one with %s', async (_, email) => {
    const user = userEvent.setup()
    render(<LoginScreen />)

    await submitEmail(user, email)

    const field = screen.getByLabelText('Adresse e-mail')
    expect(await screen.findByText(INVALID)).toBeInTheDocument()
    expect(field).toHaveAccessibleDescription(INVALID)
    expect(field).toHaveValue(email)
    // Nothing was sent, so no `422` could come back as the generic message.
    expect(discover.mutateAsync).not.toHaveBeenCalled()
  })

  it('keeps the incomplete-address message for an address with no domain, and says only it', async () => {
    const user = userEvent.setup()
    render(<LoginScreen />)

    await submitEmail(user, 'élise@acme')

    expect(await screen.findByText(INCOMPLETE)).toBeInTheDocument()
    expect(screen.queryByText(INVALID)).toBeNull()
    expect(discover.mutateAsync).not.toHaveBeenCalled()
  })

  it('checks the address it sends: the normalised one, not the one typed', async () => {
    const user = userEvent.setup()
    discover.mutateAsync.mockResolvedValue(UNKNOWN)
    render(<LoginScreen />)

    // U+212A KELVIN SIGN is outside ASCII and lower-cases to an ASCII `k`.
    await submitEmail(user, '\u212Aodera@acme.fr')

    await screen.findByLabelText('Identifiant de votre organisation')
    expect(discover.mutateAsync).toHaveBeenCalledWith({ email: 'kodera@acme.fr' })
    expect(screen.queryByText(INVALID)).toBeNull()
  })

  it('sends an address the contract accepts, spaces around it trimmed', async () => {
    const user = userEvent.setup()
    discover.mutateAsync.mockResolvedValue(UNKNOWN)
    render(<LoginScreen />)

    await submitEmail(user, '  Marie+Factures@ACME-construction.fr ')

    await screen.findByLabelText('Identifiant de votre organisation')
    expect(discover.mutateAsync).toHaveBeenCalledWith({
      email: 'marie+factures@acme-construction.fr',
    })
    expect(screen.queryByText(INVALID)).toBeNull()
  })
})

describe('too many discovery attempts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Fills and submits with events fired by hand: `userEvent` waits on real
   * timers between its steps, and the clock here is a fake one. */
  async function submit(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
    await act(async () => {
      // As a press does: the button takes focus, then submits.
      screen.getByRole('button', { name: 'Continuer' }).focus()
      fireEvent.click(screen.getByRole('button', { name: 'Continuer' }))
      await vi.advanceTimersByTimeAsync(0)
    })
  }
  const tick = (seconds: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(seconds * 1000)
    })

  const views = [
    ['email', undefined, 'Adresse e-mail', 'julie@acme.fr'],
    ['identifier', 'acme-sa', 'Identifiant de votre organisation', 'acme-sa'],
  ] as const

  it.each(views)(
    'uses the actual deadline after a throttled %s timer',
    async (_, slug, label, value) => {
      const start = Date.now()
      discover.mutateAsync.mockRejectedValue(rateLimited(30))
      render(<LoginScreen {...(slug === undefined ? {} : { initialSlug: slug })} />)
      await submit(label, value)

      // Changing wall time does not run the twenty missed interval callbacks.
      vi.setSystemTime(start + 20_000)
      await tick(1)
      expect(screen.getByText('Trop de tentatives. Réessayez dans 9 secondes.')).toBeVisible()
      expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled()

      vi.setSystemTime(start + 31_000)
      await tick(1)
      expect(screen.queryByText(/Trop de tentatives/)).toBeNull()
      expect(screen.getByRole('button', { name: 'Continuer' })).toBeEnabled()
    }
  )

  it.each(views)('clears the %s interval as the wait completes', async (_, slug, label, value) => {
    discover.mutateAsync.mockRejectedValue(rateLimited(2))
    render(<LoginScreen {...(slug === undefined ? {} : { initialSlug: slug })} />)
    // Settle the form's initial zero-delay work before measuring timers.
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(vi.getTimerCount()).toBe(0)
    await submit(label, value)
    expect(vi.getTimerCount()).toBe(1)

    await tick(2)
    expect(screen.queryByText(/Trop de tentatives/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeEnabled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(views)('clears the active %s interval on unmount', async (_, slug, label, value) => {
    discover.mutateAsync.mockRejectedValue(rateLimited(30))
    const mounted = render(<LoginScreen {...(slug === undefined ? {} : { initialSlug: slug })} />)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(vi.getTimerCount()).toBe(0)
    await submit(label, value)
    expect(vi.getTimerCount()).toBe(1)
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled()

    mounted.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    [1, 1, 'seconde'],
    [1_000_000, 278, 'heures'],
    [2_000_000, 556, 'heures'],
    [3_600_000_000, 1_000_000, 'heures'],
    [7_200_000_000, 2_000_000, 'heures'],
  ])('renders the French countdown for %i seconds', async (seconds, count, unit) => {
    discover.mutateAsync.mockRejectedValue(rateLimited(seconds))
    render(<LoginScreen />)

    await submit('Adresse e-mail', 'julie@acme.fr')

    expect(screen.getByRole('alert')).toHaveTextContent(
      `Trop de tentatives. Réessayez dans ${count} ${unit}.`
    )
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled()
  })

  it('counts the wait down and holds the button until it is over', async () => {
    discover.mutateAsync.mockRejectedValue(rateLimited(30))
    render(<LoginScreen />)

    await submit('Adresse e-mail', 'julie@acme.fr')

    const button = screen.getByRole('button', { name: 'Continuer' })
    expect(screen.getByText('Trop de tentatives. Réessayez dans 30 secondes.')).toBeVisible()
    expect(button).toBeDisabled()
    // The address typed is still there, and focus is on it: not left on a
    // button that has just been disabled.
    expect(screen.getByLabelText('Adresse e-mail')).toHaveValue('julie@acme.fr')
    expect(screen.getByLabelText('Adresse e-mail')).toHaveFocus()

    await tick(1)
    expect(screen.getByText('Trop de tentatives. Réessayez dans 29 secondes.')).toBeVisible()
    expect(button).toBeDisabled()

    await tick(28)
    expect(screen.getByText('Trop de tentatives. Réessayez dans 1 seconde.')).toBeVisible()
    expect(button).toBeDisabled()

    await tick(1)
    expect(screen.queryByText(/Trop de tentatives/)).toBeNull()
    expect(button).toBeEnabled()
  })

  it('announces the wait once, not every second', async () => {
    discover.mutateAsync.mockRejectedValue(rateLimited(30))
    render(<LoginScreen />)

    await submit('Adresse e-mail', 'julie@acme.fr')

    // One alert, carrying the sentence as it was when the refusal arrived.
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Trop de tentatives. Réessayez dans 30 secondes.'
    )

    await tick(1)
    // The line on screen goes on counting; it is in no live region, so nothing
    // is announced again, and the alert that spoke is gone rather than stale.
    expect(screen.queryByRole('alert')).toBeNull()
    const line = screen.getByText('Trop de tentatives. Réessayez dans 29 secondes.')
    expect(line.closest('[aria-live], [role="alert"], [role="status"]')).toBeNull()
  })

  it.each(views)(
    'shares the %s deadline across views and guards form submissions',
    async (_, slug, label, value) => {
      discover.mutateAsync.mockRejectedValue(rateLimited(30))
      render(<LoginScreen {...(slug === undefined ? {} : { initialSlug: slug })} />)
      await submit(label, value)
      await tick(5)
      const switchView = () =>
        fireEvent.click(
          screen.getByRole('button', {
            name: screen.queryByLabelText('Adresse e-mail')
              ? "Utiliser l'identifiant de votre organisation"
              : 'Utiliser une adresse e-mail',
          })
        )
      switchView()
      const otherLabel = slug === undefined ? 'Identifiant de votre organisation' : 'Adresse e-mail'
      fireEvent.change(screen.getByLabelText(otherLabel), {
        target: { value: slug === undefined ? 'acme-sa' : 'julie@acme.fr' },
      })
      expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled()
      expect(screen.getByText('Trop de tentatives. Réessayez dans 25 secondes.')).toBeVisible()
      await act(async () => {
        fireEvent.submit(screen.getByLabelText(otherLabel).closest('form')!)
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(discover.mutateAsync).toHaveBeenCalledTimes(1)
      await tick(24)
      switchView()
      expect(screen.getByText('Trop de tentatives. Réessayez dans 1 seconde.')).toBeVisible()
      expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled()
      const active = document.activeElement
      await tick(1)
      const status = screen.getByRole('status')
      expect(status).toHaveAttribute('aria-live', 'polite')
      expect(status).toHaveTextContent('Vous pouvez réessayer.')
      expect(document.activeElement).toBe(active)
      expect(screen.getByRole('button', { name: 'Continuer' })).toBeEnabled()
      const mutations: MutationRecord[] = []
      const observer = new MutationObserver((records) => mutations.push(...records))
      observer.observe(status, { childList: true, subtree: true, characterData: true })
      switchView()
      await tick(2)
      switchView()
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(screen.getByRole('status')).toBe(status)
      expect(mutations).toHaveLength(0)
      observer.disconnect()
    }
  )

  it.each([
    [59, '59 secondes'],
    [60, '1 minute'],
    [61, '2 minutes'],
    [3599, '60 minutes'],
    [3600, '1 heure'],
    [3601, '2 heures'],
  ])('presents %s seconds without changing the deadline', async (seconds, text) => {
    const start = Date.now()
    discover.mutateAsync.mockRejectedValue(rateLimited(seconds))
    render(<LoginScreen />)
    await submit('Adresse e-mail', 'julie@acme.fr')
    expect(screen.getByRole('alert')).toHaveTextContent(
      `Trop de tentatives. Réessayez dans ${text}.`
    )
    vi.setSystemTime(start + seconds * 1000 - 1001)
    await tick(1)
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled()
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Adresse e-mail').closest('form')!)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(discover.mutateAsync).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeEnabled()
  })

  it('extends an active wait when another started request later refuses for longer', async () => {
    const failures: ((reason: unknown) => void)[] = []
    discover.mutateAsync.mockImplementation(() => new Promise((_, reject) => failures.push(reject)))
    render(<LoginScreen />)
    await submit('Adresse e-mail', 'julie@acme.fr')
    await submit('Adresse e-mail', 'julie@acme.fr')
    await act(async () => {
      failures[1]!(rateLimited(2))
      await vi.advanceTimersByTimeAsync(0)
    })
    await tick(1)
    await act(async () => {
      failures[0]!(rateLimited(61))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('Trop de tentatives. Réessayez dans 2 minutes.')).toBeVisible()
    await tick(60)
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled()
    await tick(1)
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeEnabled()
  })

  it.each([
    [60, '1 minute'],
    [61, '2 minutes'],
    [3600, '1 hour'],
    [3601, '2 hours'],
  ])('renders the approved English duration for %s seconds', async (seconds, text) => {
    discover.mutateAsync.mockRejectedValue(rateLimited(seconds))
    render(<LoginScreen />)
    await submit('Adresse e-mail', 'julie@acme.fr')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'EN' })))
    try {
      expect(screen.getByRole('alert')).toHaveTextContent(
        `Too many attempts. Try again in ${text}.`
      )
      await tick(seconds)
      expect(screen.getByRole('status')).toHaveTextContent('You can try again.')
    } finally {
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'FR' })))
    }
  })

  it('does not shorten the deadline when an earlier request refuses later', async () => {
    const failures: ((reason: unknown) => void)[] = []
    discover.mutateAsync.mockImplementation(() => new Promise((_, reject) => failures.push(reject)))
    render(<LoginScreen />)
    await submit('Adresse e-mail', 'julie@acme.fr')
    await submit('Adresse e-mail', 'julie@acme.fr')
    expect(failures).toHaveLength(2)
    await act(async () => {
      failures[1]!(rateLimited(61))
      await vi.advanceTimersByTimeAsync(0)
    })
    await tick(1)
    await act(async () => {
      failures[0]!(rateLimited(2))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('Trop de tentatives. Réessayez dans 1 minute.')).toBeVisible()
    await tick(59)
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled()
    await tick(1)
    expect(screen.getByRole('status')).toHaveTextContent('Vous pouvez réessayer.')
  })

  it.each([
    ['Infinity', Infinity],
    ['NaN', NaN],
    ['1e306, whose deadline would be Infinity', 1e306],
  ])('waits a minute, as if nothing were said, when retry_after_s is %s', async (_, given) => {
    discover.mutateAsync.mockRejectedValue(rateLimited(given))
    render(<LoginScreen />)

    await submit('Adresse e-mail', 'julie@acme.fr')

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Trop de tentatives. Réessayez dans 1 minute.'
    )
    await tick(59)
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled()
    await tick(1)
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeEnabled()
  })

  it('waits a minute when the refusal does not say how long', async () => {
    discover.mutateAsync.mockRejectedValue(rateLimited(undefined))
    render(<LoginScreen />)

    await submit('Adresse e-mail', 'julie@acme.fr')

    expect(screen.getByText('Trop de tentatives. Réessayez dans 1 minute.')).toBeVisible()
  })

  // The contract allows `retry_after_s: 0` (`integer | null, minimum: 0`): a
  // refusal with nothing to wait for. It used to show nothing at all — no
  // message, no countdown, a live button — so the refusal was silent.
  const NO_WAIT = 'Trop de tentatives. Réessayez.'

  it.each([
    ['zero', 0],
    ['less than zero', -5],
  ])('says so and leaves the button usable when the wait is %s', async (_, retryAfterS) => {
    discover.mutateAsync.mockRejectedValue(rateLimited(retryAfterS))
    render(<LoginScreen />)

    await submit('Adresse e-mail', 'julie@acme.fr')

    const button = screen.getByRole('button', { name: 'Continuer' })
    expect(screen.getByRole('alert')).toHaveTextContent(NO_WAIT)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.queryByText(/Réessayez dans/)).toBeNull()
    expect(button).toBeEnabled()
    expect(screen.getByLabelText('Adresse e-mail')).toHaveValue('julie@acme.fr')

    // No countdown: a second later the same sentence is still the alert, and
    // the button is still there to press.
    await tick(1)
    expect(screen.getByRole('alert')).toHaveTextContent(NO_WAIT)
    expect(button).toBeEnabled()

    // And pressing it asks again.
    await submit('Adresse e-mail', 'julie@acme.fr')
    expect(discover.mutateAsync).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert')).toHaveTextContent(NO_WAIT)
  })

  it('says so for the organisation identifier as well', async () => {
    discover.mutateAsync.mockRejectedValue(rateLimited(0))
    render(<LoginScreen initialSlug="acme-sa" />)

    await submit('Identifiant de votre organisation', 'acme-sa')

    expect(screen.getByRole('alert')).toHaveTextContent(NO_WAIT)
    expect(screen.queryByText(/Réessayez dans/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeEnabled()
    expect(screen.getByLabelText('Identifiant de votre organisation')).toHaveValue('acme-sa')
  })

  it('rounds a part of a second up, in the sentence and in the wait', async () => {
    discover.mutateAsync.mockRejectedValue(rateLimited(1.5))
    render(<LoginScreen />)

    await submit('Adresse e-mail', 'julie@acme.fr')

    const button = screen.getByRole('button', { name: 'Continuer' })
    // Announced as it appears, like any other wait.
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Trop de tentatives. Réessayez dans 2 secondes.'
    )
    expect(button).toBeDisabled()

    await tick(1)
    expect(screen.getByText('Trop de tentatives. Réessayez dans 1 seconde.')).toBeVisible()
    expect(button).toBeDisabled()

    await tick(1)
    expect(screen.queryByText(/Trop de tentatives/)).toBeNull()
    expect(button).toBeEnabled()
  })

  it('does the same for the organisation identifier', async () => {
    discover.mutateAsync.mockRejectedValue(rateLimited(5))
    render(<LoginScreen initialSlug="acme-sa" />)

    await submit('Identifiant de votre organisation', 'acme-sa')

    const button = screen.getByRole('button', { name: 'Continuer' })
    expect(screen.getByText('Trop de tentatives. Réessayez dans 5 secondes.')).toBeVisible()
    expect(button).toBeDisabled()
    expect(screen.getByLabelText('Identifiant de votre organisation')).toHaveFocus()

    await tick(5)
    expect(screen.queryByText(/Trop de tentatives/)).toBeNull()
    expect(button).toBeEnabled()
  })

  describe('discovery unavailable', () => {
    it.each(views)(
      'waits five seconds on the %s step, then lets the person try again',
      async (_, slug, label, value) => {
        discover.mutateAsync.mockRejectedValue(unavailable(5))
        render(<LoginScreen {...(slug === undefined ? {} : { initialSlug: slug })} />)

        await submit(label, value)

        const button = screen.getByRole('button', { name: 'Continuer' })
        // Announced once, as it appears, with the address to write to.
        expect(screen.getByRole('alert')).toHaveTextContent(unavailableSentence(5))
        expect(screen.getAllByRole('alert')).toHaveLength(1)
        expect(screen.queryByText(/Trop de tentatives/)).toBeNull()
        expect(button).toBeDisabled()
        expect(screen.getByLabelText(label)).toHaveValue(value)
        expect(screen.getByLabelText(label)).toHaveFocus()

        await tick(1)
        expect(screen.getByText(unavailableSentence(4))).toBeVisible()
        expect(screen.queryByRole('alert')).toBeNull()
        await act(async () => {
          fireEvent.submit(screen.getByLabelText(label).closest('form')!)
          await vi.advanceTimersByTimeAsync(0)
        })
        expect(discover.mutateAsync).toHaveBeenCalledTimes(1)

        await tick(3)
        expect(screen.getByText(unavailableSentence(1))).toBeVisible()
        expect(button).toBeDisabled()

        await tick(1)
        expect(screen.queryByText(/Le service est momentanément indisponible/)).toBeNull()
        expect(button).toBeEnabled()
        expect(screen.getByRole('status')).toHaveTextContent('Vous pouvez réessayer.')

        await submit(label, value)
        expect(discover.mutateAsync).toHaveBeenCalledTimes(2)
      }
    )

    it.each([
      ['missing', undefined, 5],
      ['shorter than five seconds', 1, 5],
      ['zero', 0, 5],
      ['longer than five seconds', 12, 12],
      ['a part of a second over five', 5.2, 6],
      ['a year', 31_536_000, 60],
      ['1e306', 1e306, 60],
      ['Infinity', Infinity, 60],
      ['NaN', NaN, 5],
    ])(
      'waits the contract minimum or more, a minute at most, when retry_after_s is %s',
      async (_, given, wait) => {
        discover.mutateAsync.mockRejectedValue(unavailable(given))
        render(<LoginScreen />)

        await submit('Adresse e-mail', 'julie@acme.fr')

        expect(screen.getByRole('alert')).toHaveTextContent(unavailableSentence(wait))
        await tick(wait - 1)
        expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled()
        await tick(1)
        expect(screen.getByRole('button', { name: 'Continuer' })).toBeEnabled()
      }
    )

    it('does not shorten a rate-limit wait, nor change its sentence', async () => {
      const failures: ((reason: unknown) => void)[] = []
      discover.mutateAsync.mockImplementation(
        () => new Promise((_, reject) => failures.push(reject))
      )
      render(<LoginScreen />)
      await submit('Adresse e-mail', 'julie@acme.fr')
      await submit('Adresse e-mail', 'julie@acme.fr')
      await act(async () => {
        failures[0]!(rateLimited(30))
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        failures[1]!(unavailable(5))
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(screen.getByText('Trop de tentatives. Réessayez dans 30 secondes.')).toBeVisible()
      expect(screen.queryByText(/Le service est momentanément indisponible/)).toBeNull()
      await tick(29)
      expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled()
      await tick(1)
      expect(screen.getByRole('button', { name: 'Continuer' })).toBeEnabled()
    })

    it('renders the English sentence', async () => {
      discover.mutateAsync.mockRejectedValue(unavailable(5))
      render(<LoginScreen />)
      await submit('Adresse e-mail', 'julie@acme.fr')
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'EN' })))
      try {
        expect(
          screen.getByText(
            'The service is temporarily unavailable. Try again in 5 seconds; if it continues, email us at support@kodera.io.'
          )
        ).toBeVisible()
      } finally {
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'FR' })))
      }
    })
  })
})

describe('interactive demo entry', () => {
  afterEach(() => registerInteractiveDemo(undefined))

  it('prefills community when no organisation is explicitly requested', () => {
    registerInteractiveDemo({ slug: 'community', createStore: createLocalWorkspaceStore })
    render(<LoginScreen />)
    expect(screen.getByLabelText('Identifiant de votre organisation')).toHaveValue('community')
  })

  it('preserves an explicitly requested organisation in demo mode', () => {
    registerInteractiveDemo({ slug: 'community', createStore: createLocalWorkspaceStore })
    render(<LoginScreen initialSlug="acme-sa" />)
    expect(screen.getByLabelText('Identifiant de votre organisation')).toHaveValue('acme-sa')
  })
})
