"""Real PostgreSQL checkpoint persistence, scope binding and compare-and-swap authority."""

from dataclasses import replace
from datetime import UTC, datetime

import pytest
from workspace_safety.test_moderation import world as world

from apps.audit.models import AuditEvent
from apps.identity.models import Identity
from apps.orgs.models import Membership
from apps.orgs.privacy_archives import SECTIONS, ArchiveRefusalError, Request, State
from apps.orgs.privacy_models import PrivacyExport
from apps.orgs.privacy_services import CurrentAuthority, DatabaseJournal, persist_started
from core.db.ids import new_uuid7

pytestmark = pytest.mark.django_db(transaction=True)


def started(world):
    org, _, members, _ = world
    identity = Identity.objects.get(user=members[0].user, organisation=org)
    now = int(datetime.now(UTC).timestamp())
    request = Request(
        str(new_uuid7()),
        str(identity.id),
        str(identity.user_id),
        "workspace",
        str(org.id),
        True,
        now,
        now + 600,
    )
    state = State(request, 1, {key: "snapshot-" + key for key in SECTIONS})
    row = persist_started(state, CurrentAuthority())
    return state, row


def test_database_journal_survives_new_adapter_and_only_one_checkpoint_wins(world):
    state, row = started(world)
    assert DatabaseJournal().load(str(row.id)) == state
    next_state = replace(state, revision=2)
    assert DatabaseJournal().save(next_state, 1)
    assert not DatabaseJournal().save(next_state, 1)
    assert DatabaseJournal().load(str(row.id)) == next_state
    assert PrivacyExport.objects.get(pk=row.id).status == "running"
    events = list(AuditEvent.objects.filter(target_urn=f"urn:kodera:export:{row.id}"))
    assert len(events) == 1 and events[0].action == "export.requested"
    assert events[0].metadata == {"scope": "workspace"}
    assert not AuditEvent.objects.filter(action="export.ready").exists()


def test_database_checkpoint_cannot_change_immutable_request_binding(world):
    state, _ = started(world)
    mutated = replace(state, request=replace(state.request, include_media=False), revision=2)
    assert not DatabaseJournal().save(mutated, 1)
    assert DatabaseJournal().load(state.request.id) == state


@pytest.mark.parametrize("mutation", ["subject", "scope", "expiry", "ready", "checkpoint"])
def test_persisted_binding_and_ready_mutations_refuse_with_diagnostic(world, mutation):
    state, row = started(world)
    if mutation == "subject":
        snapshot = dict(row.request_snapshot)
        snapshot["user_id"] = str(new_uuid7())
        PrivacyExport.objects.filter(pk=row.id).update(request_snapshot=snapshot)
    elif mutation == "scope":
        snapshot = dict(row.request_snapshot)
        snapshot["scope"] = "account"
        PrivacyExport.objects.filter(pk=row.id).update(request_snapshot=snapshot)
    elif mutation == "expiry":
        snapshot = dict(row.request_snapshot)
        snapshot["expires_at"] += 1
        PrivacyExport.objects.filter(pk=row.id).update(request_snapshot=snapshot)
    elif mutation == "checkpoint":
        PrivacyExport.objects.filter(pk=row.id).update(checkpoint={})
    else:
        PrivacyExport.objects.filter(pk=row.id).update(status="ready")
    diagnostic = (
        "persisted export ready binding"
        if mutation == "ready"
        else "persisted export checkpoint invalid"
    )
    with pytest.raises(ArchiveRefusalError, match=diagnostic):
        DatabaseJournal().load(state.request.id)


def test_current_owner_and_enabled_identity_are_required_on_every_resume(world):
    state, _ = started(world)
    org, _, members, _ = world
    authority = CurrentAuthority()
    assert authority.authorize(state.request)
    # Preserve the independent last-owner invariant while testing this requester revocation.
    Membership.objects.filter(pk=members[1].id).update(role="org_owner")
    Membership.objects.filter(pk=members[0].id).update(role="org_member")
    assert not authority.authorize(state.request)
    Membership.objects.filter(pk=members[0].id).update(role="org_owner")
    Identity.objects.filter(pk=state.request.identity_id).update(enabled=False)
    assert not authority.authorize(state.request)
    assert not authority.authorize(replace(state.request, organisation_id=str(new_uuid7())))


def test_personal_export_is_bound_to_current_person_and_no_workspace(world):
    state, _ = started(world)
    personal = replace(state.request, id=str(new_uuid7()), scope="account", organisation_id=None)
    personal.validate()
    assert CurrentAuthority().authorize(personal)
    assert not CurrentAuthority().authorize(replace(personal, user_id=str(new_uuid7())))


def test_export_admission_rolls_back_when_audit_cannot_commit(world, monkeypatch):
    from apps.orgs import privacy_services

    state, _ = started(world)
    next_request = replace(state.request, id=str(new_uuid7()))
    next_state = replace(state, request=next_request)

    def refuse_audit(*args):
        raise RuntimeError("synthetic audit failure")

    monkeypatch.setattr(privacy_services, "_audit", refuse_audit)
    with pytest.raises(RuntimeError, match="synthetic audit failure"):
        persist_started(next_state, CurrentAuthority())
    assert not PrivacyExport.objects.filter(id=next_request.id).exists()
