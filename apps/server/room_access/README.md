# Room access: Espace's audio rooms

**Status:** Proposed · **Owner:** API seat

This is the process on each tenant VM that runs Espace (ADR-0018). It decides who may enter an audio room, removes whoever should not be there, and shows who is in it. It ships in Core's image, imports nothing from Django or `apps/`, and runs apart from the tenant agent: its token listener faces the browser, and the agent holds Core's credential and the engines' admin credentials.

The design specification E4 spike chose this design over lk-jwt-service. That spike lives in `architecture/engine-spike/rooms/`, with the measurements.

## What it does

- **Token** (`POST /token {"room_id": "!…"}`), called by the Console with the member's own Matrix token.
  - **Who gets one:** a joined member of an audio channel's room that is not archived. It is refused (403) to everyone else, with one answer for every reason.
  - **What it covers:** that room only, valid 10 minutes, under the identity `{user_id}|{device_id}`. The device comes from the caller's own token, so a second tab does not replace the first.
  - **Listen-only:** publishing is withheld from members outside `may_publish`.
- **Rate limit.** One Matrix user's token requests per rolling minute (default 30), counted once Synapse has named the caller and before the room or LiveKit is asked anything; and, before Synapse is asked at all, one presented credential's. Past the limit the answer is `429 {"error": "rate_limited", "retry_after_s": n}` with `Retry-After: n`, which a listed origin may read. The count is this process's, which is the tenant's: one room-access runs per tenant VM.
- **CORS.** `Access-Control-Allow-Origin` is sent only when the request's `Origin` is exactly a configured origin, and is then that origin: never `*`, never a reflection. Every answer carries `Vary: Origin`. A preflight from any other origin is refused.
- **Guard,** on LiveKit's `participant_joined` and on every reconciliation pass (every 2 s):
  - a participant whose Matrix user is not joined to the room, or whose audio policy is missing,
    malformed, archived or no longer audio, is removed. Issuance and reconciliation use the same
    active-policy predicate; invalid policy needs no membership read to revoke existing callers;
  - a publish right that no longer matches the policy, because listen-only was switched during the call, is updated.

  The tenant agent's roster guard checks the same rooms against the channel set every 5 minutes, as a backstop.
- **Occupancy.** It writes `io.kodera.room.occupancy` into the room when the set of people in it changes: each member, on how many devices, sharing a screen or a camera. Members see it through their own `/sync`. After a restart, the first pass compares with the event already in the room, so an unchanged call writes nothing.
- **Membership reads:** one `/joined_members` read per room per pass. The room's policy, `io.kodera.room.policy`, is written by the agent, never by this service, and counts only when the agent sent it: in a direct message a member holds every power level and could write one herself. Token and guard read it alike.
- **Invitations:** only the agent's are accepted; any other, such as a member's direct message, is declined.

## Its credentials

- **Its own Matrix account.** The agent joins it to every audio room at level 10, which allows writing occupancy and nothing else: no kick, ban, redaction, invite or state. If the account does not exist yet, the agent invites it instead, and it accepts the invitation on its next pass.
- **The VM's LiveKit key,** for tokens and the server API.

It never holds the agent's administrator account.

## Run

```bash
python -m room_access
```

| Variable | Meaning |
|---|---|
| `ROOM_ACCESS_SYNAPSE_URL`, `ROOM_ACCESS_MATRIX_TOKEN` | the VM's Synapse, and this service's own account token |
| `LIVEKIT_URL`, `LIVEKIT_WS_URL` | LiveKit's server API on the VM's network, and the `wss://` URL browsers connect to |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | the VM's LiveKit key |
| `ROOM_ACCESS_ALLOWED_ORIGINS` | the Console origins CORS answers, comma-separated: exact origins (`https://host[:port]`, or plain http on `localhost` / `127.0.0.1` for a local stack). A wildcard, `null`, a path or a pattern stops the process |
| `ROOM_ACCESS_GRANTS_PER_MINUTE` | one identity's token requests per rolling minute, 1 to 600 (default 30); it cannot be turned off |
| `ROOM_ACCESS_AGENT_USER` | the tenant agent's full Matrix user ID (`@kodera-agent:{server_name}`): the only sender of a policy that counts and the only inviter accepted |
| `ROOM_ACCESS_API_BIND`, `ROOM_ACCESS_API_PORT` | the token listener (default `127.0.0.1:8095`), published only through the edge |
| `ROOM_ACCESS_WEBHOOK_BIND`, `ROOM_ACCESS_WEBHOOK_PORT` | LiveKit's webhook listener (default `127.0.0.1:8096`), on the VM's internal network only |
| `ROOM_ACCESS_RECONCILE_S`, `ROOM_ACCESS_TOKEN_TTL_S` | defaults 2 and 600 |

**Deployment** on tenant VMs belongs to Fleet. LiveKit's `webhook.urls` lists both this service (`/livekit/webhook`) and the tenant agent.

## Tests

`tests/test_room_access.py` runs in CI, with Synapse and LiveKit replaced by fakes:

- the token's refusals, claims and listen-only rule;
- the guard on a pass and on a signed webhook;
- occupancy grouping, and writes only on change;
- a listen-only switch during a call;
- a room LiveKit closed;
- a restart in the middle of a call;
- CORS and body bounds;
- a policy a member wrote in her own direct message grants nothing, and only the agent's invitations are joined;
- a silent, slow or trickling client cut off, and each listener's connection pool bounded;
- that this service and the agent name LiveKit rooms alike.

E9 measures the p95 latencies again on the lab VM.
