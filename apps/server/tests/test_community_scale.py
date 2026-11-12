"""The canonical community at scale: docs/specs/DEFAULT_COMMUNITY.md, "Reads and first visits".

`GET /me` prepares the caller's community membership on every call. Its steady state takes no row
lock, writes nothing and runs a bounded number of statements that does not grow with the
community; a first visit writes only the visitor's own rows, safely against a concurrent first
visit, and does not rebuild the engines' member set, which the next agent poll rebuilds once for
everyone who joined since.

Real signed tokens through the routed views on the disposable PostgreSQL. The last tests are the
refusal proofs: with the organisation lock put back on the read, and with the rebuild put back on
the first visit, the checks the other tests rely on fail by name.
"""

import inspect
import re
import textwrap
from concurrent.futures import ThreadPoolExecutor

import pytest
from customer_http_fixtures import (
    configure,
    http_signer as http_signer,
    token as signed_token,
    trust_entry,
)
from django.db import IntegrityError, close_old_connections, connection, transaction
from django.test import Client
from django.test.utils import CaptureQueriesContext
from test_access_tokens import frozen_clock as frozen_clock
from test_default_community import ISSUER, community as community, signup, token

from apps.engine_intents import services as engine
from apps.engine_intents.models import EngineMemberSet
from apps.identity.models import Identity, User
from apps.orgs import community as communities
from apps.orgs.community import ensure_community_membership, refresh_community_member_set
from apps.orgs.models import Membership, Organisation

pytestmark = pytest.mark.django_db(transaction=True)

# What a steady-state `GET /me` may send: reads, and the read-only snapshot it opens.
WRITES_OR_LOCKS = re.compile(
    r"\b(FOR\s+(NO\s+KEY\s+)?UPDATE|FOR\s+(KEY\s+)?SHARE|INSERT\s+INTO|UPDATE\s+\"|DELETE\s+FROM"
    r"|LOCK\s+TABLE|pg_advisory)",
    re.IGNORECASE,
)
# The statements of one steady-state `GET /me` with the community configured: the three of the
# membership preparation, then the profile's own snapshot. A bound, so that a statement per
# member, or a new one per call, fails here.
STEADY_STATE_STATEMENTS = 12


@pytest.fixture
def visitor(community, settings, http_signer):
    """A canonical-realm person who has not visited yet, and how they call `GET /me`."""
    configure(settings, [trust_entry(http_signer, ISSUER)])
    client = Client()

    def me(subject="visitor"):
        credential = signed_token(
            http_signer, ISSUER, subject, email_verified=True, email=f"{subject}@example.test"
        )
        return client.get("/api/v1/me", HTTP_AUTHORIZATION="Bearer " + credential)

    community.me = me
    return community


def statements_of(call):
    with CaptureQueriesContext(connection) as captured:
        response = call()
    return response, [query["sql"] for query in captured.captured_queries]


# --- the steady-state read ---------------------------------------------------------------------


def check_steady_state_read(w):
    """A person who has visited before: `GET /me` locks no row, writes nothing, and stays within
    the statement bound."""
    assert w.me().status_code == 200  # the first visit, which may write
    response, statements = statements_of(w.me)
    assert response.status_code == 200, response.content
    offending = [sql for sql in statements if WRITES_OR_LOCKS.search(sql)]
    assert not offending, f"steady-state GET /me took a row lock or wrote: {offending[:2]}"
    assert len(statements) <= STEADY_STATE_STATEMENTS, (
        f"steady-state GET /me ran {len(statements)} statements, over the bound of "
        f"{STEADY_STATE_STATEMENTS}"
    )
    return len(statements)


def test_a_steady_state_read_takes_no_lock_writes_nothing_and_is_bounded(visitor):
    check_steady_state_read(visitor)


def test_the_statement_count_does_not_grow_with_the_community(visitor):
    small = check_steady_state_read(visitor)
    for index in range(40):
        signup(f"member-{index}")
    assert check_steady_state_read(visitor) == small


def test_the_preparation_itself_is_three_reads_outside_any_transaction(community):
    verified, member = signup()
    with CaptureQueriesContext(connection) as captured:
        assert ensure_community_membership(verified=verified).id == member.id
        assert not connection.in_atomic_block
    statements = [query["sql"] for query in captured.captured_queries]
    assert len(statements) == 3 and all(sql.lstrip().startswith("SELECT") for sql in statements)
    assert not any(WRITES_OR_LOCKS.search(sql) for sql in statements)


