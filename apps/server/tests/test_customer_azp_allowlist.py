"""The customer lane admits only the OAuth clients of KODERA_ALLOWED_OIDC_CLIENT_IDS as `azp`.

A customer-lane token whose `azp` is missing or names another client is refused exactly as any
other unverifiable token (`TokenVerificationError`, `401 unauthenticated` over HTTP). The list
defaults to the web console and the two native apps, gains KODERA_CONSOLE_CLIENT_ID when it is
set, and a list that resolves to no client stops every profile but a local one at start.
"""

import json
import os
import subprocess
import sys

import pytest
from customer_http_fixtures import (
    ROOT,
    http_signer as http_signer,
    http_world as http_world,
    request,
    safe_problem,
    token,
    trust_entry,
)
from django.core.exceptions import ImproperlyConfigured
from test_access_tokens import ISSUER, claims, frozen_clock as frozen_clock, sign

from config.environment import (
    ALLOWED_OIDC_CLIENT_IDS_DEFAULT,
    allowed_oidc_client_ids,
    auth_trust,
)
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import (
    DEFAULT_ALLOWED_AZP,
    load_trust,
    verify_configured_token,
)

DEFAULT_CLIENTS = ("console", "kodera-ios", "kodera-android")
EMPTY_REFUSED = (
    "KODERA_ALLOWED_OIDC_CLIENT_IDS names no client, so every customer token would be refused; "
    "only a local profile may run with none"
)


def customer_trust(http_signer, **environment):
    return auth_trust(
        {"KODERA_AUTH_TRUST": json.dumps([trust_entry(http_signer, ISSUER)]), **environment}
    )


def without_azp(**changes):
    payload = claims(**changes)
    del payload["azp"]
    return payload


def refused(http_signer, payload, trusted):
    with pytest.raises(TokenVerificationError) as error:
        verify_configured_token(sign(http_signer, payload), trusted=trusted)
    assert str(error.value) == "access token refused"


def test_the_default_is_the_console_and_the_two_native_apps():
    assert allowed_oidc_client_ids({}) == DEFAULT_CLIENTS
    assert ALLOWED_OIDC_CLIENT_IDS_DEFAULT.split(",") == list(DEFAULT_CLIENTS)
    assert DEFAULT_ALLOWED_AZP == DEFAULT_CLIENTS


def test_a_customer_token_without_azp_is_refused(http_signer):
    trusted = customer_trust(http_signer)
    refused(http_signer, without_azp(), trusted)
    # The unchanged token with an admitted client verifies: the refusal is the missing claim.
    verified, lane = verify_configured_token(sign(http_signer, claims()), trusted=trusted)
    assert lane == "customer" and verified.authorized_party == "console"


@pytest.mark.parametrize(
    "party",
    ["foreign-client", "Console", "console ", "", "kodera-ios,console", None, 1, ["console"]],
)
def test_a_customer_token_of_a_foreign_client_is_refused(http_signer, party):
    refused(http_signer, claims(azp=party), customer_trust(http_signer))


@pytest.mark.parametrize("party", DEFAULT_CLIENTS)
def test_each_default_client_is_admitted(http_signer, party):
    verified, lane = verify_configured_token(
        sign(http_signer, claims(azp=party)), trusted=customer_trust(http_signer)
    )
    assert lane == "customer" and verified.authorized_party == party


def test_the_console_client_id_is_added_to_the_list(http_signer):
    environment = {"KODERA_CONSOLE_CLIENT_ID": "partner-console"}
    assert allowed_oidc_client_ids(environment) == (*DEFAULT_CLIENTS, "partner-console")
    trusted = customer_trust(http_signer, **environment)
    for party in (*DEFAULT_CLIENTS, "partner-console"):
        verified, _ = verify_configured_token(sign(http_signer, claims(azp=party)), trusted=trusted)
        assert verified.authorized_party == party
    # Without it, the same client is foreign.
    refused(http_signer, claims(azp="partner-console"), customer_trust(http_signer))


def test_an_explicit_list_replaces_the_default_and_still_gains_the_console(http_signer):
    environment = {
        "KODERA_ALLOWED_OIDC_CLIENT_IDS": " web-only , kodera-ios ,,",
        "KODERA_CONSOLE_CLIENT_ID": "kodera-ios",
    }
    assert allowed_oidc_client_ids(environment) == ("web-only", "kodera-ios")
    trusted = customer_trust(http_signer, **environment)
    verify_configured_token(sign(http_signer, claims(azp="web-only")), trusted=trusted)
    refused(http_signer, claims(azp="console"), trusted)
    environment["KODERA_CONSOLE_CLIENT_ID"] = "console"
    assert allowed_oidc_client_ids(environment) == ("web-only", "kodera-ios", "console")


