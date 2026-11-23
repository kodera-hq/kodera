"""End-to-end PostgreSQL + Matrix + Yjs Docs verification of resumable WorkspaceTemplate v2."""

from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from order_fixtures import commit_order
from test_customer_persistence_models import anchor, anchor_models, identity
from test_tenant_agent_channels import FakeHomeserver, build
from test_workspace_onboarding import conformance_errors, realm_job
from workspace_documents.test_services import _native_engine

from apps.docs.models import Collection, CollectionRow, Document, DocumentSnapshot
from apps.engine_intents.channel_sets import (
    ChannelSetSnapshot,
    snapshot_results,
)
from apps.engine_intents.models import EngineChannelSet
from apps.orgs.models import Organisation
from apps.workspaces.models import (
    Category,
    Channel,
    Workspace,
    WorkspaceTemplateApplication,
)
from apps.workspaces.services import (
    InvalidTemplateOperationError,
    TemplateOperationConflictError,
    TemplateProvisioningStepError,
    apply_workspace_template,
)
from apps.workspaces.templates import PERSONA_TEMPLATE_IDS, resolve_template
from tenant_agent.channels import CHANNEL_KIND
from tenant_agent.engines import EngineError
from tenant_agent.synapse import POLICY

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def native_engine(settings):
    yield from _native_engine(settings)


class FlakyCreateRoomHomeserver(FakeHomeserver):
    """Fake Synapse homeserver that fails `/createRoom` on configured attempt numbers."""

    def __init__(self, users: tuple[str, ...], fail_on_create_attempts: set[int] | None = None):
        super().__init__(users=users)
        self.create_room_attempts = 0
        self.fail_on_create_attempts = set(fail_on_create_attempts or ())

    def _call(self, method, path, body=None, *, ok=(200,)):
        clean_path, _, _ = path.partition("?")
        if clean_path.endswith("/createRoom"):
            self.create_room_attempts += 1
            if self.create_room_attempts in self.fail_on_create_attempts:
                raise EngineError("transient synapse 503 during room creation")
        return super()._call(method, path, body=body, ok=ok)


def _make_matrix_provisioner(tmp_dir, homeserver: FakeHomeserver, active_subjects: tuple[str, ...]):
    handlers, _, _, _ = build(tmp_dir, homeserver=homeserver, active=active_subjects)

    def provision(snapshot: ChannelSetSnapshot) -> tuple[dict[str, str], list[str], list[str]]:
        outcome = handlers.handle(CHANNEL_KIND, snapshot.to_agent_payload())
        succeeded = outcome.status == "succeeded"
        failed_ids = (
            list((outcome.artefacts or {}).get("failed_channel_ids", [])) if not succeeded else None
        )
        return snapshot_results(snapshot, succeeded=succeeded, failed_ids=failed_ids)

    return provision


def _create_isolated_org(slug_prefix: str) -> Organisation:
    models = anchor_models()
    suffix = uuid4().hex[:6]
    slug = f"{slug_prefix[:10].rstrip('-')}-{suffix}"
    org, _, owners = anchor(models, slug=slug)
    subject = f"owner-{suffix}"
    identity(models, org, owners[0].user, subject=subject)
    realm_job(org, "succeeded")
    commit_order(org.id, org.issuer, subject)
    return org