def test_a_deployment_without_a_community_asks_the_database_nothing(community, settings):
    settings.KODERA_DEFAULT_COMMUNITY_ORG_SLUG = ""
    with CaptureQueriesContext(connection) as captured:
        assert ensure_community_membership(verified=token()) is None
    assert captured.captured_queries == []


# --- the first visit ---------------------------------------------------------------------------


def check_a_first_visit_leaves_the_member_set_to_the_poll(w):
    """A first visit writes the visitor's own rows and nothing for the engines: the member set is
    not rebuilt in the request, only marked behind by the organisation's authority revision."""
    organisation = w.organisation.id
    refresh_community_member_set(organisation)  # whatever joined before this check is announced
    before = EngineMemberSet.objects.filter(organisation_id=organisation).count()
    assert not engine.member_set_refresh_due(organisation_id=organisation)
    response, statements = statements_of(lambda: w.me("newcomer"))
    assert response.status_code == 200, response.content
    assert (
        Membership.objects.filter(
            organisation_id=organisation, user__email="newcomer@example.test"
        ).count()
        == 1
    )
    assert EngineMemberSet.objects.filter(organisation_id=organisation).count() == before, (
        "a first visit rebuilt the engines' member set on the read path"
    )
    assert not any("engine_intents" in sql for sql in statements), (
        "a first visit touched the engines' tables on the read path"
    )
    assert engine.member_set_refresh_due(organisation_id=organisation)


def test_a_first_visit_writes_its_own_rows_and_no_member_set(visitor):
    check_a_first_visit_leaves_the_member_set_to_the_poll(visitor)


def test_one_rebuild_announces_everyone_who_joined_and_the_next_is_not_due(visitor):
    organisation = visitor.organisation.id
    before = EngineMemberSet.objects.filter(organisation_id=organisation).count()
    subjects = [f"joiner-{index}" for index in range(5)]
    for subject in subjects:
        assert visitor.me(subject).status_code == 200
    assert EngineMemberSet.objects.filter(organisation_id=organisation).count() == before
    assert refresh_community_member_set(organisation) is True
    latest = EngineMemberSet.objects.filter(organisation_id=organisation).order_by("-revision")
    assert latest.count() == before + 1 and latest[0].reason == "community_signup"
    assert set(subjects) <= set(latest[0].active_subjects)
    assert (
        latest[0].authority_revision == Organisation.objects.get(id=organisation).authority_revision
    )
    # Nothing moved since: no second set, however often the poll asks.
    for _ in range(3):
        assert refresh_community_member_set(organisation) is False
    assert latest.count() == before + 1


def test_the_agent_poll_is_what_rebuilds_the_set(visitor):
    organisation = visitor.organisation.id
    _, agent_token = engine.issue_credential(organisation_id=organisation)
    assert visitor.me("polled").status_code == 200
    before = EngineMemberSet.objects.filter(organisation_id=organisation).count()
    client = Client()
    poll = client.get(
        "/agent/v1/commands?kinds=engine_set_member_subjects",
        HTTP_AUTHORIZATION="Bearer " + agent_token,
    )
    assert poll.status_code == 200, poll.content
    [command] = poll.json()["commands"]
    assert "polled" in command["payload"]["active_subjects"]
    assert EngineMemberSet.objects.filter(organisation_id=organisation).count() == before + 1
    again = client.get(
        "/agent/v1/commands?kinds=engine_set_member_subjects",
        HTTP_AUTHORIZATION="Bearer " + agent_token,
    )
    assert again.status_code == 200 and again.json()["commands"] == []
    assert EngineMemberSet.objects.filter(organisation_id=organisation).count() == before + 1


def test_a_refresh_that_fails_never_fails_the_poll_and_waits_before_trying_again(
    visitor, monkeypatch
):
    organisation = visitor.organisation.id
    _, agent_token = engine.issue_credential(organisation_id=organisation)
    assert visitor.me("over-the-bound").status_code == 200
    assert visitor.me("over-the-bound-too").status_code == 200
    monkeypatch.setattr(engine, "MAX_SUBJECTS", 1)
    poll = Client().get("/agent/v1/commands", HTTP_AUTHORIZATION="Bearer " + agent_token)
    assert poll.status_code == 200, poll.content
    assert Membership.objects.filter(user__email="over-the-bound@example.test").count() == 1
    head = engine.EngineMemberSetHead.objects.get(organisation_id=organisation)
    assert head.refused_at is not None and head.refused_problem == "over_bound"
    # Refused a moment ago: not due again on the next poll, and due once the wait has passed.
    assert not engine.member_set_refresh_due(organisation_id=organisation)
    later = head.refused_at + engine.REFRESH_RETRY_AFTER
    assert engine.member_set_refresh_due(organisation_id=organisation, now=later)


