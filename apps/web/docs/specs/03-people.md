# 03 — People

**Status:** Proposed · **Owner:** zôÖma

## 1. Goal

Get 120 colleagues into the organisation's space — by email, by spreadsheet, or by scanning a
code on a site hut — and let the person in charge promote, demote, or remove any of them
afterwards.

## 2. Persona and the "can the CEO do this alone" test

**Who.** The office manager, more often than the CEO. They hold the staff list in a spreadsheet
exported from the payroll tool. A quarter of the people on it have no company email address.
Some are on site all week and will never open a laptop.

**Alone test: pass**, on five conditions.

1. Pasting a column of email addresses works. The primary invitation input accepts addresses
   separated by commas, semicolons, spaces, or newlines, because that is what a paste from a
   spreadsheet produces.
2. The CSV path never rejects a whole file. It shows a preview with the valid rows, the
   duplicates, and the invalid rows separately, and lets the person import the valid ones and fix
   the rest afterwards.
3. Roles are described by what they can do, not by their name. "Administrateur — peut inviter
   et retirer, sans accès à la facturation" sits next to the choice, always.
4. The on-site path produces one printable sheet with a QR code that a foreman can pin in the
   site hut. The console explains, in one sentence, that the code expires and that the first
   person to use it claims that place.
5. Removing someone is one clear confirmation that spells out the consequence ("Marc Petit ne
   pourra plus utiliser la console", and that Visio and Docs are not cut yet, §4.5) and never
   asks the person to retype anything.

**Where it still fails.** Bulk role assignment from the CSV (a `role` column) is supported, but
bulk *changes* of role afterwards are not; a person changing 30 roles does it 30 times. Recorded
as a known gap, planned after launch.

## 3. Entry points

| Entry | URL |
|---|---|
| Navigation "Personnes" | `/{org}/people` |
| Invitation drawer | `/{org}/people/invite` |
| CSV import | `/{org}/people/import` |
| Import result | `/{org}/people/import/{importId}` |
| Pending invitations tab | `/{org}/people?tab=invitations` |
| On-site enrolment | `/{org}/people/on-site` |
| From the order confirmation | `/{org}/people/import?from=order` |
| From the status screen "Préparer la liste" | `/{org}/people/import?from=status` |
| Direct link to a person | `/{org}/people/{memberId}` |

## 4. Screens

### 4.1 `list` — members

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│  Personnes                                                          (h1)      │
│  118 personnes · 4 invitations en attente                                     │
│                                                                               │
│  [ Membres (118) ][ Invitations (4) ][ Accès sur site (1) ]                   │
│                                                                               │
│  [ 🔍 Rechercher un nom ou un e-mail      ]  [ Rôle ▾ ]   [ Inviter ▾ ]       │
│                                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐    │
│  │ Nom                 E-mail                 Rôle           Dernière    │    │
│  │                                                            connexion  │    │
│  ├───────────────────────────────────────────────────────────────────────┤    │
│  │ MD Marie Dupont     marie.dupont@acme.fr   Propriétaire    aujourd'hui│ ⋯  │
│  │ JL Julie Leroy      julie.leroy@acme.fr    Administratrice il y a 2 j │ ⋯  │
│  │ CB Camille Bernard  camille@acme.fr         Facturation     il y a 5 j │ ⋯  │
│  │ MP Marc Petit       marc.petit@acme.fr     Membre          il y a 31 j│ ⋯  │
│  │ SB Samir Benali     —                      Membre          jamais     │ ⋯  │
│  │    (accès sur site)                                                   │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
│                                              [ Afficher 25 de plus ]          │
└───────────────────────────────────────────────────────────────────────────────┘
```

Row menu (`⋯`): an owner may choose "Rendre propriétaire", "Rendre administrateur",
"Donner accès à la facturation" or "Rendre membre"; an administrator may move only between
administrator and member. "Renvoyer l'invitation" appears for a pending invitation, followed by
"Retirer de l'organisation" when the caller may remove that role. The current role is omitted.

Components, in the design-system vocabulary of `COMPONENTS.md`: `Table` (32 px circular avatars
— slate for administrators, cobalt for members, dashed for a pending invitation — with the email
column ellipsised and a fixed status column), `Status pill`, `Button` (primary, one per screen),
`Banner` (the federation nudge), `Empty/loading/confirm`.

Console primitives that carry them: `Tabs`, `TextField` (search, debounced 300 ms), `Select`
(role filter), `Button` with menu ("Inviter par e-mail", "Importer un fichier", "Créer un accès
sur site"), `DataTable` with `Avatar`, `Badge` (role), `StatusPill` (never connected / on-site),
row menu, `Pagination` as a cursor "load more", `EmptyState`, `Skeleton`.

Filters are the three of the delivered design — Toutes · Admins · En attente — rendered as
`Tabs`, and the subtitle counts the same three groups from `memberships/count`, one call per
group, never summed in the browser.

**The federation nudge.** When no federation provider is active and the organisation's
entitlements include `federation`, the list carries one informational `Banner`: letting existing
accounts sign in removes the invitation problem altogether, and someone who leaves the company
loses access at the same time. It links to Domaine & identité, the "Connexion (Google /
Microsoft)" tab (`07-federation.md`). It appears once per screen, never as a modal, and it is
dismissible for the session.

When a provider **is** active, the same slot carries the reverse note: accounts arrive from the
provider, inviting stays available for people outside it, and removing someone is worded as
withdrawing access rather than deleting them.

### 4.2 `invite` — by email (drawer)

```text
┌── Inviter des personnes ──────────────────────────────────── [×] ──┐
│                                                                    │
│  Adresses e-mail                                                   │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ julie.leroy@acme.fr, marc.petit@acme.fr                      │  │
│  │ samir.benali@acme.fr                                         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  Séparez-les par une virgule, un point-virgule ou un retour à la   │
│  ligne. Vous pouvez coller une colonne depuis un tableur.          │
│                                                                    │
│  3 adresses reconnues · 0 en double · 0 invalide                   │
│                                                                    │
│  Rôle                                                              │
│  (•) Membre — peut participer aux réunions et aux documents        │
│  ( ) Administrateur — peut inviter et retirer, sans facturation    │
│  ( ) Facturation — peut consulter et payer, sans gérer les accès   │
│                                                                    │
│  Message (facultatif)                                              │
│  [                                                              ]  │
│                                                                    │
│  [ Envoyer 3 invitations ]                        [ Annuler ]      │
└────────────────────────────────────────────────────────────────────┘
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Text field` (multi-line, one
address per line, with per-line validation and duplicates flagged), `Button` (primary, the label
carries the count), `Banner` on the result.

Console primitives that carry them: `Drawer`, textarea-style `TextField` (multi-line, chips
rendered on blur), live counter in a polite region, `RadioGroup` (role, with the description
inline), `TextField` (message), `Button` (label carries the count), `Button` (secondary).

**The invitation is valid for 14 days**, and the field's help text says so before the
invitation is sent, not only in the email: Core sets `expires_at` to 14 days after it is issued,
and its mail states that date (Core's `docs/specs/INVITATIONS.md` §2 and §1 step 3). No invitation
exists yet when the drawer is open, so the help text carries Core's number and does not read it.
The realm's account set-up mail, sent before it to an account not set up yet, holds a link that
lives 72 hours; that is the number `08-home.md` uses, from the last send, to decide when an
invitation has been waiting too long.

The billing choice is rendered only for an owner. An administrator sees member and
administrator only. Owner is never assigned from the invitation drawer or a spreadsheet: an
owner promotes an active member from the detail drawer, with a confirmation that states the
contractual and deletion authority being granted. These are UI safety constraints on top of the
Core API rules in ADR-0010.

#### Unsent invitation recovery

Status: Approved D2 behavior implemented; current-head acceptance and integration are required.

Only an unsent invitation's raw address text, selected invitation role and open flag may cross
an explicit reconnect or an expired same-realm Browser Back sign-in in the same tab. The
versioned invitation-purpose `sessionStorage` slot binds processed SDK issuer and subject to
immutable organisation, Core identity and active membership IDs. It lasts less than ten minutes
from saving, rejects future timestamps, and permits at most65536 UTF-8 text bytes. It stores
no credential, MFA value, CSV upload, batch result, error or arbitrary form field. Existing
address parsing and200-address validation apply only on deliberate sending.

The route captures the authentication generation alongside its authoritative `/me` response.
Ready authentication, a live credential, matching current generation, unique active Core
identity/membership and current owner/admin permission establish ownership before reading or
reopening. The same verified owner may return through a new generation. Changed ownership,
permission or forbidden saved role discards the slot. The People list destination reached by
actual expired Browser Back may reopen this saved drawer; unrelated areas are never redirected.
The mounted drawer may save its last committed owner after that same session expires, before
an awaited guard can unmount it. Initial login, realm switching, ordinary navigation and logout
do not save drafts.

Reading does not consume during render. Consumption follows committed restoration of that
exact serialized snapshot, cancels abandoned effect setup, and compares the current slot before
removal so a newer snapshot survives. Context replacement resets private drawer state. A
current-document consumed-snapshot marker prevents an ordinary close from reopening a snapshot
whose removal is denied; it is not a cross-document persistence or ownership authority.

Starting any real invitation batch or malformed-only batch outcome permanently excludes that
operation from recovery, before nonce allocation or Core contact. Pending, partial, rejected,
quota, network-uncertain and invalidation/result gaps stay excluded even after editing. Existing
in-page retry payload/key behavior is unchanged. Restoration allocates no nonce, sends no
request and never submits automatically.

Removal failure may invalidate the same feature slot with JSON `null`, which the strict reader
refuses. No alternate store is used. If both removal and invalidation fail, deliberate sending
stops as local validation before any nonce, Core request or batch outcome; the existing send
failure alert leaves editing and sign-in usable. A committed read cannot overwrite an intervening
newer snapshot when a storage read fails. Get/set/remove errors never expose exception details or
private fields. Global auth-storage denial remains the existing OIDC/return-to limitation.
Success and explicit logout clear recovery; expiry, corruption and mismatched ownership refuse it.
There is no user-facing restoration guarantee, attempted-operation reconciliation or general form
recovery. Existing Order retention and purchase holds remain unchanged.

#### Invitation outcome and consumed receipt

Status: Invitation feedback distinguishes local refusal, an unconfirmed request and a
confirmed result whose screen finalization failed. This does not change invitation roles,
server authority, unsent recovery or provider delivery.

The local recovery-slot refusal still stops before nonce allocation and Core contact. After
an actual request, network, numeric 5xx, raw JSON/body-reader failures and malformed resolved
bodies are outcome-unconfirmed. They never prove zero invitations or a successful count. The
same original addresses and role reuse their existing intention key on deliberate retry;
editing remains possible and a deliberate changed payload is a new intention. No automatic
POST, field restoration or cross-remount retry history is introduced. Copy warns that the
current fields may have changed from the original addresses AND role.

A body is consumed only when its finite nonnegative integer counts are each at most the number
of submitted VALID rows, its results contain exactly one object row per submitted address in
submission order with case-insensitive correlation and no duplicates, its outcomes belong to
the closed result set, and its counts agree with the created/skipped/failed categories and row
count. Locally malformed addresses remain separate. A created row with invitation:null is
valid; unused optional invitation/detail/seat fields are not mandatory. The existing mutation
wrapper exposes body only: this is no claim of full schema, HTTP metadata or email delivery.
Malformed success bodies retain the original intention key and cannot produce a success callback.

The drawer owns one finite intention and confirmed receipt. A synchronous invocation guard
precedes external submission tracking. Only that invocation may discharge its key or clear its
busy state. Consumed confirmation and callback-attempt markers precede external result tracking,
toast and completion callbacks. A synchronous finalization error cannot turn known confirmation
into an unknown POST, a zero-count assertion, a fresh-key replay of that settled payload or a
repeated callback. This fallback preserves the current edited draft. Its settled-payload block
applies only to finalization failure; normal partial/all-rejected retries still send only their
retryable subset under a new deliberate intention, and a changed deliberate intent supersedes
the one local fallback. A zero-created receipt confirms its outcome, never a positive created count.

Mounted invocation, committed organisation/caller and the accepted auth generation/realm/optional
processed identity fence every awaited continuation and shared effect, with fresh checks after
external callbacks. Auth owner/status loss and committed context replacement retire work even
if that tuple later returns. Credential-only rotation under the same ready owner preserves a
legitimate receipt. Optional recoveryOwner is not an ordinary sending prerequisite. Dismissal
stays usable and retires local work; it does not cancel or undo a POST already issued. Obsolete
continuations cannot announce/navigate into a new owner or release its newer flight.

Before a consumed receipt, numeric 5xx is unknown BEFORE problem-type checks, including a reply
carrying quota type. Exact 409 quota-exceeded keeps the existing seat/support message. Every
other 4xx, including unregistered responses, uses neutral refusal copy without zero-count or retry
assurances. The existing 4xx key lifecycle is unchanged and deferred; do not infer that every 4xx is a
cached final response or that an in-flight request takes a new key. After a consumed receipt,
its known outcome takes precedence over the class of any later processing exception. Default query invalidation catches individual
list/count refetch errors; those reads do not undo a valid batch receipt.

Acceptance uses the real drawer/Core client/QueryClient/MSW boundary, completed stateful effects
and independent invitation/membership reads before semantic assertions, plus real response-body,
receipt correlation, reentry, callback, context retirement and credential-rotation controls.
Core Main currently has no implemented batch-invitation/accept endpoint or outbox caller.
These client/MSW checks qualify the model and declared contract only; the fixture's linked
invited membership is bookkeeping, not a real POST membership-lifecycle guarantee. Generic
Core replay scope also binds verified issuer/subject/method/path, not merely the model's
organisation/key pair. Backend token, pending-person, redemption/resend and retention contracts
remain unresolved; approved account pricing is unlimited and no seats-included capacity cap is
introduced here. This establishes no live Core/SMTP, native geometry or full settings readiness.

### 4.3 `import` — CSV

Step 1, upload:

```text
┌───────────────────────────────────────────────────────────────────┐
│  Importer une liste                                       (h1)    │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐    │
│  │        Déposez votre fichier ici, ou [ Parcourir ]        │    │
│  │        CSV · 5 000 lignes maximum · 2 Mo                  │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                   │
│  Votre fichier doit contenir une colonne d'adresses e-mail.       │
│  Les colonnes prénom, nom et rôle sont facultatives.              │
│  Le fichier est supprimé par le serveur dès qu'il est lu.          │
│  [ Télécharger un modèle ]                                        │
└───────────────────────────────────────────────────────────────────┘
```

Step 2, mapping and preview:

```text
│  Nous avons trouvé 124 lignes.                                    │
│                                                                   │
│  Colonne du fichier        →  Champ                               │
│  "Adresse mail"            →  [ E-mail          ▾ ]               │
│  "Prénom"                  →  [ Prénom          ▾ ]               │
│  "Nom"                     →  [ Nom             ▾ ]               │
│  "Service"                 →  [ Ignorer         ▾ ]               │
│                                                                   │
│  ✅ 118 prêtes à être invitées                                    │
│  ⚠  4 déjà membres — elles seront ignorées                        │
│  ⚠  2 adresses en double dans le fichier — une seule sera gardée  │
│  ❌ 0 adresse illisible                                            │
│                                                                   │
│  [ Voir le détail ligne par ligne ]                               │
│                                                                   │
│  Rôle attribué : (•) Membre  ( ) Administrateur  ( ) Facturation* │
│  [ Inviter 118 personnes ]              [ Annuler ]               │
```

`*` Facturation is visible only to an owner. An administrator can import members or
administrators; an owner value from a role column is rejected rather than silently downgraded.

Step 3, result (partial failure is the normal case):

```text
│  114 invitations envoyées                                         │
│  ❌ 4 n'ont pas pu être envoyées :                                 │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │ ligne 42  jean.martin@acme..fr   Adresse invalide         │     │
│  │ ligne 77  s.benali@acme.fr       Boîte inexistante        │     │
│  │ ligne 91  contact@acme.fr        Invitation déjà envoyée  │     │
│  │ ligne 103 pierre@                Adresse invalide         │     │
│  └──────────────────────────────────────────────────────────┘     │
│  [ Réessayer les 4 lignes ]   [ Télécharger les lignes en échec ] │
│  Ces lignes seront supprimées à l'échéance indiquée ci-dessous.    │
```

Components: `FileDrop`, `Table` (mapping, with `Select` per column), summary as four counted
`InlineAlert` lines, `Drawer` (row-by-row detail), `RadioGroup`, `Button`,
`ProgressList` (during send), result `Table` with per-row reason, `Button` (retry the failed
subset only), `Button` (download failures as CSV).

The raw upload is gone before the mapping screen renders. The console reads
`staging_expires_at` and shows the remaining retry window on preview and partial-failure states.
On `completed` or `discarded`, `filename` is null and `rows` is empty; the result screen renders
the durable counts only. Downloading failures creates a file locally from the retryable rows
already displayed and never asks the server to retain a second export.

### 4.4 `on-site` — enrolment codes

```text
┌───────────────────────────────────────────────────────────────────┐
│  Accès sur site                                           (h1)    │
│  Pour les personnes sans adresse e-mail professionnelle.          │
│                                                                   │
│  Comment ça marche                                                │
│  1. Vous créez des places (par exemple 12).                       │
│  2. Vous imprimez la feuille et vous l'affichez.                  │
│  3. Chaque personne scanne le code avec son téléphone et          │
│     enregistre son empreinte ou son visage. Une place par         │
│     personne.                                                     │
│  4. Le code expire à la date et à l'heure imprimées sur la feuille.│
│                                                                   │
│  Combien de places ? [ 12 ]     Rôle : Membre                     │
│  [ Créer 12 places ]                                              │
│                                                                   │
│  ┌── Feuilles actives ────────────────────────────────────────┐   │
│  │ Créée aujourd'hui · 12 places · 5 utilisées · expire       │   │
│  │ demain à 9 h 12                                            │   │
│  │ [ Imprimer ]  [ Voir le code ]  [ Désactiver ]             │   │
│  └────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
```

Print sheet (a dedicated print stylesheet, one page):

```text
┌───────────────────────────────────────┐
│   ACME Construction                   │
│   Rejoignez la visio de l'entreprise  │
│                                       │
│         ┌─────────────┐               │
│         │ ▚▚▚▚▚▚▚▚▚▚▚ │               │
│         │ ▚▚  QR  ▚▚▚ │               │
│         └─────────────┘               │
│   ou saisissez : acme.kodera.io/j  │
│   code : 7K4P-92MB                    │
│                                       │
│   Valable jusqu'au 5 mars, 9 h 12     │
│   Une place par personne.             │
└───────────────────────────────────────┘
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Card`, `Stepper` (the four
steps), `Text field` (count), `Button`, `Table` (active sheets), `Copy-value block` (the short
code), `Empty/loading/confirm` (the deactivation dialog).

Console primitives that carry them: `Card`, ordered list (the four steps), `TextField` (count),
`Button`, `Table` (active sheets), `QrPanel` (**new component**, and one the design drop does
not define — see the design gaps in `README.md`), `Button` (print), `ConfirmDestructive`
(deactivate), `CopyableCode` (the short code).

**A sheet's token lives until its `expires_at`, at most 24 hours ahead** (the contract's
`EnrolmentTokenCreateRequest` cap) and each place is single use. Both facts are stated on the
sheet itself and in the console, and both are read from `EnrolmentToken.expires_at` rather than
written into the copy. The panel always shows the short code beside the QR image, so a failure
to render the image never blocks anyone.

### 4.5 `member-detail` (drawer)

Name, email, role with a `Select`, state (invited / active / on-site unclaimed), last sign-in,
the date they joined, and one destructive action.

```text
┌── Marc Petit ──────────────────────────────── [×] ──┐
│ marc.petit@acme.fr                                  │
│ Rôle       [ Membre            ▾ ]                  │
│ État       Actif                                    │
│ Rejoint le 12 janvier 2027                          │
│ Dernière connexion  il y a 31 jours                 │
│                                                     │
│ ────────────────────────────────────────────        │
│ [ Retirer de l'organisation ]                       │
└─────────────────────────────────────────────────────┘
```

Removal confirmation:

```text
┌── Retirer Marc Petit ? ─────────────────────────────┐
│ Marc Petit ne pourra plus utiliser la console de     │
│ votre organisation. Son accès à Visio et à Docs      │
│ n'est pas encore coupé : si vous devez le couper     │
│ maintenant, écrivez-nous à {email}. Ses documents    │
│ restent dans l'espace de l'organisation.             │
│                                                      │
│ [ Retirer ]                       [ Annuler ]        │
└──────────────────────────────────────────────────────┘
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Card`, `Status pill`,
`Empty/loading/confirm` (the confirmation dialog names the person and the consequence),
`Button` (destructive).

Console primitives that carry them: `Drawer`, `DefinitionList`, `Select` (role),
`ConfirmDestructive`.

**Suspension (contract 0.18.0).**
- **Action.** An active person shows « Suspendre dans la console » under the role, behind a confirmation. A suspended one shows « Réactiver dans la console », with no confirmation. Both are one `PATCH` with `state`, under `If-Match`, and are offered exactly when a role change is: the same authority, the same `blocked_reason`.
- **Last owner.** The last owner cannot be suspended. Core answers `409 last-owner-protected`, with the same sentence as for demotion.

**Not a security control yet** (release gate, Core `MEMBERSHIP_LIFECYCLE.md` §6). Core's record is authoritative: the person loses console use on their next request. Disabling the realm account (Visio, Docs) is a separate delivery (keycloak#52). Until it lands:
- the actions say « dans la console », not « accès »;
- both confirmations say « Son accès à Visio et à Docs n'est pas encore coupé », with the support address for an urgent cut.

**Changes and removals act only on the person as shown.** The change re-reads the person first. If the role or state differs from the screen, nothing is sent: the person is shown again with « Cette personne vient d'être modifiée par quelqu'un d'autre ». The row menu also checks `can_remove` on that read. The write then goes under that read's `If-Match`; removal's is optional for Core and always sent here. Refusals:
- `412`, or `404` when someone else already removed the person: the same "changed meanwhile" sentence, and the screen re-reads the person;
- `409 last-owner-protected`: the last-administrator sentence below;
- `403` (out of reach, oneself, or a suspended organisation): « Cette modification n'est pas possible pour le moment », with the support address.

A removal answers `200` with the removed membership.

**The last-administrator rule.** The Core API refuses to remove or demote the last `owner` and
answers `409`; the console renders that as one sentence naming the fix — appoint someone else
first — and changes nothing on the screen. The delivered copy words it for administrators, and
the same sentence covers both cases, because a buyer does not distinguish `owner` from `admin`
and the console never teaches them to.

### Member-drawer role acknowledgement and readback

Status: The role drawer separates a confirmed write from its current detail read. This does not
change the row menu, role policy, suspension/removal semantics or provider access.

The role action still reads the exact person immediately before PATCH, respects current permission
advice and role/state changes, and sends that read's If-Match. A successful, structurally valid
Membership response bound to the exact organisation, member and requested role confirms the write.
It is announced as saved while a new GET reads MembershipDetail and its server ETag. If that GET
fails, the drawer keeps the saved acknowledgement, labels the old role as last known and disables
member mutations. The refresh action sends only GET. List/count refresh success, cached data and a
cancelled/refetch result are not detail confirmation. Only a matching fresh network reply makes
current role/permission advice editable and permits the ordinary success toast. A concurrent later
role change displays the actual returned role and the existing changed-meanwhile sentence.

A lost, malformed or wrong-target PATCH reply, or a server failure, leaves the write outcome
unconfirmed. It is neither reported saved nor reported definitely rejected. Recovery is GET only;
a later matching role does not prove that this uncertain write caused it. Registered refusals keep
the existing forbidden, last-owner and precondition messages. No retry automatically repeats PATCH,
and acknowledgement analytics and the confirmed-current-role toast are each emitted at most once.

Every initial/background detail response is validated inside the drawer's query function before
cache publication: exact target, required/rendered fields, role/state, permission booleans and a
strong server tag. The same validation precedes PATCH target selection. Each mount owns a unique
serializable key under the existing member prefix on the existing QueryClient. Explicit readback
cancels its own automatic read and excludes that exact detail key from broad People invalidation.
Publication checks the actual read ticket, ready session/credential and original query/client
ownership. Cache clear, replacement client, close, target or session changes retire old work.
Same-session credential renewal retires only the old GET; an already-issued PATCH acknowledgement
retains its stable session/write ownership and fresh-credential GET-only recovery remains possible.
No provider, token storage or shared query policy changes are involved.

Runnable regressions: `MemberDrawer.test.tsx` groups `role change readback` and
`role change readback recovery boundaries`. They retain the actual committed Administrator plus
503 detail/200 list predecessor, inspect every detail-cache success, release held work across
credential/session/target/client/close transitions, and cover uncertain replies, permission refusal,
GET-only recovery and StrictMode remounts alongside the existing member controls.

## 5. State matrix

| Screen | Default | Loading | Empty | Error | Success | Partial failure | Permission denied | Offline |
|---|---|---|---|---|---|---|---|---|
| `list` | Members table | `Skeleton` rows keeping column widths | No members beyond the owner → `EmptyState` "Personne pour l'instant" + "Inviter des personnes" and "Importer une liste" (while the member import is not offered, `src/app/capabilities.ts`, only the first, with `console.people.list.empty-body-email`); a search with no result is a distinct empty state offering to clear the search | Fetch fails → full-table error with retry; the tabs stay usable | Row updates in place after a role change, `Toast` confirms | Page 2 fails to load → the rows already loaded stay, the "load more" button shows the error | `org_member` and `org_billing` see no People item in the navigation; direct URL shows the role banner | Banner; table readable, row menu actions disabled with the reason |
| `invite` | Empty textarea | n/a (opens instantly) | n/a | Send fails entirely → alert with retry, the addresses are kept | Drawer closes, invited people appear in the Invitations tab, `Toast` with the count | Some addresses rejected → the drawer stays open, shows what was sent and what was not, and the retry covers only the failures | Only `owner` and `admin` see the button | Send disabled with the reason; the typed addresses survive |
| `import` (upload) | Drop zone | n/a | n/a | File too large, wrong type, unreadable → inline error naming the limit and the accepted formats | Advances to mapping | n/a | as above | Upload disabled |
| `import` (preview) | Mapping + four counters | `Skeleton` while parsing | File with 0 usable rows → "Aucune adresse exploitable" + the template download | Parse fails → error naming the row where it broke + the template | Advances to sending | The normal case: valid, already-member, duplicate, invalid counted separately | as above | Import disabled, the parsed preview stays |
| `import` (result) | Sent count + failures table | `ProgressList` while sending, with a live count | All rows succeeded → success card only | Send call fails wholesale → nothing was sent, one alert, one retry | `Toast` + link to the Invitations tab | Per-row reasons, retry scoped to failures, download of failed rows | as above | Retry disabled |
| `on-site` | Explanation + active sheets | `Skeleton` | No sheet yet → the explanation is the empty state, with the creation form | Creation fails → alert with retry | New sheet appears, print opens | Sheet created but the QR image failed → the short code is shown and printable, with an alert | Only `owner` and `admin` | Creation disabled |
| `member-detail` | Fields + remove | `Skeleton` | n/a | A refused role write explains why; an uncertain reply offers GET-only recovery | Fresh exact detail confirms the role and permits its toast | Acknowledged write with unavailable detail keeps saved truth and offers GET-only refresh, with last-known fields disabled | The last owner cannot be demoted or removed; an admin cannot alter owner or billing memberships; each unavailable action states the reason | Actions disabled |

## 6. Core API calls

| Method | Path | Fields sent | Fields read |
|---|---|---|---|
| `GET` | `/api/v1/organisations/{organisation_id}/memberships` | `cursor`, `limit`, `role`, `state`, `account_kind` | `data[]{ id, person_id, email, display_name, role, state, source, account_kind, mfa_enrolled, last_seen_at, created_at }`, `next_cursor`, `has_more` |
| `GET` | `/api/v1/organisations/{organisation_id}/memberships/count` | `role`, `state`, `account_kind` | `count`, `counted_at` |
| `GET` | `/api/v1/organisations/{organisation_id}/memberships/{membership_id}` | — | As a row, plus `can_change_role`, `can_remove`, `blocked_reason`, `invitation_id` |
| `PATCH` | `/api/v1/organisations/{organisation_id}/memberships/{membership_id}` | `If-Match`; `role` or `state` (`suspended`, `active`) | `id, role, state` |
| `DELETE` | `/api/v1/organisations/{organisation_id}/memberships/{membership_id}` | `If-Match` (optional for Core, always sent) | `200` with the removed membership; it leaves the list at once |
| `GET` | `/api/v1/organisations/{organisation_id}/invitations` | `cursor`, `state` | `data[]{ id, email, role, state, realm, expires_at, sent_count, last_sent_at, created_at }`, `next_cursor` |
| `POST` | `/api/v1/organisations/{organisation_id}/invitations` | `Idempotency-Key`; `invitations[]{ email, role, display_name? }` (1–500), `send_email`, `locale` | `created`, `skipped`, `failed`, `seats_used_after`, `seats_included`, `results[]{ email, outcome, invitation, detail }` |
| `POST` | `/api/v1/invitations/{invitation_id}/actions/resend` | `Idempotency-Key` | `id, sent_count, last_sent_at` |
| `DELETE` | `/api/v1/invitations/{invitation_id}` | — | `204` |
| `POST` | `/api/v1/organisations/{organisation_id}/member-imports` | `Idempotency-Key`; multipart `file`, `has_header_row?` | `id, state, filename, row_count, detected_columns[]{ index, header, sample }, staging_expires_at` |
| `PATCH` | `/api/v1/member-imports/{member_import_id}` | `column_mapping{ email, given_name, family_name, role }` (column indexes), `default_role` | `id, state, summary{ ready, already_member, already_invited, duplicate, invalid }, rows[]{ line, email, role, status, reason_code }` |
| `POST` | `/api/v1/member-imports/{member_import_id}/actions/execute` | `Idempotency-Key`; `only_lines[]?`, `send_email`, `locale` | `200`: the batch result; no infrastructure job is created |
| `GET` | `/api/v1/member-imports/{member_import_id}` | — | As above, plus `summary.invited`, `summary.failed`, `staging_expires_at` and retryable `rows[].invitation_id`; polled while `state` is `validating` or `running` |
| `POST` | `/api/v1/organisations/{organisation_id}/enrolment-tokens` | `Idempotency-Key`; `role`, `max_uses`, `expires_at`, `label?`, `require_email_domain?` | `id, role, state, max_uses, uses, expires_at, fingerprint`, plus `secret`, `enrolment_url` and `qr_svg` **returned exactly once** |
| `GET` | `/api/v1/organisations/{organisation_id}/enrolment-tokens` | `cursor`, `state=active` | `data[]{ id, label, role, state, max_uses, uses, expires_at, fingerprint }` |
| `DELETE` | `/api/v1/organisations/{organisation_id}/enrolment-tokens/{enrolment_token_id}` | — | `204` |

Notes.

Resend confirmation consumes a non-null, non-array object whose string `id` and
`organisation_id` exactly match the requested invitation and organisation. Validate this
correlation before releasing its intention key or announcing success. An unusable body uses the
existing unavailable feedback and retains the same key for deliberate recovery across the member
row and Invitations tab; no automatic resend follows. `sent_count` and `last_sent_at` remain
optional. This body-only projection does not prove full schema/status/header conformance, current
invitation state or mail delivery. A valid older response may release only its still-matching
intention key. Existing network/server-failure and 4xx key behavior are unchanged.

A `410` on resend (`invitation-expired`, `invitation-revoked`) is final, on the member row and the
Invitations tab alike: the toast says the invitation can no longer be sent and to invite the
address again (`console.people.members.error-resend-gone`), never « réessayez ».

A resolved invitation cancellation accepts the existing void204 contract without a JSON receipt.
Before pruning the captured organisation's pending-invitation cache, cancel that exact query's
old publication. Remove only the acknowledged string id and organisation id; preserve other
rows, pages and cursors, and do not create a missing cache. A failed refresh cannot restore an
actionable pending row or reclassify the acknowledged cancellation as a failed write. The cache
update belongs to the originally captured QueryClient even if its panel retires. Retired
organisation/client lifetimes publish no later refresh or toast, including an away-and-back
replacement. A refusal or lost reply is not an acknowledgement and does not prune by inference.
Query cancellation fences publication; it does not establish physical transport abort or a live
backend invitation lifecycle. Existing resend and default query-error behavior are unchanged.

- The console never calls Keycloak. Invitations, enrolment tokens, and role changes are Core API
  operations that fan out to the tenant realm server-side (ADR-0003).
- **`PATCH` and `DELETE` carry no `Idempotency-Key`.** Only a `POST` does; a `PATCH` that sends one
  is refused. Concurrency on a `PATCH` is `If-Match`.
- **A page carries no total.** `next_cursor` and `has_more` say whether to keep going, and the seat
  gauge reads `memberships/count`. The federation screen reads the same endpoint with
  `account_kind=hosted`.
- `can_change_role`, `can_remove` and `blocked_reason` (`last_owner`, `self`, `staff_managed`) are
  rendering advice from the API, so a disabled control has a reason. They are not authorisation:
  the API re-checks the rules and answers `last-owner-protected` whatever the console rendered.
- **The batch invitation and the CSV import are both real, and they share one engine.** The paste
  drawer posts `invitations[]` directly; the import stages a file so the mapping and the preview
  happen before anything is sent, and its execution runs the same batch service. `results[].outcome`
  is `created`, `already_member`, `already_invited`, `invalid_email` or `failed`, one per submitted
  row and in submission order, which is what the partial-failure state renders.
- The CSV file is uploaded to the Core API and parsed there, so that the console holds no
  personal data beyond the current page and the parse rules live in one place. It is the only
  non-JSON body in the contract; at most 2 MB and 5 000 rows. The raw object is deleted after
  parsing; only retryable rows survive execution, and never beyond `staging_expires_at`.
- `only_lines[]` on the execution retry is belt and braces rather than the safety mechanism: a line
  that has already produced an invitation is skipped server-side whatever the console sends, so a
  retry of the whole file cannot double-invite.
- Enrolment-token fields follow the contract: `count` is `max_uses`, `ttl_hours` is an absolute
  `expires_at`, and the one-time `secret`, `enrolment_url` and `qr_svg` come back on creation only.

## 7. MSW scenario overlays

| Overlay | Deviation |
|---|---|
| `people.empty` | One membership (the owner), no invitations, `memberships/count` returns 1 |
| `people.large-list` | 118 memberships over three cursor pages, `has_more: true` on the first two |
| `people.invite-partial-failure` | `POST /invitations` returns `created: 2`, `skipped: 1`, `failed: 1` with `results[].outcome` `invalid_email` and `already_member` |
| `people.invite-all-rejected` | Every `results[].outcome` is `invalid_email` |
| `people.import-mixed` | `PATCH /member-imports/{member_import_id}` returns `summary` 118 ready, 4 already_member, 2 duplicate, 0 invalid |
| `people.import-execution-partial` | After execution `state: partially_failed`, `summary.invited: 114`, `summary.failed: 4`, four `rows[]` with `status: failed` and a `reason_code` |
| `people.import-completed-scrubbed` | `state: completed`, `filename: null`, durable summary counts, `rows: []` and no detected sample value |
| `people.import-file-too-large` | Upload returns `413` `payload-too-large` with the limit in `detail` |
| `people.last-owner` | `memberships/{id}` returns `can_remove: false`, `can_change_role: false`, `blocked_reason: last_owner` |
| `people.enrolment-active` | One `active` token, `max_uses: 12`, `uses: 5` |
| `people.enrolment-qr-failed` | Creation succeeds with `qr_svg` absent; the `fingerprint` and `enrolment_url` are present |
| `people.seat-limit` | `POST /invitations` returns `409` `capacity-exceeded` with `seats_included` reached |
| `people.member-role` | Caller is `member`; the area is not reachable |

## 8. Validation rules

| Field | Rule | When | Copy key |
|---|---|---|---|
| Invitation addresses | At least one address | On submit | `console.people.invite.error-emails-required` |
| Invitation addresses | Split on `,` `;` newline and tab; whitespace trimmed; `Nom <a@b.fr>` reduced to the address | On input | — (silent normalisation) |
| Invitation addresses | Each address valid | On blur, per address, shown as a red chip | `console.people.invite.error-address-invalid` |
| Invitation addresses | Duplicates inside the input collapsed, counted, and reported | On blur | `console.people.invite.hint-duplicates` |
| Invitation addresses | At most 200 per submission | On input | `console.people.invite.error-too-many`; `console.people.invite.error-too-many-batches` while the member import is not offered (`src/app/capabilities.ts`) |
| Message | ≤ 500 characters | On input, with a counter after 400 | `console.people.invite.error-message-length` |
| CSV file | `.csv`; comma, semicolon and tab delimiters detected | On drop | `console.people.import.error-file-type` |
| CSV file | ≤ 2 MB and ≤ 5 000 rows | On drop / server | `console.people.import.error-file-too-large` |
| Imported role | Owner may choose member, administrator or billing; administrator may choose member or administrator; owner values in a file are rejected | Mapping and server | `console.people.import.error-role-not-allowed` |
| Column mapping | An email column must be mapped | On submit | `console.people.import.error-email-column-required` |
| Enrolment count | Integer 1–200 | On blur | `console.people.on-site.error-count-range` |
| Role change | An organisation always keeps at least one owner | Server | `console.people.members.error-last-owner` |
| Self-removal | A person cannot remove themselves | Client + server | `console.people.members.error-self-removal` |

## 9. Error copy rules

Cause, then next action, per row when the failure is per row. A failed address is never described
as "erreur" alone: the row says which address and why.

Most per-address outcomes are **not** problem documents: a batch never fails halfway, so every row
comes back with an `outcome` and the call itself is a `200`.

| `results[].outcome`, `rows[].reason_code`, or problem `type` | Copy key | Next action |
|---|---|---|
| `outcome: invalid_email` | `console.people.invite.error-address-invalid` | Fix it in the field, or in the file and re-import the failed rows |
| `outcome: already_member` | `console.people.invite.error-already-member` | None needed; the row is informational, not an error |
| `outcome: already_invited` | `console.people.invite.error-already-invited` | Resend from the Invitations tab |
| `reason_code: mail_provider_rejected` | `console.people.invite.error-mailbox-unreachable` | Check the address, or use an on-site access |
| `capacity-exceeded` | `console.people.invite.error-seat-limit` | Never at launch — accounts are unlimited; if returned, show the generic message and open support |
| `last-owner-protected` | `console.people.members.error-last-owner` | Promote someone else first |
| `conflict` with `blocked_reason: self` | `console.people.members.error-self-removal` | Ask another administrator |
| `payload-too-large` | `console.people.import.error-file-too-large` | Split the file, limits named |
| `unprocessable-entity` on the upload or the mapping | `console.people.import.error-parse-failed` | Names the line from `detail`, offers the template |
| `conflict` on an enrolment token | `console.people.on-site.error-token-expired` | Create a new sheet |
| `forbidden` | `console.shell.access.error-role` | Ask the owner |

## 10. Accessibility

- The table is a real `table` with a caption, column headers, and a row header (the name). The
  row menu is a `Button` with an accessible name that includes the person ("Actions pour Marc
  Petit").
- **Focus order (`list`):** `h1` → tabs → search → role filter → invite button → table (row by
  row, then the row menu) → "load more".
- **Keyboard map:** `/` focuses the search from anywhere on the screen; `Escape` clears the
  search when it is focused and non-empty, then closes the drawer; `↑`/`↓` move between row
  menu items; `Enter` opens the member drawer from a focused row; `Shift+Tab` from the drawer
  returns to the row that opened it.
- The invitation address counter ("3 adresses reconnues · 0 en double · 0 invalide") is a polite
  live region, debounced 500 ms, and is the accessible description of the field.
- The import preview counters are a list, not four coloured tiles: each line reads as a sentence
  and the count is inside the sentence.
- During sending, the progress is announced at 0 %, 50 % and 100 % only, never per row.
- `ConfirmDestructive` is a modal `Dialog` with the destructive action **not** autofocused;
  focus lands on the dialog heading, `Escape` cancels, and the confirm button's accessible name
  contains the person's name.
- The QR sheet's print stylesheet keeps the short code as text so a person who cannot scan can
  type it; the QR image carries an `alt` giving the same code.
- Role radio descriptions are part of each option's accessible name, so a screen-reader user
  hears what the role can do without exploring.
- Chips rendered from pasted addresses are removable with `Backspace` when focused and expose a
  "Retirer {address}" button.

## 11. Analytics events

No personal data: never an email address, a name, or a domain. Counts and reasons only.

| Event | Properties |
|---|---|
| `people_viewed` | `tab` (`members` \| `invitations` \| `on-site`), `member_count_bucket` |
| `people_invite_opened` | `source` (`button` \| `empty-state` \| `status`) |
| `people_invite_submitted` | `count`, `role`, `paste_used` (bool) |
| `people_invite_result` | `sent`, `rejected`, `reasons[]` (codes only) |
| `people_import_started` | `source` |
| `people_import_parsed` | `rows`, `ready`, `already_member`, `duplicate`, `invalid` |
| `people_import_executed` | `sent`, `failed` |
| `people_import_retry` | `retried` |
| `people_role_changed` | `from`, `to` |
| `people_member_removed` | — |
| `people_enrolment_created` | `count` |
| `people_enrolment_printed` | — |
| `people_enrolment_claimed_view` | `used`, `count` |

## 12. Acceptance tests

1. **Given** an organisation with one member (`people.empty`),
   **when** the People screen loads,
   **then** an empty state offers exactly two ways forward — invite by email and import a list —
   and no table headers are shown.
   `people/list: offers two ways to add the first colleagues`

2. **Given** the invitation drawer,
   **when** a column of addresses is pasted with mixed commas and newlines,
   **then** the addresses are recognised individually, the counter announces how many were found,
   and the submit button's label carries the count.
   `people/invite: accepts a spreadsheet paste as separate addresses`

3. **Given** two addresses are rejected (`people.invite-partial-failure`),
   **when** the invitations are sent,
   **then** the drawer stays open, names which two failed and why, keeps the two that succeeded
   out of the retry, and the retry sends only the failures.
   `people/invite: retries only the addresses that failed`

4. **Given** a mixed CSV (`people.import-mixed`),
   **when** the file is uploaded and the columns mapped,
   **then** the preview separates ready, already-member, duplicate and invalid rows with a count
   each, and the import button names how many people will be invited.
   `people/import: separates ready, duplicate and invalid rows before importing`

5. **Given** an import that half fails (`people.import-execution-partial`),
   **when** the send finishes,
   **then** the successful count is stated, the four failed rows are listed with their line
   number and reason, and the failed rows can be downloaded.
   `people/import: lists the failed rows with their line number and reason`

6. **Given** a completed import (`people.import-completed-scrubbed`),
   **when** its result is reloaded,
   **then** the successful counts remain but no filename, detected sample or personal row is
   available to the console.
   `people/import: renders durable counts after personal staging data is scrubbed`

7. **Given** a file over the size limit (`people.import-file-too-large`),
   **when** it is dropped,
   **then** the error names the limit and the accepted formats and the drop zone stays usable.
   `people/import: names the limit when the file is too large`

8. **Given** the caller is the only owner (`people.last-owner`),
   **when** they open their own detail,
   **then** the role control and the removal action are disabled, each with a sentence saying
   another owner must be appointed first.
   `people/members: prevents the last owner from removing themselves`

9. **Given** a member row,
   **when** removal is confirmed,
   **then** the confirmation names the person and the consequence, focus starts on the dialog
   heading, `Escape` cancels without removing, and confirming updates the table in place.
   `people/members: confirms a removal by naming the person and the consequence`

10. **Given** an owner and an administrator viewing the same member,
    **when** each opens the role control,
    **then** the owner can choose billing or owner with the required confirmation, while the
    administrator can choose only member or administrator.
    `people/members: keeps billing and ownership grants owner-only`

11. **Given** an active enrolment sheet (`people.enrolment-active`),
   **when** the sheet is opened,
   **then** the QR code, the typed short code, the expiry and the used-of-total count are all
   present, and the print view fits one page with the short code as text.
   `people/on-site: prints a sheet with both a code to scan and a code to type`

12. **Given** the QR image fails (`people.enrolment-qr-failed`),
    **when** the sheet renders,
    **then** the short code and claim address are still shown and printable, with an alert
    explaining that the image is unavailable.
    `people/on-site: still gives a usable code when the image fails`

13. **Given** an unsent multiline invitation and a selected administrator role,
    **when** its real credential expires and Browser Back starts the full mock sign-in,
    **then** fresh same-owner verification reopens the drawer with exact fields and no request.
    `people/recovery: preserves an unsent invitation through expired Browser Back`

14. **Given** a production-saved unsent invitation,
    **when** the returning fresh Core identity and membership differ,
    **then** no private field is restored and the slot is discarded.
    `people/recovery: discards the draft for a changed fresh Core owner`

15. **Given** a production-saved invitation and denied feature-slot removal,
    **when** restoration commits, the drawer closes, and explicit logout runs,
    **then** closing does not reopen it and logout clears the recovery slot and preserves unrelated state.
    `people/recovery: explicit logout clears a production-saved draft after denied consumption`

16. **Given** denied feature-slot removal after restoration and a deliberately attempted batch,
    **when** another full sign-in returns to the same verified owner,
    **then** the attempted batch is never reopened, renonced or submitted automatically.
    `people/recovery: never reopens an attempted batch after denied removal and fresh sign-in`

## 13. Out of scope for launch

- Bulk role changes on existing members (planned after launch).
- Groups, teams, or departments; the organisation is flat at launch.
- Directory sync from the customer's IdP, planned after launch; federation at launch maps identities at login,
  it does not import a list.
- Deprovisioning workflows tied to a leave date.
- Per-person permissions inside Visio or Docs; roles here are organisation-level.
- Guest management: guests join by link and are never listed here, by design.
- Export of the member list as a file; at launch it is a support request, and it later becomes
  part of the export package.
- One-click export and delete of the organisation's data (planned after launch).

## Changelog

- The invitation's validity (gap report G16): the help text now says the invitation is valid for
  14 days, as Core issues it, instead of an activation link valid for seven days, a number no mail
  carried.

- Contract 0.18.0: suspension and reactivation in the console (§4.5), and removal under `If-Match`
  answering `200`. A change or removal applies only to the person as shown. The `412`/`404` and
  `403` sentences are new. Both confirmations say Visio and Docs access is not cut yet, as the release
  gate requires.

- Removal answers `202` with a `realm_update` job, as contract v0.11.0 declares, not `204`
  (superseded by contract 0.18.0, above).
- Enrolment token lifetime aligned with contract v0.11.0: `expires_at` is at most 24 hours
  ahead, so the copy no longer states 72 hours and reads the expiry from the token instead.

- Entry points now use the delivered People routes: active Home links to `/{org}/people/invite`;
  provisioning Home and Status link to `/{org}/people/import?from=status`; successful order
  confirmation links to `/{org}/people/import?from=order`. All require an owner or administrator
  role and the current organisation slug. Domain setup remains withheld.

- Applies Core ADR-0010 and ADR-0011: billing and ownership grants are
  owner-only in the UI, the CSV limits match the contract, raw uploads are
  deleted after parsing, and only retryable rows remain for at most seven days.

- Review fixes: the state matrix quotes the catalogue's own empty state, and the import-result
  wireframe follows the rewritten already-invited string.

- Aligned with the delivered design: the three list filters, the federation nudge and its
  reverse note once a provider is active, the seven-day life of an activation link stated before
  sending, the 72-hour enrolment token with its short code always beside the QR image, the
  last-administrator sentence, and the design-system component names.

- Initial version: member list, paste-tolerant email invitations, CSV import with per-row
  partial failure and scoped retry, on-site enrolment sheets, role changes and removal.
- Reconciled with the Core API contract: `memberships` replaces `members`, the page carries no
  total and `memberships/count` answers the seat gauge, imports move to `/member-imports` with
  `actions/execute`, resend and revoke move to `/invitations/{invitation_id}`, and per-address
  outcomes replace the invented per-address problem types.
- Onboarding audit (item 9): a typed `410` on resend has its own final sentence instead of the
  "service unavailable, retry" toast (§6).
