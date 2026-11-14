"""Origin and abuse controls at the edge of the customer API and of room-access:
docs/specs/ABUSE_AND_ORIGIN_CONTROLS.md.

- **CORS** (`core.api.edge.ConsoleCorsMiddleware`): an origin is named only when it is exactly one
  of KODERA_CONSOLE_ORIGINS; never `*`, never a reflection; credentials only for a listed origin;
  `Vary: Origin` always; the preflight is answered with fixed lists.
- **The mutation bucket** (`core.api.edge.MutationRateLimitMiddleware`): one verified principal's
  writes per rolling minute, `429 rate-limited` with `Retry-After` past it, keyed on `(iss, sub)`
  and on nothing a caller can write.
- **room-access**: one identity's LiveKit token requests per rolling minute, `429` past it, and
  CORS to its configured origins only.

Pure cases first, each run against the real module and then against a mutant of it: one owned
source mutation per rule, which must fail the one case that owns it (the pattern of
tests/test_trusted_edge.py). Then the same rules through the routed views, with real signed
tokens on the disposable PostgreSQL, and the proof that taking the limiter out of the middleware
chain is caught by name.
"""

import ast
import ipaddress
import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.core.exceptions import ImproperlyConfigured
from django.http import HttpResponse
from django.test import Client, RequestFactory
from test_access_tokens import frozen_clock as frozen_clock
from test_membership_lifecycle import get, m as m, patch as patch_membership, stored
from test_room_access import (
    ALICE,
    AUDIO,
    CONSOLE as ROOM_CONSOLE,
    FakeLiveKit,
    FakeMatrix,
    world as world,
)
from test_workspace_onboarding import _component, _validator, contract

from config.environment import mutation_rate_per_minute
from core.api import edge
from room_access import server as room_server
from room_access.config import Config, ConfigError
from room_access.service import Service

ROOT = Path(__file__).resolve().parents[1]
ISSUER = "https://identity.customer.test/realms/alpha"
CONSOLE = "https://app.kodera.io"
OTHER_CONSOLE = "https://console.kodera.io:8443"
EVIL = "https://evil.test"
ACAO = "Access-Control-Allow-Origin"
ACAC = "Access-Control-Allow-Credentials"
CORS_HEADERS = {
    ACAO,
    ACAC,
    "Access-Control-Allow-Methods",
    "Access-Control-Allow-Headers",
    "Access-Control-Expose-Headers",
    "Access-Control-Max-Age",
}


def vary(response):
    return {part.strip().lower() for part in response.get("Vary", "").split(",") if part.strip()}


def cors_of(response):
    return {name: response[name] for name in CORS_HEADERS if name in response}


# --- the pure cases: (module, context) -> bool ---------------------------------------------------


@pytest.fixture
def ctx(settings, http_signer):
    """Two principals of one trusted issuer, and the Console's two origins. No database."""
    configure(settings, [trust_entry(http_signer, ISSUER)])
    settings.KODERA_CONSOLE_ORIGINS = f"{CONSOLE}, {OTHER_CONSOLE}"
    settings.KODERA_MUTATION_RATE_PER_MINUTE = 3
    settings.KODERA_TRUSTED_EDGE = (ipaddress.ip_network("172.19.0.2/32"),)
    return SimpleNamespace(
        settings=settings,
        factory=RequestFactory(),
        alice=token(http_signer, ISSUER, subject="alice"),
        # The same principal, another token: a refresh must not open a second bucket.
        alice_again=token(http_signer, ISSUER, subject="alice", jti="another-token"),
        bob=token(http_signer, ISSUER, subject="bob"),
    )


def served(module, ctx, method="get", path="/api/v1/me", **headers):
    """One request through the module's CORS middleware around a view that answers 200."""
    reached = []

    def view(request):
        reached.append(request.method)
        return HttpResponse("ok")

    request = getattr(ctx.factory, method)(path, **headers)
    return module.ConsoleCorsMiddleware(view)(request), reached


def preflight(module, ctx, origin, method="PATCH", path="/api/v1/me", **headers):
    return served(
        module,
        ctx,
        "options",
        path,
        HTTP_ORIGIN=origin,
        HTTP_ACCESS_CONTROL_REQUEST_METHOD=method,
        **headers,
    )


def case_a_listed_origin_is_named_exactly_with_credentials(module, ctx):
    for origin in (CONSOLE, OTHER_CONSOLE):
        response, _ = served(module, ctx, HTTP_ORIGIN=origin)
        if response.get(ACAO) != origin or response.get(ACAC) != "true":
            return False
    return True


def case_an_unlisted_origin_is_never_reflected(module, ctx):
    for origin in (
        EVIL,
        "https://app.kodera.io.evil.test",
        "https://evil-app.kodera.io",
        "http://app.kodera.io",
        "https://app.kodera.io:444",
        "https://APP.kodera.io",
        "https://app.kodera.io/",
        "null",
        "*",
        "",
    ):
        response, reached = served(module, ctx, HTTP_ORIGIN=origin)
        if cors_of(response) or not reached:
            return False
    return True


def case_the_allowed_origin_is_never_a_wildcard(module, ctx):
    answers = [served(module, ctx, HTTP_ORIGIN=origin)[0] for origin in (CONSOLE, EVIL, "*")]
    answers.append(preflight(module, ctx, CONSOLE)[0])
    answers.append(served(module, ctx)[0])
    return all("*" not in response.get(ACAO, "") for response in answers)


