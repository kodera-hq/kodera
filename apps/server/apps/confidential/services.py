"""Server-accepted consecutive epochs and proof-bound public verification bundles."""

import base64
import hashlib
import json
from typing import Any
from uuid import UUID

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from django.conf import settings
from django.db import transaction

from apps.e2ee.services import (
    RefusalError as RefusalError,
    admit_directory as admit_directory,
    directory_context,
    verification_context as verification_context,
)
from services.identity.access_tokens import VerifiedAccessToken

from .models import DeviceVerificationBundle, MlsRoomEpoch


def enabled() -> None:
    if getattr(settings, "KODERA_E2EE_RELAY_ENABLED", False) is not True:
        raise RefusalError(503)


def accept_epoch(
    *, room_id: UUID, epoch: int, sequence: int, commit: bytes, device_ids: list[str]
) -> None:
    """Called only by the serialized relay transaction that accepts the signed commit."""
    if not transaction.get_connection().in_atomic_block:
        raise RuntimeError("epoch acceptance requires the relay transaction")
    previous = MlsRoomEpoch.objects.filter(room_id=room_id).order_by("-epoch").first()
    if (previous is None and epoch != 0) or (previous is not None and epoch != previous.epoch + 1):
        raise RefusalError(409)
    MlsRoomEpoch.objects.create(
        room_id=room_id,
        epoch=epoch,
        commit_sequence=sequence,
        commit_digest=hashlib.sha256(commit).hexdigest(),
        device_ids=sorted(device_ids),
    )


def verification_statement(
    *,
    organisation_id: UUID,
    membership_id: str,
    body: dict[str, Any],
    purpose: str,
    signing_key: str,
) -> bytes:
    """Domain-separated cross-signing statement, bound to tenant, member, device and revision."""
    return json.dumps(
        {
            "purpose": purpose,
            "organisationId": str(organisation_id),
            "membershipId": membership_id,
            "deviceId": body["deviceId"],
            "revision": body["revision"],
            "masterKey": body["masterKey"],
            "selfSigningKey": body["selfSigningKey"],
            "signingKey": signing_key,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()


@transaction.atomic
def publish_bundle(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    body: dict[str, Any],
    request_id: str = "",
) -> dict[str, Any]:
    enabled()
    if set(body) != {
        "deviceId",
        "revision",
        "masterKey",
        "selfSigningKey",
        "crossSigningSignature",
        "deviceSignature",
        "signature",
    }:
        raise RefusalError(422)
    context = verification_context(verified=verified, organisation_id=organisation_id, body=body)
    if type(body.get("revision")) is not int or not 1 <= body["revision"] <= 2**53 - 1:
        raise RefusalError(422)
    try:

        def key(field: str, size: int) -> bytes:
            value = base64.b64decode(body[field], validate=True)
            if len(value) != size:
                raise ValueError("invalid public material size")
            return value

        master, self_signing = key("masterKey", 32), key("selfSigningKey", 32)
        for public, signature, purpose in (
            (master, key("crossSigningSignature", 64), "self-signing-key"),
            (self_signing, key("deviceSignature", 64), "device-verification"),
        ):
            Ed25519PublicKey.from_public_bytes(public).verify(
                signature,
                verification_statement(
                    organisation_id=organisation_id,
                    membership_id=context["membershipId"],
                    body=body,
                    purpose=purpose,
                    signing_key=context["signingKey"],
                ),
            )
    except (KeyError, TypeError, ValueError, InvalidSignature):
        raise RefusalError(422) from None
    row = (
        DeviceVerificationBundle.objects.select_for_update()
        .filter(device_id=context["deviceId"])
        .first()
    )
    if body["revision"] != (row.revision + 1 if row else 1):
        raise RefusalError(409)
    bundle = {**body, "signingKey": context["signingKey"], "membershipId": context["membershipId"]}
    if row is None:
        DeviceVerificationBundle.objects.create(
            device_id=context["deviceId"], revision=body["revision"], public_bundle=bundle
        )
    else:
        row.revision, row.public_bundle = body["revision"], bundle
        row.save(update_fields=["revision", "public_bundle", "updated_at"])
    from apps.audit.services import record_workspace_resource_event

    record_workspace_resource_event(
        action="workspace.e2ee.verification_published",
        organisation_id=organisation_id,
        actor_id=UUID(context["identityId"]),
        target_id=UUID(context["deviceId"]),
        request_id=request_id,
    )
    return {"deviceId": context["deviceId"], "revision": body["revision"]}


@transaction.atomic
def discover(
    *, verified: VerifiedAccessToken, organisation_id: UUID, room_id: UUID, device_id: str
) -> dict[str, Any]:
    enabled()
    context = directory_context(
        verified=verified, organisation_id=organisation_id, room_id=room_id, device_id=device_id
    )
    row = MlsRoomEpoch.objects.filter(room_id=context["roomId"], epoch=context["epoch"]).first()
    if context["algorithm"] != "io.kodera.mls.v1" or row is None:
        raise RefusalError(409)
    return {
        **{key: value for key, value in context.items() if key != "signingKeys"},
        "commitSequence": row.commit_sequence,
        "commitDigest": row.commit_digest,
        "acceptedAt": row.created_at.isoformat(),
        "verificationBundles": [
            item.public_bundle
            for item in DeviceVerificationBundle.objects.filter(
                device_id__in=context["deviceIds"],
                device__revoked_at__isnull=True,
            ).order_by("device_id")
        ],
    }
