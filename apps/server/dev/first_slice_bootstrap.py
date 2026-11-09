"""Drive FS-BOOT-01..07 against the real runtime; absent behaviour is red, never green.

The seven verdicts below are pure functions of one `Observation`, which is measured — never
assumed — against a real disposable PostgreSQL, the real settings, the real URL resolver, the
real DRF stack and, for FS-BOOT-06, a real local identity provider. Each verdict raises
`WouldPassError` when its observation shows the behaviour present. The suite in `tests/` drives
every verdict, through `decide`, against observations that carry one case's subject at a time, so
a verdict weakened to something an absent slice also satisfies — or keyed on a dimension its
scenario is not about — is caught by a named message rather than discovered in review.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Never

ROOT = Path(__file__).resolve().parents[1]
DOCKER = shutil.which("docker")
CONTRACT = "contracts/core-api.openapi.yaml"
CASES = tuple(f"FS-BOOT-{number:02}" for number in range(1, 8))
LOCAL_BASE = "/api/v1"
PROJECT = "fsboot-acceptance"
COMPOSE = "dev/first_slice_bootstrap.compose.yaml"
DB_PORT = 55432
DATABASE_URL = f"postgres://kodera:kodera@127.0.0.1:{DB_PORT}/kodera_server"
PROBE_LIMIT = 4 * 1024 * 1024
PROBE_SECONDS = 900

# The records docs/specs/FIRST_OWNER_BOOTSTRAP.md §2 names. A model whose name is absent from
# the migrated application cannot hold the state its clause describes.
INTAKE_RECORDS = ("Organisation", "Intake", "AuditEvent")
CLAIM_RECORDS = ("OwnerClaim", "Membership")
DURABLE_RECORDS = ("Job", "OutboxDelivery", "IdempotencyRecord")
# What FS-BOOT-07's two intake probes answer once the guarded operation refuses them.
VALIDATION_REFUSAL = 422


class BlockedError(Exception):
    """A dependency the harness needs is absent; never a product verdict."""


class WouldPassError(Exception):
    """The observation shows the behaviour present, so this case must not report `failed`."""


class ProbeError(Exception):
    """The measurement itself failed; a run that cannot measure reports nothing."""


# --------------------------------------------------------------------- contract ----


def load_contract(root: Path) -> dict[str, Any]:
    try:
        import yaml
    except ModuleNotFoundError as error:  # pragma: no cover - declared in pyproject
        raise BlockedError(
            "dependency-absent:PyYAML, declared in pyproject.toml dev group"
        ) from error
    try:
        raw = (root / CONTRACT).read_bytes()
    except OSError as error:
        raise BlockedError(f"contract-unreadable:{CONTRACT}") from error
    document = yaml.safe_load(raw)
    if not isinstance(document, dict) or not isinstance(document.get("paths"), dict):
        raise BlockedError(f"contract-unreadable:{CONTRACT} carries no paths object")
    return document


def reviewed_operation(document: dict[str, Any], operation_id: str) -> dict[str, Any]:
    """Read the path and method from the contract. Never assume a route the contract moved."""
    for path, item in document["paths"].items():
        if not isinstance(item, dict):
            continue
        for method, operation in item.items():
            if not isinstance(operation, dict) or operation.get("operationId") != operation_id:
                continue
            authz = operation.get("x-kodera-authz") or {}
            return {
                "operation_id": operation_id,
                "method": method.upper(),
                "path": path,
                "roles": tuple(authz.get("roles") or ()),
                "scope": operation.get("x-kodera-scope"),
            }
    raise BlockedError(
        f"contract-missing-operation:{operation_id} is not in {CONTRACT}; "
        "the specification and the executable contract disagree"
    )


def local_url(operation: dict[str, Any], **parameters: str) -> str:
    path = operation["path"]
    for name, value in parameters.items():
        path = path.replace("{" + name + "}", value)
    return LOCAL_BASE + path


# ------------------------------------------------------------------ observation ----


@dataclass(frozen=True)
class Observation:
    """Everything the verdicts read. Every field is measured by `observe`, never defaulted."""

    probes: dict[str, dict[str, Any]] = field(default_factory=dict)
    models: tuple[str, ...] = ()
    relations: tuple[str, ...] = ()
    routes: tuple[str, ...] = ()
    authenticators: tuple[str, ...] = ()
    harness_race: dict[str, int] = field(default_factory=dict)
    identity: dict[str, Any] = field(default_factory=dict)

    def probe(self, name: str) -> dict[str, Any]:
        if name not in self.probes:
            raise ProbeError(f"unmeasured probe: {name}")
        return self.probes[name]

    def served(self, *names: str) -> bool:
        """True only when every named probe reached a view of this application."""
        return all(self.probe(name)["routed"] for name in names)

    def absent_records(self, names: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(name for name in names if name not in self.models)


def sentence(items: tuple[str, ...]) -> str:
    return ", ".join(items) if items else "none"


# ---------------------------------------------------------------------- verdicts ----
# Each returns (status, assertions). Each raises WouldPassError on an observation that shows the
# behaviour present, which is what makes a weakened assertion detectable.


def verdict_boot_01(observation: Observation) -> tuple[str, list[str]]:
    missing = observation.absent_records(INTAKE_RECORDS + CLAIM_RECORDS)
    if observation.served("intake", "bootstrap_status", "claim_consume") and not missing:
        raise WouldPassError("FS-BOOT-01")
    intake = observation.probe("intake")
    return "failed", [
        "FS-BOOT-01 asserts that a staff intake, a completed realm binding and an MFA-verified "
        "claim leave exactly one active organisation with one customer owner, no staff "
        "membership, and committed audit evidence for both the bootstrap and the claim.",
        f"observed: the reviewed operation createOrganisation ({intake['method']} "
        f"{intake['url']}) reached no view of this application; the real URL resolver serves "
        f"only {sentence(observation.routes)}.",
        f"observed: the migrated schema holds no model for {sentence(missing)}, so no "
        "organisation, membership or audit row of this slice can exist to be counted.",
        "not reached, and therefore not proven either way: the staff actor holding no customer "
        "membership, the realm binding, the MFA-verified claim, and the "
        "organisation.intake_recorded / owner_claim.consumed / membership.created / "
        "organisation.activated audit evidence.",
    ]


def verdict_boot_02(observation: Observation) -> tuple[str, list[str]]:
    missing = observation.absent_records(DURABLE_RECORDS)
    if observation.served("intake", "intake_replay", "bootstrap_status") and not missing:
        raise WouldPassError("FS-BOOT-02")
    first, replay = observation.probe("intake"), observation.probe("intake_replay")
    return "failed", [
        "FS-BOOT-02 asserts that a crash before commit, after commit and before dispatch, or "
        "after identity-provider success and before local acknowledgement, resumed with the same "
        "intention, leaves exactly one realm, one intended subject and one owner claim, with "
        "truthful pending or unknown states and no manual database insertion.",
        f"observed: two intakes carrying the same Idempotency-Key returned "
        f"{first['status']} and {replay['status']} from the real stack; neither created an "
        "operation, so there is no second intention to deduplicate and no first one to resume.",
        f"observed: the migrated schema holds no model for {sentence(missing)}, so the "
        "commit-before-dispatch boundary has no durable dispatchable row and the only way to "
        "produce one is the manual database insertion this scenario forbids.",
        f"observed: getOrganisationBootstrap ({observation.probe('bootstrap_status')['url']}) "
        "reached no view, so no pending or unknown state can be reported truthfully or "
        "otherwise.",
    ]


def verdict_boot_03(observation: Observation) -> tuple[str, list[str]]:
    presenters = ("claim_staff", "claim_other_subject", "claim_other_realm", "claim_unknown")
    wrong = (*presenters, "claim_email_match")
    if observation.served(*wrong, "claim_consume") and observation.authenticators:
        raise WouldPassError("FS-BOOT-03")
    statuses = {name: observation.probe(name)["status"] for name in wrong}
    return "failed", [
        "FS-BOOT-03 asserts that staff, another subject in the same realm, a subject in another "
        "realm, an unknown identity and a person holding only a matching email string are each "
        "refused, that no membership is created, and that the intended owner can still complete "
        "the positive control.",
        f"observed: each of the five presenters reached no view of consumeOwnerClaim: {statuses}.",
        "observed: DEFAULT_AUTHENTICATION_CLASSES is "
        f"{list(observation.authenticators)}, so no code resolves a verified (iss, sub) to "
        "an Identity. The email-string presenter that AUTHZ.md §6 rule 7 exists to refuse cannot "
        "be told apart from the intended owner, because neither is resolved at all.",
        "not reached: the refusal of each presenter for its own reason, the absence of a "
        "membership after each refusal, and the positive control.",
    ]


def verdict_boot_04(observation: Observation) -> tuple[str, list[str]]:
    states = ("claim_expired", "claim_revoked", "claim_altered", "claim_consumed")
    missing = observation.absent_records(CLAIM_RECORDS)
    if observation.served(*states) and not missing:
        raise WouldPassError("FS-BOOT-04")
    return "failed", [
        "FS-BOOT-04 asserts that an expired, revoked, altered or consumed claim, each presented "
        "separately without an independently authorised replay of the original operation, cannot "
        "grant a membership, and that neither normal authentication nor ordinary invitations "
        "expose an owner-grant bypass.",
        "observed: each of the four claim states reached no view: "
        f"{ {name: observation.probe(name)['status'] for name in states} }.",
        f"observed: the migrated schema holds no model for {sentence(missing)}, so a claim has "
        "no state to be expired, revoked or consumed in, and an altered token has no verifier to "
        "fail against.",
        f"observed: the real URL resolver serves only {sentence(observation.routes)}. No "
        "invitation or membership-granting operation exists, so the absence of an owner-grant "
        "bypass here is the absence of the entire grant surface — it is not an enforced control "
        "and must not be read as one.",
    ]


def verdict_boot_05(observation: Observation) -> tuple[str, list[str]]:
    race = observation.harness_race
    if observation.served("claim_race_a", "claim_race_b") and "Organisation" in observation.models:
        raise WouldPassError("FS-BOOT-05")
    if race.get("attempted", 0) < 2 or race.get("committed") != 1:
        raise BlockedError(
            "harness-concurrency-unproven: the harness could not commit exactly one of two "
            f"racing writers against the disposable PostgreSQL ({race}); a red FS-BOOT-05 would "
            "not be attributable to the product"
        )
    return "failed", [
        "FS-BOOT-05 asserts that two concurrent valid claims, or a claim concurrent with a "
        "revocation, commit one consistent result: one claim or the revocation wins, with no "
        "duplicate owner grant and no active organisation left without an owner.",
        "observed: both concurrent requests to consumeOwnerClaim reached no view "
        f"({observation.probe('claim_race_a')['status']} and "
        f"{observation.probe('claim_race_b')['status']}), so there is no transactional boundary "
        "for them to race at.",
        f"observed: the migrated schema holds no model for {sentence(observation.absent_records(('Organisation',)))}, "
        "so there is no organisation row to lock and no ownership to duplicate.",
        f"harness positive control: {race['attempted']} racing writers holding SELECT ... FOR "
        f"UPDATE on one row of the same PostgreSQL committed exactly {race['committed']}. The "
        "red above is the product's absence, not a harness that cannot run two writers.",
    ]


def verdict_boot_06(observation: Observation) -> tuple[str, list[str]]:
    identity = observation.identity
    if "unavailable" in identity:
        raise BlockedError(f"identity-provider-unavailable:{identity['unavailable']}")
    if not identity.get("second_factor"):
        raise BlockedError(
            "no-second-factor-in-any-local-identity-provider: the real local provider "
            f"({identity.get('provider', 'unknown')}) completed a real authorisation-code flow "
            "and the production verifier services.identity.access_tokens.verify_access_token "
            "accepted its access token, but that token carries "
            f"{'no amr claim at all' if identity.get('amr') is None else 'amr=' + repr(identity['amr'])}"
            f" and acr={identity.get('acr')!r}: no second factor. No realm definition in this "
            f"repository configures one either ({identity.get('realm_survey')}). FS-BOOT-06 "
            "requires that actual local provider MFA succeed and that its evidence be freshly "
            "verified; ACCEPTANCE.md forbids replacing the provider's assertions with a test "
            "boolean, so this case is blocked rather than faked. Missing dependency: a local "
            "realm that requires local TOTP and issues signed email_verified=true, "
            "kodera_mfa_enrolled=true, Console-bound azp, current-login amr containing otp "
            "and a recent auth_time (at most 300 s plus 30 s of skew) within the decided "
            "330-second Core consumer horizon"
        )
    if observation.served("claim_consume"):
        raise WouldPassError("FS-BOOT-06")
    return "failed", [
        "FS-BOOT-06 asserts that an invalid or missing second factor, or forged browser enrolment "
        "storage, fails the claim, and that a claim with an actual local provider's freshly "
        "verified MFA evidence succeeds, with no production simulation path exercised.",
        f"observed: the local provider issued freshly verified second-factor evidence "
        f"(amr={identity.get('amr')}), and consumeOwnerClaim still reached no view.",
    ]


def verdict_boot_07(observation: Observation) -> tuple[str, list[str]]:
    missing = observation.absent_records(("AuditEvent",))
    dpa = observation.probe("intake_signs_dpa")
    membership = observation.probe("intake_names_membership")
    # A routed intake is not the refusal this case is about: the probes carry no staff token, so
    # a routed view answers them before it reads a body. Only the 422 itself is the behaviour.
    refused = dpa["status"] == VALIDATION_REFUSAL and membership["status"] == VALIDATION_REFUSAL
    if (
        observation.served("intake_signs_dpa", "intake_names_membership")
        and refused
        and not missing
    ):
        raise WouldPassError("FS-BOOT-07")
    routed = observation.served("intake_signs_dpa", "intake_names_membership")
    return "failed", [
        "FS-BOOT-07 asserts that a staff intake request attempting to sign terms or a DPA as the "
        "organisation's owner, or to nominate staff as a customer membership, is refused by the "
        "guarded operation, that the applicable denial is recorded, and that only an authorised "
        "customer identity supplies acceptance evidence.",
        "observed: the contract's OrganisationCreateRequest declares "
        f"additionalProperties={observation.probes['intake_signs_dpa']['contract_closed']}, so "
        "the refusal is specified. "
        + (
            "createOrganisation is routed, but this probe carries no staff token with a second "
            "factor, so the view refuses it before reading the body: "
            if routed
            else "No view serves createOrganisation, so nothing enforces it: "
        )
        + f"a body carrying dpa_acceptance returned {dpa['status']} and a body naming a "
        f"membership returned {membership['status']}, not a {VALIDATION_REFUSAL} "
        "validation-error.",
        f"observed: the migrated schema holds no model for {sentence(missing)}, so no applicable "
        "denial can be recorded.",
        "scope note: this case asserts the intake side only. placeOrder is org_owner only from "
        "contract 0.10.0, decision OD-1 of docs/specs/FIRST_OWNER_BOOTSTRAP.md §9, and that "
        "side is not asserted here.",
    ]


VERDICTS = {
    "FS-BOOT-01": verdict_boot_01,
    "FS-BOOT-02": verdict_boot_02,
    "FS-BOOT-03": verdict_boot_03,
    "FS-BOOT-04": verdict_boot_04,
    "FS-BOOT-05": verdict_boot_05,
    "FS-BOOT-06": verdict_boot_06,
    "FS-BOOT-07": verdict_boot_07,
}


def decide(case: str, observation: Observation) -> dict[str, Any]:
    if case not in VERDICTS:
        raise ProbeError(f"unknown case: {case}")
    try:
        status, assertions = VERDICTS[case](observation)
    except BlockedError as blocked:
        return {"id": case, "status": "blocked", "observed_assertions": [str(blocked)]}
    if status != "failed" or not assertions:
        raise ProbeError(f"a bootstrap verdict may only return a named failure: {case}")
    return {"id": case, "status": status, "observed_assertions": assertions}


# The observation a reviewer would see if the whole slice existed. Every verdict must raise
# WouldPassError out of `decide` against it, and against the narrower observation carrying its own
# subject alone; `tests/test_first_slice_bootstrap.py` holds them to both, and to the converse —
# that no verdict goes quiet on another case's subject, or on its own with one input regressed.
IMPLEMENTED = Observation(
    probes={
        name: {
            "routed": True,
            # FS-BOOT-07's two probes are refused by a working intake; every other one succeeds.
            "status": (
                VALIDATION_REFUSAL
                if name in ("intake_signs_dpa", "intake_names_membership")
                else 200
            ),
            "url": "/api/v1/implemented",
            "method": "POST",
            "contract_closed": False,
        }
        for name in (
            "intake",
            "intake_replay",
            "bootstrap_status",
            "claim_consume",
            "claim_staff",
            "claim_other_subject",
            "claim_other_realm",
            "claim_unknown",
            "claim_email_match",
            "claim_expired",
            "claim_revoked",
            "claim_altered",
            "claim_consumed",
            "claim_race_a",
            "claim_race_b",
            "intake_signs_dpa",
            "intake_names_membership",
        )
    },
    models=INTAKE_RECORDS + CLAIM_RECORDS + DURABLE_RECORDS,
    relations=("organisation", "intake", "owner_claim", "membership", "audit_event"),
    routes=("api/v1/organisations", "api/v1/owner-claims/actions/consume"),
    authenticators=("services.identity.authentication.RealmBearerAuthentication",),
    harness_race={"attempted": 2, "committed": 1},
    identity={
        "provider": "local",
        "second_factor": True,
        "amr": ["pwd", "otp"],
        "acr": "1",
        "realm_survey": "one realm requires a second factor",
    },
)


# ------------------------------------------------------------------- measurement ----


def compose(root: Path, *arguments: str, timeout: int = 300) -> subprocess.CompletedProcess[str]:
    """Only ever this project, and only ever this file. Never a stack this harness did not create.

    `-p PROJECT -f COMPOSE` is not decoration: `docker compose down -v` removes every named
    volume of whatever project it is pointed at, so naming both here is what keeps a teardown
    from reaching the development stack or another worktree's.
    """
    if DOCKER is None:
        raise BlockedError("docker-unavailable: a real disposable PostgreSQL is required")
    return subprocess.run(  # noqa: S603 - resolved program, literal arguments, no caller input
        [DOCKER, "compose", "-p", PROJECT, "-f", str(root / COMPOSE), *arguments],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def start_database(root: Path) -> None:
    started = compose(root, "up", "-d", "--wait")
    if started.returncode:
        raise BlockedError(
            f"disposable-database-unavailable: compose project {PROJECT} did not start"
        )


def stop_database(root: Path) -> None:
    compose(root, "down", "-v", timeout=120)


def survey_realms(root: Path) -> str:
    """Name every realm definition in the tree and whether any configures a second factor."""
    markers = ("otpPolicy", "CONFIGURE_TOTP", "otp-form", "auth-otp-form", '"type": "otp"')
    definitions, configured = [], []
    for path in sorted((root / "dev/realms").glob("*.json")) + [root / "dev/identity_fixture.py"]:
        try:
            text = path.read_text(encoding="utf-8", errors="strict")
        except (OSError, UnicodeDecodeError):
            continue
        name = path.relative_to(root).as_posix()
        definitions.append(name)
        if any(marker in text for marker in markers):
            configured.append(name)
    return (
        f"surveyed {len(definitions)} realm definitions ({', '.join(definitions) or 'none'}); "
        f"configuring a second factor: {', '.join(configured) or 'none'}"
    )


def observe_identity(root: Path) -> dict[str, Any]:
    """Boot the repository's real local provider and read what its token actually asserts."""
    survey = survey_realms(root)
    try:
        from dev.identity_fixture import KEYCLOAK, REALM, FixtureError, code_flow, owned_provider
        from services.identity.access_tokens import (
            IssuerKeySnapshot,
            TokenVerificationError,
            verify_access_token,
        )
    except ModuleNotFoundError as error:
        return {"unavailable": f"identity fixture not importable ({error})", "realm_survey": survey}
    try:
        import time

        with owned_provider() as (transport, password):
            tokens = code_flow(transport, password)
            if tokens is None:
                return {"unavailable": "local authorisation flow returned no token"}
            admitted = IssuerKeySnapshot.from_jwks(
                transport.jwks(),
                issuer=transport.origin + f"/realms/{REALM}",
                generation="fsboot",
                expires_at=int(time.time()) + 300,
            )
            verified = verify_access_token(tokens["access_token"], admitted=admitted)
            factors = tuple(verified.amr) if verified.amr is not None else None
            return {
                "provider": KEYCLOAK.split("@")[0],
                "flow": "authorisation code with PKCE against the running local provider",
                "verified_by": "services.identity.access_tokens.verify_access_token",
                "amr": list(factors) if factors is not None else None,
                "acr": verified.acr,
                "auth_time": verified.auth_time,
                "second_factor": bool(set(factors or ()) - {"pwd", "password"}),
                "realm_survey": survey,
            }
    except (FixtureError, TokenVerificationError, OSError, subprocess.SubprocessError) as error:
        return {"unavailable": f"{type(error).__name__}", "realm_survey": survey}


