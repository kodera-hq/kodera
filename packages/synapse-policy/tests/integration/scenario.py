"""Drive a real Synapse as a third-party client would, and check what the policy refuses.

Called by run.sh with the port of a Synapse that loads the module. Exit 0 only if every check passes.
"""

import json
import sys
import urllib.error
import urllib.request

BASE = f"http://127.0.0.1:{sys.argv[1]}/_matrix/client/v3"
ALICE, BOB, CAROL = "@alice:it.local", "@bob:it.local", "@carol:it.local"
MEGOLM = {"algorithm": "m.megolm.v1.aes-sha2"}
# What a client posts in a room once it has shared a Megolm session by to-device message. Synapse
# does not need m.room.encryption in the room to accept it.
CIPHERTEXT = {
    **MEGOLM,
    "ciphertext": "AwgAEnACgAkLmt6qF84IK++J7UDH2Za1YVchHyprqTqsg",
    "device_id": "RJYKSTBOIE",
    "sender_key": "IlRMeOPX2e0MurIyfWEucYBRVOEEUMrOHqn/8mLqMjA",
    "session_id": "X3lUlvLELLYxeTx4yOVu6UDpasGEVO0Jbu+QFnm0cKQ",
}
failures = 0


def call(method, path, token=None, body=None):
    request = urllib.request.Request(
        BASE + path, method=method, data=None if body is None else json.dumps(body).encode()
    )
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def login(user):
    status, body = call(
        "POST",
        "/login",
        body={
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": user},
            "password": f"pw-{user}-123",
        },
    )
    assert status == 200, (user, status, body)
    return body["access_token"]


def check(name, got, want):
    global failures
    failures += got != want
    print(f"{'PASS' if got == want else 'FAIL'} {name}: got {got}, want {want}")


agent, alice, bob, carol = (login(u) for u in ("kodera-agent", "alice", "bob", "carol"))
dm_request = {"is_direct": True, "invite": [BOB], "preset": "trusted_private_chat"}

status, _ = call("POST", "/createRoom", alice, {"preset": "public_chat", "name": "x"})
check("member cannot create a public room", status, 403)
status, _ = call("POST", "/createRoom", alice, {"preset": "private_chat"})
check("member cannot create a private room that is not a DM", status, 403)
status, _ = call(
    "POST",
    "/createRoom",
    alice,
    {**dm_request, "initial_state": [{"type": "m.room.encryption", "state_key": "", "content": MEGOLM}]},
)
check("member cannot create an encrypted DM", status, 403)

status, dm = call("POST", "/createRoom", alice, dm_request)
check("member creates a direct message with its invite", status, 200)
dm_id = dm.get("room_id", "!missing")
status, _ = call("POST", f"/rooms/{dm_id}/join", bob)
check("the invited member joins the direct message", status, 200)
status, _ = call("PUT", f"/rooms/{dm_id}/send/m.room.message/t1", bob, {"msgtype": "m.text", "body": "hi"})
check("members post in a direct message", status, 200)
status, _ = call("PUT", f"/rooms/{dm_id}/send/m.room.encrypted/c1", bob, CIPHERTEXT)
check("member cannot post ciphertext in a DM", status, 403)
# Both members of a trusted_private_chat DM hold power 100, so only the module refuses this.
status, _ = call("PUT", f"/rooms/{dm_id}/state/m.room.encrypted/", alice, CIPHERTEXT)
check("member cannot send ciphertext as DM state", status, 403)
status, page = call("GET", f"/rooms/{dm_id}/messages?dir=b&limit=100", alice)
check(
    "no ciphertext reached the DM's timeline",
    (status, sum(e.get("type") == "m.room.encrypted" for e in page.get("chunk", []))),
    (200, 0),
)
status, _ = call("POST", f"/rooms/{dm_id}/invite", alice, {"user_id": CAROL})
check("member cannot invite a third person into a DM", status, 403)
status, _ = call("PUT", f"/rooms/{dm_id}/state/m.room.join_rules/", alice, {"join_rule": "public"})
check("member cannot make a DM public", status, 403)
status, _ = call(
    "PUT", f"/rooms/{dm_id}/state/m.room.history_visibility/", alice, {"history_visibility": "world_readable"}
)
check("member cannot make a DM's history world-readable", status, 403)
status, _ = call("PUT", f"/rooms/{dm_id}/state/m.room.encryption/", alice, MEGOLM)
check("member cannot turn on encryption", status, 403)
status, _ = call(
    "POST", f"/rooms/{dm_id}/invite", alice, {"id_server": "id.example.org", "id_access_token": "unused", "medium": "email", "address": "x@example.org"}
)
check("member cannot invite by e-mail", status, 403)
status, _ = call("PUT", "/directory/room/%23lunch:it.local", alice, {"room_id": dm_id})
check("member cannot create a room alias", status, 403)
status, _ = call("PUT", f"/directory/list/room/{dm_id}", alice, {"visibility": "public"})
check("member cannot publish a room to the directory", status, 403)

