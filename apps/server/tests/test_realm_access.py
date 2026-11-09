"""The realm access delivery, against PostgreSQL: docs/specs/MEMBERSHIP_LIFECYCLE.md §6.1.

Membership changes go through the real signed views (the `m` world of test_membership_lifecycle).
The run calls a fake realm admin at the Keycloak boundary: an in-memory set of realm users keyed by
(realm, user id), with their enabled flag, online sessions and offline grants, which records every
call and can be told to fail one. The HTTP client is test_realm_access_client.py's; one check here
drives the command through it end to end.

Each check raises an AssertionError whose message starts with its own fixed first line (`CHECK
<name>:`). Each mutant of MUTANTS patches one part of the delivery and requires exactly its owning
check's line, so no check here passes without having been seen to fail for its own reason.
"""

from __future__ import annotations

import io
import json
import logging
import re
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection, transaction
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_customer_persistence_concurrency import session
from test_customer_persistence_models import identity
from test_membership_lifecycle import audit, delete, m as m, patch, problem, stored
from test_realm_access_client import SECRET, TOKEN, keycloak_hosts
from test_workspace_onboarding import http_signer as http_signer, model, person, realm_job

from apps.engine_intents import services as engine_services
from apps.engine_intents.services import issue_credential
from apps.jobs import locks
from apps.jobs.kinds import Lock
from apps.orgs import membership_lifecycle
from apps.orgs.management.commands.run_realm_deliveries import ORGANISATION_LOCK
from apps.outbox import realm_access, realm_enqueue
from apps.outbox.realm import keycloak
from apps.outbox.realm.keycloak import RealmCallError, RealmTarget

pytestmark = pytest.mark.django_db(transaction=True)

# The test organisations' issuers are https://identity.customer.test/realms/<slug>.
ISSUER_ORIGIN = "https://identity.customer.test"


# ------------------------------------------------------------------------- fake realm ----


@dataclass
class RealmUser:
    enabled: bool = True
    sessions: list[str] = field(default_factory=lambda: ["online-1"])
    offline: set[str] = field(default_factory=lambda: {"console"})


class FakeRealms:
    """Realm users of every realm, keyed by (realm, user id), and every call made to them."""

    def __init__(self) -> None:
        self.users: dict[tuple[str, str], RealmUser] = {}
        self.calls: list[tuple[str, ...]] = []
        self.failures: dict[str, list[Exception]] = {}
        self.no_op: set[str] = set()
        self.opened: list[str] = []
        # Per realm user: an error every read raises, or a delay every read takes.
        self.unreadable: dict[str, Exception] = {}
        self.slow: dict[str, float] = {}
        # Per realm: an error every listing raises, or a delay every listing takes.
        self.unlistable: dict[str, Exception] = {}
        self.slow_list: dict[str, float] = {}

    def add(self, realm: str, user_id: str, **values: Any) -> RealmUser:
        self.users[(realm, user_id)] = RealmUser(**values)
        return self.users[(realm, user_id)]

    def fail(self, method: str, *errors: Exception) -> None:
        self.failures.setdefault(method, []).extend(errors)

    def named(self, name: str) -> list[tuple[str, ...]]:
        return [call for call in self.calls if call[1] == name]

    @contextmanager
    def factory(self, target: RealmTarget, deadline: float | None = None) -> Iterator[FakeAdmin]:
        self.opened.append(target.realm)
        queued = self.failures.get("open")
        if queued:
            raise queued.pop(0)
        yield FakeAdmin(self, target)


class FakeAdmin:
    def __init__(self, realms: FakeRealms, target: RealmTarget) -> None:
        self.realms = realms
        self.realm = target.realm

    def _hit(self, name: str, *args: str) -> RealmUser | None:
        self.realms.calls.append((self.realm, name, *args))
        if args and name == "get_user":
            if args[0] in self.realms.slow:
                time.sleep(self.realms.slow[args[0]])
            if args[0] in self.realms.unreadable:
                raise self.realms.unreadable[args[0]]
        queued = self.realms.failures.get(name)
        if queued:
            raise queued.pop(0)
        return self.realms.users.get((self.realm, args[0])) if args else None

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        user = self._hit("get_user", user_id)
        return None if user is None else {"id": user_id, "enabled": user.enabled}

    def set_enabled(self, user_id: str, enabled: bool) -> None:
        user = self._hit("set_enabled", user_id)
        assert user is not None
        if "set_enabled" not in self.realms.no_op:
            user.enabled = enabled

    def logout(self, user_id: str) -> None:
        user = self._hit("logout", user_id)
        if user is None:
            raise keycloak.RealmUserAbsentError()
        if "logout" not in self.realms.no_op:
            user.sessions = []

    def consents(self, user_id: str) -> list[dict[str, Any]]:
        user = self._hit("consents", user_id)
        return [] if user is None else [{"clientId": c} for c in sorted(user.offline)]

    def revoke_consent(self, user_id: str, client_id: str) -> None:
        user = self._hit("revoke_consent", user_id, client_id)
        if user is not None and "revoke_consent" not in self.realms.no_op:
            user.offline.discard(client_id)

    def sessions(self, user_id: str) -> list[dict[str, Any]]:
        user = self._hit("sessions", user_id)
        return [] if user is None else [{"id": s} for s in user.sessions]

    def enabled_user_ids(self, *, deadline: float | None = None) -> set[str]:
        self._hit("enabled_user_ids")
        if self.realm in self.realms.slow_list:
            time.sleep(self.realms.slow_list[self.realm])
        if self.realm in self.realms.unlistable:
            raise self.realms.unlistable[self.realm]
        return {
            uid
            for (realm, uid), u in self.realms.users.items()
            if realm == self.realm and u.enabled
        }

    def count_users(self) -> int:
        self._hit("count_users")
        return sum(1 for realm, _ in self.realms.users if realm == self.realm)


@pytest.fixture
def realms(m):
    found = FakeRealms()
    for who in (m.owner, m.admin, m.billing, m.member):
        found.add("alpha", who.identity.subject)
    found.add("bravo", m.foreigner.identity.subject)
    return found


def run(realms: FakeRealms, **options: Any) -> realm_access.RunReport:
    return realm_access.run_realm_deliveries(
        admin_factory=realms.factory,
        organisation_lock=ORGANISATION_LOCK,
        origins_issuer=ISSUER_ORIGIN,
        **options,
    )


def deliveries() -> list[dict[str, Any]]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT d.id, d.organisation_id, d.category, d.changes_realm, d.status, "
            "r.membership_id, r.identity_id, r.realm_user_id, r.operation "
            "FROM outbox_outboxdelivery d JOIN outbox_realmaccess r ON r.delivery_id = d.id "
            "ORDER BY d.created_at, d.id"
        )
        names = [column.name for column in cursor.description]
        return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]


def attempts(delivery_id) -> list[str]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT outcome FROM outbox_deliveryattempt WHERE delivery_id = %s ORDER BY seq",
            [delivery_id],
        )
        return [row[0] for row in cursor.fetchall()]


def sql(statement: str, parameters: list[Any] | None = None) -> None:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)


def all_due() -> None:
    sql("UPDATE outbox_realmaccess SET not_before = clock_timestamp()")


def set_state(who, state: str) -> None:
    sql("UPDATE orgs_membership SET state = %s WHERE id = %s", [state, who.member.id])


def suspend(w, who):
    response = patch(w, w.owner, who.member, {"state": "suspended"})
    assert response.status_code == 200, response.content


def reactivate(w, who):
    response = patch(w, w.owner, who.member, {"state": "active"})
    assert response.status_code == 200, response.content


def remove(w, who):
    response = delete(w, w.owner, who.member)
    assert response.status_code == 200, response.content


def reasons() -> list[tuple[str, str | None]]:
    return [
        (row["action"], row["metadata"].get("reason"))
        for row in audit()
        if row["action"].startswith("outbox_delivery.")
    ]


def forge(organisation_id, membership_id, identity_id, realm_user_id, operation="access_off"):
    """A row as the API role could write it: it holds INSERT on both tables."""
    with transaction.atomic():
        return realm_enqueue.insert_realm_access(
            organisation_id=organisation_id,
            membership_id=membership_id,
            identity_id=identity_id,
            realm_user_id=realm_user_id,
            operation=operation,
        )


