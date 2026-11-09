"""Compose actual owner commands, signed HTTP and workspace effects on disposable PostgreSQL.

The signer asserts synthetic contact/MFA facts; provider documents and operator evidence are
synthetic. No provider login, SMTP delivery, deployment or least-privilege image is qualified.
"""

import hashlib
import time

import pytest
from customer_http_fixtures import configure, token, trust_entry
from django.db import connection
from django.test import Client
from django.utils import timezone
from order_fixtures import commit_order
from owner_claim_consume_fixtures import (
    http_signer as http_signer,
    issue_owner,
    owner_world as owner_world,
    post_consume,
    w as w,
)
from test_customer_persistence_models import anchor, anchor_models, identity
from test_operator_realm_bootstrap import run, who

from apps.audit.models import AuditEvent
from apps.identity.models import Identity, StaffRole, User
from apps.jobs.models import Job
from apps.orgs.models import Membership, Organisation, OwnerBinding, OwnerClaim, SlugReservation
from apps.outbox.models import OutboxDelivery, OutboxMessage
from apps.workspaces.models import Category, Channel, ResourcePolicy, ResourcePolicyRule, Workspace
from core.idempotency.models import IdempotencyRecord

pytestmark = pytest.mark.django_db(transaction=True)

CONSUME = "/api/v1/owner-claims/actions/consume"
CONSUME_KEY = "journey-consume-public-key-1"
BEFORE_CONFIRM_KEY = "journey-awaiting-confirmation-1"
READY_KEY = "journey-ready-initialisation-1"
OWNER_MESSAGE = (
    "JOURNEY-OWNER-EFFECT: signed consumption must create the exact accepted owner and no workspace"
)
GATE_MESSAGE = "JOURNEY-CONFIRMATION-GATE: unconfirmed ownership must not initialise a workspace"


def _path(world):
    return f"/api/v1/organisations/{world.organisation.id}/workspace"


def _credential(issued):
    world, _, _, verified = issued
    now = int(time.time())
    return token(world.signer, verified.issuer, verified.subject, iat=now, exp=now + 300)


def _ordered(issued):
    """The owner orders with the CGV and the DPA: the step between the claim and the workspace."""
    world, _, _, verified = issued
    commit_order(world.organisation.id, verified.issuer, verified.subject)


def _read(issued, **headers):
    return Client().get(
        _path(issued[0]), HTTP_AUTHORIZATION="Bearer " + _credential(issued), **headers
    )


def _initialise(issued, key):
    return Client().post(
        _path(issued[0]) + "/actions/initialise",
        data=b"",
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + _credential(issued),
        HTTP_IDEMPOTENCY_KEY=key,
    )


def _receipts(issued, path, key):
    _, _, _, verified = issued
    return IdempotencyRecord.objects.filter(
        issuer=verified.issuer,
        subject=verified.subject,
        method="POST",
        path=path,
        key_sha256=hashlib.sha256(key.encode()).hexdigest(),
    )


def _receipt_snapshot(issued, path, key):
    row = _receipts(issued, path, key).get()
    return tuple(
        bytes(value) if isinstance(value, memoryview) else value
        for value in (
            row.id,
            row.issuer,
            row.subject,
            row.method,
            row.path,
            row.key_sha256,
            row.body_sha256,
            row.status,
            row.content_type,
            row.body,
            row.location,
            row.etag,
            row.job_id,
            row.created_at,
        )
    )


def _unaffected():
    """Only identifiers: never read persisted contact, seal or token material for diagnostics."""
    return tuple(
        tuple(model.objects.order_by("pk").values_list("pk", flat=True))
        for model in (User, Identity, Job, OutboxDelivery, OutboxMessage)
    )


def _workspace_rows(world):
    return {
        model.__name__: tuple(
            model.objects.filter(
                **(
                    {"organisation_id": world.organisation.id}
                    if model is Workspace
                    else {"policy__workspace__organisation_id": world.organisation.id}
                    if model is ResourcePolicyRule
                    else {"workspace__organisation_id": world.organisation.id}
                )
            )
            .order_by("id")
            .values_list("id", flat=True)
        )
        for model in (Workspace, ResourcePolicy, ResourcePolicyRule, Category, Channel)
    } | {
        "events": tuple(
            AuditEvent.objects.filter(
                organisation_id=world.organisation.id, action="workspace.initialised"
            )
            .order_by("id")
            .values_list("id", flat=True)
        )
    }


