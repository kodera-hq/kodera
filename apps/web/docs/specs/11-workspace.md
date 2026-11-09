# 11 — Workspace

**Status:** Proposed · **Owner:** zôÖma

The first slice of the organisation workspace (workspace pilot capability W13): the organisation's
categories and text channels, one channel's header with an honest empty state, and the setup
states that come before the workspace exists. Core contract 0.13.0 carries the two operations it
uses, `getWorkspace` and `initialiseWorkspace`; Core's `docs/specs/PILOT_WORKSPACE_ONBOARDING.md`
§§2–4 is the source of every state and of the starter template.

## 1. Goal

"I open my organisation's workspace and see where my team will talk, or why it is not ready yet."

## 2. Persona and the "can the CEO do this alone" test

**Who.** Every member of the organisation, whatever their role: an owner or an administrator who
has just claimed the organisation and waits for it to be ready, and the colleagues who arrive
after.

**Alone test: pass.** Each state is one sentence and, at most, one action. While setup runs the page
says so and updates itself; when it has stopped it says that the team knows and gives the way to
write to it, with a reference; when it is ready to start, an owner or an administrator has one
button. Once the workspace exists, the categories and channels are on the left and the chosen
channel's name is the page's heading.

**Baseline limitation.** Without a matching Matrix session, this baseline offers no message
writes. The matching-session live extension implements messages, threads and reactions, and
view-owned audio. Files and structural channel administration remain outside this slice (§13).

## 3. Entry points

| Entry | URL |
|---|---|
| The rail's « Messages » item | `/{org}/workspace` |
| A direct link or a bookmark | `/{org}/workspace` — the first channel the caller may see |
| A link to one channel | `/{org}/workspace/{channelId}` |

**Its own surface (owner decision).** The workspace is an application of its own beside the
console, « Messages » on the dark rail next to the tenant's applications, with « Réglages » at its foot for every role but `org_member`, not an
area of the console's navigation. Its pages keep the `/{org}/workspace…` addresses, which decide
the surface (`src/app/railModules.ts`, `surfaceOf`): the shell then draws the rail and gives the
whole width to the workspace — no console sidebar, no content header and, on a phone, the rail's
places as a tab bar in place of the console's (§4.2).

**On the rail.** The item is in the rail's list of surfaces (`src/app/railModules.ts`,
`RAIL_SURFACES`), named « Messages », after the tenant's applications and before the foot,
where « Réglages » (the console) sits for every role but `org_member`; Core serves `getWorkspace`, and the v1 plan
puts Espace in the first internal version. No console navigation offers it. It is drawn for an
organisation whose tenant runs the `messaging` app, and for an `org_member` of an organisation
that has no tenant yet: that member lands here
(`00-shell-and-login.md` §3) and reads how far setup has come (§4.3), instead of an empty Home that
speaks to an owner. It is not drawn for an organisation whose tenant runs without `messaging`, nor
for an owner, an administrator or a billing contact before a tenant exists.

## 4. Screens

### 4.1 Workspace, ready

```
┌────┬──────────────────────┬────────────────────────────────────────────┐
│rail│ [AC] ACME Constr…  ▾ │ # bienvenue                         (h1)   │
│    │      acme-sa         │                                            │
│    │ [⌕ Rechercher Ctrl K]│                                            │
│    │ ▾ Général            │                                            │
│    │   # bienvenue  ◀     │   Ouvrez vos messages pour lire et         │
│    │   # général          │   écrire dans vos salons.                  │
│    │ ▾ Équipe             │   [ Ouvrir les messages ]                  │
│    │   Aucun salon pour   │                                            │
│    │   l'instant.         │                                            │
└────┴──────────────────────┴────────────────────────────────────────────┘
```

The channel column on the left, the conversation beside it, the whole width after the rail.
Room is kept for a contextual side panel (thread, members) right of the conversation and an
audio dock at the foot of the channel column; neither is drawn in this slice.

- The column opens with the organisation (gap report G8, reference screen p02): its initials on a
  `c-t6` tile and its name, without the slug. For a person in two
  organisations or more, the whole header is a button (« ACME Construction, changer
  d'organisation ») opening a menu of the others; choosing one opens the same area there, as the
  console's switcher does (00-shell-and-login.md §4.6). The initials are hidden from the reading
  order: the name follows them. This surface draws no console sidebar, so this is where the
  switch lives on it (`src/app/organisationSwitch.ts`). The phone's drawer keeps the
  organisation's name alone: the top bar already carries the switch there.
- Below it, « Rechercher » with its shortcut: « Ctrl K », or « ⌘ K » on a Mac, where `Ctrl K`
  stays the text field's own "delete to the end of the line" (`aria-keyshortcuts` names the one
  that applies; the key cap is hidden from the reading order). The shortcut opens it from anywhere
  on the surface, except while the surface is withdrawn — behind a modal, or behind the
  session-expiry screen, which keeps the page mounted but hidden: the key then does nothing, so
  the organisation's channel names never come back over that screen. It opens a dialog « Aller à un salon »: a field and the matching channels, by name, without
  regard to case or accents. It searches names only, never messages. Arrows move the highlight,
  `Enter` or a press chooses, `Escape` closes and returns focus to what had it. A text channel
  opens, and focus lands on its heading. In the live workspace the audio rooms are listed too,
  read with « Salon audio »; choosing one moves focus to its row and does not join it, so a search
  never turns a microphone on; a room that cannot be joined yet leaves focus on « Rechercher ».
  No match reads « Aucun salon ne porte ce nom. ». On a phone, the ready workspace's drawer has
  no search: the drawer is itself the list. The live workspace's column is the whole screen there:
  it keeps the search, without a shortcut or a key cap, and draws no organisation header, since
  the top bar carries the organisation and its switch.
- The sidebar is a `nav` named « Salons » by a visually hidden heading. It follows the
  conversation in the document, so the page's `h1` comes before its `h2`, and is placed on the
  left visually. Each category is a
  disclosure button (`aria-expanded`) over its list of channels; collapsing one hides its list.
  Each text channel whose room exists (`room_state` `ready`) is a link; the current one carries
  `aria-current="page"`. Categories, then their channels, then the uncategorised channels, in the
  order Core sends them. An audio channel is named with a speaker, never a link: it is joined from
  the live workspace. A channel whose room is `pending` or `failed` is drawn greyed with « En
  préparation » and cannot be chosen, nor found by the search. An archived channel is listed with
  « Archivé ».
- Labels: a row with a `template_key` the console knows is labelled from the catalogue
  (`console.workspace.category.<key>`, `console.workspace.channel.<key>`); any other row shows its
  stored `name`.
- The channel pane: the channel's label as the page's `h1`, its topic when it has one, and in the
  live workspace a text channel's member count (« The channel's header » below). Where the
  deployment does not offer Espace (no matrix domain), the pane says « La messagerie n’est pas
  disponible pour votre organisation. ». It makes no promise of a later release (gap report G7),
  and draws no message, member or occupancy.
- **The tenant (quick-workspace SPEC W2).** The workspace is drawn once the organisation's first
  tenant is read (`listTenants`, limit 1); until then, the loading skeleton, and a failed read is
  the error state with « Réessayer ». The tenant's slug is its homeserver's server name and may
  differ from the organisation's slug: the homeserver, the Matrix session the page accepts and the
  live workspace's identity are all found from the tenant's slug, never the organisation's. While
  the tenant is `ordered`, `provisioning` or `ready`, its homeserver does not exist yet: the pane
  says « Votre espace se prépare. Vous pourrez y écrire dès qu’il sera prêt. » under the channel's
  heading, every channel is greyed (above), no way in is drawn, no Matrix session is used and no
  sign-in starts; the live region says the preparing title. A `failed` tenant is the failed setup
  state of §4.3. With no tenant, or one `suspended`, `decommissioning` or `deleted`, the pane says
  messaging is not available and no session is used. The tenant is read again every 10 s while
  it is `provisioning` or `ready`, every minute while it waits on an operator (`ordered`,
  `failed`), and on coming back to the tab, so the page opens without a reload once it is set
  active. `upgrading` and `maintenance` are open: a sign-in started then may meet an unreachable
  homeserver, which the page says as such. The tenant's slug is taken by the tenant rule (3 to 32
  characters), not the organisation's. The read is kept while the member is in another module:
  the live workspace's drafts are checked against the open tenant's slug, so nothing is written
  or sent from them while the tenant is not open, and a slug that has moved retires them at the
  next check. A stopped tenant quotes no request id: the
  workspace read's id is quoted only when that read is the one that said setup stopped. An audio
  channel's row says « Salon audio » to a screen reader, and an archived one says « Archivé ».
