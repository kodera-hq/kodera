"""Per-request storage credentials behind a private, filesystem-authorized Unix socket.

This process is separate from the API. Mount the Secret Manager directory only
into this worker; mount only its socket into the API. Never log RPC bodies or URLs.
"""

from __future__ import annotations

import argparse
import hmac
import http.client
import json
import os
import socketserver
import stat
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from uuid import UUID

from . import outbound
from .storage import (
    EXPIRY_SECONDS,
    ObjectDescriptor,
    ObjectMismatchError,
    S3Credential,
    S3Location,
    StorageRefusedError,
    presign,
)
from .storage_protocol import MAX_RPC_BYTES, unique_object

MAX_SECRET_BYTES = 16384


def descriptor(data: Any) -> ObjectDescriptor:
    if not isinstance(data, dict) or set(data) != {
        "organisationId",
        "attachmentId",
        "filename",
        "contentType",
        "sizeBytes",
        "sha256",
    }:
        raise StorageRefusedError()
    try:
        return ObjectDescriptor(
            UUID(data["organisationId"]),
            UUID(data["attachmentId"]),
            data["filename"],
            data["contentType"],
            data["sizeBytes"],
            data["sha256"],
        )
    except (ValueError, TypeError, AttributeError):
        raise StorageRefusedError() from None


class DirectorySource:
    def __init__(self, directory: Path) -> None:
        self.directory = directory

    @contextmanager
    def load(self, organisation_id: UUID) -> Iterator[tuple[S3Location, S3Credential]]:
        # A mounted Secret Manager version may use symlinks, but cannot escape its root.
        try:
            root = self.directory.resolve(strict=True)
            path = (root / str(organisation_id)).resolve(strict=True)
            if not path.is_relative_to(root) or not stat.S_ISREG(path.stat().st_mode):
                raise StorageRefusedError()
            with path.open("rb") as stream:
                raw = stream.read(MAX_SECRET_BYTES + 1)
            if len(raw) > MAX_SECRET_BYTES:
                raise StorageRefusedError()
            data = json.loads(raw, object_pairs_hook=unique_object)
            del raw
            if (
                not isinstance(data, dict)
                or not {"endpoint", "bucket", "region", "accessKey", "secretKey"} <= data.keys()
                or data.keys()
                - {"endpoint", "bucket", "region", "accessKey", "secretKey", "sessionToken"}
            ):
                raise StorageRefusedError()
            if not all(isinstance(value, str) for value in data.values()):
                raise StorageRefusedError()
            location = S3Location(data["endpoint"], data["bucket"], data["region"])
            credential = S3Credential(
                data["accessKey"], data["secretKey"], data.get("sessionToken")
            )
            del data
        except (OSError, UnicodeError, ValueError, TypeError):
            raise StorageRefusedError() from None
        try:
            yield location, credential
        finally:
            # Strings cannot be zeroed; release this request's references without caching.
            del credential


def _verify(location: S3Location, credential: S3Credential, obj: ObjectDescriptor) -> None:
    url, headers = presign(location, credential, obj, method="HEAD", now=datetime.now(UTC))
    connection, response = outbound.request(
        outbound.target(url, https_only=True),
        method="HEAD",
        headers=headers,
        deadline=time.monotonic() + 10,
    )
    try:
        expected = {
            "content-length": str(obj.size_bytes),
            "content-type": obj.content_type,
            "x-amz-checksum-sha256": obj.checksum,
        }
        if response.status == 404:
            raise ObjectMismatchError()
        if response.status != 200:
            raise StorageRefusedError()
        for name, value in expected.items():
            actual = [v.strip() for k, v in response.getheaders() if k.lower() == name]
            if len(actual) != 1 or not hmac.compare_digest(actual[0], value):
                raise ObjectMismatchError()
        # Only one-shot PUTs are signed. A multipart aggregate is not a whole-object digest.
        checksum_kind = response.getheader("x-amz-checksum-type")
        if checksum_kind not in {None, "FULL_OBJECT"}:
            raise ObjectMismatchError()
    finally:
        response.close()
        connection.close()


class StorageWorker:
    def __init__(self, source: DirectorySource) -> None:
        self.source = source

    def execute(self, message: Any) -> dict[str, Any]:
        if not isinstance(message, dict) or set(message) != {"operation", "object"}:
            raise StorageRefusedError()
        operation, obj = message["operation"], descriptor(message["object"])
        if not isinstance(operation, str) or operation not in {"upload", "download", "verify"}:
            raise StorageRefusedError()
        with self.source.load(obj.organisation_id) as (location, credential):
            if operation == "verify":
                _verify(location, credential, obj)
                return {"verified": True}
            now = datetime.now(UTC)
            url, headers = presign(
                location,
                credential,
                obj,
                method="PUT" if operation == "upload" else "GET",
                now=now,
            )
            return {
                "url": url,
                "headers": headers,
                "expiresAt": (now + timedelta(seconds=EXPIRY_SECONDS)).isoformat(),
            }


class _UnixServer(socketserver.UnixStreamServer):
    allow_reuse_address = False
    request_queue_size = 4

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Exception renderers must not disclose a credential or signed resource URL.
        return


class _Handler(BaseHTTPRequestHandler):
    server: _UnixServer

    def log_message(self, format: str, *args: Any) -> None:
        return

    def setup(self) -> None:
        self.request.settimeout(15)
        super().setup()

    def do_POST(self) -> None:
        status, result = 503, {"error": "storage unavailable"}
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if (
                self.path != "/rpc"
                or len(lengths) != 1
                or self.headers.get("Transfer-Encoding")
                or self.headers.get("Content-Type") != "application/json"
            ):
                raise StorageRefusedError()
            if not lengths[0].isdigit() or len(lengths[0]) > 6:
                raise StorageRefusedError()
            length = int(lengths[0])
            if not 1 <= length <= MAX_RPC_BYTES:
                raise StorageRefusedError()
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise StorageRefusedError()
            message = json.loads(raw, object_pairs_hook=unique_object)
            result = self.server.worker.execute(message)  # type: ignore[attr-defined]
            status = 200
        except ObjectMismatchError:
            status, result = 409, {"error": "object verification failed"}
        except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
            pass
        body = json.dumps(result, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)


def bind(path: Path, source: DirectorySource) -> _UnixServer:
    # Refuse existing sockets/files rather than unlinking another process's endpoint.
    if not path.is_absolute() or len(os.fsencode(path)) > 100 or path.exists() or path.is_symlink():
        raise StorageRefusedError()
    previous_umask = os.umask(0o177)
    try:
        server = _UnixServer(str(path), _Handler)
    finally:
        os.umask(previous_umask)
    server.worker = StorageWorker(source)  # type: ignore[attr-defined]
    return server


def serve(path: Path, source: DirectorySource) -> None:
    server = bind(path, source)
    inode = path.stat().st_ino
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        if path.is_socket() and path.stat().st_ino == inode:
            path.unlink()


def main(environment: Mapping[str, str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--secret-directory", type=Path, required=True)
    arguments = parser.parse_args()
    from django.core.exceptions import ImproperlyConfigured

    from config.deploy_environment import _refuse_unsafe

    try:
        _refuse_unsafe(os.environ if environment is None else environment, "kodera-media-worker")
    except ImproperlyConfigured:
        parser.error("the media worker environment is unsafe")
    serve(arguments.socket, DirectorySource(arguments.secret_directory))


if __name__ == "__main__":
    main()
