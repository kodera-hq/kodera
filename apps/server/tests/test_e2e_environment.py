"""The live end-to-end environment, read statically: its trust proof and its compose boundary.

What only a running stack can prove (Keycloak's kid, the browser flow's amr, the API's answer) is
`python -m dev.e2e.make_trust probe`, for the optional CI job proposed in dev/e2e/README.md
("Proposed CI job"), which is not in any workflow.
"""

import copy
import json
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

from apps.orgs.claim_configuration import claim_link
from apps.outbox.mail.links import origins_from_environment
from apps.outbox.mail.seal import key_from_environment as outbox_key
from apps.outbox.mail.transport import transport_from_environment
from apps.outbox.realm.keycloak import origins_from_environment as realm_origins
from config.environment import console_client_id, intake_admitted, is_loopback_host, local_database
from core.sealing import key_from_environment
from dev.accept_runtime import POSTGRES
from dev.e2e import invitations, journey, make_trust
from dev.identity_fixture import KEYCLOAK
from services.identity.discovery_input import allowed_origins
from services.identity.discovery_policy import configured_key

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "dev/e2e/compose.yaml"
API_ENVIRONMENT = {
    "DATABASE_URL",
    "DJANGO_ALLOWED_HOSTS",
    "DJANGO_DEBUG",
    "DJANGO_SECRET_KEY",
    "DJANGO_SETTINGS_MODULE",
    "KODERA_AUTH_TRUST",
    "KODERA_CONSOLE_CLIENT_ID",
    "KODERA_CONSOLE_ORIGINS",
    "KODERA_CONTACT_SEAL_KEY",
    "KODERA_DISCOVERY_HMAC_KEY",
    "KODERA_INTAKE_ADMITTED",
    "KODERA_MEMBERSHIP_CURSOR_KEY",
    "KODERA_STAFF_ISSUER",
}
# What `ops` adds to the operator environment `migrate` has: the gate and contact key every pilot
# command reads (FIRST_OWNER_BOOTSTRAP.md section 3.8), the claim mail's settings, and the invitation
# mail's link and the realm worker's credentials and origins (INVITATIONS.md section 4).
OPS_ADDS = {
    "KODERA_CONTACT_SEAL_KEY",
    "KODERA_INTAKE_ADMITTED",
    "KODERA_MAIL_FROM",
    "KODERA_MAIL_LINK_ORIGINS",
    "KODERA_MAIL_SMTP_URL",
    "KODERA_OUTBOX_SEAL_KEY",
    "KODERA_OWNER_CLAIM_LINK",
    "KODERA_INVITATION_LINK",
    "KODERA_REALM_ADMIN_ORIGIN",
    "KODERA_REALM_ISSUER_ORIGIN",
    "KODERA_REALM_WORKER_SECRET_DIR",
}
# The one host file the API container sees: the test-only settings overlay the image lacks.
E2E_OVERLAY = [("bind", "config/settings/e2e.py", "/app/config/settings/e2e.py", True)]
SELFTEST = [
    "derivation-fixed",
    "totp-rfc6238",
    "realms-shape",
    "realms-shape-refusals",
    "core-admits-trust",
    "core-admits-settings",
    "imported-key-verifies",
]


def test_selftest_passes_every_check():
    assert make_trust.selftest() == SELFTEST


def mutated_template(monkeypatch, realm, change):
    original = make_trust.load_template

    def load(name):
        value = original(name)
        if name == realm:
            change(value)
        return value

    monkeypatch.setattr(make_trust, "load_template", load)


def drop_audience(value):
    mappers = value["clients"][0]["protocolMappers"]
    value["clients"][0]["protocolMappers"] = [
        m for m in mappers if m["protocolMapper"] != "oidc-audience-mapper"
    ]
    mappers.append({"protocolMapper": "oidc-audience-mapper", "config": {}})


def zero_amr_age(value):
    for config in value["authenticatorConfig"]:
        config["config"]["default.reference.maxAge"] = "0"


def optional_code(value):
    value["authenticationFlows"][1]["authenticationExecutions"][1]["requirement"] = "OPTIONAL"


def password_only_path(value):
    value["authenticationFlows"][0]["authenticationExecutions"].append(
        {"authenticator": "auth-username-password-form", "requirement": "ALTERNATIVE"}
    )