- Where the deployment offers Espace (a matrix domain), the tenant is open and the member has no
  Matrix session yet, the page starts that sign-in on its own, once, on arrival, or on the draw
  that first sees the tenant open. From `/{org}/workspace`, it comes back to `#welcome` when that
  channel's room exists; otherwise to the page on screen. The Console's Keycloak session makes
  Synapse's SSO come straight back. While that start is under way, the pane says « Ouverture de vos
  messages… » above a busy « Ouvrir les messages ». This is decided at the first draw, so the page
  never draws the invitation to open the messages just before it leaves for them (gap report
  G7). The page does not start it again within a minute of the last automatic start, so « back »
  from Synapse or Keycloak lands on the button instead of looping. It never starts without session
  storage. In both cases, and when the start fails, the pane says « Ouvrez vos messages pour lire
  et écrire dans vos salons. » above « Ouvrir les messages »
  (`useAutoOpenEspace`, `src/features/workspace/OpenEspace.tsx`). The automatic start and the
  callback's return both replace the history entry, so « back » from the workspace never reaches
  the spent callback. A callback opened with no sign-in pending leaves the live session alone.
  Runnable acceptance: `npx vitest run src/features/workspace/WorkspaceScreen.test.tsx -t "the way
  into the live workspace"`.
- A channel id in the address that the caller cannot see: « Ce salon n'est pas disponible » in the
  pane, the sidebar unchanged.

Components: `EmptyState` vocabulary drawn inline, `Drawer` (narrow), router `Link`.

### 4.2 Narrow layout

The channel pane takes the width. A « Salons » button beside the channel's heading opens a bottom
`Drawer` holding the same sidebar; choosing a channel closes the drawer and the new channel's
heading takes focus — the drawer hands focus to that heading as it closes, the one `RouteFocus`
focuses after the navigation, so the two never compete. Closing the drawer without a choice
returns focus to « Salons ».

The narrow layout draws no rail, and the console's tab bar holds the console's places, so this
surface draws neither. It draws the rail's places instead, as a tab bar of its own at the foot of
the screen (`NarrowModuleBar`, gap report G11, reference screens p01 and p02 on a phone): a `nav`
named « Modules », like the rail it stands in for, with the console tab bar's look (52 px tabs,
glyph over label, the current one in `c-accent-ink` at 600 with a 2 px edge). In this order:

- « Accueil » (`console.shell.nav.title-home`, the name the console's tab bar and the sidebar give
  that page), leading to `/{org}/home`, for every role: the way back to the console. Not the
  rail's « Réglages »: a member has no settings, and goes back all the same.
- « Messages » (`console.shell.rail.title-workspace`), the workspace, current
  (`aria-current="page"`).
- Each of the tenant's other applications, in the rail's order and under the rail's rules: named
  by the server (`TenantApp.name`), drawn with the rail's glyph at the tab's size, opening in a new
  tab, its accessible name followed by « — Ouvre un nouvel onglet ».

One column per place: two when the tenant runs nothing but Espace, six when it runs all four other
applications. The reference's « Docs », « Agenda » and « Activité » are drawn only as the tenant's
applications are: a tab with nowhere to go would be a dead button. The top bar keeps the maker's
mark: the way back is the tab bar's « Accueil », in one place, not two.
`src/app/Shell.wayBack.test.tsx` fails for any declared rail surface, released or not, whose phone
layout offers no « Accueil » link to `/{org}/home`.

### 4.3 Setup states

One centred block in the place of the workspace: the organisation's name, an `h1`, one sentence,
and at most one action.

| Core answer | Title | Body | Action | Reads again |
|---|---|---|---|---|
| `setup` `pending` or `running`, no reason | `console.workspace.setup.title-preparing` | `console.workspace.setup.body-preparing` | — | every 10 s |
| `setup` `pending` / `awaiting_owner_confirmation` | `console.workspace.setup.title-confirming-owner` | `console.workspace.setup.body-confirming-owner` | — | every 60 s |
| `setup` `pending` / `awaiting_owner_confirmation`, to anyone but the owner | `console.workspace.setup.title-preparing` | `console.workspace.setup.body-preparing` | — | every 60 s |
| `setup` `failed`, either reason | `console.workspace.setup.title-failed` | `console.workspace.setup.body-failed` | `console.common.action-contact-support` to Aide (`reason=step-failed`), with the request id (`console.workspace.setup.label-request-id`) | every 60 s |
| `ready`, `not_initialised`, `can_initialise` true | `console.workspace.setup.title-ready` | `console.workspace.setup.body-ready` | `console.workspace.setup.action-create` | — |
| `ready`, `not_initialised`, `can_initialise` false | `console.workspace.setup.title-not-created` | `console.workspace.setup.body-not-created` | — | every 60 s |
| `ready`, `initialised` | §4.1 | | | every 10 s while a room is `pending`, every 60 s while one is `failed`, else — |
| `ready`, `initialised`, the tenant `failed` | `console.workspace.setup.title-failed` | `console.workspace.setup.body-failed` | as `setup` `failed` | every 60 s (the tenant) |

Nothing reads again while the tab is hidden. A failed setup offers no retry: an operator acts.
The contract gives a stopped setup no reference of its own, so the page quotes the request id of
the read that first reported it, labelled as a request id and kept while later reads come and go;
it is never handed to Aide as a job reference.

**Creating the workspace.** The button calls `initialiseWorkspace` with an `Idempotency-Key`
generated when the state is first drawn, shows `console.workspace.setup.status-creating` while it
runs, then reads `getWorkspace` again and draws whatever that answer says — never the
initialisation's own answer. If that read fails, the page says `console.common.error-unavailable`
and offers `console.common.action-retry`, which reads again and never creates again. Two presses
in one frame send one request. The key follows the contract's retry rule: after a `5xx` or a network
failure the next attempt reuses it; after any `4xx` the next attempt takes a new one; a `409`
reads `getWorkspace` again first.

## 5. State matrix

| State | Workspace ready | Setup state | Narrow drawer |
|---|---|---|---|
| Default | §4.1 | §4.3 | closed, « Salons » button |
| Loading | skeleton of the sidebar and pane | the same skeleton | the same skeleton |
| Empty | a category with no channel says `console.workspace.sidebar.empty-category`; a workspace with no channel at all draws the pane's empty state under the shell title | n/a — every setup state has a sentence | the same as wide |
| Error | `console.common.error-unavailable` with `console.common.action-retry`; a `404` (a Core that does not serve the workspace yet) is not retried by the client | the same | the same |
| Partial | n/a — Core answers the structure whole | n/a | n/a |
| Permission | n/a — every organisation role reads; a hidden channel is absent | the create action only when `can_initialise` | n/a |
| Offline | the shell's offline banner; the last answer stays drawn | the same | the same |
| Success | the new workspace, read again after creation | — | the drawer closes on a choice |

## 6. Core API calls

| Method and path | Sent | Read |
|---|---|---|
| `GET /organisations/{organisation_id}/workspace` (`getWorkspace`) | `organisation_id` | `state`, `setup.state`, `setup.reason`, `can_initialise`, `categories[]` (`id`, `name`, `template_key`, `channels[]`), `uncategorised_channels[]`, each channel's `id`, `kind`, `name`, `template_key`, `topic`, `lifecycle`, `room_state`; header `X-Request-Id` |
| `POST /organisations/{organisation_id}/workspace/actions/initialise` (`initialiseWorkspace`) | `organisation_id`, header `Idempotency-Key`, no body | the status only |
| `GET /organisations/{organisation_id}/tenants?limit=1` (`listTenants`) | `organisation_id` | the first tenant's `slug` and `status` |

A body outside the contract's closed enums (`state`, `setup.state`, `setup.reason`, `kind`,
`lifecycle`, `room_state`, the tenant's `status`) is refused before it is cached and drawn as the
error state.

## 7. MSW scenario overlays

| Overlay | Deviation |
|---|---|
| `workspace.ready` | `getWorkspace` answers the starter workspace, `initialised` |
| `workspace.setup-pending` | `setup` `pending`, no reason, `not_initialised` |
| `workspace.setup-running` | `setup` `running`, no reason, `not_initialised` |
| `workspace.awaiting-owner` | `setup` `pending` / `awaiting_owner_confirmation`, `not_initialised` |
| `workspace.setup-failed` | `setup` `failed` / `realm_job_failed`, `not_initialised` |
| `workspace.not-initialised` | `setup` `ready`, `not_initialised`, `can_initialise` true; `initialiseWorkspace` answers `201` and the next read is the starter workspace |
| `workspace.member-not-created` | `setup` `ready`, `not_initialised`, `can_initialise` false |
| `workspace.unavailable` | `getWorkspace` answers `500 internal-error` |
| `workspace.tenant-preparing` | the starter workspace with every room `pending`; `listTenants` answers its tenant `ordered` |

