"""The worker acceptance harness can fail: each check refuses its weakening, by its message.

No database and no Docker. A weakened tree is a copy of the worker image's files (or of the
compose file, or of the ignore rules) with one change.
"""

import ast
import copy
import shutil
from pathlib import Path

import pytest
import yaml
from worker_acceptance import (
    HERE,
    INVENTORY,
    ROOT,
    WORKER_SETTINGS,
    InventoryError,
    WorkerGapError,
    acceptance,
    api_image_worker_refusals,
    gap_is_missing,
    last_line,
    load_inventory,
    require,
    worker_image_files,
    worker_image_refusals,
    worker_network_refusals,
    worker_process,
    worker_supervision_refusals,
)

from dev.image_context import image_files, image_tree

COMPOSE = yaml.safe_load((ROOT / "compose.yaml").read_text(encoding="utf-8"))


# ----------------------------------------------------------------- inventory and binding ----


def bound_rows(source: str) -> dict[str, str]:
    """Each test function of the acceptance module and the row its decorator names."""
    rows = {}
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name.startswith("test_"):
            names = [
                str(d.args[0].value)
                for d in node.decorator_list
                if isinstance(d, ast.Call)
                and getattr(d.func, "id", None) == "acceptance"
                and d.args
                and isinstance(d.args[0], ast.Constant)
            ]
            rows[node.name] = names[0] if len(names) == 1 else ""
    return rows


def binding_problems(source: str, inventory: dict) -> list[str]:
    rows = bound_rows(source)
    problems = [f"{name} is bound to no single WK row" for name, row in rows.items() if not row]
    named = {row: name for name, row in rows.items() if row}
    for identifier, row in sorted(inventory.items()):
        if named.get(identifier) != row["function"]:
            problems.append(f"{identifier} has no test named {row['function']}")
    problems += [f"{row} is not in the inventory" for row in sorted(set(named) - set(inventory))]
    return problems


def test_every_row_has_exactly_its_test_and_every_test_its_row():
    source = (HERE / "test_worker_acceptance.py").read_text(encoding="utf-8")
    assert binding_problems(source, INVENTORY) == []
    # G1.5-B built both gaps: every row passes, and the xfail binding is proven on a planted row.
    assert {row["state"] for row in INVENTORY.values()} == {"pass"}


def test_the_binding_check_refuses_a_missing_test_and_an_unbound_one():
    source = (HERE / "test_worker_acceptance.py").read_text(encoding="utf-8")
    dropped = source.replace('@acceptance("WK-07")\n', "", 1)
    assert binding_problems(dropped, INVENTORY) == [
        "test_wk_07_compose_puts_the_worker_on_an_internal_network_with_the_database_alone "
        "is bound to no single WK row",
        "WK-07 has no test named "
        "test_wk_07_compose_puts_the_worker_on_an_internal_network_with_the_database_alone",
    ]
    extra = source + '\n\n@acceptance("WK-99")\ndef test_wk_99_planted():\n    pass\n'
    assert binding_problems(extra, INVENTORY) == ["WK-99 is not in the inventory"]


@pytest.mark.parametrize(
    ("row", "message"),
    [
        ('id = "WK-1"\nfunction = "test_wk_1_x"\nstate = "pass"', "malformed identifier 'WK-1'"),
        ('id = "WK-01"\nfunction = "test_wk_01_x"\nstate = "skip"', "WK-01 has state 'skip'"),
        ('id = "WK-01"\nfunction = "test_wk_01_x"\nstate = "xfail"', "WK-01 is xfail with no"),
        (
            'id = "WK-01"\nfunction = "test_wk_01_x"\nstate = "pass"\ngap = "worker:runner"',
            "WK-01 passes and still records gap",
        ),
        ('id = "WK-01"\nfunction = "test_x"\nstate = "pass"', "WK-01 names no function starting"),
    ],
)
def test_a_malformed_row_refuses_the_whole_inventory(row, message):
    with pytest.raises(InventoryError, match=message):
        load_inventory(f"format = 1\n\n[[test]]\n{row}\n")


