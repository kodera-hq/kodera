"""Zero-trust `kodera-staff` OIDC JWT verification, split-plane Host admission, and DB RBAC."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from http.client import HTTPMessage
from typing import IO, Any
from urllib.parse import urlsplit
from uuid import UUID

import jwt
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from django.conf import settings
from django.db import connection
from django.http import HttpRequest

from .errors import StaffApiError
from .models import OPS_STEP_UP_MAX_AGE_SEC, STAFF_REALM, STAFF_ROLES

REQUIRED_AZP = "kodera-admin"
REQUIRED_AUDIENCES = frozenset({"kodera-admin-api", "kodera-server"})
READ_TRIAGE_AMR = frozenset({"hwk", "otp"})
OPS_REQUIRED_AMR = "hwk"
ALLOWED_JWT_ALGS = frozenset({"RS256", "ES256"})
MAX_BEARER_TOKEN_BYTES = 8192
MAX_JWKS_BYTES = 65536
JWKS_CACHE_TTL_SEC = 300.0

PublicKey = rsa.RSAPublicKey | ec.EllipticCurvePublicKey


@dataclass(frozen=True)
class VerifiedStaffRequest:
    identity_id: UUID
    user_id: UUID
    issuer: str
    subject: str
    roles: tuple[str, ...]
    amr: tuple[str, ...]
    auth_time: int | None
    plane: str


@dataclass(frozen=True)
class _PlaneConfig:
    issuer: str
    jwks_url: str
    ops_hosts: tuple[str, ...]


_jwks_lock = threading.Lock()
_jwks_cache: dict[str, tuple[float, dict[str, tuple[str, PublicKey]]]] = {}
_test_jwks_registry: dict[str, dict[str, Any]] = {}


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse all 3xx HTTP redirects on staff OIDC JWKS fetches."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: HTTPMessage,
        newurl: str,
    ) -> urllib.request.Request | None:
        raise urllib.error.HTTPError(
            req.full_url,
            code,
            "HTTP redirects are forbidden when fetching staff JWKS",
            headers,
            fp,
        )


_JWKS_OPENER = urllib.request.build_opener(NoRedirectHandler)


def register_test_jwks(jwks_url: str, jwks_payload: dict[str, Any]) -> None:
    """Register deterministic in-memory JWKS for test suites without network I/O."""
    with _jwks_lock:
        _test_jwks_registry[jwks_url] = dict(jwks_payload)
        _jwks_cache.pop(jwks_url, None)


def clear_jwks_cache() -> None:
    """Clear cached and test-registered JWKS snapshots."""
    with _jwks_lock:
        _jwks_cache.clear()
        _test_jwks_registry.clear()


def _resolve_ops_hosts(raw: object) -> tuple[str, ...]:
    if raw is None:
        return ()
    entries: list[str]
    if isinstance(raw, str):
        stripped = raw.strip()
        if not stripped:
            return ()
        entries = [part.strip().lower() for part in stripped.split(",") if part.strip()]
    elif isinstance(raw, Sequence):
        entries = [item.strip().lower() for item in raw if isinstance(item, str) and item.strip()]
    else:
        return ()
    if not entries:
        return ()
    for host in entries:
        host_only, _, _ = host.partition(":")
        if host_only == "admin" or host_only.startswith("admin."):
            return ()
    return tuple(dict.fromkeys(entries))


def _resolve_plane_config() -> _PlaneConfig:
    issuer = getattr(settings, "KODERA_STAFF_OIDC_ISSUER", None)
    jwks_url = getattr(settings, "KODERA_STAFF_OIDC_JWKS_URL", None)
    ops_hosts = _resolve_ops_hosts(getattr(settings, "KODERA_STAFF_OPS_HOSTS", ()))
    if (
        not isinstance(issuer, str)
        or not issuer.strip()
        or not issuer.endswith(f"/realms/{STAFF_REALM}")
        or not isinstance(jwks_url, str)
        or not jwks_url.strip()
        or not ops_hosts
    ):
        raise StaffApiError(
            503,
            "staff_plane_unconfigured",
            "Staff plane unavailable",
            "Staff OIDC issuer, JWKS endpoint, and dedicated ops-admin hosts must be configured",
            type_slug="c1-backend-unconfigured",
        )
    return _PlaneConfig(issuer=issuer.strip(), jwks_url=jwks_url.strip(), ops_hosts=ops_hosts)


def _fetch_jwks_document(jwks_url: str) -> dict[str, Any]:
    with _jwks_lock:
        override = _test_jwks_registry.get(jwks_url)
    if override is not None:
        return override
    parsed = urlsplit(jwks_url)
    allow_loopback_http = getattr(settings, "KODERA_LOOPBACK_ISSUERS", False) is True
    if parsed.scheme != "https" and not (
        allow_loopback_http
        and parsed.scheme == "http"
        and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    ):
        raise StaffApiError(
            503,
            "staff_jwks_unavailable",
            "Staff JWKS unavailable",
            "Refused non-HTTPS staff JWKS URL",
            type_slug="c1-backend-jwks-unavailable",
        )
    req = urllib.request.Request(  # noqa: S310 - scheme validated above, redirects disabled
        jwks_url, headers={"Accept": "application/json"}, method="GET"
    )
    try:
        with _JWKS_OPENER.open(req, timeout=3.0) as resp:
            raw = resp.read(MAX_JWKS_BYTES + 1)
    except Exception as exc:
        raise StaffApiError(
            503,
            "staff_jwks_unavailable",
            "Staff JWKS unavailable",
            "Unable to retrieve staff OIDC signing keys",
            type_slug="c1-backend-jwks-unavailable",
        ) from exc
    if len(raw) > MAX_JWKS_BYTES:
        raise StaffApiError(
            503,
            "staff_jwks_unavailable",
            "Staff JWKS unavailable",
            "Staff JWKS response exceeded maximum size",
            type_slug="c1-backend-jwks-unavailable",
        )
    try:
        doc = json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        raise StaffApiError(
            503,
            "staff_jwks_unavailable",
            "Staff JWKS unavailable",
            "Malformed JSON from staff JWKS endpoint",
            type_slug="c1-backend-jwks-unavailable",
        ) from exc
    if not isinstance(doc, dict):
        raise StaffApiError(
            503,
            "staff_jwks_unavailable",
            "Staff JWKS unavailable",
            "Staff JWKS payload must be an object",
            type_slug="c1-backend-jwks-unavailable",
        )
    return doc


def _parse_jwks_keys(doc: dict[str, Any]) -> dict[str, tuple[str, PublicKey]]:
    keys_raw = doc.get("keys")
    if not isinstance(keys_raw, list) or not keys_raw:
        return {}
    parsed: dict[str, tuple[str, PublicKey]] = {}
    for item in keys_raw[:32]:
        if not isinstance(item, dict):
            continue
        kid = item.get("kid")
        kty = item.get("kty")
        use = item.get("use")
        if not isinstance(kid, str) or not kid or (use is not None and use != "sig"):
            continue
        try:
            if kty == "RSA":
                pub_rsa = jwt.algorithms.RSAAlgorithm.from_jwk(item)
                if isinstance(pub_rsa, rsa.RSAPublicKey) and 2048 <= pub_rsa.key_size <= 8192:
                    alg = item.get("alg")
                    if alg in {None, "RS256"}:
                        parsed[kid] = ("RS256", pub_rsa)
            elif kty == "EC":
                pub_ec = jwt.algorithms.ECAlgorithm.from_jwk(item)
                if isinstance(pub_ec, ec.EllipticCurvePublicKey):
                    alg = item.get("alg")
                    if alg in {None, "ES256"}:
                        parsed[kid] = ("ES256", pub_ec)
        except Exception:  # noqa: S112 - skip malformed foreign JWK entries safely
            continue
    return parsed


def _resolve_signing_key(jwks_url: str, kid: str) -> tuple[str, PublicKey]:
    now = time.monotonic()
    with _jwks_lock:
        cached = _jwks_cache.get(jwks_url)
        if cached is not None and cached[0] > now and kid in cached[1]:
            return cached[1][kid]
    doc = _fetch_jwks_document(jwks_url)
    keys = _parse_jwks_keys(doc)
    with _jwks_lock:
        _jwks_cache[jwks_url] = (time.monotonic() + JWKS_CACHE_TTL_SEC, keys)
    found = keys.get(kid)
    if found is None:
        raise StaffApiError(
            401,
            "invalid_token",
            "Authentication required",
            "Unknown or retired signing key identifier",
            authenticate_challenge=True,
        )
    return found


def _extract_bearer_token(request: HttpRequest) -> str:
    raw = request.META.get("HTTP_AUTHORIZATION", "")
    if not isinstance(raw, str) or not raw or len(raw) > MAX_BEARER_TOKEN_BYTES + 7:
        raise StaffApiError(
            401,
            "missing_bearer_token",
            "Authentication required",
            "Bearer access token required for /staff/v1/* endpoints",
            authenticate_challenge=True,
        )
    parts = raw.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise StaffApiError(
            401,
            "missing_bearer_token",
            "Authentication required",
            "Malformed Authorization header; expected Bearer <jwt>",
            authenticate_challenge=True,
        )
    return parts[1]


def _request_host(request: HttpRequest) -> str:
    raw_host = request.META.get("HTTP_HOST", "")
    if not isinstance(raw_host, str) or not raw_host.strip():
        server_name = request.META.get("SERVER_NAME", "")
        raw_host = server_name if isinstance(server_name, str) else ""
    return raw_host.strip().lower()


def _verify_jwt_claims(
    token: str,
    config: _PlaneConfig,
    *,
    now_epoch: int,
) -> dict[str, Any]:
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise StaffApiError(
            401,
            "invalid_token",
            "Authentication required",
            "Malformed JWT header",
            authenticate_challenge=True,
        ) from exc
    alg = header.get("alg")
    kid = header.get("kid")
    if (
        alg not in ALLOWED_JWT_ALGS
        or not isinstance(kid, str)
        or not kid
        or "crit" in header
    ):
        raise StaffApiError(
            401,
            "invalid_token",
            "Authentication required",
            "Unsupported JWT signing header",
            authenticate_challenge=True,
        )
    key_alg, public_key = _resolve_signing_key(config.jwks_url, kid)
    if key_alg != alg:
        raise StaffApiError(
            401,
            "invalid_token",
            "Authentication required",
            "JWT alg does not match JWK algorithm",
            authenticate_challenge=True,
        )
    try:
        claims: dict[str, Any] = jwt.decode(
            token,
            key=public_key,
            algorithms=[key_alg],
            issuer=config.issuer,
            options={
                "verify_signature": True,
                "verify_exp": False,
                "verify_nbf": False,
                "verify_iat": False,
                "verify_aud": False,
                "verify_iss": True,
                "require": ["iss", "sub", "exp", "aud", "azp"],
            },
        )
    except jwt.PyJWTError as exc:
        raise StaffApiError(
            401,
            "invalid_token",
            "Authentication required",
            "Staff JWT signature or issuer verification failed",
            authenticate_challenge=True,
        ) from exc

    exp = claims.get("exp")
    if isinstance(exp, bool) or not isinstance(exp, int | float) or now_epoch >= int(exp):
        raise StaffApiError(
            401,
            "token_expired",
            "Authentication required",
            "Staff access token has expired",
            authenticate_challenge=True,
        )
    nbf = claims.get("nbf")
    if nbf is not None and (isinstance(nbf, bool) or not isinstance(nbf, int | float) or now_epoch < int(nbf)):
        raise StaffApiError(
            401,
            "invalid_token",
            "Authentication required",
            "Staff access token is not yet valid",
            authenticate_challenge=True,
        )

    azp = claims.get("azp")
    if azp != REQUIRED_AZP:
        raise StaffApiError(
            401,
            "invalid_azp",
            "Authentication required",
            "Token azp must be kodera-admin",
            authenticate_challenge=True,
        )

    raw_aud = claims.get("aud")
    if isinstance(raw_aud, str):
        aud_set = {raw_aud}
    elif isinstance(raw_aud, list) and all(isinstance(item, str) for item in raw_aud):
        aud_set = set(raw_aud)
    else:
        aud_set = set()
    if not REQUIRED_AUDIENCES.issubset(aud_set):
        raise StaffApiError(
            401,
            "invalid_audience",
            "Authentication required",
            "Token aud must contain both kodera-admin-api and kodera-server",
            authenticate_challenge=True,
        )

    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub.strip() or len(sub) > 255:
        raise StaffApiError(
            401,
            "invalid_token",
            "Authentication required",
            "Token sub claim is missing or invalid",
            authenticate_challenge=True,
        )
    return claims


def _resolve_db_staff_identity_and_roles(issuer: str, subject: str) -> tuple[UUID, UUID, tuple[str, ...]]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT i.id, i.user_id
            FROM identity_identity i
            JOIN identity_user u ON u.id = i.user_id
            WHERE i.realm = %s
              AND i.issuer = %s
              AND i.subject = %s
              AND i.enabled = TRUE
              AND i.deleted_at IS NULL
              AND u.enabled = TRUE
              AND u.deleted_at IS NULL
            LIMIT 1
            """,
            [STAFF_REALM, issuer, subject],
        )
        row = cursor.fetchone()
        if row is None:
            raise StaffApiError(
                403,
                "staff_identity_missing",
                "Forbidden",
                "Caller holds no active kodera-staff identity in PostgreSQL",
            )
        identity_id = row[0] if isinstance(row[0], UUID) else UUID(str(row[0]))
        user_id = row[1] if isinstance(row[1], UUID) else UUID(str(row[1]))

        cursor.execute(
            """
            SELECT role FROM staff_api_role_grant
            WHERE identity_id = %s AND realm = %s AND revoked_at IS NULL
            UNION
            SELECT role FROM identity_staffrole
            WHERE identity_id = %s AND realm = %s AND revoked_at IS NULL
            """,
            [identity_id, STAFF_REALM, identity_id, STAFF_REALM],
        )
        raw_roles = {str(r[0]) for r in cursor.fetchall()}

    ordered_roles = tuple(role for role in STAFF_ROLES if role in raw_roles)
    return identity_id, user_id, ordered_roles


