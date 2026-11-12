# Message catalogue — English

**Status:** Proposed · **Owner:** zôÖma

English is the console's second language. `fr.md` is the source of truth for meaning; this file
translates it key for key. CI fails when a key exists in one file and not the other.

## Rules applied throughout

- **Buttons are verb-led** and name the outcome: "Send invitations", never "OK" or "Submit".
- **Errors state the cause, then the next action**, in that order, in one or two sentences.
- **No product jargon**: never "tenant", "realm", "provisioning", "job". The customer reads
  "your accounts", "setting up", "sign in with your company accounts". **"Instance" is customer
  vocabulary**, not jargon, per the owner-approved glossary in
  [`../README.md`](../README.md); "your space" survives in the strings written before the design
  drop and means the same thing.
- **Money**: `€5.99`, `€403.20`, `€1,490`. Format examples only; the runtime formats with `Intl`.
- **Dates** in body copy are written in full: `31 December 2026`, `1 March 2027`. Tables may use
  `31/12/2026`. Times use `15:30`. Format examples only.
- **Placeholders** are the same named placeholders as in French: `{count}`, `{organisation}`,
  `{host}`, `{amount}`, `{date}`, `{person}`, `{provider}`. Plurals use ICU `plural`.
- English is British: "organisation", "apologise", "-ise" endings. It is the language of the NGO
  and DPG segment, so it avoids French-specific legal shorthand and spells out what a French term
  means when there is no equivalent.

---

## 1. Common

| Key | Text |
|---|---|
| `console.common.action-continue` | Continue |
| `console.common.action-back` | Back |
| `console.common.action-cancel` | Cancel |
| `console.common.action-retry` | Try again |
| `console.common.action-copy` | Copy |
| `console.common.action-copy-all` | Copy all |
| `console.common.action-download` | Download |
| `console.common.action-close` | Close |
| `console.common.action-open` | Open |
| `console.common.action-resend` | Resend |
| `console.common.action-contact-support` | Contact us |
| `console.common.action-load-more` | Show {count} more |
| `console.common.toast-copied` | Copied |
| `console.common.a11y-copied` | {field} copied to the clipboard. |
| `console.common.a11y-opens-new-tab` | Opens in a new tab |
| `console.common.a11y-page-loaded` | {title} page loaded. |
| `console.common.hint-optional` | Optional |
| `console.common.hint-required` | Required |
| `console.common.error-unavailable` | The service is temporarily unavailable. Try again in a few minutes; if it continues, email us at {email}. |
| `console.common.error-rate-limited` | Too many attempts. Try again in {seconds} seconds. |
| `console.common.error-offline` | You are no longer connected to the internet. Changes are paused and will resume automatically. |
| `console.common.error-unexpected` | Something did not complete. Try again; if it continues, email us at {email} quoting reference {requestId}. |
| `console.common.label-request-reference` | Reference: {requestId} |
| `console.common.title-not-found` | Organisation not found |
| `console.common.body-not-found-organisation` | No organisation matches this address. Check the link, or sign in to find yours. |
| `console.common.body-area-pending` | This page is not available yet. |
| `console.common.a11y-loading` | Loading |
| `console.common.a11y-notification` | Notification |
| `console.common.a11y-notifications-region` | Notifications |
| `console.common.app-title` | Kodera |
| `console.common.product-name` | Kodera |

## 2. Shell

| Key | Text |
|---|---|
| `console.shell.nav.title-home` | Home |
| `console.shell.nav.title-apps` | Applications |
| `console.shell.nav.title-people` | People |
| `console.shell.nav.title-domain` | Domain & identity |
| `console.shell.nav.title-invoices` | Billing |
| `console.shell.nav.title-help` | Help |
| `console.shell.nav.hint-provisioning` | Available as soon as your instance is ready. |
| `console.shell.nav.action-skip-to-content` | Skip to content |
| `console.shell.nav.a11y-label` | Main navigation |
| `console.shell.rail.a11y-label` | Modules |
| `console.shell.rail.a11y-home` | {organisation} home |
| `console.shell.rail.title-console` | Console |
| `console.shell.rail.title-settings` | Settings |
| `console.shell.tabs.a11y-label` | Tab navigation |
| `console.shell.tabs.title-more` | More |
| `console.shell.topbar.title-menu` | Account and organisation |
| `console.shell.topbar.title-menu-button` | {initials} · Account and organisation |
| `console.shell.switcher.label` | Organisation |
| `console.shell.switcher.placeholder-search` | Search for an organisation |
| `console.shell.switcher.action-sign-out` | Sign out |
| `console.shell.switcher.a11y-current` | Current organisation |
| `console.shell.account.title` | Your account |
| `console.shell.account.action-security` | Security and sign-in |
| `console.shell.account.action-appearance` | Appearance |
| `console.shell.account.action-language` | Language |
| `console.shell.account.action-sign-out` | Sign out |
| `console.shell.account.status-role-owner` | Owner |
| `console.shell.account.status-role-admin` | Administrator |
| `console.shell.account.status-role-billing` | Billing |
| `console.shell.account.status-role-member` | Member |
| `console.shell.capacity.status-summary` | {used} of {limit} places |
| `console.shell.banner.status-incident` | {component}: service disrupted since {time}. |
| `console.shell.banner.action-incident-details` | Find out more |
| `console.shell.banner.status-maintenance` | Maintenance scheduled for {date} at {time}, about {minutes} minutes. |
| `console.shell.banner.status-capacity` | You are approaching the limit of {limit} people in meetings at the same time. |
| `console.shell.banner.status-dunning` | An invoice is overdue ({amount}). |
| `console.shell.banner.status-dunning-no-amount` | An invoice is overdue. |
| `console.shell.banner.status-dunning-member` | A payment is pending. For any question, contact your organisation's owner. |
| `console.shell.banner.action-dunning-invoice` | View the invoice |
| `console.shell.banner.status-offline` | No internet connection. The information shown dates from {time}. |
| `console.shell.session.status-restoring` | Restoring your session… |
| `console.shell.session.title-expiring` | Your session is about to expire |
| `console.shell.session.subtitle-expiring` | For security, you will be signed out in {minutes} minutes. |
| `console.shell.session.action-stay` | Stay signed in |
| `console.shell.session.action-sign-out` | Sign out |
| `console.shell.session.error-expired` | Sign in again to continue. |
| `console.shell.session.action-sign-in-again` | Sign in again |
| `console.shell.session.a11y-countdown` | Signing out in {seconds} seconds. |
| `console.shell.session.title-expired` | Your session has expired |
| `console.shell.session.body-expired` | Sign in again to pick up where you left off. |
| `console.shell.session.title-unrecognized` | Your session is not recognized |
| `console.shell.session.body-unrecognized` | Sign in again to continue. |
| `console.shell.session.title-restore-failed` | We could not restore your session |
| `console.shell.session.body-restore-failed` | Sign out, then sign in again. If it continues, email us at {email}. |
| `console.shell.session.title-no-organisation` | No organisation yet |
| `console.shell.session.body-no-organisation` | You are signed in, but your account is not part of any organisation. If you received an invitation, open the link in the invitation email again to join. Otherwise, ask an owner of the organisation to add you. |
| `console.shell.access.error-role` | This page is for administrators. Ask {owner} to give you that role. |
| `console.shell.access.label-owner-fallback` | an administrator of your organisation |
| `console.shell.access.error-tier` | This feature is included from the {pack} plan. |
| `console.shell.access.action-see-plans` | See the plans |
| `console.shell._.error-load-failed` | Your console could not be loaded. Try again; if it continues, email us at {email}. |
| `console.shell._.title-load-failed` | Your console could not be displayed |
| `console.shell._.body-load-failed` | Try again in a moment. If it continues, email us at {email}. |
| `console.shell.staff.badge` | Kodera staff |

## 3. Login

### 3.1 `realm`

| Key | Text |
|---|---|
| `console.login.realm.title` | Sign in to your console |
| `console.login.realm.subtitle` | Enter your work email address. |
| `console.login.realm.subtitle-slug` | Enter your organisation identifier. |
| `console.login.realm.label-email` | Email address |
| `console.login.realm.placeholder-email` | first.last@yourcompany.com |
| `console.login.realm.action-continue` | Continue |
| `console.login.realm.action-use-slug` | Use your organisation identifier instead |
| `console.login.realm.label-slug` | Organisation identifier |
| `console.login.realm.placeholder-slug` | acme-sa |
| `console.login.realm.hint-slug` | It is in your welcome email. |
| `console.login.realm.action-use-email` | Use an email address instead |
| `console.login.realm.action-help` | Need help? |
| `console.login.realm.error-email-required` | Enter your email address to continue. |
| `console.login.realm.error-email-format` | This address does not look complete. Check that it has an @ and a domain name. |
| `console.login.realm.error-email-invalid` | This address is not valid. Check that it has no spaces or accented letters. |
| `console.login.realm.error-domain-unknown` | No organisation uses the domain {domain}. Use your organisation identifier, or email us at {email}. |
| `console.login.realm.error-rate-limited` | {count, plural, one {Too many attempts. Try again in {count} second.} many {Too many attempts. Try again in {count} seconds.} other {Too many attempts. Try again in {count} seconds.}} |
| `console.login.realm.error-rate-limited-minutes` | {count, plural, one {Too many attempts. Try again in {count} minute.} many {Too many attempts. Try again in {count} minutes.} other {Too many attempts. Try again in {count} minutes.}} |
| `console.login.realm.error-rate-limited-hours` | {count, plural, one {Too many attempts. Try again in {count} hour.} many {Too many attempts. Try again in {count} hours.} other {Too many attempts. Try again in {count} hours.}} |
| `console.login.realm.a11y-retry-ready` | You can try again. |
| `console.login.realm.error-rate-limited-no-wait` | Too many attempts. Try again. |
| `console.login.realm.error-unavailable` | {count, plural, one {The service is temporarily unavailable. Try again in {count} second; if it continues, email us at {email}.} many {The service is temporarily unavailable. Try again in {count} seconds; if it continues, email us at {email}.} other {The service is temporarily unavailable. Try again in {count} seconds; if it continues, email us at {email}.}} |
| `console.login.realm.error-slug-format` | An identifier contains 5 to 20 characters: unaccented letters, digits and hyphens. It cannot start or end with a hyphen. |
| `console.login.realm.error-slug-unknown` | This identifier does not match any organisation. Check your welcome email. |

### 3.2 `organisation`

| Key | Text |
|---|---|
| `console.login.organisation.title` | {count, plural, one {{count} organisation uses this address} other {{count} organisations use this address}} |
| `console.login.organisation.subtitle` | Choose the one you want to sign in to. |
| `console.login.organisation.action-back` | Use a different address |
| `console.login.organisation.error-load-failed` | Your organisations could not be shown. Try again. |

### 3.3 `handoff`

| Key | Text |
|---|---|
| `console.login.handoff.title` | Taking you to {organisation}'s sign-in page… |
| `console.login.handoff.action-continue` | Continue |
| `console.login.handoff.error-blocked` | Your browser blocked the redirect. Select "Continue", or allow redirects for this site. |
| `console.login.handoff.a11y-redirecting` | Redirecting. |

### 3.4 `mfa`

| Key | Text |
|---|---|
| `console.login.mfa.title-unavailable` | Two-factor authentication required |
| `console.login.mfa.body-unavailable` | Your account requires a second verification step. Enrollment is not yet available in this console. Contact your organisation administrator before trying again. |
| `console.login.mfa.warning-simulation` | Demonstration only: this simulation does not secure your account. Do not use the displayed codes for a real account. |
| `console.login.mfa.status-loading-simulation` | Loading the demonstration… |
| `console.login.mfa.title` | Secure your account |
| `console.login.mfa.subtitle` | Every administrator is asked for a second check. |
| `console.login.mfa.title-passkey` | Your device's key |
| `console.login.mfa.subtitle-passkey` | Face ID, fingerprint or your device passcode. Nothing to remember, nothing to install. |
| `console.login.mfa.action-passkey` | Set up this device's key |
| `console.login.mfa.title-totp` | An authentication app |
| `console.login.mfa.subtitle-totp` | Google Authenticator, Authy, FreeOTP or similar. |
| `console.login.mfa.action-totp` | Use an app |
| `console.login.mfa.hint-no-sms` | Both methods work offline. We never send a code by text message. |
| `console.login.mfa.title-totp-step1` | Scan this code in your app |
| `console.login.mfa.hint-totp-secret` | Or type this key by hand: |
| `console.login.mfa.title-totp-step2` | Enter the six digits shown |
| `console.login.mfa.label-code` | Six-digit code |
| `console.login.mfa.title-totp-step3` | Keep your recovery codes |
| `console.login.mfa.subtitle-recovery` | They let you sign in if you lose your phone. Keep them somewhere other than your computer. |
| `console.login.mfa.action-download-recovery` | Download the recovery codes |
| `console.login.mfa.action-print-recovery` | Print |
| `console.login.mfa.action-finish` | Finish |
| `console.login.mfa.error-code-format` | The code has six digits. |
| `console.login.mfa.error-code-invalid` | That code is not valid. Check the time on your phone, then enter the code shown now. |
| `console.login.mfa.error-locked` | Too many attempts. Try again in {seconds} seconds. |
| `console.login.mfa.error-passkey-unsupported` | Your browser or device does not support this method. Use an authentication app. |
| `console.login.mfa.error-required` | This action needs a second check. Set it up now: it takes two minutes. |
| `console.login.mfa.error-passkey-cancelled` | Setup was interrupted. Start it again, or use an authentication app. |
| `console.login.mfa.warning-recovery-not-saved` | Your recovery codes have not been saved yet. Download them before continuing. |
| `console.login.mfa.a11y-enrolled` | Second check set up. |

## 4. Order

### 4.1 `plan`

| Key | Text |
|---|---|
| `console.order.plan.title` | Choose your plan |
| `console.order.plan.subtitle` | We charge for capacity, not for accounts: your colleagues and your guests are unlimited. |
| `console.order.plan.label-headcount` | How many people are in your organisation? |
| `console.order.plan.hint-headcount` | We size for peaks: about 30% of your people in meetings at once. External guests count; accounts don't. |
| `console.order.plan.status-recommendation` | We recommend {plan}. It is designed for {min} to {max} people: about 30% of your teams in meetings at the same time. |
| `console.order.plan.status-recommendation-quote` | {count, plural, one {No online plan is designed for {count} person: we size your space with you, on a quote.} other {No online plan is designed for {count} people: we size your space with you, on a quote.}} |
| `console.order.plan.action-quote` | Ask for a quote |
| `console.order.plan.status-recommended` | {count, plural, one {Recommended · {count} person} other {Recommended · {count} people}} |
| `console.order.plan.label-price-monthly-note` | {amount} monthly · excl. VAT · Docs included |
| `console.order.plan.label-ngo` | Non-profit, NGO, education · −15% |
| `console.order.plan.hint-ngo-verified` | We check your eligibility before issuing the invoice; the reduction appears on it. |
| `console.order.plan.hint-capacity` | {count} concurrent participants |
| `console.order.plan.label-designed-for` | Designed for {min} to {max} people |
| `console.order.plan.label-price-annual` | {amount} per month, billed annually |
| `console.order.plan.label-price-monthly` | {amount} per month, no commitment |
| `console.order.plan.label-price-per-month` | /month excl. VAT |
| `console.order.plan.label-price-per-month-billed-annually` | /month excl. VAT, billed annually |
| `console.order.plan.label-price-annual-total` | {amount} excl. VAT a year |
| `console.order.plan.status-docs-included` | Docs is included in the {plan} plan: nothing to add. |
| `console.order.plan.hint-yearly-only` | The {plan} plan is billed annually only. |
| `console.order.plan.action-choose` | Continue with {plan} |
| `console.order.plan.status-chosen` | Plan chosen |
| `console.order.plan.title-addons` | Options |
| `console.order.plan.label-addon-docs` | Docs — collaborative documents |
| `console.order.plan.label-billing-period` | Payment |
| `console.order.plan.label-monthly` | Monthly, no commitment |
| `console.order.plan.label-annual` | Annual · −10% |
| `console.order.plan.action-enterprise` | More than {max} people? Let's talk. |
| `console.order.plan.warning-below-recommendation` | This plan is designed for up to {max} people. Beyond {capacity} people at the same time, new connections are refused until a place frees up. |
| `console.order.plan.error-headcount-range` | Enter a number of people between 1 and 100,000. |
| `console.order.plan.error-plan-required` | Choose a plan to continue. |
| `console.order.plan.error-plan-unavailable` | This plan is no longer available. Choose another one, or ask us for a quote. |
| `console.order.plan.empty-catalogue` | The plans are temporarily unavailable. Try again in a few minutes, or email us at {email}. |
| `console.order.plan.a11y-card-name` | {plan}, {price}, {capacity}. |

