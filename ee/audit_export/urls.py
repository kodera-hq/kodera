"""URL routes for Enterprise Signed Compliance Audit Exports (`/api/v1/ee/compliance/audit-exports/*`).

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

from django.urls import URLPattern, path

from ee.audit_export.views import (
    append_audit_event_view,
    create_audit_export_view,
    verify_audit_export_view,
)

urlpatterns: list[URLPattern] = [
    path("audit-exports", create_audit_export_view, name="ee-audit-exports"),
    path("audit-exports/stream", create_audit_export_view, name="ee-audit-exports-stream"),
    path("audit-exports/events", append_audit_event_view, name="ee-audit-exports-events"),
    path("audit-exports/verify", verify_audit_export_view, name="ee-audit-exports-verify"),
]
