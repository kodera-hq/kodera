"""Pure scenario acceptance first; these tests never start a service."""

import copy
import importlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def module():
    assert (ROOT / "dev/membership_directory_image_acceptance.py").is_file(), (
        "directory image scenario is absent"
    )
    return importlib.import_module("dev.membership_directory_image_acceptance")


def test_fixed_scenario_entrypoint_exists_before_resource_use():
    assert (ROOT / "dev/accept_membership_directory_image.py").is_file(), (
        "directory image entrypoint is absent"
    )
    assert module().OPERATIONS == (
        "reset",
        "token-valid",
        "token-expired",
        "rename-organisation",
        "restore-organisation",
        "revoke-caller",
        "restore-caller",
        "stop-api",
        "start-api",
    )


def test_fixture_is_model_compatible_and_mutations_preserve_owner():
    m = module()
    plan = m.fixture_plan()
    m.check_fixture(plan)
    assert sum(r["in_directory"] for r in plan["rows"]) == 26
    assert plan["other_rows"][0]["person_id"] == plan["provider"]["primary_user_mapping"]
    assert plan["organisations"][0]["realm"] == plan["organisations"][0]["slug"] == "directory-main"


@pytest.mark.parametrize(
    "kind,reason",
    [
        ("slug", "organisation-slug-shape"),
        ("realm", "organisation-realm-mismatch"),
        ("alias", "membership-id-alias"),
        ("population", "fixture-current-count"),
        ("owner", "primary-mutation-needs-other-owner"),
        ("foreign", "same-person-foreign-control"),
    ],
)
def test_fixture_semantic_refusals(kind, reason):
    m = module()
    plan = m.fixture_plan()
    if kind == "slug":
        plan["organisations"][1]["slug"] = "image-directory-other"
    if kind == "realm":
        plan["organisations"][0]["realm"] = "other-realm"
    if kind == "alias":
        plan["other_rows"][0]["membership_id"] = plan["rows"][0]["membership_id"]
    if kind == "population":
        plan["rows"].pop()
    if kind == "owner":
        next(r for r in plan["rows"] if r["label"] == "member_09")["role"] = "org_member"
    if kind == "foreign":
        plan["other_rows"][0]["person_id"] = plan["provider"]["alternate_user_mapping"]
    with pytest.raises(m.Refusal, match=reason):
        m.check_fixture(plan)


def test_frames_accept_fragmented_bounded_request():
    m = module()
    frames = m.Frames()
    assert frames.feed(b'{"id":1,') == []
    assert frames.feed(b'"op":"reset"}\n') == [{"id": 1, "op": "reset"}]
    frames.eof()
    assert m.control_request({"id": 1, "op": "reset"}, 1) == "reset"


@pytest.mark.parametrize(
    "chunks", [[b"x" * 262145 + b"\n"], [b"x" * 131072, b"x" * 131073 + b"\n"]]
)
def test_oversized_frame_never_delivers(chunks):
    m = module()
    frames = m.Frames()
    with pytest.raises(m.Refusal, match="control-frame-too-large"):
        for chunk in chunks:
            frames.feed(chunk)
    with pytest.raises(m.Refusal, match="control-channel-failed"):
        frames.feed(b"{}\n")


def test_partial_eof_is_terminal():
    m = module()
    frames = m.Frames()
    frames.feed(b"{")
    with pytest.raises(m.Refusal, match="control-partial-eof"):
        frames.eof()
    with pytest.raises(m.Refusal, match="control-channel-failed"):
        frames.feed(b"{}\n")


@pytest.mark.parametrize(
    "message",
    [
        {"id": 2, "op": "reset"},
        {"id": True, "op": "reset"},
        {"id": 1, "op": "shell"},
        {"id": 1, "op": "reset", "sql": "SELECT 1"},
        {"id": 0, "op": "reset"},
    ],
)
def test_control_request_refuses_parameters_unknown_and_order(message):
    m = module()
    with pytest.raises(m.Refusal, match="control-request-refused"):
        m.control_request(message, 1)


