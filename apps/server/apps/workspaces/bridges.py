"""Serialized bilateral agreements and identity-bound single-channel guest authority."""

import re
from datetime import timedelta
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.audit.services import record_workspace_resource_event
from apps.identity.selectors import current_identity, current_identity_by_id
from apps.orgs.selectors import active_organisation, has_privacy_cutoff, person_has_membership
from services.identity.access_tokens import VerifiedAccessToken

from .models import (
    Channel,
    PartnerChannelAgreement,
    PartnerChannelAgreementRevision,
    SessionEviction,
    SingleChannelGuestGrant,
)
from .moderation import RefusalError as RefusalError, authorise_workspace

ROOM = re.compile(r"![A-Za-z0-9_.=-]{1,128}:[a-z0-9.-]{1,253}\Z")
USER = re.compile(r"@[!-9;-~]{1,255}:[a-z0-9.-]{1,253}\Z")
SERVER = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")
HISTORY_NOTICE = (
    "Matrix history already replicated to the partner homeserver cannot be remotely erased."
)


def _enabled() -> None:
    if getattr(settings, "KODERA_CHANNEL_GOVERNANCE_ENABLED", False) is not True:
        raise RefusalError(503, "service-unavailable")


def _uuid(value: Any) -> UUID:
    try:
        return UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        raise RefusalError(422) from None


def _channel(identifier: Any, organisation: UUID) -> Channel:
    row = Channel.objects.filter(
        id=_uuid(identifier), workspace__organisation_id=organisation, lifecycle="active"
    ).first()
    if row is None:
        raise RefusalError(404)
    return row


def _audit(caller: Any, action: str, target: UUID, request_id: str) -> None:
    record_workspace_resource_event(
        action="workspace." + action,
        organisation_id=caller.organisation_id,
        actor_id=caller.identity_id,
        target_id=target,
        request_id=request_id,
    )


def _agreement(row: PartnerChannelAgreement) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "organisationId": str(row.organisation_id),
        "partnerOrganisationId": str(row.partner_organisation_id),
        "channelId": str(row.channel_id),
        "partnerChannelId": str(row.partner_channel_id),
        "matrixRoomId": row.matrix_room_id,
        "localHomeserver": row.local_homeserver,
        "partnerHomeserver": row.partner_homeserver,
        "federationMode": "partner",
        "state": row.state,
        "revision": row.revision,
        "replicatedHistoryErasable": False,
        "historyNotice": HISTORY_NOTICE,
    }


def _guest(row: SingleChannelGuestGrant) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "guestIdentityId": str(row.guest_identity_id),
        "channelId": str(row.single_channel_id),
        "matrixUserId": row.matrix_user_id,
        "matrixRoomId": row.matrix_room_id,
        "role": row.role,
        "expiresAt": row.expires_at.isoformat(),
        "allowCalls": row.allow_calls,
        "revokedAt": row.revoked_at.isoformat() if row.revoked_at else None,
    }


@transaction.atomic
def overview(*, verified: VerifiedAccessToken, organisation_id: UUID) -> dict[str, Any]:
    authorise_workspace(verified=verified, organisation_id=organisation_id, admin=True)
    agreements = PartnerChannelAgreement.objects.filter(
        Q(organisation_id=organisation_id) | Q(partner_organisation_id=organisation_id)
    ).order_by("id")
    guests = SingleChannelGuestGrant.objects.filter(organisation_id=organisation_id).order_by("id")
    return {
        "enforcementReady": getattr(settings, "KODERA_CHANNEL_GOVERNANCE_ENABLED", False) is True,
        "agreements": [_agreement(row) for row in agreements[:200]],
        "guests": [_guest(row) for row in guests[:200]],
    }