# ------------------------------------------------------------------- what is written ----


def check_each_change_writes_its_deliveries(w) -> None:
    suspend(w, w.member)
    reactivate(w, w.member)
    remove(w, w.member)
    found = deliveries()
    assert [(d["operation"], d["realm_user_id"]) for d in found] == [
        ("access_off", "alpha-member"),
        ("access_on", "alpha-member"),
        ("access_off", "alpha-member"),
    ], "CHECK each_change: a change did not write its delivery"
    assert all(
        d["category"] == "identity_user_operation"
        and d["changes_realm"]
        and d["status"] == "pending"
        for d in found
    ), "CHECK each_change: a delivery has the wrong shape"
    assert {d["membership_id"] for d in found} == {w.member.member.id}
    assert {d["identity_id"] for d in found} == {w.member.identity.id}


def test_each_change_writes_its_deliveries(m):
    check_each_change_writes_its_deliveries(m)


def test_a_no_op_a_role_change_a_repeat_and_a_refusal_write_nothing(m):
    assert patch(m, m.owner, m.admin.member, {"role": "org_member"}).status_code == 200
    assert patch(m, m.owner, m.admin.member, {"state": "active"}).status_code == 200
    problem(delete(m, m.admin, m.owner.member), 403, "forbidden")
    remove(m, m.billing)
    assert len(deliveries()) == 1
    remove(m, m.billing)  # a repeat writes nothing
    assert len(deliveries()) == 1


def test_a_person_without_a_realm_identity_gets_no_delivery(m):
    user = m.models.User.objects.create(email="invited@customer.test")
    invited = m.models.Membership.objects.create(
        user=user, organisation=m.alpha, role="org_member", state="invited"
    )
    response = delete(m, m.owner, invited)
    assert response.status_code == 200, response.content
    assert deliveries() == []


def test_access_on_names_usable_identities_only(m):
    suspend(m, m.member)
    sql("UPDATE identity_identity SET enabled = false WHERE id = %s", [m.member.identity.id])
    reactivate(m, m.member)
    assert [d["operation"] for d in deliveries()] == ["access_off"], (
        "an access_on named a disabled identity"
    )


def check_a_rolled_back_change_leaves_no_delivery(w, monkeypatch) -> None:
    issue_credential(organisation_id=w.alpha.id)  # an agent would receive the set
    monkeypatch.setattr(engine_services, "MAX_SUBJECTS", 1)
    problem(patch(w, w.owner, w.member.member, {"state": "suspended"}), 500, "internal-error")
    problem(delete(w, w.owner, w.member.member), 500, "internal-error")
    assert stored(w.member.member).state == "active"
    assert deliveries() == [], "CHECK rollback: a delivery outlived the change it belongs to"


def test_a_rolled_back_change_leaves_no_delivery(m, monkeypatch):
    check_a_rolled_back_change_leaves_no_delivery(m, monkeypatch)


def test_the_enqueue_raises_outside_a_transaction(m):
    with pytest.raises(realm_enqueue.RealmEnqueueError):
        realm_enqueue.enqueue_realm_access(
            organisation_id=m.alpha.id,
            membership_id=m.member.member.id,
            user_id=m.member.user.id,
            operation="access_off",
        )
    assert deliveries() == []


# ---------------------------------------------------------------------------- the run ----


def check_off_disables_logs_out_and_revokes(w, realms) -> None:
    suspend(w, w.member)
    report = run(realms)
    user = realms.users[("alpha", "alpha-member")]
    assert user.sessions == [], "CHECK off: the online sessions were not ended"
    assert user.offline == set(), "CHECK off: the offline grants were not revoked"
    assert user.enabled is False, "CHECK off: the user was not disabled"
    assert report.succeeded == 1 and not report.needs_operator, report.line()
    [delivery] = deliveries()
    assert delivery["status"] == "succeeded" and attempts(delivery["id"]) == ["accepted"]
    assert reasons() == [("outbox_delivery.sent", None)]


def test_off_disables_logs_out_and_revokes(m, realms):
    check_off_disables_logs_out_and_revokes(m, realms)


def test_a_repeated_off_converges_without_changing_the_user(m, realms):
    suspend(m, m.member)
    run(realms)
    realms.calls.clear()
    admin = FakeAdmin(realms, RealmTarget("alpha"))
    assert realm_access.turn_off(admin, "alpha-member") is None
    assert realms.named("set_enabled") == [] and realms.named("revoke_consent") == []


def test_on_enables_and_restores_nothing(m, realms):
    suspend(m, m.member)
    run(realms)
    reactivate(m, m.member)
    realms.calls.clear()
    report = run(realms)
    user = realms.users[("alpha", "alpha-member")]
    assert report.succeeded == 1 and user.enabled is True
    assert user.sessions == [] and user.offline == set()
    assert realms.named("logout") == [] and realms.named("revoke_consent") == []


def test_on_overrides_a_disable_made_in_keycloak(m, realms):
    suspend(m, m.member)
    run(realms)
    reactivate(m, m.member)
    run(realms)
    realms.users[("alpha", "alpha-member")].enabled = False  # an admin disabled them in Keycloak
    suspend(m, m.member)
    reactivate(m, m.member)
    run(realms)
    assert realms.users[("alpha", "alpha-member")].enabled is True


def test_on_waits_for_an_earlier_off_of_the_same_person(m, realms):
    suspend(m, m.member)
    # A read failed before any write: safe to retry later (a failed write would be held instead).
    realms.fail("get_user", RealmCallError("temporary", http_status=503))
    first = run(realms)
    assert first.deferred == 1
    reactivate(m, m.member)
    report = run(realms)  # the off waits for its backoff; the later on must wait behind it
    off, on = deliveries()
    assert off["status"] == "pending" and attempts(off["id"]) == ["temporary"]
    assert on["status"] == "pending" and attempts(on["id"]) == [], "on ran before the earlier off"
    assert report.succeeded == 0 and realms.named("set_enabled") == []
    all_due()
    final = run(realms)
    # The off now finds the membership active and is withdrawn; the on then enables.
    assert final.withdrawn == 1 and final.succeeded == 1
    assert [d["status"] for d in deliveries()] == ["failed", "succeeded"]
    assert realms.users[("alpha", "alpha-member")].enabled is True


def test_a_member_of_two_organisations_is_revoked_in_one_realm_only(m, realms):
    bound = identity(m.models, m.bravo, m.member.user, subject="bravo-member")
    m.models.Membership.objects.create(
        user=m.member.user,
        organisation=m.bravo,
        role="org_member",
        state="active",
        accepted_at=timezone.now(),
    )
    realms.add("bravo", bound.subject)
    remove(m, m.member)
    run(realms)
    assert set(realms.opened) == {"alpha"} and {call[0] for call in realms.calls} == {"alpha"}
    assert realms.users[("alpha", "alpha-member")].enabled is False
    assert realms.users[("bravo", "bravo-member")].enabled is True


def test_a_server_error_backs_off_and_the_fifth_fails(m, realms):
    suspend(m, m.member)
    for _ in range(5):
        realms.fail("get_user", RealmCallError("temporary", http_status=503))
    reports = []
    for _ in range(5):
        all_due()
        reports.append(run(realms))
    [delivery] = deliveries()
    assert attempts(delivery["id"]) == ["temporary"] * 5
    assert delivery["status"] == "failed"
    assert [r.deferred for r in reports] == [1, 1, 1, 1, 0] and reports[-1].failed == 1
    assert reasons()[-1] == ("outbox_delivery.failed", "attempts_exhausted")


def test_a_deferral_moves_not_before(m, realms):
    suspend(m, m.member)
    realms.fail("get_user", RealmCallError("temporary", http_status=502))
    with pytest.MonkeyPatch.context() as patched:
        patched.setattr(realm_access, "jitter", lambda upper: upper)
        run(realms)
    with connection.cursor() as cursor:
        cursor.execute("SELECT not_before - clock_timestamp() FROM outbox_realmaccess")
        waited = cursor.fetchone()[0].total_seconds()
    # The 15 s floor above the request timeout, then the first deferral's full 30 s of jitter.
    assert 40 < waited <= 45
    assert run(realms).succeeded == 0, "a deferred delivery ran before its backoff"


