"""Cardless freemium PME self-serve workspace provisioning (`<= 5` seats, `< 5 s`).

Provisions `Organisation(shared_realm=True, plan_tier='freemium_pme')`, permanent
`SlugReservation`, `Identity`, `Membership(role='org_owner')`, `Tenant(status='active')`,
starter `Workspace` (`#welcome`, `#general`, `#lounge`), and `WorkspaceQuota(seats=5)`
in a single atomic database transaction with zero cloud/Keycloak credentials (`ADR-0003`).

At Milestone A, KODERA_BILLING_ENABLED=false refuses new Sovereign orders with
409 billing-disabled. Cardless signup remains available. Its redirect_path is local to
the console. The 201 Location uses KODERA_APP_ORIGIN when configured. For invitation
mail, configure that origin on the sender and include it in KODERA_MAIL_LINK_ORIGINS.
KODERA_SELF_SERVE_DISPOSABLE_DOMAINS extends the built-in list with comma-separated domains.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.identity.community import (
    create_self_serve_owner_identity,
    resolve_or_create_locked_self_serve_person,
)
from apps.identity.passport import passport_secret
from apps.identity.selectors import active_shared_issuer_identity_for_user, is_storable_subject
from apps.orgs.intake_services import (
    SLUG,
    held_organisation_or_reservation_slugs,
    is_organisation_or_reservation_slug_taken,
    provision_self_serve_organisation_and_owner,
)
from apps.orgs.selectors import count_active_freemium_owned_organisations
from apps.tenancy.services import (
    create_active_self_serve_tenant,
    held_tenant_slugs,
    tenant_slug_exists,
)
from apps.workspaces.initialise import create_starter
from apps.workspaces.services import sync_subscription_quota
from apps.workspaces.warm_pool import workspace_slug_is_reserved
from core.api import lanes
from core.passport import (
    PASSPORT_SESSION_PREFIX,
    PassportSessionError,
    verify_passport_session_token,
)
from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import is_trusted_issuer, verify_configured_token

FREEMIUM_POLICY_REF = "freemium:pme:seats-5"
FREEMIUM_SEAT_LIMIT = 5
MAX_ACTIVE_FREEMIUM_ORGS_PER_PERSON = 3
DISPOSABLE_EMAIL_DOMAINS = frozenset(
    {
        "10minutemail.com",
        "guerrillamail.com",
        "guerrillamail.net",
        "mailinator.com",
        "sharklasers.com",
        "yopmail.com",
    }
)
NAME_MAX_LENGTH = 120
SUGGESTION_SUFFIXES = tuple(f"-{n}" for n in range(2, 12))
MAX_ORG_SLUG_LENGTH = 20
SLUG_CONFLICT_CONSTRAINTS = frozenset(
    {
        "reservation_namespace_slug_unique",
        "tenancy_tenant_slug_key",
        "orgs_slugreservation_namespace_slug_key",
    }
)
_REALM_TAIL = re.compile(r"/realms/([a-z0-9][a-z0-9-]{0,62})\Z")


class SelfServeAuthForbiddenError(Exception):
    """Caller token is not a verified shared-realm customer identity."""


class SelfServeRateLimitError(Exception):
    """Caller already owns the maximum number of active freemium PME workspaces."""

    def __init__(self, retry_after_s: int = 3600) -> None:
        super().__init__("freemium workspace limit reached")
        self.retry_after_s = retry_after_s


class SelfServeValidationError(Exception):
    """Structured `422` validation errors on request fields."""

    def __init__(self, errors: list[dict[str, str]]) -> None:
        super().__init__("self-serve validation error")
        self.errors = errors


class SelfServeSlugTakenError(Exception):
    """Requested slug is already held; carries up to 3 available suggestions."""

    def __init__(self, slug: str, suggestions: list[str]) -> None:
        super().__init__("slug taken")
        self.slug = slug
        self.suggestions = suggestions


class SelfServeUnavailableError(Exception):
    """Shared community OIDC issuer is not configured or trusted on this deployment."""


@dataclass(frozen=True, slots=True)
class SelfServeCaller:
    issuer: str
    realm: str
    subject: str
    email: str


@dataclass(frozen=True, slots=True)
class SelfServeRequest:
    name: str
    slug: str
    locale: str


def _has_control_char(value: str) -> bool:
    for ch in value:
        cat = unicodedata.category(ch)
        if cat.startswith("C") or cat in ("Zl", "Zp"):
            return True
    return False


def default_community_issuer() -> str:
    issuer = getattr(settings, "KODERA_DEFAULT_COMMUNITY_ISSUER", "")
    return issuer.strip() if isinstance(issuer, str) else ""


def _realm_from_issuer(issuer: str) -> str | None:
    matched = _REALM_TAIL.search(issuer)
    return None if matched is None else matched.group(1)


def _signup_email(raw: str) -> str:
    email = raw.strip()
    try:
        validate_email(email)
        domain = email.rsplit("@", 1)[-1].encode("idna").decode("ascii").lower().rstrip(".")
    except (ValidationError, UnicodeError):
        raise SelfServeAuthForbiddenError() from None
    blocked = DISPOSABLE_EMAIL_DOMAINS | settings.KODERA_SELF_SERVE_DISPOSABLE_DOMAINS
    labels = domain.split(".")
    if any(".".join(labels[i:]) in blocked for i in range(len(labels))):
        raise SelfServeAuthForbiddenError()
    return email


def authorise_self_serve_caller(*, verified: VerifiedAccessToken, lane: str) -> SelfServeCaller:
    """Verify caller holds a verified-email OIDC token from `default_community_issuer()`."""
    if lane != "customer":
        raise SelfServeAuthForbiddenError()
    shared_issuer = default_community_issuer()
    if not shared_issuer or not is_trusted_issuer(
        shared_issuer, trusted=settings.KODERA_AUTH_TRUST
    ):
        raise SelfServeUnavailableError()
    realm = _realm_from_issuer(shared_issuer)
    if realm is None or realm == "kodera-staff":
        raise SelfServeUnavailableError()
    if (
        verified.issuer != shared_issuer
        or not is_storable_subject(verified.subject)
        or verified.email_verified is not True
        or not isinstance(verified.email, str)
        or not verified.email.strip()
        or len(verified.email.strip()) > 254
    ):
        raise SelfServeAuthForbiddenError()
    return SelfServeCaller(
        issuer=shared_issuer,
        realm=realm,
        subject=verified.subject,
        email=_signup_email(verified.email),
    )


def resolve_self_serve_caller_from_token(token: str) -> SelfServeCaller:
    """Verify a Bearer OIDC or Kodera Passport token for cardless PME self-serve."""
    if token.startswith(PASSPORT_SESSION_PREFIX):
        secret = passport_secret()
        if secret is None:
            raise TokenVerificationError()
        try:
            claims = verify_passport_session_token(token, secret=secret)
        except PassportSessionError as exc:
            raise TokenVerificationError() from exc
        if not claims.email_verified:
            raise SelfServeAuthForbiddenError()
        shared_issuer = default_community_issuer()
        if not shared_issuer or not is_trusted_issuer(
            shared_issuer, trusted=settings.KODERA_AUTH_TRUST
        ):
            raise SelfServeUnavailableError()
        found = active_shared_issuer_identity_for_user(user_id=claims.user_id, issuer=shared_issuer)
        if found is None:
            raise SelfServeAuthForbiddenError()
        person, ident = found
        return SelfServeCaller(
            issuer=ident.issuer,
            realm=ident.realm,
            subject=ident.subject,
            email=_signup_email(person.email),
        )

    verified, lane = verify_configured_token(token, trusted=settings.KODERA_AUTH_TRUST)
    verified, lane = lanes.admit(verified, lane)
    return authorise_self_serve_caller(verified=verified, lane=lane)


def parse_self_serve_request(body: dict[str, Any]) -> SelfServeRequest:
    errors: list[dict[str, str]] = []
    allowed = {"name", "slug", "locale"}
    for extra in sorted(set(body) - allowed):
        errors.append({"pointer": f"/{extra}", "code": "unknown_member"})

    raw_name = body.get("name")
    if "name" not in body:
        errors.append({"pointer": "/name", "code": "required"})
        name = ""
    elif not isinstance(raw_name, str):
        errors.append({"pointer": "/name", "code": "type"})
        name = ""
    else:
        name = raw_name.strip()
        if not name or len(raw_name) > NAME_MAX_LENGTH or _has_control_char(raw_name):
            errors.append({"pointer": "/name", "code": "format"})

    raw_slug = body.get("slug")
    if "slug" not in body:
        errors.append({"pointer": "/slug", "code": "required"})
        slug = ""
    elif not isinstance(raw_slug, str):
        errors.append({"pointer": "/slug", "code": "type"})
        slug = ""
    elif not SLUG.fullmatch(raw_slug):
        errors.append({"pointer": "/slug", "code": "format"})
        slug = ""
    elif workspace_slug_is_reserved(raw_slug):
        errors.append({"pointer": "/slug", "code": "slug_reserved"})
        slug = ""
    else:
        slug = raw_slug

    raw_locale = body.get("locale", "fr")
    if raw_locale not in ("fr", "en"):
        errors.append({"pointer": "/locale", "code": "invalid_choice"})
        locale = "fr"
    else:
        locale = str(raw_locale)

    if errors:
        raise SelfServeValidationError(errors)
    return SelfServeRequest(name=name, slug=slug, locale=locale)


def _slug_suggestions(base_slug: str) -> list[str]:
    candidates: list[str] = []
    for suffix in SUGGESTION_SUFFIXES:
        trimmed = base_slug[: MAX_ORG_SLUG_LENGTH - len(suffix)].rstrip("-")
        candidate = f"{trimmed}{suffix}"
        if (
            SLUG.fullmatch(candidate)
            and not workspace_slug_is_reserved(candidate)
            and candidate not in candidates
        ):
            candidates.append(candidate)
    if not candidates:
        return []
    taken = held_organisation_or_reservation_slugs(candidates) | held_tenant_slugs(candidates)
    return [c for c in candidates if c not in taken][:3]


def _is_slug_taken(slug: str) -> bool:
    return is_organisation_or_reservation_slug_taken(slug) or tenant_slug_exists(slug)


def _constraint_name(error: IntegrityError) -> str | None:
    diag = getattr(error.__cause__, "diag", None)
    name = getattr(diag, "constraint_name", None)
    return name if isinstance(name, str) else None


def _resolve_or_create_locked_person_id(caller: SelfServeCaller) -> UUID:
    person_id, is_usable = resolve_or_create_locked_self_serve_person(
        issuer=caller.issuer,
        subject=caller.subject,
        email=caller.email,
    )
    if not is_usable:
        raise SelfServeAuthForbiddenError()
    return person_id


def create_self_serve_workspace(
    *,
    caller: SelfServeCaller,
    payload: SelfServeRequest,
    request_id: str,
) -> dict[str, Any]:
    """Provision a cardless `freemium_pme` (`<= 5` seats) organisation & workspace atomically."""
    with transaction.atomic():
        person_id = _resolve_or_create_locked_person_id(caller)

        active_freemium_owned = count_active_freemium_owned_organisations(user_id=person_id)
        if active_freemium_owned >= MAX_ACTIVE_FREEMIUM_ORGS_PER_PERSON:
            raise SelfServeRateLimitError()

        if _is_slug_taken(payload.slug):
            raise SelfServeSlugTakenError(payload.slug, _slug_suggestions(payload.slug))

        now = timezone.now()
        try:
            with transaction.atomic():
                organisation_id = provision_self_serve_organisation_and_owner(
                    user_id=person_id,
                    slug=payload.slug,
                    name=payload.name,
                    realm=caller.realm,
                    issuer=caller.issuer,
                    now=now,
                )
                identity_id = create_self_serve_owner_identity(
                    user_id=person_id,
                    organisation_id=organisation_id,
                    issuer=caller.issuer,
                    realm=caller.realm,
                    subject=caller.subject,
                    email=caller.email,
                )
                tenant_id = create_active_self_serve_tenant(
                    organisation_id=organisation_id,
                    slug=payload.slug,
                    name=payload.name,
                    locale=payload.locale,
                    realm=caller.realm,
                    now=now,
                )
        except IntegrityError as exc:
            if _constraint_name(exc) in SLUG_CONFLICT_CONSTRAINTS or _is_slug_taken(payload.slug):
                raise SelfServeSlugTakenError(
                    payload.slug, _slug_suggestions(payload.slug)
                ) from None
            raise

        workspace_id = create_starter(
            organisation_id=organisation_id,
            actor_id=identity_id,
            request_id=request_id,
            allow_member_invites=False,
        )
        sync_subscription_quota(
            organisation_id=organisation_id,
            policy_ref=FREEMIUM_POLICY_REF,
            seats=FREEMIUM_SEAT_LIMIT,
            media_bytes=5 * 1024 * 1024 * 1024,
            update_storage=True,
        )

    return {
        "organisation_id": str(organisation_id),
        "organisation_slug": payload.slug,
        "workspace_id": str(workspace_id),
        "tenant_id": str(tenant_id),
        "redirect_path": f"/{payload.slug}/workspace",
        "quota": {
            "policy_ref": FREEMIUM_POLICY_REF,
            "seats": FREEMIUM_SEAT_LIMIT,
            "used": 1,
            "remaining": FREEMIUM_SEAT_LIMIT - 1,
        },
    }
