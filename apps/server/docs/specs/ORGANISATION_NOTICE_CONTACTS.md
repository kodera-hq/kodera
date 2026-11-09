# Organisation notice contacts

**Status:** Proposed · **Owner:** API seat

The data processing agreement (the standard Kodera Data Processing Agreement)
sends two kinds of notice to the addresses its Annex D lists:

- a personal-data breach notification, to the security contacts and the data protection officer
  (clause 11.6);
- prior information of a sub-processor change, to its own recipients (clause 8.2).

This document gives an organisation the three addresses Annex D names, set by its owners, and says
who receives a notice when they are not set.

## 1. Facts

Three nullable columns on `orgs_organisation`:

| Field | Annex D row |
|---|---|
| `security_contact_email` | Security contact, a recipient of breach notifications (11.6) |
| `privacy_contact_email` | Data protection officer or privacy lead, a recipient of breach notifications (11.6) |
| `subprocessor_notice_email` | Recipient of sub-processor change information (8.2) |

An address must be one the outbox sender would deliver to (`apps/outbox/sender.py`,
`check_recipient`): a conservative ASCII address with a local part of at most 64 characters, 254 at
most in all. An address Django accepts but the sender refuses, such as a quoted local part, an
international domain or an IP literal, is refused, because a notice to it could never be sent. A test
keeps the two rules equal. The database also refuses a value outside 3 to 254 characters or without
`@`.

**Recipients.** `notice_recipients(organisation_id, kind)` answers:

- `breach`: the security and privacy addresses that are set, in that order;
- `subprocessor`: the sub-processor address, if set.

When none is set for that kind, it answers the current owners' addresses instead: active, accepted
`org_owner` memberships of enabled people, in membership id order, read in pages. An absent or
deleted organisation gets nothing. So does an organisation with no current owner whose person is
enabled: the database's owner guard counts memberships, not enabled people. An empty answer means
nobody can be told, and the sender must escalate to an operator rather than skip the notice. Whatever
sends a DPA notice asks this function; nothing sends one yet.

**Trust model.** The addresses are the customer's own designation: the agreement makes the
controller responsible for keeping them current (11.6), and any owner may set any deliverable
address, outside the organisation's domains too. Every change is audited (§3). Telling the other
owners about a change by mail is a follow-up for when the notice mails exist. A designated address
stays in force when the owner who set it leaves; another owner changes it.

## 2. Operations

A sub-resource of the organisation, so that these legal contacts have their own owner-only write
and do not wait for `patchOrganisation`, which Core does not serve yet.

| Operation | Roles | Answer |
|---|---|---|
| `GET /organisations/{organisation_id}/notice-contacts` (`getNoticeContacts`, `organisation:read`) | `org_owner`, `org_admin` | `200 NoticeContacts` with a strong `ETag` |
| `PATCH` same path (`patchNoticeContacts`, `organisation:update`), `application/merge-patch+json`, `If-Match` required | `org_owner` | `200 NoticeContacts` with the new `ETag` |

- `NoticeContacts` carries the three stored values, null when unset. Each comes with a
  `*_defaults_to_owners` boolean that is true exactly when the value is null, so the Console can say
  who receives the notice without guessing.
- The body is an object with only those three members, each a deliverable address or `null`
  (clear), as UTF-8 within the server's body limit. Anything else is `400 malformed-request`. A body
  that changes nothing answers `200` and writes nothing.
- The `ETag` is `sha256` over the canonical JSON of the organisation id and the three values.
- PATCH requires `If-Match`: missing is `428`, stale is `412` with `current_etag`.
- The caller resolves through `read_tenant_caller`, so the issuer binds the organisation. Another
  organisation answers `404`.
- `org_admin` reads but does not write. `org_billing`, `org_member` and staff tokens are `403`.
- A suspended organisation reads; it does not write (`403`), as for memberships.
- The write locks the organisation row `FOR NO KEY UPDATE` with `lock_timeout = 1s`, under the connection's 2-second
  statement timeout,, then resolves
  the caller again before comparing the tag. A lock held past the timeout answers
  `503 service-unavailable` with `Retry-After: 1`, and nothing changes.
- Each write advances the organisation's `authority_revision` through its existing trigger, as every
  organisation update does ([`member-authority-revision.md`](member-authority-revision.md)).

## 3. Audit

- **Change:** one `organisation.updated` row per successful change. The actor is the owner's
  identity and the target `urn:kodera:organisation:{slug}`. `before` and `after` name only the
  changed fields, each as `"set"` or `null`, never the address: AUDIT_TAXONOMY.md §4 keeps email
  addresses out of the trail.
- **Refusal:** every refused PATCH writes `authz.denied` (scope `organisation:update`) in its own
  transaction, and so does every refused staff read (AUTHZ §9). The reason is `role_missing`, the
  closed list's only fit, also for a suspended organisation. A refused tenant read is not recorded,
  so a reader cannot fill the trail by repeating it.

## 4. Contract and grants

- Contract 0.19.0, additive: the path, its two operations (PATCH with its `503`), and the schemas
  `NoticeContacts` and `NoticeContactsPatchRequest`.
- `dev/api_writer_role.py` gains `UPDATE` on the three columns and on `orgs_organisation.updated_at`.
- The image ships the three new modules.

## 5. Acceptance

`tests/test_organisation_notice_contacts.py`, against PostgreSQL:

- **Reads:** an owner and an admin read the unset defaults. Billing, member and staff get `403`;
  only staff is recorded. Another organisation is `404`.
- **Writes:**
  - an owner sets, changes and clears each address; each change writes one audit row with `"set"`
    or `null` and no address, and the tag changes;
  - an admin is `403` and recorded;
  - missing `If-Match` is `428`; a stale tag is `412` with `current_etag`;
  - a lock held past the timeout is `503`, with nothing changed;
  - bad bodies are `400`: wrong type, unknown member, non-UTF-8, oversize, and addresses the
    sender would refuse (quoted, international, IP literal, lone surrogate, local part over 64);
  - a no-op writes nothing;
  - a suspended organisation is `403`.
- **Recipients:**
  - breach goes to the security and DPO addresses, and sub-processor changes to theirs;
  - each falls back to the active owners, skipping suspended and disabled ones;
  - an absent or deleted organisation gets nothing.
- **Rule:** the address rule agrees with the outbox sender's on a sample set.
- **Grants:** the writer role serves both operations.
