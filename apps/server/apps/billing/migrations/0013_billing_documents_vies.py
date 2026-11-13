import core.db.ids
import django.db.models.deletion
from django.db import migrations, models

GUARDS = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION billing_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_evidence_immutable',
    MESSAGE='Billing evidence is append-only';
END $$;
CREATE TRIGGER billing_vies_immutable BEFORE UPDATE OR DELETE ON billing_viesconsultation
  FOR EACH ROW EXECUTE FUNCTION billing_evidence_immutable();
CREATE TRIGGER billing_artifact_immutable BEFORE UPDATE OR DELETE ON billing_billingartifact
  FOR EACH ROW EXECUTE FUNCTION billing_evidence_immutable();

CREATE FUNCTION billing_artifact_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF octet_length(NEW.pdf) NOT BETWEEN 5 AND 10000000
     OR octet_length(NEW.xml) NOT BETWEEN 1 AND 1000000
     OR encode(sha256(NEW.pdf), 'hex') <> NEW.pdf_sha256
     OR encode(sha256(NEW.xml), 'hex') <> NEW.xml_sha256
     OR NEW.validator_ref = ''
     OR (NEW.invoice_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM billing_invoice WHERE id=NEW.invoice_id AND state <> 'draft')) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_artifact_integrity',
      MESSAGE='Billing artifact requires an issued document and matching digests';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_artifact_insert BEFORE INSERT ON billing_billingartifact
  FOR EACH ROW EXECUTE FUNCTION billing_artifact_insert_guard();

CREATE FUNCTION billing_vies_issue_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'draft' AND OLD.state = 'draft' AND NEW.vat_regime='eu_reverse_charge'
     AND NOT EXISTS (
       SELECT 1 FROM billing_viesconsultation v
       WHERE v.organisation_id=NEW.organisation_id
         AND v.country_code=NEW.customer_country AND v.vat_number=NEW.customer_vat_number
         AND v.status='valid' AND v.checked_at <= NEW.issued_at
         AND v.next_check_at > NEW.issued_at
         AND NOT EXISTS (SELECT 1 FROM billing_viesconsultation newer
           WHERE newer.organisation_id=v.organisation_id AND newer.country_code=v.country_code
             AND newer.vat_number=v.vat_number
             AND (newer.checked_at, newer.id) > (v.checked_at, v.id))) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='billing_vies_evidence_required',
      MESSAGE='Reverse-charge issuance requires current recorded VIES evidence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_vies_issue BEFORE UPDATE ON billing_invoice
  FOR EACH ROW EXECUTE FUNCTION billing_vies_issue_guard();
"""

REVERSE_GUARDS = r"""
DROP TRIGGER billing_vies_issue ON billing_invoice;
DROP FUNCTION billing_vies_issue_guard();
DROP TRIGGER billing_artifact_insert ON billing_billingartifact;
DROP FUNCTION billing_artifact_insert_guard();
DROP TRIGGER billing_artifact_immutable ON billing_billingartifact;
DROP TRIGGER billing_vies_immutable ON billing_viesconsultation;
DROP FUNCTION billing_evidence_immutable();
"""


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0012_validate_complimentary_credit_reason'),
        ('orgs', '0021_remove_organisation_organisation_slug_not_reserved_and_more'),
    ]

    operations = [
        migrations.CreateModel(
            name='BillingArtifact',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('snapshot_sha256', models.TextField()),
                ('pdf_sha256', models.TextField()),
                ('xml_sha256', models.TextField()),
                ('pdf', models.BinaryField()),
                ('xml', models.BinaryField()),
                ('validator_ref', models.TextField()),
                ('credit_note', models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, to='billing.creditnote')),
                ('invoice', models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, to='billing.invoice')),
            ],
            options={
                'constraints': [models.CheckConstraint(condition=models.Q(models.Q(('credit_note__isnull', True), ('invoice__isnull', False)), models.Q(('credit_note__isnull', False), ('invoice__isnull', True)), _connector='OR'), name='billing_artifact_parent'), models.CheckConstraint(condition=models.Q(('snapshot_sha256__regex', '^[0-9a-f]{64}$')), name='billing_artifact_snapshot_sha256'), models.CheckConstraint(condition=models.Q(('pdf_sha256__regex', '^[0-9a-f]{64}$')), name='billing_artifact_pdf_sha256'), models.CheckConstraint(condition=models.Q(('xml_sha256__regex', '^[0-9a-f]{64}$')), name='billing_artifact_xml_sha256')],
            },
        ),
        migrations.CreateModel(
            name='ViesConsultation',
            fields=[
                ('id', models.UUIDField(default=core.db.ids.new_uuid7, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('country_code', models.TextField()),
                ('vat_number', models.TextField()),
                ('status', models.TextField()),
                ('checked_at', models.DateTimeField()),
                ('next_check_at', models.DateTimeField()),
                ('consultation_ref', models.TextField(blank=True, null=True)),
                ('response_sha256', models.TextField()),
                ('evidence', models.JSONField()),
                ('organisation', models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT, to='orgs.organisation')),
            ],
            options={
                'indexes': [models.Index(fields=['organisation', '-checked_at', '-id'], name='billing_vies_latest')],
                'constraints': [models.CheckConstraint(condition=models.Q(('status__in', ('valid', 'invalid', 'unavailable'))), name='billing_vies_status'), models.CheckConstraint(condition=models.Q(('response_sha256__regex', '^[0-9a-f]{64}$')), name='billing_vies_digest'), models.CheckConstraint(condition=models.Q(('next_check_at__gt', models.F('checked_at'))), name='billing_vies_window'), models.CheckConstraint(condition=models.Q(models.Q(('status', 'valid'), _negated=True), ('consultation_ref__isnull', False), _connector='OR'), name='billing_vies_valid_ref')],
            },
        ),
        migrations.RunSQL(GUARDS, reverse_sql=REVERSE_GUARDS),
    ]
