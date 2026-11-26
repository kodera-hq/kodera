"""Keep Core's fiscal authority, refund evidence and independent document series atomic."""

from typing import Any

from django.db import migrations, models

FORWARD = r"""
SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';

ALTER TABLE public.billing_creditnote DROP CONSTRAINT billing_creditnote_number_valid;
ALTER TABLE public.billing_creditnote ADD CONSTRAINT billing_creditnote_number_valid
  CHECK (number ~ '^(AV-(?!AV)[A-Z]{2,8}(-(?!AV-)[A-Z]{2,8})?|(?!AV)[A-Z]{2,8}-AV)-[0-9]{4}-[0-9]{5}$') NOT VALID;
ALTER TABLE public.billing_creditnote VALIDATE CONSTRAINT billing_creditnote_number_valid;
CREATE OR REPLACE FUNCTION public.billing_creditnote_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  note uuid := CASE WHEN TG_TABLE_NAME = 'billing_creditnote'
                    THEN (to_jsonb(NEW) ->> 'id')::uuid
                    ELSE (to_jsonb(NEW) ->> 'credit_note_id')::uuid END;
  n public.billing_creditnote%ROWTYPE;
  i public.billing_invoice%ROWTYPE;
  line_count bigint;
  net bigint;
  vat bigint;
  cum_net bigint;
  cum_vat bigint;
  cum_gross bigint;
BEGIN
  SELECT * INTO n FROM public.billing_creditnote WHERE id = note;
  SELECT * INTO i FROM public.billing_invoice WHERE id = n.invoice_id FOR UPDATE;
  SELECT count(*), coalesce(sum(total_excl_vat_minor), 0), coalesce(sum(vat_amount_minor), 0)
    INTO line_count, net, vat FROM public.billing_creditnoteline WHERE credit_note_id = note;
  SELECT coalesce(sum(total_excl_vat_minor), 0),
           coalesce(sum(vat_amount_minor), 0),
           coalesce(sum(total_incl_vat_minor), 0)
      INTO cum_net, cum_vat, cum_gross
      FROM public.billing_creditnote WHERE invoice_id = i.id;
  IF cum_net > i.total_excl_vat_minor OR cum_vat > i.vat_amount_minor
     OR cum_gross > i.total_incl_vat_minor OR EXISTS (
       SELECT 1 FROM public.billing_creditnoteline cnl
       JOIN public.billing_creditnote cn ON cn.id = cnl.credit_note_id
       JOIN public.billing_invoiceline il ON il.id = cnl.invoice_line_id
       WHERE cn.invoice_id = i.id
       GROUP BY il.id, il.total_excl_vat_minor, il.vat_amount_minor
       HAVING sum(cnl.total_excl_vat_minor) > il.total_excl_vat_minor
           OR sum(cnl.vat_amount_minor) > il.vat_amount_minor
     ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_creditnote_complete',
      MESSAGE='Cumulative credit notes cannot exceed invoice or line totals';
  END IF;
  IF n.reason = 'refund' THEN
    IF line_count = 0 OR net <> n.total_excl_vat_minor OR vat <> n.vat_amount_minor
       OR n.total_incl_vat_minor <= 0
       OR i.state NOT IN ('paid', 'issued', 'overdue')
       OR n.total_incl_vat_minor > i.total_incl_vat_minor
       OR n.organisation_id <> i.organisation_id OR n.currency <> i.currency
       OR n.vat_regime <> i.vat_regime
       OR n.vat_mention IS DISTINCT FROM i.vat_mention
       OR n.issuer_legal_name <> i.issuer_legal_name
       OR n.issuer_address <> i.issuer_address
       OR n.issuer_country IS DISTINCT FROM i.issuer_country
       OR n.issuer_siren <> i.issuer_siren
       OR n.issuer_vat_number <> i.issuer_vat_number
       OR n.customer_legal_name <> i.customer_legal_name
       OR n.customer_address_line1 <> i.customer_address_line1
       OR n.customer_address_line2 IS DISTINCT FROM i.customer_address_line2
       OR n.customer_postal_code <> i.customer_postal_code
       OR n.customer_city <> i.customer_city
       OR n.customer_country <> i.customer_country
       OR n.customer_siren IS DISTINCT FROM i.customer_siren
       OR n.customer_vat_number IS DISTINCT FROM i.customer_vat_number
       OR cum_net > i.total_excl_vat_minor
       OR cum_vat > i.vat_amount_minor
       OR cum_gross > i.total_incl_vat_minor
       OR EXISTS (
         SELECT 1
         FROM public.billing_creditnoteline cnl
         JOIN public.billing_creditnote cn ON cn.id = cnl.credit_note_id
         JOIN public.billing_invoiceline il ON il.id = cnl.invoice_line_id
         WHERE cn.invoice_id = i.id
         GROUP BY il.id, il.total_excl_vat_minor, il.vat_amount_minor
         HAVING sum(cnl.total_excl_vat_minor) > il.total_excl_vat_minor
             OR sum(cnl.vat_amount_minor) > il.vat_amount_minor
       ) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_creditnote_complete',
        MESSAGE='A refund credit note must match its invoice snapshot and never exceed its totals';
    END IF;
  ELSE
    IF line_count = 0 OR net <> n.total_excl_vat_minor OR vat <> n.vat_amount_minor
       OR n.organisation_id <> i.organisation_id OR n.currency <> i.currency
       OR cum_net <> i.total_excl_vat_minor
       OR cum_vat <> i.vat_amount_minor
       OR cum_gross <> i.total_incl_vat_minor
       OR (n.total_incl_vat_minor = i.total_incl_vat_minor AND EXISTS (
         SELECT 1 FROM public.billing_creditnote c2 WHERE c2.invoice_id = i.id AND c2.id <> n.id
       ))
       OR (n.total_incl_vat_minor < i.total_incl_vat_minor AND (
         n.reason NOT IN ('customer_cancellation', 'unpaid_lapse') OR i.amount_paid_minor <> 0
       ))
       OR i.state <> 'credited' THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_creditnote_complete',
        MESSAGE='A credit note credits its invoice in full, with its lines and their totals';
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.billing_creditnote_complete() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.billing_issue_boost_refund_credit_note(
  p_grant_id uuid,
  p_series text,
  p_delta_net_minor bigint,
  p_delta_vat_minor bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  g public.billing_workspaceboostgrant%ROWTYPE;
  i public.billing_invoice%ROWTYPE;
  il public.billing_invoiceline%ROWTYPE;
  v_av_series text;
  v_issued_at timestamptz;
  v_year integer;
  v_seq integer;
  v_number text;
  v_note_id uuid;
  v_delta_gross bigint;
BEGIN
  IF p_series IS NULL OR p_series !~ '^(AV-(?!AV)[A-Z]{2,8}(-(?!AV$)[A-Z]{2,8})?|(?!AV)[A-Z]{2,8}-AV)$'
     OR p_delta_net_minor IS NULL OR p_delta_net_minor <= 0
     OR p_delta_vat_minor IS NULL OR p_delta_vat_minor < 0 THEN
    RAISE EXCEPTION 'boost refund credit note parameters invalid' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO g FROM public.billing_workspaceboostgrant WHERE id = p_grant_id FOR UPDATE;
  IF NOT FOUND OR g.invoice_id IS NULL THEN
    RAISE EXCEPTION 'boost grant has no issued invoice to credit' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO i FROM public.billing_invoice WHERE id = g.invoice_id FOR UPDATE;
  IF NOT FOUND OR i.state <> 'paid' THEN
    RAISE EXCEPTION 'refund credit note requires a paid invoice' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO il FROM public.billing_invoiceline WHERE invoice_id = i.id ORDER BY position LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'boost invoice line missing' USING ERRCODE = '23514';
  END IF;

  v_av_series := p_series;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing-invoice-series:' || v_av_series, 0));
  v_issued_at := clock_timestamp();
  v_year := extract(year FROM (v_issued_at AT TIME ZONE 'Europe/Paris'))::integer;

  INSERT INTO public.billing_invoicenumbercounter (id, series, year, last_number)
  VALUES (public.retention_new_uuid7(), v_av_series, v_year, 1)
  ON CONFLICT (series, year) DO UPDATE
    SET last_number = public.billing_invoicenumbercounter.last_number + 1
  RETURNING last_number INTO v_seq;

  v_number := v_av_series || '-' || v_year::text || '-' || lpad(v_seq::text, 5, '0');
  v_note_id := public.retention_new_uuid7();
  v_delta_gross := p_delta_net_minor + p_delta_vat_minor;

  INSERT INTO public.billing_creditnote (
    id, created_at, updated_at, organisation_id, invoice_id, number, issued_at, reason,
    currency, vat_regime, vat_mention,
    issuer_legal_name, issuer_address, issuer_country, issuer_siren, issuer_vat_number,
    customer_legal_name, customer_address_line1, customer_address_line2,
    customer_postal_code, customer_city, customer_country, customer_siren, customer_vat_number,
    total_excl_vat_minor, vat_amount_minor, total_incl_vat_minor
  ) VALUES (
    v_note_id, v_issued_at, v_issued_at, i.organisation_id, i.id, v_number, v_issued_at, 'refund',
    i.currency, i.vat_regime, i.vat_mention,
    i.issuer_legal_name, i.issuer_address, i.issuer_country, i.issuer_siren, i.issuer_vat_number,
    i.customer_legal_name, i.customer_address_line1, i.customer_address_line2,
    i.customer_postal_code, i.customer_city, i.customer_country, i.customer_siren, i.customer_vat_number,
    p_delta_net_minor, p_delta_vat_minor, v_delta_gross
  );

  INSERT INTO public.billing_creditnoteline (
    id, credit_note_id, invoice_line_id, position, description,
    quantity, unit_amount_minor, total_excl_vat_minor, vat_rate_bp, vat_amount_minor,
    period_start, period_end
  ) VALUES (
    public.retention_new_uuid7(), v_note_id, il.id, 1, 'Avoir remboursement — ' || il.description,
    1, p_delta_net_minor, p_delta_net_minor, il.vat_rate_bp, p_delta_vat_minor,
    il.period_start, il.period_end
  );

  UPDATE public.billing_invoice
  SET amount_paid_minor = GREATEST(0, amount_paid_minor - v_delta_gross),
      updated_at = clock_timestamp()
  WHERE id = i.id;

  INSERT INTO public.audit_auditevent (
    id, occurred_at, actor_type, actor_id, actor_label, organisation_id, action, target_urn, retention_class, metadata
  ) VALUES (
    public.retention_new_uuid7(), clock_timestamp(), 'system', NULL, 'system', i.organisation_id,
    'credit_note.issued', 'urn:kodera:credit_note:' || v_note_id::text, 'standard',
    jsonb_build_object(
      'number', v_number,
      'invoice_id', i.id::text,
      'invoice_number', i.number,
      'total_incl_vat_minor', v_delta_gross,
      'reason', 'refund'
    )
  );

  RETURN v_note_id;
END
$$;
REVOKE ALL ON FUNCTION public.billing_issue_boost_refund_credit_note(uuid, text, bigint, bigint) FROM PUBLIC;


CREATE FUNCTION public.billing_issue_invoice_refund_credit_note(
  p_payment_id uuid, p_series text, p_cumulative_refunded bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $$
DECLARE
  p public.billing_payment%ROWTYPE;
  i public.billing_invoice%ROWTYPE;
  il public.billing_invoiceline%ROWTYPE;
  v_ref text;
  v_note uuid;
  v_prefix text;
  v_previous bigint;
  v_delta bigint;
  v_remaining bigint;
  v_uncredited bigint;
  v_line_net bigint;
  v_line_vat bigint;
  v_line_gross bigint;
  v_gross bigint;
  v_net bigint;
  v_vat bigint;
  v_total_net bigint := 0;
  v_total_vat bigint := 0;
  v_lines jsonb := '[]'::jsonb;
  v_issued timestamptz;
  v_year integer;
  v_seq integer;
  v_number text;
BEGIN
  IF p_payment_id IS NULL OR p_series IS NULL
     OR p_series !~ '^(AV-(?!AV)[A-Z]{2,8}(-(?!AV$)[A-Z]{2,8})?|(?!AV)[A-Z]{2,8}-AV)$'
     OR p_cumulative_refunded IS NULL OR p_cumulative_refunded <= 0 THEN
    RAISE EXCEPTION 'invoice refund parameters invalid' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO p FROM public.billing_payment WHERE id = p_payment_id;
  IF NOT FOUND OR p.provider <> 'stripe' THEN
    RAISE EXCEPTION 'Stripe invoice payment required' USING ERRCODE = '23514';
  END IF;
  -- Preserve reconciliation's Invoice -> Payment row-lock order.
  SELECT * INTO i FROM public.billing_invoice WHERE id = p.invoice_id FOR UPDATE;
  SELECT * INTO p FROM public.billing_payment WHERE id = p_payment_id FOR UPDATE;
  v_prefix := 'stripe:refund:' || p.provider_ref || ':';
  v_ref := v_prefix || p_cumulative_refunded::text;
  SELECT id INTO v_note FROM public.billing_creditnote WHERE external_ref = v_ref AND reason = 'refund';
  IF FOUND THEN RETURN v_note; END IF;
  IF i.state NOT IN ('paid', 'issued', 'overdue')
     OR p.organisation_id <> i.organisation_id OR p.currency <> i.currency
     OR p_cumulative_refunded > p.amount_minor
     OR NOT EXISTS (
       SELECT 1 FROM public.billing_providerevent e
       WHERE e.provider = p.provider AND e.payment_ref = p.provider_ref
         AND e.kind = 'payment.reversed' AND e.outcome = 'applied'
         AND e.amount_minor = p_cumulative_refunded AND e.currency = p.currency
     ) THEN
    RAISE EXCEPTION 'applied invoice refund required' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max(e.amount_minor), 0) INTO v_previous
  FROM public.billing_providerevent e
  WHERE e.provider = p.provider AND e.payment_ref = p.provider_ref
    AND e.kind = 'payment.reversed' AND e.outcome = 'applied'
    AND e.amount_minor < p_cumulative_refunded;
  v_delta := p_cumulative_refunded - v_previous;
  SELECT i.total_incl_vat_minor - coalesce(sum(total_incl_vat_minor), 0) INTO v_uncredited
  FROM public.billing_creditnote WHERE invoice_id = i.id;
  IF v_delta <= 0 THEN RETURN NULL; END IF;
  IF v_delta > v_uncredited THEN
    INSERT INTO public.audit_auditevent (
      id, occurred_at, actor_type, actor_id, actor_label, organisation_id,
      action, target_urn, retention_class, metadata
    ) VALUES (
      public.retention_new_uuid7(), clock_timestamp(), 'system', NULL, 'system', i.organisation_id,
      'payment.reconciliation_mismatch', 'urn:kodera:payment:' || p.id::text, 'standard',
      jsonb_build_object('reason', 'credit_note_ceiling_reached', 'invoice_id', i.id::text,
                        'amount_refunded_minor', p_cumulative_refunded,
                        'delta_refunded_minor', v_delta, 'uncredited_minor', v_uncredited)
    );
    RETURN NULL;
  END IF;
  v_remaining := v_delta;
  -- Allocate against remaining frozen line capacities. Cumulative inclusive-tax rounding
  -- carries cents across partial refunds and exactly restores every line on a full refund.
  FOR il IN SELECT * FROM public.billing_invoiceline WHERE invoice_id = i.id ORDER BY position LOOP
    SELECT coalesce(sum(l.total_excl_vat_minor), 0), coalesce(sum(l.vat_amount_minor), 0)
    INTO v_line_net, v_line_vat
    FROM public.billing_creditnoteline l
    JOIN public.billing_creditnote n ON n.id = l.credit_note_id
    WHERE n.invoice_id = i.id AND l.invoice_line_id = il.id;
    v_line_gross := il.total_excl_vat_minor + il.vat_amount_minor - v_line_net - v_line_vat;
    IF v_line_gross <= 0 THEN CONTINUE; END IF;
    v_gross := floor(v_remaining::numeric * v_line_gross / v_uncredited)::bigint;
    IF v_gross > 0 THEN
      v_net := round((v_line_net + v_line_vat + v_gross)::numeric * il.total_excl_vat_minor
                     / (il.total_excl_vat_minor + il.vat_amount_minor))::bigint - v_line_net;
      v_vat := v_gross - v_net;
      IF v_net < 0 OR v_vat < 0 THEN
        RAISE EXCEPTION 'refund line allocation invalid' USING ERRCODE = '23514';
      END IF;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'invoice_line_id', il.id, 'position', il.position, 'description', il.description,
        'net', v_net, 'vat', v_vat, 'rate', il.vat_rate_bp,
        'period_start', il.period_start, 'period_end', il.period_end
      ));
      v_total_net := v_total_net + v_net;
      v_total_vat := v_total_vat + v_vat;
    END IF;
    v_remaining := v_remaining - v_gross;
    v_uncredited := v_uncredited - v_line_gross;
  END LOOP;
  IF v_remaining <> 0 OR v_total_net + v_total_vat <> v_delta THEN
    RAISE EXCEPTION 'refund line totals incomplete' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing-invoice-series:' || p_series, 0));
  v_issued := clock_timestamp();
  v_year := extract(year FROM (v_issued AT TIME ZONE 'Europe/Paris'))::integer;
  INSERT INTO public.billing_invoicenumbercounter (id, series, year, last_number)
  VALUES (public.retention_new_uuid7(), p_series, v_year, 1)
  ON CONFLICT (series, year) DO UPDATE
    SET last_number = public.billing_invoicenumbercounter.last_number + 1
  RETURNING last_number INTO v_seq;
  v_number := p_series || '-' || v_year::text || '-' || lpad(v_seq::text, 5, '0');
  v_note := public.retention_new_uuid7();
  INSERT INTO public.billing_creditnote (
    id, created_at, updated_at, organisation_id, invoice_id, number, issued_at, reason, external_ref,
    currency, vat_regime, vat_mention,
    issuer_legal_name, issuer_address, issuer_country, issuer_siren, issuer_vat_number,
    customer_legal_name, customer_address_line1, customer_address_line2,
    customer_postal_code, customer_city, customer_country, customer_siren, customer_vat_number,
    total_excl_vat_minor, vat_amount_minor, total_incl_vat_minor
  ) VALUES (
    v_note, v_issued, v_issued, i.organisation_id, i.id, v_number, v_issued, 'refund', v_ref,
    i.currency, i.vat_regime, i.vat_mention,
    i.issuer_legal_name, i.issuer_address, i.issuer_country, i.issuer_siren, i.issuer_vat_number,
    i.customer_legal_name, i.customer_address_line1, i.customer_address_line2,
    i.customer_postal_code, i.customer_city, i.customer_country, i.customer_siren, i.customer_vat_number,
    v_total_net, v_total_vat, v_delta
  );
  INSERT INTO public.billing_creditnoteline (
    id, credit_note_id, invoice_line_id, position, description, quantity,
    unit_amount_minor, total_excl_vat_minor, vat_rate_bp, vat_amount_minor, period_start, period_end
  ) SELECT public.retention_new_uuid7(), v_note, l.invoice_line_id, l.position, l.description, 1,
           l.net, l.net, l.rate, l.vat, l.period_start, l.period_end
    FROM jsonb_to_recordset(v_lines) AS l(invoice_line_id uuid, position integer, description text,
           net bigint, vat bigint, rate integer, period_start timestamptz, period_end timestamptz);
  INSERT INTO public.audit_auditevent (
    id, occurred_at, actor_type, actor_id, actor_label, organisation_id,
    action, target_urn, retention_class, metadata
  ) VALUES (
    public.retention_new_uuid7(), clock_timestamp(), 'system', NULL, 'system', i.organisation_id,
    'credit_note.issued', 'urn:kodera:credit_note:' || v_note::text, 'standard',
    jsonb_build_object('number', v_number, 'invoice_id', i.id::text, 'invoice_number', i.number,
                      'total_incl_vat_minor', v_delta, 'reason', 'refund')
  );
  -- Debt, payment allocation and subscription state remain reconciliation's authority.
  RETURN v_note;
END $$;
REVOKE ALL ON FUNCTION public.billing_issue_invoice_refund_credit_note(uuid, text, bigint) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kodera_api') THEN
    GRANT EXECUTE ON FUNCTION public.billing_issue_invoice_refund_credit_note(uuid, text, bigint) TO kodera_api;
  END IF;
END $$;
"""