def race_control(connection_factory: Any) -> dict[str, int]:
    """Prove this harness can serialise two writers, so a red FS-BOOT-05 is the product's."""
    committed, lock = [], threading.Lock()
    setup = connection_factory()
    with setup.cursor() as cursor:
        cursor.execute("DROP TABLE IF EXISTS fsboot_race_control")
        cursor.execute("CREATE TABLE fsboot_race_control (id int primary key, holder text)")
        cursor.execute("INSERT INTO fsboot_race_control VALUES (1, NULL)")
    setup.commit()

    def contend(name: str) -> None:
        handle = connection_factory()
        try:
            with handle.cursor() as cursor:
                cursor.execute("BEGIN")
                cursor.execute("SELECT holder FROM fsboot_race_control WHERE id = 1 FOR UPDATE")
                if cursor.fetchone()[0] is None:
                    cursor.execute(
                        "UPDATE fsboot_race_control SET holder = %s WHERE id = 1", [name]
                    )
                    with lock:
                        committed.append(name)
                cursor.execute("COMMIT")
        finally:
            handle.close()

    runners = [threading.Thread(target=contend, args=(name,)) for name in ("a", "b")]
    for runner in runners:
        runner.start()
    for runner in runners:
        runner.join(timeout=30)
    with setup.cursor() as cursor:
        cursor.execute("DROP TABLE fsboot_race_control")
    setup.commit()
    setup.close()
    return {"attempted": len(runners), "committed": len(committed)}


