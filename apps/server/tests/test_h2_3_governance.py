"""Bilateral approval, immediate denial and single-channel guest confinement."""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.db import transaction
from django.utils import timezone
from workspace_safety.test_moderation import world as world

from apps.identity.models import Identity, User
from apps.orgs.models import Membership, Organisation, SlugReservation
from apps.workspaces import bridges
from apps.workspaces.models import Channel, ResourcePolicy, SessionEviction, Workspace

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def governed(world, settings):
    settings.KODERA_CHANNEL_GOVERNANCE_ENABLED = True
    org, workspace, members, tokens = world
    slug = "partner-" + uuid4().hex[:10]
    with transaction.atomic():
        partner = Organisation.objects.create(
            slug=slug,
            realm=slug,
            name="Partner",
            state="active",
            issuer=f"https://identity.example.org/realms/{slug}",
        )
        SlugReservation.objects.create(
            organisation=partner,
            slug=slug,
            namespace="organisation",
            state="permanent",
            protected_at=timezone.now(),
        )
        user = User.objects.create(email=slug + "@example.org")
        Identity.objects.create(
            user=user,
            organisation=partner,
            issuer=partner.issuer,
            realm=slug,
            subject=str(uuid4()),
            email=user.email,
        )
        Membership.objects.create(
            user=user,
            organisation=partner,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
    peer = Workspace.objects.create(organisation=partner)
    channels = [
        Channel.objects.create(
            workspace=target, kind="text", name="Shared", position=0, lifecycle="active"
        )
        for target in (workspace, peer)
    ]
    for target in (workspace, peer):
        policy = ResourcePolicy.objects.create(workspace=target, visibility="organisation")
        Workspace.objects.filter(id=target.id).update(default_policy=policy)
    return world, partner, channels


def proposal(governed):
    world, partner, channels = governed
    return bridges.propose(
        verified=world[3][0],
        organisation_id=world[0].id,
        body={
            "partnerOrganisationId": str(partner.id),
            "channelId": str(channels[0].id),
            "partnerChannelId": str(channels[1].id),
            "localHomeserver": "local.example.org",
            "partnerHomeserver": "peer.example.org",
            "matrixRoomId": "!shared:local.example.org",
            "historyDisclosureAccepted": True,
        },
        request_id=str(uuid4()),
    )


def test_proposer_cannot_self_activate_and_revision_is_fenced(governed):
    result = proposal(governed)
    world = governed[0]
    with pytest.raises(bridges.RefusalError):
        bridges.transition(
            verified=world[3][0],
            organisation_id=world[0].id,
            agreement_id=result["id"],
            body={"revision": 1, "action": "activate"},
            request_id=str(uuid4()),
        )
    with pytest.raises(bridges.RefusalError):
        bridges.transition(
            verified=world[3][0],
            organisation_id=world[0].id,
            agreement_id=result["id"],
            body={"revision": 9, "action": "revoke"},
            request_id=str(uuid4()),
        )


def test_unilateral_revocation_denies_stale_matrix_membership(governed):
    result = proposal(governed)
    world = governed[0]
    bridges.transition(
        verified=world[3][0],
        organisation_id=world[0].id,
        agreement_id=result["id"],
        body={"revision": 1, "action": "revoke"},
        request_id=str(uuid4()),
    )
    decision = bridges.matrix_authority(
        organisation_id=world[0].id,
        room_id="!shared:local.example.org",
        user_id="@member:peer.example.org",
        action="event",
    )
    assert decision["allowed"] is False
    assert SessionEviction.objects.count() == 2
    assert result["replicatedHistoryErasable"] is False


def test_guest_is_confined_across_rooms_homeservers_and_actions(governed):
    world, _, channels = governed
    user = User.objects.create(email="guest@example.org")
    identity = Identity.objects.create(
        user=user,
        organisation=world[0],
        issuer=world[0].issuer,
        realm=world[0].realm,
        subject=str(uuid4()),
        email=user.email,
    )
    result = bridges.grant_guest(
        verified=world[3][0],
        organisation_id=world[0].id,
        body={
            "guestIdentityId": str(identity.id),
            "matrixUserId": "@guest:peer.example.org",
            "channelId": str(channels[0].id),
            "matrixRoomId": "!guest:local.example.org",
            "expiresAt": (timezone.now() + timedelta(hours=1)).isoformat(),
            "allowCalls": False,
        },
        request_id=str(uuid4()),
    )
    for room, action in [
        ("!other:local.example.org", "join"),
        ("!other:peer.example.org", "join"),
        ("!guest:local.example.org", "invite"),
        ("", "create"),
        ("!guest:local.example.org", "call"),
        ("", "directory"),
    ]:
        assert not bridges.matrix_authority(
            organisation_id=world[0].id,
            room_id=room,
            user_id="@guest:peer.example.org",
            action=action,
        )["allowed"]
    assert bridges.matrix_authority(
        organisation_id=world[0].id,
        room_id="!guest:local.example.org",
        user_id="@guest:peer.example.org",
        action="event",
    )["allowed"]
    bridges.revoke_guest(
        verified=world[3][0],
        organisation_id=world[0].id,
        grant_id=result["id"],
        request_id=str(uuid4()),
    )
    assert not bridges.matrix_authority(
        organisation_id=world[0].id,
        room_id="!guest:local.example.org",
        user_id="@guest:peer.example.org",
        action="event",
    )["allowed"]


def test_partner_approval_suspend_and_fresh_revision_need_both_sides(governed):
    from apps.orgs.models import Membership
    from services.identity.access_tokens import VerifiedAccessToken

    result = proposal(governed)
    world, peer, _ = governed
    member = Membership.objects.get(organisation=peer, role="org_owner")
    identity = Identity.objects.get(organisation=peer, user=member.user)
    token = VerifiedAccessToken(
        peer.issuer,
        identity.subject,
        ("kodera-server",),
        0,
        2**31,
        None,
        None,
        None,
        None,
        email_verified=True,
    )

    def change(organisation, credential, revision, action):
        return bridges.transition(
            verified=credential,
            organisation_id=organisation,
            agreement_id=result["id"],
            body={"revision": revision, "action": action},
            request_id=str(uuid4()),
        )

    assert change(peer.id, token, 1, "activate")["state"] == "active"
    assert bridges.matrix_authority(
        organisation_id=world[0].id,
        room_id="!shared:local.example.org",
        user_id="@member:peer.example.org",
        action="event",
    )["allowed"]
    assert change(peer.id, token, 2, "suspend")["state"] == "suspended"
    for user in ["@member:peer.example.org", "@member:local.example.org"]:
        assert not bridges.matrix_authority(
            organisation_id=world[0].id,
            room_id="!shared:local.example.org",
            user_id=user,
            action="event",
        )["allowed"]
    assert change(world[0].id, world[3][0], 3, "repropose")["state"] == "proposed"
    with pytest.raises(bridges.RefusalError):
        change(world[0].id, world[3][0], 4, "activate")
    assert change(peer.id, token, 4, "activate")["state"] == "active"


def test_guest_core_directory_docs_template_and_channel_fence(governed, monkeypatch):
    from django.test import RequestFactory

    from apps.workspaces import guest_http
    from apps.workspaces.models import SingleChannelGuestGrant

    test_guest_is_confined_across_rooms_homeservers_and_actions(governed)
    grant = SingleChannelGuestGrant.objects.get()
    identity = Identity.objects.get(pk=grant.guest_identity_id)
    token = governed[0][3][0]
    monkeypatch.setattr(guest_http, "verify_configured_token", lambda *a, **kw: (token, "customer"))
    monkeypatch.setattr(
        guest_http,
        "current_identity",
        lambda **kw: (object(), type("Snapshot", (), {"id": identity.id})()),
    )

    def unreachable(request):
        pytest.fail("a guest reached an ordinary Core handler")

    middleware = guest_http.GuestScopeMiddleware(unreachable)
    organisation = governed[0][0].id
    for suffix in [
        "memberships",
        "workspace",
        "workspace/documents",
        "workspace/search",
        "workspace/templates",
        "workspace/channels",
        "invitations",
    ]:
        response = middleware(
            RequestFactory().get(
                f"/api/v1/organisations/{organisation}/{suffix}",
                HTTP_AUTHORIZATION="Bearer synthetic",
            )
        )
        assert response.status_code == 403
    # Revocation does not turn a guest identity into an ordinary member.
    assert grant.revoked_at is not None


def test_guest_identity_with_membership_is_refused(governed):
    world, _, channels = governed
    identity = Identity.objects.get(organisation=world[0], user=world[2][2].user)
    with pytest.raises(bridges.RefusalError):
        bridges.grant_guest(
            verified=world[3][0],
            organisation_id=world[0].id,
            body={
                "guestIdentityId": str(identity.id),
                "matrixUserId": "@member:local.example.org",
                "channelId": str(channels[0].id),
                "matrixRoomId": "!guest:local.example.org",
                "expiresAt": (timezone.now() + timedelta(hours=1)).isoformat(),
            },
            request_id=str(uuid4()),
        )


def test_organisation_erasure_removes_bilateral_and_guest_children(governed):
    from test_core_erasure import operator

    from apps.orgs.erasure_services import begin_erasure, database_now, purge_core
    from apps.workspaces.models import (
        PartnerChannelAgreement,
        PartnerChannelAgreementRevision,
        SingleChannelGuestGrant,
    )

    test_guest_is_confined_across_rooms_homeservers_and_actions(governed)
    result = proposal(governed)
    bridges.transition(
        verified=governed[0][3][0],
        organisation_id=governed[0][0].id,
        agreement_id=result["id"],
        body={"revision": 1, "action": "revoke"},
        request_id=str(uuid4()),
    )
    request = begin_erasure(
        organisation_id=governed[0][0].id,
        instruction_ref="DEL-323",
        instruction_sha256="8" * 64,
        purge_not_before=database_now(),
        actor_identity_id=operator().id,
    )
    purge_core(request.id)
    for model in (
        PartnerChannelAgreement,
        PartnerChannelAgreementRevision,
        SingleChannelGuestGrant,
        SessionEviction,
    ):
        assert not model.objects.exists()


def test_agent_authority_is_credential_bound_and_revocation_is_live(governed):
    from apps.engine_intents.services import channel_authority, issue_credential

    result = proposal(governed)
    org = governed[0][0]
    _, credential = issue_credential(organisation_id=org.id)
    args = {
        "room_id": "!shared:local.example.org",
        "user_id": "@member:peer.example.org",
        "action": "event",
    }
    assert channel_authority(token="invalid", **args) is None
    assert channel_authority(token=credential, **args)["allowed"] is False
    bridges.transition(
        verified=governed[0][3][0],
        organisation_id=org.id,
        agreement_id=result["id"],
        body={"revision": 1, "action": "revoke"},
        request_id=str(uuid4()),
    )
    assert channel_authority(token=credential, **args)["allowed"] is False


def test_audio_guest_tokens_and_existing_calls_stop_at_expiry(governed, monkeypatch):
    from test_room_access import AGENT, ALICE, AUDIO, FakeLiveKit, FakeMatrix

    from room_access.rooms import identity as media_identity, livekit_room
    from room_access.service import RefusedError as CallRefused, Service

    world, _, channels = governed
    audio = Channel.objects.create(
        workspace=world[1], kind="audio", name="Guest audio", position=1, lifecycle="active"
    )
    user = User.objects.create(email="audio-guest@example.org")
    guest = Identity.objects.create(
        user=user,
        organisation=world[0],
        issuer=world[0].issuer,
        realm=world[0].realm,
        subject=str(uuid4()),
        email=user.email,
    )
    expires = timezone.now() + timedelta(hours=1)
    bridges.grant_guest(
        verified=world[3][0],
        organisation_id=world[0].id,
        body={
            "guestIdentityId": str(guest.id),
            "matrixUserId": ALICE,
            "matrixRoomId": AUDIO,
            "channelId": str(audio.id),
            "expiresAt": expires.isoformat(),
            "allowCalls": True,
        },
        request_id=str(uuid4()),
    )

    class Live:
        def allows(self, user, room):
            return bridges.matrix_authority(
                organisation_id=world[0].id, user_id=user, room_id=room, action="call"
            )["allowed"]

        def is_guest(self, user, room):
            return self.allows(user, room)

    matrix, livekit = FakeMatrix(), FakeLiveKit()
    service = Service(matrix, livekit, "wss://media.example.org", AGENT, authority=Live())
    matrix.policy(AUDIO, audience="listed", members=[])
    assert service.grant("tok-alice", AUDIO).token
    for room in ["!other:acme.kodera.io", "!other:peer.example.org"]:
        with pytest.raises(CallRefused):
            service.grant("tok-alice", room)
    livekit.join(AUDIO, media_identity(ALICE, "DEV1"))
    monkeypatch.setattr(bridges.timezone, "now", lambda: expires + timedelta(seconds=1))
    with pytest.raises(CallRefused):
        service.grant("tok-alice", AUDIO)
    service.refresh(livekit_room(AUDIO), AUDIO)
    assert livekit.removed == [media_identity(ALICE, "DEV1")]


def test_governance_issuance_is_disabled_until_operator_activation(governed, settings):
    settings.KODERA_CHANNEL_GOVERNANCE_ENABLED = False
    with pytest.raises(bridges.RefusalError) as failure:
        proposal(governed)
    assert failure.value.status == 503
    assert (
        bridges.overview(verified=governed[0][3][0], organisation_id=governed[0][0].id)[
            "enforcementReady"
        ]
        is False
    )


@pytest.fixture(params=[("host", "local"), ("host", "peer"), ("peer", "local"), ("peer", "peer")])
def bridged_guest(governed, request):
    """Either organisation may grant a guest from either configured homeserver."""
    from apps.engine_intents.services import issue_credential
    from apps.workspaces.models import PartnerChannelAgreement, SingleChannelGuestGrant
    from services.identity.access_tokens import VerifiedAccessToken

    world, peer, channels = governed
    host = world[0]
    channels = [
        Channel.objects.create(
            workspace=channel.workspace,
            kind="audio",
            name="Shared audio",
            position=1,
            lifecycle="active",
        )
        for channel in channels
    ]
    result = proposal((world, peer, channels))
    owner = Membership.objects.get(organisation=peer, role="org_owner")
    owner_identity = Identity.objects.get(organisation=peer, user=owner.user)
    peer_token = VerifiedAccessToken(
        peer.issuer,
        owner_identity.subject,
        ("kodera-server",),
        0,
        2**31,
        None,
        None,
        None,
        None,
        email_verified=True,
    )
    bridges.transition(
        verified=peer_token,
        organisation_id=peer.id,
        agreement_id=result["id"],
        body={"revision": 1, "action": "activate"},
        request_id=str(uuid4()),
    )
    side, home = request.param
    org, channel, token = (
        (host, channels[0], world[3][0]) if side == "host" else (peer, channels[1], peer_token)
    )
    user = User.objects.create(email="bridge-guest@example.org")
    identity_org = host if home == "local" else peer
    identity = Identity.objects.create(
        user=user,
        organisation=identity_org,
        issuer=identity_org.issuer,
        realm=identity_org.realm,
        subject=str(uuid4()),
        email=user.email,
    )
    guest_user = "@guest:" + ("local.example.org" if home == "local" else "peer.example.org")
    grant = bridges.grant_guest(
        verified=token,
        organisation_id=org.id,
        body={
            "guestIdentityId": str(identity.id),
            "matrixUserId": guest_user,
            "channelId": str(channel.id),
            "matrixRoomId": result["matrixRoomId"],
            "expiresAt": (timezone.now() + timedelta(hours=1)).isoformat(),
            "allowCalls": True,
        },
        request_id=str(uuid4()),
    )
    return {
        "agreement": PartnerChannelAgreement.objects.get(id=result["id"]),
        "grant": SingleChannelGuestGrant.objects.get(id=grant["id"]),
        "credentials": [issue_credential(organisation_id=o.id)[1] for o in (host, peer)],
        "orgs": [host.id, peer.id],
        "tokens": [world[3][0], peer_token],
    }


def invalidate_bridge_guest(fixture, reason, monkeypatch):
    """Invalidate stored authority while leaving Matrix membership and policy stale."""
    agreement, grant = fixture["agreement"], fixture["grant"]
    if reason in {"suspended", "revoked"}:
        bridges.transition(
            verified=fixture["tokens"][0],
            organisation_id=fixture["orgs"][0],
            agreement_id=agreement.id,
            body={
                "revision": agreement.revision,
                "action": "suspend" if reason == "suspended" else "revoke",
            },
            request_id=str(uuid4()),
        )
    elif reason == "proposed":
        for revision, action in [
            (agreement.revision, "suspend"),
            (agreement.revision + 1, "repropose"),
        ]:
            bridges.transition(
                verified=fixture["tokens"][0],
                organisation_id=fixture["orgs"][0],
                agreement_id=agreement.id,
                body={"revision": revision, "action": action},
                request_id=str(uuid4()),
            )
    elif reason == "guest-revoked":
        index = fixture["orgs"].index(grant.organisation_id)
        bridges.revoke_guest(
            verified=fixture["tokens"][index],
            organisation_id=grant.organisation_id,
            grant_id=grant.id,
            request_id=str(uuid4()),
        )
    elif reason == "guest-expired":
        monkeypatch.setattr(
            bridges.timezone, "now", lambda: grant.expires_at + timedelta(seconds=1)
        )
    else:
        raise AssertionError(reason)


@pytest.mark.parametrize(
    "reason", ["suspended", "revoked", "proposed", "guest-revoked", "guest-expired"]
)
def test_both_agents_intersect_guest_and_partner_authority(bridged_guest, reason, monkeypatch):
    from apps.engine_intents.services import channel_authority, issue_credential

    grant = bridged_guest["grant"]
    for credential in bridged_guest["credentials"]:
        for action in ["join", "event", "call", "session"]:
            room = "" if action == "session" else grant.matrix_room_id
            assert (
                channel_authority(
                    token=credential, room_id=room, user_id=grant.matrix_user_id, action=action
                )["allowed"]
                is True
            )
        for action in ["invite", "create", "directory"]:
            assert (
                channel_authority(
                    token=credential,
                    room_id=grant.matrix_room_id,
                    user_id=grant.matrix_user_id,
                    action=action,
                )["allowed"]
                is False
            )
        for room in ["!other:local.example.org", "!other:peer.example.org"]:
            for action in ["join", "event", "call"]:
                assert (
                    channel_authority(
                        token=credential, room_id=room, user_id=grant.matrix_user_id, action=action
                    )["allowed"]
                    is False
                )
    # Another organisation's valid credential gains no authority over this guest.
    with transaction.atomic():
        stranger = Organisation.objects.create(
            slug="stranger",
            realm="stranger",
            name="Stranger",
            state="active",
            issuer="https://identity.example.org/realms/stranger",
        )
        SlugReservation.objects.create(
            organisation=stranger,
            slug="stranger",
            namespace="organisation",
            state="permanent",
            protected_at=timezone.now(),
        )
        owner = Membership.objects.get(organisation_id=bridged_guest["orgs"][0], role="org_owner")
        Identity.objects.create(
            user=owner.user,
            organisation=stranger,
            issuer=stranger.issuer,
            realm="stranger",
            subject=str(uuid4()),
            email=owner.user.email,
        )
        Membership.objects.create(
            organisation=stranger,
            user=owner.user,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
    _, credential = issue_credential(organisation_id=stranger.id)
    assert (
        channel_authority(
            token=credential,
            room_id=grant.matrix_room_id,
            user_id=grant.matrix_user_id,
            action="join",
        )["allowed"]
        is False
    )
    invalidate_bridge_guest(bridged_guest, reason, monkeypatch)
    for credential in bridged_guest["credentials"]:
        for action in ["join", "event", "call", "session"]:
            decision = channel_authority(
                token=credential,
                room_id="" if action == "session" else grant.matrix_room_id,
                user_id=grant.matrix_user_id,
                action=action,
            )
            assert decision["allowed"] is False
            assert decision["role"] == "single_channel_guest"


def test_guest_cannot_rename_a_bridged_channel_to_bypass_agreement(bridged_guest):
    from apps.engine_intents.services import channel_authority
    from apps.workspaces.models import SingleChannelGuestGrant

    original = bridged_guest["grant"]
    org = Organisation.objects.get(id=original.organisation_id)
    user = User.objects.create(email="mismatched-guest@example.org")
    guest = Identity.objects.create(
        user=user,
        organisation=org,
        issuer=org.issuer,
        realm=org.realm,
        subject=str(uuid4()),
        email=user.email,
    )
    index = bridged_guest["orgs"].index(org.id)
    result = bridges.grant_guest(
        verified=bridged_guest["tokens"][index],
        organisation_id=org.id,
        body={
            "guestIdentityId": str(guest.id),
            "matrixUserId": "@mismatched:peer.example.org",
            "channelId": str(original.single_channel_id),
            "matrixRoomId": "!renamed:local.example.org",
            "expiresAt": (timezone.now() + timedelta(hours=1)).isoformat(),
            "allowCalls": True,
        },
        request_id=str(uuid4()),
    )
    grant = SingleChannelGuestGrant.objects.get(id=result["id"])
    for credential in bridged_guest["credentials"]:
        for action in ["join", "event", "call", "session"]:
            assert (
                channel_authority(
                    token=credential,
                    room_id=grant.matrix_room_id,
                    user_id=grant.matrix_user_id,
                    action=action,
                )["allowed"]
                is False
            )