def resource():
    return {
        "Id": "a" * 64,
        "Image": "sha256:" + "b" * 64,
        "Config": {"Labels": {"kodera.customer-http": "owned"}},
    }


@pytest.mark.parametrize("kind", ["id", "image", "label"])
def test_resource_mutations_refuse(kind):
    m = module()
    facts = resource()
    m.require_resource(facts, "a" * 64, "owned", "sha256:" + "b" * 64)
    bad = copy.deepcopy(facts)
    if kind == "id":
        bad["Id"] = "c" * 64
    if kind == "image":
        bad["Image"] = "sha256:" + "d" * 64
    if kind == "label":
        bad["Config"]["Labels"]["kodera.customer-http"] = "another"
    with pytest.raises(m.Refusal, match="resource-identity-refused"):
        m.require_resource(bad, "a" * 64, "owned", "sha256:" + "b" * 64)


def test_expiry_is_actual_and_includes_real_leeway():
    m = module()
    m.require_expired(
        {
            "flow": "authorization-code-s256",
            "issuer": "http://127.0.0.1:1/realms/directory-main",
            "exp": 100,
            "leeway_seconds": 30,
        },
        131,
    )
    with pytest.raises(m.Refusal, match="token-not-actually-expired"):
        m.require_expired(
            {
                "flow": "authorization-code-s256",
                "issuer": "http://127.0.0.1:1/realms/directory-main",
                "exp": 100,
                "leeway_seconds": 30,
            },
            130,
        )


def test_restore_attempts_every_action_after_failure():
    m = module()
    calls = []

    def action(name):
        calls.append(name)
        if name == "start-api":
            raise RuntimeError("synthetic")

    with pytest.raises(m.Refusal, match="fixture-restoration-failed"):
        m.restore_all(action)
    assert calls == ["start-api", "restore-caller", "restore-organisation", "restore-contact"]


def test_completed_phase_inventory_cannot_drop_a_refusal():
    m = module()
    m.require_phases(m.REQUIRED_PHASES)
    with pytest.raises(m.Refusal, match="qualification-phases-incomplete"):
        m.require_phases(m.REQUIRED_PHASES - {"revoked"})


def test_generated_fixture_equals_reviewed_frozen_seed():
    import hashlib
    import json

    actual = json.dumps(module().fixture_plan(), sort_keys=True, separators=(",", ":")).encode()
    assert (
        hashlib.sha256(actual).hexdigest()
        == "b794e8e8da5bdb367ed30d25af5e14a6bbf394379edf2b931ff08e505236ca85"
    )


def admission():
    return {
        "version": 1,
        "lane": "02-core-image",
        "build_and_runtime": True,
        "core_head": "a" * 40,
        "core_tree": "b" * 40,
        "evidence_directory": "/absolute/owned/evidence",
        "bridge": None,
    }


@pytest.mark.parametrize(
    "kind,reason",
    [
        ("missing", "runtime-admission-refused"),
        ("denied", "runtime-admission-refused"),
        ("version", "runtime-admission-refused"),
        ("dirty", "runtime-source-drift"),
        ("head", "runtime-source-drift"),
        ("relative", "evidence-directory-refused"),
    ],
)
def test_runtime_admission_is_exact_before_resources(kind, reason):
    m = module()
    value = admission()
    identity = {"head": "a" * 40, "tree": "b" * 40, "clean": True}
    m.require_admission(value, identity)
    if kind == "missing":
        value.pop("bridge")
    if kind == "denied":
        value["build_and_runtime"] = False
    if kind == "version":
        value["version"] = True
    if kind == "dirty":
        identity["clean"] = False
    if kind == "head":
        identity["head"] = "c" * 40
    if kind == "relative":
        value["evidence_directory"] = "relative"
    with pytest.raises(m.Refusal, match=reason):
        m.require_admission(value, identity)


