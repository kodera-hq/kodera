"""Replay a terminal response under an explicit application-owned effect policy."""

from collections.abc import Callable
from typing import Any, Protocol

from django.http import HttpRequest, HttpResponse

from .idempotency import StoredResponse, respond_once as core_respond_once


class EffectPolicy(Protocol):
    def execute(self, handler: Callable[[], StoredResponse], request_id: str) -> StoredResponse: ...


def respond_once(
    request: HttpRequest,
    *,
    handler: Callable[[], StoredResponse],
    request_id: str,
    policy: EffectPolicy,
    **kwargs: Any,
) -> HttpResponse:
    """The policy runs only for a new effect, inside the existing replay transaction.

    Domain-specific savepoints and failure classification belong to the supplied policy;
    this shared adapter neither discovers applications nor loads their models or settings.
    """
    return core_respond_once(
        request,
        request_id=request_id,
        handler=lambda: policy.execute(handler, request_id),
        **kwargs,
    )
