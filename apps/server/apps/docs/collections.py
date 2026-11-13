"""Workspace-serialized Collections with current document visibility and bound query cursors."""

import hashlib
import json
from datetime import timedelta
from typing import Any
from uuid import UUID

from django.core import signing
from django.db import transaction
from django.db.models import F, Func, Q, TextField, Value
from django.db.models.fields.json import KeyTextTransform, KeyTransform
from django.utils import timezone

from apps.audit.services import record_workspace_resource_event
from apps.orgs.models import Membership
from services.identity.access_tokens import VerifiedAccessToken

from . import collection_schema as schema, services
from .errors import RefusalError
from .models import Collection, CollectionRow


def permission(row, principal):
    return (
        "editor"
        if row.creator_id == principal.membership_id or principal.role in {"org_owner", "org_admin"}
        else "viewer"
    )


def wire(row, principal):
    return {
        "id": str(row.id),
        "title": row.title,
        "properties": row.properties,
        "views": row.views,
        "role": permission(row, principal),
        "updatedAt": row.updated_at.isoformat(),
    }


def get(workspace_id, collection_id, principal, edit=False):
    row = Collection.objects.filter(
        pk=collection_id, workspace_id=workspace_id, deleted_at__isnull=True
    ).first()
    if row is None:
        raise RefusalError(404)
    if edit and permission(row, principal) != "editor":
        raise RefusalError(403)
    return row


def audit(principal, row, action, request_id):
    record_workspace_resource_event(
        action="workspace.collection." + action,
        organisation_id=principal.organisation_id,
        target_id=row.id,
        actor_id=principal.identity_id,
        request_id=request_id,
    )


@transaction.atomic
def create(*, verified, organisation_id, body, request_id):
    workspace_id, principal = services.context(verified, organisation_id)
    schema.object_fields(body, {"title", "properties", "views"})
    schema.views(body["properties"], body["views"])
    row = Collection.objects.create(
        workspace_id=workspace_id,
        creator_id=principal.membership_id,
        title=services.title(body["title"]),
        properties=body["properties"],
        views=body["views"],
    )
    audit(principal, row, "created", request_id)
    return wire(row, principal)


@transaction.atomic
def read(*, verified, organisation_id, collection_id):
    workspace_id, principal = services.context(verified, organisation_id)
    return wire(get(workspace_id, collection_id, principal), principal)


@transaction.atomic
def patch(*, verified, organisation_id, collection_id, body, if_match, request_id):
    workspace_id, principal = services.context(verified, organisation_id)
    row = get(workspace_id, collection_id, principal, True)
    if not if_match:
        raise RefusalError(428)
    if if_match != services.tag(wire(row, principal)):
        raise RefusalError(412)
    schema.object_fields(body, set(), {"title", "properties", "views"})
    if not body:
        raise RefusalError(422)
    properties, views = body.get("properties", row.properties), body.get("views", row.views)
    schema.views(properties, views)
    if properties != row.properties and CollectionRow.objects.filter(collection=row).exists():
        # Never silently reinterpret existing property values during a schema edit.
        raise RefusalError(409)
    row.title, row.properties, row.views = (
        services.title(body.get("title", row.title)),
        properties,
        views,
    )
    row.revision += 1
    row.save(update_fields=["title", "properties", "views", "revision", "updated_at"])
    audit(principal, row, "updated", request_id)
    return wire(row, principal)


@transaction.atomic
def delete(*, verified, organisation_id, collection_id, request_id):
    workspace_id, principal = services.context(verified, organisation_id)
    row = get(workspace_id, collection_id, principal, True)
    now = timezone.now()
    row.deleted_at, row.purge_after = now, now + timedelta(days=30)
    row.save(update_fields=["deleted_at", "purge_after", "updated_at"])
    audit(principal, row, "deleted", request_id)


def row_wire(row):
    return {
        "documentId": str(row.document_id),
        "values": row.values,
        "updatedAt": row.updated_at.isoformat(),
    }


