"""Workspace-serialized native document operations and current-role read ports."""

import hashlib
import json
import unicodedata
from collections.abc import Callable
from datetime import timedelta
from typing import Any
from uuid import UUID

from django.conf import settings
from django.core import signing
from django.db import IntegrityError, connection, transaction
from django.db.models import F, Func, Value
from django.db.models.fields import TextField
from django.utils import timezone

from apps.audit.services import record_workspace_resource_event
from apps.orgs.actor_selectors import TenantCaller
from apps.workspaces.channel_sets import lock_workspace
from apps.workspaces.moderation import RefusalError as WorkspaceRefusal, authorise_workspace
from apps.workspaces.selectors import workspace_id_for
from core.api.pagination import clamp_page_rows
from services.identity.access_tokens import VerifiedAccessToken

from . import engine, tickets, titles, tree
from .errors import RefusalError as RefusalError
from .models import Document, DocumentLink, DocumentSnapshot, DocumentUpdate
from .templates import TEMPLATES


def read_context(verified: VerifiedAccessToken, organisation_id: UUID) -> tuple[UUID, TenantCaller]:
    if not connection.in_atomic_block:
        raise RuntimeError("document access requires the operation transaction")
    workspace_id = workspace_id_for(organisation_id=organisation_id)
    if workspace_id is None:
        raise RefusalError(404)
    try:
        principal = authorise_workspace(
            verified=verified, organisation_id=organisation_id, lock=False
        )
    except WorkspaceRefusal as error:
        raise RefusalError(error.status, error.kind) from None
    return workspace_id, principal


def write_context(
    verified: VerifiedAccessToken, organisation_id: UUID
) -> tuple[UUID, TenantCaller]:
    # Refused callers never queue on the quota/structural write lock. Recheck authority
    # after acquiring it so a moderation change committed while waiting is observed.
    read_context(verified, organisation_id)
    if lock_workspace(organisation_id) is None:
        raise RefusalError(404)
    return read_context(verified, organisation_id)


def role(principal: TenantCaller, verified: VerifiedAccessToken, document_id: UUID) -> str | None:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT docs_document_role(%s,%s,%s,%s,%s,%s)",
            [
                document_id,
                principal.organisation_id,
                principal.membership_id,
                principal.identity_id,
                verified.issuer,
                verified.subject,
            ],
        )
        value = cursor.fetchone()[0]
    if value not in {None, "editor", "viewer"}:
        raise RefusalError(503, "service-unavailable")
    return value


def resource(
    *,
    workspace_id: UUID,
    principal: TenantCaller,
    verified: VerifiedAccessToken,
    document_id: UUID,
    edit: bool = False,
) -> tuple[Document, str]:
    row = Document.objects.filter(
        pk=document_id, workspace_id=workspace_id, deleted_at__isnull=True
    ).first()
    permission = role(principal, verified, document_id) if row is not None else None
    if row is None or permission is None:
        raise RefusalError(404)
    if edit and permission != "editor":
        raise RefusalError(403)
    return row, permission


def wire(row: Document, permission: str) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "parentId": str(row.parent_id) if row.parent_id else None,
        "title": row.title,
        "markdown": row.markdown,
        "role": permission,
        "updatedAt": row.updated_at.isoformat(),
    }


