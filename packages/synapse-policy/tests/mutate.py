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
    ("agent may not create", "if user_id == self._agent:\n            return NOT_SPAM", "if False:\n            return NOT_SPAM", "test_agent_creates_any_room"),
    ("any is_direct accepted", 'config.get("is_direct") is not True', "False", "test_member_cannot_create_anything_but_a_direct_message"),
    ("two invitees accepted", "len(invite) != 1", "len(invite) < 1", "test_member_cannot_create_anything_but_a_direct_message"),
    ("remote invitee accepted", "or not self._api.is_mine(invitee):\n            return False", ":\n            return False", "test_member_cannot_create_anything_but_a_direct_message"),
    ("initial state accepted", "and not config.get(\"initial_state\")", "", "test_member_cannot_create_anything_but_a_direct_message"),
    ("spaces accepted", 'and creation.get("type") is None', "", "test_member_cannot_create_anything_but_a_direct_message"),
    ("second invite accepted", "or others or", "or", "test_member_cannot_invite_otherwise"),
    ("other's room accepted", "create.sender != inviter or", "", "test_member_cannot_invite_otherwise"),
    ("e-mail invites open", "return NOT_SPAM if inviter == self._agent else Codes.FORBIDDEN", "return NOT_SPAM", "test_member_cannot_invite_by_email_or_phone"),
    ("agent e-mail invites refused", "return NOT_SPAM if inviter == self._agent else Codes.FORBIDDEN", "return Codes.FORBIDDEN", "test_agent_may_invite_by_email"),
    ("aliases open to members", "return NOT_SPAM if user_id == self._agent else Codes.FORBIDDEN", "return NOT_SPAM", "test_member_cannot_create_a_room_alias"),
    ("directory open", "async def user_may_publish_room(self, user_id: str, room_id: str) -> Any:\n        return Codes.FORBIDDEN", "async def user_may_publish_room(self, user_id: str, room_id: str) -> Any:\n        return NOT_SPAM", "test_nobody_publishes_to_the_directory"),
    ("agent may encrypt", "if event.type in ENCRYPTION:\n            return Codes.FORBIDDEN", "if event.type in ENCRYPTION and event.sender != self._agent:\n            return Codes.FORBIDDEN", "test_nobody_turns_on_encryption"),
    ("federated ciphertext open", "if event.type in ENCRYPTION:\n            return Codes.FORBIDDEN\n        if not event.is_state():\n            return NOT_SPAM", "if not event.is_state():\n            return NOT_SPAM\n        if event.type in ENCRYPTION:\n            return Codes.FORBIDDEN", "test_no_federated_event_carries_ciphertext"),
    ("spam check ignores encryption", "if event.type in ENCRYPTION:\n            return Codes.FORBIDDEN", "if False:\n            return Codes.FORBIDDEN", "test_no_federated_event_carries_ciphertext"),
    ("agent creates encrypted rooms", "if room_config is not None and _asks_for_encryption(room_config):", "if False:", "test_nobody_creates_an_encrypted_room"),
    ("any initial state is encryption", 'state.get("type") == "m.room.encryption"', 'state.get("type") is not None', "test_agent_creates_a_room_with_other_initial_state"),
    ("rules allow encryption", 'return event.type not in ENCRYPTION, None', "return True, None", "test_no_event_turns_on_encryption"),
    ("rules allow turning encryption on", 'frozenset({"m.room.encryption", "m.room.encrypted"})', 'frozenset({"m.room.encrypted"})', "test_no_event_turns_on_encryption"),
    ("rules allow ciphertext", 'frozenset({"m.room.encryption", "m.room.encrypted"})', 'frozenset({"m.room.encryption"})', "test_no_event_carries_ciphertext"),
    ("rules refuse everything", 'return event.type not in ENCRYPTION, None', "return False, None", "test_rules_allow_every_other_event"),
    ("join rule open", 'content.get("join_rule") != "invite"', "False", "test_member_cannot_open_a_room"),
    ("world readable open", '== "world_readable"', '== "never"', "test_member_cannot_open_a_room"),
    ("aliases open", "event.type in LOCKED_STATE\n            or", "", "test_member_cannot_open_a_room"),
    ("agent locked out", "if event.sender == self._agent:\n            return NOT_SPAM\n        if event.type == OCCUPANCY", "if event.type == OCCUPANCY", "test_ordinary_events_pass"),
    ("policy open to members", '        "io.kodera.room.policy",\n', "", "test_only_the_agent_sets_a_rooms_policy"),
    ("occupancy open to members", "return NOT_SPAM if event.sender == self._room_access else Codes.FORBIDDEN", "return NOT_SPAM", "test_only_room_access_and_the_agent_write_occupancy"),
    ("room-access locked out of occupancy", "return NOT_SPAM if event.sender == self._room_access else Codes.FORBIDDEN", "return Codes.FORBIDDEN", "test_only_room_access_and_the_agent_write_occupancy"),
    ("room-access id unchecked", 'room_access is not None and (\n            not isinstance(room_access, str) or not room_access.startswith("@") or ":" not in room_access\n        )', "False", "test_refuses_a_malformed_room_access_id"),
    ("call member state open to members", '        "m.call.member",\n', "", "test_member_cannot_spoof_call_membership"),
    ("service accounts create or receive DM at creation", "        if creator == self._room_access or invitee in {self._agent, self._room_access}:\n            return False\n", "", "test_service_accounts_never_participate_in_direct_messages"),
    ("service accounts invite or are invited into DM", "        if inviter == self._room_access or invitee in {self._agent, self._room_access}:\n            return Codes.FORBIDDEN\n", "", "test_service_accounts_never_participate_in_direct_messages"),
    ("malformed invitee accepted", "        if not _is_valid_user_id(invitee):\n            return Codes.FORBIDDEN\n", "", "test_service_accounts_and_malformed_ids_refused_in_channel_invites"),
    ("channel member invites ignored", 'policy_content.get("allow_member_invites") is True', "False", "test_joined_member_invites_local_user_into_policy_authorized_channel"),
    ("channel member invites open without policy", 'policy_content.get("allow_member_invites") is True', "True", "test_channel_without_allow_member_invites_refuses_member_invites"),
    ("non-joined member invites into channel", '_membership_of(state.get(("m.room.member", inviter))) != "join"', "False", "test_non_joined_member_cannot_invite_into_policy_authorized_channel"),
    ("federated channel invites refused when allowed", 'or policy_content.get("allow_federated_invites") is True', "", "test_joined_member_invites_federated_user_when_federated_invites_allowed"),
    ("federated channel invites open without federated policy", 'policy_content.get("allow_federated_invites") is True', "True", "test_joined_member_cannot_invite_federated_user_without_federated_policy"),
]


def main() -> int:
    original = SOURCE.read_text()
    survivors = []
    for name, before, after, owner in MUTANTS:
        if original.count(before) != 1:
            print(f"BROKEN MUTANT {name!r}: its text occurs {original.count(before)} times")
            return 2
        with tempfile.TemporaryDirectory() as tmp:
            package = pathlib.Path(tmp) / "src" / "kodera_synapse_policy"
            package.mkdir(parents=True)
            (package / "__init__.py").write_text(original.replace(before, after))
            shutil.copytree(ROOT / "tests", pathlib.Path(tmp) / "tests")
            result = subprocess.run(
                [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests/test_policy.py"],
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
    print(f"{len(MUTANTS) - len(survivors)}/{len(MUTANTS)} mutants killed by their named test")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
