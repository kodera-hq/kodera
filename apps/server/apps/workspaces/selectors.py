"""Scoped workspace values and caller-owned transaction fences."""

import http.client
import importlib
import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import connection
from django.db.models import Q

from .models import (
    Channel,
    PartnerChannelAgreement,
    Workspace,
    WorkspaceMemberRestriction,
    WorkspaceQuota,
)


def active_channel_id(*, workspace_id: UUID, channel_id: UUID) -> UUID | None:
    """An active text or audio channel in the exact workspace, without exporting its model."""
    return (
        Channel.objects.filter(
            id=channel_id,
            workspace_id=workspace_id,
            kind__in=("text", "audio"),
            lifecycle="active",
        )
        .values_list("id", flat=True)
        .first()
    )


def active_text_channel_id(*, workspace_id: UUID, channel_id: UUID) -> UUID | None:
    """An active text channel in the exact workspace, without exporting its model."""
    return (
        Channel.objects.filter(
            id=channel_id, workspace_id=workspace_id, kind="text", lifecycle="active"
        )
        .values_list("id", flat=True)
        .first()
    )


def is_confidential_channel(*, channel_id: UUID, organisation_id: UUID) -> bool:
    """Read the confidential designation within the exact organisation."""
    return Channel.objects.filter(
        id=channel_id, workspace__organisation_id=organisation_id, is_confidential=True
    ).exists()


def is_confidential_text_channel(*, workspace_id: UUID, channel_id: UUID) -> bool:
    """Whether the active text channel carries the immutable confidential designation."""
    return Channel.objects.filter(
        id=channel_id,
        workspace_id=workspace_id,
        kind="text",
        lifecycle="active",
        is_confidential=True,
    ).exists()


def is_designated_confidential_channel(*, workspace_id: UUID, channel_id: UUID) -> bool:
    """Whether an active or archived text channel carries the immutable confidential designation."""
    return Channel.objects.filter(
        id=channel_id,
        workspace_id=workspace_id,
        kind="text",
        lifecycle__in=("active", "archived"),
        is_confidential=True,
    ).exists()


def undeleted_channel_id(*, workspace_id: UUID, channel_id: UUID) -> UUID | None:
    """A non-deleted channel in the exact workspace, without exporting its model."""
    return (
        Channel.objects.filter(id=channel_id, workspace_id=workspace_id)
        .exclude(lifecycle__in=["deletion_pending", "deleted"])
        .values_list("id", flat=True)
        .first()
    )


def workspace_organisation(*, workspace_id: UUID) -> UUID:
    return Workspace.objects.values_list("organisation_id", flat=True).get(id=workspace_id)


def workspace_id_for(*, organisation_id: UUID) -> UUID | None:
    """Resolve the workspace without taking a row lock."""
    return (
        Workspace.objects.filter(organisation_id=organisation_id)
        .order_by("id")
        .values_list("id", flat=True)
        .first()
    )


def link_previews_allowed(organisation_id: UUID) -> bool:
    """Whether URL previews are permitted for the organisation's workspace."""
    return not Workspace.objects.filter(
        organisation_id=organisation_id, allow_link_previews=False
    ).exists()


def lock_workspace(*, workspace_id: UUID) -> None:
    Workspace.objects.select_for_update().get(id=workspace_id)


def lock_workspace_if_present(*, workspace_id: UUID) -> bool:
    return (
        Workspace.objects.select_for_update().filter(id=workspace_id).order_by("id").first()
        is not None
    )


def lock_organisation_workspace(*, organisation_id: UUID) -> UUID:
    return (
        Workspace.objects.select_for_update()
        .order_by("id")
        .values_list("id", flat=True)
        .get(organisation_id=organisation_id)
    )


def lock_organisation_workspace_if_present(*, organisation_id: UUID) -> UUID | None:
    return (
        Workspace.objects.select_for_update()
        .filter(organisation_id=organisation_id)
        .order_by("id")
        .values_list("id", flat=True)
        .first()
    )


