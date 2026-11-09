"""The FS-BOOT packet cannot be quietly weakened: verdicts and the runner's refusals.

These are hermetic. They exercise the verdict functions against measured-shaped observations
and the runner's admission of a driver report; the real Docker-backed measurement is
`make acceptance-first-slice`, which these cannot and do not stand in for.
"""

import json
import os
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, cast

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dev.first_slice_bootstrap import (  # noqa: E402 - path is set above for a script package
    CASES,
    IMPLEMENTED,
    BlockedError,
    Observation,
    ProbeError,
    WouldPassError,
    decide,
    load_contract,
    local_url,
    reviewed_operation,
)
from dev.mutate_first_slice_bootstrap import (  # noqa: E402 - same script package
    MUTATIONS,
    stale_anchors,
    targets_of,
)

SOURCE = Path(__file__).resolve().parents[1]
REVIEWED = ("createOrganisation", "getOrganisationBootstrap", "consumeOwnerClaim")

ABSENT_IDENTITY = {
    "provider": "local",
    "second_factor": False,
    "amr": ["pwd"],
    "acr": "1",
    "realm_survey": "surveyed 4 realm definitions; configuring a second factor: none",
}


# ------------------------------------------ what each case is about, stated here ----
# Two uniform poles — everything present, nothing present — are not enough: any predicate that
# separates them passes, whether or not it has anything to do with the scenario. So each case's
# subject is declared here, in the test, independently of the verdict that reads it, and the
# observations below vary one dimension at a time around it.


@dataclass(frozen=True)
class Subject:
    """The inputs one case's verdict is about. Not read from the verdict; compared against it."""

    dimension: str
    probes: tuple[str, ...]
    records: tuple[str, ...] = ()
    authenticated: bool = False
    second_factor: bool = False

    def inputs(self) -> tuple[tuple[str, str], ...]:
        """Every single input this case names, each of which must be load-bearing on its own."""
        rows: list[tuple[str, str]] = [("probe", name) for name in self.probes]
        rows += [("record", name) for name in self.records]
        if self.authenticated:
            rows.append(("authenticators", "DEFAULT_AUTHENTICATION_CLASSES"))
        if self.second_factor:
            rows.append(("identity", "second_factor"))
        return tuple(rows)


SUBJECTS = {
    "FS-BOOT-01": Subject(
        dimension=(
            "the intake, bootstrap-status and claim-consume operations and the Organisation, "
            "Intake, AuditEvent, OwnerClaim and Membership records"
        ),
        probes=("intake", "bootstrap_status", "claim_consume"),
        records=("Organisation", "Intake", "AuditEvent", "OwnerClaim", "Membership"),
    ),
    "FS-BOOT-02": Subject(
        dimension=(
            "a replayed intake carrying the same Idempotency-Key, the bootstrap-status operation "
            "and the Job, OutboxDelivery and IdempotencyRecord records"
        ),
        probes=("intake", "intake_replay", "bootstrap_status"),
        records=("Job", "OutboxDelivery", "IdempotencyRecord"),
    ),
    "FS-BOOT-03": Subject(
        dimension=(
            "the five wrong presenters of a claim, the positive control, and an authentication "
            "class that resolves a verified (iss, sub) to an Identity"
        ),
        probes=(
            "claim_staff",
            "claim_other_subject",
            "claim_other_realm",
            "claim_unknown",
            "claim_email_match",
            "claim_consume",
        ),
        authenticated=True,
    ),
    "FS-BOOT-04": Subject(
        dimension=(
            "the expired, revoked, altered and consumed claim states and the OwnerClaim and "
            "Membership records they would have state in"
        ),
        probes=("claim_expired", "claim_revoked", "claim_altered", "claim_consumed"),
        records=("OwnerClaim", "Membership"),
    ),
    "FS-BOOT-05": Subject(
        dimension="two concurrent claims and the Organisation row they would contend for",
        probes=("claim_race_a", "claim_race_b"),
        records=("Organisation",),
    ),
    "FS-BOOT-06": Subject(
        dimension=(
            "a claim consumed with a local provider's freshly verified second-factor evidence"
        ),
        probes=("claim_consume",),
        second_factor=True,
    ),
    "FS-BOOT-07": Subject(
        dimension=(
            "an intake signing a DPA, an intake nominating a membership, and the AuditEvent "
            "record the applicable denial would be written to"
        ),
        probes=("intake_signs_dpa", "intake_names_membership"),
        records=("AuditEvent",),
    ),
}


