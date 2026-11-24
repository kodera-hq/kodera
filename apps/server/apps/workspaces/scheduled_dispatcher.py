"""Operator-only Send Later scheduled message dispatcher with lock-free Matrix replay."""

from __future__ import annotations

import importlib
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Protocol
from uuid import UUID, uuid4

from django.conf import settings
from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone

from apps.e2ee.services import has_confidential_room
from apps.orgs.selectors import (
    lock_erasure_cutoff_fences,
    membership_delivery_state,
    organisation_delivery_state,
    privacy_cutoff_reason,
)
from apps.orgs.workspace_members import for_workspace

from .channel_access import permits_channel_post
from .models import Channel, ScheduledMessage
from .moderation import member_restrictions
from .selectors import (
    MatrixTransportError,
    SynapseRoomDirectoryClient,
    has_foreign_partner_room_binding,
    is_designated_confidential_channel,
    partner_channel_matrix_room_id,
    verify_channel_room_binding,
)

LEASE_TTL_SECONDS = 60


class MatrixReplayTransport(Protocol):
    def send_message(self, *, room_id: str, txn_id: str, content: dict[str, Any]) -> str: ...


class MatrixReplayClient(SynapseRoomDirectoryClient):
    """Idempotent Synapse room/thread message sender and compensating redactor."""

    def send_message(self, *, room_id: str, txn_id: str, content: dict[str, Any]) -> str:
        _, answer = self._call(
            "PUT",
            f"/_matrix/client/v3/rooms/{self._q(room_id)}/send/m.room.message/{self._q(txn_id)}",
            content,
        )
        event_id = answer.get("event_id") if isinstance(answer, dict) else None
        if not isinstance(event_id, str) or not event_id.startswith("$"):
            raise MatrixTransportError("matrix_event_id_invalid", retryable=False)
        return event_id

    def redact_message(
        self,
        *,
        room_id: str,
        event_id: str,
        txn_id: str,
        reason: str = "authority_revoked",
    ) -> str | None:
        _, answer = self._call(
            "PUT",
            f"/_matrix/client/v3/rooms/{self._q(room_id)}/redact/{self._q(event_id)}/{self._q(txn_id)}",
            {"reason": reason[:200]},
            ok=(200, 404),
        )
        if isinstance(answer, dict) and isinstance(answer.get("event_id"), str):
            return answer["event_id"]
        return None


def configured_matrix_client() -> Any | None:
    """Instantiate the configured Synapse room-directory / replay client if available."""
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
        return MatrixReplayClient(synapse_url, synapse_token, synapse_server)
    return None


def try_compensating_redact(
    matrix_client: Any,
    *,
    room_id: str,
    event_id: str,
    txn_id: str,
    reason: str,
) -> None:
    """Best-effort Matrix redaction when authority or GDPR erasure revokes a mid-flight send."""
    redact_fn = getattr(matrix_client, "redact_message", None)
    if callable(redact_fn):
        try:
            redact_fn(room_id=room_id, event_id=event_id, txn_id=txn_id, reason=reason)
        except Exception:  # noqa: BLE001 - best-effort compensating redaction before refusing
            logging.getLogger(__name__).warning(
                "compensating_scheduled_redaction_failed room_id=%s event_id=%s",
                room_id,
                event_id,
            )


@dataclass(frozen=True, slots=True)
class ClaimedScheduledJob:
    id: UUID
    organisation_id: UUID
    workspace_id: UUID
    channel_id: UUID | None
    room_id: str
    author_id: UUID
    body: str
    mentions: tuple[str, ...]
    thread_root_event_id: str
    matrix_txn_id: str
    lease_id: UUID


