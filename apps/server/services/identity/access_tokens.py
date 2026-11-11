"""Zero-network verification against a caller-admitted public-key snapshot."""

import base64
import binascii
import json
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

ALGORITHMS = ("RS256", "ES256")
AUDIENCE = "kodera-server"
PROFILE = "keycloak-bearer-v1"
MAX_TOKEN = 16 * 1024
MAX_JWKS = 256 * 1024
MAX_KEYS = 32
KID = re.compile(r"[\x21-\x7e]{1,128}\Z")
SEGMENT = re.compile(r"[A-Za-z0-9_-]+\Z")
PublicKey = rsa.RSAPublicKey | ec.EllipticCurvePublicKey


class TokenVerificationError(Exception):
    """One closed error, safe to map to a generic authentication failure later."""

    def __init__(self) -> None:
        super().__init__("access token refused")


def _require(condition: bool) -> None:
    if not condition:
        raise TokenVerificationError()


def _unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, value in pairs:
        _require(name not in result)
        result[name] = value
    return result


def _object(raw: bytes) -> dict[str, Any]:
    def invalid_constant(_: str) -> None:
        raise TokenVerificationError()

    value = json.loads(
        raw.decode("utf-8"), object_pairs_hook=_unique, parse_constant=invalid_constant
    )
    _require(isinstance(value, dict))
    return value  # type: ignore[no-any-return]


def _segment(value: str) -> bytes:
    _require(SEGMENT.fullmatch(value) is not None)
    raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    # Reject alternate encodings with nonzero unused padding bits.
    _require(base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii") == value)
    return raw


def _rsa_public(key: dict[str, Any]) -> rsa.RSAPublicKey:
    _require(key["kty"] == "RSA")
    _require(isinstance(key.get("n"), str) and len(key["n"]) <= 1366)
    public = jwt.algorithms.RSAAlgorithm.from_jwk(key)
    if not isinstance(public, rsa.RSAPublicKey) or not 2048 <= public.key_size <= 8192:
        raise TokenVerificationError()
    return public


@dataclass(frozen=True, repr=False)
class _Key:
    kid: str
    algorithm: str
    public: PublicKey


@dataclass(frozen=True, repr=False)
class IssuerKeySnapshot:
    """Trusted configuration + immutable parsed keys, never constructed from a token."""

    issuer: str
    generation: str
    expires_at: int
    _keys: tuple[_Key, ...] = field(repr=False)

    @classmethod
    def from_jwks(
        cls, raw: bytes, *, issuer: str, generation: str, expires_at: int
    ) -> "IssuerKeySnapshot":
        try:
            _require(isinstance(issuer, str) and 0 < len(issuer) <= 2048)
            _require(isinstance(generation, str) and 0 < len(generation) <= 128)
            _require(type(expires_at) is int and expires_at > time.time())
            _require(isinstance(raw, bytes) and len(raw) <= MAX_JWKS)
            jwks = _object(raw)
            keys = jwks.get("keys")
            if not isinstance(keys, list) or not 0 < len(keys) <= MAX_KEYS:
                raise TokenVerificationError()
            admitted: list[_Key] = []
            seen: set[str] = set()
            for key in keys:
                _require(isinstance(key, dict))
                kid = key.get("kid")
                _require(
                    isinstance(kid, str) and KID.fullmatch(kid) is not None and kid not in seen
                )
                seen.add(kid)
                _require(not {"d", "p", "q", "dp", "dq", "qi", "oth", "k"}.intersection(key))
                _require(key.get("kty") in {"RSA", "EC"})
                # Provider JWKS may publish encryption keys alongside signing keys.
                # Never select those for verification; a set with no signing key refuses.
                if key.get("use") == "enc":
                    _require(
                        key["kty"] == "RSA"
                        and key.get("alg")
                        in {"RSA-OAEP", "RSA-OAEP-256", "RSA-OAEP-384", "RSA-OAEP-512"}
                    )
                    operations = key.get("key_ops", ["encrypt"])
                    _require(
                        isinstance(operations, list)
                        and bool(operations)
                        and len(operations) == len(set(operations))
                        and set(operations) <= {"encrypt", "wrapKey"}
                    )
                    _rsa_public(key)
                    continue
                _require(key.get("use", "sig") == "sig")
                _require(key.get("key_ops", ["verify"]) == ["verify"])
                algorithm = key.get("alg", "RS256" if key["kty"] == "RSA" else "ES256")
                _require(algorithm in ALGORITHMS)
                if algorithm == "RS256":
                    public: PublicKey = _rsa_public(key)
                else:
                    _require(key["kty"] == "EC" and key.get("crv") == "P-256")
                    ec_key = jwt.algorithms.ECAlgorithm.from_jwk(key)
                    if not isinstance(ec_key, ec.EllipticCurvePublicKey):
                        raise TokenVerificationError()
                    public = ec_key
                admitted.append(_Key(kid, algorithm, public))
            _require(bool(admitted))
            return cls(issuer, generation, expires_at, tuple(admitted))
        except (ValueError, TypeError, KeyError, AttributeError, jwt.PyJWTError, RecursionError):
            raise TokenVerificationError() from None

    def signing_keys(self) -> frozenset[tuple[str, str, bytes]]:
        """Each admitted signing key as (kid, algorithm, SubjectPublicKeyInfo DER): what two
        snapshots compare by when a published key set must equal a pinned one
        (FIRST_OWNER_BOOTSTRAP.md §5.5, the realm's verify). Encryption keys are not admitted, so
        they are not compared."""
        return frozenset(
            (
                key.kid,
                key.algorithm,
                key.public.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo),
            )
            for key in self._keys
        )


