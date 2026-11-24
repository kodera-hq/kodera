"""SQL query-count invariance (O(1)) and < 64 KiB HTTP JSON page byte-budget regressions."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.db import connection, transaction
from django.test import Client
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_billing_evidence_persistence import SyntheticValidator
from test_billing_orders import CGV, documents_published, verified
from test_workspace_onboarding import w as w
from workspace_safety.test_moderation import world as world

from apps.billing import catalogue, services as billing_services
from apps.billing.actors import Actor
from apps.billing.artifacts import metadata as artifact_metadata, publish
from apps.billing.integrity import IntegrityRefusedError
from apps.billing.models import (
    BillingArtifact,
    CapacityTier,
    Invoice,
    InvoiceLine,
    Pack,
    Plan,
    Price,
)
from apps.billing.services import Agreements, OrderRequest, TenantRequest
from apps.docs import collections
from apps.docs.models import CollectionRow, Document, DocumentGrant, DocumentSnapshot
from apps.e2ee import services as e2ee_services
from apps.e2ee.models import Envelope, Room
from apps.identity.models import Identity, User
from apps.legal import services as legal
from apps.notifications import services as notifications_service
from apps.orgs.models import Invitation, Membership
from apps.orgs.selectors import digest_member
from apps.workspaces.models import (
    Category,
    Channel,
    ResourcePolicy,
    ResourcePolicyRule,
    Workspace,
    WorkspaceAbuseReport,
    WorkspaceChannelRoleOverride,
    WorkspaceInviteLink,
    WorkspaceMemberRestriction,
    WorkspaceMemberRole,
    WorkspaceRole,
)
from apps.workspaces.selectors import digest_workspace, passport_unrestricted_workspaces

pytestmark = pytest.mark.django_db(transaction=True)

HTTP_BYTE_CEILING = 65_536


class LargeSyntheticRenderer:
    """Synthetic storage fixture emitting a 32 KiB PDF payload to verify deferred blob reads."""

    def render(self, snapshot, xml):
        return (
            b"%PDF-synthetic-storage-fixture\n" + snapshot.sha256.encode() + b"\n" + (b"P" * 32_768)
        )


def _auth(credential: str, **extra: str) -> dict[str, str]:
    return {"HTTP_AUTHORIZATION": "Bearer " + credential, **extra}


def _capture_sql(fn):
    with CaptureQueriesContext(connection) as ctx:
        result = fn()
        sqls = [entry["sql"] for entry in ctx]
    assert len(sqls) > 0
    return result, sqls


def _place_and_credit_order(
    organisation,
    *,
    owner_subject: str,
    owner_identity_id: UUID,
    owner_person_id: UUID,
    index: int,
    extra_lines: int = 0,
    line_padding: str = "",
    publish_artifacts: bool = True,
):
    owner_verified = verified(organisation.issuer, owner_subject)
    dpa, _ = legal.generate_dpa(
        verified=owner_verified,
        organisation_id=organisation.id,
        pack_code="visio",
        locale="fr",
        tenant_id=None,
    )
    placed = billing_services.place_order(
        verified=owner_verified,
        organisation_id=organisation.id,
        idempotency_key=f"koderaperf-order-key-{index:05d}",
        request=OrderRequest(
            pack_code="visio",
            capacity_tier_code="S",
            billing_period="monthly",
            tenant=TenantRequest(slug=f"kp{index:04d}{uuid4().hex[:8]}", name="Perf Tenant"),
            agreements=Agreements(dpa_id=dpa.id, documents=(CGV,)),
        ),
        request_id=f"req-place-{index:05d}",
    )
    invoice = placed.invoice
    if extra_lines or line_padding:
        # Add extra lines on a separate draft-then-issued invoice when testing large line payloads.
        draft = Invoice.objects.create(
            organisation_id=organisation.id,
            vat_regime="fr_standard",
            issuer_legal_name="Issuer of Test Invoices SAS",
            issuer_address="1 rue de l'Exemple, 75000 Paris",
            issuer_country="FR",
            issuer_siren="000000000",
            issuer_vat_number="FR00000000000",
            customer_legal_name="Synthetic Customer SAS",
            customer_address_line1="1 rue Synthétique",
            customer_postal_code="75000",
            customer_city="Paris",
            customer_country="FR",
            total_excl_vat_minor=1_000 * max(1, extra_lines),
            vat_amount_minor=200 * max(1, extra_lines),
            total_incl_vat_minor=1_200 * max(1, extra_lines),
            issued_at=timezone.now(),
            due_at=timezone.now() + timedelta(days=30),
        )
        now = timezone.now()
        InvoiceLine.objects.bulk_create(
            [
                InvoiceLine(
                    invoice=draft,
                    position=pos,
                    description=f"Line {pos} {line_padding}",
                    plan_code="essentiel",
                    plan_version=1,
                    pack_code="visio",
                    capacity_tier_code="S",
                    quantity=1,
                    unit_amount_minor=1_000,
                    total_excl_vat_minor=1_000,
                    vat_rate_bp=2_000,
                    vat_amount_minor=200,
                    period_start=now,
                    period_end=now + timedelta(days=30),
                )
                for pos in range(1, max(1, extra_lines) + 1)
            ]
        )
        draft.number = f"KJP-2026-{index:05d}"
        draft.state = "issued"
        draft.save(update_fields=["number", "state", "updated_at"])

    actor = Actor("tenant", owner_identity_id, f"req-cancel-{index:05d}")
    with transaction.atomic():
        billing_services._cancel(
            placed.order.id,
            actor=actor,
            reason="customer",
        )
    invoice.refresh_from_db()
    note = invoice.credit_notes.get()
    if publish_artifacts:
        renderer = LargeSyntheticRenderer()
        validator = SyntheticValidator()
        publish(
            document_id=invoice.id,
            credit_note=False,
            renderer=renderer,
            validator=validator,
            validator_ref="synthetic-koderaperf-storage-fixture",
        )
        publish(
            document_id=note.id,
            credit_note=True,
            renderer=renderer,
            validator=validator,
            validator_ref="synthetic-koderaperf-storage-fixture",
        )
    return placed.order, invoice, note


def test_billing_invoices_credit_notes_and_orders_scale_in_constant_queries(
    w, django_assert_max_num_queries
):
    from billing_fiscal_fixtures import register_test_fiscal_periods

    register_test_fiscal_periods()
    documents_published()
    catalogue.load(catalogue.read(catalogue.PLACEHOLDER), allow_placeholder=True)
    billing_services.set_billing_profile(
        organisation_id=w.alpha.id,
        legal_name="Synthetic Customer SAS",
        address_line1="1 rue Synthétique",
        postal_code="75000",
        city="Paris",
        country="FR",
    )
    owner_identity = Identity.objects.get(issuer=w.alpha.issuer, subject="alpha-owner")

    notes = []
    for idx in range(1, 4):
        _, _, note = _place_and_credit_order(
            w.alpha,
            owner_subject="alpha-owner",
            owner_identity_id=owner_identity.id,
            owner_person_id=owner_identity.user_id,
            index=idx,
        )
        notes.append(note)

    headers = _auth(w.owner.credential)
    # Warm URL resolver and measure exact query counts at N=3.
    w.client.get(f"/api/v1/organisations/{w.alpha.id}/invoices?limit=50", **headers)

    resp, inv_3_sql = _capture_sql(
        lambda: w.client.get(f"/api/v1/organisations/{w.alpha.id}/invoices?limit=50", **headers)
    )
    assert resp.status_code == 200 and len(resp.json()["data"]) == 3
    assert all(item["xml_available"] is True for item in resp.json()["data"])

    resp, cn_3_sql = _capture_sql(
        lambda: w.client.get(f"/api/v1/organisations/{w.alpha.id}/credit-notes?limit=50", **headers)
    )
    assert resp.status_code == 200 and len(resp.json()["data"]) == 3

    resp, ord_3_sql = _capture_sql(
        lambda: w.client.get(f"/api/v1/organisations/{w.alpha.id}/orders?limit=50", **headers)
    )
    assert resp.status_code == 200 and len(resp.json()["data"]) == 3

    # Scale from 3 -> 25 rows (22 additional orders, invoices, credit notes, and 64 KiB artifact pairs).
    for idx in range(4, 26):
        _, _, note = _place_and_credit_order(
            w.alpha,
            owner_subject="alpha-owner",
            owner_identity_id=owner_identity.id,
            owner_person_id=owner_identity.user_id,
            index=idx,
        )
        notes.append(note)

    with django_assert_max_num_queries(len(inv_3_sql)):
        resp_inv, inv_25_sql = _capture_sql(
            lambda: w.client.get(f"/api/v1/organisations/{w.alpha.id}/invoices?limit=50", **headers)
        )
    assert resp_inv.status_code == 200 and len(resp_inv.json()["data"]) == 25
    assert len(inv_25_sql) == len(inv_3_sql) <= 12

    with django_assert_max_num_queries(len(cn_3_sql)):
        resp_cn, cn_25_sql = _capture_sql(
            lambda: w.client.get(
                f"/api/v1/organisations/{w.alpha.id}/credit-notes?limit=50", **headers
            )
        )
    assert resp_cn.status_code == 200 and len(resp_cn.json()["data"]) == 25
    assert len(cn_25_sql) == len(cn_3_sql) <= 12

    with django_assert_max_num_queries(12):
        resp_detail, cn_detail_sql = _capture_sql(
            lambda: w.client.get(f"/api/v1/credit-notes/{notes[-1].id}", **headers)
        )
    assert resp_detail.status_code == 200 and resp_detail.json()["id"] == str(notes[-1].id)

    with django_assert_max_num_queries(len(ord_3_sql)):
        resp_ord, ord_25_sql = _capture_sql(
            lambda: w.client.get(f"/api/v1/organisations/{w.alpha.id}/orders?limit=50", **headers)
        )
    assert resp_ord.status_code == 200 and len(resp_ord.json()["data"]) == 25
    assert len(ord_25_sql) == len(ord_3_sql) <= 10

    # Verify raw pdf/xml bytea columns were deferred (never pulled outside LENGTH(...)).
    for captured_sqls in (inv_25_sql, cn_25_sql, cn_detail_sql):
        artifact_sql = [sql for sql in captured_sqls if "billing_billingartifact" in sql]
        assert len(artifact_sql) == 1
        sql_text = artifact_sql[0]
        assert 'LENGTH("billing_billingartifact"."pdf")' in sql_text
        assert 'SELECT "billing_billingartifact"."id"' in sql_text
        select_clause = sql_text.split(" FROM ", 1)[0]
        stripped = select_clause.replace('LENGTH("billing_billingartifact"."pdf")', "").replace(
            'LENGTH("billing_billingartifact"."xml")', ""
        )
        assert '"billing_billingartifact"."pdf"' not in stripped
        assert '"billing_billingartifact"."xml"' not in stripped

    # Verify snapshot_sha256 tamper detection still fires on prefetched artifact metadata.
    sample_invoice = (
        Invoice.objects.filter(organisation_id=w.alpha.id).exclude(state="draft").first()
    )
    assert sample_invoice is not None
    tampered = BillingArtifact(
        invoice_id=sample_invoice.id,
        snapshot_sha256="0" * 64,
        pdf_sha256="1" * 64,
        xml_sha256="2" * 64,
        validator_ref="tampered",
    )
    sample_invoice._state.fields_cache["billingartifact"] = tampered
    with pytest.raises(IntegrityRefusedError, match="billing_artifact_digest_mismatch"):
        artifact_metadata(sample_invoice)


def test_billing_catalogue_plans_and_packs_scale_in_constant_queries(
    w, django_assert_max_num_queries
):
    now = timezone.now()
    tier, _ = CapacityTier.objects.get_or_create(
        code="S",
        defaults={
            "name": "Small",
            "seats_included": 10,
            "concurrent_participants_included": 10,
            "storage_included_bytes": 10_000_000,
            "vm_shape": "DEV1-S",
            "available": True,
        },
    )

    def seed_catalogue(start: int, stop: int) -> None:
        for idx in range(start, stop):
            plan = Plan.objects.create(
                code=f"plan-{idx:03d}",
                version=1,
                name=f"Plan {idx}",
                state="published",
                published_at=now - timedelta(days=1),
            )
            pack = Pack.objects.create(
                code=f"pack-{idx:03d}",
                name=f"Pack {idx}",
                apps=["visio"],
                profile_ref="standard",
                available=True,
            )
            Price.objects.create(
                plan=plan,
                pack=pack,
                capacity_tier=tier,
                billing_period="monthly",
                amount_minor=10_000 + idx,
                valid_from=now - timedelta(hours=1),
            )

    seed_catalogue(1, 4)
    w.client.get("/api/v1/catalog/plans?limit=50")
    r_plans_3, plans_3_sql = _capture_sql(lambda: w.client.get("/api/v1/catalog/plans?limit=50"))
    assert r_plans_3.status_code == 200 and len(r_plans_3.json()["data"]) == 3
    r_packs_3, packs_3_sql = _capture_sql(lambda: w.client.get("/api/v1/catalog/packs?limit=50"))
    assert r_packs_3.status_code == 200 and len(r_packs_3.json()["data"]) == 3

    seed_catalogue(4, 26)
    with django_assert_max_num_queries(len(plans_3_sql)):
        r_plans_25, plans_25_sql = _capture_sql(
            lambda: w.client.get("/api/v1/catalog/plans?limit=50")
        )
    assert r_plans_25.status_code == 200 and len(r_plans_25.json()["data"]) == 25
    assert len(plans_25_sql) == len(plans_3_sql) == 2

    with django_assert_max_num_queries(len(packs_3_sql)):
        r_packs_25, packs_25_sql = _capture_sql(
            lambda: w.client.get("/api/v1/catalog/packs?limit=50")
        )
    assert r_packs_25.status_code == 200 and len(r_packs_25.json()["data"]) == 25
    assert len(packs_25_sql) == len(packs_3_sql) == 2


def test_notifications_inbox_scales_in_constant_queries_and_preserves_visibility_semantics(
    world, http_signer, frozen_clock, settings, django_assert_max_num_queries
):
    org, workspace, members, tokens = world
    configure(settings, [trust_entry(http_signer, org.issuer)])
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    client = Client(HTTP_HOST="127.0.0.1")
    member_cred = token(http_signer, org.issuer, subject=tokens[3].subject, email_verified=True)
    unknown_cred = token(
        http_signer, org.issuer, subject="unknown-unverified-session", email_verified=False
    )

    default_policy = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    Workspace.objects.filter(pk=workspace.id).update(default_policy=default_policy)

    restricted_allowed_policy = ResourcePolicy.objects.create(
        workspace=workspace, visibility="restricted"
    )
    ResourcePolicyRule.objects.create(
        policy=restricted_allowed_policy, kind="allow_member", membership=members[3]
    )
    restricted_denied_policy = ResourcePolicy.objects.create(
        workspace=workspace, visibility="restricted"
    )

    allowed_private_chan = Channel.objects.create(
        workspace=workspace,
        name="confidential-allowed",
        kind="text",
        lifecycle="active",
        position=100,
        policy_mode="explicit",
        explicit_policy=restricted_allowed_policy,
        is_confidential=True,
    )
    denied_private_chan = Channel.objects.create(
        workspace=workspace,
        name="confidential-denied",
        kind="text",
        lifecycle="active",
        position=101,
        policy_mode="explicit",
        explicit_policy=restricted_denied_policy,
        is_confidential=True,
    )

    granted_doc = Document.objects.create(
        workspace=workspace,
        creator=members[0],
        title="Granted Restricted Doc",
        visibility="restricted",
    )
    DocumentSnapshot.objects.create(document=granted_doc, state=b"s")
    DocumentGrant.objects.create(document=granted_doc, membership=members[3], role="viewer")

    hidden_doc = Document.objects.create(
        workspace=workspace,
        creator=members[0],
        title="Hidden Restricted Doc",
        visibility="restricted",
    )
    DocumentSnapshot.objects.create(document=hidden_doc, state=b"s")

    deleted_doc = Document.objects.create(
        workspace=workspace,
        creator=members[3],
        title="Deleted Doc",
        deleted_at=timezone.now(),
        purge_after=timezone.now() + timedelta(days=30),
    )
    DocumentSnapshot.objects.create(document=deleted_doc, state=b"s")

    def seed_notifications(start: int, stop: int) -> list[UUID]:
        expected: list[UUID] = []
        with transaction.atomic():
            for idx in range(start, stop):
                ch = Channel.objects.create(
                    workspace=workspace,
                    name=f"mention-chan-{idx:03d}",
                    kind="text",
                    lifecycle="active",
                    position=200 + idx,
                )
                doc = Document.objects.create(
                    workspace=workspace,
                    creator=members[0],
                    title=f"Notif Doc {idx:03d}",
                    visibility="workspace",
                )
                DocumentSnapshot.objects.create(document=doc, state=b"s")
                n_mention = notifications_service.record(
                    organisation_id=org.id,
                    membership_id=members[3].id,
                    kind="mention",
                    resource_id=ch.id,
                )
                n_doc = notifications_service.record(
                    organisation_id=org.id,
                    membership_id=members[3].id,
                    kind="document",
                    resource_id=doc.id,
                )
                expected.extend([n_mention.id, n_doc.id])
        return expected

    # Warm up and verify 3-pair batch (6 rows: 3 mentions + 3 docs).
    seed_notifications(0, 2)
    with transaction.atomic():
        n_priv_ok = notifications_service.record(
            organisation_id=org.id,
            membership_id=members[3].id,
            kind="mention",
            resource_id=allowed_private_chan.id,
        )
        notifications_service.record(
            organisation_id=org.id,
            membership_id=members[3].id,
            kind="mention",
            resource_id=denied_private_chan.id,
        )
        notifications_service.record(
            organisation_id=org.id,
            membership_id=members[3].id,
            kind="mention",
            resource_id=uuid4(),
        )
        n_doc_ok = notifications_service.record(
            organisation_id=org.id,
            membership_id=members[3].id,
            kind="document",
            resource_id=granted_doc.id,
        )
        notifications_service.record(
            organisation_id=org.id,
            membership_id=members[3].id,
            kind="document",
            resource_id=hidden_doc.id,
        )
        notifications_service.record(
            organisation_id=org.id,
            membership_id=members[3].id,
            kind="document",
            resource_id=deleted_doc.id,
        )

    # Unknown/unverified caller gate is preserved (403 identity-unknown).
    unknown_resp = client.get("/api/v1/notifications?limit=50", **_auth(unknown_cred))
    assert unknown_resp.status_code == 403

    client.get("/api/v1/notifications?limit=50", **_auth(member_cred))
    resp_small, inbox_small_sql = _capture_sql(
        lambda: client.get("/api/v1/notifications?limit=50", **_auth(member_cred))
    )
    assert resp_small.status_code == 200
    small_ids = {UUID(item["id"]) for item in resp_small.json()["data"]}
    assert n_priv_ok.id in small_ids and n_doc_ok.id in small_ids
    assert (
        len(small_ids) == 6
    )  # 2 public mentions + 2 public docs + 1 allowed private + 1 granted doc

    # Scale up by +25 additional channels & documents (50 more notifications -> limit=50 full page!).
    seed_notifications(2, 27)
    with django_assert_max_num_queries(len(inbox_small_sql)):
        resp_large, inbox_large_sql = _capture_sql(
            lambda: client.get("/api/v1/notifications?limit=50", **_auth(member_cred))
        )
    assert resp_large.status_code == 200
    assert len(resp_large.json()["data"]) == 50
    assert resp_large.json()["has_more"] is True
    assert len(inbox_large_sql) == len(inbox_small_sql)
    selects_only = [
        sql for sql in inbox_large_sql if not sql.startswith(("SAVEPOINT", "RELEASE SAVEPOINT"))
    ]
    assert len(selects_only) <= 35


def test_memberships_workspace_roles_and_get_workspace_scale_in_constant_queries(
    world, http_signer, frozen_clock, settings, django_assert_max_num_queries
):
    org, workspace, members, tokens = world
    configure(settings, [trust_entry(http_signer, org.issuer)])
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    settings.KODERA_MEMBERSHIP_CURSOR_KEY = "17" * 32
    client = Client(HTTP_HOST="127.0.0.1")
    owner_cred = token(http_signer, org.issuer, subject=tokens[0].subject, email_verified=True)
    headers = _auth(owner_cred)

    default_policy = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    Workspace.objects.filter(pk=workspace.id).update(default_policy=default_policy)

    roles = [
        WorkspaceRole.objects.create(
            workspace=workspace,
            organisation_id=org.id,
            name=f"Role {idx}",
            slug=f"role-{idx}",
            position=idx + 1,
            permissions=["channel.view", "message.post"],
        )
        for idx in range(3)
    ]
    cat = Category.objects.create(workspace=workspace, name="General", position=0)
    for idx in range(3):
        ch = Channel.objects.create(
            workspace=workspace,
            category=cat,
            name=f"ws-chan-{idx}",
            kind="text",
            lifecycle="active",
            position=idx,
        )
        WorkspaceChannelRoleOverride.objects.create(
            workspace=workspace,
            channel=ch,
            role=roles[0],
            allow=["channel.view"],
            deny=[],
        )

    now = timezone.now()

    def add_members(start: int, stop: int) -> None:
        for idx in range(start, stop):
            u = User.objects.create(
                email=f"scale-member-{idx:04d}@alpha.test",
                display_name=f"Member {idx:04d}",
                enabled=True,
            )
            Identity.objects.create(
                user=u,
                organisation=org,
                issuer=org.issuer,
                realm=org.realm,
                subject=f"scale-sub-{idx:04d}",
                email=u.email,
                enabled=True,
            )
            m = Membership.objects.create(
                user=u,
                organisation=org,
                role="org_member",
                state="active",
                accepted_at=now,
            )
            WorkspaceMemberRole.objects.create(
                workspace=workspace, membership=m, role=roles[idx % 3]
            )

    add_members(0, 3)
    # Warm up routes
    client.get(f"/api/v1/organisations/{org.id}/memberships?limit=50", **headers)
    client.get(f"/api/v1/organisations/{org.id}/workspace/roles", **headers)
    client.get(f"/api/v1/organisations/{org.id}/workspace", **headers)

    r, mem_3_sql = _capture_sql(
        lambda: client.get(f"/api/v1/organisations/{org.id}/memberships?limit=50", **headers)
    )
    assert r.status_code == 200
    r, roles_3_sql = _capture_sql(
        lambda: client.get(f"/api/v1/organisations/{org.id}/workspace/roles", **headers)
    )
    assert r.status_code == 200
    r, ws_3_sql = _capture_sql(
        lambda: client.get(f"/api/v1/organisations/{org.id}/workspace", **headers)
    )
    assert r.status_code == 200

    # Scale members to 105+ and channels/roles to 25+
    add_members(3, 105)
    for idx in range(3, 25):
        role = WorkspaceRole.objects.create(
            workspace=workspace,
            organisation_id=org.id,
            name=f"Role {idx}",
            slug=f"role-{idx}",
            position=idx + 1,
            permissions=["channel.view"],
        )
        ch = Channel.objects.create(
            workspace=workspace,
            category=cat,
            name=f"ws-chan-{idx}",
            kind="text",
            lifecycle="active",
            position=idx,
        )
        WorkspaceChannelRoleOverride.objects.create(
            workspace=workspace,
            channel=ch,
            role=role,
            allow=["channel.view"],
            deny=[],
        )

    with django_assert_max_num_queries(len(mem_3_sql)):
        r_mem, mem_25_sql = _capture_sql(
            lambda: client.get(f"/api/v1/organisations/{org.id}/memberships?limit=50", **headers)
        )
    assert r_mem.status_code == 200 and len(r_mem.json()["data"]) == 50
    assert len(mem_25_sql) == len(mem_3_sql) <= 12

    with django_assert_max_num_queries(len(roles_3_sql)):
        r_roles, roles_25_sql = _capture_sql(
            lambda: client.get(f"/api/v1/organisations/{org.id}/workspace/roles", **headers)
        )
    assert r_roles.status_code == 200
    assert len(r_roles.json()["data"]) == 25
    assert len(r_roles.json()["assignments"]) == 105
    assert len(roles_25_sql) == len(roles_3_sql) <= 12

    with django_assert_max_num_queries(len(ws_3_sql)):
        r_ws, ws_25_sql = _capture_sql(
            lambda: client.get(f"/api/v1/organisations/{org.id}/workspace", **headers)
        )
    assert r_ws.status_code == 200
    assert len(r_ws.json()["categories"][0]["channels"]) == 25
    assert len(ws_25_sql) == len(ws_3_sql) <= 19


def test_workspace_documents_search_and_collections_enforce_64_kib_http_cap_losslessly(
    world, http_signer, settings
):
    now_epoch = int(time.time())
    org, workspace, members, tokens = world
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now_epoch + 3600)])
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    client = Client(HTTP_HOST="127.0.0.1")
    cred = token(
        http_signer,
        org.issuer,
        subject=tokens[3].subject,
        email_verified=True,
        iat=now_epoch,
        exp=now_epoch + 600,
    )
    headers = _auth(cred)
    base = f"/api/v1/organisations/{org.id}/workspace"

    default_policy = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    Workspace.objects.filter(pk=workspace.id).update(default_policy=default_policy)

    # 1. Seed 20 documents with ~5.5 KB accented markdown each (~110 KB raw, >150 KB JSON-escaped).
    seeded_doc_ids: list[str] = []
    for idx in range(20):
        body_md = f"# KoderaPerfSearchToken Document {idx:03d}\n\n" + (
            "Équipe architecture note — " * 220
        )
        doc = Document.objects.create(
            workspace=workspace,
            creator=members[3],
            title=f"KoderaPerfSearchToken Spec {idx:03d}",
            markdown=body_md,
        )
        DocumentSnapshot.objects.create(document=doc, state=b"s")
        seeded_doc_ids.append(str(doc.id))

    # Also seed 60 additional 1 KB documents matching KoderaPerfSearchToken so searchWorkspace exceeds 64 KiB if unclamped.
    for idx in range(20, 80):
        excerpt_md = f"KoderaPerfSearchToken summary {idx:03d} " + ("référence " * 110)
        doc = Document.objects.create(
            workspace=workspace,
            creator=members[3],
            title=f"KoderaPerfSearchToken Entry {idx:03d}",
            markdown=excerpt_md,
        )
        DocumentSnapshot.objects.create(document=doc, state=b"s")
        seeded_doc_ids.append(str(doc.id))

    expected_docs_desc = list(reversed(seeded_doc_ids))

    # Traverse listWorkspaceDocuments at limit=200 and prove every HTTP body < 65,536 bytes + lossless traversal.
    collected_docs: list[str] = []
    cursor: str | None = None
    doc_pages = 0
    while True:
        qs = "limit=200" + (f"&cursor={cursor}" if cursor else "")
        resp = client.get(f"{base}/documents?{qs}", **headers)
        assert resp.status_code == 200, resp.content
        assert len(resp.content) < HTTP_BYTE_CEILING, f"response was {len(resp.content)} bytes"
        payload = resp.json()
        assert payload["data"], "non-empty workspace emitted an empty page"
        collected_docs.extend(item["id"] for item in payload["data"])
        doc_pages += 1
        if not payload["has_more"]:
            assert payload["next_cursor"] is None
            break
        cursor = payload["next_cursor"]
        assert cursor is not None
    assert doc_pages >= 3
    assert collected_docs == expected_docs_desc

    # Traverse searchWorkspace at limit=200 and prove every HTTP body < 65,536 bytes + lossless traversal.
    collected_search: list[str] = []
    cursor = None
    search_pages = 0
    while True:
        qs = "q=KoderaPerfSearchToken&limit=200" + (f"&cursor={cursor}" if cursor else "")
        resp = client.get(f"{base}/search?{qs}", **headers)
        assert resp.status_code == 200, resp.content
        assert len(resp.content) < HTTP_BYTE_CEILING, (
            f"search response was {len(resp.content)} bytes"
        )
        payload = resp.json()
        assert payload["data"]
        collected_search.extend(item["id"] for item in payload["data"])
        search_pages += 1
        if not payload["has_more"]:
            assert payload["next_cursor"] is None
            break
        cursor = payload["next_cursor"]
        assert cursor is not None
    assert search_pages >= 2
    assert len(collected_search) == len(set(collected_search)) == 80
    assert set(collected_search) == set(seeded_doc_ids)

    # 2. Seed Collection with 16 multi-KB CollectionRows (~96 KB total) and traverse queryWorkspaceCollection.
    created_collection = collections.create(
        verified=tokens[3],
        organisation_id=org.id,
        body={
            "title": "Bounded Collection",
            "properties": [
                {"id": "notes", "name": "Notes", "type": "text"},
                {"id": "seq", "name": "Seq", "type": "number"},
            ],
            "views": [{"id": "all", "name": "All", "type": "table", "columns": ["notes", "seq"]}],
        },
        request_id=str(uuid4()),
    )
    collection_id = UUID(created_collection["id"])
    row_doc_ids: list[str] = []
    for seq in range(16):
        doc_id = UUID(seeded_doc_ids[seq])
        CollectionRow.objects.create(
            collection_id=collection_id,
            document_id=doc_id,
            values={
                "notes": {"type": "text", "value": f"Row {seq:02d} " + ("detail-payload-" * 400)},
                "seq": {"type": "number", "value": seq},
            },
        )
        row_doc_ids.append(str(doc_id))
    CollectionRow.objects.filter(collection_id=collection_id).count()

    collected_rows: list[str] = []
    cursor = None
    query_pages = 0
    query_body = json.dumps({"sorts": [{"propertyId": "seq", "direction": "asc"}]})
    while True:
        qs = "limit=200" + (f"&cursor={cursor}" if cursor else "")
        resp = client.post(
            f"{base}/collections/{collection_id}/query?{qs}",
            data=query_body,
            content_type="application/json",
            **_auth(cred, HTTP_IDEMPOTENCY_KEY=str(uuid4())),
        )
        assert resp.status_code == 200, resp.content
        assert len(resp.content) < HTTP_BYTE_CEILING, (
            f"collection query was {len(resp.content)} bytes"
        )
        payload = resp.json()
        assert payload["data"]
        collected_rows.extend(item["documentId"] for item in payload["data"])
        query_pages += 1
        if not payload["has_more"]:
            assert payload["next_cursor"] is None
            break
        cursor = payload["next_cursor"]
        assert cursor is not None
    assert query_pages >= 2
    assert collected_rows == row_doc_ids

    # 3. Single > 60 KiB markdown document still makes clean forward progress without hanging.
    oversized = Document.objects.create(
        workspace=workspace,
        creator=members[3],
        title="Single Oversized Page",
        markdown="X" * 65_000,
    )
    DocumentSnapshot.objects.create(document=oversized, state=b"s")
    first_page = client.get(f"{base}/documents?limit=200", **headers).json()
    assert [item["id"] for item in first_page["data"]] == [str(oversized.id)]
    assert first_page["has_more"] is True and first_page["next_cursor"] is not None
    second_page = client.get(
        f"{base}/documents?limit=200&cursor={first_page['next_cursor']}", **headers
    )
    assert len(second_page.content) < HTTP_BYTE_CEILING
    assert second_page.json()["data"][0]["id"] == expected_docs_desc[0]


def test_invoices_abuse_reports_invitations_and_envelopes_enforce_64_kib_http_cap_losslessly(
    w, world, http_signer, frozen_clock, settings
):
    from billing_fiscal_fixtures import register_test_fiscal_periods, register_test_fiscal_year

    # 1. listInvoices seeded with 15 multi-KB multi-line invoices (~75 KB total).
    now = timezone.now()
    register_test_fiscal_periods()
    register_test_fiscal_year(now.year)
    expected_invoice_ids: list[str] = []
    for idx in range(1, 16):
        draft = Invoice.objects.create(
            organisation_id=w.alpha.id,
            vat_regime="fr_standard",
            issuer_legal_name="Issuer of Test Invoices SAS",
            issuer_address="1 rue de l'Exemple, 75000 Paris",
            issuer_country="FR",
            issuer_siren="000000000",
            issuer_vat_number="FR00000000000",
            customer_legal_name="Synthetic Customer SAS",
            customer_address_line1="1 rue Synthétique",
            customer_postal_code="75000",
            customer_city="Paris",
            customer_country="FR",
            total_excl_vat_minor=15_000,
            vat_amount_minor=3_000,
            total_incl_vat_minor=18_000,
            due_at=now + timedelta(days=30),
        )
        InvoiceLine.objects.bulk_create(
            [
                InvoiceLine(
                    invoice=draft,
                    position=pos,
                    description=f"Service bundle {idx}-{pos}: " + ("dedicated-capacity-" * 18),
                    plan_code="essentiel",
                    plan_version=1,
                    pack_code="visio",
                    capacity_tier_code="S",
                    quantity=1,
                    unit_amount_minor=1_000,
                    total_excl_vat_minor=1_000,
                    vat_rate_bp=2_000,
                    vat_amount_minor=200,
                    period_start=now,
                    period_end=now + timedelta(days=30),
                )
                for pos in range(1, 16)
            ]
        )
        draft.number = f"TST-{now.year}-{idx:05d}"
        draft.issued_at = now + timedelta(seconds=idx)
        draft.state = "issued"
        draft.save(update_fields=["number", "issued_at", "state", "updated_at"])
        expected_invoice_ids.append(str(draft.id))
    expected_invoice_ids.reverse()

    collected_invoices: list[str] = []
    cursor: str | None = None
    inv_pages = 0
    while True:
        qs = "limit=200" + (f"&cursor={cursor}" if cursor else "")
        resp = w.client.get(
            f"/api/v1/organisations/{w.alpha.id}/invoices?{qs}",
            **_auth(w.owner.credential),
        )
        assert resp.status_code == 200, resp.content
        assert len(resp.content) < HTTP_BYTE_CEILING, (
            f"invoices response was {len(resp.content)} bytes"
        )
        payload = resp.json()
        assert payload["data"]
        collected_invoices.extend(item["id"] for item in payload["data"])
        inv_pages += 1
        if not payload["has_more"]:
            assert payload["next_cursor"] is None
            break
        cursor = payload["next_cursor"]
    assert inv_pages >= 2
    assert collected_invoices == expected_invoice_ids

    # 2. listAbuseReports seeded with 35 x ~2 KB reports (~75 KB total).
    org, workspace, members, tokens = world
    configure(settings, [trust_entry(http_signer, org.issuer)])
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    settings.KODERA_MEMBERSHIP_CURSOR_KEY = "m" * 48
    settings.KODERA_E2EE_RELAY_ENABLED = True
    client = Client(HTTP_HOST="127.0.0.1")
    owner_cred = token(http_signer, org.issuer, subject=tokens[0].subject, email_verified=True)
    mod_cred = token(http_signer, org.issuer, subject=tokens[2].subject, email_verified=True)

    expected_reports: list[str] = []
    for idx in range(35):
        rep = WorkspaceAbuseReport.objects.create(
            workspace=workspace,
            reporter=members[3],
            membership=members[1],
            reason=f"Report {idx:03d}: " + ("moderation-evidence-detail-" * 65),
        )
        expected_reports.append(str(rep.id))
    expected_reports.reverse()

    collected_reports: list[str] = []
    cursor = None
    rep_pages = 0
    while True:
        qs = "limit=200" + (f"&cursor={cursor}" if cursor else "")
        resp = client.get(
            f"/api/v1/organisations/{org.id}/workspace/reports?{qs}",
            **_auth(mod_cred),
        )
        assert resp.status_code == 200, resp.content
        assert len(resp.content) < HTTP_BYTE_CEILING
        payload = resp.json()
        assert payload["data"]
        collected_reports.extend(item["id"] for item in payload["data"])
        rep_pages += 1
        if not payload["has_more"]:
            assert payload["next_cursor"] is None
            break
        cursor = payload["next_cursor"]
    assert rep_pages >= 2
    assert collected_reports == expected_reports

    # 3. listInvitations seeded with 130 long-address invitations (~78 KB total at limit=200).
    owner_identity = Identity.objects.get(user=members[0].user, organisation=org)
    expected_invitations: list[str] = []
    for idx in range(130):
        inv = Invitation.objects.create(
            organisation=org,
            email=f"invitee-{idx:04d}-{'department-team-member' * 5}@sub.example-enterprise.org",
            role="org_member",
            state="pending",
            token_digest=os.urandom(32),
            token_sealed=b"sealed",
            invited_by_user=members[0].user,
            invited_by_identity=owner_identity,
            issued_at=now,
            expires_at=now + timedelta(days=7),
            sent_count=1,
            last_sent_at=now,
        )
        expected_invitations.append(str(inv.id))
    expected_invitations.reverse()

    collected_invitations: list[str] = []
    cursor = None
    invite_pages = 0
    while True:
        qs = "limit=200" + (f"&cursor={cursor}" if cursor else "")
        resp = client.get(
            f"/api/v1/organisations/{org.id}/invitations?{qs}",
            **_auth(owner_cred),
        )
        assert resp.status_code == 200, resp.content
        assert len(resp.content) < HTTP_BYTE_CEILING
        payload = resp.json()
        assert payload["data"]
        collected_invitations.extend(item["id"] for item in payload["data"])
        invite_pages += 1
        if not payload["has_more"]:
            assert payload["next_cursor"] is None
            break
        cursor = payload["next_cursor"]
    assert invite_pages >= 2
    assert collected_invitations == expected_invitations

    # 4. listConfidentialEnvelopes seeded with 14 x 5 KB ciphertexts (~98 KB base64 JSON total).
    policy = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    Workspace.objects.filter(pk=workspace.id).update(default_policy=policy)
    conf_chan = Channel.objects.create(
        workspace=workspace,
        kind="text",
        name="Confidential Bounds",
        position=500,
        lifecycle="active",
        room_state="ready",
        is_confidential=True,
    )
    key = Ed25519PrivateKey.generate()
    pub_b64 = base64.b64encode(key.public_key().public_bytes_raw()).decode()
    reg_body = {"signingKey": pub_b64}
    reg_body["signature"] = base64.b64encode(
        key.sign(
            e2ee_services.signed_statement("register-device", org.id, members[0].id, None, reg_body)
        )
    ).decode()
    dev = e2ee_services.register_device(
        verified=tokens[0], organisation_id=org.id, body=reg_body, request_id=str(uuid4())
    )
    device_id = dev["deviceId"]
    room_body = {
        "deviceId": device_id,
        "channelId": str(conf_chan.id),
        "algorithm": "io.kodera.mls.v1",
    }
    room_body["signature"] = base64.b64encode(
        key.sign(
            e2ee_services.signed_statement("create-room", org.id, members[0].id, None, room_body)
        )
    ).decode()
    created_room = e2ee_services.create_room(
        verified=tokens[0], organisation_id=org.id, body=room_body, request_id=str(uuid4())
    )
    room_id = UUID(created_room["roomId"])
    with transaction.atomic():
        for seq in range(1, 15):
            Envelope.objects.create(
                organisation_id=org.id,
                room_id=room_id,
                sender_id=UUID(device_id),
                sequence=seq,
                epoch=0,
                kind="application",
                ciphertext=os.urandom(5_120),
                signature=os.urandom(64),
            )
        Room.objects.filter(pk=room_id).update(head_sequence=14)

    collected_sequences: list[int] = []
    after = 0
    env_pages = 0
    while True:
        resp = client.get(
            f"/api/v1/organisations/{org.id}/confidential/rooms/{room_id}/envelopes"
            f"?deviceId={device_id}&after={after}",
            **_auth(owner_cred),
        )
        assert resp.status_code == 200, resp.content
        assert len(resp.content) < HTTP_BYTE_CEILING
        payload = resp.json()
        assert payload["envelopes"]
        collected_sequences.extend(item["sequence"] for item in payload["envelopes"])
        after = payload["nextAfter"]
        env_pages += 1
        if not payload["hasMore"]:
            break
    assert env_pages >= 2
    assert collected_sequences == list(range(1, 15))

    # 5. listWorkspaceInviteLinks seeded with 60 multi-role invite links (~75 KB total at limit=200).
    invite_roles = [
        WorkspaceRole.objects.create(
            workspace=workspace,
            organisation_id=org.id,
            name=f"Invite Role {idx}",
            slug=f"inv-role-{idx}",
            position=idx + 1,
            permissions=["channel.view"],
        )
        for idx in range(25)
    ]
    role_ids_payload = [str(role.id) for role in invite_roles]
    expected_links: list[str] = []
    for idx in range(60):
        lnk = WorkspaceInviteLink.objects.create(
            workspace=workspace,
            created_by=members[0],
            code_digest=hashlib.sha256(f"invite-code-{idx}".encode()).hexdigest(),
            auto_role_ids=role_ids_payload,
            expires_at=now + timedelta(hours=24),
            max_uses=10,
            role="org_member",
        )
        expected_links.append(str(lnk.id))
    expected_links.reverse()

    collected_links: list[str] = []
    cursor = None
    link_pages = 0
    while True:
        qs = "limit=200" + (f"&cursor={cursor}" if cursor else "")
        resp = client.get(
            f"/api/v1/organisations/{org.id}/workspace/invite-links?{qs}",
            **_auth(owner_cred),
        )
        assert resp.status_code == 200, resp.content
        assert len(resp.content) < HTTP_BYTE_CEILING
        payload = resp.json()
        assert payload["data"]
        collected_links.extend(item["id"] for item in payload["data"])
        link_pages += 1
        if not payload["has_more"]:
            assert payload["next_cursor"] is None
            break
        cursor = payload["next_cursor"]
    assert link_pages >= 2
    assert collected_links == expected_links


def test_digest_and_passport_selectors_run_single_combined_queries(
    world, django_assert_max_num_queries
):
    org, workspace, members, _ = world
    with django_assert_max_num_queries(1):
        contact = digest_member(membership_id=members[0].id)
    assert contact is not None and contact.organisation_name == org.name

    with django_assert_max_num_queries(2):
        ws_id = digest_workspace(organisation_id=org.id, membership_id=members[3].id)
    assert ws_id == workspace.id

    WorkspaceMemberRestriction.objects.create(
        workspace=workspace, membership=members[2], kicked=True
    )
    with django_assert_max_num_queries(2):
        assert digest_workspace(organisation_id=org.id, membership_id=members[2].id) is None

    with django_assert_max_num_queries(2):
        unrestricted = passport_unrestricted_workspaces(memberships=((org.id, members[3].id),))
    assert unrestricted == {org.id: workspace.id}

    with django_assert_max_num_queries(2):
        blocked = passport_unrestricted_workspaces(memberships=((org.id, members[2].id),))
    assert blocked == {}
