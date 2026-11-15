"""Every routed view declares a scope: docs/dev/PROJECT_LAYOUT.md §2, docs/api/AUTHZ.md §5.

A view is every callable a URL pattern reaches, through any depth of include(), DRF or plain
Django, function or class, in every urlconf a settings module of config/settings/ names as its
ROOT_URLCONF. A view declares, with core.api.scopes.declares, one Operation per HTTP method it
serves: the method, the operationId and the `x-kodera-scope` of that operation in
contracts/core-api.openapi.yaml. A route under `agent/v1/` is held to
contracts/agent-api.openapi.yaml instead: its operations carry no scope, so the view declares the
scope `agent`, and the operation's `x-kodera-authz` must admit that role.

The check fails on a routed view that declares nothing; on a scope that is not `<resource>:<verb>`,
whose resource is not a row of the AUTHZ.md §5 matrix or whose verb is not in its closed verb set;
on an operationId the contract does not have; on a scope, method or path that differs from the
contract's for that operation; and on a DRF or Django class-based view or viewset that accepts a
method it declares no operation for. Urlconfs are imported once, under the test settings.

The exemption is a closed list, EXEMPT, of routes and the view each reaches, for views with no
principal at all. The check holds each entry to it: a DRF view, AllowAny and nothing else, no
authentication class, no declaration, GET only, and routed at that route by some urlconf. An
undeclared AllowAny view, or an exempt view routed at another route, is not exempt; it fails as a
view without a scope. Outside the list no permission or authentication class is read.

One class routed at several paths is held at each route to all of its operations, so it fails
rather than passes until the check is extended for it.
A settings module whose ROOT_URLCONF is not a string literal fails too, rather than being skipped.

Not seen: the methods a plain function view handles, which only its body knows, so a function view
is held to the operations it declares; that includes a function wrapping a class view without
keeping its `view_class` or `cls`, whose class methods are then out of sight; a method a class
serves other than through a handler on the class (an overridden dispatch, http_method_names passed
to as_view(), a handler set on the instance); a method added by a
decorator built with functools.wraps above `declares`, which copies the mark to its wrapper; a
route a urlconf adds only under other settings; a urlconf a middleware selects through
request.urlconf; a urlconf's handler400, handler403, handler404 and handler500, which no pattern
reaches; a ROOT_URLCONF set other than by assignment (through
globals(), or from outside config/settings/); where an Operation is defined, which by convention
is its application's api/permissions.py; the roles of `x-kodera-authz`, which the declaration
does not carry; and whether the running permission layer enforces the declared scope, which is the
runtime half of AUTHZ.md §5 and is not built.
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
import re
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from types import ModuleType
from typing import Any, NamedTuple

from django.http import HttpRequest, HttpResponse
from django.test import RequestFactory
from django.urls import URLResolver, include, path, re_path
from django.urls.resolvers import LocalePrefixPattern
from django.views import View
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.views import APIView
from rest_framework.viewsets import ViewSet

from core.api.scopes import Operation, declares
from dev.served_operations import (
    API_PREFIX,
    Route,
    contract_path as _contract_path,
    declared as _declared,
    owner as _owner,
    routes,
)

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = ROOT / "config" / "settings"
AUTHZ = ROOT / "docs" / "api" / "AUTHZ.md"
CONTRACT = ROOT / "contracts" / "core-api.openapi.yaml"
# Routes under the Agent API's prefix are held to contracts/agent-api.openapi.yaml instead. Its
# operations carry no x-kodera-scope: their principal is the tenant agent, which a view declares as
# the scope `agent`, and the operation's x-kodera-authz must admit that role.
AGENT_CONTRACT = ROOT / "contracts" / "agent-api.openapi.yaml"
AGENT_PREFIX = "agent/v1/"
AGENT_SCOPE = "agent"
STAFF_CONTRACT = ROOT / "contracts" / "staff-api.openapi.yaml"
STAFF_PREFIX = "staff/v1/"
STAFF_SCOPE = "staff"
STAFF_ALLOWED_ROLES = frozenset(
    {
        "staff_owner",
        "staff_operator",
        "staff_security",
        "staff_support",
        "staff_growth",
        "staff_backend",
        "staff_frontend",
    }
)

# Views with no principal: their whole purpose is to answer before anyone authenticates. An entry
# is a route and the view it reaches, so an exempt view routed anywhere else is not exempt there.
EXEMPT: Mapping[tuple[str, str], str] = {
    ("health/live", "core.health.live"): "liveness probe, AllowAny, no principal",
    ("health/ready", "core.health.ready"): "readiness probe, AllowAny, no principal",
    (
        ".well-known/apple-app-site-association",
        "core.well_known.apple_app_site_association",
    ): "Apple Universal Links association, AllowAny, no principal",
    (
        ".well-known/assetlinks.json",
        "core.well_known.assetlinks",
    ): "Android App Links association, AllowAny, no principal",
}


def _authz_matrix() -> ModuleType:
    name = "check_authz_matrix"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "scripts" / "ci" / "check-authz-matrix.py"
    )
    assert spec is not None and spec.loader is not None, "no check-authz-matrix.py"
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class ContractOperation(NamedTuple):
    method: str
    path: str
    scope: str | None


class AgentOperation(NamedTuple):
    method: str
    path: str
    roles: frozenset[str]


class StaffOperation(NamedTuple):
    method: str
    path: str
    roles: frozenset[str]


class Reference(NamedTuple):
    resources: frozenset[str]
    verbs: frozenset[str]
    operations: Mapping[str, ContractOperation]
    agent_operations: Mapping[str, AgentOperation]
    staff_operations: Mapping[str, StaffOperation]


def reference() -> Reference:
    authz = _authz_matrix()
    operations = {}
    for operation_id, method_and_path, scope, _roles in authz.parse_operations(CONTRACT):
        method, _, route = method_and_path.partition(" ")
        operations[operation_id] = ContractOperation(method, route, scope)
    agent_operations = {}
    for operation_id, method_and_path, _scope, roles in authz.parse_operations(AGENT_CONTRACT):
        method, _, route = method_and_path.partition(" ")
        agent_operations[operation_id] = AgentOperation(method, route, frozenset(roles or ()))
    staff_operations = {}
    for operation_id, method_and_path, _scope, roles in authz.parse_operations(STAFF_CONTRACT):
        method, _, route = method_and_path.partition(" ")
        staff_operations[operation_id] = StaffOperation(method, route, frozenset(roles or ()))
    return Reference(
        resources=frozenset(authz.Matrix(AUTHZ).cells),
        verbs=frozenset(authz.CLOSED_VERBS),
        operations=operations,
        agent_operations=agent_operations,
        staff_operations=staff_operations,
    )


def urlconfs(settings: Path = SETTINGS) -> tuple[list[str], list[str]]:
    """Every module a settings module names as its ROOT_URLCONF, and each name it cannot read."""
    found: set[str] = set()
    unreadable: list[str] = []
    for module in sorted(settings.glob("*.py")):
        for node in ast.walk(ast.parse(module.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Assign):
                targets = node.targets
            elif isinstance(node, ast.AnnAssign | ast.AugAssign):
                targets = [node.target]
            else:
                continue
            names = {n.id for t in targets for n in ast.walk(t) if isinstance(n, ast.Name)}
            if "ROOT_URLCONF" not in names:
                continue
            value = node.value
            if (
                not isinstance(node, ast.AugAssign)
                and isinstance(value, ast.Constant)
                and value.value is None
            ):
                continue  # a command-only profile serves no urlconf
            if (
                isinstance(node, ast.AugAssign)
                or not all(isinstance(t, ast.Name) for t in targets)
                or not isinstance(value, ast.Constant)
                or not isinstance(value.value, str)
            ):
                unreadable.append(
                    f"{module.name}:{node.lineno} assigns ROOT_URLCONF a value this check cannot "
                    "read; assign it a string literal"
                )
            else:
                found.add(value.value)
    return sorted(found), unreadable


def view_name(callback: Callable[..., Any]) -> str:
    owner = _owner(callback)
    return f"{owner.__module__}.{owner.__name__}"


def _accepted_methods(callback: Callable[..., Any]) -> set[str] | None:
    """The methods a class view answers; None for a function view, whose body alone knows.

    A class answers each method it has a handler for, except OPTIONS when the handler is the one
    Django or DRF provides. HEAD is counted only when the class defines it: Django falls back to
    GET at request time, not on the class. A viewset answers those and the methods of its action
    map, since DRF dispatches on both; a HEAD the map aliases to its GET action is the same
    fallback, which DRF writes into the map on the view's first request.
    """
    cls = getattr(callback, "view_class", None) or getattr(callback, "cls", None)
    if cls is None:
        return None
    accepted = {m.upper() for m in cls.http_method_names if hasattr(cls, m)}
    if getattr(cls, "options", None) in (View.options, APIView.options):
        accepted.discard("OPTIONS")
    actions = dict(getattr(callback, "actions", None) or {})
    if "get" in actions and actions.get("head") == actions["get"]:
        del actions["head"]
    return accepted | {method.upper() for method in actions}


def _exempt_failures(where: str, callback: Callable[..., Any]) -> list[str]:
    cls = getattr(callback, "cls", None)
    if cls is None:
        return [f"{where} is exempt but is not a DRF view, so its permission cannot be read"]
    failures = []
    if list(cls.permission_classes) != [AllowAny]:
        failures.append(f"{where} is exempt but its permission classes are not exactly AllowAny")
    if list(cls.authentication_classes) != []:
        failures.append(f"{where} is exempt but authenticates a principal")
    if _declared(callback) is not None:
        failures.append(f"{where} is exempt but declares operations; remove it from EXEMPT")
    if _accepted_methods(callback) != {"GET"}:
        failures.append(f"{where} is exempt but accepts more than GET")
    return failures


def _agent_operation_failures(where: str, route: str, op: Operation, ref: Reference) -> list[str]:
    failures = []
    if op.scope != AGENT_SCOPE:
        failures.append(
            f"{where} declares scope {op.scope!r} for {op.operation_id}; an Agent API operation "
            f"declares {AGENT_SCOPE!r}"
        )
    contract = ref.agent_operations.get(op.operation_id)
    if contract is None:
        failures.append(
            f"{where} declares operation {op.operation_id!r}, which "
            "contracts/agent-api.openapi.yaml does not have"
        )
        return failures
    if AGENT_SCOPE not in contract.roles:
        failures.append(
            f"{where} serves {op.operation_id}, whose x-kodera-authz does not admit the agent"
        )
    served = (op.method.upper(), "/" + re.sub(r"<(?:\w+:)?(\w+)>", r"{\1}", route))
    if served != (contract.method, contract.path):
        failures.append(
            f"{where} serves {op.operation_id} as {served[0]} {served[1]}; "
            f"the contract has it at {contract.method} {contract.path}"
        )
    return failures


def _staff_operation_failures(where: str, route: str, op: Operation, ref: Reference) -> list[str]:
    failures = []
    if op.scope != STAFF_SCOPE:
        failures.append(
            f"{where} declares scope {op.scope!r} for {op.operation_id}; a Staff API operation "
            f"declares {STAFF_SCOPE!r}"
        )
    contract = ref.staff_operations.get(op.operation_id)
    if contract is None:
        failures.append(
            f"{where} declares operation {op.operation_id!r}, which "
            "contracts/staff-api.openapi.yaml does not have"
        )
        return failures
    if not contract.roles or not (contract.roles <= STAFF_ALLOWED_ROLES):
        failures.append(
            f"{where} serves {op.operation_id}, whose x-kodera-authz does not declare valid staff roles"
        )
    served = (op.method.upper(), "/" + re.sub(r"<(?:\w+:)?(\w+)>", r"{\1}", route))
    if served != (contract.method, contract.path):
        failures.append(
            f"{where} serves {op.operation_id} as {served[0]} {served[1]}; "
            f"the contract has it at {contract.method} {contract.path}"
        )
    return failures


def _operation_failures(where: str, route: str, op: Operation, ref: Reference) -> list[str]:
    if route.startswith(AGENT_PREFIX):
        return _agent_operation_failures(where, route, op, ref)
    if route.startswith(STAFF_PREFIX):
        return _staff_operation_failures(where, route, op, ref)
    shape = re.fullmatch(r"([a-z][a-z_]*):([a-z]+)", op.scope)
    if shape is None:
        return [f"{where} declares scope {op.scope!r} for {op.operation_id}, not <resource>:<verb>"]
    failures = []
    resource, verb = shape.groups()
    if resource not in ref.resources:
        failures.append(
            f"{where} declares scope {op.scope!r}: resource `{resource}` is not a row of "
            "the AUTHZ.md §5 matrix"
        )
    if verb not in ref.verbs:
        failures.append(
            f"{where} declares scope {op.scope!r}: verb `{verb}` is not in the closed verb set "
            "of AUTHZ.md §5"
        )
    contract = ref.operations.get(op.operation_id)
    if contract is None:
        failures.append(
            f"{where} declares operation {op.operation_id!r}, which "
            "contracts/core-api.openapi.yaml does not have"
        )
        return failures
    if contract.scope != op.scope:
        failures.append(
            f"{where} declares scope {op.scope!r} for {op.operation_id}; the contract's "
            f"x-kodera-scope is {contract.scope!r}"
        )
    served = (op.method.upper(), _contract_path(route))
    if served != (contract.method, contract.path):
        failures.append(
            f"{where} serves {op.operation_id} as {op.method.upper()} "
            f"{served[1] or '(outside ' + API_PREFIX + ')'}; the contract has it at "
            f"{contract.method} {contract.path}"
        )
    return failures


def scope_failures(
    found: list[Route], ref: Reference, exempt: Mapping[tuple[str, str], str] = EXEMPT
) -> list[str]:
    """Every way a routed view fails to declare its contract scope, one line each."""
    if not found:
        return ["no routed view found; the check would pass on an empty urlconf"]
    failures: list[str] = []
    for route in found:
        name = view_name(route.callback)
        where = f"{route.urlconf}: {route.route} -> {name}"
        if (route.route, name) in exempt:
            failures += _exempt_failures(where, route.callback)
            continue
        operations = _declared(route.callback)
        if not operations:
            failures.append(
                f"{where} declares no scope; decorate it with core.api.scopes.declares, "
                "or add it to EXEMPT if it has no principal"
            )
            continue
        methods = [op.method.upper() for op in operations]
        for method in sorted({m for m in methods if methods.count(m) > 1}):
            failures.append(f"{where} declares {method} more than once")
        for op in operations:
            failures += _operation_failures(where, route.route, op, ref)
        accepted = _accepted_methods(route.callback)
        for method in sorted((accepted or set()) - set(methods)):
            failures.append(f"{where} accepts {method} but declares no operation for it")
    routed = {(route.route, view_name(route.callback)) for route in found}
    for at, name in sorted(set(exempt) - routed):
        failures.append(
            f"exempt view {name} is not routed at {at} by any urlconf; remove it from EXEMPT"
        )
    return failures


def test_settings_name_the_urlconfs_the_api_is_served_from() -> None:
    found, unreadable = urlconfs()
    assert unreadable == [], "a settings module names a urlconf this check cannot read"
    assert {"config.urls", "config.customer_urls"} <= set(found), found


def test_every_routed_view_declares_its_contract_scope() -> None:
    modules = {name: importlib.import_module(name).urlpatterns for name in urlconfs()[0]}
    found, unreadable = routes(modules)
    assert unreadable == [], "a route cannot be read"
    assert scope_failures(found, reference()) == [], "a routed view does not declare its scope"


# Fixture views: each is the smallest view that breaks one rule.


@declares(Operation("GET", "getMe", "identity:read"))
def scoped(request: HttpRequest) -> HttpResponse:
    """Positive control: the declaration the real `me` view makes."""
    return HttpResponse()


def unscoped(request: HttpRequest) -> HttpResponse:
    """No declaration at all."""
    return HttpResponse()


@declares(Operation("GET", "getMe", "identity:peek"))
def unknown_verb(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("GET", "getMe", "widget:read"))
def unknown_resource(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("GET", "getMe", "identity"))
def malformed(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("GET", "getMe", "identity:update"))
def not_the_contracts(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("GET", "getMyself", "identity:read"))
def unknown_operation(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("PATCH", "getMe", "identity:read"))
def wrong_method(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("GET", "getMe", "identity:read"), Operation("get", "getMe", "identity:read"))
def twice(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("GET", "getMe", "identity:read"))
@api_view(["GET", "PATCH"])
def undeclared_method(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def anonymous(request: HttpRequest) -> HttpResponse:
    """A new AllowAny view, not on the exemption list."""
    return HttpResponse()


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def authenticated(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


class UnscopedClassView(View):
    def get(self, request: HttpRequest) -> HttpResponse:
        return HttpResponse()


@declares(Operation("GET", "getMe", "identity:read"))
@api_view(["GET"])
def drf_scoped(request: HttpRequest) -> HttpResponse:
    """Positive control: DRF's own OPTIONS handler needs no declaration."""
    return HttpResponse()