def digest_workspace(*, organisation_id: UUID, membership_id: UUID) -> UUID | None:
    workspace = Workspace.objects.filter(organisation_id=organisation_id).order_by("id").first()
    if (
        workspace is None
        or WorkspaceMemberRestriction.objects.filter(
            workspace=workspace, membership_id=membership_id
        )
        .filter(Q(banned=True) | Q(kicked=True))
        .exists()
    ):
        return None
    return workspace.id


def passport_unrestricted_workspaces(
    *, memberships: tuple[tuple[UUID, UUID], ...]
) -> dict[UUID, UUID]:
    """Map `organisation_id -> workspace_id` for memberships not banned or kicked in the workspace."""
    if not memberships:
        return {}
    org_ids = [org_id for org_id, _ in memberships]
    membership_by_org = dict(memberships)
    workspaces = {
        ws.organisation_id: ws.id for ws in Workspace.objects.filter(organisation_id__in=org_ids)
    }
    if not workspaces:
        return {}
    restricted_pairs = set(
        WorkspaceMemberRestriction.objects.filter(
            workspace_id__in=list(workspaces.values()),
            membership_id__in=list(membership_by_org.values()),
        )
        .filter(Q(banned=True) | Q(kicked=True))
        .values_list("workspace_id", "membership_id")
    )
    result: dict[UUID, UUID] = {}
    for org_id, ws_id in workspaces.items():
        membership_id = membership_by_org[org_id]
        if (ws_id, membership_id) not in restricted_pairs:
            result[org_id] = ws_id
    return result


def restricted_workspace_membership_ids(
    *, workspace_id: UUID, membership_ids: Iterable[UUID]
) -> set[UUID]:
    """Membership ids banned or kicked in `workspace_id`."""
    return set(
        WorkspaceMemberRestriction.objects.filter(
            workspace_id=workspace_id,
            membership_id__in=membership_ids,
        )
        .filter(Q(banned=True) | Q(kicked=True))
        .values_list("membership_id", flat=True)
    )


def is_workspace_membership_restricted(*, membership_id: UUID) -> bool:
    """Whether `membership_id` is currently banned or kicked in its workspace."""
    return (
        WorkspaceMemberRestriction.objects.filter(membership_id=membership_id)
        .filter(Q(banned=True) | Q(kicked=True))
        .exists()
    )


@dataclass(frozen=True, slots=True)
class ChannelSnapshot:
    id: UUID
    name: str
    kind: str
    lifecycle: str
    room_state: str
    is_confidential: bool


def _channel_snapshot(channel: Channel) -> ChannelSnapshot:
    return ChannelSnapshot(
        channel.id,
        channel.name,
        channel.kind,
        channel.lifecycle,
        channel.room_state,
        channel.is_confidential,
    )


def channel_snapshot(
    *, workspace_id: UUID, channel_id: UUID, for_update: bool = False
) -> ChannelSnapshot | None:
    """Read the exact channel, retaining a caller-owned row lock when requested."""
    rows = Channel.objects.filter(id=channel_id, workspace_id=workspace_id)
    if for_update:
        rows = rows.select_for_update()
    row = rows.first()
    return None if row is None else _channel_snapshot(row)


def importable_channel_snapshots(*, workspace_id: UUID) -> tuple[ChannelSnapshot, ...]:
    return tuple(
        _channel_snapshot(row)
        for row in Channel.objects.filter(workspace_id=workspace_id, kind="text").exclude(
            lifecycle__in=("deletion_pending", "deleted")
        )
    )


def workspace_page_limit(*, workspace_id: UUID) -> int | None:
    return (
        WorkspaceQuota.objects.filter(workspace_id=workspace_id)
        .values_list("pages", flat=True)
        .first()
    )


def workspace_pages_used(*, workspace_id: UUID) -> int:
    with connection.cursor() as cursor:
        cursor.execute("SELECT workspace_quota_usage(%s)", [workspace_id])
        raw_usage = cursor.fetchone()[0]
    usage = json.loads(raw_usage) if isinstance(raw_usage, str) else raw_usage
    if isinstance(usage, dict) and type(usage.get("pages")) is int:
        return int(usage["pages"])
    return 0


