"""The six invitation operations, the realm account run and the invitation mail run:
docs/specs/INVITATIONS.md §8.

Real signed requests through the routed views, every response checked against the contract; the
realm is a fake admin with Keycloak's shapes, the outbox the real one.
"""

import hashlib
import json
import re
import uuid
from contextlib import contextmanager
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from customer_http_fixtures import ME, configure, http_signer as http_signer, token, trust_entry
from django.conf import settings as django_settings
from django.db import connection
from django.test import Client
from test_access_tokens import frozen_clock as frozen_clock
from test_customer_persistence_models import anchor, anchor_models, identity, raw_update
from test_intake_writer_role import acting_as, current_user
from test_workspace_onboarding import STAFF_ISSUER, call, model, person

from apps.orgs import invitation_mail
from apps.orgs.invitation_mail import InvitationMailUnavailableError, enqueue_invitation_mails
from apps.orgs.invitations import format_token, seal_context
from apps.orgs.management.commands.run_realm_deliveries import ORGANISATION_LOCK
from apps.outbox.mail.dates import mail_instant
from apps.outbox.realm.keycloak import RealmCallError
from apps.outbox.realm_access import run_realm_deliveries
from apps.outbox.realm_accounts import REQUIRED_ACTIONS, run_realm_accounts
from core.sealing import unseal
from dev.api_writer_role import grant_statements

pytestmark = pytest.mark.django_db(transaction=True)

MANY = "/organisations/{organisation_id}/invitations"
ONE = "/invitations/{invitation_id}"
RESEND = "/invitations/{invitation_id}/actions/resend"
ACCEPT = "/invitations/accept"
PREVIEW = "/invitations/preview"
PROBLEMS = "https://kodera.io/problems/"
ORIGIN = "https://identity.customer.test"


@pytest.fixture
def w(transactional_db, settings, http_signer):
    models = anchor_models()
    alpha, _, owners = anchor(models, slug="alpha")
    bravo, _, _ = anchor(models, slug="bravo")
    configure(
        settings,
        [
            trust_entry(http_signer, alpha.issuer),
            trust_entry(http_signer, bravo.issuer),
            trust_entry(http_signer, STAFF_ISSUER, lane="staff"),
        ],
    )
    settings.KODERA_MEMBERSHIP_CURSOR_KEY = "17" * 32
    world = SimpleNamespace(
        models=models,
        signer=http_signer,
        alpha=alpha,
        bravo=bravo,
        client=Client(raise_request_exception=False, HTTP_HOST="127.0.0.1"),
        realm=FakeRealm(),
    )
    owner_user = owners[0].user
    world.owner = SimpleNamespace(
        user=owner_user,
        identity=identity(models, alpha, owner_user, subject="alpha-owner"),
        member=owners[0],
        credential=token(http_signer, alpha.issuer, subject="alpha-owner"),
    )
    world.admin = person(world, alpha, "org_admin", "alpha-admin")
    world.billing = person(world, alpha, "org_billing", "alpha-billing")
    world.member = person(world, alpha, "org_member", "alpha-member")
    world.foreigner = person(world, bravo, "org_owner", "bravo-owner")
    world.staff = SimpleNamespace(credential=token(http_signer, STAFF_ISSUER, subject="staff-one"))
    return world


# --- the fake realm ---------------------------------------------------------------------------


class FakeRealm:
    """Keycloak's user endpoints as the realm account run and the realm access run call them."""

    def __init__(self):
        self.users = {}
        self.mailed = []
        self.returns = []
        self.fail = None
        self.sessions_of = {}
        # The `console` client's valid redirects; None lists every one.
        self.redirects = None

    def users_by_email(self, email):
        if self.fail is not None:
            raise self.fail
        return [dict(user) for user in self.users.values() if user["email"] == email]

    def create_user(self, rep):
        user_id = str(uuid4())
        self.users[user_id] = {**rep, "id": user_id}

    def execute_actions_email(
        self, user_id, actions, lifespan_s, *, client_id=None, redirect_uri=None
    ):
        if redirect_uri is not None and self.redirects is not None:
            if redirect_uri not in self.redirects:
                # Keycloak's answer to a redirect_uri its client does not list.
                raise RealmCallError("permanent", http_status=400, cause="invalid_redirect_uri")
        self.mailed.append((user_id, tuple(actions), lifespan_s))
        self.returns.append((client_id, redirect_uri))

    def holding(self, email):
        return next(user for user in self.users.values() if user["email"] == email)

    # The realm access run (MEMBERSHIP_LIFECYCLE.md §6.1): turn off, log out, revoke, read back.
    def get_user(self, user_id):
        user = self.users.get(user_id)
        return None if user is None else {"id": user_id, "enabled": user["enabled"]}

    def set_enabled(self, user_id, enabled):
        self.users[user_id]["enabled"] = enabled

    def logout(self, user_id):
        self.sessions_of[user_id] = []

    def sessions(self, user_id):
        return [{"id": s} for s in self.sessions_of.get(user_id, ["online-1"])]

    def consents(self, user_id):
        return []

    def revoke_consent(self, user_id, client_id):
        pass

    def enabled_user_ids(self, *, deadline=None):
        return {uid for uid, user in self.users.items() if user["enabled"]}

    def count_users(self):
        return len(self.users)


def run_accounts(w, setup_redirect=None):
    @contextmanager
    def factory(target):
        assert target.realm == "alpha"
        yield w.realm

    return run_realm_accounts(
        admin_factory=factory, origins_issuer=ORIGIN, setup_redirect=setup_redirect
    )


