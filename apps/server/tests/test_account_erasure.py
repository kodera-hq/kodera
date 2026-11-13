"""Customer account scope preserves controller-owned content and proves concrete local progress."""

from dataclasses import replace
from datetime import timedelta

import pytest
from django.db import IntegrityError, transaction
from test_core_erasure import operator, seed
from workspace_safety.test_moderation import world as world

from apps.docs.models import Document, DocumentSnapshot, DocumentUpdate
from apps.engine_intents.models import EngineChannelSet, EngineKnownSubject, EngineMemberSet
from apps.identity.models import Identity, User
from apps.notifications.models import Notification, PushSubscription
from apps.orgs import member_set_hooks
from apps.orgs.account_erasure_services import begin_account_erasure, purge_account_core
from apps.orgs.erasure_services import database_now
from apps.orgs.models import Membership
from apps.orgs.privacy_models import AccountErasure

pytestmark = pytest.mark.django_db(transaction=True)


def admit(world, **changes):
    org, _, _, tokens = world
    values = {
        "verified": replace(tokens[0], auth_time=int(database_now().timestamp())),
        "confirmation": "delete",
        "instruction_ref": "DEL-200",
        "instruction_sha256": "7" * 64,
        "purge_not_before": database_now(),
        "actor_identity_id": operator().id,
    }
    values.update(changes)
    return begin_account_erasure(**values)


def transfer(world):
    Membership.objects.filter(pk=world[2][1].id).update(role="org_owner")


def test_last_owner_requires_transfer_without_disabling_or_erasing_any_scope(world):
    principal = Identity.objects.get(organisation=world[0], user=world[2][0].user)
    with pytest.raises(IntegrityError, match="last-owner transfer required"):
        admit(world)
    principal.refresh_from_db()
    assert principal.enabled and not AccountErasure.objects.exists()
    assert Membership.objects.get(pk=world[2][0].id).state == "active"


def test_account_intent_emits_real_erasure_sets_and_purges_only_personal_contacts_and_push(world):
    transfer(world)
    org, _, members, _ = world
    document, attachment, principal = seed(world)
    original_subject = principal.subject
    other_email = members[1].user.email
    row = admit(world)
    assert row.user_reference == members[0].user_id and row.protocol_emitted_at is not None
    assert not User.objects.get(pk=row.user_reference).enabled
    assert Membership.objects.get(pk=members[0].id).state == "removed"
    assert EngineKnownSubject.objects.filter(
        user_id=row.user_reference, erased_at__isnull=False
    ).exists()
    actual = EngineMemberSet.objects.filter(organisation=org).latest("revision")
    assert (
        original_subject in actual.erased_subjects
        and original_subject not in actual.active_subjects
    )
    assert EngineChannelSet.objects.filter(organisation=org).exists()
    result = purge_account_core(row.id)
    assert result["core_contacts_purged"] and result["protocol_emitted"] and not result["complete"]
    assert "account_message_outbox" in result["held_domains"]
    person = User.objects.get(pk=row.user_reference)
    principal.refresh_from_db()
    assert person.email == f"erased:{person.id}" and person.display_name is None
    assert principal.email == f"erased:{principal.id}" and principal.subject == original_subject
    assert not PushSubscription.objects.filter(membership=members[0]).exists()
    assert not Notification.objects.filter(membership=members[0]).exists()
    # No individual account intent owns shared documents, Yjs history or uploaded workspace content.
    assert Document.objects.filter(pk=document.id, markdown="Synthetic private body").exists()
    assert DocumentSnapshot.objects.filter(document=document).exists()
    assert DocumentUpdate.objects.filter(document=document).exists()
    assert attachment.__class__.objects.filter(pk=attachment.id).exists()
    assert User.objects.get(pk=members[1].user_id).email == other_email
    assert Membership.objects.get(pk=members[1].id).state == "active"
    assert purge_account_core(row.id)["counts"] == result["counts"]


@pytest.mark.parametrize("mutation", ["confirmation", "missing", "stale", "future", "unknown"])
def test_account_confirmation_recent_authenticated_subject_refusals_leave_no_cutoff(
    world, mutation
):
    transfer(world)
    token = replace(world[3][0], auth_time=int(database_now().timestamp()))
    changes = {"verified": token}
    if mutation == "confirmation":
        changes["confirmation"] = "no"
    elif mutation == "missing":
        changes["verified"] = replace(token, auth_time=None)
    elif mutation == "stale":
        changes["verified"] = replace(token, auth_time=token.auth_time - 1000)
    elif mutation == "future":
        changes["verified"] = replace(token, auth_time=token.auth_time + 3600)
    else:
        changes["verified"] = replace(token, subject="unrecorded-subject")
    with pytest.raises(ValueError, match="account|confirmation"):
        admit(world, **changes)
    assert not AccountErasure.objects.exists()
    assert User.objects.get(pk=world[2][0].user_id).enabled


