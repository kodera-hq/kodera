"""Real signed HTTP claims, persisted assignments, replay and current authority.

The last part is contract 0.42.0 over HTTP (docs/specs/WORKSPACE_TEMPLATES.md): `proximity` and its
permanent alias `crisis-cell` claim the same prepared workspace; a claim and a stored plan meet
whichever of a theme's identifiers each holds; and the proximity workspace takes further proximity
channels and their members through the existing structure administration.
"""

import json

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.urls import resolve
from test_access_tokens import frozen_clock as frozen_clock
from test_espace_structure import (
    CHANNELS,
    access_of,
    administration,
    create_channel,
    membership,
    send,
    set_access,
)
from test_workspace_onboarding import conformance_errors, read, w as w

from apps.workspaces import instant_claim as claims
from apps.workspaces.api.instant_claim import instant_claim
from apps.workspaces.models import (
    Category,
    Channel,
    ResourcePolicy,
    WarmPoolAllocation,
    Workspace,
)
from apps.workspaces.warm_pool import build_instant_claim_plan, parse_instant_claim_request

PATH = "/api/v1/workspaces/instant-claim"
KEY = "00000000-0000-4000-8000-000000000074"
PAYLOAD = {
    "organizationName": "Synthetic organisation",
    "slug": "alpha",
    "hostingMode": "cloud",
    "templateId": "tech-studio",
}
pytestmark = pytest.mark.django_db(transaction=True)


def call(w, actor=None, payload=None, key=KEY):
    headers = {"HTTP_AUTHORIZATION": "Bearer " + (actor or w.owner).credential}
    if key is not None:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    response = w.client.post(
        PATH, json.dumps(payload or PAYLOAD), content_type="application/json", **headers
    )
    assert not conformance_errors(response, "/workspaces/instant-claim", "post")
    return response


def prepare(w):
    plan = build_instant_claim_plan(parse_instant_claim_request(json.dumps(PAYLOAD).encode()))
    workspace = Workspace.objects.create(organisation=w.alpha)
    categories = {
        c["key"]: Category.objects.create(
            workspace=workspace,
            name=c["name"],
            template_key=c["db_template_key"],
            position=c["position"],
        )
        for c in plan["categories"]
    }
    for channel in plan["channels"]:
        values = {
            k: v
            for k, v in channel.items()
            if k not in {"category_key", "db_template_key", "template_key"}
        }
        Channel.objects.create(
            workspace=workspace,
            category=categories[channel["category_key"]],
            template_key=channel["db_template_key"],
            room_state="ready",
            **values,
        )
    return WarmPoolAllocation.objects.create(
        workspace=workspace,
        slug="alpha",
        plan=plan,
        workspace_url="https://alpha.example.org",
        invitation_url="https://alpha.example.org/invite?signed=synthetic",
        offer_mode="cloud-shared",
    )


def test_route_is_exposed():
    assert resolve(PATH).func is instant_claim


def test_empty_pool_is_explicit_and_same_key_can_retry_after_allocation(w, frozen_clock):
    response = call(w)
    assert response.status_code == 503
    assert response.json()["code"] == "warm_pool_unavailable"
    allocation = prepare(w)
    response = call(w)
    assert response.status_code == 201
    assert response.json()["workspaceId"] == str(allocation.workspace_id)
    allocation.refresh_from_db()
    assert allocation.claimed_at is not None
    replay = call(w)
    assert replay.status_code == 201
    assert replay.content == response.content
    assert replay["Idempotency-Replayed"] == "true"
    assert call(w, key="another-valid-idempotency-key-74").status_code == 409
    assert call(w, payload=PAYLOAD | {"organizationName": "Changed"}).status_code == 409


@pytest.mark.parametrize("actor", ["admin", "member", "billing", "stranger", "staff"])
def test_only_current_owner_can_claim(w, frozen_clock, actor):
    assert call(w, getattr(w, actor)).status_code == 403


