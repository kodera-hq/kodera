"""Storage descriptors cannot escape scope or accept unverified provider metadata."""

import hashlib
import json
import secrets
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest

from apps.media import storage_worker
from apps.media.storage import (
    ObjectDescriptor,
    S3Credential,
    S3Location,
    StorageRefusedError,
    disposition,
    presign,
)
from apps.media.storage_gateway import Gateway, message


def obj():
    return ObjectDescriptor(
        uuid4(),
        uuid4(),
        "example.txt",
        "text/plain",
        42,
        hashlib.sha256(secrets.token_bytes(42)).hexdigest(),
    )


@pytest.mark.parametrize(
    "change",
    [
        {"filename": "../outside"},
        {"filename": "bad\r\nheader"},
        {"filename": "bad\\path"},
        {"content_type": "text/html"},
        {"content_type": "image/svg+xml"},
        {"content_type": {}},
        {"size_bytes": True},
        {"size_bytes": 0},
        {"size_bytes": 26214401},
        {"sha256": "invalid"},
        {"organisation_id": "../outside"},
    ],
)
def test_upload_descriptor_refuses_unsafe_claims(change):
    with pytest.raises(StorageRefusedError):
        replace(obj(), **change)


def test_only_ids_form_object_keys_and_upload_headers_bind_the_claims():
    upload = obj()
    credential = S3Credential(secrets.token_hex(12), secrets.token_urlsafe(32))
    location = S3Location("https://storage.example.org", "example-bucket", "fr-par")
    url, headers = presign(location, credential, upload, method="PUT", now=datetime.now(UTC))
    assert (
        upload.key == f"organisations/{upload.organisation_id}/attachments/{upload.attachment_id}"
    )
    assert upload.filename not in urlsplit(url).path
    assert headers["content-length"] == str(upload.size_bytes)
    assert headers["content-type"] == upload.content_type
    assert headers["x-amz-checksum-sha256"] == upload.checksum
    assert headers["content-disposition"].startswith("attachment;")
    signed = parse_qs(urlsplit(url).query)["X-Amz-SignedHeaders"][0].split(";")
    assert set(signed) == {"host", *headers}
    assert credential.secret_key not in url
    assert credential.secret_key not in repr(credential)
    download, _ = presign(location, credential, upload, method="GET", now=datetime.now(UTC))
    assert parse_qs(urlsplit(download).query)["response-content-disposition"] == ["attachment"]
    assert "\r" not in disposition("été.txt")


def test_worker_reloads_a_rotated_mounted_credential_and_refuses_escaped_symlink(tmp_path):
    upload = obj()
    path = tmp_path / str(upload.organisation_id)
    worker = storage_worker.StorageWorker(storage_worker.DirectorySource(tmp_path))
    data = {
        "endpoint": "https://storage.example.org",
        "bucket": "example-bucket",
        "region": "fr-par",
        "accessKey": secrets.token_hex(12),
        "secretKey": secrets.token_urlsafe(32),
    }
    path.write_text(json.dumps(data))
    first = worker.execute({"operation": "upload", "object": message(upload)})
    data["accessKey"] = secrets.token_hex(12)
    path.write_text(json.dumps(data))
    second = worker.execute({"operation": "upload", "object": message(upload)})
    assert first["url"] != second["url"]
    assert data["accessKey"] in second["url"]
    path.unlink()
    path.symlink_to(tmp_path.parent / str(uuid4()))
    with pytest.raises(StorageRefusedError):
        worker.execute({"operation": "upload", "object": message(upload)})


