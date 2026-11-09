"""The realm-ready fact: docs/specs/REALM_DISCOVERY.md, FIRST_OWNER_BOOTSTRAP.md §5.4 (PC-8).

`complete_realm_bootstrap` writes the fact (`record_realm_ready`); `realm_ready` is how it is read.
The discovery route that will read it is not built yet; it reads it through this function, not
through the table.

The fact is written in its own transaction just before the queue's `finish_job(succeeded)`, which
refuses to run inside a caller's transaction. It therefore counts only while the `realm_create` job
it names is the organisation's latest and has succeeded: it begins to count in the transaction that
ends the job `succeeded`, and a fact whose job failed after it was written never counts. It is
withdrawn while the realm's issuer is absent from the trust list, or its entry has expired
(`issuer_untrusted`), and counts again once the entry is back; that is read, never written.
"""

from uuid import UUID

from django.db import transaction

from .bootstrap_selectors import counting_realm_ready
from .models import Organisation, RealmReadiness

REALM_JOB = "realm_create"


def record_realm_ready(*, organisation_id: UUID, job_id: UUID, recorded_by: UUID) -> UUID:
    """The fact for `job_id`, written once in its own transaction; a second call for the same job
    returns the first's id. The issuer and realm are the organisation's own."""
    with transaction.atomic():
        organisation = Organisation.objects.get(id=organisation_id)
        fact, _ = RealmReadiness.objects.get_or_create(
            job_id=job_id,
            defaults={
                "organisation_id": organisation.id,
                "issuer": organisation.issuer,
                "realm": organisation.realm,
                "recorded_by_identity_id": recorded_by,
            },
        )
    fact_id: UUID = fact.id
    return fact_id


def realm_ready(*, organisation_id: UUID) -> bool:
    """Whether the organisation's realm carries a counting realm-ready fact: one not revoked,
    naming the organisation's latest `realm_create` job, which has succeeded, with the
    organisation's issuer, while that issuer is on the trust list's customer lane and unexpired."""
    return counting_realm_ready(organisation_id=organisation_id)
