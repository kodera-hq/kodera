"""Tests for Mobile Universal Links (`apple-app-site-association`) and Android App Links (`assetlinks.json`)."""

from __future__ import annotations

import json
import uuid

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.test import Client, RequestFactory, override_settings

from config.environment import android_assetlinks_sha256, ios_app_ids
from core.well_known import REQUEST_ID_RE, apple_app_site_association, assetlinks

SAMPLE_IOS_APP_ID = "ABCDE12345.io.kodera.app"
SAMPLE_IOS_EXT_ID = "ABCDE12345.io.kodera.app.share-extension"
SAMPLE_ANDROID_SHA256 = (
    "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:"
    "01:23:45:67:89:ab:cd:ef:fe:dc:ba:98:76:54:32:10"
)


def test_ios_app_ids_validator_accepts_empty_and_deduplicates_valid_ids() -> None:
    assert ios_app_ids({}) == ()
    assert ios_app_ids({"KODERA_IOS_APP_IDS": "   "}) == ()

    parsed = ios_app_ids(
        {
            "KODERA_IOS_APP_IDS": (
                f" {SAMPLE_IOS_APP_ID} , {SAMPLE_IOS_EXT_ID} , {SAMPLE_IOS_APP_ID} "
            )
        }
    )
    assert parsed == (SAMPLE_IOS_APP_ID, SAMPLE_IOS_EXT_ID)


@pytest.mark.parametrize(
    "bad_value",
    [
        "abcde12345.io.kodera.app",  # lowercase team id
        "SHORT.io.kodera.app",  # team id != 10 chars
        "ABCDE12345.com.example.other",  # wrong bundle id
        f"{SAMPLE_IOS_APP_ID},",  # trailing empty item
        ",".join(f"TEAM0000{i:02d}.io.kodera.app" for i in range(17)),  # > 16 entries
    ],
)
def test_ios_app_ids_validator_rejects_malformed_values_without_echoing_input(
    bad_value: str,
) -> None:
    with pytest.raises(ImproperlyConfigured) as exc_info:
        ios_app_ids({"KODERA_IOS_APP_IDS": bad_value})
    assert bad_value not in str(exc_info.value)


def test_android_assetlinks_sha256_validator_uppercases_and_deduplicates() -> None:
    assert android_assetlinks_sha256({}) == ()
    assert android_assetlinks_sha256({"KODERA_ANDROID_ASSETLINKS_SHA256": ""}) == ()

    parsed = android_assetlinks_sha256(
        {
            "KODERA_ANDROID_ASSETLINKS_SHA256": (
                f" {SAMPLE_ANDROID_SHA256} , {SAMPLE_ANDROID_SHA256.upper()} "
            )
        }
    )
    assert parsed == (SAMPLE_ANDROID_SHA256.upper(),)


@pytest.mark.parametrize(
    "bad_value",
    [
        "not-a-sha256-fingerprint",
        "AA:BB:CC",  # too short
        SAMPLE_ANDROID_SHA256.replace(":", ""),  # missing colons
        SAMPLE_ANDROID_SHA256[:-1] + "G",  # non-hex character
        ",".join(
            f"{i:02X}:" + ":".join(["11"] * 31)
            for i in range(17)
        ),  # > 16 entries
    ],
)
def test_android_assetlinks_validator_rejects_malformed_values_without_echoing_input(
    bad_value: str,
) -> None:
    with pytest.raises(ImproperlyConfigured) as exc_info:
        android_assetlinks_sha256({"KODERA_ANDROID_ASSETLINKS_SHA256": bad_value})
    assert bad_value not in str(exc_info.value)


@override_settings(KODERA_IOS_APP_IDS=())
def test_apple_app_site_association_fails_closed_503_json_when_unconfigured() -> None:
    client = Client()
    response = client.get(
        "/.well-known/apple-app-site-association",
        HTTP_X_REQUEST_ID="req-aasa-unconf-1",
    )
    assert response.status_code == 503
    assert response["Content-Type"] == "application/json"
    assert response["Cache-Control"] == "no-store"
    assert response["X-Request-Id"] == "c-req-aasa-unconf-1"
    body = response.json()
    assert body["code"] == "well_known_unconfigured"
    assert body["status"] == 503
    assert body["request_id"] == "c-req-aasa-unconf-1"


@override_settings(KODERA_IOS_APP_IDS=(SAMPLE_IOS_APP_ID, SAMPLE_IOS_EXT_ID))
def test_apple_app_site_association_serves_direct_200_json_without_redirect() -> None:
    client = Client()
    response = client.get("/.well-known/apple-app-site-association", follow=False)
    assert response.status_code == 200
    assert response["Content-Type"] == "application/json"
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Cache-Control"] == "public, max-age=300"
    assert response["X-Request-Id"]

    payload = response.json()
    details = payload["applinks"]["details"]
    assert len(details) == 1
    assert details[0]["appIDs"] == [SAMPLE_IOS_APP_ID, SAMPLE_IOS_EXT_ID]
    paths = [entry["/"] for entry in details[0]["components"]]
    assert "/auth/*" in paths
    assert "/invite/*" in paths
    assert "/workspace/*" in paths
    assert payload["webcredentials"]["apps"] == [SAMPLE_IOS_APP_ID, SAMPLE_IOS_EXT_ID]


