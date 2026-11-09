"""The tenant agent's engine intents: ADR-0016.

A small process on each tenant VM. It pulls the engine commands Core issued for its tenant over the
Agent API (`contracts/agent-api.openapi.yaml`), applies them to the engines of the VM with the
credentials that stay on the VM, and reports each result. It also runs the LiveKit roster guard,
on LiveKit's `participant_joined` webhook and after each new member-subject set.

It imports nothing from Django or from `apps/`: it runs from the Core image but talks to Core only
over HTTP.
"""

AGENT_VERSION = "0.1.0"
