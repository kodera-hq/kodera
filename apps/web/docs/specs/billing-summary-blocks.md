# Billing summary blocks

Status: Implementation and the reviewed preview adaptations approved by the owner; protected CI and merge acceptance remain required.

## Scope and contract

Arrange the existing Billing overview into the complete mock's subscription block and a companion column for payment guidance and billing address. On narrower screens the blocks stack. Preserve the invoice table, filters, pagination, dunning, payment/PDF issuance, action leases, permission guard and subscription journey.

Subscription amounts, billing period, next invoice and current-period end are read from the existing active-subscription query; never calculate a monthly equivalent or invent contractual inclusions. Keep the existing subscription-detail route for the plan action. No event-pack sale, self-service price change or recurring mandate is introduced.

The read-only address uses GET /organisations/{organisation_id}, already present in the pinned Core contract and generated response fixtures. Consume only the legal/display name and billing_address. Validate organisation identity and all displayed fields before caching; reject a foreign or malformed response with a generic unavailable error. Missing address is an explicit empty state. Keep loading, unavailable and retry states local to this block so invoice actions remain usable. The existing invoices area guard must prevent this read for members without billing access.

Payment guidance states only the current supported behavior: pay each invoice online or by bank transfer, with transfer details on the PDF. It does not imply a saved card, bank mandate or automatic collection. No bank details are stored or invented here.

## Acceptance before code

Use the existing generated organisation and subscription examples as the mock baseline. Write failing profile parser cases and a missing-block browser assertion before implementation. Cover valid/absent/foreign/malformed address data and do not log response values. The card must distinguish loading, empty and failure, offer a working retry, and render only served fields. Browser acceptance checks the three blocks, exact served annual amount and period, responsive layout, unchanged invoice actions, and member denial without an organisation-profile request.

Existing invoice recovery, payment permissions, late-action protection, dunning, pagination and keyboard tests remain gates. Complete static/policy, unit and relevant browser checks; inspect pinned light/dark/black and narrow snapshots without tolerance changes. Independent adversarial, separate CTO and lead verification, owner preview approval and current-base protected CI precede merge.

## Approved adaptations

Use the shared component/token styles and real data. Omit unsupported plan-inclusion metrics, event-pack upsell and the mock's inert address-edit action. Keep card payment guidance truthful to the current per-invoice flow. The owner approved these adaptations together in the final preview.