def conditional_code(value):
    forms = value["authenticationFlows"][1]["authenticationExecutions"]
    forms.insert(1, {"authenticator": "conditional-user-configured", "requirement": "REQUIRED"})


def password_grant(value):
    value["clients"][0]["directAccessGrantsEnabled"] = True


def owner_password(value):
    value["users"][0]["credentials"] = [{"type": "password", "value": "x", "temporary": False}]


def drop_registered_factor(value):
    mappers = value["clients"][0]["protocolMappers"]
    value["clients"][0]["protocolMappers"] = [
        m for m in mappers if m["name"] != make_trust.REGISTERED_FACTOR_MAPPER
    ]


def false_registered_factor(value):
    for mapper in value["clients"][0]["protocolMappers"]:
        if mapper["name"] == make_trust.REGISTERED_FACTOR_MAPPER:
            mapper["config"]["claim.value"] = "false"


def staff_registered_factor(value):
    value["clients"][0]["protocolMappers"].append(
        {
            "name": make_trust.REGISTERED_FACTOR_MAPPER,
            "protocolMapper": "oidc-hardcoded-claim-mapper",
            "config": {"claim.name": make_trust.REGISTERED_FACTOR_CLAIM, "claim.value": "true"},
        }
    )


@pytest.mark.parametrize(
    ("realm", "change", "message"),
    [
        (make_trust.STAFF_REALM, drop_audience, "Core's audience"),
        (make_trust.STAFF_REALM, zero_amr_age, "max age of 0"),
        (make_trust.STAFF_REALM, optional_code, "one-time code is required"),
        (make_trust.ORG_REALM, optional_code, "one-time code is required"),
        (make_trust.ORG_REALM, password_only_path, "every browser sign-in"),
        (make_trust.ORG_REALM, conditional_code, "every browser sign-in"),
        (make_trust.ORG_REALM, password_grant, "no password grant"),
        (make_trust.ORG_REALM, owner_password, "credential-free"),
        (make_trust.ORG_REALM, drop_registered_factor, "must carry the registered-factor claim"),
        (make_trust.ORG_REALM, false_registered_factor, "must carry the registered-factor claim"),
        (make_trust.STAFF_REALM, staff_registered_factor, "only the organisation realm"),
    ],
)
def test_selftest_refuses_a_weakened_realm(monkeypatch, realm, change, message):
    mutated_template(monkeypatch, realm, change)
    with pytest.raises(make_trust.FixtureError, match=message):
        make_trust.selftest()


def test_selftest_refuses_swapped_lanes(monkeypatch):
    monkeypatch.setattr(
        make_trust,
        "LANES",
        {make_trust.STAFF_REALM: "customer", make_trust.ORG_REALM: "staff"},
    )
    with pytest.raises(make_trust.FixtureError, match="lanes"):
        make_trust.selftest()


def test_committed_templates_hold_no_identity_material():
    for path in sorted((ROOT / "dev/e2e/realms").glob("*.json")):
        raw = path.read_text()
        value = json.loads(raw)
        assert "components" not in value, path.name
        for needle in ("PRIVATE KEY", "privateKey", "secretData", '"credentials"', '"value"'):
            assert needle not in raw, (path.name, needle)
        assert all(not user.get("credentials") for user in value["users"])


def test_rendered_output_is_fixed_and_owner_modes_differ(tmp_path):
    first = make_trust.render(tmp_path / "a")
    second = make_trust.render(tmp_path / "b")
    assert first == second
    for name in ("compose.env", "realms/kodera-staff.json", "realms/e2e-pilot.json"):
        assert (tmp_path / "a" / name).read_bytes() == (tmp_path / "b" / name).read_bytes()
    preset = make_trust.render(tmp_path / "c", owner_mode="test-credentials")
    assert first["accounts"]["owner"]["password"] is None
    assert preset["accounts"]["owner"]["password"] is not None
    # The journey sets these after the binding; a preset owner has them from the import.
    assert first["accounts"]["owner"]["after_binding"] == {
        "password": preset["accounts"]["owner"]["password"],
        "totp_base32": preset["accounts"]["owner"]["totp_base32"],
    }
    assert "after_binding" not in preset["accounts"]["owner"]
    assert "after_binding" not in first["accounts"]["member"]
    org = json.loads((tmp_path / "c/realms/e2e-pilot.json").read_text())
    assert "TEST-ONLY" in org["displayName"]
    assert (tmp_path / "a/compose.env").stat().st_mode & 0o077 == 0
    assert (tmp_path / "a/journey.json").stat().st_mode & 0o077 == 0