def observation_for(*cases: str, without: tuple[str, str] | None = None) -> Observation:
    """Exactly what the named cases are about is present; every other dimension is absent.

    `without` regresses one single input of that subject, so a verdict that never reads an input
    it names is caught on the observation where only that input is missing.
    """
    subjects = [SUBJECTS[case] for case in cases]
    probes = {name for subject in subjects for name in subject.probes}
    records = {name for subject in subjects for name in subject.records}
    authenticated = any(subject.authenticated for subject in subjects)
    second_factor = any(subject.second_factor for subject in subjects)
    if without is not None:
        kind, name = without
        probes -= {name} if kind == "probe" else set()
        records -= {name} if kind == "record" else set()
        authenticated = authenticated and kind != "authenticators"
        second_factor = second_factor and kind != "identity"
    # `authenticators` and `identity` follow the two flags a subject declares, so a verdict
    # keyed on either is held by the properties below like any other declared input.
    #
    # `routes` and `relations` follow `serving`, which is `bool(probes)` — they move with the
    # probes rather than independently of them. What that lockstep costs depends on the subject.
    # For the six subjects that name more than one probe it costs nothing: the pairwise property
    # builds observations in which every one of the case's own probes is gone, and the
    # load-bearing property observations in which the single probe it is regressing is gone; in
    # both the surface is still rich, so a verdict keyed on the surface stops being red there and
    # is refused. FS-BOOT-06 names a single probe and is the one exception: regressing that
    # probe empties `probes` and regresses the surface with it, so the load-bearing property sees
    # a case that is still red and is satisfied; and the pairwise property never reaches
    # FS-BOOT-06's flip at all, because `identity.second_factor` blocks it first on every other
    # case's observation. `test_the_route_and_table_surface_decides_nothing` covers that gap by
    # moving `routes` and `relations` on their own, at both poles of each case's own subject: the
    # resolver's and the database's inventories are named in the prose and decide nothing. It is
    # not a complete refusal of every surface-keyed verdict — see the "Known limits" section of
    # docs/testing/first-slice-acceptance-inventory.md, which names what still evades and how.
    # `harness_race` is the one input identical in every observation: a verdict keyed on it never
    # flips at all, which is what `red()` refuses on the absent slice.
    serving = bool(probes)
    return Observation(
        probes={
            name: {
                **row,
                "routed": name in probes,
                "status": row["status"] if name in probes else 404,
                "contract_closed": False,
            }
            for name, row in IMPLEMENTED.probes.items()
        },
        models=tuple(sorted(records)),
        relations=IMPLEMENTED.relations if serving else ("django_migrations",),
        routes=IMPLEMENTED.routes if serving else ("health/live", "health/ready"),
        authenticators=IMPLEMENTED.authenticators if authenticated else (),
        harness_race=dict(IMPLEMENTED.harness_race),
        identity=dict(IMPLEMENTED.identity if second_factor else ABSENT_IDENTITY),
    )


def absent() -> Observation:
    """The shape `observe` measures against a tree with none of the slice implemented."""
    return observation_for()


# ------------------------------------ what a verdict reads, not only what it declares ----
# The properties below bind each verdict to its declared subject; nothing bound a declared
# subject to the scenario it is named after. Exchanging two `SUBJECTS` rows wholesale and
# cross-wiring the two verdicts to each other's inputs therefore left every one of them green,
# while `decide` published a red row whose own observation contradicted it. A guard that only
# enforces self-consistency is not a guard.
#
# So the observation's read path is instrumented while `decide(case, ...)` runs, and every input
# the verdict actually reaches for is compared with the ones `SUBJECTS[case]` names — in both
# directions: nothing undeclared may be read, and nothing declared may go unread. The
# instrumentation sits on the two containers `Observation.probe` and `Observation.absent_records`
# read, rather than on those methods, so a read is recorded whether it goes through them or past
# them — `verdict_boot_07` already indexes `observation.probes` directly and `verdict_boot_05`
# already tests `observation.models` directly.
#
# The two watches below are a `Mapping` and a `Sequence`, never a `dict` or `tuple` subclass.
# CPython does not route its own C-level operations on a builtin subclass through that
# subclass's Python overrides, so a watch built by subclassing records only the handful of
# operations it happens to name and every other read of the same container is silent:
# `d.setdefault(name)`, `d.pop(name)`, `len(d)`, `reversed(d)`, `d == other` and the unbound
# `dict.__getitem__(d, name)` all read a `dict` subclass without touching one override, and
# `t.count(name)`, `t.index(name)`, `t[i]`, `t[:]`, `len(t)`, `t == other` and `t + ()` do the
# same to a `tuple` subclass. That was not theoretical: the permutation below can be respelled
# through `probes.setdefault(name)` and `models.count(name) == 0` and pass a subclass-based
# watch untouched. Every read of an abc `Mapping` or `Sequence` is instead derived by the ABC
# from `__getitem__`, `__iter__` and `__len__`, so the definitions below see them all; the
# operations the ABCs do not define — every mutating one, and concatenation — raise here and are
# reported by name rather than passing unseen. Deriving a read from `__iter__` makes it visible,
# not necessarily informative: a read that materialises the sequence — `tuple(m)`, `set(m)`,
# `m[:]` — is seen, and records the names the sequence holds rather than the name asked about.
# That residual, and two others, are written down under "Known limits" in
# docs/testing/first-slice-acceptance-inventory.md; this instrumentation is frozen, not complete.
#
# What this checks, exactly: the probe names and the record names one verdict reads. Nothing
# else. `authenticators`, `identity`, `routes` and `relations` are read straight off the
# dataclass and are refused by the properties below, not here.


class UnwatchedReadError(Exception):
    """A verdict reached the observation through an operation the instrumentation cannot see."""


