"""DB-free unit tests for the Founder-locked 3-tier E2EE model (`Track 7`, `H4.3a`)."""

from __future__ import annotations

import pytest

from apps.workspaces.encryption_tiers import (
    ConversationEncryptionTier,
    classify_workspace_channel_tier,
    default_e2ee_for_surface,
    should_display_confidential_padlock,
)


def test_tier_1_private_surfaces_default_to_e2ee() -> None:
    assert default_e2ee_for_surface("direct_message") is True
    assert default_e2ee_for_surface("private_group_dm") is True
    assert default_e2ee_for_surface("private_call") is True


def test_tier_2_and_tier_3_channel_defaults_and_classification() -> None:
    assert default_e2ee_for_surface("team_channel") is False
    assert default_e2ee_for_surface("public_channel") is False
    assert (
        classify_workspace_channel_tier(is_confidential=True)
        == ConversationEncryptionTier.TIER_2_OPT_IN_CONFIDENTIAL
    )
    assert (
        classify_workspace_channel_tier(is_confidential=False)
        == ConversationEncryptionTier.TIER_3_STANDARD_CHANNEL
    )


def test_unknown_surface_raises_value_error() -> None:
    with pytest.raises(ValueError, match="Unsupported conversation surface"):
        default_e2ee_for_surface("unknown_surface")  # type: ignore[arg-type]


def test_padlock_requires_verified_e2ee_session() -> None:
    assert (
        should_display_confidential_padlock(is_confidential=True, is_verified_e2ee_session=False)
        is False
    )
    assert (
        should_display_confidential_padlock(is_direct=True, is_verified_e2ee_session=False) is False
    )
    assert (
        should_display_confidential_padlock(
            is_confidential=False, is_direct=False, is_verified_e2ee_session=True
        )
        is False
    )
    assert (
        should_display_confidential_padlock(is_confidential=True, is_verified_e2ee_session=True)
        is True
    )
    assert (
        should_display_confidential_padlock(is_direct=True, is_verified_e2ee_session=True) is True
    )
