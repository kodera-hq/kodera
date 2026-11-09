"""Credit notes: the only correction of an issued invoice (docs/domain/BILLING_MODEL.md §4).

A credit note and its lines are written in one transaction, the one that issues it, and never
deleted; a note's `pdf_ref` and `external_ref` are set once and its notice's delivery recorded,
nothing else changes. At commit a
deferred check holds the note to at least one line, to totals equal to its lines' sums and to its
invoice's, to its invoice's organisation and currency, and its invoice to `credited`; every line
credits a line of that invoice. The invoice guard admits `issued | overdue → credited`, only with
its credit note, and no longer `→ void`: an issued invoice leaves only by payment or credit note,
as apps/billing/states.py INVOICE_TRANSITIONS says. The reverse refuses while a credit note
exists: they are legal records.
"""

import core.db.ids
import django.db.models.deletion
import django.db.models.expressions
from typing import Any

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

INVOICE_GUARD = r"""
CREATE OR REPLACE FUNCTION billing_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
       'issued>paid', 'issued>overdue', 'issued>credited',
       'overdue>paid', 'overdue>credited',
       'paid>issued', 'paid>overdue') THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_invoice_transition',
      MESSAGE='Not an invoice state transition';
  END IF;
  -- Credited only by the credit note that credits it, written first in the same transaction.
  IF NEW.state = 'credited' AND OLD.state <> 'credited' AND NOT EXISTS (
       SELECT 1 FROM billing_creditnote WHERE invoice_id = NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_invoice_transition',
      MESSAGE='An invoice is credited by its credit note';
  END IF;
  RETURN NEW;
END $$;
"""

INVOICE_GUARD_BEFORE = r"""
CREATE OR REPLACE FUNCTION billing_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
"""

CREDIT_NOTE_GUARDS = r"""
CREATE FUNCTION billing_creditnote_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  settable text[] := ARRAY['pdf_ref', 'external_ref', 'notice_delivery_id', 'updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Dated in the transaction that issues it: never written afterwards with an older date.
    IF NEW.issued_at < now() THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_creditnote_immutable',
        MESSAGE='A credit note is written in the transaction that issues it';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE'
     OR (to_jsonb(OLD) - settable) IS DISTINCT FROM (to_jsonb(NEW) - settable)
     OR (OLD.pdf_ref IS NOT NULL AND NEW.pdf_ref IS DISTINCT FROM OLD.pdf_ref)
     OR (OLD.external_ref IS NOT NULL AND NEW.external_ref IS DISTINCT FROM OLD.external_ref) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_creditnote_immutable',
      MESSAGE='A credit note never changes';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_creditnote_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON billing_creditnote FOR EACH ROW EXECUTE FUNCTION billing_creditnote_guard();

CREATE FUNCTION billing_creditnoteline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  note_issued timestamptz;
  note_invoice uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_creditnote_immutable',
      MESSAGE='A line of a credit note never changes';
  END IF;
  SELECT issued_at, invoice_id INTO note_issued, note_invoice
    FROM billing_creditnote WHERE id = NEW.credit_note_id;
  IF note_issued < now() THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_creditnote_immutable',
      MESSAGE='A line is written with its credit note, never afterwards';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM billing_invoiceline
                 WHERE id = NEW.invoice_line_id AND invoice_id = note_invoice) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_creditnote_complete',
      MESSAGE='A credit note line credits a line of the note''s invoice';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_creditnoteline_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON billing_creditnoteline FOR EACH ROW EXECUTE FUNCTION billing_creditnoteline_guard();

-- A trigger function only: the scoped roles' policy refuses any other function they could run.
CREATE FUNCTION billing_creditnote_complete() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER billing_creditnote_complete AFTER INSERT ON billing_creditnote
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_creditnote_complete();
CREATE CONSTRAINT TRIGGER billing_creditnoteline_complete AFTER INSERT ON billing_creditnoteline
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_creditnote_complete();
"""

CREDIT_NOTE_GUARDS_REVERSE = r"""
DROP TRIGGER billing_creditnoteline_complete ON billing_creditnoteline;
DROP TRIGGER billing_creditnote_complete ON billing_creditnote;
DROP FUNCTION billing_creditnote_complete();
DROP TRIGGER billing_creditnoteline_immutable ON billing_creditnoteline;
DROP FUNCTION billing_creditnoteline_guard();
DROP TRIGGER billing_creditnote_immutable ON billing_creditnote;
DROP FUNCTION billing_creditnote_guard();
"""