REVERSE = r"""
SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';
DROP FUNCTION public.billing_issue_invoice_refund_credit_note(uuid, text, bigint);
ALTER TABLE public.billing_creditnote DROP CONSTRAINT billing_creditnote_number_valid;
ALTER TABLE public.billing_creditnote ADD CONSTRAINT billing_creditnote_number_valid
  CHECK (number ~ '^AV-[A-Z]{2,8}(-[A-Z]{2,8})?-[0-9]{4}-[0-9]{5}$') NOT VALID;
ALTER TABLE public.billing_creditnote VALIDATE CONSTRAINT billing_creditnote_number_valid;
CREATE OR REPLACE FUNCTION public.billing_creditnote_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  note uuid := CASE WHEN TG_TABLE_NAME = 'billing_creditnote'
                    THEN (to_jsonb(NEW) ->> 'id')::uuid
                    ELSE (to_jsonb(NEW) ->> 'credit_note_id')::uuid END;
  n public.billing_creditnote%ROWTYPE;
  i public.billing_invoice%ROWTYPE;
  line_count bigint;
  net bigint;
  vat bigint;
  cum_net bigint;
  cum_vat bigint;
  cum_gross bigint;
BEGIN
  SELECT * INTO n FROM public.billing_creditnote WHERE id = note;
  SELECT * INTO i FROM public.billing_invoice WHERE id = n.invoice_id;
  SELECT count(*), coalesce(sum(total_excl_vat_minor), 0), coalesce(sum(vat_amount_minor), 0)
    INTO line_count, net, vat FROM public.billing_creditnoteline WHERE credit_note_id = note;
  IF n.reason = 'refund' THEN
    SELECT coalesce(sum(total_excl_vat_minor), 0),
           coalesce(sum(vat_amount_minor), 0),
           coalesce(sum(total_incl_vat_minor), 0)
      INTO cum_net, cum_vat, cum_gross
      FROM public.billing_creditnote WHERE invoice_id = i.id;
    IF line_count = 0 OR net <> n.total_excl_vat_minor OR vat <> n.vat_amount_minor
       OR n.total_incl_vat_minor <= 0
       OR i.state <> 'paid'
       OR n.organisation_id <> i.organisation_id OR n.currency <> i.currency
       OR n.vat_regime <> i.vat_regime
       OR n.vat_mention IS DISTINCT FROM i.vat_mention
       OR n.issuer_legal_name <> i.issuer_legal_name
       OR n.issuer_address <> i.issuer_address
       OR n.issuer_country IS DISTINCT FROM i.issuer_country
       OR n.issuer_siren <> i.issuer_siren
       OR n.issuer_vat_number <> i.issuer_vat_number
       OR n.customer_legal_name <> i.customer_legal_name
       OR n.customer_address_line1 <> i.customer_address_line1
       OR n.customer_address_line2 IS DISTINCT FROM i.customer_address_line2
       OR n.customer_postal_code <> i.customer_postal_code
       OR n.customer_city <> i.customer_city
       OR n.customer_country <> i.customer_country
       OR n.customer_siren IS DISTINCT FROM i.customer_siren
       OR n.customer_vat_number IS DISTINCT FROM i.customer_vat_number
       OR cum_net > i.total_excl_vat_minor
       OR cum_vat > i.vat_amount_minor
       OR cum_gross > i.total_incl_vat_minor
       OR EXISTS (
         SELECT 1
         FROM public.billing_creditnoteline cnl
         JOIN public.billing_creditnote cn ON cn.id = cnl.credit_note_id
         JOIN public.billing_invoiceline il ON il.id = cnl.invoice_line_id
         WHERE cn.invoice_id = i.id
         GROUP BY il.id, il.total_excl_vat_minor, il.vat_amount_minor
         HAVING sum(cnl.total_excl_vat_minor) > il.total_excl_vat_minor
             OR sum(cnl.vat_amount_minor) > il.vat_amount_minor
       ) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_creditnote_complete',
        MESSAGE='A refund credit note must match its paid invoice snapshot and never exceed its totals';
    END IF;
  ELSE
    IF line_count = 0 OR net <> n.total_excl_vat_minor OR vat <> n.vat_amount_minor
       OR n.organisation_id <> i.organisation_id OR n.currency <> i.currency
       OR n.total_excl_vat_minor <> i.total_excl_vat_minor
       OR n.vat_amount_minor <> i.vat_amount_minor
       OR i.state <> 'credited' THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_creditnote_complete',
        MESSAGE='A credit note credits its invoice in full, with its lines and their totals';
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.billing_creditnote_complete() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.billing_issue_boost_refund_credit_note(
  p_grant_id uuid,
  p_series text,
  p_delta_net_minor bigint,
  p_delta_vat_minor bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  g public.billing_workspaceboostgrant%ROWTYPE;
  i public.billing_invoice%ROWTYPE;
  il public.billing_invoiceline%ROWTYPE;
  v_av_series text;
  v_issued_at timestamptz;
  v_year integer;
  v_seq integer;
  v_number text;
  v_note_id uuid;
  v_delta_gross bigint;
BEGIN
  IF p_series IS NULL OR p_series !~ '^[A-Z]{2,8}(-[A-Z]{2,8})?$'
     OR p_delta_net_minor IS NULL OR p_delta_net_minor <= 0
     OR p_delta_vat_minor IS NULL OR p_delta_vat_minor < 0 THEN
    RAISE EXCEPTION 'boost refund credit note parameters invalid' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO g FROM public.billing_workspaceboostgrant WHERE id = p_grant_id FOR UPDATE;
  IF NOT FOUND OR g.invoice_id IS NULL THEN
    RAISE EXCEPTION 'boost grant has no issued invoice to credit' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO i FROM public.billing_invoice WHERE id = g.invoice_id FOR UPDATE;
  IF NOT FOUND OR i.state <> 'paid' THEN
    RAISE EXCEPTION 'refund credit note requires a paid invoice' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO il FROM public.billing_invoiceline WHERE invoice_id = i.id ORDER BY position LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'boost invoice line missing' USING ERRCODE = '23514';
  END IF;

  v_av_series := 'AV-' || p_series;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing-invoice-series:' || v_av_series, 0));
  v_issued_at := clock_timestamp();
  v_year := extract(year FROM (v_issued_at AT TIME ZONE 'Europe/Paris'))::integer;

  INSERT INTO public.billing_invoicenumbercounter (id, series, year, last_number)
  VALUES (public.retention_new_uuid7(), v_av_series, v_year, 1)
  ON CONFLICT (series, year) DO UPDATE
    SET last_number = public.billing_invoicenumbercounter.last_number + 1
  RETURNING last_number INTO v_seq;

  v_number := v_av_series || '-' || v_year::text || '-' || lpad(v_seq::text, 5, '0');
  v_note_id := public.retention_new_uuid7();
  v_delta_gross := p_delta_net_minor + p_delta_vat_minor;

  INSERT INTO public.billing_creditnote (
    id, created_at, updated_at, organisation_id, invoice_id, number, issued_at, reason,
    currency, vat_regime, vat_mention,
    issuer_legal_name, issuer_address, issuer_country, issuer_siren, issuer_vat_number,
    customer_legal_name, customer_address_line1, customer_address_line2,
    customer_postal_code, customer_city, customer_country, customer_siren, customer_vat_number,
    total_excl_vat_minor, vat_amount_minor, total_incl_vat_minor
  ) VALUES (
    v_note_id, v_issued_at, v_issued_at, i.organisation_id, i.id, v_number, v_issued_at, 'refund',
    i.currency, i.vat_regime, i.vat_mention,
    i.issuer_legal_name, i.issuer_address, i.issuer_country, i.issuer_siren, i.issuer_vat_number,
    i.customer_legal_name, i.customer_address_line1, i.customer_address_line2,
    i.customer_postal_code, i.customer_city, i.customer_country, i.customer_siren, i.customer_vat_number,
    p_delta_net_minor, p_delta_vat_minor, v_delta_gross
  );

  INSERT INTO public.billing_creditnoteline (
    id, credit_note_id, invoice_line_id, position, description,
    quantity, unit_amount_minor, total_excl_vat_minor, vat_rate_bp, vat_amount_minor,
    period_start, period_end
  ) VALUES (
    public.retention_new_uuid7(), v_note_id, il.id, 1, 'Avoir remboursement — ' || il.description,
    1, p_delta_net_minor, p_delta_net_minor, il.vat_rate_bp, p_delta_vat_minor,
    il.period_start, il.period_end
  );

  UPDATE public.billing_invoice
  SET amount_paid_minor = GREATEST(0, amount_paid_minor - v_delta_gross),
      updated_at = clock_timestamp()
  WHERE id = i.id;

  INSERT INTO public.audit_auditevent (
    id, occurred_at, actor_type, actor_id, actor_label, organisation_id, action, target_urn, retention_class, metadata
  ) VALUES (
    public.retention_new_uuid7(), clock_timestamp(), 'system', NULL, 'system', i.organisation_id,
    'credit_note.issued', 'urn:kodera:credit_note:' || v_note_id::text, 'standard',
    jsonb_build_object(
      'number', v_number,
      'invoice_id', i.id::text,
      'invoice_number', i.number,
      'total_incl_vat_minor', v_delta_gross,
      'reason', 'refund'
    )
  );

  RETURN v_note_id;
END
$$;
REVOKE ALL ON FUNCTION public.billing_issue_boost_refund_credit_note(uuid, text, bigint, bigint) FROM PUBLIC;
"""