class WatchedProbes(Mapping):
    """The probes mapping, recording the name of every probe the verdict under test reads.

    A read-only `Mapping`: `__contains__`, `get`, `keys`, `items`, `values`, `==` and `dict(d)`
    are all derived by the ABC from the three definitions here, and the mutating spellings a
    verdict could otherwise read through — `setdefault`, `pop`, `popitem`, `update` — do not
    exist on it at all.
    """

    def __init__(self, rows, seen):
        self._rows = dict(rows)
        self.seen = seen

    def _record(self, *names):
        self.seen.extend(("probe", str(name)) for name in names)

    def __getitem__(self, name):
        self._record(name)
        return self._rows[name]

    def __iter__(self):
        self._record(*self._rows)
        return iter(tuple(self._rows))

    def __len__(self):
        # A length is derived from every entry, and is recorded as having read every one.
        self._record(*self._rows)
        return len(self._rows)


class WatchedModels(Sequence):
    """The models tuple, recording the name of every record the verdict under test tests for.

    A read-only `Sequence`: indexing, slicing, iteration, `len`, `reversed` and the `in`, `count`
    and `index` questions all pass through the definitions here, and concatenation — which would
    hand a verdict an unwatched plain tuple — does not exist on it.

    `__contains__`, `count` and `index` record the name they are *asked about*, not the names in
    the sequence. On an absent slice this sequence is empty, so the ABC's own mixins, which
    answer those questions by iterating, would record nothing at all and `models.count(name) == 0`
    would be exactly as silent as it was under a `tuple` subclass.
    """

    def __init__(self, names, seen):
        self._names = tuple(names)
        self.seen = seen

    def _record(self, *names):
        self.seen.extend(("record", str(name)) for name in names)

    def __getitem__(self, index):
        selected = self._names[index]
        self._record(*(selected if isinstance(index, slice) else (selected,)))
        return selected

    def __len__(self):
        self._record(*self._names)
        return len(self._names)

    def __iter__(self):
        self._record(*self._names)
        return iter(self._names)

    def __contains__(self, name):
        self._record(name)
        return name in self._names

    def count(self, name):
        self._record(name)
        return self._names.count(name)

    def index(self, name, *bounds):
        self._record(name)
        return self._names.index(name, *bounds)

    def __eq__(self, other):
        self._record(*self._names)
        if isinstance(other, WatchedModels):
            other = other._names
        if not isinstance(other, (tuple, list)):
            return NotImplemented
        self._record(*other)
        return self._names == tuple(other)

    def __hash__(self):
        # Derived from every name, and recorded as such, for the same reason `__len__` is.
        self._record(*self._names)
        return hash(self._names)


def reads_of(case: str, observation: Observation) -> list[tuple[str, str]]:
    """Every probe and record `decide(case, observation)` reaches for, in the order it reads."""
    seen: list[tuple[str, str]] = []
    # The watches stand in for the declared container types on purpose: a verdict must read
    # them exactly as it reads a measured observation, and see no difference but the recording.
    watched = replace(
        observation,
        probes=cast(Any, WatchedProbes(observation.probes, seen)),
        models=cast(Any, WatchedModels(observation.models, seen)),
    )
    try:
        decide(case, watched)
    except WouldPassError:  # the flip is a read like any other; what it read is already recorded
        pass
    except (AttributeError, TypeError) as error:
        raise UnwatchedReadError(
            f"{case} reached its observation through an operation the read instrumentation does "
            f"not implement, so whatever it read there is recorded nowhere and checked by "
            f"nothing: {type(error).__name__}: {error}. The probes mapping is a read-only "
            "Mapping and the models sequence a read-only Sequence precisely so that every read "
            "is derived from __getitem__, __iter__ and __len__; a verdict that reaches past them "
            "— through setdefault or pop, through an unbound dict or tuple method, or through "
            "concatenation — is refused here instead of passing unseen."
        ) from error
    return seen


def observed_reads(case: str) -> list[tuple[str, str]]:
    """What one verdict reads at both poles of its own subject.

    `served` stops at the first probe that is not routed, so the absent pole on its own never
    reaches the probes a case names after that one. The implemented pole runs the flip condition
    to the end; the absent pole runs the prose. Neither alone is the whole read.
    """
    return reads_of(case, absent()) + reads_of(case, observation_for(case))


WATCHED_KINDS = ("probe", "record")


def undeclared_reads(case: str) -> list[str]:
    """The inputs that verdict read which `SUBJECTS[case]` does not name, in reading order."""
    declared = set(SUBJECTS[case].inputs())
    named: list[str] = []
    for kind, name in observed_reads(case):
        if (kind, name) not in declared and f"{kind} {name!r}" not in named:
            named.append(f"{kind} {name!r}")
    return named


def unread_declarations(case: str) -> list[str]:
    """The probes and records `SUBJECTS[case]` names that its verdict was never seen to read.

    The converse of `undeclared_reads`, and the one that qualifies the instrumentation itself: a
    watch narrowed to one kind of container, or a `reads_of` that returns a prefix of what it
    saw, still reports *some* undeclared read under a permutation and so still satisfies the
    check above. It cannot satisfy this one, which needs every declared probe and every declared
    record of every case to have been seen.
    """
    seen = set(observed_reads(case))
    return [
        f"{kind} {name!r}"
        for kind, name in SUBJECTS[case].inputs()
        if kind in WATCHED_KINDS and (kind, name) not in seen
    ]


