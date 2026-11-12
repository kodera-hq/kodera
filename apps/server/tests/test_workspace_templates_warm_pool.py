"""In-memory verification of official industry workspace templates and warm-pool instant-claim.

The last part holds the two vocabularies of contract 0.42.0 (docs/specs/WORKSPACE_TEMPLATES.md):
`proximity` with its permanent alias `crisis-cell`, and the five `ThemeId` values with their three
aliases. Each rule is a case run against apps/workspaces/templates.py and then against a mutant of
it with one anchor replaced, which must fail the case that owns it.
"""

import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from apps.workspaces import templates
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
        "proximity",
    }
    assert set(TEMPLATES.keys()) == expected_ids
    assert [tpl.id for tpl in list_templates()] == list(TEMPLATES.keys())


def test_audiovisual_production_template_matches_production_company_blueprint() -> None:
    tpl = resolve_template("audiovisual-production")
    assert tpl.label_fr == "Société de production audiovisuelle"
    assert tpl.default_theme_id == "black"
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
    # The payload names the theme by its alias, `real-black`; the plan holds the ThemeId it names.
    assert plan["theme_id"] == "black"
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
    assert plan["theme_id"] == "light"
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


# --- contract 0.42.0: proximity, its alias, and the theme vocabulary ----------------------------

ROOT = Path(__file__).resolve().parents[1]
THEMES = ("light", "dark", "black", "ciel", "ciel-nuit")
THEME_ALIASES = {"givre": "light", "ardoise": "dark", "real-black": "black"}
PROXIMITY_PAYLOAD = {
    "organizationName": "Maison de quartier",
    "slug": "maison-de-quartier",
    "hostingMode": "cloud",
    "templateId": "proximity",
}


def case_proximity_and_crisis_cell_are_one_template(module):
    canonical, alias = module.resolve_template("proximity"), module.resolve_template("crisis-cell")
    return (
        canonical is alias
        and canonical.id == "proximity"
        and module.canonical_template_id("proximity") == "proximity"
        and module.canonical_template_id("crisis-cell") == "proximity"
        and "crisis-cell" not in module.TEMPLATES
        and [tpl.id for tpl in module.list_templates()].count("proximity") == 1
    )


def case_the_proximity_template_has_exactly_one_default_channel(module):
    template = module.resolve_template("crisis-cell")
    return [(ch.template_key, ch.name, ch.kind) for ch in template.channels] == [
        ("proximity", "proximity", "text")
    ] and [category.key for category in template.categories] == ["proximity"]


def case_the_labels_are_display_labels_and_never_identifiers(module):
    template = module.resolve_template("proximity")
    return (
        template.label_en == "#proximity"
        and template.label_fr == "#proximité"
        and template.id.isascii()
        and all(ch.name.isascii() and ch.template_key.isascii() for ch in template.channels)
    )


def case_the_proximity_channel_says_it_is_not_an_emergency_service(module):
    [channel] = module.resolve_template("proximity").channels
    return (
        "not an emergency service" in channel.topic
        and "pas un service d'urgence" in channel.topic
        and len(channel.topic) <= 1024
    )


def case_every_theme_identifier_and_alias_names_one_theme(module):
    return (
        all(module.canonical_theme_id(theme) == theme for theme in THEMES)
        and all(module.canonical_theme_id(a) == theme for a, theme in THEME_ALIASES.items())
        and all(
            module.canonical_theme_id(other) is None
            for other in ("neon-pink", "", "Light", "ciel nuit", None, 7, ["light"])
        )
        and tuple(module.THEME_IDS) == THEMES
        and dict(module.THEME_ALIASES) == THEME_ALIASES
    )


def case_a_stored_plan_is_read_with_the_same_identifiers_as_a_claim(module):
    """Both sides of the warm-pool match go through one canonicalisation: a plan prepared under
    an alias equals the plan a claim sending the ThemeId builds, and the other way round."""
    for alias, theme in THEME_ALIASES.items():
        stored = {"theme_id": alias, "template_id": "tech-studio", "slug": "alpha", "channels": []}
        if module.canonical_plan(stored) != {**stored, "theme_id": theme}:
            return False
        if stored["theme_id"] != alias:  # the stored plan itself is never rewritten
            return False
    untouched = {"theme_id": "neon-pink", "template_id": "unknown", "slug": "alpha"}
    return (
        module.canonical_plan({"theme_id": "ciel", "template_id": "crisis-cell"})
        == {"theme_id": "ciel", "template_id": "proximity"}
        and module.canonical_plan(untouched) == untouched
        and module.canonical_plan(None) is None
        and module.canonical_plan([]) == []
    )