def test_an_absent_user_needs_a_realm_that_answers_and_is_counted(m, realms, caplog):
    del realms.users[("alpha", "alpha-member")]
    remove(m, m.member)
    with caplog.at_level(logging.WARNING, logger="apps.outbox.realm_access"):
        report = run(realms)
    assert report.succeeded == 1 and report.user_absent == 1
    assert realms.named("count_users") == [("alpha", "count_users")]
    assert reasons()[-1] == ("outbox_delivery.sent", "user_absent")
    assert "realm user absent" in caplog.text


def test_a_rejection_fails_for_an_operator(m, realms, caplog):
    suspend(m, m.member)
    realms.fail("set_enabled", RealmCallError("permanent", http_status=400))
    with caplog.at_level(logging.ERROR, logger="apps.outbox.realm_access"):
        report = run(realms)
    [delivery] = deliveries()
    assert report.failed == 1 and report.needs_operator
    assert delivery["status"] == "failed" and attempts(delivery["id"]) == ["permanent"]
    assert reasons()[-1] == ("outbox_delivery.failed", "rejected")
    assert str(delivery["id"]) in caplog.text


def test_a_readback_that_does_not_match_is_deferred(m, realms):
    suspend(m, m.member)
    realms.no_op.add("set_enabled")
    report = run(realms)
    assert report.deferred == 1 and report.succeeded == 0
    assert reasons()[-1] == ("outbox_delivery.deferred", "readback_mismatch")


# ------------------------------------------------- unreachable and refused credential ----


def check_a_refused_credential_needs_an_operator_at_once(w, realms) -> None:
    suspend(w, w.member)
    realms.fail("open", RealmCallError("credential", http_status=403))
    report = run(realms)
    [delivery] = deliveries()
    assert report.credential == 1 and report.needs_operator, (
        "CHECK credential: a refused credential did not need an operator"
    )
    assert delivery["status"] == "pending" and attempts(delivery["id"]) == ["transport"]
    assert reasons()[-1] == ("outbox_delivery.deferred", "credential")


def test_a_refused_credential_needs_an_operator_at_once(m, realms):
    check_a_refused_credential_needs_an_operator_at_once(m, realms)


def test_the_command_exits_non_zero_on_a_refused_credential(m, settings, tmp_path):
    settings.KODERA_REALM_WORKER_SECRET_DIR = str(tmp_path)  # holds no credential
    settings.KODERA_REALM_ORIGINS = keycloak.RealmOrigins(
        issuer=ISSUER_ORIGIN, admin="http://127.0.0.1:1"
    )
    set_state(m.member, "removed")
    out = io.StringIO()
    with pytest.raises(CommandError, match="needs an operator"):
        call_command("run_realm_deliveries", "--once", stdout=out)
    assert re.search(r"\bcredential=[1-9]", out.getvalue()), out.getvalue()


# ------------------------------------------------------ the payload is not trusted ----


def user_calls(realms) -> list[tuple[str, ...]]:
    """Every call that acts on one realm user: what a delivery makes, unlike a realm listing."""
    return [call for call in realms.calls if call[1] != "enabled_user_ids"]


def check_a_forged_realm_user_id_is_never_executed(w, realms) -> None:
    forged = forge(w.alpha.id, w.member.member.id, w.member.identity.id, "alpha-owner")
    set_state(w.member, "suspended")
    report = run(realms, reconcile_first=False)
    assert attempts(forged) == [] and user_calls(realms) == [], (
        "CHECK forged_subject: a forged realm user id reached Keycloak"
    )
    assert report.mismatched == 1 and report.needs_operator
    assert reasons()[-1] == ("outbox_delivery.failed", "payload_mismatch")


def test_a_forged_realm_user_id_is_never_executed(m, realms):
    check_a_forged_realm_user_id_is_never_executed(m, realms)


def check_a_cross_organisation_payload_is_never_executed(w, realms) -> None:
    # A bravo delivery naming alpha's member and identity: another organisation's realm user.
    set_state(w.member, "suspended")
    forged = forge(w.bravo.id, w.member.member.id, w.member.identity.id, "alpha-member")
    report = run(realms, reconcile_first=False)
    assert attempts(forged) == [] and user_calls(realms) == [], (
        "CHECK cross_organisation: a payload naming another organisation's member was executed"
    )
    assert report.mismatched == 1


def test_a_cross_organisation_payload_is_never_executed(m, realms):
    check_a_cross_organisation_payload_is_never_executed(m, realms)


def test_another_persons_identity_is_never_executed(m, realms):
    set_state(m.member, "suspended")
    forged = forge(m.alpha.id, m.member.member.id, m.owner.identity.id, "alpha-owner")
    report = run(realms, reconcile_first=False)
    assert attempts(forged) == [] and user_calls(realms) == [] and report.mismatched == 1


def check_an_issuer_this_keycloak_does_not_serve_is_never_executed(w, realms) -> None:
    suspend(w, w.member)
    report = realm_access.run_realm_deliveries(
        admin_factory=realms.factory,
        organisation_lock=ORGANISATION_LOCK,
        origins_issuer="https://auth.kodera.io",
    )
    assert realms.opened == [], (
        "CHECK issuer: a realm of another Keycloak was sent this worker's credential"
    )
    assert report.mismatched == 1


def test_an_issuer_this_keycloak_does_not_serve_is_never_executed(m, realms):
    check_an_issuer_this_keycloak_does_not_serve_is_never_executed(m, realms)


# -------------------------------------------------------------------- withdrawals ----


def test_an_on_whose_membership_is_no_longer_active_is_withdrawn(m, realms):
    suspend(m, m.member)
    run(realms)
    reactivate(m, m.member)
    suspend(m, m.member)
    realms.calls.clear()
    report = run(realms)
    _, on, off = deliveries()
    assert on["status"] == "failed" and attempts(on["id"]) == []
    assert report.withdrawn == 1 and not report.needs_operator
    assert realms.named("set_enabled") == [], "a user was enabled for a suspended membership"
    assert off["status"] == "succeeded"
    assert realms.users[("alpha", "alpha-member")].enabled is False


def check_an_off_whose_membership_is_active_again_is_withdrawn(w, realms) -> None:
    # The reconcile race: a reconcile read the membership suspended, the reactivation committed
    # its access_on, then the reconcile committed an access_off after it.
    suspend(w, w.member)
    run(realms)
    reactivate(w, w.member)
    run(realms)
    forge(w.alpha.id, w.member.member.id, w.member.identity.id, "alpha-member")
    report = run(realms)
    assert realms.users[("alpha", "alpha-member")].enabled is True, (
        "CHECK off_withdrawn: an access_off disabled an active member"
    )
    assert report.withdrawn == 1


def test_an_off_whose_membership_is_active_again_is_withdrawn(m, realms):
    check_an_off_whose_membership_is_active_again_is_withdrawn(m, realms)


# ------------------------------------------------------------- the organisation lock ----


def test_a_delivery_is_held_while_a_job_holds_the_organisation_lock(m, realms):
    suspend(m, m.member)
    other = session()
    key = [locks.CLASS_CODE["organisation"], str(m.alpha.id)]
    try:
        other.execute("SELECT pg_advisory_lock(%s, hashtext(%s::text))", key)
        report = run(realms)
        assert report.held >= 1 and realms.calls == [], "a delivery ran under a job's lock"
        other.execute("SELECT pg_advisory_unlock(%s, hashtext(%s::text))", key)
    finally:
        other.close()
    assert run(realms).succeeded == 1
    # The run released the lock it took: a job can take it exclusively now.
    exclusive = Lock("organisation", m.alpha.id, "exclusive")
    assert locks.try_lock(exclusive)
    locks.unlock([exclusive])


