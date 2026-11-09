#!/usr/bin/env python3
"""Exercise ratification eligibility in isolated Git repositories, without a remote."""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CHECKER = Path(__file__).with_name("check-adr-status.py")
ADR = "docs/adr/0001-first-decision.md"
OTHER = "docs/adr/0002-second-decision.md"
REGISTERS = ("docs/adr/README.md", "docs/INDEX.md")


def git(root, *args):
    executable = shutil.which("git")
    if executable is None:
        sys.exit("ratification self-test requires Git")
    # All operations and values originate in disposable synthetic fixtures.
    return (
        subprocess.check_output(  # noqa: S603
            [executable, "-c", "core.hooksPath=/dev/null", "-C", str(root), *args],
            stderr=subprocess.PIPE,
            timeout=10,
        )
        .decode()
        .strip()
    )


def replace(root, path, before, after):
    target = root / path
    body = target.read_text()
    if before not in body:
        sys.exit(f"broken fixture: {before!r} absent from {path}")
    target.write_text(body.replace(before, after, 1))


def commit(root):
    git(root, "add", "-A")
    git(root, "commit", "-qm", "Record fixture transition")


def add_decision(root, path, title):
    (root / path).write_text(
        f"# {title}\n\n**Status:** Proposed\n\n## Context\n\nSynthetic proposal.\n"
    )
    for register in REGISTERS:
        link = Path(path).name if register == REGISTERS[0] else f"adr/{Path(path).name}"
        with (root / register).open("a") as handle:
            handle.write(f"| [{title}]({link}) | Proposed |\n")


def fixture(root):
    (root / "docs/adr").mkdir(parents=True)
    for register in REGISTERS:
        (root / register).write_text("# Register\n\n| Decision | Status |\n| --- | --- |\n")
    add_decision(root, ADR, "First decision")
    git(root, "init", "-q", "-b", "fix/fixture")
    git(root, "config", "user.name", "Fixture Author")
    git(root, "config", "user.email", "author@example.test")
    commit(root)
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD")


def accept(root, path=ADR):
    replace(root, path, "**Status:** Proposed", "**Status:** Accepted")
    name = Path(path).name
    for register in REGISTERS:
        target = root / register
        target.write_text(
            "".join(
                line.replace("| Proposed |", "| Accepted |") if name in line else line
                for line in target.read_text().splitlines(keepends=True)
            )
        )


