"""Counterexamples for the pure workspace permission intersection."""

import copy
import itertools
import unittest
from typing import Any

from services.workspace_policy.projection import evaluate

HISTORY_ACTIONS = (
    "channel.history",
    "message.search",
    "message.reply",
    "message.edit_own",
    "message.delete_own",
    "message.delete_any",
    "message.react",
    "message.pin",
    "file.read",
    "file.delete_own",
    "file.delete_any",
)
TEXT_ACTIONS = ("channel.view", "message.post", "file.upload", *HISTORY_ACTIONS)
MEDIA_ACTIONS = (
    "media.connect",
    "media.speak",
    "media.video",
    "media.share",
    "media.moderate",
)
ALL_ACTIONS = (*TEXT_ACTIONS, *MEDIA_ACTIONS)


def snapshot(**changes: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "actor_org": "org-a",
        "resource_org": "org-a",
        "member_id": "member-a",
        "active_member": True,
        "resolved": True,
        "is_dm": False,
        "authority_revision": 7,
        "projected_authority_revision": 7,
        "policy_revision": 3,
        "projected_policy_revision": 3,
        "projection_state": "ready",
        "eligible": list(ALL_ACTIONS),
        "denied": [],
        "action": "message.post",
        "kind": "text",
        "lifecycle": "active",
        "visibility": "organisation",
        "role_ids": ["role-member"],
        "allow_members": [],
        "allow_roles": [],
        "deny_members": [],
        "deny_roles": [],
        "dm_members": [],
    }
    result.update(changes)
    return result


