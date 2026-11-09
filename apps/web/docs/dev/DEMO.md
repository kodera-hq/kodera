# The walkable demo

Status: Active

A complete, clickable run through the console as it exists today, on one seeded organisation, in
an order that makes sense to somebody who has never seen the product. It runs entirely against
MSW — no Core API, no Keycloak, no network — and it is not reachable from a production build.

This document is the script. Read it while clicking.

## Start it

```
npm ci
PATH=/opt/homebrew/opt/node@22/bin:$PATH \
VITE_ENABLE_MSW=1 VITE_AUTH_MODE=mock VITE_OIDC_CLIENT_ID=console \
VITE_CORE_API_URL=http://localhost:5199/api/v1 VITE_KEYCLOAK_URL=http://localhost:5199/auth \
npm run build && npm run preview -- --port 5199 --strictPort
```

Any free port will do; the two `VITE_*` URLs and `--port` have to name the same one, because the
build bakes them in. This is the production-shaped build the end-to-end suite drives, not the dev
server — the dev server works too, but it transforms sources on every navigation and MSW logs an
error for each of Vite's own client requests, which is noise you do not want on a projector.

This build shows what the pilot shows: the screens whose Core operations are not routed yet are
hidden ([CAPABILITIES.md](CAPABILITIES.md)). The end-to-end suite adds `VITE_MOCK_UNSERVED=1`,
which shows them too, so `tests/e2e/demo-walkthrough.spec.ts` also walks the incident panel and
« État du service »; the walkthrough below describes the pilot.

Then open **`http://localhost:5199/login?demo=1`**. That is the whole entry point: `?demo=1`
selects the demo's scenario overlay, and nothing else has to be typed anywhere. `?demo=0` on any
URL leaves it again and puts the ordinary fixtures back.

The parameter does not have to survive anything — it writes the selection into
`sessionStorage['msw:scenarios']`, the same key `tests/e2e/support/useScenario.ts` writes, which
is what carries the demo across the three redirects sign-in makes. It is read in
`src/mocks/browser.ts`, a module `src/main.tsx` only imports when `VITE_ENABLE_MSW === '1'`, so
there is no demo code in a production bundle to reach in the first place
(`npm run build:check`, below).

Two practical notes before you stand in front of somebody:

- **Navigate by clicking.** Reloading the page, or typing a URL into a tab that is already signed
  in, sends the mock identity provider through the silent-SSO path, which shows
  "Restauration de votre session…" for about ten seconds before offering a "Continuer" button.
  It recovers, but not in a way you want to narrate. Opening a *fresh* tab straight at, say,
  `http://localhost:5199/vercelli/invoices?demo=1` lands on that screen in under two seconds and
  one Continuer click, so a deep link is the way back in, not a reload.
- **Nothing is ever sent.** Order submission is deliberately held on `main`
  (`SUBMISSION_HELD` in `src/features/order/AgreementsStep.tsx`), and every screen says so.

## Community workspace

Open `/login?demo=1&org=community`, continue through the mock identity provider, and land on
`/community/workspace`. The organisation identifier `community` and addresses at
`community.kodera.io` resolve to the first-party Community demo. The existing `vercelli`
identifier and sign-in address retain their original walkthrough below.

This uses the standard authenticated router, `WorkspaceScreen` and `EspaceLiveView`, with
exactly three categories:

- **Community**, open to everyone: `announcements`, `developers-community`, `support`,
  `extensions`, `self-hosting`, `show-and-tell` and the voice room `office-hours`.
- **Core Kodera**, private core-team rooms: `dev`, `strategy` and `ops-oncall`.
- **Design Partners**, separate private partner rooms: `partner-dinum` and `partner-octo`.

Each text channel has a local conversation; both partner rooms include an example of feedback
sent with Element over Matrix. Audience descriptions are display metadata in this owner demo,
not a real membership grant, a live federation check or a connected voice call. Real access remains
owned by Core and Matrix. The Community preview uses the same category blueprint.

Use Discussion/Docs and select Developer documentation to open the three-column docs hub. The
organisation sidebar also provides L/D/B theme choices, Templates onboarding, the Frame.io
connector preview and Community access. Theme choices use the normal persisted preference.

`?showcase=1` no longer selects another application; every ordinary entry uses the same router.
Appearance and channel-document components live in their product feature directories. Demo data
and mock credentials stay behind the mock-worker build gate. The server still reserves
`community` against third-party organisation or tenant creation.

## The organisation

One company, on every screen, seeded in `src/mocks/demo/seed.ts`:

| | |
|---|---|
| Organisation | **Groupe Vercelli** (Groupe Vercelli SAS), 42 route de Vienne, 69007 Lyon — SIREN 512345678, TVA FR42512345678 |
| Signed-in person | **Inès Kaci**, `i.kaci@groupe-vercelli.fr`, owner of the organisation |
| Accounts | 138, on capacity tier **M** (designed for 165 people, 50 simultaneous participants, 100 GB) |
| Subscription | plan `business` v3, pack `visio`, billed **monthly**, 349 € HT/month, next invoice on the 1st of next month |
| Applications | Visio at `https://visio.groupe-vercelli.fr`. Docs is not on sale yet, so the demo does not show it. |
| Open incident | **INC-2026-071** — video calls degraded, started 42 minutes ago |
| Invoices | four, one a month, the current one still to pay at 418,80 € TTC |

Every date is relative to the moment you open it, so the incident is always fresh, the last
invoice is always the one for this month and the next charge is always three weeks out. The
organisation is the one the design handoff uses, so the console demo and the product mock describe
the same company.

