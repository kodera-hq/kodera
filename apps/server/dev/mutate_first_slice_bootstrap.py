"""Prove the FS-BOOT packet cannot be weakened, in disposable copies, by the exact message.

Each mutation is a plausible weakening of the driver, of the runner's admission of it, or of the
sensitivity checks that qualify the verdicts. Each must be caught by one named counterexample, and
a control that must stay intact proves the mutation was surgical rather than a broken copy. A
mutation whose anchor no longer matches refuses by name rather than aborting the run. Nothing here
touches the shared tree, and no mutation runs the Docker-backed measurement: these qualify the
guards, not the services.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections.abc import Sequence
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COPIED = [
    "Makefile",
    "pyproject.toml",
    "contracts/core-api.openapi.yaml",
    "dev/__init__.py",
    "dev/accept_first_slice.py",
    "dev/first_slice_bootstrap.py",
    "dev/first_slice_manifest.json",
    "dev/identity_fixture.py",
    "dev/accept_runtime.py",
    "services/__init__.py",
    "services/identity/__init__.py",
    "services/identity/access_tokens.py",
    "tests/test_first_slice_bootstrap.py",
    "dev/mutate_first_slice_bootstrap.py",
]
SUITE = "tests/test_first_slice_bootstrap.py"


def targets_of(target: str | Sequence[str]) -> tuple[str, ...]:
    """The files one weakening edits. A weakening may cross two files; most edit one."""
    return (target,) if isinstance(target, str) else tuple(target)


def stale_anchors(sources: dict[str, str], changes: list[tuple[str, str]]) -> list[str]:
    """The anchors of one weakening that the files it names no longer carry exactly once."""
    return [old for old, _ in changes if sum(source.count(old) for source in sources.values()) != 1]


def refusal(name: str, target: str | Sequence[str], detail: str) -> dict[str, object]:
    """A weakening that qualified nothing, as a named row rather than a raised traceback."""
    return {
        "mutation": name,
        "file": list(targets_of(target)),
        "caught": False,
        "control_passed": False,
        "refusal": detail,
    }


# The permutation weakening below crosses two files, so its anchors are named here rather
# than inline: the two exchanged subject rows, and the two cross-wired flip conditions.
SUBJECTS_02_03 = (
    '    "FS-BOOT-02": Subject(\n'
    "        dimension=(\n"
    '            "a replayed intake carrying the same Idempotency-Key, the bootstrap-status operation "\n'
    '            "and the Job, OutboxDelivery and IdempotencyRecord records"\n'
    "        ),\n"
    '        probes=("intake", "intake_replay", "bootstrap_status"),\n'
    '        records=("Job", "OutboxDelivery", "IdempotencyRecord"),\n'
    "    ),\n"
    '    "FS-BOOT-03": Subject(\n'
    "        dimension=(\n"
    '            "the five wrong presenters of a claim, the positive control, and an authentication "\n'
    '            "class that resolves a verified (iss, sub) to an Identity"\n'
    "        ),\n"
    "        probes=(\n"
    '            "claim_staff",\n'
    '            "claim_other_subject",\n'
    '            "claim_other_realm",\n'
    '            "claim_unknown",\n'
    '            "claim_email_match",\n'
    '            "claim_consume",\n'
    "        ),\n"
    "        authenticated=True,\n"
    "    ),\n"
)

PERMUTED_SUBJECTS_02_03 = (
    '    "FS-BOOT-02": Subject(\n'
    "        dimension=(\n"
    '            "the five wrong presenters of a claim, the positive control, and an authentication "\n'
    '            "class that resolves a verified (iss, sub) to an Identity"\n'
    "        ),\n"
    "        probes=(\n"
    '            "claim_staff",\n'
    '            "claim_other_subject",\n'
    '            "claim_other_realm",\n'
    '            "claim_unknown",\n'
    '            "claim_email_match",\n'
    '            "claim_consume",\n'
    "        ),\n"
    "        authenticated=True,\n"
    "    ),\n"
    '    "FS-BOOT-03": Subject(\n'
    "        dimension=(\n"
    '            "a replayed intake carrying the same Idempotency-Key, the bootstrap-status operation "\n'
    '            "and the Job, OutboxDelivery and IdempotencyRecord records"\n'
    "        ),\n"
    '        probes=("intake", "intake_replay", "bootstrap_status"),\n'
    '        records=("Job", "OutboxDelivery", "IdempotencyRecord"),\n'
    "    ),\n"
)

VERDICT_02_FLIP = (
    "    missing = observation.absent_records(DURABLE_RECORDS)\n"
    '    if observation.served("intake", "intake_replay", "bootstrap_status") and not missing:\n'
    '        raise WouldPassError("FS-BOOT-02")\n'
)

PERMUTED_VERDICT_02_FLIP = (
    "    missing = observation.absent_records(DURABLE_RECORDS)\n"
    '    swapped = ("claim_staff", "claim_other_subject", "claim_other_realm", "claim_unknown")\n'
    '    if observation.served(*swapped, "claim_email_match", "claim_consume") and (\n'
    "        observation.authenticators\n"
    "    ):\n"
    '        raise WouldPassError("FS-BOOT-02")\n'
)

VERDICT_03_FLIP = (
    '    if observation.served(*wrong, "claim_consume") and observation.authenticators:\n'
    '        raise WouldPassError("FS-BOOT-03")\n'
)

PERMUTED_VERDICT_03_FLIP = (
    '    if observation.served("intake", "intake_replay", "bootstrap_status") and not (\n'
    "        observation.absent_records(DURABLE_RECORDS)\n"
    "    ):\n"
    '        raise WouldPassError("FS-BOOT-03")\n'
)


# The same permutation, respelled through the read paths a `dict` or `tuple` subclass could not
# see: `probes.setdefault(name)` in place of `observation.probe(name)`, and
# `models.count(name) == 0` in place of `absent_records(...)`. Both are ordinary Python, both
# behave identically against the real measured observation, and neither touched a single
# override of the watch this packet used to instrument with.
BYPASSING_VERDICT_02_FLIP = (
    "    missing = tuple(name for name in DURABLE_RECORDS if observation.models.count(name) == 0)\n"
    '    swapped = ("claim_staff", "claim_other_subject", "claim_other_realm", "claim_unknown")\n'
    "    if all(\n"
    '        observation.probes.setdefault(name, {"routed": False})["routed"]\n'
    '        for name in (*swapped, "claim_email_match", "claim_consume")\n'
    "    ) and observation.authenticators:\n"
    '        raise WouldPassError("FS-BOOT-02")\n'
)

# The permutation carried through to the published prose as well, so that every probe the
# cross-wired verdict names is one its swapped subject declares. The only tell left is which
# records it counted, which is what a watch narrowed to the probes mapping would not see.
COUNTING_VERDICT_02_FLIP = (
    "    missing = tuple(name for name in DURABLE_RECORDS if observation.models.count(name) == 0)\n"
    '    swapped = ("claim_staff", "claim_other_subject", "claim_other_realm", "claim_unknown")\n'
    '    if observation.served(*swapped, "claim_email_match", "claim_consume") and (\n'
    "        observation.authenticators\n"
    "    ):\n"
    '        raise WouldPassError("FS-BOOT-02")\n'
)

VERDICT_02_PROSE = (
    '    first, replay = observation.probe("intake"), observation.probe("intake_replay")\n'
)

PERMUTED_VERDICT_02_PROSE = (
    '    first, replay = observation.probe("claim_staff"), '
    'observation.probe("claim_other_subject")\n'
)

VERDICT_02_STATUS_PROSE = "observation.probe('bootstrap_status')['url']"

PERMUTED_VERDICT_02_STATUS_PROSE = "observation.probe('claim_consume')['url']"


# (name, file or files, [(anchor, replacement)], counterexample, expected message, control)
# Each anchor must appear exactly once across the files the weakening names, and is applied to
# the one that carries it; a weakening that crosses two files states both.
MUTATIONS = [
    (
        # 1. A case starts passing without the behaviour existing. Both anchors, because the
        #    packet refuses an unadmitted status twice: once on the row and once on the roll-up,
        #    and a weakening that left either standing would be caught by the survivor.
        "case-reports-a-pass",
        "dev/accept_first_slice.py",
        [
            (
                '    if value not in {"failed", "blocked"}:\n'
                '        raise AdmissionError("bootstrap_status_not_admitted")\n'
                "    return str(value)",
                "    return str(value)",
            ),
            (
                "    if status not in STATUSES:\n"
                '        raise AdmissionError("bootstrap_status_not_admitted")\n'
                "    return STATUSES.index(status)",
                "    return STATUSES.index(status) if status in STATUSES else 0",
            ),
        ],
        "test_a_status_outside_failed_or_blocked_blocks_the_whole_run[passed]",
        "a driver status outside failed or blocked must block the run, not be relayed",
        "test_without_a_driver_the_bootstrap_cases_stay_not_implemented",
    ),
    (
        # 2. A driven case is downgraded from `failed` to `not_implemented`.
        "status-downgraded-to-not-implemented",
        "dev/accept_first_slice.py",
        [
            (
                '"status": observed.get(name, {}).get("status", "not_implemented"),',
                '"status": "not_implemented",',
            )
        ],
        "test_a_driver_report_is_carried_through_and_rolls_the_status_up",
        "a driven case reported failed must not be downgraded in the roll-up",
        "test_without_a_driver_the_bootstrap_cases_stay_not_implemented",
    ),
    (
        # 3. One of the seven is dropped from the selection.
        "one-of-the-seven-dropped",
        "dev/accept_first_slice.py",
        [
            (
                "        ]\n        != driven_cases\n    ):",
                "        ]\n        != driven_cases[: len(rows)]\n    ):",
            )
        ],
        "test_a_driver_that_drops_one_of_the_seven_blocks_the_whole_run",
        "a driver that drops one of the seven must block the run, not report six",
        "test_a_driver_report_is_carried_through_and_rolls_the_status_up",
    ),
    (
        # 4. An assertion weakened to something the absent behaviour also satisfies: a
        #    404 from an application with no product at all is "not a 201", forever.
        "assertion-weakened-to-not-created",
        "dev/first_slice_bootstrap.py",
        [
            (
                "    missing = observation.absent_records(INTAKE_RECORDS + CLAIM_RECORDS)\n"
                '    if observation.served("intake", "bootstrap_status", "claim_consume") '
                "and not missing:\n"
                '        raise WouldPassError("FS-BOOT-01")',
                "    missing = observation.absent_records(INTAKE_RECORDS + CLAIM_RECORDS)\n"
                '    if observation.probe("intake")["status"] == 201:\n'
                '        raise WouldPassError("FS-BOOT-01")',
            )
        ],
        "test_no_case_stays_red_once_its_behaviour_is_present[FS-BOOT-01]",
        "still reports red against an observation where its behaviour is present",
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-01]",
    ),
    (
        # 5. The unexercised second factor is claimed as exercised: FS-BOOT-06 reported
        #    `failed` as though the provider's MFA had been driven and merely not honoured.
        "blocked-mfa-claimed-as-driven",
        "dev/first_slice_bootstrap.py",
        [('    if not identity.get("second_factor"):', "    if False:")],
        "test_the_mfa_case_is_blocked_while_no_second_factor_is_observed",
        "FS-BOOT-06 must be blocked while no second factor is observed",
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-06]",
    ),
    (
        # 6. The reviewed operation is assumed rather than read, so a contract that moved
        #    or dropped it leaves the harness driving a path nobody agreed to.
        "operation-assumed-not-read",
        "dev/first_slice_bootstrap.py",
        [
            (
                "    raise BlockedError(\n"
                '        f"contract-missing-operation:{operation_id} is not in {CONTRACT}; "\n'
                '        "the specification and the executable contract disagree"\n'
                "    )",
                "    return {\n"
                '        "operation_id": operation_id,\n'
                '        "method": "POST",\n'
                '        "path": "/organisations",\n'
                '        "roles": ("staff_operator",),\n'
                '        "scope": "organisation:create",\n'
                "    }",
            )
        ],
        "test_a_contract_that_no_longer_carries_an_operation_blocks_rather_than_guesses",
        "the reviewed operation must be read from the contract, not assumed",
        "test_each_reviewed_operation_is_read_from_the_contract[createOrganisation]",
    ),
    (
        # 7. `decide` swallows the WouldPassError a working slice would raise — the plausible
        #    future "fix" for the traceback a real implementation produces. It leaves every
        #    test and every mutation above green while making all seven cases permanently red.
        "decide-swallows-would-pass",
        "dev/first_slice_bootstrap.py",
        [
            (
                "    except BlockedError as blocked:\n"
                '        return {"id": case, "status": "blocked", '
                '"observed_assertions": [str(blocked)]}\n',
                "    except BlockedError as blocked:\n"
                '        return {"id": case, "status": "blocked", '
                '"observed_assertions": [str(blocked)]}\n'
                "    except WouldPassError:\n"
                '        return {"id": case, "status": "failed", '
                '"observed_assertions": ["behaviour present"]}\n',
            )
        ],
        "test_decide_lets_would_pass_out_rather_than_publishing_a_row[FS-BOOT-01]",
        "instead of letting WouldPassError out",
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-01]",
    ),
    (
        # 8. `served` accepts any one probe instead of all of them, so a case stops reading
        #    most of the operations it names. Invisible against two uniform poles.
        "served-satisfied-by-any-one-probe",
        "dev/first_slice_bootstrap.py",
        [
            (
                '        return all(self.probe(name)["routed"] for name in names)',
                '        return any(self.probe(name)["routed"] for name in names)',
            )
        ],
        "test_every_input_a_case_names_is_load_bearing_on_its_own[FS-BOOT-01-probe-intake]",
        "The verdict never reads that probe",
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-01]",
    ),
    (
        # 9. A verdict rekeyed to the harness's own identity fixture: FS-BOOT-04 would stop
        #    being red the moment a realm with an OTP policy is added, with no product code.
        "verdict-keyed-on-the-identity-fixture",
        "dev/first_slice_bootstrap.py",
        [
            (
                "    if observation.served(*states) and not missing:\n"
                '        raise WouldPassError("FS-BOOT-04")',
                '    if observation.identity.get("second_factor"):\n'
                '        raise WouldPassError("FS-BOOT-04")',
            )
        ],
        "test_no_case_stops_being_red_for_another_cases_behaviour[FS-BOOT-04-on-FS-BOOT-06]",
        "keyed on a dimension FS-BOOT-04 is not about",
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-04]",
    ),
    (
        # 10. A verdict rekeyed to another case's dimension: FS-BOOT-07 answering the
        #     authentication class FS-BOOT-03 is about, and nothing about its own intake.
        "verdict-keyed-on-another-cases-dimension",
        "dev/first_slice_bootstrap.py",
        [
            (
                "    if (\n"
                '        observation.served("intake_signs_dpa", "intake_names_membership")\n'
                "        and refused\n"
                "        and not missing\n"
                "    ):\n"
                '        raise WouldPassError("FS-BOOT-07")',
                '    if observation.authenticators:\n        raise WouldPassError("FS-BOOT-07")',
            )
        ],
        "test_no_case_stops_being_red_for_another_cases_behaviour[FS-BOOT-07-on-FS-BOOT-03]",
        "keyed on a dimension FS-BOOT-07 is not about",
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-07]",
    ),
    (
        # 10b. FS-BOOT-07 lifted by a routed intake alone, whatever it answered: an
        #      unauthenticated probe is refused before its body is read, so routing is not the
        #      validation refusal the scenario is about.
        "verdict-satisfied-by-routing-alone",
        "dev/first_slice_bootstrap.py",
        [("        and refused\n", "")],
        "test_a_routed_intake_that_never_reached_its_refusal_keeps_fs_boot_07_red",
        "a routed intake that refused nothing let FS-BOOT-07 pass",
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-07]",
    ),
    (
        # 11. A verdict rekeyed to the harness's own positive control, which is identical in
        #     every observation: FS-BOOT-05 would then be a function of the harness, not the
        #     product, and would report the same thing whatever anybody implemented.
        "verdict-keyed-on-the-harness-race-control",
        "dev/first_slice_bootstrap.py",
        [
            (
                '    if observation.served("claim_race_a", "claim_race_b") '
                'and "Organisation" in observation.models:\n'
                '        raise WouldPassError("FS-BOOT-05")',
                '    if race.get("attempted", 0) == 2 and race.get("committed") == 1:\n'
                '        raise WouldPassError("FS-BOOT-05")',
            )
        ],
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-05]",
        "keyed on something no case is about",
        "test_the_seven_subjects_together_are_the_whole_implemented_pole",
    ),
    (
        # 12. The subject table trimmed until the sensitivity tests pass — the weakening the
        #     sensitivity tests would otherwise invite, since they read that table.
        "subject-table-trimmed-to-fit",
        "tests/test_first_slice_bootstrap.py",
        [
            (
                '        records=("Organisation", "Intake", "AuditEvent", "OwnerClaim", '
                '"Membership"),',
                '        records=("Organisation", "OwnerClaim", "Membership"),',
            )
        ],
        "test_the_seven_subjects_together_are_the_whole_implemented_pole",
        "no case claims these as its subject",
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-01]",
    ),
    (
        # 13. The subject table permuted between two cases: FS-BOOT-02's and FS-BOOT-03's rows
        #     exchanged wholesale, prose included, and each verdict's flip condition cross-wired
        #     to the other's inputs, with both verdicts' published assertions left untouched.
        #     Replacing one subject is refused by the properties above; permuting two is not,
        #     because a permutation leaves the table and the verdicts consistent with each
        #     other. It is not merely inelegant: FS-BOOT-02 then stays red against its own
        #     implemented behaviour, publishing an observation that contradicts its own verdict,
        #     and lifts on FS-BOOT-03's instead. Only what the verdict actually read tells them
        #     apart, which is why this weakening crosses both files.
        "subjects-permuted-between-two-cases",
        ("tests/test_first_slice_bootstrap.py", "dev/first_slice_bootstrap.py"),
        [
            (SUBJECTS_02_03, PERMUTED_SUBJECTS_02_03),
            (VERDICT_02_FLIP, PERMUTED_VERDICT_02_FLIP),
            (VERDICT_03_FLIP, PERMUTED_VERDICT_03_FLIP),
        ],
        "test_a_verdict_reads_only_the_inputs_its_own_subject_declares[FS-BOOT-02]",
        "read an input its own subject does not declare",
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-02]",
    ),
    (
        # 14. The same permutation, spelled through the mapping and sequence operations a watch
        #     built by subclassing `dict` and `tuple` never sees. CPython answers `setdefault`,
        #     `pop`, `len`, `reversed`, `==`, `count`, `index`, indexing, slicing and
        #     concatenation on a builtin subclass in C, without consulting the subclass's Python
        #     overrides, so instrumenting nine methods instrumented nine methods and nothing
        #     else. This weakening changed two spellings and left the read check green; the
        #     watch is a read-only Mapping and Sequence now, so an operation the ABCs do not
        #     derive from `__getitem__`, `__iter__` and `__len__` is refused by name instead.
        "subjects-permuted-through-an-unwatchable-spelling",
        ("tests/test_first_slice_bootstrap.py", "dev/first_slice_bootstrap.py"),
        [
            (SUBJECTS_02_03, PERMUTED_SUBJECTS_02_03),
            (VERDICT_02_FLIP, BYPASSING_VERDICT_02_FLIP),
            (VERDICT_03_FLIP, PERMUTED_VERDICT_03_FLIP),
        ],
        "test_a_verdict_reads_only_the_inputs_its_own_subject_declares[FS-BOOT-02]",
        "an operation the read instrumentation does not implement",
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-02]",
    ),
    (
        # 15. The permutation carried into the prose as well, so every probe the cross-wired
        #     verdict names is one its swapped subject declares and the records are counted
        #     rather than asked for. Nothing about FS-BOOT-02's probes gives it away; on that
        #     case only the record reads do. A watch that instruments the probes mapping alone
        #     leaves this one entirely green, which is what makes it the counterexample that
        #     qualifies the models watch rather than merely repeating the one above.
        "subjects-permuted-with-the-records-counted-instead",
        ("tests/test_first_slice_bootstrap.py", "dev/first_slice_bootstrap.py"),
        [
            (SUBJECTS_02_03, PERMUTED_SUBJECTS_02_03),
            (VERDICT_02_FLIP, COUNTING_VERDICT_02_FLIP),
            (VERDICT_03_FLIP, PERMUTED_VERDICT_03_FLIP),
            (VERDICT_02_PROSE, PERMUTED_VERDICT_02_PROSE),
            (VERDICT_02_STATUS_PROSE, PERMUTED_VERDICT_02_STATUS_PROSE),
        ],
        "test_a_verdict_reads_only_the_inputs_its_own_subject_declares[FS-BOOT-02]",
        "read an input its own subject does not declare",
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-02]",
    ),
    (
        # 16. The read instrumentation truncated to the first read it saw. Every weakening that
        #     cross-wires a subject still reads *something* undeclared first, so the check that
        #     only refuses undeclared reads stays green and every mutation above stays caught;
        #     what a prefix cannot do is account for every input every case declares.
        "read-instrumentation-truncated-to-one-read",
        "tests/test_first_slice_bootstrap.py",
        [("    return seen\n", "    return seen[:1]\n")],
        "test_every_input_a_case_names_is_seen_read_while_its_verdict_decides[FS-BOOT-01]",
        "was never seen to read that",
        "test_a_verdict_reads_only_the_inputs_its_own_subject_declares[FS-BOOT-01]",
    ),
    (
        # 17. The read instrumentation narrowed to the probes mapping, leaving every record read
        #     unwatched. The check that only refuses undeclared reads survives it — the
        #     permutations above are all caught by a probe — so the records are qualified by the
        #     declarations that would then go unaccounted for, not by that check.
        "read-instrumentation-narrowed-to-probes",
        "tests/test_first_slice_bootstrap.py",
        [
            (
                "        models=cast(Any, WatchedModels(observation.models, seen)),\n",
                "        models=cast(Any, observation.models),\n",
            )
        ],
        "test_every_input_a_case_names_is_seen_read_while_its_verdict_decides[FS-BOOT-01]",
        "was never seen to read that",
        "test_a_verdict_reads_only_the_inputs_its_own_subject_declares[FS-BOOT-01]",
    ),
    (
        # 18. A verdict keyed on the route surface rather than on the operation its own case is
        #     about. FS-BOOT-06 is the one subject that names a single probe, and `routes`
        #     follows `bool(probes)` in every observation built here, so the load-bearing
        #     property cannot separate the two; the pairwise property never reaches this flip
        #     because `identity` blocks the case first. Keyed this way, FS-BOOT-06 would report
        #     would-pass on a slice where consumeOwnerClaim is not served at all, as long as
        #     some other route is.
        "verdict-keyed-on-the-route-surface",
        "dev/first_slice_bootstrap.py",
        [
            (
                '    if observation.served("claim_consume"):\n'
                '        raise WouldPassError("FS-BOOT-06")',
                '    if any(route.startswith("api/") for route in observation.routes):\n'
                '        raise WouldPassError("FS-BOOT-06")',
            )
        ],
        "test_the_route_and_table_surface_decides_nothing[FS-BOOT-06]",
        "changed its verdict when only the URL and table surface moved",
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-06]",
    ),
    (
        # 19. Weakening 13 with `verdict_boot_02`'s prose swept clean too: every probe that
        #     cross-wired verdict names is one its swapped subject declares, and the records are
        #     asked for with `in`, the way `absent_records` asks. On an absent slice the models
        #     sequence is empty, so a watch that answered `in` by reporting the names it
        #     *contains* — which is what the Sequence mixin does — would report nothing at all
        #     here. Recording the name the question is *about* is what this weakening qualifies.
        "subjects-permuted-with-the-prose-swept-clean",
        ("tests/test_first_slice_bootstrap.py", "dev/first_slice_bootstrap.py"),
        [
            (SUBJECTS_02_03, PERMUTED_SUBJECTS_02_03),
            (VERDICT_02_FLIP, PERMUTED_VERDICT_02_FLIP),
            (VERDICT_03_FLIP, PERMUTED_VERDICT_03_FLIP),
            (VERDICT_02_PROSE, PERMUTED_VERDICT_02_PROSE),
            (VERDICT_02_STATUS_PROSE, PERMUTED_VERDICT_02_STATUS_PROSE),
        ],
        "test_a_verdict_reads_only_the_inputs_its_own_subject_declares[FS-BOOT-02]",
        "read an input its own subject does not declare",
        "test_every_case_is_red_against_an_absent_slice[FS-BOOT-02]",
    ),
    (
        # 20. The read watched at one pole only, as it was before: `served` stops at the first
        #     probe that is not routed, so an absent slice never reaches the probes a case names
        #     after that one and a verdict could quietly stop reading them.
        "read-instrumentation-watching-one-pole-only",
        "tests/test_first_slice_bootstrap.py",
        [
            (
                "    return reads_of(case, absent()) + reads_of(case, observation_for(case))\n",
                "    return reads_of(case, absent())\n",
            )
        ],
        "test_every_input_a_case_names_is_seen_read_while_its_verdict_decides[FS-BOOT-01]",
        "was never seen to read that",
        "test_a_verdict_reads_only_the_inputs_its_own_subject_declares[FS-BOOT-01]",
    ),
]


def main() -> None:
    outcomes = []
    environment = {
        key: os.environ[key]
        for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")
        if key in os.environ
    }
    with tempfile.TemporaryDirectory(prefix="fsboot-mutations-") as temporary:
        for name, target, changes, case, reason, control in MUTATIONS:
            root = Path(temporary) / name
            for relative in COPIED:
                destination = root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, destination)
            sources = {relative: (root / relative).read_text() for relative in targets_of(target)}
            # A stale anchor means the weakening was never applied, so this mutation qualified
            # nothing. That is a failure of this file, and it is reported as one named row —
            # never as a traceback, which reads like a broken tool rather than a missing guard.
            if stale_anchors(sources, changes):
                outcomes.append(
                    refusal(
                        name,
                        target,
                        f"mutation-anchor-not-applied:{name} no longer appears exactly once in "
                        f"{list(sources)}, so this weakening was never applied and nothing here "
                        "qualifies the guard it names. Re-anchor it on the current source "
                        "rather than deleting it.",
                    )
                )
                continue
            for old, new in changes:
                for relative, source in sources.items():
                    if old in source:
                        sources[relative] = source.replace(old, new)
            for relative, source in sources.items():
                (root / relative).write_text(source)
            (root / "pytest.ini").write_text("[pytest]\n")
            result = subprocess.run(  # noqa: S603 - fixed tests and interpreter, no caller commands
                [
                    sys.executable,
                    "-m",
                    "pytest",
                    "-c",
                    "pytest.ini",
                    "-p",
                    "no:django",
                    "-p",
                    "no:randomly",
                    "--junitxml=result.xml",
                    f"{SUITE}::{case}",
                    f"{SUITE}::{control}",
                ],
                cwd=root,
                env={**environment, "PYTHONPATH": str(root)},
                capture_output=True,
                text=True,
                timeout=180,
            )
            # XML generated by this exact local pytest process, never external input.
            report = ET.parse(root / "result.xml")  # noqa: S314
            cases = {entry.attrib["name"]: entry for entry in report.findall(".//testcase")}
            absent_names = [item for item in (case, control) if item not in cases]
            if absent_names:
                outcomes.append(
                    refusal(
                        name,
                        target,
                        f"mutation-counterexample-not-collected:{name} named {absent_names}, "
                        "which pytest did not collect. A weakening whose counterexample no "
                        "longer exists is not caught by anything; re-point it at the test that "
                        "names this weakening.",
                    )
                )
                continue
            failure = cases[case].find("failure")
            caught = (
                result.returncode == 1
                and failure is not None
                and reason in failure.attrib.get("message", "")
            )
            intact = all(
                cases[control].find(kind) is None for kind in ["failure", "error", "skipped"]
            )
            outcomes.append(
                {
                    "mutation": name,
                    "file": list(targets_of(target)),
                    "counterexample": case,
                    "expected_message": reason,
                    "caught": caught,
                    "control": control,
                    "control_passed": intact,
                }
            )
    print(json.dumps(outcomes, indent=2))
    if not all(row["caught"] and row["control_passed"] for row in outcomes):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