@pytest.mark.parametrize(
    "field", ["manifest_sha256", "console_head", "harness_sha256", "runtime_lent", "version"]
)
def test_bridge_admission_binds_actual_manifest_and_reviewed_harness(field):
    m = module()
    value = {
        "version": 1,
        "lane": "05-client-bridge",
        "runtime_lent": True,
        "manifest_sha256": "a" * 64,
        "console_head": "b" * 40,
        "harness_sha256": "c" * 64,
    }
    m.require_bridge_admission(value, "a" * 64, "b" * 40, "c" * 64)
    value[field] = True if field == "version" else False if field == "runtime_lent" else "wrong"
    with pytest.raises(m.Refusal, match="bridge-admission-refused"):
        m.require_bridge_admission(value, "a" * 64, "b" * 40, "c" * 64)


@pytest.mark.parametrize(
    "raw,reason",
    [(b'{"id":1,"id":1,"op":"reset"}\n', "duplicate-json-key"), (b"not-json\n", "invalid-json")],
)
def test_control_invalid_json_is_terminal(raw, reason):
    m = module()
    frames = m.Frames()
    with pytest.raises(m.Refusal, match=reason):
        frames.feed(raw)
    with pytest.raises(m.Refusal, match="control-channel-failed"):
        frames.feed(b"{}\n")


def test_control_frame_limit_includes_delimiter_and_checks_before_delivery():
    m = module()
    prefix = b'{"padding":"'
    suffix = b'"}\n'
    accepted = prefix + b"x" * (m.MAX_FRAME - len(prefix) - len(suffix)) + suffix
    assert len(accepted) == m.MAX_FRAME
    assert m.Frames().feed(accepted)[0]["padding"]
    with pytest.raises(m.Refusal, match="control-frame-too-large"):
        m.Frames().feed(accepted[:-3] + b"x" + suffix)


@pytest.mark.parametrize("suffix", [b'{"id":2,"op":"reset"}\n', b"{"])
def test_parent_rejects_pipelined_and_partial_next_operation(suffix):
    m = module()
    with pytest.raises(m.Refusal, match="control-pipelining-refused"):
        m.control_batch(m.Frames(), b'{"id":1,"op":"reset"}\n' + suffix, 1)


def test_parent_rejects_repeated_completed_identifier():
    m = module()
    frames = m.Frames()
    raw = b'{"id":1,"op":"reset"}\n'
    assert m.control_batch(frames, raw, 1)[0][0] == "reset"
    with pytest.raises(m.Refusal, match="control-request-refused"):
        m.control_batch(frames, raw, 2)


def test_actual_operation_timer_interrupts_and_restores_handler():
    import signal
    import time

    m = module()
    previous = signal.getsignal(signal.SIGALRM)
    with m.operation_deadline(0.1):
        pass
    with pytest.raises(m.Refusal, match="bridge-operation-deadline"):
        with m.operation_deadline(0.01):
            time.sleep(0.1)
    assert signal.getsignal(signal.SIGALRM) == previous
    assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)


def test_private_pipe_reply_is_bounded_and_actual():
    import json
    import os

    m = module()
    read, write = os.pipe()
    try:
        m.write_pipe(write, {"id": 1, "ok": True, "result": {}})
        assert json.loads(os.read(read, 4096)) == {"id": 1, "ok": True, "result": {}}
        with pytest.raises(m.Refusal, match="control-reply-too-large"):
            m.write_pipe(write, {"padding": "x" * m.MAX_FRAME})
    finally:
        os.close(read)
        os.close(write)


def test_record_reader_refuses_oversize_and_symlink(tmp_path):
    m = module()
    target = tmp_path / "record.json"
    target.write_text("{}")
    assert m.read_record(target)[1] == {}
    target.write_text("x" * 20)
    with pytest.raises(m.Refusal, match="record-too-large"):
        m.read_record(target, 10)
    link = tmp_path / "link"
    link.symlink_to(target)
    with pytest.raises(OSError):
        m.read_record(link)