def test_v2_personas_apply_end_to_end_with_1_to_1_matrix_rooms_collections_and_starter_docs(
    tmp_path, native_engine
) -> None:
    assert len(PERSONA_TEMPLATE_IDS) == 6
    for persona_id in PERSONA_TEMPLATE_IDS:
        org = _create_isolated_org(f"p-{persona_id[:12]}")
        subject = org.identity_set.values_list("subject", flat=True).get()
        homeserver = FakeHomeserver(users=(subject,))
        provision = _make_matrix_provisioner(
            tmp_path / persona_id, homeserver, active_subjects=(subject,)
        )

        tpl = resolve_template(persona_id)
        result = apply_workspace_template(
            organisation_id=org.id,
            template_id=persona_id,
            operation_key=f"init:{persona_id}:v2",
            matrix_provisioner=provision,
            request_id=f"req-{persona_id}",
        )

        assert result.state == WorkspaceTemplateApplication.State.COMPLETED
        assert result.replayed is False
        assert result.template_id == persona_id
        assert result.template_version == 2
        assert result.completed_steps == (
            "structure",
            "matrix_projection",
            "collections",
            "starter_docs",
        )

        ws = Workspace.objects.get(organisation=org)
        assert Category.objects.filter(workspace=ws).count() == len(tpl.categories)
        channels = list(Channel.objects.filter(workspace=ws).order_by("id"))
        assert len(channels) == len(tpl.channels)
        # Strict 1:1 Matrix room mapping: audio channels reuse their single Matrix room for
        # companion chat with read_only=False and never create a second room.
        assert len(homeserver.rooms) == len(tpl.channels)
        for ch in channels:
            assert ch.room_state == Channel.RoomState.READY
            assert ch.is_confidential is False
            room = homeserver.room_of(str(ch.id))
            policy = room["state"][(POLICY, "")]
            assert policy["kind"] == ch.kind
            assert policy["read_only"] is False
            assert policy["listen_only"] is False

        assert Collection.objects.filter(workspace=ws, deleted_at__isnull=True).count() == len(
            tpl.collections
        )
        docs = list(Document.objects.filter(workspace=ws, deleted_at__isnull=True))
        assert len(docs) == len(tpl.documents)
        for doc in docs:
            snap = DocumentSnapshot.objects.get(document=doc)
            assert len(bytes(snap.state)) > 2


def test_mid_flight_matrix_room_failure_resumes_idempotently_without_duplicates(
    tmp_path, native_engine
) -> None:
    org = _create_isolated_org("resumable-matrix")
    subject = org.identity_set.values_list("subject", flat=True).get()
    # Fail on the 3rd room creation out of 5 channels in tech-studio.
    homeserver = FlakyCreateRoomHomeserver(users=(subject,), fail_on_create_attempts={3})
    provision = _make_matrix_provisioner(
        tmp_path / "matrix-resume", homeserver, active_subjects=(subject,)
    )
    op_key = "op-matrix-midflight-01"

    with pytest.raises(TemplateProvisioningStepError) as exc_info:
        apply_workspace_template(
            organisation_id=org.id,
            template_id="tech-studio",
            operation_key=op_key,
            matrix_provisioner=provision,
            request_id="req-attempt-1",
        )
    assert exc_info.value.step == "matrix_projection"

    ws = Workspace.objects.get(organisation=org)
    app_row = WorkspaceTemplateApplication.objects.get(workspace=ws, operation_key=op_key)
    assert app_row.state == WorkspaceTemplateApplication.State.FAILED
    assert app_row.last_error == "matrix_projection_failed"
    assert app_row.completed_steps == ["structure"]

    # Partial Matrix progress was durably recorded: 4 rooms converged, 1 failed (attempt #3 failed).
    assert Channel.objects.filter(workspace=ws, room_state=Channel.RoomState.READY).count() == 4
    assert Channel.objects.filter(workspace=ws, room_state=Channel.RoomState.FAILED).count() == 1
    assert len(homeserver.rooms) == 4
    initial_room_ids = dict(homeserver.aliases)
    assert Collection.objects.filter(workspace=ws).count() == 0
    assert Document.objects.filter(workspace=ws).count() == 0
    assert EngineChannelSet.objects.filter(organisation_id=org.id).count() == 1

    # Clear transient Synapse fault and resume with the exact same operation_key.
    homeserver.fail_on_create_attempts.clear()
    resumed = apply_workspace_template(
        organisation_id=org.id,
        template_id="tech-studio",
        operation_key=op_key,
        matrix_provisioner=provision,
        request_id="req-attempt-2",
    )

    assert resumed.state == WorkspaceTemplateApplication.State.COMPLETED
    assert resumed.replayed is False
    assert Category.objects.filter(workspace=ws).count() == 3
    assert Channel.objects.filter(workspace=ws).count() == 5
    assert Channel.objects.filter(workspace=ws, room_state=Channel.RoomState.READY).count() == 5
    assert len(homeserver.rooms) == 5
    # Already-created rooms kept their exact room IDs (zero duplicate rooms).
    for alias, room_id in initial_room_ids.items():
        assert homeserver.aliases[alias] == room_id
    # ChannelSet was reused rather than duplicated.
    assert EngineChannelSet.objects.filter(organisation_id=org.id).count() == 1
    assert Collection.objects.filter(workspace=ws, deleted_at__isnull=True).count() == 1
    assert Document.objects.filter(workspace=ws, deleted_at__isnull=True).count() == 2