def run_access(w):
    @contextmanager
    def factory(target, deadline=None):
        assert target.realm == "alpha"
        yield w.realm

    return run_realm_deliveries(
        admin_factory=factory, organisation_lock=ORGANISATION_LOCK, origins_issuer=ORIGIN
    )


# --- requests ---------------------------------------------------------------------------------


def bearer(who):
    return {"HTTP_AUTHORIZATION": "Bearer " + who.credential}


def post(w, path, template, who, body, key):
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    response = w.client.post(
        "/api/v1" + path,
        data=raw,
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key or f"invitation-key-{uuid4().hex}",
        **bearer(who),
    )
    return call(response, template, "post")


def invite(w, who, rows, *, key=None, organisation=None, **extra):
    body = {"invitations": rows, **extra}
    path = f"/organisations/{(organisation or w.alpha).id}/invitations"
    return post(w, path, MANY, who, body, key)


def listing(w, who, query="", organisation=None):
    path = f"/api/v1/organisations/{(organisation or w.alpha).id}/invitations"
    return call(w.client.get(path + query, **bearer(who)), MANY, "get")


def resend(w, who, invitation_id, *, key=None):
    return post(w, f"/invitations/{invitation_id}/actions/resend", RESEND, who, b"", key)


def revoke(w, who, invitation_id):
    response = w.client.delete(f"/api/v1/invitations/{invitation_id}", **bearer(who))
    return call(response, ONE, "delete")


def accept(w, who, secret, *, key=None, **extra):
    return post(w, "/invitations/accept", ACCEPT, who, {"token": secret, **extra}, key)


def preview(w, who, secret, *, body=None, **headers):
    """previewInvitation as the Console sends it: a body, and no Idempotency-Key."""
    raw = body if body is not None else json.dumps({"token": secret}).encode()
    response = w.client.post(
        "/api/v1/invitations/preview",
        data=raw,
        content_type="application/json",
        **headers,
        **bearer(who),
    )
    return call(response, PREVIEW, "post")


def problem(response, status, kind):
    assert response.status_code == status, response.content
    assert response.json()["type"] == PROBLEMS + kind, response.content
    return response.json()


def row(email, role="org_member", **extra):
    return {"email": email, "role": role, **extra}


def invitations(**filters):
    return model("orgs", "Invitation").objects.filter(**filters).order_by("id")


def audit(action):
    return list(
        model("audit", "AuditEvent")
        .objects.filter(action=action)
        .order_by("occurred_at", "id")
        .values("actor_type", "target_urn", "metadata")
    )


def link_secret(invitation):
    secret = unseal(
        django_settings.KODERA_CONTACT_SEAL_KEY,
        seal_context(invitation.id),
        bytes(invitation.token_sealed),
    )
    return format_token(invitation.id, secret.decode("ascii"))


def invitee(w, email, *, verified=True, organisation=None):
    """The realm account the run created for `email`, signed in."""
    user = w.realm.holding(email)
    return SimpleNamespace(
        subject=user["id"],
        credential=token(
            w.signer,
            (organisation or w.alpha).issuer,
            subject=user["id"],
            email=email,
            email_verified=verified,
        ),
    )


def invited(w, email="Marc@Example.TEST", role="org_member"):
    """One pending invitation whose realm account exists: what the invitee's link meets."""
    response = invite(w, w.owner, [row(email, role, display_name="Marc Dubois")])
    assert response.status_code == 201, response.content
    stored = invitations(email=email.lower()).get()
    assert run_accounts(w).succeeded == 1
    return stored, invitee(w, email.lower())


def deliveries(invitation):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT d.status, a.realm_user_id FROM outbox_outboxdelivery d "
            "JOIN outbox_realmaccount a ON a.delivery_id = d.id WHERE a.invitation_id = %s "
            "ORDER BY d.created_at, d.id",
            [invitation.id],
        )
        return cursor.fetchall()


# --- inviteToOrganisation ---------------------------------------------------------------------


def test_an_owner_invites_a_batch_and_every_row_has_an_outcome(w):
    response = invite(
        w,
        w.owner,
        [
            row("Julie@Example.TEST", "org_admin"),
            row("paul@example.test", "org_billing"),
            row("not-an-address"),
            row("alpha-admin@customer.test"),
            row("julie@example.test"),
        ],
        locale="en",
    )
    assert response.status_code == 201, response.content
    assert response.headers["Cache-Control"] == "no-store"
    body = response.json()
    assert (body["created"], body["skipped"], body["failed"]) == (2, 2, 1)
    assert [result["outcome"] for result in body["results"]] == [
        "created",
        "created",
        "invalid_email",
        "already_member",
        "already_invited",
    ]
    first = body["results"][0]["invitation"]
    assert (first["email"], first["role"], first["state"], first["realm"]) == (
        "julie@example.test",
        "org_admin",
        "pending",
        "alpha",
    )
    assert first["invited_by"] == str(w.owner.user.id) and first["sent_count"] == 1
    assert "token" not in json.dumps(body)
    stored = invitations(email="julie@example.test").get()
    assert stored.locale == "en"
    assert timedelta(days=13, hours=23) < stored.expires_at - stored.issued_at <= timedelta(days=14)
    assert stored.sent_count == 1 and stored.mail_enqueued_count == 0
    assert [status for status, _ in deliveries(stored)] == ["pending"]
    sent = audit("invitation.sent")
    assert len(sent) == 2 and sent[0]["actor_type"] == "tenant"
    assert sent[0]["metadata"] == {"role": "org_admin", "send_email": True}


def test_a_second_batch_skips_the_pending_address_and_writes_once(w):
    assert invite(w, w.owner, [row("marc@example.test")]).status_code == 201
    again = invite(w, w.owner, [row("MARC@example.test")]).json()
    assert again["results"][0]["outcome"] == "already_invited"
    assert invitations(email="marc@example.test").count() == 1


