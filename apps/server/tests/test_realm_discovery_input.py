"""Actual raw discovery-input boundary; no route, database or quota simulation."""

import json

import pytest

from services.identity.discovery_input import (
    DiscoveryInputError,
    allowed_origins,
    browser_refusal,
    check_discovery_headers,
    is_canonical_organisation_slug,
    parse_discovery_input,
)

KEY = "synthetic-key-0001"


def parse(raw, content_type="application/json", key=KEY):
    return parse_discovery_input(raw, content_type=content_type, compatibility_key=key)


def body(value):
    return json.dumps(value, ensure_ascii=False).encode()


@pytest.mark.parametrize(
    "value,expected",
    [
        ({"slug": "abcde"}, ("slug", "abcde")),
        ({"slug": "a-b-c"}, ("slug", "a-b-c")),
        ({"slug": "a" * 20}, ("slug", "a" * 20)),
        ({"email": "Person.Name+tag@EXAMPLE.invalid"}, ("domain", "example.invalid")),
        ({"email": "a@b.cd"}, ("domain", "b.cd")),
        ({"email": "a" * 64 + "@example.invalid"}, ("domain", "example.invalid")),
        ({"email": "!#$%&'*+-/=?^_`{|}~@example.invalid"}, ("domain", "example.invalid")),
        ({"email": "a@xn--example.invalid"}, ("domain", "xn--example.invalid")),
    ],
)
def test_approved_inputs(value, expected):
    assert parse(body(value)) == expected


@pytest.mark.parametrize("value", ["abcde", "a-b-c", "a" * 20])
def test_canonical_slug_valid(value):
    assert is_canonical_organisation_slug(value)


@pytest.mark.parametrize(
    "value",
    [
        None,
        123,
        True,
        "abcd",
        "a" * 21,
        "-abcd",
        "abcd-",
        "Abcde",
        "abc_e",
        "abcdé",
        "abcde\n",
        "https://example.invalid/abcde",
    ],
)
def test_canonical_slug_refuses(value):
    assert not is_canonical_organisation_slug(value)
    if isinstance(value, str):
        with pytest.raises(DiscoveryInputError) as error:
            parse(body({"slug": value}))
        assert (error.value.status, error.value.reason) == (422, "slug-shape")


@pytest.mark.parametrize(
    "raw,status,reason",
    [
        (b"", 400, "invalid-json"),
        (b"{", 400, "invalid-json"),
        (b'{"slug":"abcde",}', 400, "invalid-json"),
        (b"\xff", 400, "invalid-json"),
        (b'\xef\xbb\xbf{"slug":"abcde"}', 400, "invalid-json"),
        (b'{"slug":"abcde","slug":"fghij"}', 400, "duplicate-json-key"),
        (b'{"sl\\u0075g":"abcde","slug":"abcde"}', 400, "duplicate-json-key"),
        (b'{"x":{"same":1,"same":2}}', 400, "duplicate-json-key"),
        (b'{"slug":NaN}', 400, "invalid-json"),
        (b'{"slug":Infinity}', 400, "invalid-json"),
        (b'{"slug":-Infinity}', 400, "invalid-json"),
        (b"null", 422, "request-not-object"),
        (b"[]", 422, "request-not-object"),
        (b"true", 422, "request-not-object"),
        (b'"abcde"', 422, "request-not-object"),
        (b"{}", 422, "exactly-one-known-input"),
        (b'{"slug":"abcde","email":"a@example.invalid"}', 422, "exactly-one-known-input"),
        (b'{"slug":"abcde","organisation_id":"synthetic"}', 422, "exactly-one-known-input"),
        (b'{"realm":"abcde"}', 422, "exactly-one-known-input"),
        (b'{"slug":1}', 422, "input-not-string"),
        (b'{"slug":null}', 422, "input-not-string"),
        (b'{"email":false}', 422, "input-not-string"),
        (b'{"slug":"\\ud800"}', 422, "slug-shape"),
        (b"[" * 1500 + b"0" + b"]" * 1499, 400, "invalid-json"),
    ],
)
def test_raw_parser_refusals(raw, status, reason):
    with pytest.raises(DiscoveryInputError) as error:
        parse(raw)
    assert (error.value.status, error.value.reason) == (status, reason)
    suffix = "malformed-request" if status == 400 else "validation-error"
    assert error.value.problem_type == "https://kodera.io/problems/" + suffix