def undeleted_text_channel_exists(*, workspace_id: UUID, channel_id: UUID) -> bool:
    """Whether an active or archived text channel exists in the workspace."""
    return (
        Channel.objects.filter(id=channel_id, workspace_id=workspace_id, kind="text")
        .exclude(lifecycle__in=("deletion_pending", "deleted"))
        .exists()
    )


def may_view_channel_for_reminder(
    *,
    channel_id: UUID,
    organisation_id: UUID,
    membership_id: UUID,
    authority_revision: int,
) -> bool | None:
    """Evaluate `may_view` for a channel without leaking `Channel` across app boundaries.

    Returns `None` if the channel or workspace policy cannot be resolved.
    """
    from .channel_access import may_view, resolve
    from .structure import WorkspaceUnavailableError

    try:
        access = resolve(channel_id)
    except (Channel.DoesNotExist, WorkspaceUnavailableError):
        return None
    return may_view(
        access,
        organisation_id=organisation_id,
        membership_id=membership_id,
        authority_revision=authority_revision,
    )


def resolve_partner_channel_for_room(*, workspace_id: UUID, room_id: str) -> UUID | None:
    """Resolve the workspace's active partner-bridged channel ID for `room_id`, if any."""
    if not room_id:
        return None
    agreement = PartnerChannelAgreement.objects.filter(
        matrix_room_id=room_id, state="active"
    ).first()
    if agreement is None:
        return None
    if Channel.objects.filter(id=agreement.channel_id, workspace_id=workspace_id).exists():
        return agreement.channel_id
    if Channel.objects.filter(id=agreement.partner_channel_id, workspace_id=workspace_id).exists():
        return agreement.partner_channel_id
    return None


def partner_channel_matrix_room_id(*, channel_id: UUID) -> str | None:
    """Return the active partner-agreement `matrix_room_id` for `channel_id`, if any."""
    agreement = PartnerChannelAgreement.objects.filter(
        Q(channel_id=channel_id) | Q(partner_channel_id=channel_id),
        state="active",
    ).first()
    return None if agreement is None else agreement.matrix_room_id


def has_foreign_partner_room_binding(*, channel_id: UUID, room_id: str) -> bool:
    """Return `True` if `room_id` is bound to a `PartnerChannelAgreement` not naming `channel_id`."""
    if not room_id:
        return False
    return (
        PartnerChannelAgreement.objects.filter(matrix_room_id=room_id)
        .exclude(Q(channel_id=channel_id) | Q(partner_channel_id=channel_id))
        .exists()
    )


def verify_channel_room_binding(
    *,
    workspace_id: UUID,
    channel_id: UUID,
    room_id: str,
    resolved_synapse_room_id: str | None = None,
) -> tuple[bool, str]:
    """Verify that `room_id` (if non-empty) matches the authoritative partner or Synapse room ID.

    Trusts strictly `partner_channel_matrix_room_id` or `resolved_synapse_room_id` — never an
    unverified caller `room_id` or a `!room-<channel_id>:*` regex fallback.
    """
    if not Channel.objects.filter(id=channel_id, workspace_id=workspace_id).exists():
        return False, ""

    partner_room = partner_channel_matrix_room_id(channel_id=channel_id)
    authoritative_room = partner_room or (resolved_synapse_room_id or None)
    if not room_id:
        return True, authoritative_room or ""

    if has_foreign_partner_room_binding(channel_id=channel_id, room_id=room_id):
        return False, ""

    if authoritative_room is not None and room_id == authoritative_room:
        return True, authoritative_room

    return False, ""