def authenticate_staff_request(
    request: HttpRequest,
    *,
    plane: str,
    allowed_roles: Sequence[str],
    clock: Callable[[], int] | None = None,
) -> VerifiedStaffRequest:
    """Enforce OIDC JWT, `amr`, `/ops/*` split-plane Host & `320s` step-up, and DB RBAC."""
    config = _resolve_plane_config()
    now_epoch = clock() if clock is not None else int(time.time())

    if plane == "ops":
        host = _request_host(request)
        host_only, _, _ = host.partition(":")
        if not host or host_only == "admin" or host_only.startswith("admin.") or host not in config.ops_hosts:
            raise StaffApiError(
                403,
                "ops_ingress_required",
                "Dedicated ops-admin ingress required",
                "Refused /staff/v1/ops/* request outside configured ops-admin Host plane",
                type_slug="ops-ingress-required",
            )

    token = _extract_bearer_token(request)
    claims = _verify_jwt_claims(token, config, now_epoch=now_epoch)

    raw_amr = claims.get("amr")
    amr_list = (
        tuple(item for item in raw_amr if isinstance(item, str))
        if isinstance(raw_amr, list)
        else ()
    )
    amr_set = set(amr_list)

    raw_auth_time = claims.get("auth_time")
    auth_time: int | None
    if isinstance(raw_auth_time, bool) or not isinstance(raw_auth_time, int | float):
        auth_time = None
    else:
        auth_time = int(raw_auth_time)

    if plane == "ops":
        if OPS_REQUIRED_AMR not in amr_set:
            raise StaffApiError(
                403,
                "hwk_required",
                "Hardware-key step-up required",
                "WebAuthn hardware-key (hwk) authentication is mandatory for /staff/v1/ops/*; OTP-only tokens are refused",
                type_slug="hwk-required",
            )
        if auth_time is None or auth_time > now_epoch or (now_epoch - auth_time) > OPS_STEP_UP_MAX_AGE_SEC:
            raise StaffApiError(
                403,
                "step_up_expired",
                "Step-up authentication expired",
                f"WebAuthn auth_time must be within {OPS_STEP_UP_MAX_AGE_SEC} seconds for /staff/v1/ops/*",
                type_slug="step-up-expired",
            )
    else:
        if not amr_set.intersection(READ_TRIAGE_AMR):
            raise StaffApiError(
                403,
                "mfa_required",
                "Multi-factor authentication required",
                "Token amr must include hwk or otp for /staff/v1/{read,triage}/*",
            )

    identity_id, user_id, held_roles = _resolve_db_staff_identity_and_roles(
        config.issuer, str(claims["sub"])
    )
    if not held_roles or not set(held_roles).intersection(allowed_roles):
        raise StaffApiError(
            403,
            "insufficient_staff_role",
            "Forbidden",
            "Caller lacks an authorized StaffRole in PostgreSQL for this endpoint",
        )

    return VerifiedStaffRequest(
        identity_id=identity_id,
        user_id=user_id,
        issuer=config.issuer,
        subject=str(claims["sub"]),
        roles=held_roles,
        amr=amr_list,
        auth_time=auth_time,
        plane=plane,
    )
