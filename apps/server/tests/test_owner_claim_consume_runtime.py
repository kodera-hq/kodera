"""Pure controls for the finite synthetic consume role and actual qualifier boundaries."""

import importlib.util
import json
from copy import deepcopy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_LEDGER = {
    "SELECT": {
        "identity_user": ["id", "email", "display_name", "enabled", "deleted_at"],
        "identity_identity": [
            "id",
            "user_id",
            "organisation_id",
            "issuer",
            "subject",
            "realm",
            "enabled",
            "deleted_at",
        ],
        "orgs_organisation": [
            "id",
            "state",
            "slug",
            "realm",
            "name",
            "created_at",
            "updated_at",
            "deleted_at",
            "owner_guard_revision",
            "authority_revision",
        ],
        "orgs_membership": [
            "id",
            "user_id",
            "organisation_id",
            "role",
            "state",
            "accepted_at",
            "deleted_at",
        ],
        "orgs_ownerbinding": ["identity_id", "organisation_id", "issuer"],
        "orgs_ownerclaim": [
            "id",
            "organisation_id",
            "token_hash",
            "intended_identity_id",
            "state",
            "expires_at",
            "consumed_at",
            "membership_id",
        ],
        "orgs_slugreservation": ["organisation_id", "state", "slug"],
        "audit_auditevent": ["occurred_at", "metadata"],
        "idempotency_record": [
            "id",
            "issuer",
            "subject",
            "method",
            "path",
            "key_sha256",
            "body_sha256",
            "status",
            "content_type",
            "body",
            "location",
            "etag",
            "job_id",
            "created_at",
        ],
    },
    "INSERT": {
        "orgs_membership": [
            "id",
            "created_at",
            "updated_at",
            "deleted_at",
            "purge_after",
            "user_id",
            "organisation_id",
            "role",
            "state",
            "accepted_at",
        ],
        "audit_auditevent": [
            "id",
            "actor_type",
            "actor_id",
            "actor_label",
            "organisation_id",
            "action",
            "target_urn",
            "before",
            "after",
            "request_id",
            "job_id",
            "source_ip_trunc",
            "retention_class",
            "metadata",
        ],
        "idempotency_record": [
            "id",
            "issuer",
            "subject",
            "method",
            "path",
            "key_sha256",
            "body_sha256",
            "status",
            "content_type",
            "body",
            "location",
            "etag",
            "job_id",
        ],
    },
    "UPDATE": {
        "identity_user": ["enabled", "display_name", "updated_at"],
        "identity_identity": ["id"],
        "orgs_organisation": ["state", "updated_at", "owner_guard_revision", "authority_revision"],
        "orgs_membership": ["id"],
        "orgs_ownerbinding": ["id"],
        "orgs_ownerclaim": [
            "state",
            "revoked_at",
            "consumed_at",
            "consumed_by_identity_id",
            "membership_id",
        ],
        "orgs_slugreservation": ["state", "protected_at", "updated_at"],
    },
    "DELETE": ["idempotency_record"],
}


def controller():
    spec = importlib.util.spec_from_file_location(
        "consume_qualification", ROOT / "dev/accept_owner_claim_consume_http.py"
    )
    assert spec is not None and spec.loader is not None
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def test_actual_consume_controller_exists_and_baselines_stay_frozen():
    c = controller()
    c.baseline_sources()
    assert callable(c.install_consume_role) and callable(c.assert_consume_role_policy)


def test_consume_installer_uses_independent_literal_ledger():
    c = controller()
    assert {
        table: list(columns) for table, columns in c.ROLE_POLICY_SELECT.items()
    } == EXPECTED_LEDGER["SELECT"]
    assert {
        table: list(columns) for table, columns in c.ROLE_POLICY_UPDATE.items()
    } == EXPECTED_LEDGER["UPDATE"]
    assert {
        table: list(columns) for table, columns in c.ROLE_POLICY_INSERT.items()
    } == EXPECTED_LEDGER["INSERT"]
    assert list(c.ROLE_POLICY_DELETE) == EXPECTED_LEDGER["DELETE"]
    assert c.ROLE_RETURNING == {
        "orgs_membership": (),
        "audit_auditevent": ("occurred_at", "metadata"),
        "idempotency_record": ("created_at",),
    }
    assert c.CONSUME_SELECT_COLUMNS == c.ROLE_POLICY_SELECT
    assert c.CONSUME_UPDATE_COLUMNS == c.ROLE_POLICY_UPDATE
    assert c.CONSUME_INSERT_COLUMNS == c.ROLE_POLICY_INSERT
    assert c.CONSUME_DELETE_TABLES == ("idempotency_record",)
    c.consume_policy(c.expected_policy())


@pytest.mark.parametrize(
    "privilege,table,column",
    [
        ("SELECT", "identity_user", "purge_after"),
        ("UPDATE", "identity_user", "deleted_at"),
        ("INSERT", "audit_auditevent", "occurred_at"),
    ],
)
def test_actual_paired_grant_widening_refuses(monkeypatch, privilege, table, column):
    c = controller()
    matrix = deepcopy(getattr(c, "CONSUME_" + privilege + "_COLUMNS"))
    matrix[table] += (column,)
    monkeypatch.setattr(c, "CONSUME_" + privilege + "_COLUMNS", matrix)
    proof = c.expected_policy()
    proof[privilege.lower()].append([table, column])
    proof[privilege.lower()].sort()
    with pytest.raises(AssertionError, match="consume role policy refused"):
        c.consume_policy(proof)


def test_actual_table_delete_widening_refuses():
    c = controller()
    proof = c.expected_policy()
    proof["delete"].append("orgs_ownerclaim")
    with pytest.raises(AssertionError, match="consume role policy refused"):
        c.consume_policy(proof)


def test_actual_http_client_preserves_body_auth_and_key(monkeypatch):
    c = controller()
    calls = []

    class Response:
        code = 200
        headers = {"Cache-Control": "no-store"}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, limit):
            assert limit == 65537
            return b"{}"

    def open_request(request, *, timeout):
        calls.append(request)
        assert timeout == 5
        return Response()

    monkeypatch.setattr(c, "urlopen", open_request)
    assert c.post(1234, {"token": "synthetic-private-token"}, "signed", "logical-key")[0] == 200
    request = calls[0]
    assert request.method == "POST"
    assert json.loads(request.data) == {"token": "synthetic-private-token"}
    assert request.get_header("Authorization") == "Bearer signed"
    assert request.get_header("Idempotency-key") == "logical-key"