### 4.2 `contacts`

| Key | Text |
|---|---|
| `console.order.contacts.title` | Your organisation |
| `console.order.contacts.label-legal-name` | Legal name |
| `console.order.contacts.label-slug` | Preferred identifier |
| `console.order.contacts.hint-slug` | Your instance will be reachable at {preview}. You can connect your own domain afterwards, free of charge. |
| `console.order.contacts.hint-slug-no-domain` | This identifier forms your instance's address. You can connect your own domain afterwards, free of charge. |
| `console.order.contacts.label-registration` | Company registration number |
| `console.order.contacts.label-vat` | VAT number |
| `console.order.contacts.hint-vat` | Optional. Without a valid number, French VAT of 20% applies. |
| `console.order.contacts.title-address` | Billing address |
| `console.order.contacts.label-address-line1` | Address |
| `console.order.contacts.label-postal-code` | Postcode |
| `console.order.contacts.label-city` | City |
| `console.order.contacts.label-country` | Country |
| `console.order.contacts.label-reference` | Reference to show on the invoice |
| `console.order.contacts.hint-reference` | For example your purchase order number. |
| `console.order.contacts.title-contacts` | Contacts |
| `console.order.contacts.label-admin-email` | Administrator |
| `console.order.contacts.label-billing-email` | Billing |
| `console.order.contacts.label-security-email` | Security and privacy |
| `console.order.contacts.hint-contacts` | These addresses receive the access details, the invoices and the security alerts respectively. |
| `console.order.contacts.hint-admin-email` | They'll receive access and can add other administrators. |
| `console.order.contacts.error-name-required` | Enter your organisation's legal name. |
| `console.order.contacts.error-slug-format` | An identifier is 3 to 32 characters: unaccented letters, digits and hyphens. |
| `console.order.contacts.error-slug-taken` | That name is taken — try "{suggestion}". |
| `console.order.contacts.error-registration-required` | Enter your company registration number. |
| `console.order.contacts.error-vat-format` | This number does not match the format for the country you chose. Check it, or leave the field empty. |
| `console.order.contacts.error-vat-invalid` | This VAT number could not be verified. Correct it, or leave it empty: French VAT will be applied. |
| `console.order.contacts.error-address-required` | Complete the billing address. |
| `console.order.contacts.error-email-format` | This address does not look complete. |
| `console.order.contacts.error-reference-length` | The reference cannot be longer than 60 characters. |

### 4.3 `agreements`

| Key | Text |
|---|---|
| `console.order.agreements.title` | Documents to accept |
| `console.order.agreements.subtitle` | Three documents, generated for {organisation}. Read them here or download them before signing. Nothing is charged before you sign. |
| `console.order.agreements.label-cgv` | Terms of service |
| `console.order.agreements.label-dpa` | Data processing agreement (GDPR) |
| `console.order.agreements.label-dpa-annex-c` | Annex C — list of sub-processors |
| `console.order.agreements.label-sla` | Service level agreement |
| `console.order.agreements.label-aup` | Acceptable use policy |
| `console.order.agreements.label-version` | Version {version} |
| `console.order.agreements.action-read` | Read |
| `console.order.agreements.action-pdf` | PDF |
| `console.order.agreements.label-acceptance` | I have read the Terms and the DPA and accept them on behalf of {organisation}. |
| `console.order.agreements.label-signatory` | Signatory: {person} · {email} |
| `console.order.agreements.label-callback` | I'd like a call before go-live (30 min, free). |
| `console.order.agreements.action-submit` | Sign and receive the invoice |
| `console.order.agreements.error-acceptance-required` | Tick the acceptance box to place the order. |
| `console.order.agreements.error-document-unavailable` | This document could not be shown. Download the PDF, or try again. |
| `console.order.agreements.error-version-changed` | A new version of one document has been published since this page opened. Reload the list before accepting. |
| `console.order.agreements.error-slug-taken` | This address has just been taken. Go back one step to choose another. |
| `console.order.agreements.error-dpa-changed` | The data processing agreement was updated. Read it again, then confirm once more. |
| `console.order.agreements.action-reload-documents` | Reload the documents |
| `console.order.agreements.a11y-toc` | Document table of contents |
| `console.order.agreements.a11y-progress` | Reading progress |

### 4.4 `confirmation`

| Key | Text |
|---|---|
| `console.order.confirmation.title` | Thank you, {firstName}. Your instance is being set up. |
| `console.order.confirmation.subtitle` | We'll email you at each step. |
| `console.order.confirmation.status-eta` | within one business day |
| `console.order.confirmation.label-invoice` | Invoice {number} |
| `console.order.confirmation.action-download-invoice` | Download the invoice |
| `console.order.confirmation.action-pay` | Pay online |
| `console.order.confirmation.hint-transfer` | You can also pay by bank transfer: the details are on the invoice. |
| `console.order.confirmation.title-next-steps` | In the meantime |
| `console.order.confirmation.action-prepare-people` | Prepare your list of colleagues |
| `console.order.confirmation.action-prepare-domain` | Set up your own address |
| `console.order.confirmation.action-go-status` | Go to my space's status |
| `console.order.confirmation.action-create-workspace` | Create your workspace |
| `console.order.confirmation.error-invoice-deferred` | Your order is recorded. The invoice is being prepared and will reach you by email. |
| `console.order.confirmation.error-payment-link` | Online payment is temporarily unavailable. Pay by bank transfer using the details on the invoice, or try again. |

### 4.5 `summary` and general

| Key | Text |
|---|---|
| `console.order.summary.title` | Your order |
| `console.order.summary.label-total-monthly` | Monthly total |
| `console.order.summary.label-total-annual` | That is {amount} per year excluding tax |
| `console.order.summary.label-vat` | VAT {rate}% |
| `console.order.summary.label-billed-annually` | Billed annually |
| `console.order._.error-role` | Only the owner can place an order. Ask {owner}. |
| `console.order._.error-role-generic` | Only the owner can place an order. Ask an administrator of your organisation. |
| `console.order._.error-owner-role` | Only the organisation owner can prepare this order and generate its DPA. |
| `console.order._.error-owner-unavailable` | We could not verify your access for this order. Try again before continuing. |
| `console.order._.error-outcome-held` | An order may already have been submitted. Email us at {email} before creating another one. |
| `console.order._.error-order-exists` | An order already exists for this organisation. Contact us at {email}. |
| `console.order._.error-draft-storage` | Your draft remains on this screen, but we could not save it in this browser. |
| `console.order._.error-draft-refused` | This draft cannot be resumed. None of its fields have been restored. |
| `console.order._.status-submission-held` | Order submission is temporarily on hold. You can prepare your draft. |
| `console.order._.banner-draft-resumed` | We have resumed your order in progress. |
| `console.order._.action-restart` | Start again |
| `console.order._.title` | Order your instance |
| `console.order._.subtitle` | Ten minutes. Your instance is live within one business day. |
| `console.order._.label-step-plan` | Plan |
| `console.order._.label-step-contacts` | Organisation |
| `console.order._.label-step-agreements` | Contract |
| `console.order._.label-step-confirmation` | Confirmation |
| `console.order._.a11y-steps` | Order steps |
| `console.order._.a11y-step-announcement` | Step {step} of {total}: {label}. |
| `console.order.quote.title` | Let's talk about your project |
| `console.order.quote.subtitle` | Above {max} people, we size your space with you. |
| `console.order.quote.subtitle-no-count` | Beyond our online plans, we size your space with you. |
| `console.order.quote.label-headcount` | How many people work at your organisation? |
| `console.order.quote.label-country` | Country |
| `console.order.quote.label-needs` | Describe what you need |
| `console.order.quote.label-contact-email` | Your email address |
| `console.order.quote.error-headcount-range` | Enter a number of people. |
| `console.order.quote.error-country-required` | Enter your country. |
| `console.order.quote.error-needs-required` | Describe what you need in a few words. |
| `console.order.quote.error-email-format` | This address does not look complete. |
| `console.order.quote.action-submit` | Send my request |
| `console.order.quote.status-submitted` | Request sent. We will reply within {hours} business hours. |

## 5. Home

The Home dashboard (`08-home.md`). Three of its elements — the thirty-day availability figure,
the backup line and the planned applications — depend on fields the Core API contract does not
carry yet; their keys exist so the screen can say what it is waiting for, never so it can invent
a number.

| Key | Text |
|---|---|
| `console.home.overview.title` | Hello {firstName} |
| `console.home.overview.subtitle` | {date} · all systems operational |
| `console.home.overview.subtitle-incident` | {date} · incident in progress |
| `console.home.overview.subtitle-maintenance` | {date} · maintenance under way |
| `console.home.overview.action-invite` | Invite people |
| `console.home.overview.label-capacity` | Capacity · now |
| `console.home.overview.hint-capacity` | concurrent participants · alert at {threshold}% |
| `console.home.overview.status-capacity` | {used} of {limit} |
| `console.home.overview.status-capacity-near-limit` | Close to the limit |
| `console.home.overview.status-capacity-at-limit` | Limit reached · last refusal at {time} |
| `console.home.overview.action-see-plans` | See the plans |
| `console.home.overview.label-next-invoice` | Next invoice |
| `console.home.overview.hint-next-invoice` | excl. VAT / month · {cycle} · charged on {date} |
| `console.home.overview.action-see-invoices` | Invoices |
| `console.home.overview.label-availability` | 30-day availability |
| `console.home.overview.status-availability-met` | 99.5% commitment met |
| `console.home.overview.status-availability-measuring` | Being measured. The Applications screen shows the state of each service. |
| `console.home.overview.action-see-status` | See the applications |
| `console.home.overview.status-pending-invitations` | {count, plural, one {{count} invitation has been waiting for more than 3 days.} other {{count} invitations have been waiting for more than 3 days.}} |
| `console.home.overview.status-pending-invitations-partial` | At least {count} invitations have been waiting for more than 3 days. |
| `console.home.overview.action-resend-invitations` | Resend |
| `console.home.overview.toast-invitations-resent` | {count, plural, one {{count} invitation resent} other {{count} invitations resent}} |
| `console.home.overview.error-resend-partial` | {sent} invitations resent, {failed} did not go through. Retry those only. |
| `console.home.overview.error-invitations-unavailable` | Pending invitations could not be read. The rest of the page is up to date. |
| `console.home.overview.title-apps` | Applications |
| `console.home.overview.hint-backup` | Backed up tonight at {time} · restore tested on {date} |
| `console.home.overview.status-app-planned` | Included · {quarter} |
| `console.home.overview.action-open-app` | Open {app} |
| `console.home.overview.title-contract` | Your contract |
| `console.home.overview.label-commitment` | Committed until {date} |
| `console.home.overview.label-dpa-version` | DPA version {version} |
| `console.home.overview.action-read-contract` | Read |
| `console.home.overview.title-support` | We reply within {hours} business hours |
| `console.home.overview.hint-support` | Help tells you what to include in your message. |
| `console.home.overview.action-support` | Contact support |
| `console.home.overview.empty-title` | No instance yet |
| `console.home.overview.empty-body` | Your organisation does not have an instance yet. Ordering one takes about ten minutes. |
| `console.home.overview.empty-title-member` | Your space is not ready yet |
| `console.home.overview.empty-body-member` | An owner or an administrator of your organisation has to set it up first. There is nothing for you to do yet. |
| `console.home.overview.empty-body-unbilled` | Your organisation’s owner creates the workspace. There is nothing for you to do yet. |
| `console.home.overview.action-order` | Order |
| `console.home.create.title` | Create your workspace |
| `console.home.create.body` | Choose the name and the address of your organisation’s workspace. You can invite your colleagues as soon as it is created. |
| `console.home.create.label-name` | Workspace name |
| `console.home.create.error-name-empty` | Give your workspace a name. |
| `console.home.create.error-name-too-long` | The name is at most 200 characters long. |
| `console.home.create.error-name-characters` | The name contains a character that is not allowed. |
| `console.home.create.label-address` | Address |
| `console.home.create.action-edit-address` | Edit |
| `console.home.create.hint-address-final` | The address is permanent. |
| `console.home.create.hint-address-rule` | 3 to 32 characters: lowercase letters without accents, digits and hyphens, with no hyphen at either end. |
| `console.home.create.status-address-checking` | Checking the address… |
| `console.home.create.status-address-free` | This address is free. |
| `console.home.create.error-address-invalid` | This address does not follow the rule below. |
| `console.home.create.error-address-taken` | This address is already taken. |
| `console.home.create.error-address-reserved` | This address is reserved. |
| `console.home.create.label-suggestions` | Free addresses: |
| `console.home.create.a11y-use-suggestion` | Use the address {slug} |
| `console.home.create.a11y-address-suggestions` | Free addresses offered: {slugs}. |
| `console.home.create.label-documents` | Documents you accept by creating the workspace: |
| `console.home.create.label-document` | {title}, version {version} |
| `console.home.create.action-create` | Create the workspace — I accept the terms and the DPA |
| `console.home.create.action-creating` | Creating the workspace… |
| `console.home.create.error-documents-unavailable` | The terms of service are not available right now. Try again in a few minutes. |
| `console.home.create.error-documents-changed` | The terms have been updated. Read the new versions below, then create the workspace. |
| `console.home.create.error-unavailable` | Creating workspaces is unavailable for a moment. Try again in a few minutes. |
| `console.home.create.error-not-ready` | Your organisation is not ready to create a workspace yet. Try again in a few minutes. |
| `console.home.create.error-failed` | The workspace could not be created. Try again: only one workspace will be created. |
| `console.home.create.error-not-shown` | Your workspace is created, but this page could not update. Reload the page. |
| `console.home.overview.error-discovery-unavailable` | We could not check whether your organisation already has an instance. Retry before placing an order. |
| `console.home.overview.error-summary-unavailable` | These figures could not be refreshed. The values shown are from {time}. |
| `console.home.overview.error-invoice-unavailable` | The amount of your next invoice could not be read. Open Billing for the detail. |
| `console.home.overview.a11y-capacity` | {used} people in meetings at the same time out of {limit} possible. |
| `console.home.overview.label-billing-period-monthly` | monthly |
| `console.home.overview.label-billing-period-yearly` | yearly |
| `console.home.overview.action-prepare-domain` | Prepare your domain |
| `console.home.overview.a11y-apps-table` | Your applications |
| `console.home.overview.label-app-column-name` | Application |
| `console.home.overview.label-app-column-address` | Address |
| `console.home.overview.label-app-column-status` | Status |
| `console.home.overview.a11y-app-actions` | Actions |
| `console.home.overview.status-app-live` | Online |
| `console.home.overview.status-app-pending` | Installing |
| `console.home.overview.status-app-degraded` | Degraded |
| `console.home.overview.status-app-unavailable` | Unavailable |
| `console.home.overview.status-app-maintenance` | Maintenance |
| `console.home.overview.status-app-unknown` | Unknown status |
| `console.home.overview.status-invoice-overdue` | Invoice overdue by {amount}. Settle it from Billing. |