def test_anonymous_claim_is_refused(w):
    assert w.client.post(PATH, "{}", content_type="application/json").status_code == 401


@pytest.mark.parametrize("key", [None, "short", "invalid key with spaces"])
def test_idempotency_key_is_required_and_validated(w, frozen_clock, key):
    assert call(w, key=key).status_code == 400


def test_invalid_payload_and_reserved_slug_are_refused(w, frozen_clock):
    assert call(w, payload=PAYLOAD | {"slug": "community"}).status_code == 400


def test_foreign_owner_cannot_take_allocation(w, frozen_clock):
    allocation = prepare(w)
    assert call(w, w.foreigner).status_code == 503
    allocation.refresh_from_db()
    assert allocation.claimed_at is None


def test_unready_rooms_and_mismatched_plan_never_claim(w, frozen_clock):
    allocation = prepare(w)
    Channel.objects.filter(workspace=allocation.workspace).update(room_state="pending")
    assert call(w).status_code == 503
    Channel.objects.filter(workspace=allocation.workspace).update(room_state="ready")
    assert call(w, payload=PAYLOAD | {"themeId": "real-black"}).status_code == 503
    allocation.refresh_from_db()
    assert allocation.claimed_at is None


def test_replay_rechecks_current_identity(w, frozen_clock):
    prepare(w)
    assert call(w).status_code == 201
    w.models.Identity.objects.filter(pk=w.owner.identity.pk).update(enabled=False)
    response = call(w)
    assert response.status_code == 403
    assert response.json()["type"] == "https://kodera.io/problems/identity-unknown"


# --- contract 0.42.0: proximity, its alias, and the theme vocabulary ----------------------------

PROXIMITY = PAYLOAD | {"templateId": "proximity"}


def prepare_from(w, payload, **stored):
    """A ready allocation prepared from `payload`'s plan, as the pool leaves one: the workspace
    with its default policy, the template's categories and channels with their rooms ready.
    `stored` overrides members of the stored plan, as a plan written before 0.42.0 holds them."""
    plan = build_instant_claim_plan(parse_instant_claim_request(json.dumps(payload).encode()))
    workspace = Workspace.objects.create(organisation=w.alpha, structure_revision=1)
    default = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    Workspace.objects.filter(pk=workspace.pk).update(default_policy=default)
    categories = {
        c["key"]: Category.objects.create(
            workspace=workspace,
            name=c["name"],
            template_key=c["db_template_key"],
            position=c["position"],
        )
        for c in plan["categories"]
    }
    for channel in plan["channels"]:
        values = {
            k: v
            for k, v in channel.items()
            if k not in {"category_key", "db_template_key", "template_key"}
        }
        Channel.objects.create(
            workspace=workspace,
            category=categories[channel["category_key"]],
            template_key=channel["db_template_key"],
            room_state="ready",
            **values,
        )
    return WarmPoolAllocation.objects.create(
        workspace=workspace,
        slug="alpha",
        plan=plan | stored,
        workspace_url="https://alpha.example.org",
        invitation_url="https://alpha.example.org/invite?signed=synthetic",
        offer_mode="cloud-shared",
    )


@pytest.mark.parametrize("prepared_as", ["proximity", "crisis-cell"])
@pytest.mark.parametrize("claimed_as", ["proximity", "crisis-cell"])
def test_proximity_and_crisis_cell_claim_the_same_workspace(
    w, frozen_clock, prepared_as, claimed_as
):
    """Whichever identifier prepared the workspace and whichever the claim sends, a stored plan
    that still says `crisis-cell` included, the answer is the proximity workspace."""
    allocation = prepare_from(w, PROXIMITY | {"templateId": prepared_as}, template_id=prepared_as)
    response = call(w, payload=PROXIMITY | {"templateId": claimed_as})
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["workspaceId"] == str(allocation.workspace_id)
    assert [(c["name"], c["kind"]) for c in body["channels"]] == [("proximity", "text")]
    assert body["enabledConnectors"] == []
    [channel] = Channel.objects.filter(workspace=allocation.workspace)
    assert (channel.template_key, channel.name) == ("proximity", "proximity")
    assert "not an emergency service" in channel.topic


