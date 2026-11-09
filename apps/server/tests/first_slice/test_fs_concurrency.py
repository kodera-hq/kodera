"""R03 and R04 shared resources and external execution: FS-CON-01..06.

They follow accepted ADR-0004 and `docs/domain/JOB_CATALOGUE.md` §1: the organisation's realm is
changed only by its own `realm_create` or `realm_update` job, which holds the organisation lock
exclusively while tenant jobs hold it shared; every claim takes a higher `fence`; and an effect whose
outcome is unknown leaves the job in `needs_reconciliation`, never recovered automatically.
"""

from typing import Any

from first_slice_harness import InfrastructureAdapter, NonRetryableFailureError, scenario

# JOB_CATALOGUE.md §1: a claim's lease runs 120 seconds unless it is renewed.
LEASE_SECONDS = 120


@scenario("FS-CON-01")
def test_fs_con_01_compensation_removes_only_what_the_failed_provision_exclusively_owns(harness):
    h = harness
    catalogue = h.publish_catalogue()
    active = h.active_organisation("adopted")
    organisation_id = active.intake.organisation_id
    realm = active.intake.slug
    realm_job = h.read_operation(active.staff, active.intake.bootstrap["realm"]["job_id"])
    assert (realm_job["kind"], realm_job["status"]) == ("realm_create", "succeeded"), (
        "the realm must come from the intake's own realm_create job, before any provision"
    )
    provider = h.identity_provider()
    settings = provider.realm_settings(realm)
    tenants, jobs = [], []
    for label in ("failing", "adopting"):
        result = h.expect(
            h.place_order(active.owner, organisation_id, catalogue, label), 201, "placeOrder"
        )
        h.settle_order(result)
        job = h.expect(
            h.request_synthetic_provision(active.staff, result["tenant"]["id"]),
            202,
            "triggerTenantJob",
        )
        tenants.append(result["tenant"]["id"])
        jobs.append(job["id"])
    failed, survivor = tenants
    failed_job, survivor_job = jobs
    h.adapters.require_bound("infrastructure")
    with (
        h.fault_point(f"provision:{failed}:after-clients-created"),
        h.fault_point(f"provision:{survivor}:after-clients-created"),
    ):
        h.worker.run_until_idle()
        assert provider.client_exists(realm, failed) and provider.client_exists(realm, survivor), (
            "both provisions must have created their own clients before the failure"
        )
        # Past step 9, and only for the failing provision's correlation: a refusal no retry
        # changes, so the job fails instead of re-running the step.
        h.adapters.infrastructure.inject(
            "before-effect", NonRetryableFailureError, correlation=failed_job
        )
    h.worker.run_until_idle()
    assert h.read_operation(active.staff, failed_job)["status"] == "failed"
    assert h.read_operation(active.staff, survivor_job)["status"] == "succeeded"
    assert provider.realm_exists(realm)
    assert not provider.client_exists(realm, failed), (
        "compensation left the failed provision's own clients, which step 9 created"
    )
    assert provider.client_exists(realm, survivor), "compensation removed the sibling's clients"
    assert provider.realm_settings(realm) == settings, (
        "a provision changed the organisation's realm settings, which only a realm job may change"
    )

    with h.weakened("compensate-before-step-9-only"):
        result = h.expect(
            h.place_order(active.owner, organisation_id, catalogue, "uncompensated"),
            201,
            "placeOrder",
        )
        tenant = result["tenant"]["id"]
        job = h.expect(h.request_synthetic_provision(active.staff, tenant), 202, "triggerTenantJob")
        with h.fault_point(f"provision:{tenant}:after-clients-created"):
            h.worker.run_until_idle()
            h.adapters.infrastructure.inject(
                "before-effect", NonRetryableFailureError, correlation=job["id"]
            )
        h.worker.run_until_idle()
        assert h.read_operation(active.staff, job["id"])["status"] == "failed", (
            "the counterexample's provision did not fail, so its clients prove nothing about "
            "compensation"
        )
        assert provider.client_exists(realm, tenant), (
            "the weakening did not reach step 9's compensation, so this scenario cannot detect it"
        )


def _request(
    h: Any, staff: Any, kind: str, organisation_id: str, tenant_id: str, label: str
) -> str:
    """Request one job of `kind` and return its identifier: a realm change or a provision."""
    if kind == "realm_update":
        # The operations that enqueue a realm_update today answer `JobAccepted`, which names the
        # job `job_id`; `triggerTenantJob` answers the `Job` itself, whose identifier is `id`.
        response = h.request_realm_update(staff, organisation_id, key=h.key(f"realm/{label}"))
        assert response.status_code == 202, (
            f"the realm_update request answered {response.status_code}"
        )
        return str(response.json()["job_id"])
    accepted = h.expect(h.request_synthetic_provision(staff, tenant_id), 202, "triggerTenantJob")
    return str(accepted["id"])


