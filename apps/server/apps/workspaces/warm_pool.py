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
    ChannelBlueprint,
    CollectionBlueprint,
    DocumentBlueprint,
    WorkspaceTemplate,
    canonical_template_id,
    canonical_theme_id,
    resolve_template,
)

MAX_REQUEST_BYTES = 16 * 1024
ORG_NAME_LENGTH = (1, 80)
SLUG_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$")
OPERATION_KEY_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
CUSTOM_CHANNEL_KEY_PATTERN = re.compile(r"^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$")
ADDITIONAL_CHANNEL_NAME_RE = re.compile(
    r"^[\x20-\x7e\u00a0-\u00ac\u00ae-\u024f]*[A-Za-z0-9][\x20-\x7e\u00a0-\u00ac\u00ae-\u024f]*$"
)
# Both claim flows share the console's root namespace. Punctuation-led routes such as
# /.well-known and /_matrix are already excluded by both slug grammars.
RESERVED_SLUGS = (
    RESERVED_ORGANISATION_SLUGS
    | RESERVED_TENANT_SLUGS
    | {
        "agent",
        "assets",
        "booking",
        "callback",
        "claim",
        "developer-docs",
        "docs",
        "documents",
        "espace",
        "health",
        "healthz",
        "invitations",
        "invite",
        "invites",
        "join",
        "login",
        "logout",
        "order",
        "pricing",
        "privacy",
        "realms",
        "rtc",
        "security",
        "settings",
        "worklets",
        "workspaces",
    }
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
MAX_EXCLUDED_CHANNEL_KEYS = 32
MAX_ADDITIONAL_CHANNELS = 16
CUSTOMIZATION_MEMBERS = frozenset(
    {
        "includeAudioChannels",
        "includeCollections",
        "includeStarterDocs",
        "excludedChannelKeys",
        "additionalChannels",
    }
)
ADDITIONAL_CHANNEL_MEMBERS = frozenset({"categoryKey", "name", "kind", "topic"})
MEMBERS = frozenset(
    {
        "organizationName",
        "slug",
        "hostingMode",
        "templateId",
        "themeId",
        "soundPackId",
        "enabledConnectors",
        "operationKey",
        "customization",
    }
)
REQUIRED = ("organizationName", "slug", "hostingMode", "templateId")


class InstantClaimInputError(Exception):
    """Raised when an instant-claim onboarding payload fails validation."""

    def __init__(self, errors: list[tuple[str, str]] | None = None) -> None:
        super().__init__("malformed instant-claim request")
        self.errors = errors or []


@dataclass(frozen=True, slots=True)
class AdditionalChannelSpec:
    category_key: str
    name: str
    kind: str
    topic: str = ""

    def to_dict(self) -> dict[str, str]:
        return {
            "categoryKey": self.category_key,
            "name": self.name,
            "kind": self.kind,
            "topic": self.topic,
        }


@dataclass(frozen=True, slots=True)
class TemplateCustomization:
    include_audio_channels: bool = True
    include_collections: bool = True
    include_starter_docs: bool = True
    excluded_channel_keys: tuple[str, ...] = ()
    additional_channels: tuple[AdditionalChannelSpec, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "includeAudioChannels": self.include_audio_channels,
            "includeCollections": self.include_collections,
            "includeStarterDocs": self.include_starter_docs,
            "excludedChannelKeys": list(self.excluded_channel_keys),
            "additionalChannels": [ch.to_dict() for ch in self.additional_channels],
        }


@dataclass(frozen=True, slots=True)
class InstantClaimRequest:
    organization_name: str
    slug: str
    hosting_mode: str
    template_id: str
    theme_id: str
    sound_pack_id: str
    enabled_connectors: tuple[str, ...]
    operation_key: str | None = None
    customization: TemplateCustomization | None = None


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


def slugify_channel_key(name: str) -> str:
    """Derive a deterministic ASCII template_key (1..32 chars, [a-z][a-z0-9-]*) from a channel name."""
    folded = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", folded).strip("-")
    if not slug:
        return ""
    if slug[0].isdigit():
        slug = f"c-{slug}"
    return slug[:32].rstrip("-")


def resolve_customized_blueprints(
    template: WorkspaceTemplate, customization: TemplateCustomization | None = None
) -> tuple[
    tuple[ChannelBlueprint, ...],
    tuple[CollectionBlueprint, ...],
    tuple[DocumentBlueprint, ...],
]:
    """Return deterministic channels, collections, and documents after applying v2 customization."""
    if customization is None:
        return template.channels, template.collections, template.documents

    category_keys = {cat.key for cat in template.categories}
    excluded = set(customization.excluded_channel_keys)
    channels: list[ChannelBlueprint] = [
        ch
        for ch in template.channels
        if ch.template_key not in excluded
        and (customization.include_audio_channels or ch.kind != Channel.Kind.AUDIO)
    ]
    seen_db_keys = {ch.db_template_key for ch in channels}
    seen_names = {ch.name for ch in channels}
    for extra in customization.additional_channels:
        if extra.category_key not in category_keys:
            raise ValueError("additional channel references unknown categoryKey")
        if not customization.include_audio_channels and extra.kind == Channel.Kind.AUDIO:
            raise ValueError("audio channel added while includeAudioChannels is false")
        if not (1 <= len(extra.name) <= 64) or not ADDITIONAL_CHANNEL_NAME_RE.fullmatch(extra.name):
            raise ValueError("additional channel name contains unsupported characters")
        extra_key = slugify_channel_key(extra.name)
        if not extra_key or not CUSTOM_CHANNEL_KEY_PATTERN.fullmatch(extra_key):
            raise ValueError("additional channel name yields invalid key")
        extra_bp = ChannelBlueprint(
            category_key=extra.category_key,
            template_key=extra_key,
            name=extra.name,
            kind=extra.kind,
            topic=extra.topic,
        )
        if extra_bp.db_template_key in seen_db_keys or extra_bp.name in seen_names:
            raise ValueError("duplicate channel key or name in customization")
        seen_db_keys.add(extra_bp.db_template_key)
        seen_names.add(extra_bp.name)
        channels.append(extra_bp)

    if not channels or not any(ch.kind == Channel.Kind.TEXT for ch in channels):
        raise ValueError("customization must retain at least one text channel")

    collections: tuple[CollectionBlueprint, ...] = (
        template.collections if customization.include_collections else ()
    )
    remaining_channel_keys = {ch.template_key for ch in channels}
    remaining_collection_keys = {col.key for col in collections}

    documents: list[DocumentBlueprint] = []
    if customization.include_starter_docs:
        for doc in template.documents:
            resolved_col_key = (
                doc.collection_key if doc.collection_key in remaining_collection_keys else None
            )
            documents.append(
                DocumentBlueprint(
                    key=doc.key,
                    title=doc.title,
                    markdown=doc.markdown,
                    channel_key=(
                        doc.channel_key if doc.channel_key in remaining_channel_keys else None
                    ),
                    collection_key=resolved_col_key,
                    collection_values=doc.collection_values if resolved_col_key else (),
                )
            )

    return tuple(channels), collections, tuple(documents)


def parse_template_customization(
    raw: object, template: WorkspaceTemplate | None = None
) -> TemplateCustomization:
    """Validate and normalize a WorkspaceTemplateCustomization payload."""
    if not isinstance(raw, dict) or not (set(raw) <= CUSTOMIZATION_MEMBERS):
        raise ValueError("invalid customization object")

    include_audio = raw.get("includeAudioChannels", True)
    include_collections = raw.get("includeCollections", True)
    include_docs = raw.get("includeStarterDocs", True)
    if (
        not isinstance(include_audio, bool)
        or not isinstance(include_collections, bool)
        or not isinstance(include_docs, bool)
    ):
        raise ValueError("customization flags must be booleans")

    raw_excluded = raw.get("excludedChannelKeys", [])
    if (
        not isinstance(raw_excluded, list)
        or len(raw_excluded) > MAX_EXCLUDED_CHANNEL_KEYS
        or any(
            not isinstance(item, str) or not CUSTOM_CHANNEL_KEY_PATTERN.fullmatch(item)
            for item in raw_excluded
        )
    ):
        raise ValueError("invalid excludedChannelKeys")
    excluded_keys = _deduplicate_connectors(raw_excluded)

    raw_additional = raw.get("additionalChannels", [])
    if not isinstance(raw_additional, list) or len(raw_additional) > MAX_ADDITIONAL_CHANNELS:
        raise ValueError("invalid additionalChannels")
    additional_specs: list[AdditionalChannelSpec] = []
    for entry in raw_additional:
        if (
            not isinstance(entry, dict)
            or not {"categoryKey", "name", "kind"} <= set(entry)
            or not set(entry) <= ADDITIONAL_CHANNEL_MEMBERS
        ):
            raise ValueError("invalid additional channel entry")
        cat_key = entry["categoryKey"]
        name = entry["name"]
        kind = entry["kind"]
        topic = entry.get("topic", "")
        if (
            not isinstance(cat_key, str)
            or not CUSTOM_CHANNEL_KEY_PATTERN.fullmatch(cat_key)
            or not isinstance(name, str)
            or not (1 <= len(name) <= 64)
            or not _is_printable_single_line(name)
            or not ADDITIONAL_CHANNEL_NAME_RE.fullmatch(name)
            or not slugify_channel_key(name)
            or kind not in {Channel.Kind.TEXT, Channel.Kind.AUDIO}
            or not isinstance(topic, str)
            or len(topic) > 1024
            or (topic != "" and not _is_printable_single_line(topic))
        ):
            raise ValueError("invalid additional channel fields")
        additional_specs.append(
            AdditionalChannelSpec(category_key=cat_key, name=name, kind=kind, topic=topic)
        )

    customization = TemplateCustomization(
        include_audio_channels=include_audio,
        include_collections=include_collections,
        include_starter_docs=include_docs,
        excluded_channel_keys=excluded_keys,
        additional_channels=tuple(additional_specs),
    )
    if template is not None:
        resolve_customized_blueprints(template, customization)
    return customization


def workspace_slug_is_reserved(slug: str) -> bool:
    return slug in RESERVED_SLUGS or slug.startswith(("xn--", "synth-"))


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
        elif workspace_slug_is_reserved(slug):
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

    operation_key: str | None = None
    if "operationKey" in body:
        raw_op_key = body.get("operationKey")
        if not isinstance(raw_op_key, str) or not OPERATION_KEY_PATTERN.fullmatch(raw_op_key):
            errors.append(("/operationKey", "invalid"))
        else:
            operation_key = raw_op_key

    customization: TemplateCustomization | None = None
    if "customization" in body:
        try:
            customization = parse_template_customization(body.get("customization"), template)
        except ValueError:
            errors.append(("/customization", "invalid"))

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
        operation_key=operation_key,
        customization=customization,
    )


def build_instant_claim_plan(request: InstantClaimRequest) -> dict[str, Any]:
    """Produce a deterministic provisioning plan for warm-pool claim or self-host bootstrap."""
    template = resolve_template(request.template_id)
    effective_channels, effective_collections, effective_documents = resolve_customized_blueprints(
        template, request.customization
    )

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
    for channel in effective_channels:
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

    plan: dict[str, Any] = {
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
    if request.customization is not None:
        plan["template_version"] = template.version
        plan["collections"] = [
            {
                "key": col.key,
                "db_template_key": col.db_template_key,
                "title": col.title,
            }
            for col in effective_collections
        ]
        plan["documents"] = [
            {
                "key": doc.key,
                "db_template_key": doc.db_template_key,
                "title": doc.title,
                "channel_key": doc.channel_key,
                "collection_key": doc.collection_key,
            }
            for doc in effective_documents
        ]
        plan["customization"] = request.customization.to_dict()
    return plan


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
    effective_channels, _, _ = resolve_customized_blueprints(template, request.customization)
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
            for ch in effective_channels
        ],
        "enabledConnectors": list(request.enabled_connectors),
        "offerMode": resolved_offer,
    }
