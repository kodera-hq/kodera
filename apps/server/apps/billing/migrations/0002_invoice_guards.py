"""An issued invoice and its lines never change: docs/domain/BILLING_MODEL.md §4.

An invoice is created as a draft, editable and with no number. It is issued only with at least one
line, totals equal to the sums of its lines and a number of the series format. Once it leaves
`draft`, the only writes the guard lets through are the state, along a transition of
apps/billing/states.py INVOICE_TRANSITIONS (repeated here, and held equal to it by a test),
`paid_at`, `amount_paid_minor`, `updated_at`, and `external_ref` and `pdf_ref` while they are still
unset. A line is written, changed or removed only while its invoice is a draft, and the line guard
holds the invoice row in share mode, so an issue and a line write on one invoice queue. An issued
invoice is never deleted: `void` keeps its number.
"""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION billing_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['state', 'paid_at', 'amount_paid_minor', 'updated_at',
                          'external_ref', 'pdf_ref'];
  line_count bigint;
  net bigint;
  vat bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' OR NEW.number IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_invoice_transition',
        MESSAGE='An invoice is created as a draft';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_invoice_immutable',
        MESSAGE='An issued invoice is never deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.state = 'draft' THEN
    IF NEW.state = 'draft' THEN
      RETURN NEW;
    END IF;
    IF NEW.state <> 'issued' THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_invoice_transition',
        MESSAGE='A draft invoice is only issued';
    END IF;
    SELECT count(*), coalesce(sum(total_excl_vat_minor), 0), coalesce(sum(vat_amount_minor), 0)
      INTO line_count, net, vat FROM billing_invoiceline WHERE invoice_id = NEW.id;
    IF line_count = 0 OR net <> NEW.total_excl_vat_minor OR vat <> NEW.vat_amount_minor
       OR NEW.number !~ '^[A-Z]{2,8}(-[A-Z]{2,8})?-[0-9]{4}-[0-9]{5}$'
       OR NEW.amount_paid_minor <> 0 THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_invoice_issue',
        MESSAGE='An invoice is issued with its lines, their totals and a series number';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable)
     OR (OLD.external_ref IS NOT NULL AND NEW.external_ref IS DISTINCT FROM OLD.external_ref)
     OR (OLD.pdf_ref IS NOT NULL AND NEW.pdf_ref IS DISTINCT FROM OLD.pdf_ref) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_invoice_immutable',
      MESSAGE='An issued invoice never changes';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND (OLD.state || '>' || NEW.state) NOT IN (
       'issued>paid', 'issued>overdue', 'issued>void',
       'overdue>paid', 'overdue>void',
       'paid>issued', 'paid>overdue') THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_invoice_transition',
      MESSAGE='Not an invoice state transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_invoice_immutable BEFORE INSERT OR UPDATE OR DELETE ON billing_invoice
  FOR EACH ROW EXECUTE FUNCTION billing_invoice_guard();

CREATE FUNCTION billing_invoiceline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_state text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT state INTO parent_state FROM billing_invoice WHERE id = OLD.invoice_id FOR SHARE;
    IF parent_state <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_invoiceline_immutable',
        MESSAGE='A line of an issued invoice never changes';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT state INTO parent_state FROM billing_invoice WHERE id = NEW.invoice_id FOR SHARE;
    IF parent_state <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_invoiceline_immutable',
        MESSAGE='A line of an issued invoice never changes';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_invoiceline_immutable BEFORE INSERT OR UPDATE OR DELETE ON billing_invoiceline
  FOR EACH ROW EXECUTE FUNCTION billing_invoiceline_guard();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP TRIGGER billing_invoiceline_immutable ON billing_invoiceline;
DROP FUNCTION billing_invoiceline_guard();
DROP TRIGGER billing_invoice_immutable ON billing_invoice;
DROP FUNCTION billing_invoice_guard();
"""


class Migration(migrations.Migration):
    dependencies = [("billing", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, reverse_sql=REVERSE)]
