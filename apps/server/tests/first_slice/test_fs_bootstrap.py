"""R01 bootstrap and authority: FS-BOOT-01..07.

Each body is the scenario's Given/When/Then driven through the harness. The inventory records
where each is red today; nothing after that point has run against a real implementation yet.
"""

import threading

from first_slice_harness import problem_type, scenario

AUDIT_OF_BOOTSTRAP = {
    "organisation.intake_recorded",
    "owner_claim.consumed",
    "membership.created",
    "organisation.activated",
}


@scenario("FS-BOOT-01")
def test_fs_boot_01_intake_and_claim_leave_one_active_organisation_with_one_owner(harness):
    h = harness
    h.api.require("createOrganisation", "getOrganisationBootstrap", "consumeOwnerClaim")
    world = h.empty_customer()
    intake = h.record_intake(world.staff, "acme")
    h.worker.run_until_idle()
    status = h.read_bootstrap_status(world.staff, intake.organisation_id)
    owner = h.identities.with_second_factor(h.bound_owner(intake, status))
    token = h.adapters.claim_token(intake.intended_owner_email)
    h.expect(h.claim_first_owner(owner, token), 200, "consumeOwnerClaim")

    assert h.count("Organisation") == 1
    assert h.count("Organisation", pk=intake.organisation_id, state="active") == 1
    assert h.count("Membership", organisation_id=intake.organisation_id) == 1
    assert (
        h.count(
            "Membership",
            organisation_id=intake.organisation_id,
            role="org_owner",
            state="active",
            user__identity__subject=owner.subject,
        )
        == 1
    )
    assert h.count("Identity", issuer=world.staff.issuer) == 0, "staff gained a customer identity"
    assert AUDIT_OF_BOOTSTRAP <= set(h.audit_actions(intake.organisation_id))


@scenario("FS-BOOT-02")
def test_fs_boot_02_a_crash_at_each_bootstrap_boundary_resumes_without_manual_repair(harness):
    h = harness
    staff = h.staff()
    h.api.require("createOrganisation", "getOrganisationBootstrap")
    boundaries = (
        "intake:before-commit",
        "intake:after-commit-before-dispatch",
        "realm_create:after-provider-success-before-acknowledgement",
    )
    for index, boundary in enumerate(boundaries):
        label = f"crash{index}"
        key = h.key(label)
        with h.fault_point(boundary):
            h.record_intake(staff, label, key=key)
            h.worker.run_until_idle()
        if boundary == "intake:before-commit":
            assert h.count("Organisation", slug=h.slug(label)) == 0
        intake = h.record_intake(staff, label, key=key)
        status = h.read_bootstrap_status(staff, intake.organisation_id)
        assert status["realm"]["state"] in {"pending", "running", "unknown"}, (
            "a crash was reported as settled"
        )
        h.worker.run_until_idle()
        status = h.read_bootstrap_status(staff, intake.organisation_id)
        assert status["realm"]["state"] == "ready"
        assert status["identity_mapping"]["state"] == "ready"
        assert h.count("Organisation", slug=intake.slug) == 1
        assert h.count("Job", organisation_id=intake.organisation_id, kind="realm_create") == 1
        assert h.count("OwnerClaim", organisation_id=intake.organisation_id) == 1
        assert len(h.identity_provider().realms(intake.slug)) == 1
        assert len(h.identity_provider().subjects(intake.slug, intake.intended_owner_email)) == 1


@scenario("FS-BOOT-03")
def test_fs_boot_03_only_the_intended_subject_can_claim(harness):
    h = harness
    pending = h.owner_pending()
    elsewhere = h.owner_pending("elsewhere")
    realm = pending.intake.slug
    presenters = {
        "staff": pending.staff,
        "another subject in the same realm": h.identities.customer(realm, "colleague"),
        "a subject in another realm": elsewhere.owner,
        "an unknown identity": h.identities.untrusted(realm, "stranger"),
        "a matching email string only": h.identities.customer(
            realm, "lookalike", email=pending.intake.intended_owner_email
        ),
    }
    for name, presenter in presenters.items():
        credential = (
            presenter if presenter.lane == "staff" else h.identities.with_second_factor(presenter)
        )
        response = h.claim_first_owner(credential, pending.token, key=h.key(f"claim/{name}"))
        assert response.status_code in {401, 403, 404}, f"{name} was not refused"
        assert h.count("Membership", organisation_id=pending.intake.organisation_id) == 0, (
            f"refusing {name} created a membership"
        )

    owner = h.identities.with_second_factor(pending.owner)
    h.expect(h.claim_first_owner(owner, pending.token), 200, "consumeOwnerClaim")
    assert (
        h.count("Membership", organisation_id=pending.intake.organisation_id, role="org_owner") == 1
    )

    with h.weakened("bypass-first-owner-subject-binding"):
        bypassed = h.owner_pending("bypassed")
        lookalike = h.identities.with_second_factor(
            h.identities.customer(
                bypassed.intake.slug, "lookalike", email=bypassed.intake.intended_owner_email
            )
        )
        response = h.claim_first_owner(lookalike, bypassed.token)
        assert response.status_code == 200, (
            "the weakening did not reach subject binding, so this scenario cannot detect it"
        )


