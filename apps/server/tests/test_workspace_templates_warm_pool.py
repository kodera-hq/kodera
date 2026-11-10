"""In-memory verification of official industry workspace templates and warm-pool instant-claim."""

import json
import re

import pytest

from apps.workspaces.models import TEMPLATE_KEY, Channel
from apps.workspaces.templates import (
    TEMPLATES,
    UnknownWorkspaceTemplateError,
    list_templates,
    resolve_template,
)
from apps.workspaces.warm_pool import (
    OFFICIAL_CONNECTOR_IDS,
    RESERVED_SLUGS,
    InstantClaimInputError,
    InstantClaimRequest,
    build_instant_claim_plan,
    build_instant_claim_response,
    parse_instant_claim_request,
)

VALID_CLAIM_PAYLOAD = {
    "organizationName": "Lumière & Associés Production",
    "slug": "lumiere-production",
    "hostingMode": "cloud",
    "templateId": "audiovisual-production",
    "themeId": "real-black",
    "soundPackId": "cristal-48k",
    "enabledConnectors": ["frameio-review-bridge", "nextcloud-drive-notifier"],
}


def _parse(payload: dict) -> InstantClaimRequest:
    return parse_instant_claim_request(json.dumps(payload).encode("utf-8"), "application/json")


def _errors(payload: dict) -> list[tuple[str, str]]:
    with pytest.raises(InstantClaimInputError) as exc_info:
        _parse(payload)
    return exc_info.value.errors


def test_catalogue_exposes_all_five_official_templates() -> None:
    expected_ids = {
        "audiovisual-production",
        "tech-studio",
        "b2b-advisory",
        "public-sector",
        "crisis-cell",
    }
    assert set(TEMPLATES.keys()) == expected_ids
    assert [tpl.id for tpl in list_templates()] == list(TEMPLATES.keys())


def test_audiovisual_production_template_matches_production_company_blueprint() -> None:
    tpl = resolve_template("audiovisual-production")
    assert tpl.label_fr == "Société de production audiovisuelle"
    assert tpl.default_theme_id == "real-black"
    assert [cat.key for cat in tpl.categories] == ["production", "post-production", "plateaux"]
    assert [ch.name for ch in tpl.channels] == [
        "production",
        "tournage",
        "post-production",
        "dailies-rushes",
        "plateau-regie",
        "salle-montage",
    ]
    kinds_by_name = {ch.name: ch.kind for ch in tpl.channels}
    assert kinds_by_name == {
        "production": Channel.Kind.TEXT,
        "tournage": Channel.Kind.TEXT,
        "post-production": Channel.Kind.TEXT,
        "dailies-rushes": Channel.Kind.TEXT,
        "plateau-regie": Channel.Kind.AUDIO,
        "salle-montage": Channel.Kind.AUDIO,
    }
    assert "frameio-review-bridge" in tpl.default_connectors
    assert tpl.recommended_roles == (
        "Producteur",
        "Réalisateur",
        "post-production",
        "Superviseur VFX/Son",
    )


def test_every_template_satisfies_database_template_key_and_channel_constraints() -> None:
    pattern = re.compile(TEMPLATE_KEY)
    for tpl in list_templates():
        cat_keys = {cat.key for cat in tpl.categories}
        assert len(cat_keys) == len(tpl.categories)
        for cat in tpl.categories:
            assert pattern.fullmatch(cat.db_template_key), (tpl.id, cat.db_template_key)
            assert 1 <= len(cat.name.strip()) <= 100
        seen_channel_keys: set[str] = set()
        for ch in tpl.channels:
            assert ch.category_key in cat_keys, (tpl.id, ch.category_key)
            assert pattern.fullmatch(ch.db_template_key), (tpl.id, ch.db_template_key)
            assert ch.db_template_key not in seen_channel_keys
            seen_channel_keys.add(ch.db_template_key)
            assert ch.kind in {Channel.Kind.TEXT, Channel.Kind.AUDIO}
            assert 1 <= len(ch.name.strip()) <= 100
            assert 0 <= len(ch.topic) <= 1024
        for connector in tpl.default_connectors:
            assert connector in OFFICIAL_CONNECTOR_IDS


def test_resolve_template_refuses_unknown_identifier() -> None:
    with pytest.raises(UnknownWorkspaceTemplateError) as exc_info:
        resolve_template("non-existent-template")
    assert exc_info.value.template_id == "non-existent-template"


def test_build_instant_claim_plan_produces_deterministic_structure() -> None:
    req = _parse(VALID_CLAIM_PAYLOAD)
    plan = build_instant_claim_plan(req)
    assert plan["slug"] == "lumiere-production"
    assert plan["organization_name"] == "Lumière & Associés Production"
    assert plan["hosting_mode"] == "cloud"
    assert plan["template_id"] == "audiovisual-production"
    assert plan["template_label_fr"] == "Société de production audiovisuelle"
    assert plan["theme_id"] == "real-black"
    assert plan["sound_pack_id"] == "cristal-48k"
    assert plan["warm_pool_eligible"] is True
    assert plan["enabled_connectors"] == ["frameio-review-bridge", "nextcloud-drive-notifier"]
    assert [c["position"] for c in plan["categories"]] == [0, 1, 2]
    # Per-category channel positions start at 0 within each category.
    prod_positions = [
        ch["position"] for ch in plan["channels"] if ch["category_key"] == "production"
    ]
    post_positions = [
        ch["position"] for ch in plan["channels"] if ch["category_key"] == "post-production"
    ]
    plateaux_positions = [
        ch["position"] for ch in plan["channels"] if ch["category_key"] == "plateaux"
    ]
    assert prod_positions == [0, 1]
    assert post_positions == [0, 1]
    assert plateaux_positions == [0, 1]


