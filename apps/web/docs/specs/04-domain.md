# 04 — Domain

**Status:** Proposed · **Owner:** zôÖma

## 1. Goal

Let an organisation put its meetings and documents on its own address — `visio.acme.fr` — by
following instructions it can forward, unedited, to whoever holds the domain.

## 2. Persona and the "can the CEO do this alone" test

**Who.** The CEO starts this. Almost none of them finish it themselves: the DNS is held by the
web agency that built the site, or by an IT provider, or by a former employee's OVH account. The
real user of this screen is therefore **two people**: the buyer, who starts and checks, and a
third party who pastes two records.

**Alone test: partial pass, by design.** The buyer cannot edit their own DNS and the console must
not pretend otherwise. It passes if:

1. The screen produces a **forwardable instruction sheet** — exact record type, name, value, TTL —
   that can be copied as a block, downloaded, or emailed to the domain holder in one click,
   without the buyer having to explain anything.
2. The check is on demand and honest. "Vérifier maintenant" says what was found and what was
   expected, side by side, and names the most likely cause (propagation, a trailing dot, the
   record put on the wrong name).
3. The two-phase nature is visible from the start: first we prove you own the name, then we
   point it at your space. A buyer who sees only one step will assume the first check failing
   means the whole thing is broken.
4. Nothing irreversible happens without a confirmation that names the consequence: switching the
   primary address changes the link everyone has bookmarked.

**Where it fails.** An apex domain (`acme.fr` with no subdomain) needs an A record on a fixed
address and cannot be moved as easily afterwards. The console warns, recommends a subdomain, and
allows the apex anyway.

## 3. Entry points

| Entry | URL |
|---|---|
| Navigation "Domaine & identité", "Domaines" tab | `/{org}/domain` |
| The same area's second tab, enterprise sign-in | `/{org}/domain?tab=federation` → `07-federation.md` |
| Wizard | `/{org}/domain/new` |
| A specific domain | `/{org}/domain/{domainId}` |
| From the order confirmation | `/{org}/domain/new?from=order` |
| From the status screen | `/{org}/domain/new?from=status` |
| From the federation spec (a federated login needs the domain proven) | `/{org}/domain/new?from=federation` |
| Verification reminder email | `/{org}/domain/{domainId}?from=email` |

## 4. Screens

**This area has two tabs.** The delivered design puts domains and enterprise sign-in under one
navigation item, "Domaine & identité", because they answer the same buyer question — the
addresses my organisation uses and how my colleagues get in — and because a federated login
cannot be configured before the email domain is proven. "Domaines" is this specification;
"Connexion (Google / Microsoft)" is [`07-federation.md`](07-federation.md). The tab strip sits
under the page title, `Tabs` are the component, the tab is in the URL (`?tab=domains` is the
default, `?tab=federation` the second), and `/{org}/federation` redirects into it so old links
keep working.