@dataclass(frozen=True, repr=False)
class VerifiedAccessToken:
    """Signed evidence, never a resolved or authorised Core principal."""

    issuer: str
    subject: str
    audience: tuple[str, ...]
    issued_at: int
    expires_at: int
    not_before: int | None
    amr: tuple[str, ...] | None
    acr: str | None
    # Signed but unjudged: owner-claim consumption judges it on the database clock
    # (`evaluate_recent_authentication`). Any JSON scalar is carried as signed; a container is not.
    auth_time: int | float | str | bool | None
    profile: str = PROFILE
    email_verified: bool = False
    authorized_party: str | None = None
    mfa_enrolled: bool | None = None
    email: str | None = None


class RegisteredFactorReason(StrEnum):
    ADMITTED = "admitted"
    WRONG_LANE = "wrong_lane"
    CONTACT_UNVERIFIED = "contact_unverified"
    CLIENT_UNCONFIGURED = "client_unconfigured"
    CLIENT_MISMATCH = "client_mismatch"
    OTP_MISSING = "otp_missing"
    FUTURE_IAT = "future_iat"
    STALE = "stale"
    EVIDENCE_UNKNOWN = "evidence_unknown"


@dataclass(frozen=True, slots=True, repr=False)
class RegisteredFactor:
    value: bool | None
    horizon: datetime | None
    reason: RegisteredFactorReason


def _instant(epoch: int) -> datetime | None:
    try:
        return datetime.fromtimestamp(epoch, UTC)
    except (OverflowError, OSError, ValueError):
        return None


def evaluate_registered_factor(
    *,
    verified: VerifiedAccessToken,
    lane: str,
    console_client_id: str | None,
    database_now: datetime,
) -> RegisteredFactor:
    """Return the current registered-factor fact without I/O or wall-clock access."""

    def unknown(reason: RegisteredFactorReason) -> RegisteredFactor:
        return RegisteredFactor(None, None, reason)

    if lane != "customer":
        return unknown(RegisteredFactorReason.WRONG_LANE)
    if verified.email_verified is not True:
        return unknown(RegisteredFactorReason.CONTACT_UNVERIFIED)
    if console_client_id is None:
        return unknown(RegisteredFactorReason.CLIENT_UNCONFIGURED)
    if verified.authorized_party != console_client_id:
        return unknown(RegisteredFactorReason.CLIENT_MISMATCH)
    if "otp" not in (verified.amr or ()):
        return unknown(RegisteredFactorReason.OTP_MISSING)
    issued_at = _instant(verified.issued_at)
    horizon = _instant(min(verified.expires_at + 30, verified.issued_at + 290))
    if issued_at is None or horizon is None or database_now.tzinfo is None:
        return unknown(RegisteredFactorReason.STALE)
    now = database_now.astimezone(UTC)
    if issued_at > now + timedelta(seconds=2):
        return unknown(RegisteredFactorReason.FUTURE_IAT)
    if now >= horizon:
        return unknown(RegisteredFactorReason.STALE)
    if verified.mfa_enrolled is None:
        return RegisteredFactor(None, horizon, RegisteredFactorReason.EVIDENCE_UNKNOWN)
    return RegisteredFactor(verified.mfa_enrolled, horizon, RegisteredFactorReason.ADMITTED)


