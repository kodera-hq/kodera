"""SAML 2.0 Service Provider metadata, `AuthnRequest`, ACS verification, and JIT provisioning.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import threading
import urllib.parse
import zlib
from collections import OrderedDict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from ee.edition import require_enterprise_edition
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

SAML_BINDING_HTTP_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
SAML_BINDING_HTTP_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
SAML_NAMEID_EMAIL = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
SAML_STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success"
SAML_CM_BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer"

VALID_ROLES = ("org_member", "org_billing", "org_admin")
_ROLE_PRIORITY = {"org_member": 1, "org_billing": 2, "org_admin": 3}


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


def _sanitize_return_path(return_path: str) -> str:
    candidate = return_path.strip() or "/"
    if not candidate.startswith("/") or candidate.startswith("//") or "\\" in candidate:
        raise SamlError(
            "invalid_return_path", "Return path must be a relative path starting with '/'"
        )
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in candidate):
        raise SamlError("invalid_return_path", "Control characters are forbidden in return path")
    return candidate


class SamlService:
    """Multi-IdP SAML 2.0 Service Provider engine with replay protection and domain scoping."""

    def __init__(self, *, relay_hmac_secret: bytes | None = None) -> None:
        self._lock = threading.Lock()
        self._relay_secret = relay_hmac_secret or secrets.token_bytes(32)
        self._idps: dict[tuple[str, str], SamlIdpConfig] = {}
        self._pending_by_relay: OrderedDict[str, _PendingRequest] = OrderedDict()
        self._replay_cache: OrderedDict[tuple[str, str, str], datetime] = OrderedDict()
        self._provisioned_users: dict[tuple[str, str], ProvisionedSamlPrincipal] = {}

    def reset(self) -> None:
        """Clear in-memory IdP registrations, pending requests, replay cache, and principals."""
        with self._lock:
            self._idps.clear()
            self._pending_by_relay.clear()
            self._replay_cache.clear()
            self._provisioned_users.clear()

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
        with self._lock:
            self._idps[(config.tenant_slug, config.idp_id)] = config
        return config

    def list_idps(self, tenant_slug: str) -> list[SamlIdpConfig]:
        require_enterprise_edition()
        with self._lock:
            return [cfg for (t_slug, _), cfg in sorted(self._idps.items()) if t_slug == tenant_slug]

    def get_idp(self, tenant_slug: str, idp_id: str) -> SamlIdpConfig:
        require_enterprise_edition()
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
        digest = hmac.new(self._relay_secret, mac_input, hashlib.sha256).hexdigest()
        return f"{nonce}.{digest}"

    def create_authn_request(
        self,
        *,
        tenant_slug: str,
        idp_id: str,
        sp_base_url: str,
        return_path: str = "/",
        now: datetime | None = None,
    ) -> AuthnRequestBundle:
        require_enterprise_edition()
        idp = self.get_idp(tenant_slug, idp_id)
        clean_return = _sanitize_return_path(return_path)
        norm_base = _normalize_sp_base_url(sp_base_url)
        entity_id = self.sp_entity_id(tenant_slug, norm_base)
        acs_url = self.sp_acs_url(tenant_slug, norm_base)

        issued_at = (now or datetime.now(UTC)).astimezone(UTC)
        expires_at = issued_at + timedelta(seconds=DEFAULT_AUTHN_REQUEST_TTL_S)
        expires_epoch = int(expires_at.timestamp())

        request_id = "_" + secrets.token_hex(16)
        nonce = secrets.token_urlsafe(24)
        relay_state = self._sign_relay_token(
            nonce=nonce,
            tenant_slug=tenant_slug,
            idp_id=idp.idp_id,
            request_id=request_id,
            return_path=clean_return,
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
            return_path=clean_return,
            sp_base_url=norm_base,
            expires_at=expires_at,
        )
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

    def _consume_relay_state(
        self,
        *,
        tenant_slug: str,
        relay_state: str,
        sp_base_url: str,
        now: datetime,
    ) -> _PendingRequest:
        if not relay_state or "." not in relay_state or len(relay_state) > 256:
            raise SamlError(
                "invalid_relay_state", "Missing or malformed SAML RelayState", status=403
            )
        nonce, _, _ = relay_state.partition(".")
        if not nonce:
            raise SamlError("invalid_relay_state", "Malformed SAML RelayState nonce", status=403)

        with self._lock:
            self._prune_pending_locked(now)
            pending = self._pending_by_relay.pop(relay_state, None)

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

        pending = self._consume_relay_state(
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

        # Atomic replay check on (tenant_slug, idp_entity_id, assertion_id)
        replay_key = (tenant_slug, idp.idp_entity_id, assertion_id)
        replay_expiry = max(cond_noa, subj_noa) + skew
        with self._lock:
            self._prune_replay_locked(current_time)
            if replay_key in self._replay_cache:
                raise SamlError(
                    "replayed_assertion_id",
                    "SAML Assertion ID has already been consumed (replay detected)",
                    status=403,
                )
            self._replay_cache[replay_key] = replay_expiry
            while len(self._replay_cache) > MAX_REPLAY_ENTRIES:
                self._replay_cache.popitem(last=False)

        # Extract attributes from verified Assertion ONLY
        attrs = _extract_attributes(assertion_node)
        email = _resolve_verified_email(subject_name_id, attrs, idp.verified_domains)
        display_name = _resolve_display_name(attrs, email)
        groups = _resolve_groups(attrs)
        role = _resolve_mapped_role(groups, idp.group_role_mapping, idp.default_role)

        principal = self._jit_upsert_principal(
            idp=idp,
            assertion_id=assertion_id,
            subject_name_id=subject_name_id,
            email=email,
            display_name=display_name,
            groups=groups,
            role=role,
            return_path=pending.return_path,
            authenticated_at=current_time,
        )
        return principal

    def _jit_upsert_principal(
        self,
        *,
        idp: SamlIdpConfig,
        assertion_id: str,
        subject_name_id: str,
        email: str,
        display_name: str,
        groups: tuple[str, ...],
        role: str,
        return_path: str,
        authenticated_at: datetime,
    ) -> ProvisionedSamlPrincipal:
        key = (idp.tenant_slug, email.lower())
        with self._lock:
            existing = self._provisioned_users.get(key)
            user_id = existing.user_id if existing is not None else str(uuid4())
            if idp.organisation_id is not None:
                user_id = _sync_django_organisation_member(
                    organisation_id=idp.organisation_id,
                    idp_id=idp.idp_id,
                    subject=subject_name_id,
                    email=email.lower(),
                    display_name=display_name,
                    role=role,
                )
            record = ProvisionedSamlPrincipal(
                user_id=user_id,
                tenant_slug=idp.tenant_slug,
                idp_id=idp.idp_id,
                idp_entity_id=idp.idp_entity_id,
                assertion_id=assertion_id,
                subject_name_id=subject_name_id,
                email=email.lower(),
                display_name=display_name,
                groups=groups,
                role=role,
                return_path=return_path,
                authenticated_at=authenticated_at,
            )
            self._provisioned_users[key] = record
        return record

    def get_provisioned_principal(
        self,
        tenant_slug: str,
        email: str,
    ) -> ProvisionedSamlPrincipal | None:
        require_enterprise_edition()
        with self._lock:
            return self._provisioned_users.get((tenant_slug, email.strip().lower()))


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


def _sync_django_organisation_member(
    *,
    organisation_id: UUID,
    idp_id: str,
    subject: str,
    email: str,
    display_name: str,
    role: str,
) -> str:
    """Sync federated SAML login into Django `Identity`/`User`/`Membership` when bound to an org."""
    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership, Organisation
    from django.db import transaction
    from django.utils import timezone

    with transaction.atomic():
        org = Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True).first()
        if org is None:
            raise SamlError(
                "organisation_not_found", "Bound organisation does not exist", status=404
            )
        raw_subject_key = f"saml:{idp_id}:{subject}"
        subject_key = "".join(ch if "!" <= ch <= "~" else "_" for ch in raw_subject_key)[:255]
        identity = (
            Identity.objects.select_for_update()
            .select_related("user")
            .filter(organisation=org, issuer=org.issuer, subject=subject_key)
            .first()
        )
        if identity is None:
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
                subject=subject_key,
                email=email,
                enabled=True,
            )
        else:
            user = identity.user
            if not user.enabled:
                user.enabled = True
                user.save(update_fields=["enabled"])
            if not identity.enabled:
                identity.enabled = True
                identity.save(update_fields=["enabled"])

        now_ts = timezone.now()
        membership = (
            Membership.objects.select_for_update().filter(organisation=org, user=user).first()
        )
        if membership is None:
            Membership.objects.create(
                organisation=org,
                user=user,
                role=role,
                state=Membership.State.ACTIVE,
                accepted_at=now_ts,
            )
        else:
            membership.role = role
            membership.state = Membership.State.ACTIVE
            if membership.accepted_at is None:
                membership.accepted_at = now_ts
            membership.save(update_fields=["role", "state", "accepted_at", "updated_at"])
        return str(user.id)


default_saml_service = SamlService()
