# ADR-0017: Customer data and backups remain in the European Union

**Status:** Accepted
**Owner:** Product seat
**Deciders:** zôÖma, the product owner, who decided on 2026-10-21 that the hosting promise of the
offer is the European Union, not France, and that the choice of provider follows the measurement
agreed in principle under decision register row HOSTING-MEASURE (decision relayed by the lead
session; its register row is still to be written, see Consequences). Lours is consulted for the
placement and backup consequences.

**Supersedes ADR-0007 on acceptance.** Until this record is accepted, ADR-0007 stays Accepted and
in force. Its status changes to `Superseded by ADR-0017`, in both registers, in a status-only pull
request after this record's ratification: `check-adr-status.py` refuses a ratification diff that
touches any ADR other than the candidate, and changing ADR-0007 first would leave no accepted
record on data residency.

## Context

[ADR-0007](0007-france-only-data-residency.md) promised that customer data and backups stay in
Scaleway `fr-par`, so that the offer could say its data is hosted in France. On 2026-09-30 the
owner answered "EU for everything" when asked whether that promise was negotiable (register row
HOSTING-EU in `design specification` `plans/complete-mock/README.md`); the row records a direction, and
the hosting provider study (`design specification` `plans/HOSTING_PROVIDER_STUDY.md`) was scoped on it.
On 2026-10-21 the owner turned the direction into the promise: the offer is hosted in the European
Union.

The provider is not chosen. The study lists three options for where tenants run (§6, decision 1):
A, both plans at Hetzner; B, the dedicated plan at Hetzner and the shared plan at Scaleway; C, both
at Scaleway. ADR-0014 records that the owner kept Scaleway for shared targets on 2026-10-01 and
ruled out the option that moved both plans, which is A; the study and its owner-decision queue
still list all three. This record holds under each of them. The owner agreed in principle to
measure one dedicated tenant at each provider before choosing (HOSTING-MEASURE): Lours prepares a
cost-and-access packet first, and nothing is opened or spent before the owner approves it.

So the promise changes now and the placement does not. The legal drafts for lawyer review
(`design specification` pull request #84, `legal/drafts/`: CGV article 4.4, DPA clauses 8 and 9 and
Annex C) use the European Union wording, name each hosting sub-processor's country, and give 30
days' notice of a new sub-processor or of a change of country. They need a
decision record that says the same thing.

## Decision

- **The promise.** Customer content, identity data, control-plane customer records, application
  logs, secrets, encryption keys, backups, exports and deletion evidence MUST be stored and
  processed in a member state of the European Union, at a provider listed with its country in
  Annex C, Part 1 of the DPA in force. No replication, backup, snapshot, log export or support
  attachment containing customer personal data may target a country outside the European Union.
- **The interim placement.** Until a later ADR records the provider decision of the study's §6,
  everything this service hosts stays in Scaleway `fr-par`, and every clause of ADR-0007's
  Decision and Consequences other than its France-only promise applies unchanged. In particular:
  - backups use Standard Multi-AZ Object Storage in `fr-par`, versioning and the accepted Object
    Lock policy, and a One Zone copy is not the durable backup floor;
  - a single tenant VM remains a zonal failure domain until a measured need justifies a more
    complex tenant profile;
  - backup and restore drills identify the availability zone and storage class in their evidence;
  - provider concentration remains an accepted risk, reviewed after the first factory and restore
    evidence exist;
  - a geographic disaster-recovery copy requires the gates ADR-0007 lists: a superseding ADR, DPA
    and ROPA changes, sub-processor and region disclosure, key-custody design, deletion and
    retention alignment, and a completed restore drill. `docs/specs/BACKUP_AND_RESTORE.md` §5
    relies on that list, which now lives here.
- **Outside hosting.** The mailbox that receives support requests and the replies and bounces of
  the service's mail is not hosted by the service. It MUST be in the European Union and appear
  with its country in Annex C, Part 1 before the DPA is offered for signature; its country is not
  yet confirmed (DPA Annex C, Gandi row).
- **Moving data.** Moving any customer data to another provider, region or country requires,
  before the first byte moves: the recorded provider decision; the DPA Annex C row with the
  provider's country; the sub-processor notice of 30 days with the customer's right to object (DPA
  clause 8); the contract's `region` enumeration extended in a contract version; and a completed
  restore drill at the new location.