def test_the_console_client_accepts_the_claim_callback(tmp_path):
    make_trust.render(tmp_path)
    for realm in ("kodera-staff", "e2e-pilot"):
        clients = json.loads((tmp_path / f"realms/{realm}.json").read_text())["clients"]
        (client,) = [c for c in clients if c["clientId"] == "console"]
        assert client["redirectUris"] == [
            "http://localhost:4173/auth/callback",
            "http://localhost:4173/auth/claim-callback",
        ]


def test_a_private_file_is_never_readable_by_others_even_when_rewritten(tmp_path):
    target = tmp_path / "invitee.json"
    make_trust.write_private(target, "first\n")
    assert target.stat().st_mode & 0o777 == 0o600
    # A file an earlier run left wider is narrowed before the new content goes in.
    target.chmod(0o644)
    make_trust.write_private(target, "second\n")
    assert (target.stat().st_mode & 0o777, target.read_text()) == (0o600, "second\n")


def test_a_private_file_is_never_written_through_a_symlink(tmp_path):
    elsewhere = tmp_path / "elsewhere.txt"
    elsewhere.write_text("untouched\n")
    target = tmp_path / "invitee.json"
    target.symlink_to(elsewhere)
    with pytest.raises(OSError):
        make_trust.write_private(target, "secret\n")
    assert elsewhere.read_text() == "untouched\n"