## 6. Applications

| Key | Text |
|---|---|
| `console.status.overview.title-provisioning` | Your space is being set up |
| `console.status.overview.subtitle-provisioning` | Ready within one business day. We will write to you as soon as it is done. |
| `console.status.overview.status-step-order` | Order recorded |
| `console.status.overview.status-step-server` | Server reserved in Paris |
| `console.status.overview.status-step-apps` | Installing the applications |
| `console.status.overview.status-step-addresses` | Addresses and certificates |
| `console.status.overview.status-step-accounts` | Accounts and sign-in |
| `console.status.overview.status-step-backups` | Backups and monitoring |
| `console.status.overview.status-done` | Done |
| `console.status.overview.status-running` | In progress |
| `console.status.overview.status-pending` | To come |
| `console.status.overview.status-failed` | Failed |
| `console.status.overview.status-skipped` | Skipped |
| `console.status.overview.a11y-progress` | Step {index} of {total} done: {step}. |
| `console.status.overview.title-live` | {organisation} |
| `console.status.overview.subtitle-live` | Your addresses, the state of each service, and updates. |
| `console.status.overview.status-all-operational` | Everything is working |
| `console.status.overview.status-degraded` | {component} disrupted |
| `console.status.overview.status-stale` | We are no longer receiving information |
| `console.status.overview.status-updated` | Updated {duration} ago |
| `console.status.overview.title-apps` | Your applications |
| `console.status.overview.label-app-visio` | Visio |
| `console.status.overview.label-app-docs` | Docs |
| `console.status.overview.label-app-login` | Sign-in |
| `console.status.overview.action-open-app` | Open {app} |
| `console.status.overview.label-app-fallback` | Fallback |
| `console.status.overview.label-docs-export` | DOCX/PDF export: on quotation |
| `console.status.overview.title-capacity` | Capacity |
| `console.status.overview.status-capacity-not-measured` | Not measured yet. No figure is shown before the first measurement. |
| `console.status.overview.status-capacity` | {used} people in meetings at the same time, out of {limit} possible. |
| `console.status.overview.status-capacity-near-limit` | Close to the limit |
| `console.status.overview.status-capacity-at-limit` | Limit reached · last refusal at {time} |
| `console.status.overview.label-capacity-peak` | Peak over the last seven days: {peak}. |
| `console.status.overview.warning-capacity-near-limit` | You are approaching the limit. Beyond {limit} people at the same time, new connections are refused until a place frees up. |
| `console.status.overview.error-capacity-reached` | The limit of {limit} people at the same time has been reached: new connections are refused. A higher plan raises this limit. |
| `console.status.overview.action-see-plans` | See the plans |
| `console.status.overview.action-talk-to-us` | Talk to us about it |
| `console.status.overview.title-components` | Service status |
| `console.status.overview.label-component-web` | Website |
| `console.status.overview.label-component-calls` | Video calls |
| `console.status.overview.label-component-console` | Console |
| `console.status.overview.label-component-documents` | Documents |
| `console.status.overview.label-component-identity` | Sign-in |
| `console.status.overview.label-component-mail` | Email |
| `console.status.overview.status-component-operational` | Operational |
| `console.status.overview.status-component-degraded` | Disrupted |
| `console.status.overview.status-component-down` | Interrupted |
| `console.status.overview.status-component-maintenance` | Maintenance |
| `console.status.overview.status-component-unknown` | Status unknown |
| `console.status.overview.status-component-checking` | Checking… |
| `console.status.overview.action-history` | Seven-day history |
| `console.status.overview.title-plan` | Your plan |
| `console.status.overview.label-plan-pack` | Pack |
| `console.status.overview.label-plan-tier` | Capacity tier |
| `console.status.overview.label-next-invoice` | Next invoice: {date} |
| `console.status.overview.action-see-invoices` | See my invoices |
| `console.status.overview.title-maintenance` | Next maintenance |
| `console.status.overview.status-maintenance` | {date} at {time}, about {minutes} minutes. Ongoing calls are not interrupted. |
| `console.status.overview.title-no-tenant` | No instance yet |
| `console.status.overview.empty-no-tenant` | No space is linked to your organisation yet. |
| `console.status.overview.action-order` | Place an order |
| `console.status.overview.error-summary-unavailable` | Your space's status could not be refreshed. The information shown dates from {time}. |
| `console.status.overview.error-heartbeat-stale` | We have not received information from your instance for {duration}. Your applications may still work normally. Email us at {email} so we can check. |
| `console.status.overview.error-step-failed` | An installation step did not complete. Email us at {email} so we can resume it with you. |
| `console.status.overview.error-state-conflict` | This is not possible while your space is "{status}". {next} |
| `console.status.overview.error-provisioning-late` | Installation is taking longer than expected. Email us at {email} and we will tell you where things stand. |
| `console.status.incident.title` | {component} disrupted |
| `console.status.incident.label-since` | Since {time} |
| `console.status.incident.label-next-update` | Next update at {time} |
| `console.status.incident.title-impact` | What you are seeing |
| `console.status.incident.title-actions` | What we are doing |
| `console.status.incident.empty-updates` | We update this page as soon as we know more. |
| `console.status.incident.action-open-ticket` | Open a ticket |
| `console.status.incident.error-unavailable` | The incident details are not available right now. Try again in a few minutes. |
| `console.status.incident.body-impact-generic` | We are following the situation and will publish details as soon as they are available. |
| `console.status.incident.body-update-generic` | Update in progress. |
| `console.status.history.title` | Last seven days |
| `console.status.history.hint-schedule` | Updates on Tuesday evenings, announced 48 h in advance. Ongoing calls are never cut. |
| `console.status.history.label-degraded-minutes` | {minutes} minutes disrupted |
| `console.status.history.empty-day` | No data available |

## 7. People

### 7.1 `list`

| Key | Text |
|---|---|
| `console.people.list.title` | People |
| `console.people.list.subtitle` | {members} members · {admins} administrators · {invitations} pending invitations |
| `console.people.list.label-tab-members` | Members |
| `console.people.list.label-tab-invitations` | Invitations |
| `console.people.list.label-tab-on-site` | On-site access |
| `console.people.list.placeholder-search` | Search for a name or an email address |
| `console.people.list.placeholder-search-name` | Search for a name |
| `console.people.list.label-unnamed` | Person with no name shown |
| `console.people.list.sr-no-email` | No email address |
| `console.people.list.label-filter-role` | Role |
| `console.people.list.label-filter-all` | All |
| `console.people.list.label-filter-admins` | Admins |
| `console.people.list.label-filter-pending` | Pending |
| `console.people.list.action-invite` | Invite |
| `console.people.list.action-invite-email` | Invite by email |
| `console.people.list.action-invite-import` | Import a CSV |
| `console.people.list.action-invite-on-site` | Create on-site access |
| `console.people.list.label-column-name` | Name |
| `console.people.list.label-column-email` | Email |
| `console.people.list.label-column-role` | Role |
| `console.people.list.label-column-last-sign-in` | Last sign-in |
| `console.people.list.status-role-owner` | Owner |
| `console.people.list.status-role-admin` | Administrator |
| `console.people.list.status-role-billing` | Billing |
| `console.people.list.status-role-member` | Member |
| `console.people.list.status-never-signed-in` | Never signed in |
| `console.people.list.status-on-site` | On-site access |
| `console.people.list.status-active` | Active |
| `console.people.list.status-invited` | Pending |
| `console.people.list.status-expired` | Invitation expired |
| `console.people.list.status-suspended` | Suspended |
| `console.people.list.status-removed` | Removed |
| `console.people.list.a11y-row-actions` | Actions for {person} |
| `console.people.list.action-make-owner` | Make owner |
| `console.people.list.action-make-admin` | Make administrator |
| `console.people.list.action-make-billing` | Give billing access |
| `console.people.list.action-make-member` | Make member |
| `console.people.list.label-column-actions` | Actions |
| `console.people.list.label-column-expires` | Expires on |
| `console.people.list.empty-invitations` | No pending invitation. |
| `console.people.list.empty-title` | No one yet |
| `console.people.list.empty-body` | Invite colleagues by email or import a CSV. They'll receive a link to activate their account. |
| `console.people.list.empty-body-email` | Invite colleagues by email. They'll receive a link to activate their account. |
| `console.people.list.empty-search` | Nobody matches "{query}". |
| `console.people.list.action-clear-search` | Clear the search |
| `console.people.list.error-load-failed` | The list could not be loaded. Try again. |
| `console.people.list.title-federation-nudge` | Let your existing accounts sign in |
| `console.people.list.hint-federation-nudge` | Nothing to invite: colleagues arrive with their usual login, and anyone who leaves the company loses access at the same time. |
| `console.people.list.hint-federated` | Accounts arrive from {provider}. Inviting is still available for people outside it. |

### 7.2 `invite`

| Key | Text |
|---|---|
| `console.people.invite.title` | Invite people |
| `console.people.invite.label-emails` | Email addresses, one per line |
| `console.people.invite.hint-emails` | Separate them with a comma, a semicolon or a line break. You can paste a column from a spreadsheet. |
| `console.people.invite.hint-validity` | They'll receive an invitation valid for 14 days. |
| `console.people.invite.status-counts` | {valid} addresses recognised · {duplicates} duplicates · {invalid} invalid |
| `console.people.invite.hint-duplicates` | {count} duplicate addresses were merged. |
| `console.people.invite.a11y-remove-address` | Remove {address} |
| `console.people.invite.label-role` | Role |
| `console.people.invite.label-role-member` | Member — can take part in meetings and documents |
| `console.people.invite.label-role-admin` | Administrator — can invite and remove, without billing access |
| `console.people.invite.label-role-billing` | Billing — can view and pay, without managing access |
| `console.people.invite.label-message` | Message to go with the invitation |
| `console.people.invite.action-send` | {count, plural, one {Send {count} invitation} other {Send {count} invitations}} |
| `console.people.invite.toast-sent` | {count, plural, one {{count} invitation sent} other {{count} invitations sent}} |
| `console.people.invite.title-partial` | {sent} invitations sent, {failed} did not go through |
| `console.people.invite.action-retry-failed` | {count, plural, one {Try the failed address again} other {Try the {count} failed addresses again}} |
| `console.people.invite.error-emails-required` | Enter at least one email address. |
| `console.people.invite.error-address-invalid` | Invalid address |
| `console.people.invite.error-too-many` | You can invite 200 people at a time. Send them in batches, or import a file. |
| `console.people.invite.error-too-many-batches` | You can invite 200 people at a time. Send them in batches. |
| `console.people.invite.error-message-length` | The message cannot be longer than 500 characters. |
| `console.people.invite.error-already-member` | Already a member of your organisation |
| `console.people.invite.error-already-invited` | Already invited. You can send the invitation again from the Invitations tab. |
| `console.people.invite.error-mailbox-unreachable` | This mailbox does not exist. Check the address, or create on-site access. |
| `console.people.invite.error-seat-limit` | This invitation could not be created. Email us at {email}. |
| `console.people.invite.error-send-failed` | No invitation was sent. Your addresses are kept: try again. |
| `console.people.invite.error-send-unconfirmed` | The send result could not be confirmed. To retry the same send, use its original addresses and role. The current fields may have been edited. |
| `console.people.invite.error-send-refused` | This invitation request was refused. Check the information or contact support. |
| `console.people.invite.error-result-finalization` | The result of this send is confirmed, but this screen could not finish. Check Invitations before sending again. |

### 7.3 `import`

| Key | Text |
|---|---|
| `console.people.import.title` | Import a list |
| `console.people.import.label-drop` | Drop your file here, or browse your folders |
| `console.people.import.hint-formats` | CSV · 5,000 rows maximum · 2 MB |
| `console.people.import.hint-columns` | Your file must have a column of email addresses. First name, last name and role columns are optional. |
| `console.people.import.hint-raw-deleted` | The server deletes the file as soon as it has been read. |
| `console.people.import.hint-staging-expiry` | Rows that still failed will be deleted no later than {date}. |
| `console.people.import.action-template` | Download a template |
| `console.people.import.title-mapping` | We found {rows} rows. |
| `console.people.import.label-column-file` | Column in your file |
| `console.people.import.label-column-field` | Field |
| `console.people.import.label-field-ignore` | Ignore |
| `console.people.import.status-ready` | {count} ready to be invited |
| `console.people.import.status-already-member` | {count} already members — they will be skipped |
| `console.people.import.status-duplicate` | {count} duplicate addresses in the file — only one will be kept |
| `console.people.import.status-invalid` | {count} addresses could not be read |
| `console.people.import.action-detail` | See the detail row by row |
| `console.people.import.action-execute` | {count, plural, one {Invite {count} person} other {Invite {count} people}} |
| `console.people.import.status-sending` | Sending… {done} of {total} |
| `console.people.import.title-result` | {sent} invitations sent |
| `console.people.import.title-failures` | {count} could not be sent: |
| `console.people.import.label-line` | row {line} |
| `console.people.import.action-retry-failed` | Try the {count} failed rows again |
| `console.people.import.action-download-failures` | Download the failed rows |
| `console.people.import.error-file-type` | This format is not accepted. Use a CSV file. |
| `console.people.import.error-file-too-large` | The file is over the 2 MB or 5,000-row limit. Split it into several files. |
| `console.people.import.error-role-not-allowed` | This role cannot be assigned from this file. Choose member, administrator or billing according to your access. |
| `console.people.import.error-email-column-required` | Tell us which column holds the email addresses. |
| `console.people.import.error-parse-failed` | Reading the file stopped at row {line}. Check that row, or start from the template. |
| `console.people.import.empty-no-usable-rows` | No usable address was found in this file. |
| `console.people.import.label-field-email` | Email |
| `console.people.import.label-field-given-name` | First name |
| `console.people.import.label-field-family-name` | Last name |
| `console.people.import.label-field-role` | Role |
| `console.people.import.a11y-field-for-column` | Field for column {column} |
| `console.people.import.label-column-number` | Column {number} |
| `console.people.import.label-sample` | Example: {sample} |
| `console.people.import.label-mapping-caption` | How the columns of your file map to fields |
| `console.people.import.label-default-role` | Role assigned |
| `console.people.import.status-already-invited` | {count} already invited — they will be skipped |
| `console.people.import.hint-preview-expiry` | This list is kept until {date} at the latest, while you import it. |
| `console.people.import.label-failures-caption` | Failed rows |
| `console.people.import.label-column-line` | Row |
| `console.people.import.label-column-reason` | Reason |
| `console.people.import.body-completed` | The people you invited appear in the Invitations tab until they activate their account. |
| `console.people.import.action-view-invitations` | See the invitations |
| `console.people.import.error-parse-failed-unknown-line` | This file could not be read. Check that it is a CSV file, or start from the template. |
| `console.people.import.error-upload-failed` | The file could not be sent. Check your connection, then drop it again. |
| `console.people.import.error-execute-failed` | No invitation was sent. Your list is kept: try again. |
| `console.people.import.label-template-filename` | import-template.csv |
| `console.people.import.label-failures-filename` | failed-rows.csv |

### 7.4 `on-site`

