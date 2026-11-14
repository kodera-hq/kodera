"""Cryptographic signing and canonical hashing for Enterprise compliance audit exports.

Supports detached Ed25519 (`ed25519`, primary) and HMAC-SHA256 (`hmac-sha256`, fallback) manifest
signatures with strict domain separation.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from typing import Protocol

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

GENESIS_PREV_HASH = "0" * 64
LEDGER_HASH_DOMAIN = b"kodera-audit-ledger-v1\x00"
EXPORT_ROW_HASH_DOMAIN = b"kodera-audit-export-entry-v1\x00"
MANIFEST_SIG_DOMAIN = b"kodera-audit-manifest-v1\x00"


def canonical_json_bytes(payload: object) -> bytes:
    """Deterministic UTF-8 canonical JSON serialization (sorted keys, compact separators)."""
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def compute_domain_sha256(domain: bytes, payload: object) -> str:
    return hashlib.sha256(domain + canonical_json_bytes(payload)).hexdigest()


class AuditSigner(Protocol):
    @property
    def algorithm(self) -> str: ...

    @property
    def key_id(self) -> str: ...

    @property
    def public_key_pem(self) -> str | None: ...

    def sign_manifest(self, unsigned_manifest: dict[str, object]) -> str: ...


class Ed25519AuditSigner:
    """Ed25519 detached manifest signer for compliance export bundles."""

    def __init__(
        self,
        signing_material: Ed25519PrivateKey | None = None,
        *,
        key_id: str | None = None,
    ) -> None:
        self._signer = (
            signing_material if signing_material is not None else Ed25519PrivateKey.generate()
        )
        pub = self._signer.public_key()
        self._pub_pem = pub.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("ascii")
        pub_raw = pub.public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        self._key_id = key_id or ("ed25519-" + hashlib.sha256(pub_raw).hexdigest()[:16])

    @property
    def algorithm(self) -> str:
        return "ed25519"

    @property
    def key_id(self) -> str:
        return self._key_id

    @property
    def public_key_pem(self) -> str:
        return self._pub_pem

    def sign_manifest(self, unsigned_manifest: dict[str, object]) -> str:
        sig = self._signer.sign(MANIFEST_SIG_DOMAIN + canonical_json_bytes(unsigned_manifest))
        return base64.b64encode(sig).decode("ascii")


class HmacAuditSigner:
    """HMAC-SHA256 fallback manifest signer for symmetric SIEM pipelines."""

    def __init__(
        self,
        secret_key: bytes | None = None,
        *,
        key_id: str | None = None,
    ) -> None:
        raw = secret_key if secret_key is not None else secrets.token_bytes(32)
        if len(raw) < 32:
            raise ValueError("HMAC-SHA256 audit signing secret must be at least 32 bytes")
        self._secret = raw
        fp = hashlib.sha256(b"kodera-hmac-kid\x00" + raw).hexdigest()[:16]
        self._key_id = key_id or f"hmac-{fp}"

    @property
    def algorithm(self) -> str:
        return "hmac-sha256"

    @property
    def key_id(self) -> str:
        return self._key_id

    @property
    def public_key_pem(self) -> None:
        return None

    @property
    def secret_key(self) -> bytes:
        return self._secret

    def sign_manifest(self, unsigned_manifest: dict[str, object]) -> str:
        mac = hmac.new(
            self._secret,
            MANIFEST_SIG_DOMAIN + canonical_json_bytes(unsigned_manifest),
            hashlib.sha256,
        ).digest()
        return base64.b64encode(mac).decode("ascii")


def verify_manifest_signature(
    manifest: dict[str, object],
    *,
    trusted_public_key_pem: str | None = None,
    hmac_secret: bytes | None = None,
) -> tuple[bool, str | None]:
    """Verify the detached Ed25519 or HMAC-SHA256 signature on `manifest`."""
    alg = manifest.get("signing_algorithm")
    sig_b64 = manifest.get("signature")
    if not isinstance(alg, str) or not isinstance(sig_b64, str) or not sig_b64:
        return False, "missing_signature_or_algorithm"

    try:
        sig_bytes = base64.b64decode(sig_b64, validate=True)
    except Exception:
        return False, "invalid_signature_base64"

    unsigned = {k: v for k, v in manifest.items() if k != "signature"}
    message = MANIFEST_SIG_DOMAIN + canonical_json_bytes(unsigned)

    if alg == "ed25519":
        pem_source = trusted_public_key_pem
        if pem_source is None:
            embedded = manifest.get("public_key_pem")
            if isinstance(embedded, str) and embedded.strip():
                pem_source = embedded
        if not pem_source:
            return False, "missing_ed25519_public_key"
        try:
            loaded = serialization.load_pem_public_key(pem_source.encode("utf-8"))
        except Exception:
            return False, "invalid_ed25519_public_key"
        if not isinstance(loaded, Ed25519PublicKey):
            return False, "public_key_is_not_ed25519"
        try:
            loaded.verify(sig_bytes, message)
        except InvalidSignature:
            return False, "invalid_manifest_signature"
        return True, None

    if alg == "hmac-sha256":
        if hmac_secret is None:
            return False, "missing_hmac_secret_for_verification"
        expected = hmac.new(hmac_secret, message, hashlib.sha256).digest()
        if not hmac.compare_digest(sig_bytes, expected):
            return False, "invalid_manifest_signature"
        return True, None

    return False, "unsupported_signing_algorithm"
