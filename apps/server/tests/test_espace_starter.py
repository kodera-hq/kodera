"""The starter template's version 2, room state in getWorkspace, and the application code
`messaging`: docs/specs/ESPACE_STRUCTURE.md §§5, 8, ES-09, ES-11 and ES-12.

Real signed tokens, the real HTTP views and the disposable PostgreSQL test database, as
tests/test_espace_structure.py; every response is checked against the contract by `call`.
"""

import pytest
from order_fixtures import commit_order
from test_access_tokens import frozen_clock as frozen_clock
from test_espace_structure import READ, create_channel, send
from test_workspace_onboarding import http_signer as http_signer, initialise, model, w as w

from apps.billing import catalogue

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def e(w):
    commit_order(w.alpha.id, w.alpha.issuer, "alpha-owner")
    assert initialise(w, w.owner).status_code == 201
    return w


def test_es09_initialise_creates_the_lounge_and_records_template_version_2(e):
    lounge = model("workspaces", "Channel").objects.get(template_key="lounge")
    assert (
        lounge.kind,
        lounge.name,
        lounge.category.template_key,
        lounge.position,
        lounge.policy_mode,
        lounge.lifecycle,
        lounge.topic,
    ) == ("audio", "lounge", "team", 0, "inherit", "active", ""), "ES-09: the lounge is wrong"
    event = model("audit", "AuditEvent").objects.get(action="workspace.initialised")
    assert event.metadata["template_version"] == 2, "ES-09: the template version is not 2"
    body = send(e, e.member, "get", READ).json()
    team = next(c for c in body["categories"] if c["template_key"] == "team")
    assert [c["template_key"] for c in team["channels"]] == ["lounge"], "ES-09: members miss it"


def test_es12_get_workspace_returns_each_channels_room_state(e):
    create_channel(e, None, "salon", kind="audio")
    body = send(e, e.member, "get", READ).json()
    channels = list(body["uncategorised_channels"])
    for category in body["categories"]:
        channels += category["channels"]
    assert channels and {c["room_state"] for c in channels} == {"pending"}, (
        "ES-12: getWorkspace does not say every channel's room is pending"
    )


def test_es11_the_catalogue_accepts_messaging_and_refuses_tchap():
    assert "messaging" in catalogue.APP_CODES and "tchap" not in catalogue.APP_CODES
    document = catalogue.read(catalogue.PLACEHOLDER)
    for code, accepted in (("messaging", True), ("tchap", False)):
        first, *rest = document["packs"]
        changed = {**document, "packs": [{**first, "apps": ["visio", code]}, *rest]}
        if accepted:
            assert catalogue.load(changed, allow_placeholder=True).created
        else:
            with pytest.raises(catalogue.CatalogueError, match="names its applications"):
                catalogue.load(changed, allow_placeholder=True)
