"""Bring the running live end-to-end stack to a fully journeyed organisation: one entry point.

TEST ONLY. It plays both staff operators and the identity operator against the stack of
dev/e2e/compose.yaml, with the values `make_trust render` derived from a public label, and never
against anything else: every address it calls is http://localhost:<port> from journey.json.

    uv run python -m dev.e2e.make_trust render     # template owner mode, the default
    docker compose -f dev/e2e/compose.yaml --env-file dev/e2e/rendered/compose.env \\
      up -d --build --wait
    uv run python -m dev.e2e.make_trust probe
    uv run python -m dev.e2e.journey

The steps, each checked before the next:

1. `bootstrap_staff_roles`: `staff-one` and `staff-two` become the first two staff operators.
2. `staff-one` signs in (password + code) and `POST /api/v1/organisations` records the intake of
   `e2e-pilot`, which enqueues its `realm_create` job.
3. `staff-two` runs `start_realm_bootstrap` through the six tooling steps (the realm is the
   pre-created one) and `complete_realm_bootstrap`, whose verify reads the live realm.
4. `staff-two` (not the recorder: the two-person rule) runs `bind_intended_owner` to the fixed
   `owner` subject, after the admin API has shown the account credential-free, as the binding's
   account record says. The claim is issued and its mail enqueued.
5. TEST ONLY, standing in for the owner's actions e-mail: the admin API replaces the account with
   the same id, a derived password and code, no required action and a verified address.
6. `run_deliveries --once` sends the claim mail to Mailpit; its link's fragment is the token.
7. `owner` signs in through the Console client, and `POST /api/v1/owner-claims/actions/consume`
   consumes the claim.
8. `POST /api/v1/auth/discover` for `e2e-pilot` and the owner's `GET /api/v1/me` both answer 200.

It runs once per bring-up: the staff bootstrap succeeds only on an empty staff table. To run it
again, `down` and `up` the stack. It prints identifiers and outcomes, never a token or a password.
"""

import argparse
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from . import make_trust
from .make_trust import ORG_REALM, RENDERED, ROOT, FixtureError, require

HERE = Path(__file__).resolve().parent
COMPOSE = HERE / "compose.yaml"
ORGANISATION_NAME = "E2E Pilot"
OWNER_DISPLAY_NAME = "E2E Owner"
INSTRUCTION_REF = "SUP-0001"
TOOLING_STEPS = 6
# The claim link's fragment (apps/orgs/claim_tokens.py: `oc1_<claim id>_<43 characters>`).
CLAIM_TOKEN = re.compile(r"#(oc1_[0-9a-f-]{36}_[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])")
GRANT_LINE = re.compile(r"staff_operator granted by bootstrap to staff identity ([0-9a-f-]{36})")


# --- Loopback HTTP ---------------------------------------------------------------------------


def call(
    origin: str,
    method: str,
    path: str,
    *,
    token: str | None = None,
    body: object = None,
    form: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, Any]:
    """One request to a loopback origin of journey.json; the JSON body, or the raw bytes."""
    connection = http.client.HTTPConnection("localhost", make_trust.port_of(origin), timeout=30)
    sent = {"Accept": "application/json"}
    data: bytes | None = None
    if token is not None:
        sent["Authorization"] = "Bearer " + token
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        sent["Content-Type"] = "application/json"
    elif form is not None:
        data = urlencode(form).encode("ascii")
        sent["Content-Type"] = "application/x-www-form-urlencoded"
    sent.update(headers or {})
    try:
        connection.request(method, path, body=data, headers=sent)
        response = connection.getresponse()
        raw = response.read(4 * 1024 * 1024)
        status = response.status
        kind = response.getheader("Content-Type") or ""
    finally:
        connection.close()
    if "json" in kind and raw:
        return status, json.loads(raw)
    return status, raw


def idempotency_key(purpose: str) -> str:
    return f"e2e-journey-{purpose}-{uuid.uuid4().hex}"


# --- Operator commands -----------------------------------------------------------------------


