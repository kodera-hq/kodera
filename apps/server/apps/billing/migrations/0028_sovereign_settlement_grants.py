"""Grant least-privilege Sovereign order/settlement privileges and draft-invoice issuer function."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP FUNCTION IF EXISTS public.billing_issue_draft_invoice(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.billing_issue_draft_invoice(
  p_organisation_id uuid,
  p_invoice_id uuid,
  p_series text,
  p_payment_terms_days integer
)
RETURNS TABLE(out_number text, out_issued_at timestamptz, out_due_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  inv public.billing_invoice%ROWTYPE;
  v_issued_at timestamptz;
  v_due_at timestamptz;
  v_year integer;
  v_seq integer;
  v_number text;
BEGIN
  IF p_organisation_id IS NULL
     OR p_invoice_id IS NULL
     OR p_series IS NULL OR p_series !~ '^[A-Z]{2,8}(-[A-Z]{2,8})?$'
     OR p_payment_terms_days IS NULL OR p_payment_terms_days < 0 OR p_payment_terms_days > 365 THEN
    RAISE EXCEPTION 'draft invoice issuance parameters invalid' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO inv
  FROM public.billing_invoice
  WHERE id = p_invoice_id AND organisation_id = p_organisation_id
  FOR UPDATE;
  IF NOT FOUND OR inv.state <> 'draft' OR inv.number IS NOT NULL THEN
    RAISE EXCEPTION 'invoice is not a draft awaiting issuance' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('billing-invoice-series:' || p_series, 0));
  v_issued_at := clock_timestamp();
  v_year := extract(year FROM (v_issued_at AT TIME ZONE 'Europe/Paris'))::integer;

  INSERT INTO public.billing_invoicenumbercounter (id, series, year, last_number)
  VALUES (public.retention_new_uuid7(), p_series, v_year, 1)
  ON CONFLICT (series, year) DO UPDATE
    SET last_number = public.billing_invoicenumbercounter.last_number + 1
  RETURNING last_number INTO v_seq;

  v_number := p_series || '-' || v_year::text || '-' || lpad(v_seq::text, 5, '0');
  v_due_at := v_issued_at + make_interval(days => p_payment_terms_days);

  UPDATE public.billing_invoice
  SET number = v_number,
      state = 'issued',
      issued_at = v_issued_at,
      due_at = v_due_at,
      updated_at = clock_timestamp()
  WHERE id = p_invoice_id AND organisation_id = p_organisation_id;

  RETURN QUERY SELECT v_number, v_issued_at, v_due_at;
END
$$;

REVOKE ALL ON FUNCTION public.billing_issue_draft_invoice(uuid, uuid, text, integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kodera_api') THEN
    REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.billing_invoicenumbercounter FROM kodera_api;
    GRANT INSERT ON TABLE
      public.billing_billingprofile,
      public.billing_order,
      public.billing_subscription,
      public.billing_invoice,
      public.billing_invoiceline,
      public.billing_billingartifact
    TO kodera_api;
    GRANT UPDATE (
      legal_name,
      address_line1,
      address_line2,
      postal_code,
      city,
      country,
      siren,
      vat_number
    ) ON TABLE public.billing_billingprofile TO kodera_api;
    GRANT UPDATE (confirmation_delivery_id) ON TABLE public.billing_order TO kodera_api;
    GRANT UPDATE (pdf_ref) ON TABLE public.billing_invoice TO kodera_api;
    GRANT UPDATE (status, status_changed_at, updated_at) ON TABLE public.tenancy_tenant TO kodera_api;
    GRANT UPDATE (plan_tier) ON TABLE public.orgs_organisation TO kodera_api;
    GRANT EXECUTE ON FUNCTION public.billing_issue_draft_invoice(uuid, uuid, text, integer) TO kodera_api;
  END IF;
END
$$;
"""

REVERSE = r"""
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kodera_api') THEN
    REVOKE EXECUTE ON FUNCTION public.billing_issue_draft_invoice(uuid, uuid, text, integer) FROM kodera_api;
    REVOKE UPDATE (plan_tier) ON TABLE public.orgs_organisation FROM kodera_api;
    REVOKE UPDATE (status, status_changed_at, updated_at) ON TABLE public.tenancy_tenant FROM kodera_api;
    REVOKE UPDATE (pdf_ref) ON TABLE public.billing_invoice FROM kodera_api;
    REVOKE UPDATE (confirmation_delivery_id) ON TABLE public.billing_order FROM kodera_api;
    REVOKE UPDATE (
      legal_name,
      address_line1,
      address_line2,
      postal_code,
      city,
      country,
      siren,
      vat_number
    ) ON TABLE public.billing_billingprofile FROM kodera_api;
    REVOKE INSERT ON TABLE
      public.billing_billingprofile,
      public.billing_order,
      public.billing_subscription,
      public.billing_invoice,
      public.billing_invoiceline,
      public.billing_billingartifact
    FROM kodera_api;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.billing_issue_draft_invoice(uuid, uuid, text, integer);
"""


class Migration(migrations.Migration):
    dependencies = [
        ("billing", "0027_concurrent_creditnote_partial_unique_index"),
        ("orgs", "0036_self_serve_shared_realm"),
        ("tenancy", "0001_initial"),
    ]

    operations = [
        migrations.RunSQL(FORWARD, reverse_sql=REVERSE),
    ]