def _assert_holds_its_organisation_lock(h: Any, staff: Any, job_id: str, kind: str) -> None:
    """The hold is observed, not inferred from the other job waiting: the held job is claimed and
    its organisation lock is reserved while the scenario looks at what waits behind it."""
    assert h.read_operation(staff, job_id)["status"] in {"leased", "running"}, (
        f"the {kind} held at the barrier is not claimed, so nothing is waiting behind its lock"
    )
    # JOB_CATALOGUE.md §1: realm jobs hold the organisation lock exclusively, provisions shared.
    mode = "exclusive" if kind == "realm_update" else "shared"
    assert (
        h.count(
            "JobLockReservation",
            job_id=job_id,
            lock_class="organisation",
            mode=mode,
            ended_at__isnull=True,
        )
        == 1
    ), f"the {kind} held at the barrier has no unended {mode} organisation lock reservation"


@scenario("FS-CON-02")
def test_fs_con_02_a_realm_change_and_a_provision_are_served_in_request_order_without_blocking_another_organisation(
    harness,
):
    h = harness
    catalogue = h.publish_catalogue()
    active = h.active_organisation("locks")
    other = h.other_org("independent")
    organisation_id = active.intake.organisation_id
    other_organisation_id = other.organisation.intake.organisation_id
    staff = active.staff
    for first, second in (("realm_update", "provision"), ("provision", "realm_update")):
        label = f"{first[0]}-first"
        order = h.expect(
            h.place_order(active.owner, organisation_id, catalogue, label), 201, "placeOrder"
        )
        tenant_id = order["tenant"]["id"]
        h.settle_order(order)
        # In request order: the exclusive realm change and the shared provision conflict on the
        # organisation lock, so whichever was requested first is served first (JOB_CATALOGUE §1).
        earlier = _request(h, staff, first, organisation_id, tenant_id, label)
        later = _request(h, staff, second, organisation_id, tenant_id, label)
        elsewhere = _request(
            h, other.staff, "realm_update", other_organisation_id, other.tenant_id, f"o-{label}"
        )
        with h.fault_point(f"job:{earlier}:after-locks-taken"):
            h.worker.run_until_idle()
            _assert_holds_its_organisation_lock(h, staff, earlier, first)
            assert h.read_operation(staff, later)["status"] == "queued", (
                f"the {second} requested after the {first} was claimed while that one held a "
                "conflicting organisation lock"
            )
            assert h.read_operation(other.staff, elsewhere)["status"] == "succeeded", (
                "a held organisation lock blocked another organisation's realm job"
            )
        h.worker.run_until_idle()
        for job_id in (earlier, later):
            assert h.read_operation(staff, job_id)["status"] == "succeeded", (
                f"the {first}-first order left a job unserved after its turn: a lost claim or a "
                "lost update"
            )

    with h.weakened("remove-organisation-resource-serialisation"):
        order = h.expect(
            h.place_order(active.owner, organisation_id, catalogue, "unserialised"),
            201,
            "placeOrder",
        )
        tenant_id = order["tenant"]["id"]
        provision = _request(h, staff, "provision", organisation_id, tenant_id, "unserialised")
        realm_change = _request(
            h, staff, "realm_update", organisation_id, tenant_id, "unserialised"
        )
        with h.fault_point(f"job:{provision}:after-locks-taken"):
            h.worker.run_until_idle()
            _assert_holds_its_organisation_lock(h, staff, provision, "provision")
            status = h.read_operation(staff, realm_change)["status"]
        assert status == "succeeded", (
            "the weakening did not reach organisation resource serialisation, so this scenario "
            "cannot detect it"
        )


@scenario("FS-CON-03")
def test_fs_con_03_a_superseded_claim_fence_cannot_record_or_dispatch(harness):
    h = harness
    staff = h.staff()
    intake = h.record_intake(staff, "fenced")
    job_id = intake.bootstrap["realm"]["job_id"]
    stale = h.worker.claim(job_id)
    # Python time only; the sweep compares database time. See the harness doc's Known limits.
    h.clock.advance(seconds=LEASE_SECONDS + 1)
    h.worker.sweep()
    assert h.read_operation(staff, job_id)["status"] == "orphaned", (
        "an expired claim that dispatched nothing must be swept to orphaned, not left leased"
    )
    current = h.worker.claim(job_id)
    assert current.fence > stale.fence
    assert stale.record_success() is False
    assert stale.dispatch_next_effect() is False
    assert current.record_success() is True
    assert h.read_operation(staff, job_id)["status"] == "succeeded"

    with h.weakened("allow-old-fence-dispatch"):
        unfenced = h.record_intake(staff, "unfenced").bootstrap["realm"]["job_id"]
        old = h.worker.claim(unfenced)
        h.clock.advance(seconds=LEASE_SECONDS + 1)
        h.worker.sweep()
        h.worker.claim(unfenced)
        assert old.dispatch_next_effect() is True, (
            "the weakening did not reach fence validation, so this scenario cannot detect it"
        )


