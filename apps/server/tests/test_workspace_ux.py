"""Credential-free profile validation, conditional writes and canonical arrivals precedence."""

import base64
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import pytest

from apps.workspaces.channel_order import is_arrivals
from apps.workspaces.logo import MAX_LOGO_BYTES, validate_logo

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def raster(raw=PNG, mime="image/png"):
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


@pytest.mark.parametrize("name", ["arrivals", "#arrivals", "arrivees", "#arrivées", " ARRIVÉES "])
def test_arrivals_aliases(name):
    assert is_arrivals(name)
    assert is_arrivals("Welcome", "arrivals")
    assert not is_arrivals("general")


def test_logo_magic_mime_bounds_and_clear():
    assert validate_logo(raster()) == raster()
    assert validate_logo("") == ""
    for value in [
        None,
        [],
        "https://remote.test/logo.png",
        raster(mime="image/jpeg"),
        raster(b"<svg></svg>"),
        raster(PNG + b"x" * MAX_LOGO_BYTES),
        "data:image/png;base64,@@@@",
    ]:
        with pytest.raises(ValueError):
            validate_logo(value)
    assert validate_logo(raster(b"\xff\xd8\xff" + b"x" * 10 + b"\xff\xd9", "image/jpeg"))
    webp = b"RIFF" + (16).to_bytes(4, "little") + b"WEBPVP8 " + b"x" * 8
    assert validate_logo(raster(webp, "image/webp"))


def workspace():
    return SimpleNamespace(
        id=UUID(int=1),
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
        save=Mock(),
        display_name="",
        logo_url="",
        default_ui_mode="pro",
        default_channel_id=None,
        allow_member_channel_creation=False,
        allow_member_invites=True,
        allow_link_previews=True,
        description="",
        banner_preset="",
        icon_mxc="",
        traits=[],
        invites_paused=False,
        arrivals_channel_id=None,
        rules_channel_id=None,
        moderator_updates_channel_id=None,
        security_alerts_channel_id=None,
    )


def test_profile_trim_logo_replace_remove_preferences_and_stale_write(monkeypatch):
    from apps.workspaces import governance as service
    from apps.workspaces.moderation import RefusalError

    row = workspace()
    caller = SimpleNamespace(identity_id=UUID(int=2))
    monkeypatch.setattr(service, "mutation_context", lambda *a, **k: (row, caller))
    monkeypatch.setattr(service, "_audit", Mock())
    arguments = {"verified": None, "organisation_id": UUID(int=3)}
    # Call the domain implementation without opening a database transaction.
    patch = service.profile_with_etag.__wrapped__
    before = service.profile_etag(row)
    body, after = patch(
        **arguments,
        if_match=before,
        data={
            "display_name": "  Workshop  ",
            "logo_url": raster(),
            "default_ui_mode": "messages",
            "allow_link_previews": False,
        },
    )
    assert body["display_name"] == "Workshop"
    assert body["logo_url"] == raster()
    assert body["default_ui_mode"] == "messages" and not body["allow_link_previews"]
    assert before != after
    with pytest.raises(RefusalError) as stale:
        patch(**arguments, if_match=before, data={"display_name": "Overwritten"})
    assert stale.value.status == 412
    patch(**arguments, if_match=after, data={"logo_url": ""})
    assert row.logo_url == ""
    cleared, _ = patch(**arguments, if_match=service.profile_etag(row), data={"display_name": ""})
    assert cleared["display_name"] == "" and row.display_name == ""


def test_api_writer_role_grants_update_on_all_workspace_ux_columns():
    from core.db.api_writer_role import UPDATE_COLUMNS, grant_statements

    ux_columns = {
        "display_name",
        "logo_url",
        "default_ui_mode",
        "default_channel_id",
        "allow_member_channel_creation",
        "allow_member_invites",
        "allow_link_previews",
    }
    assert {("workspaces_workspace", col) for col in ux_columns} <= set(UPDATE_COLUMNS)
    grants = set(grant_statements("kodera_api"))
    for col in ux_columns:
        assert f'GRANT UPDATE ("{col}") ON TABLE "workspaces_workspace" TO "kodera_api"' in grants


@pytest.mark.parametrize(
    "data",
    [
        {"display_name": " "},
        {"display_name": "x"},
        {"display_name": "x" * 81},
        {"default_ui_mode": []},
        {"default_ui_mode": "simple"},
        {"allow_member_invites": 1},
        {"logo_url": "https://other.test/image"},
    ],
)
def test_invalid_profile_never_saves(data, monkeypatch):
    from apps.workspaces import governance as service
    from apps.workspaces.moderation import RefusalError

    row = workspace()
    monkeypatch.setattr(
        service, "mutation_context", lambda *a, **k: (row, SimpleNamespace(identity_id=UUID(int=2)))
    )
    with pytest.raises(RefusalError) as refused:
        service.profile_with_etag.__wrapped__(
            verified=None,
            organisation_id=UUID(int=3),
            if_match=service.profile_etag(row),
            data=data,
        )
    assert refused.value.status == 422
    row.save.assert_not_called()


def test_profile_authority_precedes_logo_validation(monkeypatch):
    from apps.workspaces import governance as service
    from apps.workspaces.moderation import RefusalError

    def refuse(*args, **kwargs):
        raise RefusalError(403)

    validate = Mock()
    monkeypatch.setattr(service, "mutation_context", refuse)
    monkeypatch.setattr(service, "validate_logo", validate)
    with pytest.raises(RefusalError):
        service.profile_with_etag.__wrapped__(
            verified=None, organisation_id=UUID(int=3), if_match="*", data={"logo_url": raster()}
        )
    validate.assert_not_called()
