"""The first-slice acceptance harness: the interface ACCEPTANCE.md specifies, against this tree.

Real: the settings, migrations, URL resolver, middleware and DRF stack of `config.settings.test`;
the PostgreSQL database pytest-django creates and owns; the production token verifier; and the
committed contract as the only source of every path an operation is driven through.

Synthetic, and only these: the external infrastructure, invoice, payment and mail adapters, each
with an inspectable effect ledger, barriers, failure injection and correlation lookup; the
identity fixture, which signs tokens with a key generated per process and which is not identity
provider software; and a clock fixed at `T0`, moved only by explicit offsets.

Never: a mock of Core's own API, a second factor minted by the harness, a skip, or a green
reported on behalf of behaviour that does not exist.

Every step this tree cannot perform raises a `ScenarioGapError` naming the first missing thing,
and the conftest binds that name to the inventory. Most gaps are measured: an operation is looked
up in the real resolver, a record in the installed models, catalogue publication, claim
revocation, the payment inbox and return, organisation closure, operator reconciliation and a
direct realm-update request in the contract, the decided organisation and tenant slug rules and the
reserved names in the contract's slug schemas, identity provider admission in the trust
configuration, the worker in compose and its step bindings, and each fault point a scenario arms in core/faults.py and
`fault_points.toml`. Each of those raises an `AssertionError` instead of its gap the moment the
thing it measures appears. The rest are asserted because Core declares nothing to measure them
against yet: adapter ports, implementation weakenings, second-factor evidence and the console.

A fault point Core declares is armed for real: a crash is an in-process `SimulatedCrash` that rolls
back the transaction it leaves, and a hold keeps the transaction open until `race` releases it.
"""

import hashlib
import hmac
import io
import ipaddress
import itertools
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import uuid
from collections.abc import Callable, Collection, Iterator, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import jwt
import pytest
import time_machine
from cryptography.hazmat.primitives.asymmetric import rsa

from dev.check_first_slice_fault_points import (
    load_inventory as load_fault_inventory,
    planned_matches,
)
from dev.first_slice_bootstrap import load_contract, local_url, reviewed_operation

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
INVENTORY_PATH = HERE / "scenarios.toml"
FAULT_INVENTORY_PATH = HERE / "fault_points.toml"
FAULT_INVENTORY = load_fault_inventory(FAULT_INVENTORY_PATH)
MANIFEST_PATH = ROOT / "dev/first_slice_manifest.json"
MARKER = "first_slice_scenario"
POPULATION_TEST = "test_collected_scenarios_equal_the_inventory_and_the_manifest"
scenario = pytest.mark.first_slice_scenario

# The fixed synthetic instant every scenario starts at. Tests move it with explicit offsets and
# never wait on the wall clock. The value is the one the token suites already use.
T0 = datetime.fromtimestamp(2_000_000_000, UTC)

STATES = ("pass", "xfail", "blocked")
DECISION_STATUSES = ("open", "decided")
GAP_KINDS = (
    "operation",
    "record",
    "service",
    "worker",
    "adapter",
    "harness",
    "contract",
    "decision",
)
ID_PATTERN = re.compile(r"FS-(BOOT|LIFE|ID|OP|CON|BILL|JOURNEY|HARNESS)-[0-9]{2}\Z")
GAP_PATTERN = re.compile(r"(" + "|".join(GAP_KINDS) + r"):[A-Za-z0-9._-]+\Z")
SYNTHETIC_DOMAIN = "acceptance.test"
IDENTITY_HOST = "https://identity.acceptance.test"
BARRIER_SECONDS = 10.0
DEFAULT_DATABASE_URL = "postgres://kodera:kodera@localhost:5432/kodera_server"
LOCAL_SUFFIXES = (".test", ".invalid", ".localhost")
READ_METHODS = {"get", "head", "options", "trace"}
COPY_IGNORED = (
    ".git",
    ".venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "htmlcov",
    ".coverage*",
)

# ACCEPTANCE.md, "Full internal journey and proof quality": its eight minimum weakenings, plus the
# one the lead's FS-CON-01 ruling adds. Each is owned by the scenario whose counterexample must fail
# for the asserted reason once Core implements it.
REQUIRED_WEAKENINGS = {
    "remove-organisation-scoping": "FS-OP-04",
    "bypass-first-owner-subject-binding": "FS-BOOT-03",
    "omit-operation-target-from-deduplication": "FS-OP-02",
    "remove-organisation-resource-serialisation": "FS-CON-02",
    "allow-old-fence-dispatch": "FS-CON-03",
    "force-unlock-on-database-lease-evidence-alone": "FS-CON-04",
    "drop-durable-job": "FS-CON-06",
    "accept-unauthenticated-payment-status": "FS-BILL-05",
    # Not one of ACCEPTANCE.md's eight: the lead's ruling on FS-CON-01 that automatic compensation
    # covers `provision` step 9, the tenant's own clients.
    "compensate-before-step-9-only": "FS-CON-01",
}

PROVIDER_WORDS = {
    "PROVIDER",
    "INVOICE",
    "INVOICING",
    "BILLING",
    "PAYMENT",
    "PAYMENTS",
    "MAIL",
    "SMTP",
    "TEM",
    "IDENTITY",
    "KEYCLOAK",
    "OIDC",
    "ISSUER",
    "SCALEWAY",
    "SCW",
    "QONTO",
    "STRIPE",
    "SENTRY",
    "WEBHOOK",
}
ENDPOINT_WORDS = {"URL", "URI", "ENDPOINT", "HOST", "DSN", "BASE"}

# Decided: register SLUG, its minimum set to 5 by the owner's answer, register SLUG-MIN-ANSWER. One
# organisation slug rule, 5-20 characters, for organisation creation and the owner-claim bootstrap
# alike (the organisation slug is the realm name, register B1); tenants keep a separate DNS-label
# rule of 3-32 (register TENANT-SLUG). The contract carries both from 0.11.0; `slug_rule` measures it.
ORGANISATION_SLUG_RULE = (5, 20)
TENANT_SLUG_RULE = (3, 32)
ORGANISATION_SLUG_SCHEMAS = (
    "OrganisationCreateRequest",
    "Organisation",
    "OrganisationSummary",
    "OrganisationBootstrap",
    "RealmDiscoveryRequest",
)
TENANT_SLUG_SCHEMAS = ("Tenant", "OrderRequest.tenant")

CATALOGUE_PATH = re.compile(r"^/(catalog|catalogue|legal-documents|offers)(/|$)")
CATALOGUE_WORD = re.compile(r"(?i)catalog|legal.?document|offer|plan|price|pack|capacity.?tier")
CATALOGUE_MODEL = re.compile(r"^(Catalog|Offer|Plan|Price|Pack|CapacityTier|LegalDocument)")


# ---------------------------------------------------------------------------------- gaps ----


class ScenarioGapError(Exception):
    """The first thing a scenario reached that this tree does not have. Never a product verdict."""

    def __init__(self, gap: str, detail: str) -> None:
        if GAP_PATTERN.fullmatch(gap) is None:
            raise ValueError(f"malformed gap name: {gap!r}")
        super().__init__(f"{gap}: {detail}")
        self.gap = gap
        self.detail = detail


class MissingBehaviourError(ScenarioGapError):
    """Specified behaviour, or a harness seam it needs, is absent."""


class BlockedOnDecisionError(ScenarioGapError):
    """The scenario reached a decision the inventory records as open."""

    def __init__(self, decision: str, detail: str) -> None:
        super().__init__(f"decision:{decision}", detail)
        self.decision = decision


class ExternalConnectionError(AssertionError):
    """A scenario tried to reach a non-loopback address. A failure, never a gap."""


class InventoryError(Exception):
    """The inventory itself is malformed; the run cannot say which scenarios exist."""


class SelectionError(Exception):
    """A selector named no mandatory scenario."""


# ----------------------------------------------------------------------------- inventory ----


@dataclass(frozen=True)
class Decision:
    key: str
    title: str
    source: str
    status: str


@dataclass(frozen=True)
class ScenarioRow:
    id: str
    group: str
    state: str
    gap: str | None
    reason: str | None


@dataclass(frozen=True)
class Inventory:
    transcribed_from: str
    required_count: int
    decisions: dict[str, Decision]
    rows: tuple[ScenarioRow, ...]

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(row.id for row in self.rows)

    def row(self, scenario_id: str) -> ScenarioRow:
        for row in self.rows:
            if row.id == scenario_id:
                return row
        raise KeyError(scenario_id)


