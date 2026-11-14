"""contracts/served-operations.json is what the deployed API routes: dev/served_operations.py.

The file is the answer a consumer reads before it calls an operation: in the contract and not in
this file means Core answers 404, or 405 on a path routed for other methods. The first test fails
when the checked-in file is stale; the rest prove that check can fail, on each way it can go
stale, and that it names the operation.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path
from typing import Any

import django
import pytest
import yaml
from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.urls import include, path, re_path

from core.api.scopes import Operation, declares
from dev import served_operations as served

CONTRACT = served.ROOT / "contracts" / "core-api.openapi.yaml"
SHOWN = Operation(method="GET", operation_id="showThing", scope="thing:read")
MADE = Operation(method="POST", operation_id="makeThing", scope="thing:create")


@declares(SHOWN)
def shown(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(MADE)
def made(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation(method="GET", operation_id="probeAgent", scope="agent"))
def agent_only(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


def patterns(*, with_made: bool = True) -> list[Any]:
    routes = [path("things/<uuid:thing_id>", shown)]
    if with_made:
        routes.append(path("things", made))
    return [
        path("api/v1/", include(routes)),
        path("agent/v1/probe", agent_only),
        path("healthz", lambda request: HttpResponse()),
    ]


def current(**kwargs: bool) -> str:
    return served.document(patterns(**kwargs))


def test_the_checked_in_file_is_what_the_deployed_api_routes() -> None:
    patterns_now = importlib.import_module(served.deployed_urlconf()).urlpatterns
    actual = served.SERVED.read_text(encoding="utf-8")
    assert served.differences(served.document(patterns_now), actual) == [], (
        "contracts/served-operations.json is stale: run `uv run python dev/served_operations.py`"
    )


def test_the_deployed_urlconf_is_the_one_the_tests_route() -> None:
    assert served.deployed_urlconf() == "config.customer_urls"
    assert settings.ROOT_URLCONF == served.deployed_urlconf()


def test_every_listed_operation_is_in_the_contract_at_its_method_and_path() -> None:
    listed = json.loads(served.SERVED.read_text(encoding="utf-8"))["operations"]
    contract = yaml.safe_load(CONTRACT.read_text(encoding="utf-8"))
    declared = {
        (operation["operationId"], method.upper(), at)
        for at, item in contract["paths"].items()
        for method, operation in item.items()
        if isinstance(operation, dict) and "operationId" in operation
    }
    assert listed, "the file lists no operation"
    for row in listed:
        assert (row["operation_id"], row["method"], row["path"]) in declared, row


def test_check_exits_1_and_names_the_operation_on_a_stale_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    stale = json.loads(served.SERVED.read_text(encoding="utf-8"))
    dropped = stale["operations"].pop(0)
    target = tmp_path / "served-operations.json"
    target.write_text(json.dumps(stale), encoding="utf-8")
    monkeypatch.setattr(served, "SERVED", target)
    assert served.main(["served_operations.py", "--check"]) == 1
    assert capsys.readouterr().err == (
        "contracts/served-operations.json: served but not listed: "
        f"{dropped['operation_id']} ({dropped['method']} {dropped['path']})\n"
    )


def test_check_does_not_set_django_up_a_second_time(monkeypatch: pytest.MonkeyPatch) -> None:
    def again() -> None:
        raise AssertionError("django.setup() ran again: it would rebind the root log handler")

    monkeypatch.setattr(django, "setup", again)
    assert served.main(["served_operations.py", "--check"]) == 0


def test_only_api_routes_are_listed_with_their_contract_path() -> None:
    assert json.loads(current())["operations"] == [
        {"operation_id": "makeThing", "method": "POST", "path": "/things"},
        {"operation_id": "showThing", "method": "GET", "path": "/things/{thing_id}"},
    ]


def test_a_route_alias_collapses_into_its_canonical_contract_path() -> None:
    aliased_patterns = [
        *patterns(),
        path("api/v1/things-alias", made),
    ]
    doc = served.document(
        aliased_patterns,
        aliases={("api/v1/things-alias", "makeThing"): "/things"},
    )
    assert json.loads(doc)["operations"] == [
        {"operation_id": "makeThing", "method": "POST", "path": "/things"},
        {"operation_id": "showThing", "method": "GET", "path": "/things/{thing_id}"},
    ]


def test_a_regex_route_is_refused_not_skipped() -> None:
    with pytest.raises(ValueError, match=r"\^api/v1/things\$ is a regex route"):
        served.document([re_path(r"^api/v1/things$", made)])


def test_a_current_file_has_no_difference() -> None:
    assert served.differences(current(), current()) == []


def test_a_route_dropped_from_the_urlconf_names_its_operation() -> None:
    assert served.differences(current(with_made=False), current()) == [
        "listed but not served: makeThing (POST /things)"
    ]


def test_a_route_added_to_the_urlconf_names_its_operation() -> None:
    assert served.differences(current(), current(with_made=False)) == [
        "served but not listed: makeThing (POST /things)"
    ]


def test_an_entry_removed_by_hand_names_its_operation() -> None:
    edited = json.loads(current())
    edited["operations"] = [r for r in edited["operations"] if r["operation_id"] != "showThing"]
    assert served.differences(current(), json.dumps(edited)) == [
        "served but not listed: showThing (GET /things/{thing_id})"
    ]


def test_an_entry_added_by_hand_names_its_operation() -> None:
    edited = json.loads(current())
    edited["operations"].append({"operation_id": "dropThing", "method": "DELETE", "path": "/x"})
    assert served.differences(current(), json.dumps(edited)) == [
        "listed but not served: dropThing (DELETE /x)"
    ]


def test_a_path_changed_by_hand_names_both_sides() -> None:
    edited = json.loads(current())
    edited["operations"][0]["path"] = "/thing"
    assert served.differences(current(), json.dumps(edited)) == [
        "served but not listed: makeThing (POST /things)",
        "listed but not served: makeThing (POST /thing)",
    ]


def test_a_difference_in_form_only_still_fails() -> None:
    assert served.differences(current(), json.dumps(json.loads(current()))) == [
        "the file differs from the generated one in form only: regenerate it"
    ]


def test_a_file_that_is_not_json_fails() -> None:
    assert served.differences(current(), "{") == ["the file is not JSON: regenerate it"]


def test_a_file_whose_top_level_is_not_an_object_lists_nothing() -> None:
    assert served.differences(current(), "[]") == [
        "served but not listed: makeThing (POST /things)",
        "served but not listed: showThing (GET /things/{thing_id})",
    ]
