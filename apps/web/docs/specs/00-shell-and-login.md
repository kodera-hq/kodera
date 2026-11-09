# 00 — Shell and login

**Status:** Proposed · **Owner:** zôÖma

## 1. Goal

Let the person who bought Kodera reach their organisation's console with the same login
they use in Visio and Docs, know at a glance whether the service is healthy, and never wonder
which organisation they are looking at.

## 2. Persona and the "can the CEO do this alone" test

**Who.** The CEO or the office manager of a 120-person organisation. They know their email
address and their organisation's name. They do not know what a realm is, what OIDC is, or that
several Keycloak realms exist. Some of them belong to two organisations (a holding and an
operating company, or a coop and its federation).

**What they do not know.** That "identifiant de votre organisation" is a slug; that MFA is
called MFA; that a session has an expiry.

**Alone test: pass**, on three conditions.

1. Realm discovery never asks for a technical identifier as the first question. The first
   question is the email address, which every buyer has; the organisation identifier is the
   fallback for a person whose email domain is not registered.
2. MFA enrolment offers the passkey first, in the words "clé de votre appareil", with TOTP as
   the second choice and a printable recovery sheet. A person who fails passkey enrolment on a
   locked-down work laptop must land on TOTP without support.
3. Session expiry never loses typed input. The console re-authenticates in place and returns to
   the same screen with the form intact.

**Where it still fails.** A user who belongs to two organisations with the same display name
cannot tell them apart. The switcher therefore shows the organisation's own domain under its
name.

## 3. Entry points

| Entry | URL | Notes |
|---|---|---|
| Direct visit | `https://app.kodera.io/` | Redirects to `/login` when no session, else to the first organisation's `/{org}/workspace` for an `org_member` of an organisation whose tenant has the `messaging` app (Espace) or that has no tenant yet, and `/{org}/home` for any other role or for a member of an organisation whose tenant runs without it, a Visio-only one say, or whose applications cannot be read (`src/app/landing.ts`, `organisationLanding.ts`) |
| Login | `/login` | Realm discovery step |
| Login, organisation pre-filled | `/login?org={slug}` | From the welcome email and from the hub's "Se connecter" |
| OIDC return | `/auth/callback` | PKCE code exchange, never linkable |
| MFA enrolment | `/{org}/security/mfa` | Forced after first login when not enrolled |
| Organisation picker | `/organisations` | Shown when the token grants more than one membership |
| Deep link into an area | `/{org}/{area}` | Preserved across the whole login round-trip |
| Help | `/{org}/help` panel, opened from the shell | `?help=1` on any URL is planned with the panel ([`06-support.md`](06-support.md) §4.1) and not implemented. Until the ticket path is served, `/{org}/help` is the interim Aide page every support action lands on (§4.0) |

## 4. Screens

### 4.1 `login` — realm discovery

```text
┌──────────────────────────────────────────────────────────────┐
│                          [ Kodera ]                          │
│                                                              │
│   Se connecter à votre console                       (h1)    │
│   Indiquez votre adresse e-mail professionnelle.             │
│                                                              │
│   ┌────────────────────────────────────────────────────┐     │
│   │ Adresse e-mail                                     │     │
│   │ [ marie.dupont@acme.fr                           ] │     │
│   └────────────────────────────────────────────────────┘     │
│                                                              │
│   [ Continuer ]                                              │
│                                                              │
│   Vous n'avez pas d'adresse professionnelle ?                │
│   → Utiliser l'identifiant de votre organisation             │
│                                                              │
│   ─────────────────────────────────────────────────────      │
│   Besoin d'aide ?  ·  État du service  ·  FR | EN            │
└──────────────────────────────────────────────────────────────┘
```

Fallback variant, after "Utiliser l'identifiant de votre organisation":

```text
│   ┌────────────────────────────────────────────────────┐     │
│   │ Identifiant de votre organisation                  │     │
│   │ [ acme-sa                                        ] │     │
│   │ Il figure dans votre e-mail de bienvenue.          │     │
│   └────────────────────────────────────────────────────┘     │
```

The subtitle follows the question on screen: `console.login.realm.subtitle` over the e-mail field,
`console.login.realm.subtitle-slug` over the identifier field.

The « [ Kodera ] » above the card is the Kodera monogram (`KoderaMark`, in `c-ink`) beside the
product name from `console.common.product-name` — its own key, so a change to the tab title
(`console.common.app-title`) never renames the product here. It is decoration, hidden from
assistive technology; the card's `h1` names the page.

Components: `Card`, `TextField` (`EmailField` in the default variant), `Button` (primary,
"Continuer"), `LinkButton` (switch to slug), `InlineAlert` (discovery failure), `HelpEntry`,
`Banner` (platform-wide incident), language toggle as `ButtonGroup`.

### 4.2 `login-organisation` — one email, several organisations

```text
┌──────────────────────────────────────────────────────────────┐
│   Deux organisations utilisent cette adresse         (h1)    │
│   Choisissez celle à laquelle vous voulez vous connecter.    │
│                                                              │
│   ┌──────────────────────────────┐                           │
│   │ ▸ ACME Construction          │  acme.fr                  │
│   ├──────────────────────────────┤                           │
│   │ ▸ ACME Holding               │  holding.acme.fr          │
│   └──────────────────────────────┘                           │
│                                                              │
│   ← Utiliser une autre adresse                               │
└──────────────────────────────────────────────────────────────┘
```

Components: `Card`, list of `Button` (secondary, one per organisation, name + domain),
`LinkButton` (back).

### 4.3 `login-handoff` — redirect to the tenant realm

A short interstitial, shown only while the browser is being sent to `id.kodera.io`. It exists
so that a slow redirect is never a blank page.

```text
┌──────────────────────────────────────────────────────────────┐
│   [ ⏳ ]  Redirection vers la page de connexion d'ACME…      │
│          Si rien ne se passe, [ Continuer ]                  │
└──────────────────────────────────────────────────────────────┘
```

Components: `Spinner`, `Button` (manual continue after 3 s), live region.

### 4.4 `mfa-enrol` — second factor

```text
┌──────────────────────────────────────────────────────────────┐
│   Sécurisez votre compte                             (h1)    │
│   Une deuxième vérification est demandée à chaque             │
│   administrateur.                                            │
│                                                              │
│   ┌─── Recommandé ─────────────────────────────────────┐     │
│   │ 🔑  La clé de votre appareil                        │     │
│   │     Face ID, empreinte ou code de votre appareil.   │     │
│   │     [ Configurer la clé de cet appareil ]           │     │
│   └────────────────────────────────────────────────────┘     │
│   ┌────────────────────────────────────────────────────┐     │
│   │ 📱  Une application d'authentification              │     │
│   │     Google Authenticator, Authy, FreeOTP…           │     │
│   │     [ Utiliser une application ]                    │     │
│   └────────────────────────────────────────────────────┘     │
│                                                              │
│   Ces deux méthodes fonctionnent hors ligne. Aucun SMS.      │
└──────────────────────────────────────────────────────────────┘
```

TOTP branch:

```text
│   1. Scannez ce code dans votre application                  │
│      ┌──────────┐    ou saisissez la clé :                   │
│      │ ▚▚▚ QR ▚▚│    [ JBSW Y3DP EHPK 3PXP ]  [Copier]       │
│      └──────────┘                                            │
│   2. Saisissez les 6 chiffres affichés                       │
│      [ _ _ _ _ _ _ ]                                         │
│   3. Conservez vos codes de secours                          │
│      [ Télécharger les codes de secours ]  [ Imprimer ]      │
│                                                              │
│   [ Terminer ]                                               │
```