def resolved(env_file):
    docker = shutil.which("docker")
    if docker is None:
        raise RuntimeError("Docker Compose CLI is required for e2e boundary acceptance")
    # Read-only; does not contact the daemon or pull.
    return subprocess.run(  # noqa: S603
        [
            docker,
            "compose",
            "-f",
            str(COMPOSE),
            "--env-file",
            str(env_file),
            "--profile",
            "ops",
            "config",
            "--format",
            "json",
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=15,
    )


@pytest.fixture(scope="module")
def services(tmp_path_factory):
    out = tmp_path_factory.mktemp("e2e-render")
    make_trust.render(out)
    result = resolved(out / "compose.env")
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_compose_refuses_to_start_unrendered(tmp_path):
    empty = tmp_path / "empty.env"
    empty.write_text("")
    result = resolved(empty)
    assert result.returncode != 0
    assert "make_trust render first" in result.stderr


def test_images_are_the_pinned_ones(services):
    assert not services.get("volumes"), "no named volume: down must discard everything"
    images = {name: s.get("image") for name, s in services["services"].items() if "build" not in s}
    assert images["keycloak"] == KEYCLOAK
    assert images["db"] == images["keycloak-db"] == POSTGRES
    for name, image in images.items():
        assert "@sha256:" in image, name


def test_every_port_is_loopback_only(services):
    for name, service in services["services"].items():
        assert not service.get("env_file"), name
        for port in service.get("ports", []):
            assert port["host_ip"] == "127.0.0.1", name


def assert_api_mounts(api):
    mounts = [
        (m["type"], Path(m["source"]).relative_to(ROOT).as_posix(), m["target"], m["read_only"])
        if Path(m["source"]).is_relative_to(ROOT)
        else (m["type"], m["source"], m["target"], m["read_only"])
        for m in api.get("volumes", [])
    ]
    assert mounts == E2E_OVERLAY, (
        "the API mounts no host file but the read-only test-only settings overlay"
    )


@pytest.mark.parametrize(
    "change",
    [
        lambda mounts: mounts.append({**mounts[0], "source": str(ROOT / "apps")}),
        lambda mounts: mounts[0].update(read_only=False),
        lambda mounts: mounts[0].update(source=str(ROOT / "config/settings/test.py")),
        lambda mounts: mounts[0].update(target="/app/config/settings/customer_http.py"),
        lambda mounts: mounts.clear(),
    ],
    ids=["second-mount", "writable", "other-file", "other-target", "no-overlay"],
)
def test_api_mount_guard_refuses_any_other_mount(services, change):
    api = copy.deepcopy(services["services"]["api"])
    change(api["volumes"])
    with pytest.raises(AssertionError, match="no host file but the read-only test-only settings"):
        assert_api_mounts(api)


def test_api_boundary(services):
    api = services["services"]["api"]
    assert_api_mounts(api)
    # The overlay is the file the image excludes, so the production build context stays closed.
    assert "config/settings/e2e.py" in (ROOT / ".dockerignore").read_text().splitlines()
    assert api["read_only"] and api["cap_drop"] == ["ALL"]
    assert "no-new-privileges:true" in api["security_opt"]
    assert set(api["environment"]) == API_ENVIRONMENT
    assert api["environment"]["DJANGO_SETTINGS_MODULE"] == "config.settings.e2e"
    # The API's own start check admits exactly this environment.
    local_database(api["environment"])
    # The disposable database admits the intake, with a well-formed contact seal key.
    assert intake_admitted(api["environment"]) is True
    assert key_from_environment(api["environment"], "KODERA_CONTACT_SEAL_KEY") is not None
    assert api["environment"]["KODERA_AUTH_TRUST"] == make_trust.trust_json(
        make_trust.DEFAULT_KEYCLOAK_ORIGIN
    )
    # Discovery's key and Console origin, and the Console client the registered factor needs.
    assert len(configured_key(api["environment"]["KODERA_DISCOVERY_HMAC_KEY"])) == 32
    assert console_client_id(api["environment"]) == "console" == make_trust.console_client_id()
    origins = api["environment"]["KODERA_CONSOLE_ORIGINS"]
    assert allowed_origins(origins, loopback_http=True) == {make_trust.DEFAULT_CONSOLE_ORIGIN}
    assert allowed_origins(origins) is None, "a deployed profile must refuse an http origin"


def test_ops_reads_what_the_pilot_commands_need(services):
    migrate = services["services"]["migrate"]["environment"]
    ops = services["services"]["ops"]["environment"]
    api = services["services"]["api"]["environment"]
    assert set(ops) - set(migrate) == OPS_ADDS
    assert {name: ops[name] for name in migrate} == migrate
    assert intake_admitted(ops) is True
    assert ops["KODERA_CONTACT_SEAL_KEY"] == api["KODERA_CONTACT_SEAL_KEY"]
    assert outbox_key(ops) is not None
    origins = origins_from_environment(ops)
    assert origins == {make_trust.DEFAULT_CONSOLE_ORIGIN}
    assert claim_link(ops, origins) == make_trust.DEFAULT_CONSOLE_ORIGIN + "/claim"
    # The transport job_queue reads, with no insecure host admitted: loopback plaintext only.
    transport = transport_from_environment(ops, insecure_hosts=frozenset())
    assert transport is not None and transport.local and transport.host == "localhost"
    # The invitation link sits on the origin the outbox may link to; the realm worker reads its
    # rendered credential from the read-only checkout and calls the issuer the browser sees.
    assert (
        claim_link({"KODERA_OWNER_CLAIM_LINK": ops["KODERA_INVITATION_LINK"]}, origins)
        == make_trust.DEFAULT_CONSOLE_ORIGIN + "/invitations/accept"
    )
    assert ops["KODERA_REALM_WORKER_SECRET_DIR"] == "/src/dev/e2e/rendered/realm-workers"
    realm = realm_origins(ops)
    assert realm is not None
    assert realm.issuer == realm.admin == make_trust.DEFAULT_KEYCLOAK_ORIGIN


def test_the_rendered_realm_worker_secret_is_the_imported_clients(tmp_path):
    make_trust.render(tmp_path)
    org = json.loads((tmp_path / "realms/e2e-pilot.json").read_text())
    [worker] = [c for c in org["clients"] if c["clientId"] == "kodera-identity-worker"]
    assert (tmp_path / "realm-workers/e2e-pilot").read_text().strip() == worker["secret"]
    staff = json.loads((tmp_path / "realms/kodera-staff.json").read_text())
    assert [c["clientId"] for c in staff["clients"]] == ["console"]


def assert_shared_loopback(services):
    """`ops` reaches the issuer the browser sees, and Mailpit, on its own loopback."""
    keycloak, mailpit, ops = (services["services"][n] for n in ("keycloak", "mailpit", "ops"))
    origin = keycloak["environment"]["KC_HOSTNAME"]
    port = make_trust.port_of(origin)
    assert keycloak.get("network_mode") == ops.get("network_mode") == "service:mailpit", (
        "Keycloak and ops must share Mailpit's network namespace"
    )
    assert keycloak["environment"].get("KC_HTTP_PORT") == str(port), (
        "Keycloak must listen on its public origin's port inside the shared namespace"
    )
    assert {(p["host_ip"], int(p["published"]), p["target"]) for p in mailpit["ports"]} == {
        ("127.0.0.1", port, port),
        ("127.0.0.1", 8125, 8025),
    }, "the issuer's port must be published unchanged, on the host's loopback only"
    smtp = transport_from_environment(ops["environment"], insecure_hosts=frozenset())
    assert smtp is not None and is_loopback_host(smtp.host), "ops must reach Mailpit on loopback"


def test_ops_shares_one_loopback_with_the_issuer_and_mailpit(services):
    assert_shared_loopback(services)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda s: s["ops"].pop("network_mode"), "share Mailpit's network namespace"),
        (lambda s: s["keycloak"].update(network_mode="bridge"), "share Mailpit's network"),
        (lambda s: s["keycloak"]["environment"].update(KC_HTTP_PORT="8080"), "listen on its"),
        (lambda s: s["mailpit"]["ports"][1].update(target=8080), "published unchanged"),
        (lambda s: s["mailpit"]["ports"][1].update(host_ip="0.0.0.0"), "published unchanged"),  # noqa: S104
    ],
    ids=["ops-own-network", "keycloak-own-network", "other-port", "remapped", "exposed"],
)
def test_shared_loopback_guard_refuses_a_split_namespace(services, change, message):
    mutated = copy.deepcopy(services)
    change(mutated["services"])
    with pytest.raises(AssertionError, match=message):
        assert_shared_loopback(mutated)


