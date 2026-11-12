"""Warm-pool instant-claim request validation and deterministic provisioning plan builder."""

import json
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from apps.orgs.intake_services import RESERVED_SLUGS as RESERVED_ORGANISATION_SLUGS
from apps.tenancy.selectors import RESERVED_SLUGS as RESERVED_TENANT_SLUGS

from .models import Channel
from .templates import (
    DEFAULT_THEME_ID,
    canonical_template_id,
    canonical_theme_id,
    resolve_template,
)

MAX_REQUEST_BYTES = 16 * 1024
ORG_NAME_LENGTH = (1, 80)
SLUG_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$")
# Both namespaces can name first-party hosts; instant claim must reserve their union.
RESERVED_SLUGS = (
    frozenset(RESERVED_ORGANISATION_SLUGS) | frozenset(RESERVED_TENANT_SLUGS) | {"login"}
)
HOSTING_MODES = frozenset({"cloud", "self-host"})
SOUND_PACK_IDS = frozenset(
    {
        "cristal-48k",
        "studio-mat",
        "silence",
        "givre",
        "atelier",
        "souffle",
        "cosmos",
        "luciole",
        "silencieux",
    }
)
DEFAULT_SOUND_PACK_ID = "cristal-48k"
OFFICIAL_CONNECTOR_IDS = frozenset(
    {
        "frameio-review-bridge",
        "github-webhook",
        "linear-sync",
        "sentry-alerts",
        "qonto-treasury-alerts",
        "stripe-revenue-events",
        "calcom-booking-sync",
        "nextcloud-drive-notifier",
    }
)
MAX_ENABLED_CONNECTORS = 10
MEMBERS = frozenset(
    {
        "organizationName",
        "slug",
        "hostingMode",
        "templateId",
        "themeId",
        "soundPackId",
        "enabledConnectors",
    }
)
REQUIRED = ("organizationName", "slug", "hostingMode", "templateId")


class InstantClaimInputError(Exception):
    """Raised when an instant-claim onboarding payload fails validation."""

    def __init__(self, errors: list[tuple[str, str]] | None = None) -> None:
        super().__init__("malformed instant-claim request")
        self.errors = errors or []


@dataclass(frozen=True, slots=True)
class InstantClaimRequest:
    organization_name: str
    slug: str
    hosting_mode: str
    template_id: str
    theme_id: str
    sound_pack_id: str
    enabled_connectors: tuple[str, ...]


def _pointer(name: str) -> str:
    """RFC 6901 JSON Pointer to a top-level member."""
    return "/" + name.replace("~", "~0").replace("/", "~1")


def _is_printable_single_line(value: str) -> bool:
    """True when `value` contains no Unicode control or line/paragraph separator characters."""
    return not any(
        unicodedata.category(ch).startswith("C") or unicodedata.category(ch) in {"Zl", "Zp"}
        for ch in value
    )


def _valid_org_name(value: object) -> bool:
    if not isinstance(value, str):
        return False
    trimmed = value.strip(" \t\n\r")
    return (
        ORG_NAME_LENGTH[0] <= len(value) <= ORG_NAME_LENGTH[1]
        and len(trimmed) > 0
        and _is_printable_single_line(value)
    )