def case_credentials_are_allowed_only_to_a_listed_origin(module, ctx):
    listed, _ = served(module, ctx, HTTP_ORIGIN=CONSOLE)
    unlisted, _ = served(module, ctx, HTTP_ORIGIN=EVIL)
    absent, _ = served(module, ctx)
    refused, _ = preflight(module, ctx, EVIL)
    return (
        listed.get(ACAC) == "true"
        and ACAC not in unlisted
        and ACAC not in absent
        and ACAC not in refused
    )


def case_every_answer_varies_on_origin(module, ctx):
    answers = [
        served(module, ctx)[0],
        served(module, ctx, HTTP_ORIGIN=CONSOLE)[0],
        served(module, ctx, HTTP_ORIGIN=EVIL)[0],
        preflight(module, ctx, CONSOLE)[0],
        preflight(module, ctx, EVIL)[0],
    ]
    return all("origin" in vary(response) for response in answers)


def case_a_malformed_setting_lists_no_origin(module, ctx):
    for value in ("*", f"{CONSOLE},*", "https://*.kodera.io", f"{CONSOLE} {EVIL}", 7, ""):
        ctx.settings.KODERA_CONSOLE_ORIGINS = value
        for origin in (CONSOLE, EVIL, "*", "https://*.kodera.io"):
            if cors_of(served(module, ctx, HTTP_ORIGIN=origin)[0]):
                return False
    ctx.settings.KODERA_CONSOLE_ORIGINS = None
    return not cors_of(served(module, ctx, HTTP_ORIGIN=CONSOLE)[0])


def case_a_listed_preflight_is_answered_with_fixed_lists(module, ctx):
    response, reached = preflight(
        module,
        ctx,
        CONSOLE,
        HTTP_ACCESS_CONTROL_REQUEST_HEADERS="x-evil, authorization, cookie",
    )
    return (
        response.status_code == 204
        and not reached
        and not response.content
        and response.get(ACAO) == CONSOLE
        and response.get("Access-Control-Allow-Methods") == "GET, POST, PUT, PATCH, DELETE"
        and response.get("Access-Control-Allow-Headers")
        == "Authorization, Content-Type, Idempotency-Key, If-Match, If-None-Match, X-Request-Id"
        and "evil" not in response.get("Access-Control-Allow-Headers", "").lower()
        and "cookie" not in response.get("Access-Control-Allow-Headers", "").lower()
        and response.get("Access-Control-Max-Age") == "600"
    )


def case_an_unlisted_preflight_is_refused_without_a_cors_header(module, ctx):
    for origin, method in ((EVIL, "PATCH"), ("null", "POST"), (CONSOLE, "TRACE"), (CONSOLE, "")):
        response, reached = preflight(module, ctx, origin, method)
        if response.status_code != 403 or reached or cors_of(response):
            return False
        if json.loads(response.content)["type"] != "https://kodera.io/problems/forbidden":
            return False
    return True


def case_only_the_customer_api_is_given_cors(module, ctx):
    for path in ("/agent/v1/commands", "/health/live", "/"):
        response, reached = served(module, ctx, path=path, HTTP_ORIGIN=CONSOLE)
        if cors_of(response) or not reached:
            return False
        response, reached = preflight(module, ctx, CONSOLE, path=path)
        if cors_of(response) or not reached:
            return False
    return True


def limited(module, ctx, credential, method="post", path="/api/v1/organisations", **meta):
    """One request through the module's limiter around a view that answers 201."""
    reached = []

    def view(request):
        reached.append(request.method)
        return HttpResponse(status=201)

    headers = {} if credential is None else {"HTTP_AUTHORIZATION": "Bearer " + credential}
    request = getattr(ctx.factory, method)(path, **headers, **meta)
    request.META["HTTP_X_REQUEST_ID"] = "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee"
    middleware = ctx.limiters.setdefault(id(module), module.MutationRateLimitMiddleware(view))
    middleware.get_response = view
    return middleware(request), reached


def spend(module, ctx, credential, **meta):
    """The principal's whole bucket: three admitted writes."""
    return [limited(module, ctx, credential, **meta)[0].status_code for _ in range(3)]


def case_a_principal_is_refused_past_the_bucket(module, ctx):
    if spend(module, ctx, ctx.alice) != [201, 201, 201]:
        return False
    response, reached = limited(module, ctx, ctx.alice)
    if response.status_code != 429 or reached:
        return False
    body = json.loads(response.content)
    return (
        body["type"] == "https://kodera.io/problems/rate-limited"
        and body["status"] == 429
        and body["scope"] == "mutation"
        and body["limit"] == 3
        and body["request_id"] == response["X-Request-Id"]
        and isinstance(body["retry_after_s"], int)
        and 1 <= body["retry_after_s"] <= 60
        and response.get("Retry-After") == str(body["retry_after_s"])
        and response.get("Cache-Control") == "no-store"
        and response.get("Content-Type") == "application/problem+json"
    )


def case_every_writing_method_is_counted_and_no_read_is(module, ctx):
    statuses = [
        limited(module, ctx, ctx.alice, method)[0].status_code
        for method in ("post", "put", "patch", "delete")
    ]
    reads = [limited(module, ctx, ctx.alice, "get")[0].status_code for _ in range(10)]
    return statuses == [201, 201, 201, 429] and reads == [201] * 10


def case_the_bucket_is_the_principals_not_the_tokens(module, ctx):
    spend(module, ctx, ctx.alice)
    return (
        limited(module, ctx, ctx.alice_again)[0].status_code == 429
        and limited(module, ctx, ctx.bob)[0].status_code == 201
    )