def test_hosted_child_uses_actual_anonymous_pipes_and_discards_diagnostics(tmp_path):
    import sys

    m = module()
    script = tmp_path / "synthetic_child.py"
    script.write_text("""import json,os,sys
os.write(4,b'{"id":1,"op":"reset"}\\n')
reply=b''
while not reply.endswith(b'\\n'): reply+=os.read(3,4096)
assert json.loads(reply)=={"id":1,"ok":True,"result":{"synthetic":"memory-only"}}
sys.stderr.write('SYNTHETIC_UNTRUSTED_DIAGNOSTIC')
print(json.dumps({"status":"local-network-pass","network_executed":True,"cases":["B01","B02","B03","B04","B05","B06","B07"],"fetch_unchanged":True}))
""")
    calls = []

    def action(op):
        calls.append(op)
        return {"synthetic": "memory-only"}

    result = m.hosted_bridge(
        {"node": sys.executable, "runner": str(script), "admission": str(tmp_path / "unused")},
        tmp_path / "unused",
        action,
    )
    assert calls == ["reset"]
    assert result == {
        "result": "pass",
        "cases": ["B01", "B02", "B03", "B04", "B05", "B06", "B07"],
        "control_requests": 1,
        "protocol": "kodera-bridge-v1",
    }
    assert "DIAGNOSTIC" not in str(result)


def test_hosted_child_partial_request_eof_refuses(tmp_path):
    import sys

    m = module()
    script = tmp_path / "synthetic_child.py"
    script.write_text('import os;os.write(4,b"{")')
    with pytest.raises(m.Refusal, match="control-partial-eof"):
        m.hosted_bridge(
            {"node": sys.executable, "runner": str(script), "admission": str(tmp_path / "unused")},
            tmp_path / "unused",
            lambda op: pytest.fail("partial input dispatched"),
        )


def test_bridge_drift_is_checked_before_evidence_or_resource_creation(tmp_path, monkeypatch):
    m = module()
    value = admission()
    value["evidence_directory"] = str(tmp_path / "not-created")
    value["bridge"] = {
        "node": "/absolute/node",
        "runner": "/absolute/runner.mjs",
        "runner_sha256": "c" * 64,
        "harness": "/absolute/harness-bindings.json",
        "harness_sha256": "d" * 64,
        "console_head": "e" * 40,
        "admission": "/absolute/lead.json",
        "barrier_seconds": 600,
    }
    monkeypatch.setattr(m, "read_record", lambda path: (b"", value))
    monkeypatch.setattr(
        m, "git_identity", lambda root: {"head": "a" * 40, "tree": "b" * 40, "clean": True}
    )

    def drift(self):
        raise m.Refusal("bridge-runner-drift")

    monkeypatch.setattr(m.DirectoryScenario, "check_bridge_files", drift)
    with pytest.raises(m.Refusal, match="bridge-runner-drift"):
        m.DirectoryScenario(tmp_path / "admission.json")
    assert not (tmp_path / "not-created").exists()


def test_resource_identity_is_durable_before_use_without_environment(tmp_path, monkeypatch, capsys):
    import json

    m = module()
    scenario = m.DirectoryScenario.__new__(m.DirectoryScenario)
    scenario.resources = {}
    scenario.evidence = tmp_path
    facts = resource()
    facts["Config"]["Env"] = ["SYNTHETIC_PRIVATE_VALUE=never-record"]
    monkeypatch.setattr(m.shared, "require_owned", lambda *args: facts)
    scenario.capture("container", "owned-api", "owned", "a" * 64)
    record = json.loads((tmp_path / "resources.jsonl").read_text())
    assert record["id"] == "a" * 64 and record["image_id"] == "sha256:" + "b" * 64
    assert "PRIVATE" not in str(record) + capsys.readouterr().out
    before = (tmp_path / "resources.jsonl").read_bytes()
    with pytest.raises(m.Refusal, match="resource-identity-refused"):
        scenario.capture("container", "owned-api", "owned", "different-id")
    assert (tmp_path / "resources.jsonl").read_bytes() == before


