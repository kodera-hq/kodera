"""The billing switch: docs/specs/QUICK_WORKSPACE.md §2.

`KODERA_BILLING_ENABLED` (config/environment.py `billing_enabled`) is read from settings at call
time, so a test can turn it. With billing off, nothing that charges runs: `placeOrder`,
`createPaymentLink` and `settle_complimentary_order` refuse before they write, and an owner
creates the organisation's workspace in one step instead, on the unbilled offer below.
"""

from django.conf import settings

# The pack an unbilled workspace is created on: the one pack on sale
# (apps/billing/catalogue/offer.toml). The status summary names it, so the console reads the
# documents in force for it and never names a pack of its own.
UNBILLED_PACK = "workspace"
# Its capacity tier, the smallest: nothing is promised unbilled, so the tier is a label Fleet sizes
# the host by, never a limit Core enforces.
UNBILLED_TIER = "S"


class BillingDisabledError(Exception):
    """Billing is off on this deployment: `409 billing-disabled`, nothing written."""


class BillingEnabledError(Exception):
    """Billing is on: `createTenant`, the unbilled path, answers `409 billing-enabled`."""


def billing_enabled() -> bool:
    enabled: bool = settings.KODERA_BILLING_ENABLED
    return enabled


def require_billing() -> None:
    """Refuse an operation that charges while billing is off."""
    if not billing_enabled():
        raise BillingDisabledError()


def require_no_billing() -> None:
    """Refuse the unbilled path while billing is on: every tenant is then ordered and paid."""
    if billing_enabled():
        raise BillingEnabledError()