## 8. Validation rules

None: the slice has no form. The create action takes no input.

## 9. Error copy rules

A failed read is `console.common.error-unavailable` (cause, next action, address) with a retry. A
failed creation is the same sentence above the button, which stays available; the next attempt's
key follows §4.3. A stopped setup is not an error of the page: it is a state with its own sentence
and no retry.

## 10. Accessibility

- One `h1`: the channel's label once the workspace exists, the state's title before. A change of
  channel is a route change: the page is announced (`console.common.a11y-page-loaded` with
  `console.workspace._.title`) and focus moves to the `h1` (`src/app/RouteFocus.tsx`).
- The channel list is a named `nav`; a category is a `button` with `aria-expanded` and
  `aria-controls`; the current channel is `aria-current="page"`. Everything is reached with `Tab`
  and activated with `Enter` or `Space`.
- One polite live region, mounted for the life of the page, carries the current state's title, so
  a state that changes while the page is open — setup finishing, the workspace created — is read
  out once.
- The narrow drawer is the shared `Drawer`: focus is trapped while it is open, `Escape` closes it
  and returns focus to « Salons ».
- The search is the shared `Dialog`, opened on its field (`initialFocus` given a ref). The field is
  a `combobox` over a `listbox`; the highlighted option is its `aria-activedescendant`, drawn with
  an edge as well as a colour. Focus never leaves the field while the list is browsed.
- The organisation switch is the shared `DropdownMenu`: `Enter`, `Space` or `ArrowDown` opens it,
  `Escape` closes it and returns focus to the header.

## 11. Analytics events

None in this slice.

## 12. Acceptance tests

1. **Given** an organisation whose workspace exists (`workspace.ready`),
   **when** a member opens `/{org}/workspace`,
   **then** the categories and their channels are listed in the order Core sent them, the first
   channel is current, and its pane says that messaging is not available, with no promise of a
   later release.
   `workspace/channels: shows the starter categories and channels in the order received`

2. **Given** the same workspace,
   **when** the person tabs to a category and collapses it, then tabs to the second channel and
   presses `Enter`,
   **then** the category's channels are hidden and shown again, the address names the channel, and
   focus is on that channel's heading.
   `workspace/channels: opens a channel from the keyboard and moves focus to its heading`

3. **Given** a phone-sized screen and the same workspace,
   **when** the person opens « Salons » and chooses a channel,
   **then** the drawer closes and the channel is current.
   `workspace/channels: opens the channels in a drawer on a phone`

4. **Given** an organisation whose setup is still running (`workspace.setup-pending`),
   **when** a member opens the workspace,
   **then** the page says the workspace is being prepared and offers no action.
   `workspace/setup: says setup is in progress and offers no action`

5. **Given** a claim waiting for the owner's confirmation (`workspace.awaiting-owner`),
   **when** the owner opens the workspace,
   **then** the page says ownership is being confirmed and offers no action.
   `workspace/setup: tells the owner their ownership is being confirmed`

5b. **Given** the same claim and an administrator, a billing contact or a member,
   **when** they open the workspace,
   **then** the page says setup is under way, never that they are being confirmed as owner.
   `workspace/setup: tells anyone but the owner that setup is under way`

6. **Given** a setup that stopped (`workspace.setup-failed`),
   **when** a member opens the workspace,
   **then** the page says setup stopped and the team knows, gives a reference and a way to write,
   and offers no retry.
   `workspace/setup: says setup stopped and offers the team's help with a reference`

7. **Given** an organisation ready for its workspace (`workspace.not-initialised`),
   **when** the owner presses « Créer l'espace de travail »,
   **then** the request carries an `Idempotency-Key`, and the starter workspace is drawn from a new
   read.
   `workspace/setup: lets an owner create the starter workspace, then shows it`

8. **Given** an organisation ready for its workspace and a member who may not create it
   (`workspace.member-not-created`),
   **when** they open the workspace,
   **then** the page says the workspace has not been created yet and who can create it, and
   offers no action.
   `workspace/setup: tells a member the workspace has not been created yet`

9. **Given** any role,
   **when** the shell is drawn,
   **then** the rail's « Messages » leads to the workspace and the console's navigation does not.
   `workspace/navigation: the rail leads to it, the console navigation does not`

9b. **Given** an `org_member` of an organisation with no tenant yet,
   **when** the shell is drawn,
   **then** the rail offers « Messages », leading to the workspace, and no « Réglages »; an owner
   of the same organisation is not offered « Messages ».
   `workspace/navigation: offers Messages to a member before the organisation has a tenant`

10. **Given** a phone-sized screen and the same workspace,
    **when** the person presses « Accueil » in the workspace's tab bar, « Modules », where
    « Messages » is current and each of the tenant's applications opens in a new tab,
    **then** the console's home opens, with the console's tab bar.
    `workspace/navigation: leads back to the console from its tab bar on a phone`

11. **Given** the ready workspace,
    **when** the person presses `Ctrl K`, types « gén » and presses `Enter`,
    **then** the search dialog closes, the address names « général », and focus is on its heading.
    `workspace/search: opens a channel from Ctrl K by its name`

12. **Given** the same search open,
    **when** the person types a name no channel has, then presses `Escape`,
    **then** the dialog says « Aucun salon ne porte ce nom. », and once closed, focus is back on
    « Rechercher ».
    `workspace/search: says when no channel has the name, and gives focus back on Escape`

13. **Given** a person in two organisations, in the ready workspace,
    **when** they open the organisation at the head of the column and choose the other one,
    **then** that organisation's workspace opens.
    `workspace/navigation: switches organisation from the head of the channel column`

14. **Given** a workspace whose three rooms are `pending` and whose tenant is `ordered`, in a
    deployment that offers Espace,
    **when** a member opens `/{org}/workspace`,
    **then** the banner shows, the three channels (two text, one audio) are greyed and say « En
    préparation », none is a link, there is no composer and no way in, no sign-in starts, the
    workspace is read again at 10 s and the tenant at 60 s; once the tenant is read `active`, one sign-in starts,
    back to `#welcome`, and the live region announces the workspace once. A `failed` tenant is the
    failed state with its support link; one `failed` room in an active tenant stays unusable while
    the sign-in still starts; with every room `ready`, reading stops; a `suspended`,
    `decommissioning` or `deleted` tenant offers no way in. The homeserver and the session,
    including the live workspace's draft owner, are the tenant's slug's when it differs from the
    organisation's.
    `workspace/preparing: greys every channel under the banner while the tenant is prepared`
    (the browser case: the banner, the greyed rows, no way in; the sign-in, the polling, the
    failed tenant, the failed room and the tenant slug are proven in
    `src/features/workspace/WorkspaceScreen.test.tsx`, « a workspace whose tenant is being
    prepared (quick-workspace W2) »)

## 13. Out of scope for launch

- Files, and searching messages, remain outside this slice; the search finds channels and rooms
  by name (§4.1). Messages, threads, reactions and unread state
  belong to the matching-session live extension below, not the no-session baseline.
- The live extension includes audio channels and a view-owned dock; persistent calls across
  routes and native/provider/release acceptance are not established here.
- Creating, renaming, reordering, archiving or moving categories and channels, and channel
  permissions: planned with structural administration.
- Dark and black baselines of the setup states and of the phone layout: the ready workspace has
  them; the others are planned.
- Calling `initialiseWorkspace` without a press: not planned for this slice. Core's onboarding
  document lets the console call it on rendering; the console asks for the press so a write never
  happens behind a person's back.

## Live message extension and bilingual acceptance

Status: Implemented live message capability with FR/EN catalogues; release remains separate.
The historical screen and section 12 describe the no-Matrix-session baseline. A configured Matrix
homeserver and matching organisation session select `EspaceLiveView`, whose store supports
messages, threads, reactions, unread counts and room-scoped drafts. This extension does not
release the rail item or establish complete Espace, provider/native or production readiness.

Message delivery, edited/deleted markers, reply excerpts/banners, reactions, thread landmark and
composers, timeline/empty state, unread/mentions and expired-session/reconnect labels use the FR/EN
catalogues. Audio labels are excluded. Whole sentences interpolate channel values; thread and
mention counts use ICU one/many/other. A fixed React author slot preserves strong emphasis and
literal text; user names/topics/bodies/emoji/identifiers never become translation markup. Time
uses the active locale and existing Europe/Paris formatter; ISO datetime remains unchanged.

