"""Guests have one explicit channel read and never inherit ordinary Core admission."""

from uuid import UUID

from django.conf import settings
from django.db import transaction

from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from .api import responses


def current_identity(*, issuer: str, subject: str):
    from apps.identity.selectors import current_identity as _current_identity

    return _current_identity(issuer=issuer, subject=subject)


_DEFAULT_CURRENT_IDENTITY = current_identity


def _organisation_id_from_path(path: str) -> UUID | None:
    prefix = "/api/v1/organisations/"
    if not path.startswith(prefix):
        return None
    raw_segment = path[len(prefix) :].split("/", 1)[0]
    try:
        return UUID(raw_segment)
    except ValueError:
        return None


def is_guest_identity(*, identity_id) -> bool:
    from .bridges import is_guest_identity as _is_guest_identity

    return _is_guest_identity(identity_id=identity_id)


class GuestScopeMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if not request.path.startswith("/api/v1/"):
            return self.get_response(request)
        if (
            not getattr(settings, "KODERA_CHANNEL_GOVERNANCE_ENABLED", False)
            or "apps.workspaces" not in settings.INSTALLED_APPS
        ):
            return self.get_response(request)
        try:
            verified, lane = verify_configured_token(
                responses.bearer(request), trusted=settings.KODERA_AUTH_TRUST
            )
        except TokenVerificationError:
            return self.get_response(request)
        if lane == "customer":
            with transaction.atomic():
                if current_identity is not _DEFAULT_CURRENT_IDENTITY:
                    identity = current_identity(issuer=verified.issuer, subject=verified.subject)
                    guest = identity is not None and is_guest_identity(identity_id=identity[1].id)
                else:
                    from apps.identity.selectors import (
                        current_identities,
                        current_identity_for_organisation,
                    )

                    target_org_id = _organisation_id_from_path(request.path)
                    if target_org_id is not None:
                        identity = current_identity_for_organisation(
                            organisation_id=target_org_id,
                            issuer=verified.issuer,
                            subject=verified.subject,
                        )
                        guest = identity is not None and is_guest_identity(
                            identity_id=identity[1].id
                        )
                    else:
                        identities = current_identities(
                            issuer=verified.issuer, subject=verified.subject
                        )
                        guest = bool(identities) and all(
                            is_guest_identity(identity_id=item[1].id) for item in identities
                        )
            if guest:
                permitted = "/api/v1/organisations/"
                if not (
                    request.method == "GET"
                    and request.path.startswith(permitted)
                    and request.path.endswith("/workspace/guest-channel")
                ):
                    request_id = responses.request_id(request)
                    return responses.finish(responses.problem("forbidden", request_id), request_id)
        return self.get_response(request)
