"""The default community's layout: docs/specs/DEFAULT_COMMUNITY.md, "The layout".

Two rules.

- **Rooms are named for what they are for.** Every word of every category and channel the layout
  provisions is a purpose word of the reviewed vocabulary below, or Kodera's own name. No
  organisation outside Kodera is named in the product: a partner's room is granted to the partner,
  never named after them. The check is an allow-list, so it refuses a name nobody thought of.
- **A re-run renames in place.** A community bootstrapped from an earlier layout keeps every room:
  the bootstrap renames the earlier room onto the layout's present name, same row and so same
  Matrix room and history, creates nothing beside it, deletes nothing, and finds nothing to do the
  next time.

The earlier layout is built here with stand-in names (`partner-alpha`, `partner-beta`): the
reconciliation recognises an earlier room by what it is (a templated channel of that category
whose key the layout no longer names), never by what it was called, so a stand-in takes the very
path a real earlier name takes.

The last tests are the refusal proofs, wired as tests/test_trusted_edge.py wires its own: one
source anchor replaced, the mutant executed, and the check that owns the rule required to fail by
name.
"""

import inspect
import re
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest
from django.db import transaction
from test_default_community import community as community, signup

from apps.engine_intents.models import EngineChannelSet
from apps.orgs.community import bootstrap_community_workspace
from apps.workspaces import community as layout
from apps.workspaces.channel_access import resolve
from apps.workspaces.channel_sets import channel_set_input
from apps.workspaces.models import Category, Channel, ResourcePolicyRule, Workspace

pytestmark = pytest.mark.django_db(transaction=True)

ROOT = Path(__file__).resolve().parents[1]
# Every word the default layout may use. Adding a room means adding its words here, in review.
VOCABULARY = frozenset(
    """
    announcements general developers community support extensions self hosting show and tell
    office hours core dev strategy ops oncall git tracker design partner partners onboarding
    feedback kodera
    """.split()
)
PARTNER_ROOMS = ("partner-onboarding", "partner-feedback")
# Stand-ins for the names an earlier layout gave the two partner rooms.
EARLIER = (("partner-alpha", "partner_alpha"), ("partner-beta", "partner_beta"))


def words(text):
    return [word for word in re.split(r"[^a-z0-9]+", text.lower()) if word]


def naming_violations(texts):
    """Why a provisioned name is not purpose-based, one sentence per offending word; or []."""
    return [
        f"the default community layout names {text!r}: {word!r} is not a purpose word, and no "
        "organisation outside Kodera is named in the product"
        for text in texts
        for word in words(text)
        if word not in VOCABULARY
    ]


def layout_texts(categories):
    """Every key and name the layout declares."""
    return [text for key, name, channels in categories for text in (key, name, *channels)]


def provisioned_texts(workspace_id):
    """Every key, name and topic the bootstrap actually stored, and what the engines are sent."""
    texts = []
    for name, key in Category.objects.filter(workspace_id=workspace_id).values_list(
        "name", "template_key"
    ):
        texts += [name, key or ""]
    for name, key, topic in Channel.objects.filter(workspace_id=workspace_id).values_list(
        "name", "template_key", "topic"
    ):
        texts += [name, key or "", topic]
    with transaction.atomic():
        _, channels = channel_set_input(workspace_id)
    return texts + [channel["name"] for channel in channels]


def partner_rooms(w):
    return list(
        Channel.objects.filter(workspace=w.workspace, category__template_key="design_partners")
        .order_by("position", "id")
        .values("id", "name", "template_key", "position", "version", "kind", "lifecycle")
    )


# --- rooms are named for what they are for -------------------------------------------------------


def check_layout_is_purpose_named(module):
    found = naming_violations(layout_texts(module.CATEGORIES))
    assert found == [], found[0]


def test_the_declared_layout_names_only_purposes():
    check_layout_is_purpose_named(layout)
    partners = next(c for c in layout.CATEGORIES if c[0] == "design_partners")
    assert partners == ("design_partners", "Design Partners", PARTNER_ROOMS)


def test_a_fresh_bootstrap_provisions_the_purpose_names_and_nothing_else(community):
    assert [room["name"] for room in partner_rooms(community)] == list(PARTNER_ROOMS)
    assert [room["template_key"] for room in partner_rooms(community)] == [
        "partner_onboarding",
        "partner_feedback",
    ]
    assert naming_violations(provisioned_texts(community.workspace.id)) == []
    assert Category.objects.get(template_key="design_partners").name == "Design Partners"
    assert Channel.objects.filter(workspace=community.workspace).count() == 14
    for room in partner_rooms(community):
        access = resolve(room["id"])
        assert access.visibility == "restricted" and access.allow_members == ()


