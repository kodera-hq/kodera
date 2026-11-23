"""Guests have one explicit channel read and never inherit ordinary Core admission."""

from django.conf import settings

from apps.identity.selectors import current_identity
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from .api import responses
from .bridges import is_guest_identity


class GuestScopeMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith("/api/v1/"):
            try:
                verified, lane = verify_configured_token(
                    responses.bearer(request), trusted=settings.KODERA_AUTH_TRUST
                )
            except TokenVerificationError:
                return self.get_response(request)
            if lane == "customer":
                identity = current_identity(issuer=verified.issuer, subject=verified.subject)
                if identity is not None and is_guest_identity(identity_id=identity[1].id):
                    permitted = "/api/v1/organisations/"
                    if not (
                        request.method == "GET"
                        and request.path.startswith(permitted)
                        and request.path.endswith("/workspace/guest-channel")
                    ):
                        request_id = responses.request_id(request)
                        return responses.finish(
                            responses.problem("forbidden", request_id), request_id
                        )
        return self.get_response(request)
