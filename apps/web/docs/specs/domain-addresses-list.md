# Domain — the list of addresses, read-only

Status: First read-only slice approved by the owner, including the two new strings and the bounded
choices listed below. Later writable slices remain Proposed.

## Scope and contract

`/{org}/domain` stops being a placeholder and shows the addresses the organisation's applications
answer at: the ones it connected under its own name, with the state of each, and the ones provided
with its instance. It reads and it changes nothing. The screen draws no « Ajouter une adresse », no
« Gérer », no row action, no tab strip, no record to copy and no check to run: each arrives with the
slice that makes it work, because a control that does nothing is a defect. No entry point on Home
or on the order confirmation returns with this slice.

Two reads, both through the generated client:

1. `GET /organisations/{organisation_id}/tenants` with `limit=1` — the instance, for its identifier
   and for `default_urls`, the addresses provided with it. `04-domain.md` §6 does not list this
   call and §7 (`domain.none`) relies on it.
2. `GET /tenants/{tenant_id}/domains` with `limit=50` and, while `has_more` is true, the
   `next_cursor` of the page before. The list is read whole before it is shown: a page carries no
   total, a server may answer fewer rows than asked, and half a list of addresses with nothing to
   say so would be read as the whole. Ten pages is the bound; past it the read is an error. A page larger than the requested
   fifty rows is also an error.

Before anything is kept, the fields the screen renders are checked. The instance must belong to the
organisation asked for, and its collection envelope must carry a consistent `has_more` and cursor.
An empty non-final tenant page is rejected as incomplete, rather than presented as no instance;
this slice does not add tenant pagination. An address must belong to the instance asked for, carry a name, a known
state and a known purpose, and an application the contract knows or none. A page that fails this is
an error, never a row drawn from a guess.

