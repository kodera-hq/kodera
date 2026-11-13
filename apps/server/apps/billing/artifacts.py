"""Publish validated document pairs once, and verify bytes against frozen accounting snapshots."""

import hashlib
from uuid import UUID

from django.db import transaction

from .documents import Renderer, Validator, render_facturx, snapshot_of
from .integrity import IntegrityRefusedError
from .models import BillingArtifact, CreditNote, Invoice


def verify_artifact(row: BillingArtifact) -> None:
    document = row.invoice if row.invoice_id is not None else row.credit_note
    if (
        document is None
        or snapshot_of(document).sha256 != row.snapshot_sha256
        or hashlib.sha256(bytes(row.pdf)).hexdigest() != row.pdf_sha256
        or hashlib.sha256(bytes(row.xml)).hexdigest() != row.xml_sha256
    ):
        raise IntegrityRefusedError("billing_artifact_digest_mismatch")


def publish(
    *,
    document_id: UUID,
    credit_note: bool,
    renderer: Renderer | None,
    validator: Validator | None,
    validator_ref: str,
) -> BillingArtifact:
    if (
        not isinstance(validator_ref, str)
        or not 1 <= len(validator_ref) <= 200
        or not validator_ref.isprintable()
    ):
        raise IntegrityRefusedError("billing_validator_reference_required")
    model = CreditNote if credit_note else Invoice
    key = "credit_note_id" if credit_note else "invoice_id"
    # The row lock serializes publication, with all frozen source fields read in that transaction.
    # Renderer and validator run locally: these ports must never call a remote customer service.
    with transaction.atomic():
        row = model.objects.select_for_update().get(id=document_id)
        existing = BillingArtifact.objects.filter(**{key: row.id}).first()
        if existing is not None:
            verify_artifact(existing)
            return existing
        snapshot = snapshot_of(row)
        pdf, xml = render_facturx(snapshot, renderer=renderer, validator=validator)
        artifact = BillingArtifact.objects.create(
            **{key: row.id},
            snapshot_sha256=snapshot.sha256,
            pdf_sha256=hashlib.sha256(pdf).hexdigest(),
            xml_sha256=hashlib.sha256(xml).hexdigest(),
            pdf=pdf,
            xml=xml,
            validator_ref=validator_ref,
        )
        row.pdf_ref = f"urn:kodera:billing-artifact:{artifact.id}"
        row.save(update_fields=["pdf_ref", "updated_at"])
        return artifact


def metadata(row: Invoice | CreditNote) -> dict[str, object]:
    key = "invoice_id" if isinstance(row, Invoice) else "credit_note_id"
    artifact = BillingArtifact.objects.filter(**{key: row.id}).first()
    if artifact is None:
        return {
            "facturx_type_code": "380" if isinstance(row, Invoice) else "381",
            "xml_available": False,
        }
    verify_artifact(artifact)
    return {
        "facturx_type_code": "380" if isinstance(row, Invoice) else "381",
        "xml_available": True,
        "snapshot_sha256": artifact.snapshot_sha256,
        "artifacts": {
            kind: {
                "sha256": digest,
                "size_bytes": len(payload),
                "content_type": content_type,
                "filename": f"{row.number}.{kind}",
            }
            for kind, digest, payload, content_type in (
                ("pdf", artifact.pdf_sha256, artifact.pdf, "application/pdf"),
                ("xml", artifact.xml_sha256, artifact.xml, "application/xml"),
            )
        },
    }
