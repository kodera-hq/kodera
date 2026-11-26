"""Offline SigV4 signatures, private gateway delegation and durable VIES outage recovery."""

import hashlib
import hmac
import io
import json
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qsl, quote, urlencode, urlsplit
from uuid import UUID

import pytest
from django.utils import timezone
from test_billing_orders import offer, place, world

from apps.billing import downloads, vies
from apps.billing.integrity import IntegrityRefusedError
from apps.billing.models import BillingProfile, ViesConsultation
from apps.media.storage import S3Credential, S3Location

ORG = UUID("00000000-0000-0000-0000-000000000001")
ARTIFACT = UUID("00000000-0000-0000-0000-000000000002")
NOW = datetime(2026, 11, 26, 12, tzinfo=UTC)


@pytest.fixture
def signer(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(
        "apps.media.outbound.target",
        lambda *args, **kwargs: SimpleNamespace(authority="objects.synthetic.invalid"),
    )
    return downloads.S3ArtifactDownloadSigner(
        location=S3Location("https://objects.synthetic.invalid", "synthetic-billing", "eu-west-1"),
        credential=S3Credential("synthetic-access", "synthetic-secret"),
        clock=lambda: NOW,
    )


@pytest.mark.parametrize(
    ("ttl", "expected"), [(-1, 60), (30, 60), (60, 60), (127, 127), (300, 300), (900, 300)]
)
@pytest.mark.parametrize("extension", ["pdf", "xml"])
def test_download_urls_are_tenant_scoped_bounded_and_have_valid_sigv4(
    signer, ttl, expected, extension
):
    url = signer.sign_object(
        organisation_id=ORG,
        artifact_id=ARTIFACT,
        number="KOD-2026-00001",
        format=extension,
        ttl_seconds=ttl,
    )
    parts = urlsplit(url)
    assert (
        parts.path
        == f"/synthetic-billing/organisations/{ORG}/billing-artifacts/{ARTIFACT}.{extension}"
    )
    params = dict(parse_qsl(parts.query))
    assert params["X-Amz-Expires"] == str(expected)
    assert params["response-cache-control"] == "private, no-store"
    assert (
        params["response-content-disposition"]
        == f'attachment; filename="KOD-2026-00001.{extension}"'
    )
    signature = params.pop("X-Amz-Signature")
    query = urlencode(sorted(params.items()), quote_via=quote, safe="-_.~")
    canonical = "\n".join(
        ("GET", parts.path, query, f"host:{parts.netloc}\n", "host", "UNSIGNED-PAYLOAD")
    )
    scope = params["X-Amz-Credential"].split("/", 1)[1]
    text = "\n".join(
        (
            "AWS4-HMAC-SHA256",
            params["X-Amz-Date"],
            scope,
            hashlib.sha256(canonical.encode()).hexdigest(),
        )
    )
    key = b"AWS4synthetic-secret"
    for item in ("20261126", "eu-west-1", "s3", "aws4_request"):
        key = hmac.new(key, item.encode(), hashlib.sha256).digest()
    assert hmac.new(key, text.encode(), hashlib.sha256).hexdigest() == signature


@pytest.mark.parametrize(
    "number", ['bad"\r\nHeader: value', "../invoice", "invoice/name", "", "a" * 300]
)
def test_download_filename_cannot_inject_headers_or_paths(signer, number):
    with pytest.raises(IntegrityRefusedError):
        signer.sign_object(organisation_id=ORG, artifact_id=ARTIFACT, number=number, format="pdf")


def test_s3_endpoint_must_be_https(signer):
    object.__setattr__(signer.location, "endpoint", "http://objects.synthetic.invalid")
    with pytest.raises(IntegrityRefusedError):
        downloads.S3ArtifactDownloadSigner(location=signer.location, credential=signer.credential)


@pytest.mark.parametrize("extension", ["pdf", "xml"])
def test_gateway_round_trip_uses_scoped_worker_signer_and_no_api_credential(
    signer, monkeypatch, extension
):
    monkeypatch.setattr(downloads, "_artifact_target", lambda artifact_id: (ORG, "KOD-2026-00001"))
    seen = []

    class Response(io.BytesIO):
        status = 200

    class Connection:
        def __init__(self, path):
            seen.append(path)

        def request(self, method, path, *, body, headers):
            seen.append(json.loads(body))
            self.result = downloads.billing_download_rpc(signer, body)

        def getresponse(self):
            return Response(self.result)

        def close(self):
            pass

    monkeypatch.setattr(downloads, "_Connection", Connection)
    gateway = downloads.GatewayBillingDownloadSigner("/synthetic/private.sock", clock=lambda: NOW)
    url = gateway.sign(
        artifact_id=ARTIFACT, format=extension, expires_at=NOW + timedelta(seconds=120)
    )
    assert dict(parse_qsl(urlsplit(url).query))["X-Amz-Expires"] == "120"
    assert seen[1]["operation"] == "billing_download"
    assert set(vars(gateway)) == {"path", "clock"}
    seen[1]["object"]["organisationId"] = str(ARTIFACT)
    with pytest.raises(IntegrityRefusedError):
        downloads.billing_download_rpc(signer, json.dumps(seen[1]).encode())


def outage(body):
    raise TimeoutError("synthetic private response must not be stored")


def valid(body, now):
    decoded = json.loads(body)
    return 200, json.dumps(
        {
            "countryCode": decoded["countryCode"],
            "vatNumber": decoded["vatNumber"],
            "valid": True,
            "requestDate": now.isoformat(),
            "requestIdentifier": "synthetic-proof",
        }
    ).encode()


@pytest.mark.django_db(transaction=True)
def test_unexpired_proof_returns_without_network_or_new_rows_and_allows_eu_order():
    w = world(country="DE", vat_number="DE000000000")
    proof = vies.record_consultation(
        organisation_id=w.organisation.id,
        country_code="DE",
        vat_number="DE000000000",
        answer=vies.Answer("valid", "synthetic-proof", {}, hashlib.sha256(b"proof").hexdigest()),
    )
    before = BillingProfile.objects.get(organisation_id=w.organisation.id).vat_number_validated_at
    row = vies.consult_with_proof_cache(
        organisation_id=w.organisation.id,
        country_code="DE",
        vat_number="DE000000000",
        opener=lambda _: pytest.fail("cached proof contacted VIES"),
    )
    assert row.id == proof.id
    assert ViesConsultation.objects.count() == 1
    assert (
        BillingProfile.objects.get(organisation_id=w.organisation.id).vat_number_validated_at
        == before
    )
    assert vies.retry_due_consultations(opener=outage) == []
    assert place(w, offer()).invoice.vat_regime == "eu_reverse_charge"


@pytest.mark.django_db(transaction=True)
def test_domestic_orders_survive_eu_vies_outages():
    w = world(vat_number="FR00000000000")
    row = vies.consult_with_proof_cache(
        organisation_id=w.organisation.id,
        country_code="FR",
        vat_number="FR00000000000",
        opener=outage,
    )
    assert row.status == "unavailable"
    assert place(w, offer()).invoice.vat_regime == "fr_standard"
    assert (
        vies.retry_due_consultations(
            opener=lambda _: pytest.fail("domestic refresh contacted VIES"),
            clock=lambda: row.next_check_at + timedelta(seconds=1),
        )
        == []
    )


@pytest.mark.django_db(transaction=True)
def test_outages_back_off_and_recovery_replaces_retry_state():
    w = world(country="DE", vat_number="DE000000000")
    now = timezone.now()
    row = vies.consult_with_proof_cache(
        organisation_id=w.organisation.id,
        country_code="DE",
        vat_number="DE000000000",
        opener=outage,
        clock=lambda: now,
    )
    for attempt, minutes in enumerate((15, 30, 60, 120, 240, 240), start=1):
        assert row.status == "unavailable"
        assert row.evidence == {"outcome": "unavailable", "retry_attempt": min(5, attempt)}
        assert row.next_check_at - row.checked_at == timedelta(minutes=minutes)
        assert (
            vies.retry_due_consultations(
                clock=lambda row=row: row.next_check_at - timedelta(seconds=1),
                opener=lambda _: pytest.fail("retried before due"),
            )
            == []
        )
        now = row.next_check_at
        rows = vies.retry_due_consultations(limit=1, opener=outage, clock=lambda now=now: now)
        assert len(rows) == 1
        row = rows[0]
    now = row.next_check_at
    recovered = vies.retry_due_consultations(
        opener=lambda body: valid(body, now), clock=lambda: now
    )[0]
    assert recovered.status == "valid"
    assert "retry_attempt" not in recovered.evidence
    assert recovered.next_check_at - recovered.checked_at == vies.VALID_FOR
    assert (
        BillingProfile.objects.get(organisation_id=w.organisation.id).vat_number_validated_at == now
    )


@pytest.mark.django_db(transaction=True)
def test_profile_change_does_not_retry_obsolete_vat_identity():
    w = world(country="DE", vat_number="DE000000000")
    row = vies.consult_with_proof_cache(
        organisation_id=w.organisation.id,
        country_code="DE",
        vat_number="DE000000000",
        opener=outage,
    )
    BillingProfile.objects.filter(organisation_id=w.organisation.id).update(
        vat_number="DE000000001"
    )
    assert (
        vies.retry_due_consultations(
            opener=lambda _: pytest.fail("obsolete VAT was contacted"),
            clock=lambda: row.next_check_at,
        )
        == []
    )
    with pytest.raises(vies.ViesRefusedError, match="billing_profile_changed"):
        vies.consult_with_proof_cache(
            organisation_id=w.organisation.id,
            country_code="DE",
            vat_number="DE000000000",
            opener=outage,
        )


@pytest.mark.parametrize("limit", [0, -1, 501, True])
def test_retry_work_is_bounded(limit):
    with pytest.raises(vies.ViesRefusedError):
        vies.retry_due_consultations(limit=limit)


def test_retry_command_passes_bounded_limit_and_reports_count(monkeypatch):
    from django.core.management import call_command

    from apps.billing.management.commands import retry_vies_consultations as command

    seen = []
    monkeypatch.setattr(command, "require_operator_profile", lambda: None)
    monkeypatch.setattr(vies, "retry_due_consultations", lambda **kwargs: seen.append(kwargs) or [])
    output = io.StringIO()
    call_command("retry_vies_consultations", limit=7, stdout=output)
    assert seen == [{"limit": 7}]
    assert "processed: 0" in output.getvalue()


@pytest.mark.parametrize("path", ["relative.sock", "/bad\x00.sock", "/" + "s" * 103])
def test_gateway_refuses_invalid_socket_paths(path):
    with pytest.raises(IntegrityRefusedError, match="billing_gateway_socket_invalid"):
        downloads.GatewayBillingDownloadSigner(path)


@pytest.mark.parametrize("value", [None, 12, {}, []])
def test_worker_rejects_nonstring_uuids(signer, value):
    request = {
        "operation": "billing_download",
        "object": {
            "organisationId": value,
            "artifactId": str(ARTIFACT),
            "number": "KOD-2026-00001",
            "format": "pdf",
            "ttl": 120,
        },
    }
    with pytest.raises(IntegrityRefusedError, match="billing_gateway_refused"):
        downloads.billing_download_rpc(signer, json.dumps(request).encode())


@pytest.mark.django_db(transaction=True)
def test_media_socket_alone_does_not_enable_billing_downloads(settings):
    from test_billing_evidence_persistence import SyntheticRenderer, SyntheticValidator

    from apps.billing.artifacts import publish
    from apps.billing.selectors import InvoicePdfNotRenderedError

    w = world()
    invoice = place(w, offer()).invoice
    publish(
        document_id=invoice.id,
        credit_note=False,
        renderer=SyntheticRenderer(),
        validator=SyntheticValidator(),
        validator_ref="test",
    )
    settings.KODERA_MEDIA_GATEWAY_SOCKET = "/synthetic/media.sock"
    settings.KODERA_BILLING_GATEWAY_SOCKET = None
    settings.KODERA_BILLING_DOWNLOAD_SIGNER = None
    with pytest.raises(InvoicePdfNotRenderedError):
        downloads.link(
            organisation_id=w.organisation.id,
            document_id=invoice.id,
            credit_note=False,
            format="pdf",
        )


@pytest.mark.django_db(transaction=True)
def test_vies_network_has_no_transaction_and_racing_valid_proof_survives_outage():
    from django.db import connection

    w = world(country="DE", vat_number="DE000000000")
    now = timezone.now()
    proofs = []

    def racing_transport(body):
        assert not connection.in_atomic_block
        proofs.append(
            vies.record_consultation(
                organisation_id=w.organisation.id,
                country_code="DE",
                vat_number="DE000000000",
                answer=vies.Answer("valid", "proof", {}, hashlib.sha256(b"proof").hexdigest()),
                clock=lambda: now,
            )
        )
        return outage(body)

    row = vies.consult_with_proof_cache(
        organisation_id=w.organisation.id,
        country_code="DE",
        vat_number="DE000000000",
        opener=racing_transport,
        clock=lambda: now,
    )
    assert row.id == proofs[0].id
    assert ViesConsultation.objects.count() == 1


@pytest.mark.django_db(transaction=True)
def test_vies_rechecks_identity_after_unlocked_network_call():
    w = world(country="DE", vat_number="DE000000000")

    def changed(body):
        BillingProfile.objects.filter(organisation_id=w.organisation.id).update(
            vat_number="DE000000001"
        )
        return outage(body)

    with pytest.raises(vies.ViesRefusedError, match="billing_profile_changed"):
        vies.consult_with_proof_cache(
            organisation_id=w.organisation.id,
            country_code="DE",
            vat_number="DE000000000",
            opener=changed,
        )
    assert not ViesConsultation.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_vies_timestamp_is_monotonic_and_future_valid_proof_is_cached():
    w = world(country="DE", vat_number="DE000000000")
    now = timezone.now()
    first = vies.record_consultation(
        organisation_id=w.organisation.id,
        country_code="DE",
        vat_number="DE000000000",
        answer=vies.Answer("invalid", "proof", {}, hashlib.sha256(b"proof").hexdigest()),
        clock=lambda: now,
    )
    second = vies.record_consultation(
        organisation_id=w.organisation.id,
        country_code="DE",
        vat_number="DE000000000",
        answer=vies.Answer("valid", "proof", {}, hashlib.sha256(b"proof").hexdigest()),
        clock=lambda: now,
    )
    assert second.checked_at == first.checked_at + timedelta(microseconds=1)
    assert (
        vies.consult_with_proof_cache(
            organisation_id=w.organisation.id,
            country_code="DE",
            vat_number="DE000000000",
            opener=lambda _: pytest.fail("cached future proof contacted VIES"),
            clock=lambda: now,
        ).id
        == second.id
    )


@pytest.mark.django_db(transaction=True)
def test_vies_uses_env_issuer_when_operator_has_no_settings_issuer(settings, monkeypatch):
    settings.KODERA_BILLING_ISSUER = None
    settings.KODERA_INVOICE_SERIES = "KOD"
    issuer = {
        "NAME": "Test Seller",
        "ADDRESS": "1 sample street",
        "POSTAL_CODE": "75000",
        "CITY": "Paris",
        "COUNTRY": "FR",
        "SIREN": "123456782",
        "VAT_NUMBER": "FR11123456782",
    }
    for key, value in issuer.items():
        monkeypatch.setenv("SAMOURAI_BILLING_ISSUER_" + key, value)
    w = world(country="DE", vat_number="DE000000000")
    now = timezone.now()

    def check_request(body):
        assert json.loads(body)["requesterNumber"] == "11123456782"
        return valid(body, now)

    assert (
        vies.consult_with_proof_cache(
            organisation_id=w.organisation.id,
            country_code="DE",
            vat_number="DE000000000",
            opener=check_request,
            clock=lambda: now,
        ).status
        == "valid"
    )


@pytest.mark.parametrize("change", ["prefix", "port", "cache"])
def test_gateway_refuses_unscoped_or_insecure_worker_url(signer, monkeypatch, change):
    monkeypatch.setattr(downloads, "_artifact_target", lambda _: (ORG, "KOD-2026-00001"))
    url = signer.sign_object(
        organisation_id=ORG,
        artifact_id=ARTIFACT,
        number="KOD-2026-00001",
        format="pdf",
        ttl_seconds=120,
    )
    if change == "prefix":
        url = url.replace("/synthetic-billing/", "/untrusted/prefix/")
    elif change == "port":
        url = url.replace("objects.synthetic.invalid", "objects.synthetic.invalid:444")
    else:
        url = url.replace("private%2C%20no-store", "public")

    class Response(io.BytesIO):
        status = 200

    class Connection:
        def __init__(self, _):
            pass

        def request(self, *args, **kwargs):
            pass

        def getresponse(self):
            return Response(json.dumps({"url": url}).encode())

        def close(self):
            pass

    monkeypatch.setattr(downloads, "_Connection", Connection)
    with pytest.raises(IntegrityRefusedError, match="billing_gateway_refused"):
        downloads.GatewayBillingDownloadSigner("/synthetic/private.sock", clock=lambda: NOW).sign(
            artifact_id=ARTIFACT, format="pdf", expires_at=NOW + timedelta(seconds=120)
        )


def test_s3_signer_returns_exact_host_used_in_canonical_signature(signer, monkeypatch):
    original = downloads.presign

    def different_authority(*args, **kwargs):
        url, headers = original(*args, **kwargs)
        return url.replace("objects.synthetic.invalid", "worker.synthetic.invalid"), headers

    monkeypatch.setattr(downloads, "presign", different_authority)
    url = signer.sign_object(
        organisation_id=ORG, artifact_id=ARTIFACT, number="KOD-2026-00001", format="pdf"
    )
    assert urlsplit(url).hostname == "worker.synthetic.invalid"
