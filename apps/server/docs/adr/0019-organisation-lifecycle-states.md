# ADR-0019: Organisation lifecycle uses five explicit states

**Status:** Accepted
**Owner:** API seat
**Deciders:** Integration lead under the delegated product and technical mandate; independent
backend and security review remains a merge gate.

## Context

The current sources encode three incompatible organisation lifecycles. Persistence and OpenAPI
carry `prospect`, `active`, `suspended`, `closed`; the domain model still says `terminated`; and the
first-slice proposal adds `closing`. A single terminal state cannot distinguish an offboarding
process with unfinished external work from an organisation whose customer identity and access are
already gone.

The intake and first-owner wire protocol is no longer hypothetical. The contract and implementation
already name `createOrganisation`, `getOrganisationBootstrap`, `consumeOwnerClaim`, `placeOrder`,
`triggerTenantJob` and `getJob`. Renaming those operations would create a second protocol without
removing the first.

The retained-record access duration, post-erasure delivery method and legal erasure sequence are
separate owner decisions. This record must not decide them indirectly through a lifecycle enum.

## Decision

- Organisation state is exactly `prospect`, `active`, `suspended`, `closing`, `closed`.
- `prospect` admits only the staff-intake bootstrap status and first-owner claim protocol. It admits
  no order, tenant, invitation or ordinary membership.
- `active` is the ordinary operating state and requires at least one active owner.
- `suspended` admits no new effect-bearing customer mutation except a separately specified
  settlement or recovery operation. Reads continue only where an explicit authorization rule
  grants them.
- `closing` is nonterminal and admits no new order, tenant, invitation or ordinary membership. It
  records that closure work or an obligation is unresolved. Which retained records remain readable
  in this state is deliberately not decided here.
- `closed` is terminal and grants no customer bearer-token access. A legally retained record does
  not by itself keep an application identity alive.
- Unknown states fail closed at persistence and authorization boundaries.
- The state-transition shape is `prospect → active`, `active ↔ suspended`,
  `active|suspended → closing`, and `closing → closed`. Cancelling a closure requires a separately
  authorized transition back to its recorded prior operating state; it is not inferred.
- The six existing operation identifiers above are the wire operations of the first-slice
  intake/claim/order/status protocol.

## Options considered

| Option | Decision |
|---|---|
| Keep four states and overload `closed` | Rejected. It cannot represent unfinished external destruction, export or evidence work. |
| Use `terminated` as the terminal spelling | Rejected. Persistence and the published wire contract already use `closed`. |
| Five states with explicit `closing` | Chosen. It separates an in-progress closure from its terminal result without deciding retained access. |

## Consequences

- Persistence, OpenAPI, authorization and generated clients must change together in a later runtime
  implementation. This record changes none of them.
- `FS-ID-03` is no longer blocked on a product decision. It remains expected red at the earlier
  real-provider second-factor gap.
- The retained-access and identity-erasure decision remains open and may add narrowly named read or
  delivery operations; it may not remove `closing`, make `closed` nonterminal or restore ordinary
  bearer access after closure.
- On acceptance this record settles `FIRST_OWNER_BOOTSTRAP.md` OD-2 and the lifecycle disagreement
  in `MODEL.md`; until the runtime change lands, those documents must label the four-state database
  and contract as an implementation gap.

## Changelog

- First version. Records the five-state lifecycle and existing wire operation identifiers while
  leaving retained access and post-erasure delivery to their separate owner decision.