Runnable acceptance: `npm test -- --maxWorkers=1 src/features/espace/EspaceLiveView.test.tsx tests/unit/i18n/regen-clean.test.ts tests/unit/i18n/format.test.ts`.
The existing actual-store fixture supplies real SDK rooms, events, sync and caught held sends.
Before the English pending assertion, prove live/cache/room/model/subscriber readiness and the
actual rendered raw body, article/delivery node, stable summaries, one parent and same composer.
The predecessor must report French text against the English expectation, not a missing node or
setup error. Act-wrapped stimuli and finally cleanup release and await held work before stop.

Literal FR/EN acceptance covers pending/failure/same-transaction retry, edited/deleted/reply and
thread states, reaction accessible names and event targets, zero/singular/plural counts, unread,
empty channel and session expiry/reconnect. Preserve own/foreign/archived/redacted permissions,
original cancel/save/send controls, relation targets and escaped raw text. Switching language on
one mounted store retains drafts, reply/thread targets and retry identity. A real-delegating
formatTime witness proves each active-locale call, plus real displayed/menu clock and unchanged
datetime: FR and EN-GB short clocks may match, so output alone cannot prove the locale.

A channel or audio room that Core lists and Matrix resolves, but whose room the member's sync
does not yet hold once live, reads « Vos salons arrivent… » (`console.workspace.channel.label-arriving`,
`console.workspace.audio.label-arriving`) in place of the composer or the join action. A newly
invited member is in that state until Core joins them to the rooms; it is not a refusal, so the
copy names no fault and promises no delay. While the sync starts, nothing is shown.

### Message history

A channel opens on its newest message and stays there while new ones arrive, unless the member
scrolled up to read. A log shorter than its height rests on the composer: the newest message sits
just above the field, and the empty space is above the history's edge. An empty channel's
« Aucun message dans #{channel}. » sits there too. A longer log still scrolls back to its first
row. Switching
channel opens the next one on its newest message too. Scrolling
to the top of the log asks the homeserver for the previous 30 events, and so does a log too short
to scroll, so a channel whose last events were mostly reactions still fills. The member's place
is kept when they arrive above. The top of the log says where it stands: a « Afficher les messages
précédents » button while more exist (for keyboard and assistive use), « Chargement des messages
précédents… » while asked (the log is `aria-busy`), « Les messages précédents n’ont pas pu être
chargés. » with « Réessayer » after a failure, which is never retried on its own, and « Début de
#{channel} » once the room's creation is reached. « Aucun message dans #{channel}. » is said only
once nothing older exists.

Runnable acceptance: `npx vitest run src/features/espace/matrix/store.history.test.ts
src/features/espace/EspaceLiveView.history.test.tsx`.

Both markdown catalogues are authoritative; generate JSON with the existing generator only.
No browser/native/provider context or unrelated diagnostic budget is required by this acceptance.
Apart from it, where the log draws its rows needs a layout engine, and is run by hand in a real
browser over a fake store, with no stack:
`npx playwright test -c playwright.espace.config.ts tests/espace/layout`.

### Mentions

Status: Implemented (V1 bar M8).

- In the channel composer and the thread composer, « @ » at the start of the text or after a space
  opens a list of the room's joined members, the viewer and Kodera's own accounts (the tenant
  agent and room-access, « The channel's header » below) left out. The list,
  `console.workspace.composer.label-mention-list`, offers at most six members whose display name
  or Matrix ID has a word starting with what follows the « @ ». Case and accents are ignored, so
  « elo » finds « Élodie ». A member with no display name is offered under the name the timeline
  draws. Opening the list loads the room's whole member list, once (`loadMembers`).
- The field is an ARIA 1.2 combobox (`MentionInput`, `src/features/espace/MentionInput.tsx`), and
  focus never leaves it. While the list is open, `ArrowDown` and `ArrowUp` move the highlight,
  `Enter` or `Tab` chooses and does not send, and `Escape` closes the list until the next « @ »
  without closing anything behind it. A pointer chooses with a click.
- Choosing writes « @Name » and a space in place of the typed word. On sending, every member whose
  whole name follows an « @ » and ends at the end, a space or punctuation goes into the message's
  `m.mentions.user_ids`; at each « @ » the longest name wins. A name typed by hand counts the same.
  A message that names no one carries no `m.mentions`. An edit carries none.
- Another member's message whose `m.mentions.user_ids` holds the viewer is marked: the accent bar
  at its start, and `console.workspace.message.label-mentions-you` read with its author and time.
  The viewer's own message and a deleted one are never marked. The mark follows the original
  message's mentions, not an edit's.

Runnable acceptance: `npm test -- src/features/espace/mentions.test.ts src/features/espace/EspaceLiveView.mentions.test.tsx src/features/espace/matrix/timeline.test.ts src/features/espace/matrix/store.test.ts`.

### Reading clears the unread mark

Status: Implemented.

While a channel is on screen and the page is visible, the Console sends the room's read marker
for its newest message (`markRead`, `useMarkRead` in `src/features/espace/useMarkRead.ts`). It
does this only while the room counts something unread or a mention, once for each newest
message, and again when a hidden page is shown. A refused or lost marker leaves the mark until
the next message or the next visit. Another channel's mark is never touched.

Runnable acceptance: `npm test -- src/features/espace/EspaceLiveView.test.tsx -t "clears its unread"`.

### Day dividers and « Nouveaux messages »

Status: Implemented (gap report G9, reference screen p02).

A channel's log is cut by a divider wherever the calendar day changes, the day being read in
Paris time as every date in the Console is. It reads `console.workspace.channel.label-day-today`
(« Aujourd’hui »), `console.workspace.channel.label-day-yesterday` (« Hier »), or the day itself
(« Lundi 2 novembre »), with its year only when that is not the current year
(« Mardi 30 décembre 2025 »). The day is read again every minute, so « Aujourd’hui » becomes
« Hier » once midnight passes with the room open.

`console.workspace.channel.label-new-messages` (« Nouveaux messages ») is drawn only in a room
that counted unread messages or mentions when it was opened. The member's read marker
(`m.fully_read`) is noted then, as it stood, so the marker stays where it was while reading the
room moves it, and moves only on the next visit. In a room already read when it was opened, nothing
is marked, even as messages arrive.

The unread messages start at the first message the log shows after the marker, in the room's own
order (`firstShownAfter` in the store). The marker can sit on any event, a reaction, an edit, a
thread reply or a member joining as well as a message. « Nouveaux messages » goes above the first
of the unread messages that someone else wrote, skipping the member's own messages, deleted ones,
and any the server has not confirmed yet. This is worked out again on every draw, so a marker
older than the loaded messages is found once older messages bring it in; until then nothing is
drawn. When the first new message opens a new day, the day's divider comes first.

A day is opened once: a message stamped earlier than the one before it (a device clock behind, a
federated server) stays under the current day.

Both are labelled rules drawn with tokens (`TimelineDivider`, `src/ui/TimelineDivider`): the day in
`c-ink-3` between `c-border-soft` hairlines, the marker in `c-accent-ink`, rules included. They
are plain text inside the log, not `role="separator"`, so a screen reader reads them in order with
the messages. At midnight, a divider whose label changes (« Aujourd’hui » to « Hier ») may be
read out once by a screen reader, since the log is a live region; this is accepted.

Runnable acceptance: `npm test -- src/features/espace/EspaceLiveView.timeline.test.tsx src/features/espace/timelineRows.test.ts src/ui/TimelineDivider/TimelineDivider.test.tsx tests/unit/i18n/format.test.ts src/features/espace/matrix/store.test.ts -t "day|Nouveaux|marker|divider|calendarDay|formatDayDivider|previousCalendarDay|fully-read"`.

### Who is typing

Status: Implemented (gap report G9, reference screen p02 `.typing`).

Under a channel's log, above its composer (so only where the member can write: an archived channel
or a room not joined has neither), a line says who else is writing in the channel now, from the
homeserver's `m.typing`: one person by name (`console.workspace.channel.typing-one`, « Henri Duflot
écrit… »), two by name (`console.workspace.channel.typing-two`, « Henri Duflot et Bob Dupont
écrivent… »), and any more as `console.workspace.channel.typing-many` (« Plusieurs personnes
écrivent… »). Each is named as their messages are signed: the display name, else the name drawn from
their id. From a room's second `m.typing` on, the line follows the user ids it names, so it shows
someone the console has not loaded as a member (the first sync brings only the last messages'
senders). The room's first `m.typing` reaches the console before the room does, so it shows only the
members loaded: someone already typing when the console opens, and not among those senders, is shown
once the room's typing next changes. A member who leaves a room and comes back sees no one typing
there until its next `m.typing`. The member never sees themself. The line keeps its height when
empty, so the composer does not move; it is drawn in `c-ink-3` at the `xs` size. It is its own
polite live region (`aria-live="polite"`, `aria-atomic="true"`, so the whole line is said), outside
the log, so a name is said once and a message arriving is not held behind it.