def observe(root: Path) -> Observation:  # noqa: C901 - one measurement, read top to bottom
    """Everything below runs against the real settings, migrations, resolver and DRF stack."""
    import django
    from django.core.management import call_command

    # The disposable container this harness started, never a caller's DATABASE_URL: a run that
    # migrated somebody else's database would be a reset of a resource it does not own.
    os.environ["DATABASE_URL"] = DATABASE_URL
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")
    os.environ.setdefault("DJANGO_SECRET_KEY", "synthetic-acceptance-key")  # noqa: S105 - synthetic
    django.setup()

    from django.apps import apps
    from django.db import connection, connections
    from django.test import Client
    from django.urls import Resolver404, resolve
    from rest_framework.settings import api_settings

    import config.urls

    call_command("migrate", verbosity=0, interactive=False)
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
        )
        relations = tuple(sorted(row[0] for row in cursor.fetchall()))

    document = load_contract(root)
    intake = reviewed_operation(document, "createOrganisation")
    status = reviewed_operation(document, "getOrganisationBootstrap")
    consume = reviewed_operation(document, "consumeOwnerClaim")
    closed = bool(
        document["components"]["schemas"]["OrganisationCreateRequest"].get(
            "additionalProperties", True
        )
    )

    client = Client()
    probes: dict[str, dict[str, Any]] = {}

    def drive(
        name: str, operation: dict[str, Any], body: Any, headers: dict[str, str] | None = None
    ) -> None:
        url = local_url(operation, organisation_id=str(uuid.uuid4()))
        try:
            resolve(url)
            routed = True
        except Resolver404:
            routed = False
        # `localhost` rather than the test client's default host, so the request passes the
        # real ALLOWED_HOSTS of config.settings.dev instead of a relaxed test environment.
        response = client.generic(
            operation["method"],
            url,
            data=json.dumps(body) if body is not None else b"",
            content_type="application/json",
            headers={"host": "localhost", **(headers or {})},
        )
        probes[name] = {
            "operation_id": operation["operation_id"],
            "method": operation["method"],
            "url": url,
            "routed": routed,
            "status": response.status_code,
            "roles": list(operation["roles"]),
            "contract_closed": closed,
        }

    body = {
        "slug": "fsboot-synthetic",
        "name": "Synthetic Intake",
        "instruction_ref": "FSBOOT-0001",
        "intended_owner": {"email": "owner@synthetic.test", "display_name": "Synthetic Owner"},
    }
    key = str(uuid.uuid4())
    drive("intake", intake, body, {"idempotency-key": key})
    drive("intake_replay", intake, body, {"idempotency-key": key})
    drive("intake_signs_dpa", intake, {**body, "dpa_acceptance": {"dpa_id": str(uuid.uuid4())}})
    drive(
        "intake_names_membership",
        intake,
        {**body, "membership": {"role": "org_owner", "email": "staff@kodera.test"}},
    )
    drive("bootstrap_status", status, None)

    # A distinct synthetic token per presenter: the scenario's five callers, four claim states
    # and two racers each reach the operation on their own request.
    token = "own_" + "0" * 43
    for name, bearer in [
        ("claim_consume", "intended"),
        ("claim_staff", "staff"),
        ("claim_other_subject", "same-realm-other-subject"),
        ("claim_other_realm", "other-realm-subject"),
        ("claim_unknown", "unknown-identity"),
        ("claim_email_match", "matching-email-only"),
        ("claim_expired", "intended"),
        ("claim_revoked", "intended"),
        ("claim_altered", "intended"),
        ("claim_consumed", "intended"),
    ]:
        drive(name, consume, {"token": token}, {"authorization": f"Bearer synthetic.{bearer}"})

    def racer(name: str) -> None:
        drive(name, consume, {"token": token}, {"authorization": "Bearer synthetic.race"})

    racers = [
        threading.Thread(target=racer, args=(name,)) for name in ("claim_race_a", "claim_race_b")
    ]
    for runner in racers:
        runner.start()
    for runner in racers:
        runner.join(timeout=30)

    return Observation(
        probes=probes,
        models=tuple(sorted(model.__name__ for model in apps.get_models())),
        relations=relations,
        routes=tuple(str(pattern.pattern) for pattern in config.urls.urlpatterns),
        authenticators=tuple(
            f"{getattr(item, '__module__', '')}.{getattr(item, '__name__', item)}"
            for item in api_settings.DEFAULT_AUTHENTICATION_CLASSES
        ),
        harness_race=race_control(lambda: connections.create_connection("default")),
        identity=observe_identity(root),
    )