class WorkspacePolicyProjectionTests(unittest.TestCase):
    def assert_decision(self, value: object, reason: str) -> None:
        original = copy.deepcopy(value)
        actual = evaluate(value)
        self.assertEqual(actual, {"allowed": reason == "allow", "reason": reason})
        self.assertIs(type(actual["allowed"]), bool)
        self.assertEqual(value, original, "evaluator mutated the input")

    def test_active_supported_actions_require_their_own_capability(self) -> None:
        for action in ALL_ACTIONS:
            kind = "audio" if action in MEDIA_ACTIONS else "text"
            with self.subTest(action=action):
                self.assert_decision(snapshot(action=action, kind=kind), "allow")
                self.assert_decision(snapshot(action=action, kind=kind, eligible=[]), "forbidden")
                self.assert_decision(
                    snapshot(action=action, kind=kind, denied=[action]), "forbidden"
                )

    def test_every_action_requires_view_present_and_not_denied(self) -> None:
        for action in ALL_ACTIONS:
            kind = "audio" if action in MEDIA_ACTIONS else "text"
            with self.subTest(action=action):
                self.assert_decision(
                    snapshot(
                        action=action,
                        kind=kind,
                        eligible=[name for name in ALL_ACTIONS if name != "channel.view"],
                    ),
                    "forbidden",
                )
                self.assert_decision(
                    snapshot(action=action, kind=kind, denied=["channel.view"]), "forbidden"
                )

    def test_media_publish_requires_connect_absent_and_denied(self) -> None:
        for action in ("media.speak", "media.video", "media.share"):
            for connect in ("absent", "denied"):
                with self.subTest(action=action, connect=connect):
                    eligible = ["channel.view", action]
                    denied = []
                    if connect == "denied":
                        eligible.append("media.connect")
                        denied.append("media.connect")
                    self.assert_decision(
                        snapshot(action=action, kind="audio", eligible=eligible, denied=denied),
                        "forbidden",
                    )

    def test_scoped_media_moderation_does_not_require_joining(self) -> None:
        for denied in ([], ["media.connect"]):
            with self.subTest(denied=denied):
                self.assert_decision(
                    snapshot(
                        action="media.moderate",
                        kind="audio",
                        eligible=["channel.view", "media.moderate"],
                        denied=denied,
                    ),
                    "allow",
                )

    def test_history_prerequisite_absent_or_denied_for_existing_content(self) -> None:
        for action in HISTORY_ACTIONS:
            for archived in (False, True):
                with self.subTest(action=action, archived=archived):
                    changes = {
                        "action": action,
                        "lifecycle": "archived" if archived else "active",
                    }
                    self.assert_decision(
                        snapshot(
                            **changes,
                            eligible=[name for name in ALL_ACTIONS if name != "channel.history"],
                        ),
                        "forbidden",
                    )
                    self.assert_decision(
                        snapshot(**changes, denied=["channel.history"]), "forbidden"
                    )

    def test_new_post_and_upload_do_not_grant_or_require_history(self) -> None:
        for action in ("message.post", "file.upload"):
            with self.subTest(action=action):
                self.assert_decision(
                    snapshot(
                        action=action,
                        eligible=["channel.view", action],
                        denied=["channel.history"],
                    ),
                    "allow",
                )

    def test_independent_action_grants_and_denies_do_not_become_a_rank(self) -> None:
        actions = ("message.post", "message.react", "message.pin")
        subsets = [
            [action for action, enabled in zip(actions, bits, strict=True) if enabled]
            for bits in itertools.product((False, True), repeat=len(actions))
        ]
        for grants, denies, action in itertools.product(subsets, subsets, actions):
            expected = "allow" if action in grants and action not in denies else "forbidden"
            with self.subTest(grants=grants, denies=denies, action=action):
                self.assert_decision(
                    snapshot(
                        action=action,
                        eligible=["channel.view", "channel.history", *grants],
                        denied=denies,
                    ),
                    expected,
                )

    def test_wrong_organisation_inactive_and_private_content_refuse(self) -> None:
        for changes in (
            {"actor_org": "org-b"},
            {"active_member": False},
            {"visibility": "restricted"},
            {"visibility": "restricted", "role_ids": ["org_owner"]},
            {"visibility": "restricted", "role_ids": ["org_admin"]},
            {"visibility": "restricted", "role_ids": ["staff_support"]},
        ):
            with self.subTest(changes=changes):
                self.assert_decision(snapshot(**changes), "not_found")

    def test_explicit_denies_win_over_member_and_multiple_role_grants(self) -> None:
        private = snapshot(
            visibility="restricted",
            role_ids=["role-reader", "role-writer"],
            allow_members=["member-a"],
            allow_roles=["role-writer"],
        )
        self.assert_decision(private, "allow")
        for deny in (
            {"deny_members": ["member-a"]},
            {"deny_roles": ["role-reader"]},
            {"deny_roles": ["role-writer"]},
        ):
            for visibility in ("organisation", "restricted"):
                with self.subTest(deny=deny, visibility=visibility):
                    self.assert_decision({**private, **deny, "visibility": visibility}, "not_found")
        self.assert_decision({**private, "allow_members": []}, "allow")
        self.assert_decision({**private, "allow_roles": []}, "allow")
        self.assert_decision({**private, "allow_members": [], "allow_roles": []}, "not_found")

    def test_dm_pair_membership_cannot_be_replaced_by_an_admin_or_acl_grant(self) -> None:
        dm = snapshot(is_dm=True, dm_members=["member-a", "member-b"], visibility="restricted")
        self.assert_decision(dm, "allow")
        self.assert_decision({**dm, "dm_members": ["member-b", "member-a"]}, "allow")
        self.assert_decision({**dm, "deny_members": ["member-a"]}, "not_found")
        self.assert_decision({**dm, "deny_roles": ["role-member"]}, "not_found")
        self.assert_decision({**dm, "active_member": False}, "not_found")
        self.assert_decision({**dm, "resource_org": "org-b"}, "not_found")
        self.assert_decision(
            {**dm, "dm_members": ["member-b", "member-c"], "allow_members": ["member-a"]},
            "not_found",
        )

    def test_projection_equality_not_minimum_or_maximum_revision(self) -> None:
        for field, current in (
            ("projected_authority_revision", 7),
            ("projected_policy_revision", 3),
        ):
            for revision in (current - 1, current, current + 1):
                with self.subTest(field=field, revision=revision):
                    self.assert_decision(
                        snapshot(**{field: revision}),
                        "allow" if revision == current else "projection_unavailable",
                    )
        for state in ("pending", "failed"):
            self.assert_decision(snapshot(projection_state=state), "projection_unavailable")
        self.assert_decision(snapshot(resolved=False), "unavailable")
        self.assert_decision(snapshot(actor_org="org-b", projection_state="failed"), "not_found")

    def test_archived_text_reads_survive_but_all_mutations_refuse(self) -> None:
        read_actions = {"channel.view", "channel.history", "message.search", "file.read"}
        for action in TEXT_ACTIONS:
            with self.subTest(action=action):
                self.assert_decision(
                    snapshot(action=action, lifecycle="archived"),
                    "allow" if action in read_actions else "archived",
                )
        for action in ("channel.view", *MEDIA_ACTIONS):
            with self.subTest(audio_action=action):
                self.assert_decision(
                    snapshot(action=action, kind="audio", lifecycle="archived"), "archived"
                )

    def test_channel_kind_and_nonactive_lifecycle(self) -> None:
        for action in MEDIA_ACTIONS:
            self.assert_decision(snapshot(action=action), "forbidden")
        for action in TEXT_ACTIONS:
            if action != "channel.view":
                self.assert_decision(snapshot(action=action, kind="audio"), "forbidden")
        for lifecycle in ("provisioning", "deletion_pending", "deleted"):
            self.assert_decision(snapshot(lifecycle=lifecycle), "unavailable")

    def test_malformed_input_has_no_permissive_defaults(self) -> None:
        for value in (None, True, 1, "snapshot", [], (), object()):
            # object() does not compare equal to its deepcopy, so check only the verdict here.
            with self.subTest(top_level=type(value).__name__):
                self.assertEqual(evaluate(value), {"allowed": False, "reason": "unavailable"})
        self.assert_decision(snapshot(extra="ignored"), "unavailable")
        for field in snapshot():
            missing = snapshot()
            del missing[field]
            with self.subTest(missing=field):
                self.assert_decision(missing, "unavailable")
            with self.subTest(null=field):
                self.assert_decision(snapshot(**{field: None}), "unavailable")
        for field in ("active_member", "resolved", "is_dm"):
            for value in (0, 1, "true", [], {}):
                with self.subTest(field=field, value=value):
                    self.assert_decision(snapshot(**{field: value}), "unavailable")
        for field in (
            "authority_revision",
            "projected_authority_revision",
            "policy_revision",
            "projected_policy_revision",
        ):
            for value in (True, False, 0, -1, 1.0, "7"):
                with self.subTest(field=field, value=value):
                    self.assert_decision(snapshot(**{field: value}), "unavailable")
        for field in (
            "actor_org",
            "resource_org",
            "member_id",
            "action",
            "kind",
            "lifecycle",
            "visibility",
            "projection_state",
        ):
            for value in ("", " ", 1, True, [], {}):
                with self.subTest(field=field, value=value):
                    self.assert_decision(snapshot(**{field: value}), "unavailable")
        for field in ("action", "kind", "lifecycle", "visibility", "projection_state"):
            self.assert_decision(snapshot(**{field: "unknown"}), "unavailable")

    def test_malformed_lists_capabilities_and_dm_shapes(self) -> None:
        for field in (
            "eligible",
            "denied",
            "role_ids",
            "allow_members",
            "allow_roles",
            "deny_members",
            "deny_roles",
            "dm_members",
        ):
            malformed: tuple[object, ...] = (
                "role",
                ("role",),
                {},
                [1],
                [True],
                [None],
                [""],
                [" "],
                ["x", "x"],
            )
            for value in malformed:
                with self.subTest(field=field, value=value):
                    self.assert_decision(snapshot(**{field: value}), "unavailable")
        for field in ("eligible", "denied"):
            self.assert_decision(snapshot(**{field: ["root.all"]}), "unavailable")
        for members in ([], ["member-a"], ["member-a", "member-b", "member-c"]):
            self.assert_decision(snapshot(is_dm=True, dm_members=members), "unavailable")
        self.assert_decision(snapshot(dm_members=["member-a", "member-b"]), "unavailable")
        self.assert_decision(
            snapshot(is_dm=True, kind="audio", dm_members=["member-a", "member-b"]),
            "unavailable",
        )

    def test_repeated_calls_and_return_mutation_do_not_change_later_decisions(self) -> None:
        value = snapshot()
        first = evaluate(value)
        first["allowed"] = False
        self.assert_decision(value, "allow")
        self.assert_decision(value, "allow")
