"""Explicit Core producers for private exports; Matrix/media providers are required separately."""

from __future__ import annotations

import json
from functools import partial
from typing import Protocol
from uuid import UUID

from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction

from apps.billing import privacy_selectors as billing_privacy
from apps.docs import privacy_selectors as docs_privacy
from apps.identity import privacy_selectors as identity_privacy
from apps.workspaces import privacy_selectors as workspace_privacy

from .models import Membership
from .privacy_archives import (
    MAX_ARCHIVE_BYTES,
    MAX_ENTRIES,
    MAX_ENTRY_BYTES,
    ArchiveRefusalError,
    Entry,
    Request,
    canonical,
    require,
)
from .privacy_services import CurrentAuthority
from .privacy_sources import CapturedEntry, FrozenSource
from .privacy_storage import PrivateVolume

MEMBER_FIELDS = (
    "id",
    "user_id",
    "organisation_id",
    "role",
    "state",
    "accepted_at",
    "created_at",
    "deleted_at",
)
CORE_RESOURCE_KINDS = frozenset(
    {"user", "identity", "membership", "document", "collection", "order", "invoice", "credit_note"}
)


def _organisation(request: Request) -> UUID:
    if request.organisation_id is None:
        raise ArchiveRefusalError("workspace export binding")
    return UUID(request.organisation_id)


def _json(value) -> bytes:
    return canonical(json.loads(json.dumps(value, cls=DjangoJSONEncoder)))


def _item(section: str, kind: str, identifier: UUID, value) -> CapturedEntry:
    return CapturedEntry(
        f"{kind}:{identifier}", Entry(f"{section}/{kind}/{identifier}.json", _json(value))
    )


class CoreSupplement(Protocol):
    """Complete remaining source-specific personal data and current disclosure checks.

    Deployments inventory all installed applications before providing these adapters.
    No default empty implementation certifies coverage of the initial Core projections.
    """

    def capture(self, request: Request) -> tuple[CapturedEntry, ...]: ...
    def permitted(self, request: Request, resource: str) -> bool: ...


