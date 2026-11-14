"""Persistence/authority adapters for the private export protocol; no default completeness ports.

Deletion remains held: no cutoff, external-store erasure or statutory-retention proof provider
is currently configured. This module neither infers an accounting purge date nor deletes data.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any

from django.db import transaction

from apps.audit.privacy_events import record_export_event
from apps.identity.privacy_selectors import current_export_organisation
from apps.orgs.models import Membership, Organisation

from .privacy_archives import SECTIONS, ArchiveRefusalError, Chunk, Request, State, require
from .privacy_models import PrivacyExport


class CurrentAuthority:
    def authorize(self, request: Request) -> bool:
        identity = current_export_organisation(
            identity_id=request.identity_id, user_id=request.user_id
        )
        if identity is None:
            return False
        if request.scope == "account":
            return True
        return str(identity) == request.organisation_id and (
            Organisation.objects.filter(
                id=identity, state="active", deleted_at__isnull=True
            ).exists()
            and Membership.objects.filter(
                organisation_id=identity,
                user_id=request.user_id,
                state="active",
                accepted_at__isnull=False,
                role="org_owner",
                deleted_at__isnull=True,
            ).exists()
        )


def encode(state: State) -> dict[str, Any]:
    return {
        "snapshots": state.snapshots,
        "chunks": [asdict(chunk) for chunk in state.chunks],
        "complete": list(state.complete),
        "artifact_key": state.artifact_key,
        "artifact_sha256": state.artifact_sha256,
        "artifact_size": state.artifact_size,
    }


def decode(row: PrivacyExport) -> State:
    try:
        request = Request(**row.request_snapshot)
        request.validate()
        require(
            request.id == str(row.id)
            and request.user_id == str(row.user_id)
            and request.identity_id == str(row.identity_id)
            and request.organisation_id
            == (str(row.organisation_id) if row.organisation_id else None)
            and request.scope == row.scope
            and request.expires_at == int(row.expires_at.timestamp()),
            "persisted export request binding",
        )
        checkpoint = row.checkpoint
        require(
            set(checkpoint)
            == {
                "snapshots",
                "chunks",
                "complete",
                "artifact_key",
                "artifact_sha256",
                "artifact_size",
            },
            "persisted export checkpoint shape",
        )
        chunks = []
        for value in checkpoint["chunks"]:
            values = dict(value)
            values["entries"] = tuple(tuple(entry) for entry in value["entries"])
            chunks.append(Chunk(**values))
        return State(
            request=request,
            revision=row.revision,
            snapshots=checkpoint["snapshots"],
            chunks=tuple(chunks),
            complete=tuple(checkpoint["complete"]),
            artifact_key=checkpoint["artifact_key"],
            artifact_sha256=checkpoint["artifact_sha256"],
            artifact_size=checkpoint["artifact_size"],
        )
    except (TypeError, KeyError, ValueError, AttributeError):
        raise ArchiveRefusalError("persisted export checkpoint invalid") from None


class DatabaseJournal:
    def load(self, request_id: str) -> State:
        row = PrivacyExport.objects.filter(id=request_id).first()
        if row is None:
            raise ArchiveRefusalError("export request absent", 404)
        require(row.status not in {"expired", "failed"}, "export request not resumable", 409)
        state = decode(row)
        require(
            (row.status == "ready") == (state.artifact_key is not None),
            "persisted export ready binding",
        )
        return state

    @transaction.atomic
    def save(self, state: State, expected_revision: int) -> bool:
        require(state.revision == expected_revision + 1, "export revision progression")
        changed = (
            PrivacyExport.objects.filter(
                id=state.request.id,
                user_id=state.request.user_id,
                identity_id=state.request.identity_id,
                revision=expected_revision,
                request_snapshot=asdict(state.request),
                status__in=["queued", "running"],
            ).update(
                revision=state.revision,
                checkpoint=encode(state),
                status="ready" if state.artifact_key is not None else "running",
                updated_at=datetime.now(UTC),
            )
            == 1
        )
        if changed and state.artifact_key is not None:
            _audit("export.ready", state.request)
        return changed


def _audit(action: str, request: Request) -> None:
    record_export_event(
        action=action,
        identity_id=request.identity_id,
        organisation_id=request.organisation_id,
        export_id=request.id,
        scope=request.scope,
    )


@transaction.atomic
def persist_started(state: State, authority: CurrentAuthority) -> PrivacyExport:
    require(
        state.revision == 1
        and not state.chunks
        and not state.complete
        and state.artifact_key is None,
        "initial export checkpoint",
    )
    require(set(state.snapshots) == set(SECTIONS), "initial export snapshot completeness")
    require(
        state.request.created_at <= int(datetime.now(UTC).timestamp()) < state.request.expires_at,
        "export expired",
        409,
    )
    require(authority.authorize(state.request), "export authority revoked", 403)
    request = state.request
    row = PrivacyExport.objects.create(
        id=request.id,
        identity_id=request.identity_id,
        user_id=request.user_id,
        organisation_id=request.organisation_id,
        scope=request.scope,
        request_snapshot=asdict(request),
        checkpoint=encode(state),
        expires_at=datetime.fromtimestamp(request.expires_at, UTC),
    )
    _audit("export.requested", request)
    return row


def deletion_hold() -> None:
    raise ArchiveRefusalError("deletion cutoff and statutory retention proofs unavailable")