Components: `Card` ×2, `Button`, `QrPanel` (**new component**: QR plus a `CopyableCode` of the
same secret plus an accessible text alternative), `TextField` (six-digit code, `inputmode`
numeric, one field not six boxes), `CopyableCode`, `Button` (download recovery codes),
`InlineAlert`, `Stepper`.

The guide's demonstration (`MfaEnrolSimulation`, in the mock build only) names the product: its
QR's `otpauth://` URI carries the issuer « Kodera », and its recovery codes download as
`kodera-codes-de-secours.txt`. Both values are mock-only. In production the enrolment is
Keycloak's, so the issuer an authenticator app shows and the recovery file's name come from the
organisation's Keycloak realm, not from the console: Keycloak writes the realm's display name
(falling back to the realm name) as the `otpauth://` issuer. Until the realm template sets that
display name, a real authenticator entry does not necessarily read « Kodera ».

### 4.5 `shell` — the authenticated frame

The complete product mock is the desktop layout reference (see
[`shell-fidelity.md`](shell-fidelity.md)). The module rail carries application icons, each named by a tooltip and its accessible name;
the organisation switcher, navigation and account block sit in the token-width 264 px sunken
sidebar. Current navigation keeps the approved accent edge, without a card shadow. A 56 px
content header contains the sidebar toggle, current area title and the working Aide link.
The page retains its own single h1. The header title is plain text and follows the same role
matrix and account destinations as navigation. Nested invoices retain the Facturation title.

**The rail** (`src/app/ModuleRail.tsx`), top to bottom, as on the reference's p01 and p02:
- the Kodera mark, linking to the organisation's home;
- the tenant's applications, each opening in a new tab;
- « Messages », the workspace (`/{org}/workspace`), for an organisation whose tenant runs
  `messaging`, or for a member before the organisation has a tenant;
- at the foot: « Réglages », the administration console (`/{org}/home`), then the person's avatar.

« Réglages » is offered to every role but `org_member`: a member has no settings to change, and
still reaches the home, Applications and Aide through the mark. On the console, a member's rail
therefore has no current item; the sidebar's current item says where they are. An item is
a 48 px icon square with no visible label: icons only, zôÖma's decision
([`icon-only-controls.md`](icon-only-controls.md)). Its name is its accessible name and shows
beside it as a tooltip on hover and on focus. The
content header is `shell-header-height` tall (56 px).

The toggle hides the desktop sidebar from sight, keyboard navigation and the accessibility tree
without unmounting the page. The rail and header remain available to restore it. The skip link
remains the first focusable control and leads straight to the page content below the header.

**The six navigation items are the whole console.** Each maps to exactly one specification:

| Item | Route | Specification |
|---|---|---|
| Accueil | `/{org}/home` | [`08-home.md`](08-home.md) |
| Applications | `/{org}/status` | [`02-status.md`](02-status.md) |
| Personnes | `/{org}/people` | [`03-people.md`](03-people.md) |
| Domaine & identité | `/{org}/domain` | [`04-domain.md`](04-domain.md) — "Domaines" tab — and [`07-federation.md`](07-federation.md) — "Connexion (Google / Microsoft)" tab |
| Facturation | `/{org}/invoices` | [`05-invoices.md`](05-invoices.md) |
| Aide | `/{org}/help` | [`06-support.md`](06-support.md) |

**Federation is a tab, not a navigation item.** The delivered design puts enterprise sign-in
under "Domaine & identité", beside domains, because both answer the same buyer question — the
addresses my organisation uses and how my colleagues get in — and because a federated login
cannot be set up before the email domain is proven. `/{org}/federation` remains a valid deep
link and resolves to `/{org}/domain?tab=federation`; both specs say so.

The account block is pinned to the bottom of the sidebar: avatar initials, display name, and the
role in the customer's words. It opens the account menu (security, appearance, language, sign
out). « Apparence » opens the theme choice, [`10-appearance.md`](10-appearance.md).

**The "Prototype" card in the delivered screens is not part of the shell.** It is a scaffold in
the design prototype pointing at a pre-login order flow that no longer exists: an order starts
only for the owner of an organisation that already exists, after the staff intake and the owner
claim (`01-order.md` §3, `09-owner-claim.md`). The card names no product surface, and it is not
specified, not built and not translated.

Mobile: below 768 px the sidebar collapses into a bottom bar with the five primary items; the
organisation switcher and the account block move into the header menu.