def _owner_effect(issued):
    world, claim, _, _ = issued
    claim.refresh_from_db()
    owners = Membership.objects.filter(
        organisation_id=world.organisation.id,
        role="org_owner",
        state="active",
        accepted_at__isnull=False,
        deleted_at__isnull=True,
    )
    accepted = list(owners.values_list("id", "user_id"))
    intended = Identity.objects.get(id=claim.intended_identity_id)
    assert (
        len(accepted) == 1
        and claim.state == "consumed"
        and claim.consumed_by_identity_id == intended.id
        and (claim.membership_id, intended.user_id) == accepted[0]
        and Organisation.objects.get(id=world.organisation.id).state == "active"
        and SlugReservation.objects.get(organisation_id=world.organisation.id).state == "permanent"
        and not Workspace.objects.filter(organisation_id=world.organisation.id).exists()
    ), OWNER_MESSAGE


def _consume(issued, *, key=CONSUME_KEY):
    before = _unaffected()
    before_events = set(AuditEvent.objects.values_list("id", flat=True))
    response = post_consume(issued, key=key)
    # This is the owning semantic assertion for the acceptance-omission mutation. A real
    # database refusal may roll back the mutant; a fake response is never substituted.
    _owner_effect(issued)
    assert response.status_code == 200, "JOURNEY: real signed consume did not succeed"
    assert _unaffected() == before, "JOURNEY: consume created unrelated people, job or mail rows"
    world, claim, secret, _ = issued
    assert OwnerClaim.objects.filter(organisation_id=world.organisation.id).count() == 1
    assert OwnerBinding.objects.filter(organisation_id=world.organisation.id).count() == 1
    assert AuditEvent.objects.exclude(id__in=before_events).count() == 3
    for action in ("owner_claim.consumed", "membership.created", "organisation.activated"):
        event = AuditEvent.objects.get(organisation_id=world.organisation.id, action=action)
        assert event.actor_id == claim.intended_identity_id and event.actor_type == "tenant"
    receipt = _receipts(issued, CONSUME, key).get()
    assert receipt.status == 200 and bytes(receipt.body) == response.content
    assert (
        secret.encode() not in response.content and bytes(claim.token_hash) not in response.content
    )
    assert response.headers["Cache-Control"] == "no-store"
    return response


def _confirmation(capsys, issued, *, actor=None):
    world, claim, _, _ = issued
    return run(
        capsys,
        "confirm_owner_contact",
        *who(actor or world.recorder),
        "--claim",
        str(claim.id),
        "--evidence-ref",
        "synthetic-independent-contact-journey",
    )


def _confirmed(capsys, issued):
    world, claim, _, _ = issued
    before = _unaffected()
    before_events = set(AuditEvent.objects.values_list("id", flat=True))
    history = tuple(
        OwnerClaim.objects.filter(id=claim.id).values_list(
            "state", "consumed_at", "consumed_by_identity_id", "membership_id", "expires_at"
        )
    )
    code, out, _ = _confirmation(capsys, issued)
    assert code == 0 and "outcome=confirmed" in out, "JOURNEY: actual recorder command refused"
    event = AuditEvent.objects.get(
        organisation_id=world.organisation.id, action="owner_claim.confirmed"
    )
    assert (event.actor_type, event.actor_id, event.target_urn, event.metadata) == (
        "staff",
        world.recorder.id,
        f"urn:kodera:owner_claim:{claim.id}",
        {"evidence_ref": "synthetic-independent-contact-journey"},
    ), "JOURNEY: confirmation did not record the actual recorder and consumed claim"
    assert _unaffected() == before, "JOURNEY: confirmation created unrelated rows"
    assert AuditEvent.objects.exclude(id__in=before_events).count() == 1
    assert (
        tuple(
            OwnerClaim.objects.filter(id=claim.id).values_list(
                "state", "consumed_at", "consumed_by_identity_id", "membership_id", "expires_at"
            )
        )
        == history
    ), "JOURNEY: confirmation changed consumed terminal history"
    return event


def _confirmation_gate(issued):
    world = issued[0]
    before = _workspace_rows(world)
    response = _initialise(issued, BEFORE_CONFIRM_KEY)
    assert (
        response.status_code == 409
        and response.json().get("allowed_states") == ["ready"]
        and not any(_workspace_rows(world).values())
        and _workspace_rows(world) == before
    ), GATE_MESSAGE
    return response


