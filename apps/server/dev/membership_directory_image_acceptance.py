"""Fixed directory scenario for the shared owned customer HTTP controller."""

import copy
import hashlib
import json
import os
import re
import select
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from http.client import HTTPConnection
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from uuid import UUID

from dev import accept_customer_http as shared
from dev.accept_runtime import docker


class Refusal(shared.ControllerError):
    """Only closed, nonsecret failure reasons."""


def require(value, reason):
    if not value:
        raise Refusal(reason)


OPERATIONS = (
    "reset",
    "token-valid",
    "token-expired",
    "rename-organisation",
    "restore-organisation",
    "revoke-caller",
    "restore-caller",
    "stop-api",
    "start-api",
)
REQUIRED_PHASES = frozenset(
    {
        "image-source",
        "reader",
        "baseline",
        "admin",
        "member",
        "changed-contact",
        "billing",
        "revoked",
        "missing-key",
        "outage",
        "recovery",
        "expiry",
    }
)
MAX_FRAME = 256 * 1024


def fixture_plan():
    return copy.deepcopy(_PLAN)


def _seed_id(number):
    return f"019a0000-0000-7000-8000-{number:012x}"


def _fixture_rows():
    declarations = [
        ("primary", 1, "org_owner", "active", True, False, False),
        ("alternate", 2, "org_member", "active", True, False, False),
        ("invited", 3, "org_member", "invited", True, False, False),
        ("suspended", 4, "org_admin", "suspended", True, False, False),
        ("disabled_person", 5, "org_member", "active", False, False, False),
        ("removed", 6, "org_member", "removed", True, False, False),
        ("deleted_membership", 7, "org_member", "active", True, False, True),
        ("deleted_person", 8, "org_member", "active", True, True, False),
    ]
    declarations += [
        (f"member_{n:02}", n, "org_owner" if n == 9 else "org_member", "active", True, False, False)
        for n in range(9, 30)
    ]
    rows = []
    for label, n, role, state, enabled, person_deleted, membership_deleted in declarations:
        generated = n >= 9
        rows.append(
            {
                "label": label,
                "person_id": _seed_id(n),
                "membership_id": _seed_id(100 + n),
                "organisation_id": _seed_id(201),
                "email": f"member{n:02}@example.test" if generated else label + "@example.test",
                "display_name": f"Synthetic Member {n:02}"
                if generated
                else "Synthetic " + label.replace("_", " "),
                "role": role,
                "state": state,
                "person_enabled": enabled,
                "person_deleted": person_deleted,
                "membership_deleted": membership_deleted,
                "in_directory": not person_deleted
                and not membership_deleted
                and state != "removed",
            }
        )
    return rows


_PLAN = {
    "organisations": [
        {
            "id": "019a0000-0000-7000-8000-0000000000c9",
            "slug": "directory-main",
            "realm": "directory-main",
            "name": "Synthetic Directory",
            "state": "active",
            "issuer_template": "http://127.0.0.1:{provider_port}/realms/directory-main",
        },
        {
            "id": "019a0000-0000-7000-8000-0000000000ca",
            "slug": "directory-other",
            "realm": "directory-other",
            "name": "Synthetic Other Directory",
            "state": "active",
            "issuer_template": "http://127.0.0.1:{provider_port}/realms/directory-other",
        },
    ],
    "provider": {
        "realms": ["directory-main", "directory-other", "directory-staff", "directory-unknown"],
        "trusted_lanes": {
            "directory-main": "customer",
            "directory-other": "customer",
            "directory-staff": "staff",
        },
        "primary_user_mapping": "019a0000-0000-7000-8000-000000000001",
        "alternate_user_mapping": "019a0000-0000-7000-8000-000000000002",
        "other_realm_primary_mapping": "019a0000-0000-7000-8000-000000000001",
    },
    "seed_constraints": {
        "accepted_at": "null for invited; actual seed timestamp for active/suspended/removed",
        "retained_deletion": "both null for retained records; actual deleted_at plus strictly later purge_after for each deleted record",
        "slug_reservations": "one permanent organisation-namespace reservation per organisation with equal slug and actual protected_at",
        "secondary_primary_owner": "member_09 remains an active owner during all primary caller role/revocation transitions",
        "foreign_owner": "primary_other_realm is active owner of its own organisation; same person, distinct membership ID",
    },
}
_PLAN["rows"] = _fixture_rows()
_PLAN["other_rows"] = [
    {
        "label": "primary_other_realm",
        "person_id": "019a0000-0000-7000-8000-000000000001",
        "membership_id": "019a0000-0000-7000-8000-00000000012d",
        "organisation_id": "019a0000-0000-7000-8000-0000000000ca",
        "email": "primary@example.test",
        "display_name": "Synthetic primary",
        "role": "org_owner",
        "state": "active",
        "in_directory": True,
        "person_enabled": True,
        "person_deleted": False,
        "membership_deleted": False,
    }
]


def check_fixture(value):
    organisations = value["organisations"]
    require(len(organisations) == 2, "fixture-organisations")
    org_ids = {org["id"] for org in organisations}
    require(len(org_ids) == 2, "organisation-id-alias")
    for org in organisations:
        require(
            re.fullmatch(r"[a-z0-9]([a-z0-9-]{3,18}[a-z0-9])", org["slug"]) is not None,
            "organisation-slug-shape",
        )
        require(org["realm"] == org["slug"], "organisation-realm-mismatch")
        require(
            org["issuer_template"] == "http://127.0.0.1:{provider_port}/realms/" + org["realm"],
            "organisation-issuer-binding",
        )
        require(1 <= len(org["name"]) <= 200 and org["state"] == "active", "organisation-fields")
    require(
        len({org["issuer_template"] for org in organisations}) == 2, "organisation-issuer-alias"
    )
    require(
        all(
            value["provider"]["trusted_lanes"].get(org["realm"]) == "customer"
            and org["realm"] in value["provider"]["realms"]
            for org in organisations
        ),
        "provider-customer-binding",
    )
    rows = value["rows"] + value["other_rows"]
    memberships = [row["membership_id"] for row in rows]
    require(len(set(memberships)) == len(memberships), "membership-id-alias")
    people = {row["person_id"] for row in rows}
    require(
        not (org_ids & people or org_ids & set(memberships) or people & set(memberships)),
        "cross-entity-id-alias",
    )
    for ident in org_ids | people | set(memberships):
        parsed = UUID(ident)
        require(str(parsed) == ident and parsed.version == 7, "fixture-uuid-shape")
    pairs = []
    for row in rows:
        require(row["organisation_id"] in org_ids, "membership-organisation-binding")
        require(
            row["role"] in {"org_owner", "org_admin", "org_billing", "org_member"}
            and row["state"] in {"invited", "active", "suspended", "removed"},
            "membership-enums",
        )
        require(
            all(
                type(row[key]) is bool
                for key in (
                    "person_enabled",
                    "person_deleted",
                    "membership_deleted",
                    "in_directory",
                )
            ),
            "fixture-flag-type",
        )
        eligible = (
            not row["person_deleted"]
            and not row["membership_deleted"]
            and row["state"] in {"invited", "active", "suspended"}
        )
        require(row["in_directory"] == eligible, "fixture-population-predicate")
        require(
            bool(row["email"])
            and "\n" not in row["email"]
            and "\r" not in row["email"]
            and len(row["email"]) <= 320
            and row["email"].endswith("@example.test"),
            "fixture-synthetic-contact",
        )
        require(
            row["display_name"] is None or len(row["display_name"]) <= 200, "fixture-display-name"
        )
        if not row["membership_deleted"]:
            pairs.append((row["person_id"], row["organisation_id"]))
    require(len(pairs) == len(set(pairs)), "membership-current-pair-alias")
    primary_org = organisations[0]["id"]
    require(
        all(row["organisation_id"] == primary_org for row in value["rows"]),
        "primary-population-org",
    )
    require(sum(row["in_directory"] for row in value["rows"]) == 26, "fixture-current-count")
    primary = value["provider"]["primary_user_mapping"]
    foreign = value["other_rows"]
    require(
        len(foreign) == 1
        and foreign[0]["person_id"] == primary
        and foreign[0]["organisation_id"] == organisations[1]["id"]
        and foreign[0]["state"] == "active"
        and foreign[0]["in_directory"],
        "same-person-foreign-control",
    )
    for org in organisations:
        owners = [
            row
            for row in rows
            if row["organisation_id"] == org["id"]
            and row["role"] == "org_owner"
            and row["state"] == "active"
            and not row["membership_deleted"]
        ]
        require(bool(owners), "active-organisation-owner")
        if org["id"] == primary_org:
            require(
                any(row["person_id"] != primary for row in owners),
                "primary-mutation-needs-other-owner",
            )
    require(
        value["provider"]["other_realm_primary_mapping"] == primary, "same-person-provider-mapping"
    )