While the member writes a new message in the channel's composer, the room is told they are typing,
for 10 s at a time, and told again at most every 8 s while keys keep coming, so a keystroke is not a
request. Clearing the text, sending it, starting an edit, leaving the room, or the view going
(another module, another organisation, a new session) says they no longer are, and only after a
« typing » that still stands. A signed-out session says nothing: it has no token left. Writing an
edit of a sent message, or a thread reply, says nothing: Matrix's typing is the whole room's, and
the line would name someone writing elsewhere. A notice the homeserver refuses is not shown: it
changes nothing the member does.

Runnable acceptance: `npm test -- src/features/espace/EspaceLiveView.typing.test.tsx src/features/espace/matrix/store.test.ts src/features/espace/EspaceDraftProvider.test.tsx -t "typ|once per stretch|returns_channel_draft_after_module_navigation"`.

### The composer's tools

Status: Implemented (gap report G9, reference screen p02 `.composer .tools`; four of its tools
wait, below).

The channel's composer is one bordered box, the field beside its icon tools on one row, and the box takes the
focus ring while anything in it has the focus. The row holds:

- « Mentionner » (`console.workspace.composer.action-mention`), an icon button named by its label.
  It writes « @ » where the caret was in the field (after a selection, which it keeps), with a space
  before it when it would otherwise touch a word, puts the focus back in the field just after it,
  and so opens the member list of « Mentions » above at once, when the room has anyone to name, its
  first member highlighted, even where `Escape` had closed the list on that same « @ ». From the
  keyboard, `Tab` reaches the button and `Enter` comes back.
- « Insérer un émoji » (`console.workspace.composer.action-emoji`), an icon button named by its
  label, which opens the emoji palette of « Emoji in the composer » below.
- « Envoyer » (`console.workspace.composer.action-send`, « Enregistrer » while editing), the
  primary button, with the send glyph.

Gras, Italique, Liste and Joindre un fichier, also on p02, are not drawn: the console sends and
draws plain text only, and has no media upload. Each needs its own spec first.

The thread composer keeps its own flat row for now.

Runnable acceptance: `npm test -- src/features/espace/EspaceLiveView.mentions.test.tsx -t "Mentionner"`.

### Emoji in the composer

Status: Implemented (workspace audit item 4).

A message's emoji are written into its text before it is sent, so the stored body carries the
emoji and every client shows it. Text received from others is never reinterpreted: a « :wave: »
someone else sent is drawn as they sent it.

- **Shortcodes.** In the channel composer and the thread composer, a known « :nom: » becomes its
  emoji as its closing « : » is typed, the caret just after it. On sending (a new message, a reply
  or an edit), every known « :nom: » still in the text, pasted for instance, is written the same
  way. A code counts only standing alone: touching a letter, a digit or a slash on either side
  (« 10:100:20 », « a:wave:b », « /:x:/ ») it stays text, and an unknown code stays as typed. A web
  address is never touched, so a SharePoint link holding « /:x:/ » goes as pasted. A code after a
  backslash stays as typed, backslash and all, which is how to send « :wave: » as text. The
  mentions are read from the text as typed, so a member whose name holds a code is still named.
  The codes are
  the common English names Discord, Slack and GitHub share (`:thumbsup:`, `:+1:`, `:wave:`,
  `:tada:`, `:white_check_mark:`…), a curated table of about a hundred emoji in
  `src/features/espace/emoji.ts`, with no new dependency.
- **The list.** « : » at the start of the text, after a space or after « ( », followed by two
  characters of a code, opens `console.workspace.composer.label-emoji-list`: at most six emoji
  whose code starts with what was typed, then those with a later word of it (after « _ ») that
  does, each drawn with its code. So « https: », « 12:30 » or a lone « : » opens nothing. The list
  is the member list's combobox (`MentionInput`) and keeps its keys: `ArrowDown` and `ArrowUp`
  move the highlight, `Enter` or `Tab` chooses and does not send, `Escape` closes it until the
  next « : » without closing anything behind it, and a click chooses. Choosing writes the emoji
  and a space in place of the typed code.
- **The palette.** « Insérer un émoji » in the channel composer's tools opens
  `console.workspace.composer.label-emoji-palette`, a popover above the whole composer box, so it
  never covers the field, with a grid of 32 emoji, the eight quick reactions first: eight to a
  row, and six at phone width, where each cell keeps the 44 px touch floor. Each is a button named « Insérer 👋 »
  (`console.workspace.composer.action-insert-emoji`) whose tooltip is its code, so a pointer user
  learns the codes. Focus enters on the first emoji; the arrow keys move within the grid,
  `Home` and `End` go to its first and last, with no wrap; the whole grid is one tab stop.
  Choosing one writes it where the caret was in the field (over a selection, which it replaces),
  closes the palette and puts the focus back in the field just after it. `Escape` or `Tab` closes
  the palette and returns the focus to its button. The palette has no search: the codes are the way to
  every other emoji. The thread composer has no palette, as it has no tools row.

Runnable acceptance: `npm test -- src/features/espace/emoji.test.ts src/features/espace/EspaceLiveView.emoji.test.tsx`;
placement and the phone grid, `npx playwright test -c playwright.espace.config.ts tests/espace/layout`.

### Keyboard shortcuts

Status: Implemented (workspace audit item 11).

Discord's keys for moving and writing, on the live view. None needs a pointer. A key some control
handled first (an open menu, list or dialog, which call `preventDefault`) is left to it, and
nothing answers while the view is behind a modal or hidden. Like Discord, the channel keys do take
over one field key: on a Mac, `Option` + `ArrowUp` / `ArrowDown` in the channel composer no longer
moves the caret by paragraph (the composer is one line, where it goes to either end). On
ChromeOS, the system turns `Alt` + `ArrowUp` / `ArrowDown` into `Page Up` / `Page Down`, so the
channel keys do not reach the page there.

- `Alt` + `ArrowUp` / `ArrowDown` (`Option` on a Mac) opens the text channel above or below the
  one shown, in the sidebar's order (categories, then the channels with none), wrapping at either
  end. Audio rooms are skipped: they are joined, not opened. Folded categories count too. From
  the thread panel or an open popover (the reaction or emoji palette), the keys stay theirs:
  changing channel would close what the focus is in. Pressed again before the new channel's
  address has loaded, they go on from the channel already asked for.
- `Alt` + `Shift` + `ArrowUp` / `ArrowDown` opens the nearest text channel above or below that
  counts something unread or a mention, wrapping, the one shown left out. With none,
  `console.workspace.shortcuts.announce-no-unread` is said and nothing moves.
- Either way the focus stays where it was, so a member writing keeps writing: the route change
  neither moves it to the page's heading nor announces the page (`src/app/routeFocusHold.ts`, read
  by `RouteFocus`), which a click on a channel still does. Each address is held on its own and let
  go once it has settled or its navigation is over. While the address catches up, the composer is
  read-only, not disabled, since a disabled field drops the focus to the page; nothing is sent and
  `ArrowUp` edits nothing meanwhile. A channel with no composer (archived, still being prepared)
  gives the focus to its heading, rather than to the page. The new channel is said instead,
  through a polite live region of the view, `console.workspace.shortcuts.announce-channel`; the
  same words twice are said twice.
- `ArrowUp` in the channel composer, while it is empty, nothing is being edited and no list is
  open, edits the viewer's newest sent, undeleted message in the channel, as « Modifier » does:
  its text in the field, the caret at its end, and `console.workspace.shortcuts.announce-editing`
  said, since a screen-reader user presses `ArrowUp` to re-read the line. With none, the key is
  the field's.
- `Escape` in the channel's column (its log or its composer), when nothing there used it: cancels
  the edit under way; else the reply under way; else marks the channel read, taking away
  « Nouveaux messages » and the unread mark, and says
  `console.workspace.shortcuts.announce-marked-read`. In a channel with nothing unread and no
  divider, it does nothing. While an input method is composing, `Escape` and `ArrowUp` are its
  own.