| Key | Text |
|---|---|
| `console.people.on-site.title` | On-site access |
| `console.people.on-site.subtitle` | For people without a work email address. |
| `console.people.on-site.title-how` | How it works |
| `console.people.on-site.hint-step1` | You create places, for example twelve. |
| `console.people.on-site.hint-step2` | You print the sheet and put it up. |
| `console.people.on-site.hint-step3` | Each person scans the code with their phone and registers their fingerprint or face. One place per person. |
| `console.people.on-site.hint-step4` | The code expires at the date and time printed on the sheet. |
| `console.people.on-site.title-qr` | Enrol with a QR code |
| `console.people.on-site.hint-qr` | Generate a single-use token, valid until the time printed on the sheet. They scan it, choose a password and set up a passkey. |
| `console.people.on-site.label-count` | How many places? |
| `console.people.on-site.action-create` | {count, plural, one {Create {count} place} other {Create {count} places}} |
| `console.people.on-site.title-active` | Active sheets |
| `console.people.on-site.status-sheet` | {count} places · {used} used · expires on {date} at {time} |
| `console.people.on-site.action-print` | Print |
| `console.people.on-site.action-show-code` | Show the code |
| `console.people.on-site.action-deactivate` | Deactivate |
| `console.people.on-site.confirm-deactivate-title` | Deactivate this sheet? |
| `console.people.on-site.confirm-deactivate-body` | The {remaining} unused places can no longer be claimed. People who have already registered keep their access. |
| `console.people.on-site.title-sheet` | Join {organisation}'s video meetings |
| `console.people.on-site.hint-sheet-manual` | Or go to {url} and enter code {code} |
| `console.people.on-site.hint-sheet-validity` | Valid until {date} at {time}. One place per person. |
| `console.people.on-site.error-count-range` | Enter a number of places between 1 and 200. |
| `console.people.on-site.error-token-expired` | This sheet has expired. Create a new one. |
| `console.people.on-site.error-qr-unavailable` | The code to scan could not be shown. The code to type below works and can be printed. |
| `console.people.on-site.empty-body` | No active sheet. Create places so your teams can register on site. |
| `console.people.on-site.label-code` | Code to type |
| `console.people.on-site.label-address` | Address |
| `console.people.on-site.a11y-qr` | QR code to scan. Code to type: {code} |
| `console.people.on-site.status-qr-unavailable` | Image unavailable |
| `console.people.on-site.hint-code-once` | A sheet's code is shown only when the sheet is created. To print another sheet again, deactivate it and create a new one. |

### 7.5 `members`

| Key | Text |
|---|---|
| `console.people.members.title` | {person} |
| `console.people.members.label-role` | Role |
| `console.people.members.label-state` | Status |
| `console.people.members.label-joined` | Joined on {date} |
| `console.people.members.label-last-sign-in` | Last signed in {duration} ago |
| `console.people.members.action-remove` | Remove from the organisation |
| `console.people.members.action-resend` | Send the invitation again |
| `console.people.members.action-revoke` | Cancel the invitation |
| `console.people.members.confirm-remove-title` | Remove {person}? |
| `console.people.members.confirm-remove-body` | {person} will no longer be able to use your organisation's console. Their access to Visio and Docs is not cut yet: if you need it cut now, write to us at {email}. Their documents stay in the organisation's space. |
| `console.people.members.action-confirm-remove` | Remove {person} |
| `console.people.members.confirm-owner-title` | Make {person} an owner? |
| `console.people.members.confirm-owner-body` | This person will be able to manage billing, roles and organisation deletion. |
| `console.people.members.action-confirm-owner` | Make owner |
| `console.people.members.toast-removed` | {person} has been removed. |
| `console.people.members.status-role-saved-refreshing` | The role change was saved.{refreshing} |
| `console.people.members.status-role-saved-refresh-failed` | The role change was saved, but these details could not be refreshed. Refresh them before making another change. |
| `console.people.members.status-role-unconfirmed` | The result of the role change could not be confirmed. Refresh these details before trying again. |
| `console.people.members.action-refresh-member` | Refresh details |
| `console.people.members.label-last-known-role` | Last known role |
| `console.people.members.toast-role-changed` | {person} is now {role}. |
| `console.people.members.action-suspend` | Suspend in the console |
| `console.people.members.action-reactivate` | Reactivate in the console |
| `console.people.members.confirm-suspend-title` | Suspend {person} in the console? |
| `console.people.members.confirm-suspend-body` | {person} will no longer be able to use your organisation's console until reactivated. Their access to Visio and Docs is not cut yet: if you need it cut now, write to us at {email}. |
| `console.people.members.action-confirm-suspend` | Suspend {person} |
| `console.people.members.toast-suspended` | {person}'s suspension is recorded. |
| `console.people.members.toast-reactivated` | {person}'s reactivation is recorded. |
| `console.people.members.error-state-change-failed` | The suspension could not be changed. Try again. |
| `console.people.members.error-changed-meanwhile` | Someone else has just changed this person. Check their details, then try again. |
| `console.people.members.error-forbidden` | This change is not possible right now. If that seems wrong, write to us at {email}. |
| `console.people.members.toast-resent` | Invitation sent again to {person}. |
| `console.people.members.error-resend-gone` | This invitation has expired or was cancelled, so it can no longer be sent again. Invite this address again. |
| `console.people.members.toast-revoked` | Invitation for {person} cancelled. |
| `console.people.members.error-last-owner` | Your organisation must keep at least one owner. Appoint someone else before changing this role. |
| `console.people.members.error-last-admin` | You need at least one administrator. Appoint another one first. |
| `console.people.members.error-owner-only-role` | Only an owner can assign or remove the owner and billing roles. |
| `console.people.members.error-self-removal` | You cannot remove yourself. Ask another administrator. |
| `console.people.members.error-self-change` | You cannot change your own role. Ask another administrator. |
| `console.people.members.error-staff-managed` | Our team manages this account. Write to us at {email} to change it. |
| `console.people.members.error-role-change-failed` | The role could not be changed. Try again. |

## 8. Domain

| Key | Text |
|---|---|
| `console.domain.list.title` | Domain |
| `console.domain.list.subtitle` | Your own addresses for Visio and Docs, and how your colleagues sign in. |
| `console.domain.list.label-tab-domains` | Domains |
| `console.domain.list.label-tab-federation` | Sign-in (Google / Microsoft) |
| `console.domain.list.label-column-address` | Address |
| `console.domain.list.label-column-app` | Application |
| `console.domain.list.label-column-state` | Status |
| `console.domain.list.status-active` | Verified |
| `console.domain.list.status-verifying` | Being verified |
| `console.domain.list.status-pending` | Waiting to be set up |
| `console.domain.list.status-failed` | Failed |
| `console.domain.list.badge-primary` | Primary |
| `console.domain.list.badge-provided` | Fallback |
| `console.domain.list.action-add` | Add an address |
| `console.domain.list.action-manage` | Manage |
| `console.domain.list.empty-title` | Use your own address |
| `console.domain.list.empty-body` | Your meetings and documents can live at an address in your own name, for example visio.yourcompany.com. |
| `console.domain.list.empty-body-none-yet` | No address of your own has been added yet. |
| `console.domain.list.label-role-media` | Video calls |
| `console.domain.new.title` | Which address do you want to use? |
| `console.domain.new.label-host` | Address |
| `console.domain.new.label-app` | For the application |
| `console.domain.new.hint-intro` | Two lines to add at your domain registrar (OVH, Gandi, Cloudflare…). We first check the domain is yours, then attach it. Allow 5 to 30 minutes. |
| `console.domain.new.label-step-proof` | Prove the domain is yours |
| `console.domain.new.label-step-point` | Point the address to your instance |
| `console.domain.new.label-step-certificate` | Certificate issued automatically |
| `console.domain.new.hint-apex` | We recommend a sub-address (visio.yourcompany.com) rather than your main address: it is simpler to set up and to move later. |
| `console.domain.new.error-host-required` | Enter the address you want to use. |
| `console.domain.new.error-host-format` | This is not a valid domain name. Enter something like visio.yourcompany.com. |
| `console.domain.new.error-host-taken` | This address is already in use. Choose another one, or contact us. |
| `console.domain.new.error-host-reserved` | This address belongs to us and cannot be added. |
| `console.domain.new.error-app-required` | Tell us which application this is for. |
| `console.domain.verify.title` | Prove that this domain is yours |
| `console.domain.verify.subtitle` | Add this record at your domain host. It changes nothing about your current website. |
| `console.domain.verify.title-line1` | Line 1 · proof of ownership |
| `console.domain.verify.label-record-type` | Type |
| `console.domain.verify.label-record-name` | Name |
| `console.domain.verify.label-record-value` | Value |
| `console.domain.verify.label-record-ttl` | Time to live (TTL) |
| `console.domain.verify.hint-ttl` | 300 seconds, or the lowest value your host offers. |
| `console.domain.verify.action-copy-all` | Copy all three lines |
| `console.domain.verify.action-download` | Download the instructions |
| `console.domain.verify.action-share` | Send to someone |
| `console.domain.verify.hint-delegate` | You do not manage the domain? Forward this page to the person or agency who does. |
| `console.domain.verify.action-check` | Check now |
| `console.domain.verify.action-check-again` | Check again |
| `console.domain.verify.status-last-check` | Last checked {duration} ago |
| `console.domain.verify.status-auto-recheck` | We check again automatically every ten minutes. |
| `console.domain.verify.status-checking` | Checking… |
| `console.domain.verify.status-not-yet-visible` | Not visible yet. Propagation takes 5 to 30 minutes; we retry every 10 minutes. |
| `console.domain.verify.action-guide-per-registrar` | Guide per registrar |
| `console.domain.verify.status-verified` | Domain verified. |
| `console.domain.verify.label-expected` | Expected |
| `console.domain.verify.label-found` | Found |
| `console.domain.verify.label-found-nothing` | (nothing) |
| `console.domain.verify.title-causes` | Most common causes |
| `console.domain.verify.hint-check-throttled` | You can check again in {seconds} seconds. |
| `console.domain.verify.action-reissue-nonce` | Generate a new value |
| `console.domain.verify.error-txt-missing` | No TXT record was found at {recordName}. Add it at your domain host, then check again. |
| `console.domain.verify.cause-propagation` | The record was only just added: a DNS change can take up to an hour to be visible everywhere. |
| `console.domain.verify.cause-full-name` | The full name was entered where your host expects only the relative part, {relativeName}. |
| `console.domain.verify.cause-wrong-domain` | The record was added on a different domain. |
| `console.domain.verify.error-txt-mismatch` | A TXT record exists, but its value does not match. Replace it with the value above, or generate a new value. |
| `console.domain.verify.cause-old-value` | An older value is still published. |
| `console.domain.verify.cause-quotes` | Quotation marks were copied along with the value. |
| `console.domain.verify.error-servfail` | The name servers for {host} answered with an error. The problem is with your domain host, and they are the ones to ask. |
| `console.domain.verify.error-nonce-expired` | The verification code expired after 72 hours. We have prepared a new one: replace the old record with this one. |
| `console.domain.verify.error-nxdomain` | The domain {host} does not respond at all. Check its spelling and that it is active. |
| `console.domain.verify.error-resolver` | Our check could not run. That does not mean your setup is wrong: try again in a moment. |
| `console.domain.point.title` | Point the address at your space |
| `console.domain.point.title-line2` | Line 2 · address (after the proof) |
| `console.domain.point.hint-media` | For video calls, also add this record: |
| `console.domain.point.hint-apex-records` | Your main address cannot use a CNAME: add these two A records instead. |
| `console.domain.point.error-cname-missing` | No CNAME record was found at {recordName}. Add it, then check again. |
| `console.domain.point.error-cname-wrong` | The CNAME points at {found} instead of {expected}. Correct the value, keeping the trailing dot if your host requires it. |
| `console.domain.point.error-a-missing` | The record for video calls is missing. Your address will work, but calls will not connect. |
| `console.domain.point.error-a-wrong` | The record for video calls points at {found} instead of {expected}. |
| `console.domain.certificate.status-issuing` | Security certificate being issued, this takes a few minutes. |
| `console.domain.certificate.status-issued` | Certificate issued. Your address is ready. |
| `console.domain.certificate.error-caa` | A CAA record on your domain forbids our certificate authority from issuing the certificate. Add {record}, then try again. |
| `console.domain.certificate.error-failed` | The security certificate could not be issued. Try again; if it continues, contact us quoting the address. |
| `console.domain.detail.action-make-primary` | Make {host} the primary address |
| `console.domain.detail.confirm-primary-title` | Use {host} as the primary address? |
| `console.domain.detail.confirm-primary-body` | Invitations and links you send from now on will use {host}. The old address keeps working and redirects to the new one. |
| `console.domain.detail.action-confirm-primary` | Use this address |
| `console.domain.detail.action-remove` | Remove this address |
| `console.domain.detail.confirm-remove-title` | Remove {host}? |
| `console.domain.detail.confirm-remove-body` | Links to {host} will stop working. Your meetings and documents stay available at your provided address. |
| `console.domain.detail.error-not-ready-for-primary` | This address must be verified and have its certificate before it can become the primary address. |
| `console.domain.detail.error-primary-removal` | The primary address cannot be removed. Choose another primary address first. |
| `console.domain.detail.status-removal-queued` | Removal in progress. |

## 9. Invoices