def test_an_expected_gap_row_refuses_another_gap_and_a_gap_that_now_exists(monkeypatch):
    import worker_acceptance

    identifier = "WK-11"
    name = INVENTORY[identifier]["function"]
    planted = {**INVENTORY[identifier], "state": "xfail", "gap": "worker:runner"}
    monkeypatch.setitem(worker_acceptance.INVENTORY, identifier, planted)

    def wrong_gap():
        raise WorkerGapError("worker:synthetic-provider-proof", "planted")

    wrong_gap.__name__ = name
    with pytest.raises(AssertionError, match=f"{identifier} stopped at worker:synthetic"):
        acceptance(identifier)(wrong_gap)()

    def forged():
        raise WorkerGapError("worker:runner", "forged")

    forged.__name__ = name
    with pytest.raises(AssertionError, match="raised worker:runner, which is no longer missing"):
        acceptance(identifier)(forged)()

    monkeypatch.setattr("worker_acceptance.gap_is_missing", lambda gap: True)
    with pytest.raises(WorkerGapError):
        acceptance(identifier)(forged)()


@pytest.mark.parametrize("shape", ["runner.py", "runner/__init__.py"])
def test_the_runner_gap_probe_sees_the_runner_and_its_absence(tmp_path, monkeypatch, shape):
    import sys

    import worker

    # Since G1.5-B the runner exists: the probe says so and require() refuses to raise the gap.
    assert not gap_is_missing("worker:runner")
    with pytest.raises(AssertionError, match="worker:runner now exists: bind the WK rows"):
        require("worker:runner")
    # A tree without it: the probe measures the absence, as it did before G1.5-B.
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.delitem(sys.modules, "worker.runner", raising=False)
    monkeypatch.setattr(worker, "__path__", [str(empty)])
    assert gap_is_missing("worker:runner")
    with pytest.raises(WorkerGapError):
        require("worker:runner")
    # A module or a package, found where the import system would find it.
    (tmp_path / shape).parent.mkdir(parents=True, exist_ok=True)
    (tmp_path / shape).write_text("# A synthetic job runner fixture.\n")
    monkeypatch.setattr(worker, "__path__", [str(empty), str(tmp_path)])
    assert not gap_is_missing("worker:runner")


def test_the_proof_gap_probe_sees_a_provider_that_cannot_authenticate(monkeypatch):
    from worker.providers import synthetic

    assert not gap_is_missing("worker:synthetic-provider-proof")
    with pytest.raises(AssertionError, match="worker:synthetic-provider-proof now exists"):
        require("worker:synthetic-provider-proof")
    monkeypatch.setattr(synthetic.SyntheticProvider, "verify", lambda self, proof: False)
    assert gap_is_missing("worker:synthetic-provider-proof")
    with pytest.raises(WorkerGapError):
        require("worker:synthetic-provider-proof")


# ------------------------------------------------------------------------------ compose ----


def weakened(change):
    compose = copy.deepcopy(COMPOSE)
    change(compose)
    return worker_network_refusals(compose)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (
            lambda c: c["services"]["worker"].update(network_mode="host"),
            "the worker sets a network mode instead of joining the worker-db network",
        ),
        (
            lambda c: c["services"]["worker"].update(networks=["worker-db", "default"]),
            "the worker joins a network other than worker-db alone",
        ),
        (
            lambda c: c["services"]["worker"].update(ports=["127.0.0.1:8001:8001"]),
            "the worker publishes or exposes a port",
        ),
        (
            lambda c: c["services"]["worker"].update(expose=["8001"]),
            "the worker publishes or exposes a port",
        ),
        (
            lambda c: c["networks"]["worker-db"].pop("internal"),
            "the worker-db network is not internal",
        ),
        (
            lambda c: c["services"]["mailpit"].update(network_mode="service:db"),
            "mailpit shares a network namespace through network_mode service:db",
        ),
        (
            lambda c: c["services"]["keycloak"].update(network_mode="container:core-db"),
            "keycloak shares a network namespace through network_mode container:core-db",
        ),
        (
            lambda c: c["services"]["api"].update(network_mode="host"),
            "api shares a network namespace through network_mode host",
        ),
        (
            lambda c: c["services"]["db"].update(networks=["default"]),
            "the worker-db network holds ['worker'], not the database and the worker",
        ),
        (
            lambda c: c["networks"]["worker-db"].update(internal=False),
            "the worker-db network is not internal",
        ),
        (
            lambda c: c["services"]["mailpit"].update(networks=["default", "worker-db"]),
            "the worker-db network holds ['db', 'mailpit', 'worker'], not the database and the "
            "worker",
        ),
    ],
)
def test_the_network_check_refuses_each_widening(change, message):
    assert weakened(lambda c: None) == []
    assert weakened(change) == [message]