def reported(case: str, observation: Observation) -> dict[str, Any] | None:
    """The row `decide` published, or None when it let `WouldPassError` out as it must."""
    try:
        return decide(case, observation)
    except WouldPassError:
        return None


def outcome(case: str, observation: Observation) -> str:
    """What `decide` did, as one word: the status it published, or the flip it let out."""
    row = reported(case, observation)
    return "would-pass" if row is None else str(row["status"])


def red(case: str, observation: Observation) -> dict[str, Any]:
    """The row `decide` published, insisting on a named refusal rather than a raised traceback."""
    row = reported(case, observation)
    if row is None:
        raise AssertionError(
            f"{case} reported its behaviour present on an observation carrying none of "
            f"{SUBJECTS[case].dimension}. Its verdict is keyed on something no case is about — a "
            "harness fixture or a constant — so it could never go green for a reason anyone "
            "implemented, nor stay red for a reason anyone could fix."
        )
    return row


# ------------------------------------------------------- the seven are really seven ----


def test_the_packet_covers_exactly_the_seven_bootstrap_scenarios():
    assert CASES == tuple(f"FS-BOOT-{number:02}" for number in range(1, 8))


@pytest.mark.parametrize("case", CASES)
def test_every_case_is_red_against_an_absent_slice(case):
    row = red(case, absent())
    assert row["id"] == case
    assert row["status"] in {"failed", "blocked"}, "no case may report a pass"
    assert row["observed_assertions"], "a red case must name what it observed"
    assert all(item.strip() for item in row["observed_assertions"])


@pytest.mark.parametrize("case", CASES)
def test_every_case_names_its_own_scenario_and_the_behaviour_it_reached_for(case):
    text = " ".join(red(case, absent())["observed_assertions"])
    assert case in text or "FS-BOOT-06" == case, "an assertion must name its scenario"
    assert len(text) > 200, "a one-word refusal is not a named observation"


def test_the_mfa_case_is_blocked_while_no_second_factor_is_observed():
    row = red("FS-BOOT-06", absent())
    assert row["status"] == "blocked", (
        "FS-BOOT-06 must be blocked while no second factor is observed: reporting it failed "
        "claims the provider's MFA was driven when it was not"
    )
    assert "no-second-factor-in-any-local-identity-provider" in row["observed_assertions"][0], (
        "a blocked case must name the dependency that is missing"
    )


def test_the_six_driven_cases_are_failed_and_the_mfa_case_is_blocked():
    rows = {case: red(case, absent()) for case in CASES}
    assert [case for case, row in rows.items() if row["status"] == "failed"] == [
        "FS-BOOT-01",
        "FS-BOOT-02",
        "FS-BOOT-03",
        "FS-BOOT-04",
        "FS-BOOT-05",
        "FS-BOOT-07",
    ]
    assert rows["FS-BOOT-06"]["status"] == "blocked"


# ---------------------------------- the assertions are sensitive to the behaviour ----
# Seven properties, every one of them through the public entry point `decide`, never through
# `VERDICTS[case]` directly, so a `decide` that catches or downgrades `WouldPassError` is caught
# here rather than making all seven cases permanently red against a working slice:
#   1. a case flips on its own subject and on nothing less than it,
#   2. `decide` lets `WouldPassError` out rather than reporting a row,
#   3. a case does not flip on another case's subject,
#   4. every single input a case names is load-bearing on its own,
#   5. a case reads no input its own subject does not name,
#   6. a case is seen to read every input its own subject does name,
#   7. no case decides anything from the route and table surface.
# Two uniform poles would satisfy none of 1, 3 or 4: any predicate that separates "everything
# present" from "nothing present" passes against them, whatever dimension it reads. Properties
# 1 to 4 read the subject table and are all satisfied by a table permuted between two cases,
# because a permutation keeps the table and the verdicts consistent with each other; 5 and 6
# read what the verdict actually did, and 6 is what holds the instrumentation of 5 to seeing
# every read rather than the first one, or one container's. 7 covers the two dimensions 5 and 6
# do not watch: `routes` and `relations` follow `bool(probes)`, so for a single-probe subject —
# FS-BOOT-06 alone — a verdict keyed on the surface flips exactly where a verdict keyed on the
# probe flips, and 3 and 4 cannot tell them apart. For the other six they can, and do. None of
# the seven refuses every surface-keyed verdict; the residual is under "Known limits" in
# docs/testing/first-slice-acceptance-inventory.md.

PAIRS = [
    pytest.param(case, other, id=f"{case}-on-{other}")
    for case in CASES
    for other in CASES
    if case != other
]
REGRESSIONS = [
    pytest.param(case, kind, name, id=f"{case}-{kind}-{name}")
    for case in CASES
    for kind, name in SUBJECTS[case].inputs()
]


@pytest.mark.parametrize("case", CASES)
def test_no_case_stays_red_once_its_behaviour_is_present(case):
    row = reported(case, observation_for(case))
    if row is None:
        return
    raise AssertionError(
        f"{case} still reports red against an observation where its behaviour is present: it "
        f"reported {row['status']!r} on the observation carrying {SUBJECTS[case].dimension} and "
        f"nothing else. Either its assertion is weaker than the scenario it claims to cover, or "
        f"it is keyed on a dimension {case} is not about."
    )