def case_no_address_or_header_chooses_the_bucket(module, ctx):
    """Behind the trusted edge or not, with whatever a caller writes in `X-Forwarded-For`: the
    principal's bucket is the same one, and another principal at the same address has their own."""
    spend(module, ctx, ctx.alice, REMOTE_ADDR="172.19.0.2", HTTP_X_FORWARDED_FOR="203.0.113.7")
    moved = [
        limited(module, ctx, ctx.alice, REMOTE_ADDR=peer, HTTP_X_FORWARDED_FOR=forwarded)
        for peer, forwarded in (
            ("172.19.0.2", "198.51.100.9"),
            ("198.51.100.44", "203.0.113.7"),
            ("172.19.0.2", ""),
        )
    ]
    neighbour, _ = limited(
        module, ctx, ctx.bob, REMOTE_ADDR="172.19.0.2", HTTP_X_FORWARDED_FOR="203.0.113.7"
    )
    return all(r.status_code == 429 for r, _ in moved) and neighbour.status_code == 201


def case_an_unverified_request_is_left_to_its_view(module, ctx):
    """No `429` in place of the `401` a client needs in order to sign in again."""
    for credential in (None, "not-a-token", ctx.alice + "x"):
        for _ in range(10):
            response, reached = limited(module, ctx, credential)
            if response.status_code != 201 or not reached:
                return False
    return True


def case_the_agent_api_is_not_the_customers_bucket(module, ctx):
    return [
        limited(module, ctx, ctx.alice, path="/agent/v1/commands/x/ack")[0].status_code
        for _ in range(10)
    ] == [201] * 10


def case_nothing_turns_the_bucket_off(module, ctx):
    """A value outside what a profile admits is read as the default, 60, never as no limit."""
    for value in (None, 0, -1, False, True, "3", 3.0, 6001, 10**9):
        ctx.settings.KODERA_MUTATION_RATE_PER_MINUTE = value
        if module.configured_limit() != 60:
            return False
    ctx.settings.KODERA_MUTATION_RATE_PER_MINUTE = 6000
    return module.configured_limit() == 6000


def case_the_window_rolls_and_a_refusal_records_nothing(module, ctx):
    now = [1000.0]
    window = module.SlidingWindow(clock=lambda: now[0])
    admitted = [window.charge("k", limit=2) for _ in range(2)]
    if [d.admitted for d in admitted] != [True, True] or admitted[1].remaining != 0:
        return False
    now[0] += 20
    refused = [window.charge("k", limit=2) for _ in range(50)]
    if any(d.admitted for d in refused) or {d.reset_s for d in refused} != {40}:
        return False
    now[0] += 39.5
    if window.charge("k", limit=2).admitted:
        return False
    now[0] += 0.5  # the first two leave the window together: the 50 refusals bought nothing
    return [window.charge("k", limit=2).admitted for _ in range(3)] == [True, True, False]


def case_the_buckets_are_bounded(module, ctx):
    now = [0.0]
    window = module.SlidingWindow(max_keys=100, clock=lambda: now[0])
    for index in range(1000):
        window.charge(f"principal-{index}", limit=5)
    full = len(window) <= 101
    now[0] += 61  # every bucket is idle: the next new principal sweeps them
    window.charge("late", limit=5)
    window.charge("later", limit=5)
    return full and len(window) <= 101


CASES = {
    case.__name__: case
    for case in (
        case_a_listed_origin_is_named_exactly_with_credentials,
        case_an_unlisted_origin_is_never_reflected,
        case_the_allowed_origin_is_never_a_wildcard,
        case_credentials_are_allowed_only_to_a_listed_origin,
        case_every_answer_varies_on_origin,
        case_a_malformed_setting_lists_no_origin,
        case_a_listed_preflight_is_answered_with_fixed_lists,
        case_an_unlisted_preflight_is_refused_without_a_cors_header,
        case_only_the_customer_api_is_given_cors,
        case_a_principal_is_refused_past_the_bucket,
        case_every_writing_method_is_counted_and_no_read_is,
        case_the_bucket_is_the_principals_not_the_tokens,
        case_no_address_or_header_chooses_the_bucket,
        case_an_unverified_request_is_left_to_its_view,
        case_the_agent_api_is_not_the_customers_bucket,
        case_nothing_turns_the_bucket_off,
        case_the_window_rolls_and_a_refusal_records_nothing,
        case_the_buckets_are_bounded,
    )
}


def run(name, module, ctx):
    ctx.limiters = {}
    return CASES[name](module, ctx)


@pytest.mark.parametrize("name", sorted(CASES))
def test_case_holds(name, ctx):
    assert run(name, edge, ctx), name