def ops(*arguments: str, stdin: str | None = None) -> str:
    """One operator command in the stack's `ops` service; its standard output."""
    docker = shutil.which("docker")
    require(docker is not None, "the Docker CLI is required to run the operator commands")
    assert docker is not None  # noqa: S101 - narrows for the type checker
    result = subprocess.run(  # noqa: S603 - a fixed CLI, the stack's own compose file
        [
            docker,
            "compose",
            "-f",
            str(COMPOSE),
            "--env-file",
            str(RENDERED / "compose.env"),
            "run",
            "--rm",
            "-T",
            "ops",
            *arguments,
        ],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
        cwd=ROOT,
    )
    for line in result.stdout.splitlines():
        print("   ", line)
    if result.returncode != 0:
        # The commands print identifiers and outcomes only; compose adds container progress.
        tail = (result.stderr.strip().splitlines() or ["(no output)"])[-1]
        raise FixtureError(f"ops {arguments[0]} failed: {tail}")
    return result.stdout


# --- Identity provider -----------------------------------------------------------------------


def login(journey: dict[str, Any], username: str, account: dict[str, Any] | None = None) -> str:
    """The probe's own sign-in; once more at the next code step only if the code was refused (a
    code is single-use, and the probe may have signed the same account in seconds ago). Any other
    refusal, and a second refusal, is raised, the second with the first as its cause."""
    try:
        tokens = make_trust.login(journey, username, account)
    except make_trust.CodeRefused as first:
        time.sleep(make_trust.TOTP_PERIOD - time.time() % make_trust.TOTP_PERIOD + 1)
        try:
            tokens = make_trust.login(journey, username, account)
        except FixtureError as again:
            raise again from first
    return tokens["access_token"]


def admin_token(journey: dict[str, Any]) -> str:
    admin = journey["keycloak_admin"]
    status, body = call(
        journey["keycloak_origin"],
        "POST",
        "/realms/master/protocol/openid-connect/token",
        form={
            "grant_type": "password",
            "client_id": "admin-cli",
            "username": admin["username"],
            "password": admin["password"],
        },
    )
    require(status == 200 and isinstance(body, dict), "the identity provider's admin refused")
    return str(body["access_token"])


def credential_types(journey: dict[str, Any], token: str, subject: str) -> list[str]:
    status, body = call(
        journey["keycloak_origin"],
        "GET",
        f"/admin/realms/{ORG_REALM}/users/{subject}/credentials",
        token=token,
    )
    require(status == 200 and isinstance(body, list), "the owner account could not be read")
    return sorted(str(item["type"]) for item in body)


def preset_owner(journey: dict[str, Any], token: str) -> None:
    """TEST ONLY: the owner account, same id, replaced by the representation `--owner-mode
    test-credentials` imports (derived password and code, no required action, address verified).
    It stands in for the owner completing Keycloak's actions e-mail after the binding."""
    realm = make_trust.render_realm(ORG_REALM, journey["console_origin"], "test-credentials")
    owner = next(user for user in realm["users"] if user["username"] == "owner")
    require(owner["id"] == journey["accounts"]["owner"]["subject"], "owner id drifted")
    status, body = call(
        journey["keycloak_origin"],
        "POST",
        f"/admin/realms/{ORG_REALM}/partialImport",
        token=token,
        body={"ifResourceExists": "OVERWRITE", "users": [owner]},
    )
    require(
        status == 200 and isinstance(body, dict) and body.get("overwritten") == 1,
        "the owner's credentials were not set",
    )


# --- Mail ------------------------------------------------------------------------------------


