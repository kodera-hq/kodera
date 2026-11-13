"""Hermetic deployment settings and command discovery; no database or provider use."""

import base64
import importlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from django.core.exceptions import ImproperlyConfigured

ROOT = Path(__file__).resolve().parents[1]
PROFILE = "config.settings.deploy_operator"
APPS = [
    "apps.identity",
    "apps.orgs",
    "apps.jobs",
    "apps.audit",
    "apps.outbox",
    "apps.legal",
    "apps.tenancy",
    "apps.billing",
    "apps.support",
    "apps.engine_intents",
    "apps.workspaces",
    "apps.docs",
    "apps.extensions",
    "apps.media",
]
COMMANDS = [
    "dispatch_extensions",
    "purge_extension_payloads",
    "import_workspace",
    "manage_extension",
    "schedule_digest",
    "set_digest_consent",
    "configure_workspace_quotas",
    "configure_collab_role",
    "configure_api_role",
    "bind_community_identity",
    "bootstrap_community_workspace",
    "bootstrap_staff_roles",
    "grant_staff_role",
    "revoke_staff_role",
    "start_realm_bootstrap",
    "complete_realm_bootstrap",
    "requeue_realm_bootstrap",
    "bind_intended_owner",
    "reissue_owner_claim",
    "revoke_owner_claim",
    "confirm_owner_contact",
    "decide_claim_delivery",
    "sweep_jobs",
    "run_deliveries",
    "cleanup_discovery_quotas",
    "run_realm_deliveries",
    "send_invitations",
    "run_operator_schedule",
    # Billing's and legal's, there for settle_complimentary_order (BILLING_MODEL.md §4.2).
    "cancel_unpaid_orders",
    "load_catalogue",
    "send_order_confirmations",
    "settle_complimentary_order",
    "withdraw_cancelled_links",
    "load_legal_documents",
    # The support ticket mails (SUPPORT_TICKETS.md §6).
    "send_support_tickets",
    "triage_support_tickets",
    # The pilot's operator override of a tenant's status (QUICK_WORKSPACE.md §5).
    "tenant_status",
    # The tenant agent's credential (ADR-0016), and the read-only lag report that comes with it.
    "enrol_tenant_agent",
    "revoke_tenant_agent",
    "engine_member_sets_lag",
]


def inputs():
    return {
        "DJANGO_SECRET_KEY": "synthetic-operator-only-" + "abc0123456789" * 5,
        "DJANGO_ALLOWED_HOSTS": "operator.synthetic.test",
        "DATABASE_URL": "postgresql://synthetic:synthetic-pass@private-db.test/core",
    }


PREAMBLE = """
import json, sys, django, psycopg
from django.db.backends.base.base import BaseDatabaseWrapper
def forbidden(*args, **kwargs):
    raise AssertionError('profile acceptance attempted database or network contact')
BaseDatabaseWrapper.ensure_connection = forbidden
psycopg.connect = forbidden
def audit(event, args):
    if event in {'socket.connect', 'socket.bind', 'socket.getaddrinfo'}:
        forbidden()
sys.addaudithook(audit)
django.setup()
from django.conf import settings
"""


def probe(program, extra=None):
    return subprocess.run(  # noqa: S603 - fixed interpreter and owned synthetic program
        [sys.executable, "-B", "-c", PREAMBLE + program],
        cwd=ROOT,
        env={
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": str(ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": PROFILE,
            **inputs(),
            **(extra or {}),
        },
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )


def loaded(program, extra=None):
    result = probe(program, extra)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_operator_profile_loads_commands_and_graph_without_database_or_http():
    result = loaded(
        """
from django.core.management import get_commands, load_command_class
from django.db.migrations.loader import MigrationLoader
from apps.orgs.management.operator import require_operator_profile
from apps.jobs import mutants
require_operator_profile()
commands = get_commands()
names = """
        + repr(COMMANDS)
        + """
for name in names:
    command = load_command_class(commands[name], name)
    assert command.create_parser('manage.py', name).format_help()
assert settings.DEBUG is False
assert settings.ROOT_URLCONF is None
assert settings.WSGI_APPLICATION is None
assert settings.MIDDLEWARE == []
assert not any(name.startswith('apps.engine_intents.api') for name in sys.modules)
assert settings.KODERA_LOOPBACK_ISSUERS is False
assert not any(name in sys.modules for name in (
    'config.settings.dev', 'config.settings.persistence', 'config.settings.job_queue',
    'config.settings.deploy', 'config.settings.customer_http', 'config.settings.test',
    'config.settings.e2e', 'config.settings.e2e_operator'))
assert not mutants.active()
settings.JOB_QUEUE_MUTANTS = frozenset({'no_dedupe'})
try:
    mutants.active()
except mutants.MutantsRefused:
    pass
else:
    raise AssertionError('operator profile permitted mutation')
loader = MigrationLoader(None)
loader.graph.validate_consistency()
print(json.dumps({'apps': settings.INSTALLED_APPS,
                  'migration_apps': sorted({app for app, name in loader.graph.leaf_nodes()}),
                  'commands': sorted(n for n, app in commands.items() if app.startswith('apps.'))}))
"""
    )
    assert result == {
        "apps": APPS,
        "migration_apps": sorted(p[5:] for p in APPS),
        "commands": sorted(COMMANDS),
    }


def test_operator_deployment_entry_is_distinct_from_fixed_api_entry():
    module = importlib.import_module("config.deploy_environment")
    parse = getattr(module, "operator_deployment", None)
    assert parse is not None, "fixed operator deployment input entry missing"
    for selector in (None, PROFILE):
        values = inputs() if selector is None else {**inputs(), "DJANGO_SETTINGS_MODULE": selector}
        assert parse(values)["DATABASES"]["default"]["HOST"] == "private-db.test"
    with pytest.raises(ImproperlyConfigured, match="^Deployment configuration refused$"):
        module.deployment({**inputs(), "DJANGO_SETTINGS_MODULE": PROFILE})
    for selector in (
        "config.settings.deploy",
        "config.settings.job_queue",
        "config.settings.e2e_operator",
        "custom.settings",
    ):
        with pytest.raises(ImproperlyConfigured, match="^Deployment configuration refused$"):
            parse({**inputs(), "DJANGO_SETTINGS_MODULE": selector})


def test_fixed_selector_guard_detects_an_actual_source_weakening():
    source = (ROOT / "config/deploy_environment.py").read_text()
    anchor = 'if environment.get("DJANGO_SETTINGS_MODULE", profile) != profile:'
    assert source.count(anchor) == 1, "selector mutation anchor moved"
    namespace = {"__name__": "operator_selector_mutant"}
    exec(  # noqa: S102 - owned source-only control
        compile(source.replace(anchor, "if False:"), "<operator-selector-mutant>", "exec"),
        namespace,
    )
    wrong = {**inputs(), "DJANGO_SETTINGS_MODULE": "config.settings.e2e_operator"}
    assert (
        namespace["operator_deployment"](wrong)["DATABASES"]["default"]["HOST"] == "private-db.test"
    )
    with pytest.raises(ImproperlyConfigured, match="^Deployment configuration refused$"):
        importlib.import_module("config.deploy_environment").operator_deployment(wrong)


@pytest.mark.parametrize("name", list(inputs()))
def test_operator_missing_required_deployment_input_is_refused(name):
    result = probe("raise AssertionError('unsafe operator startup')", {name: ""})
    assert result.returncode != 0
    assert "Deployment configuration refused" in result.stderr
    assert "unsafe operator startup" not in result.stderr


@pytest.mark.parametrize(
    "extra",
    [
        {"DJANGO_DEBUG": "1"},
        {"DATABASE_URL": "sqlite:///tmp/synthetic-private-sentinel"},
        {"DJANGO_ALLOWED_HOSTS": "*"},
        {"DJANGO_SECRET_KEY": "synthetic-private-sentinel"},
        {"SCW_SECRET_KEY": "synthetic-private-sentinel"},
        {"SCW_SECRET_KEY": ""},
        {"KEYCLOAK_ADMIN_PASSWORD": "synthetic-private-sentinel"},
        {"GUNICORN_CMD_ARGS": "synthetic-private-sentinel"},
        {"FORWARDED_ALLOW_IPS": "*"},
    ],
)
def test_operator_unsafe_deployment_is_refused_and_redacted(extra):
    result = probe("raise AssertionError('unsafe operator startup')", extra)
    assert result.returncode != 0
    assert "Deployment configuration refused" in result.stderr
    assert "synthetic-private-sentinel" not in result.stderr + result.stdout