@pytest.mark.parametrize("suffix", ["", "-stripped"])
def test_actual_secret_guard_refuses_delivered_material(suffix):
    c = controller()
    secrets = ("actual-delivered-token" + suffix, "actual-stored-verifier", "actual-sealed-value")
    for private in secrets:
        with pytest.raises(AssertionError, match="consume private material refused"):
            c.public_bytes(private.encode(), secrets)


def test_actual_driver_capture_is_closed_and_requires_real_success():
    c = controller()
    records = []
    capture = c.insert_shape_capture(records)
    columns = ",".join('"' + column + '"' for column in c.ROLE_POLICY_INSERT["orgs_membership"])
    statement = 'INSERT INTO "orgs_membership" (' + columns + ") VALUES (%s)"  # noqa: S608 - fixed synthetic compiler-shape control, never executed
    assert (
        capture(
            lambda *args: "driver-returned", statement, ["private-parameter-sentinel"], False, None
        )
        == "driver-returned"
    )
    assert len(records) == 1 and "private-parameter-sentinel" not in json.dumps(records)
    before = deepcopy(records)

    def refusal(*args):
        raise RuntimeError("private-driver-error")

    with pytest.raises(RuntimeError):
        capture(refusal, statement, [], False, None)
    assert records == before
    with pytest.raises(AssertionError, match="consume INSERT shape refused"):
        capture(
            lambda *args: None,
            statement.replace('"id",', '"private_sentinel",', 1),
            [],
            False,
            None,
        )


def test_actual_insert_inventory_refuses_missing_and_paired_shapes():
    c = controller()
    with pytest.raises(AssertionError, match="consume INSERT inventory refused"):
        c.assert_insert_shapes([])


def test_actual_resource_absence_requires_successful_listing(monkeypatch):
    from types import SimpleNamespace

    c = controller()

    def error(*args, **kwargs):
        if args[:2] == ("container", "inspect"):
            return SimpleNamespace(returncode=1, stdout="", stderr="private-daemon-error")
        raise RuntimeError("daemon-listing-refused")

    monkeypatch.setattr(c, "docker", error)
    with pytest.raises(RuntimeError, match="daemon-listing-refused"):
        c.remove("container", "owned-case")


@pytest.mark.parametrize(
    "relative",
    [
        "apps/orgs/claim_delivery.py",
        "apps/orgs/claim_confirmation.py",
        "apps/identity/owner_binding.py",
        "apps/orgs/owner_claims.py",
    ],
)
def test_actual_image_probe_refuses_private_module_restoration(tmp_path, relative):
    c = controller()
    for name in c.IMAGE_REQUIRED:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("synthetic served module")
    # The image's whole outbox is the realm access enqueue (MEMBERSHIP_LIFECYCLE.md §6.1.1).
    (tmp_path / "apps/outbox").mkdir(parents=True, exist_ok=True)
    for name in ("__init__.py", "realm_enqueue.py"):
        (tmp_path / "apps/outbox" / name).write_text("synthetic served module")
    c.image_source_boundary(tmp_path)
    path = tmp_path / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("synthetic excluded creator")
    with pytest.raises(AssertionError, match="consume image source boundary refused"):
        c.image_source_boundary(tmp_path)


def test_actual_qualifier_refuses_local_service_start(monkeypatch):
    c = controller()
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    with pytest.raises(AssertionError, match="hosted-only consume qualification"):
        c.qualify_consume_http()


@pytest.mark.parametrize(
    "bad",
    [
        [{"case": "private-sentinel"}],
        [
            {
                "case": "unknown",
                "stage": "call",
                "category": "database",
                "sqlstate": "private-state",
                "constraint": "unknown",
            }
        ],
        [],
        [{}] * 129,
    ],
)
def test_actual_scoped_diagnostics_refuse_arbitrary_capture(bad):
    c = controller()
    with pytest.raises(AssertionError, match="consume diagnostic"):
        c.closed_diagnostics(bad)


def test_actual_seed_privacy_guard_covers_binary_sealed_encodings():
    import base64

    c = controller()
    sealed = b"\x00\xfeactual-private-sealed\x80"
    world = {
        "cases": {
            "success": {
                "token": "oc1_actual-private-delivered-token",
                "verifier": "$argon2id$actual-private-verifier",
                "sealed_contact": sealed.hex(),
                "sealed_delivery": sealed.hex(),
            }
        }
    }
    private = c.secret_material(world)
    for leaked in (sealed, sealed.hex().encode(), base64.b64encode(sealed)):
        with pytest.raises(AssertionError, match="consume private material refused"):
            c.public_bytes(leaked, private)


def test_actual_operator_diagnostic_boundary_cannot_forward_unapproved_stdout(monkeypatch, capsys):
    from types import SimpleNamespace

    c = controller()
    calls = 0

    def command(*args, **kwargs):
        nonlocal calls
        calls += 1
        return SimpleNamespace(
            returncode=0 if calls == 1 else 1,
            stdout='KODERA_CONSUME_DIAGNOSTIC [{"case":"private-sentinel"}]',
            stderr="private-driver-sentinel",
        )

    monkeypatch.setattr(c.serving, "command", command)
    with pytest.raises(AssertionError, match="consume diagnostic"):
        c.operator_fixture(1234)
    assert capsys.readouterr().out == ""


def test_actual_http_capture_refuses_truncation(monkeypatch):
    c = controller()

    class Oversized:
        code = 200
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, limit):
            return b"x" * 65537

    monkeypatch.setattr(c, "urlopen", lambda *args, **kwargs: Oversized())
    with pytest.raises(AssertionError, match="consume response capture truncated"):
        c.post(1234, {}, None, "synthetic-bounded-key")


