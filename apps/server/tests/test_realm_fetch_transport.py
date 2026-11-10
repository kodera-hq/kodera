"""HTTP development exceptions never admit a remote issuer."""

from unittest.mock import MagicMock

import pytest

from apps.orgs import realm_bootstrap as rb


@pytest.mark.parametrize("host", ["example.org", "localhost.example.org", "127.0.0.2", "192.168.1.1", "2130706433"])
def test_remote_http_is_refused_before_network(settings, monkeypatch, host):
    settings.KODERA_LOOPBACK_ISSUERS = True
    opener = MagicMock()
    monkeypatch.setattr(rb.urllib.request, "build_opener", opener)
    with pytest.raises(rb.RealmUnreachable):
        rb.fetch_document(f"http://{host}/realm", "synthetic-request")
    opener.assert_not_called()


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "[::1]"])
@pytest.mark.parametrize("enabled", [False, True])
def test_loopback_requires_the_explicit_development_switch(settings, monkeypatch, host, enabled):
    settings.KODERA_LOOPBACK_ISSUERS = enabled
    opener = MagicMock()
    response = opener.return_value.open.return_value.__enter__.return_value
    response.status = 200
    response.read.return_value = b"{}"
    monkeypatch.setattr(rb.urllib.request, "build_opener", opener)
    if enabled:
        assert rb.fetch_document(f"http://{host}/realm", "synthetic-request") == {}
        opener.assert_called_once()
    else:
        with pytest.raises(rb.RealmUnreachable):
            rb.fetch_document(f"http://{host}/realm", "synthetic-request")
        opener.assert_not_called()
