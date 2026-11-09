"""Small truthful probes; database reachability is not service-release readiness."""

from django.db import DatabaseError, connection
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response


def probe_response(body: dict[str, str], status: int = 200) -> Response:
    return Response(body, status=status, headers={"Cache-Control": "no-store"})


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def live(request: Request) -> Response:
    return probe_response({"status": "alive"})


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def ready(request: Request) -> Response:
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            if cursor.fetchone() != (1,):
                return probe_response({"status": "not_ready", "database": "unavailable"}, 503)
    except DatabaseError:
        # Do not serialize/log the driver's connection string or exception.
        return probe_response({"status": "not_ready", "database": "unavailable"}, 503)
    return probe_response({"status": "ready", "database": "reachable"})
