# 07 — Federation

**Status:** Proposed · **Owner:** zôÖma

## 1. Goal

Let an organisation that already runs Google Workspace or Microsoft 365 sign in with the accounts
it already has — by handing its IT contact the exact values to paste and a one-page procedure,
and by proving the result works before anyone depends on it.

## 2. Persona and the "can the CEO do this alone" test

**Who.** The CEO starts it because "on a déjà Microsoft". The person who finishes it is whoever
administers Microsoft 365 or Google Workspace: an internal IT person, or an outsourced provider.
As with the domain, this screen is used by **two people at different times**.

**Where it lives.** This is not a navigation item. The delivered design puts it as the second
tab of **Domaine & identité**, beside domains, because both answer the same buyer question — the
addresses my organisation uses and how my colleagues get in — and because the email domains
declared here must be proven the same way a custom address is
([`04-domain.md`](04-domain.md), which says the same thing from its side).

**Alone test: fail, and the product says so.** R3 calls this **guided** federation, and we expect
one check-in per federated tenant. The delivered copy words that check-in as what it is: a
member of the Kodera team confirms with the customer before activation — *c'est prévu, pas une
panne*. It is a designed step, stated up front, never an error state and never a queue the
customer discovers after pressing a button. The screen passes its own bar if:

1. It never claims to be automatic. The first thing it says is that this takes about twenty
   minutes with the person who administers the organisation's accounts, and it offers to book a
   check-in with us from the start.
2. It produces a **runbook** — a numbered procedure with the exact values, per provider, that can
   be downloaded as one page and sent to that person, with nothing to interpret.
3. The values the customer must paste back into the console are exactly two (a client identifier
   and a secret), each with an example of what it looks like, and the secret is write-only from
   the console's point of view.
4. Nothing is switched on for real users until a **test sign-in** has succeeded, run by the
   person configuring it, in a mode that affects nobody else.
5. Turning on automatic redirection — the change that makes the password login disappear — is a
   separate, confirmed decision, with a stated way back.

## 3. Entry points

| Entry | URL |
|---|---|
| Navigation "Domaine & identité", "Connexion (Google / Microsoft)" tab | `/{org}/domain?tab=federation` |
| Old deep link, kept working | `/{org}/federation` → redirects into the tab above |
| Wizard | `/{org}/federation/new` |
| Provider chosen | `/{org}/federation/new/{provider}` (`google` \| `microsoft`) |
| Runbook | `/{org}/federation/{id}/runbook` |
| Test | `/{org}/federation/{id}/test` |
| From the People screen ("connecter Microsoft 365 plutôt qu'inviter") | `/{org}/federation/new?from=people` |
| Book a check-in | `/{org}/help/new?about=federation` |

## 4. Screens

### 4.1 `overview`