def test_account_erasure_canonical_emitter_failure_rolls_back_all_local_authority_and_intents(
    world, monkeypatch
):
    transfer(world)

    def refuse(member):
        raise RuntimeError("synthetic account emitter refusal")

    monkeypatch.setattr(member_set_hooks, "member_erased", refuse)
    with pytest.raises(RuntimeError, match="synthetic account emitter refusal"):
        admit(world)
    assert not AccountErasure.objects.exists()
    assert User.objects.get(pk=world[2][0].user_id).enabled
    assert Membership.objects.get(pk=world[2][0].id).state == "active"


def test_account_cutoff_blocks_restore_and_new_push_and_enforces_explicit_nonstatutory_deadline(
    world,
):
    transfer(world)
    _, _, principal = seed(world)
    row = admit(world, purge_not_before=database_now() + timedelta(hours=1))
    with pytest.raises(ValueError, match="not due"), transaction.atomic():
        purge_account_core(row.id)
    for mutate in [
        lambda: User.objects.filter(pk=row.user_reference).update(enabled=True),
        lambda: Identity.objects.filter(pk=principal.id).update(enabled=True),
        lambda: Membership.objects.filter(pk=world[2][0].id).update(state="active"),
    ]:
        with pytest.raises(IntegrityError, match="durable account cutoff"), transaction.atomic():
            mutate()
    with pytest.raises(IntegrityError, match="admission required"), transaction.atomic():
        AccountErasure.objects.filter(pk=row.id).update(purge_not_before=database_now())
    assert User.objects.get(pk=row.user_reference).email != f"erased:{row.user_reference}"


class AccountControlAdapter:
    """Synthetic receipt control only, never a production account provider."""

    revision = "account-control-v1"

    def __init__(self, domain):
        self.domain = domain

    def erase_and_verify(self, scope):
        from apps.orgs.account_erasure_services import AccountAbsenceProof

        return AccountAbsenceProof(
            scope.request_id,
            scope.user_id,
            scope.cutoff_at,
            self.domain,
            scope.inventory_sha256,
            "8" * 64,
            self.revision,
            database_now(),
        )

    def verify_proof(self, scope, proof):
        return proof.evidence_sha256 == "8" * 64


def test_account_completion_requires_all_person_scoped_receipts_then_pseudonymizes_subject(world):
    from apps.orgs.account_erasure_services import advance_account_erasure
    from apps.orgs.privacy_models import AccountErasureReceipt

    transfer(world)
    _, _, principal = seed(world)
    original_subject = principal.subject
    row = admit(world)
    required = row.inventory["required_domains"]
    adapters = {
        domain: AccountControlAdapter(domain)
        for domain in required
        if domain != "account_message_outbox"
    }
    held = advance_account_erasure(row.id, adapters)
    assert not held["complete"] and held["held_domains"] == ["account_message_outbox"]
    principal.refresh_from_db()
    assert principal.subject == original_subject
    adapters["account_message_outbox"] = AccountControlAdapter("account_message_outbox")
    result = advance_account_erasure(row.id, adapters)
    row.refresh_from_db()
    principal.refresh_from_db()
    assert result["complete"] and not result["held_domains"]
    assert row.status == "complete" and row.completed_at is not None
    assert principal.subject == f"erased:{principal.id}"
    assert AccountErasureReceipt.objects.filter(erasure=row).count() == len(required)
    # Accepted ADR-0016 minimal realm denylist persists while the workspace exists.
    assert EngineKnownSubject.objects.filter(
        user_id=row.user_reference, subject=original_subject, erased_at__isnull=False
    ).exists()
    assert advance_account_erasure(row.id, adapters)["complete"]
    with (
        pytest.raises(IntegrityError, match="erased realm subject cannot be rebound"),
        transaction.atomic(),
    ):
        person = User.objects.create(email="synthetic-rebind@example.test")
        Identity.objects.create(
            user=person,
            organisation=world[0],
            issuer=world[0].issuer,
            realm=world[0].realm,
            subject=original_subject,
            email=person.email,
        )
    with pytest.raises(IntegrityError, match="receipt immutable"), transaction.atomic():
        AccountErasureReceipt.objects.filter(erasure=row).update(evidence_sha256="9" * 64)


