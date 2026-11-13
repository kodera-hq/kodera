"""PostgreSQL proves recorded-VIES issue fences and immutable validated-artifact storage."""

import hashlib

import pytest
from django.db import IntegrityError, connection, transaction
from django.utils import timezone
from test_billing_orders import offer, place, world

from apps.billing.artifacts import publish, verify_artifact
from apps.billing.documents import FacturXUnavailableError, snapshot_of
from apps.billing.integrity import IntegrityRefusedError, verify_database_series
from apps.billing.models import BillingArtifact, BillingProfile, Invoice, ViesConsultation
from apps.billing.services import BillingValidationError, _regime
from apps.billing.vies import Answer, record_consultation, vat_status

pytestmark = pytest.mark.django_db(transaction=True)


def evidence(w, status="valid"):
    return record_consultation(
        organisation_id=w.organisation.id,
        country_code="DE",
        vat_number="DE000000000",
        answer=Answer(
            status,
            None if status == "unavailable" else "synthetic-consultation",
            {"outcome": status},
            hashlib.sha256(status.encode()).hexdigest(),
        ),
    )


def test_unavailable_vies_is_persisted_and_holds_new_issue_without_zero_vat_fallback():
    w = world(country="DE", vat_number="DE000000000", vat_number_validated_at=timezone.now())
    row = evidence(w, "unavailable")
    assert row.status == "unavailable"
    assert (
        BillingProfile.objects.get(organisation_id=w.organisation.id).vat_number_validated_at
        is None
    )
    assert vat_status(w.organisation.id)["status"] == "unavailable"
    with pytest.raises(BillingValidationError, match="vies_evidence_required"):
        place(w, offer())
    assert not Invoice.objects.exists()


def test_current_recorded_evidence_allows_reverse_charge_and_cannot_be_rewritten():
    w = world(country="DE", vat_number="DE000000000")
    row = evidence(w)
    placed = place(w, offer())
    assert placed.invoice.vat_regime == "eu_reverse_charge"
    assert placed.invoice.vat_amount_minor == 0
    for query in (
        lambda: ViesConsultation.objects.filter(id=row.id).update(status="invalid"),
        lambda: row.delete(),
    ):
        with (
            pytest.raises(IntegrityError, match="Billing evidence is append-only"),
            transaction.atomic(),
        ):
            query()
    verify_database_series()


def test_later_unavailable_consultation_revokes_previous_valid_claim():
    w = world(country="DE", vat_number="DE000000000")
    evidence(w)
    evidence(w, "unavailable")
    with pytest.raises(BillingValidationError, match="vies_evidence_required"):
        _regime(BillingProfile.objects.get(organisation_id=w.organisation.id))


def test_database_itself_refuses_a_reverse_charge_issue_without_recorded_evidence():
    w = world(country="DE", vat_number="DE000000000")
    row = evidence(w)
    with (
        pytest.raises(IntegrityError, match="current recorded VIES evidence"),
        transaction.atomic(),
    ):
        # Mutate the check's validity in the issuing transaction, bypassing the service's guard.
        with connection.cursor() as cursor:
            cursor.execute(
                "ALTER TABLE billing_viesconsultation DISABLE TRIGGER billing_vies_immutable"
            )
            cursor.execute(
                "UPDATE billing_viesconsultation SET status='unavailable' WHERE id=%s", [row.id]
            )
            cursor.execute(
                "ALTER TABLE billing_viesconsultation ENABLE TRIGGER billing_vies_immutable"
            )
        from unittest.mock import patch

        from apps.billing.vat import REGIMES

        with patch("apps.billing.services._regime", return_value=REGIMES["eu_reverse_charge"]):
            place(w, offer())
    assert not Invoice.objects.exists()


def test_unconfigured_renderer_cannot_write_a_pdf_reference_or_artifact():
    w = world()
    placed = place(w, offer())
    with pytest.raises(FacturXUnavailableError, match="independent conformance"):
        publish(
            document_id=placed.invoice.id,
            credit_note=False,
            renderer=None,
            validator=None,
            validator_ref="unconfigured",
        )
    assert not BillingArtifact.objects.exists()
    placed.invoice.refresh_from_db()
    assert placed.invoice.pdf_ref is None


class SyntheticRenderer:
    """Tests storage only; this deliberately makes no PDF/A conformance claim."""

    def render(self, snapshot, xml):
        return b"%PDF-synthetic-storage-fixture\n" + snapshot.sha256.encode()


class SyntheticValidator:
    def validate(self, **kwargs):
        assert kwargs["pdf"].startswith(b"%PDF-synthetic-storage-fixture")


def test_artifact_publication_is_idempotent_and_digest_mutations_are_refused():
    w = world()
    placed = place(w, offer())
    kwargs = dict(
        document_id=placed.invoice.id,
        credit_note=False,
        renderer=SyntheticRenderer(),
        validator=SyntheticValidator(),
        validator_ref="synthetic-storage-fixture-not-conformance",
    )
    artifact = publish(**kwargs)
    assert publish(**kwargs).id == artifact.id
    verify_artifact(artifact)
    artifact.xml = b"corrupted"
    with pytest.raises(IntegrityRefusedError, match="billing_artifact_digest_mismatch"):
        verify_artifact(artifact)
    with (
        pytest.raises(IntegrityError, match="Billing evidence is append-only"),
        transaction.atomic(),
    ):
        BillingArtifact.objects.filter(id=artifact.id).update(xml=b"corrupted")
    placed.invoice.refresh_from_db()
    assert placed.invoice.pdf_ref == f"urn:kodera:billing-artifact:{artifact.id}"
    assert artifact.snapshot_sha256 == snapshot_of(placed.invoice).sha256


def test_artifact_insert_refuses_mismatched_digest_even_when_service_is_bypassed():
    w = world()
    placed = place(w, offer())
    with pytest.raises(IntegrityError, match="matching digests"), transaction.atomic():
        BillingArtifact.objects.create(
            invoice=placed.invoice,
            snapshot_sha256="0" * 64,
            pdf_sha256="0" * 64,
            xml_sha256="0" * 64,
            pdf=b"%PDF-invalid",
            xml=b"invalid",
            validator_ref="synthetic",
        )