- **What this record does not decide.** The providers and regions allowed beyond `fr-par`, and the
  backup location under another provider, are left to the provider-decision ADR (study §7, step 1).
  This record does not satisfy ADR-0014's condition that "a provider outside France first needs a
  decision that supersedes ADR-0007": that condition is met by the provider-decision ADR.
- **Probes.** External availability probes may run anywhere in the European Union and carry only
  what ADR-0007 allowed them: service names, synthetic identifiers, measurements, the synthetic
  probe identity and its reserved probe room. Never customer content, a real user's identifier or
  credential, or a real room's URL. This makes legitimate the on-demand vantage point "from a
  second EU region" of `docs/specs/SLO.md` §2.4.
- **Internal tools.** Internal tools outside the customer-data path MUST receive no customer
  personal data, wherever they are established, and configuration checks and redaction tests MUST
  enforce that. One case is not yet verified: backup-failure alerts post journal lines to the team
  channel.
- **Residual risk.** The legal pack and the service description state the residual risk honestly:
  recovery is designed for host and availability-zone incidents, not for the loss of the whole
  hosting region.
- **Wording.** Product and contractual wording say « hébergé dans l'Union européenne ». Where a
  text names the current location (France, Paris, Scaleway), it states it as the current fact, not
  as the promise. The landing's « Hébergée en France » stays until the owner approves its
  replacement (study §7, step 6); it remains true of everything live today.

## Options considered

| Option | Decision |
|---|---|
| Keep France everywhere (ADR-0007) | Not chosen by the owner on 2026-09-30 (HOSTING-EU), and replaced by the European Union promise on 2026-10-21. |
| European Union for the entry plan only | Not chosen by the owner (HOSTING-EU). Two promises for one offer. |
| European Union, with the provider chosen in this record | Rejected. Nothing has been measured at either provider; choosing now would decide study §6 without its evidence. |
| European Union as the promise, placement unchanged until the measured provider decision | Chosen. The promise and the legal drafts stay true under each of the study's options. |

## Consequences

- On acceptance, ADR-0007 is superseded by this record (see the status note above). Its
  clauses other than the promise carry over unchanged until the provider decision.
- The offer no longer promises France. The internal positioning, which calls French hosting a
  differentiator, needs its replacement before public copy changes (study §6, decision 5; §8).
- To be done before this record is accepted, each in its own change:
  - the owner's 2026-10-21 decision recorded as a register row in `design specification`
    `plans/complete-mock/README.md`, with its words;
  - the legal drafts of `design specification` #84 merged, and the legal pack on `main` aligned:
    `legal/DPA_PACK_OUTLINE.md` ("Data location: France"), `legal/SUBPROCESSORS.md`,
    `legal/ROPA.md`, and the other files of study §7, step 4;
  - the contract's `region` description, "French hosting is a product promise, not a setting.",
    replaced in the next contract version; its enumeration stays `fr-par` until a provider
    decision adds a value;
  - the live citations of ADR-0007 pointed at this record: `docs/specs/SLO.md` §4 (exclusions, force majeure)
    and `docs/specs/BACKUP_AND_RESTORE.md` §5. Changelog rows that cite ADR-0007 are history and
    stay as written.
- Core ADR-0013 and ADR-0014, both Proposed, keep their reading of ADR-0007 ("ADR-0007.
  Unchanged.") through the interim rule above; they are amended for the provider decision, not
  for this one.
- The Scaleway-specific clauses of accepted core ADR-0003 and ADR-0005 are not changed by this
  record. A provider decision that moves tenants supersedes or narrows them (study §7, step 2).
- Scaleway holds HDS certification and Hetzner does not (study §8); a move off Scaleway for a
  part of the service loses that path for that part. Customers who require it are answered by the
  decision that chooses the provider.
- Revisit when the measurement of HOSTING-MEASURE is recorded and the owner takes study §6,
  decision 1.

## References

- [ADR-0007](0007-france-only-data-residency.md), superseded by this record on acceptance
- [ADR-0014](0014-shared-tenant-environment-class.md), provider-specific rules
- `design specification` `plans/HOSTING_PROVIDER_STUDY.md` §6, §7 and §8; `plans/complete-mock/README.md`,
  rows HOSTING-EU and HOSTING-MEASURE
- `design specification` pull request #84, `legal/drafts/` (CGV article 4.4; DPA clauses 8 and 9, Annex C)