@transaction.atomic
def propose(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any], request_id: str
) -> dict[str, Any]:
    caller = authorise_workspace(verified=verified, organisation_id=organisation_id, admin=True)
    _enabled()
    peer = _uuid(body.get("partnerOrganisationId"))
    if (
        peer == organisation_id
        or not active_organisation(organisation_id=peer)
        or has_privacy_cutoff(organisation_id=peer)
        or has_privacy_cutoff(organisation_id=organisation_id)
    ):
        raise RefusalError(422)
    # Global channel ordering serializes proposals in either direction without lock inversion.
    ids = sorted([_uuid(body.get("channelId")), _uuid(body.get("partnerChannelId"))])
    list(Channel.objects.select_for_update().filter(id__in=ids).order_by("id"))
    channel = _channel(body.get("channelId"), organisation_id)
    partner_channel = _channel(body.get("partnerChannelId"), peer)
    local, remote, room = (
        body.get(key) for key in ("localHomeserver", "partnerHomeserver", "matrixRoomId")
    )
    if (
        not isinstance(local, str)
        or SERVER.fullmatch(local) is None
        or not isinstance(remote, str)
        or SERVER.fullmatch(remote) is None
        or local == remote
        or not isinstance(room, str)
        or ROOM.fullmatch(room) is None
        or room.partition(":")[2] not in {local, remote}
        or body.get("historyDisclosureAccepted") is not True
    ):
        raise RefusalError(422)
    if PartnerChannelAgreement.objects.filter(
        Q(channel_id__in=ids) | Q(partner_channel_id__in=ids) | Q(matrix_room_id=room)
    ).exists():
        raise RefusalError(409)
    row = PartnerChannelAgreement.objects.create(
        organisation_id=organisation_id,
        partner_organisation_id=peer,
        channel=channel,
        partner_channel=partner_channel,
        matrix_room_id=room,
        local_homeserver=local,
        partner_homeserver=remote,
    )
    _revision(row, organisation_id)
    _audit(caller, "partner.proposed", row.id, request_id)
    return _agreement(row)


def _revision(row: PartnerChannelAgreement, organisation: UUID) -> None:
    PartnerChannelAgreementRevision.objects.create(
        agreement=row,
        revision=row.revision,
        state=row.state,
        acting_organisation_id=organisation,
    )


