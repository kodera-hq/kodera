"""Current-authority, transactionally serialized opaque envelope relay operations."""

import base64
import binascii
import hashlib
import json
from collections.abc import Generator
from contextlib import closing
from datetime import timedelta
from typing import Any, cast
from uuid import UUID

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from django.conf import settings
from django.db import OperationalError, connection, transaction
from django.db.models import Q
from django.utils import timezone

from apps.audit.services import record_workspace_resource_event
from apps.identity.selectors import current_identity
from apps.orgs.actor_selectors import TenantCaller
from apps.workspaces.channel_access import Access, may_view, resolve
from apps.workspaces.channel_sets import lock_workspace
from apps.workspaces.moderation import (
    RefusalError as WorkspaceRefusal,
    authorise_workspace,
    member_restrictions,
)
from apps.workspaces.selectors import (
    active_text_channel_id,
    is_confidential_text_channel,
    is_designated_confidential_channel,
    restricted_workspace_membership_ids,
)
from core.api.pagination import MAX_PAGE_UTF8_BYTES, utf8_json_size
from services.identity.access_tokens import PROFILE, VerifiedAccessToken

from .models import Device, Envelope, KeyPackage, Participant, Room

NON_HUMAN_SUBJECT_PREFIXES = (
    "kodera-ai",
    "kodera_ai",
    "_kodera_ai",
    "@kodera-ai",
    "@kodera_ai",
    "@_kodera_ai",
    "service-account-",
    "ai-",
    "ai_",
    "bot-",
    "bot_",
    "agent-",
    "agent_",
    "_agent_",
    "livekit-agent",
)
NON_HUMAN_SUBJECT_SUFFIXES = ("-bot", "_bot", "-agent", "_agent")
NON_HUMAN_SUBJECT_NAMES = frozenset({"kodera-agent", "room-access", "kodera-ai", "kodera_ai"})
NON_HUMAN_AZP_PREFIXES = (
    "kodera-ai",
    "kodera_ai",
    "ai-",
    "ai_",
    "bot-",
    "bot_",
    "service-",
    "agent-",
    "agent_",
)
NON_HUMAN_EMAIL_PREFIXES = (
    "kodera-ai@",
    "kodera_ai@",
    "bot-",
    "bot_",
    "ai-",
    "ai_",
    "service-account-",
)


def is_ai_or_service_actor(verified: VerifiedAccessToken) -> bool:
    """Detect bot, service-account, or AI worker tokens so they never cross E2EE boundaries."""
    if verified.profile != PROFILE:
        return True
    subject = verified.subject.strip().lower()
    localpart = subject.partition(":")[0]
    bare_local = localpart.lstrip("@")
    if (
        not subject
        or subject in NON_HUMAN_SUBJECT_NAMES
        or localpart in NON_HUMAN_SUBJECT_NAMES
        or bare_local in NON_HUMAN_SUBJECT_NAMES
        or subject.startswith(NON_HUMAN_SUBJECT_PREFIXES)
        or localpart.startswith(NON_HUMAN_SUBJECT_PREFIXES)
        or bare_local.startswith(NON_HUMAN_SUBJECT_PREFIXES)
        or bare_local.endswith(NON_HUMAN_SUBJECT_SUFFIXES)
    ):
        return True
    configured_subjects = {
        str(entry).strip().lower()
        for entry in getattr(settings, "KODERA_AI_ACTOR_SUBJECTS", ())
        if str(entry).strip()
    }
    if subject in configured_subjects:
        return True
    azp = (verified.authorized_party or "").strip().lower()
    if azp and (azp.startswith(NON_HUMAN_AZP_PREFIXES) or azp.endswith(NON_HUMAN_SUBJECT_SUFFIXES)):
        return True
    email = (verified.email or "").strip().lower()
    if email and email.startswith(NON_HUMAN_EMAIL_PREFIXES):
        return True
    configured_clients = {
        str(entry).strip().lower()
        for entry in getattr(settings, "KODERA_AI_CLIENT_IDS", ())
        if str(entry).strip()
    }
    return bool(azp and azp in configured_clients)


def has_confidential_room(*, channel_id: UUID, organisation_id: UUID | None = None) -> bool:
    """Whether an E2EE confidential room row is bound to `channel_id`."""
    queryset = Room.objects.filter(channel_id=channel_id)
    if organisation_id is not None:
        queryset = queryset.filter(organisation_id=organisation_id)
    return queryset.exists()