# Each mutant replaces exactly one anchor in core/api/edge.py and must fail the case that owns it.
MUTATIONS = [
    (
        "a wildcard origin",
        "case_the_allowed_origin_is_never_a_wildcard",
        '    response["Access-Control-Allow-Origin"] = origin\n',
        '    response["Access-Control-Allow-Origin"] = "*"\n',
    ),
    (
        "a reflected origin",
        "case_an_unlisted_origin_is_never_reflected",
        "    if isinstance(origin, str) and origin in console_origins():\n",
        "    if isinstance(origin, str) and origin:\n",
    ),
    (
        "a suffix match",
        "case_an_unlisted_origin_is_never_reflected",
        "    if isinstance(origin, str) and origin in console_origins():\n",
        "    if isinstance(origin, str) and any(origin.endswith(o[8:]) for o in console_origins()):\n",
    ),
    (
        "a malformed setting that admits everything",
        "case_a_malformed_setting_lists_no_origin",
        "    return frozenset() if listed is None else listed\n",
        "    return frozenset({request_origin}) if listed is None else listed\n",
    ),
    (
        "credentials for every origin",
        "case_credentials_are_allowed_only_to_a_listed_origin",
        "        if origin is not None:\n            _grant(response, origin)\n",
        '        response["Access-Control-Allow-Credentials"] = "true"\n'
        "        if origin is not None:\n            _grant(response, origin)\n",
    ),
    (
        "no Vary on an answer without an origin",
        "case_every_answer_varies_on_origin",
        '        patch_vary_headers(response, ("Origin",))\n',
        '        if origin is not None:\n            patch_vary_headers(response, ("Origin",))\n',
    ),
    (
        "a preflight that echoes the requested headers",
        "case_a_listed_preflight_is_answered_with_fixed_lists",
        '        response["Access-Control-Allow-Headers"] = ", ".join(ALLOWED_HEADERS)\n',
        '        response["Access-Control-Allow-Headers"] = request.META.get(\n'
        '            "HTTP_ACCESS_CONTROL_REQUEST_HEADERS", ""\n        )\n',
    ),
    (
        "a preflight answered to any origin",
        "case_an_unlisted_preflight_is_refused_without_a_cors_header",
        "        if origin is None or method not in ALLOWED_METHODS:\n",
        "        if False:\n",
    ),
    (
        "CORS on every path",
        "case_only_the_customer_api_is_given_cors",
        "        if not request.path.startswith(API_PREFIX):\n"
        "            return self.get_response(request)\n        origin = listed_origin(request)\n",
        "        origin = listed_origin(request)\n",
    ),
    (
        "the limiter never refuses",
        "case_a_principal_is_refused_past_the_bucket",
        "            if len(bucket) >= limit:\n",
        "            if False:\n",
    ),
    (
        "a refused write still reaches its view",
        "case_a_principal_is_refused_past_the_bucket",
        "        if not decision.admitted:\n            response = rate_limited(request, decision)\n"
        "        else:\n            response = self.get_response(request)\n",
        "        response = self.get_response(request)\n",
    ),
    (
        "no Retry-After on the refusal",
        "case_a_principal_is_refused_past_the_bucket",
        '    response["Retry-After"] = str(decision.reset_s)\n',
        "",
    ),
    (
        "only POST is counted",
        "case_every_writing_method_is_counted_and_no_read_is",
        'MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})',
        'MUTATING_METHODS = frozenset({"POST"})',
    ),
    (
        "the bucket is the token's",
        "case_the_bucket_is_the_principals_not_the_tokens",
        "    return principal_key(verified.issuer, verified.subject)\n",
        "    return principal_key(verified.issuer, bearer)\n",
    ),
    (
        "the bucket is the client address's",
        "case_no_address_or_header_chooses_the_bucket",
        "    return principal_key(verified.issuer, verified.subject)\n",
        "    return principal_key(\n"
        "        verified.issuer, client_address(request.META, settings.KODERA_TRUSTED_EDGE)\n"
        "    )\n",
    ),
    (
        "an unverified request is charged to one shared bucket",
        "case_an_unverified_request_is_left_to_its_view",
        "        key = verified_principal(request)\n        if key is None:\n"
        "            return self.get_response(request)\n",
        '        key = verified_principal(request) or "anonymous"\n',
    ),
    (
        "the agent API shares the customers' bucket",
        "case_the_agent_api_is_not_the_customers_bucket",
        "        if request.method not in MUTATING_METHODS or not request.path.startswith(API_PREFIX):\n",
        "        if request.method not in MUTATING_METHODS:\n",
    ),
    (
        "a setting that turns the bucket off",
        "case_nothing_turns_the_bucket_off",
        "    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIMIT:\n"
        "        return DEFAULT_LIMIT\n",
        "    if limit is None or limit == 0:\n        return 10**9\n"
        "    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIMIT:\n"
        "        return DEFAULT_LIMIT\n",
    ),
    (
        "a refusal that extends the wait",
        "case_the_window_rolls_and_a_refusal_records_nothing",
        "            if len(bucket) >= limit:\n",
        "            bucket.append(now)\n            if len(bucket) > limit:\n",
    ),
    (
        "a fixed window that never rolls",
        "case_the_window_rolls_and_a_refusal_records_nothing",
        "            while bucket and bucket[0] <= horizon:\n                bucket.popleft()\n",
        "",
    ),
    (
        "unbounded buckets",
        "case_the_buckets_are_bounded",
        "        if len(self._buckets) <= self._max_keys:\n            return\n",
        "        return\n",
    ),
]


def mutant(before: str, after: str) -> SimpleNamespace:
    source = (ROOT / "core/api/edge.py").read_text()
    assert source.count(before) == 1, f"mutation anchor moved: {before!r}"
    namespace: dict[str, object] = {"__name__": "edge_controls_mutant", "request_origin": "*"}
    exec(compile(source.replace(before, after), "<edge-controls-mutant>", "exec"), namespace)  # noqa: S102 - owned source mutation only
    return SimpleNamespace(**namespace)


@pytest.mark.parametrize(
    ("owner", "before", "after"), [m[1:] for m in MUTATIONS], ids=[m[0] for m in MUTATIONS]
)
def test_each_rule_has_a_case_that_catches_its_mutant(owner, before, after, ctx):
    assert run(owner, edge, ctx), "the owning case must hold on the real module"
    assert not run(owner, mutant(before, after), ctx), f"{owner} did not catch its mutant"


def test_the_three_named_refusals_each_have_a_mutant():
    names = {name for name, *_ in MUTATIONS}
    assert {"a wildcard origin", "a reflected origin", "the limiter never refuses"} <= names


# --- the operator's settings ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"), [(None, 60), ("", 60), ("  ", 60), ("1", 1), ("60", 60), ("6000", 6000)]
)
def test_the_rate_setting_admits_a_bounded_integer(value, expected):
    environment = {} if value is None else {"KODERA_MUTATION_RATE_PER_MINUTE": value}
    assert mutation_rate_per_minute(environment) == expected


