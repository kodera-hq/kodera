# First-slice acceptance entry point

Status: Scoped implementation specification; full first-slice runtime acceptance remains unavailable.

Superseded for scenario state by [`first-slice-acceptance-harness.md`](first-slice-acceptance-harness.md): `tests/first_slice/scenarios.toml` is authoritative, and `make first-slice-scenarios` enforces it. This entry point and its report remain the evidence record, and its output says so.

The complete-product acceptance contract names 33 mandatory scenarios and a future `make acceptance-first-slice` entry point. There is currently no executable inventory, so a missing selector or subset can be mistaken for an acceptance command that simply has no tests. Implement the enumeration and evidence boundary first, without manufacturing passing product scenarios.

## Admitted behavior

- Provide `make acceptance-first-slice` and optional `CASE=FS-BOOT-01`. The default reports all 33 mandatory cases; a known selector reports one partial case. Unknown selectors fail admission.
- Read a committed JSON manifest containing the exact mandatory IDs, nonempty descriptions, a format version and no unexpected fields. Refuse missing, duplicate, unknown, malformed or skipped entries. No manifest field may supply a result or executable command.
- Every admitted case with no driver behind it is `not_implemented`, the command returns nonzero, and the report explicitly records no observed behavioral assertions. This includes FS-HARNESS-01: tests of this entry point do not satisfy its real dependency/network/reset requirements.
- Report the repository commit, a content-sensitive source fingerprint, dirty state, manifest digest, selected IDs, invocation, deterministic synthetic fixture seed and Python version. Dependency versions and runtime admission remain unobserved. Source hashing includes the index and tracked/untracked nonignored files, deletion state, file modes and symlink text; never follow symlinks or print source contents. Bound input/source sizes and refuse incomplete capture.
- Admission failures are `blocked`, not passing product results. Unexpected internal faults remain command failures. Do not read environment credentials, execute arbitrary manifest commands, or reset resources this entry point does not own.
- One checked-in driver is admitted, at the fixed path `dev/first_slice_bootstrap.py`, and it may report FS-BOOT-01..07 only as `failed` or `blocked`. `driven` refuses every other shape — a passing status, a dropped or renamed case, a missing assertion, a nonzero-but-not-one exit, an unexpected field, unparseable or duplicate-key output — by a named reason, and a refusal blocks the whole run rather than publishing a scenario row this process cannot check. With the driver absent, those seven stay `not_implemented`, which is what they are in a tree without one.
- A real execution adapter and network/resource-ownership admission are later work. No command flag or manifest result can claim an implementation passed.

## Initial acceptance and qualification

Before implementation, invoke the promised Make target and verify it is missing. Add executable tests that exercise the real CLI using isolated synthetic Git repositories: full/selected inventory nonzero, unknown IDs, missing/duplicate/additional IDs, skipped or result-bearing manifests, malformed/duplicate-key JSON, source changes with unchanged status, index-only differences, deletion and symlink handling, oversized/unreadable inputs and redaction. Positive controls admit the intact manifest but remain non-passing for absent behavior.

Mutation qualification must catch removed population validation, allowed result injection, forced success exit and a content-insensitive source fingerprint for the named reason. Run only in disposable copies. Static checks and existing relevant runtime/token checks must remain intact. Independent review binds the final revision before publication.

## Ownership and dependency

Integration lead owns the Make target, `dev/accept_first_slice.py`, its JSON inventory and focused tests. The base is reviewed Core 42 `0692655b69ee73cf4574bd7926fb1b8fed127e12`. No dependency, workflow, production authentication, contract or model change is admitted. The canonical 33-case specification remains in the complete-product preparation packet at `459064c82556af44f4e5b17b8224778c1b2e1fad`; this entry point cannot reduce that scope.

## The bootstrap driver

Status: Seven scenarios driven and non-passing; the remaining twenty-six unchanged.

`dev/first_slice_bootstrap.py` drives FS-BOOT-01..07 against a real disposable PostgreSQL of its
own compose project `fsboot-acceptance`, the real `config.settings.test`, real migrations, the
real URL resolver and the real DRF stack, and — for FS-BOOT-06 — the repository's real local
identity provider and the real production token verifier. The paths and roles it drives are read
from `contracts/core-api.openapi.yaml` at run time; a contract that no longer carries a reviewed
operation blocks the case instead of leaving the harness on a remembered path.

