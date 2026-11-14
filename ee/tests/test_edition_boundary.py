"""Open-Core Governance & `KODERA_EDITION` boundary tests (`GOVERNANCE.md` §1)."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest
from django.test import Client, override_settings
from django.urls import URLPattern, URLResolver, get_resolver

from ee.audit_export.ledger import default_audit_ledger
from ee.edition import (
    EnterpriseEditionRequiredError,
    edition_capabilities,
    require_enterprise_edition,
)
from ee.saml.service import default_saml_service
from ee.scim.service import default_scim_service

MONOREPO_ROOT = Path(__file__).resolve().parents[2]


def _walk_url_patterns(patterns: list[object], prefix: str = "/") -> list[str]:
    routes: list[str] = []
    for item in patterns:
        if isinstance(item, URLPattern):
            routes.append(prefix + str(item.pattern))
        elif isinstance(item, URLResolver):
            routes.extend(_walk_url_patterns(list(item.url_patterns), prefix + str(item.pattern)))
    return routes


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/v1/ee/status"),
        ("GET", "/api/v1/ee/sso/saml/acme/metadata"),
        ("POST", "/api/v1/ee/sso/saml/acme/acs"),
        ("GET", "/api/v1/ee/scim/v2/ServiceProviderConfig"),
        ("GET", "/api/v1/ee/scim/v2/Users"),
        ("POST", "/api/v1/ee/scim/v2/Users"),
        ("POST", "/api/v1/ee/compliance/audit-exports"),
        ("POST", "/api/v1/ee/compliance/audit-exports/verify"),
    ],
)
def test_community_edition_blocks_all_ee_endpoints_with_403(
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
) -> None:
    monkeypatch.delenv("KODERA_EDITION", raising=False)
    with override_settings(KODERA_EDITION="community"):
        client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
        fn = getattr(client, method.lower())
        resp = fn(path)
        assert resp.status_code == 403
        assert resp["Content-Type"] == "application/json"
        assert resp["Cache-Control"] == "no-store"
        assert resp.json() == {
            "detail": "Enterprise Edition required",
            "code": "enterprise_edition_required",
        }


def test_enterprise_edition_enables_ee_status_and_unknown_ee_subpath_returns_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    with override_settings(KODERA_EDITION="enterprise"):
        client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
        resp = client.get("/api/v1/ee/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["edition"] == "enterprise"
        assert body["enterprise_enabled"] is True
        assert body["license"] == "LicenseRef-Kodera-EE"
        assert set(body["modules"]) == {"saml", "scim", "audit_export"}

        not_found = client.get("/api/v1/ee/unknown-module")
        assert not_found.status_code == 404
        assert not_found.json()["code"] == "not_found"

        scim_not_found = client.get("/api/v1/ee/scim/v2/NonExistentResource")
        assert scim_not_found.status_code == 404
        assert scim_not_found["Content-Type"] == "application/scim+json"
        assert scim_not_found.json()["schemas"] == ["urn:ietf:params:scim:api:messages:2.0:Error"]


def test_service_entrypoints_enforce_enterprise_edition_in_depth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KODERA_EDITION", "community")
    with override_settings(KODERA_EDITION="community"):
        assert edition_capabilities()["enterprise_enabled"] is False
        with pytest.raises(EnterpriseEditionRequiredError):
            require_enterprise_edition()
        with pytest.raises(EnterpriseEditionRequiredError):
            default_saml_service.build_sp_metadata_xml("acme", "https://api.kodera.io")
        with pytest.raises(EnterpriseEditionRequiredError):
            default_scim_service.tokens.issue_token(tenant_slug="acme")
        with pytest.raises(EnterpriseEditionRequiredError):
            default_audit_ledger.append_event(
                tenant_slug="acme",
                actor_type="customer_user",
                actor_id="u-1",
                action="org.read",
                target_urn="urn:kodera:org:acme",
            )


def test_open_core_boundary_zero_core_routes_require_enterprise_and_zero_ee_imports(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prove no open-source package imports `ee/` and no core route is gated on `enterprise`."""
    offenders: list[str] = []
    for open_source_dir in ("apps", "packages", "extensions", "deploy/community"):
        base = MONOREPO_ROOT / open_source_dir
        if not base.is_dir():
            continue
        for py_path in sorted(base.rglob("*.py")):
            if "/tests/" in py_path.as_posix() and py_path.name == "test_edition_gate.py":
                continue
            tree = ast.parse(py_path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name == "ee" or alias.name.startswith("ee."):
                            offenders.append(f"{py_path.relative_to(MONOREPO_ROOT)}:{node.lineno}")
                elif isinstance(node, ast.ImportFrom) and node.module:
                    if node.module == "ee" or node.module.startswith("ee."):
                        offenders.append(f"{py_path.relative_to(MONOREPO_ROOT)}:{node.lineno}")
    assert offenders == [], f"Open-source code must never import ee/: {offenders}"

    # Verify customer_urls and config.urls contain zero /api/v1/ee routes and work identically in community mode.
    for urlconf in ("config.urls", "config.customer_urls"):
        resolver = get_resolver(urlconf)
        routes = _walk_url_patterns(list(resolver.url_patterns))
        assert routes, f"Expected non-empty routes in {urlconf}"
        assert not any(r.startswith("/api/v1/ee") for r in routes)

    monkeypatch.setenv("KODERA_EDITION", "community")
    with override_settings(KODERA_EDITION="community", ROOT_URLCONF="config.urls"):
        client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
        live = client.get("/health/live")
        assert live.status_code == 200
        assert (
            live.content
            != b'{"detail": "Enterprise Edition required", "code": "enterprise_edition_required"}'
        )