@pytest.mark.parametrize("value", ["0", "-1", "off", "false", "none", "6001", "60.0", "1e3", "060"])
def test_the_rate_setting_cannot_turn_the_bucket_off(value):
    with pytest.raises(ImproperlyConfigured) as refused:
        mutation_rate_per_minute({"KODERA_MUTATION_RATE_PER_MINUTE": value})
    assert value not in str(refused.value).replace("6000", ""), "a refused value is not reflected"


def test_the_deployed_profile_installs_the_controls_in_order_and_reads_their_settings():
    program = """
import json
from django.conf import settings
print(json.dumps({
    'middleware': settings.MIDDLEWARE[:3],
    'rate': settings.KODERA_MUTATION_RATE_PER_MINUTE,
    'origins': settings.KODERA_CONSOLE_ORIGINS,
    'edge': [str(n) for n in settings.KODERA_TRUSTED_EDGE],
}))
"""
    base = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": str(ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",
        "DJANGO_SETTINGS_MODULE": "config.settings.deploy",
        "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
        "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
        "DATABASE_URL": "postgresql://synthetic:synthetic-pass@db:5432/kodera_server",
    }

    def probe(**extra):
        return subprocess.run(  # noqa: S603 - fixed isolated probe
            [sys.executable, "-c", program],
            cwd=ROOT,
            env={**base, **extra},
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )

    result = probe(
        KODERA_MUTATION_RATE_PER_MINUTE="120",
        KODERA_CONSOLE_ORIGINS=CONSOLE,
        KODERA_TRUSTED_EDGE_ADDRESSES="172.19.0.2",
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "middleware": [
            "core.api.edge.CallerRequestIdMiddleware",
            "core.api.edge.ConsoleCorsMiddleware",
            "core.api.edge.MutationRateLimitMiddleware",
        ],
        "rate": 120,
        "origins": CONSOLE,
        "edge": ["172.19.0.2/32"],
    }
    unset = probe()
    assert unset.returncode == 0, unset.stderr
    assert json.loads(unset.stdout)["rate"] == 60 and json.loads(unset.stdout)["origins"] is None
    assert probe(KODERA_MUTATION_RATE_PER_MINUTE="0").returncode != 0


def _only_appends_quota_middleware(source):
    """The HTTP profile must inherit every base control in its original order."""
    tree = ast.parse(source)
    references = [
        node for node in ast.walk(tree) if isinstance(node, ast.Name) and node.id == "MIDDLEWARE"
    ]
    assignments = [
        node
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "MIDDLEWARE" for target in node.targets
        )
    ]
    expected = ast.parse(
        'MIDDLEWARE = [*MIDDLEWARE, "apps.workspaces.quota_http.QuotaRefusalMiddleware"]'
    ).body[0]
    return (
        len(references) == 2
        and len(assignments) == 1
        and ast.dump(assignments[0]) == ast.dump(expected)
    )


def test_no_settings_module_removes_a_control_from_a_serving_profile():
    """Only non-HTTP profiles empty the list; customer HTTP only appends quota handling."""
    naming = sorted(
        path.name
        for path in (ROOT / "config/settings").glob("*.py")
        if "MIDDLEWARE" in path.read_text()
    )
    assert naming == ["base.py", "customer_http.py", "deploy_operator.py", "deploy_worker.py"]
    assert _only_appends_quota_middleware((ROOT / "config/settings/customer_http.py").read_text())


@pytest.mark.parametrize(
    "source",
    [
        'MIDDLEWARE = ["apps.workspaces.quota_http.QuotaRefusalMiddleware"]',
        'MIDDLEWARE = [*MIDDLEWARE[1:], "apps.workspaces.quota_http.QuotaRefusalMiddleware"]',
        'MIDDLEWARE = ["apps.workspaces.quota_http.QuotaRefusalMiddleware", *MIDDLEWARE]',
        'MIDDLEWARE = [*MIDDLEWARE, "apps.workspaces.quota_http.QuotaRefusalMiddleware"]\nMIDDLEWARE.clear()',
    ],
)
def test_serving_profile_cannot_remove_reorder_or_clear_inherited_controls(source):
    assert not _only_appends_quota_middleware(source)


# --- through the routed views --------------------------------------------------------------------


def rate_limited_errors(response):
    """Why `response` is not the contract's `RateLimited` answer, or []."""
    errors = []
    if response.status_code != 429:
        return [f"answered {response.status_code}, not 429"]
    declared = _component("responses", contract()["components"]["responses"]["RateLimited"])
    media = response.headers.get("Content-Type", "").split(";")[0]
    if media not in declared["content"]:
        errors.append(f"429 is {media}, not a declared media type")
    else:
        schema = declared["content"][media]["schema"]
        errors += [e.message for e in _validator(schema).iter_errors(response.json())]
    retry = response.headers.get("Retry-After", "")
    if not retry.isdigit() or int(retry) < 1:
        errors.append("429 lacks a Retry-After of at least one second")
    elif response.json().get("retry_after_s") != int(retry):
        errors.append("Retry-After and retry_after_s differ")
    if response.headers.get("Cache-Control") != "no-store":
        errors.append("429 is not no-store")
    if response.json().get("request_id") != response.headers.get("X-Request-Id"):
        errors.append("429 does not carry the request's id")
    return errors