def test_operator_containers_mount_the_checkout_read_only(services):
    for name in ("migrate", "ops"):
        operator = services["services"][name]
        assert operator["build"]["target"] == "dependencies"
        assert [(m["target"], m["read_only"]) for m in operator["volumes"]] == [("/src", True)]
        assert operator["read_only"] and operator["cap_drop"] == ["ALL"]
        environment = operator["environment"]
        assert environment["DJANGO_SETTINGS_MODULE"] == "config.settings.e2e_operator"
        local_database(environment)


def test_provider_imports_the_rendered_realms_read_only(services):
    keycloak = services["services"]["keycloak"]
    assert [(m["target"], m["read_only"]) for m in keycloak["volumes"]] == [
        ("/opt/keycloak/data/import", True)
    ]
    assert keycloak["volumes"][0]["source"].endswith("dev/e2e/rendered/realms")
    assert keycloak["environment"]["KC_HOSTNAME"] == make_trust.DEFAULT_KEYCLOAK_ORIGIN


def test_a_customer_lane_staff_issuer_is_refused_by_the_api_profile(services):
    # The API starts only when its staff issuer is on the staff lane of its trust.
    from django.core.exceptions import ImproperlyConfigured

    from config.environment import staff_issuer

    environment = copy.deepcopy(services["services"]["api"]["environment"])
    assert staff_issuer(environment, loopback_issuers=True) == environment["KODERA_STAFF_ISSUER"]
    swapped = json.loads(environment["KODERA_AUTH_TRUST"])
    swapped[0]["lane"], swapped[1]["lane"] = "customer", "staff"
    environment["KODERA_AUTH_TRUST"] = json.dumps(swapped)
    with pytest.raises(ImproperlyConfigured, match="not on the staff lane"):
        staff_issuer(environment, loopback_issuers=True)


def test_the_fixture_trust_is_refused_by_a_profile_without_loopback_issuers(services):
    # The fixture's keys are derived from a public label: only a local profile may trust them.
    from django.core.exceptions import ImproperlyConfigured

    from config.environment import auth_trust, staff_issuer

    environment = copy.deepcopy(services["services"]["api"]["environment"])
    assert len(auth_trust(environment, loopback_issuers=True)) == 2
    with pytest.raises(
        ImproperlyConfigured, match="^KODERA_AUTH_TRUST admits a plain-http or loopback issuer"
    ):
        auth_trust(environment)
    with pytest.raises(
        ImproperlyConfigured, match="^KODERA_STAFF_ISSUER is a plain-http or loopback issuer"
    ):
        staff_issuer(environment)