The channel composer lists the four channel keys with `aria-keyshortcuts`, at desktop width only;
the other two depend on the field's state.

Runnable acceptance: `npm test -- src/features/espace/EspaceLiveView.shortcuts.test.tsx src/features/espace/shortcuts.test.ts src/app/RouteFocus.test.tsx`. The focus kept in a real
browser: `npx playwright test -c playwright.espace.config.ts tests/espace/layout/shortcuts.spec.ts`,
by hand, as the other layout specs.

### The channel's header

Status: Implemented (gap report G10, reference screen p02 `.ch-head`).

Under a text channel's name, the header's line reads its topic, then how many people are in the
channel (`console.workspace.channel.members-count`, « 18 membres », « 1 membre »), separated by a
« · » that is drawn and not read. The count is the homeserver's (the sync's
`m.joined_member_count`), the member included, so it is right while only some members are loaded;
a sync that carries no count gives the loaded members' count. Kodera's own Matrix accounts are not
people and are never counted: the tenant agent (`kodera-agent`), which creates every channel room
and stays in it, and room-access (`room-access`), joined to every audio room. The agent is taken out
of the homeserver's count even while its member event is not loaded. A channel with no topic shows
the count alone. An audio room's header shows neither: its call dock says who is there.

Right after the line that ends with the count, up to three faces are drawn, at the sidebar's 20 px: first the latest people to write in the channel's
loaded messages, newest first and once each, then, while there are fewer than three, the channel's
other joined members by name. None is the member, someone who left, or one of Kodera's accounts. A
channel where only the member has written still shows who else is in it. The first sync loads only
the members who wrote lately, so when the header shows fewer than three faces and fewer than the
other people it counts, it asks the homeserver for the room's member list, and the faces fill in
when it answers. It asks once per room; only after a failure does opening the room again ask
again. A face shows the initials of the name as written, so two people of one name look the same
there. Someone with no display name, or whose display name is only their id's localpart (the
homeserver gives an account without one its localpart, the identity provider's subject, M1), has
no name: their face is a neutral person glyph, never a character of their id (staging drew « 9 »,
« 9 » and « F »). The faces are decoration (`aria-hidden`), since the count says it in words;
they overlap by `sp-1` and are ringed in `c-surface`. With no one else to show, there are no faces.
A narrow screen keeps the count and drops the faces (p02 drops the whole line).

p02 draws the faces at the header's end, among its actions; the console has none of those actions
yet, and faces alone at the far end read as unrelated to the count, so they sit beside it.

Not drawn, from p02's header: the search field and « Ouvrir un salon ». The console has no message
search, and a text channel has no call to open; each waits for a spec of its own.

Runnable acceptance: `npm test -- src/features/espace/EspaceLiveView.test.tsx src/features/espace/matrix/store.test.ts -t "G10"`.

### The tab's title

Status: Implemented (V1 bar M9).

While the live workspace is open, the tab's title is `console.workspace.live.document-title`
(« Espace — Kodera »). While the member's rooms count unread messages it is
`console.workspace.live.document-title-unread` (« (3) Espace — Kodera »), the count being the sum,
over every joined room, of its unread messages or, for a room counting only mentions, its mentions.
Leaving the workspace gives the tab back `console.common.app-title`. No favicon badge.

Runnable acceptance: `npm test -- src/features/espace/EspaceLiveView.title.test.tsx`.

### Links in messages

Status: Implemented (V1 bar M10).

A web address in a message's text, `http://` or `https://` at the start of a word, is drawn as a
link (`MessageText`, `src/features/espace/MessageText.tsx`). It opens a new tab with
`rel="noopener noreferrer"`, and `console.common.a11y-opens-new-tab` describes it. Punctuation
that ends the sentence, and a `)` the address did not open, stay outside the link. An address the
URL parser refuses, and every other scheme, stay text. No preview is fetched, and the rest of the
message is plain text, which React escapes.

Runnable acceptance: `npm test -- src/features/espace/MessageText.test.tsx src/features/espace/EspaceLiveView.test.tsx -t "web address"`.

### Live thread close focus

Status: Explicit-close focus return integrated with the existing ThreadPanel contract.
Closing a live thread with its close button or unhandled Escape returns focus to the exact
timeline button that most recently opened that root: its reply-count button or surviving
message action-menu trigger, including a root with no replies. A child menu consumes its own
first Escape and leaves the thread open. Targets belong to the current store generation,
viewer, room and root; removing their control or retiring that context releases them without
focusing another audience or introducing fallback navigation. Draft and call behavior is unchanged.

Runnable acceptance: `npm test -- --maxWorkers=1 src/features/espace/EspaceLiveView.test.tsx src/ui/TimelineMessage/TimelineMessage.test.tsx src/ui/ThreadPanel/ThreadPanel.test.tsx`.
The real composed-view predecessor opens the count button from the keyboard, moves focus into
the thread composer, and closes with Escape. Panel disappearance, intended root and the exact
connected opener are positive controls before the focus assertion. Green acceptance covers
both entries and close methods, latest same-root/different-root opener, context/control/root
retirement with surviving controls, and child Escape precedence. The shared native button
provides its concrete currentTarget synchronously for pointer and keyboard activation.

### Quick reactions

Status: Implemented, V1 bar M6. Beside each message's action menu, « Ajouter une réaction »
opens « Réactions rapides »: eight fixed emoji, 👍 ❤️ 😂 🎉 👀 ✅ 🙏 😮, each a button named
« Réagir avec 👍 » and pressed when the viewer has already reacted with it. Picking one toggles
that reaction on the message, closes the palette and returns focus to its button. There is no
picker and no search; a reaction outside the eight still shows and toggles from the message's
reaction row. Thread replies have it too; an archived channel or a deleted message has none.

Runnable acceptance: `npm test -- src/features/espace/EspaceLiveView.test.tsx -t "quick reactions|offers no message menu"`.

### Hearing yourself in an audio room

Status: Implemented, W2 audio feedback, part one: the meter and the speaking ring (the device panel
is part two). zôÖma could not tell whether their microphone worked in « détente », though their
sound was reaching the room.

**The meter.** In a call that is through, with the microphone on, a thin bar under the dock's state
draws the member's own microphone level, frame by frame: empty at -60 dBFS, half full at -30, full
at 0, so speech fills about half of it. It is read in this browser, from the call's own capture,
so it moves when the member is alone in the room. It is empty, and nothing is read, while the
call is connecting or reconnecting, while the microphone is off or being turned off, while deafened
and while listen-only. The bar is decoration (`aria-hidden`): the mute toggle already says whether
the member is heard. It is `c-on-inverse` on a `c-action-hover` track, in the dock's own tones.
The fill is scaled, not sized, so a frame moves no layout, and nothing re-renders at the voice's
pace.

**Privacy.** The level is read from the very track the call publishes, never a copy: a copied track
would keep the microphone, and the browser's recording indicator, on after the call stops its
capture. The analyser is connected to nothing that plays, so the member never hears themselves.
Each call has its own audio context, made from the join's click (a context made later may start
suspended and read silence) and closed with the call; one the browser suspends later (iOS, when the
microphone switches its audio session, or a page in the background) is asked to resume. A browser
without Web Audio, a context that will not start, or a capture it cannot read (Firefox refuses one
at another sample rate, tried once rather than on every frame) joins all the same, with a still
meter.

**Speaking.** In the sidebar, under the audio room the member is connected to, whoever speaks has
their face ringed in `c-ok`. The member's own face follows their microphone, read here: it rings
while their level is at -34 dBFS or above (RMS 0.02), and for 300 ms after, so it does not flicker
between words, and it rings when they are alone in the room. It never rings muted, being muted,
deafened, listen-only, connecting or reconnecting. The others' faces follow the call's speakers,
as LiveKit names them, and none rings while the call reconnects, when that list is stale. A ring is drawn, not read: who speaks is not announced. Rooms the member is
not in ring no one, since who speaks reaches only the people in the call. This deviates from the
design of record, whose sidebar has no speaking indicator (`design specification`
`design/reference/README.md`, the room row): the W2 plan, newer and confirmed by zôÖma, asks for a
ring that works alone, and the sidebar is the only place a call is drawn until a call view exists,
which may take the ring over.

**Why the microphone is off.** When the microphone will not turn on, the member stays in the call,
muted, and the sidebar says why, from what the browser answered:
- refused, to this site or by the system's privacy settings, which browsers report the same way
  (`NotAllowedError`): « Le micro est bloqué pour ce site ou par votre système. Autorisez-le, puis
  réactivez-le. » (`console.workspace.audio.problem-microphone-denied`);
