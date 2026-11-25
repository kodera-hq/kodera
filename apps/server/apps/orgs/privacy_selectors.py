"""Customer privacy HTTP authority, request validation and durable journal projection."""

import hashlib
import json
import re
from typing import Any
from uuid import UUID

from django.db import transaction
from django.http import HttpRequest
from django.utils import timezone

from apps.identity.selectors import (
    current_identities,
    current_identity,
    current_identity_for_organisation,
    is_storable_subject,
)
from apps.orgs.actor_selectors import (
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    read_tenant_caller,
)
from apps.orgs.models import Membership
from apps.orgs.privacy_models import AccountErasure, PrivacyErasure, PrivacyExport
from services.identity.access_tokens import VerifiedAccessToken

KEY = re.compile(r"[\x21-\x7e]{16,255}\Z")
MAX_BODY_BYTES = 4096
ACCOUNT_ROLES = frozenset({"org_owner", "org_admin", "org_billing", "org_member"})


class PrivacyHttpError(Exception):
    def __init__(self, kind: str, **extensions: object) -> None:
        super().__init__(kind)
        self.kind = kind
        self.extensions = extensions


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, value in pairs:
        if name in result:
            raise PrivacyHttpError("malformed-request")
        result[name] = value
    return result


def _clean_reason(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= 500
        and "\x00" not in value
        and not any("\ud800" <= ch <= "\udfff" for ch in value)
    )


def _validate(request: HttpRequest, kind: str) -> None:
    raw_key = request.headers.get("Idempotency-Key")
    if raw_key is None or raw_key == "":
        raise PrivacyHttpError("idempotency-key-missing")
    if not KEY.fullmatch(raw_key):
        raise PrivacyHttpError("malformed-request")
    if request.content_type != "application/json" or len(request.body) > MAX_BODY_BYTES:
        raise PrivacyHttpError("malformed-request")
    try:
        body = json.loads(request.body, object_pairs_hook=_unique_object)
    except (ValueError, UnicodeError):
        raise PrivacyHttpError("malformed-request") from None
    if not isinstance(body, dict):
        raise PrivacyHttpError("malformed-request")
    if kind == "export":
        if (
            body.keys() - {"format", "includeMedia"}
            or body.get("format") != "zip"
            or type(body.get("includeMedia", True)) is not bool
        ):
            raise PrivacyHttpError("malformed-request")
    elif (
        body.keys() - {"confirmation", "reason"}
        or body.get("confirmation") != "delete"
        or not _clean_reason(body.get("reason", ""))
    ):
        raise PrivacyHttpError("malformed-request")


def _last_owner(user_id: UUID) -> None:
    owned = Membership.objects.filter(
        user_id=user_id,
        role="org_owner",
        state="active",
        accepted_at__isnull=False,
        deleted_at__isnull=True,
        organisation__deleted_at__isnull=True,
    ).exclude(organisation__state="closed")
    for membership in owned:
        if (
            not Membership.objects.filter(
                organisation_id=membership.organisation_id,
                role="org_owner",
                state="active",
                accepted_at__isnull=False,
                deleted_at__isnull=True,
                user__enabled=True,
                user__deleted_at__isnull=True,
            )
            .exclude(user_id=user_id)
            .exists()
        ):
            raise PrivacyHttpError(
                "last-owner-protected", organisation_id=str(membership.organisation_id)
            )


def _lifecycle(row: Any, scope: str, kind: str) -> dict[str, Any]:
    if kind == "export":
        status = row.status
        if status == "ready" and row.expires_at <= timezone.now():
            status = "expired"
        failure = "build_failed" if status == "failed" else None
    else:
        # Core purge alone proves neither remote erasure nor statutory retention.
        status = "completed" if row.status == "complete" and row.completed_at else "running"
        failure = None
    return {
        "id": str(row.id),
        "scope": scope,
        "kind": kind,
        "status": status,
        "requestedAt": row.created_at.isoformat(),
        "updatedAt": row.updated_at.isoformat(),
        "expiresAt": row.expires_at.isoformat() if kind == "export" else None,
        # The journal's purge_not_before is a recovery cutoff, never an accounting deadline.
        "purgeAfter": None,
        "failureCode": failure,
    }


@transaction.atomic
def admit_privacy_request(
    request: HttpRequest,
    verified: VerifiedAccessToken,
    organisation_id: UUID | None,
    request_id: UUID | None,
    kind: str,
    download: bool,
) -> tuple[bytes, str]:
    if not is_storable_subject(verified.subject):
        raise PrivacyHttpError("identity-unknown")
    scope = "account" if organisation_id is None else "workspace"
    allowed_states = {"active"} if request.method == "POST" else {"active", "suspended"}
    if organisation_id is None:
        identities = current_identities(issuer=verified.issuer, subject=verified.subject)
        if not identities:
            raise PrivacyHttpError("identity-unknown")
        person = identities[0][0]
        admitted = False
        saw_known_identity = False
        for _, cand_identity in identities:
            if cand_identity.organisation_id is None:
                continue
            try:
                caller = read_tenant_caller(
                    verified=verified, organisation_id=cand_identity.organisation_id
                )
                saw_known_identity = True
            except TenantCallerUnknownError:
                continue
            except TenantCallerNotFoundError:
                saw_known_identity = True
                continue
            if caller.role in ACCOUNT_ROLES and caller.organisation_state in allowed_states:
                admitted = True
                break
        if not admitted:
            if not saw_known_identity:
                raise PrivacyHttpError("identity-unknown")
            raise PrivacyHttpError("forbidden")
    else:
        resolved = current_identity_for_organisation(
            organisation_id=organisation_id, issuer=verified.issuer, subject=verified.subject
        ) or current_identity(issuer=verified.issuer, subject=verified.subject)
        if resolved is None:
            raise PrivacyHttpError("identity-unknown")
        person, _ = resolved
        try:
            caller = read_tenant_caller(verified=verified, organisation_id=organisation_id)
        except TenantCallerUnknownError:
            raise PrivacyHttpError("identity-unknown") from None
        except TenantCallerNotFoundError:
            raise PrivacyHttpError("not-found") from None
        if caller.role != "org_owner" or caller.organisation_state not in allowed_states:
            raise PrivacyHttpError("forbidden")
    if request.GET:
        raise PrivacyHttpError("malformed-request")
    if request.method == "POST":
        _validate(request, kind)
        if kind == "deletion" and scope == "account":
            _last_owner(person.id)
        # No HTTP runtime/finalizer is configured. Never call a Core-only producer or cutoff.
        raise PrivacyHttpError("service-unavailable", retry_after_s=60)
    if request_id is None:
        raise PrivacyHttpError("not-found")
    row: Any
    if kind == "export":
        rows = PrivacyExport.objects.filter(id=request_id, scope=scope)
        rows = (
            rows.filter(user_id=person.id)
            if organisation_id is None
            else rows.filter(organisation_id=organisation_id)
        )
        row = rows.first()
    elif organisation_id is None:
        row = AccountErasure.objects.filter(id=request_id, user_reference=person.id).first()
    else:
        row = PrivacyErasure.objects.filter(
            id=request_id, organisation_reference=organisation_id
        ).first()
    if row is None:
        raise PrivacyHttpError("not-found")
    if download:
        if row.status != "ready" or row.expires_at <= timezone.now():
            raise PrivacyHttpError("conflict")
        raise PrivacyHttpError("service-unavailable", retry_after_s=60)
    content = json.dumps(_lifecycle(row, scope, kind), sort_keys=True).encode()
    etag = '"' + hashlib.sha256(content).hexdigest() + '"'
    return content, etag