def unsupervised(change):
    compose = copy.deepcopy(COMPOSE)
    change(compose)
    return worker_supervision_refusals(compose)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (
            lambda c: c["services"]["worker"].pop("restart"),
            "the worker has no restart policy to bring a crash-only runner back",
        ),
        (
            lambda c: c["services"]["worker"].update(restart="no"),
            "the worker has no restart policy to bring a crash-only runner back",
        ),
        (
            lambda c: c["services"]["worker"].pop("init"),
            "the worker runs without an init to reap its exited processes",
        ),
        (
            lambda c: c["services"]["worker"].update(init=False),
            "the worker runs without an init to reap its exited processes",
        ),
    ],
)
def test_the_supervision_check_refuses_a_worker_left_down_or_unreaped(change, message):
    assert unsupervised(lambda c: None) == []
    assert unsupervised(change) == [message]


# ------------------------------------------------------------------------------- images ----


def context(tmp_path: Path, dockerfile: str, extra_rule: str | None = None) -> Path:
    """A copy of the tree's sources under `tmp_path`, with one ignore rule appended."""
    for top in ("config", "core", "apps", "services", "worker", "tenant_agent", "room_access"):
        shutil.copytree(ROOT / top, tmp_path / top, ignore=shutil.ignore_patterns("__pycache__"))
    for name in ("manage.py", "pyproject.toml", "uv.lock", "Dockerfile", ".dockerignore"):
        shutil.copy2(ROOT / name, tmp_path / name)
    shutil.copy2(ROOT / "Dockerfile.worker", tmp_path / "Dockerfile.worker")
    ignore = ROOT / f"{dockerfile}.dockerignore"
    ignore = ignore if ignore.is_file() else ROOT / ".dockerignore"
    target = tmp_path / ignore.name
    text = ignore.read_text()
    target.write_text(text + (f"\n{extra_rule}\n" if extra_rule else ""))
    return tmp_path


def test_the_api_image_check_refuses_a_restored_worker(tmp_path):
    tree = context(tmp_path, "Dockerfile")
    assert api_image_worker_refusals(image_files(tree)) == []
    dockerfile = tree / "Dockerfile"
    dockerfile.write_text(
        dockerfile.read_text().replace("USER 10001", "COPY worker/ ./worker/\nUSER 10001")
    )
    ignore = tree / ".dockerignore"
    rules = ignore.read_text()
    assert rules.count("config/settings/deploy_worker.py\n") == 1
    ignore.write_text(rules.replace("config/settings/deploy_worker.py\n", "") + "\n!worker/**\n")
    refusals = api_image_worker_refusals(image_files(tree))
    assert "the API image carries worker/boot.py, which belongs to the worker" in refusals
    assert (
        "the API image carries config/settings/deploy_worker.py, which belongs to the worker"
        in refusals
    )


@pytest.mark.parametrize(
    ("rule", "message"),
    [
        ("!apps/identity/api/*.py", "the worker image carries apps/identity/api/views.py, a URL"),
        ("!config/*.py", "the worker image carries config/customer_urls.py, a URL"),
        ("!core/health.py", "the worker image carries core/health.py, a URL"),
        (
            "!config/settings/test.py",
            "the worker image carries config/settings/test.py, a settings",
        ),
        (
            "config/settings/deploy_worker.py",
            "the worker image lacks config/settings/deploy_worker",
        ),
    ],
)
def test_the_worker_image_check_refuses_each_widening(tmp_path, rule, message):
    assert worker_image_refusals(worker_image_files()) == []
    files = image_files(context(tmp_path, "Dockerfile.worker", rule), "Dockerfile.worker")
    assert any(refusal.startswith(message) for refusal in worker_image_refusals(files)), rule


# ------------------------------------------------------------------------- the process ----


def test_the_worker_check_refuses_an_open_boundary():
    # The boundary skipped: `check` must say which parts of it are open, not report them held.
    program = (
        "import worker.boot as boot\n"
        "boot.enter = lambda: setattr(boot, '_entered', True)\n"
        "import worker.__main__ as entry\n"
        "entry.main(['check'])\n"
    )
    opened = worker_process(program=program)
    assert opened.returncode != 0
    assert last_line(opened) == "the worker boundary is open: bind, listen, raw_listen"