MAX_BYTES = 65536
ROW_FIELDS = {
    "id",
    "organisation_id",
    "email",
    "display_name",
    "role",
    "state",
    "created_at",
    "updated_at",
}
PROBLEMS = {
    400: ("validation-error", "Invalid request"),
    401: ("unauthenticated", "Authentication required"),
    403: ("forbidden", "Access refused"),
    404: ("not-found", "Not found"),
    500: ("internal-error", "Internal error"),
}
PHASES = {
    "baseline",
    "admin",
    "member",
    "changed-contact",
    "billing",
    "revoked",
    "missing-key",
    "outage",
    "recovery",
}

Refused = Refusal


def common(response, content_type="application/json"):
    status, headers, body = response
    require(headers.get("cache-control") == "no-store", "response lacks no-store")
    require(
        bool(re.fullmatch(r"[A-Za-z0-9_-]{8,64}", headers.get("x-request-id", ""))),
        "response lacks safe correlation",
    )
    require(
        headers.get("content-type", "").split(";")[0] == content_type, "response media type differs"
    )
    return status, headers, body


def exact(response, expected):
    status, _, body = common(response)
    require(status == 200 and body == expected, "stored projection differs")


def page(response, expected_rows, more):
    status, headers, body = common(response)
    require(status == 200, "directory did not succeed")
    require("etag" not in headers, "collection exposes an ETag")
    require(
        isinstance(body, dict) and set(body) == {"data", "has_more", "next_cursor"},
        "page shape differs",
    )
    require(
        isinstance(body["data"], list)
        and all(isinstance(row, dict) and set(row) == ROW_FIELDS for row in body["data"]),
        "directory invented or omitted a stored fact",
    )
    require(body["data"] == expected_rows, "directory population or stored values differ")
    require(
        type(body["has_more"]) is bool and body["has_more"] is more, "continuation state differs"
    )
    cursor = body["next_cursor"]
    require(
        (isinstance(cursor, str) and bool(re.fullmatch(r"[A-Za-z0-9_-]{135}", cursor)))
        if more
        else cursor is None,
        "cursor shape differs",
    )
    return cursor


def problem(response, expected_status):
    status, headers, body = common(response, "application/problem+json")
    kind, title = PROBLEMS[expected_status]
    require(status == expected_status, "refusal status differs")
    require(
        body
        == {
            "type": "https://kodera.io/problems/" + kind,
            "title": title,
            "status": expected_status,
            "request_id": headers["x-request-id"],
        },
        "unsafe or incorrect refusal body",
    )
    require("etag" not in headers, "refusal exposes an ETag")