def tag(value: dict[str, Any]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return '"' + hashlib.sha256(encoded).hexdigest() + '"'


def audit(principal: TenantCaller, row: Document, action: str, request_id: str) -> None:
    record_workspace_resource_event(
        action="workspace.document." + action,
        organisation_id=principal.organisation_id,
        target_id=row.id,
        actor_id=principal.identity_id,
        request_id=request_id,
    )


def title(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > 255
        or any(
            ord(char) < 32 or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF for char in value
        )
    ):
        raise RefusalError(422)
    return unicodedata.normalize("NFC", value.strip())


def parents(workspace_id: UUID) -> dict[UUID, UUID | None]:
    return dict(
        Document.objects.filter(workspace_id=workspace_id, deleted_at__isnull=True).values_list(
            "id", "parent_id"
        )
    )


def validate_tree(value: dict[UUID, UUID | None]) -> None:
    try:
        tree.validate(value)
    except tree.TreeRefusedError:
        raise RefusalError(422) from None


def links(row: Document, names: tuple[str, ...]) -> None:
    """Replace outgoing references with bounded batched resolution on locale-free title keys."""
    DocumentLink.objects.filter(source=row).delete()
    if not names:
        return
    keys = sorted({titles.key(value) for value in names})
    targets = dict(
        Document.objects.filter(
            workspace_id=row.workspace_id, deleted_at__isnull=True, title_key__in=keys
        ).values_list("title_key", "id")
    )
    DocumentLink.objects.bulk_create(
        [DocumentLink(source=row, target_id=targets.get(key), target_title=key) for key in keys]
    )


def resolve_incoming(row: Document, old_title: str | None = None) -> None:
    """Only creation/rename can change the resolution of these two title buckets."""
    with connection.cursor() as cursor:
        cursor.execute(
            """UPDATE docs_documentlink l SET target_id=(
              SELECT t.id FROM docs_document t WHERE t.workspace_id=%s
              AND t.deleted_at IS NULL AND t.title_key=l.target_title
            ),updated_at=clock_timestamp()
            FROM docs_document s WHERE l.source_id=s.id AND s.workspace_id=%s
            AND l.target_title IN (%s,%s)""",
            [
                row.workspace_id,
                row.workspace_id,
                titles.key(old_title or row.title),
                titles.key(row.title),
            ],
        )


def stored(row: Document) -> tuple[DocumentSnapshot, list[bytes]]:
    snapshot = DocumentSnapshot.objects.select_for_update().filter(document=row).first()
    if snapshot is None:
        raise RefusalError(503, "service-unavailable")
    journal = list(
        DocumentUpdate.objects.filter(document=row, sequence__gt=snapshot.sequence)
        .order_by("sequence")
        .values_list("sequence", "state")[:257]
    )
    if len(journal) > 256 or [sequence for sequence, _ in journal] != list(
        range(snapshot.sequence + 1, snapshot.head_sequence + 1)
    ):
        raise RefusalError(503, "service-unavailable")
    return snapshot, [bytes(state) for _, state in journal]


def append(
    row: Document, snapshot: DocumentSnapshot, result: engine.State, principal: TenantCaller
) -> None:
    sequence = snapshot.head_sequence + 1
    DocumentUpdate.objects.create(
        document=row, sequence=sequence, actor_id=principal.identity_id, state=result.update
    )
    # REST replacement compacts in this same transaction, after its binary update is durable.
    snapshot.sequence = snapshot.head_sequence = sequence
    snapshot.state = result.snapshot
    snapshot.save(update_fields=["sequence", "head_sequence", "state", "updated_at"])
    DocumentUpdate.objects.filter(document=row, sequence__lte=sequence).delete()
    links(row, result.links)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_notify('kodera_docs',%s)", [str(row.id)])


@transaction.atomic
def authorize(verified: VerifiedAccessToken, organisation_id: UUID) -> None:
    read_context(verified, organisation_id)


@transaction.atomic
def authorize_document(
    *, verified: VerifiedAccessToken, organisation_id: UUID, document_id: UUID, edit: bool = False
) -> None:
    workspace_id, principal = read_context(verified, organisation_id)
    resource(
        workspace_id=workspace_id,
        principal=principal,
        verified=verified,
        document_id=document_id,
        edit=edit,
    )


@transaction.atomic
def create(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    name: str,
    parent_id: UUID | None,
    template_key: str | None,
    request_id: str,
) -> dict[str, Any]:
    workspace_id, principal = write_context(verified, organisation_id)
    if template_key is not None and (
        not isinstance(template_key, str) or template_key not in TEMPLATES
    ):
        raise RefusalError(422)
    row = Document(
        workspace_id=workspace_id,
        creator_id=principal.membership_id,
        parent_id=parent_id,
        title=title(name),
    )
    if parent_id is not None:
        resource(
            workspace_id=workspace_id,
            principal=principal,
            verified=verified,
            document_id=parent_id,
            edit=True,
        )
    final = parents(workspace_id)
    final[row.id] = parent_id
    validate_tree(final)
    result = engine.transform(markdown=TEMPLATES[template_key] if template_key else "")
    row.markdown = result.markdown
    try:
        row.save(force_insert=True)
    except IntegrityError as error:
        from apps.workspaces.quotas import is_guard

        if is_guard(error):
            raise
        raise RefusalError(409) from None
    DocumentSnapshot.objects.create(
        document=row, sequence=0, head_sequence=0, state=result.snapshot
    )
    links(row, result.links)
    resolve_incoming(row)
    audit(principal, row, "created", request_id)
    return wire(row, "editor")


@transaction.atomic
def read(
    *, verified: VerifiedAccessToken, organisation_id: UUID, document_id: UUID
) -> dict[str, Any]:
    workspace_id, principal = read_context(verified, organisation_id)
    row, permission = resource(
        workspace_id=workspace_id, principal=principal, verified=verified, document_id=document_id
    )
    return wire(row, permission)


@transaction.atomic
def patch(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    document_id: UUID,
    changes: dict[str, Any],
    if_match: str,
    request_id: str,
) -> dict[str, Any]:
    workspace_id, principal = write_context(verified, organisation_id)
    row, permission = resource(
        workspace_id=workspace_id,
        principal=principal,
        verified=verified,
        document_id=document_id,
        edit=True,
    )
    if not if_match:
        raise RefusalError(428)
    if if_match not in {"*", tag(wire(row, permission))}:
        raise RefusalError(412)
    if (
        not isinstance(changes, dict)
        or not changes
        or changes.keys() - {"title", "parentId", "markdown"}
    ):
        raise RefusalError(422)
    if "parentId" in changes:
        parent = changes["parentId"]
        if parent is not None:
            if not isinstance(parent, UUID):
                raise RefusalError(422)
            resource(
                workspace_id=workspace_id,
                principal=principal,
                verified=verified,
                document_id=parent,
                edit=True,
            )
        final = parents(workspace_id)
        final[row.id] = parent
        validate_tree(final)
        row.parent_id = parent
    old_title = row.title
    if "title" in changes:
        row.title = title(changes["title"])
    transformed = None
    if "markdown" in changes and changes["markdown"] != row.markdown:
        if not isinstance(changes["markdown"], str) or any(
            0xD800 <= ord(char) <= 0xDFFF for char in changes["markdown"]
        ):
            raise RefusalError(422)
        snapshot, updates = stored(row)
        transformed = engine.transform(
            snapshot=bytes(snapshot.state), updates=updates, markdown=changes["markdown"]
        )
        row.markdown = transformed.markdown
    row.revision += 1
    try:
        row.save(update_fields=["parent", "title", "markdown", "revision", "updated_at"])
    except IntegrityError as error:
        from apps.workspaces.quotas import is_guard

        if is_guard(error):
            raise
        raise RefusalError(409) from None
    if transformed is not None:
        append(row, snapshot, transformed, principal)
    else:
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_notify('kodera_docs',%s)", [str(row.id)])
    if row.title != old_title:
        resolve_incoming(row, old_title)
    audit(principal, row, "updated", request_id)
    return wire(row, permission)


@transaction.atomic
def delete(
    *, verified: VerifiedAccessToken, organisation_id: UUID, document_id: UUID, request_id: str
) -> None:
    workspace_id, principal = write_context(verified, organisation_id)
    row, _ = resource(
        workspace_id=workspace_id,
        principal=principal,
        verified=verified,
        document_id=document_id,
        edit=True,
    )
    if Document.objects.filter(parent=row, deleted_at__isnull=True).exists():
        raise RefusalError(409)
    now = timezone.now()
    Document.objects.filter(id=row.id).update(
        deleted_at=now, purge_after=now + timedelta(days=30), updated_at=now
    )
    DocumentLink.objects.filter(target_id=row.id).update(target=None, updated_at=now)
    audit(principal, row, "deleted", request_id)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_notify('kodera_docs',%s)", [str(row.id)])


@transaction.atomic
def collab_session(
    *, verified: VerifiedAccessToken, organisation_id: UUID, document_id: UUID, request_id: str
) -> dict[str, str]:
    workspace_id, principal = read_context(verified, organisation_id)
    row, permission = resource(
        workspace_id=workspace_id, principal=principal, verified=verified, document_id=document_id
    )
    endpoint = getattr(settings, "KODERA_COLLAB_PUBLIC_URL", None)
    from django.core.exceptions import ImproperlyConfigured

    from .configuration import endpoint as configured_endpoint

    if not isinstance(endpoint, str):
        raise RefusalError(503, "service-unavailable")
    try:
        configured_endpoint(endpoint, public=True)
    except ImproperlyConfigured:
        raise RefusalError(503, "service-unavailable") from None
    token, expires = tickets.mint(
        principal=principal, verified=verified, document_id=row.id, role=permission
    )
    audit(principal, row, "collab_created", request_id)
    return {"wsUrl": endpoint, "token": token, "expiresAt": expires, "role": permission}


def cursor_salt(principal: TenantCaller, verified: VerifiedAccessToken, surface: str) -> str:
    return f"documents:v1:{principal.organisation_id}:{principal.membership_id}:{verified.issuer}:{verified.subject}:{surface}"


def anchor(cursor: str | None, salt: str, limit: int) -> UUID | None:
    if type(limit) is not int or not 1 <= limit <= 200:
        raise RefusalError(400)
    if cursor is None:
        return None
    if not isinstance(cursor, str) or not cursor or len(cursor) > 512:
        raise RefusalError(400)
    try:
        return UUID(signing.loads(cursor, salt=salt, max_age=3600))
    except (ValueError, TypeError, signing.BadSignature):
        raise RefusalError(400) from None


def role_expression(principal: TenantCaller, verified: VerifiedAccessToken, field: str) -> Func:
    if field not in {"id", "source_id"}:
        raise ValueError("document role expression field refused")
    return Func(
        F(field),
        Value(principal.organisation_id),
        Value(principal.membership_id),
        Value(principal.identity_id),
        Value(verified.issuer),
        Value(verified.subject),
        function="docs_document_role",
        output_field=TextField(),
    )


@transaction.atomic
def list_documents(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    cursor: str | None,
    limit: int,
    parent_id: UUID | None = None,
) -> dict[str, Any]:
    workspace_id, principal = read_context(verified, organisation_id)
    salt = cursor_salt(principal, verified, "tree:" + str(parent_id))
    after = anchor(cursor, salt, limit)
    if parent_id is not None:
        resource(
            workspace_id=workspace_id, principal=principal, verified=verified, document_id=parent_id
        )
    rows = (
        Document.objects.filter(workspace_id=workspace_id, deleted_at__isnull=True)
        .annotate(_permission=role_expression(principal, verified, "id"))
        .filter(_permission__isnull=False)
    )
    if parent_id is not None:
        rows = rows.filter(parent_id=parent_id)
    if after is not None:
        rows = rows.filter(id__lt=after)
    selected = list(rows.order_by("-id")[: limit + 1])
    emitted, data, more = clamp_page_rows(
        selected, limit=limit, render=lambda row: wire(row, row._permission)
    )
    return {
        "data": data,
        "has_more": more,
        "next_cursor": signing.dumps(str(emitted[-1].id), salt=salt) if more and emitted else None,
    }


@transaction.atomic
def backlinks(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    document_id: UUID,
    cursor: str | None,
    limit: int,
) -> dict[str, Any]:
    workspace_id, principal = read_context(verified, organisation_id)
    resource(
        workspace_id=workspace_id, principal=principal, verified=verified, document_id=document_id
    )
    salt = cursor_salt(principal, verified, "backlinks:" + str(document_id))
    after = anchor(cursor, salt, limit)
    rows = (
        DocumentLink.objects.filter(target_id=document_id, source__workspace_id=workspace_id)
        .select_related("source")
        .annotate(_permission=role_expression(principal, verified, "source_id"))
        .filter(_permission__isnull=False)
    )
    if after is not None:
        rows = rows.filter(id__lt=after)
    selected = list(rows.order_by("-id")[: limit + 1])
    more = len(selected) > limit
    selected = selected[:limit]
    return {
        "data": [{"documentId": str(row.source_id), "title": row.source.title} for row in selected],
        "has_more": more,
        "next_cursor": signing.dumps(str(selected[-1].id), salt=salt) if more else None,
    }


@transaction.atomic
def search(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    query: str,
    cursor: str | None,
    limit: int,
) -> dict[str, Any]:
    import re

    from apps.workspaces.channel_access import may_view, resolve_all

    workspace_id, principal = read_context(verified, organisation_id)
    if not isinstance(query, str) or not 1 <= len(query) <= 200:
        raise RefusalError(400)
    salt = cursor_salt(principal, verified, "search:" + hashlib.sha256(query.encode()).hexdigest())
    anchor(None, salt, limit)
    after: UUID | None = None
    after_kind = ""
    if cursor is not None:
        if not isinstance(cursor, str) or not cursor or len(cursor) > 512:
            raise RefusalError(400)
        try:
            value = signing.loads(cursor, salt=salt, max_age=3600)
            if (
                not isinstance(value, list)
                or len(value) != 2
                or value[1] not in {"document", "channel"}
            ):
                raise ValueError
            after, after_kind = UUID(value[0]), value[1]
        except (ValueError, TypeError, signing.BadSignature):
            raise RefusalError(400) from None
    tokens = re.findall(r"[^\W_]+", query, flags=re.UNICODE)
    if not tokens:
        return {"data": [], "has_more": False, "next_cursor": None}
    tsquery = " & ".join(token + ":*" for token in tokens[:16])
    channels = []
    for channel_id, (access, name, topic) in resolve_all(workspace_id).items():
        if access.lifecycle not in {"active", "archived"}:
            continue
        if may_view(
            access,
            organisation_id=organisation_id,
            membership_id=principal.membership_id,
            authority_revision=principal.authority_revision,
        ):
            channels.append({"id": str(channel_id), "title": name, "content": topic})
    # Visible channel DTOs come from their owning service. PostgreSQL evaluates
    # their prefix/full-text predicate without this application reading foreign tables.
    with connection.cursor() as database:
        database.execute(
            """WITH q AS (SELECT to_tsquery('simple',%s) AS value),
            visible_channels AS (SELECT * FROM jsonb_to_recordset(%s::jsonb) AS c(id uuid,title text,content text)),
            results AS (
              SELECT d.id,'document'::text AS kind,d.title,left(d.markdown,1000) AS excerpt
              FROM docs_document d,q WHERE d.workspace_id=%s AND d.deleted_at IS NULL AND to_tsvector('simple',coalesce(d.title,'') || ' ' || coalesce(d.markdown,''))@@q.value
              AND docs_document_role(d.id,%s,%s,%s,%s,%s) IS NOT NULL
              UNION ALL SELECT c.id,'channel'::text,c.title,left(c.content,1000) FROM visible_channels c,q
              WHERE to_tsvector('simple',coalesce(c.title,'') || ' ' || coalesce(c.content,''))@@q.value)
            SELECT id,kind,title,excerpt FROM results WHERE (%s::uuid IS NULL OR (id,kind)<(%s::uuid,%s))
            ORDER BY id DESC,kind DESC LIMIT %s""",
            [
                tsquery,
                json.dumps(channels),
                workspace_id,
                principal.organisation_id,
                principal.membership_id,
                principal.identity_id,
                verified.issuer,
                verified.subject,
                after,
                after,
                after_kind,
                limit + 1,
            ],
        )
        found = database.fetchall()
    emitted, data, more = clamp_page_rows(
        found,
        limit=limit,
        render=lambda row: {
            "id": str(row[0]),
            "kind": row[1],
            "title": row[2],
            "excerpt": row[3],
        },
    )
    return {
        "data": data,
        "has_more": more,
        "next_cursor": signing.dumps([str(emitted[-1][0]), emitted[-1][1]], salt=salt)
        if more and emitted
        else None,
    }


def quota_replay_policy():
    """Supply the workspace effect policy through this application service boundary."""
    from apps.workspaces.services import quota_replay_policy as workspace_policy

    return workspace_policy()


def reconcile_template_collection(
    *,
    workspace_id: UUID,
    organisation_id: UUID,
    creator_membership_id: UUID,
    actor_identity_id: UUID,
    title_text: str,
    properties: list[dict[str, Any]],
    views: list[dict[str, Any]],
    existing_id: UUID | None = None,
    request_id: str = "",
    authorise_write: Callable[[], None] | None = None,
) -> tuple[UUID, bool]:
    """Idempotently ensure a template starter Collection exists in `workspace_id`."""
    from . import collection_schema
    from .models import Collection

    normalized_title = title(title_text)
    collection_schema.views(properties, views)
    with transaction.atomic():
        if authorise_write is not None:
            authorise_write()
        if lock_workspace(organisation_id) is None:
            raise RefusalError(404)
        row = None
        if existing_id is not None:
            row = Collection.objects.filter(
                pk=existing_id, workspace_id=workspace_id, deleted_at__isnull=True
            ).first()
        if row is None:
            row = (
                Collection.objects.filter(
                    workspace_id=workspace_id,
                    deleted_at__isnull=True,
                    title=normalized_title,
                )
                .order_by("id")
                .first()
            )
        if row is not None:
            return row.id, False
        row = Collection.objects.create(
            workspace_id=workspace_id,
            creator_id=creator_membership_id,
            title=normalized_title,
            properties=properties,
            views=views,
        )
        record_workspace_resource_event(
            action="workspace.collection.created",
            organisation_id=organisation_id,
            target_id=row.id,
            actor_id=actor_identity_id,
            request_id=request_id,
        )
        return row.id, True


def reconcile_template_document(
    *,
    workspace_id: UUID,
    organisation_id: UUID,
    creator_membership_id: UUID,
    actor_identity_id: UUID,
    title_text: str,
    markdown_text: str,
    channel_id: UUID | None = None,
    collection_id: UUID | None = None,
    collection_values: dict[str, Any] | None = None,
    existing_id: UUID | None = None,
    request_id: str = "",
    authorise_write: Callable[[], None] | None = None,
) -> tuple[UUID, bool]:
    """Idempotently ensure a template starter Document, Snapshot, and optional CollectionRow exist."""
    from . import collection_schema
    from .models import Collection, CollectionRow

    normalized_title = title(title_text)
    target_key = titles.key(normalized_title)
    existing_doc: Document | None = None
    if existing_id is not None:
        existing_doc = Document.objects.filter(
            pk=existing_id, workspace_id=workspace_id, deleted_at__isnull=True
        ).first()
    if existing_doc is None:
        existing_doc = (
            Document.objects.filter(
                workspace_id=workspace_id, title_key=target_key, deleted_at__isnull=True
            )
            .order_by("id")
            .first()
        )
    has_valid_snapshot = (
        existing_doc is not None
        and DocumentSnapshot.objects.filter(document=existing_doc)
        .exclude(state=b"")
        .exclude(state=b"\x00\x00")
        .exists()
    )

    transformed: engine.State | None = None
    if not has_valid_snapshot:
        if authorise_write is not None:
            with transaction.atomic():
                authorise_write()
        transformed = engine.transform(markdown=markdown_text)
        if not transformed.snapshot or transformed.snapshot == b"\x00\x00":
            raise RefusalError(503, "service-unavailable")

    with transaction.atomic():
        if authorise_write is not None:
            authorise_write()
        if lock_workspace(organisation_id) is None:
            raise RefusalError(404)
        row = None
        if existing_id is not None:
            row = Document.objects.filter(
                pk=existing_id, workspace_id=workspace_id, deleted_at__isnull=True
            ).first()
        if row is None:
            row = (
                Document.objects.filter(
                    workspace_id=workspace_id, title_key=target_key, deleted_at__isnull=True
                )
                .order_by("id")
                .first()
            )
        created = False
        if row is None:
            if transformed is None:
                raise RefusalError(503, "service-unavailable")
            row = Document(
                workspace_id=workspace_id,
                creator_id=creator_membership_id,
                channel_id=channel_id,
                title=normalized_title,
                markdown=transformed.markdown,
                visibility="workspace",
            )
            row.save(force_insert=True)
            DocumentSnapshot.objects.create(
                document=row, sequence=0, head_sequence=0, state=transformed.snapshot
            )
            links(row, transformed.links)
            resolve_incoming(row)
            record_workspace_resource_event(
                action="workspace.document.created",
                organisation_id=organisation_id,
                target_id=row.id,
                actor_id=actor_identity_id,
                request_id=request_id,
            )
            created = True
        else:
            existing_snap = DocumentSnapshot.objects.filter(document=row).first()
            if existing_snap is None:
                if transformed is None:
                    raise RefusalError(503, "service-unavailable")
                DocumentSnapshot.objects.create(
                    document=row, sequence=0, head_sequence=0, state=transformed.snapshot
                )
            elif bytes(existing_snap.state) in (b"", b"\x00\x00"):
                if transformed is None:
                    raise RefusalError(503, "service-unavailable")
                existing_snap.state = transformed.snapshot
                existing_snap.save(update_fields=["state", "updated_at"])

        if collection_id is not None:
            collection = Collection.objects.filter(
                pk=collection_id, workspace_id=workspace_id, deleted_at__isnull=True
            ).first()
            if collection is not None:
                supplied_values = dict(collection_values or {})
                collection_schema.values(collection.properties, supplied_values)
                _, created_row = CollectionRow.objects.get_or_create(
                    collection=collection,
                    document=row,
                    defaults={"values": supplied_values},
                )
                if created_row:
                    collection.revision += 1
                    collection.save(update_fields=["revision", "updated_at"])
        return row.id, created
