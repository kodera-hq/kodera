# Tenant agent: engine member sets and Espace channel sets

**Status:** Proposed · **Owner:** API seat

The process on each tenant VM that applies ADR-0016:

- It pulls `engine_set_member_subjects` commands from Core over the Agent API (`contracts/agent-api.openapi.yaml`).
- It converges Docs, Meet and, when the VM runs Espace, Synapse to the organisation's member set, and runs the LiveKit roster guard.
- On a VM that runs Espace, it also pulls `engine_set_channel_members` (ADR-0018, agent-api 0.5.0) and converges the tenant's Matrix rooms to the organisation's channels.

It ships in Core's image and imports nothing from Django or `apps/`.

## What it does

- **Inactive subjects:** the engine user is deactivated in Docs and Meet through each engine's own code. In the same transaction, Docs queues the yhub reset-connections kick for every document the user reaches, which closes open editors (code 4401). Their sessions are then deleted (Docs: session cache; Meet: session table).
- **Released subjects:** an engine user who is inactive is reactivated, only when a set arrives. The periodic re-application never reactivates, so an engine administrator's own deactivation stands.
- **No one else is touched.**
- **The roster guard** removes from every LiveKit room each inactive subject and each user Meet holds as deactivated. Room-level access (roles, the lobby, moderation) stays Meet's. One room the guard cannot check does not stop the others, and the set is then reported as not converged.
- **Each engine converges on its own:** one engine failing does not stop the other, nor the guard.
- **When:**
  - on each new set;
  - on LiveKit's `participant_joined` webhook;
  - every 5 minutes (guard sweep);
  - every 15 minutes (re-application of the set in force);
  - after a restore (`python -m tenant_agent reapply`).
