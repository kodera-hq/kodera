"""SAML 2.0 Service Provider metadata, `AuthnRequest`, ACS verification, and JIT provisioning.

Persists tenant IdP configurations (`ee_saml_idp`), single-use `AuthnRequest` / `RelayState`
bindings (`ee_saml_pending_request`), assertion replay nonces (`ee_saml_replay_assertion`), and
federated principal projections (`ee_saml_principal`) in PostgreSQL across Gunicorn workers.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import inspect
import ipaddress
import json
import os
import re
import secrets
import socket
import ssl
import threading
import urllib.parse
import zlib
from collections import OrderedDict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4, uuid5

import jwt
from django.db import DatabaseError, IntegrityError, connection, transaction
from uuid6 import uuid7

from ee.edition import require_enterprise_edition
from ee.saml.dns_txt import query_dns_txt_records
from ee.saml.xml_security import (
    SAML_ASSERTION_NS,
    SAML_METADATA_NS,
    SAML_PROTOCOL_NS,
    PublicVerificationKey,
    SamlSignatureError,
    SamlXmlSecurityError,
    XmlNode,
    _escape_c14n_attr,
    load_idp_verification_key,
    parse_hardened_xml,
    verify_saml_response_tree,
)
from ee.store import (
    TenantCutoffError,
    acquire_active_tenant_fence,
    can_use_postgres,
    derive_ee_hkdf_bytes,
    is_retriable_lock_contention,
    reset_ee_tables,
)

SAML_BINDING_HTTP_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
SAML_BINDING_HTTP_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
SAML_NAMEID_EMAIL = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
SAML_STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success"
SAML_CM_BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer"

VALID_ROLES = ("org_member", "org_billing", "org_admin")
_ROLE_PRIORITY = {"org_member": 1, "org_billing": 2, "org_admin": 3}
_RELAY_HMAC_KDF_INFO = b"kodera-ee-saml-relay-hmac-v1"
_DOMAIN_VERIFY_KDF_INFO = b"kodera-ee-saml-domain-verify-v1"
_HANDOFF_KDF_INFO = b"kodera-ee-saml-oidc-handoff-v1"
_SAML_SUBJECT_NAMESPACE = UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
_PUBLIC_FREEMAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "outlook.com",
        "hotmail.com",
        "live.com",
        "yahoo.com",
        "icloud.com",
        "proton.me",
        "protonmail.com",
        "aol.com",
        "gmx.com",
        "yandex.com",
        "mail.com",
        "zoho.com",
    }
)


def _canonical_saml_subject_uuid(organisation_id: UUID, idp_id: str, subject: str) -> str:
    """Derive deterministic KC-02 UUID subject (`[0-9a-f-]{36}`) bound strictly to SAML IdP + NameID."""
    return str(
        uuid5(_SAML_SUBJECT_NAMESPACE, f"kodera-saml-v1:{organisation_id}:{idp_id}:{subject}")
    )


def _is_ascii_lower_alnum(ch: str) -> bool:
    return ("a" <= ch <= "z") or ("0" <= ch <= "9")


def _is_valid_slug(value: str) -> bool:
    if not (1 <= len(value) <= 63):
        return False
    if not _is_ascii_lower_alnum(value[0]) or not _is_ascii_lower_alnum(value[-1]):
        return False
    return all(_is_ascii_lower_alnum(ch) or ch == "-" for ch in value)


def _is_valid_domain(value: str) -> bool:
    if not (1 <= len(value) <= 253) or "." not in value:
        return False
    labels = value.split(".")
    if len(labels) < 2:
        return False
    if not all(_is_valid_slug(label) for label in labels):
        return False
    tld = labels[-1]
    return 2 <= len(tld) <= 63 and all("a" <= ch <= "z" for ch in tld)


def _extract_email_domain(candidate: str) -> str | None:
    local, sep, domain = candidate.partition("@")
    if not sep or "@" in domain:
        return None
    if not (1 <= len(local) <= 64) or not (1 <= len(domain) <= 253):
        return None
    if any(ch.isspace() or ch in "<>\"'" for ch in local):
        return None
    low_domain = domain.lower()
    if not _is_valid_domain(low_domain):
        return None
    return low_domain


MAX_PENDING_REQUESTS = 10_000
MAX_REPLAY_ENTRIES = 50_000
DEFAULT_AUTHN_REQUEST_TTL_S = 300
DEFAULT_CLOCK_SKEW_S = 60
MAX_CLOCK_SKEW_S = 180


class SamlError(ValueError):
    """Structured SAML 2.0 validation or security refusal."""

    def __init__(self, code: str, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True, slots=True)
class SamlIdpConfig:
    tenant_slug: str
    idp_id: str
    idp_entity_id: str
    idp_sso_url: str
    public_key_pem: str
    verified_domains: frozenset[str]
    group_role_mapping: Mapping[str, str] = field(default_factory=dict)
    default_role: str = "org_member"
    want_assertions_signed: bool = True
    clock_skew_seconds: int = DEFAULT_CLOCK_SKEW_S
    organisation_id: UUID | None = None
    _public_key: PublicVerificationKey = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not _is_valid_slug(self.tenant_slug):
            raise SamlError("invalid_tenant_slug", "Invalid tenant slug format")
        if not _is_valid_slug(self.idp_id):
            raise SamlError("invalid_idp_id", "Invalid IdP identifier format")
        if not self.idp_entity_id or len(self.idp_entity_id) > 512:
            raise SamlError("invalid_idp_entity_id", "Invalid IdP entityID")
        parsed_sso = urllib.parse.urlsplit(self.idp_sso_url)
        if parsed_sso.scheme != "https" or not parsed_sso.hostname:
            raise SamlError("invalid_idp_sso_url", "IdP SSO URL must be an https:// URL")
        if not self.verified_domains:
            raise SamlError(
                "missing_verified_domains",
                "At least one verified email domain is required for SAML federation",
            )
        normalized_domains: set[str] = set()
        for domain in self.verified_domains:
            clean = domain.strip().lower()
            if not _is_valid_domain(clean):
                raise SamlError("invalid_verified_domain", "Invalid verified domain")
            normalized_domains.add(clean)
        object.__setattr__(self, "verified_domains", frozenset(normalized_domains))

        if self.default_role not in VALID_ROLES:
            raise SamlError("invalid_default_role", "Unsupported default role")
        for grp, role in self.group_role_mapping.items():
            if not grp or role not in VALID_ROLES:
                raise SamlError("invalid_group_mapping", "Unsupported mapped role for group")
        if not 0 <= self.clock_skew_seconds <= MAX_CLOCK_SKEW_S:
            raise SamlError("invalid_clock_skew", "Clock skew must be between 0 and 180 seconds")

        try:
            key = load_idp_verification_key(self.public_key_pem)
        except Exception as exc:
            raise SamlError(
                "invalid_idp_certificate", "Invalid IdP verification certificate or key"
            ) from exc
        object.__setattr__(self, "_public_key", key)

    @property
    def public_key(self) -> PublicVerificationKey:
        return self._public_key


@dataclass(frozen=True, slots=True)
class AuthnRequestBundle:
    tenant_slug: str
    idp_id: str
    request_id: str
    relay_state: str
    redirect_url: str
    destination: str
    sp_entity_id: str
    acs_url: str
    saml_request_xml: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class _PendingRequest:
    tenant_slug: str
    idp_id: str
    request_id: str
    relay_state: str
    return_path: str
    sp_base_url: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class ProvisionedSamlPrincipal:
    user_id: str
    tenant_slug: str
    idp_id: str
    idp_entity_id: str
    assertion_id: str
    subject_name_id: str
    email: str
    display_name: str
    groups: tuple[str, ...]
    role: str
    return_path: str
    authenticated_at: datetime
    oidc_client_id: str = "console"
    oidc_redirect_uri: str | None = None
    oidc_code_challenge: str | None = None


@dataclass(frozen=True, slots=True)
class SamlHandoffSession:
    user_id: str
    tenant_slug: str
    role: str
    return_path: str
    access_token: str
    expires_in: int
    passport_token: str | None = None


def _idp_from_row(row: tuple[object, ...]) -> SamlIdpConfig:
    domains_raw = json.loads(str(row[5]))
    mapping_raw = json.loads(str(row[6]))
    org_str = str(row[10]) if row[10] is not None else None
    return SamlIdpConfig(
        tenant_slug=str(row[0]),
        idp_id=str(row[1]),
        idp_entity_id=str(row[2]),
        idp_sso_url=str(row[3]),
        public_key_pem=str(row[4]),
        verified_domains=frozenset(str(d) for d in domains_raw)
        if isinstance(domains_raw, list)
        else frozenset(),
        group_role_mapping={str(k): str(v) for k, v in mapping_raw.items()}
        if isinstance(mapping_raw, dict)
        else {},
        default_role=str(row[7]),
        want_assertions_signed=bool(row[8]),
        clock_skew_seconds=int(str(row[9])),
        organisation_id=UUID(org_str) if org_str else None,
    )


def _principal_from_row(row: tuple[object, ...]) -> ProvisionedSamlPrincipal:
    groups_raw = json.loads(str(row[8]))
    groups_tuple = tuple(str(g) for g in groups_raw) if isinstance(groups_raw, list) else ()
    auth_val = row[11]
    auth_dt = (
        auth_val.astimezone(UTC)
        if isinstance(auth_val, datetime)
        else datetime.fromisoformat(str(auth_val)).astimezone(UTC)
    )
    return ProvisionedSamlPrincipal(
        user_id=str(row[0]),
        tenant_slug=str(row[1]),
        idp_id=str(row[2]),
        idp_entity_id=str(row[3]),
        assertion_id=str(row[4]),
        subject_name_id=str(row[5]),
        email=str(row[6]),
        display_name=str(row[7]),
        groups=groups_tuple,
        role=str(row[9]),
        return_path=str(row[10]),
        authenticated_at=auth_dt,
    )


def _parse_saml_instant(raw: str | None, field_name: str) -> datetime:
    if not raw:
        raise SamlError(
            "missing_timestamp", f"Missing required SAML timestamp {field_name}", status=403
        )
    cleaned = raw.strip()
    if (
        len(cleaned) < 20
        or len(cleaned) > 30
        or cleaned[4] != "-"
        or cleaned[7] != "-"
        or cleaned[10] != "T"
        or cleaned[13] != ":"
        or cleaned[16] != ":"
        or not cleaned.endswith("Z")
    ):
        raise SamlError(
            "malformed_timestamp",
            f"SAML timestamp {field_name} must be UTC ISO-8601 ending in Z",
            status=403,
        )
    year_s = cleaned[0:4]
    month_s = cleaned[5:7]
    day_s = cleaned[8:10]
    hour_s = cleaned[11:13]
    minute_s = cleaned[14:16]
    second_s = cleaned[17:19]
    frac_s = cleaned[19:-1]
    fixed_parts = (year_s, month_s, day_s, hour_s, minute_s, second_s)
    if not all(all("0" <= ch <= "9" for ch in seg) for seg in fixed_parts):
        raise SamlError(
            "malformed_timestamp",
            f"SAML timestamp {field_name} must be UTC ISO-8601 ending in Z",
            status=403,
        )
    micro = 0
    if frac_s:
        if not frac_s.startswith("."):
            raise SamlError(
                "malformed_timestamp",
                f"SAML timestamp {field_name} must be UTC ISO-8601 ending in Z",
                status=403,
            )
        digits = frac_s[1:]
        if not (1 <= len(digits) <= 9) or not all("0" <= ch <= "9" for ch in digits):
            raise SamlError(
                "malformed_timestamp",
                f"SAML timestamp {field_name} must be UTC ISO-8601 ending in Z",
                status=403,
            )
        micro = int(digits[:6].ljust(6, "0"))
    try:
        return datetime(
            int(year_s),
            int(month_s),
            int(day_s),
            int(hour_s),
            int(minute_s),
            int(second_s),
            micro,
            tzinfo=UTC,
        )
    except ValueError as exc:
        raise SamlError(
            "malformed_timestamp", f"Invalid calendar timestamp in {field_name}", status=403
        ) from exc


def _format_saml_instant(instant: datetime) -> str:
    utc_dt = instant.astimezone(UTC)
    return utc_dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _normalize_sp_base_url(sp_base_url: str) -> str:
    cleaned = sp_base_url.strip().rstrip("/")
    parsed = urllib.parse.urlsplit(cleaned)
    if (
        parsed.scheme not in {"https", "http"}
        or not parsed.netloc
        or parsed.query
        or parsed.fragment
    ):
        raise SamlError("invalid_sp_base_url", "Invalid Service Provider base URL")
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/")


_CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}\Z")
_PKCE_CHALLENGE_S256_RE = re.compile(r"^[A-Za-z0-9_-]{43}\Z")
_PKCE_VERIFIER_S256_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}\Z")
_LOOPBACK_REDIRECT_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "[::1]", "testserver"})


def _sanitize_return_path(return_path: str) -> str:
    candidate = return_path.strip() or "/"
    if not candidate.startswith("/") or candidate.startswith("//") or "\\" in candidate:
        raise SamlError(
            "invalid_return_path", "Return path must be a relative path starting with '/'"
        )
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in candidate):
        raise SamlError("invalid_return_path", "Control characters are forbidden in return path")
    return candidate


def _validate_oidc_client_id(raw: str | None) -> str:
    if raw is None or not raw.strip():
        return "console"
    cleaned = raw.strip()
    if not _CLIENT_ID_RE.fullmatch(cleaned):
        raise SamlError("invalid_client_id", "Invalid OIDC client_id", status=400)
    return cleaned


def _validate_oidc_redirect_uri(
    raw: str | None,
    *,
    sp_base_url: str,
    tenant_slug: str,
) -> str:
    norm_base = _normalize_sp_base_url(sp_base_url)
    if raw is None or not raw.strip():
        return f"{norm_base}/api/v1/ee/sso/saml/{tenant_slug}/oidc-handoff"
    cleaned = raw.strip()
    if len(cleaned) > 1024 or "\\" in cleaned or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in cleaned):
        raise SamlError("invalid_redirect_uri", "Invalid OIDC redirect_uri", status=400)
    parsed = urllib.parse.urlsplit(cleaned)
    host_low = (parsed.hostname or "").lower()
    if not parsed.netloc or parsed.fragment:
        raise SamlError("invalid_redirect_uri", "Invalid OIDC redirect_uri", status=400)
    if parsed.scheme == "https":
        return cleaned
    if parsed.scheme == "http" and host_low in _LOOPBACK_REDIRECT_HOSTS:
        return cleaned
    raise SamlError(
        "invalid_redirect_uri",
        "OIDC redirect_uri must use https:// (or loopback http:// in local tests)",
        status=400,
    )


def _validate_optional_pkce(
    code_challenge: str | None,
    code_challenge_method: str | None,
) -> str | None:
    if code_challenge is None or not code_challenge.strip():
        if code_challenge_method is not None and code_challenge_method.strip():
            if code_challenge_method.strip() != "S256":
                raise SamlError(
                    "invalid_pkce_challenge",
                    "PKCE code_challenge_method must be S256",
                    status=400,
                )
        return None
    method = (code_challenge_method or "S256").strip()
    cleaned = code_challenge.strip()
    if method != "S256" or not _PKCE_CHALLENGE_S256_RE.fullmatch(cleaned):
        raise SamlError(
            "invalid_pkce_challenge",
            "Invalid PKCE code_challenge or unsupported method (S256 required)",
            status=400,
        )
    return cleaned


def _encode_pending_context(
    return_path: str,
    *,
    client_id: str,
    redirect_uri: str | None,
    code_challenge: str | None,
) -> str:
    if client_id == "console" and redirect_uri is None and code_challenge is None:
        return return_path
    return json.dumps(
        {
            "return_path": return_path,
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "code_challenge": code_challenge,
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _decode_pending_context(stored: str) -> tuple[str, str, str | None, str | None]:
    if not stored.startswith("{"):
        return stored, "console", None, None
    try:
        parsed = json.loads(stored)
    except ValueError:
        return "/", "console", None, None
    if not isinstance(parsed, dict):
        return "/", "console", None, None
    ret = parsed.get("return_path")
    cid = parsed.get("client_id")
    ruri = parsed.get("redirect_uri")
    pkce = parsed.get("code_challenge")
    return (
        ret if isinstance(ret, str) and ret else "/",
        cid if isinstance(cid, str) and cid else "console",
        ruri if isinstance(ruri, str) and ruri else None,
        pkce if isinstance(pkce, str) and pkce else None,
    )


def _compute_pkce_s256(verifier: str) -> str:
    return (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest())
        .rstrip(b"=")
        .decode("ascii")
    )


def _issue_core_passport_token(*, user_id: UUID, active_organisation_id: UUID, now_epoch: int) -> str | None:
    try:
        from django.conf import settings

        from core.passport import PASSPORT_SESSION_TTL_SECONDS, issue_passport_session_token

        secret = getattr(settings, "SECRET_KEY", "")
        if not isinstance(secret, str) or len(secret) < 16:
            return None
        kwargs: dict[str, Any] = {
            "secret": secret,
            "user_id": user_id,
            "active_organisation_id": active_organisation_id,
            "now": now_epoch,
            "ttl_seconds": PASSPORT_SESSION_TTL_SECONDS,
        }
        sig_params = inspect.signature(issue_passport_session_token).parameters
        if "email_verified" in sig_params:
            kwargs["email_verified"] = True
        return str(issue_passport_session_token(**kwargs))
    except Exception:
        return None


OidcTokenExchanger = Callable[[str, Mapping[str, str]], Mapping[str, object]]


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connects TCP directly to the SSRF-validated IP while verifying TLS SNI + cert hostname."""

    def __init__(
        self,
        host: str,
        *,
        pinned_ip: str,
        port: int,
        timeout: float,
        context: ssl.SSLContext,
    ) -> None:
        super().__init__(host, port=port, timeout=timeout, context=context)
        self._pinned_ip = pinned_ip
        self._tls_context = context

    def connect(self) -> None:
        raw_sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)
        self.sock = self._tls_context.wrap_socket(raw_sock, server_hostname=self.host)


