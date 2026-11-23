"""Public workspace service ports; policy construction performs no request or database work."""

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.core.exceptions import ObjectDoesNotExist
from django.db import connection, transaction
from django.db.models import Max
from django.utils import timezone

from apps.engine_intents.channel_sets import ChannelSetSnapshot
from core.api.guarded_replay import EffectPolicy
from services.identity.access_tokens import VerifiedAccessToken


class InvalidTemplateOperationError(ValueError):
    """Raised when an operation_key or template customization fails validation."""


class TemplateOperationConflictError(ValueError):
    """Raised when an existing operation_key is reused with a mismatched template or spec."""


class TemplateActorForbiddenError(PermissionError):
    """Raised when the template actor lacks active org_owner authority."""


class TemplateActorUnknownError(PermissionError):
    """Raised when the template actor's identity or person is disabled, deleted, or absent."""


class TemplateProvisioningStepError(RuntimeError):
    """Raised when an asynchronous or external step fails mid-flight after checkpointing."""

    def __init__(self, step: str, detail: str, *, error_code: str = "") -> None:
        super().__init__(f"{step}: {detail}")
        self.step = step
        self.detail = detail
        self.error_code = error_code or f"{step}_failed"


@dataclass(frozen=True, slots=True)
class TemplateApplicationResult:
    application_id: UUID
    workspace_id: UUID
    operation_key: str
    template_id: str
    template_version: int
    state: str
    replayed: bool
    category_ids: dict[str, UUID]
    channel_ids: dict[str, UUID]
    collection_ids: dict[str, UUID]
    document_ids: dict[str, UUID]
    channel_set_id: UUID | None
    channel_set_revision: int | None
    completed_steps: tuple[str, ...]


ChannelSetProvisioner = Callable[[ChannelSetSnapshot], tuple[dict[str, str], list[str], list[str]]]
TemplateStepHook = Callable[[str, str], None]


def quota_replay_policy() -> EffectPolicy:
    from .quota_http import QuotaReplayPolicy

    return QuotaReplayPolicy()


def sync_subscription_quota(
    *,
    organisation_id: UUID,
    policy_ref: str,
    seats: int | None,
    media_bytes: int | None = None,
    pages: int | None = None,
    update_storage: bool = False,
) -> UUID | None:
    """Synchronize an organisation's WorkspaceQuota from reconciled subscription state."""
    from .models import Workspace, WorkspaceQuota

    if seats is not None and seats < 0:
        raise ValueError("seats quota must be non-negative")
    workspace = Workspace.objects.filter(organisation_id=organisation_id).first()
    if workspace is None:
        return None
    quota = WorkspaceQuota.objects.select_for_update().filter(workspace=workspace).first()
    if quota is None:
        quota = WorkspaceQuota.objects.create(
            workspace=workspace,
            policy_ref=policy_ref,
            seats=seats,
            media_bytes=media_bytes if update_storage else None,
            pages=pages if update_storage else None,
        )
        return quota.id
    quota.policy_ref = policy_ref
    quota.seats = seats
    update_fields = ["policy_ref", "seats", "updated_at"]
    if update_storage:
        quota.media_bytes = media_bytes
        quota.pages = pages
        update_fields.extend(["media_bytes", "pages"])
    quota.save(update_fields=update_fields)
    return quota.id


