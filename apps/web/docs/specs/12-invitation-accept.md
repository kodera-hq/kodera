# 12 — Invitation acceptance

**Status:** Draft, not gated. The page is built in every build, and its connected run is the v1
smoke's E2 (`tests/smoke/README.md`). Its §12 tests join `scripts/spec-gate.json` once the mock
identity provider can answer the protected popup sign-in in the end-to-end suite · **Owner:** zôÖma

The page an invitation mail links to. An organisation's owner or administrator invites a person
from People ([`03-people.md`](03-people.md) §4.2); Core creates that person's account in the
organisation's realm, mails them the realm's own set-up link (address, password, authenticator) and
then the invitation link. **This page** is where the invitation link lands, and where the person
becomes a member.

## 1. Goal

The invited person reaches the organisation's Espace as an `org_member`, having signed in to the
organisation's own realm, with one explicit click to join. A link whose halves disagree is refused
before any sign-in starts.

## 2. Persona

The invited person is often new to Kodera and has just set up their account from the realm's mail.
They are not a member yet, so the page is shell-less: no rail, no organisation menu.

## 3. Entry point

| Entry | URL |
|---|---|
| The invitation mail Core sends (`acceptInvitation`, contract 0.30.0; kodera-core#308) | `<invitation base>/{organisation_id}/{slug}#<token>`, with the opaque token only in the fragment |

The same shape as the claim link ([`09-owner-claim.md`](09-owner-claim.md) §3). The organisation id
and slug are nonsecret and may appear in history and logs; neither authenticates the person.

- **The entry serves in every build**, unlike the claim, which waits for `VITE_FIRST_OWNER_JOURNEY`.
- **Fragment.** The entry bootstrap (`src/entry-bootstrap.ts`, [`entry-bootstrap.md`](entry-bootstrap.md))
  captures the fragment once, removes it with `history.replaceState`, and verifies removal before
  any other request. Only then does it release the page, which holds the token in memory only
  (`src/features/invitation/entry.ts`). The token never goes to storage, the router, history state,
  a query, a log or analytics. A reload loses it, and the person reopens the link. Leaving the page
  (`pagehide`, including into the back-forward cache) forgets it.
- **Refused shapes.** The path must be exactly `/invitations/accept/<canonical UUID>/<slug>`, and
  the token must be within the contract's bound (32 to 256 printable characters, otherwise opaque).
  Anything else shows the entry recovery page, and no other request starts.
- **Headers.** The static server already serves every page with `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store` and `frame-ancestors 'none'` ([`claim-entry-serving.md`](claim-entry-serving.md)).
- **Protected callback.** The sign-in uses the protected popup that the claim uses, which returns to
  `/auth/claim-callback`. That callback therefore serves in every build now, still only after the
  claim envelope key has been read, removed and verified absent; a failed deletion still stops it.
  Fleet and identity realm tooling's customer realm template already register this redirect URI.

## 4. Screen

```
┌─────────────────────────────────────────────┐
│ Invitation Kodera                (kicker)   │
│ (AS) Acme SA                                │
│ ─────────────────────────────────────────── │
│ Vous êtes invité à rejoindre Acme SA.  (h1) │
│ Connectez-vous avec le compte créé pour     │
│ vous.                                       │
│                                             │
│ [ Se connecter ]                            │
└─────────────────────────────────────────────┘
```

The kicker is `text-md` semibold in `c-accent-ink`. Once discovery has confirmed the link
(§4.1), and only then, the organisation sits above the sentence: its initials on `c-inverse`
(decoration, hidden from assistive technology) and its name, from the discovery answer. Each
sentence is the page's `h1`, `text-2xl` bold, the onboarding reference screen's title size.

### 4.1 Before sign-in: the organisation is the link's own

The page posts `discoverRealm` with the link's slug. It continues only when the answer names an
organisation whose `id` is the link's organisation id, whose `slug` is the link's slug, and whose
`realm` is the answer's realm. The organisation's name on the page comes from that answer, never
from the link. Any other answer, including an unresolved slug, is « Ce lien d'invitation n'est pas
valide », the token is forgotten, and no sign-in is offered. A discovery that gets no answer, a
`429` or a `5xx` says « Nous n'avons pas pu vérifier ce lien d'invitation » and offers « Réessayer »,
which asks again; any other refusal is « Nous n'avons pas pu confirmer votre invitation ».

### 4.2 Sign-in

« Se connecter » opens the protected popup sign-in (`ownerClaimAuth.begin`, purpose `invitation`)
on the discovered realm. Like the claim's, it is always a new login (`max_age=0`): an invitation is
accepted by whoever signs in, never by a session already open in that browser for another person of
the same realm. The popup's state carries the purpose, and a returned state of the other purpose
does not release this one. A popup the person closes ends the sign-in (`popupAbortOnClose`). While the popup is open, the page says « Une fenêtre de connexion est
ouverte. Terminez la connexion dans cette fenêtre. » and offers « Annuler »: it closes the popup
(`cancel()`), and the page offers « Se connecter » again, as a closed popup does. A popup that
comes back after it was cancelled changes nothing. The page keeps the
session generation the sign-in produced, and sends an acceptance only under it: any other session
asks for « Se connecter » again, with nothing sent.

### 4.3 Join

Signed in, the page says « Rejoignez Acme SA pour accéder à son espace » and offers « Rejoindre
Acme SA ». Nothing is posted before that click. The click posts `acceptInvitation` with the token
and an `Idempotency-Key`. There is one key per sign-in, and a retry after an unanswered request,
a `5xx` or `idempotency-key-in-flight` resends the same key and body. Core stores and replays a
`2xx` or a `4xx` other than `401` and `429` against its key (Core `docs/api/CONVENTIONS.md` §8);
a retry after a `429` takes a new key, as the header's own description asks, which changes nothing
on the wire.

## 5. State matrix

| Answer to `acceptInvitation` | The person reads | Then |
|---|---|---|
| `200` | (spinner) | The token is forgotten, cached `/me` reads are dropped, and the page opens `/{slug}/workspace` for an `org_member`, or `/{slug}/home` for any other role the membership answers |
| `409 conflict`, and `/me` lists an active membership of this organisation | « Vous êtes déjà membre de Acme SA » | « Ouvrir les messages » links to `/{slug}/workspace` for an `org_member`; « Ouvrir l'accueil » links to `/{slug}/home` for any other role |
| `409 conflict`, any other `/me` (no such membership, not active, unreadable, or another session) | « Cette invitation ne peut pas être utilisée. Contactez la personne qui vous a invité(e). » | No action; the token is forgotten |
| `409 idempotency-key-in-flight` | « L'acceptation n'a pas abouti. Réessayez dans un instant. » | « Rejoindre » waits `retry_after_s`, then resends the same key and body |
| `409 idempotency-key-reuse`, any other `409` | « Nous n'avons pas pu confirmer votre invitation… » | No action; the token is forgotten |
| `404` | « Cette invitation n'existe pas ou a déjà été utilisée… » | No action; the token is forgotten |
| `410` | « Cette invitation a expiré ou a été retirée… » | No action; the token is forgotten |
| `401` | The sign-in sentence again | « Se connecter »; the next acceptance uses a new key |
| `5xx`, no answer | « L'acceptation n'a pas abouti. Réessayez dans un instant. » | « Rejoindre » resends the same key and body |
| `429` | The same sentence | « Rejoindre » sends the same body with a new key |
| Any other refusal | « Nous n'avons pas pu confirmer votre invitation… » | No action; the token is forgotten |

Leaving the page ends it, whether the browser leaves (`pagehide`) or the app routes away (the home
link, back): the token is forgotten and a sign-in still open is cancelled.

The page with no held token for its own path (a reload, a link opened without its fragment) says
« Rouvrez le lien de votre invitation pour continuer » and sends nothing.

Core answers `409 conflict` for a person who is already a member, and also for an organisation
that is not active and for a person removed from it. So the page reads `GET /me` under the same
session before saying « déjà membre », and links to a home only when `/me` shows an active
membership of this organisation.

## 6. Core API calls

| Method | Path | Body | When |
|---|---|---|---|
| `POST` | `/api/v1/auth/discover` | `{ slug }` | On load, before any sign-in |
| `POST` | `/api/v1/invitations/accept` | `{ token }`, `Idempotency-Key` | On « Rejoindre », signed in to the discovered realm |
| `GET` | `/api/v1/me` | | After a `409 conflict`, under the same session |

`display_name` is not sent: the realm account already carries the person's name.

## 7. Copy

`docs/specs/copy/{fr,en}.md`, « Invitation acceptance »: `console.invitation.accept.*`.

## 10. Accessibility

Each settled state's sentence is the page's `h1`, and focus moves to it. The heading carries
`data-route-heading`: it is where reading resumes, not a control, so like every route heading it
draws no focus ring (`src/index.css`); before, it drew one, and looked like a field. While a
request is in flight the page shows a labelled spinner instead.

## 12. Acceptance tests

Proposed, not gated (see the status line). The unit tests in
`src/features/invitation/AcceptScreen.test.tsx` cover §4–§5 today, and the v1 smoke's E2 runs the
page against Core and Keycloak.

1. **Given** a pending invitation and its invited person,
   **when** they open the link, sign in and join,
   **then** they land on the organisation's Espace as an active `org_member`.
   `invitation/accept: makes the invited person a member and opens Espace`

2. **Given** a link whose slug discovers another organisation than its id names,
   **when** the page loads,
   **then** it says the link is not valid and offers no sign-in.
   `invitation/accept: refuses a link whose organisation id and slug disagree`

3. **Given** an expired or withdrawn invitation,
   **when** the person joins,
   **then** the page says so and asks for a new invitation, with no action.
   `invitation/accept: explains an expired or withdrawn invitation`

4. **Given** a person who is already a member,
   **when** they join again,
   **then** the page says so and links to Espace, or to the home for an owner, admin or billing.
   `invitation/accept: tells an existing member and links to Espace`

## 13. Out of scope for launch

- Setting a display name on acceptance.
- Accepting into an organisation the person already belongs to under another account.
- A gated end-to-end run in the mock suite, which needs the mock identity provider to answer the
  protected popup.
- Who invited the person, and the role they will hold. Core offers the invited person no read of
  an invitation before it is accepted (`acceptInvitation` only; `Invitation.invited_by` is an id
  that only the organisation's managers can read). Showing them needs a token-bound preview
  operation in Core, with its own security review (it must not become a token oracle). Until
  then, the invitation mail is the place that names the inviter.

## Changelog

- Card hierarchy (gap report G4, staging walk finding 5): the sentence heading is a route heading
  and draws no focus ring, it is `text-2xl` bold, the kicker is readable, and the confirmed
  organisation is named above it. Inviter and role are out of scope until Core has a preview (§13).

- Draft: the page, the entry, the protected callback in every build, the unit tests and the v1
  smoke's E2.
