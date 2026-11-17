"""Pure policy checks for public billing catalogue grants and staff community MFA projection."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID

import pytest

from apps.identity import services
from apps.identity.api.serializers import serialize_customer
from apps.identity.selectors import PersonSnapshot
from apps.orgs.selectors import MembershipSnapshot, OrganisationSnapshot
from core.db import api_writer_role
from services.identity.access_tokens import VerifiedAccessToken

NOW = datetime(2033, 5, 18, 3, 33, 20, tzinfo=UTC)
CATALOGUE_TABLES = ("billing_plan", "billing_pack", "billing_capacitytier", "billing_price")


def test_api_writer_role_grants_read_only_select_on_all_four_catalogue_tables() -> None:
    for table in CATALOGUE_TABLES:
        assert table in api_writer_role.SELECT
        assert table not in api_writer_role.INSERT
        assert table not in api_writer_role.DELETE
    assert not any(table in CATALOGUE_TABLES for table, _ in api_writer_role.SELECT_COLUMNS)
    assert not any(table in CATALOGUE_TABLES for table, _ in api_writer_role.UPDATE_COLUMNS)

    statements = api_writer_role.grant_statements("kodera_api")
    for table in CATALOGUE_TABLES:
        assert f'GRANT SELECT ON TABLE "{table}" TO "kodera_api"' in statements
        assert not any(
            stmt.startswith(("GRANT INSERT", "GRANT UPDATE", "GRANT DELETE"))
            and f'"{table}"' in stmt
            for stmt in statements
        )


@pytest.mark.parametrize(
    ("amr", "offset_s", "expected_mfa"),
    [
        (("pwd", "hwk"), 0, True),
        (("pwd", "otp"), 0, True),
        (("pwd",), 0, None),
        (None, 0, None),
        (("pwd", "hwk"), 290, None),
    ],
)
def test_read_staff_community_projects_mfa_enrolled_only_for_valid_staff_factor(
    monkeypatch: pytest.MonkeyPatch,
    amr: tuple[str, ...] | None,
    offset_s: int,
    expected_mfa: bool | None,
) -> None:
    import apps.orgs.community as community_mod

    user_id = UUID("01900000-0000-7000-8000-000000000001")
    identity_id = UUID("01900000-0000-7000-8000-000000000002")
    org_id = UUID("01900000-0000-7000-8000-000000000003")
    membership_id = UUID("01900000-0000-7000-8000-000000000004")
    staff_issuer = "https://identity.staff.test/realms/kodera-staff"

    person = PersonSnapshot(user_id, "owner@synthetic.test", "Owner")
    principal = SimpleNamespace(
        id=identity_id,
        user_id=user_id,
        user=person,
        issuer=staff_issuer,
        realm="kodera-staff",
        subject="staff-owner",
        email="owner@synthetic.test",
    )
    member = SimpleNamespace(organisation_id=org_id)
    membership = MembershipSnapshot(
        membership_id,
        OrganisationSnapshot(org_id, "community", "Kodera Community", "community"),
        "org_owner",
        "active",
        NOW,
    )

    monkeypatch.setattr(community_mod, "configured_slug", lambda: "community")
    monkeypatch.setattr(community_mod, "ensure_community_membership", lambda **_: member)
    monkeypatch.setattr(community_mod, "community_member", lambda **_: (principal, member))
    monkeypatch.setattr(services, "person_memberships", lambda **_: (membership,))
    monkeypatch.setattr(services, "database_now", lambda: NOW + timedelta(seconds=offset_s))

    verified = VerifiedAccessToken(
        issuer=staff_issuer,
        subject="staff-owner",
        audience=("kodera-server",),
        issued_at=int(NOW.timestamp()),
        expires_at=int(NOW.timestamp()) + 300,
        not_before=None,
        amr=amr,
        acr=None,
        auth_time=int(NOW.timestamp()),
    )
    result = services.read_staff_community(verified=verified)
    assert result.mfa_enrolled is expected_mfa

    payload = json.loads(serialize_customer(result))
    assert payload["organisations"][0]["identity_id"] == str(identity_id)
    if expected_mfa is True:
        assert payload["identities"][0]["mfa_enrolled"] is True
    else:
        assert "mfa_enrolled" not in payload["identities"][0]


def test_privacy_lifecycle_grants_are_select_only() -> None:
    tables = ("orgs_privacyexport", "orgs_privacyerasure", "orgs_accounterasure")
    for table in tables:
        assert table in api_writer_role.SELECT
        assert table not in api_writer_role.INSERT
        assert table not in api_writer_role.DELETE
        assert not any(name == table for name, _ in api_writer_role.UPDATE_COLUMNS)
    assert not any("privacy" in signature for signature in api_writer_role.EXECUTE_FUNCTIONS)