def test_mid_flight_starter_docs_failure_resumes_idempotently_without_duplicate_docs_or_rows(
    tmp_path, native_engine
) -> None:
    org = _create_isolated_org("resumable-docs")
    subject = org.identity_set.values_list("subject", flat=True).get()
    homeserver = FakeHomeserver(users=(subject,))
    provision = _make_matrix_provisioner(
        tmp_path / "docs-resume", homeserver, active_subjects=(subject,)
    )
    op_key = "op-docs-midflight-01"

    def fail_on_second_doc(step: str, item: str) -> None:
        if step == "starter_docs" and item == "incident-runbook":
            raise RuntimeError("simulated collab engine timeout on second starter doc")

    with pytest.raises(RuntimeError, match="simulated collab engine timeout"):
        apply_workspace_template(
            organisation_id=org.id,
            template_id="tech-studio",
            operation_key=op_key,
            matrix_provisioner=provision,
            step_hook=fail_on_second_doc,
            request_id="req-docs-1",
        )

    ws = Workspace.objects.get(organisation=org)
    app_row = WorkspaceTemplateApplication.objects.get(workspace=ws, operation_key=op_key)
    assert app_row.state == WorkspaceTemplateApplication.State.FAILED
    assert app_row.last_error == "starter_docs_failed"
    assert app_row.completed_steps == ["structure", "matrix_projection", "collections"]
    assert Collection.objects.filter(workspace=ws, deleted_at__isnull=True).count() == 1
    first_docs = list(Document.objects.filter(workspace=ws, deleted_at__isnull=True))
    assert len(first_docs) == 1
    first_doc_id = first_docs[0].id
    assert app_row.artefacts["documents"] == {"product-handbook": str(first_doc_id)}
    assert CollectionRow.objects.filter(collection__workspace=ws).count() == 1

    # Resume without fault: first doc and collection row are reused, second doc is created cleanly.
    resumed = apply_workspace_template(
        organisation_id=org.id,
        template_id="tech-studio",
        operation_key=op_key,
        matrix_provisioner=provision,
        request_id="req-docs-2",
    )

    assert resumed.state == WorkspaceTemplateApplication.State.COMPLETED
    assert resumed.replayed is False
    assert resumed.document_ids["product-handbook"] == first_doc_id
    assert Category.objects.filter(workspace=ws).count() == 3
    assert Channel.objects.filter(workspace=ws).count() == 5
    assert len(homeserver.rooms) == 5
    assert Collection.objects.filter(workspace=ws, deleted_at__isnull=True).count() == 1
    assert CollectionRow.objects.filter(collection__workspace=ws).count() == 1
    assert Document.objects.filter(workspace=ws, deleted_at__isnull=True).count() == 2


