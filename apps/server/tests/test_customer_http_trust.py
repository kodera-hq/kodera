"""Finite public configuration acceptance; no database or provider required."""

import copy
import json

import pytest
from customer_http_fixtures import http_signer as http_signer, trust_entry, trust_module
from test_access_tokens import ISSUER, NOW, frozen_clock as frozen_clock


def test_public_trust_loader_exists():
    assert callable(trust_module().load_trust)


def test_empty_trust_has_no_authority():
    module = trust_module()
    for value in (None, "", "[]"):
        assert not module.load_trust(value)


def test_valid_public_snapshots_are_loaded_without_network(http_signer, monkeypatch):
    import socket

    def refuse_network(*_args, **_kwargs):
        pytest.fail("public trust loader attempted network access")

    monkeypatch.setattr(socket.socket, "connect", refuse_network)
    values = trust_module().load_trust(json.dumps([trust_entry(http_signer, ISSUER)]))
    assert len(values) == 1


@pytest.mark.parametrize(
    "case",
    [
        "not-array",
        "entry-not-object",
        "missing-lane",
        "extra-field",
        "invalid-lane",
        "duplicate-issuer",
        "bool-expiry",
        "float-expiry",
        "string-expiry",
        "expired",
        "issuer-not-string",
        "generation-not-string",
        "jwks-not-object",
        "private-key",
        "duplicate-json-key",
        "duplicate-nested-key",
        "invalid-json",
        "too-many-entries",
        "too-many-utf8-bytes",
        "unknown-signing-algorithm",
    ],
)
def test_invalid_public_configuration_refuses_safely(http_signer, case):
    entry = trust_entry(http_signer, ISSUER)
    value = [copy.deepcopy(entry)]
    if case == "not-array":
        value = {"entries": value}
    elif case == "entry-not-object":
        value = [False]
    elif case == "missing-lane":
        del value[0]["lane"]
    elif case == "extra-field":
        value[0]["remote_url"] = "https://untrusted.invalid/keys"
    elif case == "invalid-lane":
        value[0]["lane"] = "operator"
    elif case == "duplicate-issuer":
        value.append(copy.deepcopy(entry))
    elif case in {"bool-expiry", "float-expiry", "string-expiry", "expired"}:
        value[0]["expires_at"] = {
            "bool-expiry": True,
            "float-expiry": float(NOW + 600),
            "string-expiry": str(NOW + 600),
            "expired": NOW - 1,
        }[case]
    elif case == "issuer-not-string":
        value[0]["issuer"] = 17
    elif case == "generation-not-string":
        value[0]["generation"] = True
    elif case == "jwks-not-object":
        value[0]["public_jwks"] = json.dumps(entry["public_jwks"])
    elif case == "private-key":
        value[0]["public_jwks"]["keys"][0]["d"] = "synthetic-private-sentinel"
    elif case == "too-many-entries":
        value = [trust_entry(http_signer, ISSUER + str(i)) for i in range(9)]
    elif case == "unknown-signing-algorithm":
        value[0]["public_jwks"]["keys"][0]["alg"] = "HS256"
    raw = json.dumps(value)
    if case == "duplicate-json-key":
        raw = raw.replace('"lane": "customer"', '"lane": "staff", "lane": "customer"')
    elif case == "duplicate-nested-key":
        raw = raw.replace('"kid": "same-owned-kid"', '"kid": "other", "kid": "same-owned-kid"')
    elif case == "invalid-json":
        raw = '["synthetic-private-sentinel"'
    elif case == "too-many-utf8-bytes":
        value[0]["generation"] = "é" * 128
        raw = json.dumps(value, ensure_ascii=False)
        raw = " " * (65536 - len(raw)) + raw
        assert len(raw) == 65536 and len(raw.encode("utf-8")) > 65536
    module = trust_module()
    with pytest.raises(module.TrustConfigurationError) as error:
        module.load_trust(raw)
    assert str(error.value) == "public trust configuration refused"
    assert error.value.__cause__ is None


def test_eight_entries_and_exact_byte_bound_have_a_positive_control(http_signer):
    entries = [trust_entry(http_signer, ISSUER + str(i)) for i in range(8)]
    raw = json.dumps(entries)
    raw += " " * (65536 - len(raw.encode("utf-8")))
    assert len(raw.encode("utf-8")) == 65536
    assert len(trust_module().load_trust(raw)) == 8


def test_customer_http_profile_loads_public_configuration_at_startup(http_signer):
    result = startup_probe(json.dumps([trust_entry(http_signer, ISSUER)]))
    assert result.returncode == 0, "customer HTTP profile did not initialize actual public trust"
    assert result.stdout.strip() == "PUBLIC_TRUST_ENTRIES 1"


def test_customer_http_profile_refuses_invalid_configuration_at_startup(http_signer):
    entry = trust_entry(http_signer, ISSUER)
    entry["lane"] = "synthetic-invalid-lane-sentinel"
    result = startup_probe(json.dumps([entry]))
    assert result.returncode == 2, "invalid public input did not refuse profile initialization"
    assert result.stdout.strip() == "PUBLIC_TRUST_REFUSED"
    if "synthetic-invalid-lane-sentinel" in result.stdout + result.stderr:
        pytest.fail("invalid public input was disclosed by profile initialization")


def startup_probe(raw):
    import os
    import subprocess
    import sys

    from customer_http_fixtures import ROOT

    assert (ROOT / "config/settings/customer_http.py").is_file(), (
        "explicit customer HTTP settings profile is not implemented"
    )
    # New interpreter exercises actual environment-to-settings initialization.
    # It blocks Python socket and Django connection entry points; no migrations run.
    code = """
import socket
import sys
import time
from datetime import UTC, datetime

import time_machine

def forbidden_connect(*args, **kwargs):
    raise AssertionError("configuration initialization attempted network")

socket.socket.connect = forbidden_connect
with time_machine.travel(datetime.fromtimestamp(int(sys.argv[1]), UTC), tick=False):
    assert time.time() == int(sys.argv[1])
    from django.db.backends.base.base import BaseDatabaseWrapper
    BaseDatabaseWrapper.ensure_connection = forbidden_connect
    from services.identity.trusted_issuers import TrustConfigurationError
    try:
        import django
        django.setup()
        from django.conf import settings
        print("PUBLIC_TRUST_ENTRIES", len(settings.KODERA_AUTH_TRUST))
    except Exception as error:
        if type(error) is TrustConfigurationError and str(error) == "public trust configuration refused":
            print("PUBLIC_TRUST_REFUSED")
            sys.exit(2)
        print("UNEXPECTED_INITIALIZATION_FAILURE")
        sys.exit(3)
"""
    return subprocess.run(  # noqa: S603 — fixed interpreter/code; synthetic data only in env
        [sys.executable, "-c", code, str(NOW)],
        cwd=ROOT,
        env={
            "PATH": os.defpath,
            "PYTHONPATH": str(ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": "config.settings.customer_http",
            "KODERA_AUTH_TRUST": raw,
        },
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
