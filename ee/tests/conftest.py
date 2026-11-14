"""Shared pytest fixtures and state-isolation hooks for `ee/tests/`.

All cryptographic keys are generated dynamically in memory at test runtime (never committed).
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import NameOID

from ee.audit_export.ledger import default_audit_ledger
from ee.saml.service import default_saml_service
from ee.scim.service import default_scim_service


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