def test_operator_defaults_keep_existing_cutover_and_delivery_refusals():
    assert loaded("""
from io import StringIO
from uuid import UUID
from django.core.management import call_command
from django.core.management.base import CommandError
from apps.orgs.realm_bootstrap import principal_for, Refused
assert settings.KODERA_INTAKE_ADMITTED is False
assert settings.KODERA_AUTH_TRUST == ()
assert settings.KODERA_STAFF_ISSUER is None
assert settings.KODERA_CONTACT_SEAL_KEY is None
assert settings.KODERA_OUTBOX_SEAL_KEY is None
assert settings.KODERA_MAIL_TRANSPORT is None
assert settings.KODERA_MAIL_LINK_ORIGINS == frozenset()
try:
    principal_for(UUID(int=1))
except Refused as error:
    assert 'cutover is not declared final' in str(error)
else:
    raise AssertionError('cutover gate missing')
try:
    call_command('run_deliveries', once=True, stdout=StringIO())
except CommandError as error:
    assert 'no mail transport is configured' in str(error)
else:
    raise AssertionError('delivery gate missing')
assert settings.KODERA_REALM_WORKER_SECRET_DIR is None
assert settings.KODERA_REALM_ORIGINS is None
try:
    call_command('run_realm_deliveries', once=True, stdout=StringIO())
except CommandError as error:
    assert 'no realm worker credential source' in str(error)
else:
    raise AssertionError('realm delivery gate missing')
print(json.dumps({'closed': True}))
""") == {"closed": True}


def test_operator_reads_existing_claim_and_mail_inputs_without_contact():
    key = base64.urlsafe_b64encode(bytes(range(32))).decode()
    assert loaded(
        """
assert settings.KODERA_INTAKE_ADMITTED is True
assert settings.KODERA_CONTACT_SEAL_KEY == bytes(range(32))
assert settings.KODERA_OUTBOX_SEAL_KEY == bytes(range(32))
assert settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS == '3600'
assert settings.KODERA_OWNER_CLAIM_LINK == 'https://console.synthetic.test/claim'
assert settings.KODERA_MAIL_LINK_ORIGINS == frozenset({'https://console.synthetic.test'})
assert settings.KODERA_MAIL_TRANSPORT.host == 'smtp.synthetic.test'
assert settings.KODERA_MAIL_TRANSPORT.starttls is True
assert settings.KODERA_REALM_WORKER_SECRET_DIR == '/run/synthetic-realm-workers'
assert settings.KODERA_REALM_ORIGINS.issuer == 'https://auth.synthetic.test'
assert settings.KODERA_REALM_ORIGINS.admin == 'https://admin.synthetic.test'
print(json.dumps({'configured': True}))
""",
        {
            "KODERA_INTAKE_ADMITTED": "1",
            "KODERA_CONTACT_SEAL_KEY": key,
            "KODERA_OUTBOX_SEAL_KEY": key,
            "KODERA_OWNER_CLAIM_LIFETIME_SECONDS": "3600",
            "KODERA_OWNER_CLAIM_LINK": "https://console.synthetic.test/claim",
            "KODERA_MAIL_LINK_ORIGINS": "https://console.synthetic.test",
            "KODERA_MAIL_SMTP_URL": "smtp://smtp.synthetic.test:587",
            "KODERA_MAIL_FROM": "Kodera <noreply@notify.staging.kodera.io>",
            "KODERA_REALM_WORKER_SECRET_DIR": "/run/synthetic-realm-workers",
            "KODERA_REALM_ISSUER_ORIGIN": "https://auth.synthetic.test",
            "KODERA_REALM_ADMIN_ORIGIN": "https://admin.synthetic.test",
        },
    ) == {"configured": True}