SET_SESSION_TIMEOUTS = "SET lock_timeout = '5s'; SET statement_timeout = '30s';"
RESET_SESSION_TIMEOUTS = "RESET lock_timeout; RESET statement_timeout;"
CREATE_REFUND_EXTERNAL_IN_TX = (
    "CREATE UNIQUE INDEX IF NOT EXISTS billing_creditnote_refund_external_unique "
    "ON public.billing_creditnote (external_ref) "
    "WHERE reason = 'refund' AND external_ref IS NOT NULL;"
)
CREATE_REFUND_EXTERNAL_CONCURRENTLY = (
    "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS billing_creditnote_refund_external_unique "
    "ON public.billing_creditnote (external_ref) "
    "WHERE reason = 'refund' AND external_ref IS NOT NULL;"
)
DROP_REFUND_EXTERNAL_IN_TX = (
    "DROP INDEX IF EXISTS public.billing_creditnote_refund_external_unique;"
)
DROP_REFUND_EXTERNAL_CONCURRENTLY = (
    "DROP INDEX CONCURRENTLY IF EXISTS public.billing_creditnote_refund_external_unique;"
)


def _forwards(apps: Any, schema_editor: Any) -> None:
    del apps
    if schema_editor.connection.in_atomic_block:
        schema_editor.execute(CREATE_REFUND_EXTERNAL_IN_TX, params=None)
        schema_editor.execute(FORWARD, params=None)
        return
    schema_editor.execute(SET_SESSION_TIMEOUTS, params=None)
    schema_editor.execute(CREATE_REFUND_EXTERNAL_CONCURRENTLY, params=None)
    schema_editor.execute("BEGIN;\n" + FORWARD + "\nCOMMIT;", params=None)
    schema_editor.execute(RESET_SESSION_TIMEOUTS, params=None)