def test_limit_is_received_bytes_before_parsing():
    raw = b'{"slug":"abcde"}'
    assert parse(raw + b" " * (4096 - len(raw))) == ("slug", "abcde")
    with pytest.raises(DiscoveryInputError) as error:
        parse(raw + b" " * (4097 - len(raw)), content_type=None, key=None)
    assert (error.value.status, error.value.reason) == (413, "body-size")
    # Multibyte payload is below 4096 characters but above 4096 received bytes.
    with pytest.raises(DiscoveryInputError) as error:
        parse(body({"slug": "é" * 2050}))
    assert error.value.status == 413


@pytest.mark.parametrize(
    "content_type", [None, "text/plain", "application/json-patch+json", "", 123]
)
def test_media_type_refusal_precedes_key(content_type):
    with pytest.raises(DiscoveryInputError) as error:
        parse(b"{}", content_type=content_type, key=None)
    assert (error.value.status, error.value.reason) == (415, "media-type")


@pytest.mark.parametrize(
    "content_type", ["application/json", "Application/JSON; charset=utf-8", " application/json "]
)
def test_json_media_type_parameters(content_type):
    assert parse(b'{"slug":"abcde"}', content_type) == ("slug", "abcde")


@pytest.mark.parametrize("key", ["k" * 16, "k" * 255, "k" * 8 + " " + "k" * 8])
def test_compatibility_key_boundaries(key):
    assert parse(b'{"slug":"abcde"}', key=key) == ("slug", "abcde")


@pytest.mark.parametrize(
    "key",
    [
        None,
        "k" * 15,
        "k" * 256,
        " " + "k" * 16,
        "k" * 16 + " ",
        "k" * 16 + "\n",
        "k" * 8 + "\t" + "k" * 8,
        "é" * 16,
        "k" * 16 + "\x7f",
        123,
    ],
)
def test_key_refusal_precedes_json(key):
    with pytest.raises(DiscoveryInputError) as error:
        parse(b"{", key=key)
    expected = "key-missing" if key is None else "key-shape"
    assert (error.value.status, error.value.reason) == (400, expected)
    suffix = "idempotency-key-missing" if key is None else "malformed-request"
    assert error.value.problem_type.endswith("/" + suffix)


@pytest.mark.parametrize(
    "email",
    [
        "a" * 65 + "@example.invalid",
        "a..b@example.invalid",
        ".a@example.invalid",
        "a.@example.invalid",
        "é@example.invalid",
        "a@é.invalid",
        '"a"@example.invalid',
        "a@[127.0.0.1]",
        "a@localhost",
        "a@-example.invalid",
        "a@example-.invalid",
        "a@example.invalid.",
        "a@" + "x" * 64 + ".invalid",
        "a@example.invalid\n",
        "a@@example.invalid",
        "a@.invalid",
        "a@example..invalid",
    ],
)
def test_invalid_ascii_email(email):
    with pytest.raises(DiscoveryInputError) as error:
        parse(body({"email": email}))
    assert error.value.status == 422
    assert error.value.problem_type.endswith("/validation-error")


def test_email_total_length_and_exact_domain():
    domain = ".".join(["b" * 63, "c" * 63, "d" * 61])
    email = "a" * 64 + "@" + domain
    assert len(email) == 254
    assert parse(body({"email": email})) == ("domain", domain)
    with pytest.raises(DiscoveryInputError) as error:
        parse(body({"email": email + "e"}))
    assert error.value.reason == "email-shape"
    assert parse(body({"email": "a@sub.example.invalid"})) == ("domain", "sub.example.invalid")


def test_no_key_or_local_part_in_returned_value_and_no_replay():
    assert parse(body({"email": "first-person@EXAMPLE.invalid"})) == parse(
        body({"email": "second-person@example.invalid"})
    )
    assert parse(body({"slug": "abcde"})) == ("slug", "abcde")
    assert parse(body({"slug": "fghij"})) == ("slug", "fghij")
    assert parse(body({"slug": "abcde"}), key="different-key-0001") == ("slug", "abcde")


@pytest.mark.parametrize(
    "raw",
    [
        b'{"slug":"private-sentinel",',
        b'{"email":"private-sentinel"}',
        b'{"slug":NaN}',
        b'{"slug":"a","slug":"private-sentinel"}',
    ],
)
def test_refusal_metadata_does_not_embed_input_or_json_exception(raw):
    with pytest.raises(DiscoveryInputError) as error:
        parse(raw)
    assert "private-sentinel" not in str(error.value)
    assert "private-sentinel" not in repr(vars(error.value))
    assert error.value.args == (error.value.reason,)
    assert error.value.__context__ is None
    assert error.value.__cause__ is None