EXPECTED_CASE_COUNTS = {
    "test_actual_scoped_role_success_and_executed_insert_shapes": 1,
    "test_actual_scoped_denial_receipt_requires_new_key": 2,
    "test_actual_scoped_replay_withdrawal_preserves_receipt": 1,
    "test_actual_sequence_kind_policy_and_privilege_refusal": 6,
    "test_actual_nonadmitted_column_write_refuses": 5,
    "test_actual_granted_lock_id_storage_refusal": 3,
    "test_actual_enabled_privilege_is_value_unrestricted": 1,
    "test_actual_column_grant_omission_rolls_back_without_widening": 1,
    "test_actual_catalog_paired_column_widening_refuses": 3,
    "test_actual_delete_table_and_security_definer_widening_refuse": 1,
    "test_actual_retained_organisation_fanout_and_rollback": 1,
    "test_actual_scoped_replay_holds_through_cached_materialization": 3,
    "test_actual_scoped_database_clock_expiry_is_single_and_audited": 1,
    "test_actual_scoped_staff_and_unknown_customer_have_no_consume_capability": 1,
    "test_actual_replay_guard_omission_mutation_releases_forbidden_cached_bytes": 1,
}


def test_actual_pg_observer_refuses_missing_cases_and_skipped_success():
    from types import SimpleNamespace

    c = controller()
    assert c.SCOPED_CASE_COUNTS == EXPECTED_CASE_COUNTS
    proof = c.postgresql_plugin()
    assert proof.complete() is False
    items = [
        SimpleNamespace(
            nodeid="tests/test_owner_claim_consume_fixture.py::" + name + "[" + str(index) + "]"
        )
        for name, count in c.SCOPED_CASE_COUNTS.items()
        for index in range(count)
    ]
    with pytest.raises(AssertionError, match="consume scoped case inventory refused"):
        proof.pytest_collection_modifyitems(items=items[:-1])
    proof.pytest_collection_modifyitems(items=items)
    assert proof.complete() is False
    for item in items:
        proof.pytest_runtest_makereport(item, SimpleNamespace(when="call", excinfo=None))
    assert proof.complete() is True


# Measured actual fixture and historical scanner controls use independently fixed ledgers.
HISTORICAL_FINGERPRINTS = (
    "586dcd794dc7e50b5de9ac4b230b0b5598fa6d90:tests/test_owner_claim_consume_fixture.py:generic-api-key:72",
    "586dcd794dc7e50b5de9ac4b230b0b5598fa6d90:tests/test_owner_claim_consume_fixture.py:generic-api-key:552",
)


def scanner_guard():
    path = ROOT / "scripts/ci/check-gitleaks-fingerprints.py"
    spec = importlib.util.spec_from_file_location("historical_fingerprint_guard", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixture_pair_events(source):
    import ast
    import builtins
    from contextlib import contextmanager
    from types import SimpleNamespace

    tree = ast.parse(source)
    function = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "test_actual_retained_organisation_fanout_and_rollback"
    )
    function.decorator_list = []
    events, depth = [], [0]

    class StopProbeError(Exception):
        pass

    @contextmanager
    def atomic():
        depth[0] += 1
        try:
            yield
        finally:
            depth[0] -= 1

    class OrganisationManager:
        def create(self, **fields):
            events.append(("organisation", depth[0]))
            return SimpleNamespace(**fields)

    class ReservationManager:
        def create(self, **fields):
            events.append(("reservation", depth[0]))
            raise StopProbeError

    models = SimpleNamespace(
        Organisation=SimpleNamespace(objects=OrganisationManager()),
        SlugReservation=SimpleNamespace(objects=ReservationManager()),
        OwnerClaim=None,
    )
    identity = SimpleNamespace(Identity=None, User=None)
    original_import = builtins.__import__

    def intercepted(name, *args, **kwargs):
        if name == "apps.orgs.models":
            return models
        if name == "apps.identity.models":
            return identity
        if name == "psycopg":
            return SimpleNamespace(sql=None)
        return original_import(name, *args, **kwargs)

    namespace = {
        "transaction": SimpleNamespace(atomic=atomic),
        "__builtins__": {**vars(builtins), "__import__": intercepted},
    }
    exec(compile(ast.Module(body=[function], type_ignores=[]), "fixture-pair", "exec"), namespace)  # noqa: S102 - actual callable body interception
    try:
        namespace[function.name]((None, {"cases": {"success": {}}}, None, None))
    except StopProbeError:
        pass
    return events


def require_fixture_pair(source):
    assert fixture_pair_events(source) == [("organisation", 1), ("reservation", 1)], (
        "actual retained fixture reservation pair lacks one atomic boundary"
    )


def test_actual_retained_fixture_pair_requires_same_atomic_boundary():
    require_fixture_pair((ROOT / "tests/test_owner_claim_consume_fixture.py").read_text())


def test_actual_historical_fingerprint_guard_and_ledger_exist():
    guard = scanner_guard()
    assert (
        guard.validate_ledger(
            (ROOT / "scripts/ci/gitleaks-historical-fingerprints.txt").read_text()
        )
        == HISTORICAL_FINGERPRINTS
    )


def test_actual_guard_probe_secret_is_deterministic_and_stopword_free():
    guard = scanner_guard()
    first = guard.probe_secret(72)
    second = guard.probe_secret(552)
    assert first == guard.probe_secret(72)
    assert second == guard.probe_secret(552)
    assert first != second
    for probe in (first, second):
        assert len(probe) == 48
        assert len(set(probe)) == 48
        assert not (set(probe.lower()) & set("aeiouy01"))


@pytest.mark.parametrize(
    "mutation",
    ["empty", "missing", "duplicate", "extra", "global", "commit", "path", "rule", "line"],
)
def test_actual_fingerprint_ledger_refuses_scope_widening(mutation):
    guard = scanner_guard()
    values = list(HISTORICAL_FINGERPRINTS)
    if mutation == "empty":
        values = []
    elif mutation == "missing":
        values.pop()
    elif mutation == "duplicate":
        values.append(values[0])
    elif mutation == "extra":
        values.append("1" * 40 + ":tests/test_owner_claim_consume_fixture.py:generic-api-key:72")
    elif mutation == "global":
        values[0] = values[0].split(":", 1)[1]
    else:
        index = {"commit": 0, "path": 1, "rule": 2, "line": 3}[mutation]
        fields = values[0].split(":")
        fields[index] = "changed"
        values[0] = ":".join(fields)
    with pytest.raises(AssertionError, match="historical fingerprint ledger refused"):
        guard.validate_ledger("\n".join(values) + "\n")


