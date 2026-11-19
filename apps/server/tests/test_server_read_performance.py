"""Issuer routing and empty-application status parity without external services."""

import base64
import json
from dataclasses import replace
from types import SimpleNamespace
from uuid import uuid4

import pytest
from django.utils import timezone
from test_access_tokens import (
    claims,
    frozen_clock as frozen_clock,
    sign,
    signer as signer,
    snapshot,
)

from apps.billing import tenant_reads
from services.identity import trusted_issuers
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import TrustedIssuer


@pytest.mark.parametrize("position", [0, 7])
def test_issuer_routing_verifies_only_the_matching_snapshot(signer, monkeypatch, position):
    admitted = snapshot([signer[2]])
    entries = [
        TrustedIssuer(
            "customer", replace(admitted, issuer=f"https://issuer-{i}.test/"), ("console",)
        )
        for i in range(8)
    ]
    entries[position] = TrustedIssuer("customer", admitted, ("console",))
    calls = []
    real = trusted_issuers.verify_access_token

    def verify(compact, *, admitted):
        calls.append(admitted.issuer)
        return real(compact, admitted=admitted)

    monkeypatch.setattr(trusted_issuers, "verify_access_token", verify)
    verified, lane = trusted_issuers.verify_configured_token(sign(signer), trusted=tuple(entries))
    assert lane == "customer" and verified.issuer == admitted.issuer
    assert calls == [admitted.issuer]


@pytest.mark.parametrize("issuer", ["https://unknown.test/", None, [], {"nested": "issuer"}])
def test_untrusted_or_invalid_issuer_never_reaches_signature_verification(
    signer, monkeypatch, issuer
):
    def unexpected(*args, **kwargs):
        raise AssertionError("an unmatched issuer reached signature verification")

    monkeypatch.setattr(trusted_issuers, "verify_access_token", unexpected)
    parts = sign(signer).split(".")
    parts[1] = (
        base64.urlsafe_b64encode(json.dumps(claims(iss=issuer)).encode()).rstrip(b"=").decode()
    )
    with pytest.raises(TokenVerificationError):
        trusted_issuers.verify_configured_token(
            ".".join(parts),
            trusted=(TrustedIssuer("customer", snapshot([signer[2]]), ("console",)),),
        )


@pytest.mark.parametrize(
    "status,overall",
    [
        ("ordered", "maintenance"),
        ("provisioning", "maintenance"),
        ("ready", "operational"),
        ("active", "operational"),
        ("maintenance", "maintenance"),
        ("failed", "major_outage"),
        ("suspended", "major_outage"),
    ],
)
def test_empty_community_application_list_preserves_pending_and_failure_status(
    monkeypatch, settings, status, overall
):
    row = SimpleNamespace(
        id=uuid4(),
        organisation_id=uuid4(),
        status=status,
        apps=[],
        slug="community",
        is_default_community=True,
        status_changed_at=timezone.now(),
    )
    settings.KODERA_TENANT_APP_URLS = {}
    monkeypatch.setattr(tenant_reads.tenancy, "tenant_of", lambda **kwargs: row)
    monkeypatch.setattr(tenant_reads.tenancy, "newest_tenant_not_deleted", lambda _: row)
    monkeypatch.setattr(tenant_reads, "last_heartbeat", lambda **kwargs: None)
    monkeypatch.setattr(tenant_reads, "dunning", lambda _: ("current", None))
    detail = tenant_reads.tenant_status(row.organisation_id, row.id)
    summary = tenant_reads.status_summary(row.organisation_id)
    assert detail["apps"] == [] and detail["status"] == status
    assert summary["tenant_id"] == detail["tenant_id"] and summary["overall"] == overall


@pytest.mark.parametrize("exists", [True, False])
def test_staff_community_prepares_membership_only_when_the_current_read_misses(monkeypatch, exists):
    from apps.identity import services
    from apps.orgs import community

    principal = SimpleNamespace(
        id=uuid4(),
        user_id=uuid4(),
        user=object(),
        issuer="https://staff.test/",
        realm="community",
        subject="staff",
        email="staff@example.test",
    )
    member = SimpleNamespace(organisation_id=uuid4())
    reads, preparations = [], []

    def current(**kwargs):
        reads.append(1)
        return (principal, member) if exists or len(reads) > 1 else None

    monkeypatch.setattr(community, "configured_slug", lambda: "community")
    monkeypatch.setattr(community, "community_member", current)
    monkeypatch.setattr(
        community, "ensure_community_membership", lambda **kwargs: preparations.append(1)
    )
    monkeypatch.setattr(services, "person_memberships", lambda **kwargs: ())
    result = services.read_staff_community(verified=SimpleNamespace(amr=None))
    assert result.current_identity_id == principal.id
    assert len(reads) == (1 if exists else 2) and len(preparations) == (0 if exists else 1)
