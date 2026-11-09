// Invoice-specific consumer checks. Generated client types do not validate wire
// responses. Check the fields this area renders or opens, without calculating
// money, certifying payment, or claiming complete OpenAPI validation.

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function money(value: unknown): boolean {
  return object(value) && Number.isSafeInteger(value.amount_minor) && value.currency === 'EUR'
}

const STATES: ReadonlySet<unknown> = new Set([
  'draft',
  'issued',
  'paid',
  'overdue',
  'void',
  'credited',
])
const VAT_REGIMES: ReadonlySet<unknown> = new Set([
  'fr_standard',
  'eu_reverse_charge',
  'exempt',
  'outside_eu',
])

/** List rows may retain the existing unavailable-amount fallback; detail totals are mandatory. */
export function requireInvoiceResponse(
  value: unknown,
  expected: { organisationId: string; invoiceId?: string }
): void {
  const fail = () => {
    throw new Error('Invoice response is unavailable.')
  }
  if (!object(value)) return fail()
  if (
    !text(value.id) ||
    !text(value.organisation_id) ||
    !STATES.has(value.state) ||
    value.organisation_id !== expected.organisationId ||
    (expected.invoiceId !== undefined && value.id !== expected.invoiceId) ||
    (value.pdf_available !== undefined && typeof value.pdf_available !== 'boolean') ||
    (value.vat_regime !== undefined && !VAT_REGIMES.has(value.vat_regime))
  )
    return fail()
  for (const field of ['number', 'external_ref']) {
    if (value[field] != null && typeof value[field] !== 'string') return fail()
  }
  for (const field of ['issued_at', 'due_at']) {
    if (value[field] != null && !timestamp(value[field])) return fail()
  }
  // The list explicitly offers the PDF when the row currency is unavailable.
  const absentRowAmount =
    value.total_incl_vat === undefined ||
    (object(value.total_incl_vat) && value.total_incl_vat.currency === undefined)
  if (expected.invoiceId === undefined) {
    if (!absentRowAmount && !money(value.total_incl_vat)) return fail()
    return
  }
  if (
    !money(value.total_incl_vat) ||
    !money(value.total_excl_vat) ||
    !money(value.vat_amount) ||
    (value.amount_due !== undefined && !money(value.amount_due)) ||
    !Array.isArray(value.lines) ||
    value.lines.some(
      (line: unknown) =>
        !object(line) ||
        typeof line.description !== 'string' ||
        !money(line.total_excl_vat) ||
        !Number.isSafeInteger(line.vat_rate_bp)
    )
  )
    return fail()
}

function usableLink(value: unknown): value is Record<string, unknown> {
  if (!object(value) || !text(value.url) || !timestamp(value.expires_at)) return false
  if (Date.parse(value.expires_at) <= Date.now()) return false
  // URL parsing normalises whitespace; refuse it before parsing instead of
  // quietly accepting a different destination spelling. Never log signed URLs.
  if (
    /\s/.test(value.url) ||
    [...value.url].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return false
  try {
    const url = new URL(value.url)
    return (
      url.protocol === 'https:' &&
      url.hostname.length > 0 &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}

export function requirePaymentLink(value: unknown, invoiceId: string): void {
  if (!usableLink(value) || value.invoice_id !== invoiceId || value.state !== 'active') {
    throw new Error('Payment link response is unavailable.')
  }
}

export function requireInvoiceDownloadLink(value: unknown): void {
  if (!usableLink(value) || value.content_type !== 'application/pdf') {
    throw new Error('Invoice PDF response is unavailable.')
  }
}

export function requireActiveSubscription(value: unknown, organisationId: string): void {
  if (
    !object(value) ||
    !text(value.id) ||
    value.organisation_id !== organisationId ||
    value.state !== 'active' ||
    !text(value.pack_code) ||
    (value.plan_code !== undefined && !text(value.plan_code)) ||
    (value.billing_period !== 'monthly' && value.billing_period !== 'yearly') ||
    !object(value.price_snapshot) ||
    !money(value.price_snapshot.total_excl_vat) ||
    !timestamp(value.current_period_end) ||
    (value.next_invoice_at != null && !timestamp(value.next_invoice_at))
  )
    throw new Error('Subscription response is unavailable.')
}

const DUNNING_STATES: ReadonlySet<unknown> = new Set([
  'current',
  'past_due',
  'notice',
  'formal_notice',
  'suspension_notice',
  'suspended',
  'terminated',
])

export function requireDunningResponse(value: unknown, organisationId: string): void {
  if (
    !object(value) ||
    !DUNNING_STATES.has(value.state) ||
    // The current wire has no organisation field; if one is supplied it cannot
    // contradict the organisation whose query produced this view.
    (value.organisation_id !== undefined && value.organisation_id !== organisationId) ||
    (value.oldest_overdue_invoice_id != null && !text(value.oldest_overdue_invoice_id)) ||
    (value.days_overdue != null &&
      (typeof value.days_overdue !== 'number' ||
        !Number.isSafeInteger(value.days_overdue) ||
        value.days_overdue < 0)) ||
    (value.hold_until != null && !timestamp(value.hold_until)) ||
    (value.amount_due != null && !money(value.amount_due)) ||
    !Array.isArray(value.steps) ||
    value.steps.some(
      (step: unknown) =>
        !object(step) ||
        !DUNNING_STATES.has(step.state) ||
        typeof step.done !== 'boolean' ||
        (step.due_at != null && !timestamp(step.due_at))
    )
  )
    throw new Error('Dunning response is unavailable.')
}