def test_another_organisation_is_never_refreshed_this_way(community):
    from test_customer_persistence_models import anchor, anchor_models

    other, _, _ = anchor(anchor_models())
    assert refresh_community_member_set(other.id) is False
    assert EngineMemberSet.objects.filter(organisation_id=other.id).count() == 0


# --- concurrent first visits -------------------------------------------------------------------


def test_the_two_constraints_first_visits_rely_on_exist(community):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY(%s)",
            [sorted(communities.FIRST_VISIT_CONSTRAINTS)],
        )
        found = dict(cursor.fetchall())
    assert set(found) == communities.FIRST_VISIT_CONSTRAINTS
    assert all("UNIQUE" in definition for definition in found.values())
    assert "(issuer, subject)" in found["identity_issuer_subject_unique"]
    assert "(user_id, organisation_id)" in found["membership_current_unique"]


@pytest.mark.parametrize("workers", [2, 8])
def test_concurrent_first_visits_of_one_person_create_one_of_each(community, workers):
    verified = token("racer", email_verified=True, email="racer@example.test")

    def join(_):
        close_old_connections()
        try:
            return ensure_community_membership(verified=verified).id
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=workers) as executor:
        ids = list(executor.map(join, range(workers)))
    assert len(set(ids)) == 1
    assert Identity.objects.filter(issuer=ISSUER, subject="racer").count() == 1
    assert User.objects.filter(email="racer@example.test").count() == 1
    assert (
        Membership.objects.filter(
            organisation=community.organisation, user__email="racer@example.test"
        ).count()
        == 1
    )


def test_concurrent_first_visits_of_different_people_all_succeed(community):
    def join(index):
        close_old_connections()
        try:
            subject = f"crowd-{index}"
            verified = token(subject, email_verified=True, email=f"{subject}@example.test")
            return ensure_community_membership(verified=verified).state
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=8) as executor:
        states = list(executor.map(join, range(24)))
    assert states == ["active"] * 24
    assert (
        Membership.objects.filter(
            organisation=community.organisation, user__email__startswith="crowd-"
        ).count()
        == 24
    )


def test_losing_the_identity_race_reads_the_winners_rows(community, monkeypatch):
    """The loser, made deterministic: its first attempt inserts an identity the winner has just
    committed, and PostgreSQL refuses it by the constraint. The attempt rolls back, with the
    person it created, and the retry finds the winner's membership."""
    verified, winner = signup("contested")
    real, attempts = communities.materialize_community_identity, []

    def loser(**kwargs):
        attempts.append(1)
        orphan = User.objects.create(email="contested@example.test")
        Identity.objects.create(
            user=orphan,
            organisation_id=kwargs["organisation_id"],
            issuer=kwargs["issuer"],
            realm=kwargs["realm"],
            subject=verified.subject,
            email="contested@example.test",
        )
        raise AssertionError("the duplicate identity was admitted")

    from apps.identity.community import community_identity as find_identity

    looks = []

    def blind_at_first(verified_token):
        # The loser's view: the winner's identity is not committed yet when it looks.
        looks.append(1)
        return None if len(looks) <= 2 else find_identity(verified_token)

    monkeypatch.setattr(communities, "materialize_community_identity", loser)
    monkeypatch.setattr(communities, "community_identity", blind_at_first)
    assert ensure_community_membership(verified=verified).id == winner.id
    assert attempts == [1], "the first attempt lost the race, the second read the winner's rows"
    assert User.objects.filter(email="contested@example.test").count() == 1
    assert Identity.objects.filter(issuer=ISSUER, subject="contested").count() == 1
    monkeypatch.setattr(communities, "materialize_community_identity", real)


def test_an_identity_committed_between_the_look_and_the_insert_is_found(community, monkeypatch):
    """The other way to lose: the winner commits after the loser looked and before it would
    insert. Nothing is inserted, nothing conflicts, and the loser must still answer the winner's
    membership rather than nothing."""
    from apps.identity.community import community_identity as find_identity

    verified, winner = signup("just-committed")
    looks = []

    def blind_at_first(verified_token):
        looks.append(1)
        return None if len(looks) <= 2 else find_identity(verified_token)

    monkeypatch.setattr(communities, "community_identity", blind_at_first)
    assert ensure_community_membership(verified=verified).id == winner.id
    assert len(looks) == 3
    assert Identity.objects.filter(issuer=ISSUER, subject="just-committed").count() == 1