class CoreSources:
    def __init__(self, storage: PrivateVolume) -> None:
        self.storage = storage

    def adapters(
        self, supplements: dict[str, CoreSupplement] | None = None
    ) -> dict[str, FrozenSource]:
        sections = {"identity", "memberships", "documents", "collections", "billing"}
        require(
            supplements is not None
            and set(supplements) == sections
            and all(provider is not None for provider in supplements.values()),
            "Core export completeness providers unavailable",
        )
        if supplements is None:
            raise ArchiveRefusalError("Core export completeness providers unavailable")
        # Projections are not a complete application data inventory: remaining contributions,
        # payments, installed extensions and other personal facts require explicit providers.
        return {
            name: FrozenSource(
                name,
                self.storage,
                partial(self._complete_capture, name, supplements[name]),
                partial(self._complete_permitted, supplements[name]),
            )
            for name in sorted(sections)
        }

    def _complete_capture(
        self, section: str, supplement: CoreSupplement, request: Request
    ) -> tuple[CapturedEntry, ...]:
        additional = supplement.capture(request)
        require(
            type(additional) is tuple
            and all(
                item.resource.partition(":")[0] not in CORE_RESOURCE_KINDS for item in additional
            ),
            "supplement overrides Core resource provenance",
        )
        return self.capture(section, request) + additional

    def _complete_permitted(
        self, supplement: CoreSupplement, request: Request, resource: str
    ) -> bool:
        if not CurrentAuthority().authorize(request):
            return False
        if resource.partition(":")[0] in CORE_RESOURCE_KINDS:
            return self.permitted(request, resource)
        return supplement.permitted(request, resource)

    @staticmethod
    def _members(request: Request):
        rows = Membership.objects.all()
        return (
            rows.filter(organisation_id=_organisation(request))
            if request.scope == "workspace"
            else rows.filter(user_id=request.user_id)
        )

    @staticmethod
    def _workspace_ids(request: Request) -> tuple[UUID, ...]:
        organisations = (
            (_organisation(request),)
            if request.scope == "workspace"
            else tuple(
                Membership.objects.filter(
                    user_id=request.user_id,
                    state="active",
                    accepted_at__isnull=False,
                    deleted_at__isnull=True,
                ).values_list("organisation_id", flat=True)[: MAX_ENTRIES + 1]
            )
        )
        require(len(organisations) <= MAX_ENTRIES, "Core export organisation binding bound")
        try:
            return workspace_privacy.export_workspace_ids(
                organisation_ids=organisations, max_entries=MAX_ENTRIES
            )
        except workspace_privacy.PrivacyWorkspaceRefusalError as error:
            raise ArchiveRefusalError(str(error)) from None

    @staticmethod
    def _identity_ids(request: Request) -> tuple[UUID, ...]:
        try:
            return identity_privacy.export_identity_ids(
                user_id=request.user_id, max_entries=MAX_ENTRIES
            )
        except identity_privacy.PrivacyIdentityRefusalError as error:
            raise ArchiveRefusalError(str(error)) from None

    @staticmethod
    def _document_allowed(request: Request, identifier: UUID) -> bool:
        row = docs_privacy.document_disclosure_context(identifier=identifier)
        if row is None:
            return False
        org, creator_user = row
        if (
            request.scope == "workspace"
            and str(org) != request.organisation_id
            or request.scope == "account"
            and str(creator_user) != request.user_id
        ):
            return False
        identity = identity_privacy.disclosure_identity(
            user_id=request.user_id, organisation_id=org
        )
        member = Membership.objects.filter(
            user_id=request.user_id,
            organisation_id=org,
            state="active",
            accepted_at__isnull=False,
            deleted_at__isnull=True,
        ).first()
        if identity is None or member is None:
            return False
        identity_id, issuer, subject = identity
        return docs_privacy.document_role_permitted(
            identifier=identifier,
            organisation_id=org,
            membership_id=member.id,
            identity_id=identity_id,
            issuer=issuer,
            subject=subject,
        )

    @transaction.atomic
    def permitted(self, request: Request, resource: str) -> bool:
        if not CurrentAuthority().authorize(request):
            return False
        try:
            kind, raw = resource.split(":", 1)
            identifier = UUID(raw)
        except (ValueError, TypeError):
            return False
        if kind == "user":
            return str(identifier) == request.user_id
        if kind == "identity":
            return identity_privacy.identity_export_permitted(
                identifier=identifier,
                scope=request.scope,
                user_id=request.user_id,
                organisation_id=_organisation(request) if request.scope == "workspace" else None,
            )
        if kind == "membership":
            return self._members(request).filter(id=identifier).exists()
        if kind == "document":
            return self._document_allowed(request, identifier)
        if kind == "collection":
            return docs_privacy.collection_export_permitted(
                identifier=identifier,
                scope=request.scope,
                user_id=request.user_id,
                workspace_ids=self._workspace_ids(request),
            )
        if kind in {"order", "invoice", "credit_note"}:
            return billing_privacy.export_record_permitted(
                kind=kind,
                identifier=identifier,
                scope=request.scope,
                organisation_id=_organisation(request) if request.scope == "workspace" else None,
                identity_ids=self._identity_ids(request)
                if request.scope == "account" and kind == "order"
                else (),
            )
        return False

    @transaction.atomic
    def capture(self, section: str, request: Request) -> tuple[CapturedEntry, ...]:
        require(CurrentAuthority().authorize(request), "export authority revoked", 403)
        entries: list[CapturedEntry] = []
        total = 0

        def append(item: CapturedEntry) -> None:
            nonlocal total
            require(len(entries) < MAX_ENTRIES, "Core export entry bound")
            total += len(item.entry.content)
            require(
                len(item.entry.content) <= MAX_ENTRY_BYTES and total <= MAX_ARCHIVE_BYTES,
                "Core export byte bound",
            )
            entries.append(item)

        if section == "identity":
            if request.scope == "account":
                person = identity_privacy.export_user(user_id=request.user_id)
                append(_item(section, "user", UUID(request.user_id), person))
            for row in identity_privacy.export_identities(
                scope=request.scope,
                user_id=request.user_id,
                organisation_id=_organisation(request) if request.scope == "workspace" else None,
            ):
                append(_item(section, "identity", row["id"], row))
        elif section == "memberships":
            for row in self._members(request).order_by("id").values(*MEMBER_FIELDS).iterator():
                append(_item(section, "membership", row["id"], row))
        elif section in {"documents", "collections"}:
            workspace_ids = self._workspace_ids(request)
            allowed = partial(self._document_allowed, request)
            parts = (
                docs_privacy.document_export_parts(
                    scope=request.scope,
                    user_id=request.user_id,
                    workspace_ids=workspace_ids,
                    permitted=allowed,
                    max_journal_entries=MAX_ENTRIES,
                )
                if section == "documents"
                else docs_privacy.collection_export_parts(
                    scope=request.scope,
                    user_id=request.user_id,
                    workspace_ids=workspace_ids,
                    permitted=allowed,
                )
            )
            try:
                for part in parts:
                    if part.relative_path is None:
                        append(_item(section, part.kind, part.identifier, part.value))
                    else:
                        content = part.value if isinstance(part.value, bytes) else _json(part.value)
                        append(
                            CapturedEntry(
                                f"{part.kind}:{part.identifier}",
                                Entry(f"{section}/{part.relative_path}", content),
                            )
                        )
            except docs_privacy.PrivacySourceRefusalError as error:
                raise ArchiveRefusalError(str(error)) from None
        elif section == "billing":
            for kind, row in billing_privacy.export_records(
                scope=request.scope,
                organisation_id=_organisation(request) if request.scope == "workspace" else None,
                identity_ids=self._identity_ids(request) if request.scope == "account" else (),
            ):
                append(_item(section, kind, row["id"], row))
        else:
            raise ArchiveRefusalError("Core source unavailable")
        return tuple(entries)