class Probe:
    def __init__(self, supplied):
        self.value = supplied
        require(
            type(supplied.get("api_port")) is int and 0 < supplied["api_port"] < 65536,
            "invalid loopback port",
        )
        self.org = str(UUID(supplied["organisation_id"]))
        self.other = str(UUID(supplied["other_organisation_id"]))
        require(self.org != self.other, "fixture organisations must differ")
        self.detail = "/api/v1/organisations/" + self.org
        self.directory = self.detail + "/memberships"
        require(
            isinstance(supplied["expected_rows"], list) and len(supplied["expected_rows"]) == 26,
            "fixture requires exactly 26 current rows",
        )
        require(
            all(set(row) == ROW_FIELDS for row in supplied["expected_rows"]),
            "fixture row shape differs",
        )
        ids = [row["id"] for row in supplied["expected_rows"]]
        require(ids == sorted(set(ids)), "fixture rows must have unique sorted IDs")
        require(
            all(row["organisation_id"] == self.org for row in supplied["expected_rows"]),
            "fixture row escaped bound organisation",
        )
        for token in supplied["tokens"].values():
            require(
                isinstance(token, str)
                and 0 < len(token) <= 16384
                and not any(c.isspace() for c in token),
                "invalid private credential",
            )

    def get(self, path, credential="access", query=None, conditional=False):
        allowed = {
            "/api/v1/me",
            "/health/ready",
            "/health/live",
            self.detail,
            self.directory,
            "/api/v1/organisations/" + self.other + "/memberships",
        }
        require(path in allowed, "request path escaped fixed surface")
        require(
            query is None or set(query) <= {"limit", "role", "state", "cursor"},
            "query escaped fixed surface",
        )
        headers = {"X-Request-Id": "image-probe-correlation"}
        if credential is not None:
            headers["Authorization"] = "Bearer " + self.value["tokens"][credential]
        if conditional:
            headers["If-None-Match"] = "*"
        conn = HTTPConnection("127.0.0.1", self.value["api_port"], timeout=3)
        timer = None
        try:
            conn.connect()
            sock = conn.sock

            # Absolute deadline also bounds slow reads; no proxy or redirect machinery.
            def expire():
                try:
                    sock.shutdown(2)
                except OSError:
                    pass

            timer = threading.Timer(5, expire)
            timer.start()
            conn.request("GET", path + (("?" + urlencode(query)) if query else ""), headers=headers)
            response = conn.getresponse()
            raw = response.read(MAX_BYTES + 1)
            require(len(raw) <= MAX_BYTES, "response exceeds bound")
            return (
                response.status,
                {k.lower(): v for k, v in response.getheaders()},
                json.loads(raw),
            )
        except Refused:
            raise
        except Exception:
            raise Refused("owned HTTP request failed") from None
        finally:
            if timer:
                timer.cancel()
            conn.close()

    def run(self, phase):
        require(phase in PHASES, "unknown probe phase")
        v = self.value
        if phase in {"billing", "revoked"}:
            problem(self.get(self.directory, conditional=True), 403)
            problem(self.get(self.directory, query={"limit": 1, "cursor": v["continuation"]}), 403)
            return
        if phase == "missing-key":
            exact(self.get("/api/v1/me"), v["expected_me"])
            exact(self.get(self.detail), v["expected_detail"])
            problem(self.get(self.directory), 500)
            return
        if phase == "outage":
            for path in ("/api/v1/me", self.detail, self.directory):
                problem(self.get(path), 500)
            require(
                self.get("/health/ready", credential=None)[0] == 503, "outage readiness differs"
            )
            require(self.get("/health/live", credential=None)[0] == 200, "outage liveness differs")
            return
        exact(self.get("/api/v1/me"), v["expected_me"])
        exact(self.get(self.detail), v["expected_detail"])
        rows = v["expected_rows"]
        page(self.get(self.directory), rows, False)
        page(self.get(self.directory, conditional=True), rows, False)
        page(self.get(self.directory, query={"state": "removed"}), [], False)
        cursor = page(self.get(self.directory, query={"limit": 1}), rows[:1], True)
        for index in range(1, len(rows)):
            cursor = page(
                self.get(self.directory, query={"limit": 1, "cursor": cursor}),
                rows[index : index + 1],
                index < len(rows) - 1,
            )
        if phase != "baseline":
            return
        first = page(self.get(self.directory, query={"limit": 1}), rows[:1], True)
        page(
            self.get(self.directory, credential="refreshed", query={"limit": 1, "cursor": first}),
            rows[1:2],
            True,
        )
        page(self.get(self.directory, credential="alternate", query={"limit": 1}), rows[:1], True)
        problem(
            self.get(self.directory, credential="alternate", query={"limit": 1, "cursor": first}),
            400,
        )
        for query in (
            {"limit": 2, "cursor": first},
            {"limit": 1, "role": "org_member", "cursor": first},
            {"limit": 1, "state": "active", "cursor": first},
            {"limit": 1, "cursor": ("A" if first[0] != "A" else "B") + first[1:]},
        ):
            problem(self.get(self.directory, query=query), 400)
        other_path = "/api/v1/organisations/" + self.other + "/memberships"
        page(
            self.get(other_path, credential="other_realm", query={"limit": 1}),
            v["other_rows"][:1],
            len(v["other_rows"]) > 1,
        )
        problem(
            self.get(other_path, credential="other_realm", query={"limit": 1, "cursor": first}), 400
        )
        problem(self.get(other_path), 404)
        for token in ("wrong_audience", "untrusted_issuer", "id_token", "refresh_token"):
            problem(self.get(self.directory, credential=token), 401)
        problem(self.get(self.directory, credential="staff"), 403)
        # Cursor stays private: the controller obtains its own continuation before mutations.


def unique_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate-json-key")
            result[key] = value
        return result

    try:
        return json.loads(raw, object_pairs_hook=pairs)
    except (ValueError, UnicodeError, RecursionError):
        raise Refusal("invalid-json") from None


class Frames:
    """Bound bytes before parsing; failure is terminal and EOF must be complete."""

    def __init__(self):
        self.buffer = bytearray()
        self.failed = False

    def feed(self, chunk):
        require(not self.failed, "control-channel-failed")
        try:
            self.buffer.extend(chunk)
            messages = []
            while True:
                end = self.buffer.find(b"\n")
                require(
                    (end + 1 if end >= 0 else len(self.buffer)) <= MAX_FRAME,
                    "control-frame-too-large",
                )
                if end < 0:
                    break
                messages.append(unique_json(bytes(self.buffer[:end])))
                del self.buffer[: end + 1]
            return messages
        except Exception:
            self.failed = True
            raise

    def eof(self):
        require(not self.failed, "control-channel-failed")
        if self.buffer:
            self.failed = True
            raise Refusal("control-partial-eof")


def control_request(message, expected):
    require(
        isinstance(message, dict)
        and set(message) == {"id", "op"}
        and type(message["id"]) is int
        and message["id"] == expected
        and message["op"] in OPERATIONS,
        "control-request-refused",
    )
    return message["op"]


def require_resource(details, expected_id, owner, image=None):
    labels = details.get("Config", {}).get("Labels", details.get("Labels", {})) or {}
    require(
        details.get("Id") == expected_id
        and labels.get(shared.LABEL) == owner
        and (image is None or details.get("Image") == image),
        "resource-identity-refused",
    )


def require_expired(provenance, now):
    require(
        isinstance(provenance, dict)
        and set(provenance) == {"flow", "issuer", "exp", "leeway_seconds"}
        and provenance["flow"] == "authorization-code-s256"
        and type(provenance["exp"]) is int
        and provenance["leeway_seconds"] == 30
        and re.fullmatch(
            r"http://127\.0\.0\.1:[1-9][0-9]{0,4}/realms/directory-main", provenance["issuer"]
        )
        is not None
        and now > provenance["exp"] + 30,
        "token-not-actually-expired",
    )


def restore_all(action):
    failures = []
    for operation in ("start-api", "restore-caller", "restore-organisation", "restore-contact"):
        try:
            action(operation)
        except Exception:
            failures.append(operation)
    require(not failures, "fixture-restoration-failed")


def require_phases(phases):
    require(set(phases) == REQUIRED_PHASES, "qualification-phases-incomplete")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_record(path, bound=MAX_FRAME):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as source:
        require(stat.S_ISREG(os.fstat(source.fileno()).st_mode), "record-not-regular")
        raw = source.read(bound + 1)
    require(len(raw) <= bound, "record-too-large")
    return raw, unique_json(raw)


