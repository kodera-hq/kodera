"""API-side delegation: only a private Unix socket, never an S3 credential."""

import http.client
import json
import socket
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .outbound import target
from .storage import ObjectDescriptor, ObjectMismatchError, StorageRefusedError
from .storage_protocol import MAX_RPC_BYTES, unique_object


class _Connection(http.client.HTTPConnection):
    def __init__(self, path: str) -> None:
        super().__init__("localhost", timeout=15)
        self.path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        try:
            self.sock.connect(self.path)
        except BaseException:
            self.sock.close()
            raise


def message(obj: ObjectDescriptor) -> dict[str, Any]:
    return {
        "organisationId": str(obj.organisation_id),
        "attachmentId": str(obj.attachment_id),
        "filename": obj.filename,
        "contentType": obj.content_type,
        "sizeBytes": obj.size_bytes,
        "sha256": obj.sha256,
    }


class Gateway:
    def __init__(self, socket_path: str | None) -> None:
        if not socket_path or not Path(socket_path).is_absolute():
            raise StorageRefusedError()
        self.path = socket_path

    def call(self, operation: str, obj: ObjectDescriptor) -> dict[str, Any]:
        raw = json.dumps(
            {"operation": operation, "object": message(obj)}, separators=(",", ":")
        ).encode()
        if len(raw) > MAX_RPC_BYTES:
            raise StorageRefusedError()
        connection = _Connection(self.path)
        response = None
        try:
            connection.request(
                "POST",
                "/rpc",
                body=raw,
                headers={"Content-Type": "application/json", "Connection": "close"},
            )
            response = connection.getresponse()
            body = response.read(MAX_RPC_BYTES + 1)
            if len(body) > MAX_RPC_BYTES:
                raise StorageRefusedError()
            result = json.loads(body, object_pairs_hook=unique_object)
            if response.status == 409 and result == {"error": "object verification failed"}:
                raise ObjectMismatchError()
            if response.status != 200:
                raise StorageRefusedError()
            if operation == "verify":
                if (
                    not isinstance(result, dict)
                    or set(result) != {"verified"}
                    or result["verified"] is not True
                ):
                    raise StorageRefusedError()
            else:
                if not isinstance(result, dict) or set(result) != {"url", "headers", "expiresAt"}:
                    raise StorageRefusedError()
                target(result["url"], https_only=True)
                expiry = datetime.fromisoformat(result["expiresAt"])
                if (
                    expiry.tzinfo is None
                    or not 0 < (expiry - datetime.now(UTC)).total_seconds() <= 300
                ):
                    raise StorageRefusedError()
                if not isinstance(result["headers"], dict) or not all(
                    isinstance(k, str)
                    and isinstance(v, str)
                    and "\r" not in k + v
                    and "\n" not in k + v
                    for k, v in result["headers"].items()
                ):
                    raise StorageRefusedError()
            return result
        except ObjectMismatchError:
            raise
        except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException):
            raise StorageRefusedError() from None
        finally:
            if response is not None:
                response.close()
            connection.close()