| Key | Text |
|---|---|
| `console.invoices.list.error-dunning-invoice` | The overdue invoice could not be loaded. Retry to view its details. |
| `console.invoices.list.title` | Invoices |
| `console.invoices.list.subtitle` | Your subscription, invoices and payment method. |
| `console.invoices.list.status-up-to-date` | Up to date |
| `console.invoices.list.title-subscription` | Your subscription |
| `console.invoices.list.label-subscription` | {plan} · billed {period} |
| `console.invoices.list.label-recurring` | {amount} per month, that is {annual} per year excluding tax |
| `console.invoices.list.label-next-invoice` | Next invoice: {date} |
| `console.invoices.list.label-monthly-ex-vat` | Monthly, excl. VAT |
| `console.invoices.list.label-next-charge` | Next charge |
| `console.invoices.list.action-change-plan` | Change plan |
| `console.invoices.list.label-column-number` | Number |
| `console.invoices.list.label-column-date` | Date |
| `console.invoices.list.label-column-amount` | Amount including tax |
| `console.invoices.list.label-column-state` | Status |
| `console.invoices.list.status-paid` | Paid |
| `console.invoices.list.status-open` | Due |
| `console.invoices.list.status-overdue` | {count, plural, one {{count} day overdue} other {{count} days overdue}} |
| `console.invoices.list.status-credit-note` | Credit note |
| `console.invoices.list.status-void` | Cancelled |
| `console.invoices.list.status-overdue-short` | Overdue |
| `console.invoices.list.action-pdf` | Download the PDF of invoice {number} |
| `console.invoices.list.action-pay` | Pay {amount} |
| `console.invoices.list.action-bank-details` | Bank details |
| `console.invoices.list.empty-title` | Your first invoice is on its way |
| `console.invoices.list.empty-body` | It will be issued on {date} and sent to {billingEmail}. |
| `console.invoices.list.error-amount-unavailable` | Amount unavailable — see the PDF. |
| `console.invoices.list.error-load-failed` | Your invoices could not be loaded. Try again. |
| `console.invoices.list.hint-payment-method` | Automatic direct debit will arrive after launch. Until then, every invoice includes a card or bank-transfer payment link. |
| `console.invoices.list.hint-issuer` | Issued by Samouraï Coop through Qonto · Factur-X |
| `console.invoices.detail.title` | Invoice {number} |
| `console.invoices.detail.label-due` | Due on {date} |
| `console.invoices.detail.title-to-pay` | To pay |
| `console.invoices.detail.action-pay` | Pay online |
| `console.invoices.detail.hint-payment-methods` | Online payment accepts cards and one-off SEPA direct debit. You will leave the console for our payment provider. |
| `console.invoices.detail.action-bank-details` | See the bank details |
| `console.invoices.detail.title-lines` | Detail |
| `console.invoices.detail.label-total-excl-tax` | Total excluding tax |
| `console.invoices.detail.label-column-amount-excl-tax` | Amount excluding tax |
| `console.invoices.detail.label-tax` | VAT {rate}% |
| `console.invoices.detail.label-total-incl-tax` | Total including tax |
| `console.invoices.detail.label-issued` | Issued on {date} |
| `console.invoices.detail.label-reference` | Reference: {reference} |
| `console.invoices.detail.action-pdf` | Download the PDF |
| `console.invoices.detail.action-support` | A problem with this invoice? |
| `console.invoices.detail.error-not-found` | This invoice does not exist or does not belong to your organisation. |
| `console.invoices.detail.error-pdf-unavailable` | The PDF for this invoice is currently unavailable. Email us at {email} and include its number. |
| `console.invoices.detail.error-pdf-download-failed` | The PDF is currently unavailable. Try again; if this persists, email us at {email} and include the invoice number. |
| `console.invoices.detail.error-payment-link` | Online payment is temporarily unavailable. Try again in a few moments, or pay by bank transfer using the details on the invoice PDF. |
| `console.invoices.detail.error-payment-link-no-pdf` | Online payment is temporarily unavailable. Try again in a few moments, or email us at {email} and include the invoice number. |
| `console.invoices.detail.hint-transfer` | You can also pay by bank transfer: the details are on the invoice PDF. |
| `console.invoices.detail.hint-payment-pending` | We have not received a payment for this invoice yet. A payment can take a few minutes to appear. |
| `console.invoices.detail.action-refresh` | Refresh |
| `console.invoices.detail.hint-already-paid` | This invoice is settled. Thank you. |
| `console.invoices.bank.title` | Bank details |
| `console.invoices.bank.label-holder` | Account holder |
| `console.invoices.bank.label-iban` | IBAN |
| `console.invoices.bank.label-bic` | BIC |
| `console.invoices.bank.error-copy` | Copy failed. Select the reference to copy it manually. |
| `console.invoices.bank.label-reference` | Reference |
| `console.invoices.bank.hint-reference` | Put reference {reference} on your transfer so the payment is matched automatically. |
| `console.invoices.bank.error-unavailable` | The bank details are on your invoice in PDF form. |
| `console.invoices.dunning.title` | Payment deadlines |
| `console.invoices.dunning.label-overdue-since` | Due date passed on {date} |
| `console.invoices.dunning.status-reminder-1` | {date} — reminder sent |
| `console.invoices.dunning.status-reminder-2` | {date} — second reminder |
| `console.invoices.dunning.status-formal-notice` | {date} — formal notice, late-payment interest and the €40 fixed recovery fee |
| `console.invoices.dunning.status-suspension-notice` | {date} — suspension notice, seven days |
| `console.invoices.dunning.status-suspension` | {date} — sign-in suspended. Your data is kept and meetings in progress finish normally. |
| `console.invoices.dunning.status-suspension-held` | Sign-in suspension: paused while your dispute is reviewed. |
| `console.invoices.dunning.status-reminder-1-held` | Reminder: paused while your dispute is reviewed. |
| `console.invoices.dunning.status-reminder-2-held` | Second reminder: paused while your dispute is reviewed. |
| `console.invoices.dunning.status-formal-notice-held` | Formal notice and late-payment penalties: paused while your dispute is reviewed. |
| `console.invoices.dunning.status-suspension-notice-held` | Suspension notice: paused while your dispute is reviewed. |
| `console.invoices.dunning.hint-restore` | Payment restores access within one business day. |
| `console.invoices.dunning.action-pay-now` | Pay now |
| `console.invoices.subscription.title` | Your plan |
| `console.invoices.subscription.label-capacity` | {count} people in meetings at the same time |
| `console.invoices.subscription.hint-price-changes` | Our prices change at most once a year, with 60 days' notice. |
| `console.invoices.subscription.empty-active` | No active subscription for this organisation. |
| `console.invoices.subscription.label-commitment` | Committed until |
| `console.invoices.subscription.hint-included` | Included: Visio {count} concurrent participants, Docs, 30-day backups, support within {hours} business hours, 99.5% SLA with credits. |
| `console.invoices.subscription.hint-upgrade-prorata` | Moving up takes effect immediately. Pro-rata amount: {amount}. |
| `console.invoices.subscription.hint-downgrade` | Moving down takes effect at the end of the commitment, on {date}. |
| `console.invoices._.banner-suspended` | Your space is suspended over an unpaid invoice. Paying restores access within one business day; your data is kept. |
| `console.invoices._.error-role` | Invoices are for the owner and administrators. Ask {owner}. |
| `console.invoices._.error-role-generic` | Invoices are for the organisation's owner and administrators. |
| `console.invoices._.a11y-breadcrumb` | Breadcrumb |
| `console.invoices._.a11y-loading` | Loading… |
| `console.invoices._.vat-regime-eu-reverse-charge` | VAT not applicable, reverse charge by the customer (article 196 of directive 2006/112/EC). |
| `console.invoices._.vat-regime-exempt` | VAT not applicable, article 293 B of the French tax code. |
| `console.invoices._.vat-regime-outside-eu` | VAT not applicable, export outside the European Union. |
| `console.invoices.list.banner-overdue` | {count, plural, one {Invoice {number} is {count} day overdue.} other {Invoice {number} is {count} days overdue.}} |
| `console.invoices.list.banner-overdue-no-days` | Invoice {number} is overdue. |
| `console.invoices.list.banner-overdue-unnumbered` | {count, plural, one {An invoice is {count} day overdue.} other {An invoice is {count} days overdue.}} |
| `console.invoices.list.banner-overdue-unnumbered-no-days` | An invoice is overdue. |
| `console.invoices.list.detail-suspension` | Without payment by {date}, access will be suspended. |
| `console.invoices.list.detail-hold` | A dispute is open: reminders are paused until {date} while it is reviewed. |
| `console.invoices.list.caption` | Your invoices |
| `console.invoices.list.label-period-monthly` | monthly |
| `console.invoices.list.label-period-yearly` | yearly |
| `console.invoices.list.label-annual-ex-vat` | Annual amount excl. VAT |
| `console.invoices.list.label-state-filter` | Filter by status |
| `console.invoices.list.option-all` | All |
| `console.invoices.list.action-view-detail` | View detail |
| `console.invoices.list.action-view-subscription` | View my subscription |
| `console.invoices.list.empty-body-date` | It will be issued on {date}. |
| `console.invoices.list.a11y-row-actions` | Actions for invoice {number} |
| `console.invoices.list.a11y-pagination` | Invoice pagination |
| `console.invoices.list.a11y-more-loaded` | {count} more invoices shown. |
| `console.invoices.detail.action-open-payment` | Open payment |
| `console.invoices.detail.title-payment-link-ready` | Payment link ready |
| `console.invoices.detail.title-payment-in-progress` | Payment in progress? |
| `console.invoices.detail.action-check-payment` | I've paid |
| `console.invoices.detail.caption-lines` | Detail of invoice {number} |
| `console.invoices.dunning.status-word-pending` | Ahead |
| `console.invoices.dunning.status-word-running` | In progress |
| `console.invoices.dunning.status-word-done` | Done |
| `console.invoices.dunning.status-word-failed` | Failed |
| `console.invoices.dunning.status-word-skipped` | Skipped |
| `console.invoices.dunning.status-word-paused` | Paused |

## 10. Support

| Key | Text |
|---|---|
| `console.support.help.title` | Help |
| `console.support.help.subtitle` | A question or a problem: write to us and we answer by email. |
| `console.support.help.title-write` | Write to support |
| `console.support.help.body-write` | Write to us at {email}. We answer at the address you write from. |
| `console.support.help.label-address` | Address |
| `console.support.help.error-copy` | Copying failed. Select the address to copy it. |
| `console.support.help.title-include` | Include in your message |
| `console.support.help.label-include-organisation` | Your organisation's name: {organisation} |
| `console.support.help.label-include-topic` | The subject: {topic} |
| `console.support.help.label-include-page` | The page you were on |
| `console.support.help.label-include-time` | When it happened, even roughly |
| `console.support.help.label-include-time-if-problem` | If something went wrong, when it happened |
| `console.support.help.label-include-question` | Your question, in a few words |
| `console.support.help.action-write` | Write an email |
| `console.support.help.hint-write` | If an email app is set up on this device, this button opens it with this information already filled in; otherwise, copy the address. Never send us your password. |
| `console.support.help.mail-subject` | Help request — {organisation} |
| `console.support.help.mail-subject-topic` | {topic} — {organisation} |
| `console.support.help.mail-line-organisation` | Organisation: {organisation} ({slug}) |
| `console.support.help.mail-line-topic` | Subject: {topic} |
| `console.support.help.mail-line-page` | Page concerned: |
| `console.support.help.mail-line-time` | Time of the problem: |
| `console.support.help.mail-line-description` | What is happening? |
| `console.support.help.mail-line-time-if-problem` | Time of the problem, if any: |
| `console.support.help.mail-line-question` | Your question: |
| `console.support.help.mail-line-question-or-description` | Your question, or what is happening: |
| `console.support.help.title-links` | Useful links |
| `console.support.help.action-status` | See your instance's status |
| `console.support.help.hint-status` | Ongoing disruptions are reported there. |
| `console.support.help.action-invoices` | See your invoices |
| `console.support.help.hint-invoices` | Every invoice downloads as a PDF; the bank-transfer details are on it. |
| `console.support.help.about-stale` | Your instance has stopped reporting |
| `console.support.help.about-step-failed` | A provisioning step failed |
| `console.support.help.about-step-failed-reference` | A provisioning step failed (reference {reference}) |
| `console.support.help.about-provisioning` | Your instance's provisioning |
| `console.support.help.about-incident` | Ongoing incident on your instance |
| `console.support.help.about-invoice` | Invoice {number} |
| `console.support.help.about-change-plan` | Plan change |
| `console.support.help.about-capacity` | Your plan's capacity |
| `console.support.help.about-dunning` | Late payment |
| `console.support.help.about-order` | Your order |
| `console.support.help.about-state-ready` | Your instance is ready to be handed over |
| `console.support.help.about-state-upgrading` | Your instance is being updated |
| `console.support.help.about-state-maintenance` | Maintenance under way on your instance |
| `console.support.help.about-state-suspended` | Your instance is suspended |
| `console.support.help.about-state-decommissioning` | Your instance is being closed |
| `console.support.help.about-state-deleted` | Your instance is closed |
| `console.support.help.about-state-failed` | An operation on your instance failed |
| `console.support.panel.title` | Help |
| `console.support.panel.subtitle` | A human, real-time status, and answers to common questions. |
| `console.support.panel.title-articles` | On this page |
| `console.support.panel.title-write` | Cannot find it? |
| `console.support.panel.action-write` | Write to the team |
| `console.support.panel.status-sla` | Reply within {hours} business hours · {businessHours} |
| `console.support.panel.status-sla-unknown` | We reply as soon as we can. |
| `console.support.panel.action-follow-incident` | Follow the incident |
| `console.support.panel.action-tickets` | Your open requests ({count}) |
| `console.support.panel.hint-shortcut` | Keyboard shortcut: Alt + / |
| `console.support.panel.title-status` | Your instance status |
| `console.support.panel.label-component-web` | Web (Visio, Docs) |
| `console.support.panel.label-component-calls` | Calls (audio, video) |
| `console.support.panel.label-component-login` | Sign-in |
| `console.support.panel.status-maintenance` | Planned maintenance: {date}, {start}–{end}. Ongoing calls are not interrupted. |
| `console.support.panel.title-faq` | Frequently asked questions |
| `console.support.new.title` | Contact support |
| `console.support.new.subtitle` | Reply within {hours} business hours ({plan}). Your instance details are attached automatically — nothing technical to explain. |
| `console.support.new.label-category` | What is it about? |
| `console.support.new.label-category-accounts` | Sign-in and accounts |
| `console.support.new.label-category-calls` | Video calls |
| `console.support.new.label-category-docs` | Documents |
| `console.support.new.label-category-domain` | Address and domain |
| `console.support.new.label-category-billing` | Billing |
| `console.support.new.label-category-security` | Security |
| `console.support.new.label-category-other` | Something else |
| `console.support.new.label-impact` | What is the impact? |
| `console.support.new.label-impact-blocking` | Nobody can work |
| `console.support.new.label-impact-partial` | Part of the team is affected |
| `console.support.new.label-impact-question` | It is a question, nothing is blocked |
| `console.support.new.label-subject` | Subject |
| `console.support.new.label-body` | What happened? |
| `console.support.new.hint-body` | Tell us what you have already tried, it saves us both time. |
| `console.support.new.placeholder-body` | A few words is enough. The time and the room name help even more. |
| `console.support.new.label-attachments` | Attachments |
| `console.support.new.hint-attachments` | PNG, JPG, PDF or a text file · 10 MB per file · 5 files maximum |
| `console.support.new.title-context` | Information attached automatically |
| `console.support.new.label-context-organisation` | Organisation and plan ({organisation}, {tier}) |
| `console.support.new.label-context-tenant` | Your space's status ({state}) |
| `console.support.new.label-context-screen` | The page you are writing from ({screen}) |
| `console.support.new.label-context-request` | Reference of the last error ({requestId}) |
| `console.support.new.label-context-browser` | Browser and system ({browser}) |
| `console.support.new.hint-context-privacy` | We do not attach the content of your meetings or your documents. |
| `console.support.new.hint-context-required` | Your organisation's name is always attached: without it we cannot answer you. |
| `console.support.new.status-context-attached` | Attached: instance {slug} · {plan} · v{version} · Paris |
| `console.support.new.action-edit-context` | Change what is attached |
| `console.support.new.status-sla` | Reply expected within {hours} business hours. |
| `console.support.new.status-sla-out-of-hours` | You are writing outside business hours: first reply expected {day} before {time}. |
| `console.support.new.action-submit` | Send the request |
| `console.support.new.status-submitted` | Request {reference} sent. Reply expected before {deadline}. |
| `console.support.new.error-category-required` | Choose what your request is about. |
| `console.support.new.error-impact-required` | Tell us the impact so we can prioritise correctly. |
| `console.support.new.error-subject-required` | Sum up your request in a few words. |
| `console.support.new.error-body-too-short` | Describe what is happening in a few sentences: it saves a round trip. |
| `console.support.new.error-body-too-long` | Your description is over 10,000 characters. Attach the detail as a file. |
| `console.support.new.hint-secret-detected` | This text may contain a password or a key. Remove it: we never need one. |
| `console.support.new.error-file-type` | This file format is not accepted. |
| `console.support.new.error-file-too-large` | This file is over 10 MB. Compress it, or email it quoting the reference. |
| `console.support.new.error-submit-failed` | Your request could not be sent. Nothing is lost: try again, or email {email}. |
| `console.support.tickets.title` | Your requests |
| `console.support.tickets.status-open` | In progress |
| `console.support.tickets.status-waiting-on-you` | Waiting for your reply |
| `console.support.tickets.status-answered` | Answered |
| `console.support.tickets.status-closed` | Closed |
| `console.support.tickets.status-deadline` | Reply expected before {time} |
| `console.support.tickets.empty-title` | No requests yet |
| `console.support.tickets.empty-body` | Write to us as soon as something blocks you: we would rather have one question too many. |
| `console.support.ticket.label-author-you` | You |
| `console.support.ticket.label-author-team` | Kodera team |
| `console.support.ticket.title-context` | Attached information |
| `console.support.ticket.label-reply` | Your reply |
| `console.support.ticket.action-reply` | Send the reply |
| `console.support.ticket.error-reply-required` | Write your reply. |
| `console.support.ticket.error-attachment-failed` | The attachment {filename} could not be sent. Try again, or email it quoting reference {reference}. |
| `console.support.ticket.error-closed` | This request is closed. We are opening a new one that references it, so the context follows. |
| `console.support.ticket.error-not-found` | This request does not exist or does not belong to your organisation. |
| `console.support.signin.title` | Cannot sign in? |
| `console.support.signin.label-email` | Your email address |
| `console.support.signin.label-organisation-hint` | Your organisation identifier, if you know it |
| `console.support.signin.label-body` | What is happening? |
| `console.support.signin.action-submit` | Send |
| `console.support.signin.hint-privacy` | We reply to this address. Never send us your password. |
| `console.support.signin.status-submitted` | If we know this address, you will receive a reply by email. |
| `console.support.signin.error-email-required` | Enter the email address we should reply to. |
| `console.support.signin.error-rate-limited` | We have already received a request for this address. Try again in {minutes} minutes, or email {email}. |