def observe_registered_factor_reason(reason: RegisteredFactorReason) -> None:
    """Bounded metrics seam; exporters may consume only the closed reason enum."""


# The provider repeats a session's original `amr` for its whole SSO lifetime, so the `otp`
# owner-claim consumption reads is current only for a login made for it: at most this old.
RECENT_AUTHENTICATION_MAX_AGE_S = 300
# The verifier's own leeway (`verify_access_token`), granted once more for provider clock skew.
RECENT_AUTHENTICATION_SKEW_S = 30
# The registered factor's future-`iat` tolerance, applied to `auth_time` the same way.
FUTURE_AUTHENTICATION_TOLERANCE_S = 2
# Check-to-commit budget (REGISTERED_FACTOR_SIGNAL.md §4, `C`), reserved out of the 330 s
# ceiling (300 + 30) so that a pause between a passing read and COMMIT cannot pass the ceiling.
COMMIT_LAG_BUDGET_S = 10
# The one bound both the decision and the final read before COMMIT apply: 320 s, inclusive.
# A commit lands within 330 s of the login while the read-to-commit lag stays within the budget,
# an unmeasured target that nothing enforces; a late claim is refused at
# the decision with `mfa-required`, never accepted there and then rolled back with `503`.
RECENT_AUTHENTICATION_BOUND_S = (
    RECENT_AUTHENTICATION_MAX_AGE_S + RECENT_AUTHENTICATION_SKEW_S - COMMIT_LAG_BUDGET_S
)


class RecentAuthenticationReason(StrEnum):
    RECENT = "recent"
    MISSING = "auth_time_missing"
    FUTURE = "future_auth_time"
    STALE = "stale_authentication"


def evaluate_recent_authentication(
    *, verified: VerifiedAccessToken, database_now: datetime
) -> RecentAuthenticationReason:
    """Whether the login behind this token is recent, without I/O or wall-clock access.

    Recent means a signed integer `auth_time` no more than 2 s ahead of the database clock and
    no more than 320 s behind it, both bounds inclusive."""
    auth_time = verified.auth_time
    if type(auth_time) is not int:
        return RecentAuthenticationReason.MISSING
    authenticated_at = _instant(auth_time)
    if authenticated_at is None:
        return RecentAuthenticationReason.MISSING
    if database_now.tzinfo is None:
        return RecentAuthenticationReason.STALE
    now = database_now.astimezone(UTC)
    if authenticated_at > now + timedelta(seconds=FUTURE_AUTHENTICATION_TOLERANCE_S):
        return RecentAuthenticationReason.FUTURE
    if now - authenticated_at > timedelta(seconds=RECENT_AUTHENTICATION_BOUND_S):
        return RecentAuthenticationReason.STALE
    return RecentAuthenticationReason.RECENT


def recent_authentication_horizon(verified: VerifiedAccessToken) -> datetime | None:
    """The first instant at which the final read before COMMIT refuses this login, or None.

    The same 320 s bound as the decision, inclusive at microsecond resolution: this is
    `auth_time + 320 s + 1 us`, compared as the factor's horizon is."""
    auth_time = verified.auth_time
    if type(auth_time) is not int:
        return None
    authenticated_at = _instant(auth_time)
    if authenticated_at is None:
        return None
    try:
        return authenticated_at + timedelta(seconds=RECENT_AUTHENTICATION_BOUND_S, microseconds=1)
    except OverflowError:
        return None