def test_a_replayed_batch_answers_the_first_result_and_writes_nothing(w):
    first = invite(w, w.owner, [row("marc@example.test")], key="invitation-replay-0001")
    replayed = invite(w, w.owner, [row("marc@example.test")], key="invitation-replay-0001")
    assert replayed.status_code == 201 and replayed.headers["Idempotency-Replayed"] == "true"
    assert replayed.json() == first.json()
    assert invitations().count() == 1 and len(audit("invitation.sent")) == 1


def test_send_email_false_creates_the_invitation_without_a_mail_owed(w):
    body = invite(w, w.owner, [row("marc@example.test")], send_email=False).json()
    assert "sent_count" not in body["results"][0]["invitation"]
    stored = invitations().get()
    assert stored.sent_count == 0 and stored.last_sent_at is None


@pytest.mark.parametrize(
    ("who", "role"),
    [("admin", "org_billing"), ("member", "org_member"), ("billing", "org_member")],
)
def test_a_caller_without_the_grant_is_refused_and_recorded(w, who, role):
    problem(invite(w, getattr(w, who), [row("marc@example.test", role)]), 403, "forbidden")
    assert invitations().count() == 0
    denied = audit("authz.denied")
    assert len(denied) == 1 and denied[0]["metadata"]["required_scope"] == "invitation:create"


def test_an_admin_may_invite_an_admin(w):
    assert invite(w, w.admin, [row("marc@example.test", "org_admin")]).status_code == 201


def test_an_owner_role_is_never_an_invitation_value(w):
    problem(invite(w, w.owner, [row("marc@example.test", "org_owner")]), 400, "malformed-request")


def test_a_stranger_and_staff_are_refused(w):
    problem(invite(w, w.foreigner, [row("marc@example.test")]), 404, "not-found")
    problem(invite(w, w.staff, [row("marc@example.test")]), 403, "forbidden")
    assert invitations().count() == 0


def test_a_suspended_organisation_takes_no_invitation(w):
    raw_update(w.alpha, state="suspended")
    problem(invite(w, w.owner, [row("marc@example.test")]), 403, "forbidden")


@pytest.mark.parametrize(
    "body",
    [
        b"{",
        {"invitations": []},
        {"invitations": [row("a@example.test")], "extra": 1},
        {"invitations": [row("a@example.test")], "send_email": "yes"},
        {"invitations": [row("a@example.test")], "locale": "de"},
        {"invitations": [row("a@example.test", display_name="x" * 201)]},
        {"invitations": [row("a@example.test") for _ in range(501)]},
    ],
)
def test_a_malformed_batch_is_refused_whole(w, body):
    path = f"/organisations/{w.alpha.id}/invitations"
    problem(post(w, path, MANY, w.owner, body, None), 400, "malformed-request")
    assert invitations().count() == 0


# --- listInvitations --------------------------------------------------------------------------


def test_a_reader_pages_newest_first_and_a_cursor_is_bound_to_its_caller(w):
    for name in ("one", "two", "three"):
        invite(w, w.owner, [row(f"{name}@example.test")])
    first = listing(w, w.owner, "?limit=2")
    assert first.status_code == 200 and first.headers["Cache-Control"] == "no-store"
    page = first.json()
    assert [item["email"] for item in page["data"]] == ["three@example.test", "two@example.test"]
    assert page["has_more"] is True
    rest = listing(w, w.owner, f"?limit=2&cursor={page['next_cursor']}").json()
    assert [item["email"] for item in rest["data"]] == ["one@example.test"]
    assert rest["has_more"] is False and rest["next_cursor"] is None
    problem(listing(w, w.admin, f"?cursor={page['next_cursor']}"), 400, "malformed-request")


def test_the_state_filter_and_a_lapsed_invitation_reads_expired(w):
    invite(w, w.owner, [row("old@example.test"), row("new@example.test")])
    old = invitations(email="old@example.test").get()
    raw_update(
        old,
        issued_at=old.issued_at - timedelta(days=15),
        expires_at=old.issued_at - timedelta(days=1),
    )
    every = {item["email"]: item["state"] for item in listing(w, w.owner).json()["data"]}
    assert every == {"old@example.test": "expired", "new@example.test": "pending"}
    revoke(w, w.owner, invitations(email="new@example.test").get().id)
    revoked = listing(w, w.owner, "?state=revoked").json()["data"]
    assert [item["email"] for item in revoked] == ["new@example.test"]
    problem(listing(w, w.owner, "?state=lost"), 400, "malformed-request")


def test_members_strangers_and_staff_do_not_list(w):
    problem(listing(w, w.member), 403, "forbidden")
    problem(listing(w, w.foreigner), 404, "not-found")
    problem(listing(w, w.staff), 403, "forbidden")


# --- resendInvitation -------------------------------------------------------------------------


def test_a_resend_waits_a_minute_then_owes_one_more_mail_and_set_up_link(w):
    invite(w, w.owner, [row("marc@example.test")])
    stored = invitations().get()
    early = problem(resend(w, w.admin, stored.id), 429, "rate-limited")
    assert early["status"] == 429
    raw_update(stored, last_sent_at=stored.last_sent_at - timedelta(minutes=2))
    later = resend(w, w.admin, stored.id)
    assert later.status_code == 200, later.content
    assert later.json()["sent_count"] == 2
    assert invitations().get().sent_count == 2
    assert len(deliveries(stored)) == 2
    assert audit("invitation.resent")[0]["metadata"] == {"sent_count": 2}


