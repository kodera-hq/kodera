"""Server-accepted consecutive epochs, proof-bound verification bundles, and opaque KVKB1 backups."""

import base64
import binascii
import hashlib
import json
from typing import Any
from uuid import UUID

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from django.conf import settings
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.e2ee.services import (
    MAX_EPOCH,
    RefusalError as RefusalError,
    admit_directory as admit_directory,
    directory_context,
    key_backup_member_context as key_backup_member_context,
    key_backup_publish_context as key_backup_publish_context,
    verification_context as verification_context,
)
from services.identity.access_tokens import VerifiedAccessToken

from .models import DeviceVerificationBundle, KeyBackupArchive, MlsRoomEpoch

KVKB1_MAGIC = b"KVKB1"
KVKB1_DOMAIN = "kodera-zk-key-backup"
KVKB1_VERSION = 1
KVKB1_MIN_CAPSULE_BYTES = 42
KVKB1_MAX_CAPSULE_BYTES = 262_144
KVKB1_MAX_HEADER_BYTES = 2_048
KVKB1_SALT_BYTES = 16
KVKB1_IV_BYTES = 12
KVKB1_MIN_CIPHERTEXT_AND_TAG_BYTES = 17
KVKB1_PASSPHRASE_MIN_ITERATIONS = 600_000
KVKB1_PASSPHRASE_MAX_ITERATIONS = 2_000_000


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
    if type(body.get("revision")) is not int or not 1 <= body["revision"] <= MAX_EPOCH:
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