def observe_recent_authentication_reason(reason: RecentAuthenticationReason) -> None:
    """Bounded metrics seam; exporters may consume only the closed reason enum."""


def _verified_contact(payload: dict[str, Any]) -> bool:
    if "email_verified" not in payload:
        return False
    fact = payload["email_verified"]
    _require(type(fact) is bool)
    return fact  # type: ignore[no-any-return]


def _optional_string(payload: dict[str, Any], name: str) -> str | None:
    value = payload.get(name)
    return value if type(value) is str else None


def _optional_boolean(payload: dict[str, Any], name: str) -> bool | None:
    value = payload.get(name)
    return value if type(value) is bool else None


def verify_access_token(compact: str, *, admitted: IssuerKeySnapshot) -> VerifiedAccessToken:
    try:
        now = time.time()
        _require(isinstance(compact, str) and len(compact) <= MAX_TOKEN)
        _require(admitted.expires_at > now)
        parts = compact.split(".")
        _require(len(parts) == 3)
        header, payload = _object(_segment(parts[0])), _object(_segment(parts[1]))
        _segment(parts[2])
        _require(not {"crit", "jku", "x5u", "jwk", "b64", "x5c"}.intersection(header))
        algorithm, kid = header.get("alg"), header.get("kid")
        _require(isinstance(algorithm, str) and algorithm in ALGORITHMS)
        _require(isinstance(kid, str) and KID.fullmatch(kid) is not None)
        _require(payload.get("iss") == admitted.issuer)
        matching = [key for key in admitted._keys if key.kid == kid and key.algorithm == algorithm]
        _require(len(matching) == 1)
        # Explicit asymmetric allowlist and issuer/audience checks remain library-enforced.
        # Strict types and the access-token profile below supplement library coercions.
        verified = jwt.decode(
            compact,
            matching[0].public,
            algorithms=ALGORITHMS,
            issuer=admitted.issuer,
            audience=AUDIENCE,
            leeway=30,
            options={"require": ["iss", "sub", "aud", "iat", "exp", "typ"]},
        )
        _require(verified == payload)
        _require(payload["typ"] == "Bearer")
        subject = payload["sub"]
        _require(isinstance(subject, str) and bool(subject))
        audience = payload["aud"]
        if isinstance(audience, str):
            audience = [audience]
        _require(
            isinstance(audience, list)
            and bool(audience)
            and all(isinstance(item, str) and bool(item) for item in audience)
            and AUDIENCE in audience
        )
        iat, exp = payload["iat"], payload["exp"]
        _require(type(iat) is int and type(exp) is int and exp > iat)
        _require(exp > now - 30 and iat <= now + 30)
        nbf = payload.get("nbf")
        if "nbf" in payload:
            _require(type(nbf) is int and nbf < exp and nbf <= now + 30)
        amr = payload.get("amr")
        if "amr" in payload:
            _require(
                isinstance(amr, list)
                and len(amr) <= 32
                and all(isinstance(item, str) and 0 < len(item) <= 128 for item in amr)
            )
        acr, auth_time = payload.get("acr"), payload.get("auth_time")
        if "acr" in payload:
            _require(isinstance(acr, str) and len(acr) <= 128)
        # `auth_time` is never a reason to refuse the token: its policy belongs to the one
        # consumer that reads it, on the database clock, which answers `403 mfa-required`.
        if not isinstance(auth_time, int | float | str | bool):
            auth_time = None
        return VerifiedAccessToken(
            admitted.issuer,
            subject,
            tuple(audience),
            iat,
            exp,
            nbf,
            tuple(amr) if amr is not None else None,
            acr,
            auth_time,
            email_verified=_verified_contact(payload),
            email=_optional_string(payload, "email"),
            authorized_party=_optional_string(payload, "azp"),
            mfa_enrolled=_optional_boolean(payload, "kodera_mfa_enrolled"),
        )
    except (
        ValueError,
        TypeError,
        KeyError,
        AttributeError,
        jwt.PyJWTError,
        binascii.Error,
        RecursionError,
    ):
        raise TokenVerificationError() from None
