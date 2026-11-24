"""Founder-locked 3-tier E2EE conversation model (`Track 7`, `H4.3a`).

- Tier 1 (`TIER_1_DEFAULT_E2EE`): `1:1` DMs, private group DMs, and private calls default to
  end-to-end encryption (`MLS + SFrame + KVKB1 + local search`) at creation (`True`).
- Tier 2 (`TIER_2_OPT_IN_CONFIDENTIAL`): Workspace/team text channels are opt-in confidential
  (`False` at creation; when `is_confidential=True`, strict Zero-Knowledge applies: `403` on
  server AI, Scheduled Messages, and Reminders, `KDE1` encrypted Yjs collaboration, and `SFrame`).
- Tier 3 (`TIER_3_STANDARD_CHANNEL`): Standard channels (`#arrivals`, `#general`, and standard
  team channels) default to `is_confidential=False` so newcomers keep instant history and
  connectors/opt-in AI operate with zero fake E2EE padlock.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

ConversationSurface = Literal[
    "direct_message",
    "private_group_dm",
    "private_call",
    "team_channel",
    "public_channel",
]


class ConversationEncryptionTier(StrEnum):
    TIER_1_DEFAULT_E2EE = "tier-1-default-e2ee"
    TIER_2_OPT_IN_CONFIDENTIAL = "tier-2-opt-in-confidential"
    TIER_3_STANDARD_CHANNEL = "tier-3-standard-channel"


def default_e2ee_for_surface(surface: ConversationSurface) -> bool:
    """Return whether E2EE is enabled by default when creating `surface`."""
    if surface in ("direct_message", "private_group_dm", "private_call"):
        return True
    if surface in ("team_channel", "public_channel"):
        return False
    msg = f"Unsupported conversation surface: {surface!r}"
    raise ValueError(msg)


def classify_workspace_channel_tier(*, is_confidential: bool) -> ConversationEncryptionTier:
    """Classify a workspace channel into Tier 2 (`🔒` opt-in ZK) or Tier 3 (standard)."""
    if is_confidential:
        return ConversationEncryptionTier.TIER_2_OPT_IN_CONFIDENTIAL
    return ConversationEncryptionTier.TIER_3_STANDARD_CHANNEL