def test_only_a_pending_invitation_is_resent_and_only_by_its_administrators(w):
    invite(w, w.owner, [row("marc@example.test")])
    stored = invitations().get()
    problem(resend(w, w.member, stored.id), 403, "forbidden")
    problem(resend(w, w.foreigner, stored.id), 404, "not-found")
    problem(resend(w, w.owner, uuid4()), 404, "not-found")
    revoke(w, w.owner, stored.id)
    problem(resend(w, w.owner, stored.id), 410, "invitation-revoked")


def test_a_lapsed_invitation_is_gone_for_a_resend_and_an_accepted_one_conflicts(w):
    lapsed, _ = invited(w, "julie@example.test")
    raw_update(
        lapsed,
        issued_at=lapsed.issued_at - timedelta(days=15),
        expires_at=lapsed.issued_at - timedelta(days=1),
    )
    problem(resend(w, w.owner, lapsed.id), 410, "invitation-expired")
    stored, marc = invited(w)
    assert accept(w, marc, link_secret(stored)).status_code == 200
    problem(resend(w, w.owner, stored.id), 409, "conflict")
    # Nothing more is owed for either.
    assert [i.sent_count for i in invitations().order_by("email")] == [1, 1]


def test_an_admin_cannot_resend_or_revoke_an_invitation_to_a_role_they_cannot_grant(w):
    invite(w, w.owner, [row("marc@example.test", "org_billing")])
    stored = invitations().get()
    problem(resend(w, w.admin, stored.id), 403, "forbidden")
    problem(revoke(w, w.admin, stored.id), 403, "forbidden")
    assert [d["metadata"]["required_scope"] for d in audit("authz.denied")] == [
        "invitation:act",
        "invitation:delete",
    ]
    after = invitations().get()
    assert (after.state, after.sent_count) == ("pending", 1)
    # The owner who issued it still can.
    assert revoke(w, w.owner, stored.id).status_code == 204


# --- revokeInvitation -------------------------------------------------------------------------


def test_a_revoked_invitation_is_a_tombstone_and_revoking_again_answers_the_same(w):
    invite(w, w.owner, [row("marc@example.test")])
    stored = invitations().get()
    problem(revoke(w, w.member, stored.id), 403, "forbidden")
    problem(revoke(w, w.foreigner, stored.id), 404, "not-found")
    assert revoke(w, w.admin, stored.id).status_code == 204
    assert revoke(w, w.admin, stored.id).status_code == 204
    after = invitations().get()
    assert after.state == "revoked" and after.revoked_at is not None
    assert len(audit("invitation.revoked")) == 1


# --- acceptInvitation -------------------------------------------------------------------------


def test_the_invitee_accepts_once_and_becomes_a_member(w):
    stored, marc = invited(w, role="org_admin")
    response = accept(w, marc, link_secret(stored))
    assert response.status_code == 200, response.content
    body = response.json()
    assert (body["role"], body["state"], body["source"]) == ("org_admin", "active", "invitation")
    assert (body["email"], body["display_name"]) == ("marc@example.test", "Marc Dubois")
    after = invitations().get()
    assert after.state == "accepted" and str(after.membership_id) == body["id"]
    assert len(audit("invitation.accepted")) == len(audit("membership.created")) == 1
    me = w.client.get(ME, **bearer(marc)).json()
    assert [(item["membership_id"], item["role"]) for item in me["organisations"]] == [
        (body["id"], "org_admin")
    ]
    # The same link again: already a member, never a second membership.
    problem(accept(w, marc, link_secret(stored)), 409, "conflict")
    member_sets = model("engine_intents", "EngineMemberSet").objects.filter(reason="member_joined")
    assert member_sets.count() == 1


def test_a_token_that_does_not_resolve_says_nothing(w):
    stored, marc = invited(w)
    secret = link_secret(stored)
    problem(accept(w, marc, secret[:-4] + "AAAA"), 404, "not-found")
    problem(accept(w, marc, format_token(uuid4(), secret[-43:])), 404, "not-found")
    problem(accept(w, marc, "x" * 40), 404, "not-found")
    problem(accept(w, w.staff, secret), 404, "not-found")
    assert invitations().get().state == "pending"


def test_only_the_realm_account_made_for_the_address_and_verified_may_accept(w):
    stored, marc = invited(w)
    secret = link_secret(stored)
    problem(accept(w, w.foreigner, secret), 404, "not-found")
    someone = SimpleNamespace(
        credential=token(w.signer, w.alpha.issuer, subject="someone-else", email_verified=True)
    )
    problem(accept(w, someone, secret), 404, "not-found")
    unverified = invitee(w, "marc@example.test", verified=False)
    problem(accept(w, unverified, secret), 404, "not-found")
    assert accept(w, marc, secret).status_code == 200


def test_a_revoked_or_lapsed_invitation_is_gone(w):
    stored, marc = invited(w)
    revoke(w, w.owner, stored.id)
    problem(accept(w, marc, link_secret(stored)), 410, "invitation-revoked")
    second, julie = invited(w, "julie@example.test")
    raw_update(
        second,
        issued_at=second.issued_at - timedelta(days=15),
        expires_at=second.issued_at - timedelta(days=1),
    )
    problem(accept(w, julie, link_secret(second)), 410, "invitation-expired")


def test_an_accepted_token_is_spent(w):
    stored, marc = invited(w)
    secret = link_secret(stored)
    joined = accept(w, marc, secret).json()
    removed = w.client.delete(
        f"/api/v1/organisations/{w.alpha.id}/memberships/{joined['id']}", **bearer(w.owner)
    )
    assert removed.json()["state"] == "removed", removed.content
    # Removed since, the person cannot bring the membership back with the link that made it.
    problem(accept(w, marc, secret), 404, "not-found")