- none found (`NotFoundError`): « Aucun micro n’est détecté. Branchez-en un, puis réactivez-le. »
  (`…problem-microphone-missing`);
- held by another application (`NotReadableError`): « Votre micro est utilisé par une autre
  application. Fermez-la, puis réactivez-le. » (`…problem-microphone-in-use`);
- anything else keeps « Votre micro est inaccessible… » (`…problem-microphone`).

Unmuting tries again, and a microphone that turns on clears the message.

Runnable acceptance: `npm test -- src/features/espace/audio/call.test.ts src/features/espace/audio/meter.test.ts src/features/espace/useMicActivity.test.tsx src/ui/AudioDock/AudioDock.test.tsx src/ui/RoomRow/RoomRow.test.tsx src/ui/Avatar/Avatar.test.tsx src/features/espace/EspaceLiveView.test.tsx -t "microphone|meter|Meter|hears themselves|useMicActivity|meterFill|level|rings|speaking|glyph"`.

### Choosing the microphone and the output

Status: Implemented, W2 audio feedback, part two.

In a call, a « Réglages audio » button in the dock (`console.workspace.audio.action-settings`, two
sliders, named and not drawn in words) opens a panel anchored to it, not modal. It holds:
- « Micro » (`label-input`): « Par défaut du système » (`option-default`), then every microphone
  the browser lists, by its name. A browser that has not been granted the microphone names none,
  so each reads « Micro 1 », « Micro 2 »… (`option-input-unnamed`).
- « Sortie audio » (`label-output`), the same for speakers and headsets (`option-output-unnamed`).
  A browser that cannot choose where a page's sound plays (no `setSinkId`, as in Safari) shows
  « Votre navigateur joue le son sur la sortie du système. » (`label-output-unsupported`) instead
  of the list.
- « Niveau du micro » (`label-input-level`) over the same meter as the dock's, read the same way
  (« Hearing yourself in an audio room »): it moves as the member speaks, and is empty muted.
- « Tester le son » (`action-test-sound`): a short tone, under a second, played on the output
  shown, which is the one the call plays on. It never goes into the call: it is made in this page
  and played there. A tone that cannot play there (an output gone) says « Le son de test n’a pas
  pu être joué sur cette sortie. Choisissez-en une autre, puis réessayez. » (`problem-test-sound`),
  until another output is chosen or the panel opens again.

The lists follow the browser: a device plugged in or out while the panel is open is added or
removed. A choice applies at once, in the call: a new microphone is captured in place of the old
one, and the call's sound moves to the new output. It is remembered in this browser
(`localStorage` `console:audio-devices`, the two device ids the browser gives this site), so the
next call starts with it. Storage that refuses the write keeps the choice for this page only.

A remembered microphone that is not plugged in when the capture starts, at a call's start or on
an unmute (`OverconstrainedError` or `NotFoundError` for that device), is not an error: the call
takes the system's default microphone, the « Micro » field shows the default with « Le micro
choisi n’est pas branché : celui par défaut est utilisé. » (`label-input-missing`) as its
description, and the choice is kept for the next call. Plugged back in meanwhile, it is listed,
and the field still shows the default until the member picks it again. No microphone at all says
so (`problem-microphone-missing`), without that description. The default is always asked for by
name: the call never captures a device chosen in an earlier call once the member has chosen the
default. A remembered output that is gone plays on the default output the same way.

A microphone the member chooses that will not start says why, as unmuting does (« Hearing
yourself in an audio room »), and the call goes back to the one it had; when that will not start
again either, the member is muted, saying why. The field shows the microphone picked at once, and
the call's own once the switch settles. One picked while the capture was starting (a permission
prompt open) is the one the call captures once it has started.

Runnable acceptance: `npm test -- src/features/espace/audio/devices.test.ts src/features/espace/audio/call.test.ts src/features/espace/AudioSettings.test.tsx src/ui/AudioDock/AudioDock.test.tsx -t "device|Device|output|input|settings|test sound|tone"`.

## Draft continuity across organisation modules

Status: Draft continuity contract.

Within one currently admitted tenant Core lifetime, organisation and Matrix
registration, an unsent channel draft survives permitted module navigation and
return. Reply/edit/thread targets remain qualified by their original room.
A fresh view-owned Matrix store on return does not alone invalidate that draft.

The admission predicate binds the captured AuthProvider lifetime and Core
retirement stamp, current tenant issuer/subject and realm, accepted membership
and workspace organisation, Matrix registration stamp and current-person
localpart/server-name mapping, and the current store/view lease. Usable
credential rotation suspends access until matching loader acceptance. Terminal
Core or Matrix boundaries permanently retire old memory and commands, including
coalesced unusable-to-usable or same-object clear/re-registration.

This increment retains draft data only in memory. It retains no store,
controller, transport token, DOM reference or media owner across outlet removal.
The existing live-call leave confirmation and controller cleanup remain:
Cancel preserves the current call; Confirm ends it during departure. Returning
does not automatically send, join, reconnect or activate capture.

`returns_channel_draft_after_module_navigation` exercises the actual
organisation loader, workspace and People routes, view, Matrix SDK and store
against a finite synthetic protocol. Before the intended predecessor failure,
it establishes joined-room/current-person readiness, types and observes a
draft, commits departure and observes the old store stopping, then commits Back
with a fresh store in the same Matrix session. The draft must still match
exactly, with no send or implicit join. The predecessor's named semantic
failure is `DraftLostAcrossModuleNavigation`; setup, import, protocol,
cleanup, act or unhandled errors do not qualify.

Runnable acceptance lives in `EspaceDraftProvider.test.tsx` (ten composed
functions, thirteen cases), `AuthProvider.test.tsx` (three lifetime functions)
and `matrix.test.ts` (four registration/sign-out functions): seventeen functions
and twenty cases in total. The composed cases cover module continuity, room and
thread targets, synchronous terminal retirement before external observers,
temporary suspension during usable rotation or status-only pending, repeated
public identity, silent command-time expiry, unchanged live-call departure,
StrictMode/history cleanup and absence of durable or diagnostic draft effects.
The command-time expiry witness is `ExpiredDraftOwnerIssuedCommand`.

The implementation keeps the memory owner above the organisation outlet. Each
committed room/store view receives a disposable lease; detached handlers cannot
read, overwrite or send through a replacement view. The imperative gateway
checks current authority again at effect time, including credential expiry that
arrives without a notification. Map updates and the current store handoff occur
synchronously before notifying draft observers. Usable credential rotation hides
draft access until the real current-user loader accepts the new credential; it
does not extend the call or store lifetime. Existing transport consumption may
continue in an already mounted view under its existing media policy, while a new
view requires current accepted authority. Wrong tenant/person, workspace, Matrix
registration or current-store viewer cannot enter the provider's standalone
fallback.

## Changelog

- The phone's tab bar (gap report G11, reference screens p01 and p02): on a phone the workspace
  draws the rail's places as a tab bar of its own, « Modules »: « Accueil », « Messages » and the
  tenant's other applications. A person on a phone reaches Visio or Docs from the workspace, which
  had only a way back to the console. That way back moves from the top bar to the tab bar's
  « Accueil », and the top bar keeps the maker's mark. No new copy.

- Keyboard shortcuts (workspace audit item 11), as in Discord: `Alt` + arrows to the channel above
  or below, `Alt` + `Shift` + arrows to the next unread one, `ArrowUp` in an empty composer to
  edit your newest message, and `Escape` to cancel an edit or reply, else to mark the channel
  read. Four new keys under `console.workspace.shortcuts.*`.

- Emoji in the composer (workspace audit item 4): a known « :nom: » becomes its emoji as it is
  typed and again on sending, so the stored body carries the emoji; « : » and two letters open a
  list of matching emoji like the member list; and « Insérer un émoji » opens a palette of 32.
  Received text is never reinterpreted. Four new keys under `console.workspace.composer.*`.

- A message's actions (the reaction palette and « ··· ») show on hover, on keyboard focus and
  while a menu is open, and are faded out the rest of the time, keeping their space so the text
  never moves. A screen with no hover, or forced colours, always shows them
  (`espace-message-actions.md`).

- A short channel's messages rest on the composer, the newest nearest the field, instead of
  sitting at the top of the log with the empty space under them. A long log still scrolls back to
  its start. Proven in a real browser over a fake store (`tests/espace/layout`).

- Choosing the microphone and the output (W2 audio feedback, part two): a « Réglages audio »
  panel in the call dock with the microphone and output lists, the meter and « Tester le son »;
  the choice applies at once, is remembered in this browser, and a remembered device that is not
  plugged in falls back to the default. Eleven new keys under `console.workspace.audio.*`.

