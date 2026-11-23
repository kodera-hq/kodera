"""Read-only verified-email member matching; external privileges are strictly ignored."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from apps.identity.models import Identity
from apps.orgs.models import Membership

from .import_parsers import ImportedExternalUser, clean, identifier

SOURCE_LABELS: dict[str, str] = {
    "slack": "Slack",
    "discord": "Discord",
    "notion": "Notion",
}


@dataclass(frozen=True)
class MemberMapping:
    external_id: str
    display_name: str
    matched_membership_id: UUID | None
    local_role_preserved: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "external_id": self.external_id,
            "display_name": self.display_name,
            "matched_membership_id": (
                str(self.matched_membership_id) if self.matched_membership_id is not None else None
            ),
            "local_role_preserved": True,
        }


@dataclass(frozen=True)
class MemberMatchResult:
    mappings: tuple[MemberMapping, ...]
    by_external_id: dict[str, MemberMapping]
    external_admin_privilege_ignored: bool

    @property
    def matched_count(self) -> int:
        return sum(1 for item in self.mappings if item.matched_membership_id is not None)

    @property
    def unmatched_count(self) -> int:
        return sum(1 for item in self.mappings if item.matched_membership_id is None)


def inert_author_attribution(source: str, external_id: str, display_name: str) -> str:
    """Inert attributed text for unmatched or replayed external authors."""
    safe_id = identifier(external_id)
    safe_name = clean(display_name, 200) or safe_id
    label = SOURCE_LABELS.get(source, "External")
    return f"Imported author: {safe_name} ({label} {safe_id})"


def match_external_users(
    *, organisation_id: UUID, external_users: Sequence[ImportedExternalUser]
) -> MemberMatchResult:
    """Match non-bot exported emails against active organisation memberships with enabled identities.

    Hard Security Invariant:
    - Read-only: never creates or updates `User`, `Identity`, `Membership`, or `WorkspaceModerator`.
    - External `is_owner`, `is_primary_owner`, `is_admin`, or Discord administrator bitmasks are
      strictly ignored and emit `external_admin_privilege_ignored = True`.
    """
    admin_ignored = any(user.had_external_admin_privilege for user in external_users)
    candidate_emails = sorted(
        {
            user.email.strip().lower()
            for user in external_users
            if not user.is_bot and isinstance(user.email, str) and user.email.strip()
        }
    )

    email_to_membership: dict[str, UUID | None] = {}
    if candidate_emails:
        active_memberships = {
            row.user_id: row.id
            for row in Membership.objects.filter(
                organisation_id=organisation_id,
                state="active",
                accepted_at__isnull=False,
                deleted_at__isnull=True,
                user__enabled=True,
                user__deleted_at__isnull=True,
            ).only("id", "user_id")
        }
        if active_memberships:
            for normalized in candidate_emails:
                matched_user_ids = {
                    ident.user_id
                    for ident in Identity.objects.filter(
                        organisation_id=organisation_id,
                        enabled=True,
                        deleted_at__isnull=True,
                        email__iexact=normalized,
                    ).only("id", "user_id")
                    if ident.user_id in active_memberships
                }
                if len(matched_user_ids) == 1:
                    only_user_id = next(iter(matched_user_ids))
                    email_to_membership[normalized] = active_memberships[only_user_id]
                else:
                    email_to_membership[normalized] = None

    mappings: list[MemberMapping] = []
    by_external: dict[str, MemberMapping] = {}
    for user in external_users:
        matched_id: UUID | None = None
        if not user.is_bot and isinstance(user.email, str) and user.email.strip():
            matched_id = email_to_membership.get(user.email.strip().lower())
        mapping = MemberMapping(
            external_id=user.external_id,
            display_name=user.display_name,
            matched_membership_id=matched_id,
            local_role_preserved=True,
        )
        mappings.append(mapping)
        by_external[user.external_id] = mapping

    return MemberMatchResult(
        mappings=tuple(mappings),
        by_external_id=by_external,
        external_admin_privilege_ignored=admin_ignored,
    )
