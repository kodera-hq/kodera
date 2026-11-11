# Default community workspace

Status: Implemented

## Operator preparation

Apply migrations with the migration role. Configure the exact public trusted
community issuer in `KODERA_AUTH_TRUST`, then set:

- `KODERA_DEFAULT_COMMUNITY_ORG_SLUG=community`
- `KODERA_DEFAULT_COMMUNITY_ISSUER=https://identity.example.test/realms/community`
- `KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID` to the existing enabled owner's person UUID.

Run `python manage.py bootstrap_community_workspace`. Alternatively pass the
owner UUID using `--owner-user-id`. First creation requires a real existing owner;
there is no synthetic administrator. Repeated runs preserve IDs and explicit
partner grants. Drift in canonical category visibility or channel category, kind,
lifecycle or policy mode fails with an operator-reconciliation error; bootstrap
does not silently accept a public private-room policy or alter custom resources.
Bootstrap also creates the canonical `community` Tenant with `apps=[messaging]`
and status `provisioning`. It never claims a homeserver is live. After the
operator verifies Synapse SSO, membership reconciliation and channel acknowledgements,
list its real ID with `python manage.py tenant_status --settings
config.settings.deploy_operator list`, enroll the agent with that `--tenant` ID,
and promote it using `python manage.py tenant_status --settings
config.settings.deploy_operator set --staff-identity <operator-identity>
--tenant <tenant-id> --to active --reason "Community backend acceptance verified"`.
The existing audited command requires a current staff operator grant. Until then
the web workspace stays in provisioning. The canonical tenant list admits current
community members from their actual issuer; all other tenant lists retain isolation.

The command queues membership and channel sets; the enrolled
tenant agent must acknowledge real rooms before messaging is ready.

The Community category contains announcements, general, developers-community,
support, extensions, self-hosting, show-and-tell and the office-hours audio room.
Announcements allows member history and reactions while posts require an
administrator. Core Kodera includes the private `kodera-git-tracker` channel for
operator-configured verified provider activity. Core Kodera is explicitly granted to community owners/admins;
Design Partners starts with no member grants. Assign partner access explicitly.

## Account and API verification

Verify a canonical-realm signup with `email_verified=true` and the email scope.
GET `/api/v1/me` materializes the new identity and its community membership.
Existing enabled customer and staff identities get the same membership at profile
bootstrap. Other tenant grants remain bound to their own issuer. Staff identities
receive no automatic community administrator grant.

POST `/api/v1/community/support/tickets` accepts the existing
`SupportTicketCreateRequest` and an `Idempotency-Key`. Omit `tenant_id` and normally
`organisation_id`. The response contains `id`, `state`, `priority`, `queue`, and
`confirmation=\"ticket-created\"`. Five tickets per person per rolling hour is the
limit. Replays are authorized against current membership before returning a
stored response. Existing support triage and mail commands process these tickets;
configure and operate that queue before inviting public users.

For an existing person's separate canonical-realm account, verify control of both
accounts and run `python manage.py bind_community_identity --user-id <person-uuid>
--subject <community-realm-subject>`. Never infer this binding from matching email.
The command queues the exact subject in engine membership. Without a proven
binding, cross-realm users have API support access but must authenticate their
canonical realm account for Matrix; automatic broker linking is a cutover gate.

## Rollback

Unset the default-community slug to stop automatic membership and the cross-issuer
exception. Retain the rows and memberships for audit and recovery. Restore the
previous image only with a schema-compatible release; do not reverse the reserved
slug migration while the canonical community row exists. Suspend membership to
revoke community access; login never revives it.