**The narrow layout, as built.** It applies below 768 px wide (the `md` breakpoint, 48rem: a
rem in a media query follows the reader's default font size, so it moves exactly as `md:` does), and on a touch screen at most
500 px tall — a phone held sideways, 844 or 932 px wide, whose height cannot hold the sidebar
(, owner ruling). One query says so (`src/app/layoutQuery.ts`); the shell's frame choice
and every screen's `narrow:` classes read it. The mock's mobile language (`README` §3, "Mobile —
huit écrans, 390 × 780"); the phone frame and its status bar are artboard decoration and are not
drawn. Below 768 px wide the page is one column. A phone held sideways that is 768 px wide or more
(844, 932) keeps a screen's own wide grids — Accueil's three cards side by side — under the phone's
top bar and tab bar; only the shell and the touch targets change.

- *Top bar* (a `header`, sticky at the top): the maker's monogram, the organisation's name (not a
  heading), and one control, « Compte et organisation », which opens a side sheet holding the
  organisation switcher, the account block (initials, name, role) and « Se déconnecter ».
- *Tab bar* (a `nav` named « Navigation par onglets », distinct from the sidebar's « Navigation
  principale »), sticky at the foot of the screen — it stays in view while the page scrolls and
  takes its own room at the end of the page — a grid with one column per tab: « Accueil »,
  « Applications », « Facturation », « Aide », « Plus ». The sidebar's role matrix applies
  unchanged, so a member has no « Facturation » tab and the grid has four columns.
- *« Plus »* opens a bottom sheet listing the other places: « Personnes » and « Domaine &
  identité » (managers only, as in the sidebar), « Sécurité et connexion » and « Apparence »
  (, owner ruling). « Plus » is drawn
  as current while one of those places is open.
- « Sécurité et connexion » opens the `/{org}/security` placeholder from both layouts
  until its screen exists (, owner ruling). People has its own implemented area.
  It never sends an enrolled person to the second-factor enrolment guide.
- The account menu's entries are one list for both layouts (`src/app/accountItems.ts`): the wide
  menu draws them all; the narrow layout puts a place in « Plus », an action in the top menu, and
  leaves out « Langue », which has no screen yet.
- Each item lives in one place: places in the tab bar or « Plus », the session (organisation,
  account, sign-out) in the top menu. Neither the module rail nor the sidebar is rendered.
- On the workspace, the tab bar is the rail's, not the console's: « Accueil », « Messages » and
  the tenant's other applications, in a `nav` named « Modules »
  ([`11-workspace.md`](11-workspace.md) §4.2).
- The current tab is shown by weight (600) and a 2 px `c-accent-ink` edge as well as by its
  `c-accent-ink` ink; `aria-current="page"` carries it for assistive technology.
- Every control is at least 44 × 44 px; the page gutter is 16 px; the bars, the sheets and the
  toasts clear the device's safe-area insets, and toasts sit above the tab bar. Nothing scrolls the
  page sideways: a table scrolls inside its own box. A control reached with `Tab` is never
  entirely hidden by a bar (WCAG 2.4.11), and on a phone held upright it is scrolled wholly clear
  of both where it fits. Two exceptions to "wholly": a text area scrolls to its caret rather than
  to its own edge, so part of it can stay under a bar; and in landscape a control taller than the
  space between the bars (the agreements table, a plan card) cannot fit whole.

Components: `Sidebar shell` (264 px token, sunken ground, right hairline, sticky,
surface active item with an accent edge), integrated organisation switcher, `Button`
and `LinkButton` in the navigation, `Banner` (status slot), `Status pill` (capacity, when it
is shown).

Console primitives that carry them: `OrgSwitcher`, `HelpEntry` (`Alt+/` and the help item),
`Avatar` plus a dropdown (profile, security, language, sign out), navigation list, `Banner`,
`Gauge` (compact capacity readout when the sidebar footer shows one), `Breadcrumb` on sub-pages,
`Tooltip` (a navigation item disabled while the instance is provisioning), `Skeleton` for the
first paint.

**Browser chrome.** The tab, the installed app and the favicon name the product, Kodera, on
every screen and before the first paint: `index.html`'s `<title>` and `console.common.app-title`
(which `main.tsx` sets as `document.title` once the catalogue boots) are both « Kodera » — one
static title, no per-screen titles; `site.webmanifest`'s `name` and `short_name` are « Kodera »;
`favicon.svg` is the Kodera monogram on the slate tile, with the accessible name « Kodera ». The
PNG and `.ico` icons are rasters of the same tile (`public/README.md`).
`tests/unit/brand/legacy-brand.test.ts` enforces this. It keeps the previous product name off
`index.html`, `public/`, the copy catalogues and the source files of the login wordmark and the
authenticator entry (§4.1, §4.4). The legal entity's name stays only where it names the invoice
issuer.

**Status banner slot.** One slot, directly under the header, above the page title. At most one
banner at a time, chosen by this precedence: offline → session about to expire → platform
incident affecting this tenant → dunning (invoice overdue) → capacity ≥ 90 % → maintenance
announced. Everything else is an in-page `InlineAlert`, not a banner.

What each banner may say is bounded by what `status-summary` carries (§6), because the shell makes
no second call:

- **Incident.** The component and the time it started, and "En savoir plus" to Applications
  (except on Applications itself). No next-update time: `status-summary` carries none until
  contract 0.12.0 (below), and `measured_at` is when the status was read, not when it will next be
  updated. Applications shows the incident's own `next_update_at`.
- **Dunning.** For the roles that can open Invoices: "Une facture est en retard de paiement" with
  `amount_due`, and "Voir la facture" to `oldest_overdue_invoice_id`. No invoice number and no
  day count: `status-summary` carries neither, and the invoice id is a link target, never text.
  Every other role reads a neutral information line, "Un paiement est en attente. Pour toute
  question, contactez le propriétaire de votre organisation.", with no amount and no link
  (`console.shell.banner.status-dunning-member`). The shell cannot yet tell a dispute hold apart:
  `hold_until` joins `status-summary.billing` in contract 0.12.0.
- **One incident, one banner.** While Applications shows its own incident banner (`02-status.md`
  §4.3) for a component, the slot does not announce that component's incident again; it shows the
  next banner in the precedence (dunning, capacity, maintenance), or none. If the page and the
  shell's summary name different components, the slot keeps its incident banner.

### 4.6 `organisation-switcher`

```text
┌──────────────────────────────┐
│ [ Rechercher…              ] │
├──────────────────────────────┤
│ ✓ ACME Construction          │
│   acme.fr · Business         │
├──────────────────────────────┤
│   ACME Holding               │
│   holding.acme.fr · Team     │
├──────────────────────────────┤
│   Se déconnecter             │
└──────────────────────────────┘
```

Components: `Combobox` (filter appears above five entries), option rows with name, domain, tier,
check mark on the current one.

Switching organisation re-authenticates against the other realm when the current token does not
cover it; the console keeps the destination area (`/other-org/status` if the user was on
`/acme-sa/status`, else `/other-org/home`, which is the default screen of every organisation).

The desktop switcher is integrated into the sunken sidebar; narrow surfaces retain their card.
It shows the organisation name and the contract-backed slug. With a single organisation it is
static text; multiple memberships retain the existing accessible combobox and realm navigation.
No unavailable pack or branding field is invented.

### 4.7 `session-expiry`

```text
┌───────────────────────────────────────────────────────────────┐
│  Votre session va expirer                              (h2)   │
│  Par sécurité, votre session se fermera dans 2 minutes.       │
│  [ Garder la session ouverte ]        [ Se déconnecter ]      │
└───────────────────────────────────────────────────────────────┘
```

Components: a labelled nonmodal warning panel at T−2 min, the existing modal `Dialog` at T−0, `Button` ×2, live region
announcing the countdown at 120 s and 30 s only.

Rules: a silent refresh runs on every focus and every 60 s while the tab is visible. The dialog
appears only within the final 120 seconds of the access token lifetime, including after a failed refresh. A failed refresh with more than 120 seconds remaining never opens the warning. On expiry, the approved unsent People invitation consumer saves only its allowlisted fields in
tab-scoped `sessionStorage`, survives the full login round trip and restores only after fresh
same-owner authentication and Core verification. The storage/operation boundaries are defined in
`03-people.md` §4.2. Existing Order recovery keeps its approved24-hour policy; other forms, including
OTP input, receive no recovery promise. This invitation recovery stores nothing in `localStorage`.

The warning and expired dialog each have a name matching their state.

| | Countdown (T−2 min to T−0) | Expired (T−0) |
|---|---|---|
| Title, which is the dialog's accessible name | `console.shell.session.title-expiring` | `console.shell.session.title-expired` |
| Body | `console.shell.session.subtitle-expiring` | `console.shell.session.error-expired` |
| Actions | « Garder la session ouverte », « Se déconnecter » | « Se reconnecter », alone (§9) |
| Close control, `Escape`, a press outside | Explicit Close or Escape immediately dismisses the warning and attempts renewal in the background. A failed renewal cannot reopen the dismissed warning for the same credential; actual expiry still requires reconnecting. Background pointer interaction continues editing without renewal | None: no close control is drawn, and `Escape` and a press outside do nothing. There is no session left for a dismissal to keep open |
| Focus | Appearance preserves background focus and allows typing, pointer interaction and Tab. Removing a focused warning action may return to its connected prior editor; independently moved background focus stays | On « Se reconnecter », whether the dialog opens expired or expires while open |

The expired body is « Reconnectez-vous pour continuer. ». It gives the next action under a title
that has already said what happened, and it promises nothing about what the person had typed:
acceptance test6 exercises the bounded unsent People invitation consumer without adding a
restoration promise for other forms.

The approved warning is nonmodal and uses the existing panel/control tokens in document flow
before the MFA guide or in the Shell banner area, without an overlay or a focus trap. The expired Dialog remains blocking.
The120/30-second announcements retain exact equality; skipped-threshold catch-up is not built.
Actual mock-auth warning acceptance is `shell/session: warning preserves MFA editing before blocking expiry (wide)`,
its `(narrow)` counterpart, and `shell/session: warning leaves normal Shell navigation usable` with its `(narrow)` counterpart.
These checks do not promise OTP restoration or universal programmatic mutation protection.

### 4.8 `staff-shell` (retired from customer console)

Staff sign-in (`/staff/login`) and staff administration screens live exclusively in the standalone
Kodera Administration Dashboard (the staff administration surface, `Core ADR-0023`) on dedicated staff origins
(`admin.kodera.io` and WireGuard-only `ops-admin.kodera.io`), never inside `kodera-web`.

## 5. State matrix

| Screen | Default | Loading | Empty | Error | Success | Partial failure | Permission denied | Offline |
|---|---|---|---|---|---|---|---|---|
| `login` | Email field focused | Button spinner while discovery runs | n/a — the form is the empty state | Domain unknown → the identifier field, under its own subtitle, with an inline alert above it naming the domain and the support address; the address typed is kept for the way back. Identifier unknown → inline alert under the field, the identifier kept. Rate limited → inline alert counting down, submit disabled until the wait is over, what was typed kept; with no wait to count, the alert alone and submit usable (§9) | Redirect to the realm | n/a | n/a | Banner "Pas de connexion", submit disabled |
| `login-organisation` | 2–5 organisation rows | `Skeleton` rows | Not reachable (only shown when ≥ 2) | Discovery lost → back to `login` with the email kept | Redirect to the chosen realm | n/a | n/a | Banner, rows non-interactive |
| `login-handoff` | Spinner + message | The whole screen is a loading state | n/a | Redirect blocked → manual `Continuer` + "Autorisez les redirections" | Browser leaves the console | n/a | n/a | "Reconnexion dès que le réseau revient" |
| `mfa-enrol` | Two method cards | `Skeleton` cards while capabilities load | n/a | Passkey refused by the device → alert naming the reason + TOTP offered; wrong TOTP code → field error, 5 attempts then 60 s lock | Recovery codes screen, then the destination | Passkey enrolled but recovery codes not downloaded → banner until downloaded | Not reachable (self-service) | Banner; enrolment cannot start |
| `shell` | Nav + content | `Skeleton` nav + content | n/a | `GET /me` fails → full-page error with retry and the support address; `unauthenticated` → full-page "Votre session n'est pas reconnue" with the single action "Se reconnecter", the destination kept, or `/login` when the URL names no organisation; refused again right after that sign-in → "Nous n'avons pas pu rétablir votre session" with "Se déconnecter" and the support address, never a second round; `identity-unknown` (a `403` for a token that verifies but names no identity Core knows) → "Pas encore d'organisation" with "Se déconnecter" and the support address, never "Se reconnecter", since signing in again brings back the same answer. `/` and `/login` get the same full-page screen; a route below the organisation shows it inside the shell. The heading takes focus and the message is announced (`role="alert"`). Never the router's own error text | n/a | Nav renders, one widget (capacity) fails → widget shows its own inline error, nav unaffected | Areas the role cannot see are absent from nav; direct URL shows a banner naming the role needed | Persistent banner; cached content readable; mutations disabled |
| `organisation-switcher` | Rows with current marked | `Skeleton` rows | One organisation → the switcher renders as static text, not a menu | Fetch fails → "Impossible de charger vos organisations" + retry | New organisation loaded, area preserved | Token covers A but not B → B triggers a re-login instead of failing | n/a | Menu opens read-only, switching disabled |
| `session-expiry` | Hidden | n/a | n/a | Refresh fails → modal, sign in again | Session extended silently, no dialog | Refresh succeeds for reads but the pending mutation was rejected → the mutation's own screen shows the retry | n/a | Countdown pauses; on reconnection a refresh is attempted before the dialog |

**Navigation states.** An item the role cannot use is absent, not disabled. An item the
instance cannot yet serve — Applications, Domaine & identité and Facturation while the tenant is
`ordered`, `provisioning` or `ready` — is rendered disabled with a `Tooltip` saying when it
opens; Accueil, Personnes and Aide stay live throughout, because inviting colleagues and asking
a question are both useful before go-live (`08-home.md` §4.1). An item a locked entitlement
covers is rendered disabled with the pack that unlocks it, never removed.

## 6. Core API calls

Paths, parameter names, field names and enum values are those of
`kodera-server/contracts/core-api.openapi.yaml`; the mapping from an earlier draft of this section
is in [`contracts/CONSOLE_RECONCILIATION.md`](https://github.com/kodera-hq/kodera/blob/main/contracts/CONSOLE_RECONCILIATION.md).

| Method | Path | Fields sent | Fields read |
|---|---|---|---|
| `POST` | `/api/v1/auth/discover` | `Idempotency-Key`; exactly one of `slug` or `email` | `realm`, `issuer`, `openid_configuration_url`, `organisation{ id, slug, name, realm }`, `candidates[]{ realm, issuer, openid_configuration_url, organisation }` |
| `GET` | `/api/v1/me` | — | `id, email, display_name, locale, staff, staff_roles[]`, `identities[]{ id, issuer, realm, subject, email, email_verified, mfa_enrolled, federated_with, last_login_at }`, `organisations[]{ organisation{ id, slug, name, realm }, membership_id, role, state, identity_id, joined_at }` |
| `PATCH` | `/api/v1/me` | `locale`, `display_name` | Same as `GET /me` |
| `GET` | `/api/v1/organisations/{organisation_id}` | — | `id, slug, name, legal_name, state, realm, country, vat_regime, billing_email, locale` |
| `GET` | `/api/v1/organisations/{organisation_id}/entitlements` | `cursor`, `limit` | `data[]{ code, enabled, required_pack_code, required_capacity_tier_code, limit, used }` |
| `GET` | `/api/v1/organisations/{organisation_id}/status-summary` | — | `overall`, `components[]{ key, name, state, since, message_key, incident_ref }`, `capacity{ seats, participants, storage, threshold_pct, upgrade_prompt }`, `billing{ dunning_state, oldest_overdue_invoice_id, amount_due }`, `maintenance{ scheduled_at, duration_s, message_key }`, `open_incident_ids[]` |
| `GET` | `/api/v1/support/help-context` | `area`, `screen`, `locale` | `articles[]{ id, title, url }`, `sla{ support_tier, first_response_target_minutes, business_hours_label, next_response_due_at }`, `incident` |

Notes.

- **Organisations are addressed by `organisation_id`, never by slug.** The browser URL keeps the
  slug because it reads well and is shareable; the console resolves it to an id once, from `/me`,
  which returns the id and the slug of every organisation the person belongs to. The one place a
  slug reaches the API is `POST /auth/discover`, where the caller has nothing else.
- Token acquisition, refresh, MFA enrolment and the login form itself happen at
  `id.kodera.io` through OIDC with PKCE. The console holds only short-lived tokens and calls
  no Keycloak admin endpoint (ADR-0003). `mfa-enrol` is a console-hosted **guide** around the
  realm's required action; the enrolment itself is Keycloak's.
- `POST /auth/discover` is unauthenticated and rate limited, and it carries an `Idempotency-Key`
  like every other `POST`. It never reveals whether an email address exists, and an unknown slug
  and an unknown domain give the **same** `200` with `realm: null` and an empty `candidates[]` —
  not a `404`. The console shows a neutral message either way.
- `PATCH /me` carries `If-Match`, not `Idempotency-Key`: a `PATCH` that carries an idempotency key
  is refused.
- `status-summary` is one call for the whole shell, so navigation does not fan out into four
  requests. `capacity` percentages are server-computed; the console does not divide.
- `overall` and every `components[].state` come from one closed set:
  `operational`, `degraded`, `partial_outage`, `major_outage`, `maintenance`.
- Every request carries `X-Request-Id`; the value of the last failed request is what the support
  form pre-fills, through `GET /api/v1/support/ticket-context?request_id=…`.

## 7. MSW scenario overlays

| Overlay | Deviation |
|---|---|
| `shell.single-organisation` | `/me` returns one entry in `organisations[]`; the switcher is static text |
| `shell.multi-organisation` | `/me` returns three entries in `organisations[]` across two packs |
| `shell.member-role` | `/me` returns `role: member`; Personnes, Domaine & identité and Facturation are hidden, Accueil, Applications and Aide remain |
| `shell.mfa-not-enrolled` | `/me` returns `identities[0].mfa_enrolled: false` |
| `shell.session-expired` | Every call returns `401` with `type` `.../unauthenticated` |
| `shell.offline` | Network-layer failure on every request |
| `shell.status-degraded` | `status-summary` returns `overall: degraded` with `calls` degraded and an entry in `open_incident_ids[]` |
| `shell.capacity-92` | `status-summary` returns `capacity.participants.pct: 92` and `upgrade_prompt: true` |
| `shell.entitlement-locked` | `entitlements` returns `federation` and `custom_domain` with `enabled: false` and `required_pack_code: visio-docs-pro` |
| `login.single-organisation` | `auth/discover` returns `realm: acme-sa` with its organisation and `candidates: []`. The base example did this until contract 0.12.0; since then the generated base answer is the neutral zero result |
| `login.unknown-domain` | `auth/discover` returns `200` with `realm: null` and `candidates: []` |
| `login.two-organisations` | `auth/discover` returns `realm: null` and two entries in `candidates[]` |
| `login.discovery-rate-limited` | `auth/discover` returns `429` with `retry_after_s` |
| `staff.session` | `/me` returns `staff: true` with `staff_roles: ["staff_support"]` and no `organisations[]` |

## 8. Validation rules

| Field | Rule | When | Copy key |
|---|---|---|---|
| Email | Non-empty | On submit | `console.login.realm.error-email-required` |
| Email | Contains `@` and a dot-bearing domain; no format lecture beyond that | On submit | `console.login.realm.error-email-format` |
| Email | An address discovery accepts: the contract's ASCII rule on `RealmDiscoveryRequest.email` (`src/api/discoveryEmail.ts`) — no space or accented letter, no two dots in a row, at most 64 characters before the `@` and 254 in all, domain labels of letters, digits and inner hyphens. Checked only once the row above passes, so a person sees one of the two | On submit | `console.login.realm.error-email-invalid` |
| Email | Domain maps to an organisation | Server, on submit | `console.login.realm.error-domain-unknown` |
| Organisation identifier | 5–20 characters, `a–z`, `0–9`, internal `-`, alphanumeric ends | On blur | `console.login.realm.error-slug-format` |
| Organisation identifier | Known slug | Server, on submit | `console.login.realm.error-slug-unknown` |
| TOTP code | Exactly 6 digits, spaces stripped | On submit | `console.login.mfa.error-code-format` |
| TOTP code | Accepted by the realm | Server | `console.login.mfa.error-code-invalid` |
| TOTP attempts | 5 failures → 60 s lock, counter shown | Client + server | `console.login.mfa.error-locked` |

Discovery is deliberately forgiving: leading and trailing spaces are stripped, the input is
lower-cased, and a pasted `https://acme-sa.kodera.io` is reduced to `acme-sa` rather than rejected.

## 9. Error copy rules

Cause, then next action, in that order, never more than two sentences, never an error code in
the sentence. The `X-Request-Id` is shown in small monospace under the message only when the
failure is a server error, and it is what the support form carries.

The `type` values below are the registry in `components.schemas.ProblemType`, which is closed: the
console switches on `type` and never on `title` or `detail`, which are English staff prose.

| Problem `type` suffix | Copy key | Shown as |
|---|---|---|
| *no problem document*: `auth/discover` answers `200` with an empty `candidates[]`, for an e-mail address | `console.login.realm.error-domain-unknown` | `InlineAlert` above the identifier field it leads to — it is about the address, not about the identifier — until the identifier is submitted; « Utiliser une adresse e-mail » goes back with the address kept |
| the same answer, for an organisation identifier | `console.login.realm.error-slug-unknown` | `InlineAlert` under the identifier field, which keeps what was typed |
| `rate-limited`, on sign-in, with a wait | `console.login.realm.error-rate-limited` | `InlineAlert` counts down one LoginScreen-owned in-memory deadline shared by email and identifier; switching never clears/restarts it and later refused responses cannot shorten it. Both request paths refuse until the exact deadline. Below60 seconds use seconds, below3600 ceiling minutes, otherwise ceiling hours; presentation does not change the deadline. Initial refusal speaks once, ticks are silent, and one polite completion says `console.login.realm.a11y-retry-ready` without moving focus. Reload creates fresh UI; no unauthenticated field/deadline is persisted, and a new server refusal is handled. An answer that gives no `retry_after_s`, or gives `Infinity` or `NaN`, or a wait longer than the countdown can hold (over `Number.MAX_SAFE_INTEGER` milliseconds, about 285,000 years — `1e306`, say), counts down from 60 s; any other wait, however long, is held to its end (a `retry_after_s` of `-Infinity` is less than zero, next row); a part of a second is rounded up, in the sentence and in the wait |
| `rate-limited`, on sign-in, with `retry_after_s` of 0 or less | `console.login.realm.error-rate-limited-no-wait` | `InlineAlert`, announced as it appears; no countdown, and submit stays usable: there is nothing to wait for, and the person is still told they were refused |
| `service-unavailable`, on sign-in (`auth/discover` answers `503`) | `console.login.realm.error-unavailable` | `InlineAlert` counting down its own wait of five seconds — the contract's backoff, and its minimum: a longer `retry_after_s` is honoured up to 60 s, which caps it whatever arrives (`Infinity`, `1e306` and a year included); a shorter, missing or `NaN` one waits the five seconds — on the same shared deadline as `rate-limited`, which a `503` never shortens; « Continuer » is unusable until it ends, and the completion is the same polite `console.login.realm.a11y-retry-ready` |
| `rate-limited`, elsewhere | `console.common.error-rate-limited` | `InlineAlert`, retry countdown from `retry_after_s` |
| `unauthenticated` | `console.shell.session.error-expired` | `Dialog`, single action "Se reconnecter"; when the page itself could not load, `console.shell.session.title-unrecognized` and `console.shell.session.body-unrecognized` as a full-page screen with the same single action; a generic 401 alone does not establish expiry |
| `identity-unknown` | `console.shell.session.title-no-organisation`, `console.shell.session.body-no-organisation` | The route error screen when `GET /me` or an organisation route is refused: the person is signed in, belongs to no organisation yet, and an owner of their organisation must add them; actions "Se déconnecter" and the support address. Never the re-authentication round, never the generic error |
| `mfa-required` | `console.login.mfa.error-required` | `Dialog` opening the enrolment guide |
| `forbidden` | `console.shell.access.error-role` | `Banner` naming the role that can do it and the owner to ask |
| `forbidden` on a capability `entitlements` reports as disabled | `console.shell.access.error-tier` | Disabled control + `Tooltip` naming `required_pack_code` + link to Invoices |
| `service-unavailable` | `console.common.error-unavailable` | Full-page error with retry and "Voir l'état du service" |
| `internal-error` | `console.common.error-unavailable` | Same, with the `request_id` shown |
| network failure | `console.common.error-offline` | Shell `Banner` |

**A sentence that tells the customer to write gives the address.** « écrivez-nous » is followed
by « à {email} », and the placeholder is filled with the console's one support address
(`src/app/supportContact.ts`) by the message runtime, wherever the sentence is rendered
(`docs/dev/I18N.md`). `src/app/supportSentences.test.ts` refuses a sentence that says
« écrivez-nous » with no address, and lists the ones still left so with the reason for each.

The console never reaches the `forbidden` case for a locked capability in the normal flow: it reads
`entitlements` first and renders the control disabled. The row exists because a direct URL, a stale
tab or a plan change between two requests all produce it, and none of them may show a raw `403`.

The current-identity read MUST NOT automatically retry a 401 or 403 with the same credential.
Transient failures retain the configured bounded retry policy. Explicit retry or a new credential
still requires a fresh authority read; a 403 never becomes an expiry prompt or automatic login.
The actual expiry dialog keeps its existing expiry-specific copy and authority rules.

## 10. Accessibility

- **Focus order, `login`:** skip link → language toggle → email field → "Continuer" → slug
  fallback link → help link → status link. The email field takes focus on mount.
- **Focus order, `shell`:** skip link ("Aller au contenu") → organisation switcher → help →
  account menu → status banner (when present, and only when it carries an action) → navigation →
  page `h1` → content.
- **Focus order, `shell` in the narrow layout:** skip link → « Compte et organisation » → tab bar (in
  its visual order, « Plus » last) → status banner (as above) → page `h1` → content. Both sheets
  trap focus while open; `Escape` closes them and returns focus to the control that opened them.
- Route change moves focus to the page `h1` and announces the page title in a polite live
  region. The `h1` that takes focus is one a person can see. A screen may carry a visually hidden
  `h1` as well — every order screen names the flow in one, above the step's own title — and that
  one never takes focus.
  - *As built* (`src/app/RouteFocus.tsx`, mounted once by the organisation layout, in the shell
    and around the enrolment guide alike). A route change is a change of the path the router has
    finished loading. Arriving — a sign-in, a reload, a bookmark — is not one, nor is a redirect
    on the way to a page, nor a change of search parameters or of hash. The second-factor guard's
    redirect (§12, test 4) is such a redirect: it sends a person to the enrolment guide before any
    page is drawn, so they arrive on the guide. The guide is not announced, and the route change
    moves no focus there; the guide puts focus on its own heading when it opens, as it did before.
    A later navigation from the guide is a route change.
  - The announcement is `console.common.a11y-page-loaded` with the title the content header shows
    for the area (§4.5), so a nested page is announced under its area's name. It needs no data: it
    is made as soon as the route has changed, and a state that draws no `h1` is still announced.
    The order flow is announced under its own name, `console.order._.title`: it is no navigation
    item, so the header has only its fallback « Console » there. Federation has no title of its
    own either, and is still announced as « Console ».
  - A step of the order wizard is not announced here. The wizard says « Étape 2 sur 4 :
    Organisation. » in its own polite region, and that is the only announcement of a step
    ([`01-order.md`](01-order.md) §10); this region is left untouched, because anything written
    to it would be a second one. Focus moves as for any route change. Entering the order, leaving
    it, and the way to and from the quote request are ordinary route changes.
  - Focus moves to the first `h1` of `main` that is not visually hidden, once the screen draws it,
    which is often after the screen's first read — unless the person has pressed a key, pressed a
    pointer or scrolled since the route changed: focus is never taken back from someone who has
    moved on. The wait for the heading ends after five seconds in any case: a person can move on
    without a key, a pointer or a wheel, and a heading that arrives later than that takes no
    focus. A state whose only `h1` is visually hidden — the order, for a person who may not
    order — is announced and moves no focus. A navigation started from the account menu or from a
    sheet ends on the heading too, not on the control the closing menu hands focus back to.
  - The heading takes `tabindex="-1"`: a script can focus it and `Tab` never stops on it, so the
    focus orders above are unchanged. It draws no focus ring: it is where reading resumes, not a
    control.
- **Keyboard map:** `Tab` / `Shift+Tab` everywhere; `Enter` submits discovery; `Escape` closes
  the switcher, the help panel, and any dropdown, returning focus to its trigger; `↑`/`↓` move
  through switcher options; `Home`/`End` jump to the first and last option; typing filters when
  the `Combobox` is present. `Alt+/` opens help from anywhere; the shortcut is listed in the help
  panel.
- **Live regions:** one polite region in the shell for route announcements, beside the toast
  stack's own; one assertive region for session expiry and offline transitions. Never two
  assertive regions competing.
- The status banner is a `role="status"` region when informational, `role="alert"` only when it
  reports a live outage.
- The countdown in `session-expiry` is announced twice (120 s, 30 s), never every second.
- Heading outline: one `h1` per screen, sections as `h2`, cards as `h3`. The organisation name is
  never the `h1`. A title inside a whole-card radio control is a label, not a section heading.
- Contrast: every token pair meets WCAG AA; the focus ring meets 3:1 against both adjacent
  surfaces. The status pill colours are backed by a text label.
- **Theme:** the console follows the device's light or dark setting until the person chooses
  light, dark or black on the Apparence page ([`10-appearance.md`](10-appearance.md)); the choice
  is kept in this browser and applied before the first paint. Every launch view passes axe,
  contrast included, in the dark and black themes (`tests/visual/screens.spec.ts`), without rule
  exclusions. The Order plan also runs the unrestricted check in light.
- Reduced motion: the handoff spinner becomes a static message; banner entry has no slide.

## 11. Analytics events

No personal data: no email address, no display name, no organisation name, no IP, no slug that
identifies a customer. The organisation is carried as a salted, rotating pseudonymous id.

| Event | Properties |
|---|---|
| `login_discovery_submitted` | `kind` (`email` \| `slug`) |
| `login_discovery_failed` | `kind`, `reason` (`domain-unknown` \| `slug-unknown` \| `rate-limited`) |
| `login_organisation_chosen` | `count` (how many were offered) |
| `mfa_enrolment_started` | `method` (`passkey` \| `totp`) |
| `mfa_enrolment_completed` | `method`, `attempts` |
| `mfa_enrolment_abandoned` | `method`, `step` |
| `organisation_switched` | `membership_count` |
| `session_expiry_dialog_shown` | `outcome` (`extended` \| `signed-out` \| `ignored`) |
| `status_banner_shown` | `kind` (`offline` \| `incident` \| `dunning` \| `capacity` \| `maintenance`) |
| `help_opened` | `area`, `screen` |

## 12. Acceptance tests

1. **Given** a user whose email domain maps to exactly one organisation (`login.single-organisation`),
   **when** they submit their email on `/login`,
   **then** the browser is sent to that organisation's realm and the destination area is kept
   across the round-trip.
   `login/realm: sends a known email domain straight to its organisation`

2. **Given** a user whose email domain is not registered (`login.unknown-domain`),
   **when** they submit,
   **then** a message names the cause, the organisation-identifier fallback and the address to
   write to; the fallback field appears under a subtitle about the identifier, with the message
   above it; and the email is preserved for the way back.
   `login/realm: explains an unknown domain and offers the organisation identifier`

3. **Given** an email that maps to two organisations (`login.two-organisations`),
   **when** the user submits,
   **then** both organisations are listed with their domain, and choosing the second one sends
   the browser to that organisation's realm.
   `login/organisation: lets one address choose between two organisations`

4. **Given** an authenticated admin who has not enrolled a second factor
   (`shell.mfa-not-enrolled`),
   **when** they open any console URL,
   **then** they land on MFA enrolment with the device key offered first, and they cannot
   navigate away until a factor is enrolled.
   `login/mfa: forces enrolment before any other screen`

5. **Given** MFA enrolment by authentication app,
   **when** the user completes it entirely with the keyboard,
   **then** the secret can be copied, the six-digit field is reachable and labelled, the recovery
   codes can be downloaded, and focus stays in the guide until completion. Completing the guide
   focuses the visible Home heading, announces Accueil once in the shell’s polite region and lets
   Tab continue into the page.
   `login/mfa: completes application enrolment with the keyboard alone`

6. **Given** an unsent People invitation with raw multiline input and a permitted nondefault role,
   **when** its actual mock SDK credential expires and full sign-in returns while fresh `/me` is held,
   **then** no private field appears before ownership is verified; the same-owner drawer restores
   exact fields, consumes its snapshot, sends nothing automatically, and only deliberate sending
   creates the normal contract-backed request and idempotency key.
   `shell/session: signs back in without losing what was typed`

7. **Given** a member-role token (`shell.member-role`),
   **when** they open `/{org}/people` directly,
   **then** the navigation does not show People and the page states which role is required and
   whom to ask, with no raw error.
   `shell/access: tells a member which role is needed instead of showing an error`

8. **Given** the media component is degraded (`shell.status-degraded`),
   **when** the console loads,
   **then** exactly one banner appears, it names calls as affected in plain French with the time
   the disruption started, and it is announced once. It claims no next-update time today, because
   `status-summary` carries none. Future requirement: contract 0.12.0 adds `next_update_at` per
   incident, and from that version the banner also states the next update time.
   `shell/status: shows one plain-French banner for a calls outage`

9. **Given** the browser goes offline (`shell.offline`) while the status page is open,
   **when** the connection drops,
   **then** already-loaded content stays readable, every submit is disabled with the reason, and
   the view refreshes by itself when the connection returns.
   `shell/offline: keeps content readable and disables submissions`

10. **Given** a 390 × 780 screen,
    **when** a person moves through the console with the keyboard alone (`Tab`, `Shift+Tab`,
    `Enter`),
    **then** the tab bar and the « Plus » sheet reach every area their role allows, the sheet
    traps focus, `Escape` returns it to « Plus », and no focused control is entirely hidden by a
    bar (at 390 × 780, none is hidden at all).
    `shell/narrow: reaches every area from the tab bar and the Plus sheet with the keyboard`

11. **Given** a 390 × 780 touch screen,
    **when** a person taps through the tab bar, the « Plus » sheet and the top menu,
    **then** each tap lands on the area it names, and the top menu holds the organisation, the
    account and « Se déconnecter ».
    `shell/narrow: reaches every area by tap and keeps the session in the top menu`

12. **Given** a phone at 320 × 640, 390 × 780, or held sideways at 844 × 390 or 932 × 430,
    **when** any journey screen is open (login, MFA, home, applications, invoices, invoice detail,
    subscription, Aide, and the order steps),
    **then** the page does not scroll sideways, no content is cut off at the screen's edge or inside
    a clipped box, and every control is at least 44 px tall.
    `shell/narrow: no journey screen scrolls sideways at 390 px`

13. **Given** a signed-in person who has just arrived on a page of the console,
    **when** they follow a navigation link with the keyboard,
    **then** the page they arrived on was neither announced nor focused, the new page is announced
    once in a polite region, keyboard focus is on its `h1` with no ring drawn, and `Tab` leaves the
    heading without ever coming back to it.
    `shell/navigation: announces the new page and moves focus to its heading`

14. **Given** a signed-in person whose session can no longer be refreshed,
    **when** the session expires,
    **then** the dialog is named « Votre session a expiré », its body reads « Reconnectez-vous
    pour continuer. », « Se reconnecter » is its only control and has focus, `Escape` and a press
    outside leave it open, and « Se reconnecter » starts the sign-in round trip.
    `shell/session: leaves signing in again as the only way out of an expired session`

15. **Given** too many discovery attempts (`login.discovery-rate-limited`),
    **when** a person submits their address,
    **then** the message counts the wait down from `retry_after_s`, the address stays in its field,
    « Continuer » cannot be used until the shared deadline ends even after email/identifier switches,
    completion is polite without moving focus, a new refusal is handled and reload has fresh UI.
    `login/realm: counts a rate limit down and holds the button until it ends`

The theme's own tests — set before the first paint, following the device, chosen by keyboard,
refused storage — are [`10-appearance.md`](10-appearance.md) §12; test 11 above counts
« Apparence » among the places « Plus » reaches.


16. **Given** a person with memberships in two organisations, on Aide in the first realm,
    **when** the actual organisation switcher selects the second and its sign-in completes,
    **then** the destination organisation is correct and Aide is preserved. The new document is
    an arrival: no route-change announcement or injected heading tabindex is added.
    `shell/organisation: preserves the area through another realm sign-in`

Navigation lifecycle unit acceptance additionally proves that unmounting or replacing a route
cancels its pending heading observer, timer and user-intent listeners; an obsolete wait cannot
focus an unrelated page. Existing late-heading and moved-on controls remain unchanged. These
transition checks remain separate from the actual People restoration acceptance6. Required-all
gate admission still needs complete runnable acceptance for every shell scenario and test-deletion
refusal proof; this source specification does not weaken that gate.


## 13. Out of scope for launch

- Self-serve payment method and card-on-file management (planned after launch).
- SMS as a login or recovery factor — excluded by decision, not deferred.
- Directory sync of users from the customer's IdP, planned after launch.
- Custom login theming beyond logo and colours (Enterprise, planned after launch).
- An in-console audit-log viewer; audit export is a support request at launch.
- One-click export and delete of the organisation's data (planned after launch; a runbook covers it at launch).
- Unattended provisioning triggered by payment (planned after launch).

## Changelog

- The workspace's phone tab bar (§4.5, [`11-workspace.md`](11-workspace.md) §4.2, gap report G11):
  on the workspace the narrow layout draws the rail's places, « Modules », in place of the console's
  tab bar, and the top bar keeps the maker's mark.

- Rail (§4.5): the workspace's item is « Messages », as on the reference. The console's item is
  « Réglages », moved to the foot of the rail and not offered to `org_member`. Items are 68 px wide
  and sized by their content; the content header keeps 56 px through its own token (design tokens
  v0.6.0).

- Member arrival (§3): a member of an organisation with no tenant yet lands on the workspace,
  which says how far setup has come, rather than on a Home that offers an order they cannot place.
  A failed applications read still keeps Home.

- Staff plane cutover (§3, §4.8, §5): removed `/staff/login` and `staff-shell` from
  `kodera-web`; staff authentication and administration live exclusively in the
  standalone the staff administration surface application on dedicated origins (`Core ADR-0023`).
- Discovery hardening (§8, §9), no wording changed: the e-mail step checks the address it sends —
  trimmed and lower-cased — rather than the one typed, so the two can no longer disagree (a
  character outside ASCII can lower-case to an ASCII one). A `503`'s wait is capped at 60 s,
  whatever `retry_after_s` says, `Infinity` and `1e306` included; a `NaN` waits as if none were
  given (five seconds). On a `429`, `Infinity`, `NaN` and a wait longer than the countdown can
  hold (`1e306`) wait as if none were given, 60 s, where they used to show « Infinity heures »;
  `-Infinity` is less than zero and leaves the button usable. Any other `429` wait is honoured in
  full, with its minutes and hours sentences: a hostile but countable one, a year say, holds the
  button until it elapses, by design.
- Discovery refusals (§8, §9): a `503` from `auth/discover` now has its own five-second wait
  (`console.login.realm.error-unavailable`, counted down, the button held), instead of the generic
  « Réessayez dans quelques minutes ». And the e-mail step checks the contract's ASCII address rule
  before sending, so an address the contract refuses — an accented letter, a space, two dots in a
  row — gets `console.login.realm.error-email-invalid` rather than the generic message a `422`
  left. Both sentences wait for the owner's approval of their wording.
- Core contract 0.13.0 (realm discovery reshaped in 0.12.0): the result is one of three exact
  shapes — zero, one, or two to twenty candidates — with the same members as before, so the screen
  is unchanged. The generated base answer is now the zero result, so acceptance test 1 names the
  new `login.single-organisation` overlay. The new refusals (`413`, `415`, `422`, `503`) fall into
  the screen's existing generic message; giving `503` its own wait is follow-up work.
- Expired-session body (§4.7, owner decision): « Reconnectez-vous pour continuer. » replaces
  « Votre session a expiré. Reconnectez-vous : ce que vous avez saisi est conservé. », which
  repeated the dialog's title and promised a restoration that is not built. Acceptance test 14
  names the body.

- Rate limit with nothing to wait for (§5, §9): a `429` whose `retry_after_s` is 0, which the
  contract allows, showed no message, no countdown and a live button. It now says « Trop de
  tentatives. Réessayez. » (`console.login.realm.error-rate-limited-no-wait`, wording approved by
  the owner) and leaves the button usable. A value below zero is treated the same. §9 says what
  each value of `retry_after_s` shows.

- Route change (§10): the wait for a heading that arrives with the screen's data ends after five
  seconds. It had no end, so focus could be pulled to a late heading from a person who had moved
  on without pressing a key or a pointer.

- Arrival through the second-factor guard (§10): a person sent to the enrolment guide on arrival
  was told « Page Sécurité et connexion chargée. », though the spec says a redirect on the way to
  a page is no route change. The guard redirects after the layout is mounted, which the
  route-change rule took for a navigation; it no longer does.

- Route change in the order flow (§10). Focus goes to the first `h1` a person can see, never to a
  visually hidden one: each order step used to leave focus on the hidden « Commander votre
  instance ». A step of the wizard is announced by the wizard alone, where the page announcement
  used to speak beside it; entering the order is announced as « Commander votre instance »
  instead of « Console ». The sentence saying the `h1` is never visually hidden was false for the
  order and is replaced (owner decision: focus the step's visible heading, one announcement).

- Two screens outside the shell, found by the first axe scans they were given
  (`tests/e2e/axe-screens.spec.ts`): the unknown-organisation page is the page's `main` landmark
  when it is drawn as the whole page, and adds none inside the shell; the staff sign-in's one
  sentence is its `h1` (§10, one `h1` per screen).

- Sign-in errors keep their context (UX audit OL-24; §4.1, §5, §9). An unknown domain used to
  show the identifier field under the e-mail subtitle, with the e-mail's error under the
  identifier as if it were the identifier's own: the subtitle now follows the field and the
  message sits above it. An unknown identifier no longer empties the field. A rate limit counts
  down and holds the button, with its own key for the singular. Acceptance test 2 is reworded,
  its name unchanged; acceptance test 15.
- « écrivez-nous » gives the address (UX audit OL-13; §9): in the unknown-domain message, in
  « Le service est momentanément indisponible… », « Une opération n'a pas abouti… », the
  empty-catalogue message and the failed sign-in return.

- Session expiry (§4.7): the two states of the dialog are tabulated. Once expired it is named
  « Votre session a expiré » instead of « Votre session va expirer », and it cannot be closed:
  its close control was drawn, took focus and did nothing (UX audit SH-11). The note that the
  countdown is modal, which was only in the code, is in the spec. Acceptance test 14.

- Route change (§10): the behaviour is built and described as built — what counts as a route
  change, what is announced and when, when focus moves and when it does not, and why the heading
  is no tab stop (UX audit SH-15). The live-region rule names the toast stack's own region beside
  the route announcements'. Acceptance test 13. The two focus-order lists are unchanged.

- The theme choice: the account menu gains « Apparence » (§4.5), a place reached from « Plus »
  on a phone, opening the theme page of [`10-appearance.md`](10-appearance.md); §10 states how
  the theme is chosen and applied. Supersedes the plan's account-menu item that cycled through
  the themes.

- Browser chrome (§4.5): the tab title, the installed app's name and the favicon's accessible name
  are « Kodera », and the staff badge (§4.8) reads « Personnel Kodera » (UX audit OL-14). The
  login wordmark (§4.1) is the Kodera monogram and name instead of the text `kodera.io`. The
  enrolment guide's demonstration uses the issuer « Kodera » and the recovery file
  `kodera-codes-de-secours.txt` (§4.4); in production both come from the Keycloak realm. A unit
  guard keeps the previous product name off `index.html`, `public/`, the copy catalogues and the
  three source files that print it.

- The narrow layout is built (§4.5, "The narrow layout, as built"): below 768 px wide, and on a
  phone held sideways, a top bar with
  the « Compte et organisation » menu and a tab bar (« Accueil · Applications · Facturation ·
  Aide · Plus ») replace the rail and the sidebar, which left a phone an 80 px content column
  (audit SH-02, OL-25;, owner ruling). Focus order below 768 px in §10; acceptance
  tests 10–12.

- Aide is no longer a placeholder: `/{org}/help` renders the interim Aide page
  ([`06-support.md`](06-support.md) §4.0), reached from the sidebar and from every support action.
  The §3 row no longer claims `?help=1` works: it is planned with the panel. The sign-in screen's
  « État du service » link to an external status page is removed (, owner ruling).

- Journey fixes: a route that fails to load shows the console's own French screen (retry, the
  support address; a 401 goes to "Se reconnecter" with the destination kept) instead of the
  router's English default. The shell's incident banner no longer states a next-update time the
  contract does not send, and yields to the Applications screen's own banner; the dunning banner
  states the amount due and links to the invoice instead of printing its id and a day count it
  does not have. Acceptance test 8 is reworded to match; its name is unchanged.
- Review fixes: the expired-session screen offers one sign-in round, then signing out and support;
  with no organisation in the URL it goes to `/login`. The error screen covers `/`, `/login` and
  the staff sign-in as a full page, takes focus and is announced. On Applications the slot yields
  only for the component the page's own banner names, and falls to the next banner in precedence.
  Members get a neutral overdue line. Acceptance test 8 names contract 0.12.0's `next_update_at`
  as the future requirement.

- The prototype card note no longer refers to a pre-login order flow as if it existed: orders start
  only for the owner of an existing organisation, after the staff intake and the owner claim.

- Review fixes: the session-expiry wireframe quotes the rewritten session strings, which no
  longer address the reader with a feminine-only participle.

- Initial version: realm discovery, switcher, MFA enrolment, staff realm, session expiry, shell,
  status banner slot, help entry.
- Reconciled with the Core API contract: organisations addressed by `organisation_id`,
  `POST /auth/discover`, `PATCH /me`, `entitlements` and `status-summary`, and the closed
  `ProblemType` registry in place of invented problem types.
- Aligned with the delivered design: the six-item sidebar (Accueil, Applications, Personnes,
  Domaine & identité, Facturation, Aide) with the organisation switcher and the account block
  inside it and no separate top bar, `/{org}/home` as the default screen, federation as a tab of
  Domaine & identité rather than a navigation item, the navigation states while an instance is
  provisioning, and the note that the prototype card in the delivered screens is not part of the
  shell.

- Approved login timing and warning modality: discovery shares a nonpersistent wall-clock deadline
  across email/identifier, uses seconds/minutes/hours and one polite completion. Preexpiry warning
  preserves editing focus and interaction; expiry retains the reconnect-only modal. Earlier modal
  as-built note above is historical and superseded by §4.7. Restoration acceptance6 now has the bounded People consumer; its final current-base run and
  required-all gate qualification remain separate.
- Contract 0.28.0: `identity-unknown`, the `403` Core answers a token that verifies for an
  identity it does not know or has disabled, goes to "Pas encore d'organisation" with signing out
  and the support address, on `/` and on every organisation route; it never starts
  re-authentication. Every other `403` and every unregistered problem type keep their screens.
- Review round on contract 0.28.0: the `identity-unknown` body no longer says "encore", since Core
  gives the same answer for a disabled or deleted identity, and asks the organisation's owners
  without a gendered article. `console.shell.session.title-unrecognized` takes the straight
  apostrophe the rest of `console.shell.session.*` uses.
- Onboarding audit (items 6 and 10): a member lands in Espace only when the organisation's
  tenant has the `messaging` app, and on Home otherwise, so a Visio-only member never lands on an
  Espace with no homeserver behind it. The no-organisation body tells an invitee, whom the realm's
  set-up mail returns to `/` before they have accepted, to reopen the link in the invitation
  e-mail.