def _is_loopback_oidc_allowed() -> bool:
    try:
        from django.conf import settings

        if settings.configured and (
            getattr(settings, "DEBUG", False)
            or getattr(settings, "KODERA_LOOPBACK_ISSUERS", False)
        ):
            return True
    except ImportError:
        pass
    settings_mod = os.environ.get("DJANGO_SETTINGS_MODULE", "")
    return settings_mod.endswith(".test")


def _resolve_token_endpoint_url(issuer_url: str) -> str:
    clean_issuer = issuer_url.rstrip("/")
    try:
        from django.conf import settings

        if settings.configured:
            endpoint_map = getattr(settings, "KODERA_SAML_OIDC_TOKEN_ENDPOINT_MAP", None)
            if isinstance(endpoint_map, Mapping):
                mapped = endpoint_map.get(clean_issuer)
                if isinstance(mapped, str) and mapped.strip():
                    return mapped.strip()
    except ImportError:
        pass
    return f"{clean_issuer}/protocol/openid-connect/token"


def _default_http_oidc_token_exchanger(
    token_endpoint: str,
    form_fields: Mapping[str, str],
) -> Mapping[str, object]:
    """Bounded, no-redirect, DNS-rebinding-pinned RFC 6749 / RFC 7636 `/token` HTTP client."""
    parsed = urllib.parse.urlsplit(token_endpoint)
    if (
        not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise SamlError("oidc_code_exchange_failed", "Invalid OIDC token endpoint URL", status=403)

    host_low = parsed.hostname.lower()
    loopback_ok = _is_loopback_oidc_allowed()
    is_loopback_host = host_low in {"127.0.0.1", "localhost", "::1"}
    if parsed.scheme == "http":
        if not (loopback_ok and is_loopback_host):
            raise SamlError(
                "oidc_code_exchange_failed",
                "OIDC token endpoint must use https://",
                status=403,
            )
    elif parsed.scheme != "https":
        raise SamlError(
            "oidc_code_exchange_failed",
            "Unsupported OIDC token endpoint scheme",
            status=403,
        )

    if loopback_ok and is_loopback_host:
        pinned_ip = "::1" if host_low == "::1" else "127.0.0.1"
    else:
        try:
            infos = socket.getaddrinfo(
                parsed.hostname,
                parsed.port or 443,
                type=socket.SOCK_STREAM,
            )
        except OSError as exc:
            raise SamlError(
                "oidc_code_exchange_failed",
                "OIDC token endpoint DNS resolution failed",
                status=403,
            ) from exc
        if not infos:
            raise SamlError(
                "oidc_code_exchange_failed",
                "OIDC token endpoint resolved zero addresses",
                status=403,
            )
        pinned_ip = ""
        for info in infos:
            ip_str = str(info[4][0]).split("%", 1)[0]
            try:
                addr: ipaddress.IPv4Address | ipaddress.IPv6Address = ipaddress.ip_address(ip_str)
            except ValueError as exc:
                raise SamlError(
                    "oidc_code_exchange_failed",
                    "Invalid OIDC token endpoint address",
                    status=403,
                ) from exc
            if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
                addr = addr.ipv4_mapped
            if not addr.is_global:
                raise SamlError(
                    "oidc_code_exchange_failed",
                    "OIDC token endpoint resolved to non-global address",
                    status=403,
                )
            if not pinned_ip:
                pinned_ip = ip_str

    encoded_form = urllib.parse.urlencode(dict(form_fields)).encode("utf-8")
    req_path = parsed.path or "/"
    conn: http.client.HTTPConnection
    if parsed.scheme == "http":
        conn = http.client.HTTPConnection(pinned_ip, port=parsed.port or 80, timeout=3.0)
    else:
        conn = _PinnedHTTPSConnection(
            parsed.hostname,
            pinned_ip=pinned_ip,
            port=parsed.port or 443,
            timeout=3.0,
            context=ssl.create_default_context(),
        )
    try:
        conn.request(
            "POST",
            req_path,
            body=encoded_form,
            headers={
                "Host": parsed.netloc,
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
                "Content-Length": str(len(encoded_form)),
            },
        )
        resp = conn.getresponse()
        status_code = int(resp.status)
        raw_body = resp.read(65_537)
    except (http.client.HTTPException, ssl.SSLError, TimeoutError, OSError) as exc:
        raise SamlError(
            "oidc_code_exchange_failed",
            "OIDC authorization-code exchange failed",
            status=403,
        ) from exc
    finally:
        conn.close()

    if status_code != 200 or len(raw_body) > 65_536:
        raise SamlError(
            "oidc_code_exchange_failed",
            "OIDC token endpoint returned non-200 or oversized response",
            status=403,
        )
    try:
        parsed_json = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise SamlError(
            "oidc_code_exchange_failed",
            "Malformed JSON from OIDC token endpoint",
            status=403,
        ) from exc
    if not isinstance(parsed_json, dict) or "error" in parsed_json:
        raise SamlError(
            "oidc_code_exchange_failed",
            "OIDC provider rejected authorization-code exchange",
            status=403,
        )
    return parsed_json


class SamlService:
    """Multi-IdP SAML 2.0 Service Provider engine with PostgreSQL multi-worker persistence."""

    def __init__(self, *, relay_hmac_secret: bytes | None = None) -> None:
        self._lock = threading.Lock()
        self._explicit_relay_secret = relay_hmac_secret
        self._idps: dict[tuple[str, str], SamlIdpConfig] = {}
        self._pending_by_relay: OrderedDict[str, _PendingRequest] = OrderedDict()
        self._replay_cache: OrderedDict[tuple[str, str, str], datetime] = OrderedDict()
        self._provisioned_users: dict[tuple[str, str], ProvisionedSamlPrincipal] = {}
        self._seeded_dns_txt: dict[str, list[str]] = {}
        self._verified_domains: set[tuple[str, str]] = set()
        self._dns_txt_resolver: Callable[[str], Sequence[str]] | None = None
        self._oidc_token_exchanger: OidcTokenExchanger | None = None
        self._oidc_public_keys: dict[tuple[str, str], tuple[str, Any]] = {}

    def _relay_hmac_key(self) -> bytes:
        if self._explicit_relay_secret is not None:
            return self._explicit_relay_secret
        return derive_ee_hkdf_bytes(domain_info=_RELAY_HMAC_KDF_INFO)

    def reset(self) -> None:
        """Clear IdP registrations, pending requests, replay cache, DNS fixtures, and principals."""
        with self._lock:
            self._idps.clear()
            self._pending_by_relay.clear()
            self._replay_cache.clear()
            self._provisioned_users.clear()
            self._seeded_dns_txt.clear()
            self._verified_domains.clear()
            self._dns_txt_resolver = None
            self._oidc_token_exchanger = None
            self._oidc_public_keys.clear()
        reset_ee_tables("saml")

    def set_oidc_token_exchanger(self, exchanger: OidcTokenExchanger | None) -> None:
        """Configure a custom OIDC `/token` exchanger for isolated unit tests."""
        with self._lock:
            self._oidc_token_exchanger = exchanger

    def register_oidc_public_key(
        self,
        *,
        issuer: str,
        kid: str,
        algorithm: str,
        public_key: Any,
    ) -> None:
        """Register an admitted OIDC ID-token verification key `(issuer, kid)` for memory tests."""
        if algorithm not in {"RS256", "ES256"}:
            raise ValueError("Unsupported OIDC ID-token signature algorithm")
        with self._lock:
            self._oidc_public_keys[(issuer.rstrip("/"), kid)] = (algorithm, public_key)

    def seed_dns_txt_record(self, fqdn: str, txt_value: str) -> None:
        """Seed a DNS TXT record fixture (e.g. `_kodera-challenge.<domain>`) for deterministic tests."""
        key = fqdn.strip().rstrip(".").lower()
        with self._lock:
            self._seeded_dns_txt.setdefault(key, []).append(txt_value.strip())

    def set_dns_txt_resolver(self, resolver: Callable[[str], Sequence[str]] | None) -> None:
        with self._lock:
            self._dns_txt_resolver = resolver

    def resolve_dns_txt(self, fqdn: str) -> tuple[str, ...]:
        key = fqdn.strip().rstrip(".").lower()
        with self._lock:
            seeded = tuple(self._seeded_dns_txt.get(key, ()))
            resolver = self._dns_txt_resolver
        if resolver is not None:
            resolved = tuple(str(r).strip() for r in resolver(key))
            return seeded + resolved
        if seeded:
            return seeded
        return query_dns_txt_records(key)

    def domain_verification_token(
        self,
        tenant_slug: str,
        domain: str,
        *,
        organisation_id: UUID | None = None,
    ) -> str:
        clean_domain = domain.strip().lower()
        if not _is_valid_domain(clean_domain):
            raise SamlError("invalid_verified_domain", "Invalid domain format")
        if clean_domain in _PUBLIC_FREEMAIL_DOMAINS:
            raise SamlError(
                "unverified_domain",
                "Public consumer email domains cannot be claimed for SAML federation",
                status=422,
            )
        scope = str(organisation_id) if organisation_id is not None else tenant_slug
        key = derive_ee_hkdf_bytes(
            domain_info=_DOMAIN_VERIFY_KDF_INFO + b"\x00" + scope.encode("utf-8")
        )
        digest = hmac.new(key, clean_domain.encode("utf-8"), hashlib.sha256).hexdigest()[:48]
        return f"kodera-domain-verification={digest}"

    def _assert_domain_not_claimed_by_other_tenant(
        self,
        *,
        tenant_slug: str,
        domain: str,
        organisation_id: UUID | None,
    ) -> bool:
        """Return True if already verified for THIS tenant; raise 409 if claimed by another tenant."""
        already_owned_by_self = False
        if can_use_postgres():
            with connection.cursor() as cur:
                cur.execute(
                    "SELECT tenant_slug, organisation_id, verified_domains_json FROM public.ee_saml_idp"
                )
                for row_slug, row_org_id, raw_domains_json in cur.fetchall():
                    parsed_domains = json.loads(str(raw_domains_json))
                    if not isinstance(parsed_domains, list) or domain not in parsed_domains:
                        continue
                    same_tenant = (
                        organisation_id is not None
                        and row_org_id is not None
                        and str(row_org_id) == str(organisation_id)
                    ) or str(row_slug) == tenant_slug
                    if same_tenant:
                        already_owned_by_self = True
                    else:
                        raise SamlError(
                            "domain_already_claimed",
                            "Domain is already claimed by another organisation",
                            status=409,
                        )
        else:
            with self._lock:
                for (t_slug, _), cfg in self._idps.items():
                    if domain not in cfg.verified_domains:
                        continue
                    if t_slug == tenant_slug:
                        already_owned_by_self = True
                    else:
                        raise SamlError(
                            "domain_already_claimed",
                            "Domain is already claimed by another organisation",
                            status=409,
                        )
        return already_owned_by_self

    def build_domain_challenge(
        self,
        *,
        tenant_slug: str,
        domain: str,
        organisation_id: UUID | None = None,
    ) -> dict[str, object]:
        require_enterprise_edition()
        clean_domain = domain.strip().lower()
        expected = self.domain_verification_token(
            tenant_slug, clean_domain, organisation_id=organisation_id
        )
        self._assert_domain_not_claimed_by_other_tenant(
            tenant_slug=tenant_slug,
            domain=clean_domain,
            organisation_id=organisation_id,
        )
        return {
            "tenant_slug": tenant_slug,
            "domain": clean_domain,
            "dns_record_name": f"_kodera-challenge.{clean_domain}",
            "dns_record_type": "TXT",
            "txt_value": expected,
        }

    def verify_domain_challenge(
        self,
        *,
        tenant_slug: str,
        domain: str,
        organisation_id: UUID | None = None,
    ) -> dict[str, object]:
        require_enterprise_edition()
        clean_domain = domain.strip().lower()
        expected = self.domain_verification_token(
            tenant_slug, clean_domain, organisation_id=organisation_id
        )
        already_self = self._assert_domain_not_claimed_by_other_tenant(
            tenant_slug=tenant_slug,
            domain=clean_domain,
            organisation_id=organisation_id,
        )
        fqdn = f"_kodera-challenge.{clean_domain}"
        records = self.resolve_dns_txt(fqdn)
        matched = already_self or any(
            hmac.compare_digest(rec.strip().strip('"'), expected) for rec in records
        )
        if not matched:
            raise SamlError(
                "unverified_domain",
                "DNS TXT ownership record was not found or did not match challenge",
                status=422,
            )
        scope = str(organisation_id) if organisation_id is not None else tenant_slug
        with self._lock:
            self._verified_domains.add((scope, clean_domain))
        return {
            "tenant_slug": tenant_slug,
            "domain": clean_domain,
            "verified": True,
        }

    def require_verified_domain_ownership(
        self,
        *,
        tenant_slug: str,
        domains: Iterable[str],
        organisation_id: UUID | None = None,
    ) -> None:
        domain_list = [d.strip().lower() for d in domains]
        if not domain_list:
            raise SamlError(
                "missing_verified_domains",
                "At least one verified email domain is required for SAML federation",
            )
        scope = str(organisation_id) if organisation_id is not None else tenant_slug
        for clean_domain in domain_list:
            expected = self.domain_verification_token(
                tenant_slug, clean_domain, organisation_id=organisation_id
            )
            already_self = self._assert_domain_not_claimed_by_other_tenant(
                tenant_slug=tenant_slug,
                domain=clean_domain,
                organisation_id=organisation_id,
            )
            if already_self:
                continue
            with self._lock:
                already_verified = (scope, clean_domain) in self._verified_domains
            if already_verified:
                continue
            records = self.resolve_dns_txt(f"_kodera-challenge.{clean_domain}")
            if any(hmac.compare_digest(rec.strip().strip('"'), expected) for rec in records):
                with self._lock:
                    self._verified_domains.add((scope, clean_domain))
                continue
            raise SamlError(
                "unverified_domain",
                "Domain requires proven DNS TXT ownership before SAML IdP registration",
                status=422,
            )

    def build_oidc_handoff(
        self,
        principal: ProvisionedSamlPrincipal,
        *,
        sp_base_url: str,
        ttl_seconds: int = 60,
    ) -> tuple[str, str]:
        """Mint a single-use DB-backed HMAC handoff token and full PKCE OIDC redirect URL."""
        require_enterprise_edition()
        norm_base = _normalize_sp_base_url(sp_base_url)
        client_id = _validate_oidc_client_id(principal.oidc_client_id)
        redirect_uri = _validate_oidc_redirect_uri(
            principal.oidc_redirect_uri,
            sp_base_url=norm_base,
            tenant_slug=principal.tenant_slug,
        )
        # Always generate and retain a server-owned 64-char PKCE verifier + OIDC nonce (`BUG-0060`)
        # so the OIDC `/oidc-handoff` callback exchanges `code` + `server_code_verifier` at `/token`
        # per RFC 7636 §4.5 without exposing `server_code_verifier` in URLs or `state`.
        server_code_verifier = secrets.token_urlsafe(48)
        outbound_challenge = _compute_pkce_s256(server_code_verifier)
        oidc_nonce = secrets.token_urlsafe(24)
        client_pkce = principal.oidc_code_challenge or ""

        issued_at = principal.authenticated_at.astimezone(UTC)
        expires_at = issued_at + timedelta(seconds=ttl_seconds)
        exp_epoch = int(expires_at.timestamp())
        jti = secrets.token_urlsafe(24)
        payload_obj = {
            "v": 1,
            "jti": jti,
            "sub": principal.user_id,
            "tenant_slug": principal.tenant_slug,
            "idp_id": principal.idp_id,
            "assertion_id": principal.assertion_id,
            "return_path": principal.return_path,
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "exp": exp_epoch,
        }
        payload_b64 = (
            base64.urlsafe_b64encode(
                json.dumps(payload_obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
            )
            .decode("ascii")
            .rstrip("=")
        )
        key = derive_ee_hkdf_bytes(
            domain_info=_HANDOFF_KDF_INFO + b"\x00" + principal.tenant_slug.encode("utf-8")
        )
        sig = hmac.new(key, f"ksh1.{payload_b64}".encode("ascii"), hashlib.sha256).hexdigest()
        handoff_token = f"ksh1.{payload_b64}.{sig}"
        handoff_key = f"handoff:{jti}"

        issuer_url: str | None = None
        stored_in_pg = False
        if can_use_postgres():
            try:
                with transaction.atomic(), connection.cursor() as cur:
                    org_id, resolved_slug = acquire_active_tenant_fence(
                        cur,
                        tenant_slug=principal.tenant_slug,
                    )
                    cur.execute(
                        "SELECT issuer FROM public.orgs_organisation WHERE id = %s LIMIT 1",
                        [org_id],
                    )
                    row = cur.fetchone()
                    if row is not None and row[0]:
                        issuer_url = str(row[0]).rstrip("/")
                    effective_issuer = issuer_url or f"https://sso.kodera.test/realms/{resolved_slug}"
                    handoff_meta = json.dumps(
                        {
                            "sub": principal.user_id,
                            "email": principal.email,
                            "idp_id": principal.idp_id,
                            "subject_name_id": principal.subject_name_id,
                            "role": principal.role,
                            "return_path": principal.return_path,
                            "client_id": client_id,
                            "redirect_uri": redirect_uri,
                            "code_verifier": server_code_verifier,
                            "oidc_nonce": oidc_nonce,
                            "issuer": effective_issuer,
                            "client_pkce": client_pkce,
                        },
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                    cur.execute(
                        "DELETE FROM public.ee_saml_pending_request WHERE expires_at <= %s",
                        [issued_at],
                    )
                    cur.execute(
                        """
                        INSERT INTO public.ee_saml_pending_request (
                            relay_state, organisation_id, tenant_slug, idp_id,
                            request_id, return_path, sp_base_url, expires_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        [
                            handoff_key,
                            org_id,
                            resolved_slug,
                            principal.idp_id,
                            principal.assertion_id,
                            handoff_meta,
                            norm_base,
                            expires_at,
                        ],
                    )
                    stored_in_pg = True
            except TenantCutoffError as exc:
                if exc.code != "organisation_not_found":
                    raise SamlError(
                        exc.code,
                        "Organisation is unavailable for SAML OIDC handoff",
                        status=exc.status,
                    ) from exc
            except IntegrityError as exc:
                raise SamlError(
                    "tenant_cutoff_fenced",
                    "SAML OIDC handoff refused by privacy cutoff",
                    status=403,
                ) from exc
            except DatabaseError as exc:
                if is_retriable_lock_contention(exc):
                    raise SamlError(
                        "authority_fenced",
                        "Organisation authority changed concurrently; retry request",
                        status=409,
                    ) from exc
                raise

        effective_issuer = issuer_url or f"https://sso.kodera.test/realms/{principal.tenant_slug}"
        if not stored_in_pg:
            handoff_meta = json.dumps(
                {
                    "sub": principal.user_id,
                    "email": principal.email,
                    "idp_id": principal.idp_id,
                    "subject_name_id": principal.subject_name_id,
                    "role": principal.role,
                    "return_path": principal.return_path,
                    "client_id": client_id,
                    "redirect_uri": redirect_uri,
                    "code_verifier": server_code_verifier,
                    "oidc_nonce": oidc_nonce,
                    "issuer": effective_issuer,
                    "client_pkce": client_pkce,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
            with self._lock:
                self._prune_pending_locked(issued_at)
                self._pending_by_relay[handoff_key] = _PendingRequest(
                    tenant_slug=principal.tenant_slug,
                    idp_id=principal.idp_id,
                    request_id=principal.assertion_id,
                    relay_state=handoff_key,
                    return_path=handoff_meta,
                    sp_base_url=norm_base,
                    expires_at=expires_at,
                )
                while len(self._pending_by_relay) > MAX_PENDING_REQUESTS:
                    self._pending_by_relay.popitem(last=False)

        query = urllib.parse.urlencode(
            {
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": "openid email",
                "code_challenge": outbound_challenge,
                "code_challenge_method": "S256",
                "nonce": oidc_nonce,
                "kc_idp_hint": principal.idp_id,
                "login_hint": principal.email,
                "state": handoff_token,
            }
        )
        handoff_url = f"{effective_issuer}/protocol/openid-connect/auth?{query}"
        return handoff_url, handoff_token

    def _verify_handoff_state_signature(
        self,
        *,
        tenant_slug: str,
        handoff_token: str,
        now_epoch: int,
        require_unexpired: bool = True,
    ) -> dict[str, Any]:
        cleaned_token = handoff_token.strip()
        if not cleaned_token:
            raise SamlError("missing_handoff_token", "Missing SAML OIDC handoff token", status=400)
        if len(cleaned_token) > 4096 or not cleaned_token.startswith("ksh1."):
            raise SamlError(
                "invalid_handoff_token",
                "Invalid, tampered, or expired SAML OIDC handoff token",
                status=403,
            )
        parts = cleaned_token.split(".")
        if len(parts) != 3 or parts[0] != "ksh1" or not parts[1] or not parts[2]:
            raise SamlError(
                "invalid_handoff_token",
                "Invalid, tampered, or expired SAML OIDC handoff token",
                status=403,
            )
        _, payload_b64, supplied_sig = parts
        key = derive_ee_hkdf_bytes(
            domain_info=_HANDOFF_KDF_INFO + b"\x00" + tenant_slug.encode("utf-8")
        )
        expected_sig = hmac.new(
            key, f"ksh1.{payload_b64}".encode("ascii"), hashlib.sha256
        ).hexdigest()
        if not supplied_sig.isascii() or not hmac.compare_digest(
            supplied_sig.encode("ascii"), expected_sig.encode("ascii")
        ):
            raise SamlError(
                "invalid_handoff_token",
                "Invalid, tampered, or expired SAML OIDC handoff token",
                status=403,
            )

        padding = "=" * (-len(payload_b64) % 4)
        try:
            raw_bytes = base64.urlsafe_b64decode((payload_b64 + padding).encode("ascii"))
            claims = json.loads(raw_bytes.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise SamlError(
                "invalid_handoff_token",
                "Invalid, tampered, or expired SAML OIDC handoff token",
                status=403,
            ) from None

        if not isinstance(claims, dict) or claims.get("v") != 1:
            raise SamlError("invalid_handoff_token", "Malformed handoff claims", status=403)
        jti = claims.get("jti")
        sub = claims.get("sub")
        claim_slug = claims.get("tenant_slug")
        ret_path = claims.get("return_path")
        exp = claims.get("exp")
        if (
            not isinstance(jti, str)
            or not jti
            or not isinstance(sub, str)
            or not sub
            or claim_slug != tenant_slug
            or not isinstance(ret_path, str)
            or type(exp) is not int
            or (require_unexpired and now_epoch >= exp)
        ):
            raise SamlError(
                "invalid_handoff_token",
                "Invalid, tampered, or expired SAML OIDC handoff token",
                status=403,
            )
        return claims

    def _burn_handoff_state_best_effort(self, *, tenant_slug: str, handoff_key: str) -> None:
        if can_use_postgres():
            try:
                with transaction.atomic(), connection.cursor() as cur:
                    cur.execute(
                        "DELETE FROM public.ee_saml_pending_request "
                        "WHERE relay_state = %s AND tenant_slug = %s",
                        [handoff_key, tenant_slug],
                    )
            except DatabaseError:
                pass
        with self._lock:
            self._pending_by_relay.pop(handoff_key, None)

    def _resolve_oidc_verification_key(
        self,
        *,
        issuer: str,
        kid: str,
        now_epoch: int,
    ) -> tuple[str, Any] | None:
        clean_issuer = issuer.rstrip("/")
        with self._lock:
            reg = self._oidc_public_keys.get((clean_issuer, kid))
        if reg is not None:
            return reg
        try:
            from django.conf import settings

            if settings.configured:
                trusted = getattr(settings, "KODERA_AUTH_TRUST", ())
                for entry in trusted:
                    snap = getattr(entry, "snapshot", None)
                    if (
                        getattr(entry, "lane", None) == "customer"
                        and snap is not None
                        and getattr(snap, "issuer", "").rstrip("/") == clean_issuer
                        and int(getattr(snap, "expires_at", 0)) > now_epoch
                    ):
                        for key_entry in getattr(snap, "_keys", ()):
                            if getattr(key_entry, "kid", None) == kid:
                                return (str(key_entry.algorithm), key_entry.public)
        except ImportError:
            pass
        return None

    def _exchange_and_verify_oidc_code(
        self,
        *,
        issuer: str,
        authorization_code: str,
        redirect_uri: str,
        client_id: str,
        server_code_verifier: str,
        expected_nonce: str,
        expected_email: str,
        now_epoch: int,
    ) -> tuple[str, str]:
        """Execute RFC 7636 §4.5 `/token` exchange and verify the signed OIDC `id_token`."""
        token_endpoint = _resolve_token_endpoint_url(issuer)
        form_fields: dict[str, str] = {
            "grant_type": "authorization_code",
            "code": authorization_code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "code_verifier": server_code_verifier,
        }
        client_secret = os.environ.get("KODERA_SAML_OIDC_CLIENT_SECRET", "").strip()
        if not client_secret:
            try:
                from django.conf import settings

                if settings.configured:
                    cfg_sec = getattr(settings, "KODERA_SAML_OIDC_CLIENT_SECRET", None)
                    if isinstance(cfg_sec, str) and cfg_sec.strip():
                        client_secret = cfg_sec.strip()
            except ImportError:
                pass
        if client_secret:
            form_fields["client_secret"] = client_secret

        with self._lock:
            exchanger = self._oidc_token_exchanger
        effective_exchanger = exchanger or _default_http_oidc_token_exchanger

        token_resp = effective_exchanger(token_endpoint, form_fields)
        if not isinstance(token_resp, Mapping) or "error" in token_resp:
            raise SamlError(
                "oidc_code_exchange_failed",
                "OIDC provider rejected authorization-code exchange",
                status=403,
            )
        raw_id_token = token_resp.get("id_token")
        if not isinstance(raw_id_token, str) or not (32 <= len(raw_id_token) <= 16_384):
            raise SamlError(
                "oidc_code_exchange_failed",
                "OIDC token response missing id_token",
                status=403,
            )

        try:
            header = jwt.get_unverified_header(raw_id_token)
        except jwt.PyJWTError as exc:
            raise SamlError(
                "oidc_code_exchange_failed",
                "Malformed OIDC id_token header",
                status=403,
            ) from exc

        alg = header.get("alg")
        kid = header.get("kid")
        if alg not in {"RS256", "ES256"} or not isinstance(kid, str) or not kid:
            raise SamlError(
                "oidc_code_exchange_failed",
                "Unsupported OIDC id_token algorithm or missing kid",
                status=403,
            )

        resolved_key = self._resolve_oidc_verification_key(
            issuer=issuer,
            kid=kid,
            now_epoch=now_epoch,
        )
        if resolved_key is None or resolved_key[0] != alg:
            raise SamlError(
                "oidc_code_exchange_failed",
                "Untrusted OIDC issuer or unknown signing key",
                status=403,
            )

        try:
            id_claims = jwt.decode(
                raw_id_token,
                key=resolved_key[1],
                algorithms=[alg],
                audience=client_id,
                issuer=issuer.rstrip("/"),
                options={
                    "require": ["iss", "sub", "aud", "exp", "iat", "nonce"],
                    "verify_signature": True,
                    "verify_exp": False,
                    "verify_iat": False,
                },
            )
        except jwt.PyJWTError as exc:
            raise SamlError(
                "oidc_identity_mismatch",
                "OIDC id_token signature, issuer, or audience verification failed",
                status=403,
            ) from exc

        iat_val = id_claims.get("iat")
        exp_val = id_claims.get("exp")
        if (
            type(iat_val) is not int
            or type(exp_val) is not int
            or iat_val > now_epoch + 60
            or now_epoch >= exp_val
        ):
            raise SamlError(
                "oidc_identity_mismatch",
                "OIDC id_token validity window rejected",
                status=403,
            )

        nonce_val = id_claims.get("nonce")
        if not isinstance(nonce_val, str) or not hmac.compare_digest(
            nonce_val.encode("utf-8"),
            expected_nonce.encode("utf-8"),
        ):
            raise SamlError(
                "oidc_identity_mismatch",
                "OIDC id_token nonce mismatch",
                status=403,
            )

        tok_sub = id_claims.get("sub")
        tok_email = id_claims.get("email")
        if (
            not isinstance(tok_sub, str)
            or not (1 <= len(tok_sub) <= 255)
            or any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in tok_sub)
            or id_claims.get("email_verified") is False
            or not isinstance(tok_email, str)
            or tok_email.strip().lower() != expected_email.strip().lower()
        ):
            raise SamlError(
                "oidc_identity_mismatch",
                "OIDC id_token subject or email does not match SAML assertion",
                status=403,
            )
        return tok_sub, tok_email.strip().lower()

    def consume_oidc_handoff(
        self,
        *,
        tenant_slug: str,
        handoff_token: str,
        sp_base_url: str,
        authorization_code: str | None = None,
        provider_error: str | None = None,
        provider_error_description: str | None = None,
        code_verifier: str | None = None,
        now: datetime | None = None,
    ) -> SamlHandoffSession:
        """Complete SAML->OIDC callback via RFC 7636 PKCE `/token` exchange and single-use burn."""
        require_enterprise_edition()
        if not _is_valid_slug(tenant_slug):
            raise SamlError("invalid_tenant_slug", "Invalid tenant slug", status=400)
        norm_base = _normalize_sp_base_url(sp_base_url)
        current_time = (now or datetime.now(UTC)).astimezone(UTC)
        now_epoch = int(current_time.timestamp())

        # 1. Reject any OAuth/OIDC provider error callback (`error=access_denied`, etc.) with 403
        #    and immediately burn the pending `state` when authentic so it can never be replayed!
        if provider_error is not None or provider_error_description is not None:
            if handoff_token.strip():
                try:
                    err_claims = self._verify_handoff_state_signature(
                        tenant_slug=tenant_slug,
                        handoff_token=handoff_token,
                        now_epoch=now_epoch,
                        require_unexpired=False,
                    )
                    self._burn_handoff_state_best_effort(
                        tenant_slug=tenant_slug,
                        handoff_key=f"handoff:{err_claims['jti']}",
                    )
                except SamlError:
                    pass
            raise SamlError(
                "oidc_provider_error",
                "OIDC provider returned an authorization error",
                status=403,
            )

        # 2. Verify `state` (`handoff_token`) HMAC signature and expiry BEFORE inspecting DB.
        claims = self._verify_handoff_state_signature(
            tenant_slug=tenant_slug,
            handoff_token=handoff_token,
            now_epoch=now_epoch,
            require_unexpired=True,
        )
        jti = str(claims["jti"])
        sub = str(claims["sub"])
        ret_path = str(claims["return_path"])

        # 3. Require a non-empty, well-formed OAuth 2.0 authorization `code` BEFORE burning state.
        if authorization_code is None or not authorization_code.strip():
            raise SamlError(
                "missing_authorization_code",
                "Missing OIDC authorization code",
                status=400,
            )
        clean_code = authorization_code.strip()
        if len(clean_code) > 1024 or any(
            ch.isspace() or ord(ch) < 0x21 or ord(ch) > 0x7E for ch in clean_code
        ):
            raise SamlError(
                "invalid_authorization_code",
                "Malformed OIDC authorization code",
                status=400,
            )

        if code_verifier is not None and code_verifier.strip():
            if not _PKCE_VERIFIER_S256_RE.fullmatch(code_verifier.strip()):
                raise SamlError(
                    "invalid_pkce_verifier",
                    "PKCE code_verifier verification failed",
                    status=403,
                )

        clean_return = _sanitize_return_path(ret_path)
        handoff_key = f"handoff:{jti}"

        from ee.auth import EE_SAML_SESSION_TTL_SECONDS, issue_ee_saml_session_token

        if can_use_postgres():
            try:
                user_uuid = UUID(sub)
            except ValueError as exc:
                raise SamlError("invalid_handoff_token", "Invalid subject UUID", status=403) from exc

            # Phase A: Atomically validate optional client PKCE & burn single-use `handoff:<jti>`
            # BEFORE making the outbound OIDC `/token` HTTP call (zero DB locks held over network I/O!).
            try:
                with transaction.atomic(), connection.cursor() as cur:
                    org_id, resolved_slug = acquire_active_tenant_fence(
                        cur,
                        tenant_slug=tenant_slug,
                    )
                    cur.execute(
                        """
                        SELECT sp_base_url, return_path
                        FROM public.ee_saml_pending_request
                        WHERE relay_state = %s
                          AND organisation_id = %s
                          AND tenant_slug = %s
                          AND expires_at > %s
                        FOR UPDATE NOWAIT
                        """,
                        [handoff_key, org_id, resolved_slug, current_time],
                    )
                    pending_row = cur.fetchone()
                    if pending_row is None:
                        raise SamlError(
                            "replayed_handoff_token",
                            "SAML OIDC handoff token has already been consumed or expired",
                            status=403,
                        )
                    if str(pending_row[0]) != norm_base:
                        raise SamlError(
                            "sp_origin_mismatch",
                            "Service Provider origin does not match initiating handoff",
                            status=403,
                        )
                    stored_meta = json.loads(str(pending_row[1]))
                    stored_client_pkce = str(stored_meta.get("client_pkce", ""))
                    if (
                        code_verifier is not None
                        and code_verifier.strip()
                        and (
                            not stored_client_pkce
                            or not hmac.compare_digest(
                                _compute_pkce_s256(code_verifier.strip()).encode("ascii"),
                                stored_client_pkce.encode("ascii"),
                            )
                        )
                    ):
                        raise SamlError(
                            "invalid_pkce_verifier",
                            "PKCE code_verifier verification failed",
                            status=403,
                        )
                    cur.execute(
                        """
                        DELETE FROM public.ee_saml_pending_request
                        WHERE relay_state = %s AND organisation_id = %s
                        """,
                        [handoff_key, org_id],
                    )
            except TenantCutoffError as exc:
                raise SamlError(
                    exc.code,
                    "Organisation is unavailable for SAML session completion",
                    status=exc.status,
                ) from exc
            except DatabaseError as exc:
                if is_retriable_lock_contention(exc):
                    raise SamlError(
                        "authority_fenced",
                        "Organisation authority changed concurrently; retry request",
                        status=409,
                    ) from exc
                raise

            # Phase B: Exchange `code` + retained `server_code_verifier` at OIDC `/token` (RFC 7636 §4.5)
            # and cryptographically verify `id_token` claims (`iss`, `aud`, `exp`, `nonce`, `email`, `sub`).
            verified_oidc_sub, _verified_email = self._exchange_and_verify_oidc_code(
                issuer=str(stored_meta["issuer"]),
                authorization_code=clean_code,
                redirect_uri=str(stored_meta["redirect_uri"]),
                client_id=str(stored_meta["client_id"]),
                server_code_verifier=str(stored_meta["code_verifier"]),
                expected_nonce=str(stored_meta["oidc_nonce"]),
                expected_email=str(stored_meta["email"]),
                now_epoch=now_epoch,
            )

            # Phase C: Re-verify live active `(User, Identity, Membership)` + `sub` match in Postgres!
            try:
                with transaction.atomic(), connection.cursor() as cur:
                    org_id, resolved_slug = acquire_active_tenant_fence(
                        cur,
                        tenant_slug=tenant_slug,
                    )
                    cur.execute(
                        "SELECT pg_try_advisory_xact_lock_shared("
                        "hashtextextended('privacy_account_cutoff:' || %s, 0))",
                        [str(user_uuid)],
                    )
                    lock_row = cur.fetchone()
                    if not lock_row or not bool(lock_row[0]):
                        raise SamlError(
                            "authority_fenced",
                            "Account privacy lock busy; retry request",
                            status=409,
                        )

                    cur.execute(
                        """
                        SELECT u.email, u.enabled, u.deleted_at
                        FROM public.identity_user u
                        WHERE u.id = %s
                        FOR SHARE OF u
                        """,
                        [user_uuid],
                    )
                    u_row = cur.fetchone()
                    if u_row is None or u_row[2] is not None or str(u_row[0]).startswith("erased:"):
                        raise SamlError(
                            "account_cutoff_fenced",
                            "Account is under privacy erasure cutoff",
                            status=403,
                        )
                    if not bool(u_row[1]):
                        raise SamlError("user_disabled", "User account is disabled", status=403)

                    cur.execute(
                        "SELECT o.issuer FROM public.orgs_organisation o WHERE o.id = %s",
                        [org_id],
                    )
                    o_row = cur.fetchone()
                    if o_row is None or not o_row[0]:
                        raise SamlError(
                            "organisation_not_found",
                            "Bound organisation does not exist",
                            status=404,
                        )
                    org_issuer = str(o_row[0])

                    cur.execute(
                        """
                        SELECT i.subject
                        FROM public.identity_identity i
                        WHERE i.organisation_id = %s
                          AND i.user_id = %s
                          AND i.issuer = %s
                          AND i.enabled = TRUE
                          AND i.deleted_at IS NULL
                        ORDER BY i.created_at ASC, i.id ASC
                        LIMIT 1
                        """,
                        [org_id, user_uuid, org_issuer],
                    )
                    i_row = cur.fetchone()
                    if i_row is None:
                        raise SamlError(
                            "identity_unknown",
                            "Authenticated identity is not provisioned",
                            status=403,
                        )
                    ident_subject = str(i_row[0])
                    if verified_oidc_sub not in {ident_subject, str(user_uuid)}:
                        raise SamlError(
                            "oidc_identity_mismatch",
                            "OIDC id_token subject does not match provisioned SAML identity",
                            status=403,
                        )

                    cur.execute(
                        """
                        SELECT m.role
                        FROM public.orgs_membership m
                        WHERE m.organisation_id = %s
                          AND m.user_id = %s
                          AND m.state = 'active'
                          AND m.accepted_at IS NOT NULL
                          AND m.deleted_at IS NULL
                        ORDER BY m.id ASC
                        LIMIT 1
                        FOR SHARE OF m NOWAIT
                        """,
                        [org_id, user_uuid],
                    )
                    m_row = cur.fetchone()
                    if m_row is None:
                        raise SamlError(
                            "tenant_membership_required",
                            "Active tenant membership is required",
                            status=403,
                        )
                    live_role = str(m_row[0])
            except TenantCutoffError as exc:
                raise SamlError(
                    exc.code,
                    "Organisation is unavailable for SAML session completion",
                    status=exc.status,
                ) from exc
            except DatabaseError as exc:
                if is_retriable_lock_contention(exc):
                    raise SamlError(
                        "authority_fenced",
                        "Organisation authority changed concurrently; retry request",
                        status=409,
                    ) from exc
                raise

            access_token = issue_ee_saml_session_token(
                issuer=org_issuer,
                subject=ident_subject,
                user_id=user_uuid,
                organisation_id=org_id,
                tenant_slug=resolved_slug,
                now=now_epoch,
                ttl_seconds=EE_SAML_SESSION_TTL_SECONDS,
            )
            passport_token = _issue_core_passport_token(
                user_id=user_uuid,
                active_organisation_id=org_id,
                now_epoch=now_epoch,
            )
            return SamlHandoffSession(
                user_id=str(user_uuid),
                tenant_slug=resolved_slug,
                role=live_role,
                return_path=clean_return,
                access_token=access_token,
                expires_in=EE_SAML_SESSION_TTL_SECONDS,
                passport_token=passport_token,
            )

        with self._lock:
            self._prune_pending_locked(current_time)
            mem_pending = self._pending_by_relay.get(handoff_key)
            if mem_pending is None:
                raise SamlError(
                    "replayed_handoff_token",
                    "SAML OIDC handoff token has already been consumed or expired",
                    status=403,
                )
            if mem_pending.sp_base_url != norm_base:
                raise SamlError(
                    "sp_origin_mismatch",
                    "Service Provider origin does not match initiating handoff",
                    status=403,
                )
            mem_meta = json.loads(mem_pending.return_path)
            mem_client_pkce = str(mem_meta.get("client_pkce", ""))
            if (
                code_verifier is not None
                and code_verifier.strip()
                and (
                    not mem_client_pkce
                    or not hmac.compare_digest(
                        _compute_pkce_s256(code_verifier.strip()).encode("ascii"),
                        mem_client_pkce.encode("ascii"),
                    )
                )
            ):
                raise SamlError(
                    "invalid_pkce_verifier",
                    "PKCE code_verifier verification failed",
                    status=403,
                )
            del self._pending_by_relay[handoff_key]
            mem_role = str(mem_meta.get("role", "org_member"))

        verified_mem_sub, _ = self._exchange_and_verify_oidc_code(
            issuer=str(mem_meta["issuer"]),
            authorization_code=clean_code,
            redirect_uri=str(mem_meta["redirect_uri"]),
            client_id=str(mem_meta["client_id"]),
            server_code_verifier=str(mem_meta["code_verifier"]),
            expected_nonce=str(mem_meta["oidc_nonce"]),
            expected_email=str(mem_meta["email"]),
            now_epoch=now_epoch,
        )
        mem_org_uuid = uuid5(_SAML_SUBJECT_NAMESPACE, f"mem-org:{tenant_slug}")
        mem_idp_id = str(mem_meta.get("idp_id", ""))
        mem_name_id = str(mem_meta.get("subject_name_id", ""))
        allowed_mem_subs = {
            sub,
            _canonical_saml_subject_uuid(mem_org_uuid, mem_idp_id, mem_name_id),
        }
        with self._lock:
            mem_idp = self._idps.get((tenant_slug, mem_idp_id))
        if mem_idp is not None and mem_idp.organisation_id is not None:
            allowed_mem_subs.add(
                _canonical_saml_subject_uuid(mem_idp.organisation_id, mem_idp_id, mem_name_id)
            )
        if verified_mem_sub not in allowed_mem_subs:
            raise SamlError(
                "oidc_identity_mismatch",
                "OIDC id_token subject does not match SAML principal",
                status=403,
            )
        mem_user_uuid = (
            UUID(sub) if len(sub) == 36 else uuid5(_SAML_SUBJECT_NAMESPACE, f"mem-user:{sub}")
        )
        access_token = issue_ee_saml_session_token(
            issuer=str(mem_meta["issuer"]),
            subject=str(mem_user_uuid),
            user_id=mem_user_uuid,
            organisation_id=mem_org_uuid,
            tenant_slug=tenant_slug,
            now=now_epoch,
            ttl_seconds=EE_SAML_SESSION_TTL_SECONDS,
        )
        return SamlHandoffSession(
            user_id=sub,
            tenant_slug=tenant_slug,
            role=mem_role,
            return_path=clean_return,
            access_token=access_token,
            expires_in=EE_SAML_SESSION_TTL_SECONDS,
            passport_token=None,
        )

    def sp_entity_id(self, tenant_slug: str, sp_base_url: str) -> str:
        if not _is_valid_slug(tenant_slug):
            raise SamlError("invalid_tenant_slug", "Invalid tenant slug")
        base = _normalize_sp_base_url(sp_base_url)
        return f"{base}/api/v1/ee/sso/saml/{tenant_slug}/metadata"

    def sp_acs_url(self, tenant_slug: str, sp_base_url: str) -> str:
        if not _is_valid_slug(tenant_slug):
            raise SamlError("invalid_tenant_slug", "Invalid tenant slug")
        base = _normalize_sp_base_url(sp_base_url)
        return f"{base}/api/v1/ee/sso/saml/{tenant_slug}/acs"

    def register_idp(self, config: SamlIdpConfig) -> SamlIdpConfig:
        require_enterprise_edition()
        if can_use_postgres():
            domains_json = json.dumps(sorted(config.verified_domains))
            mapping_json = json.dumps(dict(config.group_role_mapping), sort_keys=True)
            now_ts = datetime.now(UTC)
            try:
                with transaction.atomic(), connection.cursor() as cur:
                    org_id, resolved_slug = acquire_active_tenant_fence(
                        cur,
                        tenant_slug=config.tenant_slug,
                        organisation_id=config.organisation_id,
                    )
                    cur.execute(
                        """
                        INSERT INTO public.ee_saml_idp (
                            id, organisation_id, tenant_slug, idp_id, idp_entity_id,
                            idp_sso_url, public_key_pem, verified_domains_json,
                            group_role_mapping_json, default_role, want_assertions_signed,
                            clock_skew_seconds, created_at, updated_at
                        ) VALUES (
                            %s, %s, %s, %s, %s,
                            %s, %s, %s,
                            %s, %s, %s,
                            %s, %s, %s
                        )
                        ON CONFLICT (tenant_slug, idp_id) DO UPDATE SET
                            idp_entity_id = EXCLUDED.idp_entity_id,
                            idp_sso_url = EXCLUDED.idp_sso_url,
                            public_key_pem = EXCLUDED.public_key_pem,
                            verified_domains_json = EXCLUDED.verified_domains_json,
                            group_role_mapping_json = EXCLUDED.group_role_mapping_json,
                            default_role = EXCLUDED.default_role,
                            want_assertions_signed = EXCLUDED.want_assertions_signed,
                            clock_skew_seconds = EXCLUDED.clock_skew_seconds,
                            updated_at = EXCLUDED.updated_at
                        """,
                        [
                            uuid7(),
                            org_id,
                            resolved_slug,
                            config.idp_id,
                            config.idp_entity_id,
                            config.idp_sso_url,
                            config.public_key_pem,
                            domains_json,
                            mapping_json,
                            config.default_role,
                            config.want_assertions_signed,
                            config.clock_skew_seconds,
                            now_ts,
                            now_ts,
                        ],
                    )
            except TenantCutoffError as exc:
                raise SamlError(
                    exc.code,
                    "Organisation is unavailable for SAML writes",
                    status=exc.status,
                ) from exc
            except IntegrityError as exc:
                raise SamlError(
                    "tenant_cutoff_fenced",
                    "SAML write refused by privacy cutoff",
                    status=403,
                ) from exc

            return SamlIdpConfig(
                tenant_slug=resolved_slug,
                idp_id=config.idp_id,
                idp_entity_id=config.idp_entity_id,
                idp_sso_url=config.idp_sso_url,
                public_key_pem=config.public_key_pem,
                verified_domains=config.verified_domains,
                group_role_mapping=config.group_role_mapping,
                default_role=config.default_role,
                want_assertions_signed=config.want_assertions_signed,
                clock_skew_seconds=config.clock_skew_seconds,
                organisation_id=org_id,
            )

        with self._lock:
            self._idps[(config.tenant_slug, config.idp_id)] = config
        return config

    def list_idps(self, tenant_slug: str) -> list[SamlIdpConfig]:
        require_enterprise_edition()
        if can_use_postgres():
            with connection.cursor() as cur:
                cur.execute(
                    """
                    SELECT tenant_slug, idp_id, idp_entity_id, idp_sso_url, public_key_pem,
                           verified_domains_json, group_role_mapping_json, default_role,
                           want_assertions_signed, clock_skew_seconds, organisation_id
                    FROM public.ee_saml_idp
                    WHERE tenant_slug = %s
                    ORDER BY idp_id ASC
                    """,
                    [tenant_slug],
                )
                rows = cur.fetchall()
            return [_idp_from_row(row) for row in rows]

        with self._lock:
            return [cfg for (t_slug, _), cfg in sorted(self._idps.items()) if t_slug == tenant_slug]

    def get_idp(self, tenant_slug: str, idp_id: str) -> SamlIdpConfig:
        require_enterprise_edition()
        if can_use_postgres():
            with connection.cursor() as cur:
                cur.execute(
                    """
                    SELECT tenant_slug, idp_id, idp_entity_id, idp_sso_url, public_key_pem,
                           verified_domains_json, group_role_mapping_json, default_role,
                           want_assertions_signed, clock_skew_seconds, organisation_id
                    FROM public.ee_saml_idp
                    WHERE tenant_slug = %s AND idp_id = %s
                    """,
                    [tenant_slug, idp_id],
                )
                row = cur.fetchone()
            cfg = _idp_from_row(row) if row is not None else None
        else:
            with self._lock:
                cfg = self._idps.get((tenant_slug, idp_id))

        if cfg is None:
            raise SamlError(
                "idp_not_found",
                f"SAML Identity Provider {idp_id!r} is not configured for tenant {tenant_slug!r}",
                status=404,
            )
        return cfg

    def build_sp_metadata_xml(self, tenant_slug: str, sp_base_url: str) -> bytes:
        require_enterprise_edition()
        entity_id = _escape_c14n_attr(self.sp_entity_id(tenant_slug, sp_base_url))
        acs_url = _escape_c14n_attr(self.sp_acs_url(tenant_slug, sp_base_url))
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<md:EntityDescriptor xmlns:md="{SAML_METADATA_NS}" entityID="{entity_id}">'
            '<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" '
            f'protocolSupportEnumeration="{SAML_PROTOCOL_NS}">'
            f"<md:NameIDFormat>{SAML_NAMEID_EMAIL}</md:NameIDFormat>"
            f'<md:AssertionConsumerService Binding="{SAML_BINDING_HTTP_POST}" '
            f'Location="{acs_url}" index="0" isDefault="true"/>'
            "</md:SPSSODescriptor>"
            "</md:EntityDescriptor>"
        )
        return xml.encode("utf-8")

    def _sign_relay_token(
        self,
        *,
        nonce: str,
        tenant_slug: str,
        idp_id: str,
        request_id: str,
        return_path: str,
        expires_epoch: int,
    ) -> str:
        mac_input = (
            f"kodera-saml-relay-v1\x00{nonce}\x00{tenant_slug}\x00{idp_id}\x00"
            f"{request_id}\x00{return_path}\x00{expires_epoch}"
        ).encode()
        digest = hmac.new(self._relay_hmac_key(), mac_input, hashlib.sha256).hexdigest()
        return f"{nonce}.{digest}"

    def create_authn_request(
        self,
        *,
        tenant_slug: str,
        idp_id: str,
        sp_base_url: str,
        return_path: str = "/",
        client_id: str | None = None,
        redirect_uri: str | None = None,
        code_challenge: str | None = None,
        code_challenge_method: str | None = None,
        now: datetime | None = None,
    ) -> AuthnRequestBundle:
        require_enterprise_edition()
        idp = self.get_idp(tenant_slug, idp_id)
        clean_return = _sanitize_return_path(return_path)
        norm_base = _normalize_sp_base_url(sp_base_url)
        clean_client_id = _validate_oidc_client_id(client_id)
        clean_redirect_uri = (
            _validate_oidc_redirect_uri(
                redirect_uri,
                sp_base_url=norm_base,
                tenant_slug=tenant_slug,
            )
            if redirect_uri is not None and redirect_uri.strip()
            else None
        )
        clean_pkce = _validate_optional_pkce(code_challenge, code_challenge_method)
        encoded_context = _encode_pending_context(
            clean_return,
            client_id=clean_client_id,
            redirect_uri=clean_redirect_uri,
            code_challenge=clean_pkce,
        )
        entity_id = self.sp_entity_id(tenant_slug, norm_base)
        acs_url = self.sp_acs_url(tenant_slug, norm_base)

        issued_at = (now or datetime.now(UTC)).astimezone(UTC).replace(microsecond=0)
        expires_at = issued_at + timedelta(seconds=DEFAULT_AUTHN_REQUEST_TTL_S)
        expires_epoch = int(expires_at.timestamp())

        request_id = "_" + secrets.token_hex(16)
        nonce = secrets.token_urlsafe(24)
        relay_state = self._sign_relay_token(
            nonce=nonce,
            tenant_slug=tenant_slug,
            idp_id=idp.idp_id,
            request_id=request_id,
            return_path=encoded_context,
            expires_epoch=expires_epoch,
        )

        authn_xml = (
            f'<samlp:AuthnRequest xmlns:samlp="{SAML_PROTOCOL_NS}" '
            f'xmlns:saml="{SAML_ASSERTION_NS}" '
            f'ID="{_escape_c14n_attr(request_id)}" '
            'Version="2.0" '
            f'IssueInstant="{_format_saml_instant(issued_at)}" '
            f'Destination="{_escape_c14n_attr(idp.idp_sso_url)}" '
            f'ProtocolBinding="{SAML_BINDING_HTTP_POST}" '
            f'AssertionConsumerServiceURL="{_escape_c14n_attr(acs_url)}">'
            f"<saml:Issuer>{_escape_c14n_attr(entity_id)}</saml:Issuer>"
            f'<samlp:NameIDPolicy Format="{SAML_NAMEID_EMAIL}" AllowCreate="true"/>'
            "</samlp:AuthnRequest>"
        )

        compressor = zlib.compressobj(level=6, method=zlib.DEFLATED, wbits=-15)
        deflated = compressor.compress(authn_xml.encode("utf-8")) + compressor.flush()
        saml_req_b64 = base64.b64encode(deflated).decode("ascii")

        sep = "&" if "?" in idp.idp_sso_url else "?"
        query = urllib.parse.urlencode({"SAMLRequest": saml_req_b64, "RelayState": relay_state})
        redirect_url = f"{idp.idp_sso_url}{sep}{query}"

        pending = _PendingRequest(
            tenant_slug=tenant_slug,
            idp_id=idp.idp_id,
            request_id=request_id,
            relay_state=relay_state,
            return_path=encoded_context,
            sp_base_url=norm_base,
            expires_at=expires_at,
        )
        if can_use_postgres():
            try:
                with transaction.atomic(), connection.cursor() as cur:
                    org_id, resolved_slug = acquire_active_tenant_fence(
                        cur,
                        tenant_slug=tenant_slug,
                        organisation_id=idp.organisation_id,
                    )
                    cur.execute(
                        "DELETE FROM public.ee_saml_pending_request WHERE expires_at <= %s",
                        [issued_at],
                    )
                    cur.execute(
                        """
                        INSERT INTO public.ee_saml_pending_request (
                            relay_state, organisation_id, tenant_slug, idp_id,
                            request_id, return_path, sp_base_url, expires_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        [
                            relay_state,
                            org_id,
                            resolved_slug,
                            idp.idp_id,
                            request_id,
                            encoded_context,
                            norm_base,
                            expires_at,
                        ],
                    )
            except TenantCutoffError as exc:
                raise SamlError(
                    exc.code, "Organisation is unavailable for SAML login", status=exc.status
                ) from exc
            except IntegrityError as exc:
                raise SamlError(
                    "tenant_cutoff_fenced", "SAML login refused by privacy cutoff", status=403
                ) from exc
        else:
            with self._lock:
                self._prune_pending_locked(issued_at)
                self._pending_by_relay[relay_state] = pending
                while len(self._pending_by_relay) > MAX_PENDING_REQUESTS:
                    self._pending_by_relay.popitem(last=False)

        return AuthnRequestBundle(
            tenant_slug=tenant_slug,
            idp_id=idp.idp_id,
            request_id=request_id,
            relay_state=relay_state,
            redirect_url=redirect_url,
            destination=idp.idp_sso_url,
            sp_entity_id=entity_id,
            acs_url=acs_url,
            saml_request_xml=authn_xml,
            expires_at=expires_at,
        )

    def _prune_pending_locked(self, now: datetime) -> None:
        expired = [key for key, item in self._pending_by_relay.items() if item.expires_at <= now]
        for key in expired:
            del self._pending_by_relay[key]

    def _prune_replay_locked(self, now: datetime) -> None:
        expired = [key for key, exp in self._replay_cache.items() if exp <= now]
        for key in expired:
            del self._replay_cache[key]

    def _peek_relay_state(
        self,
        *,
        tenant_slug: str,
        relay_state: str,
        sp_base_url: str,
        now: datetime,
    ) -> _PendingRequest:
        """Validate `RelayState` without mutating DB state so unauthenticated XML cannot burn it."""
        if not relay_state or "." not in relay_state or len(relay_state) > 256:
            raise SamlError(
                "invalid_relay_state", "Missing or malformed SAML RelayState", status=403
            )
        nonce, _, _ = relay_state.partition(".")
        if not nonce:
            raise SamlError("invalid_relay_state", "Malformed SAML RelayState nonce", status=403)

        pending: _PendingRequest | None = None
        if can_use_postgres():
            with connection.cursor() as cur:
                cur.execute(
                    """
                    SELECT tenant_slug, idp_id, request_id, return_path, sp_base_url, expires_at
                    FROM public.ee_saml_pending_request
                    WHERE relay_state = %s AND expires_at > %s
                    """,
                    [relay_state, now],
                )
                row = cur.fetchone()
            if row is not None:
                exp_val = row[5]
                exp_dt = (
                    exp_val.astimezone(UTC)
                    if isinstance(exp_val, datetime)
                    else datetime.fromisoformat(str(exp_val)).astimezone(UTC)
                )
                pending = _PendingRequest(
                    tenant_slug=str(row[0]),
                    idp_id=str(row[1]),
                    request_id=str(row[2]),
                    relay_state=relay_state,
                    return_path=str(row[3]),
                    sp_base_url=str(row[4]),
                    expires_at=exp_dt,
                )
        else:
            with self._lock:
                self._prune_pending_locked(now)
                pending = self._pending_by_relay.get(relay_state)

        if pending is None:
            raise SamlError(
                "invalid_relay_state",
                "Unknown, expired, or already-consumed SAML RelayState",
                status=403,
            )

        expected_token = self._sign_relay_token(
            nonce=nonce,
            tenant_slug=pending.tenant_slug,
            idp_id=pending.idp_id,
            request_id=pending.request_id,
            return_path=pending.return_path,
            expires_epoch=int(pending.expires_at.timestamp()),
        )
        if not hmac.compare_digest(relay_state, expected_token):
            raise SamlError(
                "invalid_relay_state", "SAML RelayState CSRF verification failed", status=403
            )
        if pending.tenant_slug != tenant_slug:
            raise SamlError(
                "cross_tenant_relay_state",
                "SAML RelayState belongs to a different tenant",
                status=403,
            )
        norm_base = _normalize_sp_base_url(sp_base_url)
        if pending.sp_base_url != norm_base:
            raise SamlError(
                "sp_origin_mismatch",
                "Service Provider origin does not match initiating AuthnRequest",
                status=403,
            )
        return pending

    def _record_assertion_once(
        self,
        *,
        tenant_slug: str,
        idp_entity_id: str,
        assertion_id: str,
        expires_at: datetime,
        now: datetime,
        organisation_id: UUID | None = None,
    ) -> None:
        if can_use_postgres():
            try:
                with transaction.atomic(), connection.cursor() as cur:
                    org_id, resolved_slug = acquire_active_tenant_fence(
                        cur,
                        tenant_slug=tenant_slug,
                        organisation_id=organisation_id,
                    )
                    cur.execute(
                        "DELETE FROM public.ee_saml_replay_assertion WHERE expires_at <= %s",
                        [now],
                    )
                    cur.execute(
                        """
                        INSERT INTO public.ee_saml_replay_assertion (
                            id, organisation_id, tenant_slug, idp_entity_id, assertion_id, expires_at
                        ) VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (tenant_slug, idp_entity_id, assertion_id) DO NOTHING
                        RETURNING assertion_id
                        """,
                        [uuid7(), org_id, resolved_slug, idp_entity_id, assertion_id, expires_at],
                    )
                    inserted = cur.fetchone()
            except TenantCutoffError as exc:
                raise SamlError(
                    exc.code, "Organisation is unavailable for SAML ACS", status=exc.status
                ) from exc
            except IntegrityError as exc:
                raise SamlError(
                    "tenant_cutoff_fenced", "SAML ACS refused by privacy cutoff", status=403
                ) from exc

            if inserted is None:
                raise SamlError(
                    "replayed_assertion_id",
                    "SAML Assertion ID has already been consumed (replay detected)",
                    status=403,
                )
            return

        replay_key = (tenant_slug, idp_entity_id, assertion_id)
        with self._lock:
            self._prune_replay_locked(now)
            if replay_key in self._replay_cache:
                raise SamlError(
                    "replayed_assertion_id",
                    "SAML Assertion ID has already been consumed (replay detected)",
                    status=403,
                )
            self._replay_cache[replay_key] = expires_at
            while len(self._replay_cache) > MAX_REPLAY_ENTRIES:
                self._replay_cache.popitem(last=False)

    def consume_saml_response(
        self,
        *,
        tenant_slug: str,
        saml_response_b64: str,
        relay_state: str,
        sp_base_url: str,
        now: datetime | None = None,
    ) -> ProvisionedSamlPrincipal:
        """Validate a SAML 2.0 `SAMLResponse` and provision the federated tenant member."""
        require_enterprise_edition()
        current_time = (now or datetime.now(UTC)).astimezone(UTC)

        # Decode and run hardened XML security checks FIRST so XXE / DTD / malformed XML payloads
        # are deterministically rejected before consulting protocol state.
        if not saml_response_b64 or len(saml_response_b64) > 360_000:
            raise SamlError(
                "invalid_saml_response", "Missing or oversized SAMLResponse payload", status=400
            )
        try:
            xml_bytes = base64.b64decode(saml_response_b64.strip(), validate=True)
        except Exception as exc:
            raise SamlError(
                "invalid_base64_response", "SAMLResponse is not valid base64", status=400
            ) from exc

        try:
            response_root = parse_hardened_xml(xml_bytes)
        except SamlXmlSecurityError as exc:
            raise SamlError(
                exc.code, "SAML XML payload failed security validation", status=400
            ) from exc

        pending = self._peek_relay_state(
            tenant_slug=tenant_slug,
            relay_state=relay_state,
            sp_base_url=sp_base_url,
            now=current_time,
        )
        idp = self.get_idp(tenant_slug, pending.idp_id)

        try:
            assertion_node = verify_saml_response_tree(
                response_root,
                idp.public_key,
                want_assertions_signed=idp.want_assertions_signed,
            )
        except SamlSignatureError as exc:
            raise SamlError(exc.code, "SAML signature verification failed", status=403) from exc

        expected_entity_id = self.sp_entity_id(tenant_slug, sp_base_url)
        expected_acs_url = self.sp_acs_url(tenant_slug, sp_base_url)

        if response_root.attr("Version") != "2.0" or assertion_node.attr("Version") != "2.0":
            raise SamlError("unsupported_saml_version", "SAML Version must be 2.0", status=400)

        resp_in_response_to = response_root.attr("InResponseTo")
        if not resp_in_response_to or not hmac.compare_digest(
            resp_in_response_to, pending.request_id
        ):
            raise SamlError(
                "in_response_to_mismatch",
                "SAML Response InResponseTo does not match pending AuthnRequest ID",
                status=403,
            )

        resp_destination = response_root.attr("Destination")
        if not resp_destination or resp_destination != expected_acs_url:
            raise SamlError(
                "invalid_destination",
                "SAML Response Destination does not match Service Provider ACS URL",
                status=403,
            )

        # Verify Status == Success
        status_el = response_root.find_first_child(SAML_PROTOCOL_NS, "Status")
        status_code_el = (
            status_el.find_first_child(SAML_PROTOCOL_NS, "StatusCode")
            if status_el is not None
            else None
        )
        if status_code_el is None or status_code_el.attr("Value") != SAML_STATUS_SUCCESS:
            raise SamlError(
                "saml_status_not_success", "IdP returned non-Success SAML Status", status=403
            )

        # Verify Issuer on Response (if present) and Assertion (required)
        resp_issuer_el = response_root.find_first_child(SAML_ASSERTION_NS, "Issuer")
        if resp_issuer_el is not None:
            resp_issuer = resp_issuer_el.text_content(forbid_child_elements=True).strip()
            if resp_issuer != idp.idp_entity_id:
                raise SamlError(
                    "issuer_mismatch", "Response Issuer does not match configured IdP", status=403
                )

        assertion_issuer_el = assertion_node.find_first_child(SAML_ASSERTION_NS, "Issuer")
        if assertion_issuer_el is None:
            raise SamlError("missing_assertion_issuer", "Assertion lacks saml:Issuer", status=403)
        assertion_issuer = assertion_issuer_el.text_content(forbid_child_elements=True).strip()
        if assertion_issuer != idp.idp_entity_id:
            raise SamlError(
                "issuer_mismatch", "Assertion Issuer does not match configured IdP", status=403
            )

        assertion_id = assertion_node.attr("ID") or ""
        if not assertion_id:
            raise SamlError("missing_assertion_id", "Assertion lacks ID attribute", status=403)

        skew = timedelta(seconds=idp.clock_skew_seconds)

        # Validate Subject & SubjectConfirmationData
        subject_el = assertion_node.find_first_child(SAML_ASSERTION_NS, "Subject")
        if subject_el is None:
            raise SamlError("missing_subject", "Assertion lacks saml:Subject", status=403)
        name_id_el = subject_el.find_first_child(SAML_ASSERTION_NS, "NameID")
        if name_id_el is None:
            raise SamlError("missing_name_id", "Subject lacks saml:NameID", status=403)
        subject_name_id = name_id_el.text_content(forbid_child_elements=True).strip()
        if not subject_name_id:
            raise SamlError("empty_name_id", "Subject NameID is empty", status=403)

        confirmations = subject_el.find_children(SAML_ASSERTION_NS, "SubjectConfirmation")
        bearer_data: XmlNode | None = None
        for conf in confirmations:
            if conf.attr("Method") == SAML_CM_BEARER:
                bearer_data = conf.find_first_child(SAML_ASSERTION_NS, "SubjectConfirmationData")
                if bearer_data is not None:
                    break
        if bearer_data is None:
            raise SamlError(
                "missing_bearer_confirmation",
                "Subject lacks bearer SubjectConfirmationData",
                status=403,
            )

        if bearer_data.attr("Recipient") != expected_acs_url:
            raise SamlError(
                "invalid_recipient",
                "SubjectConfirmationData Recipient does not match Service Provider ACS URL",
                status=403,
            )
        subj_irt = bearer_data.attr("InResponseTo")
        if not subj_irt or not hmac.compare_digest(subj_irt, pending.request_id):
            raise SamlError(
                "in_response_to_mismatch",
                "SubjectConfirmationData InResponseTo does not match pending AuthnRequest ID",
                status=403,
            )
        subj_noa = _parse_saml_instant(
            bearer_data.attr("NotOnOrAfter"),
            "SubjectConfirmationData.NotOnOrAfter",
        )
        if current_time >= subj_noa + skew:
            raise SamlError(
                "assertion_expired", "SubjectConfirmationData NotOnOrAfter has expired", status=403
            )
        if bearer_data.attr("NotBefore") is not None:
            subj_nb = _parse_saml_instant(
                bearer_data.attr("NotBefore"),
                "SubjectConfirmationData.NotBefore",
            )
            if current_time < subj_nb - skew:
                raise SamlError(
                    "assertion_not_yet_valid",
                    "SubjectConfirmationData NotBefore is in the future",
                    status=403,
                )

        # Validate Conditions & AudienceRestriction
        conditions_el = assertion_node.find_first_child(SAML_ASSERTION_NS, "Conditions")
        if conditions_el is None:
            raise SamlError("missing_conditions", "Assertion lacks saml:Conditions", status=403)

        cond_nb = _parse_saml_instant(conditions_el.attr("NotBefore"), "Conditions.NotBefore")
        cond_noa = _parse_saml_instant(
            conditions_el.attr("NotOnOrAfter"), "Conditions.NotOnOrAfter"
        )
        if cond_nb >= cond_noa:
            raise SamlError(
                "invalid_condition_window",
                "Conditions NotBefore must precede NotOnOrAfter",
                status=403,
            )
        if current_time < cond_nb - skew:
            raise SamlError(
                "assertion_not_yet_valid", "Assertion NotBefore is in the future", status=403
            )
        if current_time >= cond_noa + skew:
            raise SamlError("assertion_expired", "Assertion NotOnOrAfter has expired", status=403)

        audience_restrictions = conditions_el.find_children(
            SAML_ASSERTION_NS, "AudienceRestriction"
        )
        if not audience_restrictions:
            raise SamlError(
                "missing_audience_restriction", "Conditions lacks AudienceRestriction", status=403
            )
        for restriction in audience_restrictions:
            audiences = [
                aud.text_content(forbid_child_elements=True).strip()
                for aud in restriction.find_children(SAML_ASSERTION_NS, "Audience")
            ]
            if expected_entity_id not in audiences:
                raise SamlError(
                    "invalid_audience",
                    "Assertion AudienceRestriction does not authorize this Service Provider",
                    status=403,
                )

        # Extract attributes from verified Assertion ONLY before committing replay & provisioning
        attrs = _extract_attributes(assertion_node)
        email = _resolve_verified_email(subject_name_id, attrs, idp.verified_domains)
        display_name = _resolve_display_name(attrs, email)
        groups = _resolve_groups(attrs)
        role = _resolve_mapped_role(groups, idp.group_role_mapping, idp.default_role)

        decoded_return, oidc_client_id, oidc_redirect_uri, oidc_code_challenge = (
            _decode_pending_context(pending.return_path)
        )
        replay_expiry = max(cond_noa, subj_noa) + skew
        return self._commit_verified_assertion_and_principal(
            idp=idp,
            relay_state=relay_state,
            assertion_id=assertion_id,
            replay_expiry=replay_expiry,
            subject_name_id=subject_name_id,
            email=email,
            display_name=display_name,
            groups=groups,
            role=role,
            return_path=decoded_return,
            oidc_client_id=oidc_client_id,
            oidc_redirect_uri=oidc_redirect_uri,
            oidc_code_challenge=oidc_code_challenge,
            authenticated_at=current_time,
        )

    def _commit_verified_assertion_and_principal(
        self,
        *,
        idp: SamlIdpConfig,
        relay_state: str,
        assertion_id: str,
        replay_expiry: datetime,
        subject_name_id: str,
        email: str,
        display_name: str,
        groups: tuple[str, ...],
        role: str,
        return_path: str,
        oidc_client_id: str = "console",
        oidc_redirect_uri: str | None = None,
        oidc_code_challenge: str | None = None,
        authenticated_at: datetime,
    ) -> ProvisionedSamlPrincipal:
        """Atomically consume `RelayState`, record assertion replay nonce, and JIT-provision member."""
        email_low = email.lower()
        existing = self.get_provisioned_principal(idp.tenant_slug, email_low)
        principal_ref = existing.user_id if existing is not None else str(uuid4())
        linked_person_id: UUID | None = None

        if can_use_postgres():
            try:
                with transaction.atomic(), connection.cursor() as cur:
                    org_id, resolved_slug = acquire_active_tenant_fence(
                        cur,
                        tenant_slug=idp.tenant_slug,
                        organisation_id=idp.organisation_id,
                    )
                    cur.execute(
                        "DELETE FROM public.ee_saml_pending_request WHERE expires_at <= %s",
                        [authenticated_at],
                    )
                    cur.execute(
                        """
                        DELETE FROM public.ee_saml_pending_request
                        WHERE relay_state = %s AND expires_at > %s
                        RETURNING request_id
                        """,
                        [relay_state, authenticated_at],
                    )
                    if cur.fetchone() is None:
                        raise SamlError(
                            "invalid_relay_state",
                            "Unknown, expired, or already-consumed SAML RelayState",
                            status=403,
                        )

                    cur.execute(
                        "DELETE FROM public.ee_saml_replay_assertion WHERE expires_at <= %s",
                        [authenticated_at],
                    )
                    cur.execute(
                        """
                        INSERT INTO public.ee_saml_replay_assertion (
                            id, organisation_id, tenant_slug, idp_entity_id, assertion_id, expires_at
                        ) VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (tenant_slug, idp_entity_id, assertion_id) DO NOTHING
                        RETURNING assertion_id
                        """,
                        [
                            uuid7(),
                            org_id,
                            resolved_slug,
                            idp.idp_entity_id,
                            assertion_id,
                            replay_expiry,
                        ],
                    )
                    if cur.fetchone() is None:
                        raise SamlError(
                            "replayed_assertion_id",
                            "SAML Assertion ID has already been consumed (replay detected)",
                            status=403,
                        )

                    linked_person_id, effective_role = _sync_django_organisation_member(
                        organisation_id=org_id,
                        idp_id=idp.idp_id,
                        subject=subject_name_id,
                        email=email_low,
                        display_name=display_name,
                        role=role,
                        assertion_id=assertion_id,
                    )
                    principal_ref = str(linked_person_id)

                    record = ProvisionedSamlPrincipal(
                        user_id=principal_ref,
                        tenant_slug=idp.tenant_slug,
                        idp_id=idp.idp_id,
                        idp_entity_id=idp.idp_entity_id,
                        assertion_id=assertion_id,
                        subject_name_id=subject_name_id,
                        email=email_low,
                        display_name=display_name,
                        groups=groups,
                        role=effective_role,
                        return_path=return_path,
                        authenticated_at=authenticated_at,
                        oidc_client_id=oidc_client_id,
                        oidc_redirect_uri=oidc_redirect_uri,
                        oidc_code_challenge=oidc_code_challenge,
                    )
                    groups_json = json.dumps(list(record.groups), separators=(",", ":"))
                    cur.execute(
                        """
                        INSERT INTO public.ee_saml_principal (
                            id, organisation_id, user_id, principal_ref, tenant_slug,
                            email_lower, idp_id, idp_entity_id, assertion_id,
                            subject_name_id, email, display_name, groups_json,
                            role, return_path, authenticated_at, updated_at
                        ) VALUES (
                            %s, %s, %s, %s, %s,
                            %s, %s, %s, %s,
                            %s, %s, %s, %s,
                            %s, %s, %s, %s
                        )
                        ON CONFLICT (tenant_slug, email_lower) DO UPDATE SET
                            user_id = EXCLUDED.user_id,
                            principal_ref = EXCLUDED.principal_ref,
                            idp_id = EXCLUDED.idp_id,
                            idp_entity_id = EXCLUDED.idp_entity_id,
                            assertion_id = EXCLUDED.assertion_id,
                            subject_name_id = EXCLUDED.subject_name_id,
                            email = EXCLUDED.email,
                            display_name = EXCLUDED.display_name,
                            groups_json = EXCLUDED.groups_json,
                            role = EXCLUDED.role,
                            return_path = EXCLUDED.return_path,
                            authenticated_at = EXCLUDED.authenticated_at,
                            updated_at = EXCLUDED.updated_at
                        """,
                        [
                            uuid7(),
                            org_id,
                            linked_person_id,
                            record.user_id,
                            resolved_slug,
                            email_low,
                            record.idp_id,
                            record.idp_entity_id,
                            record.assertion_id,
                            record.subject_name_id,
                            record.email,
                            record.display_name,
                            groups_json,
                            record.role,
                            record.return_path,
                            authenticated_at,
                            authenticated_at,
                        ],
                    )
            except TenantCutoffError as exc:
                raise SamlError(
                    exc.code, "SAML principal write refused by privacy cutoff", status=exc.status
                ) from exc
            except IntegrityError as exc:
                msg = str(exc)
                if "account cutoff refuses write" in msg:
                    raise SamlError(
                        "account_cutoff_fenced",
                        "Account is under privacy erasure cutoff",
                        status=403,
                    ) from exc
                raise SamlError(
                    "tenant_cutoff_fenced",
                    "SAML principal write refused by privacy cutoff",
                    status=403,
                ) from exc
            except DatabaseError as exc:
                if is_retriable_lock_contention(exc):
                    raise SamlError(
                        "authority_fenced",
                        "Organisation authority changed concurrently; retry request",
                        status=409,
                    ) from exc
                raise
            except Exception as exc:
                from apps.orgs import member_set_hooks

                member_set_hooks.after_rollback(exc)
                raise
            return record

        replay_key = (idp.tenant_slug, idp.idp_entity_id, assertion_id)
        with self._lock:
            self._prune_pending_locked(authenticated_at)
            if relay_state not in self._pending_by_relay:
                raise SamlError(
                    "invalid_relay_state",
                    "Unknown, expired, or already-consumed SAML RelayState",
                    status=403,
                )
            self._prune_replay_locked(authenticated_at)
            if replay_key in self._replay_cache:
                raise SamlError(
                    "replayed_assertion_id",
                    "SAML Assertion ID has already been consumed (replay detected)",
                    status=403,
                )
            self._pending_by_relay.pop(relay_state, None)
            self._replay_cache[replay_key] = replay_expiry
            while len(self._replay_cache) > MAX_REPLAY_ENTRIES:
                self._replay_cache.popitem(last=False)

        effective_role = role
        if idp.organisation_id is not None:
            linked_person_id, effective_role = _sync_django_organisation_member(
                organisation_id=idp.organisation_id,
                idp_id=idp.idp_id,
                subject=subject_name_id,
                email=email_low,
                display_name=display_name,
                role=role,
                assertion_id=assertion_id,
            )
            principal_ref = str(linked_person_id)

        record = ProvisionedSamlPrincipal(
            user_id=principal_ref,
            tenant_slug=idp.tenant_slug,
            idp_id=idp.idp_id,
            idp_entity_id=idp.idp_entity_id,
            assertion_id=assertion_id,
            subject_name_id=subject_name_id,
            email=email_low,
            display_name=display_name,
            groups=groups,
            role=effective_role,
            return_path=return_path,
            authenticated_at=authenticated_at,
            oidc_client_id=oidc_client_id,
            oidc_redirect_uri=oidc_redirect_uri,
            oidc_code_challenge=oidc_code_challenge,
        )
        with self._lock:
            self._provisioned_users[(idp.tenant_slug, email_low)] = record
        return record

    def get_provisioned_principal(
        self,
        tenant_slug: str,
        email: str,
    ) -> ProvisionedSamlPrincipal | None:
        require_enterprise_edition()
        email_low = email.strip().lower()
        if can_use_postgres():
            with connection.cursor() as cur:
                cur.execute(
                    """
                    SELECT principal_ref, tenant_slug, idp_id, idp_entity_id, assertion_id,
                           subject_name_id, email, display_name, groups_json, role,
                           return_path, authenticated_at
                    FROM public.ee_saml_principal
                    WHERE tenant_slug = %s AND email_lower = %s
                    """,
                    [tenant_slug, email_low],
                )
                row = cur.fetchone()
            return _principal_from_row(row) if row is not None else None

        with self._lock:
            return self._provisioned_users.get((tenant_slug, email_low))


def _extract_attributes(assertion_node: XmlNode) -> dict[str, list[str]]:
    collected: dict[str, list[str]] = {}
    for stmt in assertion_node.find_children(SAML_ASSERTION_NS, "AttributeStatement"):
        for attr_node in stmt.find_children(SAML_ASSERTION_NS, "Attribute"):
            name = (attr_node.attr("Name") or "").strip()
            if not name:
                continue
            values: list[str] = []
            for val_node in attr_node.find_children(SAML_ASSERTION_NS, "AttributeValue"):
                val_text = val_node.text_content(forbid_child_elements=True).strip()
                if val_text:
                    values.append(val_text)
            collected.setdefault(name, []).extend(values)
    return collected


_EMAIL_ATTR_KEYS = (
    "email",
    "mail",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "urn:oid:0.9.2342.19200300.100.1.3",
)
_DISPLAY_NAME_ATTR_KEYS = (
    "displayName",
    "cn",
    "http://schemas.microsoft.com/identity/claims/displayname",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
)
_GROUPS_ATTR_KEYS = (
    "groups",
    "memberOf",
    "http://schemas.xmlsoap.org/claims/Group",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
)


def _resolve_verified_email(
    subject_name_id: str,
    attrs: Mapping[str, list[str]],
    verified_domains: frozenset[str],
) -> str:
    attr_email: str | None = None
    for key in _EMAIL_ATTR_KEYS:
        vals = attrs.get(key)
        if vals:
            if len(vals) != 1:
                raise SamlError(
                    "ambiguous_email_attribute",
                    "Multiple email attribute values are forbidden",
                    status=403,
                )
            attr_email = vals[0].strip().lower()
            break

    nameid_email = subject_name_id.strip().lower() if "@" in subject_name_id else None
    if attr_email is not None and nameid_email is not None and attr_email != nameid_email:
        raise SamlError(
            "subject_email_mismatch",
            "Subject NameID email does not match AttributeStatement email",
            status=403,
        )

    candidate = attr_email or nameid_email
    if not candidate:
        raise SamlError(
            "missing_email_claim", "SAML Assertion must carry a user email address", status=403
        )

    domain = _extract_email_domain(candidate)
    if domain is None:
        raise SamlError(
            "invalid_email_claim", "Malformed email address in SAML Assertion", status=403
        )

    if domain not in verified_domains:
        raise SamlError(
            "unverified_email_domain",
            "Email domain is not verified for this tenant",
            status=403,
        )
    return candidate


def _resolve_display_name(attrs: Mapping[str, list[str]], fallback_email: str) -> str:
    for key in _DISPLAY_NAME_ATTR_KEYS:
        vals = attrs.get(key)
        if vals and vals[0].strip():
            return vals[0].strip()[:255]
    return fallback_email.split("@", 1)[0][:255]


def _resolve_groups(attrs: Mapping[str, list[str]]) -> tuple[str, ...]:
    seen: dict[str, None] = {}
    for key in _GROUPS_ATTR_KEYS:
        for item in attrs.get(key, []):
            cleaned = item.strip()
            if cleaned:
                seen[cleaned] = None
    return tuple(seen.keys())


def _resolve_mapped_role(
    groups: Iterable[str],
    mapping: Mapping[str, str],
    default_role: str,
) -> str:
    best_role = default_role
    best_prio = _ROLE_PRIORITY[default_role]
    for grp in groups:
        mapped = mapping.get(grp)
        if mapped is not None and _ROLE_PRIORITY[mapped] > best_prio:
            best_role = mapped
            best_prio = _ROLE_PRIORITY[mapped]
    return best_role


def _lock_and_verify_saml_person(cur: Any, *, user_id: UUID) -> None:
    """Lock global `identity_user` (`FOR SHARE NOWAIT`) and refuse cutoff or globally disabled users.

    Never mutates `identity_user.enabled`: a tenant SAML IdP must never clear a global security
    disable.
    """
    cur.execute(
        "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:' || %s, 0))",
        [str(user_id)],
    )
    lock_row = cur.fetchone()
    if not lock_row or not bool(lock_row[0]):
        raise SamlError(
            "authority_fenced",
            "Organisation authority changed concurrently; retry request",
            status=409,
        )
    cur.execute(
        """
        SELECT u.email, u.enabled, u.deleted_at
        FROM public.identity_user u
        WHERE u.id = %s
        FOR SHARE OF u NOWAIT
        """,
        [user_id],
    )
    u_row = cur.fetchone()
    if u_row is None or u_row[2] is not None or str(u_row[0]).startswith("erased:"):
        raise SamlError(
            "account_cutoff_fenced",
            "Account is under privacy erasure cutoff",
            status=403,
        )
    if not bool(u_row[1]):
        raise SamlError(
            "user_disabled",
            "User account is disabled",
            status=403,
        )


def _sync_django_organisation_member(
    *,
    organisation_id: UUID,
    idp_id: str,
    subject: str,
    email: str,
    display_name: str,
    role: str,
    assertion_id: str = "",
) -> tuple[UUID, str]:
    """Sync federated SAML login into Core `User`/`Identity`/`Membership` under `kodera_api` grants.

    Never links onto pre-existing non-SAML identities by email, mints KC-02 canonical UUID subjects,
    protects `org_owner` and `org_billing` from JIT overwrites, and emits Core audit + engine hooks.
    """
    from apps.audit.models import AuditEvent
    from apps.audit.services import record_membership_event
    from apps.identity.models import Identity, User
    from apps.orgs import member_set_hooks
    from apps.orgs.models import Membership, Organisation
    from apps.outbox.realm_enqueue import ACCESS_ON, enqueue_realm_access
    from django.utils import timezone

    try:
        with transaction.atomic():
            org = (
                Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True)
                .exclude(state=Organisation.State.CLOSED)
                .first()
            )
            if org is None:
                raise SamlError(
                    "tenant_cutoff_fenced",
                    "Organisation is closed or does not exist",
                    status=403,
                )
            saml_uuid_subject = _canonical_saml_subject_uuid(org.id, idp_id, subject)
            legacy_raw = f"saml:{idp_id}:{subject}"
            legacy_subject_key = "".join(ch if "!" <= ch <= "~" else "_" for ch in legacy_raw)[:255]
            identity = (
                Identity.objects.select_related("user")
                .filter(
                    organisation=org,
                    issuer=org.issuer,
                    subject__in=[saml_uuid_subject, legacy_subject_key],
                )
                .order_by("created_at", "id")
                .first()
            )
            if identity is None:
                existing_non_saml = (
                    Identity.objects.select_related("user")
                    .filter(
                        organisation=org,
                        issuer=org.issuer,
                        email__iexact=email,
                    )
                    .order_by("created_at", "id")
                    .first()
                )
                if existing_non_saml is not None:
                    if (
                        existing_non_saml.deleted_at is not None
                        or existing_non_saml.email.startswith("erased:")
                    ):
                        raise SamlError(
                            "account_cutoff_fenced",
                            "Account is under privacy erasure cutoff",
                            status=403,
                        )
                    if not existing_non_saml.enabled:
                        raise SamlError(
                            "user_disabled",
                            "User account is disabled",
                            status=403,
                        )
                    with connection.cursor() as cur:
                        _lock_and_verify_saml_person(cur, user_id=existing_non_saml.user_id)
                    existing_memb = Membership.objects.filter(
                        organisation=org,
                        user_id=existing_non_saml.user_id,
                    ).first()
                    if existing_memb is not None:
                        if existing_memb.deleted_at is not None:
                            raise SamlError(
                                "tenant_cutoff_fenced",
                                "Tenant membership is under erasure cutoff",
                                status=403,
                            )
                        if existing_memb.state in {
                            Membership.State.SUSPENDED,
                            Membership.State.REMOVED,
                        }:
                            raise SamlError(
                                "user_disabled",
                                "Tenant membership is suspended or removed",
                                status=403,
                            )
                    raise SamlError(
                        "email_bound_to_non_saml_identity",
                        "SAML email-based fallback linking onto pre-existing non-SAML identity is forbidden",
                        status=403,
                    )

            if identity is not None:
                if identity.deleted_at is not None or identity.email.startswith("erased:"):
                    raise SamlError(
                        "account_cutoff_fenced",
                        "Account is under privacy erasure cutoff",
                        status=403,
                    )
                if not identity.enabled:
                    raise SamlError(
                        "user_disabled",
                        "User account is disabled",
                        status=403,
                    )
                with connection.cursor() as cur:
                    _lock_and_verify_saml_person(cur, user_id=identity.user_id)
                user = identity.user
            else:
                # Never link or reuse a global `User` across tenants by contact `email`
                # (`CUSTOMER_PERSISTENCE.md:29` / `ADR-0024` / `owner_binding.py`).
                user = User.objects.create(
                    email=email,
                    display_name=display_name[:200] if display_name else None,
                    enabled=True,
                )
                identity = Identity.objects.create(
                    user=user,
                    organisation=org,
                    realm=org.realm,
                    issuer=org.issuer,
                    subject=saml_uuid_subject,
                    email=email,
                    enabled=True,
                )

            now_ts = timezone.now()
            req_id = (assertion_id or f"saml-{uuid7()}")[:64]
            membership = (
                Membership.objects.select_for_update(nowait=True)
                .filter(organisation=org, user=user)
                .first()
            )
            if membership is None:
                created = Membership.objects.create(
                    organisation=org,
                    user=user,
                    role=role,
                    state=Membership.State.ACTIVE,
                    accepted_at=now_ts,
                )
                AuditEvent.objects.create(
                    action="membership.created",
                    actor_type="tenant",
                    actor_id=identity.id,
                    actor_label=f"urn:kodera:identity:{identity.id}",
                    organisation_id=org.id,
                    target_urn=f"urn:kodera:membership:{created.id}",
                    request_id=req_id,
                    retention_class="standard",
                    before=None,
                    after={"role": role, "state": Membership.State.ACTIVE},
                    metadata={"source": "saml", "idp_id": idp_id},
                )
                enqueue_realm_access(
                    organisation_id=org.id,
                    membership_id=created.id,
                    user_id=user.id,
                    operation=ACCESS_ON,
                )
                member_set_hooks.member_set_changed(
                    organisation_id=org.id,
                    reason="saml_provisioned",
                )
                return user.id, role

            if membership.deleted_at is not None:
                raise SamlError(
                    "tenant_cutoff_fenced",
                    "Tenant membership is under erasure cutoff",
                    status=403,
                )
            if membership.state in {Membership.State.SUSPENDED, Membership.State.REMOVED}:
                raise SamlError(
                    "user_disabled",
                    "Tenant membership is suspended or removed",
                    status=403,
                )
            effective_role = (
                membership.role
                if membership.role in {Membership.Role.OWNER, Membership.Role.BILLING}
                else role
            )
            old_role = membership.role
            old_state = membership.state
            role_changed = old_role != effective_role
            state_changed = old_state != Membership.State.ACTIVE
            if role_changed or state_changed or membership.accepted_at is None:
                Membership.objects.filter(id=membership.id, organisation_id=org.id).update(
                    role=effective_role,
                    state=Membership.State.ACTIVE,
                    accepted_at=membership.accepted_at or now_ts,
                    updated_at=now_ts,
                )
                if role_changed:
                    record_membership_event(
                        action="membership.role_changed",
                        organisation_id=org.id,
                        membership_id=membership.id,
                        actor_id=identity.id,
                        request_id=req_id,
                        before={"role": old_role},
                        after={"role": effective_role},
                    )
                if state_changed:
                    record_membership_event(
                        action="membership.reactivated",
                        organisation_id=org.id,
                        membership_id=membership.id,
                        actor_id=identity.id,
                        request_id=req_id,
                        before={"state": old_state},
                        after={"state": Membership.State.ACTIVE},
                    )
                    enqueue_realm_access(
                        organisation_id=org.id,
                        membership_id=membership.id,
                        user_id=user.id,
                        operation=ACCESS_ON,
                    )
                    member_set_hooks.member_set_changed(
                        organisation_id=org.id,
                        reason=member_set_hooks.MEMBER_REACTIVATED,
                    )
                elif role_changed:
                    member_set_hooks.channel_set_changed(
                        organisation_id=org.id,
                        reason=member_set_hooks.CHANNEL_SET_REASON,
                    )
            return user.id, effective_role
    except IntegrityError as exc:
        msg = str(exc)
        if "account cutoff refuses write" in msg:
            raise SamlError(
                "account_cutoff_fenced",
                "Account is under privacy erasure cutoff",
                status=403,
            ) from exc
        raise SamlError(
            "tenant_cutoff_fenced",
            "SAML provisioning refused by privacy cutoff",
            status=403,
        ) from exc
    except DatabaseError as exc:
        if is_retriable_lock_contention(exc):
            raise SamlError(
                "authority_fenced",
                "Organisation authority changed concurrently; retry request",
                status=409,
            ) from exc
        raise


default_saml_service = SamlService()