def test_the_two_identifiers_are_answered_alike(w, frozen_clock):
    """`crisis-cell` is never answered differently from `proximity`: with no workspace prepared
    both are the same refusal, and neither is the `400` of an unknown template."""
    by_name = call(w, payload=PROXIMITY)
    by_alias = call(w, payload=PROXIMITY | {"templateId": "crisis-cell"}, key=KEY[:-2] + "75")
    assert by_name.status_code == by_alias.status_code == 503
    assert by_name.json()["code"] == by_alias.json()["code"] == "warm_pool_unavailable"
    unknown = call(w, payload=PROXIMITY | {"templateId": "crisis"}, key=KEY[:-2] + "76")
    assert unknown.status_code == 400


THEME_PAIRS = [("givre", "light"), ("ardoise", "dark"), ("real-black", "black")]


def check_a_claim_and_a_stored_plan_meet_on_the_theme(w, stored, sent):
    allocation = prepare_from(w, PAYLOAD | {"themeId": stored}, theme_id=stored)
    assert WarmPoolAllocation.objects.get(pk=allocation.pk).plan["theme_id"] == stored
    response = call(w, payload=PAYLOAD | {"themeId": sent})
    assert response.status_code == 201, (
        f"a claim sending {sent} did not match the plan prepared as {stored}: "
        f"{response.status_code}"
    )
    allocation.refresh_from_db()
    assert allocation.claimed_at is not None


@pytest.mark.parametrize(("alias", "theme"), THEME_PAIRS)
@pytest.mark.parametrize("direction", ["plan holds the alias", "claim sends the alias"])
def test_a_claim_and_a_stored_plan_meet_whichever_theme_identifier_each_holds(
    w, frozen_clock, alias, theme, direction
):
    stored, sent = (alias, theme) if direction == "plan holds the alias" else (theme, alias)
    check_a_claim_and_a_stored_plan_meet_on_the_theme(w, stored, sent)


@pytest.mark.parametrize("theme", ["light", "dark", "black", "ciel", "ciel-nuit"])
def test_each_theme_identifier_claims_the_plan_prepared_for_it(w, frozen_clock, theme):
    check_a_claim_and_a_stored_plan_meet_on_the_theme(w, theme, theme)


def test_a_different_theme_is_still_a_different_plan(w, frozen_clock):
    allocation = prepare_from(w, PAYLOAD | {"themeId": "givre"}, theme_id="givre")
    for other in ("dark", "ardoise", "ciel"):
        assert call(w, payload=PAYLOAD | {"themeId": other}).status_code == 503
    allocation.refresh_from_db()
    assert allocation.claimed_at is None


def test_refusal_control_the_theme_check_passes_on_the_unmutated_claim(w, frozen_clock):
    check_a_claim_and_a_stored_plan_meet_on_the_theme(w, "givre", "light")


def test_refusal_a_claim_that_reads_the_stored_plan_raw_fails_the_theme_check(
    w, frozen_clock, monkeypatch
):
    """The mutant: the claim compares the stored plan as it is, without the canonicalisation its
    own identifiers went through. A plan prepared as `givre` no longer meets a claim for `light`."""
    monkeypatch.setattr(claims, "canonical_plan", lambda plan: plan)
    with pytest.raises(AssertionError, match="did not match the plan prepared as givre"):
        check_a_claim_and_a_stored_plan_meet_on_the_theme(w, "givre", "light")