## 11. Federation

| Key | Text |
|---|---|
| `console.federation.overview.title` | Sign in with your company accounts |
| `console.federation.overview.subtitle` | Your colleagues sign in with their Microsoft 365 or Google Workspace account. No extra password. |
| `console.federation.overview.title-provider` | {provider} sign-in — three steps, with us |
| `console.federation.overview.subtitle-guided` | You (or your IT provider) create an "application" in the {provider} console with the values shown, then paste the ID and secret here. A Kodera team member checks with you before activation — that’s by design, not a fault. |
| `console.federation.overview.warning-effort` | Allow about twenty minutes, with the person who administers your Microsoft or Google accounts. We can guide you through it. |
| `console.federation.overview.action-book-checkin` | Book a guided session |
| `console.federation.overview.label-microsoft` | Microsoft 365 (Entra ID) |
| `console.federation.overview.label-google` | Google Workspace |
| `console.federation.overview.action-configure` | Set up {provider} |
| `console.federation.overview.action-other-provider` | Another provider? Contact us. |
| `console.federation.overview.status-active` | Active |
| `console.federation.overview.status-configured` | Set up, never tested |
| `console.federation.overview.status-disabled` | Disabled |
| `console.federation.overview.status-pending-review` | Request received on {date}. We confirm within one business day. A sign-in test will be run with you. |
| `console.federation.overview.status-eta` | Reply within one business day |
| `console.federation.overview.action-edit-request` | Edit |
| `console.federation.overview.label-domains` | Accepted domains: {domains} |
| `console.federation.overview.label-last-test` | Last successful test: {date} |
| `console.federation.overview.label-login-mode-both` | Both sign-in methods stay available |
| `console.federation.overview.label-login-mode-redirect` | Automatic redirect enabled |
| `console.federation.overview.action-test-again` | Run the test again |
| `console.federation.overview.action-edit-domains` | Change the domains |
| `console.federation.overview.action-disable` | Disable |
| `console.federation.overview.confirm-disable-title` | Disable {provider} sign-in? |
| `console.federation.overview.confirm-disable-body` | Your colleagues will sign in with an email address and a password again. No account is deleted. |
| `console.federation.overview.warning-secret-expiring` | The secret provided by {provider} expires on {date}. Renew it before then to avoid an interruption: the instructions are here. |
| `console.federation.overview.hint-deprovisioning` | Once active, anyone disabled in {provider} can no longer sign in here. Their sessions expire within 24 h. |
| `console.federation.overview.empty-body` | No company sign-in is set up. Your colleagues sign in with an email address. |
| `console.federation.domains.title` | Which email domains do you use? |
| `console.federation.domains.hint` | Anyone whose address ends with one of these domains will be sent to {provider} to sign in. |
| `console.federation.domains.hint-ownership` | These domains must belong to you. We check ownership as we do for a custom address. |
| `console.federation.domains.label` | Allowed email domain |
| `console.federation.domains.hint-restriction` | Only addresses on this domain will be able to sign in. |
| `console.federation.domains.error-required` | Enter at least one domain. |
| `console.federation.domains.error-format` | Enter a domain on its own, for example yourcompany.com, with no @ and no full address. |
| `console.federation.domains.error-not-verified` | Ownership of {domain} has not been proved yet. Prove it, then come back here. |
| `console.federation.domains.action-prove-domain` | Prove ownership of {domain} |
| `console.federation.domains.error-claimed-elsewhere` | {domain} is already used by another organisation. Contact us. |
| `console.federation.domains.error-too-many` | You can declare up to ten domains. |
| `console.federation.values.title` | Values to enter on the {provider} side |
| `console.federation.values.subtitle` | Forward this page to the person who administers your accounts. |
| `console.federation.values.label-application-name` | Application name |
| `console.federation.values.label-redirect-uri` | Redirect URI |
| `console.federation.values.label-logout-uri` | Sign-out URL |
| `console.federation.values.label-scopes` | Permissions |
| `console.federation.values.label-account-types` | Account types |
| `console.federation.values.action-copy-all` | Copy all the values |
| `console.federation.values.action-download-runbook` | One-page guide (PDF) |
| `console.federation.values.action-share-runbook` | Send by email |
| `console.federation.values.title-runbook` | Step by step |
| `console.federation.values.error-generation-failed` | The values could not be generated. Try again; if it continues, contact us. |
| `console.federation.values.error-pdf-failed` | The download is not available right now. The steps below are complete and can be copied. |
| `console.federation.credentials.title` | Paste the two values |
| `console.federation.credentials.label-client-id` | Client ID |
| `console.federation.credentials.hint-client-id` | It looks like: {example} |
| `console.federation.credentials.label-secret` | Client secret |
| `console.federation.credentials.hint-secret` | We store it encrypted. It will never be shown again. |
| `console.federation.credentials.label-secret-expiry` | Expiry date given by {provider} |
| `console.federation.credentials.hint-secret-expiry` | We will warn you thirty days ahead. |
| `console.federation.credentials.action-save-and-test` | Save and request verification |
| `console.federation.credentials.error-client-id-required` | Enter the application identifier. |
| `console.federation.credentials.error-client-id-format` | This identifier does not match the format {provider} uses. |
| `console.federation.credentials.error-secret-required` | Enter the client secret. |
| `console.federation.credentials.error-secret-looks-like-id` | You pasted the secret's identifier, not its value. In {provider}, copy the "Value" column — it is shown only once, right after you create the secret. |
| `console.federation.credentials.error-expiry-range` | Enter a date within the next five years. |
| `console.federation.credentials.error-save-failed` | The credentials could not be saved. The secret has been cleared from the form: paste it again. |
| `console.federation.test.title` | Let's test before switching it on |
| `console.federation.test.subtitle` | This test affects nobody else. We send you to {provider}, then bring you back here. |
| `console.federation.test.action-run` | Run the sign-in test |
| `console.federation.test.status-running` | Test in progress… |
| `console.federation.test.status-success` | Sign-in succeeded |
| `console.federation.test.label-account` | Account received |
| `console.federation.test.label-display-name` | Name |
| `console.federation.test.label-domain-allowed` | Domain allowed |
| `console.federation.test.status-failed` | Sign-in failed |
| `console.federation.test.action-fix-credentials` | Correct the credentials |
| `console.federation.test.action-retry` | Run the test again |
| `console.federation.test.error-test-required` | A successful test is needed before switching this on. Run the sign-in test. |
| `console.federation.test.error-invalid-client` | {provider} does not recognise the application identifier. Check that it is the application's identifier and not your directory's. |
| `console.federation.test.error-invalid-secret` | {provider} rejected the secret. The most common mistake is copying the secret's identifier instead of its value. |
| `console.federation.test.error-redirect-mismatch` | The redirect URI declared in {provider} does not match. Check that it is complete and that it was added as a "Web" application, not a "SPA". |
| `console.federation.test.error-consent-required` | An administrator of your directory must grant consent to the application. |
| `console.federation.test.error-tenant-mismatch` | The account used for the test belongs to a different directory, or the application was declared as multi-organisation. |
| `console.federation.test.error-domain-not-allowed` | Sign-in worked, but the address used is not in the domains you declared. Add this domain so your colleagues can sign in. |
| `console.federation.test.action-add-domain` | Add this domain |
| `console.federation.test.error-domain-not-verified` | The domain {domain} is claimed but not verified yet. Finish verifying it before turning on {provider} sign-in. |
| `console.federation.test.error-cancelled` | The test was interrupted before it finished. Nothing is wrong with your setup: run it again. |
| `console.federation.test.error-provider` | {provider} refused the sign-in without saying why. Write to us quoting reference {request_id}: we have the detail. |
| `console.federation.test.error-provider-unreachable` | {provider} did not respond. Your setup is not at fault: try again in a moment. |
| `console.federation.test.error-token-expired` | The secret has expired. Create a new one in {provider}, then paste it here. |
| `console.federation.activate.title` | How your colleagues will sign in |
| `console.federation.activate.label-mode-both` | Both methods stay available — recommended to start with |
| `console.federation.activate.label-mode-redirect` | Redirect automatically to {provider} |
| `console.federation.activate.action-activate` | Switch on |
| `console.federation.activate.confirm-redirect-title` | Switch on automatic redirect? |
| `console.federation.activate.confirm-redirect-body` | Your colleagues will no longer see the password screen: they will be sent straight to {provider}. The {count} people invited by email or by on-site code will no longer be able to sign in. You can change this back at any time from this page. |
| `console.federation.activate.action-confirm-redirect` | Switch on redirect to {provider} |
| `console.federation.activate.toast-activated` | {provider} sign-in switched on. |
| `console.federation.activate.error-count-changed` | The number of accounts changed while you were confirming. Check the new figure, then confirm again. |
| `console.federation.overview.error-last-route` | Turning {provider} off would leave nobody able to sign in. Create an owner account with a password first. |
| `console.federation.activate.error-failed` | Switching on did not complete. Nothing has changed: try again. |

## 12. Mock identity provider (test tooling)

Not a customer screen: the stand-in for Keycloak's own hosted login page under
`VITE_AUTH_MODE=mock` (ADR-0007), gated out of every build that is not the mock one. Listed here,
not written inline, for the same reason every other string in this file is — a hand-written
sentence in a component is untranslated to every English reader with nothing failing.

| Key | Text |
|---|---|
| `console.mockidp._.title` | Continue to {realm} |

---

## Changelog

- Merged with the design drop: translated key for key from the French, including the new
  `console.home.*` section, the renamed navigation keys and the wording the drop's French
  imposed on strings both catalogues covered.

- Initial version: English translation of the full French catalogue for the shell, login, and the
  seven launch areas.
- Keys added for the states the Core API contract makes reachable: second-factor required,
  tenant-state conflict, DNS `servfail` and an expired verification nonce, the suspension banner,
  a closed support request, three federation test outcomes, the stale acknowledgement count and
  the last-sign-in-route guard. `error-tier` now names the pack rather than a tier.

## Home recovery states

| Key | Copy |
|---|---|
| `console.home.overview.error-copy-failed` | Could not copy. Select the address to copy it. |
| `console.home.overview.title-space-state` | Your space status |
| `console.home.overview.state-upgrading` | Your space is being upgraded. |
| `console.home.overview.state-maintenance` | Maintenance is in progress on your space. |
| `console.home.overview.state-suspended` | Your instance is suspended. Check its status or email us at {email}. |
| `console.home.overview.state-decommissioning` | Your space is being closed. |
| `console.home.overview.state-deleted` | Your instance has been deleted. For any questions, email us at {email}. |
| `console.home.overview.state-failed` | An operation on your instance failed. Check its status or email us at {email}. |

## Status lifecycle recovery

| Key | Copy |
| --- | --- |
| `console.status.overview.title-state` | Your space status |
| `console.status.overview.state-ready` | Your space is ready for handover. |
| `console.status.overview.state-upgrading` | Your space is being updated. |
| `console.status.overview.state-maintenance` | Your space is undergoing maintenance. |
| `console.status.overview.state-suspended` | Your instance is suspended. Email us at {email} to find out what happens next. |
| `console.status.overview.state-decommissioning` | Your space is being closed. |
| `console.status.overview.state-deleted` | Your space is closed. |
| `console.status.overview.state-failed` | The last operation on your instance failed. Email us at {email}. |
| `console.status.overview.state-last-operation` | Last reported operation |
| `console.status.overview.state-health-unknown` | Service health unavailable |
| `console.status.overview.status-loading-subscription` | Loading your plan |

## Messaging demo preview (demo tooling)

Not a customer screen, and not a messenger this repository implements. Tchap is La Suite’s
Matrix-based messaging service; Kodera installs and operates it for a customer
(`contracts/core-api.openapi.yaml`, `TenantApp.app`). These strings label a *picture* of that
application, shown so an owner can demonstrate the suite. The surface is gated out of every build
that is not the mock one, exactly like the mock identity provider above. The fictional people,
channels and messages the preview displays are data and live in
`src/features/messaging/demo-fixture.ts`; everything written around them is here.

The rows below themselves ship in every build, because the whole catalogue does — measured: 32
`console.messaging.demo.*` keys are present in an `oidc`/no-MSW bundle, exactly as the two
`console.mockidp` keys above already are. Unreachable strings in a JSON blob, not a screen: the
route, the surface and the fixture are what `scripts/check-production-bundle.sh` proves absent,
and no build that omits those can render a word of this section.

| Key | Copy |
|---|---|
| `console.messaging.demo.badge` | Demonstration preview |
| `console.messaging.demo.title` | Tchap messaging |
| `console.messaging.demo.subtitle` | La Suite messaging, installed and operated by Kodera for {organisation} |
| `console.messaging.demo.notice` | This preview shows what Tchap looks like inside your space. It is connected to no messaging service: the people, channels and messages it displays are fictional. |
| `console.messaging.demo.navigation-label` | Channels and rooms in the preview |
| `console.messaging.demo.channels-title` | Channels |
| `console.messaging.demo.unread` | {count, plural, one {{count} unread message} other {{count} unread messages}} |
| `console.messaging.demo.rooms-title` | Rooms — audio and video |
| `console.messaging.demo.rooms-hint` | These rooms stay open all the time: people come and go without a meeting to organise. |
| `console.messaging.demo.room-occupancy` | {count, plural, one {{count} person of {capacity}} other {{count} people of {capacity}}} |
| `console.messaging.demo.room-empty` | Empty room, {capacity} seats |
| `console.messaging.demo.room-occupants-label` | People currently in {room} |
| `console.messaging.demo.room-kind-audio` | Audio |
| `console.messaging.demo.room-kind-video` | Video |
| `console.messaging.demo.room-kind-screen` | Screen sharing |
| `console.messaging.demo.state-speaking` | speaking |
| `console.messaging.demo.state-muted` | muted |
| `console.messaging.demo.state-sharing` | sharing their screen |
| `console.messaging.demo.state-available` | available |
| `console.messaging.demo.state-listening` | listening |
| `console.messaging.demo.conversation-label` | Conversation in channel {channel} |
| `console.messaging.demo.members-title` | {count, plural, one {{count} member} other {{count} members}} |
| `console.messaging.demo.members-label` | Members of channel {channel} |
| `console.messaging.demo.composer-label` | Message to {channel} |
| `console.messaging.demo.composer-hint` | The field is here to show the layout; this preview sends nothing. |
| `console.messaging.demo.composer-send` | Send |
| `console.messaging.demo.composer-sent` | Nothing was sent: this preview is connected to no messaging service. |
| `console.messaging.demo.empty-title` | Channel not in this preview |
| `console.messaging.demo.empty-body` | Only channel {channel} is shown here. |

