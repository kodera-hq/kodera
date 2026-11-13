"""Workspace schema is registered by the test/schema profiles and the customer HTTP profile only."""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization

from dev.e2e import make_trust

ROOT = Path(__file__).resolve().parents[1]
PROBE = """
import hashlib
import json
import sys
sys.path.insert(0, sys.argv[1])
if len(sys.argv) > 2:
    sys.path.insert(1, sys.argv[2])
from cryptography.hazmat.primitives import serialization
from django.db.backends.base.base import BaseDatabaseWrapper
def refuse_connection(*args, **kwargs):
    raise AssertionError("profile registration must not connect to a database")
BaseDatabaseWrapper.ensure_connection = refuse_connection
import django
django.setup()
from django.apps import apps
from django.conf import settings
print(json.dumps({
    "profile": settings.SETTINGS_MODULE,
    "loopback_issuers": getattr(settings, "KODERA_LOOPBACK_ISSUERS", None),
    "staff_issuer": getattr(settings, "KODERA_STAFF_ISSUER", None),
    "trust": [
        {
            "lane": entry.lane,
            "issuer": entry.snapshot.issuer,
            "generation": entry.snapshot.generation,
            "expires_at": entry.snapshot.expires_at,
            "keys": [
                {
                    "kid": key.kid,
                    "sha256": hashlib.sha256(key.public.public_bytes(
                        serialization.Encoding.DER,
                        serialization.PublicFormat.SubjectPublicKeyInfo,
                    )).hexdigest(),
                }
                for key in entry.snapshot._keys
            ],
        }
        for entry in getattr(settings, "KODERA_AUTH_TRUST", ())
    ],
    "apps": sorted(config.name for config in apps.get_app_configs()),
    "workspace_models": sorted(model.__name__ for model in apps.get_models()
                               if model._meta.app_label == "workspaces"),
}))
"""


@pytest.mark.parametrize(
    ("profile", "has_workspace"),
    [
        ("config.settings.test", True),
        ("config.settings.job_queue", True),
        ("config.settings.workspace_metadata_test", True),
        ("config.settings.dev", False),
        ("config.settings.customer_http", True),
        ("config.settings.e2e", True),
        ("config.settings.e2e_operator", True),
    ],
)
def test_workspace_registration_is_explicit_per_profile(profile, has_workspace):
    result = subprocess.run(  # noqa: S603 - fixed interpreter/probe and closed profile list
        [sys.executable, "-I", "-B", "-c", PROBE, str(ROOT)],
        cwd=ROOT,
        env={
            "PATH": os.environ.get("PATH", ""),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": profile,
            # Unused synthetic endpoint; the probe refuses every connection attempt.
            "DATABASE_URL": "postgres://synthetic:synthetic@127.0.0.1:1/kodera_server",
        },
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["profile"] == profile
    assert ("apps.workspaces" in report["apps"]) is has_workspace
    assert report["workspace_models"] == (
        [
            "Category",
            "Channel",
            "ChannelNotice",
            "ResourcePolicy",
            "ResourcePolicyRule",
            "WarmPoolAllocation",
            "Workspace",
            "WorkspaceAbuseReport",
            "WorkspaceInviteLink",
            "WorkspaceInviteRedemption",
            "WorkspaceMemberRestriction",
            "WorkspaceModerator",
        ]
        if has_workspace
        else []
    )


# The startup positive deliberately leaves the optional staff issuer unset: on the predecessor,
# customer_http must reach the trust guard, rather than fail earlier at the staff-issuer guard.
def loopback_startup(profile="config.settings.test", *, environment=None, root=ROOT):
    return subprocess.run(  # noqa: S603 - fixed interpreter/probe and explicit test inputs
        [sys.executable, "-I", "-B", "-c", PROBE, str(root), str(ROOT)],
        cwd=root,
        env={
            "PATH": os.defpath,
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": profile,
            "DATABASE_URL": "postgres://synthetic:synthetic@127.0.0.1:1/kodera_server",
            "KODERA_AUTH_TRUST": make_trust.trust_json(make_trust.DEFAULT_KEYCLOAK_ORIGIN),
            **(
                {
                    "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
                    "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
                }
                if profile == "config.settings.deploy"
                else {}
            ),
            **(environment or {}),
        },
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )


def assert_loopback_startup(result):
    assert result.returncode == 0, "LoopbackStartupTrustRefused\n" + result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["profile"] == "config.settings.test"
    assert report["loopback_issuers"] is True
    expected = []
    for realm in make_trust.REALMS:
        key = make_trust.signing_key(realm)
        expected.append(
            {
                "lane": make_trust.LANES[realm],
                "issuer": make_trust.issuer(make_trust.DEFAULT_KEYCLOAK_ORIGIN, realm),
                "generation": make_trust.GENERATION,
                "expires_at": make_trust.EXPIRES_AT,
                "keys": [
                    {
                        "kid": make_trust.key_id(key),
                        "sha256": hashlib.sha256(
                            key.public_key().public_bytes(
                                serialization.Encoding.DER,
                                serialization.PublicFormat.SubjectPublicKeyInfo,
                            )
                        ).hexdigest(),
                    }
                ],
            }
        )
    assert report["trust"] == expected
    # test.py intentionally overrides the validated staff input after persistence has loaded.
    assert report["staff_issuer"] == "https://identity.staff.test/realms/kodera-staff"
    assert "apps.workspaces" in report["apps"]


def test_test_profile_loopback_startup_loads_pinned_trust_without_database():
    assert_loopback_startup(loopback_startup())


def test_test_profile_loopback_startup_validates_staff_before_synthetic_override():
    staff = make_trust.issuer(make_trust.DEFAULT_KEYCLOAK_ORIGIN, make_trust.STAFF_REALM)
    assert_loopback_startup(loopback_startup(environment={"KODERA_STAFF_ISSUER": staff}))


@pytest.mark.parametrize("missing", [False, True], ids=["wrong-lane", "missing-issuer"])
def test_test_profile_loopback_startup_refuses_invalid_staff_binding(missing):
    entries = make_trust.trust_entries(make_trust.DEFAULT_KEYCLOAK_ORIGIN)
    if missing:
        entries = [entry for entry in entries if entry["lane"] != "staff"]
    else:
        for entry in entries:
            if entry["lane"] == "staff":
                entry["lane"] = "customer"
    result = loopback_startup(
        environment={
            "KODERA_AUTH_TRUST": json.dumps(entries),
            "KODERA_STAFF_ISSUER": make_trust.issuer(
                make_trust.DEFAULT_KEYCLOAK_ORIGIN, make_trust.STAFF_REALM
            ),
        }
    )
    assert result.returncode != 0 and not result.stdout
    assert result.stderr.strip().splitlines()[-1] == (
        "django.core.exceptions.ImproperlyConfigured: "
        "KODERA_STAFF_ISSUER is not on the staff lane of KODERA_AUTH_TRUST"
    )


@pytest.mark.parametrize("raw", ["{", "{}"], ids=["invalid-json", "wrong-shape"])
def test_test_profile_loopback_startup_refuses_malformed_trust(raw):
    result = loopback_startup(environment={"KODERA_AUTH_TRUST": raw})
    assert result.returncode != 0 and not result.stdout
    assert result.stderr.strip().splitlines()[-1] == (
        "services.identity.trusted_issuers.TrustConfigurationError: "
        "public trust configuration refused"
    )