Six report `failed` and name the specific absent behaviour they reached for. FS-BOOT-06 reports
`blocked`: no realm definition in this repository configures a second factor, and the case
measures that against the running provider rather than asserting it. Every case is red at the
first step of its intended path, not at the discrimination its scenario is ultimately about;
`docs/specs/FIRST_OWNER_BOOTSTRAP.md` §11 records exactly what that does and does not prove.

The compose project is separate from the development stack on purpose: `docker compose down -v`
removes every named volume of the project it is given, so a harness that reset the development
project would take another worktree's database with it. This project owns one container, no named
volume and port 55432.

A verdict must be sensitive to the dimension its own scenario is about, not merely able to tell a
fully implemented slice from an empty one: any predicate at all separates those two poles. So
`tests/test_first_slice_bootstrap.py` declares, independently of the verdicts, what each case is
about — the operations it drives, the records it counts, the authentication class it needs, the
second factor it requires — and builds observations that vary one dimension at a time around it:
one carrying only that case's own subject, six carrying another case's and not its own, and one per
single input with exactly that input regressed. A verdict that fails to flip on its own subject,
flips on somebody else's, or never reads an input it names is refused by a message naming the case
and the dimension. Every one of those checks goes through `decide`, never through the verdict
function directly, so a `decide` that caught or downgraded `WouldPassError` — which would leave all
seven cases red for ever, against a working slice as loudly as against an absent one — is refused
the same way.

Those four properties bind each verdict to its declared subject and leave the table free to be
permuted: exchange two rows wholesale and cross-wire the two verdicts to each other's inputs, and
the table and the verdicts stay consistent with each other while both cases are now about the wrong
scenario — each publishing a red that contradicts its own observation and lifting on the other
case's behaviour. A guard that only enforces self-consistency is not a guard, so two further
properties read what the verdict actually did. The observation's read path is instrumented while
`decide` runs — at both poles of each case's own subject, because a probe check stops at the first
operation that is not served and so an absent slice alone never reaches the probes a case names
after that one. Any probe or record the verdict reaches for that `SUBJECTS[case]` does not name is
refused by a message giving the case and each undeclared input; and any probe or record the case
declares that the verdict was never *seen* to read is refused the same way, which is what holds the
instrumentation itself to recording every read rather than the first one, or one container's.
The instrumentation sits on the two containers `Observation.probe` and `Observation.absent_records`
read, rather than on those methods, so a read is recorded whether it goes through them or past them
— two verdicts already index `observation.probes` and test `observation.models` directly. It checks
probe names and record names, and nothing else.

Those two containers are presented to the verdict as an abc `Mapping` and an abc `Sequence`, never
as a `dict` or `tuple` subclass. CPython answers its own operations on a builtin subclass in C
without consulting that subclass's Python overrides, so a watch built by subclassing records only
the operations it happens to name: `setdefault`, `pop`, `len`, `reversed`, `==` and an unbound
`dict.__getitem__` read a `dict` subclass without touching one override, and `count`, `index`,
indexing, slicing, `len`, `==` and concatenation do the same to a `tuple` subclass — enough to
respell a whole cross-wired verdict through reads nothing records. Every read of a `Mapping` or a
`Sequence` through the protocol is instead derived by the ABC from `__getitem__`, `__iter__` and
`__len__`; membership, `count` and `index` are recorded against the name they are *asked about*,
since on an absent slice the models sequence is empty and a watch that answered them by iterating
would record nothing; and the operations the ABCs do not define at all — every mutating one, and
concatenation — are refused by name rather than passing unseen. Deriving a read from `__iter__`
makes it visible, not necessarily informative: what a materialising read records is limit 1 under
"Known limits" below.