## Appearance

The Appearance page (`docs/specs/10-appearance.md`): the theme choice, reached from the account menu.

| Key | Copy |
|---|---|
| `console.shell.appearance.title` | Appearance |
| `console.shell.appearance.subtitle` | Console theme |
| `console.shell.appearance.hint-choice` | The theme applies at once to the whole console. It is saved in this browser only: on another device or in another browser, choose it again. |
| `console.shell.appearance.label-theme` | Theme |
| `console.shell.appearance.label-system` | Automatic |
| `console.shell.appearance.hint-system` | the light sky or the night sky, following your device’s setting |
| `console.shell.appearance.label-ciel` | Sky |
| `console.shell.appearance.hint-ciel` | the official theme, glass over a light sky |
| `console.shell.appearance.label-ciel-nuit` | Sky night |
| `console.shell.appearance.hint-ciel-nuit` | the night sky, low light |
| `console.shell.appearance.label-light` | Light |
| `console.shell.appearance.hint-light` | office, daylight |
| `console.shell.appearance.label-dark` | Dark |
| `console.shell.appearance.hint-dark` | low light, end of the day |
| `console.shell.appearance.label-black` | Black |
| `console.shell.appearance.hint-black` | OLED screens, night use |
| `console.shell.appearance.warning-not-kept` | This browser did not save your choice: it applies to this page, not the next time it loads. To keep it, allow this site to store data in your browser’s settings. |

## Application cards

| Key | Text |
| --- | --- |
| `console.status.app.status-pending` | Preparing |
| `console.status.app.status-live` | Operational |
| `console.status.app.status-degraded` | Service disrupted |
| `console.status.app.status-unavailable` | Unavailable |
| `console.status.app.status-maintenance` | Under maintenance |
| `console.status.app.status-unknown` | Unknown status |
| `console.status.app.label-version` | Version {version} |

## Desktop page header

| Key | Text |
| --- | --- |
| `console.shell.header.a11y-label` | Page header |
| `console.shell.header.action-hide-navigation` | Hide navigation |
| `console.shell.header.action-show-navigation` | Show navigation |

## Billing summary blocks

| Key | Text |
| --- | --- |
| `console.invoices.summary.title-address` | Billing address |
| `console.invoices.summary.title-payment` | Payment methods |
| `console.invoices.summary.empty-address` | No billing address has been provided. |
| `console.invoices.summary.loading-address` | Loading billing address |
| `console.invoices.summary.label-next-invoice` | Next invoice |

## Theme codes and polls

| Key | Text |
| --- | --- |
| `console.appearance.theme.error-too-long` | Code refused: a theme code is at most 2048 bytes. |
| `console.appearance.theme.error-prefix` | Code refused: it must start with kodera-theme:v1: |
| `console.appearance.theme.error-base64` | Code refused: its base64 encoding is not canonical. |
| `console.appearance.theme.error-utf8` | Code refused: its content is not valid UTF-8. |
| `console.appearance.theme.error-json` | Code refused: its content is not valid JSON. |
| `console.appearance.theme.error-duplicate-field` | Code refused: a field appears twice. |
| `console.appearance.theme.error-unknown-field` | Code refused: it contains an unknown field. |
| `console.appearance.theme.error-missing-field` | Code refused: a required field is missing. |
| `console.appearance.theme.error-field-type` | Code refused: a field does not have the expected type. |
| `console.appearance.theme.error-version` | Code refused: only version v=1 is supported. |
| `console.appearance.theme.error-id` | Theme refused: the id is 1 to 64 characters among a-z, 0-9 and hyphen. |
| `console.appearance.theme.error-name` | Theme refused: the name is 1 to 64 bytes, with no outer space and no control character. |
| `console.appearance.theme.error-author` | Theme refused: the author is 1 to 64 bytes, with no outer space and no control character. |
| `console.appearance.theme.error-base-mode` | Theme refused: the base mode is light, dark or black. |
| `console.appearance.theme.error-colour` | Theme refused: each colour is written rgb(r, g, b), with whole numbers from 0 to 255. |

## Docs channel panel

| Key | Text |
| --- | --- |
| `console.docs.panel.title` | Docs — Collaborative documents |
| `console.docs.panel.label-active-channel` | Active channel: |
| `console.docs.panel.status-in-development` | In development |
| `console.docs.panel.region-label` | Active collaborative document |
| `console.docs.panel.default-pad-title` | Notes — {channel} |
| `console.docs.panel.action-copy-link` | Copy the link |
| `console.docs.panel.action-copy-link-named` | Copy the link to the document {title} |
| `console.docs.panel.label-link-copied` | Link copied |
| `console.docs.panel.action-open` | Open in Docs ↗ |
| `console.docs.panel.action-open-named` | Open {title} in Docs — new tab |
| `console.docs.panel.editor-title` | Notes draft |
| `console.docs.panel.editor-notice` | Live co-editing is in development: this draft stays in this tab and is shared with no one. |
| `console.docs.panel.editor-label` | Channel notes draft |
| `console.docs.panel.draft-initial` | Local draft, not shared |
| `console.docs.panel.draft-edited` | Draft changed, not shared |
| `console.docs.panel.draft-kept` | Draft kept for {title}, not shared |
| `console.docs.panel.draft-heading` | Minutes — {channel} |
| `console.docs.panel.draft-first-item` | Team actions and decisions to record |
| `console.docs.panel.action-insert-heading` | H2 heading |
| `console.docs.panel.snippet-heading` | New section |
| `console.docs.panel.action-insert-action` | Action item |
| `console.docs.panel.snippet-action` | Action item to follow up |
| `console.docs.panel.action-insert-decision` | Decision |
| `console.docs.panel.snippet-decision` | Decision approved in the meeting. |
| `console.docs.panel.action-keep-draft` | Keep the draft |
| `console.docs.panel.pads-count` | Documents linked to the channel ({count}) |
| `console.docs.panel.pads-label` | Channel documents |
| `console.docs.panel.label-new-pad` | New collaborative document |
| `console.docs.panel.placeholder-new-pad` | Agenda, minutes… |
| `console.docs.panel.action-create-pad` | Create the pad |

## Workspace

| Key | Text |
| --- | --- |
| `console.workspace._.title` | Workspace |
| `console.workspace.sidebar.title` | Channels |
| `console.workspace.sidebar.empty-category` | No channels yet. |
| `console.workspace.sidebar.action-switch-organisation` | {name}, switch organisation |
| `console.workspace.search.action-open` | Search |
| `console.workspace.search.label-shortcut` | Ctrl K |
| `console.workspace.search.label-shortcut-mac` | ⌘ K |
| `console.workspace.search.title` | Go to a channel |
| `console.workspace.search.label-query` | Channel name |
| `console.workspace.search.label-results` | Matching channels |
| `console.workspace.search.label-audio` | Audio room |
| `console.workspace.search.label-empty` | No channel has this name. |
| `console.workspace.category.general` | General |
| `console.workspace.category.team` | Team |
| `console.workspace.channel.welcome` | welcome |
| `console.workspace.channel.general` | general |
| `console.workspace.channel.lounge` | lounge |
| `console.workspace.channel.proximity` | proximity |
| `console.workspace.channel.body-empty` | Messaging is not available for your organisation. |
| `console.workspace.channel.body-open` | Open your messages to read and write in your channels. |
| `console.workspace.channel.body-opening` | Opening your messages… |
| `console.workspace.channel.label-archived` | Archived |
| `console.workspace.channel.label-preparing` | Being prepared |
| `console.workspace.channel.label-arriving` | Your channels are on their way… |
| `console.workspace.channel.title-not-found` | This channel is not available |
| `console.workspace.setup.title-preparing` | Your workspace is being prepared |
| `console.workspace.setup.banner-preparing` | Your workspace is being prepared. You will be able to write in it as soon as it is ready. |
| `console.workspace.setup.body-preparing` | This page updates by itself. You can leave and come back later. |
| `console.workspace.setup.title-confirming-owner` | We are confirming your ownership |
| `console.workspace.setup.body-confirming-owner` | We will contact you to confirm that you own the organisation. Your workspace will be ready after that. |
| `console.workspace.setup.title-failed` | Your workspace setup has stopped |
| `console.workspace.setup.body-failed` | Our team has been told and is on it; there is nothing for you to do. |
| `console.workspace.setup.title-ready` | Your workspace is ready to be created |
| `console.workspace.setup.body-ready` | We will create your organisation’s starter categories and channels. |
| `console.workspace.setup.action-create` | Create the workspace |
| `console.workspace.setup.status-creating` | Creating the workspace… |
| `console.shell.rail.title-workspace` | Messages |
| `console.workspace.setup.title-not-created` | Your workspace has not been created yet |
| `console.workspace.setup.body-not-created` | An owner or administrator of your organisation can create it. |
| `console.workspace.setup.label-request-id` | Request ID: {requestId} |

## Invitation entry recovery

| Key | Text |
| --- | --- |
| `console.entry.recovery.title` | We cannot continue your request here |
| `console.entry.recovery.body` | This page cannot continue your request. |
| `console.entry.recovery.restart` | If you received an invitation, reopen the original link. |
| `console.entry.recovery.support` | If you need help, write to us at {email}. |

## First-owner claim

Source: `docs/specs/09-owner-claim.md`, behind `VITE_FIRST_OWNER_JOURNEY`.

| Key | Text |
| --- | --- |
| `console.claim.landing.eyebrow` | Kodera invitation |
| `console.claim.landing.busy` | One moment… |
| `console.claim.landing.sign-in` | Sign in with the invited account to become your organisation’s owner |
| `console.claim.landing.action-sign-in` | Sign in |
| `console.claim.landing.signing-in` | A sign-in window is open. Finish signing in in that window. |
| `console.claim.landing.action-cancel` | Cancel |
| `console.claim.landing.ready` | Confirm that you are becoming your organisation’s owner |
| `console.claim.landing.action-confirm` | Become the owner |
| `console.claim.landing.retry` | The confirmation did not go through. Try again in a moment. |
| `console.claim.landing.missing` | Reopen your invitation link to continue |
| `console.claim.landing.not-ready` | Your organisation is still being prepared. Reopen the link a little later. |
| `console.claim.landing.expired` | This invitation has expired. Ask us for a new link. |
| `console.claim.landing.revoked` | This invitation was cancelled. Ask us for a new link. |
| `console.claim.landing.consumed` | This invitation has already been used. Sign in as usual. |
| `console.claim.landing.mismatch` | Sign in with the account that received the invitation |
| `console.claim.landing.mfa` | Turn on two-step verification, then reopen your invitation link |
| `console.claim.landing.contact` | Verify your email address, then reopen your invitation link |
| `console.claim.landing.failed` | We could not confirm your invitation. Reopen the link or write to us at {email}. |
| `console.claim.landing.confirmed` | Your invitation is confirmed. Continue to choose your plan. |
| `console.claim.landing.action-continue` | Continue |
| `console.claim.landing.unknown` | This invitation link is not valid. Check it, or write to us at {email}. |


## Invitation acceptance

| Key | Text |
| --- | --- |
| `console.invitation.accept.eyebrow` | Kodera invitation |
| `console.invitation.accept.busy` | One moment… |
| `console.invitation.accept.sign-in` | You are invited to join {name}. Sign in with the account created for you. |
| `console.invitation.accept.action-sign-in` | Sign in |
| `console.invitation.accept.signing-in` | A sign-in window is open. Finish signing in in that window. |
| `console.invitation.accept.action-cancel` | Cancel |
| `console.invitation.accept.ready` | Join {name} to reach its workspace |
| `console.invitation.accept.action-accept` | Join {name} |
| `console.invitation.accept.retry` | The acceptance did not go through. Try again in a moment. |
| `console.invitation.accept.check-retry` | We could not check this invitation link. Try again in a moment. |
| `console.invitation.accept.action-retry` | Try again |
| `console.invitation.accept.member` | You are already a member of {name} |
| `console.invitation.accept.unusable` | This invitation cannot be used. Contact the person who invited you. |
| `console.invitation.accept.action-open` | Open home |
| `console.invitation.accept.action-open-workspace` | Open messages |
| `console.invitation.accept.missing` | Reopen your invitation link to continue |
| `console.invitation.accept.invalid` | This invitation link is not valid. Check it, or ask for a new invitation. |
| `console.invitation.accept.unknown` | This invitation does not exist or has already been used. Ask for a new invitation. |
| `console.invitation.accept.gone` | This invitation has expired or was withdrawn. Ask for a new invitation. |
| `console.invitation.accept.failed` | We could not confirm your invitation. Reopen the link or write to us at {email}. |

## Espace live entry

Source: `src/features/workspace/OpenEspace.tsx`, the way from the workspace's layout into the live
workspace, offered where the deployment names a matrix domain.

| Key | Text |
| --- | --- |
| `console.workspace.live.action-open` | Open messages |
| `console.workspace.live.document-title` | Espace — {app} |
| `console.workspace.live.document-title-unread` | ({count}) Espace — {app} |
| `console.workspace.live.problem-unreachable` | Messaging cannot be reached right now. Check your connection, then try again. |
| `console.workspace.live.problem-unavailable` | Messaging cannot open for your organisation right now. Try again later; if it continues, email us at {email}. |

## Espace audio rooms

Source: `src/features/espace/EspaceLiveView.tsx`, the call dock and the audio rooms of the sidebar.

| Key | Text |
| --- | --- |
| `console.workspace.audio.label-dock` | Call in progress |
| `console.workspace.audio.status-connecting` | Connecting… |
| `console.workspace.audio.status-connected` | Connected |
| `console.workspace.audio.status-reconnecting` | Reconnecting… |
| `console.workspace.audio.status-listen-only` | Connected · listen only |
| `console.workspace.audio.label-listen-only` | listen only |
| `console.workspace.audio.label-arriving` | Your channels are on their way… |
| `console.workspace.audio.action-mute` | Mute |
| `console.workspace.audio.action-unmute` | Unmute |
| `console.workspace.audio.action-deafen` | Deafen |
| `console.workspace.audio.action-undeafen` | Undeafen |
| `console.workspace.audio.action-leave` | Leave |
| `console.workspace.audio.action-retry` | Try again |
| `console.workspace.audio.action-dismiss` | Close |
| `console.workspace.audio.action-start-audio` | Turn on sound |
| `console.workspace.audio.label-playback-blocked` | Your browser is holding back the call's sound. |
| `console.workspace.audio.problem-forbidden` | You no longer have access to this room. |
| `console.workspace.audio.problem-unavailable` | Audio is unavailable right now. Try again in a moment. |
| `console.workspace.audio.problem-network` | The audio room cannot be reached. Check your connection, then try again. |
| `console.workspace.audio.problem-unauthenticated` | Your messaging session has expired. Sign in again to join the room. |
| `console.workspace.audio.problem-removed` | The call ended: you no longer have access to this room. |
| `console.workspace.audio.problem-room-closed` | The call ended: this audio room was closed. |
| `console.workspace.audio.problem-elsewhere` | The call continues in another tab. |
| `console.workspace.audio.problem-connection-lost` | The connection to the call was lost. Join the room again to resume. |
| `console.workspace.audio.problem-microphone` | Your microphone cannot be used. Allow it in your browser, then unmute. |
| `console.workspace.audio.problem-microphone-denied` | The microphone is blocked for this site or by your system. Allow it, then unmute. |
| `console.workspace.audio.problem-microphone-missing` | No microphone was found. Plug one in, then unmute. |
| `console.workspace.audio.problem-microphone-in-use` | Another application is using your microphone. Close it, then unmute. |
| `console.workspace.audio.action-settings` | Audio settings |
| `console.workspace.audio.label-input` | Microphone |
| `console.workspace.audio.label-output` | Audio output |
| `console.workspace.audio.option-default` | System default |
| `console.workspace.audio.option-input-unnamed` | Microphone {index} |
| `console.workspace.audio.option-output-unnamed` | Output {index} |
| `console.workspace.audio.label-output-unsupported` | Your browser plays sound on the system output. |
| `console.workspace.audio.label-input-level` | Microphone level |
| `console.workspace.audio.label-input-missing` | The chosen microphone is not plugged in: the default one is used. |
| `console.workspace.audio.action-test-sound` | Test the sound |
| `console.workspace.audio.problem-test-sound` | The test sound could not play on this output. Choose another, then try again. |
| `console.workspace.audio.problem-microphone-stuck` | Your microphone could not be turned off: the call was ended so that no one can hear you. |
| `console.workspace.audio.confirm-leave-title` | Leave the call? |
| `console.workspace.audio.confirm-leave-body` | Leaving this page will end your call. Everyone else stays in the room. |
| `console.workspace.audio.action-confirm-leave` | Leave the call |
| `console.workspace.audio.action-stay` | Stay in the call |