def test_the_vocabulary_check_refuses_a_name_nobody_listed():
    assert naming_violations(["partner-onboarding", "Design Partners"]) == []
    for text in ("partner-examplecorp", "Example Corp Partners", "partner_examplecorp"):
        found = naming_violations([text])
        assert found and "not a purpose word" in found[0] and "example" in " ".join(found)


# --- a re-run renames in place -------------------------------------------------------------------


def as_bootstrapped_from_the_earlier_layout(w):
    """Turn the community into one an earlier layout bootstrapped: its two partner rooms carry
    their earlier names and keys, their Matrix rooms exist and have applied their access, and a
    partner has been granted the category."""
    rooms = partner_rooms(w)
    for room, (name, key) in zip(rooms, EARLIER, strict=True):
        Channel.objects.filter(id=room["id"]).update(
            name=name,
            template_key=key,
            room_state="ready",
            applied_access_etag="applied-" + key,
            room_state_revision=7,
            topic="Kept as it is",
        )
    _, partner = signup("a-partner")
    category = Category.objects.get(workspace=w.workspace, template_key="design_partners")
    ResourcePolicyRule.objects.create(
        policy=category.default_policy, kind="allow_member", membership_id=partner.id
    )
    # A room an administrator added, and so theirs: no template key.
    own = Channel.objects.create(
        workspace=w.workspace,
        category=category,
        name="partner-alpha-notes",
        kind="text",
        position=2,
        lifecycle="active",
    )
    return SimpleNamespace(
        ids=[room["id"] for room in rooms],
        versions=[room["version"] for room in rooms],
        partner=partner,
        own=own,
        revision=Workspace.objects.get(id=w.workspace.id).structure_revision,
        sets=EngineChannelSet.objects.filter(organisation_id=w.organisation.id).count(),
    )


def stored(ids):
    rows = Channel.objects.in_bulk(ids)
    return [rows[channel_id] for channel_id in ids]


def check_a_rerun_renames_the_earlier_rooms_in_place(w):
    before = as_bootstrapped_from_the_earlier_layout(w)
    assert bootstrap_community_workspace().id == w.workspace.id
    names = [room["name"] for room in partner_rooms(w)]
    earlier = [name for name, _ in EARLIER]
    assert not set(names) & set(earlier), (
        f"a re-run left a room of the earlier layout under its earlier name: {names}"
    )
    assert names == [*PARTNER_ROOMS, "partner-alpha-notes"], (
        f"a re-run left the earlier rooms beside new ones, or lost one: {names}"
    )
    renamed = stored(before.ids)
    assert [room.name for room in renamed] == list(PARTNER_ROOMS), (
        "a re-run replaced a room instead of renaming it: the earlier rows do not carry the "
        "layout's names"
    )
    assert [room.template_key for room in renamed] == ["partner_onboarding", "partner_feedback"]
    return before, renamed


def test_a_rerun_on_the_earlier_layout_renames_each_room_in_place(community):
    before, renamed = check_a_rerun_renames_the_earlier_rooms_in_place(community)
    # The same rows, so the same Matrix rooms and their history: nothing but the name moved.
    for room, version, (_, key) in zip(renamed, before.versions, EARLIER, strict=True):
        assert room.version == version + 1
        assert (room.room_state, room.applied_access_etag, room.room_state_revision) == (
            "ready",
            "applied-" + key,
            7,
        )
        assert (room.topic, room.kind, room.lifecycle) == ("Kept as it is", "text", "active")
        assert room.policy_mode == "inherit" and room.explicit_policy_id is None
        # The partner's grant on the category still reaches the renamed room.
        assert resolve(room.id).allow_members == (before.partner.id,)
    assert [room.position for room in renamed] == [0, 1]
    # Nothing created, nothing deleted: the fourteen canonical rooms and the administrator's own.
    assert Channel.objects.filter(workspace=community.workspace).count() == 15
    own = Channel.objects.get(id=before.own.id)
    assert (own.name, own.template_key, own.version) == ("partner-alpha-notes", None, 1)
    assert naming_violations(layout_texts(layout.CATEGORIES)) == []
    # A structural change, announced to the engines for the same channel ids.
    assert (
        Workspace.objects.get(id=community.workspace.id).structure_revision == before.revision + 1
    )
    latest = EngineChannelSet.objects.filter(organisation_id=community.organisation.id).order_by(
        "-revision"
    )
    assert latest.count() == before.sets + 1
    sent = {channel["channel_id"]: channel["name"] for channel in latest[0].channels}
    assert [sent[str(channel_id)] for channel_id in before.ids] == list(PARTNER_ROOMS)


