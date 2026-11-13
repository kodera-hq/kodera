"""Explicit Core producers for private exports; Matrix/media providers are required separately."""

from __future__ import annotations

import json
from functools import partial
from typing import Protocol
from uuid import UUID

from django.core.serializers.json import DjangoJSONEncoder
from django.db import connection, transaction

from apps.billing.models import CreditNote, Invoice, Order
from apps.docs.models import Collection, CollectionRow, Document, DocumentSnapshot, DocumentUpdate
from apps.identity.models import Identity, User
from apps.workspaces.models import Workspace

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
ORDER_FIELDS = (
    "id",
    "organisation_id",
    "state",
    "placed_by",
    "created_at",
    "billing_contact_email",
    "billing_contact_name",
    "purchase_order_ref",
)
INVOICE_FIELDS = (
    "id",
    "organisation_id",
    "number",
    "state",
    "currency",
    "issued_at",
    "due_at",
    "paid_at",
    "total_excl_vat_minor",
    "vat_amount_minor",
    "total_incl_vat_minor",
    "amount_paid_minor",
)
CREDIT_FIELDS = (
    "id",
    "organisation_id",
    "invoice_id",
    "number",
    "issued_at",
    "reason",
    "currency",
    "total_excl_vat_minor",
    "vat_amount_minor",
    "total_incl_vat_minor",
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
    def _identities(request: Request):
        return Identity.objects.filter(user_id=request.user_id, organisation__isnull=False)

    @staticmethod
    def _members(request: Request):
        rows = Membership.objects.all()
        return (
            rows.filter(organisation_id=_organisation(request))
            if request.scope == "workspace"
            else rows.filter(user_id=request.user_id)
        )

    @staticmethod
    def _workspace_ids(request: Request):
        rows = Workspace.objects.all()
        if request.scope == "workspace":
            return rows.filter(organisation_id=_organisation(request)).values_list("id", flat=True)
        organisations = Membership.objects.filter(
            user_id=request.user_id,
            state="active",
            accepted_at__isnull=False,
            deleted_at__isnull=True,
        ).values_list("organisation_id", flat=True)
        return rows.filter(organisation_id__in=organisations).values_list("id", flat=True)

    @staticmethod
    def _document_allowed(request: Request, identifier: UUID) -> bool:
        row = (
            Document.objects.filter(id=identifier, deleted_at__isnull=True)
            .values("workspace__organisation_id", "creator__user_id")
            .first()
        )
        if row is None:
            return False
        org = row["workspace__organisation_id"]
        if (
            request.scope == "workspace"
            and str(org) != request.organisation_id
            or request.scope == "account"
            and str(row["creator__user_id"]) != request.user_id
        ):
            return False
        identity = Identity.objects.filter(
            user_id=request.user_id, organisation_id=org, enabled=True, deleted_at__isnull=True
        ).first()
        member = Membership.objects.filter(
            user_id=request.user_id,
            organisation_id=org,
            state="active",
            accepted_at__isnull=False,
            deleted_at__isnull=True,
        ).first()
        if identity is None or member is None:
            return False
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT docs_document_role(%s,%s,%s,%s,%s,%s)",
                [identifier, org, member.id, identity.id, identity.issuer, identity.subject],
            )
            return cursor.fetchone()[0] in {"editor", "viewer"}

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
            identity_rows = Identity.objects.filter(id=identifier, organisation__isnull=False)
            return (
                identity_rows.filter(organisation_id=_organisation(request)).exists()
                if request.scope == "workspace"
                else identity_rows.filter(user_id=request.user_id).exists()
            )
        if kind == "membership":
            return self._members(request).filter(id=identifier).exists()
        if kind == "document":
            return self._document_allowed(request, identifier)
        if kind == "collection":
            collection_rows = Collection.objects.filter(
                id=identifier,
                deleted_at__isnull=True,
                workspace_id__in=self._workspace_ids(request),
            )
            if request.scope == "account":
                collection_rows = collection_rows.filter(creator__user_id=request.user_id)
            return collection_rows.exists()
        if kind == "order":
            order_rows = Order.objects.filter(id=identifier)
            return (
                order_rows.filter(organisation_id=_organisation(request)).exists()
                if request.scope == "workspace"
                else order_rows.filter(
                    placed_by__in=self._identities(request).values_list("id", flat=True)
                ).exists()
            )
        if kind in {"invoice", "credit_note"}:
            model = Invoice if kind == "invoice" else CreditNote
            return (
                request.scope == "workspace"
                and model.objects.filter(
                    id=identifier, organisation_id=_organisation(request)
                ).exists()
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
                person = User.objects.values(
                    "id", "email", "display_name", "enabled", "created_at", "deleted_at"
                ).get(id=request.user_id)
                append(_item(section, "user", UUID(request.user_id), person))
                rows = self._identities(request)
            else:
                rows = Identity.objects.filter(organisation_id=_organisation(request))
            for row in rows.order_by("id").values(*IDENTITY_FIELDS).iterator():
                append(_item(section, "identity", row["id"], row))
        elif section == "memberships":
            for row in self._members(request).order_by("id").values(*MEMBER_FIELDS).iterator():
                append(_item(section, "membership", row["id"], row))
        elif section == "documents":
            rows = Document.objects.filter(
                workspace_id__in=self._workspace_ids(request), deleted_at__isnull=True
            )
            if request.scope == "account":
                rows = rows.filter(creator__user_id=request.user_id)
            for document in rows.order_by("id").iterator():
                if not self._document_allowed(request, document.id):
                    continue
                snapshot = (
                    DocumentSnapshot.objects.select_for_update().filter(document=document).first()
                )
                if snapshot is None:
                    raise ArchiveRefusalError("native document snapshot absent")
                require(
                    0 <= snapshot.head_sequence - snapshot.sequence <= MAX_ENTRIES,
                    "native document journal incomplete",
                )
                append(
                    _item(
                        section,
                        "document",
                        document.id,
                        {
                            "id": document.id,
                            "title": document.title,
                            "parentId": document.parent_id,
                            "revision": document.revision,
                            "markdownProjection": document.markdown,
                            "snapshotSequence": snapshot.sequence,
                            "headSequence": snapshot.head_sequence,
                            "format": "yjs-v1",
                        },
                    )
                )
                resource = f"document:{document.id}"
                prefix = f"documents/native/{document.id}"
                append(
                    CapturedEntry(resource, Entry(prefix + "/snapshot.bin", bytes(snapshot.state)))
                )
                expected = snapshot.sequence + 1
                for update in (
                    DocumentUpdate.objects.filter(
                        document=document,
                        sequence__gt=snapshot.sequence,
                        sequence__lte=snapshot.head_sequence,
                    )
                    .order_by("sequence")
                    .iterator(chunk_size=1)
                ):
                    require(update.sequence == expected, "native document journal incomplete")
                    expected += 1
                    append(
                        CapturedEntry(
                            resource,
                            Entry(prefix + f"/update_{update.sequence}.bin", bytes(update.state)),
                        )
                    )
                require(
                    expected == snapshot.head_sequence + 1, "native document journal incomplete"
                )
        elif section == "collections":
            rows = Collection.objects.filter(
                workspace_id__in=self._workspace_ids(request), deleted_at__isnull=True
            )
            if request.scope == "account":
                rows = rows.filter(creator__user_id=request.user_id)
            for row in rows.order_by("id").iterator():
                append(
                    _item(
                        section,
                        "collection",
                        row.id,
                        {
                            "id": row.id,
                            "title": row.title,
                            "properties": row.properties,
                            "views": row.views,
                            "revision": row.revision,
                        },
                    )
                )
                for member in (
                    CollectionRow.objects.filter(collection=row).order_by("id").iterator()
                ):
                    if self._document_allowed(request, member.document_id):
                        # Both collection and document authority are necessary for the row.
                        append(
                            CapturedEntry(
                                f"document:{member.document_id}",
                                Entry(
                                    f"collections/rows/{row.id}/{member.document_id}.json",
                                    _json(
                                        {
                                            "collectionId": row.id,
                                            "documentId": member.document_id,
                                            "values": member.values,
                                        }
                                    ),
                                ),
                            )
                        )
        elif section == "billing":
            orders = (
                Order.objects.filter(organisation_id=_organisation(request))
                if request.scope == "workspace"
                else Order.objects.filter(
                    placed_by__in=self._identities(request).values_list("id", flat=True)
                )
            )
            for row in orders.order_by("id").values(*ORDER_FIELDS).iterator():
                append(_item(section, "order", row["id"], row))
            if request.scope == "workspace":
                for kind, model, fields in (
                    ("invoice", Invoice, INVOICE_FIELDS),
                    ("credit_note", CreditNote, CREDIT_FIELDS),
                ):
                    for row in (
                        model.objects.filter(organisation_id=_organisation(request))
                        .order_by("id")
                        .values(*fields)
                        .iterator()
                    ):
                        append(_item(section, kind, row["id"], row))
        else:
            raise ArchiveRefusalError("Core source unavailable")
        return tuple(entries)