- Hearing yourself in an audio room (W2 audio feedback, part one): a microphone meter in the dock,
  read in this browser from the call's own capture, so it moves alone in a room; a speaking ring on
  the faces under the room the member is in, their own from that meter; and three new reasons the
  microphone is off, refused, missing or in use. Three new keys under `console.workspace.audio.*`.
  The channel's header draws its faces beside the count, and a person glyph for someone with no
  name rather than a character of their id.

- The channel's header shows the faces of members who never wrote: after the latest people to
  write, the other joined members fill the three faces by name, and the header asks for the room's
  member list when the first sync did not bring them. On staging, #général read « 4 membres » with
  no faces, because only the member had written there.

- The channel's header (gap report G10): a text channel's line reads the topic, then its people
  from the homeserver's count (« 18 membres »), beside up to three faces of the latest people to
  write. Kodera's own accounts are never counted, shown or offered to mention. One new key,
  `console.workspace.channel.members-count`.

- The composer's tools (gap report G9, reference screen p02): the field above a row with
  « Mentionner », which writes « @ » at the caret and opens the member list, and « Envoyer » with its
  glyph. One new key: `console.workspace.composer.action-mention`.

- Who is typing (gap report G9): a polite line under the log names one or two people writing
  in the channel, « Plusieurs personnes » for more, from the homeserver's `m.typing`; the composer
  tells the room while a new message is written. Three new keys under `console.workspace.channel.*`.

- A workspace whose tenant is being prepared (quick-workspace SPEC W2): the tenant is read with
  the workspace, its slug finds the homeserver and the session, and while it is prepared the
  channels are greyed under « Votre espace se prépare » and nothing starts a sign-in. Channels
  whose room is not `ready` are greyed in every case, audio channels are named in the sidebar, the
  starter audio channel is « détente », and the first automatic sign-in comes back to `#welcome`.
  A suspended or removed tenant offers no way in; an `ordered` tenant is read every minute.
  Two new keys: `console.workspace.channel.lounge`, `console.workspace.setup.banner-preparing`.

- The log's day dividers and « Nouveaux messages » (gap report G9, reference screen p02): a
  divider at each calendar day in Paris time (« Aujourd’hui », « Hier », « Lundi 2 novembre »),
  and a marker above the first message someone else wrote since the member last read the room,
  kept in place for the visit. Three new keys under `console.workspace.channel.*`.

- The way in speaks of Messages, as the rail does (gap report G7). « Ouvrir les messages » and
  « Ouvrez vos messages pour lire et écrire dans vos salons. » replace « Ouvrir Espace » and its
  sentence, and the invitation's « Ouvrir Espace » becomes « Ouvrir les messages » too. An
  automatic start is drawn as « Ouverture de vos messages… » with a busy button from the first
  draw: one new key, `console.workspace.channel.body-opening`. The two lines that say why the way in
  failed name « La messagerie » instead of « Espace », since they sit above « Ouvrir les messages ».
  Where Espace is not offered, the pane no longer promises a later release. The sign-in to Synapse still leaves the page and comes
  back; making it silent needs Core or the realm, not the Console.

- The rail's item for the workspace is « Messages », as on the reference screens (gap report G6),
  and the phone's way back from the workspace is « Accueil ».

- The column's head (gap report G8, reference screen p02): the organisation's tile with its
  initials, name and slug, which is the organisation switch for a person in two organisations or
  more, and « Rechercher » with `Ctrl K`, a jump to a channel or an audio room by its name (§4.1,
  §10, acceptance 11–13). The « Salons » heading is now visually hidden; it still names the `nav`.

- Member arrival (gap report G5): a member of an organisation with no tenant yet is offered the
  rail's « Espace » and lands on it (§3). While Core waits for the owner's confirmation, only the
  owner is told so; anyone else reads that setup is under way (§4.3), not that they are being
  confirmed as owner. The reference screens' « Messages » label waits for the
  wider rail item they use (gap report G6): at the current item width it does not fit.

- V1 bar M6: quick reactions, a fixed palette of eight emoji beside each message's action menu
  (« Quick reactions » above).

- Links in messages (V1 bar M10): http and https addresses open in a new tab, with no opener, no
  referrer and no preview. No new key: `console.common.a11y-opens-new-tab` is reused.

- The tab's title (V1 bar M9): « (3) Espace — Kodera » while the member's rooms count unread
  messages, « Espace — Kodera » otherwise. Two new keys, `console.workspace.live.document-title`
  and `console.workspace.live.document-title-unread`.

- Reading a channel clears its unread mark: the store's `markRead` was never called. The channel
  on screen sends its read marker while the page is visible.

- Mentions (V1 bar M8): « @ » in a composer offers the room's members, the message carries the
  named members in `m.mentions`, and a message that mentions the viewer is marked. Two new keys,
  `console.workspace.composer.label-mention-list` and
  `console.workspace.message.label-mentions-you`.

- Espace item M3: history pages back on scroll, the log opens and stays at the newest message, the
  member's place is kept, and the log's top says whether more, loading, a failure or the start.

- UX audit item 4, interim: a resolved room the member's sync does not hold reads « Vos salons
  arrivent… » instead of « Vous n’êtes pas membre de ce salon », in the channel pane and on the
  audio row. Core joining the member to the rooms is the real fix.

- Release preparation: on a phone, where the surface has no tab bar, the top bar leads back to
  the console (§4.2, acceptance test 10), and a unit check refuses any rail surface that hides the
  tab bar without that way back. No new copy: the link reuses the rail's « Console ».

- Owner decisions and review: the workspace is its own surface, « Espace » on the rail
  (unreleased), with its own layout; a member who may not create it is told it has not been
  created yet, polled every 60 s; a stopped setup quotes a request id as such and no longer
  passes it to Aide as a job reference; one live region for state changes; the drawer hands focus
  to the heading; a failed read after a creation offers to read again; no retry on a `404`.

- First version, with Core contract 0.13.0: the workspace sidebar and channel pane, the setup
  states and the create action, kept out of the navigation.

## Structural workspace and online presence

Status: Implemented.

The phone workspace tab bar offers Home, Messages and the tenant's other applications. The channel composer keeps its text and icon controls on one row. The loaded start of a channel shows a welcome block, timeline faces are 40 px with stable per-member token tones, the member panel opens from the channel header, and the sidebar header omits the organisation slug. Empty audio rows keep their occupancy in their accessible name but draw no count. Voice member rows and non-current channel rows use the workspace roles. Thread replies use a muted composer and icon submit control. Mute and deafen keep fixed labels with aria-pressed; dock separators use a non-breaking space.

Presence is drawn only from m.presence events in this store session, never from a separate request. Online or currently_active draws a success-role dot ringed against the surface; unavailable and offline draw no dot. The face's accessible name gains the catalogue's online suffix.

The panel groups loaded members by room power level (50 and above under administration); it asks for the member list when opened.

New copy keys: `console.workspace.members.admins`, `console.workspace.presence.online`, `console.workspace.members.title`, `console.workspace.channel.welcome-title`.

The proximity panel (« Autour de moi ») is mounted only above a channel the server flags as the organisation's proximity room, never because of a channel's name; Core flags no channel yet, so the product mounts no panel. Without a proximity transport the panel is one line, « Non connecté », and offers nothing to send: the relay is in development. The channel header carries no integration drawers. Polls and other timeline inserts are drawn at their own time between messages, not after them.

New copy keys: `console.workspace.channel.create-in-category`, `console.workspace.layout.resize-channels`, `console.workspace.layout.resize-side-panel`, `console.workspace.canvas.mode-label`, `console.workspace.canvas.mode-chat`, `console.workspace.canvas.mode-docs`, `console.workspace.members.online-count`, `console.workspace.members.state-online`, `console.workspace.members.state-offline`, `console.workspace.emergency.title`, `console.workspace.emergency.state-disconnected`, `console.workspace.emergency.state-connected`, `console.workspace.emergency.disconnected-body`, `console.workspace.emergency.message-label`, `console.workspace.emergency.message-placeholder`, `console.workspace.emergency.actions-label`, `console.workspace.emergency.status-safe`, `console.workspace.emergency.status-assistance`, `console.workspace.emergency.status-muster`, `console.workspace.emergency.status-note`, `console.workspace.emergency.sent`, `console.workspace.emergency.roster-count`, `console.workspace.emergency.roster-show`, `console.workspace.emergency.roster-hide`, `console.workspace.emergency.roster-label`, `console.workspace.emergency.local-name`.