@transaction.atomic
def read_row(*, verified, organisation_id, collection_id, document_id):
    workspace_id, principal = services.context(verified, organisation_id)
    collection = get(workspace_id, collection_id, principal)
    services.resource(
        workspace_id=workspace_id, principal=principal, verified=verified, document_id=document_id
    )
    row = CollectionRow.objects.filter(collection=collection, document_id=document_id).first()
    if row is None:
        raise RefusalError(404)
    return row_wire(row)


@transaction.atomic
def put_row(
    *,
    verified,
    organisation_id,
    collection_id,
    document_id,
    body,
    if_match,
    request_id,
    if_none_match="",
):
    workspace_id, principal = services.context(verified, organisation_id)
    collection = get(workspace_id, collection_id, principal, True)
    services.resource(
        workspace_id=workspace_id,
        principal=principal,
        verified=verified,
        document_id=document_id,
        edit=True,
    )
    schema.object_fields(body, {"values"})
    schema.values(collection.properties, body["values"])
    for typed in body["values"].values():
        if typed["type"] == "person" and typed["value"] is not None:
            if not Membership.objects.filter(
                pk=typed["value"],
                organisation_id=organisation_id,
                state="active",
                accepted_at__isnull=False,
                deleted_at__isnull=True,
                user__enabled=True,
                user__deleted_at__isnull=True,
            ).exists():
                raise RefusalError(422)
    row = CollectionRow.objects.filter(collection=collection, document_id=document_id).first()
    if if_match and if_none_match:
        raise RefusalError(422)
    if not if_match and not if_none_match:
        raise RefusalError(428)
    if if_none_match and if_none_match != "*":
        raise RefusalError(422)
    if row is None and if_none_match != "*":
        raise RefusalError(412)
    if row is not None and (if_none_match or if_match != services.tag(row_wire(row))):
        raise RefusalError(412)
    if row is None:
        row = CollectionRow.objects.create(
            collection=collection, document_id=document_id, values=body["values"]
        )
    else:
        row.values = body["values"]
        row.save(update_fields=["values", "updated_at"])
    collection.revision += 1
    collection.save(update_fields=["revision", "updated_at"])
    audit(principal, collection, "row_updated", request_id)
    return row_wire(row)


@transaction.atomic
def list_collections(*, verified, organisation_id, cursor, limit):
    workspace_id, principal = services.context(verified, organisation_id)
    salt = services.cursor_salt(principal, verified, "collections")
    after = services.anchor(cursor, salt, limit)
    rows = Collection.objects.filter(workspace_id=workspace_id, deleted_at__isnull=True)
    if after is not None:
        rows = rows.filter(id__lt=after)
    selected = list(rows.order_by("-id")[: limit + 1])
    return {
        "data": [wire(row, principal) for row in selected[:limit]],
        "has_more": len(selected) > limit,
        "next_cursor": signing.dumps(str(selected[limit - 1].id), salt=salt)
        if len(selected) > limit
        else None,
    }


def expression(key):
    return KeyTransform("value", KeyTransform(key, F("values")))