# The wire uses JSON integers shared with browser clients; never admit a value
# that loses precision in their number representation.
MAX_EPOCH = 2**53 - 1
MAX_DEVICES = 16
MAX_PACKAGES = 16
MAX_PARTICIPANTS = 128
MAX_FENCED_ACCOUNTS = 2 * MAX_PARTICIPANTS + 3
MAX_ENVELOPES = 4096
# One bounded full-roster rotation remains possible when application capacity is exhausted.
MAX_RECOVERY_ENVELOPES = MAX_ENVELOPES + MAX_PARTICIPANTS + 1
MAX_PAGE_BYTES = MAX_PAGE_UTF8_BYTES
ADMINS = frozenset({"org_owner", "org_admin"})
REQUEST_FIELDS = {
    "publish-verification-bundle": (
        {
            "deviceId",
            "revision",
            "masterKey",
            "selfSigningKey",
            "crossSigningSignature",
            "deviceSignature",
            "signature",
        },
        set(),
    ),
    "register-device": ({"signingKey", "signature"}, set()),
    "publish-key-package": ({"deviceId", "keyPackage", "signature"}, set()),
    "create-room": ({"deviceId", "channelId", "algorithm", "signature"}, set()),
    "claim-key-package": ({"deviceId", "targetDeviceId", "epoch", "signature"}, set()),
    "send-application": ({"deviceId", "epoch", "ciphertext", "signature"}, set()),
    "commit-epoch": ({"deviceId", "epoch", "deviceIds", "ciphertext", "signature"}, {"welcome"}),
    "retire-room-device": ({"deviceId", "targetDeviceId", "epoch", "signature"}, set()),
    "revoke-device": ({"deviceId", "targetDeviceId", "signature"}, set()),
}


class RefusalError(ValueError):
    def __init__(self, status: int, kind: str | None = None) -> None:
        super().__init__("confidential transport refused")
        self.status = status
        self.kind = kind


def _uuid(value: Any) -> UUID:
    if not isinstance(value, str):
        raise RefusalError(422)
    try:
        result = UUID(value)
    except ValueError:
        raise RefusalError(422) from None
    if str(result) != value:
        raise RefusalError(422)
    return result


def _bytes(value: Any, minimum: int, maximum: int) -> bytes:
    if not isinstance(value, str) or not minimum <= len(value) <= 4 * ((maximum + 2) // 3):
        raise RefusalError(422)
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise RefusalError(422) from None
    if not minimum <= len(decoded) <= maximum or base64.b64encode(decoded).decode() != value:
        raise RefusalError(422)
    return decoded


def signed_statement(
    operation: str,
    organisation: UUID,
    membership: UUID,
    resource: UUID | None,
    body: dict[str, Any],
) -> bytes:
    """Canonical public protocol transcript; signatures and payloads are never logged."""
    unsigned = {key: value for key, value in body.items() if key != "signature"}
    return (
        b"kodera-e2ee-relay-v1\0"
        + json.dumps(
            [
                operation,
                str(organisation),
                str(membership),
                str(resource) if resource else None,
                unsigned,
            ],
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode()
    )


def _proof(
    public_key: bytes,
    operation: str,
    principal: TenantCaller,
    resource: UUID | None,
    body: dict[str, Any],
) -> bytes:
    required, optional = REQUEST_FIELDS[operation]
    if not required <= body.keys() or body.keys() - required - optional:
        raise RefusalError(422)
    signature = _bytes(body.get("signature"), 64, 64)
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(
            signature,
            signed_statement(
                operation, principal.organisation_id, principal.membership_id, resource, body
            ),
        )
    except (InvalidSignature, ValueError, TypeError):
        raise RefusalError(403) from None
    return signature


def _context(
    verified: VerifiedAccessToken,
    organisation: UUID,
    *,
    body: dict[str, Any] | None = None,
    room_id: UUID | None = None,
) -> tuple[UUID, TenantCaller]:
    if not connection.in_atomic_block:
        raise RuntimeError("confidential transport requires an operation transaction")
    with connection.cursor() as cursor:
        cursor.execute("SHOW transaction_isolation")
        if cursor.fetchone()[0] != "read committed":
            raise RefusalError(503, "service-unavailable")
    if is_ai_or_service_actor(verified):
        raise RefusalError(403, "forbidden")
    identity = current_identity(issuer=verified.issuer, subject=verified.subject)
    if identity is None:
        raise RefusalError(403, "identity-unknown")
    if identity[0].email.strip().lower().startswith(NON_HUMAN_EMAIL_PREFIXES) or identity[
        1
    ].email.strip().lower().startswith(NON_HUMAN_EMAIL_PREFIXES):
        raise RefusalError(403, "forbidden")
    identifiers = set()
    for field in ("deviceId", "targetDeviceId"):
        if body is not None and field in body:
            identifiers.add(_uuid(body[field]))
    if body is not None and "deviceIds" in body:
        values = body["deviceIds"]
        if not isinstance(values, list) or len(values) > MAX_PARTICIPANTS:
            raise RefusalError(422)
        identifiers.update(_uuid(value) for value in values)

    def users() -> set[UUID]:
        rows = Device.objects.filter(organisation_id=organisation).filter(
            Q(id__in=identifiers)
            | Q(participant__room_id=room_id, participant__left_epoch__isnull=True)
            if room_id is not None
            else Q(id__in=identifiers)
        )
        people = list(
            rows.values_list("membership__user_id", flat=True).distinct()[: MAX_FENCED_ACCOUNTS + 1]
        )
        if len(people) > MAX_FENCED_ACCOUNTS:
            raise RefusalError(503)
        return {identity[0].id, *people}

    fenced = users()
    # Privacy fences precede workspace/authority rows. A cutoff acquires its
    # exclusive advisory fence before it versions authority and emits room sets.
    # Reversing this order would deadlock a writer against an erasure cutoff.
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:'||%s::text,0))",
            [organisation],
        )
        if not cursor.fetchone()[0]:
            raise RefusalError(503)
        for person in sorted(fenced):
            cursor.execute(
                "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:'||%s::text,0))",
                [person],
            )
            if not cursor.fetchone()[0]:
                raise RefusalError(503)
    workspace = lock_workspace(organisation)
    if workspace is None:
        raise RefusalError(404)
    if not users() <= fenced:
        raise RefusalError(503, "service-unavailable")
    # Every identity/membership mutation versions its parent organisation. A SHARE
    # fence prevents it from committing between admission and this operation's commit.
    # No user/member row lock is taken after it: authority writers own those first.
    # Account cutoff owns organisation rows before it emits workspace changes.
    # An unrelated account's cutoff is not in the roster fences above. Never wait
    # on its organisation row while owning the workspace it will need next.
    try:
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                "SELECT id FROM orgs_organisation WHERE id=%s FOR SHARE NOWAIT", [organisation]
            )
            if cursor.fetchone() is None:
                raise RefusalError(404)
    except OperationalError as failure:
        if getattr(failure.__cause__, "sqlstate", None) == "55P03":
            raise RefusalError(503) from None
        raise
    try:
        principal = authorise_workspace(verified=verified, organisation_id=organisation)
    except WorkspaceRefusal as failure:
        raise RefusalError(failure.status, failure.kind) from None
    return workspace, principal