def _evaluate_delivery_authority(
    *,
    row: ScheduledMessage,
    now: datetime,
    resolved_synapse_room_id: str | None = None,
    check_synapse_binding: bool = False,
) -> tuple[str, str, UUID | None]:
    """Return `(verdict, reason, author_user_id)` where verdict is `ok|refused_policy|obsolete`."""
    member_row = membership_delivery_state(
        membership_id=row.author_id, organisation_id=row.organisation_id
    )
    author_user_id: UUID | None = member_row[0] if member_row is not None else None

    cutoff_reason = privacy_cutoff_reason(
        organisation_id=row.organisation_id, user_id=author_user_id
    )
    if cutoff_reason is not None:
        return "obsolete", cutoff_reason, author_user_id

    org_row = organisation_delivery_state(organisation_id=row.organisation_id)
    if org_row is None or org_row[0] != "active":
        return "refused_policy", "organisation_inactive", author_user_id

    if (
        member_row is None
        or member_row[2] != "active"
        or member_row[3] is None
        or member_row[4] is not None
        or for_workspace(
            organisation_id=row.organisation_id, membership_id=row.author_id, lock=False
        )
        is None
    ):
        return "refused_policy", "membership_inactive", author_user_id

    denied, muted = member_restrictions(row.workspace_id, row.author_id, now=now)
    if denied:
        return "refused_policy", "member_banned_or_kicked", author_user_id
    if muted:
        return "refused_policy", "member_muted", author_user_id

    if row.channel_id is None:
        return "refused_policy", "channel_binding_required", author_user_id

    if is_designated_confidential_channel(
        workspace_id=row.workspace_id, channel_id=row.channel_id
    ) or has_confidential_room(channel_id=row.channel_id, organisation_id=row.organisation_id):
        return "refused_policy", "confidential_channel_refused", author_user_id

    if not Channel.objects.filter(
        id=row.channel_id,
        workspace_id=row.workspace_id,
        kind="text",
        lifecycle="active",
    ).exists():
        return "refused_policy", "channel_unavailable", author_user_id

    if check_synapse_binding:
        room_ok, _ = verify_channel_room_binding(
            workspace_id=row.workspace_id,
            channel_id=row.channel_id,
            room_id=row.room_id,
            resolved_synapse_room_id=resolved_synapse_room_id,
        )
        if not room_ok:
            return "refused_policy", "channel_room_mismatch", author_user_id
    elif row.room_id:
        if has_foreign_partner_room_binding(channel_id=row.channel_id, room_id=row.room_id):
            return "refused_policy", "channel_room_mismatch", author_user_id
        partner_room = partner_channel_matrix_room_id(channel_id=row.channel_id)
        if partner_room is not None and row.room_id != partner_room:
            return "refused_policy", "channel_room_mismatch", author_user_id

    if not permits_channel_post(
        channel_id=row.channel_id,
        membership_id=row.author_id,
        organisation_id=row.organisation_id,
        member_org_role=str(member_row[1]),
        authority_revision=int(org_row[1]),
    ):
        return "refused_policy", "channel_post_denied", author_user_id

    return "ok", "", author_user_id


def _build_matrix_content(job: ClaimedScheduledJob) -> dict[str, Any]:
    content: dict[str, Any] = {
        "msgtype": "m.text",
        "body": job.body,
        "io.kodera.scheduled_message_id": str(job.id),
        "io.kodera.author_membership_id": str(job.author_id),
    }
    if job.mentions:
        content["io.kodera.mention_membership_ids"] = list(job.mentions)
    if job.thread_root_event_id:
        content["m.relates_to"] = {
            "rel_type": "m.thread",
            "event_id": job.thread_root_event_id,
            "is_falling_back": True,
            "m.in_reply_to": {"event_id": job.thread_root_event_id},
        }
    return content


def _claim_next(
    *, organisation_id: UUID | None = None, now: datetime | None = None
) -> tuple[str, ClaimedScheduledJob | None]:
    """Claim one due scheduled message or transition it immediately if revoked/erased."""
    ref = timezone.now() if now is None else now
    with transaction.atomic():
        qs = ScheduledMessage.objects.select_for_update(skip_locked=True).filter(
            Q(state=ScheduledMessage.State.PENDING, deliver_at__lte=ref)
            | Q(state=ScheduledMessage.State.IN_FLIGHT, lease_expires_at__lte=ref)
        )
        if organisation_id is not None:
            qs = qs.filter(organisation_id=organisation_id)
        row = qs.order_by("deliver_at", "id").first()
        if row is None:
            return "empty", None

        verdict, reason, _ = _evaluate_delivery_authority(row=row, now=ref)
        if verdict == "obsolete":
            ScheduledMessage.objects.filter(pk=row.pk).update(
                state=ScheduledMessage.State.OBSOLETE,
                lease_id=None,
                lease_expires_at=None,
                failure_reason=reason,
                updated_at=ref,
            )
            return "obsoleted", None
        if verdict == "refused_policy":
            ScheduledMessage.objects.filter(pk=row.pk).update(
                state=ScheduledMessage.State.REFUSED_POLICY,
                lease_id=None,
                lease_expires_at=None,
                failure_reason=reason,
                updated_at=ref,
            )
            return "refused_policy", None

        lease = uuid4()
        expires_at = ref + timedelta(seconds=LEASE_TTL_SECONDS)
        ScheduledMessage.objects.filter(pk=row.pk).update(
            state=ScheduledMessage.State.IN_FLIGHT,
            lease_id=lease,
            lease_expires_at=expires_at,
            updated_at=ref,
        )
        mentions = (
            tuple(str(m) for m in row.mentions_json if isinstance(m, str))
            if isinstance(row.mentions_json, list)
            else ()
        )
        return (
            "claimed",
            ClaimedScheduledJob(
                id=row.id,
                organisation_id=row.organisation_id,
                workspace_id=row.workspace_id,
                channel_id=row.channel_id,
                room_id=row.room_id,
                author_id=row.author_id,
                body=row.body,
                mentions=mentions,
                thread_root_event_id=row.thread_root_event_id,
                matrix_txn_id=row.matrix_txn_id,
                lease_id=lease,
            ),
        )