def test_shared_loopback_guard_refuses_plaintext_smtp_to_another_host(services):
    # Core's transport admits plaintext to a loopback host only; Mailpit by its service name is
    # refused by every profile but a test one that names it, which the stack does not need.
    from apps.outbox.mail.transport import TransportConfigError

    mutated = copy.deepcopy(services)
    mutated["services"]["ops"]["environment"]["KODERA_MAIL_SMTP_URL"] = (
        "smtp+insecure://mailpit:1025"
    )
    with pytest.raises(TransportConfigError, match="plaintext SMTP is accepted only for a local"):
        assert_shared_loopback(mutated)


def test_the_claim_token_is_read_from_the_link_fragment():
    # A synthetic claim of the shape apps/orgs/claim_tokens.py formats, built, never a literal.
    claim = "_".join(("oc1", str(uuid.UUID(int=1)), "A" * 42 + "-"))
    text = f"open this link:\n\nhttp://localhost:4173/claim/x/e2e-pilot#{claim}\n\nThe team"
    assert journey.CLAIM_TOKEN.search(text).group(1) == claim
    assert journey.CLAIM_TOKEN.search(text.replace("#oc1_", "#oc2_")) is None
    assert journey.CLAIM_TOKEN.search(text.replace(claim, claim + "B")) is None


def test_the_journey_refuses_a_preset_owner_before_any_call(tmp_path, monkeypatch):
    rendered = make_trust.render(tmp_path, owner_mode="test-credentials")
    assert rendered["owner_mode"] == "test-credentials"

    def no_call(*args, **kwargs):
        raise AssertionError("the journey called the stack")

    monkeypatch.setattr(journey, "call", no_call)
    monkeypatch.setattr(journey, "ops", no_call)
    with pytest.raises(make_trust.FixtureError, match="credential-free, which a preset owner"):
        journey.journey_run(tmp_path / "journey.json")


def test_the_owner_preset_after_binding_is_the_test_credentials_import(tmp_path, monkeypatch):
    rendered = make_trust.render(tmp_path)
    sent = []

    def fake_call(origin, method, path, **kwargs):
        sent.append((method, path, kwargs["body"]))
        return 200, {"overwritten": 1}

    monkeypatch.setattr(journey, "call", fake_call)
    journey.preset_owner(rendered, "admin-token")
    [(method, path, body)] = sent
    assert (method, path) == ("POST", "/admin/realms/e2e-pilot/partialImport")
    assert body["ifResourceExists"] == "OVERWRITE"
    [owner] = body["users"]
    assert owner["id"] == rendered["accounts"]["owner"]["subject"]
    assert sorted(c["type"] for c in owner["credentials"]) == ["otp", "password"]
    assert owner["requiredActions"] == [] and owner["emailVerified"] is True
    assert (
        owner["credentials"][0]["value"]
        == rendered["accounts"]["owner"]["after_binding"]["password"]
    )

    monkeypatch.setattr(journey, "call", lambda *a, **k: (200, {"overwritten": 0, "added": 1}))
    with pytest.raises(make_trust.FixtureError, match="credentials were not set"):
        journey.preset_owner(rendered, "admin-token")


def test_the_journey_retries_a_sign_in_only_when_its_code_was_refused(monkeypatch):
    attempts = []

    def refused_then_signed_in(journey_value, username, account=None):
        attempts.append(username)
        if len(attempts) == 1:
            raise make_trust.CodeRefused("the one-time code was refused: spent, or out of step")
        return {"access_token": "synthetic-access"}

    slept = []
    monkeypatch.setattr(make_trust, "login", refused_then_signed_in)
    monkeypatch.setattr(journey.time, "sleep", slept.append)
    assert journey.login({}, "staff-one") == "synthetic-access"
    assert attempts == ["staff-one", "staff-one"] and len(slept) == 1


def test_the_journey_raises_any_other_sign_in_refusal_at_once(monkeypatch):
    def refused(journey_value, username, account=None):
        raise make_trust.FixtureError("token exchange refused")

    def no_sleep(seconds):
        raise AssertionError("the journey waited to retry a refusal that was not the code's")

    monkeypatch.setattr(make_trust, "login", refused)
    monkeypatch.setattr(journey.time, "sleep", no_sleep)
    with pytest.raises(make_trust.FixtureError, match="^token exchange refused$"):
        journey.login({}, "staff-one")