def scanner_fixture(tmp_path):
    guard = scanner_guard()
    guard.git(["init", "--initial-branch=feat/scanner-fixture", str(tmp_path)], ROOT)
    guard.git(
        [
            "-c",
            "user.name=Fixture acceptance",
            "-c",
            "user.email=fixture@synthetic.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "Keep scanner fixture independent of product history",
        ],
        tmp_path,
    )
    ledger = tmp_path / ".github/gitleaks-historical-fingerprints.txt"
    ledger.parent.mkdir()
    ledger.write_text("\n".join(HISTORICAL_FINGERPRINTS) + "\n")
    (tmp_path / ".gitleaks.toml").write_bytes((ROOT / ".gitleaks.toml").read_bytes())
    return tmp_path


def owned_active_binding_fixture(tmp_path, monkeypatch):
    """Actual Git/verifier semantics on public-only unit data, never canonical history proof."""
    import hashlib

    guard = scanner_guard()
    # Freeze production defaults independently before any isolated unit binding.
    assert guard.ORIGINAL == "586dcd794dc7e50b5de9ac4b230b0b5598fa6d90"
    assert guard.BLOB_SHA256 == "adbd590fe19c1dfcb7501e6ab11057b097d87e6d89769cd42ebdb9f1ab5b68b3"
    assert guard.LITERAL_SHA256 == (
        "fef69f550822badc09d14fe8511988e14e65568d8e88c7636855d36c47dbefa5",
        "9e69d3d8d9ca63b43428fb82056bd4e312b67d100efc7b53bc83037d4021c149",
    )
    assert guard.EXPECTED == HISTORICAL_FINGERPRINTS
    root = scanner_fixture(tmp_path)
    lines = ["# Public-only synthetic unit source; actual canonical proof is in Secret scan"] * 600
    lines[71] = "def request(world, *, facts='credential', key='0000000000000001', payload=None):"
    lines[72] = "    return Client().post('/', HTTP_IDEMPOTENCY_KEY=key)"
    lines[549] = "def test_actual_scoped_database_clock_expiry_is_single_and_audited():"
    lines[550] = "    return Client().post("
    lines[551] = "        HTTP_IDEMPOTENCY_KEY='0000000000000002')"
    blob = ("\n".join(lines) + "\n").encode()
    source = root / guard.FIXTURE
    source.parent.mkdir()
    source.write_bytes(blob)
    guard.git(["add", guard.FIXTURE], root)
    guard.git(
        [
            "-c",
            "user.name=Fixture acceptance",
            "-c",
            "user.email=fixture@synthetic.invalid",
            "commit",
            "-m",
            "Bind pure history controls to owned public unit data",
        ],
        root,
    )
    target = guard.git(["rev-parse", "HEAD"], root).decode().strip()
    expected = tuple(f"{target}:{guard.FIXTURE}:generic-api-key:{line}" for line in (72, 552))
    monkeypatch.setattr(guard, "ORIGINAL", target)
    monkeypatch.setattr(guard, "EXPECTED", expected)
    monkeypatch.setattr(guard, "BLOB_SHA256", hashlib.sha256(blob).hexdigest())
    monkeypatch.setattr(
        guard,
        "LITERAL_SHA256",
        tuple(
            hashlib.sha256(value.encode()).hexdigest()
            for value in ("0000000000000001", "0000000000000002")
        ),
    )
    (root / guard.LEDGER).write_text("\n".join(expected) + "\n")
    assert guard.check_scope(root) == {"history_mode": "active", "historical_source": "verified"}
    return guard, root, blob


def test_actual_guard_active_history_verifies_immutable_public_key_source(tmp_path, monkeypatch):
    guard, root, _ = owned_active_binding_fixture(tmp_path, monkeypatch)
    assert guard.check_scope(root) == {"history_mode": "active", "historical_source": "verified"}


def test_actual_guard_inactive_history_never_requests_missing_blob(tmp_path, monkeypatch):
    guard = scanner_guard()
    root = scanner_fixture(tmp_path)
    original = guard.git

    def forbid_show(arguments, checkout):
        assert arguments[0] != "show", "inactive history requested missing original source"
        return original(arguments, checkout)

    monkeypatch.setattr(guard, "git", forbid_show)
    assert guard.check_scope(root) == {
        "history_mode": "inactive-not-scanned",
        "historical_source": "not-applicable",
    }


@pytest.mark.parametrize("entry", ["file", "directory", "symlink", "broken-symlink"])
def test_actual_guard_refuses_any_root_ignore_entry(tmp_path, entry):
    guard = scanner_guard()
    root = scanner_fixture(tmp_path)
    target = root / ".gitleaksignore"
    if entry == "file":
        target.write_text(HISTORICAL_FINGERPRINTS[0])
    elif entry == "directory":
        target.mkdir()
    else:
        target.symlink_to(root / (".github" if entry == "symlink" else "absent"))
    with pytest.raises(AssertionError, match="root ignore entry refused"):
        guard.check_scope(root)


@pytest.mark.parametrize(
    "mutation",
    [
        "shallow",
        "empty",
        "malformed",
        "duplicate",
        "missing-head",
        "command-error",
        "missing-object",
    ],
)
def test_actual_guard_refuses_incomplete_or_unverified_history(tmp_path, monkeypatch, mutation):
    guard, root, _ = owned_active_binding_fixture(tmp_path, monkeypatch)
    original = guard.git
    reached = []

    def altered(arguments, checkout):
        if arguments == ["rev-parse", "--is-shallow-repository"] and mutation == "shallow":
            reached.append(mutation)
            return b"true\n"
        if arguments == ["rev-list", "--full-history", "HEAD"] and mutation in {
            "empty",
            "malformed",
            "duplicate",
            "missing-head",
            "command-error",
        }:
            reached.append(mutation)
            if mutation == "command-error":
                return original(["rev-list", "--full-history", "synthetic-missing-ref"], checkout)
            if mutation == "empty":
                return b""
            if mutation == "malformed":
                return b"not-a-commit\n"
            if mutation == "duplicate":
                result = original(arguments, checkout)
                return result + result.splitlines()[0] + b"\n"
            if mutation == "missing-head":
                return b"1" * 40 + b"\n"
        if (
            arguments == ["show", guard.ORIGINAL + ":" + guard.FIXTURE]
            and mutation == "missing-object"
        ):
            reached.append(mutation)
            return original(["show", "0" * 40 + ":" + guard.FIXTURE], checkout)
        return original(arguments, checkout)

    monkeypatch.setattr(guard, "git", altered)
    with pytest.raises(AssertionError) as refused:
        guard.check_scope(root)
    assert reached == [mutation], "intended history mutation was not reached"
    assert str(refused.value) == (
        "historical command refused"
        if mutation in {"command-error", "missing-object"}
        else "historical complete history refused"
    )