VOCABULARY_CASES = {
    case.__name__: case
    for case in (
        case_proximity_and_crisis_cell_are_one_template,
        case_the_proximity_template_has_exactly_one_default_channel,
        case_the_labels_are_display_labels_and_never_identifiers,
        case_the_proximity_channel_says_it_is_not_an_emergency_service,
        case_every_theme_identifier_and_alias_names_one_theme,
        case_a_stored_plan_is_read_with_the_same_identifiers_as_a_claim,
    )
}
# Each mutant replaces exactly one anchor in apps/workspaces/templates.py.
VOCABULARY_MUTATIONS = [
    (
        "the crisis-cell alias is removed",
        "case_proximity_and_crisis_cell_are_one_template",
        'TEMPLATE_ALIASES = {"crisis-cell": "proximity"}',
        "TEMPLATE_ALIASES: dict[str, str] = {}",
    ),
    (
        "the crisis-cell alias names another template",
        "case_proximity_and_crisis_cell_are_one_template",
        'TEMPLATE_ALIASES = {"crisis-cell": "proximity"}',
        'TEMPLATE_ALIASES = {"crisis-cell": "tech-studio"}',
    ),
    (
        "crisis-cell is a template of its own again",
        "case_proximity_and_crisis_cell_are_one_template",
        "\n\n\ndef resolve_template(template_id: str) -> WorkspaceTemplate:",
        '\nTEMPLATES["crisis-cell"] = TEMPLATES["tech-studio"]\n\n\n'
        "def resolve_template(template_id: str) -> WorkspaceTemplate:",
    ),
    (
        "a second default channel",
        "case_the_proximity_template_has_exactly_one_default_channel",
        "                PROXIMITY_NOT_AN_EMERGENCY_SERVICE,\n            ),\n",
        "                PROXIMITY_NOT_AN_EMERGENCY_SERVICE,\n            ),\n"
        '            ChannelBlueprint("proximity", "urgence", "urgence", Channel.Kind.TEXT),\n',
    ),
    (
        "the label is used as the channel's slug",
        "case_the_labels_are_display_labels_and_never_identifiers",
        '                "proximity",\n                "proximity",\n                "proximity",\n',
        '                "proximity",\n                "proximity",\n                "proximité",\n',
    ),
    (
        "the English label is dropped",
        "case_the_labels_are_display_labels_and_never_identifiers",
        '        label_en="#proximity",\n',
        "",
    ),
    (
        "the non-emergency notice is dropped",
        "case_the_proximity_channel_says_it_is_not_an_emergency_service",
        "                PROXIMITY_NOT_AN_EMERGENCY_SERVICE,\n            ),\n",
        '                "",\n            ),\n',
    ),
    (
        "a theme alias is removed",
        "case_every_theme_identifier_and_alias_names_one_theme",
        '{"givre": "light", "ardoise": "dark", "real-black": "black"}',
        '{"ardoise": "dark", "real-black": "black"}',
    ),
    (
        "a theme alias names another theme",
        "case_every_theme_identifier_and_alias_names_one_theme",
        '{"givre": "light", "ardoise": "dark", "real-black": "black"}',
        '{"givre": "dark", "ardoise": "dark", "real-black": "black"}',
    ),
    (
        "a ThemeId is refused",
        "case_every_theme_identifier_and_alias_names_one_theme",
        'THEME_IDS = ("light", "dark", "black", "ciel", "ciel-nuit")',
        'THEME_IDS = ("light", "dark", "black", "ciel")',
    ),
    (
        "any string is a theme",
        "case_every_theme_identifier_and_alias_names_one_theme",
        "    return theme_id if theme_id in THEME_IDS else None\n",
        "    return theme_id\n",
    ),
    (
        "a stored plan keeps its theme alias",
        "case_a_stored_plan_is_read_with_the_same_identifiers_as_a_claim",
        '    if theme_id is not None:\n        canonical["theme_id"] = theme_id\n',
        "",
    ),
    (
        "a stored plan keeps its template alias",
        "case_a_stored_plan_is_read_with_the_same_identifiers_as_a_claim",
        '    if template_id is not None:\n        canonical["template_id"] = template_id\n',
        "",
    ),
    (
        "reading a stored plan rewrites it",
        "case_a_stored_plan_is_read_with_the_same_identifiers_as_a_claim",
        "    canonical = dict(plan)\n",
        "    canonical = plan\n",
    ),
]


def vocabulary_mutant(before: str, after: str) -> SimpleNamespace:
    source = (ROOT / "apps/workspaces/templates.py").read_text()
    assert source.count(before) == 1, f"mutation anchor moved: {before!r}"
    namespace: dict[str, object] = {
        "__name__": "apps.workspaces.templates",
        "__package__": "apps.workspaces",
    }
    exec(compile(source.replace(before, after), "<templates-mutant>", "exec"), namespace)  # noqa: S102 - owned source mutation only
    return SimpleNamespace(**namespace)