def test_completed_replay_operation_key_conflict_and_legacy_alias_backward_compatibility(
    tmp_path,
) -> None:
    org = _create_isolated_org("alias-compat")
    subject = org.identity_set.values_list("subject", flat=True).get()
    homeserver = FakeHomeserver(users=(subject,))
    provision = _make_matrix_provisioner(
        tmp_path / "alias-compat", homeserver, active_subjects=(subject,)
    )

    # Legacy alias `crisis-cell` resolves to canonical `proximity`.
    first = apply_workspace_template(
        organisation_id=org.id,
        template_id="crisis-cell",
        operation_key="op-legacy-crisis-cell",
        matrix_provisioner=provision,
    )
    assert first.template_id == "proximity"
    assert first.replayed is False
    assert list(first.channel_ids) == ["proximity"]

    # Replaying with canonical `proximity` and same operation_key succeeds idempotently.
    replayed = apply_workspace_template(
        organisation_id=org.id,
        template_id="proximity",
        operation_key="op-legacy-crisis-cell",
        matrix_provisioner=provision,
    )
    assert replayed.replayed is True
    assert replayed.channel_ids == first.channel_ids
    assert EngineChannelSet.objects.filter(organisation_id=org.id).count() == 1

    # Reusing the same operation_key with a different template or customization is refused.
    with pytest.raises(TemplateOperationConflictError):
        apply_workspace_template(
            organisation_id=org.id,
            template_id="blank",
            operation_key="op-legacy-crisis-cell",
        )

    with pytest.raises(InvalidTemplateOperationError):
        apply_workspace_template(
            organisation_id=org.id,
            template_id="blank",
            operation_key="invalid key!",
        )


def test_template_ledger_enforces_sql_restrict_binding_cutoff_erasure_and_real_yjs_snapshots(
    tmp_path,
) -> None:
    from django.db import IntegrityError, connection, transaction
    from test_core_erasure import begin

    from apps.orgs.erasure_services import advance_erasure

    org = _create_isolated_org("erasure-tpl")
    other_org = _create_isolated_org("other-tpl")
    other_res = apply_workspace_template(
        organisation_id=other_org.id,
        template_id="blank",
        operation_key="op-other-blank",
    )

    # Without a configured Yjs collab engine, starter_docs refuses to write a dummy b"\x00\x00"
    # snapshot and checkpoints cleanly with closed ASCII error code `collab_engine_unavailable`.
    with pytest.raises(TemplateProvisioningStepError) as unavail_exc:
        apply_workspace_template(
            organisation_id=org.id,
            template_id="tech-studio",
            operation_key="op-unavail-engine",
        )
    assert unavail_exc.value.error_code == "collab_engine_unavailable"
    ws = Workspace.objects.get(organisation=org)
    app_row = WorkspaceTemplateApplication.objects.get(
        workspace=ws, operation_key="op-unavail-engine"
    )
    assert app_row.state == WorkspaceTemplateApplication.State.FAILED
    assert app_row.last_error == "collab_engine_unavailable"
    assert Document.objects.filter(workspace=ws).count() == 0
    assert DocumentSnapshot.objects.filter(document__workspace=ws).count() == 0

    # 1. Explicit PostgreSQL ON DELETE RESTRICT (`confdeltype = 'r'`, non-deferrable).
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT confdeltype, convalidated, condeferrable FROM pg_constraint "
            "WHERE conname = 'workspace_template_app_workspace_fk'"
        )
        assert cursor.fetchone() == ("r", True, False)

    # 2. Closed ASCII error-code check constraint refuses arbitrary exception prose / PII.
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkspaceTemplateApplication.objects.filter(pk=app_row.pk).update(
            last_error="RuntimeError: user@example.org failed"
        )

    # 3. `a_resource_binding` refuses relocating `workspace_id` or mutating `operation_key`.
    with (
        pytest.raises(IntegrityError, match="resource authority binding immutable"),
        transaction.atomic(),
    ):
        WorkspaceTemplateApplication.objects.filter(pk=app_row.pk).update(
            workspace_id=other_res.workspace_id
        )
    with (
        pytest.raises(IntegrityError, match="resource authority binding immutable"),
        transaction.atomic(),
    ):
        WorkspaceTemplateApplication.objects.filter(pk=app_row.pk).update(
            operation_key="op-mutated"
        )

    # 4. `aa_privacy_cutoff` refuses writes after organisation erasure cutoff, and `advance_erasure`
    #    purges `WorkspaceTemplateApplication` rows cleanly under worker authority.
    erasure = begin(org)
    with pytest.raises(IntegrityError, match="durable erasure cutoff"), transaction.atomic():
        WorkspaceTemplateApplication.objects.filter(pk=app_row.pk).update(last_error="")
    with pytest.raises(IntegrityError, match="durable erasure cutoff"), transaction.atomic():
        WorkspaceTemplateApplication.objects.create(
            workspace=ws,
            operation_key="op-after-cutoff",
            template_id="blank",
            template_version=2,
            spec_fingerprint="a" * 64,
        )

    result = advance_erasure(erasure.id, {})
    assert result["core_purged"] is True
    assert not WorkspaceTemplateApplication.objects.filter(workspace=ws).exists()
    # Unrelated organisation's ledger row is untouched.
    assert WorkspaceTemplateApplication.objects.filter(workspace_id=other_res.workspace_id).exists()