def check_mutation_bucket(w):
    """The acceptance: with a bucket of three, an owner's fourth write in the minute is refused
    `429` before the view, changes nothing, and leaves reads and other principals alone."""
    w.settings.KODERA_MUTATION_RATE_PER_MINUTE = 3
    target = w.member.member
    roles = ["org_admin", "org_member", "org_admin"]
    for role in roles:
        changed = patch_membership(w, w.owner, target, {"role": role})
        assert changed.status_code == 200, changed.content
        assert changed.headers.get("RateLimit-Limit") == "3", (
            "the mutation rate limit did not count the principal's write"
        )
    tag = get(w, w.owner, target).headers["ETag"]
    refused = w.client.patch(
        f"/api/v1/organisations/{w.alpha.id}/memberships/{target.id}",
        data=json.dumps({"role": "org_member"}),
        content_type="application/merge-patch+json",
        HTTP_AUTHORIZATION="Bearer " + w.owner.credential,
        HTTP_IF_MATCH=tag,
    )
    assert rate_limited_errors(refused) == [], (
        "the mutation rate limit did not refuse the principal's write past the bucket"
    )
    assert refused.json()["scope"] == "mutation" and refused.json()["limit"] == 3
    assert stored(target).role == "org_admin", "a refused write reached its handler"
    # Reads are never counted or refused, and another principal has their own bucket.
    assert get(w, w.owner, target).status_code == 200
    assert patch_membership(w, w.admin, target, {"role": "org_member"}).status_code == 200


@pytest.fixture
def h(m, settings):
    m.settings = settings
    settings.KODERA_CONSOLE_ORIGINS = CONSOLE
    return m


def test_a_principals_write_past_the_bucket_is_refused_before_its_view(h):
    check_mutation_bucket(h)


def test_the_refusal_is_readable_by_the_console_and_by_no_other_origin(h):
    h.settings.KODERA_MUTATION_RATE_PER_MINUTE = 1
    path = f"/api/v1/organisations/{h.alpha.id}/memberships/{h.member.member.id}"

    def write(origin):
        return h.client.patch(
            path,
            data=b"{}",
            content_type="application/merge-patch+json",
            HTTP_AUTHORIZATION="Bearer " + h.owner.credential,
            HTTP_ORIGIN=origin,
        )

    assert write(CONSOLE).status_code != 429
    listed, unlisted = write(CONSOLE), write(EVIL)
    assert listed.status_code == unlisted.status_code == 429
    assert listed[ACAO] == CONSOLE and listed[ACAC] == "true"
    assert "Retry-After" in listed["Access-Control-Expose-Headers"]
    assert not cors_of(unlisted) and "origin" in vary(unlisted)


def test_an_expired_or_forged_token_gets_its_401_however_often_it_is_sent(h):
    h.settings.KODERA_MUTATION_RATE_PER_MINUTE = 1
    path = f"/api/v1/organisations/{h.alpha.id}/memberships/{h.member.member.id}"
    for _ in range(5):
        response = h.client.patch(
            path,
            data=b"{}",
            content_type="application/merge-patch+json",
            HTTP_AUTHORIZATION="Bearer " + h.owner.credential + "x",
        )
        assert response.status_code == 401


def test_real_answers_name_the_console_and_nothing_else(h):
    path = f"/api/v1/organisations/{h.alpha.id}/memberships/{h.member.member.id}"
    auth = {"HTTP_AUTHORIZATION": "Bearer " + h.owner.credential}
    listed = h.client.get(path, HTTP_ORIGIN=CONSOLE, **auth)
    assert listed.status_code == 200
    assert listed[ACAO] == CONSOLE and listed[ACAC] == "true"
    assert "ETag" in listed["Access-Control-Expose-Headers"]
    for origin in (EVIL, "null", "https://app.kodera.io.evil.test"):
        unlisted = h.client.get(path, HTTP_ORIGIN=origin, **auth)
        assert unlisted.status_code == 200 and not cors_of(unlisted)
        assert "origin" in vary(unlisted)
    native = h.client.get(path, **auth)
    assert native.status_code == 200 and not cors_of(native) and "origin" in vary(native)
    # A refusal and an unrouted path are answers too.
    for response in (
        h.client.get(path, HTTP_ORIGIN=CONSOLE),
        h.client.get("/api/v1/no-such-route", HTTP_ORIGIN=CONSOLE),
    ):
        assert response[ACAO] == CONSOLE and "origin" in vary(response)


def test_a_real_preflight_is_answered_before_any_view(h):
    path = f"/api/v1/organisations/{h.alpha.id}/memberships/{h.member.member.id}"
    ask = {"HTTP_ACCESS_CONTROL_REQUEST_METHOD": "PATCH"}
    allowed = h.client.options(path, HTTP_ORIGIN=CONSOLE, **ask)
    assert allowed.status_code == 204 and allowed[ACAO] == CONSOLE and not allowed.content
    assert "If-Match" in allowed["Access-Control-Allow-Headers"]
    assert allowed["X-Request-Id"]
    refused = h.client.options(path, HTTP_ORIGIN=EVIL, **ask)
    assert refused.status_code == 403 and not cors_of(refused)
    assert refused.json()["request_id"] == refused["X-Request-Id"]


@pytest.fixture
def without_the_limiter(settings):
    kept = [name for name in settings.MIDDLEWARE if "MutationRateLimit" not in name]
    assert len(kept) == len(settings.MIDDLEWARE) - 1, "the limiter is not installed once"
    settings.MIDDLEWARE = kept


def test_refusal_control_the_bucket_check_passes_with_the_limiter_installed(h):
    h.client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    check_mutation_bucket(h)


def test_refusal_without_the_limiter_the_bucket_check_fails_by_name(h, without_the_limiter):
    h.client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    with pytest.raises(AssertionError) as caught:
        check_mutation_bucket(h)
    assert "mutation rate limit did not" in str(caught.value)


