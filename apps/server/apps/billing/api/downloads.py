"""Authenticated PDF/XML link issuance from validated artifacts, audited per request."""

import hashlib
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.http import HttpRequest, HttpResponse

from apps.billing import downloads, events, selectors
from apps.billing.access import read_as_member, record_member_denial, record_staff_denial
from apps.billing.actors import Actor
from apps.billing.callers import BillingForbiddenError
from apps.billing.pagination import InvalidListQueryError
from apps.orgs.actor_selectors import TenantCaller
from core.api import lanes
from core.api.scopes import Operation, declares
from services.identity.trusted_issuers import verify_configured_token

from . import permissions as op, views

GET_CREDIT_NOTE_DOWNLOAD = Operation(
    method="GET", operation_id="getCreditNoteDownloadLink", scope="invoice:read"
)


def _download(
    request: HttpRequest, document_id: UUID, *, credit_note: bool, operation: Operation
) -> HttpResponse:
    kind = "credit_note" if credit_note else "invoice"
    owner = selectors.credit_note_owner if credit_note else selectors.invoice_owner

    def produce(request_id: str) -> dict[str, object]:
        verified, lane = verify_configured_token(
            views._bearer(request), trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        target = f"urn:kodera:{kind}:{document_id}"
        if lane == "staff":
            record_staff_denial(
                verified=verified, target_urn=target, request_id=request_id, scope="invoice:read"
            )
            raise views._RefusedError()

        def sign(caller: TenantCaller) -> tuple[TenantCaller, dict[str, object]]:
            if set(request.GET) - {"format"} or len(request.GET.getlist("format")) > 1:
                raise InvalidListQueryError()
            format = request.GET.get("format", "pdf")
            if format not in {"pdf", "xml"}:
                raise InvalidListQueryError()
            return caller, downloads.link(
                organisation_id=caller.organisation_id,
                document_id=document_id,
                credit_note=credit_note,
                format=format,
            )

        try:
            caller, answer = read_as_member(
                verified=verified,
                organisation=lambda: owner(document_id),
                scope="invoice:read",
                read=sign,
            )
        except BillingForbiddenError as refused:
            record_member_denial(refused=refused, target_urn=target, request_id=request_id)
            raise views._RefusedError() from None
        with transaction.atomic():
            events.record(
                "invoice.download_requested",
                actor=Actor("tenant", caller.identity_id, request_id),
                organisation_id=caller.organisation_id,
                target=(kind, document_id),
                metadata={"format": request.GET.get("format", "pdf")},
            )
        return answer

    response = views._answer(request, operation, produce)
    if response.status_code == 200:
        response["ETag"] = '"sha256-' + hashlib.sha256(response.content).hexdigest() + '"'
    return response


@declares(op.GET_INVOICE_DOWNLOAD_LINK)
def invoice_download(request: HttpRequest, invoice_id: UUID) -> HttpResponse:
    return _download(request, invoice_id, credit_note=False, operation=op.GET_INVOICE_DOWNLOAD_LINK)


@declares(GET_CREDIT_NOTE_DOWNLOAD)
def credit_note_download(request: HttpRequest, credit_note_id: UUID) -> HttpResponse:
    return _download(request, credit_note_id, credit_note=True, operation=GET_CREDIT_NOTE_DOWNLOAD)