def _assert_replay(first, replay):
    assert replay.status_code == first.status_code and replay.content == first.content, (
        "JOURNEY: stored answer was not replayed byte for byte"
    )
    assert replay.headers["Content-Type"] == first.headers["Content-Type"]
    assert replay.headers["Idempotency-Replayed"] == "true"
    assert replay.headers["Cache-Control"] == "no-store"
    assert replay.headers.get("Location") == first.headers.get("Location")


def _starter(issued):
    world, claim, _, _ = issued
    workspace = Workspace.objects.get(organisation_id=world.organisation.id)
    assert workspace.structure_revision == 1
    policy = ResourcePolicy.objects.get(workspace=workspace)
    assert workspace.default_policy_id == policy.id
    assert (policy.visibility, policy.revision) == ("organisation", 1)
    assert not ResourcePolicyRule.objects.filter(policy__workspace=workspace).exists()
    categories = list(Category.objects.filter(workspace=workspace).order_by("position"))
    assert [
        (c.template_key, c.name, c.position, c.default_policy_id, c.version) for c in categories
    ] == [
        ("general", "General", 0, None, 1),
        ("team", "Team", 1, None, 1),
    ]
    channels = list(
        Channel.objects.filter(workspace=workspace).order_by("category__position", "position")
    )
    assert [
        (
            c.category_id,
            c.template_key,
            c.name,
            c.position,
            c.kind,
            c.policy_mode,
            c.explicit_policy_id,
            c.lifecycle,
            c.topic,
            c.version,
        )
        for c in channels
    ] == [
        (categories[0].id, "welcome", "welcome", 0, "text", "inherit", None, "active", "", 1),
        (categories[0].id, "general", "general", 1, "text", "inherit", None, "active", "", 1),
        (categories[1].id, "lounge", "lounge", 0, "audio", "inherit", None, "active", "", 1),
    ]
    event = AuditEvent.objects.get(
        organisation_id=world.organisation.id, action="workspace.initialised"
    )
    assert (event.actor_id, event.actor_type, event.target_urn, event.metadata) == (
        claim.intended_identity_id,
        "tenant",
        f"urn:kodera:workspace:{workspace.id}",
        {"workspace_id": str(workspace.id), "template_version": 2},
    )
    return workspace


def test_real_claim_to_confirmed_workspace_journey(owner_world, settings, capsys):
    world = owner_world
    assert world.organisation.state == "prospect"
    assert not Membership.objects.filter(organisation_id=world.organisation.id).exists()
    assert not OwnerBinding.objects.filter(organisation_id=world.organisation.id).exists()
    assert not any(_workspace_rows(world).values())
    people_before_issue = (User.objects.count(), Identity.objects.count())
    issued = issue_owner(world, settings)
    claim = issued[1]
    assert (
        OwnerBinding.objects.get(organisation_id=world.organisation.id).identity_id
        == claim.intended_identity_id
    )
    assert claim.state == "issued" and claim.membership_id is None
    assert OutboxMessage.objects.filter(delivery_id=claim.delivery_id).exists()
    assert (User.objects.count(), Identity.objects.count()) == tuple(
        n + 1 for n in people_before_issue
    )
    assert not Membership.objects.filter(organisation_id=world.organisation.id).exists()
    assert not any(_workspace_rows(world).values())
    _consume(issued)
    first = _read(issued)
    assert first.status_code == 200
    assert first.json() == {
        "organisation_id": str(world.organisation.id),
        "state": "not_initialised",
        "setup": {"state": "pending", "reason": "awaiting_owner_confirmation"},
        "can_initialise": False,
        "id": None,
        "categories": [],
        "uncategorised_channels": [],
    }
    old = _confirmation_gate(issued)
    path = _path(world) + "/actions/initialise"
    old_receipt = _receipt_snapshot(issued, path, BEFORE_CONFIRM_KEY)
    _confirmed(capsys, issued)
    confirmation = AuditEvent.objects.filter(action="owner_claim.confirmed").count()
    code, out, _ = _confirmation(capsys, issued)
    assert code == 0 and "outcome=already_confirmed" in out
    assert AuditEvent.objects.filter(action="owner_claim.confirmed").count() == confirmation
    ready = _read(issued)
    assert ready.json()["setup"] == {"state": "ready", "reason": None}
    assert ready.json()["can_initialise"] is False, "a workspace before the order"
    _ordered(issued)
    ready = _read(issued)
    assert ready.json()["state"] == "not_initialised" and ready.json()["can_initialise"] is True
    _assert_replay(old, _initialise(issued, BEFORE_CONFIRM_KEY))
    assert _receipt_snapshot(issued, path, BEFORE_CONFIRM_KEY) == old_receipt
    assert not any(_workspace_rows(world).values())
    unaffected = _unaffected()
    response = _initialise(issued, READY_KEY)
    assert response.status_code == 201 and response.json() == {"state": "initialised"}
    assert response.headers["Location"] == _path(world)
    workspace = _starter(issued)
    rows = _workspace_rows(world)
    receipt = _receipt_snapshot(issued, path, READY_KEY)
    _assert_replay(response, _initialise(issued, READY_KEY))
    assert _receipt_snapshot(issued, path, READY_KEY) == receipt
    another = _initialise(issued, "journey-another-initialisation-1")
    assert another.status_code == 200 and another.json() == {"state": "initialised"}
    assert "Idempotency-Replayed" not in another.headers
    assert _workspace_rows(world) == rows and _unaffected() == unaffected
    final = _read(issued)
    assert final.status_code == 200 and final.json()["id"] == str(workspace.id)
    assert final.json()["setup"] == {"state": "ready", "reason": None}
    assert final.json()["state"] == "initialised" and final.json()["can_initialise"] is False
    assert [
        (c["template_key"], [x["template_key"] for x in c["channels"]])
        for c in final.json()["categories"]
    ] == [("general", ["welcome", "general"]), ("team", ["lounge"])]
    assert final.json()["uncategorised_channels"] == []
    assert final.headers["ETag"] == '"' + hashlib.sha256(final.content).hexdigest() + '"'
    conditional = _read(issued, HTTP_IF_NONE_MATCH=final.headers["ETag"])
    assert conditional.status_code == 304 and conditional.content == b""
    assert conditional.headers["Cache-Control"] == "no-store"
    assert _workspace_rows(world) == rows