def test_a_delivery_is_held_while_a_realm_job_waits_for_the_organisation_lock(m, realms):
    suspend(m, m.member)
    job = realm_job(m.alpha, "queued")
    model("jobs", "Job").objects.filter(id=job.id).update(lock_requested_at=timezone.now())
    report = run(realms)
    assert report.held >= 1 and realms.calls == [], "a delivery jumped a waiting realm job"
    assert deliveries()[0]["status"] == "pending"


# ------------------------------------------------------- abandoned, stuck, outstanding ----


def stall(claimed_by="access_on"):
    """Claim the next delivery as a runner that then stalls past the lease: its attempt stays
    open, 16 minutes old. Returns the claim, so the test can land its outcome late."""
    claimed = realm_access.claim_next(
        realm_access.RunReport(), set(), ORGANISATION_LOCK, origins_issuer=ISSUER_ORIGIN
    )
    assert claimed is not None and claimed.operation == claimed_by
    ORGANISATION_LOCK.release(organisation_id=claimed.organisation_id)
    sql(
        "UPDATE outbox_deliveryattempt SET started_at = clock_timestamp() - "
        "interval '16 minutes' WHERE id = %s",
        [claimed.attempt_id],
    )
    return claimed


def check_an_abandoned_attempt_is_held_for_an_operator(w, realms) -> None:
    """The counterexample: a stalled access_on, then a suspension. Nothing may enable the
    suspended member silently, and the case must be reported on every run."""
    suspend(w, w.member)
    run(realms)
    reactivate(w, w.member)
    claimed = stall("access_on")
    suspend(w, w.member)
    all_due()
    realms.calls.clear()
    report = run(realms)
    on = next(d for d in deliveries() if d["id"] == claimed.delivery_id)
    assert on["status"] == "needs_reconciliation", (
        "CHECK abandoned: an abandoned attempt was retried instead of held for an operator"
    )
    assert attempts(on["id"]) == ["abandoned"]
    assert user_calls(realms) == [], "the later access_off ran past an unresolved outcome"
    assert report.reconciliation == 1 and report.outstanding >= 1 and report.needs_operator
    assert ("outbox_delivery.reconciliation_required", "attempt_abandoned") in reasons()
    # The stalled runner wakes and its enable lands: recorded nowhere, and reported.
    realms.users[("alpha", "alpha-member")].enabled = True
    late = realm_access.RunReport()
    realm_access.record_outcome(claimed, realm_access.Outcome("accepted", None), late)
    assert late.late == 1 and late.needs_operator
    assert next(d for d in deliveries() if d["id"] == claimed.delivery_id)["status"] == (
        "needs_reconciliation"
    )
    assert run(realms).needs_operator, "an unresolved outcome stopped being reported"


def test_an_abandoned_attempt_is_held_for_an_operator(m, realms):
    check_an_abandoned_attempt_is_held_for_an_operator(m, realms)


def test_an_operator_decides_the_stalled_attempt_from_a_fresh_realm_read(m, realms, monkeypatch):
    from test_staff_identity import operator

    from apps.identity.command_principal import staff_principal_for_command
    from apps.jobs.services import Evidence
    from apps.orgs.realm_access_decision import decide_realm_access_attempt

    check_an_abandoned_attempt_is_held_for_an_operator(m, realms)
    [held] = [d for d in deliveries() if d["status"] == "needs_reconciliation"]
    from types import SimpleNamespace

    staff = operator(SimpleNamespace(**vars(m.models), StaffRole=model("identity", "StaffRole")))
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        stopped = cursor.fetchone()[0]
    monkeypatch.setattr(realm_access, "RECONCILE_QUIET_PERIOD", timedelta(0))
    decided = decide_realm_access_attempt(
        principal=staff_principal_for_command(staff.id),
        delivery_id=held["id"],
        compute_terminated=Evidence(
            provider="lab-runner", resource_id="runner-a", request_id="stop-1", observed_at=stopped
        ),
        admin_factory=realms.factory,
        origins_issuer=ISSUER_ORIGIN,
    )
    # The enable landed: the access_on is completed as observed, and Core, which asks for off now,
    # gets a fresh access_off in the decision's transaction.
    assert (decided.exit, decided.operation_outcome) == ("resume", "completed")
    assert decided.observed.enabled is True and decided.enqueued == "access_off"
    assert ("outbox_delivery.reconciliation_decided", None) in [
        (row["action"], None) for row in audit() if row["action"].endswith("decided")
    ]
    report = run(realms)
    assert realms.users[("alpha", "alpha-member")].enabled is False
    assert report.outstanding == 0 and not report.needs_operator, report.line()


def check_a_delayed_enable_never_undoes_a_removal(w, realms) -> None:
    """The verdict's counterexample: an access_on's PUT reaches Keycloak and times out here; the
    member is removed; Keycloak finishes the enable last. Nothing may report the removal done."""
    suspend(w, w.member)
    run(realms)
    reactivate(w, w.member)
    realms.fail("set_enabled", RealmCallError("ambiguous", cause="TimeoutError"))
    first = run(realms)
    on = deliveries()[-1]
    assert on["status"] == "needs_reconciliation" and attempts(on["id"]) == ["ambiguous"], (
        "CHECK ambiguous: a write with an unknown outcome was not held for an operator"
    )
    assert first.reconciliation == 1 and first.needs_operator
    remove(w, w.member)
    all_due()
    realms.calls.clear()
    blocked = run(realms)
    assert user_calls(realms) == [], "CHECK ambiguous: a later delivery ran past an unknown outcome"
    assert blocked.outstanding >= 1 and blocked.needs_operator
    realms.users[("alpha", "alpha-member")].enabled = True  # Keycloak finishes the enable now
    later = run(realms)
    assert later.needs_operator, "CHECK ambiguous: the removed member's enable went unreported"
    assert not any(
        d["operation"] == "access_off" and d["status"] == "succeeded" for d in deliveries()[-1:]
    ), "CHECK ambiguous: the removal's access_off was certified before the enable settled"


def test_a_delayed_enable_never_undoes_a_removal(m, realms):
    check_a_delayed_enable_never_undoes_a_removal(m, realms)


def test_an_operator_cannot_decide_inside_the_quiet_period_then_decides_after_it(
    m, realms, monkeypatch
):
    from types import SimpleNamespace

    from test_staff_identity import operator

    from apps.identity.command_principal import staff_principal_for_command
    from apps.jobs.services import Evidence
    from apps.orgs.realm_access_decision import (
        RealmDecisionRefusedError,
        decide_realm_access_attempt,
    )

    check_a_delayed_enable_never_undoes_a_removal(m, realms)
    [held] = [d for d in deliveries() if d["status"] == "needs_reconciliation"]
    staff = operator(SimpleNamespace(**vars(m.models), StaffRole=model("identity", "StaffRole")))
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        now = cursor.fetchone()[0]

    def decide():
        return decide_realm_access_attempt(
            principal=staff_principal_for_command(staff.id),
            delivery_id=held["id"],
            compute_terminated=Evidence(
                provider="kodera-worker",
                resource_id=f"attempt-closed:{held['id']}",
                request_id="closed-1",
                observed_at=now,
            ),
            admin_factory=realms.factory,
            origins_issuer=ISSUER_ORIGIN,
        )

    before = (deliveries(), reasons())
    realms.calls.clear()
    with pytest.raises(RealmDecisionRefusedError, match="quiet_period"):
        decide()
    assert (deliveries(), reasons()) == before and realms.calls == [], "a refusal wrote or read"
    assert realm_access.RECONCILE_QUIET_PERIOD >= timedelta(seconds=330)
    monkeypatch.setattr(realm_access, "RECONCILE_QUIET_PERIOD", timedelta(0))
    decided = decide()
    # The enable landed: completed as observed; Core asks for off, which is pending already and
    # is enqueued again in the decision's transaction. The next run turns the member off.
    assert (decided.exit, decided.observed.enabled, decided.enqueued) == (
        "resume",
        True,
        "access_off",
    )
    final = run(realms)
    assert realms.users[("alpha", "alpha-member")].enabled is False
    assert not final.needs_operator, final.line()