@declares(Operation("GET", "getMe", "identity:read"))
class ExplicitHeadAndOptions(View):
    def get(self, request: HttpRequest) -> HttpResponse:
        return HttpResponse()

    def head(self, request: HttpRequest) -> HttpResponse:
        return HttpResponse()

    def options(self, request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
        return HttpResponse()


@declares(Operation("GET", "getMe", "identity:read"))
class UndeclaredAction(ViewSet):
    def retrieve(self, request: HttpRequest) -> HttpResponse:
        return HttpResponse()

    def create(self, request: HttpRequest) -> HttpResponse:
        return HttpResponse()


@api_view(["GET"])
@authentication_classes([SessionAuthentication])
@permission_classes([AllowAny])
def authenticating(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("GET", "getMe", "identity:read"))
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def declaring(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@api_view(["GET"])
@declares(Operation("GET", "getMe", "identity:read"))
def declared_inside(request: HttpRequest) -> HttpResponse:
    """`declares` under `api_view`: the mark is on the function DRF wraps, not on the view."""
    return HttpResponse()


@declares(Operation("GET", "getMe", "identity:read"))
class DeclaredClassView(View):
    """Positive control: Django's own OPTIONS handler needs no declaration."""

    def get(self, request: HttpRequest) -> HttpResponse:
        return HttpResponse()


@declares(Operation("GET", "getOrganisation", "organisation:read"))
def organisation(request: HttpRequest, organisation_id: Any) -> HttpResponse:
    """Positive control: a path converter maps to the contract's path parameter."""
    return HttpResponse()


@declares(Operation("GET", "getMe", "identity:read"))
class DirectHandler(ViewSet):
    def retrieve(self, request: HttpRequest) -> HttpResponse:
        return HttpResponse()

    def delete(self, request: HttpRequest) -> HttpResponse:
        return HttpResponse()


@api_view(["GET", "POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def writable_probe(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("GET", "getCommands", "agent"))
def agent_commands(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("POST", "ackCommand", "agent"))
def agent_ack(request: HttpRequest, command_id: Any) -> HttpResponse:
    return HttpResponse()


@declares(Operation("GET", "getCommands", "identity:read"))
def agent_with_a_customer_scope(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("GET", "getMe", "agent"))
def agent_route_serving_a_customer_operation(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("GET", "getStaffOverview", "staff"))
def staff_overview_fixture(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("GET", "getStaffOverview", "identity:read"))
def staff_with_customer_scope(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


@declares(Operation("GET", "getMe", "staff"))
def staff_serving_customer_operation(request: HttpRequest) -> HttpResponse:
    return HttpResponse()


def _check(*patterns: Any, exempt: Mapping[tuple[str, str], str] | None = None) -> list[str]:
    found, unreadable = routes({"fixture": list(patterns)})
    return unreadable + scope_failures(found, reference(), {} if exempt is None else exempt)


HERE = __name__


def test_a_declared_view_matching_the_contract_passes() -> None:
    assert _check(path("api/v1/me", scoped)) == []
    assert _check(path("api/v1/me", drf_scoped)) == []
    assert _check(path("api/v1/me", DeclaredClassView.as_view())) == []
    assert _check(path("api/v1/organisations/<uuid:organisation_id>", organisation)) == []


def test_the_check_names_a_routed_view_without_a_scope() -> None:
    assert _check(path("api/v1/me", unscoped)) == [
        f"fixture: api/v1/me -> {HERE}.unscoped declares no scope; decorate it with "
        "core.api.scopes.declares, or add it to EXEMPT if it has no principal"
    ]


def test_the_check_reaches_views_through_include_and_class_views() -> None:
    nested = include([path("me", UnscopedClassView.as_view())])
    assert _check(path("api/v1/", nested)) == [
        f"fixture: api/v1/me -> {HERE}.UnscopedClassView declares no scope; decorate it with "
        "core.api.scopes.declares, or add it to EXEMPT if it has no principal"
    ]


def test_the_check_names_a_scope_with_an_unknown_verb() -> None:
    assert _check(path("api/v1/me", unknown_verb)) == [
        f"fixture: api/v1/me -> {HERE}.unknown_verb declares scope 'identity:peek': "
        "verb `peek` is not in the closed verb set of AUTHZ.md §5",
        f"fixture: api/v1/me -> {HERE}.unknown_verb declares scope 'identity:peek' for getMe; "
        "the contract's x-kodera-scope is 'identity:read'",
    ]


def test_the_check_names_a_scope_whose_resource_is_not_a_matrix_row() -> None:
    assert _check(path("api/v1/me", unknown_resource)) == [
        f"fixture: api/v1/me -> {HERE}.unknown_resource declares scope 'widget:read': "
        "resource `widget` is not a row of the AUTHZ.md §5 matrix",
        f"fixture: api/v1/me -> {HERE}.unknown_resource declares scope 'widget:read' for getMe; "
        "the contract's x-kodera-scope is 'identity:read'",
    ]


def test_the_check_names_a_scope_that_is_not_resource_and_verb() -> None:
    assert _check(path("api/v1/me", malformed)) == [
        f"fixture: api/v1/me -> {HERE}.malformed declares scope 'identity' for getMe, "
        "not <resource>:<verb>"
    ]


def test_the_check_names_a_scope_that_differs_from_the_contract() -> None:
    assert _check(path("api/v1/me", not_the_contracts)) == [
        f"fixture: api/v1/me -> {HERE}.not_the_contracts declares scope 'identity:update' "
        "for getMe; the contract's x-kodera-scope is 'identity:read'"
    ]


def test_the_check_names_an_operation_the_contract_does_not_have() -> None:
    assert _check(path("api/v1/me", unknown_operation)) == [
        f"fixture: api/v1/me -> {HERE}.unknown_operation declares operation 'getMyself', "
        "which contracts/core-api.openapi.yaml does not have"
    ]


def test_the_check_names_a_method_or_path_that_differs_from_the_contract() -> None:
    assert _check(path("api/v1/me", wrong_method), path("api/v1/you", scoped)) == [
        f"fixture: api/v1/me -> {HERE}.wrong_method serves getMe as PATCH /me; "
        "the contract has it at GET /me",
        f"fixture: api/v1/you -> {HERE}.scoped serves getMe as GET /you; "
        "the contract has it at GET /me",
    ]
    assert _check(path("me", scoped)) == [
        f"fixture: me -> {HERE}.scoped serves getMe as GET (outside api/v1/); "
        "the contract has it at GET /me"
    ]


def test_an_agent_route_matching_the_agent_contract_passes() -> None:
    assert (
        _check(
            path("agent/v1/commands", agent_commands),
            path("agent/v1/commands/<uuid:command_id>/ack", agent_ack),
        )
        == []
    )


def test_an_agent_route_is_held_to_the_agent_contract_not_the_customer_one() -> None:
    assert _check(path("agent/v1/commands", agent_with_a_customer_scope)) == [
        f"fixture: agent/v1/commands -> {HERE}.agent_with_a_customer_scope declares scope "
        "'identity:read' for getCommands; an Agent API operation declares 'agent'"
    ]
    assert _check(path("agent/v1/me", agent_route_serving_a_customer_operation)) == [
        f"fixture: agent/v1/me -> {HERE}.agent_route_serving_a_customer_operation declares "
        "operation 'getMe', which contracts/agent-api.openapi.yaml does not have"
    ]
    # And a customer route cannot serve an Agent API operation.
    assert _check(path("api/v1/commands", agent_commands)) == [
        f"fixture: api/v1/commands -> {HERE}.agent_commands declares scope 'agent' for "
        "getCommands, not <resource>:<verb>"
    ]


def test_an_agent_route_at_another_path_or_method_than_the_contract_s_fails() -> None:
    assert _check(path("agent/v1/command", agent_commands)) == [
        f"fixture: agent/v1/command -> {HERE}.agent_commands serves getCommands as "
        "GET /agent/v1/command; the contract has it at GET /agent/v1/commands"
    ]


def test_an_agent_operation_the_contract_does_not_admit_the_agent_to_fails() -> None:
    ref = reference()
    closed = {**ref.agent_operations}
    closed["getCommands"] = closed["getCommands"]._replace(roles=frozenset({"staff"}))
    found, _ = routes({"fixture": [path("agent/v1/commands", agent_commands)]})
    assert scope_failures(found, ref._replace(agent_operations=closed), {}) == [
        f"fixture: agent/v1/commands -> {HERE}.agent_commands serves getCommands, whose "
        "x-kodera-authz does not admit the agent"
    ]


def test_a_staff_route_matching_the_staff_contract_and_failing_mutations() -> None:
    assert _check(path("staff/v1/read/overview", staff_overview_fixture)) == []
    assert _check(path("staff/v1/read/overview", staff_with_customer_scope)) == [
        f"fixture: staff/v1/read/overview -> {HERE}.staff_with_customer_scope declares scope "
        "'identity:read' for getStaffOverview; a Staff API operation declares 'staff'"
    ]
    assert _check(path("staff/v1/read/overview", staff_serving_customer_operation)) == [
        f"fixture: staff/v1/read/overview -> {HERE}.staff_serving_customer_operation declares "
        "operation 'getMe', which contracts/staff-api.openapi.yaml does not have"
    ]
    ref = reference()
    closed = {**ref.staff_operations}
    closed["getStaffOverview"] = closed["getStaffOverview"]._replace(roles=frozenset({"org_owner"}))
    found, _ = routes({"fixture": [path("staff/v1/read/overview", staff_overview_fixture)]})
    assert scope_failures(found, ref._replace(staff_operations=closed), {}) == [
        f"fixture: staff/v1/read/overview -> {HERE}.staff_overview_fixture serves "
        "getStaffOverview, whose x-kodera-authz does not declare valid staff roles"
    ]


def test_the_check_names_a_method_declared_twice() -> None:
    assert _check(path("api/v1/me", twice)) == [
        f"fixture: api/v1/me -> {HERE}.twice declares GET more than once"
    ]


def test_the_check_names_a_method_a_class_view_accepts_without_declaring_it() -> None:
    assert _check(path("api/v1/me", undeclared_method)) == [
        f"fixture: api/v1/me -> {HERE}.undeclared_method accepts PATCH but declares "
        "no operation for it"
    ]


def test_the_check_names_head_and_options_a_class_defines_without_declaring_them() -> None:
    assert _check(path("api/v1/me", ExplicitHeadAndOptions.as_view())) == [
        f"fixture: api/v1/me -> {HERE}.ExplicitHeadAndOptions accepts HEAD but declares "
        "no operation for it",
        f"fixture: api/v1/me -> {HERE}.ExplicitHeadAndOptions accepts OPTIONS but declares "
        "no operation for it",
    ]


def test_the_check_names_a_handler_a_viewset_defines_outside_its_action_map() -> None:
    assert _check(path("api/v1/me", DirectHandler.as_view({"get": "retrieve"}))) == [
        f"fixture: api/v1/me -> {HERE}.DirectHandler accepts DELETE but declares "
        "no operation for it"
    ]


def test_a_viewset_reads_the_same_before_and_after_its_first_request() -> None:
    view = UndeclaredAction.as_view({"get": "retrieve", "post": "create"})
    expected = [
        f"fixture: api/v1/me -> {HERE}.UndeclaredAction accepts POST but declares "
        "no operation for it"
    ]
    assert _check(path("api/v1/me", view)) == expected
    view(RequestFactory().get("/api/v1/me"))
    assert getattr(view, "actions", {}).get("head") == "retrieve", (
        "DRF no longer aliases HEAD in the map"
    )
    assert _check(path("api/v1/me", view)) == expected


def test_the_check_names_a_viewset_action_without_a_declaration() -> None:
    view = UndeclaredAction.as_view({"get": "retrieve", "post": "create"})
    assert _check(path("api/v1/me", view)) == [
        f"fixture: api/v1/me -> {HERE}.UndeclaredAction accepts POST but declares "
        "no operation for it"
    ]


def test_a_declaration_under_another_decorator_is_not_seen_and_fails_closed() -> None:
    assert _check(path("api/v1/me", declared_inside)) == [
        f"fixture: api/v1/me -> {HERE}.declared_inside declares no scope; decorate it with "
        "core.api.scopes.declares, or add it to EXEMPT if it has no principal"
    ]


def test_a_new_allow_any_view_is_not_exempt() -> None:
    assert _check(path("health/new", anonymous)) == [
        f"fixture: health/new -> {HERE}.anonymous declares no scope; decorate it with "
        "core.api.scopes.declares, or add it to EXEMPT if it has no principal"
    ]


def test_the_check_holds_each_exempt_view_to_the_exemption() -> None:
    exempt = {
        ("a", f"{HERE}.authenticated"): "fixture",
        ("b", f"{HERE}.unscoped"): "fixture",
        ("c", f"{HERE}.authenticating"): "fixture",
        ("d", f"{HERE}.declaring"): "fixture",
        ("e", f"{HERE}.anonymous"): "fixture",
        ("f", f"{HERE}.gone"): "fixture",
        ("g", f"{HERE}.writable_probe"): "fixture",
    }
    assert _check(
        path("a", authenticated),
        path("b", unscoped),
        path("c", authenticating),
        path("d", declaring),
        path("e", anonymous),
        path("g", writable_probe),
        exempt=exempt,
    ) == [
        f"fixture: a -> {HERE}.authenticated is exempt but its permission classes are not "
        "exactly AllowAny",
        f"fixture: b -> {HERE}.unscoped is exempt but is not a DRF view, so its permission "
        "cannot be read",
        f"fixture: c -> {HERE}.authenticating is exempt but authenticates a principal",
        f"fixture: d -> {HERE}.declaring is exempt but declares operations; remove it from EXEMPT",
        f"fixture: g -> {HERE}.writable_probe is exempt but accepts more than GET",
        f"exempt view {HERE}.gone is not routed at f by any urlconf; remove it from EXEMPT",
    ]


def test_an_exempt_view_routed_at_another_route_is_not_exempt_there() -> None:
    exempt = {("health/live", f"{HERE}.anonymous"): "fixture"}
    assert _check(
        path("health/live", anonymous), path("api/v1/open", anonymous), exempt=exempt
    ) == [
        f"fixture: api/v1/open -> {HERE}.anonymous declares no scope; decorate it with "
        "core.api.scopes.declares, or add it to EXEMPT if it has no principal"
    ]


def test_the_urlconf_discovery_refuses_a_root_urlconf_it_cannot_read(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text('ROOT_URLCONF = "x.urls"\n')
    (tmp_path / "b.py").write_text('ROOT_URLCONF: str = "y.urls"\n')
    (tmp_path / "c.py").write_text('NAME = "z.urls"\nROOT_URLCONF = NAME\n')
    (tmp_path / "d.py").write_text('ROOT_URLCONF, OTHER = "w.urls", 1\n')
    (tmp_path / "e.py").write_text('ROOT_URLCONF = "v.urls"\nROOT_URLCONF += "x"\n')
    assert urlconfs(tmp_path) == (
        ["v.urls", "x.urls", "y.urls"],
        [
            "c.py:2 assigns ROOT_URLCONF a value this check cannot read; "
            "assign it a string literal",
            "d.py:1 assigns ROOT_URLCONF a value this check cannot read; "
            "assign it a string literal",
            "e.py:2 assigns ROOT_URLCONF a value this check cannot read; "
            "assign it a string literal",
        ],
    )


def test_the_check_refuses_a_locale_prefixed_route() -> None:
    localised = URLResolver(LocalePrefixPattern(), [path("api/v1/me", scoped)])
    assert _check(localised) == [
        f"fixture: {localised.pattern} is a regex route; routes are path() so their contract "
        "path can be read",
        "no routed view found; the check would pass on an empty urlconf",
    ]


def test_the_check_refuses_a_regex_route_and_an_empty_urlconf() -> None:
    assert _check(re_path(r"^api/v1/me$", scoped)) == [
        "fixture: ^api/v1/me$ is a regex route; routes are path() so their contract path "
        "can be read",
        "no routed view found; the check would pass on an empty urlconf",
    ]