def dispatch_scheduled_messages(
    *,
    matrix_client: Any,
    organisation_id: UUID | None = None,
    max_jobs: int = 25,
    mid_flight_hook: Callable[[ClaimedScheduledJob, str], None] | None = None,
) -> dict[str, int]:
    """Drain up to `max_jobs` due scheduled messages without holding DB locks across Matrix HTTP."""
    if connection.in_atomic_block:
        raise RuntimeError(
            "dispatch_scheduled_messages must run outside an enclosing atomic transaction"
        )
    if type(max_jobs) is not int or not 1 <= max_jobs <= 100:
        raise ValueError("max_jobs must be between 1 and 100")

    counts = {
        "delivered": 0,
        "refused_policy": 0,
        "obsoleted": 0,
        "retryable": 0,
        "redacted_compensating": 0,
    }

    for _ in range(max_jobs):
        status, job = _claim_next(organisation_id=organisation_id)
        if status == "empty":
            break
        if status in ("obsoleted", "refused_policy"):
            counts[status] += 1
            continue
        if job is None or connection.in_atomic_block:
            raise RuntimeError("claimed scheduled job invariant violated")

        if job.channel_id is None:
            with transaction.atomic():
                ScheduledMessage.objects.filter(
                    pk=job.id,
                    state=ScheduledMessage.State.IN_FLIGHT,
                    lease_id=job.lease_id,
                ).update(
                    state=ScheduledMessage.State.REFUSED_POLICY,
                    lease_id=None,
                    lease_expires_at=None,
                    failure_reason="channel_binding_required",
                    updated_at=timezone.now(),
                )
            counts["refused_policy"] += 1
            continue

        # Always resolve the authoritative Matrix room ID for `job.channel_id` (partner agreement
        # or Synapse room directory `#kodera-ch-<channel_id>:<domain>`); never trust `job.room_id`
        # as an independent destination.
        target_room_id = partner_channel_matrix_room_id(channel_id=job.channel_id) or ""
        if not target_room_id:
            resolve_fn = getattr(matrix_client, "resolve_channel_room", None)
            if callable(resolve_fn):
                try:
                    resolved = resolve_fn(job.channel_id)
                except MatrixTransportError as exc:
                    if exc.retryable:
                        with transaction.atomic():
                            ScheduledMessage.objects.filter(
                                pk=job.id,
                                state=ScheduledMessage.State.IN_FLIGHT,
                                lease_id=job.lease_id,
                            ).update(
                                state=ScheduledMessage.State.PENDING,
                                lease_id=None,
                                lease_expires_at=None,
                                failure_reason=exc.code,
                                updated_at=timezone.now(),
                            )
                        counts["retryable"] += 1
                        continue
                    resolved = None
                if isinstance(resolved, str) and resolved:
                    target_room_id = resolved

        if target_room_id and job.room_id and job.room_id != target_room_id:
            with transaction.atomic():
                ScheduledMessage.objects.filter(
                    pk=job.id,
                    state=ScheduledMessage.State.IN_FLIGHT,
                    lease_id=job.lease_id,
                ).update(
                    state=ScheduledMessage.State.REFUSED_POLICY,
                    lease_id=None,
                    lease_expires_at=None,
                    failure_reason="channel_room_mismatch",
                    updated_at=timezone.now(),
                )
            counts["refused_policy"] += 1
            continue

        if not target_room_id:
            with transaction.atomic():
                row = ScheduledMessage.objects.select_for_update().filter(pk=job.id).first()
                if row is not None and row.state == ScheduledMessage.State.IN_FLIGHT:
                    verdict, reason, _ = _evaluate_delivery_authority(row=row, now=timezone.now())
                    if verdict == "obsolete":
                        ScheduledMessage.objects.filter(pk=job.id).update(
                            state=ScheduledMessage.State.OBSOLETE,
                            lease_id=None,
                            lease_expires_at=None,
                            failure_reason=reason,
                            updated_at=timezone.now(),
                        )
                        counts["obsoleted"] += 1
                    else:
                        ScheduledMessage.objects.filter(pk=job.id).update(
                            state=ScheduledMessage.State.PENDING,
                            lease_id=None,
                            lease_expires_at=None,
                            failure_reason="room_unready",
                            updated_at=timezone.now(),
                        )
                        counts["retryable"] += 1
            continue

        try:
            event_id = matrix_client.send_message(
                room_id=target_room_id,
                txn_id=job.matrix_txn_id,
                content=_build_matrix_content(job),
            )
        except MatrixTransportError as exc:
            now_err = timezone.now()
            with transaction.atomic():
                row = ScheduledMessage.objects.select_for_update().filter(pk=job.id).first()
                if row is not None and row.state == ScheduledMessage.State.IN_FLIGHT:
                    verdict, reason, _ = _evaluate_delivery_authority(row=row, now=now_err)
                    if verdict == "obsolete":
                        ScheduledMessage.objects.filter(pk=job.id).update(
                            state=ScheduledMessage.State.OBSOLETE,
                            lease_id=None,
                            lease_expires_at=None,
                            failure_reason=reason,
                            updated_at=now_err,
                        )
                        counts["obsoleted"] += 1
                    elif exc.retryable:
                        ScheduledMessage.objects.filter(pk=job.id).update(
                            state=ScheduledMessage.State.PENDING,
                            lease_id=None,
                            lease_expires_at=None,
                            failure_reason=exc.code,
                            updated_at=now_err,
                        )
                        counts["retryable"] += 1
                    else:
                        ScheduledMessage.objects.filter(pk=job.id).update(
                            state=ScheduledMessage.State.REFUSED_POLICY,
                            lease_id=None,
                            lease_expires_at=None,
                            failure_reason=exc.code,
                            updated_at=now_err,
                        )
                        counts["refused_policy"] += 1
            continue

        if mid_flight_hook is not None:
            mid_flight_hook(job, event_id)

        redact_reason: str | None = None
        with transaction.atomic():
            now_post = timezone.now()
            row = ScheduledMessage.objects.select_for_update().filter(pk=job.id).first()
            if row is None:
                redact_reason = "erasure_purged"
                counts["obsoleted"] += 1
            elif row.state != ScheduledMessage.State.IN_FLIGHT or row.lease_id != job.lease_id:
                redact_reason = f"state_{row.state}"
            else:
                verdict, reason, author_uid = _evaluate_delivery_authority(
                    row=row,
                    now=now_post,
                    resolved_synapse_room_id=target_room_id,
                    check_synapse_binding=True,
                )
                if verdict == "obsolete":
                    ScheduledMessage.objects.filter(pk=job.id).update(
                        state=ScheduledMessage.State.OBSOLETE,
                        lease_id=None,
                        lease_expires_at=None,
                        failure_reason=reason,
                        updated_at=now_post,
                    )
                    redact_reason = reason
                    counts["obsoleted"] += 1
                elif verdict == "refused_policy":
                    # Re-check erasure cutoff in case it arrived simultaneously
                    cutoff = privacy_cutoff_reason(
                        organisation_id=row.organisation_id, user_id=author_uid
                    )
                    if cutoff is not None:
                        ScheduledMessage.objects.filter(pk=job.id).update(
                            state=ScheduledMessage.State.OBSOLETE,
                            lease_id=None,
                            lease_expires_at=None,
                            failure_reason=cutoff,
                            updated_at=now_post,
                        )
                        redact_reason = cutoff
                        counts["obsoleted"] += 1
                    else:
                        ScheduledMessage.objects.filter(pk=job.id).update(
                            state=ScheduledMessage.State.REFUSED_POLICY,
                            lease_id=None,
                            lease_expires_at=None,
                            failure_reason=reason,
                            updated_at=now_post,
                        )
                        redact_reason = reason
                        counts["refused_policy"] += 1
                else:
                    if author_uid is not None:
                        lock_erasure_cutoff_fences(
                            organisation_id=row.organisation_id, user_id=author_uid
                        )
                    cutoff_after_fence = privacy_cutoff_reason(
                        organisation_id=row.organisation_id, user_id=author_uid
                    )
                    if cutoff_after_fence is not None:
                        ScheduledMessage.objects.filter(pk=job.id).update(
                            state=ScheduledMessage.State.OBSOLETE,
                            lease_id=None,
                            lease_expires_at=None,
                            failure_reason=cutoff_after_fence,
                            updated_at=now_post,
                        )
                        redact_reason = cutoff_after_fence
                        counts["obsoleted"] += 1
                    else:
                        ScheduledMessage.objects.filter(pk=job.id).update(
                            state=ScheduledMessage.State.DELIVERED,
                            matrix_event_id=event_id,
                            room_id=target_room_id,
                            lease_id=None,
                            lease_expires_at=None,
                            failure_reason="",
                            updated_at=now_post,
                        )
                        counts["delivered"] += 1

        if redact_reason is not None:
            try_compensating_redact(
                matrix_client,
                room_id=target_room_id,
                event_id=event_id,
                txn_id=f"{job.matrix_txn_id}-redact",
                reason=redact_reason,
            )
            counts["redacted_compensating"] += 1

    return counts