def git_identity(root):
    def git(*arguments):
        return subprocess.run(  # noqa: S603 - fixed read-only Git arguments
            ["git", "-C", str(root), *arguments],  # noqa: S607 - installed Git, fixed subcommands
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()  # noqa: S603,S607 - fixed read-only git arguments

    return {
        "head": git("rev-parse", "HEAD"),
        "tree": git("rev-parse", "HEAD^{tree}"),
        "clean": not git("status", "--porcelain=v1"),
    }


def require_admission(value, identity):
    fields = {
        "version",
        "lane",
        "build_and_runtime",
        "core_head",
        "core_tree",
        "evidence_directory",
        "bridge",
    }
    require(
        isinstance(value, dict)
        and set(value) == fields
        and type(value["version"]) is int
        and value["version"] == 1
        and value["lane"] == "02-core-image"
        and value["build_and_runtime"] is True,
        "runtime-admission-refused",
    )
    require(
        identity == {"head": value["core_head"], "tree": value["core_tree"], "clean": True},
        "runtime-source-drift",
    )
    require(
        all(re.fullmatch("[a-f0-9]{40}", value[key]) for key in ("core_head", "core_tree")),
        "runtime-source-identity",
    )
    require(Path(value["evidence_directory"]).is_absolute(), "evidence-directory-refused")
    bridge = value["bridge"]
    if bridge is not None:
        require(
            isinstance(bridge, dict)
            and set(bridge)
            == {
                "node",
                "runner",
                "runner_sha256",
                "harness",
                "harness_sha256",
                "console_head",
                "admission",
                "barrier_seconds",
            },
            "bridge-plan-refused",
        )
        require(
            all(Path(bridge[k]).is_absolute() for k in ("node", "runner", "harness", "admission"))
            and Path(bridge["runner"]).name == "runner.mjs"
            and Path(bridge["harness"]).name == "harness-bindings.json",
            "bridge-path-refused",
        )
        require(
            type(bridge["barrier_seconds"]) is int and 1 <= bridge["barrier_seconds"] <= 600,
            "bridge-barrier-refused",
        )
        require(
            all(
                re.fullmatch("[a-f0-9]{64}", bridge[k]) for k in ("runner_sha256", "harness_sha256")
            ),
            "bridge-hash-refused",
        )


def run_seed_operation(payload):
    """Host-only model-backed fixture writes/oracle, never imported by the image."""
    from datetime import timedelta

    import django

    django.setup()
    from django.core.management import call_command
    from django.db import connection, transaction
    from django.utils import timezone

    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership, Organisation, SlugReservation

    plan = fixture_plan()
    check_fixture(plan)
    primary = plan["provider"]["primary_user_mapping"]
    primary_org = plan["organisations"][0]["id"]
    primary_membership = plan["rows"][0]["membership_id"]
    operation = payload["operation"]
    require(
        operation
        in {
            "seed",
            "oracle",
            "snapshot",
            "reset",
            "admin",
            "member",
            "billing",
            "revoke-caller",
            "restore-caller",
            "rename-organisation",
            "restore-organisation",
            "change-contact",
            "restore-contact",
        },
        "fixture-operation-refused",
    )
    if operation == "seed":
        call_command("migrate", verbosity=0, interactive=False)
        bindings = payload["bindings"]
        require(set(bindings) == {"primary", "alternate", "other"}, "seed-identity-bindings")
        with transaction.atomic():
            now = timezone.now()
            for row in plan["rows"]:
                deleted = (
                    {"deleted_at": now, "purge_after": now + timedelta(days=1)}
                    if row["person_deleted"]
                    else {}
                )
                User.objects.create(
                    id=row["person_id"],
                    email=row["email"],
                    display_name=row["display_name"],
                    enabled=row["person_enabled"],
                    **deleted,
                )
            for org in plan["organisations"]:
                binding = bindings["primary" if org["id"] == primary_org else "other"]
                require(
                    binding["issuer"].endswith("/realms/" + org["realm"]), "seed-issuer-binding"
                )
                Organisation.objects.create(
                    id=org["id"],
                    slug=org["slug"],
                    realm=org["realm"],
                    issuer=binding["issuer"],
                    name=org["name"],
                    state=org["state"],
                )
                SlugReservation.objects.create(
                    organisation_id=org["id"], slug=org["slug"], state="permanent", protected_at=now
                )
            for row in plan["rows"] + plan["other_rows"]:
                deleted = (
                    {"deleted_at": now, "purge_after": now + timedelta(days=1)}
                    if row["membership_deleted"]
                    else {}
                )
                Membership.objects.create(
                    id=row["membership_id"],
                    user_id=row["person_id"],
                    organisation_id=row["organisation_id"],
                    role=row["role"],
                    state=row["state"],
                    accepted_at=None if row["state"] == "invited" else now,
                    **deleted,
                )
            for index, (alias, user_id, org) in enumerate(
                (
                    ("primary", primary, plan["organisations"][0]),
                    (
                        "alternate",
                        plan["provider"]["alternate_user_mapping"],
                        plan["organisations"][0],
                    ),
                    ("other", primary, plan["organisations"][1]),
                ),
                401,
            ):
                binding = bindings[alias]
                require(
                    binding["issuer"].endswith("/realms/" + org["realm"])
                    and 1 <= len(binding["subject"]) <= 255
                    and binding["subject"].isascii(),
                    "seed-issuer-binding",
                )
                Identity.objects.create(
                    id=f"019a0000-0000-7000-8000-{index:012x}",
                    user_id=user_id,
                    organisation_id=org["id"],
                    issuer=binding["issuer"],
                    realm=org["realm"],
                    subject=binding["subject"],
                    email=User.objects.get(id=user_id).email,
                )
    elif operation not in {"oracle", "snapshot"}:
        with transaction.atomic():
            now = timezone.now()
            if operation in {
                "reset",
                "admin",
                "member",
                "billing",
                "revoke-caller",
                "restore-caller",
            }:
                role = {"admin": "org_admin", "member": "org_member", "billing": "org_billing"}.get(
                    operation, "org_owner"
                )
                state = "suspended" if operation == "revoke-caller" else "active"
                require(
                    Membership.objects.filter(
                        id=primary_membership, user_id=primary, organisation_id=primary_org
                    ).update(role=role, state=state, updated_at=now)
                    == 1,
                    "fixture-membership-target",
                )
            if operation in {"reset", "rename-organisation", "restore-organisation"}:
                name = (
                    "Synthetic Directory Updated"
                    if operation == "rename-organisation"
                    else plan["organisations"][0]["name"]
                )
                require(
                    Organisation.objects.filter(id=primary_org).update(name=name, updated_at=now)
                    == 1,
                    "fixture-organisation-target",
                )
            if operation in {"reset", "change-contact", "restore-contact"}:
                email = (
                    "changed@example.test"
                    if operation == "change-contact"
                    else plan["rows"][0]["email"]
                )
                name = (
                    "Synthetic Changed Contact"
                    if operation == "change-contact"
                    else plan["rows"][0]["display_name"]
                )
                require(
                    User.objects.filter(id=primary).update(
                        email=email, display_name=name, updated_at=now
                    )
                    == 1,
                    "fixture-person-target",
                )
    if operation == "snapshot":
        facts = {}
        with connection.cursor() as cursor:
            for table in sorted(shared.TABLES):
                # Fixed internal allowlist; no caller SQL/name accepted.
                from psycopg import sql

                cursor.execute(
                    sql.SQL("SELECT row_to_json(t) FROM (SELECT * FROM {} ORDER BY id) t").format(
                        sql.Identifier(table)
                    )
                )
                facts[table] = [row[0] for row in cursor.fetchall()]
        return {"sha256": sha(json.dumps(facts, sort_keys=True, default=str).encode())}

    # Independent database oracle: no product selectors/services/serializers.
    def stamp(value, milliseconds=False):
        return value.isoformat(timespec="milliseconds" if milliseconds else "auto").replace(
            "+00:00", "Z"
        )

    person = User.objects.get(id=primary)
    identities = list(Identity.objects.filter(user_id=primary).order_by("id"))
    memberships = list(
        Membership.objects.filter(user_id=primary, deleted_at__isnull=True)
        .select_related("organisation")
        .order_by("id")
    )
    identity_ids = {str(item.organisation_id): str(item.id) for item in identities}
    me = {
        "id": str(person.id),
        "email": person.email,
        "display_name": person.display_name,
        "staff": False,
        "identities": [
            {
                "id": str(item.id),
                "issuer": item.issuer,
                "realm": item.realm,
                "subject": item.subject,
                "email": item.email,
            }
            for item in identities
        ],
        "organisations": [
            {
                "organisation": {
                    "id": str(item.organisation_id),
                    "slug": item.organisation.slug,
                    "realm": item.organisation.realm,
                    "name": item.organisation.name,
                },
                "membership_id": str(item.id),
                "identity_id": identity_ids[str(item.organisation_id)],
                "role": item.role,
                "state": item.state,
                "joined_at": stamp(item.accepted_at),
            }
            for item in memberships
            if item.state == "active"
        ],
    }
    org = Organisation.objects.get(id=primary_org)
    detail = {
        "id": str(org.id),
        "slug": org.slug,
        "name": org.name,
        "state": org.state,
        "created_at": stamp(org.created_at, True),
    }

    def rows_for(org_id):
        # The expected eligible IDs come from the fixed seed plan, not the endpoint query.
        declarations = [
            r
            for r in plan["rows"] + plan["other_rows"]
            if r["organisation_id"] == org_id and r["in_directory"]
        ]
        actual = {
            str(item.id): item
            for item in Membership.objects.filter(
                id__in=[r["membership_id"] for r in declarations]
            ).select_related("user")
        }
        require(set(actual) == {r["membership_id"] for r in declarations}, "fixture-row-missing")
        return [
            {
                "id": key,
                "organisation_id": str(item.organisation_id),
                "email": item.user.email,
                "display_name": item.user.display_name,
                "role": item.role,
                "state": item.state,
                "created_at": stamp(item.created_at, True),
                "updated_at": stamp(item.updated_at, True),
            }
            for key, item in sorted(actual.items())
        ]

    return {
        "me": me,
        "organisation": detail,
        "memberships": rows_for(primary_org),
        "other_memberships": rows_for(plan["organisations"][1]["id"]),
        "counts": {
            "identity_user": User.objects.count(),
            "identity_identity": Identity.objects.count(),
            "orgs_organisation": Organisation.objects.count(),
            "orgs_membership": Membership.objects.count(),
            "orgs_slugreservation": SlugReservation.objects.count(),
        },
    }


class DirectoryScenario:
    """Finite adapter; the shared controller alone creates and finally cleans the stack."""

    def __init__(self, admission_path):
        _, self.admission = read_record(admission_path)
        self.identity = git_identity(shared.ROOT)
        require_admission(self.admission, self.identity)
        if self.admission["bridge"] is not None:
            self.check_bridge_files()
        self.evidence = Path(self.admission["evidence_directory"])
        self.evidence.mkdir(mode=0o700, parents=False, exist_ok=False)
        self.resources = {}
        self.phases = set()
        self.api_ready = False
        self.plan = fixture_plan()
        check_fixture(self.plan)
        self.bindings = {}
        self.tokens = {}

    def passed(self, phase):
        require(phase in REQUIRED_PHASES, "unknown-qualification-phase")
        self.phases.add(phase)
        print(json.dumps({"directory_phase": phase, "result": "pass"}), flush=True)

    def capture(self, kind, name, owner, expected_id=None):
        details = shared.require_owned(kind, name, owner)
        if expected_id is not None:
            require_resource(details, expected_id, owner)
        self.resources[(kind, name)] = {"id": details["Id"], "image": details.get("Image")}
        event = {
            "kind": kind,
            "name": name,
            "id": details["Id"],
            "image_id": details.get("Image"),
            "labels": {shared.LABEL: owner},
        }
        descriptor = os.open(
            self.evidence / "resources.jsonl",
            os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW,
            0o600,
        )
        with os.fdopen(descriptor, "a") as record:
            record.write(json.dumps(event, sort_keys=True) + "\n")
        print(json.dumps({"owned_resource": event}), flush=True)
        return details

    def inspect(self, kind, name):
        expected = self.resources[(kind, name)]
        facts = shared.require_owned(kind, name, self.owner)
        require_resource(facts, expected["id"], self.owner, expected["image"])
        return facts

    def imports(self, directory, password):
        from dev.identity_fixture import CALLBACK, fixture_realm

        for realm in self.plan["provider"]["realms"]:
            value = fixture_realm(
                password,
                CALLBACK,
                realm=realm,
                usernames=("qualification", "alternate")
                if realm == "directory-main"
                else ("qualification",),
                expiring=realm == "directory-main",
            )
            path = directory / (realm + ".json")
            path.write_text(json.dumps(value))
            path.chmod(0o644)  # Synthetic local provider import, never real credentials.

    def provider(self, port, password, owner):
        from dev.identity_fixture import LoopbackHTTP, code_flow
        from services.identity.access_tokens import IssuerKeySnapshot, verify_access_token

        self.password = password
        self.owner = owner
        self.transports = {
            realm: LoopbackHTTP(port, realm=realm) for realm in self.plan["provider"]["realms"]
        }
        self.snapshots = {}
        trust = []
        self.trust_expiry = int(time.time()) + 1800
        for realm, transport in self.transports.items():
            shared.wait_until(lambda t=transport: bool(t.jwks()), 30, "directory provider realm")
            issuer = transport.origin + "/realms/" + realm
            jwks = transport.jwks()
            self.snapshots[realm] = IssuerKeySnapshot.from_jwks(
                jwks, issuer=issuer, generation=owner, expires_at=self.trust_expiry
            )
            if realm in self.plan["provider"]["trusted_lanes"]:
                trust.append(
                    dict(
                        lane=self.plan["provider"]["trusted_lanes"][realm],
                        issuer=issuer,
                        generation=owner,
                        expires_at=self.trust_expiry,
                        public_jwks=json.loads(jwks),
                    )
                )
        transport = self.transports["directory-main"]
        original = code_flow(transport, password)
        primary = verify_access_token(
            original["access_token"], admitted=self.snapshots["directory-main"]
        )
        self.tokens.update(
            access=original["access_token"],
            id_token=original["id_token"],
            refresh_token=original["refresh_token"],
        )
        self.tokens["refreshed"] = self.fresh()
        for alias, realm, user in (
            ("alternate", "directory-main", "alternate"),
            ("other_realm", "directory-other", "qualification"),
            ("staff", "directory-staff", "qualification"),
            ("untrusted_issuer", "directory-unknown", "qualification"),
        ):
            material = code_flow(self.transports[realm], password, username=user)
            verified = verify_access_token(material["access_token"], admitted=self.snapshots[realm])
            self.tokens[alias] = material["access_token"]
            if alias in {"alternate", "other_realm"}:
                self.bindings["alternate" if alias == "alternate" else "other"] = {
                    "issuer": verified.issuer,
                    "subject": verified.subject,
                }
        self.bindings["primary"] = {"issuer": primary.issuer, "subject": primary.subject}
        self.tokens["wrong_audience"] = code_flow(
            transport, password, client_id="without-core-audience"
        )["access_token"]
        self.expired_token = code_flow(transport, password, client_id="expiring-console")[
            "access_token"
        ]
        verified_expiry = verify_access_token(
            self.expired_token, admitted=self.snapshots["directory-main"]
        )
        require(
            1 <= verified_expiry.expires_at - verified_expiry.issued_at <= 60,
            "provider-short-lifetime-not-applied",
        )
        self.expiry: dict[str, Any] = {
            "flow": "authorization-code-s256",
            "issuer": verified_expiry.issuer,
            "exp": verified_expiry.expires_at,
            "leeway_seconds": 30,
        }
        return original, primary, json.dumps(trust), "directory-main"

    def fresh(self):
        from dev.identity_fixture import code_flow
        from services.identity.access_tokens import verify_access_token

        token = code_flow(self.transports["directory-main"], self.password)["access_token"]
        verified = verify_access_token(token, admitted=self.snapshots["directory-main"])
        require(verified.expires_at > time.time() + 180, "valid-token-lifetime-insufficient")
        return token

    def seed_payload(self):
        return {"operation": "seed", "bindings": self.bindings}

    def bind(self, *, names, image, api_port, api_env, environment):
        self.names = names
        self.image = image
        self.api_port = api_port
        self.api_env = api_env
        self.environment = environment
        self.api_ready = True
        self.inspect("container", names[2])

    def owner_operation(self, operation):
        self.inspect("container", self.names[0])
        self.inspect("container", self.names[1])
        result = subprocess.run(
            [sys.executable, "-m", "dev.membership_directory_image_acceptance"],
            input=json.dumps({"operation": operation}),
            cwd=shared.ROOT,
            env=self.environment,
            text=True,
            capture_output=True,
            timeout=20,
            check=False,
        )  # noqa: S603 - fixed local fixture module/operation
        require(
            result.returncode == 0 and len(result.stdout) <= MAX_FRAME,
            "owned-fixture-operation-failed",
        )
        return unique_json(result.stdout)

    def payload(self, oracle):
        return {
            "api_port": self.api_port,
            "organisation_id": self.plan["organisations"][0]["id"],
            "other_organisation_id": self.plan["organisations"][1]["id"],
            "tokens": self.tokens,
            "expected_me": oracle["me"],
            "expected_detail": oracle["organisation"],
            "expected_rows": oracle["memberships"],
            "other_rows": oracle["other_memberships"],
        }

    def probe(self, phase, continuation=None):
        self.inspect("container", self.names[2])
        before = self.owner_operation("snapshot")
        payload = self.payload(self.owner_operation("oracle"))
        if continuation is not None:
            payload["continuation"] = continuation
        Probe(payload).run(phase)
        require(self.owner_operation("snapshot") == before, "customer-read-wrote-persisted-data")
        self.passed(phase)

    def replace_api(self, with_key):
        current = self.inspect("container", self.names[2])
        docker("container", "rm", "-f", current["Id"], timeout=15)
        del self.resources[("container", self.names[2])]
        args = shared.api_runtime_arguments()
        args[1] = f"127.0.0.1:{self.api_port}:8000"
        environment = dict(self.api_env)
        if not with_key:
            environment.pop("KODERA_MEMBERSHIP_CURSOR_KEY", None)
        for key, value in environment.items():
            args.extend(("-e", key + "=" + value))
        new_id = shared.run_container(
            self.names[2], self.owner, "256m", self.image, args, shared.API_COMMAND
        )
        details = self.capture("container", self.names[2], self.owner, new_id)
        shared.require_api_runtime(details, environment, (self.password,))
        shared.resource_evidence(self.names[2], 256 * 1024**2, self.owner)
        shared.wait_until(
            lambda: shared.http_request(self.api_port, "/health/ready")[0] == 200,
            30,
            "replacement API",
        )

    def qualify(self):
        self.probe("baseline")
        for operation, phase in (
            ("admin", "admin"),
            ("member", "member"),
            ("change-contact", "changed-contact"),
        ):
            try:
                self.owner_operation(operation)
                self.probe(phase)
            finally:
                self.owner_operation("reset")
        for operation, phase in (("billing", "billing"), ("revoke-caller", "revoked")):
            # One unexpired token and cursor across grant changes; renewal happens before both.
            self.tokens["access"] = self.fresh()
            payload = self.payload(self.owner_operation("oracle"))
            client = Probe(payload)
            continuation = page(
                client.get(client.directory, query={"limit": 1}), payload["expected_rows"][:1], True
            )
            try:
                self.owner_operation(operation)
                self.probe(phase, continuation)
            finally:
                self.owner_operation("reset")
            restored = self.payload(self.owner_operation("oracle"))
            page(
                client.get(client.directory, query={"limit": 1, "cursor": continuation}),
                restored["expected_rows"][1:2],
                True,
            )
        try:
            self.replace_api(False)
            self.probe("missing-key")
        finally:
            self.replace_api(True)
        self.probe("baseline")
        before = self.inspect("container", self.names[2])
        payload = self.payload(self.owner_operation("oracle"))
        database_snapshot = self.owner_operation("snapshot")
        self.inspect("container", self.names[0])
        with shared.paused_database(
            self.names[0],
            self.owner,
            expected_id=self.resources[("container", self.names[0])]["id"],
        ):
            Probe(payload).run("outage")
        self.passed("outage")
        shared.wait_until(
            lambda: shared.http_request(self.api_port, "/health/ready")[0] == 200,
            30,
            "database recovery",
        )
        self.probe("recovery")
        after = self.inspect("container", self.names[2])
        shared.require_recovery(
            before,
            after,
            payload["expected_me"],
            shared.http_request(self.api_port, "/api/v1/me", self.tokens["access"])[1],
        )
        require(self.owner_operation("snapshot") == database_snapshot, "outage-recovery-wrote-data")
        self.qualify_expiry()
        self.owner_operation("reset")
        self.tokens["access"] = self.fresh()
        self.probe("baseline")
        require_phases(self.phases)
        self.publish_qualification()
        if self.admission["bridge"] is not None:
            self.lend()

    def qualify_expiry(self):
        from services.identity.access_tokens import TokenVerificationError, verify_access_token

        deadline = time.monotonic() + 95
        while time.time() <= self.expiry["exp"] + 30:
            require(time.monotonic() < deadline, "expiry-wait-exceeded")
            time.sleep(0.25)
        require_expired(self.expiry, time.time())
        try:
            verify_access_token(self.expired_token, admitted=self.snapshots["directory-main"])
        except TokenVerificationError:
            pass
        else:
            raise Refusal("expired-provider-token-accepted")
        self.tokens["access"] = self.fresh()
        client = Probe(self.payload(self.owner_operation("oracle")))
        self.tokens["expired"] = self.expired_token
        problem(client.get("/api/v1/me", credential="expired"), 401)
        exact(client.get("/api/v1/me"), client.value["expected_me"])
        self.passed("expiry")

    def record(self, name, value):
        require(re.fullmatch(r"[a-z-]+\.json", name) is not None, "evidence-name-refused")
        raw = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
        with (self.evidence / name).open("xb") as target:
            target.write(raw)
        return sha(raw)

    def publish_qualification(self):
        api = self.inspect("container", self.names[2])
        image = self.inspect("image", self.image)
        network = self.inspect("network", self.owner)
        evidence = {
            "source": self.identity,
            "phases": sorted(self.phases),
            "image_id": image["Id"],
            "api_id": api["Id"],
            "api_started_at": api["State"]["StartedAt"],
            "expiry_provenance": self.expiry,
            "reader_role": "customer_api_reader",
            "required_image_source_sha256": {
                name: sha((shared.ROOT / name).read_bytes()) for name in shared.REQUIRED_IMAGE_FILES
            },
            "qualification": "local synthetic provider/image only",
        }
        self.qualification_hash = self.record("qualification.json", evidence)
        manifest = {
            "version": 1,
            "qualified": True,
            "core": {
                "head": self.identity["head"],
                "tree": self.identity["tree"],
                "image": image["Id"],
                "provenance": "held-candidate",
            },
            "api_url": f"http://127.0.0.1:{self.api_port}/api/v1",
            "resources": {
                "owner": "02-core-image",
                "api_id": api["Id"],
                "db_id": self.inspect("container", self.names[0])["Id"],
                "provider_id": self.inspect("container", self.names[1])["Id"],
                "network_id": network["Id"],
                "labels": {shared.LABEL: self.owner},
            },
            "fixture": {
                "organisation_id": self.plan["organisations"][0]["id"],
                "foreign_organisation_id": self.plan["organisations"][1]["id"],
                "person_id": self.plan["provider"]["primary_user_mapping"],
            },
            "control": {
                "protocol": "kodera-bridge-v1",
                "owner": "02-core-image",
                "operations": list(OPERATIONS),
            },
            "qualification_evidence_sha256": self.qualification_hash,
        }
        self.manifest_hash = self.record("qualified-manifest.json", manifest)
        print(
            json.dumps(
                {
                    "directory_qualified_manifest": str(self.evidence / "qualified-manifest.json"),
                    "sha256": self.manifest_hash,
                }
            ),
            flush=True,
        )

    def action(self, operation):
        self.inspect("network", self.owner)
        self.inspect("image", self.image)
        self.inspect("container", self.names[0])
        self.inspect("container", self.names[1])
        api = self.inspect("container", self.names[2])
        if operation == "token-valid":
            return {"access_token": self.fresh()}
        if operation == "token-expired":
            require_expired(self.expiry, time.time())
            return {"access_token": self.expired_token, "provenance": self.expiry}
        if operation == "stop-api":
            docker("stop", "--time", "2", api["Id"], timeout=10)

            def unreachable():
                try:
                    with socket.create_connection(("127.0.0.1", self.api_port), timeout=1):
                        return False
                except OSError:
                    return True

            shared.wait_until(unreachable, 5, "owned API unreachable")
            return {}
        if operation == "start-api":
            if api["State"]["Running"] is not True:
                docker("start", api["Id"], timeout=10)
            shared.wait_until(
                lambda: shared.http_request(self.api_port, "/health/ready")[0] == 200,
                15,
                "owned API restart",
            )
            self.inspect("container", self.names[2])
            observed = shared.http_request(self.api_port, "/api/v1/me", self.fresh())
            require(
                observed[0] == 200 and observed[1] == self.owner_operation("oracle")["me"],
                "restarted-api-projection-refused",
            )
            return {}
        oracle = self.owner_operation(operation)
        if operation == "reset":
            return {key: oracle[key] for key in ("me", "organisation", "memberships")}
        if operation == "rename-organisation":
            return {"organisation": oracle["organisation"]}
        return {}

    def before_cleanup(self):
        if not self.api_ready:
            return
        database = self.inspect("container", self.names[0])
        if database["State"]["Paused"]:
            docker("unpause", database["Id"], timeout=10)
        restore_all(self.action)

    def check_bridge_files(self):
        bridge = self.admission["bridge"]
        require(
            sha(Path(bridge["runner"]).read_bytes()) == bridge["runner_sha256"],
            "bridge-runner-drift",
        )
        raw, harness = read_record(bridge["harness"])
        require(sha(raw) == bridge["harness_sha256"], "bridge-harness-drift")
        allowed = {
            "SPEC.md",
            "FIXTURE_INTERFACE.md",
            "acceptance.mjs",
            "acceptance.test.mjs",
            "runner.mjs",
            "runner.test.mjs",
            "control-channel.mjs",
            "control-channel.test.mjs",
            "J2_ACCEPTANCE.md",
            "evidence/source-bindings.json",
            "evidence/shared-interface-bindings.json",
        }
        require(set(harness["files"]) == allowed, "bridge-inventory-refused")
        root = Path(bridge["runner"]).parent
        for name, digest in harness["files"].items():
            require(sha((root / name).read_bytes()) == digest, "bridge-inventory-drift")
        _, shared_inputs = read_record(root / "evidence/shared-interface-bindings.json")
        plan = fixture_plan()
        require(
            shared_inputs["status"] == "agreed"
            and shared_inputs["runtime_fixture"]
            == {
                "organisation_id": plan["organisations"][0]["id"],
                "foreign_organisation_id": plan["organisations"][1]["id"],
                "person_id": plan["provider"]["primary_user_mapping"],
            },
            "bridge-shared-fixture-drift",
        )
        for filename, digest in shared_inputs["files"].items():
            require(sha(Path(filename).read_bytes()) == digest, "bridge-shared-source-drift")
        require(git_identity(shared.ROOT) == self.identity, "runtime-source-drift")

    def lend(self):
        bridge = self.admission["bridge"]
        self.check_bridge_files()
        barrier = time.monotonic() + bridge["barrier_seconds"]
        print(
            json.dumps(
                {
                    "bridge": "awaiting-exact-lead-admission",
                    "manifest_sha256": self.manifest_hash,
                    "harness_sha256": bridge["harness_sha256"],
                    "barrier_seconds": bridge["barrier_seconds"],
                }
            ),
            flush=True,
        )
        while not Path(bridge["admission"]).exists():
            require(time.monotonic() < barrier, "bridge-admission-barrier-expired")
            time.sleep(0.25)
        _, admitted = read_record(bridge["admission"])
        require_bridge_admission(
            admitted, self.manifest_hash, bridge["console_head"], bridge["harness_sha256"]
        )
        require(self.trust_expiry > time.time() + 240, "bridge-trust-lifetime-insufficient")
        self.check_bridge_files()
        self.inspect("container", self.names[2])
        try:
            result = hosted_bridge(bridge, self.evidence / "qualified-manifest.json", self.action)
            self.record("bridge.json", result)
        finally:
            restore_all(self.action)


def require_bridge_admission(value, manifest_hash, console_head, harness_hash):
    require(
        isinstance(value, dict)
        and type(value.get("version")) is int
        and value.get("runtime_lent") is True
        and value
        == {
            "version": 1,
            "lane": "05-client-bridge",
            "runtime_lent": True,
            "manifest_sha256": manifest_hash,
            "console_head": console_head,
            "harness_sha256": harness_hash,
        },
        "bridge-admission-refused",
    )


@contextmanager
def operation_deadline(seconds=30):
    require(0 < seconds <= 30, "operation-deadline-refused")
    require(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), "operation-timer-already-active")
    previous = signal.getsignal(signal.SIGALRM)

    def expired(signum, frame):
        raise Refusal("bridge-operation-deadline")

    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def control_batch(frames, chunk, expected_id):
    messages = frames.feed(chunk)
    require(
        len(messages) <= 1 and (not messages or not frames.buffer), "control-pipelining-refused"
    )
    return [(control_request(message, expected_id), message) for message in messages]


