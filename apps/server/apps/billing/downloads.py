"""Short-lived object-store document signing port; the API holds no storage credential."""

from datetime import datetime, timedelta
from typing import Protocol
from urllib.parse import urlsplit
from uuid import UUID

from django.conf import settings
from django.utils import timezone

from .artifacts import verify_artifact
from .integrity import IntegrityRefusedError
from .models import BillingArtifact, CreditNote, Invoice
from .selectors import InvoicePdfNotRenderedError


class DownloadSigner(Protocol):
    def sign(self, *, artifact_id: UUID, format: str, expires_at: datetime) -> str:
        """Sign the validated worker-published object; no API infrastructure credential."""
        ...


def link(
    *, organisation_id: UUID, document_id: UUID, credit_note: bool, format: str
) -> dict[str, object]:
    if format not in {"pdf", "xml"}:
        raise IntegrityRefusedError("billing_download_format")
    prefix = "credit_note" if credit_note else "invoice"
    row = BillingArtifact.objects.filter(
        **{prefix + "_id": document_id, prefix + "__organisation_id": organisation_id}
    ).first()
    if row is None:
        model = CreditNote if credit_note else Invoice
        if model.objects.filter(
            id=document_id, organisation_id=organisation_id, pdf_ref__isnull=False
        ).exists():
            raise IntegrityRefusedError("billing_artifact_missing")
        raise InvoicePdfNotRenderedError()
    verify_artifact(row)
    signer: DownloadSigner | None = getattr(settings, "KODERA_BILLING_DOWNLOAD_SIGNER", None)
    if signer is None:
        raise InvoicePdfNotRenderedError()
    expires = timezone.now() + timedelta(minutes=5)
    url = signer.sign(artifact_id=row.id, format=format, expires_at=expires)
    parts = urlsplit(url)
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.fragment
        or any(ord(c) < 33 for c in url)
        or len(url) > 8192
    ):
        raise IntegrityRefusedError("billing_download_signer_url_invalid")
    document = row.credit_note if credit_note else row.invoice
    if document is None:
        raise IntegrityRefusedError("billing_artifact_parent_missing")
    return {
        "url": url,
        "expires_at": expires.isoformat(),
        "content_type": "application/pdf" if format == "pdf" else "application/xml",
        "filename": f"{document.number}.{format}",
        "sha256": row.pdf_sha256 if format == "pdf" else row.xml_sha256,
        "size_bytes": len(row.pdf if format == "pdf" else row.xml),
    }
