"""The realm_create provider (worker/providers/keycloak.py), against a stub realm-apply.sh.

The stub records its argv and environment, prints what the test hands it and exits as told. The
live provider qualification needs Keycloak and kcadm and is separate from these stub tests.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import signal
import subprocess
import time
from pathlib import Path

import pytest

from dev.image_context import image_files
from worker.providers import keycloak
from worker.providers.keycloak import RealmApplyError, Target, VendorMismatchError

SECRET = "creator-secret-value-0123456789"
SMTP_SECRET = "smtp-password-value-9876543210"
RUN_ID = "dsp_01J:realm_create.1"
STUB = """#!/usr/bin/env bash
here="$(cd "$(dirname "$0")" && pwd)"
printf '%s\\n' "$@" > "$here/argv"
env > "$here/env"
if [[ -f "$here/hang" ]]; then
  sleep 30 &
  echo $! > "$here/descendant"
  wait
fi
cat "$here/stdout" 2>/dev/null
cat "$here/stderr" >&2 2>/dev/null
exit "$(cat "$here/exit" 2>/dev/null || echo 0)"
"""
# What bash adds to any environment it starts with.
BASH_OWN = {"PWD", "SHLVL", "_", "OLDPWD"}


def record(**overrides: object) -> str:
    value: dict[str, object] = {
        "run_id": RUN_ID,
        "step": 1,
        "name": "create_realm",
        "outcome": "completed",
        "issuer": "https://auth.staging.kodera.io/realms/acme",
        "admin_url": "https://auth-admin.staging.kodera.io",
        "compute_terminated": {
            "provider": "keycloak:auth.staging.kodera.io",
            "resource_id": RUN_ID,
            "request_id": f"{RUN_ID}/1",
            "observed_at": "2026-11-04T22:00:00Z",
        },
        "target_read": {
            "provider": "keycloak:auth.staging.kodera.io",
            "resource_id": "acme",
            "request_id": f"{RUN_ID}/1/read",
            "observed_at": "2026-11-04T22:00:00Z",
        },
        "note": "created",
    }
    value.update(overrides)
    return "run-record " + json.dumps(value)


def pin(vendor: Path) -> None:
    files = {
        name: {"source": name, "sha256": hashlib.sha256((vendor / name).read_bytes()).hexdigest()}
        for name in (keycloak.SCRIPT, keycloak.TEMPLATE)
    }
    (vendor / "PIN.json").write_text(json.dumps({"commit": "0" * 40, "files": files}))


@pytest.fixture
def vendor(tmp_path: Path) -> Path:
    directory = tmp_path / "vendor"
    directory.mkdir()
    (directory / keycloak.SCRIPT).write_text(STUB)
    (directory / keycloak.TEMPLATE).write_text('{"realm": "org-template"}\n')
    pin(directory)
    (directory / "stdout").write_text(record() + "\n")
    return directory


@pytest.fixture
def target(tmp_path: Path) -> Target:
    creator = tmp_path / "creator-secret"
    creator.write_text(SECRET)
    smtp = tmp_path / "smtp-password"
    smtp.write_text(SMTP_SECRET)
    return Target("https://auth-admin.staging.kodera.io", creator, "smtp-user", smtp)


def run(
    vendor: Path, target: Target, step: str = "create_realm", **kw: object
) -> keycloak.Evidence:
    options: dict[str, object] = {"run_id": RUN_ID, "realm": "acme", "timeout": 10.0}
    options.update(kw)
    return keycloak.run_step(step, target=target, vendor=vendor, **options)  # type: ignore[arg-type]


def environment_of(vendor: Path) -> dict[str, str]:
    lines = (vendor / "env").read_text().splitlines()
    return dict(line.split("=", 1) for line in lines if "=" in line)


# --- the pin ------------------------------------------------------------------------------------


def test_the_vendored_files_match_their_pin() -> None:
    pinned = keycloak.verify_vendored()
    assert pinned["repository"] == "kodera-hq/kodera-ops"
    assert len(pinned["commit"]) == 40
    assert set(pinned["files"]) == {keycloak.SCRIPT, keycloak.TEMPLATE}


def test_a_changed_script_is_refused_before_it_runs(vendor: Path, target: Target) -> None:
    with (vendor / keycloak.SCRIPT).open("a") as script:
        script.write("# one more line\n")
    with pytest.raises(VendorMismatchError, match="realm-apply.sh differs from the pinned commit"):
        run(vendor, target)
    assert not (vendor / "argv").exists()


def test_a_changed_template_is_refused(vendor: Path, target: Target) -> None:
    (vendor / keycloak.TEMPLATE).write_text('{"realm": "other"}\n')
    with pytest.raises(VendorMismatchError, match="org-realm-template.json differs"):
        run(vendor, target)


def test_a_missing_file_is_refused(vendor: Path, target: Target) -> None:
    (vendor / keycloak.TEMPLATE).unlink()
    with pytest.raises(VendorMismatchError, match="org-realm-template.json is not vendored"):
        run(vendor, target)


def test_a_pin_that_leaves_a_file_out_is_refused(vendor: Path) -> None:
    pinned = json.loads((vendor / "PIN.json").read_text())
    del pinned["files"][keycloak.TEMPLATE]
    (vendor / "PIN.json").write_text(json.dumps(pinned))
    with pytest.raises(VendorMismatchError, match="must pin exactly"):
        keycloak.verify_vendored(vendor)


# --- argv and environment -----------------------------------------------------------------------


def test_a_step_runs_with_public_arguments_only(vendor: Path, target: Target) -> None:
    run(vendor, target, docs=True)
    argv = (vendor / "argv").read_text().splitlines()
    assert argv == [
        "step", "1", "--target", "staging", "--run-id", RUN_ID,
        "--file", str(vendor / keycloak.TEMPLATE), "--realm", "acme", "--docs",
    ]  # fmt: skip
    assert not any(SECRET in a or SMTP_SECRET in a for a in argv)


def test_verify_runs_the_verify_subcommand(vendor: Path, target: Target) -> None:
    (vendor / "stdout").write_text(record(step=7, name="verify") + "\n")
    run(vendor, target, "verify", visio=True)
    argv = (vendor / "argv").read_text().splitlines()
    assert argv[0] == "verify" and argv[-1] == "--visio" and "--docs" not in argv


@pytest.mark.parametrize("run_id", ["-x", "", "a b", "a/b", "x" * 129])
def test_a_run_id_realm_apply_would_refuse_is_refused_first(
    vendor: Path, target: Target, run_id: str
) -> None:
    with pytest.raises(RealmApplyError, match="run id"):
        run(vendor, target, run_id=run_id)
    assert not (vendor / "argv").exists()


@pytest.mark.parametrize("realm", ["-acme", "Acme", "ac me", "../acme", ""])
def test_a_realm_that_is_not_a_slug_is_refused(vendor: Path, target: Target, realm: str) -> None:
    with pytest.raises(RealmApplyError, match="slug"):
        run(vendor, target, realm=realm)


def test_an_unknown_step_is_refused(vendor: Path, target: Target) -> None:
    with pytest.raises(RealmApplyError, match="not a realm_create step"):
        run(vendor, target, "delete_realm")


def test_the_environment_carries_paths_and_nothing_inherited(
    vendor: Path, target: Target, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@db/core")
    monkeypatch.setenv("KC_ADMIN_PASSWORD", "inherited")
    run(vendor, target)
    env = environment_of(vendor)
    assert set(env) - BASH_OWN <= {
        "PATH", "HOME", "LANG", "KC_SERVER", "KC_CLIENT_ID", "KC_CLIENT_SECRET_FILE",
        "JAVA_HOME", "KCADM",
    }  # fmt: skip
    assert env["KC_CLIENT_ID"] == "kodera-realm-creator"
    assert env["KC_CLIENT_SECRET_FILE"] == str(target.creator_secret_file)
    assert env["KC_SERVER"] == target.admin_url
    assert not any(SECRET in v or SMTP_SECRET in v for v in env.values())


def test_only_the_smtp_step_gets_the_smtp_password_file(vendor: Path, target: Target) -> None:
    (vendor / "stdout").write_text(record(step=5, name="configure_smtp") + "\n")
    run(vendor, target, "configure_smtp")
    env = environment_of(vendor)
    assert env["SMTP_USER"] == "smtp-user"
    assert env["SMTP_PASSWORD_FILE"] == str(target.smtp_password_file)
    assert not any(SMTP_SECRET in v for v in env.values())


def test_the_smtp_step_without_its_password_file_is_refused(vendor: Path, target: Target) -> None:
    bare = Target(target.admin_url, target.creator_secret_file)
    with pytest.raises(RealmApplyError, match="SMTP"):
        run(vendor, bare, "configure_smtp")
    assert not (vendor / "argv").exists()


# --- the run record -----------------------------------------------------------------------------


def test_the_run_record_becomes_the_steps_evidence(vendor: Path, target: Target) -> None:
    (vendor / "stdout").write_text("progress line\n" + record() + "\n")
    evidence = run(vendor, target)
    assert evidence.step == "create_realm"
    assert evidence.record["target_read"]["resource_id"] == "acme"
    assert evidence.record["admin_url"] == "https://auth-admin.staging.kodera.io"
    assert "note" not in evidence.record


def test_the_admin_url_keeps_no_credential(vendor: Path, target: Target) -> None:
    (vendor / "stdout").write_text(
        record(admin_url="http://user:pw@localhost:18443/admin?token=t#frag") + "\n"
    )
    evidence = run(vendor, target)
    assert evidence.record["admin_url"] == "http://localhost:18443/admin"


def test_unknown_keys_are_dropped(vendor: Path, target: Target) -> None:
    line = record(secret="x", compute_terminated={"provider": "p", "token": "t", "request_id": "r"})
    (vendor / "stdout").write_text(line + "\n")
    evidence = run(vendor, target)
    assert "secret" not in evidence.record
    assert evidence.record["compute_terminated"] == {"provider": "p", "request_id": "r"}


# --- the four conditions on an untagged run record (S7) -----------------------------------------
# Each test below fails when its condition's rule is flipped (the PR's mutation table).


def test_s7_1_the_records_outcome_note_and_issuer_host_decide_nothing(
    vendor: Path, target: Target
) -> None:
    (vendor / "stdout").write_text(record() + "\n")
    plain = run(vendor, target)
    (vendor / "stdout").write_text(
        record(
            outcome="failed",
            note="nothing was done",
            issuer="https://elsewhere.example/realms/acme",
        )
        + "\n"
    )
    odd = run(vendor, target)
    # Exit status 0 and the step match decide: the same step completes either way.
    assert (odd.step, type(odd)) == (plain.step, type(plain))
    assert odd.record["outcome"] == "failed"


def test_s7_2_a_nonzero_exit_fails_the_step_even_with_a_completed_record(
    vendor: Path, target: Target
) -> None:
    (vendor / "exit").write_text("1")
    with pytest.raises(RealmApplyError, match="failed with exit status 1"):
        run(vendor, target)


@pytest.mark.parametrize("stdout", ["", "progress only\n", record() + "\n" + record() + "\n"])
def test_s7_2_a_zero_exit_without_exactly_one_record_fails_the_step(
    vendor: Path, target: Target, stdout: str
) -> None:
    (vendor / "stdout").write_text(stdout)
    with pytest.raises(RealmApplyError, match="run records, not one"):
        run(vendor, target)


@pytest.mark.parametrize(
    "override",
    [
        {"run_id": "other"},
        {"step": 2},
        {"name": "create_clients"},
        {"issuer": "https://auth.staging.kodera.io/realms/other"},
        {"issuer": None},
    ],
    ids=["run_id", "step", "name", "realm", "no-issuer"],
)
def test_s7_3_a_record_of_another_run_step_or_realm_fails_the_step(
    vendor: Path, target: Target, override: dict[str, object]
) -> None:
    (vendor / "stdout").write_text(record(**override) + "\n")
    with pytest.raises(RealmApplyError, match="does not match the step"):
        run(vendor, target)


def test_s7_4_a_record_past_its_size_bound_fails_the_step(vendor: Path, target: Target) -> None:
    (vendor / "stdout").write_text(record(note="x" * keycloak.MAX_RECORD_BYTES) + "\n")
    with pytest.raises(RealmApplyError, match="longer than 8192 bytes"):
        run(vendor, target)


def test_s7_4_the_stored_record_is_plain_json_of_strings(vendor: Path, target: Target) -> None:
    line = record(target_read={"provider": "p", "resource_id": ["<b>x</b>"], "request_id": 7})
    (vendor / "stdout").write_text(line + "\n")
    evidence = run(vendor, target)
    assert evidence.record["target_read"] == {
        "provider": "p",
        "resource_id": "['<b>x</b>']",
        "request_id": "7",
    }
    assert json.loads(json.dumps(evidence.record)) == evidence.record


def test_a_record_without_its_observations_is_refused(vendor: Path, target: Target) -> None:
    (vendor / "stdout").write_text(record(target_read=None) + "\n")
    with pytest.raises(RealmApplyError, match="has no target_read"):
        run(vendor, target)


# --- failure and timeout ------------------------------------------------------------------------


def test_a_failed_step_keeps_stderr_off_its_message(vendor: Path, target: Target) -> None:
    (vendor / "stdout").write_text("")
    (vendor / "stderr").write_text(f"realm-apply.sh: refused, body {SECRET}\n")
    (vendor / "exit").write_text("3")
    with pytest.raises(RealmApplyError) as raised:
        run(vendor, target)
    assert raised.value.exit_code == 3
    assert SECRET not in str(raised.value) and SECRET not in repr(raised.value)
    assert "refused" in raised.value.diagnostics


def test_a_step_past_its_timeout_ends_and_leaves_its_descendants_to_the_group_kill(
    vendor: Path, target: Target
) -> None:
    (vendor / "hang").write_text("")
    started = time.monotonic()
    with pytest.raises(RealmApplyError, match="did not finish within 1 s"):
        run(vendor, target, timeout=1.0)
    # Not held by the descendant's open pipes.
    assert time.monotonic() - started < 10
    descendant = int((vendor / "descendant").read_text())
    try:
        # Still in the caller's group, so the runner's kill of the step child's group reaches it.
        assert os.getpgid(descendant) == os.getpgrp()
    finally:
        os.kill(descendant, signal.SIGKILL)


# --- the images ---------------------------------------------------------------------------------


def test_only_the_worker_image_carries_realm_apply_and_kcadm() -> None:
    root = Path(__file__).resolve().parents[2]
    worker = set(image_files(root, "Dockerfile.worker"))
    assert {
        "worker/providers/keycloak.py",
        "worker/vendor/keycloak/PIN.json",
        "worker/vendor/keycloak/realm-apply.sh",
        "worker/vendor/keycloak/org-realm-template.json",
    } <= worker
    assert "kcadm" in (root / "Dockerfile.worker").read_text()
    for dockerfile in sorted(
        p.name for p in root.glob("Dockerfile*") if p.suffix != ".dockerignore"
    ):
        if dockerfile == "Dockerfile.worker":
            continue
        assert not [f for f in image_files(root, dockerfile) if f.startswith("worker/")], dockerfile
        assert "kcadm" not in (root / dockerfile).read_text().lower(), dockerfile


def test_worker_dockerfile_jdeps_strips_split_package_warnings_before_jlink(
    tmp_path: Path,
) -> None:
    root = Path(__file__).resolve().parents[2]
    dockerfile = (root / "Dockerfile.worker").read_text()
    joined = re.sub(r"\\\n[ \t]*", " ", dockerfile)
    matches = [
        line.removeprefix("RUN ").strip()
        for line in joined.splitlines()
        if line.startswith("RUN ") and "jdeps " in line and "jlink " in line
    ]
    assert len(matches) == 1, "expected exactly one jdeps+jlink RUN step in Dockerfile.worker"
    # Containment check before running under /bin/sh -c: only /opt/kcadm and /dev/null absolute paths may appear.
    abs_paths = set(re.findall(r"(?<![A-Za-z0-9_.-])/[A-Za-z0-9_./*-]+", matches[0]))
    assert all(p == "/dev/null" or p.startswith("/opt/kcadm") for p in abs_paths), abs_paths

    kcadm_root = tmp_path / "opt" / "kcadm"
    assert not any(c in str(kcadm_root) for c in " \t\n'\"$`\\;|*?")
    lib_dir = kcadm_root / "bin" / "client" / "lib"
    lib_dir.mkdir(parents=True)
    cli_jar = kcadm_root / "bin" / "client" / "keycloak-admin-cli-26.8.2.jar"
    bc_jar = lib_dir / "bcprov-jdk18on-1.86.jar"
    cli_jar.write_text("")
    bc_jar.write_text("")

    kcadm_called = tmp_path / "kcadm.called"
    kcadm_sh = kcadm_root / "bin" / "kcadm.sh"
    kcadm_sh.write_text(
        f"#!/bin/sh\nprintf '%s\\n' \"$JAVA_HOME|$*\" > {shlex.quote(str(kcadm_called))}\n"
    )
    kcadm_sh.chmod(0o755)

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    jdeps_called = tmp_path / "jdeps.called"
    jdeps_stub = bin_dir / "jdeps"
    jdeps_stub.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$@\" > {shlex.quote(str(jdeps_called))}\n"
        'cat "$FAKE_JDEPS_STDOUT"\n'
        'exit "${FAKE_JDEPS_EXIT:-0}"\n'
    )
    jdeps_stub.chmod(0o755)

    jlink_called = tmp_path / "jlink.called"
    jlink_stub = bin_dir / "jlink"
    jlink_stub.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$@\" > {shlex.quote(str(jlink_called))}\n")
    jlink_stub.chmod(0o755)

    cmd = matches[0].replace("/opt/kcadm", str(kcadm_root))
    base_env = {
        "PATH": f"{bin_dir}:/usr/bin:/bin",
        "HOME": str(tmp_path),
    }
    stdout_file = tmp_path / "jdeps.stdout"

    def run_step(jdeps_stdout: str, jdeps_exit: int = 0) -> subprocess.CompletedProcess[str]:
        jdeps_called.unlink(missing_ok=True)
        jlink_called.unlink(missing_ok=True)
        kcadm_called.unlink(missing_ok=True)
        stdout_file.write_text(jdeps_stdout)
        # Match Docker's default SHELL ["/bin/sh", "-c"] (without -e) so && chaining is genuinely tested.
        return subprocess.run(  # noqa: S603 - fixed /bin/sh -c and path-contained Dockerfile command
            ["/bin/sh", "-c", cmd],
            cwd=tmp_path,
            env={
                **base_env,
                "FAKE_JDEPS_STDOUT": str(stdout_file),
                "FAKE_JDEPS_EXIT": str(jdeps_exit),
            },
            text=True,
            capture_output=True,
            check=False,
        )

    # Case 1a: Warning-free jdeps output links cleanly.
    clean = run_step("java.base,java.logging\n")
    assert clean.returncode == 0, clean.stderr

    # Case 1b: BouncyCastle 1.86 split-package warnings (+ interior/trailing blank lines) are stripped.
    ok = run_step(
        "Warning: split package: org.bouncycastle.util "
        "file:///opt/kcadm/bin/client/lib/bcprov-jdk18on-1.86.jar "
        "/opt/kcadm/bin/client/lib/bcprov-jdk18on-1.86.jar\n\n"
        "java.base,java.logging,jdk.unsupported\n\n"
    )
    assert ok.returncode == 0, ok.stderr
    jdeps_args = jdeps_called.read_text().splitlines()
    cp_idx = jdeps_args.index("--class-path")
    assert jdeps_args[cp_idx + 1] == f"{kcadm_root}/bin/client/lib/*"
    assert str(cli_jar) in jdeps_args
    assert str(bc_jar) in jdeps_args
    jlink_args = jlink_called.read_text().splitlines()
    add_modules_idx = jlink_args.index("--add-modules")
    assert jlink_args[add_modules_idx + 1] == (
        "java.base,java.logging,jdk.unsupported,"
        "java.desktop,java.naming,java.security.jgss,java.sql,jdk.crypto.ec"
    )
    assert kcadm_called.read_text().strip() == f"{kcadm_root / 'jre'}|--help"

    # Case 2: Non-zero jdeps exit status aborts under /bin/sh -c before jlink or kcadm.
    failed_exit = run_step("java.base,java.logging\n", jdeps_exit=2)
    assert failed_exit.returncode == 2
    assert not jlink_called.exists()
    assert not kcadm_called.exists()

    # Case 3: Warning-only, multi-line non-warning, or malformed module output fails closed with stderr diagnostic.
    for bad_stdout in (
        "Warning: split package: org.bouncycastle.util\n",
        "java.base\njava.logging\n",
        "java..base\n",
        "INVALID_MODULE!\n",
    ):
        failed_parse = run_step(bad_stdout)
        assert failed_parse.returncode != 0
        assert "invalid jdeps module output:" in failed_parse.stderr
        assert not jlink_called.exists()
        assert not kcadm_called.exists()