## Workspace message actions

| Key | Text |
|---|---|
| `console.workspace.message.actions-label` | Actions for the message from {author} at {time} |
| `console.workspace.message.action-react` | React 👍 |
| `console.workspace.message.action-add-reaction` | Add a reaction |
| `console.workspace.message.reaction-palette-label` | Quick reactions |
| `console.workspace.message.action-react-with` | React with {emoji} |
| `console.workspace.message.action-reply` | Reply |
| `console.workspace.message.action-open-thread` | Open thread |
| `console.workspace.message.action-edit` | Edit |
| `console.workspace.message.action-delete` | Delete |
| `console.workspace.message.action-pin` | Pin |
| `console.workspace.message.action-unpin` | Unpin |

## Workspace pins, search and Kodera emoji

| Key | Text |
|---|---|
| `console.workspace.pins.action-open` | Pinned messages ({count}) |
| `console.workspace.pins.title` | Pinned messages |
| `console.workspace.pins.empty` | No pinned messages in this channel. Pin one from its « ··· » menu. |
| `console.workspace.pins.not-loaded` | Older than the loaded history. |
| `console.workspace.find.action-open` | Search this channel |
| `console.workspace.find.field-label` | Words to find |
| `console.workspace.find.hint` | In the loaded messages, ignoring accents and capitals. |
| `console.workspace.find.empty` | No loaded message holds these words. |
| `console.workspace.find.count-results` | {count, plural, one {{count} message found} many {{count} messages found} other {{count} messages found}} |
| `console.workspace.find.label-more` | Only the {count} newest are listed. |
| `console.workspace.composer.label-kodera-emoji` | Kodera emoji |

## Live workspace message controls

| Key | Text |
|---|---|
| `console.workspace.message.label-edited` | (edited) |
| `console.workspace.message.label-deleted` | Message deleted |
| `console.workspace.message.label-mentions-you` | Mentions you |
| `console.workspace.message.label-reply` | In reply to |
| `console.workspace.message.reply-banner` | In reply to <author/> |
| `console.workspace.message.status-sending` | Sending… |
| `console.workspace.message.status-failed` | Send failed |
| `console.workspace.message.reaction-label` | {emoji} {count} |
| `console.workspace.message.reaction-mine` | {emoji} {count}, you reacted |
| `console.workspace.message.session-expired` | Your messaging session has expired. |
| `console.workspace.message.action-reconnect` | Sign in again |
| `console.workspace.thread.count-replies` | {count, plural, one {{count} reply} many {{count} replies} other {{count} replies}} |
| `console.workspace.thread.title` | Thread |
| `console.workspace.thread.label-replies` | Replies |
| `console.workspace.thread.composer-label` | Reply to thread |
| `console.workspace.thread.composer-placeholder` | Reply to thread… |
| `console.workspace.thread.action-reply` | Reply |
| `console.workspace.composer.reply-cancel` | Cancel reply |
| `console.workspace.composer.edit-label` | Editing message |
| `console.workspace.composer.edit-cancel` | Cancel edit |
| `console.workspace.composer.label-mention-list` | Members to mention |
| `console.workspace.composer.label-message` | Message in #{channel} |
| `console.workspace.composer.placeholder-message` | Write in #{channel} |
| `console.workspace.composer.action-save` | Save |
| `console.workspace.composer.action-send` | Send |
| `console.workspace.composer.action-mention` | Mention |
| `console.workspace.composer.action-emoji` | Insert an emoji |
| `console.workspace.composer.label-emoji-palette` | Emoji |
| `console.workspace.composer.action-insert-emoji` | Insert {emoji} |
| `console.workspace.composer.label-emoji-list` | Matching emoji |
| `console.workspace.shortcuts.announce-channel` | Channel #{channel} |
| `console.workspace.shortcuts.announce-no-unread` | No other unread channel |
| `console.workspace.shortcuts.announce-marked-read` | #{channel} marked as read |
| `console.workspace.shortcuts.announce-editing` | Editing your last message. Escape to cancel. |
| `console.workspace.channel.log-label` | Messages in {channel} |
| `console.workspace.channel.live-empty` | No messages in #{channel}. |
| `console.workspace.channel.action-load-older` | Show earlier messages |
| `console.workspace.channel.status-loading-older` | Loading earlier messages… |
| `console.workspace.channel.error-load-older` | Earlier messages could not be loaded. |
| `console.workspace.channel.label-history-start` | Beginning of #{channel} |
| `console.workspace.channel.label-day-today` | Today |
| `console.workspace.channel.label-day-yesterday` | Yesterday |
| `console.workspace.channel.label-new-messages` | New messages |
| `console.workspace.channel.members-count` | {count, plural, one {{count} member} many {{count} members} other {{count} members}} |
| `console.workspace.channel.typing-one` | {name} is typing… |
| `console.workspace.channel.typing-two` | {first} and {second} are typing… |
| `console.workspace.channel.typing-many` | Several people are typing… |
| `console.workspace.channel.label-unread` | unread |
| `console.workspace.channel.count-mentions` | {count, plural, one {{count} mention} many {{count} mentions} other {{count} mentions}} |

## Live audio room-row controls

| Key | Text |
|---|---|
| `console.workspace.audio.action-join-room` | Join {room} |
| `console.workspace.audio.label-empty` | empty |
| `console.workspace.audio.count-people` | {count, plural, one {{count} person} many {{count} people} other {{count} people}} |
| `console.workspace.audio.label-occupants` | In {room} |
| `console.workspace.audio.label-sharing-screen` | sharing their screen |
| `console.workspace.audio.action-show-others` | {count, plural, one {Show {count} other person} many {Show {count} other people} other {Show {count} other people}} |

| `console.workspace.presence.online` | online |
| `console.workspace.members.title` | Members |

| `console.workspace.members.admins` | Administrators |

| `console.workspace.channel.welcome-title` | Welcome to #{channel} |
| `console.workspace.channel.create-in-category` | Create a channel in {category} |
| `console.workspace.layout.resize-channels` | Resize the channel column |
| `console.workspace.layout.resize-side-panel` | Resize the side panel |
| `console.workspace.canvas.mode-label` | Channel view |
| `console.workspace.canvas.mode-chat` | Chat |
| `console.workspace.canvas.mode-docs` | Docs |
| `console.workspace.members.online-count` | Online ({count}) |
| `console.workspace.members.state-online` | Online |
| `console.workspace.members.state-offline` | Offline |
| `console.workspace.proximity.title` | Around me |
| `console.workspace.proximity.state-disconnected` | Not connected |
| `console.workspace.proximity.state-connected` | Connected |
| `console.workspace.proximity.disconnected-body` | The proximity relay is in development. |
| `console.workspace.proximity.message-label` | Zone or short message (optional) |
| `console.workspace.proximity.message-placeholder` | E.g. Reception, 2nd floor |
| `console.workspace.proximity.actions-label` | Share your presence |
| `console.workspace.proximity.status-safe` | Here |
| `console.workspace.proximity.status-assistance` | Could use a hand |
| `console.workspace.proximity.status-muster` | Meeting point |
| `console.workspace.proximity.status-note` | Note |
| `console.workspace.proximity.sent` | Presence shared: {status} |
| `console.workspace.proximity.roster-count` | {count, plural, one {{count} person nearby} other {{count} people nearby}} |
| `console.workspace.proximity.roster-show` | Show |
| `console.workspace.proximity.roster-hide` | Hide |
| `console.workspace.proximity.roster-label` | People nearby |
| `console.workspace.proximity.local-name` | You (this device) |
| `console.workspace.proximity.notice` | This is not an emergency service and does not replace emergency numbers. If someone is in danger, call the emergency services. |
| `console.workspace.proximity.pseudonym-hint` | Checking in is voluntary. It is shown under a pseudonym, dedicated or generated, not under your name. |

## Product onboarding and deployment

| Key | Text |
| --- | --- |
| `console.onboarding.studio.identity` | Your workspace |
| `console.onboarding.studio.name` | Workspace name |
| `console.onboarding.studio.hosting` | Hosting |
| `console.onboarding.studio.cloud` | Instant European Cloud |
| `console.onboarding.studio.selfhost` | Self-hosted |
| `console.onboarding.studio.template` | Your organisation |
| `console.onboarding.studio.studio` | Audiovisual Production Company |
| `console.onboarding.studio.tech` | Technology & Product Studio |
| `console.onboarding.studio.consulting` | Consulting & B2B |
| `console.onboarding.studio.public` | Public sector |
| `console.onboarding.studio.proximity` | Field and event teams |
| `console.onboarding.studio.finish` | Make it yours |
| `console.onboarding.studio.next` | Continue |
| `console.onboarding.studio.back` | Back |
| `console.onboarding.studio.open` | Open workspace |
| `console.onboarding.studio.close` | Close |
| `console.onboarding.studio.theme` | Appearance |
| `console.onboarding.studio.light` | Frost |
| `console.onboarding.studio.dark` | Slate |
| `console.onboarding.studio.black` | Real Black OLED |
| `console.onboarding.studio.sound` | Sound pack · 48 kHz |
| `console.onboarding.studio.invite` | Copy invitation link |
| `console.onboarding.studio.copied` | Copied |
| `console.onboarding.studio.invite-unavailable` | Your invitation link will be available after your workspace is created. |
| `console.onboarding.studio.preview` | Channel and role preview |
| `console.onboarding.studio.pad` | Call sheet & Post-production tracking |
| `console.onboarding.studio.roles` | @Producer · @Director · @post-production · @VFX/Sound Supervisor |
| `console.onboarding.studio.terminal` | One-command terminal deployment |
| `console.onboarding.studio.domain` | Public domain |
| `console.onboarding.studio.issuer` | External HTTPS OIDC issuer |
| `console.onboarding.studio.support` | Support mailbox |
| `console.onboarding.studio.copy-command` | Copy command |
| `console.onboarding.studio.trust` | External issuer required. Prepare public-trust.json with its trusted public keys. Linux VPS: Scaleway, Hetzner, Hostinger, OVHcloud. |
| `console.onboarding.studio.invalid` | Enter a public domain and valid HTTPS URL. |
| `console.onboarding.studio.thread-poll` | This poll will be published in the parent channel. |
| `console.onboarding.studio.frameio` | Frame.io reviews, timecodes and approvals directly in #post-production and #dailies-rushes. |
| `console.onboarding.studio.stage` | Stage & Control |
| `console.onboarding.studio.editing` | Editing room |
| `console.onboarding.studio.channel-proximity` | proximity |
| `console.onboarding.studio.integrations-studio` | Frame.io · /frameio-review |
| `console.onboarding.studio.integrations-tech` | GitHub · Qonto |
| `console.onboarding.studio.sound-givre` | Givre |
| `console.onboarding.studio.sound-atelier` | Atelier |
| `console.onboarding.extensions.count-reference` | {count, plural, one {{count} reference implementation} other {{count} reference implementations}} |
| `console.onboarding.extensions.list-label` | Kodera reference implementations |
| `console.onboarding.extensions.reference-note` | Starter examples to adapt: no external account is connected. |
| `console.onboarding.tour.step-badge` | Step {step} of {total} |
| `console.onboarding.tour.theme-title` | Visual appearance |
| `console.onboarding.tour.theme-subtitle` | Choose between the clarity of Givre and the night-time comfort of Nuit, with an instant preview. |
| `console.onboarding.tour.sonic-title` | 48 kHz acoustic signature |
| `console.onboarding.tour.sonic-subtitle` | Listen to and pick your sound identity, synthesised in real time by WebAudio DSP. |
| `console.onboarding.tour.av-check-title` | Microphone & local AI mask |
| `console.onboarding.tour.av-check-subtitle` | 100% on the device, no biometric data sent to the server. |
| `console.onboarding.tour.channels-title` | Your essential channels |
| `console.onboarding.tour.channels-subtitle` | A one-click guided tour of your coordination, architecture and proximity channels. |
| `console.onboarding.tour.general-label` | #general |
| `console.onboarding.tour.general-description` | Day-to-day coordination, team announcements and quick polls. |
| `console.onboarding.tour.general-badge` | Everyday |
| `console.onboarding.tour.architecture-label` | #architecture |
| `console.onboarding.tour.architecture-description` | System design, Matrix E2EE, LiveKit SFU and technical decisions. |
| `console.onboarding.tour.architecture-badge` | Engineering |
| `console.onboarding.tour.proximity-label` | #proximity |
| `console.onboarding.tour.proximity-description` | A voluntary, pseudonymous check-in with the people nearby, by named zone. It is not an emergency service. |
| `console.onboarding.tour.proximity-badge` | Presence |


## Matrix channel invitations

| Key | Text |
|---|---|
| `console.workspace.channel-invite.action-open` | Invite |
| `console.workspace.channel-invite.title` | Invite to channel (Matrix) |
| `console.workspace.channel-invite.description` | Invite someone to #{channel} or copy a link to this channel. Links respect the channel’s access rules. |
| `console.workspace.channel-invite.matrix-id` | Matrix user ID |
| `console.workspace.channel-invite.id-help` | For example: @firstname.lastname:example.org or @architect:example.com |
| `console.workspace.channel-invite.invalid` | Enter a complete Matrix user ID in the format @user:domain.tld. |
| `console.workspace.channel-invite.action-send` | Send Matrix invitation |
| `console.workspace.channel-invite.success` | Matrix invitation sent to {userId} |
| `console.workspace.channel-invite.error` | The Matrix invitation failed. Check your invitation permissions and server rules, then try again. |
| `console.workspace.channel-invite.unavailable` | Direct invitations are unavailable here. You can copy a channel link. |
| `console.workspace.channel-invite.clients` | The universal link opens in any Matrix client: Element, Tchap, Cinny, FluffyChat, Nheko or Kodera. |
| `console.workspace.channel-invite.matrix-to` | Universal Matrix link (matrix.to) |
| `console.workspace.channel-invite.alias` | Matrix channel alias |
| `console.workspace.channel-invite.alias-suggestion` | Suggested alias (not published) |
| `console.workspace.channel-invite.matrix-uri` | Native Matrix URI |
| `console.workspace.channel-invite.web` | Kodera web link |
| `console.workspace.channel-invite.copy` | Copy: {label} |
| `console.workspace.channel-invite.copied` | Copied |
| `console.workspace.channel-invite.copy-error` | Copy failed. Select the link to copy it manually. |
