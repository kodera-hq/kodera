# Copy mapping — design drop → console catalogue

**Status:** Proposed · **Owner:** zôÖma

The design drop (`design-drop/COPY.md` and `design-drop/specs/*.md`) carries the owner-approved
French copy under short, screen-local keys — `order.title`, `home.pending.banner`. The console
catalogues use `console.<area>.<screen>.<key>` (`README.md` §4). This table is the one-to-one
mapping between them, so that a string can be traced from the design file to the runtime key and
back.

**The rule applied throughout: the drop's French wins.** Where the two catalogues covered the
same string, the drop's wording replaced ours. Where the drop wrote nothing, our key and its
wording stand — the drop covers the happy paths, and the catalogue also covers loading, empty,
partial-failure, permission-denied and offline states, which is why it has roughly six times as
many keys.

The six exceptions, where the catalogue differs from the drop and the reason, are in the last section.

## Placeholders

The drop's placeholders are normalised into the catalogue's named set on the way in. This is a
mechanical rename, never a change of meaning.

| Drop | Catalogue | Note |
|---|---|---|
| `{n}` | `{count}` | Plurals become ICU `plural` in the catalogue value |
| `{h}` | `{hours}` | |
| `{d}` | `{days}` | |
| `{idp}` | `{provider}` | |
| `{org}`, `{legalName}` | `{organisation}` | |
| `{name}` | `{person}` | |
| `{price}` | `{amount}` | Rendered from a `Money` object, minor units |
| `{eta}` (planned apps) | `{quarter}` | Never rendered without one |
| `{firstName}`, `{date}`, `{time}`, `{slug}`, `{plan}`, `{version}`, `{min}`, `{max}`, `{cycle}`, `{suggestion}`, `{apps}` | unchanged | Already named |

## 1. Navigation and shell

| Drop key | Catalogue key | Disposition |
|---|---|---|
| `nav.home` | `console.shell.nav.title-home` | New |
| `nav.apps` | `console.shell.nav.title-apps` | Catalogue key renamed from `console.shell.nav.title-status`; value from the drop |
| `nav.people` | `console.shell.nav.title-people` | Same value in both |
| `nav.domain` | `console.shell.nav.title-domain` | Drop's value ("Domaine & identité") |
| `nav.billing` | `console.shell.nav.title-invoices` | Drop's value ("Facturation") |
| `nav.help` | `console.shell.nav.title-help` | Same value in both |
| — | `console.shell.nav.title-federation` | **Removed.** Federation is a tab of Domaine & identité, not a navigation item; the tab label is `console.domain.list.label-tab-federation` |
| `role.admin` | `console.shell.account.status-role-admin` | New — the sidebar account block |
| `role.member` | `console.shell.account.status-role-member` | New |
| `status.ok` | `console.status.overview.status-all-operational` | Existing, same value |
| `status.incident` | `console.home.overview.subtitle-incident` | New, worded for the Accueil header |
| `action.copy` / `action.copied` | `console.common.action-copy` / `console.common.toast-copied` | Existing, same values |
| `action.open` | `console.common.action-open` | New |
| `action.cancel` | `console.common.action-cancel` | Existing, same value |

## 2. Home (`08-home.md`)

Every key in this section is new; the area did not exist in the catalogue.