def _audit(principal: TenantCaller, action: str, target: UUID, request_id: str) -> None:
    record_workspace_resource_event(
        action="workspace.e2ee." + action,
        organisation_id=principal.organisation_id,
        target_id=target,
        actor_id=principal.identity_id,
        request_id=request_id,
    )


def _active_device(
    device: Device,
    workspace: UUID,
    access: Access | None = None,
    revision: int = 1,
    denied: set[UUID] | None = None,
) -> bool:
    member, identity = device.membership, device.identity
    if (
        device.revoked_at is not None
        or member.state != "active"
        or member.accepted_at is None
        or member.deleted_at is not None
        or not member.user.enabled
        or member.user.deleted_at is not None
        or not identity.enabled
        or identity.deleted_at is not None
        or identity.user_id != member.user_id
        or identity.organisation_id != device.organisation_id
        or device.organisation_id != member.organisation_id
        or member.role not in {"org_owner", "org_admin", "org_member", "org_billing"}
    ):
        return False
    banned = member_restrictions(workspace, member.id)[0] if denied is None else member.id in denied
    return not banned and (
        access is None
        or may_view(
            access,
            organisation_id=device.organisation_id,
            membership_id=member.id,
            authority_revision=revision,
        )
    )


def _denied(workspace: UUID, devices: list[Device]) -> set[UUID]:
    return restricted_workspace_membership_ids(
        workspace_id=workspace, membership_ids={device.membership_id for device in devices}
    )


def _device(identifier: Any, principal: TenantCaller, workspace: UUID) -> Device:
    row = (
        Device.objects.select_related("membership__user", "identity")
        .filter(
            id=_uuid(identifier),
            organisation_id=principal.organisation_id,
            membership_id=principal.membership_id,
            identity_id=principal.identity_id,
        )
        .first()
    )
    if row is None or not _active_device(row, workspace):
        raise RefusalError(404)
    return row