def test_confirmation_requires_actual_consumption_and_original_current_recorder(
    owner_world, settings, capsys
):
    issued = issue_owner(owner_world, settings)
    before = AuditEvent.objects.filter(action="owner_claim.confirmed").count()
    code, _, error = _confirmation(capsys, issued)
    assert code == 1 and "consumed_claim_required" in error
    assert AuditEvent.objects.filter(action="owner_claim.confirmed").count() == before
    _consume(issued)
    code, _, error = _confirmation(capsys, issued, actor=owner_world.operator)
    assert code == 1 and "intake_recorder_required" in error
    assert AuditEvent.objects.filter(action="owner_claim.confirmed").count() == before
    grant = StaffRole.objects.get(
        identity=owner_world.recorder, role="staff_operator", revoked_at__isnull=True
    )
    StaffRole.objects.filter(id=grant.id).update(revoked_at=timezone.now())
    code, _, error = _confirmation(capsys, issued)
    assert code == 1 and "operator_refused" in error
    assert AuditEvent.objects.filter(action="owner_claim.confirmed").count() == before
    # A revoked grant is immutable. Restoration is a new lawful grant for this same recorder.
    StaffRole.objects.create(
        identity=owner_world.recorder, realm="kodera-staff", role="staff_operator"
    )
    _confirmed(capsys, issued)
    grant.refresh_from_db()
    assert grant.revoked_at is not None


def test_consumed_history_can_confirm_after_original_deadline(owner_world, settings, capsys):
    settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "5"
    issued = issue_owner(owner_world, settings)
    _consume(issued)
    claim = issued[1]
    terminal = (claim.state, claim.consumed_at, claim.consumed_by_identity_id, claim.membership_id)
    until = time.monotonic() + 8
    elapsed = False
    while time.monotonic() < until:
        with connection.cursor() as cursor:
            cursor.execute("SELECT clock_timestamp() > %s", [claim.expires_at])
            elapsed = cursor.fetchone()[0]
        if elapsed:
            break
        time.sleep(0.05)
    assert elapsed, "JOURNEY: bounded database deadline observation did not complete"
    _confirmed(capsys, issued)
    claim.refresh_from_db()
    assert (
        claim.state,
        claim.consumed_at,
        claim.consumed_by_identity_id,
        claim.membership_id,
    ) == terminal