@pytest.mark.parametrize(
    "extra",
    [
        {"KODERA_INTAKE_ADMITTED": "true"},
        {"KODERA_CONTACT_SEAL_KEY": "synthetic-private-sentinel"},
        {"KODERA_OUTBOX_SEAL_KEY": "synthetic-private-sentinel"},
        {"KODERA_AUTH_TRUST": "synthetic-private-sentinel"},
        {"KODERA_STAFF_ISSUER": "http://localhost/realms/kodera-staff"},
        {"KODERA_MAIL_LINK_ORIGINS": "https://console.synthetic.test/extra"},
        {
            "KODERA_MAIL_SMTP_URL": "smtp+insecure://remote.synthetic.test",
            "KODERA_MAIL_FROM": "noreply@notify.staging.kodera.io",
        },
        {"KODERA_REALM_ISSUER_ORIGIN": "https://auth.synthetic.test"},
        {
            "KODERA_REALM_ISSUER_ORIGIN": "ftp://synthetic-private-sentinel",
            "KODERA_REALM_ADMIN_ORIGIN": "https://admin.synthetic.test",
        },
    ],
)
def test_operator_invalid_operation_inputs_refuse_without_echo(extra):
    result = probe("raise AssertionError('invalid settings loaded')", extra)
    assert result.returncode != 0
    assert "invalid settings loaded" not in result.stderr
    assert "synthetic-private-sentinel" not in result.stderr + result.stdout


@pytest.mark.parametrize(
    "issuer",
    [
        "https://identity.synthetic.test/realms/kodera-staff",
        "http://127.0.0.1/realms/kodera-staff",
        "https://127.0.0.1/realms/kodera-staff",
    ],
)
def test_operator_trust_uses_real_snapshot_validation_and_refuses_loopback(issuer):
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    public.update(kid="synthetic-operator", alg="RS256", use="sig", key_ops=["verify"])
    trust = json.dumps(
        [
            {
                "lane": "staff",
                "issuer": issuer,
                "generation": "synthetic-operator",
                "expires_at": int(time.time()) + 3600,
                "public_jwks": {"keys": [public]},
            }
        ]
    )
    result = probe(
        """
assert settings.KODERA_STAFF_ISSUER == settings.KODERA_AUTH_TRUST[0].snapshot.issuer
print(json.dumps({'staff_trust': True}))
""",
        {"KODERA_AUTH_TRUST": trust, "KODERA_STAFF_ISSUER": issuer},
    )
    if issuer.startswith("https://identity."):
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == {"staff_trust": True}
    else:
        assert result.returncode != 0
        assert "plain-http or loopback issuer" in result.stderr


SETTLE = """
from django.core.management import call_command
call_command('settle_complimentary_order', '--staff-identity', '00000000-0000-7000-8000-000000000001',
             '--organisation', 'kodera-team', '--order', '00000000-0000-7000-8000-000000000002',
             '--reason', 'probe')
"""


def test_the_complimentary_settlement_runs_on_the_operator_profile_up_to_the_database():
    """The staff command of BILLING_MODEL.md §4.2 is found and imports on the operator profile, and
    gets past its operator and series guards to its first database read, which this probe forbids.
    tests/test_complimentary_order.py runs it to the end on a real database under this profile. On
    the API's profile it is refused (no outbox); before billing was installed here it was unknown."""
    result = probe(SETTLE, {"KODERA_INTAKE_ADMITTED": "1", "KODERA_INVOICE_SERIES": "KOD"})
    assert result.returncode != 0
    assert "profile acceptance attempted database or network contact" in result.stderr
    assert "not all installed" not in result.stderr
    assert "Unknown command" not in result.stderr


def test_without_the_apis_invoice_series_the_settlement_refuses_before_reading_anything():
    # Never the default series: a credit note numbered outside the API's series breaks its counter.
    result = probe(SETTLE, {"KODERA_INTAKE_ADMITTED": "1"})
    assert result.returncode != 0
    assert "KODERA_INVOICE_SERIES is not set" in result.stderr
    assert "nothing written" in result.stderr
    assert "attempted database or network contact" not in result.stderr