def _room(
    identifier: UUID,
    principal: TenantCaller,
    workspace: UUID,
    device: Device,
    *,
    allow_self_retire: bool = False,
) -> tuple[Room, Access, dict[UUID, Device]]:
    row = (
        Room.objects.select_for_update()
        .filter(
            id=identifier,
            organisation_id=principal.organisation_id,
            channel__workspace_id=workspace,
        )
        .first()
    )
    if row is None:
        raise RefusalError(404)
    access = resolve(row.channel_id)
    if access.lifecycle not in {"active", "archived"}:
        raise RefusalError(404)
    if not allow_self_retire and not is_designated_confidential_channel(
        workspace_id=workspace, channel_id=row.channel_id
    ):
        raise RefusalError(409)
    stored = list(
        Participant.objects.filter(room=row, left_epoch__isnull=True)
        .select_related("device__membership__user", "device__identity")
        .order_by("device_id")[: MAX_PARTICIPANTS + 1]
    )
    if len(stored) > MAX_PARTICIPANTS or device.id not in {part.device_id for part in stored}:
        raise RefusalError(404)
    denied = _denied(workspace, [part.device for part in stored])
    active = {
        part.device_id: part.device
        for part in stored
        if _active_device(part.device, workspace, access, principal.authority_revision, denied)
    }
    if device.id not in active:
        raise RefusalError(404)
    # A successful observation records the barrier durably. A later reactivation
    # cannot resume this epoch without a Commit. HTTP admission owns a separate
    # transaction before publication, so its barrier survives a refused effect.
    if len(active) != len(stored) and not row.rekey_required:
        row.rekey_required = True
        row.save(update_fields=["rekey_required", "updated_at"])
    return row, access, active


def _write_allowed(principal: TenantCaller, workspace: UUID, access: Access) -> None:
    _, muted = member_restrictions(workspace, principal.membership_id)
    if (
        access.lifecycle != "active"
        or muted
        or ("message.post" in access.denied and principal.role not in ADMINS)
    ):
        raise RefusalError(403)


def _discard_room_packages(room: Room) -> None:
    """Discard expired or superseded bytes without changing durable claim metadata."""
    now = timezone.now()
    KeyPackage.objects.filter(claimed_for=room, package__isnull=False).filter(
        Q(expires_at__lte=now) | Q(claimed_epoch__lt=room.epoch)
    ).update(package=None, discarded_at=now, updated_at=now)


@transaction.atomic
def authorize_request(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    operation: str,
    body: dict[str, Any],
    room_id: UUID | None = None,
) -> None:
    """Fence current authority before replay metadata or an opaque response is returned.

    Epoch freshness and package availability belong to a new effect. A successful
    replay may follow a later commit, but never a caller's revocation or loss of access.
    """
    workspace, principal = _context(verified, organisation_id, body=body, room_id=room_id)
    if operation == "register-device":
        public_key = _bytes(body.get("signingKey"), 32, 32)
        _proof(public_key, operation, principal, None, body)
        existing = Device.objects.filter(
            organisation_id=organisation_id, signing_key=public_key
        ).first()
        if existing is not None and (
            existing.revoked_at is not None
            or existing.membership_id != principal.membership_id
            or existing.identity_id != principal.identity_id
        ):
            raise RefusalError(409)
        return
    device = _device(body.get("deviceId"), principal, workspace)
    _proof(bytes(device.signing_key), operation, principal, room_id, body)
    if operation == "revoke-device":
        if not Device.objects.filter(
            id=_uuid(body.get("targetDeviceId")),
            organisation_id=organisation_id,
            membership_id=principal.membership_id,
            identity_id=principal.identity_id,
        ).exists():
            raise RefusalError(404)
    elif operation == "create-room":
        channel_id = active_text_channel_id(
            channel_id=_uuid(body.get("channelId")), workspace_id=workspace
        )
        if channel_id is None or principal.role not in ADMINS:
            raise RefusalError(404)
        access = resolve(channel_id)
        if not _active_device(device, workspace, access, principal.authority_revision):
            raise RefusalError(404)
        _write_allowed(principal, workspace, access)
        if not is_confidential_text_channel(workspace_id=workspace, channel_id=channel_id):
            raise RefusalError(409)
    elif room_id is not None:
        self_retire = operation == "retire-room-device" and body.get("targetDeviceId") == body.get(
            "deviceId"
        )
        room, access, _ = _room(
            room_id, principal, workspace, device, allow_self_retire=self_retire
        )
        # Leaving with the current device does not publish content.
        if not self_retire:
            _write_allowed(principal, workspace, access)
        if operation == "claim-key-package":
            if principal.role not in ADMINS:
                raise RefusalError(403)
            target = (
                Device.objects.select_related("membership__user", "identity")
                .filter(id=_uuid(body.get("targetDeviceId")), organisation_id=organisation_id)
                .first()
            )
            if target is None or not _active_device(
                target, workspace, access, principal.authority_revision
            ):
                raise RefusalError(404)
        _discard_room_packages(room)