def check_a_direct_enable_after_a_removal_is_corrected(w, realms) -> None:
    """Whatever enables a removed member in Keycloak later (a queued request, an administrator, a
    fault), the next run's bulk verification finds them enabled, turns them off again in the same
    pass, audits it and exits non-zero."""
    remove(w, w.member)
    assert run(realms).succeeded == 1
    user = realms.users[("alpha", "alpha-member")]
    user.enabled, user.sessions, user.offline = True, ["late-1"], {"console"}
    report = run(realms)
    assert report.drift == 1 and report.needs_operator, (
        "CHECK drift: an enable after a completed removal was not found"
    )
    assert (user.enabled, user.sessions, user.offline) == (False, [], set()), (
        "CHECK drift: the drifted realm user was not turned off again in the same pass"
    )
    assert ("outbox_delivery.drift_detected", "realm_drift") in reasons()
    clean = run(realms)
    assert clean.drift == 0 and not clean.needs_operator, clean.line()


def test_a_direct_enable_after_a_removal_is_corrected(m, realms):
    check_a_direct_enable_after_a_removal_is_corrected(m, realms)


def removed_and_turned_off(w, realms, *people):
    for who in people:
        remove(w, who)
    report = run(realms)
    assert report.succeeded == len(people), report.line()


def health(w, organisation=None) -> dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT last_verified_at, unverified_passes, consecutive_failures, last_failure "
            "FROM outbox_realmverification WHERE organisation_id = %s",
            [(organisation or w.alpha).id],
        )
        row = cursor.fetchone()
    names = ("last_verified_at", "unverified_passes", "consecutive_failures", "last_failure")
    return dict(zip(names, row, strict=True)) if row else {}


def test_verification_leaves_open_work_and_active_members_alone(m, realms):
    suspend(m, m.member)
    run(realms)
    reactivate(m, m.member)  # an access_on is pending: the member is not one Core wants off
    set_state(m.billing, "removed")
    with transaction.atomic():
        realm_enqueue.enqueue_realm_access(  # an access_off still pending: open work, not drift
            organisation_id=m.alpha.id,
            membership_id=m.billing.member.id,
            user_id=m.billing.user.id,
            operation="access_off",
        )
    sql("UPDATE outbox_realmaccess SET not_before = clock_timestamp() + interval '1 day'")
    report = run(realms)
    assert report.drift == 0, report.line()
    assert realms.users[("alpha", "alpha-billing")].enabled is True  # left to its own delivery


def test_new_revocations_arriving_every_pass_never_delay_an_old_identity(m, realms, monkeypatch):
    """The rotating sweep's starvation: one new removal per pass kept an old drift unread. Bulk
    verification reads the whole realm every pass with a time phase of its own, so slow new
    deliveries that use up their own phase cannot keep it from running."""
    monkeypatch.setattr(realm_access, "DELIVERY_PHASE_S", 0.25)
    removed_and_turned_off(m, realms, m.billing)
    realms.users[("alpha", "alpha-billing")].enabled = True  # the old identity drifts
    newcomers = [person(m, m.alpha, "org_member", f"alpha-new-{index}") for index in range(3)]
    for index, newcomer in enumerate(newcomers):
        realms.add("alpha", f"alpha-new-{index}")
        realms.slow[f"alpha-new-{index}"] = 0.1  # each new delivery fills the delivery phase
        remove(m, newcomer)
        report = run(realms)
        assert report.succeeded >= 1
        if index == 0:
            assert report.drift == 1, "an old identity waited behind a new revocation"
    assert realms.users[("alpha", "alpha-billing")].enabled is False


def test_more_drifts_than_the_correction_budget_are_all_corrected(m, realms, monkeypatch):
    monkeypatch.setattr(realm_access, "CORRECTION_BUDGET", 2)
    removed_and_turned_off(m, realms, m.member, m.billing, m.admin)
    for subject in ("alpha-member", "alpha-billing", "alpha-admin"):
        realms.users[("alpha", subject)].enabled = True
    first = run(realms)
    assert first.drift == 3 and first.needs_operator
    still = [
        s
        for s in ("alpha-member", "alpha-billing", "alpha-admin")
        if realms.users[("alpha", s)].enabled
    ]
    assert len(still) == 1, "the correction budget was not spent in the same pass"
    run(realms)
    assert not any(
        realms.users[("alpha", s)].enabled for s in ("alpha-member", "alpha-billing", "alpha-admin")
    )


def test_corrections_have_their_own_budget_when_new_deliveries_fill_the_limit(m, realms):
    removed_and_turned_off(m, realms, m.member)
    realms.users[("alpha", "alpha-member")].enabled = True
    remove(m, m.billing)  # one new delivery, and the run's delivery limit is one
    report = run(realms, limit=1)
    assert report.drift == 1 and realms.users[("alpha", "alpha-member")].enabled is False
    assert realms.users[("alpha", "alpha-billing")].enabled is False


def test_a_credential_error_escalates_on_the_first_pass(m, realms):
    removed_and_turned_off(m, realms, m.member)
    realms.unlistable["alpha"] = RealmCallError("credential", http_status=403)
    report = run(realms)
    assert report.credential == 1 and report.needs_operator, report.line()
    assert health(m)["last_failure"] == "credential"


def test_an_unverified_realm_alerts_after_the_pass_threshold(m, realms):
    removed_and_turned_off(m, realms, m.member)
    realms.unlistable["alpha"] = RealmCallError("transport")
    reports = [run(realms) for _ in range(realm_access.VERIFY_ALERT_PASSES)]
    assert all(r.unverifiable == 1 for r in reports)
    assert not any(r.unverified for r in reports[:-1]), "one unanswered listing paged an operator"
    assert reports[-1].unverified == 1 and reports[-1].needs_operator
    del realms.unlistable["alpha"]
    healed = run(realms)
    assert healed.unverified == 0 and not healed.needs_operator, healed.line()


def test_an_unverified_realm_alerts_after_the_time_threshold(m, realms):
    removed_and_turned_off(m, realms, m.member)
    sql(
        "UPDATE outbox_realmverification SET last_verified_at = clock_timestamp() - %s "
        "* interval '1 second'",
        [realm_access.VERIFY_ALERT_AFTER.total_seconds() + 60],
    )
    realms.unlistable["alpha"] = RealmCallError("transport")
    report = run(realms)
    assert report.unverified == 1 and report.needs_operator, report.line()


def test_a_lock_skip_keeps_the_failure_history(m, realms):
    removed_and_turned_off(m, realms, m.member)
    realms.unlistable["alpha"] = RealmCallError("transport")
    run(realms)
    before = health(m)
    assert before["consecutive_failures"] == 1
    other = session()
    key = [locks.CLASS_CODE["organisation"], str(m.alpha.id)]
    try:
        other.execute("SELECT pg_advisory_lock(%s, hashtext(%s::text))", key)
        run(realms)
    finally:
        other.close()
    after = health(m)
    assert after["consecutive_failures"] == 1, "a lock skip cleared the failure history"
    assert after["unverified_passes"] == before["unverified_passes"] + 1
    assert after["last_verified_at"] == before["last_verified_at"]


def test_a_new_access_off_runs_before_verification(m, realms):
    removed_and_turned_off(m, realms, m.billing)
    realms.calls.clear()
    remove(m, m.member)
    run(realms)
    names = [c[1] for c in realms.calls]
    assert names.index("set_enabled") < names.index("enabled_user_ids"), (
        "verification ran before a new revocation"
    )


def test_the_run_deadline_bounds_verification_after_new_revocations(m, realms, monkeypatch):
    for name, value in (
        ("DELIVERY_PHASE_S", 0.2),
        ("CALL_OVERRUN_S", 0.0),
        ("VERIFY_PHASE_S", 0.5),
    ):
        monkeypatch.setattr(realm_access, name, value)
    removed_and_turned_off(m, realms, m.billing)
    bravo_member = person(m, m.bravo, "org_member", "bravo-member")
    realms.add("bravo", "bravo-member")
    set_state(bravo_member, "removed")  # a second realm needs verification too
    realms.slow_list["alpha"] = realms.slow_list["bravo"] = 0.4
    remove(m, m.member)
    realms.calls.clear()  # only the measured pass's calls
    started = time.monotonic()
    report = run(realms)
    elapsed = time.monotonic() - started
    assert realms.users[("alpha", "alpha-member")].enabled is False and report.succeeded >= 1
    assert len(realms.named("enabled_user_ids")) <= 2 and elapsed < 2.0, (elapsed, report.line())