class MatrixTransportError(RuntimeError):
    """Raised when the Matrix homeserver refuses or fails a directory or replay call."""

    def __init__(self, code: str, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow HTTP redirects when carrying a homeserver bearer token."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


class SynapseRoomDirectoryClient:
    """Read-only Synapse room-alias resolver (`#kodera-ch-<channel_id>:<server>` -> `!opaque:domain`)."""

    def __init__(
        self,
        url: str,
        token: str,
        server_name: str = "",
        *,
        timeout: float = 10.0,
    ) -> None:
        self._url = url.rstrip("/")
        self._token = token
        self.server_name = server_name
        self._timeout = timeout
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    @staticmethod
    def _q(value: str) -> str:
        return urllib.parse.quote(value, safe="")

    def _call(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        ok: tuple[int, ...] = (200,),
    ) -> tuple[int, Any]:
        req = urllib.request.Request(  # noqa: S310 - operator-configured tenant homeserver
            self._url + path,
            data=None if body is None else json.dumps(body, separators=(",", ":")).encode(),
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
            },
            method=method,
        )
        try:
            with self._opener.open(req, timeout=self._timeout) as response:
                raw = response.read(65536)
                status = response.status
        except urllib.error.HTTPError as exc:
            exc.close()
            if exc.code in ok:
                return exc.code, {}
            retryable = exc.code in (429, 502, 503, 504)
            raise MatrixTransportError(f"matrix_http_{exc.code}", retryable=retryable) from None
        except (urllib.error.URLError, OSError, http.client.HTTPException):
            raise MatrixTransportError("matrix_unavailable", retryable=True) from None
        try:
            return status, json.loads(raw) if raw else {}
        except ValueError:
            raise MatrixTransportError("matrix_invalid_json", retryable=False) from None

    def resolve_channel_room(self, channel_id: UUID) -> str | None:
        if not self.server_name:
            return None
        alias = f"#kodera-ch-{channel_id}:{self.server_name}"
        status, answer = self._call(
            "GET",
            f"/_matrix/client/v3/directory/room/{self._q(alias)}",
            ok=(200, 404),
        )
        if status == 200 and isinstance(answer, dict) and isinstance(answer.get("room_id"), str):
            return answer["room_id"]
        return None


def configured_matrix_directory_client() -> Any | None:
    """Instantiate the configured Synapse room-directory client if available."""
    transport_factory = getattr(settings, "KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY", None)
    if callable(transport_factory):
        return transport_factory()
    if isinstance(transport_factory, str) and transport_factory:
        module_name, _, attribute = transport_factory.rpartition(".")
        if module_name and attribute:
            try:
                factory = getattr(importlib.import_module(module_name), attribute)
            except (ImportError, AttributeError):
                return None
            if callable(factory):
                return factory()
        return None
    synapse_url = getattr(settings, "KODERA_SYNAPSE_URL", None)
    synapse_token = getattr(settings, "KODERA_SYNAPSE_ADMIN_TOKEN", None)
    synapse_server = str(getattr(settings, "KODERA_SYNAPSE_SERVER_NAME", "") or "")
    if (
        isinstance(synapse_url, str)
        and synapse_url
        and isinstance(synapse_token, str)
        and synapse_token
    ):
        return SynapseRoomDirectoryClient(synapse_url, synapse_token, synapse_server)
    return None


def resolve_authoritative_channel_room(
    *,
    channel_id: UUID,
    matrix_client: Any | None = None,
) -> str | None:
    """Resolve `channel_id`'s authoritative Matrix room ID outside `transaction.atomic()`."""
    partner_room = partner_channel_matrix_room_id(channel_id=channel_id)
    if partner_room is not None:
        return partner_room
    client = matrix_client if matrix_client is not None else configured_matrix_directory_client()
    if client is None:
        return None
    resolve_fn = getattr(client, "resolve_channel_room", None)
    if not callable(resolve_fn):
        return None
    if connection.in_atomic_block:
        raise RuntimeError(
            "resolve_authoritative_channel_room must execute outside transaction.atomic()"
        )
    resolved = resolve_fn(channel_id)
    return resolved if isinstance(resolved, str) and resolved else None