def write_pipe(descriptor, message):
    raw = (json.dumps(message, separators=(",", ":")) + "\n").encode()
    require(len(raw) <= MAX_FRAME, "control-reply-too-large")
    offset = 0
    deadline = time.monotonic() + 5
    while offset < len(raw):
        remaining = deadline - time.monotonic()
        require(
            remaining > 0 and bool(select.select([], [descriptor], [], max(remaining, 0))[1]),
            "control-write-deadline",
        )
        offset += os.write(descriptor, raw[offset:])


def hosted_bridge(bridge, manifest, action):
    """A reviewed fixed child, anonymous pipes, bounded bytes/time and closed reports."""
    import fcntl

    reply_read, reply_write = os.pipe()
    command_read, command_write = os.pipe()
    child_reply = fcntl.fcntl(reply_read, fcntl.F_DUPFD_CLOEXEC, 10)
    child_command = fcntl.fcntl(command_write, fcntl.F_DUPFD_CLOEXEC, 10)
    os.close(reply_read)
    os.close(command_write)
    child = None
    expected_id = 1
    last_operation = None
    terminal_report = None
    try:
        launcher = "import os,sys; r,w=int(sys.argv[1]),int(sys.argv[2]); os.dup2(r,3); os.dup2(w,4); os.close(r); os.close(w); os.execv(sys.argv[3],sys.argv[3:])"
        child = subprocess.Popen(  # noqa: S603 - exact admitted interpreter/runner and fixed arguments
            [
                sys.executable,
                "-c",
                launcher,
                str(child_reply),
                str(child_command),
                bridge["node"],
                bridge["runner"],
                "--run",
                str(manifest),
                bridge["admission"],
            ],
            cwd=Path(bridge["runner"]).parent,
            env=shared.child_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(child_reply, child_command),
        )  # noqa: S603 - exact admitted node/runner hashes, fixed arguments, no shell
        os.close(child_reply)
        os.close(child_command)
        child_reply = child_command = -1
        os.set_blocking(reply_write, False)
        frames = Frames()
        output = bytearray()
        diagnostics = bytearray()
        if child.stdout is None or child.stderr is None:
            raise Refusal("bridge-pipes-absent")
        streams = {
            command_read: "commands",
            child.stdout.fileno(): "stdout",
            child.stderr.fileno(): "stderr",
        }
        deadline = time.monotonic() + 210
        command_deadline = time.monotonic() + 30
        completion_deadline = None
        while streams:
            require(
                completion_deadline is None or time.monotonic() < completion_deadline,
                "bridge-completion-deadline",
            )
            require(time.monotonic() < deadline, "bridge-child-deadline")
            require(
                terminal_report is not None
                or time.monotonic() < command_deadline
                or child.poll() is not None,
                "bridge-command-deadline",
            )
            ready = select.select(list(streams), [], [], 0.25)[0]
            for descriptor in ready:
                chunk = os.read(descriptor, 8192)
                kind = streams[descriptor]
                if not chunk:
                    if kind == "commands":
                        frames.eof()
                    del streams[descriptor]
                    continue
                if kind != "commands":
                    if kind == "stdout":
                        require(terminal_report is None, "bridge-output-after-result")
                    target = output if kind == "stdout" else diagnostics
                    target.extend(chunk)
                    require(len(target) <= 65536, "bridge-output-bound")
                    if kind == "stdout" and b"\n" in output:
                        require(
                            output.count(b"\n") == 1 and output.endswith(b"\n"),
                            "bridge-result-refused",
                        )
                        value = unique_json(output)
                        require(
                            value.get("status") == "local-network-pass"
                            and value.get("network_executed") is True
                            and value.get("cases")
                            == ["B01", "B02", "B03", "B04", "B05", "B06", "B07"]
                            and value.get("fetch_unchanged") is True,
                            "bridge-result-refused",
                        )
                        frames.eof()
                        terminal_report = value
                        # Release a child's outstanding asynchronous read before waiting
                        # for its exit. Report acceptance alone never constitutes success.
                        os.close(reply_write)
                        reply_write = -1
                        completion_deadline = time.monotonic() + 5
                    continue
                require(terminal_report is None, "bridge-command-after-result")
                messages = control_batch(frames, chunk, expected_id)
                for operation, _message in messages:
                    last_operation = operation
                    with operation_deadline():
                        result = action(operation)
                    write_pipe(reply_write, {"id": expected_id, "ok": True, "result": result})
                    expected_id += 1
                    command_deadline = time.monotonic() + 30
        require(child.wait(timeout=5) == 0, "bridge-child-failed")
        if terminal_report is None:
            raise Refusal("bridge-result-refused")
        # Never persist arbitrary child output/diagnostics or protocol material.
        return {
            "result": "pass",
            "cases": terminal_report["cases"],
            "control_requests": expected_id - 1,
            "protocol": "kodera-bridge-v1",
        }
    finally:
        if child is not None:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            print(
                json.dumps(
                    {
                        "bridge_progress": {
                            "completed_commands": expected_id - 1,
                            "last_operation": last_operation,
                            "terminal_report_accepted": terminal_report is not None,
                            "child_exit": child.returncode,
                        }
                    }
                ),
                flush=True,
            )
            if child.stdout:
                child.stdout.close()
            if child.stderr:
                child.stderr.close()
        for descriptor in (reply_write, command_read, child_reply, child_command):
            if descriptor >= 0:
                os.close(descriptor)


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(MAX_FRAME + 1)
        require(len(raw) <= MAX_FRAME, "fixture-input-too-large")
        print(json.dumps(run_seed_operation(unique_json(raw))))
    except Exception:
        # The captured private oracle subprocess cannot dump connection/subject input.
        print("owned fixture operation failed", file=sys.stderr)
        raise SystemExit(1) from None
