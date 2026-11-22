"""API-side delegation: only a private Unix socket, never an S3 credential."""

import http.client
import json
import socket
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from .outbound import target
from .storage import (
    ObjectDescriptor,
    ObjectKey,
    ObjectMismatchError,
    StorageRefusedError,
    parse_object_key,
)
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


def message(obj: ObjectDescriptor | ObjectKey | str) -> dict[str, Any]:
    if isinstance(obj, str):
        parsed = parse_object_key(obj)
        return {
            "organisationId": str(parsed.organisation_id),
            "attachmentId": str(parsed.attachment_id),
        }
    if isinstance(obj, ObjectKey):
        return {
            "organisationId": str(obj.organisation_id),
            "attachmentId": str(obj.attachment_id),
        }
    if isinstance(obj, ObjectDescriptor):
        return {
            "organisationId": str(obj.organisation_id),
            "attachmentId": str(obj.attachment_id),
            "filename": obj.filename,
            "contentType": obj.content_type,
            "sizeBytes": obj.size_bytes,
            "sha256": obj.sha256,
        }
    raise StorageRefusedError()


class Gateway:
    def __init__(self, socket_path: str | None) -> None:
        if not socket_path or not Path(socket_path).is_absolute():
            raise StorageRefusedError()
        self.path = socket_path

    def call(
        self, operation: str, obj: ObjectDescriptor | ObjectKey | str | dict[str, Any]
    ) -> dict[str, Any]:
        if operation == "attachment_prefix":
            if not isinstance(obj, dict):
                raise StorageRefusedError()
            object_message = obj
        else:
            if isinstance(obj, dict) or (
                operation != "delete" and not isinstance(obj, ObjectDescriptor)
            ):
                raise StorageRefusedError()
            object_message = message(obj)
        raw = json.dumps(
            {"operation": operation, "object": object_message}, separators=(",", ":")
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
            if operation == "attachment_prefix":
                if object_message["key"] is not None:
                    if result != {"deleted": True}:
                        raise StorageRefusedError()
                elif (
                    not isinstance(result, dict)
                    or set(result) != {"keys", "continuation"}
                    or not isinstance(result["keys"], list)
                    or len(result["keys"]) > 10
                    or any(
                        not isinstance(key, str)
                        or not key.startswith(
                            f"organisations/{object_message['organisationId']}/attachments/"
                        )
                        or len(key.encode("utf-8")) > 1024
                        or any(part in {".", ".."} for part in key.split("/"))
                        for key in result["keys"]
                    )
                    or (
                        result["continuation"] is not None
                        and (
                            not isinstance(result["continuation"], str)
                            or not result["continuation"]
                            or len(result["continuation"]) > 4096
                            or not result["continuation"].isascii()
                        )
                    )
                ):
                    raise StorageRefusedError()
            elif operation == "verify":
                if (
                    not isinstance(result, dict)
                    or set(result) != {"verified"}
                    or result["verified"] is not True
                ):
                    raise StorageRefusedError()
            elif operation == "delete":
                if (
                    not isinstance(result, dict)
                    or set(result) != {"deleted"}
                    or result["deleted"] is not True
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

    def delete_object(self, target_obj: str | ObjectDescriptor | ObjectKey) -> dict[str, Any]:
        return self.call("delete", target_obj)

    def verify_room_member(
        self, *, organisation_id: UUID, room_id: str, subject: str
    ) -> bool | None:
        raw = json.dumps(
            {
                "operation": "room_member",
                "object": {
                    "organisationId": str(organisation_id),
                    "roomId": room_id,
                    "subject": subject,
                },
            },
            separators=(",", ":"),
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
            if len(body) > MAX_RPC_BYTES or response.status != 200:
                raise StorageRefusedError()
            result = json.loads(body, object_pairs_hook=unique_object)
            if (
                not isinstance(result, dict)
                or set(result) != {"configured", "allowed"}
                or not isinstance(result["configured"], bool)
                or not isinstance(result["allowed"], bool)
            ):
                raise StorageRefusedError()
            if not result["configured"]:
                return None
            return result["allowed"]
        except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException):
            raise StorageRefusedError() from None
        finally:
            if response is not None:
                response.close()
            connection.close()


def delete_object(
    target_obj: str | ObjectDescriptor | ObjectKey, *, socket_path: str | None = None
) -> dict[str, Any]:
    """Delete an S3 object via the private worker socket and confirm HTTP 404 via signed HEAD."""
    resolved_socket = socket_path
    if resolved_socket is None:
        from django.conf import settings

        resolved_socket = getattr(settings, "KODERA_MEDIA_GATEWAY_SOCKET", None)
    return Gateway(resolved_socket).delete_object(target_obj)


def attachment_prefix(
    organisation_id: UUID,
    *,
    continuation: str | None = None,
    key: str | None = None,
    socket_path: str | None = None,
) -> dict[str, Any]:
    """List one S3 page or delete a prefix-scoped key through the private worker."""
    if socket_path is None:
        from django.conf import settings

        socket_path = getattr(settings, "KODERA_MEDIA_GATEWAY_SOCKET", None)
    return Gateway(socket_path).call(
        "attachment_prefix",
        {
            "organisationId": str(organisation_id),
            "continuation": continuation,
            "key": key,
        },
    )
