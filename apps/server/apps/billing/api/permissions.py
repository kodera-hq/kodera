"""Billing declarations; the stored role and the organisation are enforced by apps/billing/access.py."""

from core.api.scopes import Operation

LIST_PLANS = Operation(method="GET", operation_id="listPlans", scope="plan:read")
LIST_PACKS = Operation(method="GET", operation_id="listPacks", scope="plan:read")
LIST_CAPACITY_TIERS = Operation(method="GET", operation_id="listCapacityTiers", scope="plan:read")
LIST_PRICES = Operation(method="GET", operation_id="listPrices", scope="plan:read")
LIST_ORDERS = Operation(method="GET", operation_id="listOrders", scope="order:read")
GET_ORDER = Operation(method="GET", operation_id="getOrder", scope="order:read")
LIST_SUBSCRIPTIONS = Operation(
    method="GET", operation_id="listSubscriptions", scope="subscription:read"
)
GET_SUBSCRIPTION = Operation(
    method="GET", operation_id="getSubscription", scope="subscription:read"
)
LIST_INVOICES = Operation(method="GET", operation_id="listInvoices", scope="invoice:read")
GET_INVOICE = Operation(method="GET", operation_id="getInvoice", scope="invoice:read")
LIST_CREDIT_NOTES = Operation(method="GET", operation_id="listCreditNotes", scope="invoice:read")
GET_CREDIT_NOTE = Operation(method="GET", operation_id="getCreditNote", scope="invoice:read")
GET_DUNNING = Operation(method="GET", operation_id="getDunning", scope="subscription:read")
GET_BILLING_VAT = Operation(
    method="GET", operation_id="getBillingVatStatus", scope="billing_vat:read"
)
VALIDATE_BILLING_VAT = Operation(
    method="POST", operation_id="validateBillingVat", scope="billing_vat:update"
)
GET_PAYMENT_LINK = Operation(method="GET", operation_id="getPaymentLink", scope="payment:read")
CREATE_PAYMENT_LINK = Operation(
    method="POST", operation_id="createPaymentLink", scope="payment:create"
)
GET_INVOICE_DOWNLOAD_LINK = Operation(
    method="GET", operation_id="getInvoiceDownloadLink", scope="invoice:read"
)
PLACE_ORDER = Operation(method="POST", operation_id="placeOrder", scope="order:create")
CANCEL_ORDER = Operation(method="POST", operation_id="cancelOrder", scope="order:act")
LIST_TENANTS = Operation(method="GET", operation_id="listTenants", scope="tenant:read")
# The one step to a workspace on a deployment that does not bill (QUICK_WORKSPACE.md §4).
CREATE_TENANT = Operation(method="POST", operation_id="createTenant", scope="tenant:create")
GET_TENANT = Operation(method="GET", operation_id="getTenant", scope="tenant:read")
GET_TENANT_STATUS = Operation(method="GET", operation_id="getTenantStatus", scope="tenant:read")
GET_STATUS_SUMMARY = Operation(
    method="GET", operation_id="getOrganisationStatusSummary", scope="organisation:read"
)
CHECK_SLUG_AVAILABILITY = Operation(
    method="GET", operation_id="checkSlugAvailability", scope="organisation:read"
)
COUNT_MEMBERSHIPS = Operation(
    method="GET", operation_id="countMemberships", scope="membership:read"
)
GET_HELP_CONTEXT = Operation(
    method="GET", operation_id="getHelpContext", scope="support_ticket:read"
)
RECEIVE_STRIPE_WEBHOOK = Operation(
    method="POST", operation_id="receiveStripeWebhook", scope="payment:act"
)