@pytest.mark.parametrize(
    "mutation",
    [
        "request",
        "person",
        "cutoff",
        "inventory",
        "domain",
        "revision",
        "digest",
        "future",
        "unverified",
        "workspace_type",
    ],
)
def test_account_scoped_proof_mutations_refuse_without_receipt_or_completion(world, mutation):
    from uuid import uuid4

    from apps.orgs.account_erasure_services import AccountErasureScope, persist_account_absence
    from apps.orgs.erasure_services import AbsenceProof
    from apps.orgs.privacy_models import AccountErasureReceipt

    transfer(world)
    row = admit(world)
    purge_account_core(row.id)
    scope = AccountErasureScope(row.id, row.user_reference, row.cutoff_at, row.inventory)
    adapter = AccountControlAdapter("private_exports")
    proof = adapter.erase_and_verify(scope)
    values = {
        "request": {"request_id": uuid4()},
        "person": {"user_id": uuid4()},
        "cutoff": {"cutoff_at": row.cutoff_at - timedelta(seconds=1)},
        "inventory": {"inventory_sha256": "9" * 64},
        "domain": {"domain": "matrix_accounts"},
        "revision": {"adapter_revision": "other"},
        "digest": {"evidence_sha256": "bad"},
        "future": {"verified_at": database_now() + timedelta(hours=1)},
        "unverified": {"evidence_sha256": "9" * 64},
    }
    bad = (
        AbsenceProof(
            row.id,
            world[0].id,
            row.cutoff_at,
            "private_exports",
            scope.inventory_sha256,
            "8" * 64,
            adapter.revision,
            database_now(),
        )
        if mutation == "workspace_type"
        else replace(proof, **values[mutation])
    )
    with pytest.raises(ValueError, match="account erasure proof"):
        persist_account_absence(scope, bad, adapter)
    assert not AccountErasureReceipt.objects.exists()
    assert not purge_account_core(row.id)["complete"]


def test_processing_login_resumes_account_but_cannot_admit_or_read_personal_tables(world):
    import psycopg
    from test_erasure_review_guards import restricted_login

    transfer(world)
    row = admit(world)
    # Reuse the independently authenticated fixture with explicit teardown, not SET ROLE.
    with restricted_login("worker") as (name, connect):
        with connect() as login:
            assert login.execute("SELECT current_user,session_user").fetchone() == (name, name)
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                login.execute("SELECT email FROM public.identity_user")
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                login.execute("SELECT privacy_begin_account_erasure(NULL,NULL,NULL,NULL,NULL,NULL)")
            login.execute("SELECT privacy_purge_account_core(%s)", [row.id])
            assert (
                login.execute("SELECT privacy_complete_account_erasure(%s)", [row.id]).fetchone()[0]
                is False
            )
            for domain in row.inventory["required_domains"]:
                login.execute(
                    "SELECT privacy_record_account_absence(%s,%s,%s,%s,%s,%s,%s,clock_timestamp())",
                    [
                        row.id,
                        row.user_reference,
                        row.cutoff_at,
                        row.inventory_sha256,
                        domain,
                        "8" * 64,
                        "synthetic-independent-control",
                    ],
                )
            assert (
                login.execute("SELECT privacy_complete_account_erasure(%s)", [row.id]).fetchone()[0]
                is True
            )


def test_workspace_can_complete_after_person_cutoff_without_restoring_account(world):
    from test_core_erasure import ControlledAdapter, begin

    from apps.orgs.erasure_services import advance_erasure

    transfer(world)
    seed(world)
    account = admit(world)
    purge_account_core(account.id)
    workspace = begin(world[0])
    result = advance_erasure(
        workspace.id,
        {domain: ControlledAdapter(domain) for domain in workspace.inventory["required_domains"]},
    )
    assert result["complete"]
    assert not User.objects.get(pk=account.user_reference).enabled
    assert not purge_account_core(account.id)["complete"]


def test_account_subject_finalization_across_pending_workspace_cutoff_preserves_its_holds(world):
    from uuid import uuid4

    from django.utils import timezone
    from test_core_erasure import begin
    from workspace_safety.test_moderation import world as make_world

    from apps.orgs.account_erasure_services import advance_account_erasure

    other, _, _, other_tokens = make_world.__wrapped__()
    person = world[2][0].user
    other_principal = Identity.objects.create(
        user=person,
        organisation=other,
        issuer=other.issuer,
        realm=other.realm,
        subject=str(uuid4()),
        email=person.email,
    )
    Membership.objects.create(
        user=person,
        organisation=other,
        role="org_member",
        state="active",
        accepted_at=timezone.now(),
    )
    original = Identity.objects.get(organisation=world[0], user=person)
    pending_workspace = begin(world[0])
    assert original.subject == Identity.objects.get(pk=original.pk).subject
    row = admit(
        world,
        verified=replace(
            other_tokens[0],
            subject=other_principal.subject,
            auth_time=int(database_now().timestamp()),
        ),
    )
    result = advance_account_erasure(
        row.id,
        {domain: AccountControlAdapter(domain) for domain in row.inventory["required_domains"]},
    )
    assert result["complete"]
    original.refresh_from_db()
    assert original.subject == f"erased:{original.id}"
    pending_workspace.refresh_from_db()
    assert pending_workspace.status == "cutoff" and pending_workspace.completed_at is None
    assert pending_workspace.erasurereceipt_set.count() == 0
    # Neither account completion nor its narrow context authorizes a different identity write.
    with (
        pytest.raises(IntegrityError, match="durable erasure cutoff|durable account cutoff"),
        transaction.atomic(),
    ):
        Identity.objects.filter(pk=original.pk).update(email="restored@example.test")
    assert User.objects.get(pk=world[2][1].user_id).enabled