def test_a_second_concurrent_run_exits_already_running_and_does_nothing(
    m, realms, settings, tmp_path
):
    settings.KODERA_REALM_WORKER_SECRET_DIR = str(tmp_path)
    settings.KODERA_REALM_ORIGINS = keycloak.RealmOrigins(
        issuer=ISSUER_ORIGIN, admin="http://127.0.0.1:1"
    )
    set_state(m.member, "removed")
    other = session()
    try:
        held = other.execute(
            "SELECT pg_try_advisory_lock(hashtext(%s))", [realm_access.RUN_LOCK]
        ).fetchone()[0]
        assert held
        out = io.StringIO()
        call_command("run_realm_deliveries", "--once", stdout=out)
        assert out.getvalue().strip() == "already_running", out.getvalue()
        assert deliveries() == [], "a run that found another running wrote something"
    finally:
        other.close()


@pytest.mark.parametrize("stuck", [False, True])
def test_a_run_lock_held_too_long_is_reported_stuck(
    m, realms, settings, tmp_path, monkeypatch, stuck
):
    settings.KODERA_REALM_WORKER_SECRET_DIR = str(tmp_path)
    settings.KODERA_REALM_ORIGINS = keycloak.RealmOrigins(
        issuer=ISSUER_ORIGIN, admin="http://127.0.0.1:1"
    )
    if stuck:  # the holder's session is older than the threshold
        monkeypatch.setattr(realm_access, "STUCK_RUN_AFTER_S", -1.0)
    other = session()
    try:
        other.execute("SELECT pg_try_advisory_lock(hashtext(%s))", [realm_access.RUN_LOCK])
        out = io.StringIO()
        if stuck:
            with pytest.raises(CommandError, match="stuck_run"):
                call_command("run_realm_deliveries", "--once", stdout=out)
            assert out.getvalue().strip().startswith("stuck_run")
        else:
            call_command("run_realm_deliveries", "--once", stdout=out)
            assert out.getvalue().strip() == "already_running"
    finally:
        other.close()


def test_corrections_still_run_when_new_deliveries_overrun_their_phase(m, realms, monkeypatch):
    for name, value in (
        ("DELIVERY_PHASE_S", 0.3),
        ("VERIFY_PHASE_S", 0.3),
        ("CORRECTION_PHASE_S", 0.3),
        ("CALL_OVERRUN_S", 0.3),
    ):
        monkeypatch.setattr(realm_access, name, value)
    monkeypatch.setattr(realm_access, "RUN_DEADLINE_S", 0.3 + 0.3 + 0.3 + 0.3 + 0.3)
    removed_and_turned_off(m, realms, m.member)
    realms.users[("alpha", "alpha-member")].enabled = True  # the drift to correct
    newcomers = [person(m, m.alpha, "org_member", f"alpha-slow-{i}") for i in range(4)]
    for index, newcomer in enumerate(newcomers):
        realms.add("alpha", f"alpha-slow-{index}")
        realms.slow[f"alpha-slow-{index}"] = 0.25  # every new delivery overruns its phase
        remove(m, newcomer)
    report = run(realms)
    assert report.drift == 1, report.line()
    assert realms.users[("alpha", "alpha-member")].enabled is False, (
        "the overrunning deliveries left the correction no time"
    )


def test_the_run_deadline_bounds_the_whole_pass(m, realms, monkeypatch):
    removed_and_turned_off(m, realms, m.billing)
    monkeypatch.setattr(realm_access, "RUN_DEADLINE_S", 0.3)
    realms.slow["alpha-member"] = 0.4
    remove(m, m.member)
    before = health(m)
    realms.calls.clear()  # only the measured pass's calls
    started = time.monotonic()
    report = run(realms)
    assert time.monotonic() - started < 0.3 + 0.4 + 0.5, report.line()
    # The delivery stopped between its calls (nothing ambiguous), and verification never started.
    assert realms.named("set_enabled") == [] and report.reconciliation == 0
    assert realms.named("enabled_user_ids") == []
    assert health(m)["unverified_passes"] == before["unverified_passes"] + 1


def test_a_failing_realm_cannot_keep_a_healthy_one_from_being_verified(m, realms, monkeypatch):
    removed_and_turned_off(m, realms, m.member)
    bravo_member = person(m, m.bravo, "org_member", "bravo-member")
    realms.add("bravo", "bravo-member")
    set_state(bravo_member, "removed")
    run(realms)
    # Windows from the run's start: a verification window of 0.2 s fits one 0.25 s listing.
    for name, value in (
        ("DELIVERY_PHASE_S", 0.0),
        ("CALL_OVERRUN_S", 0.0),
        ("VERIFY_PHASE_S", 0.2),
    ):
        monkeypatch.setattr(realm_access, name, value)
    realms.unlistable["alpha"] = RealmCallError("transport")
    realms.slow_list["alpha"] = realms.slow_list["bravo"] = 0.25  # one realm per phase
    realms.calls.clear()
    for _ in range(4):
        run(realms)
    listed = [call[0] for call in realms.calls if call[1] == "enabled_user_ids"]
    assert listed.count("bravo") >= 2, f"a failing realm kept the healthy one waiting: {listed}"


def test_verification_fetches_one_token_per_realm(m, realms):
    removed_and_turned_off(m, realms, m.member, m.billing, m.admin)
    realms.opened.clear()
    run(realms)
    assert realms.opened == ["alpha"], "verification fetched more than one token for a realm"


def test_a_pending_on_of_a_suspended_member_is_outstanding(m, realms):
    suspend(m, m.member)
    run(realms)
    reactivate(m, m.member)
    sql(
        "UPDATE outbox_realmaccess SET not_before = clock_timestamp() + interval '1 day' "
        "WHERE operation = 'access_on'"
    )
    set_state(m.member, "suspended")  # suspended again, its access_on still pending
    run(realms)
    sql("UPDATE outbox_outboxdelivery SET created_at = created_at - interval '10 minutes'")
    report = run(realms)
    assert report.outstanding >= 1 and report.needs_operator, report.line()


def _operator_principal(w):
    from types import SimpleNamespace

    from test_staff_identity import operator

    from apps.identity.command_principal import staff_principal_for_command

    staff = operator(SimpleNamespace(**vars(w.models), StaffRole=model("identity", "StaffRole")))
    return staff_principal_for_command(staff.id)


def test_an_ambiguous_attempt_needs_no_operator_evidence_but_an_abandoned_one_does(
    m, realms, monkeypatch
):
    from apps.orgs.realm_access_decision import (
        RealmDecisionRefusedError,
        decide_realm_access_attempt,
    )

    monkeypatch.setattr(realm_access, "RECONCILE_QUIET_PERIOD", timedelta(0))
    check_a_delayed_enable_never_undoes_a_removal(m, realms)
    [ambiguous] = [d for d in deliveries() if d["status"] == "needs_reconciliation"]
    principal = _operator_principal(m)
    decided = decide_realm_access_attempt(
        principal=principal,
        delivery_id=ambiguous["id"],
        compute_terminated=None,
        admin_factory=realms.factory,
        origins_issuer=ISSUER_ORIGIN,
    )
    assert decided.exit == "resume" and decided.enqueued == "access_off"
    run(realms)
    reactivate(m, m.admin)  # a fresh person for the abandoned case
    suspend(m, m.admin)
    run(realms)
    reactivate(m, m.admin)
    stall("access_on")
    run(realms)
    [abandoned] = [d for d in deliveries() if d["status"] == "needs_reconciliation"]
    with pytest.raises(RealmDecisionRefusedError, match="compute_terminated_required"):
        decide_realm_access_attempt(
            principal=principal,
            delivery_id=abandoned["id"],
            compute_terminated=None,
            admin_factory=realms.factory,
            origins_issuer=ISSUER_ORIGIN,
        )