@transaction.atomic
def revoke_device(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any], request_id: str
) -> dict[str, Any]:
    workspace, principal = _context(verified, organisation_id, body=body)
    device = _device(body.get("deviceId"), principal, workspace)
    _proof(bytes(device.signing_key), "revoke-device", principal, None, body)
    target = Device.objects.filter(
        id=_uuid(body.get("targetDeviceId")),
        organisation_id=organisation_id,
        membership_id=principal.membership_id,
        identity_id=principal.identity_id,
    ).first()
    if target is None:
        raise RefusalError(404)
    now = timezone.now()
    if target.revoked_at is None:
        target.revoked_at = now
        target.save(update_fields=["revoked_at", "updated_at"])
        # Monotonic payload removal never revives a claimant, including one whose
        # account cutoff is held. The database preserves all claim/binding fields.
        KeyPackage.objects.filter(device=target, package__isnull=False).update(
            package=None, discarded_at=now, updated_at=now
        )
        _audit(principal, "device_revoked", target.id, request_id)
    return {"deviceId": str(target.id), "revoked": True}


@transaction.atomic
def register_device(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any], request_id: str
) -> dict[str, Any]:
    workspace, principal = _context(verified, organisation_id, body=body)
    public_key = _bytes(body.get("signingKey"), 32, 32)
    _proof(public_key, "register-device", principal, None, body)
    existing = Device.objects.filter(
        organisation_id=organisation_id, signing_key=public_key
    ).first()
    if existing is not None:
        if (
            existing.membership_id != principal.membership_id
            or existing.identity_id != principal.identity_id
            or existing.revoked_at is not None
        ):
            raise RefusalError(409)
        return {"deviceId": str(existing.id), "signingKey": body["signingKey"]}
    if (
        Device.objects.filter(
            membership_id=principal.membership_id, revoked_at__isnull=True
        ).count()
        >= MAX_DEVICES
    ):
        raise RefusalError(409)
    row = Device.objects.create(
        organisation_id=organisation_id,
        membership_id=principal.membership_id,
        identity_id=principal.identity_id,
        signing_key=public_key,
    )
    _audit(principal, "device_registered", row.id, request_id)
    return {"deviceId": str(row.id), "signingKey": body["signingKey"]}


@transaction.atomic
def publish_package(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any], request_id: str
) -> dict[str, Any]:
    workspace, principal = _context(verified, organisation_id, body=body)
    device = _device(body.get("deviceId"), principal, workspace)
    _proof(bytes(device.signing_key), "publish-key-package", principal, None, body)
    package = _bytes(body.get("keyPackage"), 1, 16384)
    now = timezone.now()
    reference = hashlib.sha256(package).digest()
    KeyPackage.objects.filter(device=device, expires_at__lte=now, package__isnull=False).update(
        package=None, discarded_at=now, updated_at=now
    )
    if KeyPackage.objects.filter(device=device, reference=reference).exists():
        raise RefusalError(409)
    if (
        KeyPackage.objects.filter(
            device=device, claimed_at__isnull=True, expires_at__gt=now, package__isnull=False
        ).count()
        >= MAX_PACKAGES
    ):
        raise RefusalError(409)
    row = KeyPackage.objects.create(
        organisation_id=organisation_id,
        device=device,
        reference=reference,
        package=package,
        expires_at=now + timedelta(days=7),
    )
    _audit(principal, "package_published", row.id, request_id)
    return {
        "keyPackageId": str(row.id),
        "reference": base64.b64encode(reference).decode(),
        "expiresAt": row.expires_at.isoformat(),
    }


@transaction.atomic
def create_room(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any], request_id: str
) -> dict[str, Any]:
    workspace, principal = _context(verified, organisation_id, body=body)
    device = _device(body.get("deviceId"), principal, workspace)
    _proof(bytes(device.signing_key), "create-room", principal, None, body)
    channel_id = active_text_channel_id(
        channel_id=_uuid(body.get("channelId")), workspace_id=workspace
    )
    if channel_id is None or principal.role not in ADMINS:
        raise RefusalError(404)
    access = resolve(channel_id)
    if not _active_device(device, workspace, access, principal.authority_revision):
        raise RefusalError(404)
    _write_allowed(principal, workspace, access)
    if not is_confidential_text_channel(workspace_id=workspace, channel_id=channel_id):
        raise RefusalError(409)
    if body.get("algorithm") not in ("io.kodera.mls.v1", "m.megolm.v1.aes-sha2"):
        raise RefusalError(422)
    if Room.objects.filter(channel_id=channel_id).exists():
        raise RefusalError(409)
    row = Room.objects.create(
        organisation_id=organisation_id, channel_id=channel_id, algorithm=body["algorithm"]
    )
    Participant.objects.create(
        organisation_id=organisation_id, room=row, device=device, joined_epoch=0
    )
    if row.algorithm == "io.kodera.mls.v1":
        from apps.confidential.services import accept_epoch

        accept_epoch(room_id=row.id, epoch=0, sequence=0, commit=b"", device_ids=[str(device.id)])
    _audit(principal, "room_created", row.id, request_id)
    return {
        "roomId": str(row.id),
        "algorithm": row.algorithm,
        "epoch": 0,
        "deviceIds": [str(device.id)],
    }


