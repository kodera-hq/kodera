"""Finite public trust configuration; never discovers an issuer from a request."""

import json
import time
from dataclasses import dataclass
from typing import Any, Literal, cast

from .access_tokens import (
    IssuerKeySnapshot,
    TokenVerificationError,
    VerifiedAccessToken,
    verify_access_token,
)

Lane = Literal["customer", "staff"]
MAX_CONFIGURATION_BYTES = 64 * 1024
MAX_ISSUERS = 8
ENTRY_FIELDS = {"lane", "issuer", "generation", "expires_at", "public_jwks"}
# The OAuth clients whose tokens the customer lane admits when no other list is given: the web
# console and the two native apps, each a public client of every organisation realm
# (worker/vendor/keycloak/org-realm-template.json). A deployment resolves its own list from
# KODERA_ALLOWED_OIDC_CLIENT_IDS (config.environment.allowed_oidc_client_ids).
DEFAULT_ALLOWED_AZP: tuple[str, ...] = ("console", "kodera-ios", "kodera-android")


class TrustConfigurationError(Exception):
    def __init__(self) -> None:
        super().__init__("public trust configuration refused")


@dataclass(frozen=True, slots=True, repr=False)
class TrustedIssuer:
    lane: Lane
    snapshot: IssuerKeySnapshot
    # Customer lane only: the exact `azp` values a token of this issuer must carry. A customer
    # token whose `azp` is missing or not listed is refused (`verify_configured_token`). Empty on
    # the staff lane, where `azp` is not judged here.
    allowed_azp: tuple[str, ...] = ()


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate public configuration key")
        result[key] = value
    return result


def _invalid_constant(value: str) -> None:
    raise ValueError("invalid public configuration constant")


def load_trust(
    raw: str | None, *, allowed_azp: tuple[str, ...] = DEFAULT_ALLOWED_AZP
) -> tuple[TrustedIssuer, ...]:
    """Parse once at settings initialization; expiry is also checked on every use.

    Every customer-lane issuer admits only tokens whose `azp` is one of `allowed_azp`."""
    if raw is None or raw == "":
        return ()
    try:
        if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_CONFIGURATION_BYTES:
            raise ValueError("public configuration size/type")
        entries = json.loads(
            raw, object_pairs_hook=_unique_object, parse_constant=_invalid_constant
        )
        if not isinstance(entries, list) or len(entries) > MAX_ISSUERS:
            raise ValueError("public configuration entries")
        admitted: list[TrustedIssuer] = []
        issuers: set[str] = set()
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != ENTRY_FIELDS:
                raise ValueError("public configuration entry shape")
            lane, issuer = entry["lane"], entry["issuer"]
            if not isinstance(lane, str) or lane not in {"customer", "staff"}:
                raise ValueError("public configuration lane")
            if not isinstance(issuer, str) or issuer in issuers:
                raise ValueError("public configuration issuer")
            if not isinstance(entry["generation"], str) or type(entry["expires_at"]) is not int:
                raise ValueError("public configuration primitive")
            if not isinstance(entry["public_jwks"], dict):
                raise ValueError("public configuration keys")
            snapshot = IssuerKeySnapshot.from_jwks(
                json.dumps(entry["public_jwks"], ensure_ascii=False, allow_nan=False).encode(
                    "utf-8"
                ),
                issuer=issuer,
                generation=entry["generation"],
                expires_at=entry["expires_at"],
            )
            issuers.add(issuer)
            admitted.append(
                TrustedIssuer(
                    cast(Lane, lane),
                    snapshot,
                    tuple(allowed_azp) if lane == "customer" else (),
                )
            )
        return tuple(admitted)
    except (ValueError, TypeError, UnicodeError, RecursionError, TokenVerificationError):
        raise TrustConfigurationError() from None


def verify_configured_token(
    compact: str, *, trusted: tuple[TrustedIssuer, ...]
) -> tuple[VerifiedAccessToken, Lane]:
    """Use the existing verifier, including its exact issuer check before signature work.

    A customer-lane token must also name, as `azp`, one of its issuer's allowed clients: one with
    no `azp`, or another client's, is refused like any other token (`TokenVerificationError`)."""
    for entry in trusted:
        try:
            verified = verify_access_token(compact, admitted=entry.snapshot)
        except TokenVerificationError:
            continue
        if entry.lane == "customer" and verified.authorized_party not in entry.allowed_azp:
            raise TokenVerificationError()
        return verified, entry.lane
    raise TokenVerificationError()


def is_trusted_issuer(
    issuer: str, *, trusted: tuple[TrustedIssuer, ...], lane: Lane = "customer"
) -> bool:
    """Whether `issuer` is on `lane` of the trust configuration and its entry has not expired: a
    token of an absent or expired entry does not verify, so its realm is not ready
    (FIRST_OWNER_BOOTSTRAP.md §5.4, PILOT_WORKSPACE_ONBOARDING.md §3)."""
    now = time.time()
    return any(
        entry.lane == lane and entry.snapshot.issuer == issuer and entry.snapshot.expires_at > now
        for entry in trusted
    )