def test_reconcile_only_exits_non_zero_while_anything_is_outstanding(m, realms):
    suspend(m, m.member)
    realms.fail("set_enabled", RealmCallError("permanent", http_status=400))
    run(realms)
    out = io.StringIO()
    with pytest.raises(CommandError, match="outstanding"):
        call_command("run_realm_deliveries", "--once", "--reconcile-only", stdout=out)
    assert "outstanding=1" in out.getvalue()


def check_stuck_work_is_outstanding_on_every_run(w, realms) -> None:
    suspend(w, w.member)
    realms.fail("set_enabled", RealmCallError("permanent", http_status=400))
    run(realms)
    later = run(realms)  # nothing to do, but the person still holds realm access
    assert later.outstanding == 1 and later.needs_operator, (
        "CHECK outstanding: a failed access_off was not reported on the next run"
    )
    set_state(w.billing, "suspended")
    sql("UPDATE outbox_outboxdelivery SET created_at = created_at - interval '10 minutes'")
    realms.fail("open", RealmCallError("transport"))
    report = run(realms)
    assert report.outstanding == 1 and report.oldest_outstanding_s >= 600, report.line()


def test_stuck_work_is_outstanding_on_every_run(m, realms):
    check_stuck_work_is_outstanding_on_every_run(m, realms)


def check_a_stuck_access_on_is_outstanding(w, realms) -> None:
    """A reactivated member left disabled is reported like a removed one left enabled."""
    suspend(w, w.member)
    run(realms)
    reactivate(w, w.member)
    realms.fail("set_enabled", RealmCallError("permanent", http_status=400))
    run(realms)
    report = run(realms)
    assert report.outstanding == 1 and report.needs_operator, (
        "CHECK stuck_on: a failed access_on of an active member was not reported"
    )
    set_state(w.billing, "suspended")
    run(realms)
    sql("UPDATE orgs_membership SET state = 'active' WHERE id = %s", [w.billing.member.id])
    with transaction.atomic():
        realm_enqueue.enqueue_realm_access(
            organisation_id=w.alpha.id,
            membership_id=w.billing.member.id,
            user_id=w.billing.user.id,
            operation="access_on",
        )
    # Every delivery ten minutes older, so their commit order is kept.
    sql("UPDATE outbox_outboxdelivery SET created_at = created_at - interval '10 minutes'")
    realms.fail("open", RealmCallError("transport"))
    assert run(realms).outstanding == 2, "CHECK stuck_on: a long-pending access_on was not reported"


def test_a_stuck_access_on_is_outstanding(m, realms):
    check_a_stuck_access_on_is_outstanding(m, realms)


# ---------------------------------------------------------------------------- reconcile ----


def check_reconcile_reaches_changes_made_before_the_delivery(w, realms) -> None:
    set_state(w.member, "removed")
    set_state(w.billing, "suspended")
    assert deliveries() == []
    report = run(realms)
    assert report.reconciled == 2, f"CHECK reconcile: reconciled {report.reconciled}, not 2"
    assert realms.users[("alpha", "alpha-member")].enabled is False
    assert realms.users[("alpha", "alpha-billing")].enabled is False
    assert realm_access.reconcile() == 0, "CHECK reconcile: a second pass enqueued again"
    assert realms.users[("alpha", "alpha-owner")].enabled is True


def test_reconcile_reaches_changes_made_before_the_delivery(m, realms):
    check_reconcile_reaches_changes_made_before_the_delivery(m, realms)


def test_reconcile_leaves_a_failed_off_to_its_operator_until_asked(m, realms):
    suspend(m, m.member)
    realms.fail("set_enabled", RealmCallError("permanent", http_status=400))
    run(realms)
    assert realm_access.reconcile() == 0
    assert realm_access.reconcile(requeue_failed=True) == 1
    assert run(realms).succeeded == 1
    assert realms.users[("alpha", "alpha-member")].enabled is False


def test_reconcile_replaces_a_stray_on(m):
    set_state(m.billing, "removed")
    with transaction.atomic():
        realm_enqueue.enqueue_realm_access(
            organisation_id=m.alpha.id,
            membership_id=m.billing.member.id,
            user_id=m.billing.user.id,
            operation="access_on",
        )
    assert realm_access.reconcile() == 1


def test_the_command_reconciles_alone_and_refuses_without_its_settings(m, settings):
    set_state(m.member, "removed")
    out = io.StringIO()
    call_command("run_realm_deliveries", "--once", "--reconcile-only", stdout=out)
    assert out.getvalue().startswith("reconciled=1 ")
    with pytest.raises(CommandError, match="--once"):
        call_command("run_realm_deliveries")
    settings.KODERA_REALM_WORKER_SECRET_DIR = None
    with pytest.raises(CommandError, match="KODERA_REALM_WORKER_SECRET_DIR"):
        call_command("run_realm_deliveries", "--once")
    settings.KODERA_REALM_WORKER_SECRET_DIR = "/nonexistent"
    settings.KODERA_REALM_ORIGINS = None
    with pytest.raises(CommandError, match="KODERA_REALM_ADMIN_ORIGIN"):
        call_command("run_realm_deliveries", "--once")


# ------------------------------------------------------------------- end to end, HTTP ----


def lab_organisation(w, issuer: str):
    """An organisation whose issuer is the loopback stub's, with an owner and a member bound."""
    models = w.models
    with transaction.atomic():
        organisation = models.Organisation.objects.create(
            slug="alpha-lab", realm="alpha-lab", issuer=issuer, name="Lab", state="active"
        )
        models.SlugReservation.objects.create(
            namespace="organisation",
            slug="alpha-lab",
            organisation=organisation,
            state="permanent",
            protected_at=timezone.now(),
        )
        people = []
        for role, subject in (("org_owner", "lab-owner"), ("org_member", "lab-member")):
            user = models.User.objects.create(email=f"{subject}@customer.test", enabled=True)
            identity(models, organisation, user, subject=subject)
            people.append(
                models.Membership.objects.create(
                    user=user,
                    organisation=organisation,
                    role=role,
                    state="active",
                    accepted_at=timezone.now(),
                )
            )
    return organisation, people


def test_nothing_secret_is_logged_audited_or_printed(m, settings, tmp_path, caplog):
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    (secrets / "alpha-lab").write_text(SECRET)
    with keycloak_hosts() as (kc, origins):
        kc.realm = "alpha-lab"
        _, (_, member) = lab_organisation(m, f"{origins.issuer}/realms/alpha-lab")
        kc.add_user("lab-member")
        kc.users["lab-member"]["email"] = "lab-member-address@customer.test"
        settings.KODERA_REALM_WORKER_SECRET_DIR = str(secrets)
        settings.KODERA_REALM_ORIGINS = origins
        sql("UPDATE orgs_membership SET state = 'removed' WHERE id = %s", [member.id])
        set_state(m.member, "removed")  # alpha's realm is not this Keycloak's: payload_mismatch
        out = io.StringIO()
        with caplog.at_level(logging.DEBUG):
            with pytest.raises(CommandError):
                call_command("run_realm_deliveries", "--once", stdout=out)
        assert kc.users["lab-member"]["enabled"] is False
        assert all(
            r["path"].startswith("/realms/alpha-lab/") for r in kc.requests if r["host"] == "public"
        )
    seen = caplog.text + out.getvalue() + json.dumps(audit(), default=str)
    for secret in (SECRET, TOKEN, "lab-member-address@customer.test"):
        assert secret not in seen
    assert re.search(r"\bsucceeded=1\b", out.getvalue()) and "mismatched=1" in out.getvalue()


# ---------------------------------------------------------------------- mutation negatives ----


def _enqueue_in_its_own_transaction(**kwargs: Any) -> tuple[Any, ...]:
    """The enqueue moved outside the change: a second connection that commits on its own."""
    result: list[Any] = []

    def write() -> None:
        try:
            with transaction.atomic():
                result.append(realm_enqueue.enqueue_realm_access(**kwargs))
        finally:
            connection.close()

    thread = threading.Thread(target=write)
    thread.start()
    thread.join()
    return result[0]


@dataclass(frozen=True)
class Mutant:
    name: str
    apply: Callable[[pytest.MonkeyPatch, FakeRealms], None]
    check: str


