# kodera-synapse-policy

Status: published under AGPL-3.0-or-later. Changes land by pull request.

A Synapse module that keeps a Kodera instance's rooms under its control plane's policy (Core ADR-0018).

**The model.** Kodera's control plane decides who is in which channel room, and the tenant agent's administrative account applies it. Synapse's client API is open to any Matrix client a member signs in with, so this module refuses whatever would route around that:

| Callback | Refuses |
|---|---|
| `user_may_create_room` | every room creation with `m.room.encryption` in its initial state, the agent's included (a room's initial state never reaches `check_event_for_spam`); every other creation, except a private direct message with one to eight distinct local invitees, and except by the agent |
| `on_create_room` | binds a validated DM request's invitee set to immutable `m.room.create` content, replacing any client-supplied marker |
| `user_may_invite` | every invite to or from a service account (`agent_user_id`, `room_access_user_id`, except when the agent itself invites a regular user) or with a malformed Matrix user ID; every other invite, except (1) by the agent, (2) by a joined member (`membership == "join"`) of a room whose `io.kodera.room.policy` state event sets `allow_member_invites: true` (for local users, or for external federated Matrix users when `allow_federated_invites: true` is also set), and (3) the validated initial local invitees of a member's new direct message |
| `user_may_send_3pid_invite`, `user_may_create_room_alias` | invites by e-mail or phone, and room aliases, except by the agent |
| `user_may_publish_room` | publishing any room to the directory |
| `check_event_allowed` (third-party rules) | `m.room.encryption` and `m.room.encrypted` in any event Synapse creates, with no exemption. Synapse skips `user_may_create_room` for a server admin, and the agent's account is one, so this is what holds for the agent's own room creations, for encryption a server setting would force on, and for the state an upgrade copies. `m.room.encrypted` is ciphertext: a client can post it in a room where encryption is off, with the keys shared by to-device message, so it is refused as a timeline event and as state, in channels and direct messages |
| `check_event_for_spam` | `m.room.encryption` and `m.room.encrypted` from anyone, as timeline or state: Synapse (v1.163.0) runs this callback, not `check_event_allowed`, on events from other servers. From anyone but the agent: a join rule other than `invite`, a world-readable history, aliases, third-party invites, server ACLs, room upgrades, space links and a room's policy (`io.kodera.room.policy`). From anyone but the agent and the room-access service: a room's audio occupancy (`io.kodera.room.occupancy`). Power levels do not cover these two: in a direct message its creator holds every level, and could otherwise declare it an audio room |

**Bounded direct conversations.** Member-created rooms require `is_direct: true`,
`preset: "private_chat"`, `visibility: "private"`, and one to eight distinct local
invitees, excluding the creator and service accounts. Both creators and invitees
must be registered, active non-guest Synapse accounts; deactivated, unapproved,
locked or suspended accounts fail closed at creation and each DM invitation. Aliases, initial state,
power-level overrides, spaces and third-party identifier invites are refused.
`trusted_private_chat` is refused because it promotes invitees to the creator's
power level. `on_create_room` records the validated list in immutable creation
state; each subsequent initial invite is checked against that list, including
when Synapse freezes JSON arrays into tuples. Neither simultaneous invites nor a
later invitation can expand the original recipient set. Legacy DMs without the
marker keep their first-invite-only boundary. This local account check does not
establish current Core workspace membership. Operators must reconcile Core
identity removals into Synapse account state; a Core-only removal that leaves a
local Matrix account active is not an account deactivation.

**Channel member and federated invites (`io.kodera.room.policy`).** When a channel's `("io.kodera.room.policy", "")` state event (written by the agent) sets `allow_member_invites: true`, any currently joined member of that room (`membership == "join"`) may invite local users (`is_mine(invitee)`), whether from Kodera or any standard Matrix client. Inviting an external federated Matrix user (`@localpart:domain` on another homeserver) additionally requires `allow_federated_invites: true` in `io.kodera.room.policy`. Service accounts (`agent_user_id`, `room_access_user_id`) and malformed user IDs are always refused as invitees, and `room_access_user_id` may never send invites.

**To-device messages are not room events**, and Synapse (v1.163.0) offers a module no callback for them. A client can still send encrypted to-device messages, but without `m.room.encrypted` no room carries ciphertext.

**Community governance supplements room power levels.** The tenant agent writes
additive `read_only`, `audience`, `members` and `exempt` fields to
`io.kodera.room.policy`. In a read-only room, normal members cannot post messages,
stickers or change state; reactions and their own joins/leaves remain possible.
Explicit exempt publishers and joined users with an explicit power level of at
least 50 may post, subject to Matrix's own authorization. `users_default` never
promotes everyone past this additional gate.

For `audience: listed`, only the explicit Matrix IDs in `members` may join, even
with a stale invitation. A member may invite only when both they and the invitee
are listed and the existing member-invite policy allows it. The tenant agent can
reconcile membership. Invalid governance or a policy authored by anyone else
fails closed. Legacy policies without these additive fields retain their existing
behavior; deploy the matching server policy producer before opening Community
traffic. The module handles Synapse's immutable mappings and tuples as well as
ordinary JSON test data. Native power levels remain mandatory. Restricted and customer
rooms retain invite-only rules; governed local-only Community channels may use native public
joins. Archived governed rooms refuse rejoining and posting while allowing members to leave.

## Configure

Synapse 1.132 or later is required: earlier versions pass no room configuration, so a direct message cannot be told apart and every member-created room is refused.

```yaml
modules:
  - module: kodera_synapse_policy.KoderaPolicy
    config:
      agent_user_id: "@kodera-agent:acme-sa.kodera.io"
      room_access_user_id: "@kodera-rooms:acme-sa.kodera.io"
```

`room_access_user_id` names the room-access service's account, the one writer of audio occupancy besides the agent. It is optional: without it, only the agent may write occupancy, so an instance that runs room-access sets it.

## Test

```bash
PYTHONPATH=src python3 -m pytest -q
```

```bash
python3 tests/mutate.py
```

```bash
bash tests/integration/run.sh
```

```bash
WITHOUT_MODULE=1 bash tests/integration/run.sh
```

- **Unit tests.** They run the callbacks against a minimal stand-in for Synapse's module API (`tests/conftest.py`).
- **Mutation script.** It proves every rule has a test that fails when the rule is broken, and names the test that must catch it.
- **Integration test.** It runs the module inside the pinned Synapse v1.163.0 in Docker, and drives it over the client API as a third-party client would. This covers the invite inside `/createRoom`, the state a direct-message preset creates, refused e-mail invites and aliases, and the agent's own channel.
- **Negative control.** Run without the module, the same scenario must fail (17 checks fail, exit 1).

## Continuous integration

`ci-ok` is the one required check. It passes only when every job passes:
- **Unit tests and mutations**, with the test dependencies pinned by hash (`requirements-test.txt`).
- **The real-Synapse test**, with the image pinned by digest. The negative control runs first and must fail.
- **The attribution check** on files, commit messages, the branch name, and the pull request title and body. Each check first proves it can fail.

## Licence

AGPL-3.0-or-later, like Synapse ([LICENSE](LICENSE)).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report a vulnerability privately to support@kodera.io ([SECURITY.md](SECURITY.md)).

### Local native joins

An agent-authored governed policy may include `local_only: true` for public community
channels. Both the native join callback and membership event rules refuse remote users,
even if invited. A non-boolean flag fails closed. This complements Matrix's native join
rule; it does not publish rooms, relax private listed membership or announcement posting.
