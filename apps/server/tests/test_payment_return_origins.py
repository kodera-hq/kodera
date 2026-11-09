"""createPaymentLink's return origins: the console's own, read from KODERA_CONSOLE_ORIGINS by the
parser discovery admits browsers with, so the API's two readers of the variable never disagree.

`payment_return_origins` is what config/settings/customer_http.py and deploy.py assign to
KODERA_PAYMENT_RETURN_ORIGINS, and what config/settings/e2e.py assigns with plain-http loopback
origins admitted. A malformed value admits no return URL at all, and discovery refuses browsers
for the same value, so the misconfiguration is seen on the console's first screen.
"""

import pathlib

import pytest

from apps.billing.configuration import payment_return_origins
from services.identity.discovery_input import allowed_origins


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, frozenset()),
        ("", frozenset()),
        ("https://app.kodera.io", frozenset({"https://app.kodera.io"})),
        (
            " https://app.kodera.io , https://console.kodera.io:8443 ",
            frozenset({"https://app.kodera.io", "https://console.kodera.io:8443"}),
        ),
        # One malformed entry, and none is admitted: a path, a trailing slash, plain http, a
        # capital, userinfo, a wildcard.
        ("https://app.kodera.io,https://app.kodera.io/back", frozenset()),
        ("https://app.kodera.io/", frozenset()),
        ("http://app.kodera.io", frozenset()),
        ("https://App.kodera.io", frozenset()),
        ("https://user@app.kodera.io", frozenset()),
        ("*", frozenset()),
        ("http://localhost:5173", frozenset()),
    ],
)
def test_the_return_origins_are_the_console_s_as_discovery_reads_them(raw, expected):
    assert payment_return_origins(raw) == expected
    assert payment_return_origins(raw) == (allowed_origins(raw) or frozenset())


def test_a_loopback_console_is_admitted_only_where_discovery_admits_one():
    raw = "http://localhost:5173"
    assert payment_return_origins(raw) == frozenset()
    assert payment_return_origins(raw, loopback_http=True) == frozenset({raw})


@pytest.mark.parametrize("profile", ["customer_http.py", "deploy.py"])
def test_the_api_profiles_read_the_console_origins_for_the_return_url(profile):
    source = (pathlib.Path("config/settings") / profile).read_text()
    assignment = "KODERA_PAYMENT_RETURN_ORIGINS = payment_return_origins(KODERA_CONSOLE_ORIGINS)"
    assert source.count(assignment) == 1, profile
    assert "KODERA_MAIL_LINK_ORIGINS" not in source, profile