@scenario("FS-CON-04")
def test_fs_con_04_lost_database_evidence_alone_never_unlocks_or_repeats_external_work(harness):
    h = harness
    world = h.ordered("lost-lease")
    h.adapters.require_bound("infrastructure")
    hold = h.adapters.infrastructure.hold("after-effect")
    with h.fault_point("worker:database-connection-lost"):
        h.worker.run_until_idle()
    assert hold.wait_reached()
    hold.release()
    assert len(h.adapters.infrastructure.effects("provision")) == 1
    job = h.read_operation(world.staff, world.job["id"])
    assert job["status"] == "needs_reconciliation"

    with h.weakened("force-unlock-on-database-lease-evidence-alone"):
        forced = h.ordered("forced-unlock")
        with h.fault_point("worker:database-connection-lost"):
            h.worker.run_until_idle()
        repeated = [
            effect
            for effect in h.adapters.infrastructure.effects("provision")
            if effect.correlation == forced.job["id"]
        ]
        assert len(repeated) == 2, (
            "the weakening did not reach the unlock rule, so this scenario cannot detect it"
        )


@scenario("FS-CON-05")
def test_fs_con_05_only_confirmed_absent_or_complete_outcomes_progress(harness):
    h = harness
    last = None
    for outcome in InfrastructureAdapter.OUTCOMES:
        world = h.ordered(f"uncertain-{outcome}")
        h.adapters.require_bound("infrastructure")
        job_id = world.job["id"]
        organisation_id = world.organisation.intake.organisation_id
        # The outcome is what the provider reports by correlation when the live runner, having
        # lost the response, seeks terminal proof under its own fence (JOB_CATALOGUE.md §1).
        h.adapters.infrastructure.set_outcome(job_id, outcome)
        before = len(h.adapters.infrastructure.effects("provision"))
        with h.fault_point("worker:provider-response-lost"):
            h.worker.run_until_idle()
        after = len(h.adapters.infrastructure.effects("provision"))
        job = h.read_operation(world.staff, job_id)
        entered = "job.reconciliation_required" in h.audit_actions(organisation_id)
        if outcome in {"absent", "complete"}:
            assert job["status"] == "succeeded", f"a confirmed {outcome} outcome did not progress"
            assert not entered, f"a confirmed {outcome} outcome entered needs_reconciliation"
            assert after - before == (2 if outcome == "absent" else 1), (
                f"a confirmed {outcome} outcome produced the wrong number of provider actions"
            )
        else:
            assert job["status"] == "needs_reconciliation", (
                f"a {outcome} outcome progressed without evidence"
            )
            assert entered, f"a {outcome} outcome entered needs_reconciliation without its event"
            h.worker.run_until_idle()
            assert h.read_operation(world.staff, job_id)["status"] == "needs_reconciliation", (
                f"a {outcome} outcome left needs_reconciliation without an operator's decision"
            )
            assert len(h.adapters.infrastructure.effects("provision")) == after, (
                f"a {outcome} outcome repeated the provider action"
            )
            for lock_class in ("organisation", "tenant"):
                assert (
                    h.count(
                        "JobLockReservation",
                        job_id=job_id,
                        lock_class=lock_class,
                        ended_at__isnull=True,
                    )
                    == 1
                ), f"a {outcome} outcome released its {lock_class} lock reservation"
        assert h.worker.reaped(job_id), "the locally owned subprocess was left running"
        last = world

    h.decision("external-execution-stop-evidence")
    assert last is not None
    h.operator_reconciliation(last.staff, last.job["id"])


@scenario("FS-CON-06")
def test_fs_con_06_desired_state_audit_and_job_commit_together_or_not_at_all(harness):
    h = harness
    staff = h.staff()
    h.api.require("createOrganisation")
    for boundary in ("after-desired-state", "after-audit", "after-job"):
        label = f"atomic-{boundary}"
        with h.fault_point(f"intake:{boundary}"):
            h.record_intake(staff, label)
        assert h.count("Organisation", slug=h.slug(label)) == 0
        assert h.count("AuditEvent", action="organisation.intake_recorded") == 0
        assert h.count("Job", kind="realm_create") == 0
        assert h.count("JobStep") == 0
    with h.fault_point("intake:after-commit"):
        h.record_intake(staff, "committed")
    assert h.count("Job", kind="realm_create", status="queued") == 1
    # JOB_CATALOGUE.md §1: the job's steps commit with it; realm_create has seven (§2).
    assert h.count("JobStep", job__kind="realm_create") == 7
    h.worker.run_until_idle()

    with h.weakened("drop-durable-job"):
        with h.fault_point("intake:after-commit"):
            h.record_intake(staff, "jobless")
        assert h.count("Job", kind="realm_create", status="queued") == 0, (
            "the weakening did not reach the durable job, so this scenario cannot detect it"
        )