def _trusting(mp: pytest.MonkeyPatch, realms: FakeRealms) -> None:
    mp.setattr(realm_access, "payload_problem", lambda **kwargs: None)


def _no_issuer_check(mp: pytest.MonkeyPatch, realms: FakeRealms) -> None:
    original = realm_access.payload_problem

    def lenient(**kwargs: Any) -> str | None:
        problem = original(**kwargs)
        return None if problem == "issuer" else problem

    mp.setattr(realm_access, "payload_problem", lenient)


def _sweep_retries(mp: pytest.MonkeyPatch, realms: FakeRealms) -> None:
    """The round-one sweep: an abandoned attempt closed and its delivery returned to pending."""

    def retry(report: realm_access.RunReport) -> None:
        with transaction.atomic():
            for delivery_id, _, attempt_id, _, _ in realm_access._rows(
                realm_access._ABANDONED, [realm_access.STALE_AFTER.total_seconds()]
            ):
                sql(
                    "UPDATE outbox_deliveryattempt SET outcome = 'abandoned', "
                    "finished_at = clock_timestamp() WHERE id = %s",
                    [attempt_id],
                )
                sql(
                    "UPDATE outbox_outboxdelivery SET status = 'pending' WHERE id = %s",
                    [delivery_id],
                )

    mp.setattr(realm_access, "sweep", retry)


def _ambiguous_retried(mp: pytest.MonkeyPatch, realms: FakeRealms) -> None:
    """The round-three rule: a write's unknown outcome deferred and retried like a read's."""
    original = realm_access.perform

    def retrying(claimed, factory, **kwargs):
        outcome = original(claimed, factory, **kwargs)
        if outcome.attempt == "ambiguous":
            return realm_access.Outcome("temporary", "temporary", outcome.http_status)
        return outcome

    mp.setattr(realm_access, "perform", retrying)


def _credential_as_transport(original):
    """The mutant: the real perform, with a refused credential read as plain transport, so the
    queued credential failure is consumed by the delivery as in the unmutated run."""

    def perform(claimed, factory, **kwargs):
        outcome = original(claimed, factory, **kwargs)
        if outcome.reason == "credential":
            return realm_access.Outcome("transport", "transport", outcome.http_status)
        return outcome

    return perform


def _outstanding_off_only(mp: pytest.MonkeyPatch, realms: FakeRealms) -> None:
    """The round-two report: only access_off and unresolved deliveries counted."""
    statement = realm_access._OUTSTANDING
    start = statement.index(
        "  UNION ALL\n  SELECT d.created_at\n  FROM outbox_outboxdelivery d\n  JOIN outbox_realmaccess r ON r.delivery_id = d.id\n  JOIN orgs_membership m"
    )
    end = statement.index("  UNION ALL", start + 10)
    mp.setattr(realm_access, "_OUTSTANDING", statement[:start] + statement[end:])


def _off_never_withdrawn(mp: pytest.MonkeyPatch, realms: FakeRealms) -> None:
    original = realm_access.withdrawn
    mp.setattr(
        realm_access,
        "withdrawn",
        lambda operation, subject: operation != "access_off" and original(operation, subject),
    )


MUTANTS = [
    Mutant(
        "bulk verification skipped",
        lambda mp, realms: mp.setattr(realm_access, "verify_realms", lambda **kwargs: []),
        "drift",
    ),
    Mutant("an ambiguous write retried", _ambiguous_retried, "ambiguous"),
    Mutant("access_on left out of outstanding", _outstanding_off_only, "stuck_on"),
    Mutant(
        "enqueue skipped",
        lambda mp, realms: mp.setattr(membership_lifecycle, "enqueue_realm_access", lambda **k: ()),
        "each_change",
    ),
    Mutant(
        "enqueue outside the change's transaction",
        lambda mp, realms: mp.setattr(
            membership_lifecycle, "enqueue_realm_access", _enqueue_in_its_own_transaction
        ),
        "rollback",
    ),
    Mutant(
        "reconcile skipped",
        lambda mp, realms: mp.setattr(realm_access, "reconcile", lambda **k: 0),
        "reconcile",
    ),
    Mutant("logout not called", lambda mp, realms: realms.no_op.add("logout"), "off"),
    Mutant("consents not revoked", lambda mp, realms: realms.no_op.add("revoke_consent"), "off"),
    Mutant("payload trusted: forged realm user id", _trusting, "forged_subject"),
    Mutant("payload trusted: cross-organisation", _trusting, "cross_organisation"),
    Mutant("issuer not checked against the pinned origin", _no_issuer_check, "issuer"),
    Mutant("access_off of an active membership executed", _off_never_withdrawn, "off_withdrawn"),
    Mutant(
        "credential read as plain transport",
        lambda mp, realms: mp.setattr(
            realm_access,
            "perform",
            _credential_as_transport(realm_access.perform),
        ),
        "credential",
    ),
    Mutant(
        "abandoned attempt returned to pending",
        _sweep_retries,
        "abandoned",
    ),
    Mutant(
        "outstanding not reported",
        lambda mp, realms: mp.setattr(realm_access, "outstanding", lambda: (0, 0)),
        "outstanding",
    ),
]

CHECKS: dict[str, tuple[str, Callable[[Any, FakeRealms, pytest.MonkeyPatch], None]]] = {
    "each_change": (
        "CHECK each_change:",
        lambda w, realms, mp: check_each_change_writes_its_deliveries(w),
    ),
    "rollback": (
        "CHECK rollback:",
        lambda w, realms, mp: check_a_rolled_back_change_leaves_no_delivery(w, mp),
    ),
    "reconcile": (
        "CHECK reconcile:",
        lambda w, realms, mp: check_reconcile_reaches_changes_made_before_the_delivery(w, realms),
    ),
    "off": ("CHECK off:", lambda w, realms, mp: check_off_disables_logs_out_and_revokes(w, realms)),
    "forged_subject": (
        "CHECK forged_subject:",
        lambda w, realms, mp: check_a_forged_realm_user_id_is_never_executed(w, realms),
    ),
    "cross_organisation": (
        "CHECK cross_organisation:",
        lambda w, realms, mp: check_a_cross_organisation_payload_is_never_executed(w, realms),
    ),
    "issuer": (
        "CHECK issuer:",
        lambda w, realms, mp: check_an_issuer_this_keycloak_does_not_serve_is_never_executed(
            w, realms
        ),
    ),
    "off_withdrawn": (
        "CHECK off_withdrawn:",
        lambda w, realms, mp: check_an_off_whose_membership_is_active_again_is_withdrawn(w, realms),
    ),
    "credential": (
        "CHECK credential:",
        lambda w, realms, mp: check_a_refused_credential_needs_an_operator_at_once(w, realms),
    ),
    "abandoned": (
        "CHECK abandoned:",
        lambda w, realms, mp: check_an_abandoned_attempt_is_held_for_an_operator(w, realms),
    ),
    "drift": (
        "CHECK drift:",
        lambda w, realms, mp: check_a_direct_enable_after_a_removal_is_corrected(w, realms),
    ),
    "ambiguous": (
        "CHECK ambiguous:",
        lambda w, realms, mp: check_a_delayed_enable_never_undoes_a_removal(w, realms),
    ),
    "stuck_on": (
        "CHECK stuck_on:",
        lambda w, realms, mp: check_a_stuck_access_on_is_outstanding(w, realms),
    ),
    "outstanding": (
        "CHECK outstanding:",
        lambda w, realms, mp: check_stuck_work_is_outstanding_on_every_run(w, realms),
    ),
}


@pytest.mark.parametrize("mutant", MUTANTS, ids=[mutant.name for mutant in MUTANTS])
def test_each_mutant_fails_its_owning_check_with_its_line(m, realms, monkeypatch, mutant):
    line, check = CHECKS[mutant.check]
    mutant.apply(monkeypatch, realms)
    with pytest.raises(AssertionError) as raised:
        check(m, realms, monkeypatch)
    assert str(raised.value).startswith(line), (
        f"{mutant.name} failed {mutant.check} for another reason: {str(raised.value)[:300]}"
    )


def test_every_check_has_a_mutant():
    assert {mutant.check for mutant in MUTANTS} == set(CHECKS)