def test_a_second_refusal_carries_the_first_as_its_cause(monkeypatch):
    def always_refused(journey_value, username, account=None):
        raise make_trust.CodeRefused("the one-time code was refused: spent, or out of step")

    monkeypatch.setattr(make_trust, "login", always_refused)
    monkeypatch.setattr(journey.time, "sleep", lambda seconds: None)
    with pytest.raises(make_trust.CodeRefused) as raised:
        journey.login({}, "staff-one")
    assert isinstance(raised.value.__cause__, make_trust.CodeRefused), (
        "the second refusal lost the first as its cause"
    )


def test_the_final_discovery_is_sent_from_the_console_origin(tmp_path, monkeypatch):
    rendered = make_trust.render(tmp_path)
    sent = []

    def fake_call(origin, method, path, **kwargs):
        sent.append(kwargs["headers"])
        return 200, {}

    monkeypatch.setattr(journey, "call", fake_call)
    journey.discover(rendered)
    journey.discover(rendered, browser=True)
    native, browser = sent
    assert "Origin" not in native and "Sec-Fetch-Site" not in native
    assert browser["Origin"] == rendered["console_origin"] == make_trust.DEFAULT_CONSOLE_ORIGIN
    assert browser["Sec-Fetch-Site"] == "same-site"
    source = (ROOT / "dev/e2e/journey.py").read_text()
    assert source.count("discover(journey, browser=True)") == 1, "the end state is not browser-sent"


def problem(kind, status=403, **headers):
    body = json.dumps({"type": make_trust.PROBLEMS + kind, "status": status}).encode()
    return status, {name.lower().replace("_", "-"): value for name, value in headers.items()}, body


def test_the_probe_reads_a_refusal_by_status_type_and_challenge():
    make_trust.require_refusal(problem("forbidden"), status=403, kind="forbidden", what="staff")
    make_trust.require_refusal(
        problem("identity-unknown"), status=403, kind="identity-unknown", what="owner"
    )


@pytest.mark.parametrize(
    ("response", "message"),
    [
        (problem("unauthenticated", 401, WWW_Authenticate="Bearer"), "answered 401, not 403"),
        (problem("forbidden"), "is not the identity-unknown problem"),
        (problem("identity-unknown", WWW_Authenticate="Bearer"), "carries WWW-Authenticate"),
        ((403, {}, b"not json"), "is not the identity-unknown problem"),
    ],
    ids=["unauthenticated", "forbidden-type", "challenge", "no-problem-document"],
)
def test_the_probe_refuses_a_wrong_refusal(response, message):
    with pytest.raises(make_trust.FixtureError, match=message):
        make_trust.require_refusal(response, status=403, kind="identity-unknown", what="owner")


def test_the_stack_holds_no_credential_shaped_name_a_deployed_profile_refuses(services):
    # Core #285: a deployed profile refuses a credential-shaped name it does not admit, and a
    # credential-file selector. The stack's names pass that stricter rule too, so no e2e value
    # needs the admitted list widened; the local profiles' own banned list passes as well.
    from config.environment import unadmitted_secret_names

    for name in ("api", "migrate", "ops"):
        environment = services["services"][name]["environment"]
        assert unadmitted_secret_names(environment) == [], name
        local_database(environment)


def test_the_credential_name_check_sees_a_new_e2e_secret(services):
    from config.environment import unadmitted_secret_names

    environment = {**services["services"]["ops"]["environment"], "E2E_KEYCLOAK_ADMIN_PASSWORD": "x"}
    assert unadmitted_secret_names(environment) == ["E2E_KEYCLOAK_ADMIN_PASSWORD"]


@pytest.mark.parametrize("port", [0, 80, 1023])
def test_render_refuses_a_provider_port_the_nonroot_provider_cannot_bind(tmp_path, port):
    # Keycloak listens on its origin's own port inside the shared namespace, as a nonroot user.
    with pytest.raises(make_trust.FixtureError, match="provider port must be unprivileged"):
        make_trust.render(tmp_path, keycloak_origin=f"http://localhost:{port}")
    assert not (tmp_path / "compose.env").exists()


@pytest.mark.parametrize("port", [1024, 65535])
def test_render_admits_the_unprivileged_provider_port_bounds(tmp_path, port):
    journey = make_trust.render(tmp_path, keycloak_origin=f"http://localhost:{port}")
    assert journey["keycloak_origin"] == f"http://localhost:{port}"


