"""Prove the tests can fail: each mutation of the policy must be caught by its named test.

Run: python3 tests/mutate.py   (exit 0 only when every mutant is killed by the expected test)
"""

import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src" / "kodera_synapse_policy" / "__init__.py"

# (description, original text, mutated text, test that must fail)
MUTANTS = [
    ("DM account eligibility ignored at creation", '        if not await self._active_dm_users(user_id, *room_config["invite"]):\n            return Codes.FORBIDDEN\n', "", "test_dm_creation_and_invites_require_active_registered_local_accounts"),
    ("DM account eligibility ignored at invitation", 'or not await self._active_dm_users(inviter, invitee)', "", "test_dm_creation_and_invites_require_active_registered_local_accounts"),
    ("group DMs refused", "len(invite) <= MAX_DM_INVITEES", "len(invite) <= 1", "test_member_creates_bounded_private_group_direct_messages"),
    ("unsafe trusted preset accepted", 'config.get("preset") == "private_chat"', 'config.get("preset") in {"private_chat", "trusted_private_chat"}', "test_member_cannot_create_anything_but_a_direct_message"),
    ("group DM immutable invite list ignored", "and invitee in invitees", "", "test_group_dm_invites_are_bound_to_immutable_creation_state"),
    ("unvalidated group DM marker trusted", 'and self._is_direct_message(inviter, {\n                    "is_direct": True, "invite": list(invitees) if isinstance(invitees, (list, tuple)) else invitees,\n                    "preset": "private_chat", "visibility": "private"\n                })', "", "test_malformed_group_dm_creation_state_fails_closed"),
    ("workspace ban native join open", "if user in content.get('banned', ()):", "if False:", "test_workspace_ban_refuses_native_public_join_and_post"),
    ("workspace mute posting open", "if event.type in {'m.room.message', 'm.sticker'} and _active_mute(content, event.sender):", "if False:", "test_workspace_mute_uses_server_time_even_for_exempt_member"),
    ("archived native join open", 'if content.get("archived", False) is not False:', 'if False:', "test_archived_public_room_refuses_rejoin_and_post_but_allows_leave"),
    ("archived event posting open", 'if content.get("archived") is True:', 'if False:', "test_archived_public_room_refuses_rejoin_and_post_but_allows_leave"),
    ("public native remote join open", 'if not self._api.is_mine(user) and not self._partner_federation_allowed(state, user):', 'if False:', "test_public_local_only_room_refuses_remote_native_join"),
    ("public federated member event open", 'if not _is_valid_user_id(target) or not self._api.is_mine(target):', 'if False:', "test_agent_event_bypass_never_admits_remote_membership_to_internal_room"),
    ("malformed local-only flag open", 'if type(content.get("local_only", False)) is not bool:', 'if False:', "test_public_local_only_flag_must_be_boolean"),
    ("agent may not create", "if user_id == self._agent:\n            return NOT_SPAM", "if False:\n            return NOT_SPAM", "test_agent_creates_any_room"),
    ("any is_direct accepted", 'config.get("is_direct") is not True', "False", "test_member_cannot_create_anything_but_a_direct_message"),
    ("unbounded invite fanout", "len(invite) <= MAX_DM_INVITEES", "len(invite)", "test_member_cannot_create_anything_but_a_direct_message"),
    ("remote invitee accepted", "and self._api.is_mine(invitee)\n", "\n", "test_member_cannot_create_anything_but_a_direct_message"),
    ("initial state accepted", "and not config.get(\"initial_state\")", "", "test_member_cannot_create_anything_but_a_direct_message"),
    ("spaces accepted", 'and creation.get("type") is None', "", "test_member_cannot_create_anything_but_a_direct_message"),
    ("second invite accepted", "or others or", "or", "test_member_cannot_invite_otherwise"),
    ("other's room accepted", "create.sender != inviter or", "", "test_member_cannot_invite_otherwise"),
    ("e-mail invites open", "return NOT_SPAM if inviter == self._agent else Codes.FORBIDDEN", "return NOT_SPAM", "test_member_cannot_invite_by_email_or_phone"),
    ("agent e-mail invites refused", "return NOT_SPAM if inviter == self._agent else Codes.FORBIDDEN", "return Codes.FORBIDDEN", "test_agent_may_invite_by_email"),
    ("aliases open to members", "return NOT_SPAM if user_id == self._agent else Codes.FORBIDDEN", "return NOT_SPAM", "test_member_cannot_create_a_room_alias"),
    ("directory open", "async def user_may_publish_room(self, user_id: str, room_id: str) -> Any:\n        return Codes.FORBIDDEN", "async def user_may_publish_room(self, user_id: str, room_id: str) -> Any:\n        return NOT_SPAM", "test_nobody_publishes_to_the_directory"),
    ("agent may encrypt", "if event.type in ENCRYPTION:\n            return Codes.FORBIDDEN", "if event.type in ENCRYPTION and event.sender != self._agent:\n            return Codes.FORBIDDEN", "test_nobody_turns_on_encryption"),
    ("federated ciphertext open", "if event.type in ENCRYPTION:\n            return Codes.FORBIDDEN", "if event.type in ENCRYPTION and event.is_state():\n            return Codes.FORBIDDEN", "test_no_federated_event_carries_ciphertext"),
    ("spam check ignores encryption", "if event.type in ENCRYPTION:\n            return Codes.FORBIDDEN", "if False:\n            return Codes.FORBIDDEN", "test_no_federated_event_carries_ciphertext"),
    ("agent creates encrypted rooms", "if room_config is not None and _asks_for_encryption(room_config):", "if False:", "test_nobody_creates_an_encrypted_room"),
    ("any initial state is encryption", 'state.get("type") == "m.room.encryption"', 'state.get("type") is not None', "test_agent_creates_a_room_with_other_initial_state"),
    ("rules allow encryption", 'return event.type not in ENCRYPTION and self._governance_allows(event, state_events), None', "return True, None", "test_no_event_turns_on_encryption"),
    ("rules allow turning encryption on", 'frozenset({"m.room.encryption", "m.room.encrypted"})', 'frozenset({"m.room.encrypted"})', "test_no_event_turns_on_encryption"),
    ("rules allow ciphertext", 'frozenset({"m.room.encryption", "m.room.encrypted"})', 'frozenset({"m.room.encryption"})', "test_no_event_carries_ciphertext"),
    ("rules refuse everything", 'return event.type not in ENCRYPTION and self._governance_allows(event, state_events), None', "return False, None", "test_rules_allow_every_other_event"),
    ("join rule open", 'content.get("join_rule") != "invite"', "False", "test_member_cannot_open_a_room"),
    ("world readable open", '== "world_readable"', '== "never"', "test_member_cannot_open_a_room"),
    ("aliases open", "event.type in LOCKED_STATE\n            or", "", "test_member_cannot_open_a_room"),
    ("agent locked out", "if event.sender == self._agent:\n            return NOT_SPAM\n        if event.type == OCCUPANCY", "if event.type == OCCUPANCY", "test_ordinary_events_pass"),
    ("policy open to members", '        "io.kodera.room.policy",\n', "", "test_only_the_agent_sets_a_rooms_policy"),
    ("occupancy open to members", "return NOT_SPAM if event.sender == self._room_access else Codes.FORBIDDEN", "return NOT_SPAM", "test_only_room_access_and_the_agent_write_occupancy"),
    ("room-access locked out of occupancy", "return NOT_SPAM if event.sender == self._room_access else Codes.FORBIDDEN", "return Codes.FORBIDDEN", "test_only_room_access_and_the_agent_write_occupancy"),
    ("room-access id unchecked", 'room_access is not None and (\n            not isinstance(room_access, str) or not room_access.startswith("@") or ":" not in room_access\n        )', "False", "test_refuses_a_malformed_room_access_id"),
    ("call member state open to members", '        "m.call.member",\n', "", "test_member_cannot_spoof_call_membership"),
    ("service accounts receive DM at creation", "and invitee not in {self._agent, self._room_access}", "", "test_service_accounts_never_participate_in_direct_messages"),
    ("service accounts invite or are invited into DM", "        if inviter == self._room_access or invitee in {self._agent, self._room_access}:\n            return Codes.FORBIDDEN\n", "", "test_service_accounts_never_participate_in_direct_messages"),
    ("malformed invitee accepted", "        if not _is_valid_user_id(invitee):\n            return Codes.FORBIDDEN\n", "", "test_service_accounts_and_malformed_ids_refused_in_channel_invites"),
    ("channel member invites ignored", 'policy_content.get("allow_member_invites") is True', "False", "test_joined_member_invites_local_user_into_policy_authorized_channel"),
    ("channel member invites open without policy", 'policy_content.get("allow_member_invites") is True', "True", "test_channel_without_allow_member_invites_refuses_member_invites"),
    ("non-joined member invites into channel", '_membership_of(state.get(("m.room.member", inviter))) != "join"', "False", "test_non_joined_member_cannot_invite_into_policy_authorized_channel"),
    ("federated channel invites refused when allowed", 'or policy_content.get("allow_federated_invites") is True', "", "test_joined_member_invites_federated_user_when_federated_invites_allowed"),
    ("federated channel invites open without federated policy", 'if not self._api.is_mine(invitee) and not self._partner_federation_allowed(state, invitee):', "if False:", "test_agent_cannot_invite_remote_users_into_internal_rooms"),
    ("announcement posting open", 'if content["read_only"] and (', 'if False and (', "test_announcement_member_cannot_post_or_edit_even_with_permissive_levels"),
    ("private membership open", 'if target not in content["members"]:', 'if False:', "test_private_room_refuses_unlisted_membership_even_with_invitation"),
    ("private invites open", 'if policy_content.get("audience") == "listed" and (', 'if False and (', "test_private_room_cannot_be_opened_through_member_invite_policy"),
    ("untrusted policy author accepted", 'if getattr(policy_event, "sender", None) != self._agent:', 'if False:', "test_untrusted_governance_author_fails_closed"),
    ("malformed governance open", 'if not self._governance_valid(policy_event):\n            return False', 'if not self._governance_valid(policy_event):\n            return True', "test_malformed_governance_fails_closed"),
    ("private join callback open", 'if content["audience"] == "listed" and user not in content["members"]:', 'if False:', "test_private_room_cannot_be_opened_through_member_invite_policy"),
    ("frozen policy ignored", 'return isinstance(content, Mapping) and any(', 'return isinstance(content, dict) and any(', "test_frozen_synapse_event_content_enforces_governance"),
    ('agent remote invitation bypass', 'if inviter == self._agent and self._api.is_mine(invitee):', 'if inviter == self._agent:', 'test_agent_cannot_invite_remote_users_into_internal_rooms'),
    ('agent governance bypass before federation boundary', '        if not self._federation_boundary_allows(event, state):\n            return False', '        if event.sender != self._agent and not self._federation_boundary_allows(event, state):\n            return False', 'test_agent_event_bypass_never_admits_remote_membership_to_internal_room'),
    ('stale remote timeline sender admitted', '        if not self._api.is_mine(event.sender):', '        if False:', 'test_previously_joined_remote_sender_cannot_post_inside_internal_room'),
    ('partner global allowlist ignored', 'or not set(servers) <= self._federation_servers', '', 'test_partner_author_creation_acl_and_global_boundaries_are_independent'),
    ('partner immutable creation ignored', '            and creation_mode(getattr(create, "content", None)) == "partner"', '', 'test_partner_author_creation_acl_and_global_boundaries_are_independent'),
    ('partner ACL ignored', '            and acl_matches(getattr(state.get(("m.room.server_acl", "")), "content", None), expected)', '', 'test_partner_author_creation_acl_and_global_boundaries_are_independent'),
    ('partner trusted creator ignored', '            and getattr(create, "sender", None) == self._agent', '', 'test_partner_author_creation_acl_and_global_boundaries_are_independent'),
    ('partner audience widened', '            and content.get("audience") == "all"', '', 'test_partner_policy_field_mutations_fail_closed'),
    ('partner announcement widened', '            and content.get("read_only") is False', '', 'test_partner_policy_field_mutations_fail_closed'),
    ('creation default federation open', 'creation = dict(creation, **{"m.federate": partner, MODE: "partner" if partner else "internal"})', 'creation = dict(creation, **{"m.federate": True, MODE: "partner" if partner else "internal"})', 'test_creation_defaults_to_immutable_internal_mode_and_local_acl'),
    ('partner creation trusted agent ignored', 'if creator != self._agent or not partners or creation.get("m.federate") is not True', 'if not partners or creation.get("m.federate") is not True', 'test_partner_creation_refusals_have_expected_diagnostic'),
    ('partner creation ACL widened', 'if len(acls) > 1 or (acls and acls[0].get("content") != expected):', 'if False:', 'test_partner_creation_refusals_have_expected_diagnostic'),
    ('immutable federation policy upgrade allowed', 'if creation_mode(creation) != "partner" or self._partner_content(event.content, allow_archived=True) is None:', 'if self._partner_content(event.content, allow_archived=True) is None:', 'test_internal_mode_cannot_be_upgraded_by_valid_mutable_partner_policy'),
    ('agent server ACL boundary widened', 'if not acl_matches(event.content, acl(self._server, partners or ())):', 'if False:', 'test_agent_acl_write_cannot_widen_exact_partner_boundary'),
('partner join rule widened by agent', 'if creation_mode(creation) == "partner" and event.type == "m.room.join_rules" and event.content.get(\'join_rule\') != "invite":', 'if False:', 'test_partner_join_rule_is_invite_only_even_for_agent'),
    ('initial ACL bootstrap untrusted creator admitted', 'if event.sender != self._agent or getattr(create, "sender", None) != self._agent or not partners or self._server in partners or not set(partners) <= self._federation_servers:', 'if not partners:', 'test_initial_acl_bootstrap_uses_trusted_immutable_servers_without_remote_admission'),
    ('initial approved servers not bound immutably', 'creation["io.kodera.room.initial_partner_servers"] = list(partners)', 'creation["io.kodera.room.initial_partner_servers"] = []', 'test_explicit_partner_creation_has_pinned_mode_policy_and_server_acl'),
    ('raw DM validation skipped before local ACL injection', '        if creator != self._agent and not direct:\n            raise SynapseError(403, "Members may create only validated local direct messages", errcode=Codes.FORBIDDEN)\n', '', 'test_raw_dm_validation_precedes_injected_acl_projection'),
    ('validated DM projection omitted', '                room_config = {**room_config, "initial_state": []}', '                pass', 'test_raw_dm_validation_precedes_injected_acl_projection'),
]