@transaction.atomic
def claim_package(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    room_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    workspace, principal = _context(verified, organisation_id, body=body, room_id=room_id)
    device = _device(body.get("deviceId"), principal, workspace)
    _proof(bytes(device.signing_key), "claim-key-package", principal, room_id, body)
    room, access, _ = _room(room_id, principal, workspace, device)
    _write_allowed(principal, workspace, access)
    _epoch(body.get("epoch"), room.epoch)
    if principal.role not in ADMINS:
        raise RefusalError(403)
    target = (
        Device.objects.select_related("membership__user", "identity")
        .filter(id=_uuid(body.get("targetDeviceId")), organisation_id=organisation_id)
        .first()
    )
    if target is None or not _active_device(
        target, workspace, access, principal.authority_revision
    ):
        raise RefusalError(404)
    if KeyPackage.objects.filter(
        device=target, claimed_for=room, claimed_epoch=room.epoch, claimed_at__isnull=False
    ).exists():
        raise RefusalError(409)
    now = timezone.now()
    KeyPackage.objects.filter(device=target, expires_at__lte=now, package__isnull=False).update(
        package=None, discarded_at=now, updated_at=now
    )
    row = (
        KeyPackage.objects.select_for_update()
        .filter(
            device=target,
            claimed_at__isnull=True,
            expires_at__gt=timezone.now(),
            package__isnull=False,
        )
        .order_by("created_at", "id")
        .first()
    )
    if row is None:
        raise RefusalError(404)
    package = row.package
    if package is None:
        raise RefusalError(404)
    row.claimed_at, row.claimed_for, row.claimed_by, row.claimed_epoch = (
        timezone.now(),
        room,
        device,
        room.epoch,
    )
    row.save(
        update_fields=["claimed_at", "claimed_for", "claimed_by", "claimed_epoch", "updated_at"]
    )
    _audit(principal, "package_claimed", row.id, request_id)
    return {
        "keyPackageId": str(row.id),
        "deviceId": str(target.id),
        "signingKey": base64.b64encode(bytes(target.signing_key)).decode(),
        "keyPackage": base64.b64encode(bytes(package)).decode(),
        "epoch": room.epoch,
    }


def _epoch(value: Any, expected: int) -> None:
    if type(value) is not int or not 0 <= value <= MAX_EPOCH:
        raise RefusalError(422)
    if value != expected:
        raise RefusalError(409)


def _append(
    room: Room,
    sender: Device,
    kind: str,
    ciphertext: bytes,
    signature: bytes,
    recipient: Device | None = None,
) -> Envelope:
    if Envelope.objects.filter(
        room=room, sender=sender, kind=kind, signature=signature, recipient=recipient
    ).exists():
        raise RefusalError(409)
    limit = MAX_RECOVERY_ENVELOPES if kind in {"commit", "welcome"} else MAX_ENVELOPES
    if Envelope.objects.filter(room=room).count() >= limit or room.head_sequence >= MAX_EPOCH:
        raise RefusalError(409)
    room.head_sequence += 1
    return Envelope.objects.create(
        organisation_id=room.organisation_id,
        room=room,
        sender=sender,
        recipient=recipient,
        sequence=room.head_sequence,
        epoch=room.epoch,
        kind=kind,
        ciphertext=ciphertext,
        signature=signature,
    )


@transaction.atomic
def send_application(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    room_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    workspace, principal = _context(verified, organisation_id, body=body, room_id=room_id)
    device = _device(body.get("deviceId"), principal, workspace)
    signature = _proof(bytes(device.signing_key), "send-application", principal, room_id, body)
    room, access, _ = _room(room_id, principal, workspace, device)
    _write_allowed(principal, workspace, access)
    _epoch(body.get("epoch"), room.epoch)
    if room.rekey_required:
        raise RefusalError(409)
    row = _append(room, device, "application", _bytes(body.get("ciphertext"), 16, 81920), signature)
    room.save(update_fields=["head_sequence", "updated_at"])
    _audit(principal, "application_relayed", row.id, request_id)
    return {"envelopeId": str(row.id), "sequence": row.sequence, "epoch": room.epoch}


@transaction.atomic
def commit_epoch(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    room_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    workspace, principal = _context(verified, organisation_id, body=body, room_id=room_id)
    device = _device(body.get("deviceId"), principal, workspace)
    signature = _proof(bytes(device.signing_key), "commit-epoch", principal, room_id, body)
    room, access, active = _room(room_id, principal, workspace, device)
    _write_allowed(principal, workspace, access)
    _epoch(body.get("epoch"), room.epoch)
    if room.epoch >= MAX_EPOCH:
        raise RefusalError(409)
    roster = body.get("deviceIds")
    if not isinstance(roster, list) or not 1 <= len(roster) <= MAX_PARTICIPANTS:
        raise RefusalError(422)
    ids = {_uuid(item) for item in roster}
    if len(ids) != len(roster) or device.id not in ids:
        raise RefusalError(422)
    desired = {
        row.id: row
        for row in Device.objects.filter(
            id__in=ids, organisation_id=organisation_id
        ).select_related("membership__user", "identity")
    }
    denied = _denied(workspace, list(desired.values()))
    if set(desired) != ids or any(
        not _active_device(row, workspace, access, principal.authority_revision, denied)
        for row in desired.values()
    ):
        raise RefusalError(404)
    if ids != set(active) and principal.role not in ADMINS:
        raise RefusalError(403)
    added = ids - set(active)
    for identifier in added:
        if not KeyPackage.objects.filter(
            device_id=identifier,
            claimed_for=room,
            claimed_by=device,
            claimed_epoch=room.epoch,
            package__isnull=False,
            expires_at__gt=timezone.now(),
        ).exists():
            raise RefusalError(409)
    welcome = _bytes(body.get("welcome"), 16, 262144) if added else None
    if not added and body.get("welcome") is not None:
        raise RefusalError(422)
    commit = _bytes(body.get("ciphertext"), 16, 262144)
    room.epoch += 1
    # Rows are retained for admission history; rejoining starts a fresh visibility epoch.
    Participant.objects.filter(room=room, left_epoch__isnull=True).exclude(
        device_id__in=ids
    ).update(left_epoch=room.epoch)
    for identifier in sorted(added):
        participant = Participant.objects.filter(room=room, device_id=identifier).first()
        if participant is None:
            Participant.objects.create(
                organisation_id=organisation_id,
                room=room,
                device_id=identifier,
                joined_epoch=room.epoch,
            )
        else:
            # Rejoining refreshes visibility without rewriting an immutable scope
            # binding or requiring UPDATE privilege on organisation/device IDs.
            participant.joined_epoch, participant.left_epoch = room.epoch, None
            participant.save(update_fields=["joined_epoch", "left_epoch", "updated_at"])
    row = _append(room, device, "commit", commit, signature)
    if welcome is not None:
        for identifier in sorted(added):
            _append(room, device, "welcome", welcome, signature, desired[identifier])
    room.rekey_required = False
    _discard_room_packages(room)
    room.save(update_fields=["epoch", "head_sequence", "rekey_required", "updated_at"])
    if room.algorithm == "io.kodera.mls.v1":
        from apps.confidential.services import accept_epoch

        accept_epoch(
            room_id=room.id,
            epoch=room.epoch,
            sequence=row.sequence,
            commit=commit,
            device_ids=sorted(str(value) for value in ids),
        )
    _audit(principal, "epoch_committed", row.id, request_id)
    return {
        "epoch": room.epoch,
        "commitEnvelopeId": str(row.id),
        "commitSequence": row.sequence,
        "headSequence": room.head_sequence,
        "deviceIds": sorted(str(value) for value in ids),
    }


@transaction.atomic
def retire_device(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    room_id: UUID,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    workspace, principal = _context(verified, organisation_id, body=body, room_id=room_id)
    device = _device(body.get("deviceId"), principal, workspace)
    _proof(bytes(device.signing_key), "retire-room-device", principal, room_id, body)
    target = _uuid(body.get("targetDeviceId"))
    room, _, active = _room(
        room_id, principal, workspace, device, allow_self_retire=(target == device.id)
    )
    _epoch(body.get("epoch"), room.epoch)
    if target not in active or (target != device.id and principal.role not in ADMINS):
        raise RefusalError(404)
    if room.epoch >= MAX_EPOCH:
        raise RefusalError(409)
    Participant.objects.filter(room=room, device_id=target, left_epoch__isnull=True).update(
        left_epoch=room.epoch + 1
    )
    room.rekey_required = True
    room.save(update_fields=["rekey_required", "updated_at"])
    _audit(principal, "device_retired", target, request_id)
    return {"epoch": room.epoch, "rekeyRequired": True}


@transaction.atomic
def read_envelopes(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    room_id: UUID,
    device_id: str,
    after: int = 0,
) -> dict[str, Any]:
    workspace, principal = _context(
        verified, organisation_id, body={"deviceId": device_id}, room_id=room_id
    )
    device = _device(device_id, principal, workspace)
    room, access, active = _room(room_id, principal, workspace, device)
    if type(after) is not int or not 0 <= after <= MAX_EPOCH:
        raise RefusalError(422)
    if "channel.history" in access.denied:
        raise RefusalError(403)
    joined = Participant.objects.get(room=room, device=device).joined_epoch
    pending = (
        Envelope.objects.filter(room=room, epoch__gte=joined, sequence__gt=after)
        .filter(
            Q(kind="application")
            | Q(kind="commit", epoch__gt=joined)
            | Q(kind="welcome", recipient=device)
        )
        .order_by("sequence")[:101]
    )
    devices = [
        {
            "deviceId": str(identifier),
            "signingKey": base64.b64encode(bytes(value.signing_key)).decode(),
        }
        for identifier, value in sorted(active.items())
    ]
    envelope_budget = max(1, MAX_PAGE_BYTES - utf8_json_size(devices))
    rows: list[Envelope] = []
    envelopes: list[dict[str, Any]] = []
    total = 0
    more = False
    # Django's concrete QuerySet.iterator returns its _iterator generator; the
    # stubs expose only Iterator, omitting the close used for early page limits.
    with closing(cast(Generator[Envelope, None, None], pending.iterator(chunk_size=1))) as iterator:
        for row in iterator:
            item = {
                "id": str(row.id),
                "kind": row.kind,
                "epoch": row.epoch,
                "sequence": row.sequence,
                "senderDeviceId": str(row.sender_id),
                "ciphertext": base64.b64encode(bytes(row.ciphertext)).decode(),
            }
            item_bytes = utf8_json_size(item) + (2 if envelopes else 0)
            if len(rows) >= 100 or (rows and total + item_bytes > envelope_budget):
                more = True
                break
            rows.append(row)
            envelopes.append(item)
            total += item_bytes
    return {
        "roomId": str(room.id),
        "algorithm": room.algorithm,
        "epoch": room.epoch,
        "rekeyRequired": room.rekey_required,
        "hasMore": more,
        "nextAfter": rows[-1].sequence if rows else after,
        "devices": devices,
        "envelopes": envelopes,
    }


@transaction.atomic
def directory_context(
    *, verified: VerifiedAccessToken, organisation_id: UUID, room_id: UUID, device_id: str
) -> dict[str, Any]:
    """Resolve a known channel or room UUID under current participating-device authority."""
    room_id = (
        Room.objects.filter(organisation_id=organisation_id)
        .filter(Q(id=room_id) | Q(channel_id=room_id))
        .values_list("id", flat=True)
        .first()
    ) or room_id
    workspace, principal = _context(verified, organisation_id, room_id=room_id)
    device = _device(device_id, principal, workspace)
    room, _, active = _room(room_id, principal, workspace, device)
    return {
        "roomId": str(room.id),
        "channelId": str(room.channel_id),
        "epoch": room.epoch,
        "algorithm": room.algorithm,
        "rekeyRequired": room.rekey_required,
        "deviceIds": sorted(str(identifier) for identifier in active),
        "signingKeys": {
            str(key): base64.b64encode(bytes(row.signing_key)).decode()
            for key, row in active.items()
        },
    }


@transaction.atomic
def verification_context(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any]
) -> dict[str, Any]:
    """A bundle must be proven by the currently registered device, not a supplied public key."""
    workspace, principal = _context(verified, organisation_id, body=body)
    device = _device(body.get("deviceId"), principal, workspace)
    _proof(bytes(device.signing_key), "publish-verification-bundle", principal, None, body)
    return {
        "deviceId": str(device.id),
        "membershipId": str(principal.membership_id),
        "identityId": str(principal.identity_id),
        "signingKey": base64.b64encode(bytes(device.signing_key)).decode(),
    }


@transaction.atomic
def admit_directory(*, verified: VerifiedAccessToken, organisation_id: UUID) -> None:
    _context(verified, organisation_id)


def purge_account_e2ee_in_account_context(*, user_id: UUID) -> None:
    """Invoke `public.e2ee_purge_account` inside active `account` retention worker context."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regprocedure('public.e2ee_purge_account(uuid)') IS NOT NULL")
        if cursor.fetchone()[0]:
            cursor.execute("SELECT public.e2ee_purge_account(%s)", [user_id])


def count_residual_e2ee_for_organisation(*, organisation_id: UUID) -> int:
    """Count remaining confidential relay resources belonging to an erased organisation."""
    return int(
        Envelope.objects.filter(organisation_id=organisation_id).count()
        + KeyPackage.objects.filter(organisation_id=organisation_id).count()
        + Participant.objects.filter(organisation_id=organisation_id).count()
        + Room.objects.filter(organisation_id=organisation_id).count()
        + Device.objects.filter(organisation_id=organisation_id).count()
    )


def count_residual_e2ee_for_user(*, user_id: UUID) -> int:
    """Count unrevoked confidential devices or undiscarded key packages for an erased person."""
    return int(
        Device.objects.filter(membership__user_id=user_id, revoked_at__isnull=True).count()
        + KeyPackage.objects.filter(
            device__membership__user_id=user_id, package__isnull=False
        ).count()
    )