@pytest.mark.parametrize("origin", ["keycloak_origin", "api_origin"])
def test_render_refuses_an_out_of_range_port_with_its_own_refusal(tmp_path, origin):
    with pytest.raises(make_trust.FixtureError, match="an origin must be http://localhost:<port>"):
        make_trust.render(tmp_path, **{origin: "http://localhost:65536"})
    assert not (tmp_path / "compose.env").exists()


def unauthenticated(**headers):
    return problem("unauthenticated", 401, **headers)


@pytest.mark.parametrize(
    ("invalid", "message"),
    [
        (unauthenticated(WWW_Authenticate="Bearer"), None),
        (problem("identity-unknown"), "invalid bearer token answered 403, not 401"),
        ((200, {}, b"{}"), "invalid bearer token answered 200, not 401"),
        (unauthenticated(), "invalid bearer token carries no Bearer challenge"),
        (problem("forbidden", 401, WWW_Authenticate="Bearer"), "is not the unauthenticated"),
    ],
    ids=["unauthenticated", "identity-unknown", "admitted", "no-challenge", "wrong-type"],
)
def test_the_probe_requires_401_for_an_invalid_bearer(tmp_path, monkeypatch, invalid, message):
    journey = make_trust.render(tmp_path)
    claims = make_trust.access_claims(journey["staff_issuer"], amr=["pwd", "otp"])
    claims["sub"] = journey["accounts"]["staff-one"]["subject"]
    staff = make_trust.es256_token(make_trust.signing_key(make_trust.STAFF_REALM), claims)
    monkeypatch.setattr(make_trust, "login", lambda *_: {"access_token": staff})
    trust = {
        entry["issuer"]: entry
        for entry in json.loads(make_trust.trust_json(journey["keycloak_origin"]))
    }

    class Browser:
        def __init__(self, origin):
            self.origin = origin

        def request(self, method, path):
            if path == "/health/ready":
                return 200, {}, b""
            entry = trust[make_trust.issuer(self.origin, path.split("/")[2])]
            if path.endswith("openid-configuration"):
                return 200, {}, json.dumps({"issuer": entry["issuer"]}).encode()
            return 200, {}, json.dumps(entry["public_jwks"]).encode()

    sent = []

    def api_get(origin, path, token):
        sent.append((origin, path, token))
        return problem("forbidden") if token == staff else invalid

    monkeypatch.setattr(make_trust, "Browser", Browser)
    monkeypatch.setattr(make_trust, "api_get", api_get)
    if message is None:
        passed = make_trust.probe(tmp_path / "journey.json")
        assert "api: an invalid bearer token is 401 unauthenticated on /me" in passed
    else:
        with pytest.raises(make_trust.FixtureError, match=message):
            make_trust.probe(tmp_path / "journey.json")
    # The staff token verified for real above; the invalid one is a fixed non-token string.
    assert sent == [
        (journey["api_origin"], "/api/v1/me", staff),
        (journey["api_origin"], "/api/v1/me", "invalid-e2e-token"),
    ]


def test_the_journey_can_stop_at_the_claim_mail_and_refuses_any_other_stop(tmp_path, monkeypatch):
    received = []

    def fake_run(path, until=None):
        received.append((path, until))
        return ["stopped"]

    monkeypatch.setattr(journey, "journey_run", fake_run)
    target = tmp_path / "journey.json"
    assert journey.main(["--journey", str(target), "--until", "claim-mail"]) == 0
    assert journey.main(["--journey", str(target)]) == 0
    assert received == [(target, "claim-mail"), (target, None)]
    with pytest.raises(SystemExit):
        journey.main(["--until", "consume"])


def test_the_invitation_token_is_read_from_the_link_fragment():
    fragment = "_".join(("inv1", str(uuid.UUID(int=7)), "A" * 43))
    mail = f"Accepter : http://localhost:4173/invitations/accept/{uuid.UUID(int=9)}/e2e-pilot#{fragment}\n"
    assert invitations.INVITATION_TOKEN.search(mail).group(1) == fragment
    assert invitations.INVITATION_TOKEN.search(mail.replace("#", "?t=")) is None
    assert invitations.INVITATION_TOKEN.search(mail.replace(fragment, fragment + "B")) is None