The rest of the observation is refused elsewhere, and by different mechanisms, which is worth
stating precisely. `authenticators` and `identity` follow the two flags a subject declares, so they
are held like any other declared input. `routes` and `relations` follow whether any probe of the
subject is present. They move with the probes rather than independently of them, and what that
lockstep costs depends on the subject. For the six subjects that name more than one probe it costs
nothing: the pairwise property carries observations in which every one of the case's own probes is
gone, and the load-bearing property observations in which the single probe it is regressing is
gone; in both the route surface is still rich, so a verdict keyed on the surface stops being red
there and is refused by them. FS-BOOT-06 names a single probe and is the one
exception: regressing that probe empties the observation's probes and regresses the surface with
it, so the load-bearing property sees a case that is still red; and the pairwise property never
reaches FS-BOOT-06's flip at all, because `identity` blocks the case first on every other case's
observation. A seventh property covers that gap: it moves `routes` and `relations` on their own, at
both poles of each case's own subject, and requires the verdict not to change. The resolver's
inventory and the database's are named in the prose of a verdict and decide none of them; a verdict
keyed on the surface would report would-pass on a slice where the operation its case is about is
not served at all, as long as some other route is. What that seventh property does and does not
refuse is limit 2 under "Known limits" below. `harness_race` is the one input identical in every
observation: a verdict keyed on it never flips at all, and is refused on the absent slice instead.

`uv run python dev/mutate_first_slice_bootstrap.py` (`make mutate-first-slice-bootstrap`) runs
twenty-one weakenings in disposable copies and requires each to be caught by the exact message that
names it, with an intact control: a case that starts passing, FS-BOOT-07 lifted by a routed intake
whose unauthenticated probes never reached the `422` it is about, a `failed` downgraded to
`not_implemented`, one of the seven dropped from the selection, an assertion weakened to something
the absent behaviour also satisfies, FS-BOOT-06's unexercised second factor claimed as driven, a
reviewed operation assumed rather than read from the contract, a `decide` that swallows
`WouldPassError`, a probe check satisfied by any one probe instead of all of them, a verdict rekeyed
to the harness's identity fixture, a verdict rekeyed to another case's dimension, a verdict rekeyed
to the harness's own race control, the subject table trimmed until the sensitivity checks pass, the
subject table permuted between two cases with both verdicts cross-wired to match, that permutation
respelled through `probes.setdefault(name)` — an operation no `dict` subclass would have reported —
the same permutation with the records counted rather than asked for, the same permutation with
`verdict_boot_02`'s published prose swept clean so that on that case the record reads are the only
tell left, the read instrumentation
truncated to the first read it saw, narrowed to the probes mapping alone, and watching one pole
instead of two, and a verdict keyed on the route surface rather than on the operation its own case
is about. Those permutations cross two files, so a weakening may name more than one; each of its
anchors must still appear exactly once across the files it names. A weakening whose anchor no longer matches the source
refuses by name in both places — as a row in that report and as a named test failure — rather than
aborting the run with a traceback.

### Known limits

The properties above are frozen as they are. What follows is what they do **not** establish, each
stated with the exact spelling that evades it, so a reader can reproduce the gap rather than take
it on faith. Every figure below was measured by running the suite with that change applied. One
caveat on the figures: a change that rewrites a line the mutation table anchors on also makes that
weakening's anchor stale, and `test_every_weakening_still_anchors_on_the_source_it_claims_to_weaken`
refuses it by name. All three limits below — limit 2 included — rewrite at least one anchored line,
so each states the count it runs as it stands and names the weakenings that go stale, and then the
count once those are re-anchored on the new spelling, which is what anyone committing such a change
would have to do anyway. Un-re-anchored the three runs are 176/180, 179/180 and 179/180, and in all
three the failures are anchor staleness alone, never one of the seven properties.

**1. A read that materialises the models sequence records the wrong names.**
`WatchedModels.__iter__` and slicing `__getitem__` record the names the sequence *holds*, not the
name the verdict is asking about. So `"Job" in tuple(m)`, `list(m)`, `set(m)`, `sorted(m)`, `m[:]`,
`any(name == "Job" for name in m)` and `operator.countOf(m, "Job")` all answer the question a
verdict wants answered while recording something else — and the something else is exactly wrong in
the direction that matters, because on an absent slice the sequence is empty (so a materialising
read records nothing at all) and on a case's own implemented pole it holds precisely the records
that case declares (so the read records precisely those). Measured: the FS-BOOT-02/FS-BOOT-03
permutation with **both** verdicts' prose swept clean, together with a three-line respelling of
`Observation.absent_records`. The weakening `subjects-permuted-with-the-prose-swept-clean` sweeps
`verdict_boot_02`'s prose only, so `verdict_boot_03`'s published statuses have to be swept the same
way — from the five presenter probes its old row named to the three its new row declares —