@override_settings(KODERA_ANDROID_ASSETLINKS_SHA256=())
def test_assetlinks_fails_closed_503_json_when_unconfigured() -> None:
    client = Client()
    response = client.get("/.well-known/assetlinks.json")
    assert response.status_code == 503
    assert response["Content-Type"] == "application/json"
    assert response["Cache-Control"] == "no-store"
    body = response.json()
    assert body["code"] == "well_known_unconfigured"


@override_settings(KODERA_ANDROID_ASSETLINKS_SHA256=(SAMPLE_ANDROID_SHA256,))
def test_assetlinks_serves_direct_200_json_for_io_kodera_app() -> None:
    client = Client()
    response = client.get("/.well-known/assetlinks.json", follow=False)
    assert response.status_code == 200
    assert response["Content-Type"] == "application/json"
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Cache-Control"] == "public, max-age=300"

    payload = response.json()
    assert isinstance(payload, list) and len(payload) == 1
    statement = payload[0]
    assert statement["relation"] == ["delegate_permission/common.handle_all_urls"]
    assert statement["target"] == {
        "namespace": "android_app",
        "package_name": "io.kodera.app",
        "sha256_cert_fingerprints": [SAMPLE_ANDROID_SHA256.upper()],
    }


@pytest.mark.parametrize(
    "path",
    [
        "/.well-known/apple-app-site-association",
        "/.well-known/assetlinks.json",
    ],
)
def test_well_known_endpoints_reject_post_with_405(path: str) -> None:
    client = Client()
    response = client.post(path, data="{}", content_type="application/json")
    assert response.status_code == 405


@pytest.mark.parametrize(
    "bad_request_id",
    [
        "",
        "short77",
        "x" * 65,
        "x" * 256,
        "bad\r\nheader-inject",
        "bad\x00null-byte",
        "bad space id",
    ],
)
def test_well_known_replaces_oversized_or_control_char_request_id_with_uuid7(
    bad_request_id: str,
) -> None:
    factory = RequestFactory()

    with override_settings(KODERA_IOS_APP_IDS=()):
        req_unconf = factory.get(
            "/.well-known/apple-app-site-association",
            HTTP_X_REQUEST_ID=bad_request_id,
        )
        resp_unconf = apple_app_site_association(req_unconf)
        assert resp_unconf.status_code == 503
        rid_unconf = resp_unconf["X-Request-Id"]
        assert rid_unconf != bad_request_id
        assert REQUEST_ID_RE.fullmatch(rid_unconf) is not None
        assert uuid.UUID(rid_unconf).version == 7
        assert json.loads(resp_unconf.content)["request_id"] == rid_unconf

    with override_settings(
        KODERA_IOS_APP_IDS=(SAMPLE_IOS_APP_ID,),
        KODERA_ANDROID_ASSETLINKS_SHA256=(SAMPLE_ANDROID_SHA256,),
    ):
        req_aasa = factory.get(
            "/.well-known/apple-app-site-association",
            HTTP_X_REQUEST_ID=bad_request_id,
        )
        resp_aasa = apple_app_site_association(req_aasa)
        assert resp_aasa.status_code == 200
        assert uuid.UUID(resp_aasa["X-Request-Id"]).version == 7

        req_asset = factory.get(
            "/.well-known/assetlinks.json",
            HTTP_X_REQUEST_ID=bad_request_id,
        )
        resp_asset = assetlinks(req_asset)
        assert resp_asset.status_code == 200
        assert uuid.UUID(resp_asset["X-Request-Id"]).version == 7

        client = Client()
        full_resp = client.get(
            "/.well-known/apple-app-site-association",
            HTTP_X_REQUEST_ID=bad_request_id,
        )
        assert full_resp.status_code == 200
        assert uuid.UUID(full_resp["X-Request-Id"]).version == 7


@pytest.mark.parametrize("valid_request_id", ["abcd_123", "A" * 64])
@override_settings(KODERA_IOS_APP_IDS=(SAMPLE_IOS_APP_ID,))
def test_well_known_preserves_valid_bounded_request_id(valid_request_id: str) -> None:
    factory = RequestFactory()
    req = factory.get(
        "/.well-known/apple-app-site-association",
        HTTP_X_REQUEST_ID=valid_request_id,
    )
    resp = apple_app_site_association(req)
    assert resp.status_code == 200
    assert resp["X-Request-Id"] == valid_request_id
