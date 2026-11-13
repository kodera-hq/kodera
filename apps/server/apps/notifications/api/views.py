"""Authenticated inbox and per-device empty-wakeup subscriptions."""

from uuid import UUID

from django.http import HttpRequest, HttpResponse

from core.api.scopes import Operation, declares
from services.identity.access_tokens import VerifiedAccessToken

from .. import services as service
from ..services import RefusalError
from . import http


@declares(Operation("GET", "listNotifications", "notification:read"))
def inbox(request: HttpRequest) -> HttpResponse:
    def get(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        if set(request.GET) - {"cursor", "limit"} or any(
            len(v) != 1 for _, v in request.GET.lists()
        ):
            raise RefusalError(400)
        try:
            limit = int(request.GET.get("limit", "50"))
        except ValueError:
            raise RefusalError(400) from None
        return http.json_response(
            service.inbox(verified=verified, cursor=request.GET.get("cursor"), limit=limit)
        )

    return http.serve(request, {"GET": get})


@declares(Operation("POST", "markNotificationsRead", "notification:create"))
def read(request: HttpRequest) -> HttpResponse:
    def post(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        data = http.body(request, {"ids"}, {"ids"})
        if not isinstance(data["ids"], list) or not 1 <= len(data["ids"]) <= 200:
            raise RefusalError(422)
        service.mark_read(
            verified=verified, ids=[http.uuid(i) for i in data["ids"]], request_id=request_id
        )
        return HttpResponse(status=204)

    return http.serve(request, {"POST": post})


@declares(Operation("GET", "getPushPublicKey", "push_subscription:read"))
def public_key(request: HttpRequest) -> HttpResponse:
    return http.serve(
        request,
        {
            "GET": lambda verified, request_id: http.json_response(
                {"publicKey": service.public_key(), "payloadMode": "empty"}, etag=True
            )
        },
    )


@declares(
    Operation("PUT", "putPushSubscription", "push_subscription:update"),
    Operation("DELETE", "deletePushSubscription", "push_subscription:delete"),
)
def subscription(request: HttpRequest, device_id: UUID) -> HttpResponse:
    def put(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        data = http.body(request, {"endpoint", "p256dh", "auth"}, {"endpoint", "p256dh", "auth"})
        service.put_subscription(
            verified=verified, device_id=device_id, body=data, request_id=request_id
        )
        return HttpResponse(status=204)

    def delete(verified: VerifiedAccessToken, request_id: str) -> HttpResponse:
        service.delete_subscription(verified=verified, device_id=device_id, request_id=request_id)
        return HttpResponse(status=204)

    return http.serve(request, {"PUT": put, "DELETE": delete})
