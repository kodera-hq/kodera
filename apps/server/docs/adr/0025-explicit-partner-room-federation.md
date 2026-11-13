# ADR-0025: Explicit, bounded partner-room federation

**Status:** Proposed

Opt-in implementation for review; deployment remains operator-controlled.

## Context

SRV-ADR-0018 excludes federation from the pilot. Design-partner channels now require standard
Matrix interoperability while internal workspace channels retain their existing isolation.
Opening a homeserver listener alone cannot establish a safe room boundary. Core convergence
also removes every foreign member today, so an invitation flag alone cannot enable this feature.

## Decision

Upon acceptance, this decision supersedes only SRV-ADR-0018's blanket exclusion of federation
for explicitly configured partner channels. Federation remains off by default. Other pilot
restrictions, including encryption-event policy and Core authority over local membership, remain
in force. This decision does not enable group encryption or treat a foreign account as a local
workspace member.

A trusted operator policy selects exact Core channel UUIDs and a bounded set of public partner
homeserver names. Only a non-read-only channel with Core audience `all` is eligible. A listed
or restricted Core audience cannot be widened. This experimental operator interface precedes
any owner-facing product control and is not an implicit selection by room name or category.

A partner room requires trusted initial policy, explicit immutable creation mode, invite-only
join rules, a room server ACL and a per-room server set contained in the operator's global
federation allowlist. The creation hook binds the approved initial server set immutably for
Synapse's ACL bootstrap, which runs before the initial mutable policy is visible; this
bootstrap never admits remote membership without the complete trusted policy and ACL. Both member-invite and federated-invite flags must be true. Native Matrix
membership authorization remains mandatory. Core convergence preserves foreign participants
only in that eligible channel and within its exact allowlist; bans and removal boundaries remain
effective. A partner participant gains no identity, membership or document grant in Core.

Internal rooms are created with `m.federate: false` and a local-server ACL. Remote invitations,
joins and timeline events are refused before service-account exemptions, including traffic from
previously joined remote accounts. Cleanup departures remain possible. Existing incompatible
rooms are held for explicit replacement; immutable creation state is never rewritten in place.
No automatic history copy, old-room disclosure or migration occurs.

## Evidence and consequences

Qualification requires genuine two-homeserver federation, partner invitation/join/message
exchange, internal-room refusals, Core convergence and named abuse mutations. Unit callbacks
alone do not prove client interoperability. Standard Matrix protocol evidence does not establish
that every version of Element, Tchap or Cinny has been tested on a device.

The source remains a draft until independent review and the recorded checks pass. Operator
approval of exact servers, deployed routing/TLS, room replacement and real account acceptance
remain explicit release gates. No live server or provider operation is authorized by this file.