def _backwards(apps: Any, schema_editor: Any) -> None:
    del apps
    if schema_editor.connection.in_atomic_block:
        schema_editor.execute(REVERSE, params=None)
        schema_editor.execute(DROP_REFUND_EXTERNAL_IN_TX, params=None)
        return
    schema_editor.execute(SET_SESSION_TIMEOUTS, params=None)
    schema_editor.execute("BEGIN;\n" + REVERSE + "\nCOMMIT;", params=None)
    schema_editor.execute(DROP_REFUND_EXTERNAL_CONCURRENTLY, params=None)
    schema_editor.execute(RESET_SESSION_TIMEOUTS, params=None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [("billing", "0028_sovereign_settlement_grants")]

    operations = [
        # The existing non-refund partial index already has identical NULL semantics.
        # Keep it in place so writes retain uniqueness throughout this expansion.
        migrations.RunPython(_forwards, _backwards),
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.RemoveConstraint("creditnote", "billing_creditnote_number_valid"),
                migrations.AddConstraint(
                    "creditnote",
                    models.CheckConstraint(
                        name="billing_creditnote_number_valid",
                        condition=models.Q(
                            number__regex=r"^(AV-(?!AV)[A-Z]{2,8}(-(?!AV-)[A-Z]{2,8})?|(?!AV)[A-Z]{2,8}-AV)-[0-9]{4}-[0-9]{5}$"
                        ),
                    ),
                ),
                migrations.RemoveConstraint("creditnote", "billing_creditnote_one_per_invoice"),
                migrations.AddConstraint(
                    "creditnote",
                    models.UniqueConstraint(
                        fields=["invoice"],
                        condition=models.Q(invoice__isnull=False) & ~models.Q(reason="refund"),
                        name="billing_creditnote_one_per_invoice",
                    ),
                ),
                migrations.AddConstraint(
                    "creditnote",
                    models.UniqueConstraint(
                        fields=["external_ref"],
                        condition=models.Q(reason="refund", external_ref__isnull=False),
                        name="billing_creditnote_refund_external_unique",
                    ),
                ),
            ],
        ),
    ]
