"""Per-request storage credentials behind a private, filesystem-authorized Unix socket.

This process is separate from the API. Mount the Secret Manager directory only
into this worker; mount only its socket into the API. Never log RPC bodies or URLs.
"""

from __future__ import annotations

import argparse
import fcntl
import hmac
import http.client
import json
import os
import signal
import socketserver
import stat
import threading
import time
from collections.abc import Iterator, Mapping
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from uuid import UUID
from xml.etree import ElementTree

from . import outbound
from .storage import (
    EXPIRY_SECONDS,
    ObjectDescriptor,
    ObjectKey,
    ObjectMismatchError,
    S3Credential,
    S3Location,
    StorageRefusedError,
    parse_object_key,
    presign,
    presign_prefix_request,
)
from .storage_protocol import MAX_RPC_BYTES, unique_object

MAX_SECRET_BYTES = 16384
MAX_CONCURRENT_RPCS = 32
MAX_QUEUED_RPCS = 64


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


def delete_target(data: Any) -> ObjectKey:
    if not isinstance(data, dict):
        raise StorageRefusedError()
    if set(data) == {"key"} and isinstance(data["key"], str):
        return parse_object_key(data["key"])
    if set(data) == {"organisationId", "attachmentId"}:
        if not isinstance(data["organisationId"], str) or not isinstance(data["attachmentId"], str):
            raise StorageRefusedError()
        try:
            return ObjectKey(UUID(data["organisationId"]), UUID(data["attachmentId"]))
        except ValueError:
            raise StorageRefusedError() from None
    desc = descriptor(data)
    return ObjectKey(desc.organisation_id, desc.attachment_id)


class DirectorySource:
    _S3_REQUIRED = frozenset({"endpoint", "bucket", "region", "accessKey", "secretKey"})
    _SYNAPSE_KEYS = frozenset({"synapseUrl", "synapseToken", "synapseAgentUser"})
    _ALLOWED_KEYS = _S3_REQUIRED | frozenset({"sessionToken"}) | _SYNAPSE_KEYS

    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def _read_secret_document(self, organisation_id: UUID) -> dict[str, str]:
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
                or not self._S3_REQUIRED <= data.keys()
                or data.keys() - self._ALLOWED_KEYS
            ):
                raise StorageRefusedError()
            if not all(isinstance(value, str) for value in data.values()):
                raise StorageRefusedError()
            present_synapse = data.keys() & self._SYNAPSE_KEYS
            if present_synapse and present_synapse != self._SYNAPSE_KEYS:
                raise StorageRefusedError()
            return data
        except (OSError, UnicodeError, ValueError, TypeError):
            raise StorageRefusedError() from None

    @contextmanager
    def load(self, organisation_id: UUID) -> Iterator[tuple[S3Location, S3Credential]]:
        data = self._read_secret_document(organisation_id)
        try:
            location = S3Location(data["endpoint"], data["bucket"], data["region"])
            credential = S3Credential(
                data["accessKey"], data["secretKey"], data.get("sessionToken")
            )
            del data
        except (ValueError, TypeError):
            raise StorageRefusedError() from None
        try:
            yield location, credential
        finally:
            # Strings cannot be zeroed; release this request's references without caching.
            del credential

    @contextmanager
    def load_room_verifier(self, organisation_id: UUID) -> Iterator[tuple[str, str, str] | None]:
        data = self._read_secret_document(organisation_id)
        if not (data.keys() & self._SYNAPSE_KEYS):
            del data
            yield None
            return
        synapse_url = data["synapseUrl"].rstrip("/")
        synapse_token = data["synapseToken"]
        agent_user = data["synapseAgentUser"]
        del data
        if (
            not synapse_url.startswith(("http://", "https://"))
            or not synapse_token
            or not agent_user.startswith("@")
            or ":" not in agent_user
        ):
            del synapse_token
            raise StorageRefusedError()
        try:
            yield synapse_url, synapse_token, agent_user
        finally:
            del synapse_token