def test_the_next_rerun_finds_nothing_to_rename(community):
    before, renamed = check_a_rerun_renames_the_earlier_rooms_in_place(community)
    revision = Workspace.objects.get(id=community.workspace.id).structure_revision
    for _ in range(2):
        assert bootstrap_community_workspace().id == community.workspace.id
    again = stored(before.ids)
    assert [(room.name, room.version) for room in again] == [
        (room.name, room.version) for room in renamed
    ]
    assert Workspace.objects.get(id=community.workspace.id).structure_revision == revision
    assert Channel.objects.filter(workspace=community.workspace).count() == 15


def test_a_rerun_on_the_present_layout_renames_nothing(community):
    rooms = partner_rooms(community)
    revision = Workspace.objects.get(id=community.workspace.id).structure_revision
    assert bootstrap_community_workspace().id == community.workspace.id
    assert partner_rooms(community) == rooms
    assert Workspace.objects.get(id=community.workspace.id).structure_revision == revision


def check_one_earlier_room_takes_the_name_left(w):
    """Half-migrated: one room already carries its present name, the other its earlier one. The
    earlier room takes the one name that is left; nothing collides and nothing is created."""
    first, second = partner_rooms(w)
    Channel.objects.filter(id=second["id"]).update(name=EARLIER[1][0], template_key=EARLIER[1][1])
    assert bootstrap_community_workspace().id == w.workspace.id
    rooms = partner_rooms(w)
    assert [(room["id"], room["name"]) for room in rooms] == [
        (first["id"], PARTNER_ROOMS[0]),
        (second["id"], PARTNER_ROOMS[1]),
    ], f"a half-migrated community was not completed in place: {rooms}"
    assert rooms[0]["version"] == first["version"], "a room already renamed was touched again"


def test_a_half_migrated_community_is_completed_in_place(community):
    check_one_earlier_room_takes_the_name_left(community)
    assert Channel.objects.filter(workspace=community.workspace).count() == 14


def test_a_room_an_administrator_renamed_is_theirs_and_stays(community):
    """An administrator who renamed an earlier room took it out of the template (no key). It is
    left alone; the one earlier room still templated takes the first name the layout lacks, and
    the other name is created at the end of the category rather than on an occupied place."""
    first, second = partner_rooms(community)
    Channel.objects.filter(id=first["id"]).update(name="accueil-partenaires", template_key=None)
    Channel.objects.filter(id=second["id"]).update(name=EARLIER[1][0], template_key=EARLIER[1][1])
    assert bootstrap_community_workspace().id == community.workspace.id
    rooms = {room["name"]: room for room in partner_rooms(community)}
    assert set(rooms) == {"accueil-partenaires", *PARTNER_ROOMS}
    assert rooms["accueil-partenaires"]["id"] == first["id"]
    assert rooms["accueil-partenaires"]["template_key"] is None
    assert rooms[PARTNER_ROOMS[0]]["id"] == second["id"]
    assert rooms[PARTNER_ROOMS[1]]["position"] == 2
    assert bootstrap_community_workspace().id == community.workspace.id
    assert len(partner_rooms(community)) == 3


def test_an_archived_earlier_room_is_drift_and_nothing_is_changed(community):
    """As for any canonical room: the bootstrap refuses rather than create a second room beside
    an archived one, and its transaction leaves the earlier name as it was for the operator."""
    as_bootstrapped_from_the_earlier_layout(community)
    first = partner_rooms(community)[0]
    Channel.objects.filter(id=first["id"]).update(lifecycle="archived")
    with pytest.raises(ValueError, match="channel drift"):
        bootstrap_community_workspace()
    assert [room["name"] for room in partner_rooms(community)][:2] == [n for n, _ in EARLIER]
    assert Channel.objects.filter(workspace=community.workspace).count() == 15


def test_no_other_category_is_reconciled_this_way(community):
    """Only the category whose rooms were renamed: a templated room of another canonical category
    that the layout does not name is left for the operator, never guessed at."""
    core = Category.objects.get(workspace=community.workspace, template_key="core_kodera")
    stray = Channel.objects.create(
        workspace=community.workspace,
        category=core,
        name="earlier-room",
        template_key="earlier_room",
        kind="text",
        position=9,
        lifecycle="active",
    )
    assert bootstrap_community_workspace().id == community.workspace.id
    stray.refresh_from_db()
    assert (stray.name, stray.template_key, stray.version) == ("earlier-room", "earlier_room", 1)