@pytest.mark.parametrize("case", CASES)
def test_decide_lets_would_pass_out_rather_than_publishing_a_row(case):
    row = reported(case, IMPLEMENTED)
    if row is None:
        return
    raise AssertionError(
        f"{case}: decide() published {row['status']!r} against a fully implemented slice instead "
        "of letting WouldPassError out. A decide() that catches, downgrades or reports "
        "WouldPassError leaves all seven cases red for ever — as loudly against a working slice "
        "as against an absent one — and nothing in the published report would say so."
    )


@pytest.mark.parametrize("case,other", PAIRS)
def test_no_case_stops_being_red_for_another_cases_behaviour(case, other):
    row = reported(case, observation_for(other))
    if row is None:
        raise AssertionError(
            f"{case} stopped reporting red on an observation carrying only {other}'s subject "
            f"({SUBJECTS[other].dimension}) and none of its own ({SUBJECTS[case].dimension}). "
            f"Its verdict is keyed on a dimension {case} is not about, so it would go quiet the "
            f"moment {other}'s behaviour, or one of the harness's own fixtures, changed under it."
        )
    if row["status"] not in {"failed", "blocked"}:
        raise AssertionError(f"{case} reported {row['status']!r}; no case may report a pass")


@pytest.mark.parametrize("case,kind,name", REGRESSIONS)
def test_every_input_a_case_names_is_load_bearing_on_its_own(case, kind, name):
    row = reported(case, observation_for(case, without=(kind, name)))
    if row is None:
        raise AssertionError(
            f"{case} reports its behaviour present on an observation where the one {kind} it "
            f"names as {name!r} is missing and everything else it is about is present. The "
            f"verdict never reads that {kind}, so {case} would go green on a slice that never "
            "implemented it."
        )
    if row["status"] not in {"failed", "blocked"}:
        raise AssertionError(f"{case} reported {row['status']!r}; no case may report a pass")


@pytest.mark.parametrize("case", CASES)
def test_a_verdict_reads_only_the_inputs_its_own_subject_declares(case):
    try:
        undeclared = undeclared_reads(case)
    except UnwatchedReadError as unwatched:
        raise AssertionError(str(unwatched)) from None
    if undeclared:
        raise AssertionError(
            f"{case} read an input its own subject does not declare: {', '.join(undeclared)}. "
            f"SUBJECTS[{case}] names {SUBJECTS[case].dimension}, and deciding it — on an "
            f"absent slice and on its own implemented subject — reached past that. A row and a "
            f"verdict cross-wired to another case's inputs are "
            f"consistent with each other and wrong about the scenario: {case} would publish a "
            f"red whose own observation is about a different case, and would lift on that other "
            f"case's behaviour instead of its own."
        )


@pytest.mark.parametrize("case", CASES)
def test_every_input_a_case_names_is_seen_read_while_its_verdict_decides(case):
    """The converse of the check above, and the one that qualifies the instrumentation.

    A watch that sees only probes, or a `reads_of` that returns a prefix of what it saw, still
    reports one undeclared read under a cross-wired subject table and so still satisfies the
    check above — while saying nothing about every other input of every other case. Requiring
    each declared probe and record to have been *seen* is what makes a narrowed or truncated
    watch a failure here instead of a quieter guard nobody notices.
    """
    try:
        unread = unread_declarations(case)
    except UnwatchedReadError as unwatched:
        raise AssertionError(str(unwatched)) from None
    if unread:
        raise AssertionError(
            f"{case} declares {', '.join(unread)}, and deciding it — on an absent slice and on "
            "its own implemented subject — was never seen to read that. Either the verdict does "
            "not read what its subject names, or the read "
            "instrumentation no longer records every read: a watch narrowed to one kind of "
            "container, or a reads_of that returns part of what it saw, leaves exactly this "
            "trace and leaves the check above qualified by a single row."
        )


@pytest.mark.parametrize("case", CASES)
def test_the_route_and_table_surface_decides_nothing(case):
    """`routes` and `relations` are named in the prose of a verdict and decide none of them.

    They follow `serving` in every observation built here, so for a subject that names a single
    probe they move exactly where that probe moves: the load-bearing property cannot separate a
    verdict keyed on the surface from one keyed on the probe, and the pairwise property never
    reaches FS-BOOT-06's flip because `identity` blocks it first. This moves the two of them on
    their own, at both poles of each case's own subject, which is the same differential the
    `without` observations apply to every declared input.

    Two poles are all it compares, so a surface key disjoined with the case's own probe survives
    it on FS-BOOT-06 — the one case whose absent pole is blocked before any route is read and
    whose own-subject pole already answers true. Limit 2 of the "Known limits" section of
    docs/testing/first-slice-acceptance-inventory.md carries the spelling and what it measured.
    """
    poles = (("an absent slice", absent()), (f"{case}'s own subject", observation_for(case)))
    surfaces = (("absent", absent()), ("implemented", IMPLEMENTED))
    for pole, observation in poles:
        measured = outcome(case, observation)
        for label, source in surfaces:
            moved = replace(observation, routes=source.routes, relations=source.relations)
            if outcome(case, moved) == measured:
                continue
            raise AssertionError(
                f"{case} changed its verdict when only the URL and table surface moved: on "
                f"{pole} it reported {measured!r} with the surface as measured there and "
                f"{outcome(case, moved)!r} with the {label} surface, and nothing else differs. "
                "`routes` is the resolver's own inventory and `relations` the database's; every "
                "verdict names one or the other in its prose and none may decide on them. A "
                "verdict keyed on the surface answers whatever else happens to be implemented "
                "rather than its own scenario, and would report would-pass on a slice where the "
                "operation its case is about is not served at all."
            )