def test_actual_guard_immutable_blob_and_public_header_binding_refuse_mutations(
    tmp_path, monkeypatch
):
    import hashlib

    guard, _, blob = owned_active_binding_fixture(tmp_path, monkeypatch)
    with pytest.raises(AssertionError) as refused:
        guard.verify_binding(blob + b"\n")
    assert str(refused.value) == "historical source blob refused"
    assert blob.count(b"HTTP_IDEMPOTENCY_KEY=key") == 1
    changed = blob.replace(b"HTTP_IDEMPOTENCY_KEY=key", b"HTTP_AUTHORIZATION=key")
    monkeypatch.setattr(guard, "BLOB_SHA256", hashlib.sha256(changed).hexdigest())
    with pytest.raises(AssertionError) as refused:
        guard.verify_binding(changed)
    assert str(refused.value) == "historical public key binding refused"


def test_actual_owned_public_literal_mutation_is_refused(tmp_path, monkeypatch):
    import hashlib

    guard, _, blob = owned_active_binding_fixture(tmp_path, monkeypatch)
    changed = blob.replace(b"0000000000000001", b"0000000000000003")
    monkeypatch.setattr(guard, "BLOB_SHA256", hashlib.sha256(changed).hexdigest())
    with pytest.raises(AssertionError) as refused:
        guard.verify_binding(changed)
    assert str(refused.value) == "historical public key literal refused"


def test_actual_owned_active_baseline_refuses_genuine_shallow_history(tmp_path, monkeypatch):
    guard, root, _ = owned_active_binding_fixture(tmp_path, monkeypatch)
    (root / ".git/shallow").write_text(guard.ORIGINAL + "\n")
    with pytest.raises(AssertionError) as refused:
        guard.check_scope(root)
    assert str(refused.value) == "historical complete history refused"


def test_current_public_keys_are_independently_fixed_low_entropy():
    import ast

    tree = ast.parse((ROOT / "tests/test_owner_claim_consume_fixture.py").read_text())
    request_function = next(
        node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "request"
    )
    assert request_function.args.kw_defaults[1].value == "0000000000000001"
    expiry = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "test_actual_scoped_database_clock_expiry_is_single_and_audited"
    )
    assert [
        keyword.value.value
        for node in ast.walk(expiry)
        if isinstance(node, ast.Call)
        for keyword in node.keywords
        if keyword.arg == "HTTP_IDEMPOTENCY_KEY"
    ] == ["0000000000000002"]


def test_actual_atomic_pair_omission_mutation_refuses():
    import ast

    tree = ast.parse((ROOT / "tests/test_owner_claim_consume_fixture.py").read_text())
    function = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "test_actual_retained_organisation_fanout_and_rollback"
    )
    pair = next(node for node in function.body if isinstance(node, ast.With))
    index = function.body.index(pair)
    function.body[index : index + 1] = pair.body
    with pytest.raises(
        AssertionError, match="actual retained fixture reservation pair lacks one atomic boundary"
    ):
        require_fixture_pair(ast.unparse(tree))


@pytest.mark.parametrize("variable", ["GITLEAKS_CONFIG", "GITLEAKS_CONFIG_TOML"])
def test_actual_guard_refuses_detector_environment_override(monkeypatch, variable):
    guard = scanner_guard()
    monkeypatch.setenv(variable, "synthetic-override")
    with pytest.raises(AssertionError, match="detector environment override refused"):
        guard.check_scope(ROOT)


@pytest.mark.parametrize("active", [True, False])
def test_actual_qualifier_requires_future_secret_controls_for_applicable_modes(
    monkeypatch, capsys, active
):
    import sys

    guard = scanner_guard()
    calls = []
    scope = {
        "history_mode": "active" if active else "inactive-not-scanned",
        "historical_source": "verified" if active else "not-applicable",
    }

    def command(arguments, root, **kwargs):
        assert arguments == [str(guard.BINARY), "version"] and root == ROOT
        assert guard.BINARY == Path("/tmp/gitleaks")  # noqa: S108 - exact hosted job binding
        return b"8.28.0\n"

    def future(root, *, active):
        assert root == ROOT
        calls.append(active)
        return "passed"

    monkeypatch.setattr(sys, "argv", ["fingerprint-guard"])
    monkeypatch.setattr(guard, "command", command)
    monkeypatch.setattr(guard, "check_scope", lambda root: scope)
    monkeypatch.setattr(guard, "future_proof", future)
    guard.qualify()
    assert calls == ([False, True] if active else [False])
    assert json.loads(capsys.readouterr().out) == {
        "historical_fingerprint_guard": "passed",
        **scope,
        "inactive_future_secret_probe": "passed",
        "active_future_secret_probe": "passed" if active else "not-applicable",
    }


@pytest.mark.parametrize("version", [b"8.30.1\n", b"", b"unknown\n"])
def test_actual_qualifier_refuses_unpinned_binary(monkeypatch, version):
    import sys

    guard = scanner_guard()
    monkeypatch.setattr(sys, "argv", ["fingerprint-guard"])
    monkeypatch.setattr(guard, "command", lambda *args, **kwargs: version)
    with pytest.raises(AssertionError, match="pinned detector version refused"):
        guard.qualify()


