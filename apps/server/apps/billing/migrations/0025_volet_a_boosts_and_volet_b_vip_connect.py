"""Volet A community workspace boosts/hosting credits and Volet B Stripe Connect VIP entitlements."""

import django.db.models.deletion
import django.db.models.expressions
from django.db import migrations, models

import core.db.ids

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

H31_GUARDS_FORWARD = r"""
REVOKE ALL ON TABLE public.billing_creatorconnectaccount FROM PUBLIC;
REVOKE ALL ON TABLE public.billing_creatorsplitledgerentry FROM PUBLIC;
REVOKE ALL ON TABLE public.billing_dac7sellerstatutorysnapshot FROM PUBLIC;
REVOKE ALL ON TABLE public.billing_vipmembershipentitlement FROM PUBLIC;
REVOKE ALL ON TABLE public.billing_viptieroffer FROM PUBLIC;
REVOKE ALL ON TABLE public.billing_workspaceboostgrant FROM PUBLIC;
REVOKE ALL ON TABLE public.billing_workspacehostingcredit FROM PUBLIC;

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

CREATE FUNCTION public.billing_issue_boost_invoice(
  p_grant_id uuid,
  p_series text,
  p_payment_terms_days integer,
  p_issuer jsonb,
  p_customer jsonb,
  p_description text,
  p_quantity integer,
  p_unit_amount_minor bigint,
  p_period_start timestamptz,
  p_period_end timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  g public.billing_workspaceboostgrant%ROWTYPE;
  v_issued_at timestamptz;
  v_year integer;
  v_seq integer;
  v_number text;
  v_invoice_id uuid;
  v_vat_mention text;
BEGIN
  IF p_series IS NULL OR p_series !~ '^[A-Z]{2,8}(-[A-Z]{2,8})?$'
     OR p_payment_terms_days IS NULL OR p_payment_terms_days < 0 OR p_payment_terms_days > 365
     OR p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 10000
     OR p_unit_amount_minor IS NULL OR p_unit_amount_minor <= 0 THEN
    RAISE EXCEPTION 'boost invoice issuance parameters invalid' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO g FROM public.billing_workspaceboostgrant WHERE id = p_grant_id FOR UPDATE;
  IF NOT FOUND OR g.invoice_id IS NOT NULL OR g.state <> 'pending_payment' THEN
    RAISE EXCEPTION 'boost grant not eligible for invoice issuance' USING ERRCODE = '23514';
  END IF;
  IF p_quantity * p_unit_amount_minor <> g.net_amount_minor THEN
    RAISE EXCEPTION 'boost invoice line net mismatch' USING ERRCODE = '23514';
  END IF;
  IF g.customer_kind = 'b2c'
     AND (
       NOT g.withdrawal_waiver_accepted
       OR g.withdrawal_waiver_at IS NULL
       OR g.withdrawal_waiver_evidence IS NULL
       OR g.withdrawal_waiver_evidence = ''
     ) THEN
    RAISE EXCEPTION 'B2C boost invoice requires Art. L221-28 waiver' USING ERRCODE = '23514';
  END IF;

  v_vat_mention := p_issuer ->> 'vat_mention';

  PERFORM pg_advisory_xact_lock(hashtextextended('billing-invoice-series:' || p_series, 0));
  v_issued_at := clock_timestamp();
  v_year := extract(year FROM (v_issued_at AT TIME ZONE 'Europe/Paris'))::integer;

  INSERT INTO public.billing_invoicenumbercounter (id, series, year, last_number)
  VALUES (public.retention_new_uuid7(), p_series, v_year, 1)
  ON CONFLICT (series, year) DO UPDATE
    SET last_number = public.billing_invoicenumbercounter.last_number + 1
  RETURNING last_number INTO v_seq;

  v_number := p_series || '-' || v_year::text || '-' || lpad(v_seq::text, 5, '0');
  v_invoice_id := public.retention_new_uuid7();

  INSERT INTO public.billing_invoice (
    id, created_at, updated_at, organisation_id, subscription_id, order_id,
    number, state, currency, vat_regime, vat_mention,
    issuer_legal_name, issuer_address, issuer_country, issuer_siren, issuer_vat_number,
    customer_legal_name, customer_address_line1, customer_address_line2,
    customer_postal_code, customer_city, customer_country, customer_siren, customer_vat_number,
    total_excl_vat_minor, vat_amount_minor, total_incl_vat_minor, amount_paid_minor
  ) VALUES (
    v_invoice_id, v_issued_at, v_issued_at, g.organisation_id, NULL, NULL,
    NULL, 'draft', g.currency, g.vat_regime, v_vat_mention,
    p_issuer ->> 'legal_name', p_issuer ->> 'address', p_issuer ->> 'country',
    p_issuer ->> 'siren', p_issuer ->> 'vat_number',
    p_customer ->> 'legal_name', p_customer ->> 'address_line1', p_customer ->> 'address_line2',
    p_customer ->> 'postal_code', p_customer ->> 'city', g.customer_country,
    p_customer ->> 'siren', p_customer ->> 'vat_number',
    g.net_amount_minor, g.vat_amount_minor, g.gross_amount_minor, 0
  );

  INSERT INTO public.billing_invoiceline (
    id, invoice_id, position, description, plan_code, plan_version, pack_code, capacity_tier_code,
    quantity, unit_amount_minor, total_excl_vat_minor, vat_rate_bp, vat_amount_minor,
    period_start, period_end
  ) VALUES (
    public.retention_new_uuid7(), v_invoice_id, 1, p_description, 'community-boost', 1, g.pack_code, 'S',
    p_quantity, p_unit_amount_minor, g.net_amount_minor, g.vat_rate_bp, g.vat_amount_minor,
    p_period_start, p_period_end
  );

  UPDATE public.billing_invoice
  SET number = v_number,
      state = 'issued',
      issued_at = v_issued_at,
      due_at = v_issued_at + make_interval(days => p_payment_terms_days),
      updated_at = clock_timestamp()
  WHERE id = v_invoice_id;

  INSERT INTO public.retention_worker_context
  VALUES (pg_backend_pid(), txid_current(), 'h31_invoice_bind', 'billing_workspaceboostgrant', g.id, '{}'::jsonb);

  UPDATE public.billing_workspaceboostgrant
  SET invoice_id = v_invoice_id,
      updated_at = clock_timestamp()
  WHERE id = g.id;

  DELETE FROM public.retention_worker_context
  WHERE backend = pg_backend_pid()
    AND transaction = txid_current()
    AND purpose = 'h31_invoice_bind'
    AND source_table = 'billing_workspaceboostgrant'
    AND source_id = g.id;

  INSERT INTO public.audit_auditevent (
    id, occurred_at, actor_type, actor_id, actor_label, organisation_id, action, target_urn, retention_class, metadata
  ) VALUES (
    public.retention_new_uuid7(), clock_timestamp(), 'system', NULL, 'system', g.organisation_id,
    'invoice.issued', 'urn:kodera:invoice:' || v_invoice_id::text, 'standard',
    jsonb_build_object('number', v_number, 'total_incl_vat_minor', g.gross_amount_minor)
  );

  RETURN v_invoice_id;
END
$$;
REVOKE ALL ON FUNCTION public.billing_issue_boost_invoice(uuid, text, integer, jsonb, jsonb, text, integer, bigint, timestamptz, timestamptz) FROM PUBLIC;

CREATE FUNCTION public.billing_issue_boost_refund_credit_note(
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

CREATE FUNCTION public.billing_h31_resource_binding_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  in_erasure boolean := FALSE;
BEGIN
  IF TG_TABLE_NAME = 'billing_creatorsplitledgerentry' THEN
    RAISE EXCEPTION 'creator split ledger entry immutable' USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'billing_dac7sellerstatutorysnapshot' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.purge_after < clock_timestamp()
         AND public.retention_context('purge', TG_TABLE_NAME, OLD.id) IS NOT NULL THEN
        RETURN OLD;
      END IF;
    END IF;
    RAISE EXCEPTION 'dac7 statutory snapshot immutable or not due' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
      RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE = '23514';
    END IF;

    in_erasure := public.privacy_erasure_context(NEW.organisation_id)
      OR EXISTS (
        SELECT 1 FROM public.retention_worker_context rwc
        WHERE rwc.backend = pg_backend_pid()
          AND rwc.transaction = txid_current()
          AND rwc.purpose = 'account'
          AND rwc.source_table = 'identity_user'
      );

    IF TG_TABLE_NAME = 'billing_workspaceboostgrant' THEN
      IF (
        NEW.pack_code, NEW.customer_kind, NEW.customer_country, NEW.currency,
        NEW.vat_regime, NEW.vat_rate_bp, NEW.net_amount_minor, NEW.vat_amount_minor,
        NEW.gross_amount_minor, NEW.credit_amount_minor, NEW.seats_delta,
        NEW.storage_bytes_delta, NEW.idempotency_key, NEW.request_sha256,
        NEW.withdrawal_waiver_accepted, NEW.withdrawal_waiver_at
      ) IS DISTINCT FROM (
        OLD.pack_code, OLD.customer_kind, OLD.customer_country, OLD.currency,
        OLD.vat_regime, OLD.vat_rate_bp, OLD.net_amount_minor, OLD.vat_amount_minor,
        OLD.gross_amount_minor, OLD.credit_amount_minor, OLD.seats_delta,
        OLD.storage_bytes_delta, OLD.idempotency_key, OLD.request_sha256,
        OLD.withdrawal_waiver_accepted, OLD.withdrawal_waiver_at
      ) THEN
        RAISE EXCEPTION 'boost commercial snapshot immutable' USING ERRCODE = '23514';
      END IF;
      IF NOT in_erasure AND (
        NEW.purchaser_user_id IS DISTINCT FROM OLD.purchaser_user_id
        OR NEW.withdrawal_waiver_evidence IS DISTINCT FROM OLD.withdrawal_waiver_evidence
        OR NEW.pii_scrubbed_at IS DISTINCT FROM OLD.pii_scrubbed_at
      ) THEN
        RAISE EXCEPTION 'boost identity and waiver evidence immutable' USING ERRCODE = '23514';
      END IF;
      IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
        IF OLD.invoice_id IS NOT NULL
           OR public.retention_context('h31_invoice_bind', 'billing_workspaceboostgrant', NEW.id) IS NULL THEN
          RAISE EXCEPTION 'boost invoice binding immutable' USING ERRCODE = '23514';
        END IF;
      END IF;
      IF OLD.stripe_payment_intent_id IS NOT NULL
         AND NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id THEN
        RAISE EXCEPTION 'boost payment intent immutable' USING ERRCODE = '23514';
      END IF;

    ELSIF TG_TABLE_NAME = 'billing_workspacehostingcredit' THEN
      IF NEW.boost_grant_id IS DISTINCT FROM OLD.boost_grant_id
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.granted_minor IS DISTINCT FROM OLD.granted_minor THEN
        RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE = '23514';
      END IF;

    ELSIF TG_TABLE_NAME = 'billing_viptieroffer' THEN
      IF NEW.connect_account_id IS DISTINCT FROM OLD.connect_account_id
         OR NEW.code IS DISTINCT FROM OLD.code
         OR NEW.billing_period IS DISTINCT FROM OLD.billing_period
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.price_excl_vat_minor IS DISTINCT FROM OLD.price_excl_vat_minor
         OR NEW.granted_workspace_role_id IS DISTINCT FROM OLD.granted_workspace_role_id THEN
        RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE = '23514';
      END IF;

    ELSIF TG_TABLE_NAME = 'billing_vipmembershipentitlement' THEN
      IF NEW.membership_id IS DISTINCT FROM OLD.membership_id
         OR NEW.tier_id IS DISTINCT FROM OLD.tier_id THEN
        RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE = '23514';
      END IF;
      IF (
        NEW.customer_kind, NEW.buyer_country, NEW.currency, NEW.vat_regime,
        NEW.vat_rate_bp, NEW.gross_excl_vat_minor, NEW.vat_amount_minor,
        NEW.total_incl_vat_minor, NEW.application_fee_amount_minor,
        NEW.reserved_recovery_minor, NEW.idempotency_key, NEW.request_sha256,
        NEW.withdrawal_waiver_accepted, NEW.withdrawal_waiver_at
      ) IS DISTINCT FROM (
        OLD.customer_kind, OLD.buyer_country, OLD.currency, OLD.vat_regime,
        OLD.vat_rate_bp, OLD.gross_excl_vat_minor, OLD.vat_amount_minor,
        OLD.total_incl_vat_minor, OLD.application_fee_amount_minor,
        OLD.reserved_recovery_minor, OLD.idempotency_key, OLD.request_sha256,
        OLD.withdrawal_waiver_accepted, OLD.withdrawal_waiver_at
      ) THEN
        RAISE EXCEPTION 'vip entitlement commercial snapshot immutable' USING ERRCODE = '23514';
      END IF;
      IF NOT in_erasure AND (
        NEW.buyer_user_id IS DISTINCT FROM OLD.buyer_user_id
        OR NEW.withdrawal_waiver_evidence IS DISTINCT FROM OLD.withdrawal_waiver_evidence
        OR NEW.pii_scrubbed_at IS DISTINCT FROM OLD.pii_scrubbed_at
      ) THEN
        RAISE EXCEPTION 'vip entitlement identity and waiver evidence immutable' USING ERRCODE = '23514';
      END IF;
      IF OLD.stripe_payment_intent_id IS NOT NULL
         AND NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id THEN
        RAISE EXCEPTION 'vip entitlement payment intent immutable' USING ERRCODE = '23514';
      END IF;

    ELSIF TG_TABLE_NAME = 'billing_creatorconnectaccount' THEN
      IF NEW.platform_fee_bps IS DISTINCT FROM OLD.platform_fee_bps THEN
        RAISE EXCEPTION 'connect platform fee bps immutable' USING ERRCODE = '23514';
      END IF;
      IF OLD.stripe_connect_account_id IS NOT NULL
         AND NEW.stripe_connect_account_id IS DISTINCT FROM OLD.stripe_connect_account_id THEN
        RAISE EXCEPTION 'persisted stripe_connect_account_id immutable' USING ERRCODE = '23514';
      END IF;
      IF NOT in_erasure AND (
        NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
        OR NEW.pii_scrubbed_at IS DISTINCT FROM OLD.pii_scrubbed_at
      ) THEN
        RAISE EXCEPTION 'connect account owner binding immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.billing_h31_resource_binding_guard() FROM PUBLIC;

CREATE FUNCTION public.billing_h31_privacy_cutoff_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user_id uuid := NULL;
  v_old_user_id uuid := NULL;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'billing_workspaceboostgrant' THEN
      IF OLD.state IN ('active', 'expired', 'refunded', 'disputed')
         OR OLD.invoice_id IS NOT NULL
         OR OLD.stripe_payment_intent_id IS NOT NULL THEN
        RAISE EXCEPTION 'accounting boost grant retained' USING ERRCODE = '23514';
      END IF;
    ELSIF TG_TABLE_NAME = 'billing_vipmembershipentitlement' THEN
      IF OLD.state IN ('active', 'expired', 'refunded', 'disputed')
         OR OLD.stripe_payment_intent_id IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM public.billing_creatorsplitledgerentry le
           WHERE le.entitlement_id = OLD.id
         ) THEN
        RAISE EXCEPTION 'accounting vip entitlement retained' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'accounting billing record retained' USING ERRCODE = '23514';
    END IF;
    IF public.privacy_erasure_context(OLD.organisation_id)
       OR EXISTS (
         SELECT 1 FROM public.retention_worker_context rwc
         WHERE rwc.backend = pg_backend_pid()
           AND rwc.transaction = txid_current()
           AND rwc.purpose = 'account'
           AND rwc.source_table = 'identity_user'
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'billing record deletion requires privacy erasure context'
      USING ERRCODE = '23514';
  END IF;

  IF public.privacy_erasure_context(NEW.organisation_id) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (
         SELECT 1 FROM public.retention_worker_context rwc
         WHERE rwc.backend = pg_backend_pid()
           AND rwc.transaction = txid_current()
           AND rwc.purpose = 'account'
           AND rwc.source_table = 'identity_user'
       )
       AND (
         (TG_TABLE_NAME = 'billing_workspaceboostgrant'
          AND (to_jsonb(NEW) - ARRAY['purchaser_user_id', 'withdrawal_waiver_evidence', 'pii_scrubbed_at'])
              IS NOT DISTINCT FROM
              (to_jsonb(OLD) - ARRAY['purchaser_user_id', 'withdrawal_waiver_evidence', 'pii_scrubbed_at']))
         OR (TG_TABLE_NAME = 'billing_vipmembershipentitlement'
             AND (to_jsonb(NEW) - ARRAY['buyer_user_id', 'withdrawal_waiver_evidence', 'pii_scrubbed_at'])
                 IS NOT DISTINCT FROM
                 (to_jsonb(OLD) - ARRAY['buyer_user_id', 'withdrawal_waiver_evidence', 'pii_scrubbed_at']))
         OR (TG_TABLE_NAME = 'billing_creatorconnectaccount'
             AND (to_jsonb(NEW) - ARRAY['owner_user_id', 'seller_legal_name', 'sealed_tax_tin', 'onboarding_state', 'charges_enabled', 'payouts_enabled', 'pii_scrubbed_at'])
                 IS NOT DISTINCT FROM
                 (to_jsonb(OLD) - ARRAY['owner_user_id', 'seller_legal_name', 'sealed_tax_tin', 'onboarding_state', 'charges_enabled', 'payouts_enabled', 'pii_scrubbed_at']))
       ) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'billing_workspaceboostgrant' THEN
    v_user_id := NEW.purchaser_user_id;
    IF TG_OP = 'UPDATE' THEN v_old_user_id := OLD.purchaser_user_id; END IF;
  ELSIF TG_TABLE_NAME = 'billing_vipmembershipentitlement' THEN
    v_user_id := NEW.buyer_user_id;
    IF TG_OP = 'UPDATE' THEN v_old_user_id := OLD.buyer_user_id; END IF;
  ELSIF TG_TABLE_NAME = 'billing_creatorconnectaccount' THEN
    v_user_id := NEW.owner_user_id;
    IF TG_OP = 'UPDATE' THEN v_old_user_id := OLD.owner_user_id; END IF;
  END IF;

  IF v_user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR v_user_id IS DISTINCT FROM v_old_user_id)
     AND NOT public.privacy_account_context(v_user_id) THEN
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('privacy_account_cutoff:' || v_user_id::text, 0)
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.identity_user u
      WHERE u.id = v_user_id AND u.enabled AND u.deleted_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM public.orgs_accounterasure ae
      WHERE ae.user_reference = v_user_id
    ) THEN
      RAISE EXCEPTION 'community monetization account cutoff active'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('privacy_erasure_cutoff:' || NEW.organisation_id::text, 0)
  );
  IF EXISTS (
    SELECT 1 FROM public.orgs_privacyerasure pe
    WHERE pe.organisation_reference = NEW.organisation_id
  ) OR EXISTS (
    SELECT 1 FROM public.orgs_organisation o
    WHERE o.id = NEW.organisation_id AND (o.state = 'closed' OR o.deleted_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'community monetization organisation cutoff active'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.billing_h31_privacy_cutoff_guard() FROM PUBLIC;

CREATE FUNCTION public.billing_h31_erasure_journal_hook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  org uuid;
  person uuid;
  boost_deleted bigint := 0;
  boost_scrubbed bigint := 0;
  vip_deleted bigint := 0;
  vip_scrubbed bigint := 0;
  connect_scrubbed bigint := 0;
BEGIN
  IF TG_TABLE_NAME = 'orgs_privacyerasure' THEN
    org := NEW.organisation_reference;
    IF TG_OP = 'INSERT' THEN
      NEW.inventory := NEW.inventory || jsonb_build_object(
        'h31_billing_policy', 'retained_accounting_and_dac7_statutory_snapshot'
      );
      NEW.inventory_sha256 := public.retention_inventory_digest(NEW.inventory);
      RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
      IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
        DELETE FROM public.billing_workspaceboostgrant
        WHERE organisation_id = org
          AND state IN ('pending_payment', 'cancelled')
          AND invoice_id IS NULL
          AND stripe_payment_intent_id IS NULL;
        GET DIAGNOSTICS boost_deleted = ROW_COUNT;

        UPDATE public.billing_workspaceboostgrant
        SET purchaser_user_id = NULL,
            withdrawal_waiver_evidence = CASE
              WHEN withdrawal_waiver_evidence IS NULL THEN NULL
              ELSE 'erased'
            END,
            pii_scrubbed_at = COALESCE(pii_scrubbed_at, clock_timestamp())
        WHERE organisation_id = org;
        GET DIAGNOSTICS boost_scrubbed = ROW_COUNT;

        DELETE FROM public.billing_vipmembershipentitlement v
        WHERE v.organisation_id = org
          AND v.state IN ('pending_payment', 'cancelled')
          AND v.stripe_payment_intent_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.billing_creatorsplitledgerentry le
            WHERE le.entitlement_id = v.id
          );
        GET DIAGNOSTICS vip_deleted = ROW_COUNT;

        UPDATE public.billing_vipmembershipentitlement
        SET buyer_user_id = NULL,
            withdrawal_waiver_evidence = CASE
              WHEN withdrawal_waiver_evidence IS NULL THEN NULL
              ELSE 'erased'
            END,
            pii_scrubbed_at = COALESCE(pii_scrubbed_at, clock_timestamp())
        WHERE organisation_id = org;
        GET DIAGNOSTICS vip_scrubbed = ROW_COUNT;

        UPDATE public.billing_viptieroffer
        SET name = 'erased-' || id::text,
            description = NULL,
            active = FALSE
        WHERE organisation_id = org;

        -- GDPR Art. 17(3)(b) & CGI art. 1649 ter A: snapshot settled creator tax identity
        -- into isolated statutory table before scrubbing operational CreatorConnectAccount.
        INSERT INTO public.billing_dac7sellerstatutorysnapshot (
          id, created_at, updated_at, connect_account_id, organisation_reference, workspace_reference,
          stripe_connect_account_id, seller_legal_name, tax_residence_country, sealed_tax_tin,
          retained_at, purge_after
        )
        SELECT
          public.retention_new_uuid7(), clock_timestamp(), clock_timestamp(),
          ca.id, ca.organisation_id, ca.workspace_id,
          ca.stripe_connect_account_id, ca.seller_legal_name, ca.tax_residence_country, ca.sealed_tax_tin,
          clock_timestamp(), clock_timestamp() + interval '10 years'
        FROM public.billing_creatorconnectaccount ca
        WHERE ca.organisation_id = org
          AND ca.pii_scrubbed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM public.billing_creatorsplitledgerentry le
            WHERE le.connect_account_id = ca.id
          )
        ON CONFLICT (connect_account_id) DO NOTHING;

        UPDATE public.billing_creatorconnectaccount
        SET owner_user_id = NULL,
            seller_legal_name = 'Erased creator (' || id::text || ')',
            sealed_tax_tin = NULL,
            onboarding_state = CASE
              WHEN onboarding_state = 'active' THEN 'disabled'
              ELSE onboarding_state
            END,
            charges_enabled = FALSE,
            payouts_enabled = FALSE,
            pii_scrubbed_at = COALESCE(pii_scrubbed_at, clock_timestamp())
        WHERE organisation_id = org;
        GET DIAGNOSTICS connect_scrubbed = ROW_COUNT;

        NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
          'h31_ephemeral_boosts_deleted', boost_deleted,
          'h31_retained_boosts_scrubbed', boost_scrubbed,
          'h31_ephemeral_vip_deleted', vip_deleted,
          'h31_retained_vip_scrubbed', vip_scrubbed,
          'h31_connect_accounts_scrubbed', connect_scrubbed
        );
      END IF;

      IF OLD.status <> 'complete' AND NEW.status = 'complete' THEN
        IF EXISTS (
          SELECT 1 FROM public.billing_workspaceboostgrant
          WHERE organisation_id = org
            AND (purchaser_user_id IS NOT NULL OR pii_scrubbed_at IS NULL)
        ) OR EXISTS (
          SELECT 1 FROM public.billing_vipmembershipentitlement
          WHERE organisation_id = org
            AND (buyer_user_id IS NOT NULL OR pii_scrubbed_at IS NULL)
        ) OR EXISTS (
          SELECT 1 FROM public.billing_creatorconnectaccount
          WHERE organisation_id = org
            AND (
              owner_user_id IS NOT NULL
              OR sealed_tax_tin IS NOT NULL
              OR pii_scrubbed_at IS NULL
            )
        ) THEN
          RAISE EXCEPTION 'h31 billing personal data still present' USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END IF;

  ELSIF TG_TABLE_NAME = 'orgs_accounterasure' THEN
    person := NEW.user_reference;
    IF TG_OP = 'INSERT' THEN
      NEW.inventory := NEW.inventory || jsonb_build_object(
        'h31_billing_policy', 'retained_accounting_and_dac7_statutory_snapshot'
      );
      NEW.inventory_sha256 := public.retention_inventory_digest(NEW.inventory);
      RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
      IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
        DELETE FROM public.billing_workspaceboostgrant
        WHERE purchaser_user_id = person
          AND state IN ('pending_payment', 'cancelled')
          AND invoice_id IS NULL
          AND stripe_payment_intent_id IS NULL;

        UPDATE public.billing_workspaceboostgrant
        SET purchaser_user_id = NULL,
            withdrawal_waiver_evidence = CASE
              WHEN withdrawal_waiver_evidence IS NULL THEN NULL
              ELSE 'erased'
            END,
            pii_scrubbed_at = COALESCE(pii_scrubbed_at, clock_timestamp())
        WHERE purchaser_user_id = person;

        DELETE FROM public.billing_vipmembershipentitlement v
        WHERE v.buyer_user_id = person
          AND v.state IN ('pending_payment', 'cancelled')
          AND v.stripe_payment_intent_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.billing_creatorsplitledgerentry le
            WHERE le.entitlement_id = v.id
          );

        UPDATE public.billing_vipmembershipentitlement
        SET buyer_user_id = NULL,
            withdrawal_waiver_evidence = CASE
              WHEN withdrawal_waiver_evidence IS NULL THEN NULL
              ELSE 'erased'
            END,
            pii_scrubbed_at = COALESCE(pii_scrubbed_at, clock_timestamp())
        WHERE buyer_user_id = person;

        INSERT INTO public.billing_dac7sellerstatutorysnapshot (
          id, created_at, updated_at, connect_account_id, organisation_reference, workspace_reference,
          stripe_connect_account_id, seller_legal_name, tax_residence_country, sealed_tax_tin,
          retained_at, purge_after
        )
        SELECT
          public.retention_new_uuid7(), clock_timestamp(), clock_timestamp(),
          ca.id, ca.organisation_id, ca.workspace_id,
          ca.stripe_connect_account_id, ca.seller_legal_name, ca.tax_residence_country, ca.sealed_tax_tin,
          clock_timestamp(), clock_timestamp() + interval '10 years'
        FROM public.billing_creatorconnectaccount ca
        WHERE ca.owner_user_id = person
          AND ca.pii_scrubbed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM public.billing_creatorsplitledgerentry le
            WHERE le.connect_account_id = ca.id
          )
        ON CONFLICT (connect_account_id) DO NOTHING;

        UPDATE public.billing_creatorconnectaccount
        SET owner_user_id = NULL,
            seller_legal_name = 'Erased creator (' || id::text || ')',
            sealed_tax_tin = NULL,
            onboarding_state = CASE
              WHEN onboarding_state = 'active' THEN 'disabled'
              ELSE onboarding_state
            END,
            charges_enabled = FALSE,
            payouts_enabled = FALSE,
            pii_scrubbed_at = COALESCE(pii_scrubbed_at, clock_timestamp())
        WHERE owner_user_id = person;
      END IF;

      IF OLD.status <> 'complete' AND NEW.status = 'complete' THEN
        IF EXISTS (
          SELECT 1 FROM public.billing_workspaceboostgrant WHERE purchaser_user_id = person
        ) OR EXISTS (
          SELECT 1 FROM public.billing_vipmembershipentitlement WHERE buyer_user_id = person
        ) OR EXISTS (
          SELECT 1 FROM public.billing_creatorconnectaccount WHERE owner_user_id = person
        ) THEN
          RAISE EXCEPTION 'h31 billing account personal data still present'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.billing_h31_erasure_journal_hook() FROM PUBLIC;

CREATE TRIGGER a_resource_binding
  BEFORE UPDATE OR DELETE ON public.billing_creatorsplitledgerentry
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_resource_binding_guard();
CREATE TRIGGER a_resource_binding
  BEFORE UPDATE OR DELETE ON public.billing_dac7sellerstatutorysnapshot
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_resource_binding_guard();
CREATE TRIGGER a_resource_binding
  BEFORE UPDATE ON public.billing_workspaceboostgrant
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_resource_binding_guard();
CREATE TRIGGER a_resource_binding
  BEFORE UPDATE ON public.billing_workspacehostingcredit
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_resource_binding_guard();
CREATE TRIGGER a_resource_binding
  BEFORE UPDATE ON public.billing_creatorconnectaccount
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_resource_binding_guard();
CREATE TRIGGER a_resource_binding
  BEFORE UPDATE ON public.billing_viptieroffer
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_resource_binding_guard();
CREATE TRIGGER a_resource_binding
  BEFORE UPDATE ON public.billing_vipmembershipentitlement
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_resource_binding_guard();

CREATE TRIGGER aa_h31_billing_privacy_cutoff
  BEFORE INSERT OR UPDATE OR DELETE ON public.billing_workspaceboostgrant
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_privacy_cutoff_guard();
CREATE TRIGGER aa_h31_billing_privacy_cutoff
  BEFORE INSERT OR UPDATE OR DELETE ON public.billing_workspacehostingcredit
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_privacy_cutoff_guard();
CREATE TRIGGER aa_h31_billing_privacy_cutoff
  BEFORE INSERT OR UPDATE OR DELETE ON public.billing_creatorconnectaccount
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_privacy_cutoff_guard();
CREATE TRIGGER aa_h31_billing_privacy_cutoff
  BEFORE INSERT OR UPDATE OR DELETE ON public.billing_viptieroffer
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_privacy_cutoff_guard();
CREATE TRIGGER aa_h31_billing_privacy_cutoff
  BEFORE INSERT OR UPDATE OR DELETE ON public.billing_vipmembershipentitlement
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_privacy_cutoff_guard();
CREATE TRIGGER aa_h31_billing_privacy_cutoff
  BEFORE INSERT ON public.billing_creatorsplitledgerentry
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_privacy_cutoff_guard();

CREATE TRIGGER aa_03_h31_billing_erasure
  BEFORE INSERT OR UPDATE ON public.orgs_privacyerasure
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_erasure_journal_hook();
CREATE TRIGGER aa_03_h31_billing_erasure
  BEFORE INSERT OR UPDATE ON public.orgs_accounterasure
  FOR EACH ROW EXECUTE FUNCTION public.billing_h31_erasure_journal_hook();
"""