def claim_token(journey: dict[str, Any], recipient: str) -> str:
    """The owner claim's token, from the fragment of the link in the mail Mailpit caught."""
    origin = journey["mailpit_origin"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        status, listing = call(origin, "GET", "/api/v1/messages?limit=50")
        require(status == 200 and isinstance(listing, dict), "Mailpit's API refused")
        for message in listing.get("messages") or []:
            if not any(to.get("Address") == recipient for to in message.get("To") or []):
                continue
            if ORGANISATION_NAME not in str(message.get("Subject", "")):
                continue
            status, full = call(origin, "GET", f"/api/v1/message/{message['ID']}")
            require(status == 200 and isinstance(full, dict), "Mailpit's message refused")
            found = CLAIM_TOKEN.search(str(full.get("Text", "")))
            require(found is not None, "the claim mail carries no claim link")
            assert found is not None  # noqa: S101 - narrows for the type checker
            return found.group(1)
        time.sleep(1)
    raise FixtureError("no owner claim mail reached Mailpit")


# --- The journey -----------------------------------------------------------------------------


def evidence(prefix: str, step: int, run: str) -> list[str]:
    return [
        f"--{prefix}-provider",
        "e2e-pre-created-realm",
        f"--{prefix}-resource-id",
        ORG_REALM,
        f"--{prefix}-request-id",
        f"{run}-{prefix}-{step}",
        f"--{prefix}-observed-at",
        datetime.now(UTC).isoformat(),
    ]


def discover(journey: dict[str, Any], *, browser: bool = False) -> tuple[int, Any]:
    """`discoverRealm` as a native client (no Origin), or as the stack's Console in a browser:
    its rendered origin, which only config.settings.e2e admits over plain http."""
    headers = {"Idempotency-Key": idempotency_key("discover")}
    if browser:
        headers.update({"Origin": journey["console_origin"], "Sec-Fetch-Site": "same-site"})
    return call(
        journey["api_origin"],
        "POST",
        "/api/v1/auth/discover",
        body={"slug": ORG_REALM},
        headers=headers,
    )


UNTIL = ("claim-mail",)


def journey_run(
    journey_path: Path = RENDERED / "journey.json", until: str | None = None
) -> list[str]:
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from services.identity.trusted_issuers import load_trust, verify_configured_token

    journey = json.loads(journey_path.read_text(encoding="utf-8"))
    require(
        journey["owner_mode"] == "template",
        "render with the default --owner-mode template: the binding records the owner account "
        "credential-free, which a preset owner is not",
    )
    env = make_trust.read_env(journey_path.parent / "compose.env")
    trusted = load_trust(env["KODERA_AUTH_TRUST"])
    accounts = journey["accounts"]
    owner = accounts["owner"]
    api = journey["api_origin"]
    done: list[str] = []

    status, found = discover(journey)
    require(status == 200 and isinstance(found, dict), f"discovery answered {status}")
    require(
        found["realm"] is None,
        "this stack has been journeyed already: `down` and `up` it for a fresh run",
    )

    # 1. The first two staff operators.
    try:
        output = ops(
            "bootstrap_staff_roles",
            "--operator",
            accounts["staff-one"]["subject"],
            accounts["staff-one"]["email"],
            "--operator",
            accounts["staff-two"]["subject"],
            accounts["staff-two"]["email"],
        )
    except FixtureError as error:
        raise FixtureError(
            f"{error} (it runs once per bring-up: `down` and `up` the stack)"
        ) from None
    granted = GRANT_LINE.findall(output)
    require(len(granted) == 2, "the staff bootstrap did not grant two operators")
    recorder, operator = granted
    done.append(f"staff: staff-one {recorder}, staff-two {operator}, both staff_operator")

    # 2. The intake, by staff-one, with a staff token carrying its code.
    status, created = call(
        api,
        "POST",
        "/api/v1/organisations",
        token=login(journey, "staff-one"),
        body={
            "slug": ORG_REALM,
            "name": ORGANISATION_NAME,
            "instruction_ref": INSTRUCTION_REF,
            "intended_owner": {"email": owner["email"], "display_name": OWNER_DISPLAY_NAME},
            "locale": "en",
        },
        headers={"Idempotency-Key": idempotency_key("intake")},
    )
    require(status == 201 and isinstance(created, dict), f"createOrganisation answered {status}")
    organisation_id = created["organisation"]["id"]
    done.append(f"intake: organisation {ORG_REALM} {organisation_id}, realm_create job queued")

    # 3. The realm job, by staff-two: six tooling steps, then the verify of the live realm.
    common = ["--staff-identity", operator, "--organisation", ORG_REALM]
    run = "e2e-" + uuid.uuid4().hex[:12]
    ops("start_realm_bootstrap", *common, "--tooling-run", f"{run}-1")
    for step in range(1, TOOLING_STEPS + 1):
        following = [] if step == TOOLING_STEPS else ["--tooling-run", f"{run}-{step + 1}"]
        ops(
            "start_realm_bootstrap",
            *common,
            "--outcome",
            "completed",
            *evidence("compute", step, run),
            *evidence("target", step, run),
            *following,
        )
    ops(
        "complete_realm_bootstrap",
        *common,
        "--sign-in-result",
        "ok",
        "--sign-in-evidence",
        f"{run}-pre-created-realm",
        *evidence("compute", 7, run),
    )
    done.append("realm: steps 1-6 recorded, verify of the live realm succeeded, realm ready")

    # 4. The binding, by staff-two, of an account the admin API shows credential-free.
    admin = admin_token(journey)
    require(
        credential_types(journey, admin, owner["subject"]) == [],
        "the owner account holds a credential: the binding would record a false account record",
    )
    output = ops(
        "bind_intended_owner",
        "--staff-identity",
        operator,
        "--organisation",
        ORG_REALM,
        "--subject",
        owner["subject"],
        stdin=json.dumps(
            {
                "contact": owner["email"],
                "account_record": {
                    "issuer": journey["organisation"]["issuer"],
                    "subject": owner["subject"],
                    "credential_created": False,
                    "evidence_ref": f"{run}-owner-account-credential-free",
                },
            }
        ),
    )
    require("outcome=issued" in output, "the binding issued no claim")
    done.append("binding: owner bound by staff-two, claim issued, its mail enqueued")

    # 5. TEST ONLY: the owner's password and code, after the binding.
    preset_owner(journey, admin_token(journey))
    require(
        credential_types(journey, admin_token(journey), owner["subject"]) == ["otp", "password"],
        "the owner account did not receive its password and code",
    )
    done.append("owner credentials (TEST ONLY, after the binding): password and code set")

    # 6. The claim mail, sent to Mailpit.
    ops("run_deliveries", "--once")
    token = claim_token(journey, owner["email"])
    done.append("claim mail: delivered to Mailpit, token read from its link")
    if until == "claim-mail":
        # The claim stays unconsumed, its mail in Mailpit: the Console's own claim page
        # (`/claim/<id>/<slug>`) takes it from here.
        done.append("stopped at the claim mail (--until claim-mail): the claim is not consumed")
        return done

    # 7. The owner signs in through the Console client and consumes the claim.
    signed_in = {**owner, **owner["after_binding"]}
    access = login(journey, "owner", signed_in)
    verified, lane = verify_configured_token(access, trusted=trusted)
    require(lane == "customer", "the owner token is not on the customer lane")
    require("otp" in (verified.amr or ()), "the owner token has no otp in amr")
    require(verified.email_verified is True, "the owner token's address is not verified")
    require(
        verified.authorized_party == env["KODERA_CONSOLE_CLIENT_ID"],
        "the owner token was not issued to the Console client",
    )
    require(verified.mfa_enrolled is True, "the owner token carries no registered factor")
    status, consumed = call(
        api,
        "POST",
        "/api/v1/owner-claims/actions/consume",
        token=access,
        body={"token": token, "display_name": OWNER_DISPLAY_NAME},
        headers={"Idempotency-Key": idempotency_key("consume")},
    )
    require(status == 200, f"consumeOwnerClaim answered {status}: {problem(consumed)}")
    done.append("claim: consumed by the owner, organisation active")

    # 8. The end state.
    status, found = discover(journey, browser=True)
    require(status == 200 and isinstance(found, dict), f"discovery answered {status}")
    require(
        found["realm"] == ORG_REALM and found["issuer"] == journey["organisation"]["issuer"],
        "discovery does not name the organisation's realm",
    )
    done.append(f"discoverRealm {ORG_REALM} from the Console's origin: 200, realm and issuer named")
    status, me = call(api, "GET", "/api/v1/me", token=access)
    require(status == 200 and isinstance(me, dict), f"GET /api/v1/me answered {status}")
    require(
        any(
            entry["role"] == "org_owner"
            and entry["state"] == "active"
            and entry["organisation"]["slug"] == ORG_REALM
            for entry in me.get("organisations", [])
        ),
        "the owner's /me does not show an active org_owner membership",
    )
    done.append(f"owner GET /api/v1/me: 200, active org_owner of {ORG_REALM}")
    return done


def problem(body: object) -> str:
    """A refusal's problem type only, never its whole body."""
    if isinstance(body, dict):
        return str(body.get("type", "")).rsplit("/", 1)[-1]
    return "(no problem document)"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--journey", type=Path, default=RENDERED / "journey.json")
    parser.add_argument(
        "--until",
        choices=UNTIL,
        help="stop after this step: claim-mail leaves the claim for the Console to consume",
    )
    arguments = parser.parse_args(argv)
    try:
        for line in journey_run(arguments.journey, arguments.until):
            print("ok", line)
    except FixtureError as error:
        print("refused:", error, file=sys.stderr)
        return 1
    except OSError as error:
        print(
            "unreachable:", type(error).__name__, "(is the stack up and rendered?)", file=sys.stderr
        )
        return 1
    return 0


if __name__ == "__main__":
    os.umask(0o022)
    raise SystemExit(main())