@pytest.mark.parametrize(
    "mutation", ["empty", "missing", "extra", "old-commit", "path", "rule", "line", "global"]
)
def test_actual_pinned_report_boundary_refuses_scoped_counterexamples(mutation):
    guard = scanner_guard()
    commit = "1" * 40
    rows = [
        {
            "RuleID": "generic-api-key",
            "File": guard.FIXTURE,
            "StartLine": line,
            "Commit": commit,
            "Fingerprint": f"{commit}:{guard.FIXTURE}:generic-api-key:{line}",
        }
        for line in (72, 552)
    ]
    guard.assert_findings(rows, commit)
    if mutation == "empty":
        rows = []
    elif mutation == "missing":
        rows.pop()
    elif mutation == "extra":
        rows.append(dict(rows[0]))
    elif mutation == "old-commit":
        commit = guard.ORIGINAL
    elif mutation == "global":
        rows[0]["Fingerprint"] = rows[0]["Fingerprint"].split(":", 1)[1]
    else:
        rows[0][{"path": "File", "rule": "RuleID", "line": "StartLine"}[mutation]] = "changed"
    with pytest.raises(AssertionError, match="future secret findings refused"):
        guard.assert_findings(rows, commit)


REQUIRED_SEED_CASES = ("success", "profile", "contact", "mfa", "past", "rollback", "busy")
EXPECTED_CONSUME_PROOFS = {
    "column_role_policy",
    "actual_image_boundary",
    "atomic_success",
    "replay_and_withdrawal",
    "denials_and_new_key",
    "ordered_refusals",
    "claim_nowait",
    "audit_rollback",
    "clock_expiry",
    "privacy",
    "bounded_shutdown",
}


def actual_seed_trust_prefix(c, cases):
    """Actual source entry construction and parser; no seed/database/HTTP invocation."""
    import ast
    import time

    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa

    tree = ast.parse((ROOT / "dev/accept_owner_claim_consume_http.py").read_text())
    seed = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "seed_consume_fixture"
    )
    entries = next(
        node
        for node in seed.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "entries" for target in node.targets)
    )
    append = next(
        node
        for node in seed.body
        if isinstance(node, ast.For) and isinstance(node.iter, ast.Name) and node.iter.id == "cases"
    )
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    jwk.update(kid="synthetic-consume-key", alg="RS256", use="sig", key_ops=["verify"])
    namespace = {
        "jwk": jwk,
        "now": int(time.time()),
        "STAFF_ISSUER": c.STAFF_ISSUER,
        "cases": cases,
    }
    exec(  # noqa: S102 - exact actual public construction; no database statements
        compile(
            ast.Module(body=[entries, append], type_ignores=[]), "actual-seed-trust-prefix", "exec"
        ),
        namespace,
    )
    return namespace["entries"]