@transaction.atomic
def transition(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    agreement_id: Any,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    caller = authorise_workspace(verified=verified, organisation_id=organisation_id, admin=True)
    row = (
        PartnerChannelAgreement.objects.select_for_update()
        .filter(
            Q(organisation_id=organisation_id) | Q(partner_organisation_id=organisation_id),
            id=_uuid(agreement_id),
        )
        .first()
    )
    if row is None:
        raise RefusalError(404)
    if type(body.get("revision")) is not int or body["revision"] != row.revision:
        raise RefusalError(409)
    action = body.get("action")
    if action in {"activate", "repropose"}:
        _enabled()
    if row.state == "revoked" or action not in {"activate", "suspend", "revoke", "repropose"}:
        raise RefusalError(409)
    if action == "activate" and (
        row.state != "proposed" or organisation_id != row.partner_organisation_id
    ):
        raise RefusalError(403)
    if action == "repropose" and (
        row.state != "suspended" or organisation_id != row.organisation_id
    ):
        raise RefusalError(403)
    if action == "suspend" and row.state != "active":
        raise RefusalError(409)
    row.state = {
        "activate": "active",
        "suspend": "suspended",
        "revoke": "revoked",
        "repropose": "proposed",
    }[action]
    row.revision += 1
    row.save(update_fields=["state", "revision", "updated_at"])
    _revision(row, organisation_id)
    if action in {"suspend", "revoke"}:
        for org, channel in (
            (row.organisation_id, row.channel_id),
            (row.partner_organisation_id, row.partner_channel_id),
        ):
            SessionEviction.objects.create(
                organisation_id=org, channel_id=channel, agreement=row, revision=row.revision
            )
    _audit(caller, "partner." + row.state, row.id, request_id)
    return _agreement(row)


@transaction.atomic
def grant_guest(
    *, verified: VerifiedAccessToken, organisation_id: UUID, body: dict[str, Any], request_id: str
) -> dict[str, Any]:
    caller = authorise_workspace(verified=verified, organisation_id=organisation_id, admin=True)
    _enabled()
    channel = _channel(body.get("channelId"), organisation_id)
    identity = current_identity_by_id(identity_id=_uuid(body.get("guestIdentityId")))
    if (
        identity is None
        or person_has_membership(user_id=identity[0].id)
        or has_privacy_cutoff(organisation_id=organisation_id, user_id=identity[0].id)
    ):
        raise RefusalError(422)
    user, room = body.get("matrixUserId"), body.get("matrixRoomId")
    try:
        expires = parse_datetime(body.get("expiresAt", ""))
    except (TypeError, ValueError):
        expires = None
    if (
        not isinstance(user, str)
        or USER.fullmatch(user) is None
        or not isinstance(room, str)
        or ROOM.fullmatch(room) is None
        or expires is None
        or timezone.is_naive(expires)
        or not timezone.now() < expires <= timezone.now() + timedelta(days=30)
        or type(body.get("allowCalls", False)) is not bool
        or (body.get("allowCalls") is True and channel.kind != "audio")
    ):
        raise RefusalError(422)
    # Lock the identity through its owning selector so concurrent grants cannot race.
    from apps.identity.selectors import lock_guest_identity

    lock_guest_identity(identity_id=identity[1].id)
    if SingleChannelGuestGrant.objects.filter(
        Q(guest_identity_id=identity[1].id) | Q(matrix_user_id=user)
    ).exists():
        raise RefusalError(409)
    row = SingleChannelGuestGrant.objects.create(
        organisation_id=organisation_id,
        guest_identity_id=identity[1].id,
        single_channel=channel,
        matrix_user_id=user,
        matrix_room_id=room,
        expires_at=expires,
        allow_calls=body.get("allowCalls", False),
    )
    _emit_guests(organisation_id, channel.workspace_id)
    _audit(caller, "guest.granted", row.id, request_id)
    return _guest(row)


@transaction.atomic
def revoke_guest(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    grant_id: Any,
    request_id: str,
    **_: Any,
) -> dict[str, Any]:
    caller = authorise_workspace(verified=verified, organisation_id=organisation_id, admin=True)
    row = (
        SingleChannelGuestGrant.objects.select_for_update()
        .filter(id=_uuid(grant_id), organisation_id=organisation_id)
        .first()
    )
    if row is None:
        raise RefusalError(404)
    if row.revoked_at is None:
        row.revoked_at = timezone.now()
        row.save(update_fields=["revoked_at", "updated_at"])
        SessionEviction.objects.create(
            organisation_id=organisation_id,
            channel_id=row.single_channel_id,
            guest_grant=row,
            revision=1,
        )
        _emit_guests(organisation_id, row.single_channel.workspace_id)
        _audit(caller, "guest.revoked", row.id, request_id)
    return _guest(row)


def is_guest_identity(*, identity_id: UUID) -> bool:
    # Expired and revoked grants remain restrictive; a normal membership is never inferred.
    return SingleChannelGuestGrant.objects.filter(guest_identity_id=identity_id).exists()


def matrix_authority(
    *, organisation_id: UUID, room_id: str, user_id: str, action: str
) -> dict[str, Any]:
    """Live authority, never inferred from a client's policy or stale Matrix membership."""
    denied = {"allowed": False, "role": "none", "revision": 0}
    if action not in {"join", "event", "invite", "create", "call", "directory", "session"}:
        return denied
    guest = SingleChannelGuestGrant.objects.filter(matrix_user_id=user_id).first()
    # Session probes have no room in the request; their authority is still bounded by
    # the grant's room and its bilateral agreement, including after invalidation.
    authority_room = guest.matrix_room_id if guest is not None and action == "session" else room_id
    agreements = Q(matrix_room_id=authority_room)
    if guest is not None:
        # A grant cannot rename a bridged channel's room to evade its agreement.
        agreements |= Q(channel_id=guest.single_channel_id) | Q(
            partner_channel_id=guest.single_channel_id
        )
    agreement = PartnerChannelAgreement.objects.filter(agreements).first()
    server = user_id.partition(":")[2]
    partner_allowed = agreement is None or (
        getattr(settings, "KODERA_CHANNEL_GOVERNANCE_ENABLED", False) is True
        and agreement.matrix_room_id == authority_room
        and organisation_id in {agreement.organisation_id, agreement.partner_organisation_id}
        and server in {agreement.local_homeserver, agreement.partner_homeserver}
        and agreement.state == "active"
        and not has_privacy_cutoff(organisation_id=agreement.organisation_id)
        and not has_privacy_cutoff(organisation_id=agreement.partner_organisation_id)
        and active_organisation(organisation_id=agreement.organisation_id)
        and active_organisation(organisation_id=agreement.partner_organisation_id)
        and Channel.objects.filter(
            id__in=[agreement.channel_id, agreement.partner_channel_id], lifecycle="active"
        ).count()
        == 2
    )
    if guest is not None:
        identity = current_identity_by_id(identity_id=guest.guest_identity_id)
        # Either participating agent may resolve this exact guest room. The grant
        # remains owned by its issuing organisation; it grants no partner membership.
        guest_scope = guest.organisation_id == organisation_id
        if agreement is not None:
            guest_scope = (
                guest.organisation_id,
                guest.single_channel_id,
            ) in {
                (agreement.organisation_id, agreement.channel_id),
                (agreement.partner_organisation_id, agreement.partner_channel_id),
            }
        allowed = (
            partner_allowed
            and guest_scope
            and getattr(settings, "KODERA_CHANNEL_GOVERNANCE_ENABLED", False) is True
            and (guest.matrix_room_id == room_id or action == "session")
            and guest.revoked_at is None
            and guest.expires_at > timezone.now()
            and identity is not None
            and not has_privacy_cutoff(
                organisation_id=guest.organisation_id, user_id=identity[0].id
            )
            and action in {"join", "event", "call", "session"}
            and (action != "call" or guest.allow_calls)
            and Channel.objects.filter(id=guest.single_channel_id, lifecycle="active").exists()
            and active_organisation(organisation_id=guest.organisation_id)
        )
        return {"allowed": allowed, "role": "single_channel_guest", "revision": 1}
    if agreement is None:
        return {"allowed": True, "role": "unmanaged", "revision": 0}
    if not partner_allowed:
        return denied
    local_server = (
        agreement.local_homeserver
        if organisation_id == agreement.organisation_id
        else agreement.partner_homeserver
    )
    return {
        "allowed": server == local_server or action in {"join", "event", "call"},
        "role": "local" if server == local_server else "partner",
        "revision": agreement.revision,
    }


@transaction.atomic
def guest_channel(*, verified: VerifiedAccessToken, organisation_id: UUID) -> dict[str, Any]:
    identity = current_identity(issuer=verified.issuer, subject=verified.subject)
    if identity is None:
        raise RefusalError(403, "identity-unknown")
    row = SingleChannelGuestGrant.objects.filter(
        guest_identity_id=identity[1].id, organisation_id=organisation_id
    ).first()
    if (
        row is None
        or not matrix_authority(
            organisation_id=organisation_id,
            room_id=row.matrix_room_id,
            user_id=row.matrix_user_id,
            action="join",
        )["allowed"]
    ):
        raise RefusalError(404)
    channel = _channel(row.single_channel_id, organisation_id)
    return {
        "channelId": str(channel.id),
        "name": channel.name,
        "kind": channel.kind,
        "matrixRoomId": row.matrix_room_id,
        "allowCalls": row.allow_calls,
        "expiresAt": row.expires_at.isoformat(),
        "role": row.role,
    }


def _emit_guests(organisation_id: UUID, workspace_id: UUID) -> None:
    from .channel_sets import emit_for

    emit_for(
        organisation_id=organisation_id, workspace_id=workspace_id, reason="channel.guest_changed"
    )