```python
    statuses = {
        name: observation.probe(name)["status"]
        for name in ("intake", "intake_replay", "bootstrap_status")
    }
```

— alongside the respelling itself:

```python
    def absent_records(self, names: tuple[str, ...]) -> tuple[str, ...]:
        present = set(self.models)
        return tuple(name for name in names if name not in present)
```

That runs **176/180**, the four failures being the stale anchors of the four weakenings that name
the permuted rows — `subjects-permuted-between-two-cases`,
`subjects-permuted-through-an-unwatchable-spelling`,
`subjects-permuted-with-the-records-counted-instead` and
`subjects-permuted-with-the-prose-swept-clean` — and **180/180 green** once those four are
re-anchored on the permuted spelling. Sweeping `verdict_boot_02`'s prose alone, as that weakening
does, runs 175/180 instead: `verdict_boot_03`'s prose still asks for the five presenter probes its
swapped row no longer declares, and
`test_a_verdict_reads_only_the_inputs_its_own_subject_declares[FS-BOOT-03]` refuses it — a live
property, not a stale anchor. With both swept, the property that requires every declared record to
have been seen read is satisfied *vacuously*: the implemented pole records exactly the declared
records whatever the verdict asked about. Three further spellings record nothing at all:
`copy.deepcopy(m)` and a `pickle` round-trip hand back an object whose `_names` tuple is plain and
unwatched, and `repr(m)` touches no recorded operation either — though it exposes no names on its
own, so it is only useful in combination with reaching `_names` directly. All three are contrived
rather than idiomatic; the materialising reads above are not. The probes mapping does **not** share
this defect: materialising it (`dict(observation.probes)`) records *every* probe, which the
undeclared-read property refuses on all seven cases.

**2. A surface key disjoined with the case's own probe survives the surface property — on
FS-BOOT-06, and only there.** Replacing `verdict_boot_06`'s flip with

```python
    if observation.served("claim_consume") or any(
        route.startswith("api/") for route in observation.routes
    ):
        raise WouldPassError("FS-BOOT-06")
```

runs **179/180** as it stands: the two lines that block replaces are exactly the two the weakening
`verdict-keyed-on-the-route-surface` anchors on, so applying it makes that anchor stale and
`test_every_weakening_still_anchors_on_the_source_it_claims_to_weaken[verdict-keyed-on-the-route-surface]`
is the sole failure. Re-anchored on the disjunct, it runs **180/180 green**. That weakening holds
property 7 in place and is unrelated to what the disjunct evades; nothing else moves. The surface
property compares two poles and only two: FS-BOOT-06's absent pole is blocked by `identity` before
any route is read, and at its own-subject pole `served("claim_consume")` is already true, so the
disjunct is never the term that decides. What that property *does* refuse, measured the same way, is
not nothing: a conjunctive key (`served("claim_consume") and any(route…)`) on FS-BOOT-06 is refused
by it; a sole surface key there is refused by it and by the seen-read property; and on each of the
other six cases — every one of which names more than one probe — even the disjunct is refused, by
the pairwise property, the load-bearing property and the surface property together, because those
carry observations in which the case's own probes are gone — every one of them under the pairwise
property, the single probe being regressed under the load-bearing property — while the route surface
is still rich. FS-BOOT-06 is the single case where none of that applies.

**3. Two subjects whose record sets nest can be exchanged undetected.** Exchanging the FS-BOOT-01
and FS-BOOT-04 rows of the subject table wholesale, and cross-wiring the two verdicts — flip and
prose — to each other's inputs, runs **179/180** as it stands, the sole failure being the stale
anchor of `assertion-weakened-to-not-created`, which anchors on `verdict_boot_01`'s replaced flip;
re-anchored on the exchanged spelling it runs **180/180 green**, with the read watch working exactly
as designed. FS-BOOT-04's records (`OwnerClaim`, `Membership`) are a subset of FS-BOOT-01's, so
after the exchange every record each verdict reads is one its new row declares and every record each
row declares is read by its new verdict: nothing is undeclared, nothing is unread. The read
properties catch a permutation only when it leaves some read undeclared or some declaration unread,
which two cases with nesting record sets need not do.