H31_GUARDS_REVERSE = r"""
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.orgs_privacyerasure
    WHERE status <> 'complete' AND inventory ? 'h31_billing_policy'
  ) OR EXISTS (
    SELECT 1 FROM public.orgs_accounterasure
    WHERE status <> 'complete' AND inventory ? 'h31_billing_policy'
  ) OR EXISTS (
    SELECT 1 FROM public.billing_workspaceboostgrant
    WHERE state IN ('active', 'expired', 'refunded', 'disputed')
       OR invoice_id IS NOT NULL
       OR stripe_payment_intent_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.billing_vipmembershipentitlement
    WHERE state IN ('active', 'expired', 'refunded', 'disputed')
       OR stripe_payment_intent_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.billing_creatorsplitledgerentry
  ) OR EXISTS (
    SELECT 1 FROM public.billing_dac7sellerstatutorysnapshot
  ) OR EXISTS (
    SELECT 1 FROM public.billing_creditnote WHERE reason = 'refund'
  ) THEN
    RAISE EXCEPTION 'cannot reverse H3.1 monetization schema while statutory records exist'
      USING ERRCODE = '23514';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS aa_03_h31_billing_erasure ON public.orgs_accounterasure;
DROP TRIGGER IF EXISTS aa_03_h31_billing_erasure ON public.orgs_privacyerasure;
DROP TRIGGER IF EXISTS aa_h31_billing_privacy_cutoff ON public.billing_creatorsplitledgerentry;
DROP TRIGGER IF EXISTS aa_h31_billing_privacy_cutoff ON public.billing_vipmembershipentitlement;
DROP TRIGGER IF EXISTS aa_h31_billing_privacy_cutoff ON public.billing_viptieroffer;
DROP TRIGGER IF EXISTS aa_h31_billing_privacy_cutoff ON public.billing_creatorconnectaccount;
DROP TRIGGER IF EXISTS aa_h31_billing_privacy_cutoff ON public.billing_workspacehostingcredit;
DROP TRIGGER IF EXISTS aa_h31_billing_privacy_cutoff ON public.billing_workspaceboostgrant;
DROP TRIGGER IF EXISTS a_resource_binding ON public.billing_vipmembershipentitlement;
DROP TRIGGER IF EXISTS a_resource_binding ON public.billing_viptieroffer;
DROP TRIGGER IF EXISTS a_resource_binding ON public.billing_creatorconnectaccount;
DROP TRIGGER IF EXISTS a_resource_binding ON public.billing_workspacehostingcredit;
DROP TRIGGER IF EXISTS a_resource_binding ON public.billing_workspaceboostgrant;
DROP TRIGGER IF EXISTS a_resource_binding ON public.billing_dac7sellerstatutorysnapshot;
DROP TRIGGER IF EXISTS a_resource_binding ON public.billing_creatorsplitledgerentry;
DROP FUNCTION IF EXISTS public.billing_h31_erasure_journal_hook();
DROP FUNCTION IF EXISTS public.billing_h31_privacy_cutoff_guard();
DROP FUNCTION IF EXISTS public.billing_h31_resource_binding_guard();
DROP FUNCTION IF EXISTS public.billing_issue_boost_refund_credit_note(uuid, text, bigint, bigint);
DROP FUNCTION IF EXISTS public.billing_issue_boost_invoice(uuid, text, integer, jsonb, jsonb, text, integer, bigint, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.billing_creditnote_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  note uuid := CASE WHEN TG_TABLE_NAME = 'billing_creditnote'
                    THEN (to_jsonb(NEW) ->> 'id')::uuid
                    ELSE (to_jsonb(NEW) ->> 'credit_note_id')::uuid END;
  n billing_creditnote%ROWTYPE;
  i billing_invoice%ROWTYPE;
  line_count bigint;
  net bigint;
  vat bigint;
BEGIN
  SELECT * INTO n FROM billing_creditnote WHERE id = note;
  SELECT * INTO i FROM billing_invoice WHERE id = n.invoice_id;
  SELECT count(*), coalesce(sum(total_excl_vat_minor), 0), coalesce(sum(vat_amount_minor), 0)
    INTO line_count, net, vat FROM billing_creditnoteline WHERE credit_note_id = note;
  IF line_count = 0 OR net <> n.total_excl_vat_minor OR vat <> n.vat_amount_minor
     OR n.organisation_id <> i.organisation_id OR n.currency <> i.currency
     OR n.total_excl_vat_minor <> i.total_excl_vat_minor
     OR n.vat_amount_minor <> i.vat_amount_minor
     OR i.state <> 'credited' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_creditnote_complete',
      MESSAGE='A credit note credits its invoice in full, with its lines and their totals';
  END IF;
  RETURN NULL;
END $$;
"""


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0024_enterprise_billing_tables'),
        ('orgs', '0035_ee_audit_ledger_erasure'),
        ('workspaces', '0018_ai_policy_and_consent'),
    ]

    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.CreateModel(
            name='CreatorConnectAccount',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('owner_user_id', models.UUIDField(blank=True, null=True)),
                ('stripe_platform_account_id', models.TextField(default='acct_1QhZ8fRwfVmWKPLR')),
                ('stripe_connect_account_id', models.TextField(blank=True, null=True, unique=True)),
                ('onboarding_state', models.TextField(default='intent_recorded')),
                ('operation_idempotency_key', models.TextField()),
                ('last_operation_error', models.TextField(blank=True, null=True)),
                ('charges_enabled', models.BooleanField(default=False)),
                ('payouts_enabled', models.BooleanField(default=False)),
                ('details_submitted', models.BooleanField(default=False)),
                ('platform_fee_bps', models.IntegerField(default=1000)),
                ('negative_balance_minor', models.BigIntegerField(default=0)),
                ('reserved_recovery_minor', models.BigIntegerField(default=0)),
                ('seller_legal_name', models.TextField()),
                ('tax_residence_country', models.TextField()),
                ('sealed_tax_tin', models.BinaryField(blank=True, null=True)),
                ('onboarding_completed_at', models.DateTimeField(blank=True, null=True)),
                ('pii_scrubbed_at', models.DateTimeField(blank=True, null=True)),
            ],
        ),
        migrations.CreateModel(
            name='CreatorSplitLedgerEntry',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('entry_kind', models.TextField()),
                ('stripe_event_id', models.TextField()),
                ('stripe_object_ref', models.TextField()),
                ('currency', models.TextField(default='EUR')),
                ('gross_excl_vat_minor', models.BigIntegerField()),
                ('vat_amount_minor', models.BigIntegerField()),
                ('total_incl_vat_minor', models.BigIntegerField()),
                ('application_fee_amount_minor', models.BigIntegerField()),
                ('dispute_fee_minor', models.BigIntegerField(default=0)),
                ('creator_net_minor', models.BigIntegerField()),
                ('negative_balance_delta_minor', models.BigIntegerField(default=0)),
                ('occurred_at', models.DateTimeField()),
            ],
        ),
        migrations.CreateModel(
            name='Dac7SellerStatutorySnapshot',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('connect_account_id', models.UUIDField(unique=True)),
                ('organisation_reference', models.UUIDField()),
                ('workspace_reference', models.UUIDField()),
                ('stripe_connect_account_id', models.TextField(blank=True, null=True)),
                ('seller_legal_name', models.TextField()),
                ('tax_residence_country', models.TextField()),
                ('sealed_tax_tin', models.BinaryField(blank=True, null=True)),
                ('retained_at', models.DateTimeField()),
                ('purge_after', models.DateTimeField()),
            ],
        ),
        migrations.CreateModel(
            name='VipMembershipEntitlement',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('membership_id', models.UUIDField()),
                ('buyer_user_id', models.UUIDField(blank=True, null=True)),
                ('customer_kind', models.TextField(default='b2c')),
                ('buyer_country', models.TextField()),
                ('currency', models.TextField(default='EUR')),
                ('vat_regime', models.TextField()),
                ('vat_rate_bp', models.IntegerField()),
                ('gross_excl_vat_minor', models.BigIntegerField()),
                ('vat_amount_minor', models.BigIntegerField()),
                ('total_incl_vat_minor', models.BigIntegerField()),
                ('application_fee_amount_minor', models.BigIntegerField()),
                ('reserved_recovery_minor', models.BigIntegerField(default=0)),
                ('refunded_incl_vat_minor', models.BigIntegerField(default=0)),
                ('state', models.TextField(default='pending_payment')),
                ('withdrawal_waiver_accepted', models.BooleanField(default=False)),
                ('withdrawal_waiver_at', models.DateTimeField(blank=True, null=True)),
                ('withdrawal_waiver_evidence', models.TextField(blank=True, null=True)),
                ('activated_at', models.DateTimeField(blank=True, null=True)),
                ('expires_at', models.DateTimeField(blank=True, null=True)),
                ('revoked_at', models.DateTimeField(blank=True, null=True)),
                ('revocation_reason', models.TextField(blank=True, null=True)),
                ('stripe_checkout_session_id', models.TextField(blank=True, null=True, unique=True)),
                ('stripe_checkout_url', models.TextField(blank=True, null=True)),
                ('stripe_payment_intent_id', models.TextField(blank=True, null=True, unique=True)),
                ('idempotency_key', models.TextField()),
                ('request_sha256', models.TextField()),
                ('pii_scrubbed_at', models.DateTimeField(blank=True, null=True)),
            ],
        ),
        migrations.CreateModel(
            name='VipTierOffer',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('code', models.TextField()),
                ('name', models.TextField()),
                ('description', models.TextField(blank=True, null=True)),
                ('billing_period', models.TextField(default='monthly')),
                ('currency', models.TextField(default='EUR')),
                ('price_excl_vat_minor', models.BigIntegerField()),
                ('granted_workspace_role_id', models.UUIDField()),
                ('granted_channel_ids', models.JSONField(default=list)),
                ('active', models.BooleanField(default=True)),
            ],
        ),
        migrations.CreateModel(
            name='WorkspaceBoostGrant',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('purchaser_user_id', models.UUIDField(blank=True, null=True)),
                ('pack_code', models.TextField()),
                ('customer_kind', models.TextField(default='b2c')),
                ('customer_country', models.TextField()),
                ('currency', models.TextField(default='EUR')),
                ('vat_regime', models.TextField()),
                ('vat_rate_bp', models.IntegerField()),
                ('net_amount_minor', models.BigIntegerField()),
                ('vat_amount_minor', models.BigIntegerField()),
                ('gross_amount_minor', models.BigIntegerField()),
                ('refunded_gross_minor', models.BigIntegerField(default=0)),
                ('credit_amount_minor', models.BigIntegerField()),
                ('seats_delta', models.IntegerField(default=0)),
                ('storage_bytes_delta', models.BigIntegerField(default=0)),
                ('state', models.TextField(default='pending_payment')),
                ('withdrawal_waiver_accepted', models.BooleanField(default=False)),
                ('withdrawal_waiver_at', models.DateTimeField(blank=True, null=True)),
                ('withdrawal_waiver_evidence', models.TextField(blank=True, null=True)),
                ('activated_at', models.DateTimeField(blank=True, null=True)),
                ('expires_at', models.DateTimeField(blank=True, null=True)),
                ('refunded_at', models.DateTimeField(blank=True, null=True)),
                ('stripe_checkout_session_id', models.TextField(blank=True, null=True, unique=True)),
                ('stripe_checkout_url', models.TextField(blank=True, null=True)),
                ('stripe_payment_intent_id', models.TextField(blank=True, null=True, unique=True)),
                ('idempotency_key', models.TextField()),
                ('request_sha256', models.TextField()),
                ('pii_scrubbed_at', models.DateTimeField(blank=True, null=True)),
            ],
        ),
        migrations.CreateModel(
            name='WorkspaceHostingCredit',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('currency', models.TextField(default='EUR')),
                ('granted_minor', models.BigIntegerField()),
                ('consumed_minor', models.BigIntegerField(default=0)),
                ('refunded_minor', models.BigIntegerField(default=0)),
                ('remaining_minor', models.BigIntegerField()),
                ('state', models.TextField(default='active')),
                ('expires_at', models.DateTimeField(blank=True, null=True)),
            ],
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql=(
                        "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
                        "ALTER TABLE billing_creditnote DROP CONSTRAINT billing_creditnote_vat_regime_valid;\n"
                        "ALTER TABLE billing_creditnote ADD CONSTRAINT billing_creditnote_vat_regime_valid "
                        "CHECK (vat_regime IN ('fr_standard', 'eu_reverse_charge', 'exempt', 'outside_eu', 'eu_oss')) NOT VALID;\n"
                        "ALTER TABLE billing_creditnote DROP CONSTRAINT billing_creditnote_reason_valid;\n"
                        "ALTER TABLE billing_creditnote ADD CONSTRAINT billing_creditnote_reason_valid "
                        "CHECK (reason IN ('customer_cancellation', 'unpaid_lapse', 'complimentary', 'refund')) NOT VALID;\n"
                        "ALTER TABLE billing_invoice DROP CONSTRAINT billing_invoice_vat_regime_valid;\n"
                        "ALTER TABLE billing_invoice ADD CONSTRAINT billing_invoice_vat_regime_valid "
                        "CHECK (vat_regime IN ('fr_standard', 'eu_reverse_charge', 'exempt', 'outside_eu', 'eu_oss')) NOT VALID;\n"
                    ),
                    reverse_sql=(
                        "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
                        "LOCK TABLE billing_creditnote, billing_invoice IN SHARE ROW EXCLUSIVE MODE;\n"
                        "DO $$ BEGIN\n"
                        "  IF EXISTS (SELECT 1 FROM billing_creditnote WHERE reason = 'refund' OR vat_regime = 'eu_oss') "
                        "     OR EXISTS (SELECT 1 FROM billing_invoice WHERE vat_regime = 'eu_oss') THEN\n"
                        "    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='H3.1 refund or eu_oss billing documents exist; billing 0025 cannot be reversed';\n"
                        "  END IF;\n"
                        "END $$;\n"
                        "ALTER TABLE billing_creditnote DROP CONSTRAINT billing_creditnote_vat_regime_valid;\n"
                        "ALTER TABLE billing_creditnote ADD CONSTRAINT billing_creditnote_vat_regime_valid "
                        "CHECK (vat_regime IN ('fr_standard', 'eu_reverse_charge', 'exempt', 'outside_eu')) NOT VALID;\n"
                        "ALTER TABLE billing_creditnote DROP CONSTRAINT billing_creditnote_reason_valid;\n"
                        "ALTER TABLE billing_creditnote ADD CONSTRAINT billing_creditnote_reason_valid "
                        "CHECK (reason IN ('customer_cancellation', 'unpaid_lapse', 'complimentary')) NOT VALID;\n"
                        "ALTER TABLE billing_invoice DROP CONSTRAINT billing_invoice_vat_regime_valid;\n"
                        "ALTER TABLE billing_invoice ADD CONSTRAINT billing_invoice_vat_regime_valid "
                        "CHECK (vat_regime IN ('fr_standard', 'eu_reverse_charge', 'exempt', 'outside_eu')) NOT VALID;\n"
                    ),
                ),
            ],
            state_operations=[
                migrations.RemoveConstraint(
                    model_name='creditnote',
                    name='billing_creditnote_vat_regime_valid',
                ),
                migrations.RemoveConstraint(
                    model_name='creditnote',
                    name='billing_creditnote_reason_valid',
                ),
                migrations.RemoveConstraint(
                    model_name='invoice',
                    name='billing_invoice_vat_regime_valid',
                ),
                migrations.AddConstraint(
                    model_name='creditnote',
                    constraint=models.CheckConstraint(condition=models.Q(('reason__in', ('customer_cancellation', 'unpaid_lapse', 'complimentary', 'refund'))), name='billing_creditnote_reason_valid'),
                ),
                migrations.AddConstraint(
                    model_name='creditnote',
                    constraint=models.CheckConstraint(condition=models.Q(('vat_regime__in', ('fr_standard', 'eu_reverse_charge', 'exempt', 'outside_eu', 'eu_oss'))), name='billing_creditnote_vat_regime_valid'),
                ),
                migrations.AddConstraint(
                    model_name='invoice',
                    constraint=models.CheckConstraint(condition=models.Q(('vat_regime__in', ('fr_standard', 'eu_reverse_charge', 'exempt', 'outside_eu', 'eu_oss'))), name='billing_invoice_vat_regime_valid'),
                ),
            ],
        ),
        migrations.AddField(
            model_name='creatorconnectaccount',
            name='organisation',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.organisation'),
        ),
        migrations.AddField(
            model_name='creatorconnectaccount',
            name='workspace',
            field=models.OneToOneField(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='workspaces.workspace'),
        ),
        migrations.AddField(
            model_name='creatorsplitledgerentry',
            name='connect_account',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='ledger_entries', to='billing.creatorconnectaccount'),
        ),
        migrations.AddField(
            model_name='creatorsplitledgerentry',
            name='organisation',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.organisation'),
        ),
        migrations.AddField(
            model_name='creatorsplitledgerentry',
            name='workspace',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='workspaces.workspace'),
        ),
        migrations.AddIndex(
            model_name='dac7sellerstatutorysnapshot',
            index=models.Index(fields=['purge_after', 'id'], name='billing_dac7statutory_due_idx'),
        ),
        migrations.AddConstraint(
            model_name='dac7sellerstatutorysnapshot',
            constraint=models.CheckConstraint(condition=models.Q(('tax_residence_country__regex', '^[A-Z]{2}$')), name='billing_dac7statutory_country_valid'),
        ),
        migrations.AddConstraint(
            model_name='dac7sellerstatutorysnapshot',
            constraint=models.CheckConstraint(condition=models.Q(('purge_after__gt', models.F('retained_at'))), name='billing_dac7statutory_window_valid'),
        ),
        migrations.AddField(
            model_name='vipmembershipentitlement',
            name='organisation',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.organisation'),
        ),
        migrations.AddField(
            model_name='vipmembershipentitlement',
            name='workspace',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='workspaces.workspace'),
        ),
        migrations.AddField(
            model_name='creatorsplitledgerentry',
            name='entitlement',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='ledger_entries', to='billing.vipmembershipentitlement'),
        ),
        migrations.AddField(
            model_name='viptieroffer',
            name='connect_account',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='tiers', to='billing.creatorconnectaccount'),
        ),
        migrations.AddField(
            model_name='viptieroffer',
            name='organisation',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.organisation'),
        ),
        migrations.AddField(
            model_name='viptieroffer',
            name='workspace',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='workspaces.workspace'),
        ),
        migrations.AddField(
            model_name='vipmembershipentitlement',
            name='tier',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='entitlements', to='billing.viptieroffer'),
        ),
        migrations.AddField(
            model_name='workspaceboostgrant',
            name='invoice',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, related_name='boost_grants', to='billing.invoice'),
        ),
        migrations.AddField(
            model_name='workspaceboostgrant',
            name='organisation',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.organisation'),
        ),
        migrations.AddField(
            model_name='workspaceboostgrant',
            name='workspace',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='workspaces.workspace'),
        ),
        migrations.AddField(
            model_name='workspacehostingcredit',
            name='boost_grant',
            field=models.OneToOneField(on_delete=django.db.models.deletion.RESTRICT, related_name='hosting_credit', to='billing.workspaceboostgrant'),
        ),
        migrations.AddField(
            model_name='workspacehostingcredit',
            name='organisation',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.organisation'),
        ),
        migrations.AddField(
            model_name='workspacehostingcredit',
            name='workspace',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='workspaces.workspace'),
        ),
        migrations.AddIndex(
            model_name='creatorconnectaccount',
            index=models.Index(fields=['organisation', 'onboarding_state'], name='billing_connect_org_state_idx'),
        ),
        migrations.AddConstraint(
            model_name='creatorconnectaccount',
            constraint=models.CheckConstraint(condition=models.Q(('onboarding_state__in', ('intent_recorded', 'account_created', 'onboarding_link_issued', 'restricted', 'active', 'outcome_unknown', 'disabled'))), name='billing_connect_state_valid'),
        ),
        migrations.AddConstraint(
            model_name='creatorconnectaccount',
            constraint=models.CheckConstraint(condition=models.Q(('onboarding_state__in', ('intent_recorded', 'outcome_unknown')), models.Q(('stripe_connect_account_id__isnull', False), ('stripe_connect_account_id__regex', '^acct_[A-Za-z0-9_]+$')), _connector='OR'), name='billing_connect_account_id_required'),
        ),
        migrations.AddConstraint(
            model_name='creatorconnectaccount',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('onboarding_state', 'active'), _negated=True), models.Q(('charges_enabled', True), ('details_submitted', True)), _connector='OR'), name='billing_connect_active_capabilities'),
        ),
        migrations.AddConstraint(
            model_name='creatorconnectaccount',
            constraint=models.CheckConstraint(condition=models.Q(('platform_fee_bps__range', (0, 9999))), name='billing_connect_fee_bps_valid'),
        ),
        migrations.AddConstraint(
            model_name='creatorconnectaccount',
            constraint=models.CheckConstraint(condition=models.Q(('negative_balance_minor__gte', 0), ('reserved_recovery_minor__gte', 0), ('reserved_recovery_minor__lte', models.F('negative_balance_minor'))), name='billing_connect_neg_balance_valid'),
        ),
        migrations.AddConstraint(
            model_name='creatorconnectaccount',
            constraint=models.CheckConstraint(condition=models.Q(('stripe_platform_account_id__regex', '^acct_[A-Za-z0-9_]+$')), name='billing_connect_platform_acct_valid'),
        ),
        migrations.AddConstraint(
            model_name='creatorconnectaccount',
            constraint=models.CheckConstraint(condition=models.Q(('tax_residence_country__regex', '^[A-Z]{2}$')), name='billing_connect_country_valid'),
        ),
        migrations.AddIndex(
            model_name='creatorsplitledgerentry',
            index=models.Index(fields=['connect_account', 'occurred_at'], name='billing_splitledger_acct_idx'),
        ),
        migrations.AddConstraint(
            model_name='creatorsplitledgerentry',
            constraint=models.UniqueConstraint(fields=('stripe_event_id', 'entry_kind'), name='billing_splitledger_event_kind_unique'),
        ),
        migrations.AddConstraint(
            model_name='creatorsplitledgerentry',
            constraint=models.CheckConstraint(condition=models.Q(('entry_kind__in', ('sale', 'refund', 'chargeback', 'negative_balance_recovery'))), name='billing_splitledger_kind_valid'),
        ),
        migrations.AddConstraint(
            model_name='creatorsplitledgerentry',
            constraint=models.CheckConstraint(condition=models.Q(('currency__in', ('EUR',))), name='billing_splitledger_currency_valid'),
        ),
        migrations.AddConstraint(
            model_name='creatorsplitledgerentry',
            constraint=models.CheckConstraint(condition=models.Q(('dispute_fee_minor__gte', 0)), name='billing_splitledger_dispute_fee_valid'),
        ),
        migrations.AddConstraint(
            model_name='creatorsplitledgerentry',
            constraint=models.CheckConstraint(condition=models.Q(('total_incl_vat_minor', django.db.models.expressions.CombinedExpression(models.F('gross_excl_vat_minor'), '+', models.F('vat_amount_minor'))), ('creator_net_minor', django.db.models.expressions.CombinedExpression(django.db.models.expressions.CombinedExpression(models.F('gross_excl_vat_minor'), '-', models.F('application_fee_amount_minor')), '-', models.F('dispute_fee_minor')))), name='billing_splitledger_totals_valid'),
        ),
        migrations.AddIndex(
            model_name='viptieroffer',
            index=models.Index(fields=['workspace', 'active'], name='billing_viptier_ws_active_idx'),
        ),
        migrations.AddConstraint(
            model_name='viptieroffer',
            constraint=models.UniqueConstraint(fields=('workspace', 'code'), name='billing_viptier_workspace_code_unique'),
        ),
        migrations.AddConstraint(
            model_name='viptieroffer',
            constraint=models.CheckConstraint(condition=models.Q(('code__regex', '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$')), name='billing_viptier_code_valid'),
        ),
        migrations.AddConstraint(
            model_name='viptieroffer',
            constraint=models.CheckConstraint(condition=models.Q(('billing_period__in', ('monthly', 'yearly', 'one_time'))), name='billing_viptier_period_valid'),
        ),
        migrations.AddConstraint(
            model_name='viptieroffer',
            constraint=models.CheckConstraint(condition=models.Q(('currency__in', ('EUR',))), name='billing_viptier_currency_valid'),
        ),
        migrations.AddConstraint(
            model_name='viptieroffer',
            constraint=models.CheckConstraint(condition=models.Q(('price_excl_vat_minor__gt', 0)), name='billing_viptier_price_valid'),
        ),
        migrations.AddIndex(
            model_name='vipmembershipentitlement',
            index=models.Index(fields=['workspace', 'membership_id', 'state'], name='billing_vipentitlement_mem_idx'),
        ),
        migrations.AddConstraint(
            model_name='vipmembershipentitlement',
            constraint=models.UniqueConstraint(fields=('workspace', 'idempotency_key'), name='billing_vipentitlement_idempotency_unique'),
        ),
        migrations.AddConstraint(
            model_name='vipmembershipentitlement',
            constraint=models.CheckConstraint(condition=models.Q(('request_sha256__regex', '^[0-9a-f]{64}$')), name='billing_vipentitlement_request_sha256_valid'),
        ),
        migrations.AddConstraint(
            model_name='vipmembershipentitlement',
            constraint=models.CheckConstraint(condition=models.Q(('customer_kind__in', ('b2c', 'b2b'))), name='billing_vipentitlement_kind_valid'),
        ),
        migrations.AddConstraint(
            model_name='vipmembershipentitlement',
            constraint=models.CheckConstraint(condition=models.Q(('buyer_country__regex', '^[A-Z]{2}$')), name='billing_vipentitlement_country_valid'),
        ),
        migrations.AddConstraint(
            model_name='vipmembershipentitlement',
            constraint=models.CheckConstraint(condition=models.Q(('currency__in', ('EUR',))), name='billing_vipentitlement_currency_valid'),
        ),
        migrations.AddConstraint(
            model_name='vipmembershipentitlement',
            constraint=models.CheckConstraint(condition=models.Q(('vat_regime__in', ('fr_standard', 'eu_reverse_charge', 'exempt', 'outside_eu', 'eu_oss'))), name='billing_vipentitlement_vat_regime_valid'),
        ),
        migrations.AddConstraint(
            model_name='vipmembershipentitlement',
            constraint=models.CheckConstraint(condition=models.Q(('state__in', ('pending_payment', 'active', 'expired', 'refunded', 'disputed', 'cancelled'))), name='billing_vipentitlement_state_valid'),
        ),
        migrations.AddConstraint(
            model_name='vipmembershipentitlement',
            constraint=models.CheckConstraint(condition=models.Q(('gross_excl_vat_minor__gt', 0), ('vat_rate_bp__range', (0, 10000)), ('vat_amount_minor__gte', 0), ('total_incl_vat_minor', django.db.models.expressions.CombinedExpression(models.F('gross_excl_vat_minor'), '+', models.F('vat_amount_minor'))), ('application_fee_amount_minor__gte', 0), ('application_fee_amount_minor__lt', models.F('total_incl_vat_minor')), ('reserved_recovery_minor__gte', 0), ('refunded_incl_vat_minor__gte', 0), ('refunded_incl_vat_minor__lte', models.F('total_incl_vat_minor'))), name='billing_vipentitlement_amounts_valid'),
        ),
        migrations.AddConstraint(
            model_name='vipmembershipentitlement',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(models.Q(('withdrawal_waiver_accepted', True), _negated=True), models.Q(('withdrawal_waiver_at__isnull', False), ('withdrawal_waiver_evidence__isnull', False), models.Q(('withdrawal_waiver_evidence', ''), _negated=True)), _connector='OR'), models.Q(models.Q(('customer_kind', 'b2c'), _negated=True), models.Q(('state__in', ('pending_payment', 'cancelled')), ('activated_at__isnull', True)), models.Q(('withdrawal_waiver_accepted', True), ('withdrawal_waiver_at__isnull', False), ('withdrawal_waiver_evidence__isnull', False)), _connector='OR')), name='billing_vipentitlement_b2c_waiver_valid'),
        ),
        migrations.AddConstraint(
            model_name='vipmembershipentitlement',
            constraint=models.CheckConstraint(condition=models.Q(('activated_at__isnull', True), ('expires_at__isnull', True), ('expires_at__gt', models.F('activated_at')), _connector='OR'), name='billing_vipentitlement_window_valid'),
        ),
        migrations.AddIndex(
            model_name='workspaceboostgrant',
            index=models.Index(fields=['workspace', 'state', '-created_at'], name='billing_boost_ws_state_idx'),
        ),
        migrations.AddConstraint(
            model_name='workspaceboostgrant',
            constraint=models.UniqueConstraint(fields=('organisation', 'idempotency_key'), name='billing_boost_idempotency_unique'),
        ),
        migrations.AddConstraint(
            model_name='workspaceboostgrant',
            constraint=models.CheckConstraint(condition=models.Q(('request_sha256__regex', '^[0-9a-f]{64}$')), name='billing_boost_request_sha256_valid'),
        ),
        migrations.AddConstraint(
            model_name='workspaceboostgrant',
            constraint=models.CheckConstraint(condition=models.Q(('customer_kind__in', ('b2c', 'b2b'))), name='billing_boost_customer_kind_valid'),
        ),
        migrations.AddConstraint(
            model_name='workspaceboostgrant',
            constraint=models.CheckConstraint(condition=models.Q(('customer_country__regex', '^[A-Z]{2}$')), name='billing_boost_country_valid'),
        ),
        migrations.AddConstraint(
            model_name='workspaceboostgrant',
            constraint=models.CheckConstraint(condition=models.Q(('currency__in', ('EUR',))), name='billing_boost_currency_valid'),
        ),
        migrations.AddConstraint(
            model_name='workspaceboostgrant',
            constraint=models.CheckConstraint(condition=models.Q(('vat_regime__in', ('fr_standard', 'eu_reverse_charge', 'exempt', 'outside_eu', 'eu_oss'))), name='billing_boost_vat_regime_valid'),
        ),
        migrations.AddConstraint(
            model_name='workspaceboostgrant',
            constraint=models.CheckConstraint(condition=models.Q(('state__in', ('pending_payment', 'active', 'expired', 'refunded', 'disputed', 'cancelled'))), name='billing_boost_state_valid'),
        ),
        migrations.AddConstraint(
            model_name='workspaceboostgrant',
            constraint=models.CheckConstraint(condition=models.Q(('net_amount_minor__gt', 0), ('vat_rate_bp__range', (0, 10000)), ('vat_amount_minor__gte', 0), ('gross_amount_minor', django.db.models.expressions.CombinedExpression(models.F('net_amount_minor'), '+', models.F('vat_amount_minor'))), ('refunded_gross_minor__gte', 0), ('refunded_gross_minor__lte', models.F('gross_amount_minor')), ('credit_amount_minor__gte', 0), ('seats_delta__gte', 0), ('storage_bytes_delta__gte', 0)), name='billing_boost_amounts_valid'),
        ),
        migrations.AddConstraint(
            model_name='workspaceboostgrant',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(models.Q(('withdrawal_waiver_accepted', True), _negated=True), models.Q(('withdrawal_waiver_at__isnull', False), ('withdrawal_waiver_evidence__isnull', False), models.Q(('withdrawal_waiver_evidence', ''), _negated=True)), _connector='OR'), models.Q(models.Q(('customer_kind', 'b2c'), _negated=True), models.Q(('state__in', ('pending_payment', 'cancelled')), ('activated_at__isnull', True)), models.Q(('withdrawal_waiver_accepted', True), ('withdrawal_waiver_at__isnull', False), ('withdrawal_waiver_evidence__isnull', False)), _connector='OR')), name='billing_boost_b2c_waiver_valid'),
        ),
        migrations.AddConstraint(
            model_name='workspaceboostgrant',
            constraint=models.CheckConstraint(condition=models.Q(('activated_at__isnull', True), ('expires_at__isnull', True), ('expires_at__gt', models.F('activated_at')), _connector='OR'), name='billing_boost_window_valid'),
        ),
        migrations.AddIndex(
            model_name='workspacehostingcredit',
            index=models.Index(fields=['workspace', 'state'], name='billing_hostingcredit_ws_idx'),
        ),
        migrations.AddConstraint(
            model_name='workspacehostingcredit',
            constraint=models.CheckConstraint(condition=models.Q(('currency__in', ('EUR',))), name='billing_hostingcredit_currency_valid'),
        ),
        migrations.AddConstraint(
            model_name='workspacehostingcredit',
            constraint=models.CheckConstraint(condition=models.Q(('state__in', ('active', 'depleted', 'expired', 'revoked'))), name='billing_hostingcredit_state_valid'),
        ),
        migrations.AddConstraint(
            model_name='workspacehostingcredit',
            constraint=models.CheckConstraint(condition=models.Q(('granted_minor__gte', 0), ('consumed_minor__gte', 0), ('refunded_minor__gte', 0), ('remaining_minor__gte', 0), ('remaining_minor', django.db.models.expressions.CombinedExpression(django.db.models.expressions.CombinedExpression(models.F('granted_minor'), '-', models.F('consumed_minor')), '-', models.F('refunded_minor')))), name='billing_hostingcredit_ledger_valid'),
        ),
        migrations.RunSQL(sql=H31_GUARDS_FORWARD, reverse_sql=H31_GUARDS_REVERSE),
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=TIMEOUTS),
    ]
