"""Scoped scalar identity projections for private export workers."""

from collections.abc import Iterator
from typing import Any
from uuid import UUID

from .models import Identity, User

IDENTITY_FIELDS = (
    "id",
    "user_id",
    "organisation_id",
    "issuer",
    "realm",
    "subject",
    "email",
    "enabled",
    "created_at",
    "deleted_at",
)


def current_export_organisation(*, identity_id: str, user_id: str) -> UUID | None:
    return (
        Identity.objects.filter(
            id=identity_id,
            user_id=user_id,
            enabled=True,
            deleted_at__isnull=True,
            user__enabled=True,
            user__deleted_at__isnull=True,
            organisation__isnull=False,
        )
        .values_list("organisation_id", flat=True)
        .first()
    )


def disclosure_identity(*, user_id: str, organisation_id: UUID) -> tuple[UUID, str, str] | None:
    row = Identity.objects.filter(
        user_id=user_id, organisation_id=organisation_id, enabled=True, deleted_at__isnull=True
    ).first()
    return (row.id, row.issuer, row.subject) if row is not None else None


class PrivacyIdentityRefusalError(Exception):
    """The complete identity binding set exceeds the export bound."""


def _workspace_id(value: UUID | None) -> UUID:
    if value is None:
        raise PrivacyIdentityRefusalError("workspace export binding")
    return value


def export_identity_ids(*, user_id: str, max_entries: int) -> tuple[UUID, ...]:
    rows = tuple(
        Identity.objects.filter(user_id=user_id, organisation__isnull=False).values_list(
            "id", flat=True
        )[: max_entries + 1]
    )
    if len(rows) > max_entries:
        raise PrivacyIdentityRefusalError("Core export identity binding bound")
    return rows


def identity_export_permitted(
    *, identifier: UUID, scope: str, user_id: str, organisation_id: UUID | None
) -> bool:
    if scope == "workspace" and organisation_id is None:
        raise PrivacyIdentityRefusalError("workspace export binding")
    rows = Identity.objects.filter(id=identifier, organisation__isnull=False)
    return (
        rows.filter(organisation_id=_workspace_id(organisation_id)).exists()
        if scope == "workspace"
        else rows.filter(user_id=user_id).exists()
    )


def export_user(*, user_id: str) -> dict[str, Any]:
    return dict(
        User.objects.values(
            "id", "email", "display_name", "enabled", "created_at", "deleted_at"
        ).get(id=user_id)
    )


def export_identities(
    *, scope: str, user_id: str, organisation_id: UUID | None
) -> Iterator[dict[str, Any]]:
    if scope == "workspace" and organisation_id is None:
        raise PrivacyIdentityRefusalError("workspace export binding")
    rows = (
        Identity.objects.filter(organisation_id=_workspace_id(organisation_id))
        if scope == "workspace"
        else Identity.objects.filter(user_id=user_id, organisation__isnull=False)
    )
    yield from rows.order_by("id").values(*IDENTITY_FIELDS).iterator()