## The script

Six steps. The arc is: **arrive → find a problem → understand it → see what it costs → fix the
constraint.**

### 1. Connexion — the organisation is found from the address

Open `http://localhost:5199/login?demo=1`. Type `i.kaci@groupe-vercelli.fr` and press Continuer.

> "On ne demande ni identifiant ni mot de passe de plus. Le domaine de l'adresse professionnelle
> désigne l'organisation, et l'authentification se fait sur son propre annuaire."

The next page names the realm it is signing in to — `vercelli`, the organisation's own. Press
Continuer again.

### 2. Accueil — is everything fine, what does it cost, who is here

You land on `/vercelli/home`.

> "Un seul écran répond aux trois questions qu'on se pose en arrivant."

Point at, in order:

- the **red banner**: an incident is in progress on video calls, since a stated time;
- the **capacity card**: 46 of 50 simultaneous participants, 92 %, "Proche de la limite", with
  the consequence spelled out — beyond 50, new connections are refused;
- the **next invoice**: 349 € HT/month, charged on the 1st of next month;
- the **applications**, on the customer's own domain, each with its status;
- the **contract** and the **support** cards: `visio`, monthly, four working hours to a
  first answer; « Écrire au support » opens Aide, which says what to put in the message.

### 3. Applications — the incident as an object, not a rumour

Click **Applications** in the sidebar.

> "L'incident n'est pas un bandeau vague : il a une portée et une heure de début."

- the degraded pill and banner: which component, since when, and « Nous écrire », which opens
  Aide (no external status page: this screen is the status source);
- **Vos applications**: each app's own address *and* its fallback `*.kodera.io` address, both
  copyable — the fallback is what still works while a customer's DNS is being changed;
- **Capacité**: the same 46 / 50 as Home, same percentage, same wording;
- **Votre formule**: pack `visio`, tier M, next invoice — the same date Home showed.

### 4. Facturation — the money, with no surprises

Click **Facturation**.

> "Tout ce qui est facturé est visible, avec la TVA telle qu'elle a été émise."

- **Votre abonnement**: `business`, facturé mensuellement, 349 € — the same figure as the Accueil
  card, and the same next-invoice date as both previous screens;
- the ledger: four invoices, one per month, the current one **À régler** and the three before it
  **Payée**, all at 418,80 € TTC;
- each row downloads its own PDF.

### 5. One invoice — a real French one

Click **FA-2026-0091** (the newest row; the number moves with the month).

> "Le détail, la TVA, le lien de paiement et le virement — le comptable n'a besoin de rien
> d'autre."

- the amount due and its due date;
- **Payer en ligne** (card or one-off SEPA), and the sentence saying the transfer details are on
  the PDF, because accounting departments pay by transfer (the bank details themselves wait for
  the invoice contract to carry them, 05-invoices.md §4.3);
- the line, the net total, **TVA 20 %**, the gross total — the same 349 € / 69,80 € / 418,80 € the
  list showed;
- the issue date and the payment provider's own reference.

### 6. Voir les formules — the capacity is why, and the price is stated first

Click **Applications** again, then **Voir les formules** on the capacity card.

> "On facture la capacité, pas le nombre de comptes : les collaborateurs et les invités sont
> illimités. C'est le nombre de personnes en réunion en même temps qui définit la formule."

- the headcount field, and the rule stated on screen: about 30 % of the workforce in a meeting at
  the same time;
- three plans on Core's grid (Team, Business, Business Plus), each billed annually by default
  as a monthly equivalent with its annual total, and its simultaneous participants —
  **Business Plus**, at 75, is the one that clears the 50-participant ceiling the capacity card
  was warning about a click ago;
- no Docs option: Docs is not on sale yet, and the demo shows only what Kodera sells;
- the four steps of the order, and the notice that submission is held: nothing can be bought yet,
  and the console says so rather than failing at the end.

Close on the Accueil screen.

## Known rough edges

One thing on this path is the console's, not the demo's. The demo does not hide it, and nobody
should be surprised by it mid-sentence:

- **The banner's "prochaine mise à jour" is not the incident's.** The shell reads
   `status-summary.measured_at`, because that call carries no next-update field
   (`src/app/StatusBanner.tsx` documents the gap). The incident's own next update lives in the
   incident panel, which the pilot hides until Core serves the incidents read; with the override,
   the two disagree, by design of the contract rather than of the seed.

## How this stays true

- `src/mocks/demo/seed.test.ts` — the joins between the records, the arithmetic on the invoices,
  and, by scanning `src/features`, `src/app` and `src/api` for Core API calls, the assertion that
  **every route this console can call has a seeded answer**. A route without one is not a blank
  screen: it is answered by the generated base handler, with the contract example's own company on
  it, mid-demo.
- `tests/e2e/demo-walkthrough.spec.ts` — the six steps above, in order, asserting at each one that
  the value carried from the previous screen is the value this one shows, and that the contract
  example's company appears nowhere.
- `src/mocks/browser.test.ts` — the `?demo=1` / `?demo=0` entry point, including that a URL with
  no `demo` parameter changes nothing (otherwise every end-to-end spec's own scenario selection
  would be cleared at worker start).
- `npm run build:check` — the seed's literals (`demo.groupe-vercelli`, `Groupe Vercelli`,
  `groupe-vercelli.fr`) must not appear in a production bundle, alongside the mock identity
  provider's. `scripts/check-production-bundle.selftest.sh` proves that check can fail: it
  confirms a mock build is rejected *and names each demo literal*, then mutates the clean
  production bundle with one literal at a time.