@pytest.mark.parametrize("value", ["", ",", " , ,"])
def test_an_empty_list_stops_a_deployed_profile_and_a_local_one_refuses_every_token(
    http_signer, value
):
    environment = {"KODERA_ALLOWED_OIDC_CLIENT_IDS": value}
    with pytest.raises(ImproperlyConfigured) as error:
        allowed_oidc_client_ids(environment)
    assert str(error.value) == EMPTY_REFUSED
    with pytest.raises(ImproperlyConfigured) as error:
        customer_trust(http_signer, **environment)
    assert str(error.value) == EMPTY_REFUSED
    # The console client alone is a list.
    assert allowed_oidc_client_ids({**environment, "KODERA_CONSOLE_CLIENT_ID": "console"}) == (
        "console",
    )
    # A local profile starts, and admits no customer token at all.
    assert allowed_oidc_client_ids(environment, local_profile=True) == ()
    trusted = auth_trust(
        {
            "KODERA_AUTH_TRUST": json.dumps([trust_entry(http_signer, ISSUER)]),
            **environment,
        },
        loopback_issuers=True,
    )
    refused(http_signer, claims(), trusted)


@pytest.mark.parametrize("value", ["console,with space", "console;x", "a" * 129, "clïent"])
def test_a_malformed_client_is_refused_at_start_without_echoing_it(value):
    with pytest.raises(ImproperlyConfigured) as error:
        allowed_oidc_client_ids({"KODERA_ALLOWED_OIDC_CLIENT_IDS": value})
    assert value not in str(error.value)


def test_the_staff_lane_does_not_judge_azp(http_signer):
    trusted = load_trust(json.dumps([trust_entry(http_signer, ISSUER, lane="staff")]))
    assert trusted[0].allowed_azp == ()
    for payload in (without_azp(), claims(azp="kodera-admin")):
        verified, lane = verify_configured_token(sign(http_signer, payload), trusted=trusted)
        assert lane == "staff"


def test_http_refuses_missing_and_foreign_azp_as_unauthenticated(http_world, http_signer):
    w = http_world
    for changes in ({"azp": "foreign-client"}, {"azp": None}):
        credential = token(http_signer, w.first.issuer, **changes)
        safe_problem(request(w.client, credential), 401, "unauthenticated")
    missing = sign(http_signer, without_azp(iss=w.first.issuer, sub="same-opaque-subject"))
    safe_problem(request(w.client, missing), 401, "unauthenticated")
    for party in DEFAULT_CLIENTS:
        assert request(w.client, token(http_signer, w.first.issuer, azp=party)).status_code == 200


PROBE = """
import json
import django
from django.core.exceptions import ImproperlyConfigured
try:
    django.setup()
except ImproperlyConfigured as error:
    print(json.dumps({"refused": str(error)}))
else:
    from django.conf import settings
    print(json.dumps({"allowed": [list(entry.allowed_azp) for entry in settings.KODERA_AUTH_TRUST]}))
"""


def startup(profile, http_signer, **environment):
    # The child runs on the wall clock, years before the fixtures' NOW: the entry is current there.
    entry = trust_entry(http_signer, ISSUER)
    result = subprocess.run(  # noqa: S603 - a fixed interpreter and a fixed program
        [sys.executable, "-B", "-c", PROBE],
        cwd=ROOT,
        env={
            "PATH": os.defpath,
            "PYTHONPATH": str(ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": profile,
            "DATABASE_URL": "postgres://synthetic:synthetic@127.0.0.1:1/kodera_server",
            "KODERA_AUTH_TRUST": json.dumps([entry]),
            **(
                {
                    "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
                    "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
                }
                if profile == "config.settings.deploy"
                else {}
            ),
            **environment,
        },
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout)


@pytest.mark.parametrize("profile", ["config.settings.customer_http", "config.settings.deploy"])
def test_a_deployable_profile_refuses_to_start_with_no_client(http_signer, profile):
    assert startup(profile, http_signer) == {"allowed": [list(DEFAULT_CLIENTS)]}
    assert startup(profile, http_signer, KODERA_CONSOLE_CLIENT_ID="partner-console") == {
        "allowed": [[*DEFAULT_CLIENTS, "partner-console"]]
    }
    assert startup(profile, http_signer, KODERA_ALLOWED_OIDC_CLIENT_IDS="") == {
        "refused": EMPTY_REFUSED
    }


def test_the_test_profile_starts_with_no_client(http_signer):
    assert startup("config.settings.test", http_signer, KODERA_ALLOWED_OIDC_CLIENT_IDS="") == {
        "allowed": [[]]
    }