def test_refusal_a_limiter_that_admits_everything_fails_the_bucket_check(h, monkeypatch):
    unlimited = edge.Decision(True, 3, 3, 1)
    monkeypatch.setattr(edge.SlidingWindow, "charge", lambda self, key, *, limit: unlimited)
    h.client = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1")
    with pytest.raises(AssertionError, match="mutation rate limit did not refuse"):
        check_mutation_bucket(h)


# --- room-access: LiveKit call tokens ------------------------------------------------------------


def serve(server):
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"


def ask(base, bearer, origin=None, room=AUDIO):
    headers = {"Authorization": "Bearer " + bearer, "Content-Type": "application/json"}
    if origin is not None:
        headers["Origin"] = origin
    request = urllib.request.Request(  # noqa: S310 - the test's own loopback listener
        f"{base}/token", data=json.dumps({"room_id": room}).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:  # noqa: S310 - the test's own loopback listener
            return response.status, dict(response.headers), json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        with exc:
            return exc.code, dict(exc.headers), json.loads(exc.read() or b"{}")


class Counting(FakeLiveKit):
    """LiveKit, counting what the token path asks of it."""

    def __init__(self):
        super().__init__()
        self.asked = 0

    def create_room(self, name, room_id):
        self.asked += 1
        super().create_room(name, room_id)


class Asked(FakeMatrix):
    """Synapse, counting who-am-I reads."""

    def __init__(self):
        super().__init__()
        self.whoamis = 0

    def whoami(self, token):
        self.whoamis += 1
        return super().whoami(token)


def room_case_an_identity_is_refused_past_its_grants(module):
    """Two tokens of one Matrix user share one bucket; past it the answer is 429 with its wait,
    LiveKit is asked nothing more, and another member is unaffected."""
    matrix, livekit = Asked(), Counting()
    service = Service(matrix, livekit, "wss://media.acme.kodera.io", "@kodera-agent:acme.kodera.io")
    server = module.make_token_server(
        "127.0.0.1", 0, service, frozenset({ROOM_CONSOLE}), limiter=module.GrantLimiter(2)
    )
    base = serve(server)
    try:
        first = ask(base, "tok-alice", ROOM_CONSOLE)
        second = ask(base, "tok-alice-2", ROOM_CONSOLE)
        asked = livekit.asked
        third = ask(base, "tok-alice", ROOM_CONSOLE)
        other = ask(base, "tok-bob", ROOM_CONSOLE)
    finally:
        server.shutdown()
        server.server_close()
    return (
        first[0] == second[0] == 200
        and third[0] == 429
        and third[2] == {"error": "rate_limited", "retry_after_s": int(third[1]["Retry-After"])}
        and 1 <= third[2]["retry_after_s"] <= 60
        and third[1]["Cache-Control"] == "no-store"
        and "Retry-After" in third[1].get("Access-Control-Expose-Headers", "")
        and livekit.asked == asked + 1  # bob's grant only
        and other[0] == 200
    )


def room_case_a_repeated_credential_stops_reaching_synapse(module):
    matrix = Asked()
    service = Service(
        matrix, Counting(), "wss://media.acme.kodera.io", "@kodera-agent:acme.kodera.io"
    )
    server = module.make_token_server(
        "127.0.0.1", 0, service, frozenset({ROOM_CONSOLE}), limiter=module.GrantLimiter(2)
    )
    base = serve(server)
    try:
        statuses = [ask(base, "tok-nobody")[0] for _ in range(5)]
    finally:
        server.shutdown()
        server.server_close()
    return statuses == [401, 401, 429, 429, 429] and matrix.whoamis == 2


def room_case_a_listener_is_limited_without_being_told(module):
    """No caller can build an unlimited listener: the default limiter is always there."""
    service = Service(
        Asked(), Counting(), "wss://media.acme.kodera.io", "@kodera-agent:acme.kodera.io"
    )
    server = module.make_token_server("127.0.0.1", 0, service, frozenset({ROOM_CONSOLE}))
    base = serve(server)
    try:
        statuses = [ask(base, "tok-alice")[0] for _ in range(module.GRANTS_PER_MINUTE + 1)]
    finally:
        server.shutdown()
        server.server_close()
    return statuses == [200] * module.GRANTS_PER_MINUTE + [429]


def room_case_cors_names_a_configured_origin_only(module):
    service = Service(
        Asked(), Counting(), "wss://media.acme.kodera.io", "@kodera-agent:acme.kodera.io"
    )
    server = module.make_token_server("127.0.0.1", 0, service, frozenset({ROOM_CONSOLE}))
    base = serve(server)
    try:
        listed = ask(base, "tok-alice", ROOM_CONSOLE)[1]
        answers = [ask(base, "tok-alice", origin)[1] for origin in (EVIL, "*", "null", None)]
    finally:
        server.shutdown()
        server.server_close()
    return (
        listed.get(ACAO) == ROOM_CONSOLE
        and all(ACAO not in headers for headers in answers)
        and all(headers.get("Vary") == "Origin" for headers in (listed, *answers))
    )


ROOM_CASES = {
    case.__name__: case
    for case in (
        room_case_an_identity_is_refused_past_its_grants,
        room_case_a_repeated_credential_stops_reaching_synapse,
        room_case_a_listener_is_limited_without_being_told,
        room_case_cors_names_a_configured_origin_only,
    )
}
ROOM_MUTATIONS = [
    (
        "the identity limit is removed",
        "room_case_an_identity_is_refused_past_its_grants",
        "        wait = grants.identity(user_id)\n",
        "        wait = None\n",
    ),
    (
        "the limit is per device",
        "room_case_an_identity_is_refused_past_its_grants",
        '        return self.wait("identity:" + user_id)\n',
        '        return self.wait("identity:" + user_id + str(self._clock()))\n',
    ),
    (
        "the credential limit is removed",
        "room_case_a_repeated_credential_stops_reaching_synapse",
        "            wait = grants.credential(matrix_token)\n",
        "            wait = None\n",
    ),
    (
        "a listener with no limiter",
        "room_case_a_listener_is_limited_without_being_told",
        "    grants = limiter if limiter is not None else GrantLimiter()\n",
        "    grants = limiter if limiter is not None else GrantLimiter(10**6)\n",
    ),
    (
        "a reflected origin",
        "room_case_cors_names_a_configured_origin_only",
        '            allowed = _cors_origin(self.headers.get("Origin", ""), origins)\n'
        "            if allowed is not None:\n"
        '                self.send_header("Access-Control-Allow-Origin", allowed)\n',
        '            allowed = self.headers.get("Origin", "") or None\n'
        "            if allowed is not None:\n"
        '                self.send_header("Access-Control-Allow-Origin", allowed)\n',
    ),
    (
        "a wildcard origin",
        "room_case_cors_names_a_configured_origin_only",
        '            allowed = _cors_origin(self.headers.get("Origin", ""), origins)\n'
        "            if allowed is not None:\n"
        '                self.send_header("Access-Control-Allow-Origin", allowed)\n',
        '            if True:\n                self.send_header("Access-Control-Allow-Origin", "*")\n',
    ),
]


def room_mutant(before: str, after: str) -> SimpleNamespace:
    source = (ROOT / "room_access/server.py").read_text()
    assert source.count(before) == 1, f"mutation anchor moved: {before!r}"
    namespace: dict[str, object] = {"__name__": "room_access.server", "__package__": "room_access"}
    exec(compile(source.replace(before, after), "<room-access-mutant>", "exec"), namespace)  # noqa: S102 - owned source mutation only
    return SimpleNamespace(**namespace)


@pytest.mark.parametrize("name", sorted(ROOM_CASES))
def test_room_case_holds(name):
    assert ROOM_CASES[name](room_server), name


@pytest.mark.parametrize(
    ("owner", "before", "after"),
    [m[1:] for m in ROOM_MUTATIONS],
    ids=[m[0] for m in ROOM_MUTATIONS],
)
def test_each_room_rule_has_a_case_that_catches_its_mutant(owner, before, after):
    assert not ROOM_CASES[owner](room_mutant(before, after)), f"{owner} did not catch its mutant"


def test_a_refused_identity_never_reaches_the_room_or_livekit(world):
    matrix, livekit, service = world
    reads = []
    original = matrix.state_event
    matrix.state_event = lambda room, kind: reads.append(room) or original(room, kind)

    def refuse(user_id):
        assert user_id == ALICE
        raise room_server.RateLimitedError(7)

    with pytest.raises(room_server.RateLimitedError) as refused:
        service.grant("tok-alice", AUDIO, admit=refuse)
    assert refused.value.retry_after_s == 7 and reads == [] and livekit.calls == {}


def room_environment(**changes):
    return {
        "ROOM_ACCESS_SYNAPSE_URL": "http://synapse:8008",
        "ROOM_ACCESS_MATRIX_TOKEN": "room-access-token",
        "LIVEKIT_URL": "http://livekit:7880",
        "LIVEKIT_WS_URL": "wss://media.acme.kodera.io",
        "LIVEKIT_API_KEY": "roomkey",
        "LIVEKIT_API_SECRET": "room-secret-for-tests-only-0123456789",
        "ROOM_ACCESS_ALLOWED_ORIGINS": ROOM_CONSOLE,
        "ROOM_ACCESS_AGENT_USER": "@kodera-agent:acme.kodera.io",
        **changes,
    }


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (ROOM_CONSOLE, {ROOM_CONSOLE}),
        (
            f"{ROOM_CONSOLE}, https://chat.example.org:8443",
            {ROOM_CONSOLE, "https://chat.example.org:8443"},
        ),
        ("http://127.0.0.1:5173", {"http://127.0.0.1:5173"}),
        ("http://localhost:4173", {"http://localhost:4173"}),
    ],
)
def test_room_access_admits_exact_origins(value, expected):
    config = Config.from_env(room_environment(ROOM_ACCESS_ALLOWED_ORIGINS=value))
    assert config.allowed_origins == frozenset(expected)


@pytest.mark.parametrize(
    "value",
    [
        "*",
        f"{ROOM_CONSOLE},*",
        "https://*.kodera.io",
        "null",
        "https://app.kodera.io/",
        "https://app.kodera.io/path",
        "https://APP.kodera.io",
        "http://app.kodera.io",
        "app.kodera.io",
        " , ",
    ],
)
def test_room_access_refuses_a_wildcard_or_anything_that_is_not_an_origin(value):
    with pytest.raises(ConfigError):
        Config.from_env(room_environment(ROOM_ACCESS_ALLOWED_ORIGINS=value))


def test_room_access_reads_its_grant_rate_and_cannot_turn_it_off():
    assert Config.from_env(room_environment()).grants_per_minute == 30
    assert (
        Config.from_env(room_environment(ROOM_ACCESS_GRANTS_PER_MINUTE="5")).grants_per_minute == 5
    )
    for value in ("0", "-1", "off", "601", "", "5.0"):
        with pytest.raises(ConfigError):
            Config.from_env(room_environment(ROOM_ACCESS_GRANTS_PER_MINUTE=value))
    with pytest.raises(ValueError):
        room_server.GrantLimiter(0)
