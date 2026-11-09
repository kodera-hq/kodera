# ADR-0005: Tenant projects are bootstrapped through a human-controlled boundary

**Status:** Accepted
**Deciders:** zôÖma

## Context

The provisioning worker is intentionally limited to one tenant project at a
time. That restriction cannot create the project or the first IAM application,
policy and API key inside it.

Scaleway API keys are associated with a user or application at organisation
scope and inherit policy permissions. Project creation requires an
organisation-scoped permission such as `ProjectManager`; generating keys for an
application requires IAM administration. `IAMManager` is especially sensitive:
it can create policies that grant broader access. Calling the resulting key
"project-scoped" describes its policy, not the key's account scope.

Giving those organisation capabilities to the internet-facing API or the
general provisioning worker would turn either compromise into organisation
takeover. Pretending that the first project-scoped key can mint itself would
leave the root of trust undefined.

## Decision

### Initial commercial operation

Tenant project bootstrap is a separate, human-controlled operation:

1. Core creates an audited bootstrap request for an `ordered` tenant. The
   tenant remains `ordered` while bootstrap is pending.
2. A named operator authenticates to Scaleway with a personal account and
   mandatory MFA, then creates the project, IAM application, policy restricted
   to that project, and an expiring application API key.
3. The secret value is written directly through the approved one-job secret
   injection path. It MUST NOT enter Core, a repository, a ticket, a terminal
   transcript or a job payload. The injection design and its failure test are a
   blocking specification before the first real provider call.
4. Core records only provider identifiers, the access-key fingerprint, policy
   digest, expiry, operator, evidence reference and secret reference.
5. A verification step proves that the application can perform the declared
   tenant actions and that an operation outside the tenant project is denied.
   Provisioning cannot start on a missing, expired or wider policy.
6. The worker loads that tenant-policy-scoped credential for one job, drops it
   when the job exits and records expiry or revocation evidence.

Policy templates are reviewed code in `deployment operations`, but organisation-level
credentials, key values and owner sessions never enter that repository.

The existing `provision` job begins with verification of an accepted bootstrap;
it does not create a project or organisation-scoped IAM objects.

### Future automation

Unattended project creation requires a dedicated allocator as a separate
runtime, release unit, credential store and audit boundary. It MUST NOT share a
process, filesystem, deployment identity or database credential with the Core
API or tenant provisioning worker.

The allocator remains blocked until all of the following are reviewed:

- its own threat model and data-flow diagram;
- the minimum provider permission sets and resource conditions;
- credential custody, rotation and break-glass procedure;
- idempotent project allocation and safe empty-project reclamation;
- an approval policy for allocation, policy-template change and deletion;
- an integration test proving it cannot read or mutate tenant resources;
- alerts for any IAM action outside a live bootstrap job.

Automating a human click without satisfying these gates is not an incremental
implementation of this ADR; it requires a superseding decision.

## Options considered

| Option | Decision |
|---|---|
| Put an organisation-level key in the Core API | Rejected. An internet-facing application compromise becomes organisation takeover. |
| Put an organisation-level key in the provisioning worker | Rejected. A malicious job or profile can mint broader policies and escape every tenant boundary. |
| Keep a permanent pool of pre-created empty projects | Deferred. It reduces runtime privilege but creates inventory, quota, key-rotation and safe-reclamation problems before demand justifies it. |
| Human-controlled bootstrap, then a tenant-policy-scoped worker key | Chosen for the initial stage. It makes the privileged step visible and keeps provider automation behind one tenant boundary. |
| Dedicated automated allocator | Target architecture after its separate security gate. |

## Consequences

- Initial onboarding includes an explicit operator step and cannot be described
  as unattended.
- The console needs a visible bootstrap-pending state under `ordered`; it must
  not imply the tenant is already provisioning.
- A failed or expired bootstrap is recoverable by replacing the key and evidence
  without recreating the order.
- The provider boundary is auditable, but the one-job secret-injection
  specification remains a blocking implementation task.
- Provider language in specs must distinguish organisation-scoped API keys from
  policies restricted to one project.

## References

- [Scaleway: create API keys](https://www.scaleway.com/en/docs/iam/how-to/create-api-keys/)
- [Scaleway: permission sets](https://www.scaleway.com/en/docs/iam/reference-content/permission-sets/)
- [Scaleway: reproduce project-scoped API keys with IAM](https://www.scaleway.com/en/docs/iam/reference-content/reproduce-roles-project-api-keys/)