def prepare(root, case):
    if case in {"omitted-input", "wrong-input", "partial-input"}:
        prepare(root, "multiple" if case == "partial-input" else "content")
        return
    if case in {"untouched-unrelated", "untouched-proposal"}:
        fixture(root)
        accept(root)
        if case == "untouched-proposal":
            add_decision(root, OTHER, "Second decision")
        commit(root)
        git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
        if case == "untouched-unrelated":
            (root / "note.md").write_text("Legitimate unrelated feature change.\n")
        else:
            replace(root, OTHER, "Synthetic proposal.", "Revised pending proposal.")
        commit(root)
        return
    fixture(root)
    if case in {"multiple", "unrelated-proposal"}:
        add_decision(root, OTHER, "Second decision")
    if case in {"deleted-unrelated", "modified-unrelated"}:
        (root / "existing.md").write_text("Existing documentation.\n")
    if case == "base-accepted":
        accept(root)
    if case == "base-duplicate-status":
        with (root / ADR).open("a") as handle:
            handle.write("**Status:** Proposed\n")
    if case.startswith("base-duplicate-register"):
        reg = REGISTERS[int(case[-1])]
        with (root / reg).open("a") as handle:
            handle.write((root / reg).read_text().splitlines()[-1] + "\n")
    if case == "reference":
        for reg in REGISTERS:
            body = (root / reg).read_text()
            link = Path(ADR).name if reg == REGISTERS[0] else f"adr/{Path(ADR).name}"
            (root / reg).write_text(
                body.replace(f"[First decision]({link})", "[First decision][first]")
                + f"\n[first]: <{link}?plain=1#context>\n"
            )
    if case in {
        "multiple",
        "unrelated-proposal",
        "deleted-unrelated",
        "modified-unrelated",
        "base-accepted",
        "base-duplicate-status",
        "reference",
    } or case.startswith("base-duplicate-register"):
        commit(root)
        git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
    if case == "base-accepted":
        replace(root, ADR, "Synthetic proposal.", "Changed accepted content.")
        for register in REGISTERS:
            replace(root, register, "# Register", "# Changed register")
    else:
        accept(root)
    if case == "reference":
        for register in REGISTERS:
            replace(root, register, "| Proposed |", "| Accepted |")
    if case == "multiple":
        accept(root, OTHER)
    if case == "unrelated-proposal":
        replace(root, OTHER, "Synthetic proposal.", "Unrelated proposal edit.")
    if case == "deleted-unrelated":
        (root / "existing.md").unlink()
    if case == "modified-unrelated":
        replace(root, "existing.md", "Existing", "Edited")
    if case == "approval-text":
        replace(root, ADR, "Synthetic proposal.", "Approval: accepted by all reviewers.")
    if case == "content":
        replace(root, ADR, "Synthetic proposal.", "Changed proposal.")
    if case in {"duplicate-empty-status", "duplicate-indented-status"}:
        with (root / ADR).open("a") as handle:
            handle.write(
                "**Status:**\n" if case == "duplicate-empty-status" else "  **Status:** Accepted\n"
            )
    if case == "duplicate-status":
        with (root / ADR).open("a") as handle:
            handle.write("**Status:** Accepted\n")
    if case == "whitespace":
        replace(root, ADR, "**Status:** Accepted", "**Status:**  Accepted")
    if case == "line-endings":
        (root / ADR).write_bytes((root / ADR).read_bytes().replace(b"\n", b"\r\n"))
    if case.startswith("register-text"):
        replace(root, REGISTERS[int(case[-1])], "# Register", "# Different register")
    if case.startswith("register-title"):
        replace(root, REGISTERS[int(case[-1])], "First decision", "Different title")
    if case.startswith("register-duplicate"):
        register = REGISTERS[int(case[-1])]
        with (root / register).open("a") as handle:
            handle.write((root / register).read_text().splitlines()[-1] + "\n")
    if case == "symlink-register":
        body = (root / REGISTERS[0]).read_text()
        external = root.parent / "external-register.md"
        external.write_text(body)
        (root / REGISTERS[0]).unlink()
        (root / REGISTERS[0]).symlink_to(external)
    if case == "new-accepted":
        add_decision(root, OTHER, "Second decision")
        accept(root, OTHER)
    if case in {"unrelated", "checker", "policy"}:
        path = {
            "unrelated": "note.md",
            "checker": "scripts/ci/check-adr-status.py",
            "policy": "AGENTS.md",
        }[case]
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text("Synthetic unrelated change.\n")
    if case == "mode":
        (root / ADR).chmod(0o755)
    if case == "deleted-register":
        (root / REGISTERS[0]).unlink()
    if case != "dirty":
        commit(root)
    if case == "untracked":
        (root / "extra.md").write_text("Untracked.\n")
    if case == "missing-base":
        git(root, "update-ref", "-d", "refs/remotes/origin/main")
    if case == "stale-base":
        head = git(root, "rev-parse", "HEAD")
        git(root, "checkout", "-qb", "fix/base-advance", "refs/remotes/origin/main")
        git(root, "commit", "--allow-empty", "-qm", "Advance base without changing proposal")
        git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
        git(root, "checkout", "-q", head)
    if case == "shallow":
        (root / ".git/shallow").write_text(git(root, "rev-parse", "HEAD") + "\n")
    if case == "merge-checkout":
        git(root, "checkout", "-qb", "fix/merge", "refs/remotes/origin/main")
        git(root, "merge", "--no-ff", "-qm", "Merge fixture", "fix/fixture")