def load_inventory(raw: str) -> Inventory:
    """Parse and validate the inventory. Every refusal names the row or decision it is about."""
    try:
        data = tomllib.loads(raw)
    except tomllib.TOMLDecodeError as error:
        raise InventoryError(f"the inventory is not valid TOML: {error}") from None
    if set(data) != {"format", "transcribed_from", "required_count", "decision", "scenario"}:
        raise InventoryError(f"the inventory has unexpected top-level keys: {sorted(data)}")
    if data["format"] != 1:
        raise InventoryError("the inventory format must be 1")
    if not isinstance(data["transcribed_from"], str) or not data["transcribed_from"].strip():
        raise InventoryError("the inventory must say where its identifiers were transcribed from")
    if type(data["required_count"]) is not int:
        raise InventoryError("required_count must be an integer")
    decisions: dict[str, Decision] = {}
    for key, table in data["decision"].items():
        if not isinstance(table, dict) or set(table) != {"title", "source", "status"}:
            raise InventoryError(f"decision {key} must carry exactly title, source and status")
        if table["status"] not in DECISION_STATUSES:
            raise InventoryError(f"decision {key} has status {table['status']!r}")
        decisions[key] = Decision(key, table["title"], table["source"], table["status"])
    rows: list[ScenarioRow] = []
    seen: set[str] = set()
    for entry in data["scenario"]:
        scenario_id = entry.get("id") if isinstance(entry, dict) else None
        if not isinstance(scenario_id, str) or ID_PATTERN.fullmatch(scenario_id) is None:
            raise InventoryError(f"inventory row {scenario_id!r} has a malformed identifier")
        if scenario_id in seen:
            raise InventoryError(f"{scenario_id} appears more than once in the inventory")
        seen.add(scenario_id)
        state = entry.get("state")
        if state not in STATES:
            raise InventoryError(f"{scenario_id} has state {state!r}; expected one of {STATES}")
        expected = {"id", "group", "state"} | ({"gap", "reason"} if state != "pass" else set())
        if set(entry) != expected:
            raise InventoryError(f"{scenario_id} ({state}) must carry exactly {sorted(expected)}")
        gap = entry.get("gap")
        if state != "pass":
            if not isinstance(gap, str) or GAP_PATTERN.fullmatch(gap) is None:
                raise InventoryError(f"{scenario_id} has a malformed gap {gap!r}")
            if not isinstance(entry["reason"], str) or not entry["reason"].strip():
                raise InventoryError(f"{scenario_id} must say why it is {state}")
            if gap.startswith("decision:"):
                key = gap.removeprefix("decision:")
                if key not in decisions:
                    raise InventoryError(f"{scenario_id} names decision {key}, which is not listed")
                if decisions[key].status != "open":
                    raise InventoryError(
                        f"{scenario_id} is red on decision {key}, which the inventory records "
                        "as decided"
                    )
            elif state == "blocked":
                raise InventoryError(f"{scenario_id} is blocked but its gap names no decision")
        rows.append(ScenarioRow(scenario_id, entry["group"], state, gap, entry.get("reason")))
    if len(rows) != data["required_count"]:
        raise InventoryError(
            f"the inventory holds {len(rows)} scenarios; ACCEPTANCE.md requires "
            f"{data['required_count']}"
        )
    return Inventory(data["transcribed_from"], data["required_count"], decisions, tuple(rows))


def manifest_ids(path: Path = MANIFEST_PATH) -> tuple[str, ...]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return tuple(row["id"] for row in data["scenarios"])


def population_problems(
    *,
    inventory_ids: Sequence[str],
    collected: Sequence[str],
    manifest: Sequence[str],
    malformed: Sequence[str] = (),
    unmarked: Sequence[str] = (),
    required_count: int,
) -> list[str]:
    """Every way the collected scenario set can disagree with the inventory, each by name."""
    problems = [f"{nodeid} carries a malformed scenario identifier" for nodeid in malformed]
    problems += [
        f"{nodeid} is a scenario-file test with no scenario identifier" for nodeid in unmarked
    ]
    for scenario_id in inventory_ids:
        if scenario_id not in collected:
            problems.append(f"{scenario_id} is in the inventory but no collected test carries it")
    for scenario_id in sorted(set(collected)):
        if scenario_id not in inventory_ids:
            problems.append(f"{scenario_id} is collected but absent from the inventory")
        if collected.count(scenario_id) > 1:
            problems.append(
                f"{scenario_id} is collected by {collected.count(scenario_id)} tests; "
                "a scenario is exactly one test"
            )
    for scenario_id in manifest:
        if scenario_id not in inventory_ids:
            problems.append(
                f"{scenario_id} is in dev/first_slice_manifest.json but not the inventory"
            )
    for scenario_id in inventory_ids:
        if scenario_id not in manifest:
            problems.append(
                f"{scenario_id} is in the inventory but not dev/first_slice_manifest.json"
            )
    if len(inventory_ids) != required_count:
        problems.append(
            f"the inventory holds {len(inventory_ids)} scenarios; it requires {required_count}"
        )
    return problems


def incomplete_population(
    inventory_ids: Sequence[str], results: Collection[str], deselected: Collection[str]
) -> str | None:
    """The message that fails a population run in which some mandatory scenario has no result."""
    missing = [scenario_id for scenario_id in inventory_ids if scenario_id not in results]
    if not missing:
        return None
    parts = []
    dropped = [scenario_id for scenario_id in missing if scenario_id in deselected]
    if dropped:
        parts.append("deselected " + ", ".join(dropped))
    never = [scenario_id for scenario_id in missing if scenario_id not in deselected]
    if never:
        parts.append("never collected or never run " + ", ".join(never))
    return (
        "first-slice population incomplete: "
        + "; ".join(parts)
        + ". Every mandatory scenario must run; FIRST_SLICE_CASE runs exactly one."
    )


def select_case(value: str | None, known: Collection[str]) -> str | None:
    """`FIRST_SLICE_CASE`: one named scenario, or refuse. The refusal never echoes the input."""
    if value is None or value == "":
        return None
    if value not in known:
        raise SelectionError("FIRST_SLICE_CASE names no mandatory first-slice scenario")
    return value


def verdict(
    row: ScenarioRow, *, outcome: str, wasxfail: bool, exc: BaseException | None, xpass: bool
) -> tuple[str, str | None]:
    """The honest label of one scenario report, and the failure message that replaces it if any.

    `outcome` is pytest's report outcome after its own xfail handling. A skip is refused, an
    expected failure is accepted only for the gap the inventory records, and an unexpected pass
    stays the failure strict xfail already made it.
    """
    if outcome == "skipped" and not wasxfail:
        return "failed", (
            f"{row.id} was skipped; a mandatory first-slice scenario may not skip "
            "(ACCEPTANCE.md: a prohibited skip is a failure)"
        )
    if wasxfail:
        observed = getattr(exc, "gap", None)
        if observed != row.gap:
            return "failed", (
                f"{row.id} is red for a reason the inventory does not record: expected gap "
                f"{row.gap!r}, observed {observed!r}"
                + (f" ({exc.detail})" if isinstance(exc, ScenarioGapError) else "")
            )
        return ("blocked" if row.state == "blocked" else "xfail"), None
    if outcome == "failed":
        return ("passed unexpectedly" if xpass else "failed"), None
    return "passed", None


def failure_summary(exc: BaseException | None) -> str:
    """What actually failed, for the run summary: never the gap the inventory hoped for."""
    if exc is None:
        return ""
    if isinstance(exc, ScenarioGapError):
        return f"{exc.gap}: {exc.detail}"
    first = str(exc).strip().splitlines()[0] if str(exc).strip() else ""
    return f"{type(exc).__name__}: {first}"[:200]


# ------------------------------------------------------------------------ child runners ----


def child_environment(extra: Mapping[str, str]) -> dict[str, str]:
    """The parent's environment for a child pytest, minus what would couple the two runs."""
    dropped = ("COV_CORE_", "COVERAGE_", "PYTEST_", "FIRST_SLICE_")
    environment = {key: value for key, value in os.environ.items() if not key.startswith(dropped)}
    environment.update(extra)
    return environment


def disposable_copy(destination: Path) -> Path:
    shutil.copytree(ROOT, destination, ignore=shutil.ignore_patterns(*COPY_IGNORED))
    return destination


@dataclass(frozen=True)
class RunnerResult:
    name: str
    status: int
    output: str