Before setup:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  Connexion avec les comptes de votre entreprise                 (h1)     │
│  Vos collaborateurs se connectent avec leur compte Microsoft 365 ou       │
│  Google Workspace. Aucun mot de passe supplémentaire.                    │
│                                                                          │
│  ⏱ Comptez environ 20 minutes, avec la personne qui administre vos       │
│    comptes Microsoft ou Google. Nous pouvons vous accompagner.           │
│    [ Réserver un accompagnement ]                                        │
│                                                                          │
│  ┌──────────────────────┐  ┌──────────────────────┐                      │
│  │  Microsoft 365       │  │  Google Workspace    │                      │
│  │  (Entra ID)          │  │                      │                      │
│  │  [ Configurer ]      │  │  [ Configurer ]      │                      │
│  └──────────────────────┘  └──────────────────────┘                      │
│                                                                          │
│  Autre fournisseur (SAML ou OpenID Connect) ? [ Nous écrire ]            │
└──────────────────────────────────────────────────────────────────────────┘
```

After setup:

```text
│  Microsoft 365                              ● Actif                      │
│  Domaines acceptés : acme.fr, acme-btp.fr                                │
│  Dernier test réussi : 4 mars 2027                                       │
│  Redirection automatique : activée                                       │
│  [ Refaire un test ]  [ Modifier les domaines ]  [ Désactiver ]          │
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Tabs` (this is the second tab
of Domaine & identité), `Card` ×2 (providers), `Banner` (the twenty-minute warning and the
check-in state), `Status pill`, `Button`, `Empty/loading/confirm`.

Console primitives that carry them: `Tabs`, `Card` ×2, `InlineAlert`, `Button`,
`DefinitionList`, `StatusPill`, `ConfirmDestructive` (disable), `EmptyState`, `LinkButton`.

**The check-in state.** Between saving the credentials and activation the provider sits in a
review state, and the overview says so with the date the request was received and the promise
that it is answered within one business day. The fields go read-only with an explicit "Modifier"
to reopen them. The banner is cobalt — information, not a warning — because nothing is wrong.

**What deprovisioning means, said before activation.** Once the connection is live, a person
disabled in Google or Microsoft can no longer sign in here and their sessions expire within
24 hours. That is the reason most buyers want this feature, so it is stated on the screen and
not left to the runbook.

### 4.2 `new/{provider}` — the wizard

Four steps in the URL: `/domains`, `/values`, `/credentials`, `/test`.

**Step 1 — which email domains.**

```text
│  ①Domaines ── ②Valeurs ── ③Identifiants ── ④Test                         │
│                                                                          │
│  Quels domaines de messagerie utilisez-vous ?                            │
│  [ acme.fr ×] [ acme-btp.fr ×] [ +                                    ]  │
│  Une personne dont l'adresse se termine par l'un de ces domaines sera    │
│  envoyée vers Microsoft pour se connecter.                               │
│                                                                          │
│  ℹ Ces domaines doivent vous appartenir. Nous vérifions la propriété     │
│    comme pour une adresse personnalisée.                                 │
│                                                                          │
│  [ Continuer ]                                                           │
```

**Step 2 — the values to paste into Microsoft or Google.**

```text
│  À saisir dans votre espace Microsoft Entra                              │
│  Transmettez cette page à la personne qui administre vos comptes.        │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Nom de l'application    Kodera — ACME                [ Copier ]     │  │
│  │ URI de redirection      https://id.kodera.io/     [ Copier ]     │  │
│  │                         realms/acme-sa/broker/microsoft/endpoint    │  │
│  │ URL de déconnexion      https://id.kodera.io/…    [ Copier ]     │  │
│  │ Autorisations           openid, profile, email       [ Copier ]     │  │
│  │ Types de comptes        Ce répertoire uniquement                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  [ Copier toutes les valeurs ]  [ Télécharger la marche à suivre (1 page)]│
│  [ Envoyer par e-mail à… ]                                               │
│                                                                          │
│  ┌── Marche à suivre ─────────────────────────────────────────────────┐  │
│  │ 1. Ouvrez portal.azure.com puis « Microsoft Entra ID ».            │  │
│  │ 2. « Inscriptions d'applications » → « Nouvelle inscription ».     │  │
│  │ 3. Nom : Kodera — ACME. Types de comptes : ce répertoire.          │  │
│  │ 4. URI de redirection (Web) : collez la valeur ci-dessus.          │  │
│  │ 5. Enregistrez. Notez l'« ID d'application (client) ».             │  │
│  │ 6. « Certificats et secrets » → « Nouveau secret client ».         │  │
│  │    Durée 24 mois. Copiez la valeur immédiatement : elle ne sera    │  │
│  │    plus affichée.                                                  │  │
│  │ 7. Revenez ici et collez les deux valeurs.                         │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  [ Continuer ]                                                           │
```

**Step 3 — the two values back.**

```text
│  Collez les deux valeurs                                                 │
│  ID d'application (client)                                               │
│  [ 4f2c9a10-8e77-4a1e-9c30-0d5b7e2a1f88                              ]   │
│  Il ressemble à : 00000000-0000-0000-0000-000000000000                   │
│                                                                          │
│  Secret client                                                           │
│  [ ••••••••••••••••••••••••••••••••••••••                            ]   │
│  Nous le conservons chiffré. Il ne sera plus jamais affiché.             │
│  Date d'expiration (indiquée par Microsoft)  [ 04/03/2029 ]              │
│  Nous vous préviendrons 30 jours avant.                                  │
│                                                                          │
│  [ Enregistrer et tester ]                                               │
```

**Step 4 — the test.**

```text
│  Testons avant d'activer                                                 │
│  Ce test n'affecte personne d'autre. Vous serez envoyée vers Microsoft,  │
│  puis ramenée ici.                                                       │
│  [ Lancer le test de connexion ]                                         │
│                                                                          │
│  ┌── Résultat ────────────────────────────────────────────────────────┐  │
│  │ ✅ Connexion réussie                                                │  │
│  │    Compte reçu : marie.dupont@acme.fr                              │  │
│  │    Nom : Marie Dupont                                              │  │
│  │    Domaine autorisé : oui                                          │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Comment vos collaborateurs se connecteront                              │
│  (•) Les deux méthodes restent proposées (recommandé pour démarrer)      │
│  ( ) Redirection automatique vers Microsoft                              │
│                                                                          │
│  [ Activer ]                                                             │
```

Failure variant:

```text
│  │ ❌ La connexion a échoué                                            │
│  │    Microsoft a répondu : identifiant ou secret incorrect.          │
│  │    Vérifiez que le secret collé est la « valeur » du secret et non │
│  │    son identifiant — c'est l'erreur la plus fréquente.             │
│  │    [ Corriger les identifiants ]   [ Refaire le test ]             │
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Stepper` (four steps),
`Text field` (domain, client identifier, secret — the secret masked), `Copy-value block` per
value to enter on the provider's side, `Button`, `Status pill`, `Banner`,
`Empty/loading/confirm`.

Console primitives that carry them: `Stepper`, chips input for domains (`Combobox`-style with
removable chips),
`Table` of values with `CopyableCode` per row, `Button` ("Copier toutes les valeurs",
"Télécharger la marche à suivre", "Envoyer par e-mail à…"), runbook as an ordered list inside a
`Card`, `TextField` (client id), `PasswordField` (secret, write-only), date `TextField`
(expiry), `Button` ("Enregistrer et tester"), test result `InlineAlert` with a `DefinitionList`,
`RadioGroup` (login mode), `ConfirmDestructive` (automatic redirection), `Banner` (secret
expiring).

### 4.3 `runbook` — standalone page

The same numbered procedure and value table on its own printable page, reachable without the
wizard so it can be sent as a link, and downloadable as a one-page PDF.

### 4.4 Confirmation before automatic redirection

```text
┌── Activer la redirection automatique ? ──────────────────────┐
│ Vos collaborateurs n'auront plus l'écran de mot de passe :   │
│ ils seront envoyés directement vers Microsoft.               │
│                                                              │
│ Les personnes sans compte Microsoft — invitées par e-mail    │
│ ou par code sur site — ne pourront plus se connecter.        │
│ Vous en avez 14 aujourd'hui.                                 │
│                                                              │
│ Vous pouvez revenir en arrière à tout moment depuis cette    │
│ page.                                                        │
│                                                              │
│ [ Activer la redirection ]                   [ Annuler ]     │
└──────────────────────────────────────────────────────────────┘
```

This count is the whole point of the dialog: it is the mistake a CEO makes alone.

## 5. State matrix

| Screen | Default | Loading | Empty | Error | Success | Partial failure | Permission denied | Offline |
|---|---|---|---|---|---|---|---|---|
| `overview` | Two provider cards | `Skeleton` cards | Not configured → the cards **are** the empty state, with the twenty-minute warning | Fetch fails → retry | Configured summary with the last successful test | Configured but never tested → the summary shows "Jamais testé" with the test action highlighted | `member` does not see the area; tier below Business → cards disabled with the tier named | Banner; setup disabled |
| `new/domains` | Empty chips | n/a | n/a | Domain not owned, or already federated elsewhere → chip error | Advances | One of three domains unverified → the two verified are kept and the third is marked, with a link to the domain proof | as above | Continue disabled |
| `new/values` | Value table + runbook | `Skeleton` | n/a | Values could not be generated → error with retry and support | Advances | Values shown but the PDF fails → the on-screen runbook and copy still work, the download shows its own error | as above | Copy works from cache; email sending disabled |
| `new/credentials` | Two fields | n/a | n/a | Format errors inline; save fails → the client id is kept, the secret field is cleared with an explanation | Advances to the test | Saved but expiry not parsed → saved, with a reminder to set the expiry so we can warn them | as above | Save disabled |
| `new/test` | Test button | Button busy during the round-trip | n/a | Provider rejected the credentials, or the domain claim did not match → cause + the most likely mistake + two actions | Result panel + activation choice | Sign-in succeeded but the email domain is not in the list → success with a warning, offering to add the domain | as above | Test disabled |
| activation | Two modes | n/a | n/a | Activation fails → nothing changed, retry | `Toast` + the overview | Enabled for sign-in but automatic redirection refused → federation active in both-methods mode, with the reason | as above | Disabled |
| `runbook` | Procedure | `Skeleton` | n/a | Values unavailable → support | n/a | n/a | Readable by any role in the organisation | Cached |

## 6. Core API calls

The resource is `federation-providers`, plural, because the thing being configured is one identity
provider; `federation` is the area, not the row.

| Method | Path | Fields sent | Fields read |
|---|---|---|---|
| `GET` | `/api/v1/tenants/{tenant_id}/federation-providers` | `cursor`, `limit`, `state` | `data[]{ id, provider: google\|microsoft, state: draft\|configured\|active\|disabled, label, login_mode: both\|redirect, allowed_email_domains[], secret_set, secret_expires_on, last_test{ id, result, at }, hosted_account_count }` |
| `POST` | `/api/v1/tenants/{tenant_id}/federation-providers` | `Idempotency-Key`; `provider`, `allowed_email_domains[]`, `label?`, `locale?` | The draft, with `values{ application_name, redirect_uri, logout_uri, scopes[], account_types_label_key, issuer_url, entity_id, acs_url }` |
| `GET` | `/api/v1/federation-providers/{federation_provider_id}` | — | As above, plus `domain_checks[]{ domain, verified, checked_at, failure_code }` |
| `PATCH` | `/api/v1/federation-providers/{federation_provider_id}` | `allowed_email_domains[]`, `label` | The provider |
| `PATCH` | `/api/v1/federation-providers/{federation_provider_id}/credentials` | `client_id`, `client_secret`, `secret_expires_on?` | `client_id, secret_set: true, secret_expires_on, state` — the secret is never returned |
| `POST` | `/api/v1/federation-providers/{federation_provider_id}/tests` | `Idempotency-Key`; `return_url` | `id, state: pending, authorization_url` — the console sends the browser there |
| `GET` | `/api/v1/federation-tests/{federation_test_id}` | — | `state, result: success\|failed, subject_email_masked, display_name, domain_allowed, failure_code, provider_message_key, completed_at` |
| `GET` | `/api/v1/federation-providers/{federation_provider_id}/tests` | `cursor`, `limit` | The test history, newest first |
| `POST` | `/api/v1/federation-providers/{federation_provider_id}/actions/activate` | `Idempotency-Key`; `login_mode: both\|redirect`, `acknowledged_hosted_accounts` | `202`: `job_id, kind, status, job_url` |
| `DELETE` | `/api/v1/federation-providers/{federation_provider_id}` | — | `202`: `job_id, kind, status, job_url` |
| `GET` | `/api/v1/federation-providers/{federation_provider_id}/runbook` | `locale` | `provider`, `steps[]{ index, body_key, value_ref, caution_key }`, `estimated_duration_s`, `download{ url, expires_at }` |
| `POST` | `/api/v1/federation-providers/{federation_provider_id}/runbook-shares` | `Idempotency-Key`; `recipient_email`, `note?`, `locale?` | `id, recipient_email, sent_at` — the Core API sends it |
| `GET` | `/api/v1/organisations/{organisation_id}/memberships/count` | `account_kind=hosted` | `count`, `counted_at` — the number shown in the redirection confirmation |

Notes.

- The console **never** calls Keycloak, Entra, or Google. Identity-provider configuration is a
  Core API operation applied to the tenant realm server-side (ADR-0003).
- **`domains[]` is `allowed_email_domains[]`**, and it is what stops a personal Google account from
  entering the tenant: a sign-in from an address outside the list is refused with
  `domain_not_allowed` rather than silently given an account.
- **The client secret is write-only, and the method is `PATCH`, not `PUT`.** This API does not use
  `PUT`; replacement semantics are a `PATCH` carrying every field. Nothing returns `client_secret`,
  to anybody, and it never appears in a log, an analytics event or an error message. A failed save
  clears the field rather than re-rendering the value.
- `values` are **generated**, never typed by the customer. A redirect URI with one wrong character
  is the most common reason a federation never works, and it produces an error naming neither the
  URI nor the typo.
- `login_mode` is not patchable on the provider. Switching an organisation to `redirect` is the
  activation action, because it needs the hosted-account count in front of the person doing it:
  `acknowledged_hosted_accounts` must equal the current `memberships/count?account_kind=hosted`, and
  a stale number is refused with `conflict`.
- Activation and disabling both answer `202` with a job, because both reload the tenant realm. The
  console polls the job and re-reads the provider.
- `failure_code` is a closed enum — `invalid_client`, `invalid_secret`, `redirect_uri_mismatch`,
  `consent_required`, `tenant_mismatch`, `domain_not_allowed`, `domain_not_verified`,
  `provider_unreachable`, `token_expired`, `user_cancelled`, `provider_error` — each mapped to one
  copy key and to the mistake most often behind it.
- `provider_message_key` is a **translated key**, not the provider's raw string; the raw provider
  message is kept server-side for support.
- `subject_email_masked` is masked by the API (`m****e@acme.fr`) so the test result can be shown
  without putting an address on screen for a bystander.
- The runbook is data, not a document: `steps[].body_key` is a message key and `value_ref` names
  which member of `values` the step refers to, so the console renders it copyable and it stays
  correct when a generated value changes. There is no `format=` parameter; `download` is the PDF.

## 7. MSW scenario overlays

| Overlay | Deviation |
|---|---|
| `federation.not-configured` | `tenants/{id}/federation-providers` returns an empty page |
| `federation.microsoft-draft` | One provider in `state: draft`, `secret_set: false` |
| `federation.values-generated` | `values` and `runbook` present for `provider: microsoft` |
| `federation.domain-unverified` | Two `domain_checks[]`, one with `verified: false` |
| `federation.test-success` | `federation-tests/{id}` returns `result: success`, `domain_allowed: true` |
| `federation.test-invalid-secret` | `failure_code: invalid_secret` |
| `federation.test-redirect-mismatch` | `failure_code: redirect_uri_mismatch` |
| `federation.test-domain-not-allowed` | `result: failed`, `failure_code: domain_not_allowed`, `domain_allowed: false` |
| `federation.test-cancelled` | `failure_code: user_cancelled`; worded as an interruption, not a misconfiguration |
| `federation.active-both-modes` | `state: active`, `login_mode: both`, `last_test.at` four days ago |
| `federation.hosted-accounts-14` | `memberships/count?account_kind=hosted` returns `count: 14` |
| `federation.acknowledgement-stale` | `actions/activate` returns `409` `conflict`; the count moved between the screen and the button |
| `federation.secret-expiring` | `secret_expires_on` 21 days out |
| `federation.runbook-pdf-failed` | `runbook` returns `download: null` |
| `federation.entitlement-locked` | `entitlements` returns `federation` with `enabled: false`, `required_pack_code: visio-docs-pro` |

## 8. Validation rules

| Field | Rule | When | Copy key |
|---|---|---|---|
| Domains | At least one | On submit | `console.federation.domains.error-required` |
| Domains | Valid hostname, lower-cased, no `@`, no scheme (a pasted `@acme.fr` is corrected silently) | On chip creation | `console.federation.domains.error-format` |
| Domains | Owned by this organisation | Server | `console.federation.domains.error-not-verified` |
| Domains | Not already used by another organisation | Server | `console.federation.domains.error-claimed-elsewhere` |
| Domains | At most 10 | On chip creation | `console.federation.domains.error-too-many` |
| Client id | Required | On submit | `console.federation.credentials.error-client-id-required` |
| Client id (Microsoft) | UUID shape | On blur | `console.federation.credentials.error-client-id-format` |
| Client id (Google) | Ends in `.apps.googleusercontent.com` | On blur | `console.federation.credentials.error-client-id-format` |
| Client secret | Required, ≥ 8 characters, whitespace trimmed | On submit | `console.federation.credentials.error-secret-required` |
| Client secret | A value that looks like the secret's **identifier** rather than its value (Microsoft returns both, and the identifier is a UUID) triggers a blocking error naming the mistake | On blur | `console.federation.credentials.error-secret-looks-like-id` |
| Secret expiry | Optional; a date in the future, at most 5 years out | On blur | `console.federation.credentials.error-expiry-range` |
| Activation | A successful test within the last 30 days is required before activating | Client + server | `console.federation.test.error-test-required` |
| Automatic redirection | Requires an explicit confirmation naming the hosted-account count | Client | `console.federation.activate.confirm-redirect-body` |

The secret-looks-like-an-id rule is deliberate: it is the single most common failure in this
flow, and catching it before the round-trip saves the check-in.

## 9. Error copy rules

Cause, then next action, and — because the failure is usually in a screen we do not control — a
sentence naming **the most likely mistake in the provider's console**, in the provider's own
words.

| `failure_code`, or condition | Copy key | Most likely mistake named |
|---|---|---|
| `invalid_client` | `console.federation.test.error-invalid-client` | The application identifier was copied from the wrong application, or from the directory id |
| `invalid_secret` | `console.federation.test.error-invalid-secret` | The secret's identifier was pasted instead of its value |
| `redirect_uri_mismatch` | `console.federation.test.error-redirect-mismatch` | The redirect URI was truncated, or added as "SPA" instead of "Web" |
| `consent_required` | `console.federation.test.error-consent-required` | An administrator must grant consent for the organisation |
| `tenant_mismatch` | `console.federation.test.error-tenant-mismatch` | The application was declared as multi-tenant, or the account used for the test is in another directory |
| `domain_not_allowed` | `console.federation.test.error-domain-not-allowed` | The address used for the test is not in `allowed_email_domains` — offers to add it |
| `domain_not_verified` | `console.federation.test.error-domain-not-verified` | The domain is claimed but not yet proven to belong to this organisation |
| `provider_unreachable` | `console.federation.test.error-provider-unreachable` | Nothing is wrong with the configuration; retry |
| `token_expired` | `console.federation.test.error-token-expired` | The secret has expired; create a new one, the procedure is linked |
| `user_cancelled` | `console.federation.test.error-cancelled` | The sign-in window was closed; nothing is wrong, run the test again |
| `provider_error` | `console.federation.test.error-provider` | The provider refused for a reason it did not name; support has the detail, with the `request_id` |
| `secret_expires_on` within 30 days | `console.federation.overview.warning-secret-expiring` | 30 days' notice, with the renewal steps |
| `conflict` on `actions/activate` | `console.federation.activate.error-count-changed` | Somebody joined or left while the confirmation was open; re-read the count and confirm again |
| `conflict` on `DELETE` | `console.federation.overview.error-last-route` | Turning it off would leave nobody able to sign in; create a hosted owner account first |

No provider error string is ever shown raw. The console never suggests that the customer's IT
provider made a mistake; it names the field, not the person.

## 10. Accessibility

- The value table is a real `table` with a caption; each value is a `CopyableCode` whose
  accessible name includes the field ("Copier l'URI de redirection"). Long URIs wrap; the table
  scrolls in its own container.
- The runbook is an ordered list with real list semantics; values inside a step are inline
  `CopyableCode` elements with their own accessible names, so a step can be followed by ear.
- **Focus order (`values`):** `h1` → the "transmettez cette page" sentence → value table (row by
  row with its copy button) → copy-all → download → send-by-email → runbook list → "Continuer".
- The secret field is `type="password"` with a "Afficher" toggle whose state is announced; the
  field is never pre-filled and never re-rendered with a value after an error.
- The test round-trip announces its start ("Redirection vers Microsoft") and, on return, moves
  focus to the result heading and announces the outcome once.
- The result `DefinitionList` reads as pairs ("Compte reçu : m****e@acme.fr").
- The activation `RadioGroup` labels describe the consequence, not the mechanism; the redirection
  option's description carries the hosted-account count so it is heard before selection.
- `ConfirmDestructive` for automatic redirection: focus on the heading, `Escape` cancels, the
  confirm button names the provider, and the count of affected people is inside the dialog's
  accessible description.
- The secret-expiry banner is `role="status"`, not `role="alert"` — it is 30 days out, not an
  emergency.
- Reduced motion: the "test en cours" state is static text with `aria-busy`.

## 11. Analytics events

No personal data: never a client id, never a secret, never an email address or a customer domain
(domains are counted and hashed, never carried).

| Event | Properties |
|---|---|
| `federation_started` | `provider`, `source` |
| `federation_domains_set` | `provider`, `domain_count` |
| `federation_values_copied` | `provider`, `scope` (`field` \| `all`) |
| `federation_runbook_downloaded` | `provider` |
| `federation_runbook_shared` | `provider` |
| `federation_credentials_saved` | `provider`, `expiry_provided` (bool) |
| `federation_secret_id_mistake_caught` | `provider` |
| `federation_test_run` | `provider`, `attempt_index` |
| `federation_test_result` | `provider`, `result`, `failure_code` |
| `federation_activated` | `provider`, `login_mode` |
| `federation_redirect_confirmed` | `provider`, `hosted_account_bucket` |
| `federation_disabled` | `provider` |
| `federation_checkin_requested` | `provider`, `step` |
| `federation_secret_expiry_warned` | `provider`, `days_left_bucket` |

`attempt_index` and `failure_code` together are the measurement that tells us whether the runbook
works. If most tenants succeed on attempt 1, the guided path is doing its job; if the median is 3,
the runbook is wrong.

## 12. Acceptance tests

1. **Given** no provider is configured (`federation.not-configured`),
   **when** the area loads,
   **then** it states the twenty-minute expectation and the need for the person who administers
   the organisation's accounts, and offers a check-in before offering the two providers.
   `federation/overview: sets the expectation before offering the providers`

2. **Given** Microsoft values have been generated (`federation.values-generated`),
   **when** the values step loads,
   **then** every value is individually copyable, a single action copies them all, and the
   numbered procedure names the exact menus in the provider's console.
   `federation/values: produces a forwardable value sheet and a numbered procedure`

3. **Given** the user pastes the secret's identifier instead of its value,
   **when** the secret field loses focus,
   **then** the error names that exact mistake, the field is cleared, and no round-trip is
   attempted.
   `federation/credentials: catches the secret identifier pasted instead of the secret`

4. **Given** the credentials are wrong (`federation.test-invalid-secret`),
   **when** the test returns,
   **then** the result names the cause, names the most likely mistake in the provider's console,
   and offers both correcting the credentials and re-running the test.
   `federation/test: explains a rejected secret and offers the two next steps`

5. **Given** a redirect URI mismatch (`federation.test-redirect-mismatch`),
   **when** the test returns,
   **then** the message names the truncation and the Web-versus-SPA mistake, and the exact URI is
   copyable from the result panel.
   `federation/test: names the redirect URI mistake and offers the value again`

6. **Given** a successful sign-in with an address outside the declared domains
   (`federation.test-domain-not-allowed`),
   **when** the test returns,
   **then** the result is shown as a success with a warning, and adding the domain is offered as
   one action.
   `federation/test: treats an undeclared domain as a warning, not a failure`

7. **Given** a successful test and 14 hosted accounts (`federation.test-success`,
   `federation.hosted-accounts-14`),
   **when** the user chooses automatic redirection,
   **then** the confirmation states that the 14 people invited by email or on-site code will no
   longer be able to sign in, and cancelling leaves both methods available.
   `federation/activate: names how many people automatic redirection would lock out`

8. **Given** activation is attempted without a recent successful test,
   **when** the user presses "Activer",
   **then** activation is refused with a message asking for a test first, and the test action is
   focused.
   `federation/activate: refuses activation without a successful test`

9. **Given** one declared domain is unverified (`federation.domain-unverified`),
   **when** the domains step is submitted,
   **then** the verified domains are kept, the unverified one is marked, and a link leads to the
   proof of ownership for that domain.
   `federation/domains: keeps the verified domains and links the proof for the rest`

10. **Given** the runbook PDF fails (`federation.runbook-pdf-failed`),
    **when** the download is attempted,
    **then** the on-screen procedure and the copy actions still work and the failure is shown on
    the download button only.
    `federation/values: keeps the procedure usable when the PDF fails`

11. **Given** a keyboard-only user on the values step,
    **when** they copy the redirect URI and move through the procedure,
    **then** each copy is announced with the field it belongs to and the procedure is readable
    step by step without a mouse.
    `federation/values: copies each value with the keyboard alone`

## 13. Out of scope for launch

- Unattended, fully automatic federation: launch is **guided** by decision (R3), with one
  check-in expected per federated tenant.
- Directory sync and automatic deprovisioning from the customer's IdP, planned after launch.
- Generic SAML and OIDC providers beyond Google and Microsoft; other providers go through
  support at launch.
- Group-to-role mapping from the provider's claims.
- ProConnect: a partnership track, not a launch wave.
- Automatic rotation of the client secret; we warn 30 days ahead and the customer rotates it
  with the runbook.
- More than one federated provider per organisation at a time.
- One-click export and delete of the organisation's data (planned after launch).

## Changelog

- The check-in is worded as a member of the Kodera team, the product's name, and the application
  name in the step 2 value sheet reads « Kodera — ACME » (UX audit OL-14). That value is
  `values.application_name` from Core; the contract's examples still carry the previous name.

- Aligned with the delivered design: federation is the second tab of Domaine & identité rather
  than its own navigation item, with the old deep link redirecting into it; the check-in is
  stated as designed rather than as a fault, with its own read-only review state; the
  deprovisioning promise and its 24-hour session window are stated before activation; the
  component lists name the delivered components.

- Initial version: guided Google and Microsoft setup, generated value sheet and one-page runbook,
  write-only secret with the identifier-versus-value guard, mandatory test before activation,
  automatic-redirection confirmation naming the hosted-account count.
- Reconciled with the Core API contract, which gained the whole area: `federation-providers` as the
  resource, `PATCH .../credentials` in place of `PUT` because this API does not use `PUT`,
  `allowed_email_domains[]`, activation as an `actions/activate` job carrying
  `acknowledged_hosted_accounts`, the hosted-account count from `memberships/count`, and
  `failure_code` in snake_case with three values added for the cases the first draft could not
  express.