def test_terminal_report_releases_reply_pipe_before_child_exit(tmp_path):
    import sys

    m = module()
    script = tmp_path / "completion_child.py"
    script.write_text("""import json,os,select
os.write(4,b'{"id":1,"op":"reset"}\\n')
reply=b''
while not reply.endswith(b'\\n'): reply+=os.read(3,4096)
print(json.dumps({"status":"local-network-pass","network_executed":True,"cases":["B01","B02","B03","B04","B05","B06","B07"],"fetch_unchanged":True}),flush=True)
assert select.select([3],[],[],1)[0], 'parent retained reply writer while waiting for child exit'
assert os.read(3,1)==b''
""")
    result = m.hosted_bridge(
        {"node": sys.executable, "runner": str(script), "admission": str(tmp_path / "unused")},
        tmp_path / "unused",
        lambda op: {},
    )
    assert result["control_requests"] == 1
    assert result["result"] == "pass"


@pytest.mark.parametrize(
    "ending", ["raise SystemExit(3)", 'os.write(4,b\'{"id":2,"op":"reset"}\\n\')']
)
def test_terminal_report_does_not_hide_failed_exit_or_late_command(tmp_path, ending):
    import sys

    m = module()
    script = tmp_path / "completion_child.py"
    script.write_text(
        """import json,os,select
os.write(4,b'{"id":1,"op":"reset"}\\n')
reply=b''
while not reply.endswith(b'\\n'): reply+=os.read(3,4096)
print(json.dumps({"status":"local-network-pass","network_executed":True,"cases":["B01","B02","B03","B04","B05","B06","B07"],"fetch_unchanged":True}),flush=True)
assert select.select([3],[],[],1)[0]
assert os.read(3,1)==b''
"""
        + ending
    )
    calls = []
    with pytest.raises(m.Refusal, match="bridge-child-failed|bridge-command-after-result"):
        m.hosted_bridge(
            {"node": sys.executable, "runner": str(script), "admission": str(tmp_path / "unused")},
            tmp_path / "unused",
            lambda op: calls.append(op) or {},
        )
    assert calls == ["reset"]


@pytest.mark.parametrize(
    "change,reason",
    [
        ("report['fetch_unchanged']=False", "bridge-result-refused"),
        ("suffix='unexpected\\n'", "bridge-result-refused"),
        ("ending='import time;time.sleep(10)'", "bridge-completion-deadline"),
        ("ending='os.write(1,b\"extra\")'", "bridge-output-after-result"),
    ],
)
def test_terminal_completion_guards_refuse_semantic_mutations(tmp_path, change, reason, capsys):
    import sys

    m = module()
    script = tmp_path / "completion_mutation.py"
    script.write_text(
        """import json,os,select
report={"status":"local-network-pass","network_executed":True,"cases":["B01","B02","B03","B04","B05","B06","B07"],"fetch_unchanged":True}
suffix=''
ending=''
"""
        + change
        + """
os.write(1,(json.dumps(report)+'\\n'+suffix).encode())
os.write(2,b'SYNTHETIC_UNTRUSTED_DIAGNOSTIC')
assert select.select([3],[],[],1)[0]
assert os.read(3,1)==b''
exec(ending)
"""
    )
    with pytest.raises(m.Refusal, match=reason):
        m.hosted_bridge(
            {"node": sys.executable, "runner": str(script), "admission": str(tmp_path / "unused")},
            tmp_path / "unused",
            lambda op: pytest.fail("no operation expected"),
        )
    import json

    progress = json.loads(capsys.readouterr().out)["bridge_progress"]
    assert set(progress) == {
        "completed_commands",
        "last_operation",
        "terminal_report_accepted",
        "child_exit",
    }
    assert progress["completed_commands"] == 0 and progress["last_operation"] is None
    assert "DIAGNOSTIC" not in str(progress)