def test_a_proximity_workspace_takes_more_proximity_channels_and_their_members(w, frozen_clock):
    """Nothing new is needed and nothing blocks it: an owner adds a proximity channel with
    `createChannel`, an admin adds another, and members are brought into one with the channel's
    access document, the mechanism every other channel uses."""
    allocation = prepare_from(w, PROXIMITY)
    assert call(w, payload=PROXIMITY).status_code == 201
    [category] = administration(w)["categories"]
    assert category["template_key"] == "proximity"
    assert [c["name"] for c in category["channels"]] == ["proximity"]

    hall = create_channel(w, category["id"], name="proximity-hall")
    yard = create_channel(w, category["id"], name="proximity-cour", who=w.admin)
    voice = create_channel(w, category["id"], name="proximity-voix", kind="audio")
    # The same slug again is refused by nothing either: a slug is not a key.
    again = send(
        w,
        w.owner,
        "post",
        CHANNELS,
        {"category_id": category["id"], "kind": "text", "name": "proximity"},
    )
    assert again.status_code == 201, again.content
    names = [c["name"] for c in administration(w)["categories"][0]["channels"]]
    assert sorted(names) == sorted(
        ["proximity", "proximity", "proximity-hall", "proximity-cour", "proximity-voix"]
    )
    assert (
        Channel.objects.filter(workspace=allocation.workspace, template_key="proximity").count()
        == 1
    )

    def seen_by(who):
        body = read(w, who).json()
        return {c["name"] for cat in body["categories"] for c in cat["channels"]}

    # Open to the organisation by default: every member is in.
    assert {"proximity", "proximity-hall", "proximity-cour"} <= seen_by(w.member)
    # Invited members only: the channel is restricted, and the member is not in it yet.
    restricted = set_access(w, hall["id"], visibility="restricted")
    assert restricted.status_code == 200, restricted.content
    assert "proximity-hall" not in seen_by(w.member)
    invited = set_access(
        w, hall["id"], who=w.admin, visibility="restricted", allow_members=[membership(w.member)]
    )
    assert invited.status_code == 200, invited.content
    assert access_of(w, hall["id"])[0]["allow_members"] == [membership(w.member)]
    assert "proximity-hall" in seen_by(w.member)
    assert yard["id"] != hall["id"] != voice["id"]