def template_spec_fingerprint(
    template_id: str,
    template_version: int,
    customization_payload: dict[str, Any] | None,
) -> str:
    canonical = json.dumps(
        {
            "template_id": template_id,
            "template_version": template_version,
            "customization": customization_payload,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _resolve_workspace_principal(
    organisation_id: UUID,
    creator_membership_id: UUID | None,
    actor_identity_id: UUID | None,
) -> tuple[UUID, UUID]:
    from apps.identity.selectors import realm_identities
    from apps.orgs.selectors import current_members

    members = current_members(organisation_id=organisation_id)
    if creator_membership_id is not None and actor_identity_id is not None:
        return creator_membership_id, actor_identity_id

    if not members:
        raise InvalidTemplateOperationError("organisation has no active member to own starter docs")

    role_rank = {"org_owner": 0, "org_admin": 1, "org_billing": 2, "org_member": 3}
    selected_membership_id = creator_membership_id
    if selected_membership_id is None or selected_membership_id not in members:
        selected_membership_id = min(
            members,
            key=lambda m_id: (role_rank.get(members[m_id][1], 99), str(m_id)),
        )
    selected_user_id = members[selected_membership_id][0]
    selected_identity_id = actor_identity_id
    if selected_identity_id is None:
        identities = realm_identities(
            user_id=selected_user_id, organisation_id=organisation_id, usable_only=True
        )
        if not identities:
            raise InvalidTemplateOperationError("organisation member has no enabled realm identity")
        selected_identity_id = identities[0].id
    return selected_membership_id, selected_identity_id


def _parse_uuid_map(raw: object) -> dict[str, UUID]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, UUID] = {}
    for k, v in raw.items():
        if isinstance(k, str) and isinstance(v, str):
            try:
                out[k] = UUID(v)
            except ValueError:
                continue
    return out


def _build_result(app_row: Any, *, replayed: bool) -> TemplateApplicationResult:
    artefacts = app_row.artefacts if isinstance(app_row.artefacts, dict) else {}
    raw_cs_id = artefacts.get("channel_set_id")
    cs_id: UUID | None = None
    if isinstance(raw_cs_id, str):
        try:
            cs_id = UUID(raw_cs_id)
        except ValueError:
            cs_id = None
    raw_rev = artefacts.get("channel_set_revision")
    cs_rev = raw_rev if isinstance(raw_rev, int) and not isinstance(raw_rev, bool) else None
    steps = (
        tuple(str(s) for s in app_row.completed_steps)
        if isinstance(app_row.completed_steps, list)
        else ()
    )
    return TemplateApplicationResult(
        application_id=app_row.id,
        workspace_id=app_row.workspace_id,
        operation_key=app_row.operation_key,
        template_id=app_row.template_id,
        template_version=app_row.template_version,
        state=app_row.state,
        replayed=replayed,
        category_ids=_parse_uuid_map(artefacts.get("categories")),
        channel_ids=_parse_uuid_map(artefacts.get("channels")),
        collection_ids=_parse_uuid_map(artefacts.get("collections")),
        document_ids=_parse_uuid_map(artefacts.get("documents")),
        channel_set_id=cs_id,
        channel_set_revision=cs_rev,
        completed_steps=steps,
    )


def _lock_and_verify_template_actor(
    *,
    organisation_id: UUID,
    verified: VerifiedAccessToken | None = None,
    creator_membership_id: UUID | None = None,
    actor_identity_id: UUID | None = None,
) -> tuple[UUID, UUID]:
    """Lock and re-verify the caller's Membership, Identity, User, and Organisation in canonical order."""
    if not connection.in_atomic_block:
        raise RuntimeError("_lock_and_verify_template_actor requires an active transaction")

    from apps.identity.selectors import (
        active_organisation_identities,
        current_identity,
        lock_delivery_identity_if_present,
        lock_user_fence_if_present,
        realm_identities,
    )
    from apps.orgs.actor_selectors import (
        TenantCallerNotFoundError,
        TenantCallerUnknownError,
        read_tenant_caller,
    )
    from apps.orgs.selectors import (
        active_organisation,
        current_members,
        lock_erasure_cutoff_fences,
        lock_membership_fence_if_present,
        lock_organisation as lock_organisation_row,
        membership_user_id,
    )

    from .initialise import lock_organisation

    if verified is not None:
        resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
        if resolved is None:
            raise TemplateActorUnknownError("actor identity absent or disabled")
        person, identity = resolved
        if identity.organisation_id != organisation_id:
            raise TemplateActorForbiddenError("actor identity belongs to another organisation")
        try:
            initial_caller = read_tenant_caller(verified=verified, organisation_id=organisation_id)
        except TenantCallerUnknownError:
            raise TemplateActorUnknownError("actor identity unknown") from None
        except TenantCallerNotFoundError:
            raise TemplateActorForbiddenError("actor has no active membership") from None
        if (
            creator_membership_id is not None
            and initial_caller.membership_id != creator_membership_id
        ) or (actor_identity_id is not None and initial_caller.identity_id != actor_identity_id):
            raise TemplateActorForbiddenError("actor principal does not match caller")

        lock_erasure_cutoff_fences(organisation_id=organisation_id, user_id=person.id)
        locked_user_id = lock_membership_fence_if_present(
            membership_id=initial_caller.membership_id
        )
        if locked_user_id is None:
            raise TemplateActorForbiddenError("actor membership deleted")
        if not lock_delivery_identity_if_present(identity_id=initial_caller.identity_id):
            raise TemplateActorUnknownError("actor identity deleted")
        if not lock_user_fence_if_present(user_id=locked_user_id):
            raise TemplateActorUnknownError("actor person deleted")
        if not lock_organisation_row(organisation_id=organisation_id):
            raise TemplateActorForbiddenError("organisation deleted")
        lock_organisation(organisation_id)

        if current_identity(issuer=verified.issuer, subject=verified.subject) is None:
            raise TemplateActorUnknownError("actor identity disabled under lock")
        try:
            caller = read_tenant_caller(verified=verified, organisation_id=organisation_id)
        except TenantCallerUnknownError:
            raise TemplateActorUnknownError("actor identity unknown under lock") from None
        except TenantCallerNotFoundError:
            raise TemplateActorForbiddenError("actor membership inactive under lock") from None
        if (
            caller.membership_id != initial_caller.membership_id
            or caller.identity_id != initial_caller.identity_id
            or caller.role != "org_owner"
            or caller.organisation_state != "active"
        ):
            raise TemplateActorForbiddenError("actor lacks active org_owner authority")
        return caller.membership_id, caller.identity_id

    if creator_membership_id is not None:
        try:
            target_user_id = membership_user_id(membership_id=creator_membership_id)
        except ObjectDoesNotExist:
            raise TemplateActorForbiddenError("actor membership not found") from None
        target_membership_id = creator_membership_id
    elif actor_identity_id is not None:
        pre_ids = active_organisation_identities(identity_ids={actor_identity_id})
        if not pre_ids:
            raise TemplateActorUnknownError("actor identity disabled or unknown")
        if pre_ids[0].organisation_id != organisation_id:
            raise TemplateActorForbiddenError("actor identity belongs to another organisation")
        target_user_id = pre_ids[0].user_id
        pre_members = current_members(organisation_id=organisation_id)
        matching_members = [
            m_id for m_id, (u_id, _) in pre_members.items() if u_id == target_user_id
        ]
        if not matching_members:
            raise TemplateActorForbiddenError("actor has no active membership")
        target_membership_id = matching_members[0]
    else:
        raise RuntimeError("_lock_and_verify_template_actor called without actor")

    if actor_identity_id is not None:
        target_identity_id = actor_identity_id
    else:
        usable_ids = realm_identities(
            user_id=target_user_id, organisation_id=organisation_id, usable_only=True
        )
        if not usable_ids:
            raise TemplateActorUnknownError("actor has no enabled realm identity")
        target_identity_id = usable_ids[0].id

    lock_erasure_cutoff_fences(organisation_id=organisation_id, user_id=target_user_id)
    locked_user_id = lock_membership_fence_if_present(membership_id=target_membership_id)
    if locked_user_id is None:
        raise TemplateActorForbiddenError("actor membership deleted")
    if not lock_delivery_identity_if_present(identity_id=target_identity_id):
        raise TemplateActorUnknownError("actor identity deleted")
    if not lock_user_fence_if_present(user_id=locked_user_id):
        raise TemplateActorUnknownError("actor person deleted")
    if not lock_organisation_row(organisation_id=organisation_id):
        raise TemplateActorForbiddenError("organisation deleted")
    lock_organisation(organisation_id)

    if not active_organisation(organisation_id=organisation_id):
        raise TemplateActorForbiddenError("organisation inactive")
    active_ids = active_organisation_identities(identity_ids={target_identity_id})
    if (
        not active_ids
        or active_ids[0].user_id != locked_user_id
        or active_ids[0].organisation_id != organisation_id
    ):
        raise TemplateActorUnknownError("actor identity or person disabled")
    members = current_members(organisation_id=organisation_id)
    if target_membership_id not in members:
        raise TemplateActorForbiddenError("actor membership inactive")
    m_user_id, m_role = members[target_membership_id]
    if m_user_id != locked_user_id or m_role != "org_owner":
        raise TemplateActorForbiddenError("actor lacks active org_owner authority")
    return target_membership_id, target_identity_id


def apply_workspace_template(
    *,
    organisation_id: UUID,
    template_id: str,
    operation_key: str,
    verified: VerifiedAccessToken | None = None,
    actor_identity_id: UUID | None = None,
    creator_membership_id: UUID | None = None,
    customization: Any = None,
    request_id: str = "",
    matrix_provisioner: ChannelSetProvisioner | None = None,
    step_hook: TemplateStepHook | None = None,
) -> TemplateApplicationResult:
    """Execute or resume a durable, idempotent WorkspaceTemplate v2 application.

    Each step checkpoints its created artefact UUIDs into `WorkspaceTemplateApplication` before
    external or subsequent steps proceed. If Matrix room provisioning or starter Docs generation
    fails partway through, re-invoking with the same `(organisation_id, operation_key)` reuses
    every completed category, channel, Matrix room, collection, and starter document without
    creating duplicates.
    """
    from apps.audit.services import record_workspace_initialised
    from apps.docs.errors import RefusalError as DocsRefusalError
    from apps.docs.services import reconcile_template_collection, reconcile_template_document
    from apps.engine_intents.channel_sets import (
        emit_channel_set,
        read_channel_set_snapshot,
        to_snapshot,
    )
    from apps.engine_intents.services import lock_heads

    from . import channel_sets
    from .initialise import lock_organisation
    from .models import (
        TEMPLATE_APP_ERROR_CODES,
        Category,
        Channel,
        ResourcePolicy,
        Workspace,
        WorkspaceTemplateApplication,
    )
    from .moderation import projection as moderation_projection
    from .templates import resolve_template
    from .warm_pool import (
        OPERATION_KEY_PATTERN,
        TemplateCustomization,
        parse_template_customization,
        resolve_customized_blueprints,
    )

    if connection.in_atomic_block:
        raise RuntimeError("apply_workspace_template manages its own checkpoint transactions")

    if not isinstance(operation_key, str) or not OPERATION_KEY_PATTERN.fullmatch(operation_key):
        raise InvalidTemplateOperationError("invalid operation_key")

    template = resolve_template(template_id)
    normalized_custom: TemplateCustomization | None
    if customization is None:
        normalized_custom = None
    elif isinstance(customization, TemplateCustomization):
        try:
            resolve_customized_blueprints(template, customization)
        except ValueError as exc:
            raise InvalidTemplateOperationError(str(exc)) from None
        normalized_custom = customization
    else:
        try:
            normalized_custom = parse_template_customization(customization, template)
        except ValueError as exc:
            raise InvalidTemplateOperationError(str(exc)) from None

    effective_channels, effective_collections, effective_documents = resolve_customized_blueprints(
        template, normalized_custom
    )
    fingerprint = template_spec_fingerprint(
        template.id,
        template.version,
        normalized_custom.to_dict() if normalized_custom is not None else None,
    )

    has_actor = (
        verified is not None or creator_membership_id is not None or actor_identity_id is not None
    )

    def _verify_actor(
        bound_m_id: UUID | None = creator_membership_id,
        bound_i_id: UUID | None = actor_identity_id,
    ) -> tuple[UUID, UUID]:
        return _lock_and_verify_template_actor(
            organisation_id=organisation_id,
            verified=verified,
            creator_membership_id=bound_m_id,
            actor_identity_id=bound_i_id,
        )

    with transaction.atomic():
        if has_actor:
            resolved_membership_id, resolved_identity_id = _verify_actor()
        else:
            lock_organisation(organisation_id)
            resolved_membership_id, resolved_identity_id = _resolve_workspace_principal(
                organisation_id, creator_membership_id, actor_identity_id
            )
        workspace = (
            Workspace.objects.select_for_update().filter(organisation_id=organisation_id).first()
        )
        created_workspace = False
        if workspace is None:
            workspace = Workspace.objects.create(
                organisation_id=organisation_id, structure_revision=1
            )
            default_policy = ResourcePolicy.objects.create(
                workspace=workspace,
                visibility=ResourcePolicy.Visibility.ORGANISATION,
                revision=1,
            )
            Workspace.objects.filter(pk=workspace.pk).update(default_policy=default_policy)
            workspace.default_policy = default_policy
            created_workspace = True
        elif workspace.default_policy_id is None:
            default_policy = ResourcePolicy.objects.create(
                workspace=workspace,
                visibility=ResourcePolicy.Visibility.ORGANISATION,
                revision=1,
            )
            Workspace.objects.filter(pk=workspace.pk).update(default_policy=default_policy)
            workspace.default_policy = default_policy

        app_row = (
            WorkspaceTemplateApplication.objects.select_for_update()
            .filter(workspace=workspace, operation_key=operation_key)
            .first()
        )
        if app_row is not None and app_row.spec_fingerprint != fingerprint:
            raise TemplateOperationConflictError(
                f"operation_key {operation_key!r} already bound to a different template spec"
            )
        if app_row is None:
            app_row = WorkspaceTemplateApplication.objects.create(
                workspace=workspace,
                operation_key=operation_key,
                template_id=template.id,
                template_version=template.version,
                spec_fingerprint=fingerprint,
                state=WorkspaceTemplateApplication.State.IN_PROGRESS,
                completed_steps=[],
                artefacts={
                    "categories": {},
                    "channels": {},
                    "collections": {},
                    "documents": {},
                },
                last_error="",
            )
        if created_workspace:
            record_workspace_initialised(
                organisation_id=organisation_id,
                workspace_id=workspace.id,
                actor_id=resolved_identity_id,
                request_id=request_id,
                template_version=template.version,
            )

        if app_row.state == WorkspaceTemplateApplication.State.COMPLETED:
            stored_channels = _parse_uuid_map(
                (app_row.artefacts or {}).get("channels")
                if isinstance(app_row.artefacts, dict)
                else {}
            )
            rooms_ready = True
            if matrix_provisioner is not None and stored_channels:
                ready_count = Channel.objects.filter(
                    workspace=workspace,
                    id__in=list(stored_channels.values()),
                    lifecycle=Channel.Lifecycle.ACTIVE,
                    room_state=Channel.RoomState.READY,
                ).count()
                rooms_ready = ready_count == len(stored_channels)
            if rooms_ready:
                return _build_result(app_row, replayed=True)

        app_row.state = WorkspaceTemplateApplication.State.IN_PROGRESS
        app_row.last_error = ""
        app_row.save(update_fields=["state", "last_error", "updated_at"])
        app_id = app_row.id
        workspace_id = workspace.id

    def _reverify_bound_actor() -> None:
        if has_actor:
            _verify_actor(resolved_membership_id, resolved_identity_id)

    def _checkpoint(
        *,
        section: str | None = None,
        item_key: str | None = None,
        item_value: Any = None,
        top_updates: dict[str, Any] | None = None,
        completed_step: str | None = None,
    ) -> WorkspaceTemplateApplication:
        with transaction.atomic():
            _reverify_bound_actor()
            locked = WorkspaceTemplateApplication.objects.select_for_update().get(pk=app_id)
            artefacts: dict[str, Any] = (
                dict(locked.artefacts) if isinstance(locked.artefacts, dict) else {}
            )
            if section is not None and item_key is not None:
                bucket = dict(artefacts.get(section) or {})
                bucket[item_key] = item_value
                artefacts[section] = bucket
            if top_updates:
                artefacts.update(top_updates)
            steps = list(locked.completed_steps) if isinstance(locked.completed_steps, list) else []
            if completed_step is not None and completed_step not in steps:
                steps.append(completed_step)
            locked.artefacts = artefacts
            locked.completed_steps = steps
            locked.save(update_fields=["artefacts", "completed_steps", "updated_at"])
            return locked

    current_step = "structure"
    try:
        # Step 1: PostgreSQL categories and text/audio channels.
        if step_hook is not None:
            step_hook("structure", "begin")
        with transaction.atomic():
            if has_actor:
                _reverify_bound_actor()
            else:
                lock_organisation(organisation_id)
            ws = Workspace.objects.select_for_update().get(pk=workspace_id)
            locked_app = WorkspaceTemplateApplication.objects.select_for_update().get(pk=app_id)
            artefacts = dict(locked_app.artefacts) if isinstance(locked_app.artefacts, dict) else {}
            cat_map: dict[str, str] = dict(artefacts.get("categories") or {})
            ch_map: dict[str, str] = dict(artefacts.get("channels") or {})
            structure_changed = False

            max_cat_pos = Category.objects.filter(workspace=ws).aggregate(m=Max("position"))["m"]
            next_cat_pos = 0 if max_cat_pos is None else int(max_cat_pos) + 1
            resolved_categories: dict[str, Category] = {}
            for cat_bp in template.categories:
                cat_row = (
                    Category.objects.filter(workspace=ws, template_key=cat_bp.db_template_key)
                    .order_by("id")
                    .first()
                )
                if cat_row is None:
                    cat_row = Category.objects.create(
                        workspace=ws,
                        template_key=cat_bp.db_template_key,
                        name=cat_bp.name,
                        position=next_cat_pos,
                    )
                    next_cat_pos += 1
                    structure_changed = True
                resolved_categories[cat_bp.key] = cat_row
                cat_map[cat_bp.key] = str(cat_row.id)

            next_ch_pos_by_cat: dict[UUID, int] = {}
            for ch_bp in effective_channels:
                parent_cat = resolved_categories[ch_bp.category_key]
                ch_row = (
                    Channel.objects.filter(workspace=ws, template_key=ch_bp.db_template_key)
                    .exclude(lifecycle=Channel.Lifecycle.DELETED)
                    .order_by("id")
                    .first()
                )
                if ch_row is None:
                    if parent_cat.id not in next_ch_pos_by_cat:
                        max_pos = Channel.objects.filter(
                            workspace=ws, category=parent_cat
                        ).aggregate(m=Max("position"))["m"]
                        next_ch_pos_by_cat[parent_cat.id] = (
                            0 if max_pos is None else int(max_pos) + 1
                        )
                    pos = next_ch_pos_by_cat[parent_cat.id]
                    next_ch_pos_by_cat[parent_cat.id] = pos + 1
                    ch_row = Channel.objects.create(
                        workspace=ws,
                        category=parent_cat,
                        kind=ch_bp.kind,
                        template_key=ch_bp.db_template_key,
                        name=ch_bp.name,
                        topic=ch_bp.topic,
                        position=pos,
                        policy_mode=Channel.PolicyMode.INHERIT,
                        lifecycle=Channel.Lifecycle.ACTIVE,
                    )
                    structure_changed = True
                ch_map[ch_bp.template_key] = str(ch_row.id)

            if structure_changed:
                ws.structure_revision += 1
                ws.save(update_fields=["structure_revision", "updated_at"])

            artefacts["categories"] = cat_map
            artefacts["channels"] = ch_map
            steps = (
                list(locked_app.completed_steps)
                if isinstance(locked_app.completed_steps, list)
                else []
            )
            if "structure" not in steps:
                steps.append("structure")
            locked_app.artefacts = artefacts
            locked_app.completed_steps = steps
            locked_app.save(update_fields=["artefacts", "completed_steps", "updated_at"])

        # Step 2: 1:1 Matrix room projection & channel-set emission.
        current_step = "matrix_projection"
        with transaction.atomic():
            _reverify_bound_actor()
            channel_sets.lock_workspace(organisation_id)
            locked_app = WorkspaceTemplateApplication.objects.select_for_update().get(pk=app_id)
            artefacts = dict(locked_app.artefacts) if isinstance(locked_app.artefacts, dict) else {}
            expected_channel_ids = set((artefacts.get("channels") or {}).values())
            raw_cs_id = artefacts.get("channel_set_id")
            existing_cs_uuid: UUID | None = None
            if isinstance(raw_cs_id, str):
                try:
                    existing_cs_uuid = UUID(raw_cs_id)
                except ValueError:
                    existing_cs_uuid = None
            snapshot = (
                read_channel_set_snapshot(
                    organisation_id=organisation_id, channel_set_id=existing_cs_uuid
                )
                if existing_cs_uuid is not None
                else None
            )
            if snapshot is None or not expected_channel_ids <= {
                c["channel_id"] for c in snapshot.channels
            }:
                lock_heads(organisation_id)
                all_members, ch_entries = channel_sets.channel_set_input(workspace_id)
                issued = emit_channel_set(
                    organisation_id=organisation_id,
                    reason="workspace.template_applied",
                    all_members=all_members,
                    channels=ch_entries,
                    moderation=moderation_projection(workspace_id),
                )
                snapshot = to_snapshot(issued)
                artefacts["channel_set_id"] = str(snapshot.id)
                artefacts["channel_set_revision"] = snapshot.revision
                locked_app.artefacts = artefacts
                locked_app.save(update_fields=["artefacts", "updated_at"])

        if step_hook is not None:
            step_hook("matrix_projection", "provision")
        if matrix_provisioner is not None:
            if has_actor:
                with transaction.atomic():
                    _reverify_bound_actor()
            ready, failed, notices_posted = matrix_provisioner(snapshot)
            with transaction.atomic():
                _reverify_bound_actor()
                channel_sets.apply_result(
                    organisation_id=organisation_id,
                    revision=snapshot.revision,
                    ready=ready,
                    failed=failed,
                    notices_posted=notices_posted,
                )
            if failed:
                raise TemplateProvisioningStepError(
                    "matrix_projection",
                    f"matrix room provisioning failed for {','.join(sorted(failed))}",
                )
        _checkpoint(completed_step="matrix_projection")

        # Step 3: Starter Collections.
        current_step = "collections"
        current_app = WorkspaceTemplateApplication.objects.get(pk=app_id)
        existing_collections = _parse_uuid_map(
            (current_app.artefacts or {}).get("collections")
            if isinstance(current_app.artefacts, dict)
            else {}
        )
        for col_bp in effective_collections:
            if step_hook is not None:
                step_hook("collections", col_bp.key)
            col_id, _ = reconcile_template_collection(
                workspace_id=workspace_id,
                organisation_id=organisation_id,
                creator_membership_id=resolved_membership_id,
                actor_identity_id=resolved_identity_id,
                title_text=col_bp.title,
                properties=[dict(p) for p in col_bp.properties],
                views=[dict(v) for v in col_bp.views],
                existing_id=existing_collections.get(col_bp.key),
                request_id=request_id,
                authorise_write=_reverify_bound_actor if has_actor else None,
            )
            existing_collections[col_bp.key] = col_id
            _checkpoint(section="collections", item_key=col_bp.key, item_value=str(col_id))
        _checkpoint(completed_step="collections")

        # Step 4: Starter Docs & optional Collection rows.
        current_step = "starter_docs"
        current_app = WorkspaceTemplateApplication.objects.get(pk=app_id)
        current_artefacts = current_app.artefacts if isinstance(current_app.artefacts, dict) else {}
        channel_uuid_map = _parse_uuid_map(current_artefacts.get("channels"))
        collection_uuid_map = _parse_uuid_map(current_artefacts.get("collections"))
        existing_docs = _parse_uuid_map(current_artefacts.get("documents"))

        for doc_bp in effective_documents:
            if step_hook is not None:
                step_hook("starter_docs", doc_bp.key)
            target_ch_id = channel_uuid_map.get(doc_bp.channel_key) if doc_bp.channel_key else None
            target_col_id = (
                collection_uuid_map.get(doc_bp.collection_key) if doc_bp.collection_key else None
            )
            try:
                doc_id, _ = reconcile_template_document(
                    workspace_id=workspace_id,
                    organisation_id=organisation_id,
                    creator_membership_id=resolved_membership_id,
                    actor_identity_id=resolved_identity_id,
                    title_text=doc_bp.title,
                    markdown_text=doc_bp.markdown,
                    channel_id=target_ch_id,
                    collection_id=target_col_id,
                    collection_values=dict(doc_bp.collection_values),
                    existing_id=existing_docs.get(doc_bp.key),
                    request_id=request_id,
                    authorise_write=_reverify_bound_actor if has_actor else None,
                )
            except DocsRefusalError as exc:
                if exc.status == 503:
                    raise TemplateProvisioningStepError(
                        "starter_docs",
                        "collab_engine_unavailable",
                        error_code="collab_engine_unavailable",
                    ) from None
                raise
            existing_docs[doc_bp.key] = doc_id
            _checkpoint(section="documents", item_key=doc_bp.key, item_value=str(doc_id))
        _checkpoint(completed_step="starter_docs")

        with transaction.atomic():
            _reverify_bound_actor()
            final_app = WorkspaceTemplateApplication.objects.select_for_update().get(pk=app_id)
            final_app.state = WorkspaceTemplateApplication.State.COMPLETED
            final_app.last_error = ""
            final_app.completed_at = timezone.now()
            final_app.save(update_fields=["state", "last_error", "completed_at", "updated_at"])
            return _build_result(final_app, replayed=False)

    except (TemplateActorForbiddenError, TemplateActorUnknownError):
        raise
    except Exception as exc:
        if isinstance(exc, TemplateProvisioningStepError):
            code = exc.error_code
        elif isinstance(exc, DocsRefusalError) and exc.status == 503:
            code = "collab_engine_unavailable"
        else:
            code = f"{current_step}_failed"
        if code not in TEMPLATE_APP_ERROR_CODES or code == "":
            code = "internal_step_failed"
        with transaction.atomic():
            _reverify_bound_actor()
            failed_app = (
                WorkspaceTemplateApplication.objects.select_for_update().filter(pk=app_id).first()
            )
            if failed_app is not None:
                failed_app.state = WorkspaceTemplateApplication.State.FAILED
                failed_app.last_error = code
                failed_app.save(update_fields=["state", "last_error", "updated_at"])
        raise