A note on why the observations keep `routes` and `relations` in lockstep with the probes: it is
because the machinery is frozen, not because an observation that breaks the lockstep would be
unbuildable. `observe` reads `routes` from the top-level `config.urls.urlpatterns` while a probe's
`routed` flag comes from a full-path `resolve()`, so `path("api/v1/", include(...))` committed
before any operation exists inside it produces exactly that: `routes` carrying `api/v1/` while
every probe raises `Resolver404` and answers 404. `absent()` is a milder instance of the same
thing — it carries `health/live` and `health/ready` while every probe is 404 — which is what this
repository measures today.

**The control that actually applies.** The seven rows of the subject table — what each case is
*about* — are not verified by this machinery or by any other, and nothing requires anyone to check them. The properties bind each verdict
to the row that names it, hold every declared input to being load-bearing, refuse a verdict that
reads an input its row does not name, require every declared probe and record to have been seen
read, and — with the exceptions above — keep the route and table surface out of every verdict. None
of that establishes that a row describes the scenario its identifier names. A green run is evidence
that the verdicts and the table agree with each other and that neither is trivial; it is not
evidence that the table is honest. Read the seven rows.

## Qualified entry-point scope

The CLI and focused guard tests are implemented. The full command reports all 33 scenarios; with the bootstrap driver checked in, six are `failed`, one is `blocked` and the remaining twenty-six are `not_implemented`, and a selected command reports one scenario with the same non-passing status. No product scenario, including FS-HARNESS-01, is implemented by this change.

Run `make acceptance-first-slice` or `make acceptance-first-slice CASE=FS-BOOT-01`; both currently return nonzero deliberately. `uv run python dev/mutate_first_slice_inventory.py` runs four isolated weakenings with their exact counterexample assertions and intact controls. Ordinary `make test`, lint and typecheck cover the entry-point implementation alongside the existing tests.

Measured local qualification: 75 CLI/evidence cases, 143 existing access-token cases, 5 additional independent source/argument/FIFO probes, and 4 weakening proofs pass. Both actual Make selectors produce the expected non-passing JSON. Local Make validation used a dispatch-only wrapper to the already reviewed Python environment; it installed no packages. No changed runtime production files, dependencies, contracts or workflow are involved. Hosted CI remains a separate gate.

Source capture is content-sensitive and checks file identity, mode, size, timestamps, index, path population and commit stability before reporting. It binds manifest bytes to that capture. It is not an atomic filesystem snapshot or an attestation of ignored/runtime inputs. Malformed/linked/nonregular/oversized manifests and blocked Git reads produce named redacted refusals. Git stream capture has a deadline and byte bound. An unexpected internal fault is a failing command, never a passing scenario.

Initial absence errors prove only missing entry-point scaffolding. Later measured corrections address manifest FIFO blocking, source-file replacement with FIFO, same-status content changes during capture, admitted-manifest/source mismatch and argument echo. Those behavioral counterexamples and positive controls qualify these narrow guards; they do not establish real service admission or egress containment.

Actual Make-target testing also exposed recursive CASE expansion when no command-line selector was supplied. Immediate target-specific assignment now preserves absent, environment, explicit-empty and command-line selectors. Five real Make cases qualify this wiring separately from direct Python CLI tests.

## Test parameter portability

Status: Hosted oversized-fixture setup failure reproduced in collected metadata; short-name correction passes focused qualification; hosted rerun pending.

The first hosted run passed 288 cases but could not start the oversized-manifest fixture: its auto-generated parameter identifier contained 262145 payload bytes, inherited by child Git through the pytest current-test environment. Linux refused process creation with argument-list-too-long before the manifest test ran. Use explicit short diagnostic identifiers while retaining the exact payload and refusal assertion. Acceptance: collect the same 75 inventory cases with every identifier below 1024 bytes; run all 75 with the real pytest configuration and coverage, then obtain fresh hosted CI. No subprocess environment, product implementation or workflow weakening is allowed.
