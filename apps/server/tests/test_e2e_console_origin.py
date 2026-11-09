"""Only the local end-to-end API profile admits a plain-http Console origin on discovery.

The stack's Console is http://localhost:<port> (dev/e2e/README.md), and `discoverRealm` admits a
browser only from an exact origin of KODERA_CONSOLE_ORIGINS. Everywhere but
`config.settings.e2e`, an origin is `https`, and a list holding an http one is malformed, so
discovery answers 503 to a browser rather than admit it (services/identity/discovery_input.py).
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from services.identity.discovery_input import allowed_origins

ROOT = Path(__file__).resolve().parents[1]
CONSOLE = "http://localhost:4173"
FLAG = "KODERA_CONSOLE_LOOPBACK_ORIGINS"
# The flag is a setting, never an input: each profile is also started with an environment variable
# of the same name, so a profile or a route that read it from the environment would be caught.
FLAG_ENVIRONMENTS = [None, "1", "true", "True"]
# Origins refused whatever the flag says: a host that only starts like localhost, userinfo, an IP
# literal, a case or a trailing dot a resolver would accept, a port out of range, and anything after
# the authority.
MALFORMED = [
    "http://localhost.evil:4173",
    "http://localhost:4173@evil",
    "http://user@localhost:4173",
    "http://user:pass@localhost:4173",
    "http://[::1]:4173",
    "http://127.0.0.1:4173",
    "HTTP://LOCALHOST:4173",
    "http://LOCALHOST:4173",
    "http://localhost.:4173",
    "http://localhost:0",
    "http://localhost:65536",
    "http://localhost:4173/",
    "http://localhost:4173/claim",
    "http://localhost:4173?x=1",
    "http://localhost:4173#x",
    "http://localhost:+4173",
    "http://localhost: 4173",
    "http://localhost",
    "https://localhost:4173@evil",
    "https://app.kodera.io/",
    "https://app.kodera.io?x=1",
    "https://app.kodera.io#x",
    "https://user@app.kodera.io",
]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (CONSOLE, frozenset({CONSOLE})),
        ("http://localhost:1", frozenset({"http://localhost:1"})),
        ("https://app.kodera.io, http://localhost:4173", {"https://app.kodera.io", CONSOLE}),
        ("http://localhost", None),
        ("http://localhost:0", None),
        ("http://localhost:65536", None),
        ("http://localhost:4173/", None),
        ("http://127.0.0.1:4173", None),
        ("http://app.localhost:4173", None),
        ("http://LOCALHOST:4173", None),
        ("http://app.kodera.io", None),
        ("http://localhost.attacker.example:4173", None),
    ],
)
def test_loopback_http_admits_exactly_localhost_with_a_port(raw, expected):
    assert allowed_origins(raw, loopback_http=True) == expected


@pytest.mark.parametrize("raw", [CONSOLE, "https://app.kodera.io, http://localhost:4173"])
def test_without_the_flag_an_http_origin_is_malformed(raw):
    assert allowed_origins(raw) is None
    assert allowed_origins(raw, loopback_http=False) is None


@pytest.mark.parametrize("loopback_http", [False, True])
@pytest.mark.parametrize("raw", MALFORMED)
def test_a_malformed_origin_is_refused_with_or_without_the_flag(raw, loopback_http):
    assert allowed_origins(raw, loopback_http=loopback_http) is None
    # One malformed entry makes the whole list malformed, beside a good one.
    assert allowed_origins("https://app.kodera.io, " + raw, loopback_http=loopback_http) is None


PROGRAM = """
import django
django.setup()
from django.conf import settings
from apps.identity.discovery import _admit_headers
from services.identity.discovery_policy import DiscoveryUnavailableError
try:
    _admit_headers("application/json", "e2e-console-origin-key", "http://localhost:4173", "same-origin")
except DiscoveryUnavailableError:
    outcome = "refused"
else:
    outcome = "admitted"
print("started", getattr(settings, "KODERA_CONSOLE_LOOPBACK_ORIGINS", None), outcome)
"""


# The worker's profile loads only in a process that entered the worker's boundary (worker/boot.py),
# as tests/test_loopback_issuers.py starts it.
WORKER_SETTINGS = "config.settings.deploy_worker"
WORKER_BOOT = "import worker.boot; worker.boot.enter(); "


def start(settings_module, *, path=(), program=PROGRAM, flag=None):
    if settings_module == WORKER_SETTINGS:
        program = WORKER_BOOT + program
    return subprocess.run(  # noqa: S603 - a fixed interpreter and a fixed program
        [sys.executable, "-c", program],
        cwd=ROOT,
        env={
            "PATH": os.defpath,
            "PYTHONPATH": os.pathsep.join([str(ROOT), *map(str, path)]),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": settings_module,
            "DATABASE_URL": "postgres://u:p@127.0.0.1:5432/kodera_server",
            "KODERA_CONSOLE_ORIGINS": CONSOLE,
            **({FLAG: flag} if flag is not None else {}),
            **(
                {
                    "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
                    "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
                }
                if settings_module in {"config.settings.deploy", "config.settings.deploy_operator"}
                else {}
            ),
        },
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def outcome(settings_module, *, path=(), flag=None):
    started = start(settings_module, path=path, flag=flag)
    assert started.returncode == 0, started.stderr[-2000:]
    return started.stdout.split()


@pytest.mark.parametrize("flag", FLAG_ENVIRONMENTS)
@pytest.mark.parametrize("profile", ["config.settings.customer_http", "config.settings.deploy"])
def test_the_deployable_api_profiles_refuse_the_local_console_origin(profile, flag):
    assert outcome(profile, flag=flag) == ["started", "None", "refused"], (
        f"{profile} admitted a plain-http Console origin"
    )


@pytest.mark.parametrize("flag", FLAG_ENVIRONMENTS)
def test_the_end_to_end_api_profile_admits_the_local_console_origin(flag):
    assert outcome("config.settings.e2e", flag=flag) == ["started", "True", "admitted"]


def flag_holders(modules, *, path=(), flag=None):
    """The settings modules, each started on its own, in which the flag is True."""
    program = (
        "import django; django.setup(); from django.conf import settings; "
        f"print('started', getattr(settings, {FLAG!r}, None))"
    )
    holders = set()
    for module in modules:
        started = start(module, path=path, program=program, flag=flag)
        assert started.returncode == 0, f"{module}: {started.stderr[-2000:]}"
        if started.stdout.split()[1] == "True":
            holders.add(module)
    return holders


def settings_modules():
    return sorted(
        "config.settings." + path.stem
        for path in (ROOT / "config/settings").glob("*.py")
        if path.stem != "__init__"
    )


@pytest.mark.parametrize("flag", FLAG_ENVIRONMENTS)
def test_only_the_end_to_end_api_profile_sets_the_flag(flag):
    assert flag_holders(settings_modules(), flag=flag) == {"config.settings.e2e"}, (
        "a profile other than config.settings.e2e admits a plain-http Console origin"
    )


def test_the_flag_scan_finds_a_profile_that_sets_it(tmp_path):
    (tmp_path / "widened_customer_http.py").write_text(
        f"from config.settings.customer_http import *\n{FLAG} = True\n"
    )
    assert flag_holders(["widened_customer_http"], path=[tmp_path]) == {"widened_customer_http"}
    assert outcome("widened_customer_http", path=[tmp_path]) == ["started", "True", "admitted"]