@pytest.mark.parametrize("name", sorted(VOCABULARY_CASES))
def test_vocabulary_case_holds(name):
    assert VOCABULARY_CASES[name](templates), name


@pytest.mark.parametrize(
    ("owner", "before", "after"),
    [mutation[1:] for mutation in VOCABULARY_MUTATIONS],
    ids=[mutation[0] for mutation in VOCABULARY_MUTATIONS],
)
def test_each_vocabulary_rule_has_a_case_that_catches_its_mutant(owner, before, after):
    assert VOCABULARY_CASES[owner](templates), "the owning case must hold on the real module"
    mutated = vocabulary_mutant(before, after)
    try:
        held = VOCABULARY_CASES[owner](mutated)
    except mutated.UnknownWorkspaceTemplateError:
        held = False  # the mutant refuses an identifier the contract accepts
    assert not held, f"{owner} did not catch its mutant"


@pytest.mark.parametrize("template_id", ["proximity", "crisis-cell"])
def test_a_claim_names_the_proximity_template_by_either_identifier(template_id):
    request = _parse({**PROXIMITY_PAYLOAD, "templateId": template_id})
    assert request.template_id == "proximity"
    plan = build_instant_claim_plan(request)
    assert plan == build_instant_claim_plan(_parse(PROXIMITY_PAYLOAD))
    assert plan["template_id"] == "proximity" and plan["template_label_fr"] == "#proximité"
    assert [(ch["template_key"], ch["name"], ch["kind"]) for ch in plan["channels"]] == [
        ("proximity", "proximity", "text")
    ]
    assert plan["theme_id"] == "black" and plan["enabled_connectors"] == []
    response = build_instant_claim_response(
        request,
        workspace_id="ws-1",
        workspace_url="https://maison-de-quartier.kodera.io",
        invitation_url="https://maison-de-quartier.kodera.io/invite?signed=tok",
    )
    assert response["channels"] == [{"id": "proximity", "name": "proximity", "kind": "text"}]


@pytest.mark.parametrize("theme", THEMES)
def test_a_claim_accepts_each_of_the_five_theme_identifiers(theme):
    assert _parse({**VALID_CLAIM_PAYLOAD, "themeId": theme}).theme_id == theme


@pytest.mark.parametrize(("alias", "theme"), sorted(THEME_ALIASES.items()))
def test_a_claim_reads_a_theme_alias_as_the_theme_it_names(alias, theme):
    by_alias = _parse({**VALID_CLAIM_PAYLOAD, "themeId": alias})
    by_theme = _parse({**VALID_CLAIM_PAYLOAD, "themeId": theme})
    assert by_alias == by_theme and by_alias.theme_id == theme
    assert build_instant_claim_plan(by_alias) == build_instant_claim_plan(by_theme)
    # A request built with an alias by anything but the parser still plans the ThemeId.
    direct = InstantClaimRequest(**{**_fields(by_theme), "theme_id": alias})
    assert build_instant_claim_plan(direct)["theme_id"] == theme


def _fields(request: InstantClaimRequest) -> dict:
    return {name: getattr(request, name) for name in InstantClaimRequest.__slots__}


def test_every_template_default_theme_is_a_theme_identifier_never_an_alias():
    for tpl in list_templates():
        assert tpl.default_theme_id in THEMES, tpl.id
    assert (
        _parse({k: v for k, v in VALID_CLAIM_PAYLOAD.items() if k != "themeId"}).theme_id in THEMES
    )


@pytest.mark.parametrize("value", ["Light", "LIGHT", "sky", "ciel_nuit", "real_black", "", 3])
def test_a_claim_refuses_what_is_neither_a_theme_nor_an_alias(value):
    assert _errors({**VALID_CLAIM_PAYLOAD, "themeId": value}) == [("/themeId", "invalid")]


def test_the_server_vocabularies_are_the_contracts():
    import yaml

    schemas = yaml.safe_load((ROOT / "contracts/core-api.openapi.yaml").read_text())["components"][
        "schemas"
    ]
    assert tuple(schemas["ThemeId"]["enum"]) == templates.THEME_IDS
    assert schemas["ThemeIdAlias"]["enum"] == list(templates.THEME_ALIASES)
    accepted = schemas["InstantClaimTenantRequest"]["properties"]["themeId"]["enum"]
    assert accepted == [*templates.THEME_IDS, *templates.THEME_ALIASES]
    assert schemas["WorkspaceTemplateId"]["enum"] == [*TEMPLATES, *templates.TEMPLATE_ALIASES]