def actual_busy_protocol(c, mutation=None):
    """Actual finite controller blocks on public-only call doubles; no network or SQL executes."""
    import ast
    from types import SimpleNamespace

    tree = ast.parse((ROOT / "dev/accept_owner_claim_consume_http.py").read_text())
    qualify = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "qualify_consume_http"
    )

    def block(begin, end):
        for node in ast.walk(qualify):
            for _, value in ast.iter_fields(node):
                if not isinstance(value, list):
                    continue
                starts = [
                    index
                    for index, item in enumerate(value)
                    if isinstance(item, ast.Assign)
                    and isinstance(item.value, ast.Constant)
                    and item.value.value == begin
                ]
                ends = [
                    index
                    for index, item in enumerate(value)
                    if isinstance(item, ast.Assign)
                    and isinstance(item.value, ast.Constant)
                    and item.value.value == end
                ]
                if starts and ends:
                    return value[starts[0] + 1 : ends[0]]
        raise AssertionError("actual finite phase block absent")

    ordered = block("consume-ordered-signature-and-token-refusals", "consume-verified-claim-nowait")
    held = block("consume-verified-claim-nowait", "consume-required-audit-rollback")
    checked_declaration = next(
        node
        for node in ast.walk(qualify)
        if isinstance(node, ast.FunctionDef) and node.name == "checked"
    )
    assert [node.arg for node in checked_declaration.args.kwonlyargs] == ["key", "facts", "payload"]
    assert [ast.literal_eval(node) for node in checked_declaration.args.kw_defaults] == [
        "consume-image-key-001",
        "credential",
        None,
    ]
    if mutation == "wrong-lookup":
        lookup = next(
            node
            for item in ordered
            for node in ast.walk(item)
            if isinstance(node, ast.Subscript)
            and isinstance(node.slice, ast.Constant)
            and node.slice.value == "busy"
        )
        lookup.slice.value = "wrong"
    elif mutation in {"contact-fact", "logical-key"}:
        keyword = next(
            keyword
            for item in ordered
            for node in ast.walk(item)
            if isinstance(node, ast.Call)
            for keyword in node.keywords
            if keyword.arg == ("facts" if mutation == "contact-fact" else "key")
        )
        keyword.value.value = (
            "credential" if mutation == "contact-fact" else "consume-verified-busy-key"
        )
    elif mutation == "retry-before-release":
        retry = next(
            statement
            for statement in held
            if isinstance(statement, ast.Expr)
            and isinstance(statement.value, ast.Call)
            and isinstance(statement.value.func, ast.Name)
            and statement.value.func.id == "checked"
            and len(statement.value.args) > 1
            and isinstance(statement.value.args[1], ast.Constant)
            and statement.value.args[1].value == 200
        )
        holder_scope = next(statement for statement in held if isinstance(statement, ast.With))
        rollback_index = next(
            index
            for index, statement in enumerate(holder_scope.body)
            if isinstance(statement, ast.Expr)
            and isinstance(statement.value, ast.Call)
            and isinstance(statement.value.func, ast.Attribute)
            and statement.value.func.attr == "rollback"
        )
        held.remove(retry)
        holder_scope.body.insert(rollback_index, retry)
    record = {
        "claim_id": "0001",
        "token": "0" * 48,
        "credential": "0003",
        "contact_credential": "0004",
        "unknown_credential": "0005",
    }
    other = {"token": "1" * 48}
    incorrect = record["token"][:-2] + "A" + record["token"][-1]
    trace = []
    state = {
        "issued": True,
        "held": False,
        "retry_read": False,
        "rollbacks": 0,
        "context_exits": 0,
        "successes": 0,
        "effects": 0,
    }

    def checked(case, status, *, key="consume-image-key-001", facts="credential", payload=None):
        assert case == "busy", "ordered request uses redundant case"
        trace.append(("checked", case, status, key, facts, payload))
        assert state["issued"], "busy consumed before verified held sequence"
        if status == 503:
            assert (
                state["held"]
                and key == "consume-verified-busy-key"
                and facts == "credential"
                and payload is None
            ), "verified held refusal arguments changed"
            return b"", {"Retry-After": "1"}
        if status == 200:
            c.require(
                not state["held"]
                and state["retry_read"]
                and state["rollbacks"] == 1
                and key == "consume-verified-busy-key"
                and payload is None,
                "same-key retry did not follow held refusal and release",
            )
            state["issued"] = False
            state["successes"] += 1
        else:
            assert status == 404, "unexpected earlier valid consume"
        return b"", {}

    def post(port, payload, credential, key):
        assert state["issued"] and not state["held"], "direct denial altered busy state"
        # No token is 401; a verified token, the staff one or one Core holds no identity for, 403.
        status = 401 if credential is None else 403
        trace.append(("post", status, credential, key, payload))
        if credential == record["unknown_credential"]:
            unknown = {"type": "https://kodera.io/problems/identity-unknown", "status": 403}
            return status, json.dumps(unknown).encode(), {"Cache-Control": "no-store"}
        return status, b"", {}

    class Cursor:
        def __init__(self, locking=False):
            self.locking = locking

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, query, parameters):
            if self.locking:
                assert (
                    state["issued"] and "FOR UPDATE" in query and parameters == [record["claim_id"]]
                ), "actual lock command changed"
                state["held"] = True
            else:
                assert state["held"] and "count(*)" in query and "idempotency_record" in query, (
                    "actual receipt absence check missing"
                )
                assert parameters == ["https://identity.synthetic.test/realms/consume-busy"], (
                    "receipt issuer changed"
                )
                state["retry_read"] = True

        def fetchone(self):
            return ("0001",) if self.locking else (0,)

    class Holder:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            # Real psycopg connection exit commits/rolls back and closes;
            # cursor exit alone does not release its transaction's row locks.
            state["held"] = False
            state["context_exits"] += 1
            return False

        def cursor(self):
            return Cursor(True)

        def rollback(self):
            state["held"] = False
            state["rollbacks"] += 1

    def connect(dsn, *, password):
        assert dsn == "0007" and password == "0008", (
            "existing synthetic connection arguments changed"
        )
        return Holder()

    def effects(case):
        assert case == "busy" and not state["issued"] and state["successes"] == 1, (
            "busy terminal effects missing"
        )
        state["effects"] += 1

    namespace = {
        "world": {"cases": {"busy": record}, "staff_token": "0006"},
        "record": other,
        "proof": {},
        "checked": checked,
        "post": post,
        "port": 1,
        "public_bytes": c.public_bytes,
        "privacy": [],
        "require": c.require,
        "json": json,
        "psycopg": SimpleNamespace(connect=connect),
        "admin": SimpleNamespace(info=SimpleNamespace(dsn="0007", password="0008")),
        "cursor": Cursor(),
        "effects": effects,
    }
    for body in (ordered, held):
        program = ast.fix_missing_locations(ast.Module(body=body, type_ignores=[]))
        exec(compile(program, "actual-finite-busy-protocol", "exec"), namespace)  # noqa: S102 - actual controller callable blocks; public-only call doubles
    expected_trace = [
        (
            "checked",
            "busy",
            404,
            "consume-image-key-001",
            "contact_credential",
            {"token": incorrect},
        ),
        ("checked", "busy", 404, "consume-cross-org-key", "credential", {"token": other["token"]}),
        ("post", 401, None, "!", {"unexpected": "synthetic"}),
        ("post", 403, record["unknown_credential"], "!", {}),
        ("post", 403, "0006", "consume-staff-refused-key", {"token": record["token"]}),
        ("checked", "busy", 404, "consume-unverified-busy-key", "credential", {"token": incorrect}),
        ("checked", "busy", 503, "consume-verified-busy-key", "credential", None),
        ("checked", "busy", 200, "consume-verified-busy-key", "credential", None),
    ]
    c.require(trace == expected_trace, "full ordered credential payload key trace differs")
    assert state == {
        "issued": False,
        "held": False,
        "retry_read": True,
        "rollbacks": 1,
        "context_exits": 1,
        "successes": 1,
        "effects": 1,
    }
    assert namespace["proof"] == {"ordered_refusals": True, "claim_nowait": True}
    required = next(
        node
        for node in qualify.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "required" for target in node.targets)
    )
    assert ast.literal_eval(required.value) == EXPECTED_CONSUME_PROOFS


def test_actual_default_seed_fits_fixed_trust_cap_and_distinct_states():
    from services.identity.trusted_issuers import MAX_ISSUERS, load_trust

    c = controller()
    assert c.seed_consume_fixture.__defaults__[0] == REQUIRED_SEED_CASES, (
        "actual default seed state inventory refused"
    )
    assert MAX_ISSUERS == 8
    entries = actual_seed_trust_prefix(c, c.seed_consume_fixture.__defaults__[0])
    assert len(entries) == 8 and len(load_trust(json.dumps(entries))) == 8


@pytest.mark.parametrize("restored", ["replay", "wrong"])
def test_actual_restored_extra_seed_issuer_is_refused(restored):
    from services.identity.trusted_issuers import TrustConfigurationError, load_trust

    c = controller()
    entries = actual_seed_trust_prefix(c, REQUIRED_SEED_CASES + (restored,))
    with pytest.raises(TrustConfigurationError):
        load_trust(json.dumps(entries))


def test_actual_busy_reuse_preserves_full_arguments_states_and_eleven_proofs():
    actual_busy_protocol(controller())


@pytest.mark.parametrize(
    "mutation", ["wrong-lookup", "contact-fact", "logical-key", "retry-before-release"]
)
def test_actual_busy_protocol_mutations_refuse(mutation):
    actual_busy_protocol(controller())
    if mutation == "wrong-lookup":
        with pytest.raises(KeyError) as refused:
            actual_busy_protocol(controller(), mutation)
        assert refused.value.args == ("wrong",)
    else:
        with pytest.raises(AssertionError) as refused:
            actual_busy_protocol(controller(), mutation)
        assert str(refused.value) == (
            "same-key retry did not follow held refusal and release"
            if mutation == "retry-before-release"
            else "full ordered credential payload key trace differs"
        )


