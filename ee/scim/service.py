"""RFC 7643 / RFC 7644 SCIM 2.0 User & Group directory sync and instant deprovisioning.

Persists SCIM directory users (`ee_scim_user`), groups (`ee_scim_group`), group memberships
(`ee_scim_group_member`), active user sessions (`ee_scim_session`), and append-only deprovisioning
records (`ee_scim_deprovision`) in PostgreSQL under per-organisation advisory locks and Core
privacy-erasure cutoff fences.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final, cast
from uuid import UUID, uuid4

from django.db import DatabaseError, IntegrityError, connection, transaction
from uuid6 import uuid7

from ee.edition import require_enterprise_edition
from ee.scim.auth import ScimTokenManager
from ee.scim.schemas import (
    SCIM_ENTERPRISE_USER_SCHEMA,
    SCIM_GROUP_SCHEMA,
    SCIM_LIST_RESPONSE_SCHEMA,
    SCIM_PATCH_OP_SCHEMA,
    SCIM_USER_SCHEMA,
)
from ee.store import (
    TenantCutoffError,
    acquire_active_tenant_fence,
    can_use_postgres,
    is_retriable_lock_contention,
    reset_ee_tables,
    resolve_tenant_organisation,
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
    django_user_id: str | None = None


@dataclass(slots=True)
class _TenantScimState:
    tenant_slug: str
    organisation_id: UUID | None = None
    users: dict[str, ScimUser] = field(default_factory=dict)
    groups: dict[str, ScimGroup] = field(default_factory=dict)
    sessions: dict[str, set[str]] = field(default_factory=dict)
    deprovision_log: list[DeprovisionRecord] = field(default_factory=list)
    new_deprovision_events: list[DeprovisionRecord] = field(default_factory=list)
    initial_user_snapshots: dict[str, str] = field(default_factory=dict)
    initial_group_snapshots: dict[str, tuple[str, dict[str, int]]] = field(default_factory=dict)
    initial_sessions: dict[str, set[str]] = field(default_factory=dict)


def _emails_to_json(emails: Sequence[ScimEmail]) -> str:
    return json.dumps(
        [{"value": e.value, "type": e.type, "primary": e.primary} for e in emails],
        sort_keys=True,
        separators=(",", ":"),
    )


def _emails_from_json(raw: str) -> list[ScimEmail]:
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        return []
    return [
        ScimEmail(
            value=str(item["value"]),
            type=str(item.get("type", "work")),
            primary=bool(item.get("primary", False)),
        )
        for item in parsed
        if isinstance(item, dict) and "value" in item
    ]


def _roles_to_json(roles: Sequence[str]) -> str:
    return json.dumps([str(r) for r in roles], separators=(",", ":"))


def _roles_from_json(raw: str) -> list[str]:
    parsed = json.loads(raw)
    return [str(r) for r in parsed] if isinstance(parsed, list) else []


def _coerce_utc(raw: object) -> datetime:
    if isinstance(raw, datetime):
        return raw.astimezone(UTC)
    return datetime.fromisoformat(str(raw)).astimezone(UTC)


def _user_snapshot_key(user: ScimUser) -> str:
    return json.dumps(
        {
            "user_name": user.user_name,
            "external_id": user.external_id,
            "display_name": user.display_name,
            "given_name": user.given_name,
            "family_name": user.family_name,
            "emails": _emails_to_json(user.emails),
            "active": user.active,
            "roles": _roles_to_json(user.roles),
            "department": user.department,
            "member_state": user.member_state,
            "version": user.version,
            "updated_at": user.updated_at.astimezone(UTC).isoformat(),
            "deprovisioned_at": user.deprovisioned_at.astimezone(UTC).isoformat()
            if user.deprovisioned_at is not None
            else None,
            "django_user_id": user.django_user_id,
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _group_header_snapshot_key(group: ScimGroup) -> str:
    return json.dumps(
        {
            "display_name": group.display_name,
            "external_id": group.external_id,
            "version": group.version,
            "updated_at": group.updated_at.astimezone(UTC).isoformat(),
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _resolve_scim_org_id(
    cur: object,
    *,
    tenant_slug: str,
    organisation_id: UUID | None = None,
) -> UUID | None:
    cursor = cast(Any, cur)
    if organisation_id is not None:
        return organisation_id
    found = resolve_tenant_organisation(
        cursor,
        tenant_slug=tenant_slug,
        require_open=False,
    )
    if found is not None:
        return found[0]
    for lookup_sql in (
        "SELECT organisation_id FROM public.ee_scim_token WHERE tenant_slug = %s ORDER BY created_at DESC LIMIT 1",
        "SELECT organisation_id FROM public.ee_scim_user WHERE tenant_slug = %s ORDER BY created_at DESC LIMIT 1",
        "SELECT organisation_id FROM public.ee_scim_group WHERE tenant_slug = %s ORDER BY created_at DESC LIMIT 1",
        "SELECT organisation_id FROM public.ee_scim_deprovision WHERE tenant_slug = %s ORDER BY occurred_at DESC LIMIT 1",
    ):
        cursor.execute(lookup_sql, [tenant_slug])
        row = cursor.fetchone()
        if row is not None and row[0] is not None:
            raw_id = row[0]
            return raw_id if isinstance(raw_id, UUID) else UUID(str(raw_id))
    return None


def _load_postgres_tenant_state(
    cur: object,
    *,
    organisation_id: UUID,
    tenant_slug: str,
) -> _TenantScimState:
    cursor = cast(Any, cur)
    state = _TenantScimState(tenant_slug=tenant_slug, organisation_id=organisation_id)

    cursor.execute(
        """
        SELECT
            id, user_id, user_name, external_id, display_name, given_name, family_name,
            emails_json, active, roles_json, department, member_state, version,
            created_at, updated_at, deprovisioned_at
        FROM public.ee_scim_user
        WHERE organisation_id = %s AND tenant_slug = %s
        ORDER BY created_at ASC, id ASC
        """,
        [organisation_id, tenant_slug],
    )
    for u_row in cursor.fetchall():
        uid_str = str(u_row[0])
        person_str = str(u_row[1]) if u_row[1] is not None else None
        usr = ScimUser(
            id=uid_str,
            tenant_slug=tenant_slug,
            user_name=str(u_row[2]),
            external_id=str(u_row[3]) if u_row[3] is not None else None,
            display_name=str(u_row[4]),
            given_name=str(u_row[5]),
            family_name=str(u_row[6]),
            emails=_emails_from_json(str(u_row[7])),
            active=bool(u_row[8]),
            roles=_roles_from_json(str(u_row[9])),
            department=str(u_row[10]) if u_row[10] is not None else None,
            member_state=str(u_row[11]),
            version=int(u_row[12]),
            created_at=_coerce_utc(u_row[13]),
            updated_at=_coerce_utc(u_row[14]),
            deprovisioned_at=_coerce_utc(u_row[15]) if u_row[15] is not None else None,
            django_user_id=person_str,
        )
        state.users[usr.id] = usr
        state.initial_user_snapshots[usr.id] = _user_snapshot_key(usr)

    cursor.execute(
        """
        SELECT id, display_name, external_id, version, created_at, updated_at
        FROM public.ee_scim_group
        WHERE organisation_id = %s AND tenant_slug = %s
        ORDER BY created_at ASC, id ASC
        """,
        [organisation_id, tenant_slug],
    )
    group_rows = cursor.fetchall()
    members_by_group: dict[str, list[tuple[str, int]]] = {}
    if group_rows:
        cursor.execute(
            """
            SELECT group_id, scim_user_id, member_order
            FROM public.ee_scim_group_member
            WHERE organisation_id = %s
            ORDER BY group_id ASC, member_order ASC, scim_user_id ASC
            """,
            [organisation_id],
        )
        for gm_gid, gm_uid, gm_ord in cursor.fetchall():
            members_by_group.setdefault(str(gm_gid), []).append((str(gm_uid), int(gm_ord)))

    for g_row in group_rows:
        gid_str = str(g_row[0])
        ordered_pairs = members_by_group.get(gid_str, [])
        grp = ScimGroup(
            id=gid_str,
            tenant_slug=tenant_slug,
            display_name=str(g_row[1]),
            external_id=str(g_row[2]) if g_row[2] is not None else None,
            member_ids=[pair[0] for pair in ordered_pairs],
            version=int(g_row[3]),
            created_at=_coerce_utc(g_row[4]),
            updated_at=_coerce_utc(g_row[5]),
        )
        state.groups[gid_str] = grp
        state.initial_group_snapshots[gid_str] = (
            _group_header_snapshot_key(grp),
            dict(ordered_pairs),
        )

    cursor.execute(
        """
        SELECT scim_user_id, session_id
        FROM public.ee_scim_session
        WHERE organisation_id = %s AND tenant_slug = %s
        """,
        [organisation_id, tenant_slug],
    )
    for s_uid, sid in cursor.fetchall():
        s_uid_str = str(s_uid)
        sid_str = str(sid)
        state.sessions.setdefault(s_uid_str, set()).add(sid_str)
        state.initial_sessions.setdefault(s_uid_str, set()).add(sid_str)

    cursor.execute(
        """
        SELECT scim_user_id, user_id, user_name, reason, revoked_sessions_json, occurred_at
        FROM public.ee_scim_deprovision
        WHERE organisation_id = %s AND tenant_slug = %s
        ORDER BY occurred_at ASC, id ASC
        """,
        [organisation_id, tenant_slug],
    )
    for d_uid, d_person, uname, reason, rev_json, occ in cursor.fetchall():
        rev_list = json.loads(str(rev_json))
        rev_tuple = tuple(str(s) for s in rev_list) if isinstance(rev_list, list) else ()
        state.deprovision_log.append(
            DeprovisionRecord(
                tenant_slug=tenant_slug,
                user_id=str(d_uid),
                user_name=str(uname),
                reason=str(reason),
                revoked_sessions=rev_tuple,
                occurred_at=_coerce_utc(occ),
                django_user_id=str(d_person) if d_person is not None else None,
            )
        )
    return state


def _flush_postgres_tenant_state(cur: object, state: _TenantScimState) -> None:
    cursor = cast(Any, cur)
    org_id = state.organisation_id
    if org_id is None:
        raise ValueError("Missing organisation_id on PostgreSQL SCIM tenant state")
    tenant_slug = state.tenant_slug

    # 1. Remove revoked sessions before deleting any SCIM user rows (`ON DELETE RESTRICT`).
    for uid, old_sids in state.initial_sessions.items():
        cur_sids = state.sessions.get(uid, set())
        for rem_sid in sorted(old_sids - cur_sids):
            cursor.execute(
                """
                DELETE FROM public.ee_scim_session
                WHERE organisation_id = %s AND scim_user_id = %s AND session_id = %s
                """,
                [org_id, UUID(uid), rem_sid],
            )

    # 2. Remove group memberships for deleted groups and unlinked members before user/group deletes.
    deleted_group_ids = sorted(set(state.initial_group_snapshots) - set(state.groups))
    for del_gid in deleted_group_ids:
        cursor.execute(
            "DELETE FROM public.ee_scim_group_member WHERE organisation_id = %s AND group_id = %s",
            [org_id, UUID(del_gid)],
        )
        cursor.execute(
            "DELETE FROM public.ee_scim_group WHERE organisation_id = %s AND id = %s",
            [org_id, UUID(del_gid)],
        )

    for gid, grp in state.groups.items():
        old_grp_snap = state.initial_group_snapshots.get(gid)
        if old_grp_snap is not None:
            _, old_mid_orders = old_grp_snap
            removed_mids = sorted(set(old_mid_orders) - set(grp.member_ids))
            for rem_mid in removed_mids:
                cursor.execute(
                    "DELETE FROM public.ee_scim_group_member WHERE group_id = %s AND scim_user_id = %s",
                    [UUID(gid), UUID(rem_mid)],
                )

    # 3. Delete removed SCIM users.
    deleted_user_ids = sorted(set(state.initial_user_snapshots) - set(state.users))
    for del_uid in deleted_user_ids:
        cursor.execute(
            "DELETE FROM public.ee_scim_user WHERE organisation_id = %s AND id = %s",
            [org_id, UUID(del_uid)],
        )

    # 4. Insert new SCIM users and update modified SCIM users via narrow mutable columns.
    for uid, usr in state.users.items():
        person_uuid = UUID(usr.django_user_id) if usr.django_user_id is not None else None
        emails_json = _emails_to_json(usr.emails)
        roles_json = _roles_to_json(usr.roles)
        old_snap = state.initial_user_snapshots.get(uid)
        if old_snap is None:
            cursor.execute(
                """
                INSERT INTO public.ee_scim_user (
                    id, organisation_id, user_id, tenant_slug, user_name, user_name_lower,
                    external_id, display_name, given_name, family_name, emails_json, active,
                    roles_json, department, member_state, version, created_at, updated_at,
                    deprovisioned_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s,
                    %s
                )
                """,
                [
                    UUID(usr.id),
                    org_id,
                    person_uuid,
                    tenant_slug,
                    usr.user_name,
                    usr.user_name.lower(),
                    usr.external_id,
                    usr.display_name,
                    usr.given_name,
                    usr.family_name,
                    emails_json,
                    usr.active,
                    roles_json,
                    usr.department,
                    usr.member_state,
                    usr.version,
                    usr.created_at,
                    usr.updated_at,
                    usr.deprovisioned_at,
                ],
            )
        elif old_snap != _user_snapshot_key(usr):
            cursor.execute(
                """
                UPDATE public.ee_scim_user
                SET
                    user_id = %s,
                    user_name = %s,
                    user_name_lower = %s,
                    external_id = %s,
                    display_name = %s,
                    given_name = %s,
                    family_name = %s,
                    emails_json = %s,
                    active = %s,
                    roles_json = %s,
                    department = %s,
                    member_state = %s,
                    version = %s,
                    updated_at = %s,
                    deprovisioned_at = %s
                WHERE id = %s AND organisation_id = %s
                """,
                [
                    person_uuid,
                    usr.user_name,
                    usr.user_name.lower(),
                    usr.external_id,
                    usr.display_name,
                    usr.given_name,
                    usr.family_name,
                    emails_json,
                    usr.active,
                    roles_json,
                    usr.department,
                    usr.member_state,
                    usr.version,
                    usr.updated_at,
                    usr.deprovisioned_at,
                    UUID(usr.id),
                    org_id,
                ],
            )

    # 5. Insert/update SCIM groups and synchronize group membership rows.
    for gid, grp in state.groups.items():
        old_grp_snap = state.initial_group_snapshots.get(gid)
        if old_grp_snap is None:
            cursor.execute(
                """
                INSERT INTO public.ee_scim_group (
                    id, organisation_id, tenant_slug, display_name, display_name_lower,
                    external_id, version, created_at, updated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    UUID(grp.id),
                    org_id,
                    tenant_slug,
                    grp.display_name,
                    grp.display_name.lower(),
                    grp.external_id,
                    grp.version,
                    grp.created_at,
                    grp.updated_at,
                ],
            )
            for idx, m_uid in enumerate(grp.member_ids):
                cursor.execute(
                    """
                    INSERT INTO public.ee_scim_group_member (
                        organisation_id, group_id, scim_user_id, member_order
                    ) VALUES (%s, %s, %s, %s)
                    """,
                    [org_id, UUID(grp.id), UUID(m_uid), idx],
                )
        else:
            old_header_key, old_mid_orders = old_grp_snap
            if old_header_key != _group_header_snapshot_key(grp):
                cursor.execute(
                    """
                    UPDATE public.ee_scim_group
                    SET
                        display_name = %s,
                        display_name_lower = %s,
                        external_id = %s,
                        version = %s,
                        updated_at = %s
                    WHERE id = %s AND organisation_id = %s
                    """,
                    [
                        grp.display_name,
                        grp.display_name.lower(),
                        grp.external_id,
                        grp.version,
                        grp.updated_at,
                        UUID(grp.id),
                        org_id,
                    ],
                )
            for idx, m_uid in enumerate(grp.member_ids):
                if m_uid not in old_mid_orders:
                    cursor.execute(
                        """
                        INSERT INTO public.ee_scim_group_member (
                            organisation_id, group_id, scim_user_id, member_order
                        ) VALUES (%s, %s, %s, %s)
                        """,
                        [org_id, UUID(grp.id), UUID(m_uid), idx],
                    )
                elif old_mid_orders[m_uid] != idx:
                    cursor.execute(
                        """
                        UPDATE public.ee_scim_group_member
                        SET member_order = %s
                        WHERE group_id = %s AND scim_user_id = %s
                        """,
                        [idx, UUID(grp.id), UUID(m_uid)],
                    )

    # 6. Insert newly registered SCIM sessions.
    for uid, cur_sids in state.sessions.items():
        old_sids = state.initial_sessions.get(uid, set())
        bound_usr = state.users.get(uid)
        person_uuid = (
            UUID(bound_usr.django_user_id)
            if bound_usr is not None and bound_usr.django_user_id is not None
            else None
        )
        for added_sid in sorted(cur_sids - old_sids):
            cursor.execute(
                """
                INSERT INTO public.ee_scim_session (
                    organisation_id, scim_user_id, user_id, tenant_slug, session_id
                ) VALUES (%s, %s, %s, %s, %s)
                """,
                [org_id, UUID(uid), person_uuid, tenant_slug, added_sid],
            )

    # 7. Append immutable SCIM deprovision audit records (`INSERT` only).
    for evt in state.new_deprovision_events:
        evt_person_uuid = UUID(evt.django_user_id) if evt.django_user_id is not None else None
        cursor.execute(
            """
            INSERT INTO public.ee_scim_deprovision (
                id, organisation_id, scim_user_id, user_id, tenant_slug,
                user_name, reason, revoked_sessions_json, occurred_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                uuid7(),
                org_id,
                UUID(evt.user_id),
                evt_person_uuid,
                tenant_slug,
                evt.user_name,
                evt.reason,
                json.dumps(list(evt.revoked_sessions), separators=(",", ":")),
                evt.occurred_at,
            ],
        )


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


def _parse_role_filter_path(path: str) -> str | None:
    """Match `roles[value eq "<role>"]` in linear O(n) time without regex."""
    if len(path) > MAX_SCIM_PATH_LENGTH or not path.endswith("]"):
        return None
    prefix, sep, rest = path[:-1].partition("[")
    if not sep or prefix.lower() != "roles" or "]" in rest:
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


def _groups_for_user(state: _TenantScimState, user_id: str) -> list[tuple[str, str]]:
    return [
        (grp.id, grp.display_name)
        for _, grp in sorted(state.groups.items())
        if user_id in grp.member_ids
    ]


def _member_names(state: _TenantScimState) -> dict[str, str]:
    return {usr.id: (usr.display_name or usr.user_name) for usr in state.users.values()}


def _deprovision_user(
    state: _TenantScimState,
    user: ScimUser,
    *,
    reason: str,
    organisation_id: UUID | None,
    now: datetime,
    sync_core: bool = True,
) -> None:
    effective_org_id = organisation_id or state.organisation_id
    if (
        sync_core
        and effective_org_id is not None
        and user.django_user_id is not None
        and can_use_postgres()
    ):
        _sync_django_scim_deprovision(
            effective_org_id,
            UUID(user.django_user_id),
            remove_membership=(reason == "delete_user"),
        )
    revoked = tuple(sorted(state.sessions.pop(user.id, set())))
    user.active = False
    user.member_state = "deprovisioned"
    user.deprovisioned_at = now
    evt = DeprovisionRecord(
        tenant_slug=user.tenant_slug,
        user_id=user.id,
        user_name=user.user_name,
        reason=reason,
        revoked_sessions=revoked,
        occurred_at=now,
        django_user_id=user.django_user_id,
    )
    state.deprovision_log.append(evt)
    state.new_deprovision_events.append(evt)


def _extract_member_ids(state: _TenantScimState, raw_members: object) -> list[str]:
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
        if uid not in state.users:
            raise ScimError(
                f"Member user {uid!r} does not exist in tenant {state.tenant_slug!r}",
                status=400,
                scim_type="invalidValue",
            )
        if uid not in seen:
            seen.add(uid)
            member_ids.append(uid)
    return member_ids


class ScimService:
    """Tenant-isolated SCIM 2.0 User & Group directory service with PostgreSQL persistence."""

    def __init__(self, *, tokens: ScimTokenManager | None = None) -> None:
        self._lock = threading.Lock()
        self.tokens = tokens if tokens is not None else ScimTokenManager()
        self._mem_tenants: dict[str, _TenantScimState] = {}

    def reset(self) -> None:
        with self._lock:
            self._mem_tenants.clear()
        reset_ee_tables("scim")
        self.tokens.reset()

    @contextmanager
    def _tenant_scope(
        self,
        tenant_slug: str,
        *,
        write: bool = False,
        organisation_id: UUID | None = None,
    ) -> Iterator[_TenantScimState]:
        if can_use_postgres():
            if write:
                try:
                    with transaction.atomic(), connection.cursor() as cur:
                        candidate_org_id = _resolve_scim_org_id(
                            cur,
                            tenant_slug=tenant_slug,
                            organisation_id=organisation_id,
                        )
                        resolved_org_id, _ = acquire_active_tenant_fence(
                            cur,
                            tenant_slug=tenant_slug,
                            organisation_id=candidate_org_id,
                        )
                        cur.execute(
                            "SELECT pg_advisory_xact_lock(hashtext('kodera_ee_scim:' || %s))",
                            [str(resolved_org_id)],
                        )
                        state = _load_postgres_tenant_state(
                            cur,
                            organisation_id=resolved_org_id,
                            tenant_slug=tenant_slug,
                        )
                        yield state
                        _flush_postgres_tenant_state(cur, state)
                    return
                except TenantCutoffError as exc:
                    raise ScimError(
                        "Target tenant or account is under privacy erasure cutoff",
                        status=exc.status,
                        scim_type="mutability" if exc.code == "account_cutoff_fenced" else None,
                        code=exc.code,
                    ) from exc
                except IntegrityError as exc:
                    if "cutoff refuses write" in str(exc):
                        raise ScimError(
                            "Target tenant or account is under privacy erasure cutoff",
                            status=403,
                            code="tenant_cutoff_fenced",
                        ) from exc
                    raise
                except DatabaseError as exc:
                    if is_retriable_lock_contention(exc):
                        raise ScimError(
                            "Organisation authority changed concurrently; retry request",
                            status=409,
                            code="authority_fenced",
                        ) from exc
                    raise
                except Exception as exc:
                    from apps.orgs import member_set_hooks

                    member_set_hooks.after_rollback(exc)
                    raise

            with connection.cursor() as cur:
                resolved_org_id_ro = _resolve_scim_org_id(
                    cur,
                    tenant_slug=tenant_slug,
                    organisation_id=organisation_id,
                )
                if resolved_org_id_ro is None:
                    state = _TenantScimState(tenant_slug=tenant_slug)
                else:
                    cur.execute(
                        "SELECT state, deleted_at FROM public.orgs_organisation WHERE id = %s LIMIT 1",
                        [resolved_org_id_ro],
                    )
                    org_row = cur.fetchone()
                    if org_row is None:
                        state = _TenantScimState(tenant_slug=tenant_slug)
                    elif str(org_row[0]) == "closed" or org_row[1] is not None:
                        raise ScimError(
                            "Target tenant is closed or under privacy erasure cutoff",
                            status=403,
                            code="tenant_cutoff_fenced",
                        )
                    else:
                        state = _load_postgres_tenant_state(
                            cur,
                            organisation_id=resolved_org_id_ro,
                            tenant_slug=tenant_slug,
                        )
            yield state
            return

        with self._lock:
            mem_state = self._mem_tenants.get(tenant_slug)
            if mem_state is None:
                mem_state = _TenantScimState(
                    tenant_slug=tenant_slug,
                    organisation_id=organisation_id,
                )
                self._mem_tenants[tenant_slug] = mem_state
            mem_state.new_deprovision_events.clear()
            yield mem_state

    def register_session(
        self,
        tenant_slug: str,
        user_id: str,
        session_id: str,
        *,
        organisation_id: UUID | None = None,
    ) -> None:
        """Bind an active session identifier to a SCIM-managed user (revoked on deprovision)."""
        require_enterprise_edition()
        with self._tenant_scope(
            tenant_slug,
            write=True,
            organisation_id=organisation_id,
        ) as state:
            user = state.users.get(user_id)
            if user is None or not user.active:
                raise ScimError("Cannot create session for inactive or unknown user", status=403)
            state.sessions.setdefault(user_id, set()).add(session_id)

    def active_sessions(
        self,
        tenant_slug: str,
        user_id: str,
        *,
        organisation_id: UUID | None = None,
    ) -> frozenset[str]:
        require_enterprise_edition()
        with self._tenant_scope(
            tenant_slug,
            write=False,
            organisation_id=organisation_id,
        ) as state:
            return frozenset(state.sessions.get(user_id, set()))

    def deprovision_events(
        self,
        tenant_slug: str,
        *,
        organisation_id: UUID | None = None,
    ) -> list[DeprovisionRecord]:
        require_enterprise_edition()
        with self._tenant_scope(
            tenant_slug,
            write=False,
            organisation_id=organisation_id,
        ) as state:
            return list(state.deprovision_log)

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

        with self._tenant_scope(
            tenant_slug,
            write=True,
            organisation_id=organisation_id,
        ) as state:
            for existing in state.users.values():
                if existing.user_name.lower() == user_name.lower():
                    raise ScimError(
                        f"User with userName {user_name!r} already exists in tenant",
                        status=409,
                        scim_type="uniqueness",
                    )

            user_id = str(uuid4())
            effective_org_id = organisation_id or state.organisation_id
            mapped_role = _resolve_scim_membership_role(roles)
            django_uid: str | None = None
            if effective_org_id is not None and can_use_postgres():
                primary_email = _primary_email_value(emails, user_name)
                django_uid = _sync_django_scim_provision(
                    organisation_id=effective_org_id,
                    user_name=user_name,
                    external_id=external_id,
                    email=primary_email,
                    display_name=display_name,
                    active=active,
                    requested_role=mapped_role,
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
            state.users[user_id] = user
            if not active:
                _deprovision_user(
                    state,
                    user,
                    reason="created_inactive",
                    organisation_id=effective_org_id,
                    now=timestamp,
                    sync_core=False,
                )
            groups = _groups_for_user(state, user_id)
            return user.to_scim_dict(base_url, groups)

    def get_user(
        self,
        *,
        tenant_slug: str,
        user_id: str,
        base_url: str,
        organisation_id: UUID | None = None,
    ) -> dict[str, object]:
        require_enterprise_edition()
        with self._tenant_scope(
            tenant_slug,
            write=False,
            organisation_id=organisation_id,
        ) as state:
            user = state.users.get(user_id)
            if user is None:
                raise ScimError(f"User {user_id!r} not found", status=404)
            groups = _groups_for_user(state, user.id)
            return user.to_scim_dict(base_url, groups)

    def list_users(
        self,
        *,
        tenant_slug: str,
        base_url: str,
        filter_expr: str | None = None,
        start_index: int = 1,
        count: int = DEFAULT_PAGE_SIZE,
        organisation_id: UUID | None = None,
    ) -> dict[str, object]:
        require_enterprise_edition()
        clauses = _parse_filter_clauses(filter_expr) if filter_expr else []
        with self._tenant_scope(
            tenant_slug,
            write=False,
            organisation_id=organisation_id,
        ) as state:
            tenant_users = sorted(state.users.values(), key=lambda usr: (usr.created_at, usr.id))
            matched: list[dict[str, object]] = []
            for usr in tenant_users:
                if all(
                    _matches_single_clause(_user_attr_values(usr, attr), op, lit)
                    for attr, op, lit in clauses
                ):
                    groups = _groups_for_user(state, usr.id)
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

        with self._tenant_scope(
            tenant_slug,
            write=True,
            organisation_id=organisation_id,
        ) as state:
            user = state.users.get(user_id)
            if user is None:
                raise ScimError(f"User {user_id!r} not found", status=404)

            for uid, other in state.users.items():
                if uid != user_id and other.user_name.lower() == new_user_name.lower():
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
            mapped_role = _resolve_scim_membership_role(user.roles, default_when_empty="org_member")
            ent_ext = payload.get(SCIM_ENTERPRISE_USER_SCHEMA)
            if isinstance(ent_ext, dict) and isinstance(ent_ext.get("department"), str):
                user.department = ent_ext["department"].strip() or None
            else:
                user.department = None

            was_active = user.active
            user.active = new_active
            user.version += 1
            user.updated_at = timestamp
            effective_org_id = organisation_id or state.organisation_id
            primary_email = _primary_email_value(user.emails, user.user_name)
            if (
                effective_org_id is not None
                and user.django_user_id is not None
                and can_use_postgres()
            ):
                _verify_django_scim_person_usable(
                    effective_org_id,
                    UUID(user.django_user_id),
                    require_globally_enabled=new_active,
                )
            if not new_active:
                _deprovision_user(
                    state,
                    user,
                    reason="put_active_false",
                    organisation_id=effective_org_id,
                    now=timestamp,
                )
            else:
                if not was_active:
                    user.member_state = "active"
                    user.deprovisioned_at = None
                    if (
                        effective_org_id is not None
                        and user.django_user_id is not None
                        and can_use_postgres()
                    ):
                        _sync_django_scim_reactivate(
                            effective_org_id,
                            UUID(user.django_user_id),
                            requested_role=mapped_role,
                            email=primary_email,
                            display_name=user.display_name,
                        )
                elif (
                    effective_org_id is not None
                    and user.django_user_id is not None
                    and can_use_postgres()
                ):
                    _sync_django_scim_attributes_and_role(
                        organisation_id=effective_org_id,
                        user_uuid=UUID(user.django_user_id),
                        requested_role=mapped_role,
                        email=primary_email,
                        display_name=user.display_name,
                    )

            groups = _groups_for_user(state, user.id)
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
        with self._tenant_scope(
            tenant_slug,
            write=True,
            organisation_id=organisation_id,
        ) as state:
            user = state.users.get(user_id)
            if user is None:
                raise ScimError(f"User {user_id!r} not found", status=404)

            deprovision_triggered = False
            reactivate_triggered = False
            active_true_requested = False
            roles_touched = False

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
                        deprov, reactiv = self._apply_user_field_op(
                            state, user, op=op, path=k, value=v
                        )
                        deprovision_triggered = deprovision_triggered or deprov
                        reactivate_triggered = reactivate_triggered or reactiv
                        if k.lower() == "active" and user.active:
                            active_true_requested = True
                        if k.lower() == "roles":
                            roles_touched = True
                else:
                    deprov, reactiv = self._apply_user_field_op(
                        state, user, op=op, path=path, value=value
                    )
                    deprovision_triggered = deprovision_triggered or deprov
                    reactivate_triggered = reactivate_triggered or reactiv
                    if path.lower() == "active" and user.active:
                        active_true_requested = True
                    if path.lower() == "roles" or _parse_role_filter_path(path) is not None:
                        roles_touched = True

            user.version += 1
            user.updated_at = timestamp
            effective_org_id = organisation_id or state.organisation_id
            mapped_role = (
                _resolve_scim_membership_role(user.roles, default_when_empty="org_member")
                if roles_touched
                else None
            )
            reactivate_role = (
                mapped_role if roles_touched else _resolve_scim_membership_role(user.roles)
            )
            primary_email = _primary_email_value(user.emails, user.user_name)
            if deprovision_triggered and not user.active:
                _deprovision_user(
                    state,
                    user,
                    reason="patch_active_false",
                    organisation_id=effective_org_id,
                    now=timestamp,
                )
            elif (reactivate_triggered or active_true_requested) and user.active:
                user.member_state = "active"
                user.deprovisioned_at = None
                if (
                    effective_org_id is not None
                    and user.django_user_id is not None
                    and can_use_postgres()
                ):
                    _sync_django_scim_reactivate(
                        effective_org_id,
                        UUID(user.django_user_id),
                        requested_role=reactivate_role,
                        email=primary_email,
                        display_name=user.display_name,
                    )
            elif (
                effective_org_id is not None
                and user.django_user_id is not None
                and can_use_postgres()
            ):
                _verify_django_scim_person_usable(
                    effective_org_id,
                    UUID(user.django_user_id),
                    require_globally_enabled=user.active,
                )
                if user.active:
                    _sync_django_scim_attributes_and_role(
                        organisation_id=effective_org_id,
                        user_uuid=UUID(user.django_user_id),
                        requested_role=mapped_role,
                        email=primary_email,
                        display_name=user.display_name,
                    )

            groups = _groups_for_user(state, user.id)
            return user.to_scim_dict(base_url, groups)

    def _apply_user_field_op(
        self,
        state: _TenantScimState,
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
            for uid, other in state.users.items():
                if uid != user.id and other.user_name.lower() == candidate.lower():
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
            if op == "remove":
                if value is None:
                    user.roles = []
                else:
                    remove_vals = {r.lower() for r in _parse_roles(value)}
                    user.roles = [r for r in user.roles if r.lower() not in remove_vals]
            elif op == "add":
                existing_low = {r.lower() for r in user.roles}
                for parsed_r in _parse_roles(value):
                    if parsed_r.lower() not in existing_low:
                        user.roles.append(parsed_r)
                        existing_low.add(parsed_r.lower())
            else:
                user.roles = _parse_roles(value)
            return False, False

        role_filter_target = _parse_role_filter_path(path)
        if role_filter_target is not None and op == "remove":
            target_low = role_filter_target.strip().lower()
            user.roles = [r for r in user.roles if r.lower() != target_low]
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
        with self._tenant_scope(
            tenant_slug,
            write=True,
            organisation_id=organisation_id,
        ) as state:
            user = state.users.pop(user_id, None)
            if user is None:
                raise ScimError(f"User {user_id!r} not found", status=404)
            _deprovision_user(
                state,
                user,
                reason="delete_user",
                organisation_id=organisation_id or state.organisation_id,
                now=timestamp,
            )
            for grp in state.groups.values():
                if user_id in grp.member_ids:
                    grp.member_ids = [uid for uid in grp.member_ids if uid != user_id]
                    grp.version += 1
                    grp.updated_at = timestamp

    # ------------------------------------------------------------------ Groups

    def create_group(
        self,
        *,
        tenant_slug: str,
        payload: Mapping[str, object],
        base_url: str,
        organisation_id: UUID | None = None,
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

        with self._tenant_scope(
            tenant_slug,
            write=True,
            organisation_id=organisation_id,
        ) as state:
            for existing in state.groups.values():
                if existing.display_name.lower() == display_name.lower():
                    raise ScimError(
                        f"Group {display_name!r} already exists in tenant",
                        status=409,
                        scim_type="uniqueness",
                    )
            member_ids = _extract_member_ids(state, payload.get("members"))
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
            state.groups[group_id] = group
            return group.to_scim_dict(base_url, _member_names(state))

    def get_group(
        self,
        *,
        tenant_slug: str,
        group_id: str,
        base_url: str,
        organisation_id: UUID | None = None,
    ) -> dict[str, object]:
        require_enterprise_edition()
        with self._tenant_scope(
            tenant_slug,
            write=False,
            organisation_id=organisation_id,
        ) as state:
            group = state.groups.get(group_id)
            if group is None:
                raise ScimError(f"Group {group_id!r} not found", status=404)
            return group.to_scim_dict(base_url, _member_names(state))

    def list_groups(
        self,
        *,
        tenant_slug: str,
        base_url: str,
        filter_expr: str | None = None,
        start_index: int = 1,
        count: int = DEFAULT_PAGE_SIZE,
        organisation_id: UUID | None = None,
    ) -> dict[str, object]:
        require_enterprise_edition()
        clauses = _parse_filter_clauses(filter_expr) if filter_expr else []
        with self._tenant_scope(
            tenant_slug,
            write=False,
            organisation_id=organisation_id,
        ) as state:
            names = _member_names(state)
            tenant_groups = sorted(state.groups.values(), key=lambda grp: (grp.created_at, grp.id))
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
        organisation_id: UUID | None = None,
        now: datetime | None = None,
    ) -> dict[str, object]:
        require_enterprise_edition()
        display_raw = payload.get("displayName")
        if not isinstance(display_raw, str) or not display_raw.strip():
            raise ScimError("Group displayName is required", status=400, scim_type="invalidValue")
        new_display = display_raw.strip()
        timestamp = (now or datetime.now(UTC)).astimezone(UTC)

        with self._tenant_scope(
            tenant_slug,
            write=True,
            organisation_id=organisation_id,
        ) as state:
            group = state.groups.get(group_id)
            if group is None:
                raise ScimError(f"Group {group_id!r} not found", status=404)
            for gid, other in state.groups.items():
                if gid != group_id and other.display_name.lower() == new_display.lower():
                    raise ScimError(
                        "Duplicate group displayName in tenant", status=409, scim_type="uniqueness"
                    )
            ext_raw = payload.get("externalId")
            group.display_name = new_display
            group.external_id = (
                ext_raw.strip() if isinstance(ext_raw, str) and ext_raw.strip() else None
            )
            group.member_ids = _extract_member_ids(state, payload.get("members"))
            group.version += 1
            group.updated_at = timestamp
            return group.to_scim_dict(base_url, _member_names(state))

    def patch_group(
        self,
        *,
        tenant_slug: str,
        group_id: str,
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
        with self._tenant_scope(
            tenant_slug,
            write=True,
            organisation_id=organisation_id,
        ) as state:
            group = state.groups.get(group_id)
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
                        self._set_group_display_name(state, group, value["displayName"])
                    if "members" in value:
                        self._apply_group_members_op(state, group, op=op, value=value["members"])
                    continue

                if path.lower() == "displayname":
                    if op == "remove":
                        raise ScimError(
                            "Group displayName cannot be removed",
                            status=400,
                            scim_type="mutability",
                        )
                    self._set_group_display_name(state, group, value)
                    continue

                if path.lower() == "members":
                    self._apply_group_members_op(state, group, op=op, value=value)
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
            return group.to_scim_dict(base_url, _member_names(state))

    def _set_group_display_name(
        self,
        state: _TenantScimState,
        group: ScimGroup,
        raw_name: object,
    ) -> None:
        if not isinstance(raw_name, str) or not raw_name.strip():
            raise ScimError(
                "displayName requires a non-empty string", status=400, scim_type="invalidValue"
            )
        candidate = raw_name.strip()
        for gid, other in state.groups.items():
            if gid != group.id and other.display_name.lower() == candidate.lower():
                raise ScimError(
                    "Duplicate group displayName in tenant", status=409, scim_type="uniqueness"
                )
        group.display_name = candidate

    def _apply_group_members_op(
        self,
        state: _TenantScimState,
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

        new_ids = _extract_member_ids(state, value)
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
        organisation_id: UUID | None = None,
    ) -> None:
        require_enterprise_edition()
        with self._tenant_scope(
            tenant_slug,
            write=True,
            organisation_id=organisation_id,
        ) as state:
            removed = state.groups.pop(group_id, None)
            if removed is None:
                raise ScimError(f"Group {group_id!r} not found", status=404)


def _primary_email_value(emails: list[ScimEmail], fallback: str) -> str:
    for em in emails:
        if em.primary and em.value.strip():
            return em.value.strip()
    for em in emails:
        if em.value.strip():
            return em.value.strip()
    return fallback


def _try_parse_uuid_str(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return str(UUID(value.strip()))
    except ValueError:
        return None


def _resolve_scim_membership_role(
    roles: list[str],
    *,
    default_when_empty: str | None = None,
) -> str | None:
    """Map SCIM `roles` onto Kodera `org_member` / `org_admin`; forbid `org_owner` / `org_billing`."""
    if not roles:
        return default_when_empty
    has_admin = False
    for raw in roles:
        norm = raw.strip().lower()
        if norm in {"org_owner", "owner", "org_billing", "billing", "billing_admin"}:
            raise ScimError(
                "SCIM cannot grant org_owner or org_billing roles",
                status=403,
                scim_type="mutability",
                code="forbidden",
            )
        if norm in {"org_admin", "admin"}:
            has_admin = True
    return "org_admin" if has_admin else "org_member"


def _maybe_sync_user_contact_columns(
    cur: Any,
    *,
    user_uuid: UUID,
    organisation_id: UUID | None = None,
    email: str | None,
    display_name: str | None,
) -> None:
    """Synchronize `identity_identity` / `identity_user` contact columns via narrow SECURITY DEFINER."""
    if organisation_id is None:
        return
    cur.execute(
        "SELECT public.ee_scim_sync_member_contact(%s, %s, %s, %s)",
        [
            organisation_id,
            user_uuid,
            email.strip() if email else None,
            display_name[:200] if display_name is not None else None,
        ],
    )


def _lock_and_verify_scim_person(
    cur: Any,
    *,
    organisation_id: UUID,
    user_uuid: UUID,
    require_globally_enabled: bool,
) -> None:
    """Lock global `identity_user` (`FOR SHARE NOWAIT`) and verify cutoff/global-disable invariants.

    Uses non-blocking `pg_try_advisory_xact_lock_shared` (`BUG-0062`) so SCIM writes holding
    `orgs_organisation` never deadlock against `privacy_begin_account_erasure` (`User -> Organisation`).
    """
    cur.execute(
        "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:' || %s, 0))",
        [str(user_uuid)],
    )
    lock_row = cur.fetchone()
    if not lock_row or not bool(lock_row[0]):
        raise ScimError(
            "Organisation authority changed concurrently; retry request",
            status=409,
            code="authority_fenced",
        )
    cur.execute(
        """
        SELECT u.email, u.enabled, u.deleted_at
        FROM public.identity_user u
        WHERE u.id = %s
        FOR SHARE OF u NOWAIT
        """,
        [user_uuid],
    )
    u_row = cur.fetchone()
    if u_row is None or u_row[2] is not None or str(u_row[0]).startswith("erased:"):
        raise TenantCutoffError("account_cutoff_fenced", status=403)
    if require_globally_enabled and not bool(u_row[1]):
        raise ScimError(
            "Target user account is globally disabled",
            status=403,
            scim_type="mutability",
            code="user_globally_disabled",
        )

    cur.execute(
        """
        SELECT i.email, i.enabled, i.deleted_at
        FROM public.identity_identity i
        WHERE i.organisation_id = %s AND i.user_id = %s
        ORDER BY i.created_at ASC, i.id ASC
        """,
        [organisation_id, user_uuid],
    )
    ident_rows = cur.fetchall()
    if ident_rows:
        for i_email, _i_enabled, i_deleted in ident_rows:
            if str(i_email).startswith("erased:") or i_deleted is not None:
                raise TenantCutoffError("account_cutoff_fenced", status=403)
        if require_globally_enabled and not any(bool(r[1]) and r[2] is None for r in ident_rows):
            raise ScimError(
                "Target tenant identity is disabled",
                status=403,
                scim_type="mutability",
                code="user_globally_disabled",
            )


def _verify_django_scim_person_usable(
    organisation_id: UUID,
    user_uuid: UUID,
    *,
    require_globally_enabled: bool,
) -> None:
    try:
        with transaction.atomic(), connection.cursor() as cur:
            _lock_and_verify_scim_person(
                cur,
                organisation_id=organisation_id,
                user_uuid=user_uuid,
                require_globally_enabled=require_globally_enabled,
            )
    except DatabaseError as exc:
        if is_retriable_lock_contention(exc):
            raise ScimError(
                "Organisation authority changed concurrently; retry request",
                status=409,
                code="authority_fenced",
            ) from exc
        raise


def _sync_django_scim_provision(
    *,
    organisation_id: UUID,
    user_name: str,
    external_id: str | None = None,
    email: str,
    display_name: str,
    active: bool,
    requested_role: str | None = None,
) -> str:
    from apps.audit.models import AuditEvent
    from apps.audit.services import record_membership_event
    from apps.identity.models import Identity, User
    from apps.orgs import member_set_hooks
    from apps.orgs.models import Membership, Organisation
    from apps.outbox.realm_enqueue import ACCESS_OFF, ACCESS_ON, enqueue_realm_access
    from django.utils import timezone

    try:
        with transaction.atomic():
            org = (
                Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True)
                .exclude(state="closed")
                .first()
            )
            if org is None:
                raise TenantCutoffError("tenant_cutoff_fenced", status=403)

            ext_uuid_str = _try_parse_uuid_str(external_id)
            uname_uuid_str = _try_parse_uuid_str(user_name)
            legacy_subj = "".join(ch if "!" <= ch <= "~" else "_" for ch in user_name.lower())[:255]
            candidate_subjects = [
                s for s in (ext_uuid_str, uname_uuid_str, legacy_subj) if s is not None
            ]

            identity = (
                Identity.objects.select_related("user")
                .filter(organisation=org, issuer=org.issuer, subject__in=candidate_subjects)
                .order_by("created_at", "id")
                .first()
            )
            if identity is None and email.strip():
                identity = (
                    Identity.objects.select_related("user")
                    .filter(organisation=org, issuer=org.issuer, email__iexact=email.strip())
                    .order_by("created_at", "id")
                    .first()
                )
            if identity is None:
                with connection.cursor() as cur:
                    cur.execute(
                        """
                        SELECT user_id
                        FROM public.ee_scim_deprovision
                        WHERE organisation_id = %s
                          AND user_id IS NOT NULL
                          AND (lower(user_name) = lower(%s) OR lower(user_name) = lower(%s))
                        ORDER BY occurred_at DESC
                        LIMIT 1
                        """,
                        [org.id, user_name.strip(), email.strip()],
                    )
                    deprov_row = cur.fetchone()
                if deprov_row is not None and deprov_row[0] is not None:
                    identity = (
                        Identity.objects.select_related("user")
                        .filter(organisation=org, issuer=org.issuer, user_id=deprov_row[0])
                        .order_by("created_at", "id")
                        .first()
                    )

            if identity is not None:
                with connection.cursor() as cur:
                    _lock_and_verify_scim_person(
                        cur,
                        organisation_id=org.id,
                        user_uuid=identity.user_id,
                        require_globally_enabled=True,
                    )
                user = identity.user
            else:
                # Never link or reuse a global `User` across tenants by contact `email` or
                # `userName` (`CUSTOMER_PERSISTENCE.md:29` / `ADR-0024` / `owner_binding.py`).
                # Always mint a canonical lowercase KC-02 UUID subject (`BUG-0063`).
                minted_subject = ext_uuid_str or uname_uuid_str or str(uuid7())
                user = User.objects.create(
                    email=email,
                    display_name=display_name[:200] if display_name else None,
                    enabled=True,
                )
                identity = Identity.objects.create(
                    user=user,
                    organisation=org,
                    realm=org.realm,
                    issuer=org.issuer,
                    subject=minted_subject,
                    email=email,
                    enabled=True,
                )

            now_ts = timezone.now()
            req_id = f"scim-{uuid7()}"
            target_state = Membership.State.ACTIVE if active else Membership.State.SUSPENDED
            desired_role = requested_role or Membership.Role.MEMBER
            membership = (
                Membership.objects.select_for_update(nowait=True)
                .filter(organisation=org, user=user)
                .first()
            )
            if membership is None:
                created_membership = Membership.objects.create(
                    organisation=org,
                    user=user,
                    role=desired_role,
                    state=target_state,
                    accepted_at=now_ts,
                )
                AuditEvent.objects.create(
                    action="membership.created",
                    actor_type="tenant",
                    actor_id=identity.id,
                    actor_label=f"urn:kodera:identity:{identity.id}",
                    organisation_id=org.id,
                    target_urn=f"urn:kodera:membership:{created_membership.id}",
                    request_id=req_id,
                    retention_class="standard",
                    before=None,
                    after={"role": desired_role, "state": target_state},
                    metadata={"source": "scim"},
                )
                enqueue_realm_access(
                    organisation_id=org.id,
                    membership_id=created_membership.id,
                    user_id=user.id,
                    operation=ACCESS_ON if active else ACCESS_OFF,
                )
                if active:
                    member_set_hooks.member_set_changed(
                        organisation_id=org.id,
                        reason="scim_provisioned",
                    )
            else:
                if membership.deleted_at is not None:
                    raise TenantCutoffError("tenant_cutoff_fenced", status=403)
                if membership.role == Membership.Role.OWNER and not active:
                    raise ScimError(
                        "Organisation owner cannot be deactivated or deleted via SCIM",
                        status=403,
                        scim_type="mutability",
                        code="owner_deprovision_forbidden",
                    )
                prev_state = membership.state
                prev_role = membership.role
                # Never revive `REMOVED` `org_admin` onto `org_admin` automatically (`BUG-0063`).
                if prev_state == Membership.State.REMOVED:
                    effective_role = (
                        prev_role
                        if prev_role in {Membership.Role.OWNER, Membership.Role.BILLING}
                        else Membership.Role.MEMBER
                    )
                elif prev_role in {Membership.Role.OWNER, Membership.Role.BILLING}:
                    effective_role = prev_role
                elif requested_role is not None:
                    effective_role = requested_role
                else:
                    effective_role = prev_role

                role_changed = prev_role != effective_role
                state_changed = prev_state != target_state
                if state_changed or role_changed or membership.accepted_at is None:
                    Membership.objects.filter(id=membership.id, organisation_id=org.id).update(
                        role=effective_role,
                        state=target_state,
                        accepted_at=membership.accepted_at or now_ts,
                        updated_at=now_ts,
                    )
                    if role_changed:
                        record_membership_event(
                            action="membership.role_changed",
                            organisation_id=org.id,
                            membership_id=membership.id,
                            actor_id=identity.id,
                            request_id=req_id,
                            before={"role": prev_role},
                            after={"role": effective_role},
                        )
                    if state_changed:
                        enqueue_realm_access(
                            organisation_id=org.id,
                            membership_id=membership.id,
                            user_id=user.id,
                            operation=ACCESS_ON if active else ACCESS_OFF,
                        )
                        if not active and prev_state == Membership.State.ACTIVE:
                            refreshed_m = Membership.objects.get(id=membership.id)
                            member_set_hooks.member_left(
                                refreshed_m, reason=member_set_hooks.MEMBER_SUSPENDED
                            )
                        elif active:
                            member_set_hooks.member_set_changed(
                                organisation_id=org.id,
                                reason=member_set_hooks.MEMBER_REACTIVATED,
                            )
                    elif role_changed and active:
                        member_set_hooks.channel_set_changed(
                            organisation_id=org.id,
                            reason=member_set_hooks.CHANNEL_SET_REASON,
                        )
            return str(user.id)
    except DatabaseError as exc:
        if is_retriable_lock_contention(exc):
            raise ScimError(
                "Organisation authority changed concurrently; retry request",
                status=409,
                code="authority_fenced",
            ) from exc
        raise


def _sync_django_scim_deprovision(
    organisation_id: UUID,
    user_uuid: UUID,
    *,
    remove_membership: bool = False,
) -> None:
    from apps.orgs import member_set_hooks
    from apps.orgs.models import Membership
    from apps.outbox.realm_enqueue import ACCESS_OFF, enqueue_realm_access
    from django.utils import timezone

    try:
        with transaction.atomic():
            with connection.cursor() as cur:
                _lock_and_verify_scim_person(
                    cur,
                    organisation_id=organisation_id,
                    user_uuid=user_uuid,
                    require_globally_enabled=False,
                )
            memberships = list(
                Membership.objects.select_for_update(nowait=True)
                .filter(
                    organisation_id=organisation_id,
                    user_id=user_uuid,
                    deleted_at__isnull=True,
                )
                .order_by("id")
            )
            for m in memberships:
                if m.role == Membership.Role.OWNER and m.state != Membership.State.REMOVED:
                    raise ScimError(
                        "Organisation owner cannot be deactivated or deleted via SCIM",
                        status=403,
                        scim_type="mutability",
                        code="owner_deprovision_forbidden",
                    )

            target_state = (
                Membership.State.REMOVED if remove_membership else Membership.State.SUSPENDED
            )
            now_ts = timezone.now()
            for m in memberships:
                prev_state = m.state
                if prev_state != target_state:
                    Membership.objects.filter(id=m.id, organisation_id=organisation_id).update(
                        state=target_state,
                        updated_at=now_ts,
                    )
                    enqueue_realm_access(
                        organisation_id=organisation_id,
                        membership_id=m.id,
                        user_id=user_uuid,
                        operation=ACCESS_OFF,
                    )
                    if prev_state == Membership.State.ACTIVE:
                        refreshed_m = Membership.objects.get(id=m.id)
                        member_set_hooks.member_left(
                            refreshed_m,
                            reason=(
                                member_set_hooks.MEMBER_REMOVED
                                if remove_membership
                                else member_set_hooks.MEMBER_SUSPENDED
                            ),
                        )
    except DatabaseError as exc:
        if is_retriable_lock_contention(exc):
            raise ScimError(
                "Organisation authority changed concurrently; retry request",
                status=409,
                code="authority_fenced",
            ) from exc
        raise


def _sync_django_scim_attributes_and_role(
    *,
    organisation_id: UUID,
    user_uuid: UUID,
    requested_role: str | None = None,
    email: str | None = None,
    display_name: str | None = None,
) -> None:
    """Sync SCIM `PUT`/`PATCH` attribute & role mutations onto Core `Membership` + engine hooks."""
    from apps.audit.services import record_membership_event
    from apps.identity.models import Identity
    from apps.orgs import member_set_hooks
    from apps.orgs.models import Membership
    from django.utils import timezone

    try:
        with transaction.atomic():
            with connection.cursor() as cur:
                _lock_and_verify_scim_person(
                    cur,
                    organisation_id=organisation_id,
                    user_uuid=user_uuid,
                    require_globally_enabled=True,
                )
                _maybe_sync_user_contact_columns(
                    cur,
                    user_uuid=user_uuid,
                    organisation_id=organisation_id,
                    email=email,
                    display_name=display_name,
                )

            if requested_role is None:
                return

            identity = (
                Identity.objects.filter(
                    organisation_id=organisation_id,
                    user_id=user_uuid,
                    deleted_at__isnull=True,
                )
                .order_by("created_at", "id")
                .first()
            )
            memberships = list(
                Membership.objects.select_for_update(nowait=True)
                .filter(
                    organisation_id=organisation_id,
                    user_id=user_uuid,
                    deleted_at__isnull=True,
                )
                .order_by("id")
            )
            now_ts = timezone.now()
            req_id = f"scim-{uuid7()}"
            role_changed_any = False
            for m in memberships:
                if m.state != Membership.State.ACTIVE:
                    continue
                if m.role in {Membership.Role.OWNER, Membership.Role.BILLING}:
                    continue
                if m.role != requested_role:
                    old_role = m.role
                    Membership.objects.filter(id=m.id, organisation_id=organisation_id).update(
                        role=requested_role,
                        updated_at=now_ts,
                    )
                    if identity is not None:
                        record_membership_event(
                            action="membership.role_changed",
                            organisation_id=organisation_id,
                            membership_id=m.id,
                            actor_id=identity.id,
                            request_id=req_id,
                            before={"role": old_role},
                            after={"role": requested_role},
                        )
                    role_changed_any = True
            if role_changed_any:
                member_set_hooks.channel_set_changed(
                    organisation_id=organisation_id,
                    reason=member_set_hooks.CHANNEL_SET_REASON,
                )
    except DatabaseError as exc:
        if is_retriable_lock_contention(exc):
            raise ScimError(
                "Organisation authority changed concurrently; retry request",
                status=409,
                code="authority_fenced",
            ) from exc
        raise


def _sync_django_scim_reactivate(
    organisation_id: UUID,
    user_uuid: UUID,
    *,
    requested_role: str | None = None,
    email: str | None = None,
    display_name: str | None = None,
) -> None:
    from apps.audit.services import record_membership_event
    from apps.identity.models import Identity
    from apps.orgs import member_set_hooks
    from apps.orgs.models import Membership
    from apps.outbox.realm_enqueue import ACCESS_ON, enqueue_realm_access
    from django.utils import timezone

    try:
        with transaction.atomic():
            with connection.cursor() as cur:
                _lock_and_verify_scim_person(
                    cur,
                    organisation_id=organisation_id,
                    user_uuid=user_uuid,
                    require_globally_enabled=True,
                )
                _maybe_sync_user_contact_columns(
                    cur,
                    user_uuid=user_uuid,
                    organisation_id=organisation_id,
                    email=email,
                    display_name=display_name,
                )
            identity = (
                Identity.objects.filter(
                    organisation_id=organisation_id,
                    user_id=user_uuid,
                    deleted_at__isnull=True,
                )
                .order_by("created_at", "id")
                .first()
            )
            memberships = list(
                Membership.objects.select_for_update(nowait=True)
                .filter(
                    organisation_id=organisation_id,
                    user_id=user_uuid,
                    deleted_at__isnull=True,
                )
                .order_by("id")
            )
            now_ts = timezone.now()
            req_id = f"scim-{uuid7()}"
            reactivated_any = False
            role_changed_any = False
            for m in memberships:
                prev_state = m.state
                prev_role = m.role
                was_non_active = prev_state != Membership.State.ACTIVE
                if prev_state == Membership.State.REMOVED:
                    effective_role = (
                        prev_role
                        if prev_role in {Membership.Role.OWNER, Membership.Role.BILLING}
                        else Membership.Role.MEMBER
                    )
                elif prev_role in {Membership.Role.OWNER, Membership.Role.BILLING}:
                    effective_role = prev_role
                elif requested_role is not None:
                    effective_role = requested_role
                else:
                    effective_role = prev_role

                role_changed = prev_role != effective_role
                if was_non_active or role_changed or m.accepted_at is None:
                    Membership.objects.filter(id=m.id, organisation_id=organisation_id).update(
                        role=effective_role,
                        state=Membership.State.ACTIVE,
                        accepted_at=m.accepted_at or now_ts,
                        updated_at=now_ts,
                    )
                    if role_changed and identity is not None:
                        record_membership_event(
                            action="membership.role_changed",
                            organisation_id=organisation_id,
                            membership_id=m.id,
                            actor_id=identity.id,
                            request_id=req_id,
                            before={"role": prev_role},
                            after={"role": effective_role},
                        )
                    if role_changed:
                        role_changed_any = True
                    if was_non_active:
                        enqueue_realm_access(
                            organisation_id=organisation_id,
                            membership_id=m.id,
                            user_id=user_uuid,
                            operation=ACCESS_ON,
                        )
                        reactivated_any = True
            if reactivated_any:
                member_set_hooks.member_set_changed(
                    organisation_id=organisation_id,
                    reason=member_set_hooks.MEMBER_REACTIVATED,
                )
            elif role_changed_any:
                member_set_hooks.channel_set_changed(
                    organisation_id=organisation_id,
                    reason=member_set_hooks.CHANNEL_SET_REASON,
                )
    except DatabaseError as exc:
        if is_retriable_lock_contention(exc):
            raise ScimError(
                "Organisation authority changed concurrently; retry request",
                status=409,
                code="authority_fenced",
            ) from exc
        raise


default_scim_service = ScimService()