def _deduplicate_connectors(items: list[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    ordered: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            ordered.append(item)
    return tuple(ordered)


def parse_instant_claim_request(
    raw: bytes, content_type: str = "application/json"
) -> InstantClaimRequest:
    """Parse and validate an instant-claim request payload."""
    if content_type != "application/json" or len(raw) > MAX_REQUEST_BYTES:
        raise InstantClaimInputError()
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise InstantClaimInputError() from None
    if not isinstance(body, dict):
        raise InstantClaimInputError()

    errors: list[tuple[str, str]] = [
        (_pointer(name), "unexpected") for name in sorted(set(body) - MEMBERS)
    ]
    errors += [("/" + name, "required") for name in REQUIRED if name not in body]

    org_name = body.get("organizationName")
    if "organizationName" in body and not _valid_org_name(org_name):
        errors.append(("/organizationName", "invalid"))

    slug = body.get("slug")
    if "slug" in body:
        if not isinstance(slug, str) or not SLUG_PATTERN.fullmatch(slug):
            errors.append(("/slug", "invalid"))
        elif slug in RESERVED_SLUGS or slug.startswith(("xn--", "synth-")):
            errors.append(("/slug", "reserved"))

    hosting_mode = body.get("hostingMode")
    if "hostingMode" in body and (
        not isinstance(hosting_mode, str) or hosting_mode not in HOSTING_MODES
    ):
        errors.append(("/hostingMode", "invalid"))

    # The identifier the request names, or its deprecated alias (`crisis-cell`): one template
    # either way, kept under its canonical identifier from here on.
    template_id = canonical_template_id(body.get("templateId"))
    template = None
    if "templateId" in body:
        if template_id is None:
            errors.append(("/templateId", "invalid"))
        else:
            template = resolve_template(template_id)

    # A `ThemeId`, or one of the three aliases it took before 0.42.0: kept as the ThemeId it names,
    # by the same reader a stored plan is read with (templates.canonical_plan).
    theme_id = canonical_theme_id(body.get("themeId"))
    if "themeId" not in body:
        theme_id = template.default_theme_id if template is not None else DEFAULT_THEME_ID
    elif theme_id is None:
        errors.append(("/themeId", "invalid"))
        theme_id = ""

    raw_sound = body.get("soundPackId")
    if "soundPackId" not in body:
        sound_pack_id = DEFAULT_SOUND_PACK_ID
    elif not isinstance(raw_sound, str) or raw_sound not in SOUND_PACK_IDS:
        errors.append(("/soundPackId", "invalid"))
        sound_pack_id = ""
    else:
        sound_pack_id = raw_sound

    raw_connectors = body.get("enabledConnectors")
    enabled_connectors: tuple[str, ...] = ()
    if "enabledConnectors" not in body:
        enabled_connectors = template.default_connectors if template is not None else ()
    elif (
        not isinstance(raw_connectors, list)
        or len(raw_connectors) > MAX_ENABLED_CONNECTORS
        or any(
            not isinstance(item, str) or item not in OFFICIAL_CONNECTOR_IDS
            for item in raw_connectors
        )
    ):
        errors.append(("/enabledConnectors", "invalid"))
    else:
        enabled_connectors = _deduplicate_connectors(raw_connectors)

    if errors:
        raise InstantClaimInputError(errors)

    assert isinstance(org_name, str)  # noqa: S101 - validated above
    assert isinstance(slug, str)  # noqa: S101 - validated above
    assert isinstance(hosting_mode, str)  # noqa: S101 - validated above
    assert isinstance(template_id, str)  # noqa: S101 - validated above

    return InstantClaimRequest(
        organization_name=org_name,
        slug=slug,
        hosting_mode=hosting_mode,
        template_id=template_id,
        theme_id=theme_id,
        sound_pack_id=sound_pack_id,
        enabled_connectors=enabled_connectors,
    )


def build_instant_claim_plan(request: InstantClaimRequest) -> dict[str, Any]:
    """Produce a deterministic provisioning plan for warm-pool claim or self-host bootstrap."""
    template = resolve_template(request.template_id)

    categories: list[dict[str, Any]] = [
        {
            "key": category.key,
            "db_template_key": category.db_template_key,
            "name": category.name,
            "position": index,
        }
        for index, category in enumerate(template.categories)
    ]

    positions_by_category: dict[str, int] = {}
    channels: list[dict[str, Any]] = []
    for channel in template.channels:
        position = positions_by_category.get(channel.category_key, 0)
        positions_by_category[channel.category_key] = position + 1
        channels.append(
            {
                "category_key": channel.category_key,
                "template_key": channel.template_key,
                "db_template_key": channel.db_template_key,
                "name": channel.name,
                "kind": channel.kind,
                "topic": channel.topic,
                "position": position,
                "policy_mode": Channel.PolicyMode.INHERIT,
                "lifecycle": Channel.Lifecycle.ACTIVE,
            }
        )

    return {
        "slug": request.slug,
        "organization_name": request.organization_name,
        "hosting_mode": request.hosting_mode,
        "template_id": template.id,
        "template_label_fr": template.label_fr,
        # Canonical whatever built the request: a plan never holds an alias.
        "theme_id": canonical_theme_id(request.theme_id) or request.theme_id,
        "sound_pack_id": request.sound_pack_id,
        "categories": categories,
        "channels": channels,
        "enabled_connectors": list(request.enabled_connectors),
        "recommended_roles": list(template.recommended_roles),
        "warm_pool_eligible": request.hosting_mode == "cloud",
    }


def build_instant_claim_response(
    request: InstantClaimRequest,
    *,
    workspace_id: str,
    workspace_url: str,
    invitation_url: str,
    offer_mode: str | None = None,
) -> dict[str, Any]:
    """Build the client-facing Instant-Claim response matching PHASE-C-CONTRACT.md."""
    template = resolve_template(request.template_id)
    resolved_offer = offer_mode or (
        "cloud-shared" if request.hosting_mode == "cloud" else "community"
    )
    return {
        "workspaceId": workspace_id,
        "workspaceUrl": workspace_url,
        "invitationUrl": invitation_url,
        "channels": [
            {
                "id": ch.template_key,
                "name": ch.name,
                "kind": ch.kind,
            }
            for ch in template.channels
        ],
        "enabledConnectors": list(request.enabled_connectors),
        "offerMode": resolved_offer,
    }