def test_the_operator_profile_reads_the_series_and_app_urls_through_the_apis_validators():
    urls = '{"messaging": "https://{slug}.staging.kodera.io"}'
    assert loaded(
        "print(json.dumps([settings.KODERA_INVOICE_SERIES, settings.KODERA_TENANT_APP_URLS]))",
        {"KODERA_INVOICE_SERIES": "KOD", "KODERA_TENANT_APP_URLS": urls},
    ) == ["KOD", {"messaging": "https://{slug}.staging.kodera.io"}]
    assert loaded(
        "print(json.dumps([settings.KODERA_INVOICE_SERIES, settings.KODERA_TENANT_APP_URLS]))"
    ) == [None, {}]
    for name, value, message in (
        ("KODERA_INVOICE_SERIES", "AV", "KODERA_INVOICE_SERIES does not start with AV"),
        (
            "KODERA_TENANT_APP_URLS",
            '{"visio": "http://{slug}.x.test"}',
            "KODERA_TENANT_APP_URLS is a JSON object of app code to https://",
        ),
    ):
        refused = probe("print('started')", {name: value})
        assert refused.returncode != 0 and "started" not in refused.stdout, name
        assert message in refused.stderr, refused.stderr


def test_the_settlements_tenant_line_prints_on_the_operator_profile():
    """The line the command prints after it commits, with the tenant read stubbed: on this profile
    it must not reach the tenant agent's application, which is not installed here."""
    program = (
        "import uuid, types\n"
        "import apps.tenancy.selectors as tenancy\n"
        "row = types.SimpleNamespace(id=uuid.UUID(int=7), slug='acme', realm=None,"
        " apps=['visio', 'messaging'])\n"
        "tenancy.tenant_of = lambda **kwargs: row\n"
        "from apps.billing.management.commands.settle_complimentary_order import tenant_line\n"
        "print(json.dumps(tenant_line(uuid.UUID(int=1), uuid.UUID(int=7))))"
    )
    urls = (
        '{"messaging": "https://{slug}.staging.kodera.io", "visio": "https://{slug}.visio.x.test"}'
    )
    result = probe(program, {"KODERA_TENANT_APP_URLS": urls})
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == (
        "tenant=00000000-0000-0000-0000-000000000007 slug=acme realm=- "
        "host.messaging=acme.staging.kodera.io host.visio=acme.visio.x.test"
    )


AGENT_COMMANDS = {
    "enrol_tenant_agent": [
        "--staff-identity", "00000000-0000-7000-8000-000000000001",
        "--organisation", "kodera-team",
        "--token-file", "{token_file}",
    ],
    "revoke_tenant_agent": [
        "--staff-identity", "00000000-0000-7000-8000-000000000001",
        "--organisation", "kodera-team",
        "--credential", "00000000-0000-7000-8000-000000000003",
    ],
}  # fmt: skip


@pytest.mark.parametrize("name", sorted(AGENT_COMMANDS))
def test_the_tenant_agent_commands_run_on_the_operator_profile_up_to_the_database(name, tmp_path):
    """ADR-0016's staff commands are found and import on the operator profile, and get past
    require_operator_profile and the cutover guard to their first database read, the acting staff
    identity's, which this probe forbids; without KODERA_INTAKE_ADMITTED both refuse before it.
    No token file is created before that read. tests/test_agent_enrolment.py runs them to the end on
    a real database. Before engine intents was installed here, both were unknown commands on every
    deployed profile: the API image carries no management command."""
    token_file = tmp_path / "agent.token"
    arguments = [a.replace("{token_file}", str(token_file)) for a in AGENT_COMMANDS[name]]
    result = probe(
        "from django.core.management import call_command\n"
        f"call_command({name!r}, *{arguments!r})\n",
        {"KODERA_INTAKE_ADMITTED": "1"},
    )
    assert result.returncode != 0
    assert "profile acceptance attempted database or network contact" in result.stderr
    assert "not all installed" not in result.stderr
    assert "Unknown command" not in result.stderr
    assert not token_file.exists()


@pytest.mark.parametrize("name", sorted(AGENT_COMMANDS))
def test_without_the_cutover_the_tenant_agent_commands_refuse_before_reading_anything(
    name, tmp_path
):
    token_file = tmp_path / "agent.token"
    arguments = [a.replace("{token_file}", str(token_file)) for a in AGENT_COMMANDS[name]]
    result = probe(
        f"from django.core.management import call_command\ncall_command({name!r}, *{arguments!r})\n"
    )
    assert result.returncode != 0
    assert "cutover is not declared final" in result.stderr
    assert "profile acceptance attempted database or network contact" not in result.stderr
    assert not token_file.exists()