CASES = {
    "omitted-input": (1, "changed ADR input does not match pinned Git diff"),
    "wrong-input": (1, "changed ADR input does not match pinned Git diff"),
    "partial-input": (1, "changed ADR input does not match pinned Git diff"),
    "untouched-unrelated": (0, "valid and match every register"),
    "untouched-proposal": (0, "valid and match every register"),
    "single": (0, "eligible; pending human decision review"),
    "multiple": (0, "eligible; pending human decision review"),
    "reference": (0, "eligible; pending human decision review"),
    "merge-checkout": (0, "eligible; pending human decision review"),
    "approval-text": (1, "only the unique status value may change"),
    "unrelated-proposal": (1, "entire ratification diff must contain only"),
    "deleted-unrelated": (1, "entire ratification diff must contain only"),
    "modified-unrelated": (1, "entire ratification diff must contain only"),
    "symlink-register": (1, "is a symbolic link"),
    "shallow": (1, "ratification requires complete history"),
    "register-duplicate0": (1, "only candidate register status cells may change"),
    "register-duplicate1": (1, "only candidate register status cells may change"),
    "content": (1, "only the unique status value may change"),
    "whitespace": (1, "only the unique status value may change"),
    "line-endings": (1, "only the unique status value may change"),
    "base-accepted": (1, "base status must be Proposed"),
    "base-duplicate-status": (1, "exactly one status line"),
    "duplicate-empty-status": (1, "exactly one status line"),
    "duplicate-indented-status": (1, "exactly one status line"),
    "duplicate-status": (1, "exactly one status line"),
    "base-duplicate-register0": (1, "base register must contain exactly one row"),
    "base-duplicate-register1": (1, "base register must contain exactly one row"),
    "register-text0": (1, "only candidate register status cells may change"),
    "register-text1": (1, "only candidate register status cells may change"),
    "register-title0": (1, "only candidate register status cells may change"),
    "register-title1": (1, "only candidate register status cells may change"),
    "new-accepted": (1, "only existing regular files may be modified"),
    "unrelated": (1, "entire ratification diff must contain only"),
    "checker": (1, "entire ratification diff must contain only"),
    "policy": (1, "entire ratification diff must contain only"),
    "mode": (1, "only existing regular files may be modified"),
    "deleted-register": (1, "register is missing"),
    "dirty": (1, "ratification requires a clean committed working tree"),
    "untracked": (1, "ratification requires a clean committed working tree"),
    "missing-base": (1, "cannot read ratification Git evidence"),
    "stale-base": (1, "current main base must be an ancestor of HEAD"),
}


def main():
    with tempfile.TemporaryDirectory(prefix="adr-ratification-selftest-") as temp:
        for case, (expected, diagnostic) in CASES.items():
            root = Path(temp) / case
            prepare(root, case)
            changed = (
                ADR
                if case == "missing-base"
                else git(root, "diff", "--name-only", "refs/remotes/origin/main", "HEAD")
            )
            if case == "omitted-input":
                changed = ""
            elif case == "wrong-input":
                changed = OTHER
            elif case == "partial-input":
                changed = ADR
            # Execute only the sibling checker against a synthetic fixture.
            result = subprocess.run(  # noqa: S603
                [sys.executable, str(CHECKER), str(root), "--changed-on-stdin"],
                input=changed,
                text=True,
                capture_output=True,
                timeout=10,
                env={**os.environ, "GITHUB_REF_NAME": "fix/fixture"},
            )
            if result.returncode != expected or diagnostic not in result.stdout:
                sys.exit(
                    f"ratification self-test FAILED: {case}: expected {expected} and {diagnostic!r}; got {result.returncode}\n{result.stdout}\n{result.stderr}"
                )
            if expected == 0 and not case.startswith("untouched-"):
                if any(
                    git(root, "rev-parse", ref) not in result.stdout
                    for ref in ("refs/remotes/origin/main", "HEAD")
                ):
                    sys.exit(
                        f"ratification self-test FAILED: {case}: base or HEAD SHA not reported"
                    )
            print(f"  ok  ratification-{case}: exit {expected}")
    print(f"ratification self-test passed: {len(CASES)} cases")


if __name__ == "__main__":
    main()