def _decode_strict_base64(value: Any, *, minimum: int, maximum: int) -> bytes:
    if (
        not isinstance(value, str)
        or not value
        or len(value) % 4 != 0
        or len(value) > 4 * ((maximum + 2) // 3)
    ):
        raise RefusalError(422)
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise RefusalError(422) from None
    if not minimum <= len(decoded) <= maximum or base64.b64encode(decoded).decode() != value:
        raise RefusalError(422)
    return decoded


def validate_kvkb1_capsule(
    capsule: bytes,
    *,
    organisation_id: UUID,
    user_id: str,
    expected_epoch: int,
) -> tuple[str, int]:
    """Validate outer KVKB1 header bindings without inspecting encrypted secret material."""
    if not KVKB1_MIN_CAPSULE_BYTES <= len(capsule) <= KVKB1_MAX_CAPSULE_BYTES:
        raise RefusalError(422)
    if capsule[:5] != KVKB1_MAGIC:
        raise RefusalError(422)
    header_len = int.from_bytes(capsule[5:9], "big")
    if not 1 <= header_len <= KVKB1_MAX_HEADER_BYTES or 9 + header_len >= len(capsule):
        raise RefusalError(422)
    header_bytes = capsule[9 : 9 + header_len]
    ciphertext_and_tag = capsule[9 + header_len :]
    if len(ciphertext_and_tag) < KVKB1_MIN_CIPHERTEXT_AND_TAG_BYTES:
        raise RefusalError(422)
    try:
        header_text = header_bytes.decode("utf-8")

        def reject_constant(_: str) -> None:
            raise ValueError("non-finite json constant")

        parsed = json.loads(header_text, parse_constant=reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise RefusalError(422) from None
    if not isinstance(parsed, list) or len(parsed) != 9:
        raise RefusalError(422)
    canonical = json.dumps(
        parsed, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")
    if canonical != header_bytes:
        raise RefusalError(422)
    domain, version, org_str, user_str, epoch, kdf_kind, iterations, salt_b64, iv_b64 = parsed
    if (
        domain != KVKB1_DOMAIN
        or type(version) is not int
        or version != KVKB1_VERSION
        or not isinstance(org_str, str)
        or org_str != str(organisation_id)
        or not isinstance(user_str, str)
        or user_str != user_id
        or type(epoch) is not int
        or not 1 <= epoch <= MAX_EPOCH
        or epoch != expected_epoch
        or not isinstance(kdf_kind, str)
        or type(iterations) is not int
    ):
        raise RefusalError(422)
    if kdf_kind == "recovery-key":
        if iterations != 0:
            raise RefusalError(422)
    elif kdf_kind == "passphrase":
        if not KVKB1_PASSPHRASE_MIN_ITERATIONS <= iterations <= KVKB1_PASSPHRASE_MAX_ITERATIONS:
            raise RefusalError(422)
    else:
        raise RefusalError(422)
    _decode_strict_base64(salt_b64, minimum=KVKB1_SALT_BYTES, maximum=KVKB1_SALT_BYTES)
    _decode_strict_base64(iv_b64, minimum=KVKB1_IV_BYTES, maximum=KVKB1_IV_BYTES)
    return kdf_kind, iterations


@transaction.atomic
def publish_key_backup(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    body: dict[str, Any],
    request_id: str = "",
) -> dict[str, Any]:
    enabled()
    if set(body) != {"deviceId", "backupEpoch", "capsule", "signature"}:
        raise RefusalError(422)
    context = key_backup_publish_context(
        verified=verified, organisation_id=organisation_id, body=body
    )
    backup_epoch = body.get("backupEpoch")
    if type(backup_epoch) is not int or not 1 <= backup_epoch <= MAX_EPOCH:
        raise RefusalError(422)
    capsule_bytes = _decode_strict_base64(
        body.get("capsule"),
        minimum=KVKB1_MIN_CAPSULE_BYTES,
        maximum=KVKB1_MAX_CAPSULE_BYTES,
    )
    kdf_kind, iterations = validate_kvkb1_capsule(
        capsule_bytes,
        organisation_id=organisation_id,
        user_id=context["userId"],
        expected_epoch=backup_epoch,
    )
    row = (
        KeyBackupArchive.objects.select_for_update()
        .filter(organisation_id=organisation_id, membership_id=context["membershipId"])
        .first()
    )
    next_epoch = row.backup_epoch + 1 if row is not None else 1
    if next_epoch > MAX_EPOCH or backup_epoch != next_epoch:
        raise RefusalError(
            409,
            "conflict",
            next_backup_epoch=next_epoch if next_epoch <= MAX_EPOCH else None,
        )
    digest = hashlib.sha256(capsule_bytes).hexdigest()
    if row is None:
        try:
            with transaction.atomic():
                row = KeyBackupArchive.objects.create(
                    organisation_id=organisation_id,
                    membership_id=UUID(context["membershipId"]),
                    source_device_id=UUID(context["deviceId"]),
                    backup_epoch=backup_epoch,
                    kdf_kind=kdf_kind,
                    iterations=iterations,
                    capsule_sha256=digest,
                    capsule=capsule_bytes,
                    discarded_at=None,
                )
        except IntegrityError:
            current = KeyBackupArchive.objects.filter(
                organisation_id=organisation_id,
                membership_id=context["membershipId"],
            ).first()
            conflict_next = (current.backup_epoch + 1) if current is not None else 2
            raise RefusalError(
                409,
                "conflict",
                next_backup_epoch=conflict_next if conflict_next <= MAX_EPOCH else None,
            ) from None
    else:
        row.source_device_id = UUID(context["deviceId"])
        row.backup_epoch = backup_epoch
        row.kdf_kind = kdf_kind
        row.iterations = iterations
        row.capsule_sha256 = digest
        row.capsule = capsule_bytes
        row.discarded_at = None
        row.save(
            update_fields=[
                "source_device_id",
                "backup_epoch",
                "kdf_kind",
                "iterations",
                "capsule_sha256",
                "capsule",
                "discarded_at",
                "updated_at",
            ]
        )
    from apps.audit.services import record_workspace_resource_event

    record_workspace_resource_event(
        action="workspace.e2ee.key_backup_published",
        organisation_id=organisation_id,
        actor_id=UUID(context["identityId"]),
        target_id=row.id,
        request_id=request_id,
    )
    return {
        "backupEpoch": row.backup_epoch,
        "kdfKind": row.kdf_kind,
        "iterations": row.iterations,
        "capsuleSha256": row.capsule_sha256,
        "sourceDeviceId": str(row.source_device_id),
        "publishedAt": row.updated_at.isoformat(),
    }


@transaction.atomic
def get_key_backup(*, verified: VerifiedAccessToken, organisation_id: UUID) -> dict[str, Any]:
    enabled()
    context = key_backup_member_context(verified=verified, organisation_id=organisation_id)
    row = KeyBackupArchive.objects.filter(
        organisation_id=organisation_id,
        membership_id=context["membershipId"],
    ).first()
    if row is None:
        raise RefusalError(404)
    if row.capsule is None or row.discarded_at is not None:
        raise RefusalError(
            404,
            next_backup_epoch=row.backup_epoch + 1 if row.backup_epoch < MAX_EPOCH else None,
        )
    return {
        "backupEpoch": row.backup_epoch,
        "kdfKind": row.kdf_kind,
        "iterations": row.iterations,
        "capsuleSha256": row.capsule_sha256,
        "sourceDeviceId": str(row.source_device_id),
        "publishedAt": row.updated_at.isoformat(),
        "capsule": base64.b64encode(bytes(row.capsule)).decode(),
    }


@transaction.atomic
def discard_key_backup(
    *, verified: VerifiedAccessToken, organisation_id: UUID, request_id: str = ""
) -> int:
    enabled()
    context = key_backup_member_context(verified=verified, organisation_id=organisation_id)
    row = (
        KeyBackupArchive.objects.select_for_update()
        .filter(organisation_id=organisation_id, membership_id=context["membershipId"])
        .first()
    )
    if row is None or row.capsule is None or row.discarded_at is not None:
        raise RefusalError(404)
    row.capsule = None
    row.discarded_at = timezone.now()
    row.save(update_fields=["capsule", "discarded_at", "updated_at"])
    from apps.audit.services import record_workspace_resource_event

    record_workspace_resource_event(
        action="workspace.e2ee.key_backup_discarded",
        organisation_id=organisation_id,
        actor_id=UUID(context["identityId"]),
        target_id=row.id,
        request_id=request_id,
    )
    return int(row.backup_epoch + 1)


def count_residual_confidential_for_organisation(*, organisation_id: UUID) -> int:
    """Count remaining confidential key backups, verification bundles, and MLS epochs for an erased organisation."""
    total = 0
    with connection.cursor() as cursor:
        cursor.execute(
            """SELECT
                 to_regclass('public.confidential_keybackuparchive') IS NOT NULL,
                 to_regclass('public.confidential_deviceverificationbundle') IS NOT NULL,
                 to_regclass('public.confidential_mlsroomepoch') IS NOT NULL"""
        )
        has_backups, has_bundles, has_epochs = cursor.fetchone()
    if has_backups:
        total += int(KeyBackupArchive.objects.filter(organisation_id=organisation_id).count())
    if has_bundles:
        total += int(
            DeviceVerificationBundle.objects.filter(device__organisation_id=organisation_id).count()
        )
    if has_epochs:
        total += int(MlsRoomEpoch.objects.filter(room__organisation_id=organisation_id).count())
    return total


def count_residual_confidential_for_user(*, user_id: UUID) -> int:
    """Count remaining confidential key backups and verification bundles for an erased person."""
    total = 0
    with connection.cursor() as cursor:
        cursor.execute(
            """SELECT
                 to_regclass('public.confidential_keybackuparchive') IS NOT NULL,
                 to_regclass('public.confidential_deviceverificationbundle') IS NOT NULL"""
        )
        has_backups, has_bundles = cursor.fetchone()
    if has_backups:
        total += int(KeyBackupArchive.objects.filter(membership__user_id=user_id).count())
    if has_bundles:
        total += int(
            DeviceVerificationBundle.objects.filter(device__membership__user_id=user_id).count()
        )
    return total