@pytest.mark.parametrize(
    "change",
    [
        {"status": 404},
        {"content-length": "43"},
        {"content-type": "text/html"},
        {"x-amz-checksum-sha256": "invalid"},
        {"x-amz-checksum-sha256": None},
        {"x-amz-checksum-type": "COMPOSITE"},
        {"duplicate": True},
    ],
)
def test_completion_refuses_wrong_or_missing_actual_object_facts(monkeypatch, change):
    upload = obj()
    facts = {
        "content-length": str(upload.size_bytes),
        "content-type": upload.content_type,
        "x-amz-checksum-sha256": upload.checksum,
    }
    facts.update({k: v for k, v in change.items() if k not in {"status", "duplicate"}})
    pairs = [(k, v) for k, v in facts.items() if v is not None]
    if change.get("duplicate"):
        pairs.append(("Content-Length", str(upload.size_bytes)))
    response = SimpleNamespace(
        status=change.get("status", 200),
        getheaders=lambda: pairs,
        getheader=lambda k: facts.get(k),
        close=lambda: None,
    )
    calls = []

    def fetch(destination, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(close=lambda: None), response

    monkeypatch.setattr(storage_worker.outbound, "request", fetch)
    with pytest.raises(StorageRefusedError):
        storage_worker._verify(
            S3Location("https://storage.example.org", "example-bucket", "fr-par"),
            S3Credential(secrets.token_hex(12), secrets.token_urlsafe(32)),
            upload,
        )
    assert calls[0]["method"] == "HEAD"
    assert calls[0]["headers"]["x-amz-checksum-mode"] == "ENABLED"


def test_absent_gateway_is_refused_without_fallback(tmp_path):
    with pytest.raises(StorageRefusedError):
        Gateway(None)
    with pytest.raises(StorageRefusedError):
        Gateway(str(tmp_path / "missing")).call("upload", obj())


@pytest.fixture
def socket_directory():
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory(prefix="km-", dir="/tmp") as path:
        yield Path(path)


def test_api_delegates_over_private_socket_without_receiving_storage_secret(
    tmp_path, socket_directory
):
    import stat
    import threading

    upload = obj()
    directory = tmp_path / "mounted"
    directory.mkdir()
    secret = secrets.token_urlsafe(32)
    (directory / str(upload.organisation_id)).write_text(
        json.dumps(
            {
                "endpoint": "https://storage.example.org",
                "bucket": "example-bucket",
                "region": "fr-par",
                "accessKey": secrets.token_hex(12),
                "secretKey": secret,
            }
        )
    )
    socket_path = socket_directory / "signer.sock"
    server = storage_worker.bind(socket_path, storage_worker.DirectorySource(directory))
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        result = Gateway(str(socket_path)).call("upload", upload)
        assert set(result) == {"url", "headers", "expiresAt"}
        assert secret not in json.dumps(result)
        assert upload.key in result["url"]
        assert stat.S_IMODE(socket_path.stat().st_mode) == 0o600
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    assert not thread.is_alive()


@pytest.mark.parametrize(
    "environment",
    [
        {"SCW_AUTH_KEY": "placeholder"},
        {"SOPS_AGE_KEY_FILE": "placeholder"},
        {"DJANGO_DEBUG": "true"},
        {"DJANGO_SETTINGS_MODULE": "other.profile"},
        {"KODERA_FAULT_TEST": "1"},
    ],
)
def test_worker_startup_reuses_the_deployed_environment_refusals(
    monkeypatch, environment, tmp_path
):
    import sys

    monkeypatch.setattr(
        sys,
        "argv",
        [
            "media-worker",
            "--socket",
            str(tmp_path / "example.sock"),
            "--secret-directory",
            str(tmp_path / "mounted"),
        ],
    )
    monkeypatch.setattr(
        storage_worker, "serve", lambda *args: pytest.fail("unsafe worker reached its socket")
    )
    with pytest.raises(SystemExit) as failure:
        storage_worker.main(environment)
    assert failure.value.code == 2


@pytest.mark.parametrize(
    "status, result, mismatch",
    [
        (200, {"verified": 1}, False),
        (200, {"verified": False}, False),
        (409, {"error": "object verification failed"}, True),
        (503, {"error": "storage unavailable"}, False),
    ],
)
def test_gateway_distinguishes_object_mismatch_from_unavailable_or_invalid_reply(
    monkeypatch, tmp_path, status, result, mismatch
):
    from apps.media import storage_gateway
    from apps.media.storage import ObjectMismatchError

    class Connection:
        def __init__(self, path):
            self.closed = False

        def request(self, *args, **kwargs):
            pass

        def getresponse(self):
            return SimpleNamespace(
                status=status, read=lambda n: json.dumps(result).encode(), close=lambda: None
            )

        def close(self):
            self.closed = True

    monkeypatch.setattr(storage_gateway, "_Connection", Connection)
    with pytest.raises(StorageRefusedError) as failure:
        Gateway(str(tmp_path / "signer.sock")).call("verify", obj())
    assert isinstance(failure.value, ObjectMismatchError) is mismatch