@scenario("FS-BOOT-04")
def test_fs_boot_04_an_expired_revoked_altered_or_consumed_claim_grants_nothing(harness):
    h = harness
    for state in ("expired", "revoked", "altered", "consumed"):
        pending = h.owner_pending(state)
        organisation_id = pending.intake.organisation_id
        owner = h.identities.with_second_factor(pending.owner)
        token = pending.token
        if state == "expired":
            status = h.read_bootstrap_status(pending.staff, organisation_id)
            h.clock.move_to(h.clock.now().fromisoformat(status["claim"]["expires_at"]))
            h.clock.advance(seconds=1)
        elif state == "revoked":
            h.revoke_claim(pending.staff, organisation_id)
        elif state == "altered":
            token = token[:-1] + ("A" if token[-1] != "A" else "B")
        elif state == "consumed":
            h.expect(
                h.claim_first_owner(owner, token, key=h.key("first")), 200, "consumeOwnerClaim"
            )

        response = h.claim_first_owner(owner, token, key=h.key(f"retry/{state}"))
        expected = {"expired": 410, "revoked": 410, "altered": 404, "consumed": 409}[state]
        assert response.status_code == expected, f"a {state} claim answered {response.status_code}"
        owners = 1 if state == "consumed" else 0
        assert h.count("Membership", organisation_id=organisation_id) == owners, (
            f"a {state} claim granted"
        )

        if state != "consumed":
            me = h.api.call("getMe", principal=pending.owner)
            assert me.status_code in {401, 403}, (
                "normal authentication exposed the prospect organisation"
            )
        accepted = h.api.call(
            "acceptInvitation",
            principal=pending.owner,
            body={"token": token},
            idempotency_key=h.key(f"invite/{state}"),
        )
        assert accepted.status_code in {400, 404, 422}, "an invitation path accepted an owner claim"
        assert h.count("Membership", organisation_id=organisation_id) == owners


@scenario("FS-BOOT-05")
def test_fs_boot_05_racing_claims_or_a_claim_against_revocation_commit_one_result(harness):
    h = harness
    pending = h.owner_pending("race")
    owner = h.identities.with_second_factor(pending.owner)
    first, second = h.race(
        lambda: h.claim_first_owner(owner, pending.token, key=h.key("a")),
        lambda: h.claim_first_owner(owner, pending.token, key=h.key("b")),
    )
    assert sorted([first.status_code, second.status_code]) == [200, 409]
    assert (
        h.count("Membership", organisation_id=pending.intake.organisation_id, role="org_owner") == 1
    )

    revoked = h.owner_pending("revocation-race")
    claimant = h.identities.with_second_factor(revoked.owner)
    lock = threading.Lock()
    outcomes: list[str] = []

    def claim() -> None:
        response = h.claim_first_owner(claimant, revoked.token)
        with lock:
            outcomes.append(f"claim:{response.status_code}")

    def revoke() -> None:
        h.revoke_claim(revoked.staff, revoked.intake.organisation_id)
        with lock:
            outcomes.append("revoke:done")

    h.race(claim, revoke)
    organisation_id = revoked.intake.organisation_id
    owners = h.count("Membership", organisation_id=organisation_id, role="org_owner")
    active = h.count("Organisation", pk=organisation_id, state="active")
    assert (owners, active) in {(1, 1), (0, 0)}, (
        "the race left an ownerless active organisation or a stray owner"
    )


@scenario("FS-BOOT-06")
def test_fs_boot_06_only_actual_provider_mfa_lets_the_claim_succeed(harness):
    h = harness
    h.decision("mfa-contact-proof-and-claim-delivery")
    pending = h.owner_pending("mfa")
    organisation_id = pending.intake.organisation_id
    without = h.claim_first_owner(pending.owner, pending.token, key=h.key("no-factor"))
    assert without.status_code == 403 and problem_type(without) == "mfa-required"
    forged = h.api.call(
        "consumeOwnerClaim",
        principal=pending.owner,
        body={"token": pending.token},
        idempotency_key=h.key("forged"),
        headers={"cookie": "enrolment=complete; mfa=verified"},
    )
    assert forged.status_code == 403 and problem_type(forged) == "mfa-required"
    assert h.count("Membership", organisation_id=organisation_id) == 0

    owner = h.identities.with_second_factor(pending.owner)
    h.expect(h.claim_first_owner(owner, pending.token), 200, "consumeOwnerClaim")
    assert h.count("Membership", organisation_id=organisation_id, role="org_owner") == 1


@scenario("FS-BOOT-07")
def test_fs_boot_07_staff_intake_cannot_sign_for_the_customer_or_become_its_member(harness):
    h = harness
    active = h.active_organisation("guarded")
    staff = active.staff
    attempts = {
        "sign-dpa": {"dpa_acceptance": {"dpa_id": h.key("dpa"), "accepted": True}},
        "sign-terms": {"terms_acceptance": {"version": "synthetic", "accepted": True}},
        "nominate-staff": {"membership": {"role": "org_owner", "email": staff.email}},
    }
    for label, extra in attempts.items():
        response = h.api.call(
            "createOrganisation",
            principal=staff,
            body=h.intake_body(label, **extra),
            idempotency_key=h.key(f"guarded/{label}"),
        )
        assert response.status_code == 422 and problem_type(response) == "validation-error", label
    denied = h.api.call(
        "acceptDpa",
        principal=staff,
        path={"organisation_id": active.intake.organisation_id, "dpa_id": h.key("dpa")},
        body={"accepted": True},
        idempotency_key=h.key("staff-accepts-dpa"),
    )
    assert denied.status_code in {403, 404}
    assert "authz.denied" in h.audit_actions(active.intake.organisation_id)
    assert h.count("Membership", organisation_id=active.intake.organisation_id) == 1
    assert h.count("DpaAcceptance", organisation_id=active.intake.organisation_id) == 0
