# Invoice foundation recovery

Status: Recovered implementation under final independent review; not deployed

Preserve existing invoice feature cfad2bfe60ae6b4440ec466e1337ab12e8733dd6 on the reviewed common foundations. First measure actual query behavior before changing it: an empty subscription is explicit absence; malformed invoice collections and contradictory has_more/next_cursor cannot be presented as complete empty/terminal results. Keep explicit owner/admin/billing readers and protect draft invoices from customer lists.

The current wire permits an optional next_cursor. Refusing an impossible continuation in the consumer does not ratify a wire revision or implement a Core paginator. Preserve valid first/terminal/continuing pages as controls. A missing body cannot justify issuing a payment link, and a generic conflict cannot establish that an invoice was paid. Payment issuance, retry identity and late callbacks need separate measured acceptance before enabling or changing those side effects. Do not infer payment from return parameters or mocks.

The initial scaffold preceded production edits. The subsequent recovery is admitted by the ongoing implementation task, on isolated feature history with independent review. No external payment request or infrastructure operation is part of the qualification.

Initial actual-query acceptance reproduced five failures and two positive controls: empty subscription became an error; four malformed/contradictory invoice pages were accepted. Valid continuing and terminal pages retained draft filtering. Evidence is preserved in invoice-query-recovery-red.log. Those initial failures preceded the corrections described below.

## Additional recovered action boundaries

Actual detail-component acceptance reproduced three failures: a generic conflict announced payment while Core still reported issued, an unmounted page opened a late payment URL, and a successful empty subscription rendered no explanation. Payment state must follow the freshly read invoice, not a generic refusal. Async callbacks must retain their initiating organisation/view/session and retire after navigation, logout or identity replacement. The GET-to-POST fallback must check that same lifetime before issuance, not merely ignore its eventual response. Payment actions require a separate owner/billing grant; administrator invoice reading does not grant payment-link operations under the current wire contract.

Compose the already reviewed identity bridge normally so changed identities retire the session generation. Retain current root role navigation and independently tested area reading; the former route-stub unit assertion must be replaced by actual invoice-area guard coverage and full browser roles as the real feature replaces the stub. No server payment convergence or duplicate-provider proof follows from these client checks.

## Returned links

An automatic new-tab attempt after an asynchronous issuance may not open a tab. Preserve the validated, unexpired returned URL as an explicit user action within its initiating view/session; never infer a payment has started or succeeded from URL issuance. Both PDF and payment actions need this fallback. Refuse activation after expiry or view/session retirement. A missing window handle with noopener is not proof of blocking.

Dunning context must not disappear merely because a state filter or cursor page omits the oldest overdue invoice. Resolve its existing detail endpoint when the row is missing; show an explicit retry if that read fails. Never create or infer an invoice from the dunning summary.

## Final response and interaction boundaries

Feature-specific checks admit only usable rendered invoice, active-subscription and dunning fields. Invoice detail is bound to both the requested invoice and the current organisation, with both IDs in its query key. Link checks apply to successful GET and POST responses: active payment link, matching invoice, HTTPS without credentials, and future expiry; PDF responses additionally require application/pdf. Invalid successful lookup data never authorizes issuance. These checks do not implement server authentication, monetary calculations, provider reconciliation or a full schema validator.

Reference copy success follows a fulfilled clipboard write; refusal is visible and old-reference completions retire. The reviewed shared returnFocusTo implementation handles both bank dialog and dunning drawer consumers. Returned URLs retain an explicit user activation after the automatic tab attempt. Expired first and replacement results cannot appear usable; payment lookup can be retried while the invoice remains payable even after a PDF action replaces the displayed fallback.

Dunning discovery and off-page invoice failures expose retry. The drawer pays the already resolved, currently payable invoice instead of looking only in filtered rows. Empty filtered pages preserve a valid continuation. All payment controls separately require owner/billing; administrator invoice and PDF reading remain available. Original route-stub assertions are replaced by actual invoice guard and browser role coverage.

Recovery includes the original invoice feature and normal merges of the reviewed common session, role, active identity and focus histories. It does not claim complete collaboration mock parity, operational payment integration, customer readiness or an infrastructure deployment.