def run_runners(
    root: Path, runs: Mapping[str, Mapping[str, str]], arguments: Sequence[str]
) -> dict[str, RunnerResult]:
    """Run the first-slice runner once per environment, concurrently, in a disposable copy.

    Each child runs without a test database: what these runs prove is refusal before any scenario
    reports, and a child that reached the database would fail on pytest-django's access guard.
    """

    def one(name: str, extra: Mapping[str, str]) -> RunnerResult:
        # A fixed interpreter running pytest on a disposable copy of this repository.
        result = subprocess.run(  # noqa: S603
            [sys.executable, "-m", "pytest", "-p", "no:cacheprovider", *arguments],
            cwd=root,
            env=child_environment({"FIRST_SLICE_NO_DATABASE": "1", **extra}),
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        return RunnerResult(name, result.returncode, result.stdout + result.stderr)

    with ThreadPoolExecutor(max_workers=max(1, min(len(runs), os.cpu_count() or 2))) as pool:
        futures = {name: pool.submit(one, name, extra) for name, extra in runs.items()}
        return {name: future.result() for name, future in futures.items()}


def collect_population(directory: Path, *, cwd: Path = ROOT) -> dict[str, Any]:
    """Collect, never run, the scenario directory in a child pytest and read what it collected."""
    with tempfile.TemporaryDirectory(prefix="first-slice-collection-") as temporary:
        report = Path(temporary) / "collected.json"
        # A fixed interpreter running pytest on a directory of this repository; no caller input.
        result = subprocess.run(  # noqa: S603
            [
                sys.executable,
                "-m",
                "pytest",
                "--collect-only",
                "-q",
                "-p",
                "no:cacheprovider",
                str(directory),
            ],
            cwd=cwd,
            env=child_environment({"FIRST_SLICE_COLLECTION_REPORT": str(report)}),
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
        if result.returncode != 0 or not report.is_file():
            tail = (result.stdout + result.stderr)[-4000:]
            raise AssertionError(
                f"collecting {directory} exited {result.returncode} without a report:\n{tail}"
            )
        return json.loads(report.read_text(encoding="utf-8"))


# ------------------------------------------------------------------------------ admission ----


def is_local_host(host: str | None) -> bool:
    """Loopback, or a reserved name that cannot resolve to a live provider."""
    if not host:
        return False
    name = host.strip("[]").lower()
    if name in {"localhost", "ip6-localhost"} or name.endswith(LOCAL_SUFFIXES):
        return True
    try:
        return ipaddress.ip_address(name.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def is_loopback_host(host: str | None) -> bool:
    if not host:
        return False
    name = host.strip("[]").lower()
    if name in {"localhost", "ip6-localhost"}:
        return True
    try:
        return ipaddress.ip_address(name.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def _host_of(value: str) -> str | None:
    if "://" in value:
        return urlsplit(value).hostname
    return value.split("/", 1)[0].rsplit(":", 1)[0] or None


def trust_issuers(raw: str) -> list[str]:
    entries = json.loads(raw)
    if not isinstance(entries, list):
        raise ValueError("trust configuration is not a list")
    return [str(entry.get("issuer", "")) for entry in entries if isinstance(entry, dict)]


def database_endpoint(environ: Mapping[str, str]) -> tuple[str, int]:
    parsed = urlsplit(environ.get("DATABASE_URL", DEFAULT_DATABASE_URL))
    return parsed.hostname or "localhost", parsed.port or 5432


def admission_refusals(environ: Mapping[str, str]) -> list[str]:
    """Every reason this environment may not run first-slice acceptance, each by name.

    A configured provider endpoint or identity issuer that is not local, and a PostgreSQL that does
    not accept connections, refuse the run before any scenario reports. Hosts are named; values,
    which may carry credentials, never are.
    """
    refusals = []
    for name in sorted(environ):
        parts = set(name.upper().split("_"))
        if parts & PROVIDER_WORDS and parts & ENDPOINT_WORDS:
            host = _host_of(environ[name])
            if not is_local_host(host):
                refusals.append(
                    f"an external provider endpoint is configured: {name} names "
                    f"{host or 'an unparseable host'}"
                )
    raw = environ.get("KODERA_AUTH_TRUST")
    if raw:
        try:
            issuers = trust_issuers(raw)
        except ValueError:
            refusals.append("KODERA_AUTH_TRUST is not a parseable trust list")
            issuers = []
        for issuer in issuers:
            host = urlsplit(issuer).hostname
            if not is_local_host(host):
                refusals.append(f"a public identity issuer is configured: {host}")
    host, port = database_endpoint(environ)
    try:
        with socket.create_connection((host, port), timeout=2):
            pass
    except OSError:
        refusals.append(
            f"a dependency is unavailable: PostgreSQL at {host}:{port} does not accept connections"
        )
    return refusals


# ------------------------------------------------------------------------ measured seams ----


def contract_operations(contract: Mapping[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    operations = []
    for path, item in (contract.get("paths") or {}).items():
        if not isinstance(item, dict):
            continue
        for method, operation in item.items():
            if isinstance(operation, dict) and "responses" in operation:
                operations.append((method.lower(), str(path), operation))
    return operations


def contract_write_operations(contract: Mapping[str, Any], pattern: str) -> list[str]:
    found = []
    for method, path, operation in contract_operations(contract):
        if method in READ_METHODS:
            continue
        operation_id = str(operation.get("operationId", ""))
        if re.search(pattern, f"{operation_id} {path}", re.IGNORECASE):
            found.append(f"{method.upper()} {path} ({operation_id or 'no operationId'})")
    return found


def catalogue_write_surface(contract: Mapping[str, Any], model_names: Sequence[str]) -> list[str]:
    """Any non-read operation on catalogue, offer or legal-document resources, and any such model."""
    found = []
    for method, path, operation in contract_operations(contract):
        if method in READ_METHODS:
            continue
        operation_id = str(operation.get("operationId", ""))
        tags = " ".join(str(tag) for tag in operation.get("tags") or [])
        if (
            CATALOGUE_PATH.match(path)
            or CATALOGUE_WORD.search(operation_id)
            or CATALOGUE_WORD.search(tags)
        ):
            found.append(f"{method.upper()} {path} ({operation_id or 'no operationId'})")
    found += [f"model {name}" for name in model_names if CATALOGUE_MODEL.match(name)]
    return found


def contract_slug_patterns(contract: Mapping[str, Any], names: Sequence[str]) -> dict[str, str]:
    """The `slug` pattern of each named schema; `Parent.child` names a nested object property."""
    schemas = (contract.get("components") or {}).get("schemas") or {}
    found = {}
    for name in names:
        try:
            parent, *children = name.split(".")
            node = schemas[parent]
            for child in children:
                node = node["properties"][child]
            found[name] = str(node["properties"]["slug"]["pattern"])
        except (KeyError, TypeError):
            raise AssertionError(
                f"the contract no longer carries {name}.slug with a pattern: the slug-rule "
                "measurement must follow the schema before its gap can be trusted"
            ) from None
    return found


REALM_UPDATE_NAME = re.compile(
    r"realm.?(update|change|setting|sync)|(update|change|patch|sync)\w*realm|/realms?(/|$)",
    re.IGNORECASE,
)


def _resolve(contract: Mapping[str, Any], schema: Any) -> Any:
    """Follow local `$ref`s to the schema they name; anything else is returned as it is."""
    schemas = (contract.get("components") or {}).get("schemas") or {}
    seen = 0
    while isinstance(schema, dict) and isinstance(schema.get("$ref"), str) and seen < 20:
        schema = schemas.get(schema["$ref"].rsplit("/", 1)[-1])
        seen += 1
    return schema


def _admits(contract: Mapping[str, Any], schema: Any, value: str, depth: int = 0) -> bool:
    """Whether a value schema admits `value` through `enum` or `const`, or through any branch of
    its own `allOf`, `oneOf` or `anyOf`."""
    schema = _resolve(contract, schema)
    if not isinstance(schema, dict) or depth > 20:
        return False
    if value in (schema.get("enum") or []) or schema.get("const") == value:
        return True
    return any(
        _admits(contract, part, value, depth + 1)
        for branch in ("allOf", "oneOf", "anyOf")
        for part in schema.get(branch) or []
    )


def _kind_accepts(contract: Mapping[str, Any], schema: Any, kind: str, depth: int = 0) -> bool:
    """Whether a request schema's `kind` property, or any branch composing it, admits `kind`."""
    schema = _resolve(contract, schema)
    if not isinstance(schema, dict) or depth > 20:
        return False
    for branch in ("allOf", "oneOf", "anyOf"):
        if any(_kind_accepts(contract, part, kind, depth + 1) for part in schema.get(branch) or []):
            return True
    return _admits(contract, (schema.get("properties") or {}).get("kind"), kind)


def _query_kind_accepts(contract: Mapping[str, Any], parameters: Any, kind: str) -> bool:
    """Whether a query parameter named `kind`, inline or by `$ref`, admits `kind`."""
    declared = (contract.get("components") or {}).get("parameters") or {}
    for parameter in parameters or []:
        if isinstance(parameter, dict) and isinstance(parameter.get("$ref"), str):
            parameter = declared.get(parameter["$ref"].rsplit("/", 1)[-1])
        if (
            isinstance(parameter, dict)
            and parameter.get("in") == "query"
            and parameter.get("name") == "kind"
            and _admits(contract, parameter.get("schema"), kind)
        ):
            return True
    return False


def realm_update_request_surface(contract: Mapping[str, Any]) -> list[str]:
    """Any non-read operation that can request a `realm_update` job directly.

    Present when a request body's `kind`, or a `kind` query parameter of the operation or its path,
    admits `realm_update` (a widened `JobTriggerRequest.kind`, a `triggerOrganisationJob`), or when
    the operation is named for a realm change (`patchRealmSettings`, `syncRealm`, a `/realms/...`
    path). A free-form name such as `reconfigureRealm` is not recognised: a known limit.
    """
    found = []
    for method, path, operation in contract_operations(contract):
        if method in READ_METHODS:
            continue
        operation_id = str(operation.get("operationId", ""))
        content = ((operation.get("requestBody") or {}).get("content")) or {}
        by_kind = any(
            isinstance(media, dict) and _kind_accepts(contract, media.get("schema"), "realm_update")
            for media in content.values()
        )
        item = (contract.get("paths") or {}).get(path) or {}
        parameters = [*(item.get("parameters") or []), *(operation.get("parameters") or [])]
        by_query = _query_kind_accepts(contract, parameters, "realm_update")
        if by_kind or by_query or REALM_UPDATE_NAME.search(f"{operation_id} {path}"):
            found.append(f"{method.upper()} {path} ({operation_id or 'no operationId'})")
    return found


def slug_rule_disagreements(patterns: Mapping[str, str], minimum: int, maximum: int) -> list[str]:
    """Each pattern that refuses a boundary the rule admits, or admits one it refuses."""
    problems = []
    for name, pattern in patterns.items():
        expression = re.compile(pattern)
        for length, admitted in (
            (minimum - 1, False),
            (minimum, True),
            (maximum, True),
            (maximum + 1, False),
        ):
            accepted = expression.search("a" * length) is not None
            if accepted != admitted:
                verb = "accepts" if accepted else "refuses"
                problems.append(f"{name}.slug {verb} {length} characters")
    return problems


def installed_model_names() -> list[str]:
    from django.apps import apps

    return sorted(model.__name__ for model in apps.get_models())


def worker_steps_unbound() -> bool:
    """The worker's runner exists (G1.5-B); its production registry binds no kind's steps until
    G1.5-C, so the deployed worker claims no job (lane decision W4)."""
    from worker.registry import PRODUCTION

    return not PRODUCTION.kinds


def local_identity_issuers(environ: Mapping[str, str]) -> list[str]:
    raw = environ.get("KODERA_AUTH_TRUST")
    if not raw:
        return []
    try:
        issuers = trust_issuers(raw)
    except ValueError:
        return []
    return [issuer for issuer in issuers if is_loopback_host(urlsplit(issuer).hostname)]


# ------------------------------------------------------------------------------ decisions ----


class Decisions:
    def __init__(self, inventory: Inventory) -> None:
        self._inventory = inventory

    def require(self, key: str) -> Decision:
        if key not in self._inventory.decisions:
            raise AssertionError(f"a scenario names decision {key}, which the inventory lacks")
        decision = self._inventory.decisions[key]
        if decision.status == "open":
            raise BlockedOnDecisionError(key, f"{decision.title} is open ({decision.source})")
        return decision


# ---------------------------------------------------------------------------------- clock ----


class Clock:
    """`T0` plus controlled offsets. Nothing in a scenario waits on the wall clock."""

    def __init__(self) -> None:
        self._traveller: Any = None

    @contextmanager
    def frozen(self) -> Iterator["Clock"]:
        with time_machine.travel(T0, tick=False) as traveller:
            self._traveller = traveller
            try:
                yield self
            finally:
                self._traveller = None

    def now(self) -> datetime:
        return datetime.now(UTC)

    def advance(self, **offset: float) -> datetime:
        if self._traveller is None:
            raise AssertionError("the harness clock is not frozen")
        self._traveller.shift(timedelta(**offset))
        return self.now()

    def move_to(self, instant: datetime) -> datetime:
        if self._traveller is None:
            raise AssertionError("the harness clock is not frozen")
        self._traveller.move_to(instant)
        return self.now()


# ----------------------------------------------------------------------------- egress ----


def is_loopback(address: Any) -> bool:
    if isinstance(address, str | bytes):
        return True  # AF_UNIX path
    host = address[0]
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    return is_loopback_host(str(host))  # a name other than localhost is never resolved


@contextmanager
def egress_guard(refused: list[str]) -> Iterator[None]:
    """Refuse every Python-level connection to a non-loopback address, before any packet."""
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex

    def check(address: Any) -> None:
        if not is_loopback(address):
            refused.append(repr(address))
            raise ExternalConnectionError(
                f"an unexpected external connection to {address!r} was attempted; the first "
                "slice admits declared local services only"
            )

    def connect(sock: socket.socket, address: Any) -> None:
        check(address)
        original_connect(sock, address)

    def connect_ex(sock: socket.socket, address: Any) -> int:
        check(address)
        return original_connect_ex(sock, address)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(socket.socket, "connect", connect)
        patch.setattr(socket.socket, "connect_ex", connect_ex)
        yield


# ------------------------------------------------------------------------------ identity ----

_SIGNING_KEY: list[rsa.RSAPrivateKey] = []
_STRANGER_KEY: list[rsa.RSAPrivateKey] = []
_CONTRACT: list[dict[str, Any]] = []


def signing_key() -> rsa.RSAPrivateKey:
    if not _SIGNING_KEY:
        _SIGNING_KEY.append(rsa.generate_private_key(public_exponent=65537, key_size=2048))
    return _SIGNING_KEY[0]


def stranger_key() -> rsa.RSAPrivateKey:
    """A key no trust entry names, generated once per process like the signing key."""
    if not _STRANGER_KEY:
        _STRANGER_KEY.append(rsa.generate_private_key(public_exponent=65537, key_size=2048))
    return _STRANGER_KEY[0]


def committed_contract() -> dict[str, Any]:
    """The contract as committed, parsed once per process: it does not change during a run, and
    parsing it again for every scenario was most of each scenario's setup time."""
    if not _CONTRACT:
        _CONTRACT.append(load_contract(ROOT))
    return _CONTRACT[0]


def public_jwk(kid: str) -> dict[str, Any]:
    public: dict[str, Any] = json.loads(
        jwt.algorithms.RSAAlgorithm.to_jwk(signing_key().public_key())
    )
    public.update(kid=kid, alg="RS256", use="sig", key_ops=["verify"])
    return public


@dataclass(frozen=True)
class Principal:
    lane: str
    issuer: str
    subject: str
    email: str
    trusted: bool = True


class SignedIdentityFixture:
    """Real signatures verified by the production verifier; not identity provider software.

    It can sign any claim, which is exactly why it must never sign a second factor: `amr`, `acr`
    and `auth_time` are left out of every token it mints, and `with_second_factor` refuses.
    """

    def __init__(self, settings: Any, namespace: str, decisions: Decisions) -> None:
        self._settings = settings
        self._namespace = namespace
        self._decisions = decisions
        self._kid = f"first-slice-{namespace}"
        self._public = public_jwk(self._kid)
        self._entries: list[dict[str, Any]] = []

    def issuer(self, realm: str) -> str:
        return f"{IDENTITY_HOST}/realms/{realm}"

    def _trust(self, issuer: str, lane: str) -> None:
        from services.identity.trusted_issuers import load_trust

        if any(entry["issuer"] == issuer for entry in self._entries):
            return
        self._entries.append(
            {
                "lane": lane,
                "issuer": issuer,
                "generation": self._kid,
                "expires_at": int(T0.timestamp()) + 365 * 86400,
                "public_jwks": {"keys": [self._public]},
            }
        )
        self._settings.KODERA_AUTH_TRUST = load_trust(json.dumps(self._entries))

    def staff(self, label: str) -> Principal:
        issuer = self.issuer("kodera-staff")
        self._trust(issuer, "staff")
        # The one staff issuer of the settings is the one on the staff lane (STAFF_IDENTITY.md §1).
        self._settings.KODERA_STAFF_ISSUER = issuer
        return Principal(
            "staff", issuer, f"{self._namespace}-staff-{label}", f"{label}@staff.{SYNTHETIC_DOMAIN}"
        )

    def customer(
        self, realm: str, label: str, *, subject: str | None = None, email: str | None = None
    ) -> Principal:
        issuer = self.issuer(realm)
        self._trust(issuer, "customer")
        return Principal(
            "customer",
            issuer,
            subject or f"{self._namespace}-{label}",
            email or f"{label}@{realm}.{SYNTHETIC_DOMAIN}",
        )

    def untrusted(self, realm: str, label: str) -> Principal:
        """A well-formed token from an issuer Core was never told about."""
        return Principal(
            "customer",
            self.issuer(realm + "-unknown"),
            f"{self._namespace}-{label}",
            f"{label}@{realm}.{SYNTHETIC_DOMAIN}",
            trusted=False,
        )

    def bearer(self, principal: Principal) -> str:
        now = int(datetime.now(UTC).timestamp())
        claims = {
            "iss": principal.issuer,
            "sub": principal.subject,
            "aud": "kodera-server",
            "iat": now,
            "exp": now + 300,
            "typ": "Bearer",
            # The web console's client: the customer lane admits only its allowed clients.
            "azp": "console",
            "email": principal.email,
            "email_verified": True,
        }
        key = signing_key() if principal.trusted else stranger_key()
        return jwt.encode(claims, key, algorithm="RS256", headers={"kid": self._kid})

    def with_second_factor(self, principal: Principal) -> Principal:
        """Second-factor evidence must come from real identity provider software, never from here."""
        self._decisions.require("mfa-contact-proof-and-claim-delivery")
        raise MissingBehaviourError(
            "harness:identity-provider-second-factor",
            "no local identity provider that requires and issues a second factor is admitted to "
            "this environment, and the signed fixture must not mint one",
        )


# ------------------------------------------------------------------------------ adapters ----


@dataclass(frozen=True)
class Effect:
    adapter: str
    action: str
    correlation: str
    reference: str
    payload_sha256: str
    sequence: int


class InjectedFailureError(Exception):
    """Injected before the effect: nothing happened at the provider."""


class NonRetryableFailureError(Exception):
    """Injected before the effect, as a refusal no retry changes: nothing happened at the provider,
    and the caller must fail the step rather than try it again. A fault model, not product logic."""


class LostResponseError(Exception):
    """Injected after the effect: it happened, and the caller cannot know."""


class CapabilityUnavailableError(Exception):
    """The adapter was configured without this capability, as a real provider may be."""


class BarrierTimeoutError(AssertionError):
    """A barrier was never released; the scenario is wrong, not the product."""


@dataclass
class Hold:
    reached: threading.Event = field(default_factory=threading.Event)
    released: threading.Event = field(default_factory=threading.Event)

    def wait_reached(self, timeout: float = BARRIER_SECONDS) -> bool:
        return self.reached.wait(timeout)

    def release(self) -> None:
        self.released.set()


def digest(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(raw).hexdigest()


class SyntheticAdapter:
    """One external provider, locally controlled. It records every effect and deduplicates none:
    deduplication is Core's job, and a ledger that hid a second effect would hide Core's defect."""

    def __init__(self, name: str, *, prefix: str) -> None:
        self.name = name
        self._prefix = prefix
        self._lock = threading.Lock()
        self._ledger: list[Effect] = []
        self._holds: dict[str, Hold] = {}
        self._faults: dict[tuple[str, str | None], list[type[Exception]]] = {}
        self._numbers = itertools.count(1)
        self.capabilities = {"lookup"}

    def hold(self, point: str) -> Hold:
        self._holds[point] = hold = Hold()
        return hold

    def inject(
        self,
        point: str,
        failure: type[Exception],
        *,
        times: int = 1,
        correlation: str | None = None,
    ) -> None:
        """Queue `failure` at `point`: for one correlation only when it is named, else for the next
        calls whatever their correlation. A targeted failure is taken before an untargeted one."""
        with self._lock:
            self._faults.setdefault((point, correlation), []).extend([failure] * times)

    def without(self, capability: str) -> None:
        self.capabilities.discard(capability)

    def _checkpoint(self, point: str, correlation: str) -> None:
        hold = self._holds.get(point)
        if hold is not None:
            hold.reached.set()
            if not hold.released.wait(BARRIER_SECONDS):
                raise BarrierTimeoutError(f"{self.name} barrier {point} was never released")
        with self._lock:
            queue = self._faults.get((point, correlation)) or self._faults.get((point, None)) or []
            failure = queue.pop(0) if queue else None
        if failure is not None:
            raise failure(f"{self.name} {point} injected for correlation {correlation}")

    def perform(self, action: str, correlation: str, payload: Any) -> Effect:
        self._checkpoint("before-effect", correlation)
        with self._lock:
            effect = Effect(
                self.name,
                action,
                correlation,
                f"{self._prefix}-{next(self._numbers):06d}",
                digest(payload),
                len(self._ledger) + 1,
            )
            self._ledger.append(effect)
        self._checkpoint("after-effect", correlation)
        return effect

    def lookup(self, correlation: str) -> tuple[Effect, ...]:
        if "lookup" not in self.capabilities:
            raise CapabilityUnavailableError(f"{self.name} cannot look up by correlation")
        with self._lock:
            return tuple(effect for effect in self._ledger if effect.correlation == correlation)

    def effects(self, action: str | None = None) -> tuple[Effect, ...]:
        with self._lock:
            return tuple(e for e in self._ledger if action is None or e.action == action)


class InvoiceAdapter(SyntheticAdapter):
    """The authoritative issuer: the provider number is the invoice number."""

    def __init__(self) -> None:
        super().__init__("invoice", prefix="SYN-INV")

    def issue(self, correlation: str, payload: Any) -> Effect:
        return self.perform("issue", correlation, payload)


class InfrastructureAdapter(SyntheticAdapter):
    OUTCOMES = ("absent", "complete", "running", "unresolvable")

    def __init__(self) -> None:
        super().__init__("infrastructure", prefix="SYN-PRJ")
        self._outcomes: dict[str, str] = {}

    def provision(self, correlation: str, payload: Any) -> Effect:
        return self.perform("provision", correlation, payload)

    def destroy(self, correlation: str, payload: Any) -> Effect:
        return self.perform("destroy", correlation, payload)

    def set_outcome(self, correlation: str, outcome: str) -> None:
        if outcome not in self.OUTCOMES:
            raise ValueError(outcome)
        self._outcomes[correlation] = outcome

    def outcome(self, correlation: str) -> str:
        if correlation in self._outcomes:
            return self._outcomes[correlation]
        return "complete" if self.lookup(correlation) else "absent"


@dataclass(frozen=True)
class SignedEvent:
    body: bytes
    signature: str
    event_id: str


class PaymentAdapter(SyntheticAdapter):
    def __init__(self) -> None:
        super().__init__("payment", prefix="SYN-PAY")
        self.account = "acct_synthetic_" + secrets.token_hex(4)
        self._secret = secrets.token_bytes(32)

    def event(
        self,
        *,
        reference: str,
        amount_cents: int,
        currency: str = "EUR",
        kind: str = "payment.succeeded",
        account: str | None = None,
        event_id: str | None = None,
        valid_signature: bool = True,
    ) -> SignedEvent:
        identifier = event_id or "evt_" + secrets.token_hex(8)
        body = json.dumps(
            {
                "id": identifier,
                "type": kind,
                "account": account or self.account,
                "reference": reference,
                "amount_cents": amount_cents,
                "currency": currency,
            },
            sort_keys=True,
        ).encode()
        key = self._secret if valid_signature else secrets.token_bytes(32)
        signature = hmac.new(key, body, hashlib.sha256).hexdigest()
        self.perform("emit", identifier, {"sha256": hashlib.sha256(body).hexdigest()})
        return SignedEvent(body, signature, identifier)

    def verify(self, body: bytes, signature: str) -> bool:
        expected = hmac.new(self._secret, body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)

    def secret_hex(self) -> str:
        """For asserting the signing secret is stored nowhere; never for a report."""
        return self._secret.hex()


@dataclass(frozen=True)
class Message:
    to: str
    subject: str
    body: str


class MailAdapter(SyntheticAdapter):
    """Delivered messages stay in memory for the scenario; the ledger holds digests only."""

    TOKEN = re.compile(r"own_[A-Za-z0-9_-]{43,}")

    def __init__(self) -> None:
        super().__init__("mail", prefix="SYN-MSG")
        self._messages: list[Message] = []

    def deliver(self, to: str, subject: str, body: str) -> Effect:
        effect = self.perform("deliver", to, {"subject": subject, "sha256": digest(body)})
        with self._lock:
            self._messages.append(Message(to, subject, body))
        return effect

    def take(self, to: str) -> Message:
        with self._lock:
            for index in range(len(self._messages) - 1, -1, -1):
                if self._messages[index].to == to:
                    return self._messages.pop(index)
        raise AssertionError(f"no message was delivered to {to}")

    def redacted(self) -> list[dict[str, str]]:
        with self._lock:
            return [
                {"to": m.to, "subject": m.subject, "sha256": digest(m.body)} for m in self._messages
            ]


class AdapterSet:
    def __init__(self) -> None:
        self.invoice = InvoiceAdapter()
        self.infrastructure = InfrastructureAdapter()
        self.payment = PaymentAdapter()
        self.mail = MailAdapter()

    def require_bound(self, name: str) -> SyntheticAdapter:
        """Asserted, not measured: Core declares no adapter port to look for yet."""
        raise MissingBehaviourError(
            f"adapter:{name}",
            f"Core declares no {name} adapter port the harness can bind its synthetic {name} "
            "provider to",
        )

    def claim_token(self, email: str) -> str:
        self.require_bound("mail")
        match = MailAdapter.TOKEN.search(self.mail.take(email).body)
        if match is None:
            raise AssertionError(f"the message delivered to {email} carries no owner claim token")
        return match.group(0)


# -------------------------------------------------------------------------------- worker ----


class Worker:
    """The worker, measured against the tree: its runner claims, renews, sweeps and reaps (G1.5-B),
    and its production registry binds no kind's steps before G1.5-C. A claim and a sweep are the
    queue's own; running a job waits for the bindings."""

    def _unbound(self, what: str) -> MissingBehaviourError:
        if not worker_steps_unbound():
            raise AssertionError(
                "the worker's production registry serves a kind: wire first_slice_harness.Worker "
                "to the runner before trusting a worker gap"
            )
        return MissingBehaviourError(
            "worker:step-bindings", f"the worker binds no job kind's steps yet, so it cannot {what}"
        )

    def run_until_idle(self) -> None:
        raise self._unbound("claim and run queued jobs")

    def claim(self, job_id: str) -> Any:
        from apps.jobs.services import claim_job

        return claim_job(runner_id="first-slice-harness", job_id=uuid.UUID(job_id))

    def sweep(self) -> None:
        from apps.jobs.services import sweep_expired_leases

        sweep_expired_leases()

    def restart_dispatcher(self) -> None:
        # Asserted, not measured: lane decision W5 keeps run_realm_deliveries an external one-shot
        # until the scheduler lands, and the worker does not reimplement it.
        raise MissingBehaviourError(
            "worker:outbox-dispatcher",
            "the outbox dispatcher is an external one-shot until the scheduler lands (W5)",
        )

    def reaped(self, job_id: str) -> bool:
        raise self._unbound(f"report whether job {job_id}'s owned subprocess was reaped")


# ---------------------------------------------------------------------------------- API ----


class CoreApi:
    """Core's real API, in process: the real URL resolver, middleware and views. Never a stub."""

    def __init__(self, identities: SignedIdentityFixture) -> None:
        self.contract = committed_contract()
        self._identities = identities

    def operation(self, operation_id: str) -> dict[str, Any]:
        return reviewed_operation(self.contract, operation_id)

    def url(self, operation_id: str, **parameters: str) -> str:
        operation = self.operation(operation_id)
        names = re.findall(r"{([a-z_]+)}", operation["path"])
        filled = {
            name: parameters.get(name, "00000000-0000-4000-8000-000000000000") for name in names
        }
        return local_url(operation, **filled)

    def require(self, *operation_ids: str) -> None:
        """Measure that each operation is routed. The first that is not is the gap."""
        from django.conf import settings
        from django.urls import Resolver404, resolve

        for operation_id in operation_ids:
            operation = self.operation(operation_id)
            url = self.url(operation_id)
            try:
                resolve(url)
            except Resolver404:
                raise MissingBehaviourError(
                    f"operation:{operation_id}",
                    f"{operation['method']} {url} resolves to no view under the real "
                    f"ROOT_URLCONF {settings.ROOT_URLCONF}",
                ) from None

    def call(
        self,
        operation_id: str,
        *,
        principal: Principal | None = None,
        path: dict[str, str] | None = None,
        body: Any = None,
        raw: bytes | None = None,
        idempotency_key: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        self.require(operation_id)
        if principal is not None and principal.lane == "staff":
            # Asserted: Core re-asserts a second factor on every staff token (AUTHZ.md §3) and
            # answers one without it 403 mfa-required, before its body is read. This fixture never
            # mints one, so no staff request it signs can reach the operation's behaviour.
            raise MissingBehaviourError(
                "harness:identity-provider-second-factor",
                f"{operation_id} is routed, but a staff principal needs a second factor in amr, "
                "and no local identity provider that issues one is admitted to this environment",
            )
        operation = self.operation(operation_id)
        url = self.url(operation_id, **(path or {}))
        sent = dict(headers or {})
        sent.setdefault("host", "localhost")
        if principal is not None:
            sent["authorization"] = "Bearer " + self._identities.bearer(principal)
        if idempotency_key is not None:
            sent["idempotency-key"] = idempotency_key
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else b"")
        from django.test import Client

        # One client per request: scenarios race requests on threads, and a shared test client
        # carries cookies and signal receivers from one request into the next.
        response = Client(raise_request_exception=False).generic(
            operation["method"], url, data=data, content_type="application/json", headers=sent
        )
        if response.status_code == 405:
            raise MissingBehaviourError(
                f"operation:{operation_id}",
                f"{url} is routed but its view does not accept {operation['method']}",
            )
        return response


def problem_type(response: Any) -> str | None:
    try:
        kind = response.json().get("type", "")
    except (ValueError, AttributeError):
        return None
    return str(kind).rsplit("/", 1)[-1] or None


# ------------------------------------------------------------------------------ worlds ----


@dataclass(frozen=True)
class Catalogue:
    offer: dict[str, Any]


@dataclass(frozen=True)
class Intake:
    organisation_id: str
    slug: str
    key: str
    intended_owner_email: str
    bootstrap: dict[str, Any]


@dataclass(frozen=True)
class EmptyCustomer:
    staff: Principal
    catalogue: Catalogue


@dataclass(frozen=True)
class OwnerPending:
    staff: Principal
    intake: Intake
    owner: Principal
    token: str


@dataclass(frozen=True)
class ActiveOrganisation:
    staff: Principal
    intake: Intake
    owner: Principal
    token: str


@dataclass(frozen=True)
class Ordered:
    staff: Principal
    organisation: ActiveOrganisation
    order: dict[str, Any]
    tenant_id: str
    job: dict[str, Any]


@dataclass(frozen=True)
class SharedOrganisation:
    staff: Principal
    organisation: ActiveOrganisation
    tenants: tuple[str, str]


# ----------------------------------------------------------------------------- harness ----


class FirstSliceHarness:
    """The internal commands of FIRST_SLICE_SPEC.md and the fixtures of ACCEPTANCE.md."""

    def __init__(self, *, request: Any, settings: Any, inventory: Inventory) -> None:
        self._request = request
        self.inventory = inventory
        self.namespace = "f" + hashlib.sha256(request.node.nodeid.encode()).hexdigest()[:7]
        self.decisions = Decisions(inventory)
        self.clock = Clock()
        self.identities = SignedIdentityFixture(settings, self.namespace, self.decisions)
        self.api = CoreApi(self.identities)
        self.adapters = AdapterSet()
        self.worker = Worker()
        self.refused_connections: list[str] = []
        self._holds: dict[str, Hold] = {}

    @contextmanager
    def running(self) -> Iterator["FirstSliceHarness"]:
        from core import faults

        try:
            with self.clock.frozen(), egress_guard(self.refused_connections):
                yield self
        finally:
            left = faults.armed_points()
            faults.disarm_all()
        if left:
            raise AssertionError(f"the scenario left fault points armed: {', '.join(left)}")

    # -- naming, isolation, decisions ------------------------------------------------------

    def decision(self, key: str) -> Decision:
        return self.decisions.require(key)

    def slug(self, label: str) -> str:
        return f"{self.namespace}-{label}"[:20].rstrip("-")

    def key(self, label: str) -> str:
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{self.namespace}/{label}"))

    def email(self, local: str, label: str) -> str:
        return f"{local}@{self.slug(label)}.{SYNTHETIC_DOMAIN}"

    def example(self, name: str) -> dict[str, Any]:
        loaded: dict[str, Any] = json.loads(
            (ROOT / "contracts/examples" / name).read_text(encoding="utf-8")
        )
        return loaded

    def scratch(self, label: str) -> Path:
        factory = self._request.getfixturevalue("tmp_path_factory")
        return Path(factory.mktemp(f"{self.namespace}-{label}"))

    # -- records ---------------------------------------------------------------------------

    def db(self) -> None:
        """Real commits in the test database pytest-django created, flushed after each scenario.

        The conftest declares that database statically for every harness user. This refuses any
        other: the harness resets only what it owns, and fails before touching anything it does not.
        """
        from django.db import connection

        name = str(connection.settings_dict["NAME"])
        if not name.startswith("test_"):
            raise AssertionError(
                f"the harness refuses database {name!r}: only a test database pytest-django "
                "created for this run is harness-owned"
            )

    def model(self, name: str) -> Any:
        from django.apps import apps

        for model in apps.get_models():
            if model.__name__ == name:
                return model
        raise MissingBehaviourError(f"record:{name}", f"no installed model is named {name}")

    def count(self, name: str, **filters: Any) -> int:
        model = self.model(name)
        self.db()
        return int(model._base_manager.filter(**filters).count())

    def count_if_present(self, name: str, **filters: Any) -> int:
        """For fixture preconditions only: a model that does not exist holds no rows.

        Never in a postcondition. A negative postcondition must fail when its model is absent or
        named differently, and only `count` does that.
        """
        try:
            return self.count(name, **filters)
        except MissingBehaviourError:
            return 0

    def audit_actions(self, organisation_id: str) -> list[str]:
        model = self.model("AuditEvent")
        self.db()
        rows = model._base_manager.filter(organisation_id=organisation_id).order_by("id")
        return [str(action) for action in rows.values_list("action", flat=True)]

    @contextmanager
    def fault_point(self, name: str) -> Iterator[Hold | None]:
        """Arm Core's named fault point for the body: core/faults.py, recorded in fault_points.toml.

        Measured: a name the inventory records as planned, and Core does not declare, is the gap
        `harness:core-fault-points`; one Core declares while the inventory still plans it, or one
        the inventory does not record at all, is an AssertionError. A crash point swallows its own
        `SimulatedCrash` and nothing else; a hold point yields its `Hold`, which `race` releases
        once every racer not held there has returned. Leaving the body, the point must have been
        reached, and a crash point must have crashed out of Core: anything else is an
        AssertionError, while a gap or failure raised inside the body goes on unchanged.
        """
        from core import faults

        points = {str(row["name"]): row for row in FAULT_INVENTORY.get("point", [])}
        planned = [str(row["name"]) for row in FAULT_INVENTORY.get("planned", [])]
        if name not in points:
            if any(planned_matches(entry, name) for entry in planned):
                if name in faults.POINTS:
                    raise AssertionError(
                        f"Core now declares fault point {name}: record it under [[point]] in "
                        f"{FAULT_INVENTORY_PATH.name} before trusting gap harness:core-fault-points"
                    )
                raise MissingBehaviourError(
                    "harness:core-fault-points",
                    f"Core declares no fault point {name} that the harness can crash at",
                )
            raise AssertionError(
                f"{name} is not a fault point {FAULT_INVENTORY_PATH.name} records, as a point or "
                "as planned"
            )
        if name not in faults.POINTS:
            raise AssertionError(f"{FAULT_INVENTORY_PATH.name} records {name}; Core declares none")
        hold = Hold() if faults.POINTS[name].mode == "hold" else None
        faults.arm(name, hold=hold)
        if hold is not None:
            self._holds[name] = hold
        crashed = False
        try:
            yield hold
        except faults.SimulatedCrash as crash:
            if crash.point != name:
                raise AssertionError(
                    f"fault point {crash.point} crashed while {name} was the one armed here"
                ) from crash
            if hold is not None:
                # A hold crashes only when nobody released it: the race it served never ran.
                raise AssertionError(f"hold {name} timed out") from crash
            crashed = True
        finally:
            reached = faults.disarm(name)
            if hold is not None:
                hold.release()
                self._holds.pop(name, None)
        if reached == 0:
            raise AssertionError(f"fault point {name} was armed and never reached")
        if hold is None and not crashed:
            raise AssertionError(
                f"fault point {name} was reached, and its crash never left Core: something caught it"
            )

    @contextmanager
    def weakened(self, name: str) -> Iterator[None]:
        """Apply a required weakening to Core, in a disposable copy: one of ACCEPTANCE.md's minimum
        weakenings, or the one the lead's FS-CON-01 ruling adds.

        Asserted, not measured: there is no Core implementation to weaken yet. The body under this
        context is the counterexample, and it must fail for the asserted reason once there is.
        """
        if name not in REQUIRED_WEAKENINGS:
            raise AssertionError(
                f"{name} is not a required weakening (ACCEPTANCE.md's minimum weakenings and the "
                "lead's FS-CON-01 ruling)"
            )
        raise MissingBehaviourError(
            "harness:implementation-weakening",
            f"Core has no implementation to weaken for {name}",
        )
        yield  # pragma: no cover - unreachable until the seam exists

    def race(self, *actions: Callable[[], Any]) -> list[Any]:
        """Start every action at one barrier; re-raise the first gap or failure in order."""
        start = threading.Barrier(len(actions))
        results: list[Any] = [None] * len(actions)
        errors: list[BaseException | None] = [None] * len(actions)

        def run(index: int, action: Callable[[], Any]) -> None:
            from django.db import connections

            try:
                start.wait(BARRIER_SECONDS)
                results[index] = action()
            except BaseException as error:  # noqa: BLE001 - re-raised on the calling thread
                errors[index] = error
            finally:
                connections.close_all()

        threads = [threading.Thread(target=run, args=(i, a)) for i, a in enumerate(actions)]
        for thread in threads:
            thread.start()
        if self._holds:
            self._release_after_the_others(threads)
        for thread in threads:
            thread.join(BARRIER_SECONDS * 3)
        for error in errors:
            if error is not None:
                raise error
        return results

    def _release_after_the_others(self, threads: Sequence[threading.Thread]) -> None:
        """Release every armed hold once each racer not waiting at one has returned."""
        from core import faults

        deadline = time.monotonic() + BARRIER_SECONDS * 3
        while True:
            alive = sum(thread.is_alive() for thread in threads)
            held = sum(faults.hits(name) for name in self._holds)
            if alive == 0 or (held and alive <= held):
                break
            if time.monotonic() > deadline:
                for hold in self._holds.values():
                    hold.release()
                raise BarrierTimeoutError(
                    f"{alive} racers were still running and {held} held after "
                    f"{BARRIER_SECONDS * 3:.0f} s"
                )
            time.sleep(0.01)
        for hold in self._holds.values():
            hold.release()

    def _contract_absence(self, gap: str, pattern: str, what: str) -> MissingBehaviourError:
        present = contract_write_operations(self.api.contract, pattern)
        if present:
            raise AssertionError(
                f"{what} now exists in the contract ({', '.join(present)}): drive the harness "
                f"through it before trusting gap {gap}"
            )
        return MissingBehaviourError(gap, f"the contract carries no {what}")

    def slug_rule(self, kind: str) -> None:
        """Measured: every contract slug pattern of this kind implements the decided rule."""
        schemas: Sequence[str]
        minimum: int
        maximum: int
        if kind == "organisation":
            schemas, (minimum, maximum) = ORGANISATION_SLUG_SCHEMAS, ORGANISATION_SLUG_RULE
        elif kind == "tenant":
            schemas, (minimum, maximum) = TENANT_SLUG_SCHEMAS, TENANT_SLUG_RULE
        else:
            raise AssertionError(f"no decided slug rule for {kind}")
        patterns = contract_slug_patterns(self.api.contract, schemas)
        problems = slug_rule_disagreements(patterns, minimum, maximum)
        if problems:
            raise MissingBehaviourError(
                f"contract:{kind}-slug-rule-{minimum}-{maximum}",
                f"the contract does not carry the decided {minimum}-{maximum} {kind} slug rule: "
                + "; ".join(problems),
            )

    def reserved_organisation_slugs(self) -> tuple[str, ...]:
        """Measured: the reserved names the contract enumerates as `not: {enum: [...]}` on the slug."""
        slug = self.api.contract["components"]["schemas"]["OrganisationCreateRequest"][
            "properties"
        ]["slug"]
        reserved = (slug.get("not") or {}).get("enum")
        if not reserved:
            raise MissingBehaviourError(
                "contract:reserved-organisation-slugs",
                "OrganisationCreateRequest.slug enumerates no reserved name, and neither the owner "
                "decision on the slug rule nor the design of record names the list",
            )
        return tuple(str(name) for name in reserved)

    def admit_services(self) -> None:
        """Measure the dependencies a first-slice run needs; the first unavailable one is the gap."""
        refusals = admission_refusals(os.environ)
        if refusals:
            raise AssertionError("; ".join(refusals))
        self.identity_provider()

    def identity_provider(self) -> Any:
        """Measured: a running local identity provider is a loopback issuer in the trust list."""
        local = local_identity_issuers(os.environ)
        if local:
            raise AssertionError(
                f"KODERA_AUTH_TRUST admits a loopback identity provider ({', '.join(local)}): "
                "wire the harness to it before trusting harness:identity-provider-admission"
            )
        raise MissingBehaviourError(
            "harness:identity-provider-admission",
            "KODERA_AUTH_TRUST admits no loopback identity provider: the CI test job provides "
            "PostgreSQL only, and the signed identity fixture is not identity provider software",
        )

    def console(self) -> Any:
        """Asserted: what the application displays is another repository's."""
        raise MissingBehaviourError(
            "harness:console",
            "what the application displays is kodera-console's, which this repository cannot drive",
        )

    # -- the proposed internal commands ----------------------------------------------------

    def expect(self, response: Any, status: int, operation_id: str) -> Any:
        if response.status_code != status:
            raise AssertionError(
                f"{operation_id} answered {response.status_code} ({problem_type(response)}), "
                f"expected {status}"
            )
        return response.json() if response.content else None

    def expect_ok(self, response: Any, operation_id: str) -> Any:
        """For operations whose exact success status the contract leaves to the implementation."""
        if not 200 <= response.status_code < 300:
            raise AssertionError(
                f"{operation_id} answered {response.status_code} ({problem_type(response)})"
            )
        return response.json() if response.content else None

    def in_flight_reference(self, response: Any) -> str:
        """The stable operation reference carried by a complete or in-flight intake reply."""
        reference = response.headers.get("X-Operation-Ref")
        if isinstance(reference, str) and re.fullmatch(r"[0-9a-f]{64}", reference):
            return reference
        raise MissingBehaviourError(
            "contract:idempotency-key-in-flight-operation-reference",
            "the reply carries no valid 64-lowercase-hex X-Operation-Ref, so it cannot reference "
            "the durable operation FS-OP-01 requires",
        )

    def stored_anywhere(self, needle: str) -> list[str]:
        """Every text or JSON column of the public schema holding `needle`, as table.column."""
        from django.db import connection

        self.db()
        found: list[str] = []
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' "
                "AND data_type IN ('text', 'character varying', 'json', 'jsonb')"
            )
            for table, column in cursor.fetchall():
                # Identifiers come from the catalogue just read, never from a caller.
                cursor.execute(
                    f'SELECT 1 FROM "{table}" WHERE strpos("{column}"::text, %s) > 0 LIMIT 1',  # noqa: S608
                    [needle],
                )
                if cursor.fetchone():
                    found.append(f"{table}.{column}")
        return found

    def membership_id(self, principal: Principal, organisation_id: str) -> str:
        membership = self.model("Membership")._base_manager.get(
            organisation_id=organisation_id, user__identity__subject=principal.subject
        )
        return str(membership.pk)

    def add_member(self, active: "ActiveOrganisation", role: str, label: str) -> Principal:
        organisation_id = active.intake.organisation_id
        email = f"{label}@{active.intake.slug}.{SYNTHETIC_DOMAIN}"
        self.expect_ok(
            self.api.call(
                "inviteToOrganisation",
                principal=active.owner,
                path={"organisation_id": organisation_id},
                body={"email": email, "role": role},
                idempotency_key=self.key(f"invite/{label}"),
            ),
            "inviteToOrganisation",
        )
        self.adapters.require_bound("mail")
        # The invitation message format is whatever the bound mail port writes.
        token = self.adapters.mail.take(email).body.strip()
        member = self.identities.customer(active.intake.slug, label, email=email)
        self.expect_ok(
            self.api.call(
                "acceptInvitation",
                principal=member,
                body={"token": token},
                idempotency_key=self.key(f"accept/{label}"),
            ),
            "acceptInvitation",
        )
        return member

    def deliver_payment_event(self, event: SignedEvent) -> Any:
        raise self._contract_absence(
            "service:payment-inbox",
            r"payment.?event|webhook|/inbox",
            "inbound payment event operation",
        )

    def payment_inbox_evidence(self, event_id: str) -> Any:
        raise self._contract_absence(
            "service:payment-inbox",
            r"payment.?event|webhook|/inbox",
            "inbound payment event operation",
        )

    def deliver_payment_return(self, parameters: dict[str, str]) -> Any:
        raise self._contract_absence(
            "service:payment-return",
            r"payment.?return|return.?url|/returns?(/|$)",
            "browser payment-return operation",
        )

    def revoke_claim(self, staff: Principal, organisation_id: str) -> Any:
        raise self._contract_absence(
            "service:owner-claim-revocation",
            r"revoke\w*claim|claim\w*revoke|owner-claims/.*revoke",
            "owner-claim revocation operation (docs/specs/FIRST_OWNER_BOOTSTRAP.md §6.1)",
        )

    def close_organisation(self, principal: Principal, organisation_id: str, **options: Any) -> Any:
        raise self._contract_absence(
            "service:organisation-closure",
            r"clos(e|ure)\w*organi|organi\w*clos|/closure|erase|erasure",
            "organisation closure or identity erasure operation",
        )

    def operator_reconciliation(self, principal: Principal, job_id: str) -> Any:
        raise self._contract_absence(
            "service:operator-reconciliation",
            r"reconcil",
            "operator reconciliation operation",
        )

    def intake_body(self, label: str, **changes: Any) -> dict[str, Any]:
        body = self.example("organisation-intake-request.json")
        slug = changes.pop("slug", None) or self.slug(label)
        body.update(
            slug=slug,
            name=f"Synthetic {label}",
            legal_name=f"Synthetic {label}",
            vat_number=None,
            billing_email=f"billing@{slug}.{SYNTHETIC_DOMAIN}",
            email_domains=[f"{slug}.{SYNTHETIC_DOMAIN}"],
            # A ticket reference of the shape the intake admits (`^[A-Z]{2,8}-[0-9]{1,8}$`), one
            # per intake of the scenario.
            instruction_ref="FS-"
            + str(
                int(hashlib.sha256(f"{self.namespace}/{label}".encode()).hexdigest(), 16) % 10**8
            ),
            intended_owner={
                "email": f"owner@{slug}.{SYNTHETIC_DOMAIN}",
                "display_name": "Synthetic Owner",
            },
        )
        body.update(changes)
        return body

    def record_intake(
        self, staff: Principal, label: str, *, key: str | None = None, **changes: Any
    ) -> Intake:
        body = self.intake_body(label, **changes)
        key = key or self.key(f"intake/{label}")
        response = self.api.call(
            "createOrganisation", principal=staff, body=body, idempotency_key=key
        )
        payload = self.expect(response, 201, "createOrganisation")
        return Intake(
            organisation_id=payload["organisation"]["id"],
            slug=payload["organisation"]["slug"],
            key=key,
            intended_owner_email=body["intended_owner"]["email"],
            bootstrap=payload["bootstrap"],
        )

    def read_bootstrap_status(self, principal: Principal, organisation_id: str) -> Any:
        response = self.api.call(
            "getOrganisationBootstrap",
            principal=principal,
            path={"organisation_id": organisation_id},
        )
        return self.expect(response, 200, "getOrganisationBootstrap")

    def bound_owner(self, intake: Intake, status: Any) -> Principal:
        identity_id = status["identity_mapping"]["identity_id"]
        identity = self.model("Identity")._base_manager.get(pk=identity_id)
        return self.identities.customer(
            intake.slug, "owner", subject=identity.subject, email=identity.email
        )

    def claim_first_owner(self, principal: Principal, token: str, *, key: str | None = None) -> Any:
        return self.api.call(
            "consumeOwnerClaim",
            principal=principal,
            body={"token": token},
            idempotency_key=key or self.key(f"claim/{principal.subject}"),
        )

    def publish_catalogue(self) -> Catalogue:
        """The offer, published through Core's only publication surface: the operator's
        `load_catalogue` command over the catalogue models (apps/billing/catalogue). Measured: the
        contract carries no write on catalogue resources; one appearing must be driven here."""
        operations = catalogue_write_surface(self.api.contract, [])
        if operations:
            raise AssertionError(
                f"a catalogue publication surface exists: {', '.join(operations)}. Drive "
                "publish_catalogue through it before trusting the operator command"
            )
        if not catalogue_write_surface({}, installed_model_names()):
            raise MissingBehaviourError(
                "service:catalogue-publication",
                "the contract carries no non-read operation on catalogue, offer or "
                "legal-document resources, and no catalogue model is installed",
            )
        from django.core.management import call_command

        call_command("load_catalogue", allow_placeholder=True, stdout=io.StringIO())
        call_command("load_legal_documents", allow_placeholder=True, stdout=io.StringIO())
        # The placeholder catalogue's yearly Visio + Docs offer at capacity M, the example's.
        return Catalogue(
            offer={
                "plan_code": "essentiel",
                "pack_code": "visio-docs",
                "capacity_tier_code": "M",
                "billing_period": "yearly",
            }
        )

    def order_body(
        self, label: str, catalogue: Catalogue, dpa_id: str, **changes: Any
    ) -> dict[str, Any]:
        body = self.example("order-request.json")
        body.update(catalogue.offer)
        body["tenant"] = {"slug": self.slug(label), "name": f"Synthetic {label}", "locale": "fr"}
        body["dpa_acceptance"] = {
            "dpa_id": dpa_id,
            "accepted": True,
            "accepted_by_name": "Synthetic Owner",
            "accepted_by_role": "Owner",
        }
        body["billing_contact"] = {
            "email": self.email("billing", label),
            "name": "Synthetic Billing",
        }
        body.update(changes)
        return body

    def place_order(
        self,
        owner: Principal,
        organisation_id: str,
        catalogue: Catalogue,
        label: str,
        *,
        key: str | None = None,
        **changes: Any,
    ) -> Any:
        dpa = self.api.call(
            "generateDpa", principal=owner, path={"organisation_id": organisation_id}
        )
        dpa_id = self.expect(dpa, 201, "generateDpa")["id"]
        return self.api.call(
            "placeOrder",
            principal=owner,
            path={"organisation_id": organisation_id},
            body=self.order_body(label, catalogue, dpa_id, **changes),
            idempotency_key=key or self.key(f"order/{label}"),
        )

    def settle_order(self, result: Any) -> None:
        """Pay the order `result` placed, by the provider's verified event. An organisation holds
        one order in flight (`placeOrder`, contract 0.20.0): its next order follows this one."""
        order = result["order"]
        money = order["price_snapshot"]["total_incl_vat"]
        self.deliver_payment_event(
            self.adapters.payment.event(
                reference=order["id"],
                amount_cents=money["amount_minor"],
                currency=money["currency"],
            )
        )

    def request_synthetic_provision(
        self, staff: Principal, tenant_id: str, *, kind: str = "provision", key: str | None = None
    ) -> Any:
        return self.api.call(
            "triggerTenantJob",
            principal=staff,
            path={"tenant_id": tenant_id},
            body={"kind": kind},
            idempotency_key=key or self.key(f"job/{tenant_id}/{kind}"),
        )

    def request_realm_update(
        self, staff: Principal, organisation_id: str, *, key: str | None = None
    ) -> Any:
        """Measured: a `realm_update` is its own organisation job (ADR-0004), and the contract
        enqueues one only behind federation-provider and membership changes, which need fixtures
        this harness does not have. A direct way to request one turns this into a failure.
        """
        present = realm_update_request_surface(self.api.contract)
        if present:
            raise AssertionError(
                f"a direct realm_update request now exists in the contract ({', '.join(present)}): "
                "drive request_realm_update through it before trusting gap service:realm-update"
            )
        raise MissingBehaviourError(
            "service:realm-update",
            "the contract carries no operation that requests a realm_update job directly",
        )

    def read_operation(self, principal: Principal, job_id: str) -> Any:
        response = self.api.call("getJob", principal=principal, path={"job_id": job_id})
        return self.expect(response, 200, "getJob")

    # -- the fixtures of ACCEPTANCE.md ------------------------------------------------------

    def staff(self, label: str = "operator") -> Principal:
        return self.identities.staff(label)

    def empty_customer(self) -> EmptyCustomer:
        staff = self.staff()
        catalogue = self.publish_catalogue()
        for name in ("Organisation", "Identity", "Membership", "Tenant", "Job"):
            rows = self.count_if_present(name)
            if rows:
                raise AssertionError(f"empty_customer holds {rows} {name} rows before it starts")
        return EmptyCustomer(staff, catalogue)

    def owner_pending(self, label: str = "pending") -> OwnerPending:
        staff = self.staff()
        intake = self.record_intake(staff, label)
        self.worker.run_until_idle()
        status = self.read_bootstrap_status(staff, intake.organisation_id)
        if status["organisation_state"] != "prospect":
            raise AssertionError(f"owner_pending is {status['organisation_state']}, not prospect")
        owner = self.bound_owner(intake, status)
        token = self.adapters.claim_token(intake.intended_owner_email)
        if self.count("Membership", organisation_id=intake.organisation_id):
            raise AssertionError("owner_pending already holds a membership")
        return OwnerPending(staff, intake, owner, token)

    def active_organisation(self, label: str = "active") -> ActiveOrganisation:
        pending = self.owner_pending(label)
        owner = self.identities.with_second_factor(pending.owner)
        self.expect(self.claim_first_owner(owner, pending.token), 200, "consumeOwnerClaim")
        return ActiveOrganisation(pending.staff, pending.intake, owner, pending.token)

    def ordered(self, label: str = "ordered") -> Ordered:
        catalogue = self.publish_catalogue()
        active = self.active_organisation(label)
        result = self.expect(
            self.place_order(active.owner, active.intake.organisation_id, catalogue, label),
            201,
            "placeOrder",
        )
        tenant_id = result["tenant"]["id"]
        job = self.expect(
            self.request_synthetic_provision(active.staff, tenant_id), 202, "triggerTenantJob"
        )
        return Ordered(active.staff, active, result, tenant_id, job)

    def shared_org(self, label: str = "shared") -> SharedOrganisation:
        catalogue = self.publish_catalogue()
        active = self.active_organisation(label)
        tenants = []
        for suffix in ("a", "b"):
            result = self.expect(
                self.place_order(
                    active.owner, active.intake.organisation_id, catalogue, f"{label}-{suffix}"
                ),
                201,
                "placeOrder",
            )
            tenants.append(result["tenant"]["id"])
            self.settle_order(result)
            self.expect(
                self.request_synthetic_provision(active.staff, result["tenant"]["id"]),
                202,
                "triggerTenantJob",
            )
        self.worker.run_until_idle()
        return SharedOrganisation(active.staff, active, (tenants[0], tenants[1]))

    def other_org(self, label: str = "other") -> Ordered:
        world = self.ordered(label)
        self.worker.run_until_idle()
        return world

    def delivery_unknown(self, label: str = "unknown") -> Ordered:
        world = self.ordered(label)
        self.adapters.require_bound("invoice")
        self.adapters.invoice.inject("after-effect", LostResponseError)
        self.worker.restart_dispatcher()
        return world

    def retained_records(self, label: str = "retained") -> Ordered:
        self.decision("tenant-scoped-retained-access-window")
        world = self.ordered(label)
        self.worker.run_until_idle()
        return world