def test_a_watched_probes_mapping_records_every_way_of_reading_it():
    """Each read below is either recorded against the probe it names, or does not exist."""
    seen: list[tuple[str, str]] = []
    watched = WatchedProbes({"intake": {"routed": False}, "claim_consume": {"routed": False}}, seen)
    both = [("probe", "intake"), ("probe", "claim_consume")]

    def read(action):
        del seen[:]
        try:
            action()
        except (AttributeError, TypeError) as error:
            return type(error).__name__
        return list(dict.fromkeys(seen))

    assert read(lambda: watched["intake"]) == [("probe", "intake")]
    assert read(lambda: "intake" in watched) == [("probe", "intake")]
    assert read(lambda: watched.get("intake")) == [("probe", "intake")]
    assert read(lambda: len(watched)) == both
    assert read(lambda: dict(watched)) == both
    assert read(lambda: {**watched}) == both
    assert read(lambda: [*watched]) == both
    assert read(lambda: list(watched.items())) == both
    assert read(lambda: list(watched.values())) == both
    assert read(lambda: list(watched.keys())) == both
    assert read(lambda: watched == {"intake": {"routed": False}}) == both
    assert read(lambda: watched != {}) == both
    # Not recorded because they cannot be spelled at all against a read-only Mapping.
    assert read(lambda: watched.setdefault("intake", {})) == "AttributeError"
    assert read(lambda: watched.pop("intake")) == "AttributeError"
    assert read(lambda: watched.popitem()) == "AttributeError"
    assert read(lambda: watched.update({})) == "AttributeError"
    assert read(lambda: reversed(watched)) == "TypeError"
    assert read(lambda: dict.__getitem__(watched, "intake")) == "TypeError"
    assert read(lambda: dict.items(watched)) == "TypeError"
    assert read(lambda: json.dumps(watched)) == "TypeError"


def test_a_watched_models_sequence_records_every_way_of_reading_it():
    """Each read below is either recorded against the record it names, or does not exist."""
    seen: list[tuple[str, str]] = []
    watched = WatchedModels(("Organisation", "Membership"), seen)
    both = [("record", "Organisation"), ("record", "Membership")]

    def read(action):
        del seen[:]
        try:
            action()
        except (AttributeError, TypeError) as error:
            return type(error).__name__
        return list(dict.fromkeys(seen))

    assert read(lambda: "Job" in watched) == [("record", "Job")]
    assert read(lambda: watched.count("Job")) == [("record", "Job")]
    assert read(lambda: watched.index("Organisation")) == [("record", "Organisation")]
    assert read(lambda: watched[0]) == [("record", "Organisation")]
    assert read(lambda: watched[-1]) == [("record", "Membership")]
    assert read(lambda: watched[:]) == both
    assert read(lambda: len(watched)) == both
    assert read(lambda: list(reversed(watched))) == both
    assert read(lambda: list(watched)) == both
    assert read(lambda: sorted(watched)) == both
    assert read(lambda: set(watched)) == both
    assert read(lambda: watched == ("Organisation", "Membership")) == both
    assert read(lambda: watched != ("Job",)) == [*both, ("record", "Job")]
    # Not recorded because they cannot be spelled at all against a read-only Sequence.
    assert read(lambda: watched + ()) == "TypeError"
    assert read(lambda: () + watched) == "TypeError"
    assert read(lambda: tuple.__contains__(watched, "Job")) == "TypeError"
    assert read(lambda: tuple.count(watched, "Job")) == "TypeError"


@pytest.mark.parametrize("name", [row[0] for row in MUTATIONS])
def test_every_weakening_still_anchors_on_the_source_it_claims_to_weaken(name):
    """A weakening whose anchor moved qualifies nothing, and must say so, not raise."""
    _, target, changes, *_ = next(row for row in MUTATIONS if row[0] == name)
    sources = {
        relative: (SOURCE / relative).read_text(encoding="utf-8") for relative in targets_of(target)
    }
    stale = stale_anchors(sources, changes)
    if stale:
        raise AssertionError(
            f"the weakening {name!r} no longer anchors on {list(sources)}: it expects each of "
            f"{stale} exactly once and the current source does not carry it. Until it is "
            "re-anchored, that weakening is applied to nothing and the guard it names is "
            "qualified by nothing."
        )


def test_the_seven_subjects_together_are_the_whole_implemented_pole():
    whole = observation_for(*CASES)
    unclaimed = sorted(set(IMPLEMENTED.models) - set(whole.models))
    unrouted = sorted(name for name, row in whole.probes.items() if not row["routed"])
    if unclaimed or unrouted:
        raise AssertionError(
            "no case claims these as its subject, so nothing above is sensitive to them: "
            f"records {unclaimed or 'none'}, probes {unrouted or 'none'}. A subject table "
            "trimmed until the sensitivity tests pass is the weakening they exist to refuse."
        )
    assert whole.authenticators == IMPLEMENTED.authenticators
    assert whole.identity == IMPLEMENTED.identity