@transaction.atomic
def query(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    collection_id: UUID,
    body: dict[str, Any],
    cursor: str | None,
    limit: int,
):
    workspace_id, principal = services.context(verified, organisation_id)
    collection = get(workspace_id, collection_id, principal)
    schema.object_fields(body, set(), {"filters", "sorts", "viewId"})
    if type(limit) is not int or not 1 <= limit <= 200:
        raise RefusalError(400)
    view: dict[str, Any] = {}
    if "viewId" in body:
        selected_view = next((v for v in collection.views if v["id"] == body["viewId"]), None)
        if selected_view is None:
            raise RefusalError(422)
        view = selected_view
    schema.query(collection.properties, body.get("filters", []), body.get("sorts", []))
    filters = [*view.get("filters", []), *body.get("filters", [])]
    sorts = schema.items(body.get("sorts", view.get("sorts", [])), 10)
    schema.query(collection.properties, filters, sorts)
    fingerprint = hashlib.sha256(
        json.dumps([body, collection.revision], sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    salt = services.cursor_salt(principal, verified, f"collection:{collection.id}:{fingerprint}")
    offset = 0
    if cursor is not None:
        try:
            if not isinstance(cursor, str) or len(cursor) > 4096:
                raise ValueError
            offset = signing.loads(cursor, salt=salt, max_age=3600)
            if type(offset) is not int or not 0 <= offset <= 1000000:
                raise ValueError
        except (ValueError, TypeError, signing.BadSignature):
            raise RefusalError(400) from None
    permission = Func(
        F("document_id"),
        Value(principal.organisation_id),
        Value(principal.membership_id),
        Value(principal.identity_id),
        Value(verified.issuer),
        Value(verified.subject),
        function="docs_document_role",
        output_field=TextField(),
    )
    rows = (
        CollectionRow.objects.filter(collection=collection, document__deleted_at__isnull=True)
        .annotate(_permission=permission)
        .filter(_permission__isnull=False)
    )
    props = schema.definitions(collection.properties)
    for index, filt in enumerate(filters):
        key, op = filt["propertyId"], filt["operator"]
        alias = f"_filter{index}"
        rows = rows.annotate(**{alias: expression(key)})
        if op in schema.EMPTY:
            condition = Q(**{alias + "__isnull": True}) | Q(**{alias: None})
            if props[key]["type"] in {"text", "url"}:
                condition |= Q(**{alias: ""})
            if props[key]["type"] == "multi_select":
                condition |= Q(**{alias: []})
            rows = rows.filter(condition) if op == "is_empty" else rows.exclude(condition)
        elif op == "contains" and props[key]["type"] == "multi_select":
            rows = rows.annotate(**{alias: KeyTransform("value", KeyTransform(key, F("values")))})
            rows = rows.filter(**{alias + "__contains": filt["value"]["value"]})
        else:
            if op == "contains":
                rows = rows.annotate(
                    **{alias: KeyTextTransform("value", KeyTransform(key, F("values")))}
                )
            lookup = {"eq": "exact", "ne": "exact", "contains": "contains"}.get(op, op)
            condition = Q(**{alias + "__" + lookup: filt["value"]["value"]})
            rows = rows.exclude(condition) if op == "ne" else rows.filter(condition)
    ordering = []
    for index, sort in enumerate(sorts):
        key, alias = sort["propertyId"], f"_sort{index}"
        rows = rows.annotate(**{alias: expression(key)})
        field = F(alias)
        ordering.append(
            field.asc(nulls_last=True)
            if sort["direction"] == "asc"
            else field.desc(nulls_last=True)
        )
    selected = list(rows.order_by(*ordering, "document_id")[offset : offset + limit + 1])
    return {
        "data": [row_wire(row) for row in selected[:limit]],
        "has_more": len(selected) > limit,
        "next_cursor": signing.dumps(offset + limit, salt=salt) if len(selected) > limit else None,
    }


@transaction.atomic
def delete_row(*, verified, organisation_id, collection_id, document_id, if_match, request_id):
    workspace_id, principal = services.context(verified, organisation_id)
    collection = get(workspace_id, collection_id, principal, True)
    services.resource(
        workspace_id=workspace_id,
        principal=principal,
        verified=verified,
        document_id=document_id,
        edit=True,
    )
    row = CollectionRow.objects.filter(collection=collection, document_id=document_id).first()
    if row is None:
        raise RefusalError(404)
    if not if_match:
        raise RefusalError(428)
    if if_match != services.tag(row_wire(row)):
        raise RefusalError(412)
    row.delete()
    collection.revision += 1
    collection.save(update_fields=["revision", "updated_at"])
    audit(principal, collection, "row_deleted", request_id)
