"""RFC 7643 / RFC 7644 SCIM 2.0 User & Group directory sync and instant deprovisioning.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import json
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final
from uuid import UUID, uuid4

from ee.edition import require_enterprise_edition
from ee.scim.auth import ScimTokenManager
from ee.scim.schemas import (
    SCIM_ENTERPRISE_USER_SCHEMA,
    SCIM_GROUP_SCHEMA,
    SCIM_LIST_RESPONSE_SCHEMA,
    SCIM_PATCH_OP_SCHEMA,
    SCIM_USER_SCHEMA,
)

MAX_PAGE_SIZE = 200
DEFAULT_PAGE_SIZE = 100
MAX_SCIM_FILTER_LENGTH: Final[int] = 512
MAX_SCIM_PATH_LENGTH: Final[int] = 256

_FILTER_ATTR_CHARS: Final[frozenset[str]] = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-"
)
_COMPARE_OPS: Final[frozenset[str]] = frozenset({"eq", "ne", "co", "sw", "ew"})


class ScimError(ValueError):
    """Structured RFC 7644 SCIM 2.0 error."""

    def __init__(
        self,
        detail: str,
        *,
        status: int = 400,
        scim_type: str | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status = status
        self.scim_type = scim_type
        if code is not None:
            self.code = code
        elif status == 409:
            self.code = "uniqueness"
        elif status == 404:
            self.code = "not_found"
        elif status == 403:
            self.code = "forbidden"
        elif scim_type is not None:
            self.code = f"scim_{scim_type}"
        else:
            self.code = "invalid_request"


@dataclass(slots=True)
class ScimEmail:
    value: str
    type: str = "work"
    primary: bool = True


@dataclass(slots=True)
class ScimUser:
    id: str
    tenant_slug: str
    user_name: str
    external_id: str | None
    display_name: str
    given_name: str
    family_name: str
    emails: list[ScimEmail]
    active: bool
    roles: list[str]
    department: str | None
    member_state: str
    version: int
    created_at: datetime
    updated_at: datetime
    deprovisioned_at: datetime | None = None
    django_user_id: str | None = None

    @property
    def etag(self) -> str:
        return f'W/"u-{self.id}-v{self.version}"'

    def to_scim_dict(
        self,
        base_url: str,
        groups: Sequence[tuple[str, str]] = (),
    ) -> dict[str, object]:
        schemas = [SCIM_USER_SCHEMA]
        if self.department is not None:
            schemas.append(SCIM_ENTERPRISE_USER_SCHEMA)

        payload: dict[str, object] = {
            "schemas": schemas,
            "id": self.id,
            "userName": self.user_name,
            "name": {
                "givenName": self.given_name,
                "familyName": self.family_name,
                "formatted": self.display_name,
            },
            "displayName": self.display_name,
            "active": self.active,
            "emails": [
                {"value": item.value, "type": item.type, "primary": item.primary}
                for item in self.emails
            ],
            "groups": [
                {
                    "value": gid,
                    "display": gname,
                    "$ref": f"{base_url}/Groups/{gid}",
                }
                for gid, gname in groups
            ],
            "roles": [{"value": r} for r in self.roles],
            "meta": {
                "resourceType": "User",
                "created": self.created_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "lastModified": self.updated_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "location": f"{base_url}/Users/{self.id}",
                "version": self.etag,
            },
        }
        if self.external_id is not None:
            payload["externalId"] = self.external_id
        if self.department is not None:
            payload[SCIM_ENTERPRISE_USER_SCHEMA] = {"department": self.department}
        return payload


@dataclass(slots=True)
class ScimGroup:
    id: str
    tenant_slug: str
    display_name: str
    external_id: str | None
    member_ids: list[str]
    version: int
    created_at: datetime
    updated_at: datetime

    @property
    def etag(self) -> str:
        return f'W/"g-{self.id}-v{self.version}"'

    def to_scim_dict(
        self,
        base_url: str,
        member_names: Mapping[str, str],
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "schemas": [SCIM_GROUP_SCHEMA],
            "id": self.id,
            "displayName": self.display_name,
            "members": [
                {
                    "value": uid,
                    "display": member_names.get(uid, uid),
                    "$ref": f"{base_url}/Users/{uid}",
                }
                for uid in self.member_ids
            ],
            "meta": {
                "resourceType": "Group",
                "created": self.created_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "lastModified": self.updated_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "location": f"{base_url}/Groups/{self.id}",
                "version": self.etag,
            },
        }
        if self.external_id is not None:
            payload["externalId"] = self.external_id
        return payload


@dataclass(frozen=True, slots=True)
class DeprovisionRecord:
    tenant_slug: str
    user_id: str
    user_name: str
    reason: str
    revoked_sessions: tuple[str, ...]
    occurred_at: datetime


def _parse_bool_value(raw: object) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        lowered = raw.strip().lower()
        if lowered == "true":
            return True
        if lowered == "false":
            return False
    raise ScimError("Boolean value expected for attribute", status=400, scim_type="invalidValue")


def _parse_emails(raw_emails: object, fallback_username: str) -> list[ScimEmail]:
    if raw_emails is None:
        if "@" in fallback_username:
            return [ScimEmail(value=fallback_username.strip().lower(), type="work", primary=True)]
        return []
    if not isinstance(raw_emails, list):
        raise ScimError("emails must be a list", status=400, scim_type="invalidValue")
    parsed: list[ScimEmail] = []
    for idx, entry in enumerate(raw_emails):
        if not isinstance(entry, dict) or not isinstance(entry.get("value"), str):
            raise ScimError(
                "Each email object requires a string value", status=400, scim_type="invalidValue"
            )
        val = entry["value"].strip()
        if not val or "@" not in val:
            raise ScimError("Malformed email value in emails", status=400, scim_type="invalidValue")
        etype = str(entry.get("type") or "work").strip() or "work"
        primary = bool(entry.get("primary", idx == 0))
        parsed.append(ScimEmail(value=val, type=etype, primary=primary))
    return parsed


def _parse_roles(raw_roles: object) -> list[str]:
    if raw_roles is None:
        return []
    if not isinstance(raw_roles, list):
        raise ScimError("roles must be a list", status=400, scim_type="invalidValue")
    out: list[str] = []
    for item in raw_roles:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
        elif (
            isinstance(item, dict) and isinstance(item.get("value"), str) and item["value"].strip()
        ):
            out.append(item["value"].strip())
    return out


def _user_attr_values(user: ScimUser, attr_name: str) -> list[str | bool]:
    lowered = attr_name.lower()
    if lowered == "username":
        return [user.user_name]
    if lowered == "id":
        return [user.id]
    if lowered == "externalid":
        return [user.external_id] if user.external_id is not None else []
    if lowered == "displayname":
        return [user.display_name]
    if lowered == "active":
        return [user.active]
    if lowered in {"emails", "emails.value"}:
        return [e.value for e in user.emails]
    if lowered == "name.givenname":
        return [user.given_name] if user.given_name else []
    if lowered == "name.familyname":
        return [user.family_name] if user.family_name else []
    raise ScimError(
        f"Unsupported filter attribute '{attr_name}'", status=400, scim_type="invalidFilter"
    )


def _group_attr_values(group: ScimGroup, attr_name: str) -> list[str | bool]:
    lowered = attr_name.lower()
    if lowered == "displayname":
        return [group.display_name]
    if lowered == "id":
        return [group.id]
    if lowered == "externalid":
        return [group.external_id] if group.external_id is not None else []
    if lowered in {"members", "members.value"}:
        return list(group.member_ids)
    raise ScimError(
        f"Unsupported group filter attribute '{attr_name}'", status=400, scim_type="invalidFilter"
    )


def _matches_single_clause(
    values: Sequence[str | bool], op: str, literal: str | bool | None
) -> bool:
    op_low = op.lower()
    if op_low == "pr":
        return any(v != "" for v in values)

    if isinstance(literal, bool):
        bool_vals = [v for v in values if isinstance(v, bool)]
        if op_low == "eq":
            return any(v is literal for v in bool_vals)
        if op_low == "ne":
            return all(v is not literal for v in bool_vals)
        raise ScimError("Invalid boolean filter operator", status=400, scim_type="invalidFilter")

    if not isinstance(literal, str):
        raise ScimError("Invalid filter literal", status=400, scim_type="invalidFilter")
    target = literal.lower()
    str_vals = [v.lower() for v in values if isinstance(v, str)]
    if op_low == "eq":
        return any(v == target for v in str_vals)
    if op_low == "ne":
        return all(v != target for v in str_vals)
    if op_low == "co":
        return any(target in v for v in str_vals)
    if op_low == "sw":
        return any(v.startswith(target) for v in str_vals)
    if op_low == "ew":
        return any(v.endswith(target) for v in str_vals)
    raise ScimError(f"Unsupported filter operator '{op}'", status=400, scim_type="invalidFilter")


def _tokenize_scim_filter(cleaned: str) -> list[tuple[str, str]]:
    """Tokenize a bounded SCIM filter string in O(n) linear time without regular expressions."""
    tokens: list[tuple[str, str]] = []
    idx = 0
    limit = len(cleaned)
    while idx < limit:
        while idx < limit and cleaned[idx].isspace():
            idx += 1
        if idx >= limit:
            break

        if cleaned[idx] == '"':
            start = idx
            idx += 1
            escaped = False
            while idx < limit:
                ch = cleaned[idx]
                if escaped:
                    escaped = False
                    idx += 1
                    continue
                if ch == "\\":
                    escaped = True
                    idx += 1
                    continue
                if ch == '"':
                    break
                idx += 1
            if idx >= limit:
                raise ScimError(
                    "Unterminated string literal in SCIM filter",
                    status=400,
                    scim_type="invalidFilter",
                )
            raw_quoted = cleaned[start : idx + 1]
            idx += 1
            if idx < limit and not cleaned[idx].isspace():
                raise ScimError(
                    "Unexpected trailing character after string literal in SCIM filter",
                    status=400,
                    scim_type="invalidFilter",
                )
            try:
                decoded = json.loads(raw_quoted)
            except ValueError as exc:
                raise ScimError(
                    "Malformed string literal in SCIM filter",
                    status=400,
                    scim_type="invalidFilter",
                ) from exc
            if not isinstance(decoded, str):
                raise ScimError(
                    "Expected string literal in SCIM filter",
                    status=400,
                    scim_type="invalidFilter",
                )
            tokens.append(("str", decoded))
            continue

        if cleaned[idx] in _FILTER_ATTR_CHARS:
            start = idx
            while idx < limit and cleaned[idx] in _FILTER_ATTR_CHARS:
                idx += 1
            if idx < limit and not cleaned[idx].isspace():
                raise ScimError(
                    "Unexpected character in SCIM filter expression",
                    status=400,
                    scim_type="invalidFilter",
                )
            tokens.append(("word", cleaned[start:idx]))
            continue

        raise ScimError(
            "Invalid character in SCIM filter expression",
            status=400,
            scim_type="invalidFilter",
        )

    return tokens


def _parse_filter_clauses(filter_expr: str) -> list[tuple[str, str, str | bool | None]]:
    """Parse RFC 7644 SCIM filter expression in deterministic O(n) linear time (`len <= 512`)."""
    if len(filter_expr) > MAX_SCIM_FILTER_LENGTH:
        raise ScimError("Invalid or oversized SCIM filter", status=400, scim_type="invalidFilter")
    cleaned = filter_expr.strip()
    if not cleaned:
        raise ScimError("Invalid or oversized SCIM filter", status=400, scim_type="invalidFilter")

    tokens = _tokenize_scim_filter(cleaned)
    if len(tokens) < 2:
        raise ScimError("Malformed SCIM filter expression", status=400, scim_type="invalidFilter")

    clauses: list[tuple[str, str, str | bool | None]] = []
    pos = 0
    total = len(tokens)
    while pos < total:
        attr_kind, attr_name = tokens[pos]
        if attr_kind != "word" or pos + 1 >= total or tokens[pos + 1][0] != "word":
            raise ScimError(
                "Malformed SCIM filter expression", status=400, scim_type="invalidFilter"
            )
        op_word = tokens[pos + 1][1].lower()
        if op_word == "pr":
            clauses.append((attr_name, "pr", None))
            pos += 2
        elif op_word in _COMPARE_OPS:
            if pos + 2 >= total:
                raise ScimError(
                    "Missing comparison value in SCIM filter",
                    status=400,
                    scim_type="invalidFilter",
                )
            lit_kind, lit_val = tokens[pos + 2]
            if lit_kind == "str":
                clauses.append((attr_name, op_word, lit_val))
            elif lit_kind == "word" and lit_val.lower() == "true":
                clauses.append((attr_name, op_word, True))
            elif lit_kind == "word" and lit_val.lower() == "false":
                clauses.append((attr_name, op_word, False))
            else:
                raise ScimError(
                    "Invalid literal in SCIM filter expression",
                    status=400,
                    scim_type="invalidFilter",
                )
            pos += 3
        else:
            raise ScimError(
                "Unsupported operator in SCIM filter expression",
                status=400,
                scim_type="invalidFilter",
            )

        if pos < total:
            sep_kind, sep_word = tokens[pos]
            if sep_kind != "word" or sep_word.lower() != "and" or pos + 1 >= total:
                raise ScimError(
                    "Malformed logical conjunction in SCIM filter",
                    status=400,
                    scim_type="invalidFilter",
                )
            pos += 1

    return clauses


def _parse_bracket_eq_literal(inner: str, expected_attr: str) -> str | None:
    if not inner or len(inner) > MAX_SCIM_PATH_LENGTH:
        return None
    try:
        tokens = _tokenize_scim_filter(inner)
    except ScimError:
        return None
    if len(tokens) != 3:
        return None
    if tokens[0][0] != "word" or tokens[0][1].lower() != expected_attr:
        return None
    if tokens[1][0] != "word" or tokens[1][1].lower() != "eq":
        return None
    if tokens[2][0] != "str" or not tokens[2][1]:
        return None
    return tokens[2][1]


def _parse_member_filter_path(path: str) -> str | None:
    """Match `members[value eq "<id>"]` in linear O(n) time without regex."""
    if len(path) > MAX_SCIM_PATH_LENGTH or not path.endswith("]"):
        return None
    prefix, sep, rest = path[:-1].partition("[")
    if not sep or prefix.lower() != "members" or "]" in rest:
        return None
    return _parse_bracket_eq_literal(rest.strip(), "value")


def _parse_email_filter_path(path: str) -> tuple[str, str | None] | None:
    """Match `emails[type eq "<type>"][.<subattr>]` in linear O(n) time without regex."""
    if len(path) > MAX_SCIM_PATH_LENGTH:
        return None
    prefix, sep, after_open = path.partition("[")
    if not sep or prefix.lower() != "emails":
        return None
    inside, sep_close, suffix = after_open.partition("]")
    if not sep_close:
        return None
    etype = _parse_bracket_eq_literal(inside.strip(), "type")
    if etype is None:
        return None
    if suffix == "":
        return etype, None
    if (
        suffix.startswith(".")
        and len(suffix) > 1
        and all(ch.isalnum() or ch == "_" for ch in suffix[1:])
    ):
        return etype, suffix[1:]
    return None


def _paginate(
    items: Sequence[dict[str, object]],
    *,
    start_index: int = 1,
    count: int = DEFAULT_PAGE_SIZE,
) -> dict[str, object]:
    effective_start = max(1, start_index)
    effective_count = max(0, min(MAX_PAGE_SIZE, count))
    total = len(items)
    if effective_count == 0:
        sliced: list[dict[str, object]] = []
    else:
        offset = effective_start - 1
        sliced = list(items[offset : offset + effective_count])
    return {
        "schemas": [SCIM_LIST_RESPONSE_SCHEMA],
        "totalResults": total,
        "startIndex": effective_start,
        "itemsPerPage": len(sliced),
        "Resources": sliced,
    }


class ScimService:
    """Tenant-isolated SCIM 2.0 User & Group directory service with instant session revocation."""

    def __init__(self, *, tokens: ScimTokenManager | None = None) -> None:
        self._lock = threading.Lock()
        self.tokens = tokens if tokens is not None else ScimTokenManager()
        self._users: dict[tuple[str, str], ScimUser] = {}
        self._groups: dict[tuple[str, str], ScimGroup] = {}
        self._active_sessions: dict[tuple[str, str], set[str]] = {}
        self._deprovision_log: list[DeprovisionRecord] = []

    def reset(self) -> None:
        with self._lock:
            self._users.clear()
            self._groups.clear()
            self._active_sessions.clear()
            self._deprovision_log.clear()
        self.tokens.reset()

    def register_session(self, tenant_slug: str, user_id: str, session_id: str) -> None:
        """Bind an active session identifier to a SCIM-managed user (revoked on deprovision)."""
        require_enterprise_edition()
        with self._lock:
            user = self._users.get((tenant_slug, user_id))
            if user is None or not user.active:
                raise ScimError("Cannot create session for inactive or unknown user", status=403)
            self._active_sessions.setdefault((tenant_slug, user_id), set()).add(session_id)

    def active_sessions(self, tenant_slug: str, user_id: str) -> frozenset[str]:
        require_enterprise_edition()
        with self._lock:
            return frozenset(self._active_sessions.get((tenant_slug, user_id), set()))

    def deprovision_events(self, tenant_slug: str) -> list[DeprovisionRecord]:
        require_enterprise_edition()
        with self._lock:
            return [evt for evt in self._deprovision_log if evt.tenant_slug == tenant_slug]

    def _groups_for_user_locked(self, tenant_slug: str, user_id: str) -> list[tuple[str, str]]:
        return [
            (grp.id, grp.display_name)
            for (t_slug, _), grp in sorted(self._groups.items())
            if t_slug == tenant_slug and user_id in grp.member_ids
        ]

    def _member_names_locked(self, tenant_slug: str) -> dict[str, str]:
        return {
            usr.id: (usr.display_name or usr.user_name)
            for (t_slug, _), usr in self._users.items()
            if t_slug == tenant_slug
        }

    def _deprovision_user_locked(
        self,
        user: ScimUser,
        *,
        reason: str,
        organisation_id: UUID | None,
        now: datetime,
    ) -> None:
        session_key = (user.tenant_slug, user.id)
        revoked = tuple(sorted(self._active_sessions.pop(session_key, set())))
        user.active = False
        user.member_state = "deprovisioned"
        user.deprovisioned_at = now
        self._deprovision_log.append(
            DeprovisionRecord(
                tenant_slug=user.tenant_slug,
                user_id=user.id,
                user_name=user.user_name,
                reason=reason,
                revoked_sessions=revoked,
                occurred_at=now,
            )
        )
        if organisation_id is not None and user.django_user_id is not None:
            _sync_django_scim_deprovision(organisation_id, UUID(user.django_user_id))

    def create_user(
        self,
        *,
        tenant_slug: str,
        payload: Mapping[str, object],
        base_url: str,
        organisation_id: UUID | None = None,
        now: datetime | None = None,
    ) -> dict[str, object]:
        require_enterprise_edition()
        user_name_raw = payload.get("userName")
        if not isinstance(user_name_raw, str) or not user_name_raw.strip():
            raise ScimError("userName is required", status=400, scim_type="invalidValue")
        user_name = user_name_raw.strip()

        raw_name = payload.get("name")
        given_name = ""
        family_name = ""
        if isinstance(raw_name, dict):
            if isinstance(raw_name.get("givenName"), str):
                given_name = raw_name["givenName"].strip()
            if isinstance(raw_name.get("familyName"), str):
                family_name = raw_name["familyName"].strip()

        display_raw = payload.get("displayName")
        if isinstance(display_raw, str) and display_raw.strip():
            display_name = display_raw.strip()
        elif given_name or family_name:
            display_name = f"{given_name} {family_name}".strip()
        else:
            display_name = user_name

        ext_raw = payload.get("externalId")
        external_id = ext_raw.strip() if isinstance(ext_raw, str) and ext_raw.strip() else None
        active = _parse_bool_value(payload.get("active", True))
        emails = _parse_emails(payload.get("emails"), user_name)
        roles = _parse_roles(payload.get("roles"))

        ent_ext = payload.get(SCIM_ENTERPRISE_USER_SCHEMA)
        department: str | None = None
        if isinstance(ent_ext, dict) and isinstance(ent_ext.get("department"), str):
            department = ent_ext["department"].strip() or None

        timestamp = (now or datetime.now(UTC)).astimezone(UTC)

        with self._lock:
            for (t_slug, _), existing in self._users.items():
                if t_slug == tenant_slug and existing.user_name.lower() == user_name.lower():
                    raise ScimError(
                        f"User with userName {user_name!r} already exists in tenant",
                        status=409,
                        scim_type="uniqueness",
                    )

            user_id = str(uuid4())
            django_uid: str | None = None
            if organisation_id is not None:
                primary_email = user_name
                for em in emails:
                    if em.value.strip():
                        primary_email = em.value.strip()
                        break
                django_uid = _sync_django_scim_provision(
                    organisation_id=organisation_id,
                    user_name=user_name,
                    email=primary_email,
                    display_name=display_name,
                    active=active,
                )

            user = ScimUser(
                id=user_id,
                tenant_slug=tenant_slug,
                user_name=user_name,
                external_id=external_id,
                display_name=display_name,
                given_name=given_name,
                family_name=family_name,
                emails=emails,
                active=active,
                roles=roles,
                department=department,
                member_state="active" if active else "deprovisioned",
                version=1,
                created_at=timestamp,
                updated_at=timestamp,
                deprovisioned_at=None if active else timestamp,
                django_user_id=django_uid,
            )
            self._users[(tenant_slug, user_id)] = user
            if not active:
                self._deprovision_user_locked(
                    user,
                    reason="created_inactive",
                    organisation_id=organisation_id,
                    now=timestamp,
                )
            groups = self._groups_for_user_locked(tenant_slug, user_id)
            return user.to_scim_dict(base_url, groups)

    def get_user(
        self,
        *,
        tenant_slug: str,
        user_id: str,
        base_url: str,
    ) -> dict[str, object]:
        require_enterprise_edition()
        with self._lock:
            user = self._users.get((tenant_slug, user_id))
            if user is None:
                raise ScimError(f"User {user_id!r} not found", status=404)
            groups = self._groups_for_user_locked(tenant_slug, user.id)
            return user.to_scim_dict(base_url, groups)

    def list_users(
        self,
        *,
        tenant_slug: str,
        base_url: str,
        filter_expr: str | None = None,
        start_index: int = 1,
        count: int = DEFAULT_PAGE_SIZE,
    ) -> dict[str, object]:
        require_enterprise_edition()
        clauses = _parse_filter_clauses(filter_expr) if filter_expr else []
        with self._lock:
            tenant_users = [
                usr
                for (t_slug, _), usr in sorted(
                    self._users.items(), key=lambda item: item[1].created_at
                )
                if t_slug == tenant_slug
            ]
            matched: list[dict[str, object]] = []
            for usr in tenant_users:
                if all(
                    _matches_single_clause(_user_attr_values(usr, attr), op, lit)
                    for attr, op, lit in clauses
                ):
                    groups = self._groups_for_user_locked(tenant_slug, usr.id)
                    matched.append(usr.to_scim_dict(base_url, groups))
        return _paginate(matched, start_index=start_index, count=count)

    def replace_user(
        self,
        *,
        tenant_slug: str,
        user_id: str,
        payload: Mapping[str, object],
        base_url: str,
        organisation_id: UUID | None = None,
        now: datetime | None = None,
    ) -> dict[str, object]:
        require_enterprise_edition()
        user_name_raw = payload.get("userName")
        if not isinstance(user_name_raw, str) or not user_name_raw.strip():
            raise ScimError("userName is required for PUT", status=400, scim_type="invalidValue")
        new_user_name = user_name_raw.strip()
        new_active = _parse_bool_value(payload.get("active", True))
        timestamp = (now or datetime.now(UTC)).astimezone(UTC)

        with self._lock:
            user = self._users.get((tenant_slug, user_id))
            if user is None:
                raise ScimError(f"User {user_id!r} not found", status=404)

            for (t_slug, uid), other in self._users.items():
                if (
                    t_slug == tenant_slug
                    and uid != user_id
                    and other.user_name.lower() == new_user_name.lower()
                ):
                    raise ScimError(
                        f"User with userName {new_user_name!r} already exists",
                        status=409,
                        scim_type="uniqueness",
                    )

            raw_name = payload.get("name")
            given_name = ""
            family_name = ""
            if isinstance(raw_name, dict):
                if isinstance(raw_name.get("givenName"), str):
                    given_name = raw_name["givenName"].strip()
                if isinstance(raw_name.get("familyName"), str):
                    family_name = raw_name["familyName"].strip()

            display_raw = payload.get("displayName")
            if isinstance(display_raw, str) and display_raw.strip():
                display_name = display_raw.strip()
            elif given_name or family_name:
                display_name = f"{given_name} {family_name}".strip()
            else:
                display_name = new_user_name

            ext_raw = payload.get("externalId")
            user.user_name = new_user_name
            user.external_id = (
                ext_raw.strip() if isinstance(ext_raw, str) and ext_raw.strip() else None
            )
            user.given_name = given_name
            user.family_name = family_name
            user.display_name = display_name
            user.emails = _parse_emails(payload.get("emails"), new_user_name)
            user.roles = _parse_roles(payload.get("roles"))
            ent_ext = payload.get(SCIM_ENTERPRISE_USER_SCHEMA)
            if isinstance(ent_ext, dict) and isinstance(ent_ext.get("department"), str):
                user.department = ent_ext["department"].strip() or None
            else:
                user.department = None

            was_active = user.active
            user.active = new_active
            user.version += 1
            user.updated_at = timestamp
            if not new_active:
                self._deprovision_user_locked(
                    user,
                    reason="put_active_false",
                    organisation_id=organisation_id,
                    now=timestamp,
                )
            elif not was_active and new_active:
                user.member_state = "active"
                user.deprovisioned_at = None
                if organisation_id is not None and user.django_user_id is not None:
                    _sync_django_scim_reactivate(organisation_id, UUID(user.django_user_id))

            groups = self._groups_for_user_locked(tenant_slug, user.id)
            return user.to_scim_dict(base_url, groups)

    def patch_user(
        self,
        *,
        tenant_slug: str,
        user_id: str,
        payload: Mapping[str, object],
        base_url: str,
        organisation_id: UUID | None = None,
        now: datetime | None = None,
    ) -> dict[str, object]:
        require_enterprise_edition()
        schemas = payload.get("schemas")
        if not isinstance(schemas, list) or SCIM_PATCH_OP_SCHEMA not in schemas:
            raise ScimError(
                f"PATCH request must declare {SCIM_PATCH_OP_SCHEMA}",
                status=400,
                scim_type="invalidSyntax",
            )
        operations = payload.get("Operations")
        if not isinstance(operations, list) or not operations:
            raise ScimError(
                "PATCH Operations must be a non-empty list", status=400, scim_type="invalidSyntax"
            )

        timestamp = (now or datetime.now(UTC)).astimezone(UTC)
        with self._lock:
            user = self._users.get((tenant_slug, user_id))
            if user is None:
                raise ScimError(f"User {user_id!r} not found", status=404)

            deprovision_triggered = False
            reactivate_triggered = False

            for op_entry in operations:
                if not isinstance(op_entry, dict) or not isinstance(op_entry.get("op"), str):
                    raise ScimError(
                        "Each PATCH operation requires 'op'", status=400, scim_type="invalidSyntax"
                    )
                op = op_entry["op"].strip().lower()
                if op not in {"add", "replace", "remove"}:
                    raise ScimError(
                        f"Unsupported PATCH op {op!r}", status=400, scim_type="invalidSyntax"
                    )

                raw_path = op_entry.get("path")
                path = raw_path.strip() if isinstance(raw_path, str) else ""
                value = op_entry.get("value")

                if not path:
                    if op == "remove":
                        raise ScimError(
                            "PATCH remove requires a target path", status=400, scim_type="noTarget"
                        )
                    if not isinstance(value, dict):
                        raise ScimError(
                            "Pathless PATCH add/replace requires an object value",
                            status=400,
                            scim_type="invalidSyntax",
                        )
                    for k, v in value.items():
                        deprov, reactiv = self._apply_user_field_op_locked(
                            user, op=op, path=k, value=v
                        )
                        deprovision_triggered = deprovision_triggered or deprov
                        reactivate_triggered = reactivate_triggered or reactiv
                else:
                    deprov, reactiv = self._apply_user_field_op_locked(
                        user, op=op, path=path, value=value
                    )
                    deprovision_triggered = deprovision_triggered or deprov
                    reactivate_triggered = reactivate_triggered or reactiv

            user.version += 1
            user.updated_at = timestamp
            if deprovision_triggered and not user.active:
                self._deprovision_user_locked(
                    user,
                    reason="patch_active_false",
                    organisation_id=organisation_id,
                    now=timestamp,
                )
            elif reactivate_triggered and user.active:
                user.member_state = "active"
                user.deprovisioned_at = None
                if organisation_id is not None and user.django_user_id is not None:
                    _sync_django_scim_reactivate(organisation_id, UUID(user.django_user_id))

            groups = self._groups_for_user_locked(tenant_slug, user.id)
            return user.to_scim_dict(base_url, groups)

    def _apply_user_field_op_locked(
        self,
        user: ScimUser,
        *,
        op: str,
        path: str,
        value: object,
    ) -> tuple[bool, bool]:
        """Apply a single attribute mutation on `user`; returns `(deprovisioned, reactivated)`."""
        low_path = path.lower()
        if low_path == "active":
            if op == "remove":
                raise ScimError("active cannot be removed", status=400, scim_type="mutability")
            new_active = _parse_bool_value(value)
            was_active = user.active
            user.active = new_active
            return (not new_active), (not was_active and new_active)

        if low_path == "username":
            if op == "remove" or not isinstance(value, str) or not value.strip():
                raise ScimError(
                    "userName requires a non-empty string", status=400, scim_type="invalidValue"
                )
            candidate = value.strip()
            for (t_slug, uid), other in self._users.items():
                if (
                    t_slug == user.tenant_slug
                    and uid != user.id
                    and other.user_name.lower() == candidate.lower()
                ):
                    raise ScimError(
                        "Duplicate userName in tenant", status=409, scim_type="uniqueness"
                    )
            user.user_name = candidate
            return False, False

        if low_path == "displayname":
            user.display_name = "" if op == "remove" else str(value or "").strip()
            return False, False

        if low_path == "externalid":
            user.external_id = (
                None if op == "remove" else (str(value).strip() if value is not None else None)
            )
            return False, False

        if low_path == "name.givenname":
            user.given_name = "" if op == "remove" else str(value or "").strip()
            return False, False

        if low_path == "name.familyname":
            user.family_name = "" if op == "remove" else str(value or "").strip()
            return False, False

        if low_path == "name" and isinstance(value, dict):
            if "givenName" in value and isinstance(value["givenName"], str):
                user.given_name = value["givenName"].strip()
            if "familyName" in value and isinstance(value["familyName"], str):
                user.family_name = value["familyName"].strip()
            return False, False

        if low_path == "emails":
            user.emails = [] if op == "remove" else _parse_emails(value, user.user_name)
            return False, False

        email_filter_parsed = _parse_email_filter_path(path)
        if email_filter_parsed is not None:
            etype, subattr = email_filter_parsed
            sub = (subattr or "value").lower()
            if sub == "value" and isinstance(value, str) and value.strip():
                updated = False
                for em in user.emails:
                    if em.type.lower() == etype.lower():
                        em.value = value.strip()
                        updated = True
                if not updated:
                    user.emails.append(
                        ScimEmail(value=value.strip(), type=etype, primary=not user.emails)
                    )
                return False, False

        if low_path == "roles":
            user.roles = [] if op == "remove" else _parse_roles(value)
            return False, False

        if low_path in {
            f"{SCIM_ENTERPRISE_USER_SCHEMA.lower()}:department",
            "urn:ietf:params:scim:schemas:extension:enterprise:2.0:user:department",
        }:
            user.department = None if op == "remove" else (str(value).strip() or None)
            return False, False

        if path == SCIM_ENTERPRISE_USER_SCHEMA and isinstance(value, dict):
            if "department" in value:
                raw_dep = value["department"]
                user.department = (
                    str(raw_dep).strip() if isinstance(raw_dep, str) and raw_dep.strip() else None
                )
            return False, False

        raise ScimError(f"Unsupported PATCH path '{path}'", status=400, scim_type="invalidPath")

    def delete_user(
        self,
        *,
        tenant_slug: str,
        user_id: str,
        organisation_id: UUID | None = None,
        now: datetime | None = None,
    ) -> None:
        require_enterprise_edition()
        timestamp = (now or datetime.now(UTC)).astimezone(UTC)
        with self._lock:
            user = self._users.pop((tenant_slug, user_id), None)
            if user is None:
                raise ScimError(f"User {user_id!r} not found", status=404)
            self._deprovision_user_locked(
                user,
                reason="delete_user",
                organisation_id=organisation_id,
                now=timestamp,
            )
            for (t_slug, _), grp in self._groups.items():
                if t_slug == tenant_slug and user_id in grp.member_ids:
                    grp.member_ids = [uid for uid in grp.member_ids if uid != user_id]
                    grp.version += 1
                    grp.updated_at = timestamp

    # ------------------------------------------------------------------ Groups

    def _extract_member_ids_locked(self, tenant_slug: str, raw_members: object) -> list[str]:
        if raw_members is None:
            return []
        if not isinstance(raw_members, list):
            raise ScimError("Group members must be a list", status=400, scim_type="invalidValue")
        member_ids: list[str] = []
        seen: set[str] = set()
        for entry in raw_members:
            uid: str | None = None
            if isinstance(entry, dict) and isinstance(entry.get("value"), str):
                uid = entry["value"].strip()
            elif isinstance(entry, str):
                uid = entry.strip()
            if not uid:
                raise ScimError(
                    "Each group member entry requires a user 'value'",
                    status=400,
                    scim_type="invalidValue",
                )
            if (tenant_slug, uid) not in self._users:
                raise ScimError(
                    f"Member user {uid!r} does not exist in tenant {tenant_slug!r}",
                    status=400,
                    scim_type="invalidValue",
                )
            if uid not in seen:
                seen.add(uid)
                member_ids.append(uid)
        return member_ids

    def create_group(
        self,
        *,
        tenant_slug: str,
        payload: Mapping[str, object],
        base_url: str,
        now: datetime | None = None,
    ) -> dict[str, object]:
        require_enterprise_edition()
        display_raw = payload.get("displayName")
        if not isinstance(display_raw, str) or not display_raw.strip():
            raise ScimError("Group displayName is required", status=400, scim_type="invalidValue")
        display_name = display_raw.strip()
        ext_raw = payload.get("externalId")
        external_id = ext_raw.strip() if isinstance(ext_raw, str) and ext_raw.strip() else None
        timestamp = (now or datetime.now(UTC)).astimezone(UTC)

        with self._lock:
            for (t_slug, _), existing in self._groups.items():
                if t_slug == tenant_slug and existing.display_name.lower() == display_name.lower():
                    raise ScimError(
                        f"Group {display_name!r} already exists in tenant",
                        status=409,
                        scim_type="uniqueness",
                    )
            member_ids = self._extract_member_ids_locked(tenant_slug, payload.get("members"))
            group_id = str(uuid4())
            group = ScimGroup(
                id=group_id,
                tenant_slug=tenant_slug,
                display_name=display_name,
                external_id=external_id,
                member_ids=member_ids,
                version=1,
                created_at=timestamp,
                updated_at=timestamp,
            )
            self._groups[(tenant_slug, group_id)] = group
            return group.to_scim_dict(base_url, self._member_names_locked(tenant_slug))

    def get_group(
        self,
        *,
        tenant_slug: str,
        group_id: str,
        base_url: str,
    ) -> dict[str, object]:
        require_enterprise_edition()
        with self._lock:
            group = self._groups.get((tenant_slug, group_id))
            if group is None:
                raise ScimError(f"Group {group_id!r} not found", status=404)
            return group.to_scim_dict(base_url, self._member_names_locked(tenant_slug))

    def list_groups(
        self,
        *,
        tenant_slug: str,
        base_url: str,
        filter_expr: str | None = None,
        start_index: int = 1,
        count: int = DEFAULT_PAGE_SIZE,
    ) -> dict[str, object]:
        require_enterprise_edition()
        clauses = _parse_filter_clauses(filter_expr) if filter_expr else []
        with self._lock:
            names = self._member_names_locked(tenant_slug)
            tenant_groups = [
                grp
                for (t_slug, _), grp in sorted(
                    self._groups.items(), key=lambda item: item[1].created_at
                )
                if t_slug == tenant_slug
            ]
            matched: list[dict[str, object]] = []
            for grp in tenant_groups:
                if all(
                    _matches_single_clause(_group_attr_values(grp, attr), op, lit)
                    for attr, op, lit in clauses
                ):
                    matched.append(grp.to_scim_dict(base_url, names))
        return _paginate(matched, start_index=start_index, count=count)

    def replace_group(
        self,
        *,
        tenant_slug: str,
        group_id: str,
        payload: Mapping[str, object],
        base_url: str,
        now: datetime | None = None,
    ) -> dict[str, object]:
        require_enterprise_edition()
        display_raw = payload.get("displayName")
        if not isinstance(display_raw, str) or not display_raw.strip():
            raise ScimError("Group displayName is required", status=400, scim_type="invalidValue")
        new_display = display_raw.strip()
        timestamp = (now or datetime.now(UTC)).astimezone(UTC)

        with self._lock:
            group = self._groups.get((tenant_slug, group_id))
            if group is None:
                raise ScimError(f"Group {group_id!r} not found", status=404)
            for (t_slug, gid), other in self._groups.items():
                if (
                    t_slug == tenant_slug
                    and gid != group_id
                    and other.display_name.lower() == new_display.lower()
                ):
                    raise ScimError(
                        "Duplicate group displayName in tenant", status=409, scim_type="uniqueness"
                    )
            ext_raw = payload.get("externalId")
            group.display_name = new_display
            group.external_id = (
                ext_raw.strip() if isinstance(ext_raw, str) and ext_raw.strip() else None
            )
            group.member_ids = self._extract_member_ids_locked(tenant_slug, payload.get("members"))
            group.version += 1
            group.updated_at = timestamp
            return group.to_scim_dict(base_url, self._member_names_locked(tenant_slug))

    def patch_group(
        self,
        *,
        tenant_slug: str,
        group_id: str,
        payload: Mapping[str, object],
        base_url: str,
        now: datetime | None = None,
    ) -> dict[str, object]:
        require_enterprise_edition()
        schemas = payload.get("schemas")
        if not isinstance(schemas, list) or SCIM_PATCH_OP_SCHEMA not in schemas:
            raise ScimError(
                f"PATCH request must declare {SCIM_PATCH_OP_SCHEMA}",
                status=400,
                scim_type="invalidSyntax",
            )
        operations = payload.get("Operations")
        if not isinstance(operations, list) or not operations:
            raise ScimError(
                "PATCH Operations must be a non-empty list", status=400, scim_type="invalidSyntax"
            )

        timestamp = (now or datetime.now(UTC)).astimezone(UTC)
        with self._lock:
            group = self._groups.get((tenant_slug, group_id))
            if group is None:
                raise ScimError(f"Group {group_id!r} not found", status=404)

            for op_entry in operations:
                if not isinstance(op_entry, dict) or not isinstance(op_entry.get("op"), str):
                    raise ScimError(
                        "Each PATCH operation requires 'op'", status=400, scim_type="invalidSyntax"
                    )
                op = op_entry["op"].strip().lower()
                if op not in {"add", "replace", "remove"}:
                    raise ScimError(
                        f"Unsupported PATCH op {op!r}", status=400, scim_type="invalidSyntax"
                    )
                raw_path = op_entry.get("path")
                path = raw_path.strip() if isinstance(raw_path, str) else ""
                value = op_entry.get("value")

                if not path and isinstance(value, dict):
                    if "displayName" in value:
                        self._set_group_display_name_locked(group, value["displayName"])
                    if "members" in value:
                        self._apply_group_members_op_locked(group, op=op, value=value["members"])
                    continue

                if path.lower() == "displayname":
                    if op == "remove":
                        raise ScimError(
                            "Group displayName cannot be removed",
                            status=400,
                            scim_type="mutability",
                        )
                    self._set_group_display_name_locked(group, value)
                    continue

                if path.lower() == "members":
                    self._apply_group_members_op_locked(group, op=op, value=value)
                    continue

                target_uid = _parse_member_filter_path(path)
                if target_uid is not None and op == "remove":
                    group.member_ids = [uid for uid in group.member_ids if uid != target_uid]
                    continue

                raise ScimError(
                    f"Unsupported Group PATCH path '{path}'", status=400, scim_type="invalidPath"
                )

            group.version += 1
            group.updated_at = timestamp
            return group.to_scim_dict(base_url, self._member_names_locked(tenant_slug))

    def _set_group_display_name_locked(self, group: ScimGroup, raw_name: object) -> None:
        if not isinstance(raw_name, str) or not raw_name.strip():
            raise ScimError(
                "displayName requires a non-empty string", status=400, scim_type="invalidValue"
            )
        candidate = raw_name.strip()
        for (t_slug, gid), other in self._groups.items():
            if (
                t_slug == group.tenant_slug
                and gid != group.id
                and other.display_name.lower() == candidate.lower()
            ):
                raise ScimError(
                    "Duplicate group displayName in tenant", status=409, scim_type="uniqueness"
                )
        group.display_name = candidate

    def _apply_group_members_op_locked(
        self,
        group: ScimGroup,
        *,
        op: str,
        value: object,
    ) -> None:
        if op == "remove":
            if value is None:
                group.member_ids = []
                return
            if not isinstance(value, list):
                raise ScimError(
                    "Remove members value must be a list", status=400, scim_type="invalidValue"
                )
            remove_ids: set[str] = set()
            for entry in value:
                if isinstance(entry, dict) and isinstance(entry.get("value"), str):
                    remove_ids.add(entry["value"].strip())
                elif isinstance(entry, str):
                    remove_ids.add(entry.strip())
            group.member_ids = [uid for uid in group.member_ids if uid not in remove_ids]
            return

        new_ids = self._extract_member_ids_locked(group.tenant_slug, value)
        if op == "replace":
            group.member_ids = new_ids
        elif op == "add":
            for uid in new_ids:
                if uid not in group.member_ids:
                    group.member_ids.append(uid)

    def delete_group(
        self,
        *,
        tenant_slug: str,
        group_id: str,
    ) -> None:
        require_enterprise_edition()
        with self._lock:
            removed = self._groups.pop((tenant_slug, group_id), None)
            if removed is None:
                raise ScimError(f"Group {group_id!r} not found", status=404)


def _sync_django_scim_provision(
    *,
    organisation_id: UUID,
    user_name: str,
    email: str,
    display_name: str,
    active: bool,
) -> str:
    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership, Organisation
    from django.db import transaction
    from django.utils import timezone

    with transaction.atomic():
        org = Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True).first()
        if org is None:
            raise ScimError("Bound organisation does not exist", status=404)
        subj = "".join(ch if "!" <= ch <= "~" else "_" for ch in user_name.lower())[:255]
        identity = (
            Identity.objects.select_for_update()
            .select_related("user")
            .filter(organisation=org, issuer=org.issuer, subject=subj)
            .first()
        )
        if identity is None:
            user = User.objects.create(
                email=email,
                display_name=display_name[:200] if display_name else None,
                enabled=active,
            )
            Identity.objects.create(
                user=user,
                organisation=org,
                realm=org.realm,
                issuer=org.issuer,
                subject=subj,
                email=email,
                enabled=active,
            )
        else:
            user = identity.user
            user.enabled = active
            user.save(update_fields=["enabled"])
            identity.enabled = active
            identity.save(update_fields=["enabled"])

        now_ts = timezone.now()
        state = Membership.State.ACTIVE if active else Membership.State.SUSPENDED
        membership = (
            Membership.objects.select_for_update().filter(organisation=org, user=user).first()
        )
        if membership is None:
            Membership.objects.create(
                organisation=org,
                user=user,
                role=Membership.Role.MEMBER,
                state=state,
                accepted_at=now_ts,
            )
        else:
            membership.state = state
            if membership.accepted_at is None:
                membership.accepted_at = now_ts
            membership.save(update_fields=["state", "accepted_at", "updated_at"])
        return str(user.id)


def _sync_django_scim_deprovision(organisation_id: UUID, user_uuid: UUID) -> None:
    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership
    from django.db import transaction

    with transaction.atomic():
        User.objects.filter(id=user_uuid).update(enabled=False)
        Identity.objects.filter(organisation_id=organisation_id, user_id=user_uuid).update(
            enabled=False
        )
        Membership.objects.filter(organisation_id=organisation_id, user_id=user_uuid).update(
            state=Membership.State.SUSPENDED
        )


def _sync_django_scim_reactivate(organisation_id: UUID, user_uuid: UUID) -> None:
    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership
    from django.db import transaction

    with transaction.atomic():
        User.objects.filter(id=user_uuid).update(enabled=True)
        Identity.objects.filter(organisation_id=organisation_id, user_id=user_uuid).update(
            enabled=True
        )
        Membership.objects.filter(organisation_id=organisation_id, user_id=user_uuid).update(
            state=Membership.State.ACTIVE
        )


default_scim_service = ScimService()