def test_a_replayed_acceptance_answers_the_first_result(w):
    stored, marc = invited(w)
    first = accept(w, marc, link_secret(stored), key="accept-replay-key-0001")
    again = accept(w, marc, link_secret(stored), key="accept-replay-key-0001")
    assert again.headers["Idempotency-Replayed"] == "true" and again.json() == first.json()


# --- previewInvitation ------------------------------------------------------------------------


def standing():
    """Everything a preview must leave as it found it: the invitations, every audit row, the
    memberships, the people and identities acceptance would create, the organisations, the replay
    store and the realm and mail deliveries."""
    return (
        list(model("orgs", "Invitation").objects.order_by("id").values()),
        list(model("identity", "User").objects.order_by("id").values()),
        list(model("identity", "Identity").objects.order_by("id").values()),
        list(model("orgs", "Organisation").objects.order_by("id").values()),
        list(model("audit", "AuditEvent").objects.order_by("id").values_list("id", flat=True)),
        list(model("orgs", "Membership").objects.order_by("id").values()),
        model("idempotency", "IdempotencyRecord").objects.count(),
        model("outbox", "OutboxDelivery").objects.count(),
    )


def test_the_invitee_reads_the_card_and_the_preview_changes_nothing(w):
    raw_update(w.owner.user, display_name="Julie Martin")
    stored, marc = invited(w, role="org_admin")
    secret = link_secret(stored)
    before = standing()
    response = preview(w, marc, secret)
    assert response.status_code == 200, response.content
    assert response.json() == {
        "organisation_name": w.alpha.name,
        "inviter_display_name": "Julie Martin",
        "role": "org_admin",
        "expires_at": stored.expires_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    assert response["Cache-Control"] == "no-store" and response["X-Request-Id"]
    assert "Idempotency-Replayed" not in response
    # A key sent anyway is ignored: the same card again, nothing stored, nothing replayed.
    again = preview(w, marc, secret, HTTP_IDEMPOTENCY_KEY="preview-key-ignored-0001")
    assert again.json() == response.json() and "Idempotency-Replayed" not in again
    assert standing() == before
    # Neither consumed nor extended: the token it read is accepted as if no preview had been read.
    joined = accept(w, marc, secret)
    assert joined.status_code == 200, joined.content
    assert invitations().get().expires_at == stored.expires_at


def test_the_card_names_no_inviter_who_set_no_name_or_was_deleted(w):
    stored, marc = invited(w)
    assert preview(w, marc, link_secret(stored)).json()["inviter_display_name"] is None
    raw_update(w.owner.user, display_name="Julie Martin")
    assert preview(w, marc, link_secret(stored)).json()["inviter_display_name"] == "Julie Martin"
    raw_update(w.owner.user, deleted_at=stored.issued_at, purge_after=stored.expires_at)
    assert preview(w, marc, link_secret(stored)).json()["inviter_display_name"] is None


def test_a_preview_token_that_does_not_resolve_says_nothing(w):
    stored, marc = invited(w)
    secret = link_secret(stored)
    before = standing()
    problem(preview(w, marc, secret[:-4] + "AAAA"), 404, "not-found")
    problem(preview(w, marc, format_token(uuid4(), secret[-43:])), 404, "not-found")
    problem(preview(w, marc, "x" * 40), 404, "not-found")
    problem(preview(w, w.staff, secret), 404, "not-found")
    assert standing() == before


def test_only_the_invited_account_verified_reads_the_card(w):
    stored, marc = invited(w)
    secret = link_secret(stored)
    problem(preview(w, w.foreigner, secret), 404, "not-found")
    someone = SimpleNamespace(
        credential=token(w.signer, w.alpha.issuer, subject="someone-else", email_verified=True)
    )
    problem(preview(w, someone, secret), 404, "not-found")
    unverified = invitee(w, "marc@example.test", verified=False)
    problem(preview(w, unverified, secret), 404, "not-found")
    assert preview(w, marc, secret).status_code == 200


def test_a_revoked_or_lapsed_invitation_has_no_card(w):
    stored, marc = invited(w)
    revoke(w, w.owner, stored.id)
    problem(preview(w, marc, link_secret(stored)), 410, "invitation-revoked")
    second, julie = invited(w, "julie@example.test")
    raw_update(
        second,
        issued_at=second.issued_at - timedelta(days=15),
        expires_at=second.issued_at - timedelta(days=1),
    )
    before = standing()
    problem(preview(w, julie, link_secret(second)), 410, "invitation-expired")
    # A lapsed row is not moved to `expired` by a preview: only the next batch writes that.
    assert standing() == before


def test_a_member_a_spent_token_and_an_inactive_organisation_conflict_or_say_nothing(w):
    stored, marc = invited(w)
    secret = link_secret(stored)
    raw_update(w.alpha, state="suspended")
    problem(preview(w, marc, secret), 409, "conflict")
    raw_update(w.alpha, state="active")
    accept(w, marc, secret)
    # The second click: already a member.
    problem(preview(w, marc, secret), 409, "conflict")
    member = w.client.get(ME, **bearer(marc)).json()["organisations"][0]
    w.client.delete(
        f"/api/v1/organisations/{w.alpha.id}/memberships/{member['membership_id']}",
        **bearer(w.owner),
    )
    # Removed since: the link that made the membership is spent.
    problem(preview(w, marc, secret), 404, "not-found")


def test_a_person_core_holds_but_no_longer_usable_has_no_card_and_cannot_accept(w):
    stored, marc, _ = removed_member(w)
    raw_update(stored, state="pending", accepted_at=None, membership_id=None)
    held = model("identity", "Identity").objects.get(subject=marc.subject)
    raw_update(held, enabled=False)
    # The usable check comes before the removed one, so `404`, not the removed member's `409`.
    problem(preview(w, marc, link_secret(stored)), 404, "not-found")
    problem(accept(w, marc, link_secret(stored)), 404, "not-found")


def test_the_preview_cannot_write_even_by_mistake(w, monkeypatch, caplog):
    """The read-only transaction is the guard, not the absence of a write in today's code."""
    from apps.orgs import invitations as service

    stored, marc = invited(w)
    before = standing()

    def writes(*, user_id):
        model("identity", "User").objects.filter(id=user_id).update(display_name="Overwritten")
        return None

    monkeypatch.setattr(service, "person_display_name", writes)
    problem(preview(w, marc, link_secret(stored)), 500, "internal-error")
    assert standing() == before
    # The 500 is the database refusing the write, not some other failure in the patched path.
    assert any(
        "previewInvitation POST failed: InternalError" in r.getMessage() for r in caplog.records
    )


def test_a_removed_member_previews_the_conflict_acceptance_would_give(w):
    stored, marc, _ = removed_member(w)
    raw_update(stored, state="pending", accepted_at=None, membership_id=None)
    problem(preview(w, marc, link_secret(stored)), 409, "conflict")
    problem(accept(w, marc, link_secret(stored)), 409, "conflict")


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        b"{}",
        json.dumps({"token": 7}).encode(),
        json.dumps({"token": "x" * 31}).encode(),
        json.dumps({"token": "x" * 257}).encode(),
        json.dumps({"token": "x" * 40, "display_name": "Marc"}).encode(),
    ],
)
def test_a_malformed_preview_is_refused(w, body):
    stored, marc = invited(w)
    problem(preview(w, marc, None, body=body), 400, "malformed-request")