def test_v2_operation_key_matches_warm_pool_and_resumes_starter_docs_across_http(
    settings, http_signer
) -> None:
    import json
    import time

    from customer_http_fixtures import configure, token, trust_entry
    from django.test import Client

    from apps.workspaces.models import WarmPoolAllocation
    from apps.workspaces.warm_pool import build_instant_claim_plan, parse_instant_claim_request

    path = "/api/v1/workspaces/instant-claim"
    models = anchor_models()
    suffix = uuid4().hex[:6]
    slug = f"http-{suffix}"
    org, _, owners = anchor(models, slug=slug)
    now = int(time.time())
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now + 600)])
    subject = f"owner-{suffix}"
    identity(models, org, owners[0].user, subject=subject)
    realm_job(org, "succeeded")
    commit_order(org.id, org.issuer, subject)
    cred = token(http_signer, org.issuer, subject=subject, iat=now, exp=now + 300)

    # Prepare warm-pool allocation WITHOUT `operationKey`.
    base_payload = {
        "organizationName": "Studio HTTP v2",
        "slug": slug,
        "hostingMode": "cloud",
        "templateId": "tech-studio",
    }
    plan = build_instant_claim_plan(parse_instant_claim_request(json.dumps(base_payload).encode()))
    workspace = Workspace.objects.create(organisation=org)
    categories = {
        c["key"]: Category.objects.create(
            workspace=workspace,
            name=c["name"],
            template_key=c["db_template_key"],
            position=c["position"],
        )
        for c in plan["categories"]
    }
    for ch in plan["channels"]:
        vals = {
            k: v
            for k, v in ch.items()
            if k not in {"category_key", "db_template_key", "template_key"}
        }
        Channel.objects.create(
            workspace=workspace,
            category=categories[ch["category_key"]],
            template_key=ch["db_template_key"],
            room_state="ready",
            **vals,
        )
    allocation = WarmPoolAllocation.objects.create(
        workspace=workspace,
        slug=slug,
        plan=plan,
        workspace_url=f"https://{slug}.example.org",
        invitation_url=f"https://{slug}.example.org/invite?signed=synthetic",
        offer_mode="cloud-shared",
    )

    client = Client()
    claim_payload = {**base_payload, "operationKey": "http-claim-tech-studio-v2"}
    idem_key = "00000000-0000-4000-8000-000000009901"
    auth_header = f"Bearer {cred}"

    # 1. With Yjs collab engine unconfigured, HTTP returns transient 503 `warm_pool_unavailable`
    #    (not cached in idempotency store) while checkpointing structure + collections cleanly.
    settings.KODERA_COLLAB_ENGINE_URL = None
    first = client.post(
        path,
        json.dumps(claim_payload),
        content_type="application/json",
        HTTP_AUTHORIZATION=auth_header,
        HTTP_IDEMPOTENCY_KEY=idem_key,
    )
    assert not conformance_errors(first, "/workspaces/instant-claim", "post")
    assert first.status_code == 503
    assert first.json()["code"] == "warm_pool_unavailable"
    allocation.refresh_from_db()
    assert allocation.claimed_at is None

    app_row = WorkspaceTemplateApplication.objects.get(
        workspace=workspace, operation_key="http-claim-tech-studio-v2"
    )
    assert app_row.state == WorkspaceTemplateApplication.State.FAILED
    assert app_row.last_error == "collab_engine_unavailable"
    assert app_row.completed_steps == ["structure", "matrix_projection", "collections"]
    assert Collection.objects.filter(workspace=workspace, deleted_at__isnull=True).count() == 1
    assert Document.objects.filter(workspace=workspace).count() == 0

    # 2. Start real Yjs collab engine and retry with the EXACT SAME Idempotency-Key & operationKey!
    gen = _native_engine(settings)
    next(gen)
    try:
        second = client.post(
            path,
            json.dumps(claim_payload),
            content_type="application/json",
            HTTP_AUTHORIZATION=auth_header,
            HTTP_IDEMPOTENCY_KEY=idem_key,
        )
        assert not conformance_errors(second, "/workspaces/instant-claim", "post")
        assert second.status_code == 201
        assert second.json()["workspaceId"] == str(workspace.id)
        allocation.refresh_from_db()
        assert allocation.claimed_at is not None

        app_row.refresh_from_db()
        assert app_row.state == WorkspaceTemplateApplication.State.COMPLETED
        assert app_row.last_error == ""
        assert Channel.objects.filter(workspace=workspace).count() == 5
        assert Collection.objects.filter(workspace=workspace, deleted_at__isnull=True).count() == 1
        docs = list(Document.objects.filter(workspace=workspace, deleted_at__isnull=True))
        assert len(docs) == 2
        for doc in docs:
            snap = DocumentSnapshot.objects.get(document=doc)
            assert len(bytes(snap.state)) > 2

        # 3. Replaying the same Idempotency-Key replays 201, and reusing the same operationKey
        #    with a different template under a new Idempotency-Key returns 409 conflict.
        replay = client.post(
            path,
            json.dumps(claim_payload),
            content_type="application/json",
            HTTP_AUTHORIZATION=auth_header,
            HTTP_IDEMPOTENCY_KEY=idem_key,
        )
        assert replay.status_code == 201
        assert replay["Idempotency-Replayed"] == "true"

        conflict = client.post(
            path,
            json.dumps({**claim_payload, "templateId": "blank"}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {cred}",
            HTTP_IDEMPOTENCY_KEY="00000000-0000-4000-8000-000000009902",
        )
        assert not conformance_errors(conflict, "/workspaces/instant-claim", "post")
        assert conflict.status_code == 409
    finally:
        try:
            next(gen)
        except StopIteration:
            pass


def test_http_claim_attributes_to_submitting_owner_among_two_owners_and_refuses_demoted_caller(
    settings, http_signer, monkeypatch
) -> None:
    import json
    import time

    from customer_http_fixtures import configure, token, trust_entry
    from django.test import Client

    import apps.workspaces.api.instant_claim as instant_claim_api
    from apps.audit.models import AuditEvent
    from apps.workspaces.models import WarmPoolAllocation
    from apps.workspaces.services import TemplateActorForbiddenError
    from apps.workspaces.warm_pool import build_instant_claim_plan, parse_instant_claim_request

    path = "/api/v1/workspaces/instant-claim"
    models = anchor_models()
    suffix = uuid4().hex[:6]
    slug = f"twoown-{suffix}"
    org, _, owners = anchor(models, slug=slug, owners=2)
    assert len(owners) == 2
    owner_first, owner_submitting = sorted(owners, key=lambda m: str(m.id))
    assert str(owner_first.id) < str(owner_submitting.id)

    now = int(time.time())
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now + 600)])
    id_first = identity(models, org, owner_first.user, subject=f"owner-a-{suffix}")
    id_submitting = identity(models, org, owner_submitting.user, subject=f"owner-b-{suffix}")
    realm_job(org, "succeeded")
    commit_order(org.id, org.issuer, id_submitting.subject)
    cred_submitting = token(
        http_signer, org.issuer, subject=id_submitting.subject, iat=now, exp=now + 300
    )

    def _seed_warm_allocation(target_org: Organisation, target_slug: str):
        base = {
            "organizationName": "Two Owners Studio",
            "slug": target_slug,
            "hostingMode": "cloud",
            "templateId": "tech-studio",
        }
        plan = build_instant_claim_plan(parse_instant_claim_request(json.dumps(base).encode()))
        ws = Workspace.objects.create(organisation=target_org)
        cats = {
            c["key"]: Category.objects.create(
                workspace=ws,
                name=c["name"],
                template_key=c["db_template_key"],
                position=c["position"],
            )
            for c in plan["categories"]
        }
        for ch in plan["channels"]:
            vals = {
                k: v
                for k, v in ch.items()
                if k not in {"category_key", "db_template_key", "template_key"}
            }
            Channel.objects.create(
                workspace=ws,
                category=cats[ch["category_key"]],
                template_key=ch["db_template_key"],
                room_state="ready",
                **vals,
            )
        alloc = WarmPoolAllocation.objects.create(
            workspace=ws,
            slug=target_slug,
            plan=plan,
            workspace_url=f"https://{target_slug}.example.org",
            invitation_url=f"https://{target_slug}.example.org/invite?signed=synthetic",
            offer_mode="cloud-shared",
        )
        return base, ws, alloc

    base_payload, workspace, allocation = _seed_warm_allocation(org, slug)
    client = Client()

    gen = _native_engine(settings)
    next(gen)
    try:
        # 1. Submitting as `owner_submitting` (with the larger membership UUID) attributes all
        #    starter collections, starter documents, and audit events to `owner_submitting`.
        res = client.post(
            path,
            json.dumps({**base_payload, "operationKey": "op-two-owners-submit"}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {cred_submitting}",
            HTTP_IDEMPOTENCY_KEY="00000000-0000-4000-8000-000000009911",
        )
        assert not conformance_errors(res, "/workspaces/instant-claim", "post")
        assert res.status_code == 201
        allocation.refresh_from_db()
        assert allocation.claimed_at is not None

        cols = list(Collection.objects.filter(workspace=workspace, deleted_at__isnull=True))
        docs = list(Document.objects.filter(workspace=workspace, deleted_at__isnull=True))
        assert len(cols) == 1 and len(docs) == 2
        assert all(c.creator_id == owner_submitting.id for c in cols)
        assert all(d.creator_id == owner_submitting.id for d in docs)
        assert all(c.creator_id != owner_first.id for c in cols)

        audit_actors = list(
            AuditEvent.objects.filter(
                organisation_id=org.id,
                action__in=["workspace.collection.created", "workspace.document.created"],
            ).values_list("actor_id", flat=True)
        )
        assert len(audit_actors) == 3
        assert set(audit_actors) == {id_submitting.id}
        assert id_first.id not in audit_actors

        # 2. A caller demoted from `org_owner` to `org_admin` right after initial `authorise_instant_claim`
        #    is refused under lock with 403 forbidden and zero DB/Docs/ledger writes.
        slug2 = f"demote-{suffix}"
        org2, _, owners2 = anchor(models, slug=slug2, owners=2)
        configure(
            settings,
            [
                trust_entry(http_signer, org.issuer, expires_at=now + 600),
                trust_entry(http_signer, org2.issuer, expires_at=now + 600),
            ],
        )
        demoted_member = owners2[1]
        id_demoted = identity(models, org2, demoted_member.user, subject=f"demote-{suffix}")
        identity(models, org2, owners2[0].user, subject=f"stay-owner-{suffix}")
        realm_job(org2, "succeeded")
        commit_order(org2.id, org2.issuer, id_demoted.subject)
        cred_demoted = token(
            http_signer, org2.issuer, subject=id_demoted.subject, iat=now, exp=now + 300
        )
        base2, ws2, alloc2 = _seed_warm_allocation(org2, slug2)

        from apps.workspaces.instant_claim import authorise_instant_claim as real_authorise

        def _demote_after_precheck(verified_tok):
            resolved_org_id = real_authorise(verified_tok)
            models.Membership.objects.filter(pk=demoted_member.pk).update(role="org_admin")
            return resolved_org_id

        monkeypatch.setattr(instant_claim_api, "authorise_instant_claim", _demote_after_precheck)
        denied = client.post(
            path,
            json.dumps({**base2, "operationKey": "op-demoted-race"}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {cred_demoted}",
            HTTP_IDEMPOTENCY_KEY="00000000-0000-4000-8000-000000009912",
        )
        monkeypatch.setattr(instant_claim_api, "authorise_instant_claim", real_authorise)

        assert not conformance_errors(denied, "/workspaces/instant-claim", "post")
        assert denied.status_code == 403
        assert denied.json()["type"].endswith("/forbidden")
        alloc2.refresh_from_db()
        assert alloc2.claimed_at is None
        assert WorkspaceTemplateApplication.objects.filter(workspace=ws2).count() == 0
        assert Collection.objects.filter(workspace=ws2).count() == 0
        assert Document.objects.filter(workspace=ws2).count() == 0

        # 3. Restore org_owner and verify mid-flight demotion between checkpoints in
        #    `apply_workspace_template` also refuses under lock before starter_docs writes,
        #    leaving `WorkspaceTemplateApplication` state untouched (`in_progress`, not overwritten).
        models.Membership.objects.filter(pk=demoted_member.pk).update(role="org_owner")

        def _demote_before_docs(step: str, item: str) -> None:
            if step == "starter_docs":
                models.Membership.objects.filter(pk=demoted_member.pk).update(role="org_admin")

        with pytest.raises(TemplateActorForbiddenError):
            apply_workspace_template(
                organisation_id=org2.id,
                template_id="tech-studio",
                operation_key="op-midflight-demote",
                creator_membership_id=demoted_member.id,
                actor_identity_id=id_demoted.id,
                step_hook=_demote_before_docs,
            )
        assert Document.objects.filter(workspace=ws2).count() == 0
        mid_app = WorkspaceTemplateApplication.objects.get(
            workspace=ws2, operation_key="op-midflight-demote"
        )
        assert mid_app.state == WorkspaceTemplateApplication.State.IN_PROGRESS
        assert mid_app.last_error == ""

        # 4. External-step failure concurrent with caller demotion re-verifies caller authority
        #    in the failure handler before mutating `WorkspaceTemplateApplication`, raising
        #    `TemplateActorForbiddenError` with zero ledger failure-state mutation.
        models.Membership.objects.filter(pk=demoted_member.pk).update(role="org_owner")

        def _failing_provisioner_with_demotion(_snap):
            models.Membership.objects.filter(pk=demoted_member.pk).update(role="org_admin")
            raise RuntimeError("matrix rpc timeout after concurrent demotion")

        with pytest.raises(TemplateActorForbiddenError):
            apply_workspace_template(
                organisation_id=org2.id,
                template_id="tech-studio",
                operation_key="op-external-fail-demote",
                creator_membership_id=demoted_member.id,
                actor_identity_id=id_demoted.id,
                matrix_provisioner=_failing_provisioner_with_demotion,
            )
        ext_app = WorkspaceTemplateApplication.objects.get(
            workspace=ws2, operation_key="op-external-fail-demote"
        )
        assert ext_app.state == WorkspaceTemplateApplication.State.IN_PROGRESS
        assert ext_app.last_error == ""
    finally:
        try:
            next(gen)
        except StopIteration:
            pass
