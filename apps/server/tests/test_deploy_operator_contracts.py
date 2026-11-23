"""Deployed customer admission and command-only operator profile stay distinct."""

import json

from test_deploy_operator_profile import probe

GUEST_MIDDLEWARE = "apps.workspaces.guest_http.GuestScopeMiddleware"


def deployed_middleware():
    result = probe(
        "print(json.dumps({'middleware': settings.MIDDLEWARE, 'urls': settings.ROOT_URLCONF}))",
        {"DJANGO_SETTINGS_MODULE": "config.settings.deploy"},
    )
    assert result.returncode == 0, result.stderr
    profile = json.loads(result.stdout)
    assert profile["urls"] == "config.customer_urls"
    assert profile["middleware"].count(GUEST_MIDDLEWARE) == 1
    assert profile["middleware"].index("core.api.edge.CallerRequestIdMiddleware") < profile[
        "middleware"
    ].index(GUEST_MIDDLEWARE)
    assert profile["middleware"].index("core.api.edge.ConsoleCorsMiddleware") < profile[
        "middleware"
    ].index(GUEST_MIDDLEWARE)
    return profile["middleware"]


def test_deploy_installs_guest_scope_without_giving_operator_an_http_stack():
    deployed_middleware()
    result = probe("assert settings.MIDDLEWARE == []; assert settings.ROOT_URLCONF is None")
    assert result.returncode == 0, result.stderr