def test_self_host_mode_disables_warm_pool_eligibility_and_applies_template_defaults() -> None:
    req = _parse(
        {
            "organizationName": "Mairie de Saint-Cloud",
            "slug": "mairie-saint-cloud",
            "hostingMode": "self-host",
            "templateId": "public-sector",
        }
    )
    plan = build_instant_claim_plan(req)
    assert plan["warm_pool_eligible"] is False
    assert plan["theme_id"] == "givre"
    assert plan["sound_pack_id"] == "cristal-48k"
    assert plan["enabled_connectors"] == ["nextcloud-drive-notifier"]


def test_enabled_connectors_are_deduplicated_preserving_order() -> None:
    req = _parse(
        {
            **VALID_CLAIM_PAYLOAD,
            "enabledConnectors": [
                "frameio-review-bridge",
                "github-webhook",
                "frameio-review-bridge",
            ],
        }
    )
    assert req.enabled_connectors == ("frameio-review-bridge", "github-webhook")


@pytest.mark.parametrize("reserved", sorted(RESERVED_SLUGS))
def test_reserved_platform_slugs_are_rejected(reserved: str) -> None:
    assert _errors({**VALID_CLAIM_PAYLOAD, "slug": reserved}) == [("/slug", "reserved")]


@pytest.mark.parametrize(
    "bad_slug",
    [
        "ab",
        "-leading-hyphen",
        "trailing-hyphen-",
        "UPPERCASE-SLUG",
        "with_underscore",
        "with space",
        "a" * 41,
    ],
)
def test_malformed_slugs_are_rejected(bad_slug: str) -> None:
    assert _errors({**VALID_CLAIM_PAYLOAD, "slug": bad_slug}) == [("/slug", "invalid")]


@pytest.mark.parametrize(
    "bad_org_name",
    [
        "",
        "   \t  ",
        "x" * 81,
        "Org\nWithNewline",
        "Org\x00WithNull",
    ],
)
def test_invalid_organization_names_are_rejected(bad_org_name: str) -> None:
    assert _errors({**VALID_CLAIM_PAYLOAD, "organizationName": bad_org_name}) == [
        ("/organizationName", "invalid")
    ]


def test_unexpected_and_missing_fields_and_invalid_enums_are_reported() -> None:
    assert _errors({"extra/field~1": True}) == [
        ("/extra~1field~01", "unexpected"),
        ("/organizationName", "required"),
        ("/slug", "required"),
        ("/hostingMode", "required"),
        ("/templateId", "required"),
    ]
    assert _errors(
        {
            **VALID_CLAIM_PAYLOAD,
            "hostingMode": "on-prem",
            "templateId": "unknown-tpl",
            "themeId": "neon-pink",
            "soundPackId": "8bit",
            "enabledConnectors": ["unknown-connector"],
        }
    ) == [
        ("/hostingMode", "invalid"),
        ("/templateId", "invalid"),
        ("/themeId", "invalid"),
        ("/soundPackId", "invalid"),
        ("/enabledConnectors", "invalid"),
    ]


def test_non_json_content_type_and_oversized_payloads_are_refused() -> None:
    with pytest.raises(InstantClaimInputError):
        parse_instant_claim_request(b"{}", "text/plain")
    with pytest.raises(InstantClaimInputError):
        parse_instant_claim_request(b"{" * 20_000, "application/json")


def test_build_instant_claim_response_matches_phase_c_client_contract() -> None:
    req = parse_instant_claim_request(json.dumps(VALID_CLAIM_PAYLOAD).encode("utf-8"))
    response = build_instant_claim_response(
        req,
        workspace_id="ws-lumiere-01",
        workspace_url="https://lumiere-production.kodera.io",
        invitation_url="https://lumiere-production.kodera.io/invite?signed=tok123",
    )
    assert response["workspaceId"] == "ws-lumiere-01"
    assert response["workspaceUrl"] == "https://lumiere-production.kodera.io"
    assert response["invitationUrl"] == "https://lumiere-production.kodera.io/invite?signed=tok123"
    assert response["offerMode"] == "cloud-shared"
    assert response["enabledConnectors"] == ["frameio-review-bridge", "nextcloud-drive-notifier"]
    assert [c["id"] for c in response["channels"]] == [
        "production",
        "tournage",
        "post-production",
        "dailies-rushes",
        "plateau-regie",
        "salle-montage",
    ]
    assert all(c["kind"] in {"text", "audio"} for c in response["channels"])


@pytest.mark.parametrize("pack", ["givre", "atelier", "souffle", "cosmos", "luciole", "silencieux"])
def test_client_acoustic_preferences_are_valid_claim_inputs(pack):
    assert _parse({**VALID_CLAIM_PAYLOAD, "soundPackId": pack}).sound_pack_id == pack


def test_instant_claim_uses_the_existing_tenant_slug_bound():
    assert _errors({**VALID_CLAIM_PAYLOAD, "slug": "a" * 33}) == [("/slug", "invalid")]


@pytest.mark.parametrize("field", ["themeId", "soundPackId", "enabledConnectors"])
def test_explicit_null_optional_fields_match_the_nonnullable_contract(field):
    assert _errors({**VALID_CLAIM_PAYLOAD, field: None}) == [("/" + field, "invalid")]
