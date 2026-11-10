"""Safe JSON problems for errors outside routed API views."""

from django.http import HttpRequest, JsonResponse

from core.db.ids import new_uuid7


def problem(request: HttpRequest, status: int, title: str) -> JsonResponse:
    request_id = request.META.setdefault("HTTP_X_REQUEST_ID", str(new_uuid7()))
    response = JsonResponse(
        {"type": "about:blank", "title": title, "status": status, "request_id": request_id},
        status=status,
        content_type="application/problem+json",
    )
    response["X-Request-Id"] = request_id
    response["Cache-Control"] = "no-store"
    return response


def not_found(request: HttpRequest, exception: Exception) -> JsonResponse:
    return problem(request, 404, "Not found")


def server_error(request: HttpRequest) -> JsonResponse:
    return problem(request, 500, "Internal server error")