HELPER_MUTANTS = [('public homeserver validation omitted', 'return isinstance(value, str) and len(value) <= 253 and PUBLIC_SERVER.fullmatch(value) is not None and not value.endswith(PRIVATE_SUFFIXES)', 'return True', 'test_public_server_allowlist_configuration_refusals_name_boundary'), ('global allowlist bound removed', 'len(value) > MAX_SERVERS', 'len(value) > 100', 'test_public_server_allowlist_configuration_refusals_name_boundary'), ('global allowlist duplicates accepted', 'or len(set(value)) != len(value)', '', 'test_public_server_allowlist_configuration_refusals_name_boundary'), ('immutable federation disabled ignored', 'and content.get("m.federate") is True', '', 'test_partner_author_creation_acl_and_global_boundaries_are_independent'), ('frozen ACL not recognized', 'isinstance(content, Mapping) and set(content) == set(expected)', 'isinstance(content, dict) and set(content) == set(expected)', 'test_frozen_partner_state_preserves_bounded_federation')]


def main() -> int:
    survivors = []
    all_mutants = [(SOURCE, *mutation) for mutation in MUTANTS] + [(SOURCE.with_name("federation.py"), *mutation) for mutation in HELPER_MUTANTS]
    for source, name, before, after, owner in all_mutants:
        original = source.read_text()
        if original.count(before) != 1:
            print(f"BROKEN MUTANT {name!r}: its text occurs {original.count(before)} times")
            return 2
        with tempfile.TemporaryDirectory() as tmp:
            package = pathlib.Path(tmp) / "src" / "kodera_synapse_policy"
            package.mkdir(parents=True)
            shutil.copytree(SOURCE.parent, package, dirs_exist_ok=True)
            changed = original.replace(before, after)
            if name == "partner creation trusted agent ignored":
                # Raw creation and the partner branch both check the same author boundary.
                # Remove both checks to exercise that semantic rule rather than a redundant line.
                raw_author = '        if creator != self._agent and not direct:\n            raise SynapseError(403, "Members may create only validated local direct messages", errcode=Codes.FORBIDDEN)\n'
                assert changed.count(raw_author) == 1
                changed = changed.replace(raw_author, "")
            (package / source.name).write_text(changed)
            shutil.copytree(ROOT / "tests", pathlib.Path(tmp) / "tests")
            result = subprocess.run(
                [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests/test_policy.py", "tests/test_community.py", "tests/test_federation.py"],
                cwd=tmp,
                env={"PYTHONPATH": str(pathlib.Path(tmp) / "src"), "PATH": "/usr/bin:/bin"},
                capture_output=True,
                text=True,
            )
        failed = [line for line in result.stdout.splitlines() if line.startswith("FAILED")]
        caught = result.returncode == 1 and any(f"::{owner}" in line for line in failed)
        print(f"{'killed ' if caught else 'SURVIVED'} {name} (expected {owner})")
        if not caught:
            survivors.append(name)
    print(f"{len(all_mutants) - len(survivors)}/{len(all_mutants)} mutants killed by their named test")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
