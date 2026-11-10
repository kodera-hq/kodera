"""Prove every rule of the contract change gate is held by the self-test case that owns it.

A self-test that passes proves the gate can refuse. It does not prove each rule still does work: a
rule no case depends on can be deleted in silence. Each mutation below weakens one rule in a private
copy of the gate, its event script, its severity file or the workflow, runs only the case that owns
the rule, and requires that case to fail with the diagnostic that names the weakening. Every line
of the severity file is removed in turn and must be refused by its `override-<check id>` case. One
mutation removes the gate's job from the aggregate's `needs:` and requires the coverage check to
refuse it.

The harness cannot pass vacuously. Both unmutated self-tests must pass with every listed case run,
every owner must be a listed case, the severity file must list at least one override, every
mutation site must occur exactly once, and every listed mutation must be attempted.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
GATE = "apps/server/contracts/check_contract_change.py"
GATE_SELFTEST = "apps/server/contracts/check_contract_change_selftest.py"
EVENTS = "apps/server/contracts/check_contract_change_ci.py"
EVENTS_SELFTEST = "apps/server/contracts/check_contract_change_ci_selftest.py"
SEVERITY = "apps/server/contracts/oasdiff-severity-levels.txt"
WORKFLOW = ".github/workflows/ci.yml"
COVERAGE = "scripts/ci/check-ci-aggregate.py"
COPIED = (
    ".github/workflows/ci-server.yml",
    GATE,
    GATE_SELFTEST,
    EVENTS,
    EVENTS_SELFTEST,
    SEVERITY,
    "apps/server/contracts/check-version-policy.sh",
)
JOB = "server"
# Which self-test proves a mutation of each file; the workflow is proven by the coverage check.
RUNNERS = {GATE: GATE_SELFTEST, SEVERITY: GATE_SELFTEST, EVENTS: EVENTS_SELFTEST}
SUMMARIES = {
    GATE_SELFTEST: "contract change self-test passed",
    EVENTS_SELFTEST: "contract change CI self-test passed",
}
EXTRA = {GATE_SELFTEST: ["--contracts", str(HERE)], EVENTS_SELFTEST: []}
GIT_FAILURE = (
    'raise CouldNotLookError(f"git {args[0]} failed with exit {result.returncode}: {reason}")'
)


@dataclass(frozen=True)
class Mutation:
    name: str
    file: str
    before: str
    after: str
    owner: str
    diagnostic: str


def gate(name: str, before: str, after: str, owner: str, diagnostic: str) -> Mutation:
    return Mutation(name, GATE, before, after, owner, diagnostic)


def events(name: str, before: str, after: str, owner: str, diagnostic: str) -> Mutation:
    return Mutation(name, EVENTS, before, after, owner, diagnostic)


REFUSED, PASSED, NOT_LOOKED = (
    "expected exit 1, got 0",
    "expected exit 0, got 1",
    "expected exit 2, got 0",
)
ARGUMENTS = "expected gate arguments"

MUTATIONS = (
    gate(
        "WARN counts as breaking",
        "BREAKING_LEVEL = 2",
        "BREAKING_LEVEL = 3",
        "request-field-removed",
        REFUSED,
    ),
    gate(
        "the labels reach the policy",
        'arguments.extend(f"--label={label}" for label in labels)',
        "pass",
        "breaking-with-bump-and-label",
        "expected exit 0, got 1",
    ),
    gate(
        "the severity levels are passed to oasdiff",
        '                "--severity-levels",\n                str(severity),\n',
        "",
        "request-enum-member-added",
        REFUSED,
    ),
    gate(
        "the severity levels are read at the base, not the head",
        "git, base_commit, arguments.severity_levels, workspace",
        "git, head_commit, arguments.severity_levels, workspace",
        "head-weakens-severity",
        REFUSED,
    ),
    gate(
        "a change to the document's servers is breaking",
        'if as_json(base.get("servers")) != as_json(head.get("servers")):',
        "if False:",
        "servers-changed",
        REFUSED,
    ),
    gate(
        "a change to a path's servers is breaking",
        'if as_json(base_item.get("servers")) != as_json(head_item.get("servers")):',
        "if False:",
        "path-servers-changed",
        REFUSED,
    ),
    gate(
        "a change to an operation's servers is breaking",
        'if before_servers != as_json(head_operation.get("servers")):',
        "if False:",
        "operation-servers-changed",
        REFUSED,
    ),
    gate(
        "a change to x-kodera-authz is breaking",
        'OPERATION_EXTENSIONS = ("x-kodera-authz", "x-kodera-scope")',
        'OPERATION_EXTENSIONS = ("x-kodera-scope",)',
        "authz-narrowed",
        REFUSED,
    ),
    gate(
        "a change to x-kodera-scope is breaking",
        'OPERATION_EXTENSIONS = ("x-kodera-authz", "x-kodera-scope")',
        'OPERATION_EXTENSIONS = ("x-kodera-authz",)',
        "scope-changed",
        REFUSED,
    ),
    gate(
        "reordered roles are not a change",
        "if as_set_json(before) != as_set_json(after):",
        "if as_json(before) != as_json(after):",
        "authz-reordered",
        PASSED,
    ),
    gate(
        "reordered scope entries are not a change",
        "if as_set_json(before) != as_set_json(after):",
        "if as_json(before) != as_json(after):",
        "scope-reordered",
        PASSED,
    ),
    gate(
        "a repeated role is not a change",
        "return sorted({as_json(normal(item)) for item in node})",
        "return sorted(as_json(normal(item)) for item in node)",
        "authz-repeated-role",
        PASSED,
    ),
    gate(
        "operations are matched whatever their path parameters are named",
        'return PATH_PARAMETER.sub("{}", path)',
        "return path",
        "parameter-rename-widens-authz",
        REFUSED,
    ),
    gate(
        "a removed security scheme is breaking",
        '"security-scheme-removed", ERR',
        '"security-scheme-removed", INFO',
        "security-scheme-removed",
        REFUSED,
    ),
    gate(
        "a changed security scheme is breaking",
        '"security-scheme-changed", ERR',
        '"security-scheme-changed", INFO',
        "security-scheme-url-changed",
        "missing 'ERR  security-scheme-changed  components/securitySchemes/keycloakStaff'",
    ),
    gate(
        "an added security scheme is additive, not breaking",
        '"security-scheme-added", INFO',
        '"security-scheme-added", ERR',
        "security-scheme-added",
        PASSED,
    ),
    gate(
        "a security scheme's description is not a change",
        'if key != "description"',
        "if True",
        "security-scheme-description-changed",
        PASSED,
    ),
    gate(
        "a base equal to the head is said, not passed silently",
        "        if base_commit == head_commit:\n",
        "        if False:\n",
        "base-equals-head",
        "missing 'no contract comparison performed: base equals head'",
    ),
    gate(
        "a pull request compares with the merge-base, not the target's tip",
        'base = git("merge-base", tip, head).decode().strip()',
        "base = tip",
        "target-moved-after-branching",
        "expected exit 0, got 1",
    ),
    gate(
        "a push compares with the first parent, not with itself",
        'return parents[0], head, "first parent of the head"',
        'return head, head, "first parent of the head"',
        "push-checks-its-own-commit",
        REFUSED,
    ),
    gate(
        "a head with no parent cannot be looked at",
        'raise CouldNotLookError("the head commit has no parent to compare with")',
        'return head, head, "first parent of the head"',
        "root-commit",
        NOT_LOOKED,
    ),
    gate(
        "a given base is used, not the head",
        "return git.commit(base_revision), head,",
        "return head, head,",
        "push-compares-with-given-base",
        REFUSED,
    ),
    gate(
        "a failed merge-base is reported as such",
        GIT_FAILURE,
        f'if args[0] != "merge-base":\n                {GIT_FAILURE}',
        "no-merge-base",
        "missing 'git merge-base failed'",
    ),
    gate(
        "a deleted contract is refused",
        "        return VIOLATION\n    if base_blob == head_blob:",
        "        return PASSED\n    if base_blob == head_blob:",
        "contract-deleted",
        REFUSED,
    ),
    gate(
        "a contract only at the head is checked",
        "paths = sorted(set(at_base) | set(at_head))",
        "paths = sorted(set(at_base))",
        "contract-added",
        "missing 'apps/server/contracts/selftest-api.openapi.yaml: added'",
    ),
    gate(
        "an added contract is held to the policy",
        'passed, verdict = version_policy(arguments.policy, head_file, head_file, "unchanged", [])',
        'passed, verdict = True, "PASS: skipped"',
        "added-contract-invalid-version",
        NOT_LOOKED,
    ),
    gate(
        "no contract at either commit is not a pass",
        "        if not paths:\n",
        "        if False:\n",
        "no-contracts",
        NOT_LOOKED,
    ),
    gate(
        "every contract is checked, not only the core one",
        'CONTRACT_SUFFIX = ".openapi.yaml"',
        'CONTRACT_SUFFIX = "core-api.openapi.yaml"',
        "agent-contract-checked",
        REFUSED,
    ),
    gate(
        "formatting alone is not a change",
        "if base_canonical == head_canonical:",
        "if False:",
        "formatting-only",
        "expected exit 0, got 1",
    ),
    gate(
        "an INFO finding is additive, not a patch",
        '    if findings:\n        return "additive"',
        '    if False:\n        return "additive"',
        "additive-with-patch-bump",
        REFUSED,
    ),
    gate(
        "a changed document without findings is a patch, not unchanged",
        '    return "patch"\n',
        '    return "unchanged"\n',
        "prose-without-bump",
        "missing 'classified patch'",
    ),
    gate(
        "oasdiff's exit status is read",
        'raise CouldNotLookError(f"oasdiff exited {result.returncode}: {reason}")',
        "pass",
        "external-reference-refused",
        "missing 'oasdiff exited'",
    ),
    gate(
        "oasdiff's output must be JSON",
        'raise CouldNotLookError("oasdiff did not print a JSON changelog") from error',
        "items = []",
        "oasdiff-not-json",
        NOT_LOOKED,
    ),
    gate(
        "external references are refused",
        '                "--allow-external-refs=false",\n',
        "",
        "external-reference-refused",
        "missing 'disallowed external reference'",
    ),
    gate(
        "a failing oasdiff --version is reported",
        "if probe.returncode != 0:",
        "if False:",
        "oasdiff-version-fails",
        "missing '--version exited 3'",
    ),
    gate(
        "oasdiff must be the pinned version",
        'if reported != f"oasdiff version {pinned}":',
        "if False:",
        "oasdiff-wrong-version",
        NOT_LOOKED,
    ),
    gate(
        "the policy must give a verdict",
        'verdicts = [line for line in lines if line.startswith(("PASS:", "POLICY:"))]',
        'verdicts = lines or ["PASS: assumed"]',
        "policy-without-verdict",
        NOT_LOOKED,
    ),
    events(
        "only a push takes the push path",
        'if event == "push" and ref == MAIN:',
        "if ref == MAIN:",
        "dispatch-on-main",
        "expected exit 0, got 2",
    ),
    events(
        "only a push to main takes the push path",
        'if event == "push" and ref == MAIN:',
        'if event == "push":',
        "push-to-another-branch",
        "expected exit 0, got 2",
    ),
    events(
        "a push compares with the commit before it",
        "if before and before != ZERO:",
        "if False:",
        "push-compares-with-before",
        ARGUMENTS,
    ),
    events(
        "a push that changes a contract reads the labels",
        "if contracts_differ(repo, compared, head):",
        "if False:",
        "push-compares-with-before",
        ARGUMENTS,
    ),
    events(
        "a push that changes no contract reads no labels",
        "if contracts_differ(repo, compared, head):",
        "if True:",
        "push-without-contract-change",
        "expected exit 0, got 2",
    ),
    events(
        "a push retries the label lookup",
        "DEFAULT_ATTEMPTS = 4",
        "DEFAULT_ATTEMPTS = 1",
        "push-pull-request-appears-late",
        "expected exit 0, got 2",
    ),
    events(
        "a push whose labels cannot be read fails closed",
        "raise PlanError(message)",
        "return ()",
        "push-without-pull-request",
        "expected exit 2, got 0",
    ),
    events(
        "only the pull request merged as the commit gives labels",
        'if isinstance(pull, dict) and pull.get("merge_commit_sha") == sha:',
        "if isinstance(pull, dict):",
        "push-other-pull-request-ignored",
        "expected exit 2, got 0",
    ),
    events(
        "a pull request's labels are read from its event",
        "return tuple(names)",
        "return ()",
        "pull-request",
        ARGUMENTS,
    ),
    events(
        "the labels reach the gate command",
        'command += [f"--label={label}" for label in chosen.labels]',
        "command += []",
        "pull-request",
        ARGUMENTS,
    ),
    events(
        "the chosen base reaches the gate command",
        'command = [sys.executable, str(gate), "--head", chosen.head, *chosen.base]',
        'command = [sys.executable, str(gate), "--head", chosen.head, "--parent"]',
        "dispatch-on-main",
        ARGUMENTS,
    ),
    events(
        "the gate's exit status is passed through",
        "    return result.returncode\n",
        "    return 0\n",
        "gate-exit-status",
        "expected exit 1, got 0",
    ),
    Mutation(
        "the aggregate depends on the gate's job",
        WORKFLOW,
        "needs: [plan, server, web, rust-desktop, mobile]",
        "needs: [plan, web, rust-desktop, mobile]",
        "the coverage check",
        f"job `{JOB}` is not in `ci-ok` needs",
    ),
)


def severity_mutations() -> list[Mutation]:
    lines = [line for line in (ROOT / SEVERITY).read_text(encoding="utf-8").splitlines() if line]
    return [
        Mutation(
            f"the override {line.split()[0]} applies",
            SEVERITY,
            f"{line}\n",
            "",
            f"override-{line.split()[0]}",
            REFUSED,
        )
        for line in lines
    ]


def run(arguments: list[str], timeout: int = 900) -> tuple[int, str]:
    result = subprocess.run(  # noqa: S603 - fixed interpreter and scripts, no shell
        arguments, capture_output=True, text=True, check=False, timeout=timeout
    )
    return result.returncode, result.stdout + result.stderr


def private_copy(directory: Path) -> Path:
    for name in COPIED:
        target = directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    return directory


def mutate(source: str, mutation: Mutation) -> tuple[int, str]:
    """Return how often the site occurs, and the mutated source. Severity lines match whole."""
    if mutation.file == SEVERITY:
        anchored = "\n" + source
        site = "\n" + mutation.before
        return anchored.count(site), anchored.replace(site, "\n" + mutation.after)[1:]
    return source.count(mutation.before), source.replace(mutation.before, mutation.after)


def main() -> int:
    python = sys.executable
    cases: dict[str, list[str]] = {}
    for selftest in SUMMARIES:
        status, listing = run([python, str(ROOT / selftest), "--list"])
        cases[selftest] = listing.split() if status == 0 else []
        if not cases[selftest]:
            print(f"FAIL {selftest} did not list its cases (exit {status})")
            return 1
    overrides = severity_mutations()
    if not overrides:
        print(f"FAIL {SEVERITY} lists no override, so no override mutation would run")
        return 1
    mutations = [*MUTATIONS, *overrides]
    orphans = sorted(
        f"{m.owner} ({m.file})"
        for m in mutations
        if m.file in RUNNERS and m.owner not in cases[RUNNERS[m.file]]
    )
    if orphans:
        print(f"FAIL mutation owners that are not self-test cases: {', '.join(orphans)}")
        return 1

    failures: list[str] = []
    attempted = 0
    with tempfile.TemporaryDirectory(prefix="contract-change-mutations-") as directory:
        workspace = Path(directory)
        control = private_copy(workspace / "control")
        for selftest, summary in SUMMARIES.items():
            status, output = run([python, str(control / selftest), *EXTRA[selftest]])
            expected = f"{summary}: {len(cases[selftest])} case(s)"
            print(output, end="")
            if status != 0 or expected not in output:
                print(
                    f"FAIL control: {selftest} must pass all {len(cases[selftest])} cases (exit {status})"
                )
                return 1
            print(f"PASS control: the unmutated {selftest} passes all {len(cases[selftest])} cases")
        status, output = run([python, str(ROOT / COVERAGE), "--root", str(ROOT)])
        if status != 0:
            print(output)
            print(
                f"FAIL control: the coverage check must pass on the unmutated workflow (exit {status})"
            )
            return 1
        print("PASS control: the coverage check passes on the unmutated workflow")

        for index, mutation in enumerate(mutations):
            attempted += 1
            source = (ROOT / mutation.file).read_text(encoding="utf-8")
            occurrences, mutated = mutate(source, mutation)
            if occurrences != 1:
                failures.append(mutation.name)
                print(
                    f"FAIL {mutation.name}: the mutation site occurs {occurrences} times, not once"
                )
                continue
            if mutation.file == WORKFLOW:
                copy = workspace / str(index)
                shutil.copytree(ROOT / ".github/workflows", copy / ".github/workflows")
                (copy / WORKFLOW).write_text(mutated, encoding="utf-8")
                status, output = run([python, str(ROOT / COVERAGE), "--root", str(copy)])
                caught = status == 1 and mutation.diagnostic in output
            else:
                copy = private_copy(workspace / str(index))
                (copy / mutation.file).write_text(mutated, encoding="utf-8")
                selftest = RUNNERS[mutation.file]
                status, output = run(
                    [python, str(copy / selftest), *EXTRA[selftest], "--case", mutation.owner]
                )
                caught = status == 1 and f"FAIL {mutation.owner}: {mutation.diagnostic}" in output
            if caught:
                print(f"PASS {mutation.name}: refused by {mutation.owner}")
            else:
                failures.append(mutation.name)
                print(output)
                print(
                    f"FAIL {mutation.name}: {mutation.owner} did not refuse it with {mutation.diagnostic!r}"
                )

    if attempted != len(mutations) or failures:
        print(f"contract change mutations FAILED: {len(failures)} of {len(mutations)} not caught")
        return 1
    print(f"contract change mutations passed: {attempted} weakenings, each refused by its owner")
    return 0


if __name__ == "__main__":
    sys.exit(main())
