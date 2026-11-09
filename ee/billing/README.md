# Kodera Enterprise Billing & Entitlements (`ee/billing`)

Status: Active

Production commercial subscription catalogues, custom Enterprise pricing schedules, Stripe / bank-transfer invoice automation, and seat/capacity entitlement enforcement belong to the Enterprise Edition (`KODERA_EDITION=enterprise`) governed by [`../LICENSE`](../LICENSE).

Community Self-Host (`deploy/community`) runs with `KODERA_BILLING_ENABLED=false` and requires zero billing configuration. Contract tests inside `apps/server` use synthetic non-commercial fixtures only.