| Drop key | Catalogue key |
|---|---|
| `home.greeting` | `console.home.overview.title` |
| `home.subtitle` | `console.home.overview.subtitle` |
| `home.status.ok` (spec 02) | `console.home.overview.subtitle` (the same sentence's second half) |
| `home.status.incident` (spec 02) | `console.home.overview.subtitle-incident` |
| `home.capacity.label` | `console.home.overview.label-capacity` |
| `home.capacity.help` | `console.home.overview.hint-capacity` |
| `home.invoice.label` | `console.home.overview.label-next-invoice` |
| `home.invoice.help` | `console.home.overview.hint-next-invoice` |
| `home.availability.label` | `console.home.overview.label-availability` |
| `home.availability.ok` | `console.home.overview.status-availability-met` |
| `home.pending.banner` | `console.home.overview.status-pending-invitations` |
| `home.pending.cta` | `console.home.overview.action-resend-invitations` |
| `home.apps.note` | `console.home.overview.hint-backup` |
| `home.planned` | `console.home.overview.status-app-planned` |
| `home.contract.label` | `console.home.overview.title-contract` |
| `home.support.title` | `console.home.overview.title-support` |
| `home.support.body` | `console.home.overview.hint-support` |
| `home.support.cta` | `console.home.overview.action-support` |

## 3. Order (`01-order.md`)

| Drop key | Catalogue key | Disposition |
|---|---|---|
| `order.title` | `console.order._.title` | New |
| `order.subtitle` | `console.order._.subtitle` | New |
| `order.step.pack` / `org` / `contract` / `done` | `console.order._.label-step-plan` / `-contacts` / `-agreements` / `-confirmation` | New, four keys from one drop row |
| `order.headcount.label` | `console.order.plan.label-headcount` | Drop's value |
| `order.headcount.help` | `console.order.plan.hint-headcount` | Drop's value |
| `order.plan.recommended` | `console.order.plan.status-recommended` | New |
| `order.plan.concurrent` | `console.order.plan.hint-capacity` | Drop's value |
| `order.plan.designedFor` | `console.order.plan.label-designed-for` | Drop's value |
| `order.plan.monthlyNote` | `console.order.plan.label-price-monthly-note` | New |
| `order.billing.annual` | `console.order.plan.label-annual` | Drop's value |
| `order.billing.monthly` | `console.order.plan.label-monthly` | Drop's value |
| `order.billing.ngo` | `console.order.plan.label-ngo` | New |
| `order.continue` | `console.order.plan.action-choose` | Drop's value |
| `order.slug.help`, `order.step2.slugHelp` | `console.order.contacts.hint-slug` | Drop's sentence kept, after the address preview our key already carried |
| `order.slug.taken` | `console.order.contacts.error-slug-taken` | Drop's value |
| `order.admin.help` | `console.order.contacts.hint-admin-email` | New |
| `order.contract.intro` | `console.order.agreements.subtitle` | Drop's value |
| `order.contract.accept`, `order.step3.accept` | `console.order.agreements.label-acceptance` | Drop's value |
| `order.contract.callback` | `console.order.agreements.label-callback` | New |
| `order.sign` | `console.order.agreements.action-submit` | Drop's value |
| `order.done.title`, `order.step4.title` | `console.order.confirmation.title` | Drop's value |
| `order.done.body` | `console.order.confirmation.subtitle` | Drop's value |
| `order.eta`, `order.step4.eta` | `console.order.confirmation.status-eta` | New |

## 4. Applications (`02-status.md`)

| Drop key | Catalogue key | Disposition |
|---|---|---|
| `apps.subtitle` | `console.status.overview.subtitle-live` | New |
| `apps.history.note` | `console.status.history.hint-schedule` | New |
| `apps.docs.export` | `console.status.overview.label-docs-export` | New |
| `apps.planned` | `console.home.overview.status-app-planned` | Same string as `home.planned`; one key, used on both screens |
| `domain.fallback` (used on this screen too) | `console.status.overview.label-app-fallback` | New |

## 5. People (`03-people.md`)

| Drop key | Catalogue key | Disposition |
|---|---|---|
| `people.subtitle` | `console.people.list.subtitle` | Drop's value |
| `people.invite.email` | `console.people.list.action-invite-email` | Existing, same value |
| `people.invite.csv` | `console.people.list.action-invite-import` | Drop's value |
| `people.invite.help` | `console.people.invite.hint-validity` | New |
| `people.invite.emails` | `console.people.invite.label-emails` | Drop's value |
| `people.role.admin.help` | `console.people.invite.label-role-admin` | Drop's value |
| `people.invite.send` | `console.people.invite.action-send` | Existing ICU plural kept; it is the drop's sentence with correct singular handling |
| `people.filter.all` / `admins` / `pending` | `console.people.list.label-filter-all` / `-admins` / `-pending` | New, three keys from one drop row |
| `people.status.active` | `console.people.list.status-active` | New |
| `people.status.pending` | `console.people.list.status-invited` | Drop's value |
| `people.remove.title` | `console.people.members.confirm-remove-title` | Existing, same sentence |
| `people.remove.body` | `console.people.members.confirm-remove-body` | Drop's value |
| `people.remove.lastAdmin` | `console.people.members.error-last-admin` | New; `error-last-owner` stays for the owner role |
| `people.empty.title` | `console.people.list.empty-title` | Drop's value |
| `people.empty.body` | `console.people.list.empty-body` | Drop's value |
| `people.qr.title` | `console.people.on-site.title-qr` | New — the QR panel heading; `console.people.on-site.title` remains the screen title |
| `people.qr.body` | `console.people.on-site.hint-qr` | New |
| `people.fed.title` | `console.people.list.title-federation-nudge` | New |
| `people.fed.body` | `console.people.list.hint-federation-nudge` | New |

## 6. Domain (`04-domain.md`)

| Drop key | Catalogue key | Disposition |
|---|---|---|
| `domain.subtitle` | `console.domain.list.subtitle` | Drop's value |
| `domain.tab.domains` / `sso` | `console.domain.list.label-tab-domains` / `-tab-federation` | New, two keys from one drop row |
| `domain.intro` | `console.domain.new.hint-intro` | New |
| `domain.step1` / `2` / `3` | `console.domain.new.label-step-proof` / `-point` / `-certificate` | New, three keys from one drop row |
| `domain.line1` | `console.domain.verify.title-line1` | New |
| `domain.line2` | `console.domain.point.title-line2` | New |
| `domain.verify` | `console.domain.verify.action-check` | Existing, same value |
| `domain.checking` | `console.domain.verify.status-checking` | New |
| `domain.verified` | `console.domain.list.status-active` | Drop's value ("Vérifié") |
| `domain.notyet` | `console.domain.verify.status-not-yet-visible` | New; `console.domain.verify.status-auto-recheck` updated to the drop's ten-minute rule |
| `domain.copy` / `domain.copied` | `console.common.action-copy` / `console.common.toast-copied` | Existing, same values |
| `domain.guide` | `console.domain.verify.action-guide-per-registrar` | New |
| `domain.fallback` | `console.domain.list.badge-provided` | Drop's value ("Secours") |

## 7. Federation (`07-federation.md`)

| Drop key | Catalogue key | Disposition |
|---|---|---|
| `fed.title` | `console.federation.overview.title-provider` | New |
| `fed.intro` | `console.federation.overview.subtitle-guided` | New |
| `fed.domain` | `console.federation.domains.label` | New |
| `fed.domain.help` | `console.federation.domains.hint-restriction` | New; our `console.federation.domains.hint` states a different fact and stays |
| `fed.clientId` | `console.federation.credentials.label-client-id` | Drop's value |
| `fed.secret` | `console.federation.credentials.label-secret` | Drop's value |
| `fed.save` | `console.federation.credentials.action-save-and-test` | Drop's value |
| `fed.eta` | `console.federation.overview.status-eta` | New |
| `fed.pending` | `console.federation.overview.status-pending-review` | New; `{contact}` dropped — no contract field carries a support contact's name |
| `fed.values` | `console.federation.values.title` | Drop's value |
| `fed.guide` | `console.federation.values.action-download-runbook` | Drop's value |
| `fed.deprovision`, `fed.deprovision.note` | `console.federation.overview.hint-deprovisioning` | New |
| `fed.test.mismatch` | `console.federation.test.error-redirect-mismatch` | **Catalogue's value kept** — see the exceptions below |

## 8. Billing (`05-invoices.md`)

| Drop key | Catalogue key | Disposition |
|---|---|---|
| `billing.subtitle` | `console.invoices.list.subtitle` | New |
| `billing.upToDate` | `console.invoices.list.status-up-to-date` | New |
| `billing.monthly` | `console.invoices.list.label-monthly-ex-vat` | New |
| `billing.nextCharge` | `console.invoices.list.label-next-charge` | New |
| `billing.commitment` | `console.invoices.subscription.label-commitment` | New |
| `billing.included` | `console.invoices.subscription.hint-included` | New |
| `billing.changePlan` | `console.invoices.list.action-change-plan` | **Catalogue's value kept** — see the exceptions below |
| `billing.eventPack` | — | Not merged: no add-on exists in the Core API contract (`05-invoices.md`, contract gaps) |
| `billing.sepa.note` | `console.invoices.list.hint-payment-method` | New |
| `billing.invoices.note` | `console.invoices.list.hint-issuer` | New |
| `billing.status.paid` | `console.invoices.list.status-paid` | Existing, same value |
| `billing.status.overdue` | `console.invoices.list.status-overdue-short` | New; `status-overdue` keeps the day count |
| `billing.overdue` (spec 04) | `console.shell.banner.status-dunning` | **Catalogue's value changed** — see the exceptions below |
| `billing.downgrade.note` (spec 04) | `console.invoices.subscription.hint-downgrade` | New |

## 9. Help and status (`06-support.md`)

| Drop key | Catalogue key | Disposition |
|---|---|---|
| `help.subtitle` | `console.support.panel.subtitle` | New |
| `help.form.title` | `console.support.new.title` | Drop's value |
| `help.form.help` | `console.support.new.subtitle` | New |
| `help.form.subject` | `console.support.new.label-subject` | Drop's value |
| `help.form.body` | `console.support.new.label-body` | Drop's value |
| `help.form.placeholder`, `help.form.bodyPlaceholder` | `console.support.new.placeholder-body` | New |
| `help.form.attached` | `console.support.new.status-context-attached` | New |
| `help.status.title` | `console.support.panel.title-status` | New |
| `help.status.web` / `calls` / `login` | `console.support.panel.label-component-web` / `-calls` / `-login` | New, three keys from one drop row |
| `help.status.operational` | `console.status.overview.status-component-operational` | Existing, same value |
| `help.maintenance` | `console.support.panel.status-maintenance` | New; `console.status.overview.status-maintenance` also takes the drop's second sentence |
| `help.faq.title` | `console.support.panel.title-faq` | New |
| `help.sent` (spec 08) | `console.support.new.status-submitted` | **Catalogue's value kept** — see the exceptions below |

## 10. Not merged: other surfaces

The drop's last two sections are not console copy and are not merged here. They are recorded so
that nothing looks lost.

| Drop keys | Where they belong |
|---|---|
| `mail.ready.*`, `mail.invite.*`, `mail.incident.*` | Transactional email templates, owned by `kodera-core`. The one fact the console restates — an invitation lives 14 days — is `console.people.invite.hint-validity` |
| `hero.*`, `pricing.*` | The marketing site (`kodera.io/visio`), not the console |

## 11. Conflicts resolved against the drop

Six strings where the catalogue's wording differs from the drop. Everywhere else the drop won.

| Drop key | Why the catalogue's version stayed |
|---|---|
| `fed.test.mismatch` | The drop's sentence loses the actual fix. `console.federation.test.error-redirect-mismatch` names the two causes we see in practice — an incomplete URI, and an application declared as "SPA" instead of "Web" — and that sentence is the difference between a customer solving it and booking a check-in |
| `billing.changePlan` ("Changer de tier") | "Tier" is untranslated English jargon in a French sentence, which the drop's own voice principle forbids. The catalogue says "Changer de formule", and the drop uses "formule" elsewhere. Tier *names* — Business Plus — stay untranslated, as the drop's header requires |
| `help.sent` | The drop names a support contact and a number of hours. `HelpContext.sla` carries neither a name nor a rounded hour count; it carries `next_response_due_at`, computed by the server including French public holidays. The catalogue states the deadline the server computed |
| `people.qr.title` ("Enrôlement par QR code") | Kept as the QR panel's heading, not as the screen title. "Enrôlement" is the word the drop's own glossary principle tells us to translate, and "Accès sur site" is what the buyer is doing |
| `billing.overdue` ("La facture {number} est en retard de {days} jours") | The shell's banner reads `status-summary`, which carries the amount due and the invoice's id but neither its number nor a day count. Printing the id as the number and 0 as the count put a UUID and "0 jours" in front of the customer; the catalogue says "Une facture est en retard de paiement ({amount})" and links to the invoice, which states both |
| `role.admin` ("Administratrice / Administrateur") | Kept verbatim in the sidebar account block, where there is room for it. The People table's role column keeps the single form, because a 30-character double form in a data cell wraps every row |

## Changelog

- The shell's overdue banner leaves the drop's sentence: its invoice number and day count are not
  in the data the shell reads (§11).

- Initial version: the design drop's keys mapped one-to-one onto `console.<area>.<screen>.<key>`,
  the placeholder normalisation, the two drop sections that belong to other surfaces, and the
  five strings where the catalogue's wording was kept with the reason.
