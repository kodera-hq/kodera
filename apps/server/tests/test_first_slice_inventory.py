"""CLI acceptance: admitting a manifest never passes absent product behavior."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[1]
EXPECTED = [
    *(f"FS-BOOT-{i:02}" for i in range(1, 8)),
    *(f"FS-LIFE-{i:02}" for i in range(1, 4)),
    *(f"FS-ID-{i:02}" for i in range(1, 4)),
    *(f"FS-OP-{i:02}" for i in range(1, 7)),
    *(f"FS-CON-{i:02}" for i in range(1, 7)),
    *(f"FS-BILL-{i:02}" for i in range(1, 7)),
    "FS-JOURNEY-01",
    "FS-HARNESS-01",
]


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


def run(root, *args, case=""):
    import sys

    p = subprocess.run(  # noqa: S603 - fixed local CLI with separate arguments
        [sys.executable, str(root / "dev/accept_first_slice.py"), *args],
        cwd=root,
        capture_output=True,
        text=True,
        env={**os.environ, "CASE": case},
        timeout=5,
    )
    return p, json.loads(p.stdout)


def change_manifest(root, change):
    p = root / "dev/first_slice_manifest.json"
    data = json.loads(p.read_text())
    change(data)
    p.write_text(json.dumps(data))


def test_full_inventory_is_explicitly_non_passing(repo):
    p, d = run(repo)
    assert p.returncode == 1, "absent product behavior must never return success"
    assert d["status"] == "not_implemented"
    assert d["scope"] == "full"
    assert [s["id"] for s in d["scenarios"]] == EXPECTED
    assert all(
        s["status"] == "not_implemented" and s["observed_assertions"] == [] for s in d["scenarios"]
    )
    assert d["runtime_admission"] == "not_implemented"
    assert d["dependencies"]["observation"] == "not_probed"
    assert len(d["source"]["commit"]) == 40
    assert d["source"]["dirty"] is False
    assert len(d["source"]["fingerprint"]) == 64
    assert d["fixture_seed"] == "first-slice-synthetic-v1"


@pytest.mark.parametrize("case", EXPECTED)
def test_each_selector_is_partial_and_non_passing(repo, case):
    p, d = run(repo, case=case)
    assert p.returncode == 1 and d["scope"] == "partial"
    assert [s["id"] for s in d["scenarios"]] == [case]
    assert d["scenarios"][0]["status"] == "not_implemented"


def test_cli_selector_overrides_environment(repo):
    p, d = run(repo, "--case", "FS-BOOT-01", case="FS-ID-01")
    assert p.returncode == 1 and d["scenarios"][0]["id"] == "FS-BOOT-01"


def test_unknown_case_is_blocked_without_echoing_input(repo):
    p, d = run(repo, case="synthetic-sensitive-canary")
    assert p.returncode == 2 and d["status"] == "blocked"
    assert d["reason"] == "unknown_scenario"
    assert "synthetic-sensitive-canary" not in p.stdout + p.stderr


@pytest.mark.parametrize(
    "kind",
    [
        "missing",
        "duplicate",
        "unknown",
        "skip",
        "result",
        "command",
        "empty",
        "format",
        "bool",
        "extra",
        "description",
    ],
)
def test_invalid_manifest_cannot_admit_or_inject_results(repo, kind):
    def mutate(d):
        if kind == "missing":
            d["scenarios"].pop()
        elif kind == "duplicate":
            d["scenarios"][-1] = d["scenarios"][0]
        elif kind == "unknown":
            d["scenarios"][-1]["id"] = "FS-FAKE-01"
        elif kind in {"skip", "result", "command"}:
            d["scenarios"][0][kind] = "passed"
        elif kind == "empty":
            d["scenarios"] = []
        elif kind == "format":
            d["format"] = 2
        elif kind == "bool":
            d["format"] = True
        elif kind == "extra":
            d["ignored"] = "value"
        elif kind == "description":
            d["scenarios"][0]["description"] = " "

    change_manifest(repo, mutate)
    p, d = run(repo)
    assert p.returncode == 2, "invalid manifests must be blocked before scenario reporting"
    assert d["status"] == "blocked"
    assert d["reason"] == "invalid_manifest"
    assert "scenarios" not in d


@pytest.mark.parametrize(
    "content",
    ['{"format":1,"format":1,"scenarios":[]}', '{"scenarios":NaN}', "invalid-canary", "x" * 262145],
    ids=["duplicate-json-key", "nonfinite-number", "malformed-json", "oversized-manifest"],
)
def test_malformed_duplicate_non_json_and_oversized_manifest(repo, content):
    (repo / "dev/first_slice_manifest.json").write_text(content)
    p, d = run(repo)
    assert p.returncode == 2 and d["reason"] == "invalid_manifest"
    assert "invalid-canary" not in p.stdout + p.stderr


def test_missing_manifest_is_blocked(repo):
    (repo / "dev/first_slice_manifest.json").unlink()
    p, d = run(repo)
    assert p.returncode == 2 and d["reason"] == "invalid_manifest"


def test_fingerprint_observes_content_not_only_status(repo):
    path = repo / "untracked.txt"
    path.write_text("synthetic-first-secret")
    p1, d1 = run(repo)
    path.write_text("synthetic-other-secret")
    p2, d2 = run(repo)
    assert p1.returncode == p2.returncode == 1
    assert d1["source"]["dirty"] and d2["source"]["dirty"]
    assert d1["source"]["fingerprint"] != d2["source"]["fingerprint"], (
        "source fingerprint must change when file contents change"
    )
    assert "synthetic-first-secret" not in p1.stdout + p1.stderr
    assert "synthetic-other-secret" not in p2.stdout + p2.stderr


def test_fingerprint_distinguishes_staged_contents(repo):
    path = repo / "tracked.txt"
    path.write_text("first")
    git(repo, "add", "tracked.txt")
    _, first = run(repo)
    path.write_text("other")
    git(repo, "add", "tracked.txt")
    path.write_text("first")
    _, second = run(repo)
    assert first["source"]["fingerprint"] != second["source"]["fingerprint"]


def test_fingerprint_tracks_deleted_files_and_modes(repo):
    path = repo / "tracked.txt"
    path.write_text("fixture")
    git(repo, "add", "tracked.txt")
    git(repo, "commit", "-m", "Add content fixture")
    _, a = run(repo)
    path.chmod(0o755)
    _, b = run(repo)
    path.unlink()
    _, c = run(repo)
    assert len({x["source"]["fingerprint"] for x in [a, b, c]}) == 3


def test_symlink_text_hashed_without_reading_external_target(repo, tmp_path):
    target = tmp_path / "external"
    target.write_text("external-one")
    (repo / "link").symlink_to(target)
    _, a = run(repo)
    target.write_text("external-two")
    _, b = run(repo)
    assert a["source"]["fingerprint"] == b["source"]["fingerprint"]
    assert "external-one" not in json.dumps(a)


def test_parent_symlink_blocks_source_capture(repo, tmp_path):
    folder = repo / "folder"
    folder.mkdir()
    (folder / "file").write_text("owned")
    git(repo, "add", "folder/file")
    shutil.rmtree(folder)
    folder.symlink_to(tmp_path, target_is_directory=True)
    p, d = run(repo)
    assert p.returncode == 2 and d["reason"] == "source_unavailable"


def test_non_git_source_is_blocked(repo):
    shutil.rmtree(repo / ".git")
    p, d = run(repo)
    assert p.returncode == 2 and d["reason"] == "source_unavailable"


@pytest.mark.parametrize("kind", ["fifo", "symlink", "directory"])
def test_manifest_nonregular_nodes_are_refused_before_open(repo, kind):
    path = repo / "dev/first_slice_manifest.json"
    path.unlink()
    if kind == "fifo":
        os.mkfifo(path)
    elif kind == "symlink":
        path.symlink_to("/dev/zero")
    else:
        path.mkdir()
    p, d = run(repo)
    assert p.returncode == 2 and d["reason"] == "invalid_manifest"


def test_oversized_source_is_non_passing_and_not_echoed(repo):
    with (repo / "large-untracked").open("wb") as handle:
        handle.truncate(65 * 1024 * 1024)
    p, d = run(repo)
    assert p.returncode == 2 and d["reason"] == "source_unavailable"


def test_unreadable_source_is_refused(repo):
    path = repo / "unreadable"
    path.write_text("synthetic-secret-canary")
    path.chmod(0)
    try:
        p, d = run(repo)
        assert p.returncode == 2 and d["reason"] == "source_unavailable"
        assert "synthetic-secret-canary" not in p.stdout + p.stderr
    finally:
        path.chmod(0o600)


def test_unknown_cli_argument_is_redacted(repo):
    p, d = run(repo, "--synthetic-private-argument-canary")
    assert p.returncode == 2 and d["reason"] == "invalid_arguments"
    assert "synthetic-private-argument-canary" not in p.stdout + p.stderr


def load_runner(root):
    import runpy

    return runpy.run_path(str(root / "dev/accept_first_slice.py"))


def test_source_change_after_its_read_is_refused(repo):
    module = load_runner(repo)
    function = module["source"]
    original = function.__globals__["git"]
    late = repo / "late.txt"
    late.write_text("initial")
    calls = 0

    def mutate_after_read(root, *args):
        nonlocal calls
        if args == ("ls-files", "--stage", "-z"):
            calls += 1
            if calls == 2:
                late.write_text("changed")
        return original(root, *args)

    function.__globals__["git"] = mutate_after_read
    with pytest.raises(module["AdmissionError"], match="source_unavailable"):
        function(repo)


def test_manifest_changed_between_admission_and_source_is_refused(repo):
    module = load_runner(repo)
    _, admitted = module["manifest"](repo)
    change_manifest(
        repo, lambda d: d["scenarios"][0].update(description="Different admitted assertion")
    )
    with pytest.raises(module["AdmissionError"], match="source_unavailable"):
        module["source"](repo, admitted)


def test_source_replaced_by_fifo_cannot_block_open(repo):
    import sys

    (repo / "racy.txt").write_text("owned")
    probe = """
