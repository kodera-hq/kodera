"""Shared pytest fixtures, OIDC Bearer principal factory, and isolation hooks for `ee/tests/`.

All cryptographic keys are generated dynamically in memory at test runtime (never committed).
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import jwt
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import NameOID

from ee.audit_export.ledger import default_audit_ledger
from ee.saml.service import default_saml_service
from ee.scim.service import default_scim_service


@dataclass(frozen=True, slots=True)
class ProvisionedTestPrincipal:
    organisation_id: UUID
    tenant_slug: str
    user_id: UUID
    identity_id: UUID
    membership_id: UUID
    role: str
    email: str
    issuer: str
    subject: str
    token: str

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}


@pytest.fixture(autouse=True)
def _reset_ee_singletons() -> Iterator[None]:
    """Guarantee deterministic isolation under `pytest-randomly` across every test."""
    default_saml_service.reset()
    default_scim_service.reset()
    default_audit_ledger.reset()
    yield
    default_saml_service.reset()
    default_scim_service.reset()
    default_audit_ledger.reset()


@pytest.fixture(scope="session")
def rsa_idp_keypair() -> tuple[rsa.RSAPrivateKey, str, str]:
    """Generate an ephemeral 2048-bit RSA IdP keypair, SPKI PEM, and self-signed X.509 cert PEM."""
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub_pem = (
        priv.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode("ascii")
    )
    now = datetime.now(UTC)
    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "idp.acme-corp.test")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(priv.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=30))
        .sign(priv, hashes.SHA256())
    )
    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode("ascii")
    return priv, pub_pem, cert_pem


@pytest.fixture(scope="session")
def ecdsa_idp_keypair() -> tuple[ec.EllipticCurvePrivateKey, str]:
    """Generate an ephemeral NIST P-256 ECDSA IdP keypair and SPKI PEM."""
    priv = ec.generate_private_key(ec.SECP256R1())
    pub_pem = (
        priv.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode("ascii")
    )
    return priv, pub_pem


@pytest.fixture(scope="session")
def oidc_signing_keys() -> tuple[rsa.RSAPrivateKey, rsa.RSAPrivateKey, dict[str, Any]]:
    """Generate ephemeral trusted & untrusted RS256 OIDC keys for Kodera Bearer token tests."""
    trusted_priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    stranger_priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub_jwk: dict[str, Any] = json.loads(
        jwt.algorithms.RSAAlgorithm.to_jwk(trusted_priv.public_key())
    )
    pub_jwk.update(kid="ee-test-oidc-k1", alg="RS256", use="sig", key_ops=["verify"])
    return trusted_priv, stranger_priv, pub_jwk


@pytest.fixture
def tenant_principal_factory(
    monkeypatch: pytest.MonkeyPatch,
    oidc_signing_keys: tuple[rsa.RSAPrivateKey, rsa.RSAPrivateKey, dict[str, Any]],
) -> Callable[..., ProvisionedTestPrincipal]:
    """Provision real PostgreSQL `Organisation` + `Identity` + `Membership` + trusted RS256 JWT."""
    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership, Organisation, SlugReservation
    from django.conf import settings
    from django.db import transaction
    from django.utils import timezone

    from services.identity.trusted_issuers import load_trust

    trusted_priv, stranger_priv, pub_jwk = oidc_signing_keys
    trust_entries: list[dict[str, Any]] = []

    def _register_issuer(issuer: str, lane: str = "customer") -> None:
        if any(item["issuer"] == issuer for item in trust_entries):
            return
        trust_entries.append(
            {
                "lane": lane,
                "issuer": issuer,
                "generation": "ee-test-oidc-k1",
                "expires_at": int(time.time()) + 86400 * 30,
                "public_jwks": {"keys": [pub_jwk]},
            }
        )
        monkeypatch.setattr(
            settings,
            "KODERA_AUTH_TRUST",
            load_trust(json.dumps(trust_entries)),
            raising=False,
        )

    def _create(
        tenant_slug: str = "acme-corp",
        *,
        role: str = "org_owner",
        email: str | None = None,
        subject: str | None = None,
        membership_state: str = "active",
        lane: str = "customer",
        sign_with_stranger: bool = False,
        provision_identity: bool = True,
    ) -> ProvisionedTestPrincipal:
        issuer = (
            "https://sso.kodera.test/realms/kodera-staff"
            if lane == "staff"
            else f"https://sso.kodera.test/realms/{tenant_slug}"
        )
        _register_issuer(issuer, lane=lane)
        if lane == "staff":
            monkeypatch.setattr(settings, "KODERA_STAFF_ISSUER", issuer, raising=False)

        resolved_subject = subject or f"sub-{uuid4().hex[:16]}"
        resolved_email = email or f"{resolved_subject}@{tenant_slug}.test"

        with transaction.atomic():
            org = Organisation.objects.filter(slug=tenant_slug, deleted_at__isnull=True).first()
            if org is None:
                org = Organisation.objects.create(
                    slug=tenant_slug,
                    name=f"{tenant_slug} SAS",
                    realm=tenant_slug,
                    issuer=f"https://sso.kodera.test/realms/{tenant_slug}",
                    state=Organisation.State.ACTIVE,
                )
                SlugReservation.objects.create(
                    organisation=org,
                    slug=org.slug,
                    namespace="organisation",
                    state="permanent",
                    protected_at=timezone.now(),
                )
                will_be_active_owner = (
                    provision_identity
                    and lane == "customer"
                    and role == Membership.Role.OWNER
                    and membership_state == Membership.State.ACTIVE
                )
                if not will_be_active_owner:
                    boot_sub = f"boot-owner-{uuid4().hex[:12]}"
                    boot_email = f"{boot_sub}@{tenant_slug}.test"
                    boot_user = User.objects.create(
                        email=boot_email,
                        display_name="Bootstrap Owner",
                        enabled=True,
                    )
                    Identity.objects.create(
                        user=boot_user,
                        organisation=org,
                        realm=org.realm,
                        issuer=org.issuer,
                        subject=boot_sub,
                        email=boot_email,
                        enabled=True,
                    )
                    Membership.objects.create(
                        organisation=org,
                        user=boot_user,
                        role=Membership.Role.OWNER,
                        state=Membership.State.ACTIVE,
                        accepted_at=timezone.now(),
                    )

            if provision_identity and lane == "customer":
                user = User.objects.create(
                    email=resolved_email,
                    display_name="Enterprise Test Principal",
                    enabled=True,
                )
                identity = Identity.objects.create(
                    user=user,
                    organisation=org,
                    realm=org.realm,
                    issuer=org.issuer,
                    subject=resolved_subject,
                    email=resolved_email,
                    enabled=True,
                )
                membership = Membership.objects.create(
                    organisation=org,
                    user=user,
                    role=role,
                    state=membership_state,
                    accepted_at=timezone.now(),
                )
                uid, iid, mid = user.id, identity.id, membership.id
            else:
                uid, iid, mid = uuid4(), uuid4(), uuid4()

        now_ts = int(time.time())
        claims: dict[str, Any] = {
            "iss": issuer,
            "sub": resolved_subject,
            "aud": "kodera-server",
            "iat": now_ts,
            "exp": now_ts + 300,
            "typ": "Bearer",
            "email": resolved_email,
            "email_verified": True,
        }
        if lane == "customer":
            claims["azp"] = "console"

        signer = stranger_priv if sign_with_stranger else trusted_priv
        compact_jwt = jwt.encode(
            claims,
            signer,
            algorithm="RS256",
            headers={"kid": "ee-test-oidc-k1"},
        )
        return ProvisionedTestPrincipal(
            organisation_id=org.id,
            tenant_slug=tenant_slug,
            user_id=uid,
            identity_id=iid,
            membership_id=mid,
            role=role,
            email=resolved_email,
            issuer=issuer,
            subject=resolved_subject,
            token=compact_jwt,
        )

    return _create