# The power levels Core's tenant agent gives a channel room (tenant_agent/channels.py): every
# state change is the agent's, its policy event included; members post at 0.
CHANNEL_POWER = {
    "users_default": 0,
    "events_default": 0,
    "state_default": 100,
    "invite": 100,
    "kick": 100,
    "ban": 100,
    "redact": 50,
    "events": {"m.reaction": 0, "m.room.redaction": 0, "m.room.encryption": 100, "io.kodera.room.policy": 100},
}
status, channel = call(
    "POST", "/createRoom", agent, {"preset": "private_chat", "name": "general", "power_level_content_override": CHANNEL_POWER}
)
check("agent creates a channel room", status, 200)
channel_id = channel.get("room_id", "!missing")
status, _ = call("POST", f"/rooms/{channel_id}/invite", agent, {"user_id": ALICE})
check("agent invites a member into the channel", status, 200)
status, _ = call("POST", f"/rooms/{channel_id}/join", alice)
check("the member joins the channel", status, 200)
status, _ = call("PUT", f"/rooms/{channel_id}/send/m.room.message/t2", alice, {"msgtype": "m.text", "body": "hi"})
check("members post in a channel", status, 200)
status, _ = call("PUT", f"/rooms/{channel_id}/send/m.room.encrypted/c2", alice, CIPHERTEXT)
check("member cannot post ciphertext in a channel", status, 403)
status, _ = call("PUT", f"/rooms/{channel_id}/send/m.room.encrypted/c3", agent, CIPHERTEXT)
check("not even the agent posts ciphertext", status, 403)
status, _ = call("PUT", f"/rooms/{channel_id}/state/m.room.encrypted/", agent, CIPHERTEXT)
check("not even the agent sends ciphertext as state", status, 403)
status, _ = call("POST", f"/rooms/{channel_id}/invite", alice, {"user_id": CAROL})
check("member cannot invite into a channel", status, 403)
status, _ = call("PUT", f"/rooms/{channel_id}/state/io.kodera.room.policy/", alice, {"version": 1, "kind": "text"})
check("member cannot write the channel's policy (power levels)", status, 403)
status, _ = call("PUT", f"/rooms/{channel_id}/state/io.kodera.room.policy/", agent, {"version": 1, "kind": "text"})
check("the agent writes the channel's policy", status, 200)
status, _ = call("PUT", f"/rooms/{channel_id}/state/m.room.encryption/", agent, MEGOLM)
check("not even the agent turns on encryption", status, 403)
status, _ = call(
    "POST",
    "/createRoom",
    agent,
    {"preset": "private_chat", "initial_state": [{"type": "m.room.encryption", "state_key": "", "content": MEGOLM}]},
)
check("not even the agent, a server admin, creates an encrypted room", status, 403)
status, _ = call("PUT", f"/rooms/{channel_id}/state/m.room.join_rules/", agent, {"join_rule": "invite"})
check("the agent changes channel state", status, 200)

print(f"{'all checks passed' if not failures else f'{failures} check(s) failed'}")
sys.exit(1 if failures else 0)
