"""The expiry an onboarding mail shows, and where the realm's set-up mail returns the person.

docs/specs/INVITATIONS.md §1 step 3 and §4.
"""

from datetime import UTC, datetime, timedelta, timezone

import pytest

from apps.outbox.mail.dates import mail_instant
from apps.outbox.mail.links import LinkOriginsError, setup_redirect_from_environment

ORIGINS = frozenset({"https://app.example.test"})


@pytest.mark.parametrize(
    ("when", "locale", "shown"),
    [
        # Winter: Paris is UTC+1.
        (datetime(2026, 11, 7, 14, 32, tzinfo=UTC), "fr", "7 novembre 2026 à 15\u00a0h\u00a032"),
        # Summer: UTC+2, and the first of the month is « 1er ».
        (datetime(2026, 7, 1, 7, 5, tzinfo=UTC), "fr", "1er juillet 2026 à 9\u00a0h\u00a005"),
        # Late in the UTC day is the next day in Paris.
        (datetime(2026, 12, 31, 23, 30, tzinfo=UTC), "fr", "1er janvier 2027 à 0\u00a0h\u00a030"),
        (datetime(2026, 2, 3, 8, 0, tzinfo=UTC), "fr", "3 février 2026 à 9\u00a0h\u00a000"),
        (datetime(2026, 11, 7, 14, 32, tzinfo=UTC), "en", "7 November 2026 at 15:32 (Paris time)"),
        # Summer time starts on 29 March 2026 at 01:00 UTC: 1 h 59, then 3 h 00.
        (datetime(2026, 3, 29, 0, 59, tzinfo=UTC), "fr", "29 mars 2026 à 1\u00a0h\u00a059"),
        (datetime(2026, 3, 29, 1, 0, tzinfo=UTC), "fr", "29 mars 2026 à 3\u00a0h\u00a000"),
        # It ends on 25 October 2026 at 01:00 UTC: 2 h 59, then 2 h 00 again.
        (datetime(2026, 10, 25, 0, 59, tzinfo=UTC), "fr", "25 octobre 2026 à 2\u00a0h\u00a059"),
        (datetime(2026, 10, 25, 1, 0, tzinfo=UTC), "fr", "25 octobre 2026 à 2\u00a0h\u00a000"),
        # Another offset reads the same instant.
        (
            datetime(2026, 11, 7, 9, 32, tzinfo=timezone(timedelta(hours=-5))),
            "fr",
            "7 novembre 2026 à 15\u00a0h\u00a032",
        ),
    ],
)
def test_an_expiry_reads_in_paris_time_and_the_mails_language(when, locale, shown):
    assert mail_instant(when, locale) == shown


def test_an_instant_without_a_timezone_is_refused():
    with pytest.raises(ValueError, match="timezone"):
        mail_instant(datetime(2026, 11, 7, 14, 32), "fr")


def test_an_unknown_locale_is_refused():
    with pytest.raises(KeyError):
        mail_instant(datetime(2026, 11, 7, 14, 32, tzinfo=UTC), "de")


@pytest.mark.parametrize("value", [None, "", "  "])
def test_unset_the_set_up_mail_names_no_return_address(value):
    environment = {} if value is None else {"KODERA_REALM_SETUP_REDIRECT": value}
    assert setup_redirect_from_environment(environment, ORIGINS) is None


def test_the_root_of_a_mail_origin_is_kept():
    environment = {"KODERA_REALM_SETUP_REDIRECT": "https://app.example.test/"}
    assert setup_redirect_from_environment(environment, ORIGINS) == "https://app.example.test/"


@pytest.mark.parametrize(
    "value",
    [
        "https://elsewhere.example.test/",
        # The realm's console client lists `<origin>/` alone: Keycloak answers 400 to any other path.
        "https://app.example.test/start",
        "https://app.example.test",
        "https://app.example.test//",
        "https://APP.example.test/",
        "http://app.example.test/",
        "https://app.example.test/?next=x",
        "https://app.example.test/#x",
        "https://user@app.example.test/",
        "https://app.example.test/" + "a" * 512,
        "not a url",
    ],
)
def test_any_other_return_address_stops_the_process(value):
    with pytest.raises(LinkOriginsError, match="KODERA_REALM_SETUP_REDIRECT"):
        setup_redirect_from_environment({"KODERA_REALM_SETUP_REDIRECT": value}, ORIGINS)