def refuse_to_drop_credit_notes(apps: Any, schema_editor: Any) -> None:
    with schema_editor.connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM billing_creditnote")
        (count,) = cursor.fetchone()
    if count:
        raise RuntimeError(f"{count} credit note(s) exist: they are legal records, kept 10 years")


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0007_order_confirmation'),
        ('orgs', '0003_organisation_slug_minimum_five'),
    ]

    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.CreateModel(
            name='CreditNote',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('number', models.TextField(unique=True)),
                ('issued_at', models.DateTimeField()),
                ('reason', models.TextField()),
                ('currency', models.TextField()),
                ('vat_regime', models.TextField()),
                ('vat_mention', models.TextField(blank=True, null=True)),
                ('issuer_legal_name', models.TextField()),
                ('issuer_address', models.TextField()),
                ('issuer_siren', models.TextField()),
                ('issuer_vat_number', models.TextField()),
                ('customer_legal_name', models.TextField()),
                ('customer_address_line1', models.TextField()),
                ('customer_address_line2', models.TextField(blank=True, null=True)),
                ('customer_postal_code', models.TextField()),
                ('customer_city', models.TextField()),
                ('customer_country', models.TextField()),
                ('customer_siren', models.TextField(blank=True, null=True)),
                ('customer_vat_number', models.TextField(blank=True, null=True)),
                ('total_excl_vat_minor', models.BigIntegerField()),
                ('vat_amount_minor', models.BigIntegerField()),
                ('total_incl_vat_minor', models.BigIntegerField()),
                ('pdf_ref', models.TextField(blank=True, null=True)),
                ('external_ref', models.TextField(blank=True, null=True)),
                ('notice_delivery_id', models.UUIDField(blank=True, null=True, unique=True)),
            ],
        ),
        migrations.CreateModel(
            name='CreditNoteLine',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('position', models.IntegerField()),
                ('description', models.TextField()),
                ('quantity', models.IntegerField()),
                ('unit_amount_minor', models.BigIntegerField()),
                ('total_excl_vat_minor', models.BigIntegerField()),
                ('vat_rate_bp', models.IntegerField()),
                ('vat_amount_minor', models.BigIntegerField()),
                ('period_start', models.DateTimeField(blank=True, null=True)),
                ('period_end', models.DateTimeField(blank=True, null=True)),
            ],
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    "ALTER TABLE billing_invoice ADD CONSTRAINT billing_invoice_credited_unpaid CHECK "
                    "((NOT (state = 'credited') OR amount_paid_minor = 0)) NOT VALID;",
                    reverse_sql="ALTER TABLE billing_invoice DROP CONSTRAINT billing_invoice_credited_unpaid;",
                )
            ],
            state_operations=[
                migrations.AddConstraint(
                    model_name='invoice',
                    constraint=models.CheckConstraint(condition=models.Q(models.Q(('state', 'credited'), _negated=True), ('amount_paid_minor', 0), _connector='OR'), name='billing_invoice_credited_unpaid'),
                ),
            ],
        ),
        migrations.AddField(
            model_name='creditnote',
            name='invoice',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='credit_notes', to='billing.invoice'),
        ),
        migrations.AddField(
            model_name='creditnote',
            name='organisation',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='orgs.organisation'),
        ),
        migrations.AddField(
            model_name='creditnoteline',
            name='credit_note',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='lines', to='billing.creditnote'),
        ),
        migrations.AddField(
            model_name='creditnoteline',
            name='invoice_line',
            field=models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, related_name='+', to='billing.invoiceline'),
        ),
        migrations.AddIndex(
            model_name='creditnote',
            index=models.Index(fields=['organisation', '-issued_at', '-id'], name='billing_creditnote_org_idx'),
        ),
        migrations.AddConstraint(
            model_name='creditnote',
            constraint=models.UniqueConstraint(fields=('invoice',), name='billing_creditnote_one_per_invoice'),
        ),
        migrations.AddConstraint(
            model_name='creditnote',
            constraint=models.CheckConstraint(condition=models.Q(('number__regex', '^AV-[A-Z]{2,8}(-[A-Z]{2,8})?-[0-9]{4}-[0-9]{5}$')), name='billing_creditnote_number_valid'),
        ),
        migrations.AddConstraint(
            model_name='creditnote',
            constraint=models.CheckConstraint(condition=models.Q(('reason__in', ('customer_cancellation', 'unpaid_lapse'))), name='billing_creditnote_reason_valid'),
        ),
        migrations.AddConstraint(
            model_name='creditnote',
            constraint=models.CheckConstraint(condition=models.Q(('currency__in', ('EUR',))), name='billing_creditnote_currency_valid'),
        ),
        migrations.AddConstraint(
            model_name='creditnote',
            constraint=models.CheckConstraint(condition=models.Q(('vat_regime__in', ('fr_standard', 'eu_reverse_charge', 'exempt', 'outside_eu'))), name='billing_creditnote_vat_regime_valid'),
        ),
        migrations.AddConstraint(
            model_name='creditnote',
            constraint=models.CheckConstraint(condition=models.Q(('total_excl_vat_minor__gte', 0), ('vat_amount_minor__gte', 0), ('total_incl_vat_minor', django.db.models.expressions.CombinedExpression(models.F('total_excl_vat_minor'), '+', models.F('vat_amount_minor')))), name='billing_creditnote_amounts_valid'),
        ),
        migrations.AddConstraint(
            model_name='creditnoteline',
            constraint=models.UniqueConstraint(fields=('credit_note', 'position'), name='billing_creditnoteline_position_unique'),
        ),
        migrations.AddConstraint(
            model_name='creditnoteline',
            constraint=models.CheckConstraint(condition=models.Q(('quantity__range', (1, 10000)), ('unit_amount_minor__gte', 0), ('total_excl_vat_minor', django.db.models.expressions.CombinedExpression(models.F('unit_amount_minor'), '*', models.F('quantity'))), ('vat_rate_bp__range', (0, 10000)), ('vat_amount_minor__gte', 0)), name='billing_creditnoteline_amounts_valid'),
        ),
        migrations.RunSQL(sql=CREDIT_NOTE_GUARDS, reverse_sql=CREDIT_NOTE_GUARDS_REVERSE),
        migrations.RunSQL(sql=INVOICE_GUARD, reverse_sql=INVOICE_GUARD_BEFORE),
        # Last but one: reversed first, while the table is still there to count.
        migrations.RunPython(migrations.RunPython.noop, refuse_to_drop_credit_notes),
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=TIMEOUTS),
    ]