def test_a_disabled_identity_is_still_never_revived_by_looking_again(community):
    verified, member = signup("disabled")
    Identity.objects.filter(subject="disabled").update(enabled=False)
    assert ensure_community_membership(verified=verified) is None
    assert Identity.objects.filter(subject="disabled").count() == 1
    assert Membership.objects.filter(user_id=member.user_id).count() == 1


def test_losing_the_membership_race_reads_the_winners_row(community, monkeypatch):
    verified, winner = signup("twice")
    real, calls = communities._latest_membership, []

    def blind_at_first(user_id, organisation_id):
        calls.append(1)
        return None if len(calls) <= 2 else real(user_id, organisation_id)

    monkeypatch.setattr(communities, "_latest_membership", blind_at_first)
    assert ensure_community_membership(verified=verified).id == winner.id
    assert len(calls) == 3
    assert (
        Membership.objects.filter(
            organisation=community.organisation, user_id=winner.user_id
        ).count()
        == 1
    )


def test_any_other_integrity_error_is_not_mistaken_for_a_lost_race(community, monkeypatch):
    def broken(*args, **kwargs):
        with transaction.atomic():
            Membership.objects.create(
                user_id=community.owner.id,
                organisation=community.organisation,
                role="org_nobody",
                state="active",
            )

    monkeypatch.setattr(communities, "_create_first_visit", broken)
    with pytest.raises(IntegrityError):
        ensure_community_membership(
            verified=token("unlucky", email_verified=True, email="unlucky@example.test")
        )


# --- the refusal proofs ------------------------------------------------------------------------

MUTANTS = {
    "the organisation lock is put back on the read": (
        communities.ensure_community_membership,
        "    principal = community_identity(verified)\n    if principal is not None:\n",
        "    with transaction.atomic():\n"
        "        Organisation.objects.select_for_update().get(id=community.id)\n"
        "    principal = community_identity(verified)\n    if principal is not None:\n",
        check_steady_state_read,
        "took a row lock or wrote",
    ),
    "the read always enters the creation path": (
        communities.ensure_community_membership,
        "        if membership is not None:\n            return membership\n    return _first_visit",
        "        if membership is None:\n            return membership\n    return _first_visit",
        check_steady_state_read,
        "over the bound",
    ),
    "the rebuild is put back on the first visit": (
        communities._create_first_visit,
        "    return Membership.objects.create(\n"
        "        user_id=principal.user_id,\n"
        "        organisation=community,\n"
        '        role="org_member",\n'
        '        state="active",\n'
        "        accepted_at=timezone.now(),\n"
        "    )\n",
        "    created = Membership.objects.create(\n"
        "        user_id=principal.user_id,\n"
        "        organisation=community,\n"
        '        role="org_member",\n'
        '        state="active",\n'
        "        accepted_at=timezone.now(),\n"
        "    )\n"
        "    from .member_set_hooks import member_set_changed\n\n"
        '    member_set_changed(organisation_id=community.id, reason="community_signup")\n'
        "    return created\n",
        check_a_first_visit_leaves_the_member_set_to_the_poll,
        "rebuilt the engines' member set on the read path",
    ),
}


def mutated(monkeypatch, name):
    function, before, after, _, _ = MUTANTS[name]
    source = textwrap.dedent(inspect.getsource(function))
    assert source.count(before) == 1, f"mutation anchor moved: {before!r}"
    namespace = dict(function.__globals__)
    exec(compile(source.replace(before, after), f"<mutant: {name}>", "exec"), namespace)  # noqa: S102 - owned source mutation only
    monkeypatch.setattr(communities, function.__name__, namespace[function.__name__])


def test_refusal_control_the_checks_pass_on_the_unmutated_community(visitor):
    check_steady_state_read(visitor)
    check_a_first_visit_leaves_the_member_set_to_the_poll(visitor)


@pytest.mark.parametrize("name", sorted(MUTANTS))
def test_refusal_each_regression_fails_the_check_that_owns_it(visitor, monkeypatch, name):
    _, _, _, check, message = MUTANTS[name]
    mutated(monkeypatch, name)
    with pytest.raises(AssertionError, match=message):
        check(visitor)