def test_a_verdict_that_returns_a_pass_is_refused_rather_than_reported():
    from dev import first_slice_bootstrap as module

    original = module.VERDICTS["FS-BOOT-01"]
    module.VERDICTS["FS-BOOT-01"] = lambda observation: ("passed", ["it worked"])
    try:
        with pytest.raises(ProbeError, match="a bootstrap verdict may only return a named failure"):
            decide("FS-BOOT-01", absent())
    finally:
        module.VERDICTS["FS-BOOT-01"] = original


def test_an_unmeasured_probe_is_a_probe_error_not_a_silent_default():
    with pytest.raises(ProbeError, match="unmeasured probe"):
        decide("FS-BOOT-01", replace(absent(), probes={}))


def test_a_harness_that_cannot_serialise_two_writers_blocks_the_race_case():
    row = red("FS-BOOT-05", replace(absent(), harness_race={"attempted": 2, "committed": 2}))
    assert row["status"] == "blocked"
    assert "harness-concurrency-unproven" in row["observed_assertions"][0]


def test_an_unavailable_identity_provider_is_blocked_on_its_own_reason():
    row = red("FS-BOOT-06", replace(absent(), identity={"unavailable": "docker absent"}))
    assert row["status"] == "blocked"
    assert "identity-provider-unavailable" in row["observed_assertions"][0]


def test_a_second_factor_without_the_operation_is_failed_not_blocked():
    observation = replace(absent(), identity={**IMPLEMENTED.identity})
    assert red("FS-BOOT-06", observation)["status"] == "failed"


def test_a_routed_intake_that_never_reached_its_refusal_keeps_fs_boot_07_red():
    """The intake routed and the audit model present, but each probe answered before its body was
    read, as an unauthenticated probe is: the refusal FS-BOOT-07 is about was never observed."""
    present = observation_for("FS-BOOT-07")
    unauthenticated = replace(
        present,
        probes={
            name: {**row, "status": 401} if name.startswith("intake_") else row
            for name, row in present.probes.items()
        },
    )
    row = reported("FS-BOOT-07", unauthenticated)
    assert row is not None and row["status"] == "failed", (
        "a routed intake that refused nothing let FS-BOOT-07 pass"
    )
    assert "createOrganisation is routed, but" in row["observed_assertions"][1]


# ------------------------------------------------- the contract, not a memorised path ----


@pytest.mark.parametrize("operation_id", REVIEWED)
def test_each_reviewed_operation_is_read_from_the_contract(operation_id):
    operation = reviewed_operation(load_contract(SOURCE), operation_id)
    assert operation["method"] in {"GET", "POST"}
    assert operation["path"].startswith("/")
    assert operation["roles"], "the contract must declare who may reach the operation"


def test_a_contract_that_no_longer_carries_an_operation_blocks_rather_than_guesses():
    document = load_contract(SOURCE)
    for item in document["paths"].values():
        for operation in item.values():
            if isinstance(operation, dict) and operation.get("operationId") == "createOrganisation":
                operation["operationId"] = "somethingElse"
    try:
        found = reviewed_operation(document, "createOrganisation")
    except BlockedError as error:
        assert "contract-missing-operation:createOrganisation" in str(error)
        return
    raise AssertionError(
        "the reviewed operation must be read from the contract, not assumed: a contract that "
        f"no longer carries createOrganisation still yielded {found}"
    )


def test_the_local_url_carries_the_versioned_base_and_substitutes_parameters():
    document = load_contract(SOURCE)
    url = local_url(reviewed_operation(document, "getOrganisationBootstrap"), organisation_id="x")
    assert url == "/api/v1/organisations/x/bootstrap"


def test_the_intake_body_the_probe_sends_is_the_shape_the_contract_closes():
    schema = load_contract(SOURCE)["components"]["schemas"]["OrganisationCreateRequest"]
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == {"slug", "name", "instruction_ref", "intended_owner"}


# ----------------------------------------------- the runner refuses a weakened report ----


def git(root, *args):
    return subprocess.run(  # noqa: S603 - fixed synthetic Git operations
        ["git", "-c", "core.hooksPath=/dev/null", *args],  # noqa: S607
        cwd=root,
        check=True,
        capture_output=True,
        env={
            **os.environ,
            "GIT_AUTHOR_NAME": "Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.test",
            "GIT_COMMITTER_NAME": "Fixture",
            "GIT_COMMITTER_EMAIL": "fixture@example.test",
        },
    )


ROWS = [
    {"id": f"FS-BOOT-{number:02}", "status": "failed", "observed_assertions": ["named observation"]}
    for number in range(1, 8)
]


def stub(rows, *, runtime="observed", code=1, extra=None):
    """A driver whose whole behaviour is the report it prints, so the runner is what is tested."""
    body = {
        "format": 1,
        "runtime_admission": runtime,
        "dependencies": {"observation": "probed", "versions": {}},
        "scenarios": rows,
    }
    if extra:
        body.update(extra)
    return f"import json, sys\nprint(json.dumps({body!r}))\nsys.exit({code})\n"


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "repo"
    (root / "dev").mkdir(parents=True)
    for name in ["accept_first_slice.py", "first_slice_manifest.json"]:
        shutil.copyfile(SOURCE / "dev" / name, root / "dev" / name)
    shutil.copyfile(SOURCE / "Makefile", root / "Makefile")
    git(root, "init", "-b", "fixture")
    git(root, "add", ".")
    git(root, "commit", "-m", "Record synthetic fixture")
    return root