The role gate is the one the placeholder had: an owner or an administrator sees the list; anyone
else sees the role banner and **the screen sends no read of its own** — no domain request leaves
the browser (the shell's application rail reads the instance for every role, so a tenant request is
not this screen's to withhold). The rule sits in `src/features/domain/permissions.ts`. If the Core API itself answers `forbidden`, the screen shows
the same role banner rather than a retry.

## One module for what depends on how an instance is hosted

Which addresses are provided with an instance, what an address is for, whether a bare domain may be
used, which records a customer must publish and where they point are not settled: a second hosting
model and a change of provider are being studied. Everything the console says or decides about them
lives in **`src/features/domain/hosting.ts`**, fed by what the Core API returned, and nowhere else
in the area. In this slice that is:

- the provided addresses, read from `Tenant.default_urls` — the console knows no host name of ours;
- the purpose of an address, read from `Domain.role`;
- the order of the list: the organisation's own addresses, then the provided ones.

No file of the area, of its fixtures or of its overlays writes an IP address, a host name of ours, a
provider's name or a place. `tests/unit/domain/hosting-boundary.test.ts` holds both rules: the
literals above are refused anywhere in those files, and the contract fields that describe DNS
records and the hosting of an instance may be named in `hosting.ts` only. The check ships with the
mutations that prove it can fail.

## What the list shows

One table, named « Domaines », under the area's heading « Domaine & identité ». Each address is
a row header for assistive technology, with the same body-cell appearance.

| Column | Source | Rendering |
|---|---|---|
| Adresse | `fqdn`, or the host of a `default_urls` entry | Monospace, cut with an ellipsis past 320 px, the whole name kept as the element's title |
| Application | `app`, or the key of the `default_urls` entry | « Visio » or « Docs » (`console.status.overview.label-app-visio`, `-docs`); a dash for an application the catalogue has no name for. « Appels vidéo » under it when the address carries the calls (`role: media`) |
| État | `state`, `is_canonical` | An address of the organisation: a `StatusPill` — a word and a colour, never the colour alone — and the « Principale » badge when `is_canonical` is true. A provided address: the « Secours » badge and no pill, because the API reports no state for it |

The pill says whose move it is, read from `state` alone (`04-domain.md` §6: the console never
derives a state from the records or the certificate):

| `state` | Pill | Key |
|---|---|---|
| `pending`, `nonce_issued`, `dns_pending` | neutral | `console.domain.list.status-pending` — something is awaited at the customer's registrar |
| `txt_verified`, `certificate_issued` | info | `console.domain.list.status-verifying` — the next step is ours |
| `live` | success | `console.domain.list.status-active` |
| `failed` | danger | `console.domain.list.status-failed` |

States, from the matrix of `04-domain.md` §5, row `list`:

- **Default** — the organisation's own addresses, then the provided ones.
- **Loading** — skeleton rows under the real column headers, announced once as « Chargement ».
- **Empty** — no address of the organisation's own: the provided addresses stay in the table and
  `empty-body-none-yet` says so under it. No action, because this slice has none to offer; the
  catalogue's `empty-title`, `empty-body` and « Ajouter une adresse » return with the slice that
  adds an address.
- **No instance** — the organisation has no tenant yet, a state §5 does not name: no table, the
  Applications screen's own « Pas encore d'instance » notice, no action.
- **Error** — either read fails: `console.common.error-unavailable` with « Réessayer »; the retry
  reads again and the list replaces the alert.
- **Success** — not reachable: the slice changes nothing.
- **Partial failure** — not drawn. §5 asks for « État du certificat inconnu » on a row whose
  certificate state is unknown; the list of this slice shows no certificate fact, the catalogue has
  no such string and the contract does not say what "unknown" is. It arrives with the detail of an
  address.
- **Permission denied** — as above. The tier half of the rule (a pack without custom addresses) is
  about the add action and arrives with it.
- **Offline** — the shell's banner; the rows already loaded stay readable. There is no action to
  disable.

The heading « Domaine & identité » is drawn in every state, so a person and a screen reader always
know which page this is.

## Copy

Existing keys: `console.shell.nav.title-domain`, `console.domain.list.label-tab-domains` (the
table's name and the list's heading, for screen readers only in this slice — the same word the tab
will carry), `console.domain.list.label-column-address`, `console.domain.list.label-column-app`,
`console.domain.list.label-column-state`, `console.domain.list.status-active`,
`console.domain.list.status-verifying`, `console.domain.list.status-pending`,
`console.domain.list.status-failed`, `console.domain.list.badge-primary`,
`console.domain.list.badge-provided`, `console.status.overview.label-app-visio`,
`console.status.overview.label-app-docs`, `console.status.overview.title-no-tenant`,
`console.status.overview.empty-no-tenant`, `console.common.error-unavailable`,
`console.common.action-retry`, `console.common.a11y-loading`, `console.shell.access.error-role`.

New keys, added to both catalogues with wording approved by the owner:

| Key | Français | English |
|---|---|---|
| `console.domain.list.empty-body-none-yet` | Aucune adresse à votre nom n'a encore été ajoutée. | No address of your own has been added yet. |
| `console.domain.list.label-role-media` | Appels vidéo | Video calls |

## Scenario overlays

| Overlay | The world it creates |
|---|---|
| `domain.none` | `tenants/{id}/domains` returns an empty page; only `tenant.default_urls` exists (`04-domain.md` §7) |
| `domain.mixed-addresses` | Six addresses on one page: the main address, live; the address that carries its calls, live; one waiting for its proof; one proven and being finished; one that failed; and one with a very long name, waiting for its pointing record |
| `domain.short-pages` | The same six, served two at a time whatever `limit` asks for, so the list is three pages |
| `domain.list-unavailable` | The domain read answers `internal-error`, a failure the contract declares for it, until the spec ends the outage |

Reused: `status.no-tenant` (no instance), `shell.member-role` (the role gate),
`shell.single-organisation`. The walkable demo (`demo.groupe-vercelli`) answers the domain read from
its own seed — one live address per application, the ones its Applications screen already shows —
because a route the demo leaves unanswered puts the contract example's company on screen
(`src/mocks/demo/seed.test.ts`). The fixtures take every host name of ours from the contract's own
examples; none is written in them.

## Acceptance before code

Unit tests beside the code, written first: the role gate; the state presentation (every contract
state has a label); the application names; `hosting.ts` (provided addresses read from
`default_urls`, a malformed one refused, the purpose of an address, the order of the list); the
response checks; the query (two reads by identifier, every page followed, the bound, no domain read
without an instance); and the screen in each state above — including that a refused role sends no
request and that no later-slice control is in the document.
`tests/unit/domain/hosting-boundary.test.ts` holds the one-module rule and its mutations.

Browser acceptance, in `tests/e2e/04-domain.spec.ts`, each run on a light and on a dark device:

`domain/list: shows each address with its application and its state`

`domain/list: shows the provided addresses alone when none has been added, without offering an action it cannot perform`

`domain/list: shows every address when the list arrives in several pages`

`domain/list: explains a failed load and recovers on retry`

`domain/list: keeps the addresses readable when the connection drops`

`domain/list: says when the organisation has no instance yet`

`domain/list: reaches the table with the keyboard alone`

`domain/list: stays usable on a phone, the table scrolling inside its own box`

`domain/list: keeps the list from a member and sends no domain request`

The default, empty, error and no-instance states are scanned with axe, and the default state again
on a phone; no rule is disabled.

**None of the eleven acceptance tests named in `04-domain.md` §12 is delivered by this slice.** The
one about the list (`domain/list: names the tier required for a custom address`) is about the add
action, which this slice does not draw, so it stays missing and `04-domain.md` stays out of
`scripts/spec-gate.json`.

Visual baselines: the screen is no longer a placeholder, so it has its own, written by the pinned
renderer (`docs/dev/TESTING.md` §7) on `domain.mixed-addresses` — `domain-light.png`,
`domain-dark.png` and `domain-black.png` at 1440 px, `domain-1024-light.png`, where the table
overflows its box, and `domain-mobile-light.png`. The dark and the black one pass axe in their
theme first.

## Decisions this slice takes

These bounded first-slice choices are approved by the owner. Later writable slices retain their
contract and product decision gates.

- The page heading is the area's name, « Domaine & identité », as the design of record and the
  narrow-layout acceptance test have it; the « Domaine » of the `04-domain.md` wireframe is not
  drawn. The subtitle is left out: the catalogue's sentence promises « la manière dont vos collègues
  se connectent », which is the second tab.
- No tab strip. The second tab is `07-federation.md`, still a placeholder, and a tab that leads to
  a placeholder is the button the owner ruled out. `DomainScreen` is the area's frame and
  `AddressList` its first panel, so the strip, `?tab=` and the `/{org}/federation` redirect are
  added around the list without rewriting it.
- A provided address carries « Secours » and no state: the API reports none, and the wireframe's
  « Active · fournie » would be a state the console made up.
- « Principale » is drawn only where the API says `is_canonical`. When no address of the
  organisation is the main one, the list names none.
- An address that carries the calls is listed as a row of its own, labelled « Appels vidéo »,
  rather than hidden or folded under the address it serves.
- An application the catalogue has no name for (`drive`, `tchap`, `grist`, or an unknown key of
  `default_urls`) is a dash, never the raw code.
- The instance is the organisation's first tenant, as on the Applications screen.
- `org_member` may read domains in the contract; the console keeps the area to owners and
  administrators, as the navigation does.
- No analytics event: `04-domain.md` §11 names none for opening the list.