def test_a_preview_is_a_post_and_needs_a_token(w):
    stored, marc = invited(w)
    response = w.client.get("/api/v1/invitations/preview", **bearer(marc))
    assert response.status_code == 405 and response["Allow"] == "POST"
    unsigned = w.client.post(
        "/api/v1/invitations/preview",
        data=json.dumps({"token": link_secret(stored)}),
        content_type="application/json",
    )
    problem(call(unsigned, PREVIEW, "post"), 401, "unauthenticated")


# --- the realm account run --------------------------------------------------------------------


def test_the_run_creates_the_account_with_required_actions_and_mails_the_set_up_link(w):
    invite(w, w.owner, [row("marc@example.test")])
    report = run_accounts(w)
    assert (report.succeeded, report.mailed, report.needs_operator) == (1, 1, False)
    user = w.realm.holding("marc@example.test")
    assert user["requiredActions"] == list(REQUIRED_ACTIONS) and user["enabled"] is True
    assert w.realm.mailed == [(user["id"], REQUIRED_ACTIONS, 3 * 24 * 3600)]
    # No return address configured: the mail names no client, and Keycloak ends on its own page.
    assert w.realm.returns == [(None, None)]
    assert deliveries(invitations().get()) == [("succeeded", user["id"])]
    assert run_accounts(w).succeeded == 0


def test_the_set_up_mail_returns_the_person_to_the_console_when_configured(w):
    invite(w, w.owner, [row("marc@example.test")])
    assert run_accounts(w, setup_redirect="https://app.localhost/").mailed == 1
    assert w.realm.returns == [("console", "https://app.localhost/")]


def test_the_account_speaks_the_invitations_language(w):
    invite(w, w.owner, [row("marc@example.test")], locale="en")
    invite(w, w.owner, [row("julie@example.test")])
    assert run_accounts(w).succeeded == 2
    # Keycloak's own set-up mail and sign-in pages read the user's locale attribute.
    assert w.realm.holding("marc@example.test")["attributes"] == {"locale": ["en"]}
    assert w.realm.holding("julie@example.test")["attributes"] == {"locale": ["fr"]}


def test_a_realm_without_the_return_address_does_not_fail_every_later_invitation(w):
    # A realm not re-applied since its console client gained the redirect answers 400.
    w.realm.redirects = frozenset()
    invite(w, w.owner, [row("marc@example.test")])
    invite(w, w.owner, [row("julie@example.test")])
    report = run_accounts(w, setup_redirect="https://app.localhost/")
    assert (report.configuration, report.failed, report.needs_operator) == (2, 0, True)
    assert "configuration=2" in report.line()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT d.status, a.last_reason FROM outbox_outboxdelivery d "
            "JOIN outbox_realmaccount a ON a.delivery_id = d.id ORDER BY d.created_at, d.id"
        )
        assert cursor.fetchall() == [("pending", "redirect_refused")] * 2
    # An invitation sent while the realm is still wrong waits with the others, not failed.
    invite(w, w.owner, [row("paul@example.test")])
    assert run_accounts(w, setup_redirect="https://app.localhost/").configuration == 3
    # Once the realm lists the return address, each one goes through.
    w.realm.redirects = frozenset({"https://app.localhost/"})
    report = run_accounts(w, setup_redirect="https://app.localhost/")
    assert (report.succeeded, report.mailed, report.needs_operator) == (3, 3, False)


def test_any_other_400_to_the_set_up_mail_still_fails_the_delivery(w):
    # Only a 400 to a mail naming a return address is the realm's configuration.
    invite(w, w.owner, [row("marc@example.test")])

    def refuse(*args, **kwargs):
        raise RealmCallError("permanent", http_status=400, cause="bad_actions")

    w.realm.execute_actions_email = refuse
    report = run_accounts(w)
    assert (report.failed, report.configuration) == (1, 0)