def run(root):
    process = subprocess.run(  # noqa: S603 - fixed local CLI
        [sys.executable, str(root / "dev/accept_first_slice.py")],
        cwd=root,
        capture_output=True,
        text=True,
        env={**os.environ, "CASE": ""},
        timeout=30,
    )
    return process, json.loads(process.stdout)


def with_driver(root, content):
    path = root / "dev/first_slice_bootstrap.py"
    path.write_text(content)
    git(root, "add", "dev/first_slice_bootstrap.py")
    git(root, "commit", "-m", "Record synthetic driver")
    return root


def test_without_a_driver_the_bootstrap_cases_stay_not_implemented(repo):
    process, report = run(repo)
    assert process.returncode == 1 and report["status"] == "not_implemented"
    assert all(row["status"] == "not_implemented" for row in report["scenarios"])
    assert report["runtime_admission"] == "not_implemented"


def test_a_driver_report_is_carried_through_and_rolls_the_status_up(repo):
    process, report = run(with_driver(repo, stub(ROWS)))
    assert process.returncode == 1, "a driven failure must still return nonzero"
    assert report["status"] == "failed", (
        "a driven case reported failed must not be downgraded in the roll-up"
    )
    driven = {row["id"]: row for row in report["scenarios"] if row["id"].startswith("FS-BOOT")}
    assert [row["status"] for row in driven.values()] == ["failed"] * 7, (
        "a driven case reported failed must not be downgraded to not_implemented"
    )
    assert all(row["observed_assertions"] for row in driven.values())
    assert len(report["scenarios"]) == 33, "the full command still enumerates every scenario"
    assert report["runtime_admission"] == "observed"


def test_blocked_rolls_up_below_failed_and_above_not_implemented(repo):
    rows = [{**row, "status": "blocked"} for row in ROWS]
    _, report = run(with_driver(repo, stub(rows)))
    assert report["status"] == "blocked"


@pytest.mark.parametrize(
    "status", ["passed", "PASSED", "skipped", "not_implemented", "", "xfail", "success"]
)
def test_a_status_outside_failed_or_blocked_blocks_the_whole_run(repo, status):
    rows = [{**ROWS[0], "status": status}, *ROWS[1:]]
    process, report = run(with_driver(repo, stub(rows)))
    assert process.returncode == 2, (
        "a driver status outside failed or blocked must block the run, not be relayed"
    )
    assert report["reason"] == "bootstrap_status_not_admitted"
    assert "scenarios" not in report, "a refused driver report must publish no scenario row"


def test_a_driver_that_drops_one_of_the_seven_blocks_the_whole_run(repo):
    process, report = run(with_driver(repo, stub(ROWS[:-1])))
    assert process.returncode == 2, (
        "a driver that drops one of the seven must block the run, not report six"
    )
    assert report["reason"] == "bootstrap_selection_incomplete"


def test_a_driver_that_reorders_or_renames_a_case_blocks_the_whole_run(repo):
    rows = [{**ROWS[0], "id": "FS-BOOT-09"}, *ROWS[1:]]
    process, report = run(with_driver(repo, stub(rows)))
    assert process.returncode == 2 and report["reason"] == "bootstrap_selection_incomplete"


def test_an_empty_or_blank_assertion_blocks_the_whole_run(repo):
    for assertions in ([], [""], ["  "], [None], "named"):
        rows = [{**ROWS[0], "observed_assertions": assertions}, *ROWS[1:]]
        process, report = run(with_driver(repo, stub(rows)))
        assert process.returncode == 2, assertions
        assert report["reason"] == "bootstrap_assertion_missing", assertions


def test_a_driver_that_exits_zero_is_refused_rather_than_believed(repo):
    process, report = run(with_driver(repo, stub(ROWS, code=0)))
    assert process.returncode == 2 and report["reason"] == "bootstrap_driver_unavailable"


def test_an_unexpected_top_level_field_blocks_the_whole_run(repo):
    process, report = run(with_driver(repo, stub(ROWS, extra={"status": "passed"})))
    assert process.returncode == 2 and report["reason"] == "bootstrap_report_invalid"


def test_a_driver_that_prints_nothing_parseable_blocks_the_whole_run(repo):
    process, report = run(with_driver(repo, "import sys\nprint('not-json-canary')\nsys.exit(1)\n"))
    assert process.returncode == 2 and report["reason"] == "bootstrap_report_invalid"
    assert "not-json-canary" not in process.stdout + process.stderr


def test_a_driver_report_with_a_duplicate_key_blocks_the_whole_run(repo):
    content = (
        "import sys\n"
        'print(\'{"format":1,"format":1,"runtime_admission":"observed",\'\n'
        '      \'"dependencies":{},"scenarios":[]}\')\n'
        "sys.exit(1)\n"
    )
    process, report = run(with_driver(repo, content))
    assert process.returncode == 2 and report["reason"] == "bootstrap_report_invalid"