def test_the_raw_listen_case_catches_a_boundary_without_its_raw_socket_guard():
    # The raw `_socket` guard removed: WK-02's raw cases must then see a listening socket, and
    # `check` must name the open part.
    program = (
        "import worker.boot as boot\n"
        "boot._guard_raw_socket = lambda: None\n"
        "boot.enter()\n"
        "import _socket\n"
        "s = _socket.socket(); s.listen(1); print('listening', s.getsockname()[1])\n"
    )
    listening = worker_process(program=program)
    assert listening.returncode == 0 and listening.stdout.startswith("listening"), listening.stderr
    check = (
        "import worker.boot as boot\n"
        "boot._guard_raw_socket = lambda: None\n"
        "import worker.__main__ as entry\n"
        "entry.main(['check'])\n"
    )
    opened = worker_process(program=check)
    assert opened.returncode != 0
    assert last_line(opened) == "the worker boundary is open: raw_listen"


def test_the_outside_refusal_is_what_stops_a_settings_load_outside_the_worker(tmp_path):
    image_tree(ROOT, tmp_path, "Dockerfile.worker")
    profile = tmp_path / "config" / "settings" / "deploy_worker.py"
    text = profile.read_text()
    guard = "if boot is None or not boot.entered():"
    assert text.count(guard) == 1, "the mutation no longer finds the guard it removes"
    profile.write_text(text.replace(guard, "if False:"))
    program = "import django; django.setup(); print('loaded')"
    loaded = worker_process(
        program=program, cwd=tmp_path, environment={"DJANGO_SETTINGS_MODULE": WORKER_SETTINGS}
    )
    assert loaded.returncode == 0 and loaded.stdout.strip() == "loaded", loaded.stderr[-2000:]


# ------------------------------------------------------------- the built-image qualification ----


def test_the_built_image_comparison_names_each_difference():
    from dev.worker_boundary import listing_refusals

    context = worker_image_files()
    assert listing_refusals(context, context) == []
    assert listing_refusals([*context[1:], "config/urls.py"], context) == [
        "the built worker image carries config/urls.py, which its build context does not admit",
        f"the built worker image lacks {context[0]}, which its build context admits",
    ]


# The worker image's own stages: kcadm for realm_create, which the API image never carries.
WORKER_ONLY_STAGES = ("keycloak", "kcadm")


def dependency_stages(dockerfile: str, *, without: tuple[str, ...] = ()) -> list[str]:
    """Every line before the runtime stage but the stages `without` names: the uv and Python pins
    and the locked install."""
    head = dockerfile.split("\nFROM ")[:-1]
    kept = [stage for stage in head if stage.splitlines()[0].rsplit(" AS ", 1)[-1] not in without]
    lines = "\nFROM ".join(kept).splitlines()
    return [line for line in lines if line and not line.startswith("#")]


def stage_names(dockerfile: str) -> list[str]:
    return [
        stage.splitlines()[0].rsplit(" AS ", 1)[-1] for stage in dockerfile.split("\nFROM ")[1:]
    ]


def test_the_worker_image_is_built_on_the_api_images_pins():
    # One Dependabot bump moves both images: a worker on a stale base would pass every check here.
    api = (ROOT / "Dockerfile").read_text()
    worker = (ROOT / "Dockerfile.worker").read_text()
    # Only the named kcadm stages may differ, so no other stage hides behind them.
    assert sorted(set(stage_names(worker)) - set(stage_names(api))) == sorted(WORKER_ONLY_STAGES)
    assert dependency_stages(worker, without=WORKER_ONLY_STAGES) == dependency_stages(api)
    assert worker.split("\nFROM ")[-1].splitlines()[0] == api.split("\nFROM ")[-1].splitlines()[0]
    bumped = api.replace("uv:0.12.10@", "uv:0.12.11@")
    assert dependency_stages(worker) != dependency_stages(bumped)


def test_the_worker_image_runs_unprivileged_and_only_the_worker():
    from dev.worker_boundary import runtime_stage_refusals

    worker = (ROOT / "Dockerfile.worker").read_text()
    assert runtime_stage_refusals(worker) == []
    assert runtime_stage_refusals(worker.replace("USER 10001:10001", "USER root")) == [
        "the worker image does not run as 10001:10001"
    ]
    assert runtime_stage_refusals(worker.replace("USER 10001:10001\n", "")) == [
        "the worker image does not run as 10001:10001"
    ]
    shell = worker.replace('CMD ["python", "-m", "worker", "run"]', 'CMD ["sh"]')
    assert runtime_stage_refusals(shell) == [
        "the worker image's command is not python -m worker run"
    ]
    entry = worker + 'ENTRYPOINT ["python", "-m", "http.server"]\n'
    assert runtime_stage_refusals(entry) == ["the worker image declares an entrypoint"]