def test_the_invitee_is_logged_out_before_the_set_up_mail_and_a_failed_logout_sends_nothing(w):
    # The logout is what revokes an older invitation's link (identity realm tooling refuses a link issued
    # before notBefore), so a set-up mail never goes out without it.
    invite(w, w.owner, [row("marc@example.test")])
    order = []

    def refuse(user_id):
        order.append("logout")
        raise RealmCallError("transport", cause="refused")

    w.realm.logout = refuse
    report = run_accounts(w)
    assert (report.deferred, report.mailed, w.realm.mailed) == (1, 0, [])
    with connection.cursor() as cursor:
        cursor.execute("SELECT last_reason FROM outbox_realmaccount")
        assert cursor.fetchall() == [("transport",)]
    # Once the realm answers, the logout comes first and the mail right after it.
    mail = w.realm.execute_actions_email

    def logout(user_id):
        order.append("logout")

    def send(*args, **kwargs):
        order.append("send")
        mail(*args, **kwargs)

    w.realm.logout, w.realm.execute_actions_email = logout, send
    report = run_accounts(w)
    assert (report.succeeded, report.mailed) == (1, 1)
    assert order == ["logout", "logout", "send"]


def test_an_account_already_set_up_is_used_without_a_mail(w):
    w.realm.create_user({"email": "marc@example.test", "enabled": True, "requiredActions": []})
    invite(w, w.owner, [row("marc@example.test")])
    report = run_accounts(w)
    assert (report.succeeded, report.mailed) == (1, 0) and w.realm.mailed == []


def test_a_disabled_account_is_never_turned_on(w):
    w.realm.create_user({"email": "marc@example.test", "enabled": False, "requiredActions": []})
    invite(w, w.owner, [row("marc@example.test")])
    report = run_accounts(w)
    assert (report.failed, report.needs_operator) == (1, True)
    assert deliveries(invitations().get())[0][0] == "failed"


def test_a_revoked_invitation_withdraws_its_account_delivery(w):
    invite(w, w.owner, [row("marc@example.test")])
    revoke(w, w.owner, invitations().get().id)
    report = run_accounts(w)
    assert (report.withdrawn, report.needs_operator) == (1, False) and w.realm.users == {}


def test_an_unreachable_realm_defers_without_spending_an_attempt(w):
    invite(w, w.owner, [row("marc@example.test")])
    w.realm.fail = RealmCallError("transport", cause="refused")
    assert run_accounts(w).deferred == 1
    with connection.cursor() as cursor:
        cursor.execute("SELECT attempts, last_reason FROM outbox_realmaccount")
        assert cursor.fetchall() == [(1, "transport")]
    w.realm.fail = None
    assert run_accounts(w).succeeded == 1


# --- the invitation mail run ------------------------------------------------------------------


@pytest.fixture
def mail(settings):
    settings.KODERA_OUTBOX_SEAL_KEY = hashlib.sha256(b"public synthetic invitation seal").digest()
    settings.KODERA_INVITATION_LINK = "https://app.localhost/invitations/accept"
    settings.KODERA_MAIL_LINK_ORIGINS = frozenset({"https://app.localhost"})


def messages():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT m.template_id, m.locale, m.params, m.link FROM outbox_message m "
            "ORDER BY m.delivery_id"
        )
        return cursor.fetchall()


def test_each_mail_owed_is_enqueued_once(w, mail):
    invite(w, w.owner, [row("marc@example.test", "org_admin")])
    invite(w, w.owner, [row("quiet@example.test")], send_email=False)
    assert run_accounts(w).mailed == 2
    report = enqueue_invitation_mails()
    assert (len(report.enqueued), report.skipped) == (1, [])
    [(template, locale, params, link)] = messages()
    assert (template, locale, link) == (
        "invitation",
        "fr",
        # The organisation's locator, like the owner claim link: the Console discovers the realm.
        f"https://app.localhost/invitations/accept/{w.alpha.id}/alpha",
    )
    params = params if isinstance(params, dict) else json.loads(params)
    assert params["organisation_name"] == "Synthetic organisation"
    assert params["role"] == "administrateur"
    # In Paris time and French words, never an ISO stamp.
    assert params["expires_at"] == mail_instant(
        invitations(email="marc@example.test").get().expires_at, "fr"
    )
    assert re.fullmatch(r"(1er|\d{1,2}) [a-zéû]+ \d{4} à \d{1,2} h \d\d", params["expires_at"])
    assert enqueue_invitation_mails().enqueued == []
    stored = invitations(email="marc@example.test").get()
    assert stored.mail_enqueued_count == stored.sent_count == 1
    raw_update(stored, last_sent_at=stored.last_sent_at - timedelta(minutes=2))
    resend(w, w.owner, stored.id)
    # The resend's own account delivery decides what the new mail says.
    assert enqueue_invitation_mails().enqueued == []
    assert run_accounts(w).succeeded == 1
    assert len(enqueue_invitation_mails().enqueued) == 1


def test_the_mail_announces_a_set_up_mail_only_when_the_realm_sends_one(w, mail):
    w.realm.create_user({"email": "marc@example.test", "enabled": True, "requiredActions": []})
    invite(w, w.owner, [row("marc@example.test")])
    invite(w, w.owner, [row("julie@example.test")], locale="en")
    report = run_accounts(w)
    assert (report.succeeded, report.mailed) == (2, 1)
    assert len(enqueue_invitation_mails().enqueued) == 2
    assert [(template, locale) for template, locale, _, _ in messages()] == [
        ("invitation_account_ready", "fr"),
        ("invitation", "en"),
    ]