def test_current_withdrawal_and_foreign_read_preserve_receipt(owner_world, settings, capsys):
    issued = issue_owner(owner_world, settings)
    _consume(issued)
    _confirmed(capsys, issued)
    _ordered(issued)
    first = _initialise(issued, READY_KEY)
    assert first.status_code == 201
    rows = _workspace_rows(owner_world)
    path = _path(owner_world) + "/actions/initialise"
    receipt = _receipt_snapshot(issued, path, READY_KEY)
    # An unrelated foreign anchor is a fixture only; target ownership above came from consume.
    models = anchor_models()
    foreign, _, foreign_owners = anchor(models, slug="journey-foreign")
    foreign_identity = identity(
        models, foreign, foreign_owners[0].user, subject="journey-foreign-owner"
    )
    configure(settings, [*owner_world.trust, trust_entry(owner_world.signer, foreign.issuer)])
    now = int(time.time())
    bearer = token(
        owner_world.signer, foreign.issuer, foreign_identity.subject, iat=now, exp=now + 300
    )
    denied = Client().get(_path(owner_world), HTTP_AUTHORIZATION="Bearer " + bearer)
    assert denied.status_code == 404 and "categories" not in denied.json()
    intended = Identity.objects.get(id=issued[1].intended_identity_id)
    User.objects.filter(id=intended.user_id).update(enabled=False)
    events = tuple(AuditEvent.objects.order_by("id").values_list("id", flat=True))
    read = _read(issued)
    replay = _initialise(issued, READY_KEY)
    assert read.status_code == replay.status_code == 403
    for refused in (read, replay):
        assert refused.json()["type"] == "https://kodera.io/problems/identity-unknown"
        assert "WWW-Authenticate" not in refused.headers
    assert "Idempotency-Replayed" not in replay.headers
    assert "categories" not in read.json() and "categories" not in replay.json()
    assert _receipt_snapshot(issued, path, READY_KEY) == receipt
    assert _workspace_rows(owner_world) == rows
    assert tuple(AuditEvent.objects.order_by("id").values_list("id", flat=True)) == events


@pytest.mark.parametrize(
    "omit_confirmation", [False, True], ids=["pristine", "omitted-confirmation"]
)
def test_confirmation_readiness_omission_is_caught(
    owner_world, settings, monkeypatch, omit_confirmation
):
    from apps.workspaces import setup

    issued = issue_owner(owner_world, settings)
    _consume(issued)
    _ordered(issued)
    assert _read(issued).json()["setup"] == {
        "state": "pending",
        "reason": "awaiting_owner_confirmation",
    }
    assert not AuditEvent.objects.filter(
        organisation_id=owner_world.organisation.id, action="owner_claim.confirmed"
    ).exists()
    if not omit_confirmation:
        _confirmation_gate(issued)
        return
    with monkeypatch.context() as patch:
        patch.setattr(setup, "owner_confirmation_recorded", lambda **kwargs: True)
        with pytest.raises(AssertionError, match="^" + GATE_MESSAGE + r"(?:\n|$)"):
            _confirmation_gate(issued)
    # The omission really executed the real handler, rather than failing during fixture setup.
    assert Workspace.objects.filter(organisation_id=owner_world.organisation.id).count() == 1
    assert (
        AuditEvent.objects.filter(
            organisation_id=owner_world.organisation.id, action="workspace.initialised"
        ).count()
        == 1
    )


@pytest.mark.parametrize("omit_acceptance", [False, True], ids=["pristine", "omitted-acceptance"])
def test_consumption_acceptance_omission_is_caught(
    owner_world, settings, monkeypatch, omit_acceptance
):
    issued = issue_owner(owner_world, settings)
    if not omit_acceptance:
        _consume(issued)
        return
    original = Membership.objects.create
    observed = []

    def omit(**fields):
        observed.append(fields.get("accepted_at") is not None)
        return original(**{**fields, "accepted_at": None})

    with monkeypatch.context() as patch:
        patch.setattr(Membership.objects, "create", omit)
        with pytest.raises(AssertionError, match="^" + OWNER_MESSAGE + r"(?:\n|$)"):
            _consume(issued)
    assert observed == [True], (
        "JOURNEY: acceptance omission never reached the actual membership writer"
    )
    assert not Membership.objects.filter(organisation_id=owner_world.organisation.id).exists()
    assert OwnerClaim.objects.get(id=issued[1].id).state == "issued"
    assert not _receipts(issued, CONSUME, CONSUME_KEY).exists()