@pytest.mark.parametrize("raw", [None, "{}", bytearray(b"{}")])
def test_non_bytes_adapter_input_is_a_safe_refusal(raw):
    with pytest.raises(DiscoveryInputError) as error:
        parse(raw)
    assert (error.value.status, error.value.reason) == (400, "body-type")


@pytest.mark.parametrize(
    "content_type",
    [
        "application/json; charset=iso-8859-1",
        "application/json; charset=utf-16",
        "application/json; charset=utf-8; charset=utf-16",
        "application/json; arbitrary=value",
        "application/json; charset=",
        'application/json; charset="unterminated',
        "application/json; =; malformed parameter text",
        "application/json;;;",
    ],
)
def test_media_parameters_are_ignored_for_utf8_body(content_type):
    assert parse(b'{"slug":"abcde"}', content_type) == ("slug", "abcde")


@pytest.mark.parametrize(
    "content_type",
    [
        "application/json; charset=iso-8859-1",
        "application/json; charset=utf-16",
        'application/json; charset="unterminated',
    ],
)
@pytest.mark.parametrize(
    "raw",
    [
        b'{"slug":"abcd\xe9"}',
        b'{"slug":"abcde"}'.decode().encode("utf-16"),
        b'{"slug":"\xc3("}',
    ],
    ids=["latin1", "utf16", "invalid-utf8-sequence"],
)
def test_media_parameters_never_enable_non_utf8_decoding(raw, content_type):
    with pytest.raises(DiscoveryInputError) as error:
        parse(raw, content_type)
    assert (error.value.status, error.value.reason) == (400, "invalid-json")
    assert error.value.problem_type.endswith("/malformed-request")
    assert error.value.__context__ is None


def test_conflicting_charset_does_not_reclassify_valid_utf8():
    # The bytes decode correctly as UTF-8, then fail the independently ASCII-only schema.
    with pytest.raises(DiscoveryInputError) as error:
        parse(body({"slug": "abcdé"}), "application/json; charset=iso-8859-1")
    assert (error.value.status, error.value.reason) == (422, "slug-shape")


@pytest.mark.parametrize(
    "content_type,key,status,reason",
    [
        ("text/plain", KEY, 415, "media-type"),
        ("application/x-www-form-urlencoded", KEY, 415, "media-type"),
        (None, KEY, 415, "media-type"),
        ("application/json", None, 400, "key-missing"),
        ("application/json", "short", 400, "key-shape"),
    ],
)
def test_header_refusals_need_no_body(content_type, key, status, reason):
    with pytest.raises(DiscoveryInputError) as error:
        check_discovery_headers(content_type, key)
    assert (error.value.status, error.value.reason) == (status, reason)


def test_valid_headers_pass_without_a_body():
    check_discovery_headers("application/json; charset=utf-8", KEY)


CONSOLE = "https://app.kodera.io"


@pytest.mark.parametrize(
    "origin,fetch_site,refusal",
    [
        (None, None, None),  # a native client sends neither header
        (CONSOLE, "same-origin", None),
        (CONSOLE, "same-site", None),
        (CONSOLE, None, None),
        (None, "none", None),
        ("https://attacker.example", "cross-site", "cross-site"),
        (CONSOLE, "cross-site", "cross-site"),
        (None, "Cross-Site", "cross-site"),
        ("https://attacker.example", None, "origin"),
        ("https://attacker.example", "same-site", "origin"),
        ("null", "same-origin", "origin"),
        ("https://app.kodera.io.attacker.example", None, "origin"),
    ],
)
def test_browser_refusal(origin, fetch_site, refusal):
    assert browser_refusal(origin, fetch_site, frozenset({CONSOLE})) == refusal


def test_no_configured_origin_admits_no_browser_but_every_native_client():
    assert browser_refusal(CONSOLE, "same-origin", allowed_origins(None)) == "origin"
    assert browser_refusal(None, None, allowed_origins(None)) is None


@pytest.mark.parametrize(
    "raw,expected",
    [
        (None, frozenset()),
        ("", frozenset()),
        (CONSOLE, frozenset({CONSOLE})),
        (
            " https://app.kodera.io , https://app.localhost:8443 ",
            frozenset({CONSOLE, "https://app.localhost:8443"}),
        ),
        ("http://app.kodera.io", None),
        ("https://app.kodera.io/", None),
        ("https://App.Kodera.io", None),
        ("*", None),
        (["https://app.kodera.io"], None),
    ],
)
def test_allowed_origins_are_exact_https_origins(raw, expected):
    assert allowed_origins(raw) == expected
