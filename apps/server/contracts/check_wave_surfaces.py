"""Offline acceptance of the additive workspace wire surfaces; no runtime claims."""

from __future__ import annotations

import argparse
import copy
from pathlib import Path
from typing import Any

import jsonschema_rs
import yaml

OPERATIONS = {
    "moderateWorkspaceMember",
    "createAbuseReport",
    "listAbuseReports",
    "resolveAbuseReport",
    "createWorkspaceInviteLink",
    "listWorkspaceInviteLinks",
    "revokeWorkspaceInviteLink",
    "previewWorkspaceInvite",
    "redeemWorkspaceInvite",
    "createAttachmentUpload",
    "completeAttachmentUpload",
    "getAttachment",
    "unfurlUrl",
    "listNotifications",
    "markNotificationsRead",
    "getPushPublicKey",
    "putPushSubscription",
    "deletePushSubscription",
    "listWorkspaceDocuments",
    "createWorkspaceDocument",
    "getWorkspaceDocument",
    "updateWorkspaceDocument",
    "deleteWorkspaceDocument",
    "listDocumentBacklinks",
    "createDocumentCollabSession",
    "searchWorkspace",
}


def validate(document: dict[str, Any]) -> None:
    if document["info"]["version"] not in {"0.43.0", "0.44.0", "0.44.1", "0.44.2"}:
        raise ValueError("version")
    operations = {
        op["operationId"]: (method, op)
        for item in document["paths"].values()
        for method, op in item.items()
        if isinstance(op, dict) and "operationId" in op
    }
    if not OPERATIONS <= operations.keys():
        raise ValueError("operation inventory")
    for name in OPERATIONS:
        method, op = operations[name]
        if not op.get("x-kodera-scope") or not op.get("x-kodera-authz", {}).get("roles"):
            raise ValueError("authorization")
        if (
            method == "post"
            and {"$ref": "#/components/parameters/IdempotencyKey"} not in op["parameters"]
        ):
            raise ValueError("idempotency")
        if (
            method == "patch"
            and {"$ref": "#/components/parameters/IfMatch"} not in op["parameters"]
        ):
            raise ValueError("precondition")
        if "401" not in op["responses"] or "403" not in op["responses"]:
            raise ValueError("refusals")
    if operations["putPushSubscription"][0] != "put":
        raise ValueError("push verb")
    schemas = document["components"]["schemas"]
    for name, schema in schemas.items():
        if name.startswith(
            (
                "WorkspaceDocument",
                "Attachment",
                "Unfurl",
                "DocumentCollab",
                "Push",
                "AbuseReport",
                "WorkspaceInvite",
                "WorkspaceModeration",
            )
        ):
            validator = jsonschema_rs.validator_for(
                {
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "$ref": f"#/components/schemas/{name}",
                    "components": document["components"],
                }
            )
            for example in schema.get("examples", []):
                if not validator.is_valid(example):
                    raise ValueError(f"invalid example: {name}")
    mode = schemas["PushPublicKey"]["properties"]["payloadMode"]
    if mode != {"type": "string", "enum": ["empty"]}:
        raise ValueError("empty push")
    mime = schemas["AttachmentUploadRequest"]["properties"]["contentType"]["enum"]
    if "image/svg+xml" in mime or "text/html" in mime:
        raise ValueError("active upload")
    if schemas["WorkspaceDocumentRequest"]["properties"]["templateKey"]["enum"] != [
        "spec",
        "adr",
        "meeting_notes",
        "runbook",
    ]:
        raise ValueError("templates")
    if schemas["DocumentCollabSession"]["properties"]["role"]["enum"] != ["editor", "viewer"]:
        raise ValueError("collaboration roles")
    if any("promot" in name.lower() and "doc" in name.lower() for name in operations):
        raise ValueError("rejected promotion bridge")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    document = yaml.safe_load(Path(__file__).with_name("core-api.openapi.yaml").read_text())
    validate(document)
    print(f"PASS: {len(OPERATIONS)} workspace operations and response examples")
    if args.selftest:

        def schema(d: dict[str, Any], name: str) -> dict[str, Any]:
            return d["components"]["schemas"][name]

        mutations = [
            ("version", lambda d: d["info"].update(version="0.42.0")),
            ("operation inventory", lambda d: d["paths"].pop("/push/subscriptions/{device_id}")),
            (
                "empty push",
                lambda d: schema(d, "PushPublicKey")["properties"]["payloadMode"]["enum"].append(
                    "plaintext"
                ),
            ),
            (
                "active upload",
                lambda d: schema(d, "AttachmentUploadRequest")["properties"]["contentType"][
                    "enum"
                ].append("image/svg+xml"),
            ),
            (
                "templates",
                lambda d: schema(d, "WorkspaceDocumentRequest")["properties"]["templateKey"][
                    "enum"
                ].append("chat_thread"),
            ),
            (
                "collaboration roles",
                lambda d: schema(d, "DocumentCollabSession")["properties"]["role"]["enum"].append(
                    "owner"
                ),
            ),
        ]
        for expected, mutate in mutations:
            candidate = copy.deepcopy(document)
            mutate(candidate)
            try:
                validate(candidate)
            except ValueError as error:
                if str(error) != expected:
                    raise RuntimeError(f"wrong refusal: {expected}") from error
            else:
                raise RuntimeError(f"survived: {expected}")
        print(f"PASS: {len(mutations)} named refusal mutations")


if __name__ == "__main__":
    main()
    if (
        yaml.safe_load(Path(__file__).with_name("core-api.openapi.yaml").read_text())["info"][
            "version"
        ]
        in {"0.44.0", "0.44.1", "0.44.2"}
    ):
        from check_wave4_surfaces import main as wave4_main

        wave4_main()