def test_the_mail_waits_for_the_account_delivery(w, mail):
    invite(w, w.owner, [row("marc@example.test")])
    # Not run yet: whether the realm will mail a set-up link is not known.
    assert enqueue_invitation_mails().enqueued == []
    w.realm.fail = RealmCallError("transport", cause="refused")
    assert run_accounts(w).deferred == 1
    assert enqueue_invitation_mails().enqueued == [] and messages() == []
    w.realm.fail = None
    assert run_accounts(w).succeeded == 1
    assert len(enqueue_invitation_mails().enqueued) == 1


def test_a_resend_after_the_selection_waits_for_its_own_account_delivery(w, mail, monkeypatch):
    invite(w, w.owner, [row("marc@example.test")])
    assert run_accounts(w).succeeded == 1
    stored = invitations().get()
    raw_update(
        stored, mail_enqueued_count=1, last_sent_at=stored.last_sent_at - timedelta(minutes=2)
    )
    resend(w, w.owner, stored.id)
    # The batch was read before the resend's account delivery was written: under the lock, the
    # run sees that delivery pending and waits.
    monkeypatch.setattr(invitation_mail, "_owed", lambda limit: [stored.id])
    assert enqueue_invitation_mails().enqueued == [] and messages() == []


def test_a_failed_account_delivery_holds_its_mail_and_no_other(w, mail):
    w.realm.create_user({"email": "marc@example.test", "enabled": False, "requiredActions": []})
    invite(w, w.owner, [row("marc@example.test")])
    invite(w, w.owner, [row("julie@example.test")])
    assert run_accounts(w).failed == 1
    # The failed one is left out of the batch, so it cannot hold back the next.
    report = enqueue_invitation_mails(limit=1)
    assert (len(report.enqueued), report.skipped) == (1, [])
    assert enqueue_invitation_mails().enqueued == []


def test_no_mail_is_enqueued_without_a_link_on_an_allowed_origin(w, mail, settings):
    invite(w, w.owner, [row("marc@example.test")])
    settings.KODERA_INVITATION_LINK = "https://elsewhere.test/accept"
    with pytest.raises(InvitationMailUnavailableError):
        enqueue_invitation_mails()
    assert messages() == []


# --- the API's least-privilege role -----------------------------------------------------------


@pytest.fixture
def writer(w):
    role = f"invitation_writer_{uuid.uuid4().hex[:12]}"
    with connection.cursor() as cursor:
        cursor.execute(f'CREATE ROLE "{role}" NOLOGIN NOINHERIT')
        for statement in grant_statements(role):
            cursor.execute(statement)
    try:
        yield role
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')


def test_the_writer_role_serves_every_invitation_operation(w, writer):
    with acting_as(writer):
        assert current_user() == writer
        body = invite(w, w.owner, [row("marc@example.test"), row("julie@example.test")]).json()
        assert body["created"] == 2
        assert listing(w, w.admin).status_code == 200
    julie = invitations(email="julie@example.test").get()
    raw_update(julie, last_sent_at=julie.last_sent_at - timedelta(minutes=2))
    with acting_as(writer):
        assert resend(w, w.owner, julie.id).status_code == 200
        assert revoke(w, w.owner, julie.id).status_code == 204
    # The realm worker is the operator's, never the API's; the revoked invitation's two
    # deliveries are withdrawn without a call.
    report = run_accounts(w)
    assert (report.succeeded, report.withdrawn) == (1, 2)
    stored = invitations(email="marc@example.test").get()
    marc = invitee(w, "marc@example.test")
    with acting_as(writer):
        assert preview(w, marc, link_secret(stored)).status_code == 200
        joined = accept(w, marc, link_secret(stored))
        assert joined.status_code == 200, joined.content
        assert w.client.get(ME, **bearer(marc)).json()["organisations"][0]["role"] == "org_member"


def removed_member(w):
    """Marc joined through an invitation, was removed, and the realm turned his account off."""
    stored, marc = invited(w)
    joined = accept(w, marc, link_secret(stored)).json()
    removed = w.client.delete(
        f"/api/v1/organisations/{w.alpha.id}/memberships/{joined['id']}", **bearer(w.owner)
    )
    assert removed.json()["state"] == "removed", removed.content
    operations = model("outbox", "OutboxRealmAccess").objects.order_by("delivery_id")
    assert [item.operation for item in operations] == ["access_off"]
    report = run_access(w)
    assert report.succeeded == 1, report.line()
    assert w.realm.users[marc.subject]["enabled"] is False
    return stored, marc, joined


def test_a_removed_member_is_refused_at_invitation_time(w, writer):
    _, _, _ = removed_member(w)
    with acting_as(writer):
        response = invite(w, w.owner, [row("Marc@Example.TEST")])
    assert response.status_code == 201, response.content
    assert response.json()["results"] == [
        {
            "email": "marc@example.test",
            "outcome": "failed",
            "invitation": None,
            "detail": "Removed from this organisation.",
        }
    ]
    # No invitation, so no mail and no realm account delivery that would fail for an operator.
    assert invitations(state="pending").count() == 0
    assert run_accounts(w).failed == 0


def test_a_removed_row_is_never_revived_through_an_invitation(w):
    stored, marc, joined = removed_member(w)
    # Not reachable through the API: an invitation pending for the removed person's own account.
    raw_update(stored, state="pending", accepted_at=None, membership_id=None)
    problem(accept(w, marc, link_secret(stored)), 409, "conflict")
    membership = model("orgs", "Membership").objects.get(id=joined["id"])
    assert membership.state == "removed"
    operations = model("outbox", "OutboxRealmAccess").objects.order_by("delivery_id")
    assert [item.operation for item in operations] == ["access_off"]