# --- the refusal proofs --------------------------------------------------------------------------

# One anchor of apps/workspaces/community.py replaced: an organisation's name back in the layout.
LAYOUT_ANCHOR = '("partner-onboarding", "partner-feedback")'
LAYOUT_MUTANTS = {
    "a partner room named after an organisation": '("partner-examplecorp", "partner-feedback")',
    "the other partner room named after an organisation": '("partner-onboarding", "partner-example-labs")',
    "both rooms named after organisations again": '("partner-examplecorp", "partner-example-labs")',
}


def layout_mutant(after):
    source = (ROOT / "apps/workspaces/community.py").read_text()
    assert source.count(LAYOUT_ANCHOR) == 1, "mutation anchor moved"
    namespace: dict[str, object] = {
        "__name__": "apps.workspaces.community",
        "__package__": "apps.workspaces",
    }
    exec(compile(source.replace(LAYOUT_ANCHOR, after), "<layout-mutant>", "exec"), namespace)  # noqa: S102 - owned source mutation only
    return SimpleNamespace(**namespace)


@pytest.mark.parametrize("name", sorted(LAYOUT_MUTANTS))
def test_refusal_an_organisation_name_back_in_the_layout_fails_by_name(name):
    check_layout_is_purpose_named(layout)  # holds on the real layout
    with pytest.raises(AssertionError) as caught:
        check_layout_is_purpose_named(layout_mutant(LAYOUT_MUTANTS[name]))
    message = str(caught.value)
    assert "no organisation outside Kodera is named in the product" in message
    assert "example" in message, "the refusal names the word that is not a purpose"


# One anchor of one function replaced: the reconciliation taken away or made unsafe.
RECONCILIATION_MUTANTS = {
    "the earlier rooms are no longer renamed": (
        layout.provision_community_workspace,
        "if key in RENAMED_SINCE_AN_EARLIER_LAYOUT and _rename_earlier_layout(",
        "if False and _rename_earlier_layout(",
        check_a_rerun_renames_the_earlier_rooms_in_place,
        "left a room of the earlier layout under its earlier name",
    ),
    "an earlier room is renamed onto a name already taken": (
        layout._rename_earlier_layout,
        "missing = [name for name in channels if _template_key(name) not in existing]",
        "missing = list(channels)",
        check_one_earlier_room_takes_the_name_left,
        None,  # refused by the database: one template key, one room
    ),
    "the earlier rooms are deleted and created anew": (
        layout._rename_earlier_layout,
        "renamed += Channel.objects.filter(id=channel.id).update(\n"
        "            name=name,\n"
        "            template_key=_template_key(name),\n"
        '            version=F("version") + 1,\n'
        "            updated_at=timezone.now(),\n"
        "        )",
        "renamed += Channel.objects.filter(id=channel.id).update(\n"
        '            lifecycle="deleted", template_key=None, updated_at=timezone.now()\n'
        "        )",
        check_a_rerun_renames_the_earlier_rooms_in_place,
        "under its earlier name|beside new ones, or lost one|replaced a room instead of renaming",
    ),
}


def reconciliation_mutant(monkeypatch, name):
    function, before, after, _, _ = RECONCILIATION_MUTANTS[name]
    source = textwrap.dedent(inspect.getsource(function))
    assert source.count(before) == 1, f"mutation anchor moved: {before!r}"
    namespace = dict(function.__globals__)
    exec(compile(source.replace(before, after), f"<mutant: {name}>", "exec"), namespace)  # noqa: S102 - owned source mutation only
    monkeypatch.setattr(layout, function.__name__, namespace[function.__name__])
    # The bootstrap imported the provisioner by name when it loaded.
    monkeypatch.setattr(
        "apps.orgs.community.provision_community_workspace", layout.provision_community_workspace
    )


def test_refusal_control_the_rerun_checks_pass_on_the_unmutated_bootstrap(community):
    check_a_rerun_renames_the_earlier_rooms_in_place(community)


@pytest.mark.parametrize("name", sorted(RECONCILIATION_MUTANTS))
def test_refusal_each_unsafe_reconciliation_fails_the_check_that_owns_it(
    community, monkeypatch, name
):
    _, _, _, check, message = RECONCILIATION_MUTANTS[name]
    reconciliation_mutant(monkeypatch, name)
    if message is None:
        from django.db import IntegrityError

        with pytest.raises(IntegrityError):
            check(community)
    else:
        with pytest.raises(AssertionError, match=message):
            check(community)