### 4.1 `list`

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  Domaine                                                        (h1)     │
│  Vos applications sont accessibles à votre propre adresse.               │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ visio.acme.fr        Visio     ● Active · principale    [ Gérer ]  │  │
│  │ docs.acme.fr         Docs      ⏳ Vérification en cours  [ Gérer ]  │  │
│  │ acme.kodera.io    Visio     ● Active · fournie       [   —   ]  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  [ Ajouter une adresse ]                                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Tabs` (the two tabs of the
area), `Table` (hostnames in monospace, ellipsised, fixed status column), `Status pill`,
`Button`, `Empty/loading/confirm`.

Console primitives that carry them: `Tabs`, `Table`, `StatusPill`, `Badge` ("principale",
"fournie"), `Button` ×2, `EmptyState`.

The `{slug}.*.kodera.io` hosts are always in the list, are labelled **Secours**, and carry no
removal control: they are what still works while a custom address is being verified.

### 4.2 `new` — the wizard

Three steps, in the URL: `/domain/new/address`, `/prove`, `/point`.

**Step 1 — the address.**

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  ①Adresse ── ②Preuve ── ③Activation                                      │
│                                                                          │
│  Quelle adresse voulez-vous utiliser ?                                   │
│  [ visio.acme.fr                                              ]          │
│  Pour l'application : ( ) Visio  ( ) Docs                                 │
│                                                                          │
│  ℹ Nous recommandons une sous-adresse (visio.acme.fr) plutôt que          │
│    votre adresse principale (acme.fr) : elle est plus simple à           │
│    mettre en place et à déplacer.                                        │
│                                                                          │
│  [ Continuer ]                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

**Step 2 — prove ownership (TXT).**

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  Prouvez que ce domaine est le vôtre                            (h1)     │
│  Ajoutez cet enregistrement chez votre hébergeur de domaine.             │
│  Il ne change rien à votre site actuel.                                  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Type   TXT                                             [ Copier ]  │  │
│  │ Nom    _kodera-verify.visio                          [ Copier ]  │  │
│  │ Valeur kodera-verify=9f2c7ab1e4d0…                   [ Copier ]  │  │
│  │ TTL    300 (ou la valeur la plus basse possible)                   │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  [ Copier les 3 lignes ]  [ Télécharger ]  [ Envoyer à quelqu'un ]       │
│                                                                          │
│  Vous ne gérez pas le domaine ? Transmettez cette page à la personne     │
│  ou à l'agence qui s'en occupe.                                          │
│                                                                          │
│  [ Vérifier maintenant ]     Dernière vérification : il y a 2 minutes    │
│                                                                          │
│  ┌── Résultat ────────────────────────────────────────────────────────┐  │
│  │ ❌ Aucun enregistrement TXT trouvé sur                              │  │
│  │    _kodera-verify.visio.acme.fr                                  │  │
│  │    Attendu : kodera-verify=9f2c7ab1e4d0…                         │  │
│  │    Trouvé  : (rien)                                                │  │
│  │                                                                    │  │
│  │ Causes les plus fréquentes                                          │  │
│  │ • L'enregistrement vient d'être ajouté : comptez jusqu'à 1 heure.  │  │
│  │ • Le nom a été saisi en entier (_kodera-verify.visio.acme.fr)    │  │
│  │   alors que votre hébergeur attend seulement                       │  │
│  │   _kodera-verify.visio.                                          │  │
│  │ • L'enregistrement a été ajouté sur un autre domaine.              │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

**Step 3 — point the address.**

```text
│  Dernière étape : dirigez l'adresse vers votre espace                    │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Type   CNAME                                           [ Copier ]  │  │
│  │ Nom    visio                                           [ Copier ]  │  │
│  │ Valeur acme.visio.kodera.io.                        [ Copier ]  │  │
│  │ TTL    300                                                         │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  Pour les appels vidéo, ajoutez également :                              │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Type   A       Nom  livekit.visio      Valeur  51.15.xx.xx         │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  [ Vérifier maintenant ]                                                 │
│                                                                          │
│  Ensuite : nous demandons automatiquement le certificat de sécurité.     │
│  Comptez quelques minutes.                                               │
```

Apex variant replaces the CNAME with two A records and adds a warning card explaining that the
apex cannot be a CNAME and what that means if they later change provider.

**Certificate and activation.**

```text
│  ⏳ Certificat de sécurité en cours d'émission… (environ 2 minutes)      │
│  ✅ Certificat émis. Votre adresse est prête.                            │
│                                                                          │
│  [ Faire de visio.acme.fr l'adresse principale ]                         │
```

Confirmation before switching the primary address:

```text
┌── Utiliser visio.acme.fr comme adresse principale ? ─────────┐
│ Les invitations et les liens que vous enverrez à partir de   │
│ maintenant utiliseront visio.acme.fr.                        │
│ L'ancienne adresse acme.visio.kodera.io continue de       │
│ fonctionner et redirige vers la nouvelle.                    │
│                                                              │
│ [ Utiliser cette adresse ]                 [ Annuler ]       │
└──────────────────────────────────────────────────────────────┘
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Stepper` (the three steps —
prove ownership, point the address, certificate issued automatically), `Text field` (host),
`Copy-value block` per record value, `Button`, `Status pill`, `Empty/loading/confirm`.

Console primitives that carry them: `Stepper`, `TextField` (host), `RadioGroup` (app),
`InlineAlert` (subdomain advice),
`Table` of records with `CopyableCode` per cell, `Button` ("Copier les 3 lignes",
"Télécharger", "Envoyer à quelqu'un" → opens the support/share dialog with a prefilled email
body), `Button` ("Vérifier maintenant"), result panel as `InlineAlert` with an expected/found
`DefinitionList` and a causes list, `ProgressList` (certificate), `ConfirmDestructive`
(primary switch — destructive because it changes what people have bookmarked), `Drawer`
(record detail on mobile).

### 4.3 `detail` — an existing domain

Records as configured, current verification state, certificate expiry, "Vérifier à nouveau",
"Faire de cette adresse l'adresse principale", and "Retirer cette adresse" behind a
`ConfirmDestructive` naming what breaks.

## 5. State matrix

| Screen | Default | Loading | Empty | Error | Success | Partial failure | Permission denied | Offline |
|---|---|---|---|---|---|---|---|---|
| `list` | Rows including the provided address | `Skeleton` rows | Only the provided address → `EmptyState` explaining the benefit + "Ajouter une adresse" | Fetch fails → retry | New domain appears after the wizard | One domain's certificate state unknown → that row shows "État du certificat inconnu", others normal | `member` does not see the area; tier below Business → the add button is disabled with the tier name and a link to Invoices | Banner; rows readable, add disabled |
| `new/address` | Empty field | n/a | n/a | Invalid host, already used, or reserved → field error | Advances to `prove`, domain created in `pending` | n/a | as above | Continue disabled |
| `new/prove` | Records + check button | `Skeleton` record table | n/a | **Check ran and failed** is the expected state, not an error state: expected vs found, causes, retry. **The check itself failing** (resolver unreachable) is a distinct message | Verified → advances to `point` | TXT found but with the wrong value (an old nonce) → the panel says so explicitly and offers to re-issue the nonce | as above | Check disabled with the reason; records stay copyable |
| `new/point` | CNAME (or A) + media A record | `Skeleton` | n/a | Same shape as `prove` | Certificate requested → progress | Web record correct, media record missing → the screen says the address works but calls will not, and offers to check again | as above | Check disabled |
| certificate | Progress card | Progress is the loading state | n/a | Issuance failed after retries → cause (rate limit, CAA record) + next action + support | "Prête" + the primary-address action | Certificate issued for the web host but not the media host → partial state named explicitly | as above | Polling paused |
| `detail` | Records + actions | `Skeleton` | n/a | Action fails → inline alert, state unchanged | `Toast` | Removal succeeded in the console but the certificate cleanup is queued → the row shows "Retrait en cours" | as above | Actions disabled |

**Polling and re-checking.** Verification is never polled silently in a way that hides the
user's action. The check runs when asked. After a "Vérifier maintenant" that comes back
`pending`, the console shows the delivered design's sentence — propagation takes 5 to 30
minutes, and **the server re-checks every 10 minutes** — and polls the domain every 30 s for ten
minutes so an early success is visible without a page reload, then stops and leaves the button
enabled. A `pending` result is never a red error: nothing is wrong yet, the record simply is not
visible.

**No DNS vocabulary in sentences.** "DNS", "CNAME", "TXT" and "enregistrement" appear only
inside the monospace values the customer copies and in the `Type` column beside them. The
sentences say "deux lignes à ajouter chez votre hébergeur de domaine". This is checked in the
acceptance tests.

## 6. Core API calls

| Method | Path | Fields sent | Fields read |
|---|---|---|---|
| `GET` | `/api/v1/tenants/{tenant_id}/domains` | `cursor`, `limit`, `state` | `data[]{ id, fqdn, kind: subdomain\|apex, role: web\|media, app, state, is_canonical, verification{ record_name, record_type, record_value, verified_at, checked_at, attempts, failure_code }, target{ record_name, record_type, record_value, observed_value }, certificate{ state, issued_at, expires_at, days_left, failure_code } }` |
| `POST` | `/api/v1/tenants/{tenant_id}/domains` | `Idempotency-Key`; `fqdn`, `role: web\|media`, `app?` | The domain, already in `state: nonce_issued` with the TXT record to publish |
| `GET` | `/api/v1/domains/{domain_id}` | — | As above |
| `POST` | `/api/v1/domains/{domain_id}/actions/verify` | `Idempotency-Key` | The domain after one pass: new `state`, `verification.attempts`, `verification.failure_code`, `target.observed_value` |
| `POST` | `/api/v1/domains/{domain_id}/actions/reissue-nonce` | `Idempotency-Key` | The domain with a fresh `verification.record_value` and a fresh 72-hour TTL |
| `POST` | `/api/v1/domains/{domain_id}/actions/activate` | `Idempotency-Key` | `202`: `job_id, kind, status, job_url` |
| `PATCH` | `/api/v1/domains/{domain_id}` | `is_canonical: true` | The domain, with `is_canonical` moved |
| `DELETE` | `/api/v1/domains/{domain_id}` | — | `202`: `job_id, kind, status, job_url` |
| `GET` | `/api/v1/domains/{domain_id}/instructions` | — | `fqdn`, `records[]{ purpose: ownership\|web_target\|media_target, record_type, record_name, record_value, ttl_s, published }`, `steps[]{ index, body_key, record_purpose }`, `nonce_expires_at`, `download{ url, expires_at }` |
| `POST` | `/api/v1/domains/{domain_id}/instruction-shares` | `Idempotency-Key`; `recipient_email`, `note?`, `locale?` | `id, recipient_email, sent_at` (the Core API sends the mail; the console never does) |

Notes.

- **The domain lifecycle field is `state`, and its values are the domain state machine's**:
  `pending`, `nonce_issued`, `txt_verified`, `dns_pending`, `certificate_issued`, `live`, `failed`.
  The console reads them; it never derives a state of its own from the certificate or the records.
- **The main address is `is_canonical`, not `is_primary`**, and it is moved with a `PATCH` on the
  domain, allowed only when the target is `live`. The previously canonical host keeps serving, so
  invitation links already circulating do not break.
- `failure_code` is a closed enum — `txt_absent`, `txt_mismatch`, `nxdomain`, `servfail`,
  `nonce_expired`, `caa_forbids_issuance`, `target_mismatch`, `unresolved`, `cname_chain_too_long`,
  `edge_unreachable`, `wrong_edge`, `no_certificate`, `chain_invalid`, `expiring`,
  `media_cert_stale`, `media_reload_failed`, `not_in_allowed_hosts`, `not_in_redirect_uris`,
  `default_vhost`, `invalid_fqdn`, `reserved_name`, `already_claimed`, `resolver_unavailable`,
  `rate_limited` — and each maps to one copy key and one causes list. The console never renders a
  resolver's raw output.
- One code covers both record types: a check that fails knows the name did not resolve
  (`unresolved`) or resolved elsewhere (`target_mismatch`), not which record type the customer
  chose. The copy composes the code with `target.record_type`, which is where "CNAME" or "A" comes
  from.
- Verification (TXT nonce) always precedes adding the host to the certificate list; the console
  cannot skip step 2, and `actions/activate` is refused server-side with `domain-state-conflict`
  when `state` is below `txt_verified`.
- `actions/verify` answers `200` even when the pass failed: a failing check is a state, not an
  error. Only a malformed request or a domain that can never be verified answers `4xx`.
- The media A record value is the tenant's retained media address; it is read from
  `instructions.records[]` or from `target`, never constructed by the console.
- Neither `instructions` nor its PDF is proxied by the API: `download` is a short-lived pre-signed
  link, the same shape invoices and the DPA already use. There is no `format=` parameter.

## 7. MSW scenario overlays

| Overlay | Deviation |
|---|---|
| `domain.none` | `tenants/{id}/domains` returns an empty page; only `tenant.default_urls` exists |
| `domain.verification-pending` | One domain in `state: nonce_issued`, `verification.checked_at: null` |
| `domain.verification-failing` | `actions/verify` returns `state: nonce_issued` with `failure_code: txt_absent` |
| `domain.verification-value-mismatch` | `failure_code: txt_mismatch`, an older nonce in `verification` |
| `domain.verification-succeeds-on-second-check` | First `actions/verify` stays `nonce_issued`, second returns `txt_verified` |
| `domain.target-mismatch` | `state: dns_pending`, `failure_code: target_mismatch`, `target.observed_value` pointing elsewhere |
| `domain.media-record-missing` | Web domain `live`, media domain `dns_pending` with `failure_code: unresolved` |
| `domain.apex` | `kind: apex`, `target.record_type: A` |
| `domain.certificate-issuing` | `state: certificate_issued`, `certificate.state: issuing` for two polls, then `live` |
| `domain.certificate-failed-caa` | `certificate.state: failed`, `certificate.failure_code: caa_forbids_issuance` |
| `domain.nonce-expired` | `state: failed`, `failure_code: nonce_expired`; `actions/reissue-nonce` returns a fresh value |
| `domain.resolver-unavailable` | `actions/verify` returns `200` with `failure_code: resolver_unavailable` |
| `domain.entitlement-locked` | `entitlements` returns `custom_domain` with `enabled: false`, `required_pack_code: visio-docs-pro` |

## 8. Validation rules

| Field | Rule | When | Copy key |
|---|---|---|---|
| Address | Required | On submit | `console.domain.new.error-host-required` |
| Address | A valid hostname: labels of 1–63 chars, `a–z0–9-`, no leading or trailing `-`, total ≤ 253 | On blur | `console.domain.new.error-host-format` |
| Address | Normalised: scheme, path, port, trailing dot and uppercase stripped; IDN converted to punycode with the original shown | On blur | — (silent normalisation, with a hint when it changed) |
| Address | Not already registered on this or another tenant | Server | `console.domain.new.error-host-taken` |
| Address | Not a `kodera.io` name | Client + server | `console.domain.new.error-host-reserved` |
| Address | Apex detected → non-blocking warning | On blur | `console.domain.new.hint-apex` |
| App | One selected | On submit | `console.domain.new.error-app-required` |
| Check | Not more than one check every 10 s; the button disables with a countdown | Client | `console.domain.verify.hint-check-throttled` |
| Primary switch | Only a `verified` domain with an issued certificate can become primary | Server | `console.domain.detail.error-not-ready-for-primary` |
| Removal | The primary domain cannot be removed until another is primary | Server | `console.domain.detail.error-primary-removal` |

## 9. Error copy rules

Cause, then next action, and for DNS specifically: **what we looked for, what we found, and the
three things that usually explain the difference.** No jargon beyond the record type itself,
which the buyer must forward verbatim anyway.

The record type in each copy key comes from `target.record_type`, not from the code: one code
covers the CNAME and the A case, because the check knows what it found, not what the customer chose
to publish.

| `failure_code` | Copy key | Causes list shown |
|---|---|---|
| `txt_absent` | `console.domain.verify.error-txt-missing` | Propagation delay; full name entered instead of the relative name; record added on another domain |
| `txt_mismatch` | `console.domain.verify.error-txt-mismatch` | An older value is still present; several TXT records; quotes copied with the value |
| `nxdomain` | `console.domain.verify.error-nxdomain` | The domain does not resolve at all; check the spelling and that the domain is active |
| `servfail` | `console.domain.verify.error-servfail` | The domain's own name servers answered with an error; the DNS provider is the next stop |
| `nonce_expired` | `console.domain.verify.error-nonce-expired` | The 72 hours ran out; one button issues a new record, and the old one must be replaced |
| `unresolved` on a `web` domain | `console.domain.point.error-cname-missing` | Propagation; record on the wrong name; an existing A record blocks the CNAME |
| `target_mismatch` on a `web` domain | `console.domain.point.error-cname-wrong` | Points to another service; trailing dot omitted; a redirection service in between |
| `unresolved` on a `media` domain | `console.domain.point.error-a-missing` | The media record was forgotten; calls will not work without it |
| `target_mismatch` on a `media` domain | `console.domain.point.error-a-wrong` | An old address; a proxy in front |
| `caa_forbids_issuance` | `console.domain.certificate.error-caa` | A CAA record forbids our certificate authority; the exact record to add is given |
| `resolver_unavailable` | `console.domain.verify.error-resolver` | Our check could not run; nothing is wrong with your domain; retry |
| `rate_limited` | `console.common.error-rate-limited` | Wait, with the countdown |
| `no_certificate`, `chain_invalid` | `console.domain.certificate.error-failed` | Retry, then support with the domain reference |
| `invalid_fqdn` | `console.domain.new.error-host-format` | Named at the point of typing, on `422 validation-failed` from `POST /tenants/{tenant_id}/domains` |
| `already_claimed` | `console.domain.new.error-host-taken` | Same; the address is in use, and support can say by whom |
| `reserved_name` | `console.domain.new.error-host-reserved` | Same; the name is one of ours |

Problem documents this screen also handles: `domain-state-conflict` when an action is attempted out
of order (the banner names the current `state`), `tenant-state-conflict` when the tenant is
suspended or decommissioning, and `job-in-flight` when another job holds the tenant.

The word "propagation" is never used alone: it reads "un changement DNS peut mettre jusqu'à une
heure à être visible partout".

## 10. Accessibility

- The records table is a real `table` with a caption naming the record set; each value is a
  `CopyableCode` whose accessible name includes the field ("Copier la valeur de l'enregistrement
  TXT").
- The value strings are rendered in a monospace token with `overflow-wrap` on, so a long nonce
  never forces horizontal page scroll; the table itself scrolls inside its own container.
- **Focus order (`prove`):** `h1` → intro → records table (type, name, value, each with its copy
  button) → "Copier les 3 lignes" → "Télécharger" → "Envoyer à quelqu'un" → "Vérifier
  maintenant" → result panel.
- After a check, focus moves to the result panel heading and the outcome is announced once in a
  polite region: "Vérification échouée : aucun enregistrement trouvé." A `verified` result is
  announced and the "Continuer" button receives focus.
- The check button shows its throttle as text ("Nouvelle vérification possible dans 7 s"), never
  as a disabled control with no explanation.
- Copy actions announce "Copié" in the polite region and restore their label after 2 s; the
  announcement is not repeated if the same value is copied twice in a row.
- Expected-versus-found is a `DefinitionList`, so a screen reader reads "Attendu : … Trouvé : …"
  as pairs rather than as two loose strings.
- `ConfirmDestructive` for the primary switch: focus on the heading, `Escape` cancels, the
  confirm button names the address.
- The certificate progress uses the `ProgressList` rules from spec 02; it announces only the
  transitions.
- Reduced motion: the "checking" state is a static "Vérification en cours…" with `aria-busy`, no
  spinner animation.

## 11. Analytics events

No personal data and **no customer domain names**: hostnames are hashed, and only the shape is
carried.

| Event | Properties |
|---|---|
| `domain_wizard_started` | `source`, `app` |
| `domain_created` | `kind` (`subdomain` \| `apex`), `app` |
| `domain_instructions_copied` | `scope` (`field` \| `all`) |
| `domain_instructions_downloaded` | — |
| `domain_instructions_shared` | — |
| `domain_verification_checked` | `step` (`prove` \| `point`), `result` (`verified` \| `pending` \| `failed`), `failure_code`, `attempt_index` |
| `domain_nonce_reissued` | — |
| `domain_certificate_state` | `state`, `failure_code` |
| `domain_primary_switched` | — |
| `domain_removed` | — |
| `domain_tier_locked_seen` | `required_tier` |

`attempt_index` is what tells us whether the instruction sheet works: a distribution with a long
tail means the copy is failing, not the customer.

## 12. Acceptance tests

1. **Given** a tenant with only the provided address (`domain.none`),
   **when** the buyer starts the wizard and enters `visio.acme.fr`,
   **then** the TXT record is shown with its type, name, value and TTL, each individually
   copyable, plus a single action that copies all three lines.
   `domain/prove: shows a forwardable TXT record with per-field and whole-block copy`

2. **Given** the TXT record is absent (`domain.verification-failing`),
   **when** the buyer presses "Vérifier maintenant",
   **then** the result names what was looked for and that nothing was found, lists the three
   usual causes, and offers to check again.
   `domain/verify: explains a missing TXT record and offers to check again`

3. **Given** an old nonce is still published (`domain.verification-value-mismatch`),
   **when** the check runs,
   **then** the result shows the expected value next to the value found and offers to issue a new
   value rather than only repeating the failure.
   `domain/verify: distinguishes a wrong value from a missing record`

4. **Given** the verification succeeds on the second attempt
   (`domain.verification-succeeds-on-second-check`),
   **when** the buyer checks twice,
   **then** the success is announced, focus moves to the next step, and the pointing records are
   shown.
   `domain/verify: moves to the pointing step when the record is found`

5. **Given** the web record is correct but the media record is missing
   (`domain.media-record-missing`),
   **when** the pointing check runs,
   **then** the screen states that the address works but video calls will not, and names the
   record that is missing.
   `domain/point: warns that calls will not work without the media record`

6. **Given** an apex domain (`domain.apex`),
   **when** the address is entered,
   **then** a warning recommends a subdomain, the pointing step shows A records instead of a
   CNAME, and the buyer can still proceed.
   `domain/new: recommends a subdomain but allows an apex`

7. **Given** a CAA record forbids issuance (`domain.certificate-failed-caa`),
   **when** the certificate step fails,
   **then** the message names the CAA record as the cause, gives the exact record to add, and
   offers a retry.
   `domain/certificate: names the CAA record as the cause and gives the fix`

8. **Given** the resolver is unavailable (`domain.resolver-unavailable`),
   **when** the check runs,
   **then** the message says the check could not run and that nothing is wrong with the domain,
   and it is not confused with a failed verification.
   `domain/verify: separates a failed check from a failed verification`

9. **Given** a verified domain with a certificate,
   **when** the buyer makes it the primary address,
   **then** the confirmation states that new links will use it and that the old address keeps
   working, and cancelling changes nothing.
   `domain/detail: confirms the primary switch by naming the consequence`

10. **Given** an organisation whose pack does not include custom domains (`domain.entitlement-locked`),
    **when** they open the area,
    **then** the add action is disabled with the required tier named and a link to the plans,
    and no request is sent.
    `domain/list: names the tier required for a custom address`

11. **Given** a keyboard-only user on the proving step,
    **when** they copy a record value and run a check,
    **then** the copy is announced, the check outcome is announced once, and focus lands on the
    result.
    `domain/prove: copies a record and runs a check with the keyboard alone`

## 13. Out of scope for launch

- Delegating the whole zone to us, or editing DNS on the customer's behalf through a registrar
  API.
- Automatic detection of the DNS provider with provider-specific screenshots.
- Email domains (`{slug}.mail.kodera.io` is provided and not customer-configurable at launch).
- Wildcard certificates and multi-domain aliases beyond one web host and one media host per app.
- Automatic re-verification without the customer asking, beyond the 10-minute window after a
  check.
- Self-serve removal of a domain that is currently primary.
- One-click export and delete of the organisation's data (planned after launch).

## Changelog

- First slice built: `/{org}/domain` shows the list of addresses, read-only
  ([`domain-addresses-list.md`](domain-addresses-list.md)). None of the acceptance tests of section
  12 is delivered by it, and the entry points of the next item stay withheld: each returns with the
  slice that builds the screen it leads to, not with this list. The tab strip of section 4 is not
  drawn while its second tab is a placeholder.

- Entry points withheld until this screen ships (, owner ruling: a button must not lead
  to a placeholder): Home's « Préparer votre domaine » and the order confirmation's "Réserver votre adresse" are not rendered while `/{org}/domain` is a placeholder. They
  return with this screen.

- Aligned with the delivered design: domains and enterprise sign-in are two tabs of one
  "Domaine & identité" area, the fallback `kodera.io` hosts are labelled "Secours" and cannot
  be removed, the server's ten-minute re-check is stated where the customer waits, the
  technical-vocabulary rule is written as a testable rule, and the component lists name the
  delivered components.

- Initial version: two-phase wizard (TXT nonce then CNAME or A), forwardable instruction sheet,
  expected-versus-found check results with a closed failure-code enum, certificate progress,
  primary-address switch.
- Reconciled with the Core API contract: domains addressed at `/domains/{domain_id}`, actions under
  `actions/verify`, `actions/reissue-nonce` and `actions/activate`, `is_canonical` set with a
  `PATCH` instead of a `primary` action, the instruction sheet returned as data with a download
  link, and `failure_code` moved to the domain state machine's own snake_case codes.