import os, runpy, sys
from pathlib import Path
root = Path(sys.argv[1])
module = runpy.run_path(str(root / "dev/accept_first_slice.py"))
original = os.open
victim = root / "racy.txt"
def replace(path, *args, **kwargs):
    if path == victim:
        victim.unlink()
        os.mkfifo(victim)
    return original(path, *args, **kwargs)
os.open = replace
try:
    module["source"](root)
except module["AdmissionError"] as error:
    print(str(error))
"""
    p = subprocess.run(  # noqa: S603 - fixed synthetic child probe
        [sys.executable, "-c", probe, str(repo)],
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert p.returncode == 0 and p.stdout.strip() == "source_unavailable"


@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_git_capture_refuses_oversized_stream_while_child_runs(repo, stream):
    import sys

    module = load_runner(repo)
    function = module["git"]
    real_popen = subprocess.Popen
    function.__globals__["SOURCE_LIMIT"] = 128
    code = f"import sys,time;sys.{stream}.write('x'*8192);sys.{stream}.flush();time.sleep(30)"

    def noisy_child(*args, **kwargs):
        return real_popen([sys.executable, "-c", code], **kwargs)

    import time
    from unittest.mock import patch

    start = time.monotonic()
    with patch.object(subprocess, "Popen", noisy_child):
        with pytest.raises(module["AdmissionError"], match="source_unavailable"):
            function(repo, "status")
    assert time.monotonic() - start < 5


def test_full_normalized_command_clears_inherited_case(repo):
    p, d = run(repo, "--case", "", case="FS-BOOT-01")
    assert p.returncode == 1 and d["scope"] == "full"
    assert d["command"] == ["make", "acceptance-first-slice", "CASE="]


@pytest.mark.parametrize(
    "environment_case,argument_case,expected",
    [
        ("", None, "full"),
        ("FS-BOOT-01", None, "partial"),
        ("FS-BOOT-01", "", "full"),
        ("", "FS-BOOT-01", "partial"),
        ("", "unknown-synthetic-case", "blocked"),
    ],
)
def test_actual_make_entry_point_preserves_selector(
    repo, environment_case, argument_case, expected
):
    import shlex
    import sys

    dispatcher = repo / "reviewed-python-dispatch"
    dispatcher.write_text(
        '#!/bin/sh\n[ "$1" = run ] && [ "$2" = python ] || exit 90\nshift 2\nexec '
        + shlex.quote(sys.executable)
        + ' "$@"\n'
    )
    dispatcher.chmod(0o755)
    args = ["make", "--no-print-directory", f"UV={dispatcher}", "acceptance-first-slice"]
    if argument_case is not None:
        args.append(f"CASE={argument_case}")
    p = subprocess.run(  # noqa: S603 - real checked-in Make target; literal selectors
        args,
        cwd=repo,
        env={**os.environ, "CASE": environment_case},
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert p.returncode != 0
    assert p.stdout.strip(), "Make entry point must emit its structured scenario report"
    report = json.loads(p.stdout)
    if expected == "blocked":
        assert report["status"] == "blocked" and report["reason"] == "unknown_scenario"
    else:
        assert report["scope"] == expected and report["status"] == "not_implemented"
