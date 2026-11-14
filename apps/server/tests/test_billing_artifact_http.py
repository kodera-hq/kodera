"""Validated storage fixtures qualify HTTP scoping/signing, without PDF/A conformance claims."""

import pytest
from customer_http_fixtures import http_signer as http_signer
from test_access_tokens import frozen_clock as frozen_clock
from test_billing_evidence_persistence import SyntheticRenderer, SyntheticValidator
from test_billing_http import placed as placed
from test_workspace_onboarding import call, w as w

from apps.audit.models import AuditEvent
from apps.billing.artifacts import publish

pytestmark = pytest.mark.django_db(transaction=True)
DOWNLOAD = "/invoices/{invoice_id}/download"


def test_xml_download_is_signed_scoped_and_audited_without_api_storage_credential(
    w, placed, settings
):
    artifact = publish(
        document_id=placed.invoice.id,
        credit_note=False,
        renderer=SyntheticRenderer(),
        validator=SyntheticValidator(),
        validator_ref="synthetic-storage-test-not-conformance",
    )
    signed = []

    class Signer:
        def sign(self, **kwargs):
            signed.append(kwargs)
            return "https://objects.synthetic.invalid/invoice.xml?signature=synthetic"

    settings.KODERA_BILLING_DOWNLOAD_SIGNER = Signer()
    response = call(
        w.client.get(
            f"/api/v1/invoices/{placed.invoice.id}/download?format=xml",
            HTTP_AUTHORIZATION="Bearer " + w.owner.credential,
        ),
        DOWNLOAD,
        "get",
    )
    assert response.status_code == 200, response.content
    assert response.json()["content_type"] == "application/xml"
    assert response.json()["sha256"] == artifact.xml_sha256
    assert response.json()["size_bytes"] == len(artifact.xml)
    assert signed[0]["artifact_id"] == artifact.id
    assert (
        AuditEvent.objects.filter(
            action="invoice.download_requested", organisation_id=w.alpha.id
        ).count()
        == 1
    )
    refused = w.client.get(
        f"/api/v1/invoices/{placed.invoice.id}/download?format=xml",
        HTTP_AUTHORIZATION="Bearer " + w.foreigner.credential,
    )
    assert refused.status_code == 404
    assert len(signed) == 1


def test_unknown_or_duplicate_document_format_is_refused(w, placed):
    for query in ("format=html", "format=pdf&format=xml", "unexpected=xml"):
        response = call(
            w.client.get(
                f"/api/v1/invoices/{placed.invoice.id}/download?{query}",
                HTTP_AUTHORIZATION="Bearer " + w.owner.credential,
            ),
            DOWNLOAD,
            "get",
        )
        assert response.status_code == 400
