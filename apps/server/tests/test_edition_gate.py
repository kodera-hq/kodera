"""Open-core `KODERA_EDITION` boundary tests inside `apps/server`."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.test import Client, override_settings

from config.environment import edition

SERVER_ROOT = Path(__file__).resolve().parents[1]


def test_edition_parser_defaults_to_community_and_refuses_unknown_values() -> None:
    assert edition({}) == "community"
    assert edition({"KODERA_EDITION": ""}) == "community"
    assert edition({"KODERA_EDITION": "community"}) == "community"
    assert edition({"KODERA_EDITION": "enterprise"}) == "enterprise"
    for invalid in ("pro", "ENTERPRISE", "true", "1", "ee", "secret-sentinel"):
        with pytest.raises(ImproperlyConfigured) as caught:
            edition({"KODERA_EDITION": invalid})
        assert "secret-sentinel" not in str(caught.value)


def test_community_edition_refuses_ee_prefix_without_affecting_core_routes(monkeypatch) -> None:
    monkeypatch.delenv("KODERA_EDITION", raising=False)
    with override_settings(KODERA_EDITION="community"):
        client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
        ee_resp = client.get("/api/v1/ee/status")
        assert ee_resp.status_code == 403
        assert ee_resp["Content-Type"] == "application/json"
        assert ee_resp["Cache-Control"] == "no-store"
        assert ee_resp.json() == {
            "detail": "Enterprise Edition required",
            "code": "enterprise_edition_required",
        }
        assert ee_resp["X-Request-Id"]

        live_resp = client.get("/health/live")
        assert live_resp.status_code == 200


def test_server_contains_zero_static_imports_of_ee() -> None:
    offenders: list[str] = []
    for folder in ("apps", "config", "core", "services", "worker", "tenant_agent", "room_access"):
        base = SERVER_ROOT / folder
        if not base.is_dir():
            continue
        for py_file in sorted(base.rglob("*.py")):
            tree = ast.parse(py_file.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name == "ee" or alias.name.startswith("ee."):
                            offenders.append(f"{py_file.relative_to(SERVER_ROOT)}:{node.lineno}")
                elif isinstance(node, ast.ImportFrom) and node.module:
                    if node.module == "ee" or node.module.startswith("ee."):
                        offenders.append(f"{py_file.relative_to(SERVER_ROOT)}:{node.lineno}")
    assert offenders == [], f"open-source server contains static imports of ee/: {offenders}"