def _consume_diagnostic_error(kind):
    import subprocess

    canary = "synthetic-private-exception-canary"
    if kind == "timeout":

        class PoisonTimeout(subprocess.TimeoutExpired):
            def __str__(self):
                raise AssertionError("exception __str__ must not run")

            def __repr__(self):
                raise AssertionError("exception __repr__ must not run")

        return PoisonTimeout([canary], 180, output=canary, stderr=canary)
    if kind == "command":
        return subprocess.CalledProcessError(23, [canary], output=canary, stderr=canary)
    if kind == "predicate":
        return AssertionError(canary)
    if kind == "os":
        return PermissionError(canary)
    if kind == "group":
        return ExceptionGroup(canary, [ValueError(canary)])
    if kind == "class-poison":

        class PoisonClassError(Exception):
            @property
            def __class__(self):
                raise AssertionError("exception __class__ must not run")

            @__class__.setter
            def __class__(self, _value):
                raise AssertionError("exception __class__ setter must not run")

            def __str__(self):
                raise AssertionError("exception __str__ must not run")

            def __repr__(self):
                raise AssertionError("exception __repr__ must not run")

        return PoisonClassError(canary)
    if kind == "unclassified":

        class PoisonUnknownError(Exception):
            def __str__(self):
                raise AssertionError("exception __str__ must not run")

            def __repr__(self):
                raise AssertionError("exception __repr__ must not run")

        return PoisonUnknownError(canary)
    raise AssertionError("unknown synthetic case")


@pytest.mark.parametrize(
    "kind", ["timeout", "command", "predicate", "os", "group", "unclassified", "class-poison"]
)
def test_actual_consume_entrypoint_emits_only_closed_safe_diagnostics(monkeypatch, capsys, kind):
    c = controller()
    error = _consume_diagnostic_error(kind)
    calls = []

    def qualify():
        calls.append("qualify")
        c.PHASE = "source-baseline"
        raise error

    monkeypatch.setattr(c, "qualify_consume_http", qualify)
    category = "unclassified" if kind in {"group", "class-poison"} else kind
    assert c.failure_category(error) == category
    assert c.main() == 1
    captured = capsys.readouterr()
    assert calls == ["qualify"]
    assert captured.out == ""
    assert (
        captured.err
        == f"Consume qualification refused during source-baseline ({category}); no captured values emitted\n"
    )
    assert "synthetic-private-exception-canary" not in captured.err
    assert "Traceback" not in captured.err


@pytest.mark.parametrize("stop_kind", ["system-exit", "keyboard-interrupt"])
def test_actual_consume_entrypoint_preserves_success_and_baseexception_boundary(
    monkeypatch, capsys, stop_kind
):
    c = controller()
    calls = []
    monkeypatch.setattr(c, "qualify_consume_http", lambda: calls.append("qualify"))
    assert c.main() == 0
    assert calls == ["qualify"]
    captured = capsys.readouterr()
    assert captured.out == captured.err == ""

    def stop():
        if stop_kind == "system-exit":
            raise SystemExit(7)
        raise KeyboardInterrupt

    monkeypatch.setattr(c, "qualify_consume_http", stop)
    expected_type = SystemExit if stop_kind == "system-exit" else KeyboardInterrupt
    with pytest.raises(expected_type) as result:
        c.main()
    if stop_kind == "system-exit":
        assert result.value.code == 7
    captured = capsys.readouterr()
    assert captured.out == captured.err == ""


@pytest.mark.parametrize("kind", ["unknown", "poison", "allowed-name-subclass"])
def test_actual_consume_entrypoint_never_renders_unapproved_phase(monkeypatch, capsys, kind):
    c = controller()

    class PoisonPhase:
        def __str__(self):
            raise AssertionError("phase __str__ must not run")

        def __repr__(self):
            raise AssertionError("phase __repr__ must not run")

    class PoisonAllowedPhase(str):
        def __str__(self):
            raise AssertionError("phase subclass __str__ must not run")

        def __repr__(self):
            raise AssertionError("phase subclass __repr__ must not run")

    if kind == "unknown":
        value = "synthetic-private-phase-canary"
    elif kind == "allowed-name-subclass":
        value = PoisonAllowedPhase("source-baseline")
    else:
        value = PoisonPhase()

    def qualify():
        c.PHASE = value
        raise AssertionError("synthetic-private-exception-canary")

    monkeypatch.setattr(c, "qualify_consume_http", qualify)
    assert c.safe_failure_phase(value) == "unclassified"
    assert c.main() == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert (
        captured.err
        == "Consume qualification refused during unclassified (predicate); no captured values emitted\n"
    )


@pytest.mark.parametrize(
    "where,phase,category,expected",
    [
        ("recover", "hosted-reserve", "timeout", ["recover"]),
        ("baseline", "source-baseline", "predicate", ["recover", "baseline"]),
        ("inventory", "source-inventory", "os", ["recover", "baseline", "inventory"]),
    ],
)
def test_actual_consume_source_prefix_reports_first_refusal_without_resources(
    monkeypatch, capsys, where, phase, category, expected
):
    c = controller()
    calls = []

    def observe(name):
        calls.append(name)
        if name == where:
            raise _consume_diagnostic_error(category)
        return {}

    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setattr(c.serving, "require_disk_reserve", lambda: observe("recover"))
    monkeypatch.setattr(c, "baseline_sources", lambda: observe("baseline"))
    monkeypatch.setattr(c.serving, "source_hashes", lambda: observe("inventory"))

    def forbidden_resource(*_args, **_kwargs):
        raise AssertionError("resource operation must not be reached")

    monkeypatch.setattr(c, "docker", forbidden_resource)
    assert c.main() == 1
    captured = capsys.readouterr()
    assert calls == expected
    assert captured.out == ""
    assert (
        captured.err
        == f"Consume qualification refused during {phase} ({category}); no captured values emitted\n"
    )