def _verify(location: S3Location, credential: S3Credential, obj: ObjectDescriptor) -> None:
    url, headers = presign(location, credential, obj, method="HEAD", now=datetime.now(UTC))
    connection, response = outbound.request(
        outbound.target(url, https_only=True),
        method="HEAD",
        headers=headers,
        deadline=time.monotonic() + 10,
        pool="storage",
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


def _delete(location: S3Location, credential: S3Credential, target: ObjectKey) -> None:
    delete_url, delete_headers = presign(
        location, credential, target, method="DELETE", now=datetime.now(UTC)
    )
    del_conn, del_resp = outbound.request(
        outbound.target(delete_url, https_only=True),
        method="DELETE",
        headers=delete_headers,
        deadline=time.monotonic() + 10,
        pool="storage",
    )
    try:
        if del_resp.status not in {200, 204, 404}:
            raise StorageRefusedError()
    finally:
        del_resp.close()
        del_conn.close()

    # Confirm complete absence via signed S3 HEAD returning HTTP 404 (BUG-0021, BUG-0025).
    head_url, head_headers = presign(
        location, credential, target, method="HEAD", now=datetime.now(UTC)
    )
    head_conn, head_resp = outbound.request(
        outbound.target(head_url, https_only=True),
        method="HEAD",
        headers=head_headers,
        deadline=time.monotonic() + 10,
        pool="storage",
    )
    try:
        if head_resp.status != 404:
            raise StorageRefusedError()
    finally:
        head_resp.close()
        head_conn.close()


def _prefix_request(location, credential, organisation_id, *, continuation=None, key=None):
    url, headers = presign_prefix_request(
        location,
        credential,
        organisation_id,
        now=datetime.now(UTC),
        continuation=continuation,
        key=key,
    )
    conn, response = outbound.request(
        outbound.target(url, https_only=True),
        method="GET" if key is None else "DELETE",
        headers=headers,
        deadline=time.monotonic() + 10,
        pool="storage",
    )
    try:
        if key is not None:
            if response.status not in {200, 204, 404}:
                raise StorageRefusedError()
            return None
        raw = response.read(256 * 1024 + 1)
        if response.status != 200 or len(raw) > 256 * 1024 or b"<!" in raw:
            raise StorageRefusedError()
        try:
            text = raw.decode("utf-8")
            if "<!" in text:
                raise StorageRefusedError()
            document = ElementTree.fromstring(text)  # noqa: S314 - bounded UTF-8 with all DTD/entity declarations refused
        except (UnicodeError, ElementTree.ParseError):
            raise StorageRefusedError() from None
        ns = "{http://s3.amazonaws.com/doc/2006-03-01/}"
        if document.tag != ns + "ListBucketResult":
            raise StorageRefusedError()
        prefix = f"organisations/{organisation_id}/attachments/"
        if document.findtext(ns + "Prefix") != prefix:
            raise StorageRefusedError()
        keys = [item.findtext(ns + "Key") for item in document.findall(ns + "Contents")]
        if len(keys) > 10 or any(
            not key
            or not key.startswith(prefix)
            or len(key.encode("utf-8")) > 1024
            or any(part in {".", ".."} for part in key.split("/"))
            for key in keys
        ):
            raise StorageRefusedError()
        truncated = document.findtext(ns + "IsTruncated")
        if truncated not in {"true", "false"}:
            raise StorageRefusedError()
        token = document.findtext(ns + "NextContinuationToken") if truncated == "true" else None
        if truncated == "true" and (
            not token or token == continuation or len(token) > 4096 or not token.isascii()
        ):
            raise StorageRefusedError()
        return keys, token
    finally:
        response.close()
        conn.close()


def _room_member_target(data: Any) -> tuple[UUID, str, str]:
    if (
        not isinstance(data, dict)
        or set(data) != {"organisationId", "roomId", "subject"}
        or not isinstance(data["organisationId"], str)
        or not isinstance(data["roomId"], str)
        or not isinstance(data["subject"], str)
        or not 3 <= len(data["roomId"]) <= 255
        or not 1 <= len(data["subject"]) <= 255
    ):
        raise StorageRefusedError()
    try:
        return UUID(data["organisationId"]), data["roomId"], data["subject"]
    except ValueError:
        raise StorageRefusedError() from None


class StorageWorker:
    def __init__(self, source: DirectorySource) -> None:
        self.source = source

    def execute(self, message: Any) -> dict[str, Any]:
        if not isinstance(message, dict) or set(message) != {"operation", "object"}:
            raise StorageRefusedError()
        operation = message["operation"]
        if not isinstance(operation, str) or operation not in {
            "upload",
            "download",
            "verify",
            "delete",
            "room_member",
            "attachment_prefix",
        }:
            raise StorageRefusedError()
        if operation == "attachment_prefix":
            data = message["object"]
            if (
                not isinstance(data, dict)
                or set(data) != {"organisationId", "continuation", "key"}
                or not isinstance(data["organisationId"], str)
                or (data["continuation"] is not None and not isinstance(data["continuation"], str))
                or (data["key"] is not None and not isinstance(data["key"], str))
            ):
                raise StorageRefusedError()
            try:
                org_id = UUID(data["organisationId"])
            except ValueError:
                raise StorageRefusedError() from None
            with self.source.load(org_id) as (location, credential):
                result = _prefix_request(
                    location, credential, org_id, continuation=data["continuation"], key=data["key"]
                )
            if data["key"] is not None:
                return {"deleted": True}
            keys, token = result
            return {"keys": keys, "continuation": token}
        if operation == "room_member":
            org_id, room_id, subject = _room_member_target(message["object"])
            with self.source.load_room_verifier(org_id) as verifier:
                if verifier is None:
                    return {"configured": False, "allowed": False}
                synapse_url, synapse_token, agent_user = verifier
                from room_access.clients import Matrix, UpstreamError

                try:
                    allowed = Matrix(synapse_url, synapse_token, timeout=3.0).dm_member_joined(
                        room_id, subject, agent_user
                    )
                except UpstreamError:
                    raise StorageRefusedError() from None
                return {"configured": True, "allowed": bool(allowed)}
        if operation == "delete":
            target = delete_target(message["object"])
            with self.source.load(target.organisation_id) as (location, credential):
                _delete(location, credential, target)
            return {"deleted": True}
        obj = descriptor(message["object"])
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
    request_queue_size = MAX_QUEUED_RPCS

    def __init__(self, server_address: str, handler_class: type[BaseHTTPRequestHandler]) -> None:
        super().__init__(server_address, handler_class)
        self._executor = ThreadPoolExecutor(
            max_workers=MAX_CONCURRENT_RPCS, thread_name_prefix="media-rpc"
        )
        self._backlog = threading.BoundedSemaphore(MAX_QUEUED_RPCS)
        self._lock_fd: int | None = None
        self._bound_path: Path | None = None
        self._socket_inode: int | None = None

    def _process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            self.finish_request(request, client_address)
        except Exception:  # noqa: BLE001
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)
            self._backlog.release()

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._backlog.acquire(blocking=False):
            try:
                body = b'{"error":"storage unavailable"}'
                request.sendall(
                    b"HTTP/1.1 503 Service Unavailable\r\n"
                    b"Content-Type: application/json\r\n"
                    b"Cache-Control: no-store\r\n"
                    b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n"
                    b"Connection: close\r\n\r\n" + body
                )
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            self._executor.submit(self._process_request_thread, request, client_address)
        except BaseException:
            self._backlog.release()
            self.shutdown_request(request)
            raise

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Exception renderers must not disclose a credential or signed resource URL.
        return

    def server_close(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=False)
        super().server_close()
        if self._bound_path is not None and self._socket_inode is not None:
            try:
                info = self._bound_path.lstat()
                if stat.S_ISSOCK(info.st_mode) and info.st_ino == self._socket_inode:
                    self._bound_path.unlink()
            except OSError:
                pass
            self._bound_path = None
            self._socket_inode = None
        if self._lock_fd is not None:
            try:
                os.close(self._lock_fd)
            except OSError:
                pass
            self._lock_fd = None


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
    # Coordinate exclusive ownership via `media.sock.lock` (mode 0600, O_NOFOLLOW, uid-verified)
    # before unlinking an unlocked stale socket left behind by SIGKILL or power loss (BUG-0023).
    if not path.is_absolute() or len(os.fsencode(path)) > 100 or path.is_symlink():
        raise StorageRefusedError()
    lock_path = str(path) + ".lock"
    if len(os.fsencode(lock_path)) > 255:
        raise StorageRefusedError()

    lock_fd: int | None = None
    previous_umask = os.umask(0o177)
    try:
        try:
            lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            lock_info = os.fstat(lock_fd)
            if (
                not stat.S_ISREG(lock_info.st_mode)
                or lock_info.st_uid != os.geteuid()
                or (lock_info.st_mode & 0o077) != 0
            ):
                raise StorageRefusedError()
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if path.exists() or path.is_symlink():
                existing = path.lstat()
                if not stat.S_ISSOCK(existing.st_mode):
                    raise StorageRefusedError()
                path.unlink()
            server = _UnixServer(str(path), _Handler)
            path.chmod(0o600)
        except (StorageRefusedError, SystemExit, KeyboardInterrupt):
            if lock_fd is not None:
                try:
                    os.close(lock_fd)
                except OSError:
                    pass
            raise
        except BaseException:
            if lock_fd is not None:
                try:
                    os.close(lock_fd)
                except OSError:
                    pass
            raise StorageRefusedError() from None
    finally:
        os.umask(previous_umask)

    server._lock_fd = lock_fd
    server._bound_path = path
    server._socket_inode = path.stat().st_ino
    server.worker = StorageWorker(source)  # type: ignore[attr-defined]
    return server


def serve(path: Path, source: DirectorySource) -> None:
    previous_handlers: list[tuple[signal.Signals, Any]] = []
    if threading.current_thread() is threading.main_thread():

        def _stop(_sig: int, _frame: Any) -> None:
            raise SystemExit(0)

        for sig in (signal.SIGTERM, signal.SIGINT):
            previous_handlers.append((sig, signal.getsignal(sig)))
            signal.signal(sig, _stop)
    server: _UnixServer | None = None
    try:
        server = bind(path, source)
        server.serve_forever(poll_interval=0.2)
    finally:
        for prev_sig, prev in previous_handlers:
            signal.signal(prev_sig, prev)
        if server is not None:
            server.server_close()


def main(environment: Mapping[str, str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--secret-directory", type=Path, required=True)
    arguments = parser.parse_args()
    from config.deploy_environment import ImproperlyConfigured, _refuse_unsafe

    try:
        _refuse_unsafe(os.environ if environment is None else environment, "kodera-media-worker")
    except ImproperlyConfigured:
        parser.error("the media worker environment is unsafe")
    serve(arguments.socket, DirectorySource(arguments.secret_directory))


if __name__ == "__main__":
    main()