def test_the_built_image_configuration_check_names_each_difference():
    from dev.worker_boundary import configured_refusals

    held = {"User": "10001:10001", "Cmd": ["python", "-m", "worker", "run"], "Entrypoint": None}
    assert configured_refusals(held) == []
    assert configured_refusals({**held, "User": ""}) == [
        "the built worker image does not run as 10001:10001"
    ]
    assert configured_refusals({**held, "Cmd": ["sh"], "Entrypoint": ["sh", "-c"]}) == [
        "the built worker image's command is not python -m worker run",
        "the built worker image declares an entrypoint",
    ]


PLANTED_UNDER_WORKER = (
    "worker/tests/fixture_key.py",
    "worker/providers/test_synthetic_key.py",
    "worker/providers/testdata/hmac.key",
    "worker/__pycache__/boot.cpython-312.pyc",
)


def test_the_worker_image_check_refuses_test_and_bytecode_files():
    files = worker_image_files()
    assert worker_image_refusals([*files, *PLANTED_UNDER_WORKER]) == [
        f"the worker image carries {path}, a test, fixture or bytecode file"
        for path in sorted(PLANTED_UNDER_WORKER)
    ]


def test_the_worker_image_check_sees_the_synthetic_provider_restored(tmp_path):
    # The ignore rule that keeps the test-only provider out of the image, dropped.
    tree = context(tmp_path, "Dockerfile.worker")
    ignore = tree / "Dockerfile.worker.dockerignore"
    rules = ignore.read_text()
    assert rules.count("\nworker/providers/synthetic.py\n") == 1
    ignore.write_text(rules.replace("\nworker/providers/synthetic.py\n", "\n"))
    files = image_files(tree, "Dockerfile.worker")
    assert worker_image_refusals(files) == [
        "the worker image carries worker/providers/synthetic.py, a test-only provider"
    ]


def test_the_worker_context_excludes_test_and_bytecode_files(tmp_path):
    tree = context(tmp_path, "Dockerfile.worker")
    for planted in PLANTED_UNDER_WORKER:
        (tree / planted).parent.mkdir(parents=True, exist_ok=True)
        (tree / planted).write_text("# planted\n")
    files = image_files(tree, "Dockerfile.worker")
    assert "worker/boot.py" in files
    assert sorted(set(PLANTED_UNDER_WORKER) & set(files)) == []


# ------------------------------------------------- the image's outside probes: fail or record ----


def test_a_public_address_reached_fails_and_a_gateway_reached_is_recorded():
    from dev.worker_boundary import GATEWAY_NOTE, outside_probe_verdict

    # Nothing reached: no failure, and the gateway still carries the note, never an isolation claim.
    failures, record = outside_probe_verdict(
        [("1.1.1.1", "443", "public", False), ("172.18.0.1", "22", "gateway", False)]
    )
    assert failures == []
    assert record == {
        "public_reachable": False,
        "gateway_reachable": False,
        "gateway_note": GATEWAY_NOTE,
    }
    # A gateway reached is the known limit of an internal network: recorded, never a failure.
    failures, record = outside_probe_verdict([("172.18.0.1", "22", "gateway", True)])
    assert failures == []
    assert record["gateway_reachable"] is True and record["gateway_note"] == GATEWAY_NOTE
    # A public address reached is what compose's internal network must stop: a failure.
    failures, record = outside_probe_verdict(
        [("1.1.1.1", "443", "public", True), ("172.18.0.1", "22", "gateway", True)]
    )
    assert failures == ["the worker's network reaches the public address 1.1.1.1:443"]
    assert record["public_reachable"] is True
    assert GATEWAY_NOTE == "host firewall required"
    with pytest.raises(ValueError, match="unknown probe kind"):
        outside_probe_verdict([("10.0.0.1", "22", "isolated", False)])


def test_the_image_summary_never_reads_a_probe_as_isolation():
    source = (ROOT / "dev" / "accept_worker_image.py").read_text()
    assert "outside_probe_verdict(" in source
    summary = source[source.rindex("print(") :]
    assert "**record" in summary, "the summary no longer carries the probe record"
    assert '"isolat' not in summary and "unreachable" not in summary