def test_shared_realm_replay_binds_to_original_target_organisation(
    settings, http_signer, frozen_clock
):
    """After claiming `Org A`'s warm-pool allocation under `K1`, losing `org_owner` on `Org A`
    while owning `Org B` on the same shared realm MUST refuse `K1` replay (same or modified body)
    with `403 forbidden` and NEVER release `Org A`'s cached `workspaceUrl` / `invitationUrl`."""
    from customer_http_fixtures import configure, token as signed_token, trust_entry
    from django.db import transaction
    from django.test import Client
    from django.utils import timezone

    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership, Organisation, SlugReservation

    shared_issuer = "https://auth.kodera.test/realms/community"
    configure(settings, [trust_entry(http_signer, shared_issuer)])
    settings.KODERA_DEFAULT_COMMUNITY_ISSUER = shared_issuer
    settings.KODERA_DEFAULT_COMMUNITY_ORG_SLUG = "community"

    with transaction.atomic():
        comm = Organisation.objects.create(
            slug="community",
            realm="community",
            issuer=shared_issuer,
            name="Kodera Community",
            state="active",
            is_default_community=True,
            plan_tier="community",
        )
        SlugReservation.objects.create(
            namespace="organisation",
            slug="community",
            organisation=comm,
            state="permanent",
            protected_at=timezone.now(),
        )
        steward = User.objects.create(email="steward@community.test")
        Membership.objects.create(
            user=steward,
            organisation=comm,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )

        caller_user = User.objects.create(email="dual-owner@pme.test")
        co_owner_a = User.objects.create(email="co-owner-a@pme.test")

        org_a = Organisation.objects.create(
            slug="shared-alpha",
            realm="community",
            issuer=shared_issuer,
            name="Shared Alpha",
            state="active",
            shared_realm=True,
            plan_tier="freemium_pme",
        )
        SlugReservation.objects.create(
            namespace="organisation",
            slug="shared-alpha",
            organisation=org_a,
            state="permanent",
            protected_at=timezone.now(),
        )
        Identity.objects.create(
            user=caller_user,
            organisation=org_a,
            issuer=shared_issuer,
            realm="community",
            subject="sub-shared-replay",
            email=caller_user.email,
            enabled=True,
        )
        caller_mem_a = Membership.objects.create(
            user=caller_user,
            organisation=org_a,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        Membership.objects.create(
            user=co_owner_a,
            organisation=org_a,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )

        plan = build_instant_claim_plan(
            parse_instant_claim_request(json.dumps(PAYLOAD | {"slug": "shared-alpha"}).encode())
        )
        ws_a = Workspace.objects.create(organisation=org_a)
        cats = {
            c["key"]: Category.objects.create(
                workspace=ws_a,
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
                workspace=ws_a,
                category=cats[ch["category_key"]],
                template_key=ch["db_template_key"],
                room_state="ready",
                **vals,
            )
        WarmPoolAllocation.objects.create(
            workspace=ws_a,
            slug="shared-alpha",
            plan=plan,
            workspace_url="https://shared-alpha.example.org",
            invitation_url="https://shared-alpha.example.org/invite?signed=secret-org-a",
            offer_mode="cloud-shared",
        )

    cred = signed_token(
        http_signer,
        shared_issuer,
        "sub-shared-replay",
        email_verified=True,
        email=caller_user.email,
    )
    client = Client()
    claim_body = PAYLOAD | {"slug": "shared-alpha"}
    replay_key = "00000000-0000-4000-8000-000000009974"

    # 1. Initial claim as `org_owner` of Org A succeeds with 201.
    initial = client.post(
        PATH,
        json.dumps(claim_body),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {cred}",
        HTTP_IDEMPOTENCY_KEY=replay_key,
    )
    assert not conformance_errors(initial, "/workspaces/instant-claim", "post")
    assert initial.status_code == 201, initial.content
    assert initial.json()["workspaceId"] == str(ws_a.id)
    assert "secret-org-a" in initial.json()["invitationUrl"]

    # 2. Demote caller in Org A (`org_owner` -> `org_admin`) and grant `org_owner` on Org B!
    with transaction.atomic():
        Membership.objects.filter(pk=caller_mem_a.pk).update(role="org_admin")
        org_b = Organisation.objects.create(
            slug="shared-bravo",
            realm="community",
            issuer=shared_issuer,
            name="Shared Bravo",
            state="active",
            shared_realm=True,
            plan_tier="freemium_pme",
        )
        SlugReservation.objects.create(
            namespace="organisation",
            slug="shared-bravo",
            organisation=org_b,
            state="permanent",
            protected_at=timezone.now(),
        )
        Identity.objects.create(
            user=caller_user,
            organisation=org_b,
            issuer=shared_issuer,
            realm="community",
            subject="sub-shared-replay",
            email=caller_user.email,
            enabled=True,
        )
        Membership.objects.create(
            user=caller_user,
            organisation=org_b,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )

    # 3. Replaying `K1` (both exact body AND modified body) MUST fail closed with 403 forbidden!
    for replay_payload in (claim_body, claim_body | {"organizationName": "Tampered Bravo"}):
        denied = client.post(
            PATH,
            json.dumps(replay_payload),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {cred}",
            HTTP_IDEMPOTENCY_KEY=replay_key,
        )
        assert not conformance_errors(denied, "/workspaces/instant-claim", "post")
        assert denied.status_code == 403, denied.content
        assert denied.json()["type"] == "https://kodera.io/problems/forbidden"
        assert b"shared-alpha.example.org" not in denied.content
        assert b"secret-org-a" not in denied.content