# ------------------------------------------------------------------------ probe ----


def probe(root: Path, selected: list[str]) -> dict[str, Any]:
    try:
        start_database(root)
        try:
            observation = observe(root)
        finally:
            stop_database(root)
    except BlockedError as blocked:
        return {
            "format": 1,
            "runtime_admission": "blocked",
            "dependencies": {"observation": "blocked", "versions": {}},
            "scenarios": [
                {"id": case, "status": "blocked", "observed_assertions": [str(blocked)]}
                for case in selected
            ],
        }
    return {
        "format": 1,
        "runtime_admission": "observed",
        "dependencies": {
            "observation": "probed",
            "versions": {
                "python": sys.version.split()[0],
                "compose_project": PROJECT,
                "database": DATABASE_URL.rsplit("@", 1)[-1],
            },
        },
        "scenarios": [decide(case, observation) for case in selected],
    }


class RedactedParser(argparse.ArgumentParser):
    def error(self, message: str) -> Never:
        raise SystemExit(json.dumps({"format": 1, "error": "invalid_arguments"}))


def main() -> int:
    parser = RedactedParser(description="Drive the FS-BOOT scenarios and report them.")
    parser.add_argument("--case", action="append", default=[])
    arguments = parser.parse_args()
    selected = arguments.case or list(CASES)
    unknown = [case for case in selected if case not in CASES]
    if unknown or len(set(selected)) != len(selected):
        print(json.dumps({"format": 1, "error": "invalid_selection"}))
        return 2
    try:
        report = probe(ROOT, selected)
    except ProbeError as error:
        print(json.dumps({"format": 1, "error": "probe_failed", "detail": str(error)}))
        return 2
    print(json.dumps(report, indent=2, default=str))
    return 1


if __name__ == "__main__":
    sys.exit(main())