- **Command loop:** every command is acknowledged before work and reported once. A redelivered command id replays its stored result from the local ledger, which is pruned after 30 days. Core answers at once, so the agent waits `poll_after_s` when there is nothing to do. A command with no readable future `expires_at` is treated as expired.
- **Espace channels (ADR-0018):**
  - each channel's room exists under `#kodera-ch-{channel_id}:{server_name}`, with its name, topic, `io.kodera.room.policy` and power levels (every state change is the agent's; `read_only` leaves posting to the exempt; the room-access account writes occupancy only);
  - its membership is exactly the set's members: missing ones are joined through the admin API, others are removed, and a member removed from an audio room also leaves its live call, on every device;
  - a member the room lacks is joined only after their account is read, since Synapse's admin join joins a deactivated account too: a deactivated account is not joined (logged). Only a member the member set in force holds **active** is joined or given an account: not one it holds inactive (an erased person included) or released, nobody at all while no member set is stored, and never an account the erasure ledger holds, even when the channel set still names them;
  - a member the set names who has never signed in gets an account first, so their channels work on first open: made through the admin API with no password and bound to their realm subject as it is (`external_ids`, under the homeserver's one sign-in provider, read from its login flows), and Synapse's SSO looks that binding up before it maps a new localpart, so their first sign-in lands on it. None is made when the homeserver offers other than one sign-in provider, and an account that exists is never touched. When none can be made, the member is joined within 30 s of their first sign-in: while anyone is waiting, the agent checks every 30 s whether their account exists, and applies the set again when it does;
  - a room is recorded as soon as it is made, and a room found under a channel's alias is converged only if the agent created it (otherwise that channel is reported failed);
  - a channel the set no longer lists has its room archived and emptied; if that fails, the command is reported failed, with every listed channel that converged still ready, and Core's retry tries again;
  - pending notices are posted once (ledger plus the notice id as transaction id);
  - one channel that fails is reported in `failed_channel_ids`, and the others are applied;
  - a homeserver that does not answer at all (refused, reset, timed out) ends the pass at its first call: every remaining channel is reported failed and one line is logged;
  - the admin token is sent to the configured homeserver only: no proxy, and a redirect is refused;
  - the roster guard checks each `kodera-…` audio call against the channel set in force, without asking Meet;
  - the member set deactivates and reactivates the members' Synapse accounts, then erases each erased subject's account once (Synapse's erase flag, with a local ledger). Deactivations come before erasures, so a failing erasure holds none back, and an erased account is never reactivated;
  - the re-application converges the member set before the channels, so offboarding never waits on the channels' rooms.
- **Synapse configuration** the agent relies on, which the homeserver must hold:
  - `password_config.enabled: false`: Synapse otherwise refuses to reactivate an account through the admin API without a password;
  - exactly one SSO provider, with `subject_claim: sub`: an account made ahead of sign-in is bound to the realm subject under that provider, and none is made otherwise;
  - `sso.update_profile_information: true`: an account made ahead takes the member's realm display name at their first sign-in; without it the name stays the localpart.

  Kodera's Espace profile in deployment profiles (`profiles/espace/1.0`, in review in deployment profiles#133 and #134, not yet on its main) sets all four, and its render self-test refuses a homeserver that drops any of them. No Synapse that Fleet deploys today holds them.
- **Failure reports:** an engine's own output stays in the agent's log, and Core receives the error code only.

## Run

```bash
python -m tenant_agent run
```

| Variable | Meaning |
|---|---|
| `KODERA_CORE_URL` | Core's Agent API base URL |
| `KODERA_AGENT_TOKEN` | the agent credential (`eac1_…`), issued by Core |
| `KODERA_AGENT_STATE_DIR` | local state: ledger and member set in force, mode 600 |
| `KODERA_COMPOSE_PROJECT` | the tenant stack's compose project; engines are found by its labels |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | the VM's LiveKit server API |
| `KODERA_APPS` | the La Suite apps this tenant runs, comma-separated: `docs`, `meet` (default both), as the tenant record's `apps` names them (`meet` is the app sold as Visio). An app not listed is never asked, so a tenant without Docs converges Meet, Synapse and LiveKit and succeeds. The agent stops at start on an unknown name, and on an app whose container the project holds (running or not) but the list omits: its accounts would otherwise outlive every revocation. Fleet's `tenant_agent` role (deployment profiles#135, in review) writes it from the record's apps. Espace is on when its Synapse settings are set |
| `KODERA_DOCS_SERVICE`, `KODERA_MEET_SERVICE` | compose service names (defaults `docs-backend`, `meet-backend`) |
| `DOCKER_SOCKET` | default `/var/run/docker.sock`; the agent execs into the engines through it, as the image's user (its user and first group when the image declares a malformed `USER` such as Meet's `1001:127:-1000`, which Docker refuses with exit 126) |
| `KODERA_SYNAPSE_URL`, `KODERA_SYNAPSE_TOKEN`, `KODERA_MATRIX_SERVER_NAME` | Espace only: the VM's Synapse, the agent's server-administrator token, and the homeserver's `server_name`. Without all three the agent does not take channel sets |
| `KODERA_ROOM_ACCESS_USER` | Espace only: the room-access service's Matrix account, joined to every audio room (invited only while the account does not exist yet) |
| `KODERA_WEBHOOK_PORT`, `KODERA_WEBHOOK_BIND` | LiveKit webhook listener (default `0.0.0.0:8090`); bind it to the VM's internal address, never a public interface |

**Deployment** on tenant VMs belongs to Fleet. The agent needs:

- the Docker socket;
- the VM's LiveKit key;
- LiveKit's `webhook.urls` pointed at `http://<agent>:8090/livekit/webhook`.

## Tests

- `tests/test_tenant_agent.py` runs in CI, with Core, Docker and LiveKit replaced by fakes.
- The same agent runs against the real engines of the engine spike in `design specification` (`architecture/engine-spike/`). From that folder:

```bash
KODERA_CORE_DIR=/path/to/kodera-core bin/scenario.sh agent
```
