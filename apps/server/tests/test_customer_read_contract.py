"""Wire-domain compatibility for the actual hand-authored customer contract."""

import hashlib
import json
import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def contract():
    return yaml.safe_load((ROOT / "contracts/core-api.openapi.yaml").read_text())


@pytest.mark.parametrize(
    "name",
    [
        "RealmDiscoveryRequest",
        "OrganisationSummary",
        "Organisation",
        "OrganisationCreateRequest",
        "OrganisationBootstrap",
    ],
)
@pytest.mark.parametrize(
    "value,accepted",
    [
        ("abcde", True),
        ("a" * 20, True),
        ("a-b-c", True),
        ("abcd", False),
        ("a" * 21, False),
        ("-abcd", False),
        ("abcd-", False),
        ("ab_cd", False),
        ("Abcde", False),
        ("abcdé", False),
        ("abcde\n", False),
    ],
)
def test_actual_organisation_slug_wire_domain(contract, name, value, accepted):
    schema = contract["components"]["schemas"][name]["properties"]["slug"]
    valid = (
        re.search(schema["pattern"], value) is not None
        and len(value) >= schema.get("minLength", 0)
        and len(value) <= schema.get("maxLength", len(value))
    )
    assert valid is accepted, "organisation slug wire domain disagrees with persisted realm domain"


def test_tenant_and_order_domains_remain_byte_semantically_unchanged(contract):
    # Baseline 0.10.0: tenant slug 3-32 on the order, the tenant, the availability query and its answer.
    # Re-pinned at 0.11.0 for one example value only: `Tenant`'s example `realm`, the organisation
    # slug, is `acme-sa` under the organisation minimum of five; the tenant slug stays `acme`.
    # Re-pinned at 0.16.1: billing prose (Core issues the invoice; no provider named) and provider-neutral examples
    # Re-pinned at 0.17.0: OrderRequest.legal_acceptances (required) and LegalAcceptance; generateDpa declares 422; the workspace order step
    # Re-pinned at 0.18.1: Tenant.region description only, the European Union hosting promise (ADR-0017); enum unchanged
    # Re-pinned at 0.21.0 (2026-10-22): legal texts at their permanent URL on api.kodera.io, getLegalDocumentText declares 400, Sentry removed (decision O4), DunningView.ladder deprecated
    # Re-pinned at 0.25.1: ordered cancellation and deleted-state prose require canonical never-provisioned evidence and preserve the ProjectBootstrap operator boundary; wire shapes stay unchanged
    # Re-pinned at 0.28.0: checkSlugAvailability declares 403 (forbidden, identity-unknown); no Order, Tenant or Slug schema changed
    # Re-pinned at 0.30.0: TenantStatusView.capacity is CapacityGauge or null (only measured numbers are published)
    # Re-pinned at 0.32.2: checkSlugAvailability's description says its rate limit is not enforced yet; no schema changed
    # Re-pinned at 0.35.0: TenantCreation and TenantCreated are new (createTenant), TenantCreation.name described; no existing Order, Tenant or Slug schema changed
    # Re-pinned at 0.37.1: TenantCreation.name's description names every refused class; no schema changed
    # Re-pinned at 0.38.0: SlugAvailability.reason states the reserved tenant slugs, platform labels and the errors and ops-admin hosts added; no shape changed
    schemas = contract["components"]["schemas"]
    values = {n: s for n, s in schemas.items() if n.startswith(("Order", "Tenant", "Slug"))}
    values["availability_path"] = contract["paths"]["/slug-availability"]
    digest = hashlib.sha256(
        json.dumps(values, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    assert digest == "dce9efd45bd78bfdccebf1e99734c1ff77b74302c9f60c6d3562f1526378a335"


def test_decommissioning_keeps_only_the_bounded_recovery_export_lane(contract):
    description = " ".join(contract["components"]["schemas"]["TenantStatus"]["description"].split())
    assert (
        "`decommissioning` | bounded read-only recovery window; ordinary access and mutations "
        "are disabled; no current API operation admits an exit export, while the future lane "
        "uses top-level jobs under a shared tenant lock until admission closes"
    ) in description
    assert (
        "future cutoff after the recovery end or a validated earlier-deletion instruction; "
        "`delete` destroys active stores, then a durable finalizer signs the initial attestation "
        "and changes status once cutoff evidence is sealed"
    ) in description
    assert (
        "`deleted` | initial deletion attestation signed; active stores were destroyed, or an "
        "ordered cancellation proved canonically that no workload/data store was provisioned "
        "and, when any lifetime ProjectBootstrap boundary existed, independently verified "
        "retirement and absence of every scoped project/application/policy/key before finalization"
    ) in description
    cancellation = " ".join(
        contract["paths"]["/orders/{order_id}/actions/cancel"]["post"]["description"].split()
    )
    for clause in (
        "proves no tenant workload or data store was provisioned",
        "canonical empty backup/export manifests",
        "permanent ordered-cancellation fence before inspecting any bootstrap row",
        "bootstrap record/verify and provisioning take the same lock",
        "`never_provisioned` attestation bound to this cancelled order only when no lifetime ProjectBootstrap row ever existed",
        "any recorded, verified, expired or replaced bootstrap exists",
        "immutable scope covers every historical provider project/application/policy/key boundary",
        "leaves the tenant `ordered`",
        "issues no attestation and does not enter `deleted`",
        "independent authenticated verifier seals exact absence evidence for the complete scope",
        "unbounded cleanup finalizer issue the attestation",
    ):
        assert clause in cancellation
    audit_description = " ".join(
        contract["components"]["schemas"]["AuditEvent"]["description"].split()
    )
    for action in (
        "tenant.ordered_cancellation_cleanup_recorded",
        "tenant.ordered_cancellation_cleanup_closed",
        "tenant.ordered_cancellation_cleanup_verified",
        "tenant.ordered_cancellation_cleanup_finalized",
    ):
        assert f"`{action}`" in audit_description
    assert contract["components"]["schemas"]["TenantStatus"]["enum"] == [
        "ordered",
        "provisioning",
        "ready",
        "active",
        "upgrading",
        "maintenance",
        "suspended",
        "decommissioning",
        "deleted",
        "failed",
    ]


def test_identity_mfa_enrolled_is_the_bounded_current_local_totp_fact(contract):
    identity = contract["components"]["schemas"]["Identity"]
    described = " ".join(identity["properties"]["mfa_enrolled"]["description"].split()).lower()
    assert "exact current identity" in described
    assert "signed local-totp registration fact" in described
    assert "strict `false` means no qualifying local totp" in described
    assert "omission means unknown" in described
    assert "passkey" not in described


# The two decided slug rules (docs/api/CONVENTIONS.md §4): the organisation slug,
# the realm name, is 5–20 characters, the owner's minimum (register row
# SLUG-MIN-ANSWER); the tenant slug, the DNS label and Scaleway project name, is
# 3–32 (register row TENANT-SLUG). Spelled literally here rather than read from the
# contract, so a change to `Tenant.slug` itself is a disagreement, not a new
# baseline.
ORGANISATION_SLUG_PATTERN = r"^[a-z0-9][a-z0-9-]{3,18}[a-z0-9](?![\s\S])"
TENANT_SLUG_PATTERN = r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9](?![\s\S])"
SLUG_RULES = {"organisation": ORGANISATION_SLUG_PATTERN, "tenant": TENANT_SLUG_PATTERN}
SLUG_CASES = {
    "organisation": [
        ("abcde", True),
        ("a" * 20, True),
        ("a-b-c", True),
        ("abcd", False),
        ("a" * 21, False),
        ("-abcd", False),
        ("abcd-", False),
        ("ab_cd", False),
        ("Abcde", False),
        ("abcde\n", False),
    ],
    "tenant": [
        ("abc", True),
        ("a" * 32, True),
        ("a-b", True),
        ("ab", False),
        ("a" * 33, False),
        ("-abc", False),
        ("abc-", False),
        ("a_bc", False),
        ("Abc", False),
        ("abc\n", False),
    ],
}

# A field carries a slug when its pattern has the slug shape, whatever its
# bounds and however its repetition is grouped, or when its property, parameter
# or header name says so, in any case and any spelling (`org_slug`,
# `organisationSlug`, `X-Organisation-Slug`): `slug` or `slugs`, a name that
# joins `tenant`, `organisation` or the word `org` with `slug`, or the bare
# entity name `tenant`, `organisation` or `org` (the agent contract's
# `Heartbeat.tenant` and `ConfigBundle.tenant` are tenant slugs by that name
# alone). `org` counts only as a whole word, so `forge` or `organic` never names
# an organisation. A named field that is an object is not a slug, and its
# properties are walked instead; a named array's slug is its `items`; a named
# `oneOf`, `anyOf` or `allOf` puts each branch under the name. A parameter or a
# header is the field its name names, whether it declares `schema` or `content`.
# `JobTriggerRequest.parameters.confirm_slug` is a retyped confirmation that
# carries neither a pattern nor any of those names, so it is outside this rule by
# name.
#
# Known and not walked: `realm` is not a slug name, so the realm fields are a
# blind spot of the same kind, and narrowing them is a contract decision of its
# own; nor are `propertyNames`, `patternProperties` or `prefixItems`, which
# neither contract uses.
SLUG_SHAPED_PATTERN = re.compile(r"\[a-z0-9\]\(?(\?:)?\[a-z0-9-\]")
ORG_WORD = r"(?<![a-z0-9])orgs?(?![a-z0-9])"
SLUG_NAME = re.compile(
    rf"^slugs?$|^(tenant|organi[sz]ation|org)s?$|(?=.*(tenant|organi[sz]ation|{ORG_WORD}))(?=.*slug)",
    re.IGNORECASE,
)
TENANT_WORD = re.compile(r"tenant|slug[-_]?availability", re.IGNORECASE)
ORGANISATION_WORD = re.compile(rf"organi[sz]ation|realm|{ORG_WORD}", re.IGNORECASE)
# Values under these keywords are data or prose, never a field. A property may
# carry one of these names, so the rule never applies inside `properties`.
NOT_A_SCHEMA = {"example", "examples", "default", "enum", "const", "description", "summary"}
BRANCHES = ("oneOf", "anyOf", "allOf")

# The locations the walk must at least find, so a walk that finds nothing
# cannot pass: the eight tenant fields and five organisation fields contract
# 0.10.0 carries.
TENANT_SLUG_LOCATIONS = (
    ("core-api", ("paths", "/slug-availability", "get", "parameters", 0, "schema")),
    ("core-api", ("components", "schemas", "Tenant", "properties", "slug")),
    (
        "core-api",
        ("components", "schemas", "OrderRequest", "properties", "tenant", "properties", "slug"),
    ),
    ("core-api", ("components", "schemas", "SlugAvailability", "properties", "slug")),
    (
        "core-api",
        ("components", "schemas", "SlugAvailability", "properties", "suggestions", "items"),
    ),
    (
        "core-api",
        (
            "components",
            "schemas",
            "SupportTicket",
            "properties",
            "tenant_context",
            "properties",
            "tenant_slug",
        ),
    ),
    ("agent-api", ("components", "schemas", "Heartbeat", "properties", "tenant")),
    ("agent-api", ("components", "schemas", "ConfigBundle", "properties", "tenant")),
)
ORGANISATION_SLUG_LOCATIONS = tuple(
    ("core-api", ("components", "schemas", name, "properties", "slug"))
    for name in (
        "RealmDiscoveryRequest",
        "Organisation",
        "OrganisationCreateRequest",
        "OrganisationSummary",
        "OrganisationBootstrap",
    )
)


def load_contracts():
    return {
        name: yaml.safe_load((ROOT / f"contracts/{name}.openapi.yaml").read_text())
        for name in ("core-api", "agent-api")
    }


def words(name):
    """A name with its camel-case humps split by `_`, so `orgSlug` reads as `org_Slug`."""
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name)


def slug_named(name):
    return isinstance(name, str) and SLUG_NAME.search(words(name)) is not None


def pointer_text(contract_name, pointer):
    return f"{contract_name} {'/'.join(str(step) for step in pointer)}"


def classify_slug(context):
    """Which rule a slug field is under, and the token that decided it.

    Read from the field's context innermost first. A token that names a tenant
    puts the field under the tenant rule; one that names an organisation, or its
    realm (ADR-0006: the realm name is the organisation slug), under the
    organisation rule. `checkSlugAvailability` checks a tenant slug
    (contracts/CONSOLE_RECONCILIATION.md §6.5). Path templates are read segment
    by segment so the nearest resource wins. A token that names both, such as
    `OrganisationTenantLink`, decides nothing: the rule is "ambiguous", which is
    a problem to report, never a guess.
    """
    tokens = [
        segment
        for step in reversed(context)
        if isinstance(step, str)
        for segment in reversed(step.split("/"))
    ]
    for token in tokens:
        rules = {
            rule
            for rule, word in (("tenant", TENANT_WORD), ("organisation", ORGANISATION_WORD))
            if word.search(words(token))
        }
        if len(rules) > 1:
            return "ambiguous", token
        if rules:
            return rules.pop(), token
    return None, None


def resolve(contract_name, contract, node):
    """The schema a chain of local `$ref`s ends at, and the schemas the chain passed through."""
    through = []
    seen = set()
    while isinstance(node, dict) and isinstance(node.get("$ref"), str):
        ref = node["$ref"]
        if not ref.startswith("#/"):
            break
        assert ref not in seen, f"{contract_name} $ref cycle through {ref}"
        seen.add(ref)
        steps = [step.replace("~1", "/").replace("~0", "~") for step in ref[2:].split("/")]
        node = contract
        for step in steps:
            node = node[step]
        through.append(pointer_text(contract_name, steps))
    return node, tuple(through)


def schema_kind(schema):
    """What a named field's schema is: a slug value, or a container that holds one."""
    if "pattern" in schema:
        return "value"
    types = schema.get("type")
    types = set(types) if isinstance(types, list) else {types} - {None}
    if "items" in schema or "array" in types:
        return "array"
    if any(branch in schema for branch in BRANCHES):
        return "branches"
    if "properties" in schema or "object" in types:
        return "object"
    if types == {"null"}:
        return "null"
    return "value"


def slug_fields(contracts):
    """Every slug-carrying field in the contracts.

    Each is (where, rule, token, schema, through): `rule` is "tenant",
    "organisation", "ambiguous" or None, `token` the context word that decided it,
    and `through` the `$ref` targets passed to reach `schema`, outermost first.
    """
    fields = []

    def record(contract_name, pointer, context, schema, through):
        rule, token = classify_slug(context)
        fields.append((pointer_text(contract_name, pointer), rule, token, schema, through))

    def walk_named_value(contract_name, contract, name, node, pointer, context, via=()):
        """A parameter or a header object: `name` names its `schema`, or each `content` schema."""
        context = (*context, name)
        named = slug_named(name)
        for key, child in node.items():
            if key in NOT_A_SCHEMA:
                continue
            if key == "content" and isinstance(child, dict):
                for media, entry in child.items():
                    if not isinstance(entry, dict):
                        continue
                    for entry_key, value in entry.items():
                        if entry_key in NOT_A_SCHEMA:
                            continue
                        step = ("content", media, entry_key)
                        walk(
                            contract_name,
                            contract,
                            value,
                            (*pointer, *step),
                            (*context, *step),
                            named and entry_key == "schema",
                            via=via,
                        )
                continue
            walk(
                contract_name,
                contract,
                child,
                (*pointer, key),
                (*context, key),
                named and key == "schema",
                via=via,
            )

    def walk(
        contract_name, contract, node, pointer, context, named=False, properties=False, via=()
    ):
        if isinstance(node, list):
            for index, child in enumerate(node):
                walk(
                    contract_name,
                    contract,
                    child,
                    (*pointer, index),
                    (*context, index),
                    named,
                    via=via,
                )
            return
        if not isinstance(node, dict):
            return
        if properties:
            # A `properties` map: every key is a property name, whatever it spells.
            for name, child in node.items():
                walk(
                    contract_name,
                    contract,
                    child,
                    (*pointer, name),
                    (*context, name),
                    slug_named(name),
                    via=via,
                )
            return
        if (
            isinstance(node.get("name"), str)
            and "in" in node
            and (isinstance(node.get("schema"), dict) or isinstance(node.get("content"), dict))
        ):
            # A parameter, a header one included: its name is the field's name.
            walk_named_value(contract_name, contract, node["name"], node, pointer, context, via)
            return
        schema, own_through = resolve(contract_name, contract, node)
        through = (*via, *own_through)
        pattern = schema.get("pattern")
        shaped = isinstance(pattern, str) and SLUG_SHAPED_PATTERN.search(pattern) is not None
        kind = schema_kind(schema) if named else None
        if kind == "value" or (not named and shaped):
            record(contract_name, pointer, context, schema, through)
        for key, child in node.items():
            if key in NOT_A_SCHEMA:
                continue
            if key == "headers" and isinstance(child, dict):
                # A response's, an encoding's or the components' header map: each key is a
                # header name, and a `$ref`'d header is judged under the name that refers to it.
                for header, value in child.items():
                    target, header_through = resolve(contract_name, contract, value)
                    if isinstance(target, dict) and isinstance(header, str):
                        walk_named_value(
                            contract_name,
                            contract,
                            header,
                            target,
                            (*pointer, key, header),
                            (*context, key),
                            (*via, *header_through),
                        )
                continue
            child_named = (kind == "array" and key == "items") or (
                kind == "branches" and key in BRANCHES
            )
            walk(
                contract_name,
                contract,
                child,
                (*pointer, key),
                (*context, key),
                child_named,
                key == "properties",
                via=via,
            )
        if own_through and kind in ("array", "branches"):
            # A named `$ref` to an array or to branches: the slug is in the target,
            # which is walked unnamed where it is defined, so walk its parts here
            # under the referring name.
            for key in ("items",) if kind == "array" else BRANCHES:
                if key in schema:
                    walk(
                        contract_name,
                        contract,
                        schema[key],
                        (*pointer, key),
                        (*context, key),
                        True,
                        via=through,
                    )

    for contract_name, contract in contracts.items():
        walk(contract_name, contract, contract, (), ())
    return fields


def slug_rule_problems(contracts):
    """Every slug field whose pattern is not the rule its context puts it under."""
    problems = []
    for where, rule, token, schema, through in slug_fields(contracts):
        pattern = schema.get("pattern")
        carries = f"pattern {pattern!r}" if pattern is not None else "no pattern"
        if through:
            # The field refers to its schema: name both the field and where the
            # pattern, or its absence, really is.
            carries = f"{carries} through $ref to {' then '.join(through)}"
        if rule is None:
            problems.append(
                f"{where} carries a slug ({carries}) but its context names neither a "
                "tenant nor an organisation, so no rule applies: name the schema or property "
                "for one of them"
            )
        elif rule == "ambiguous":
            problems.append(
                f"{where} carries a slug ({carries}) but {token!r}, the context word that "
                "decides its rule, names both a tenant and an organisation: name the schema "
                "or property for one of them"
            )
        elif pattern != SLUG_RULES[rule]:
            problems.append(
                f"{where} ({rule} slug) carries {carries}, not the {rule} rule {SLUG_RULES[rule]!r}"
            )
    return problems


def slug_admits(schema, value):
    pattern = schema.get("pattern")
    return (
        (pattern is None or re.search(pattern, value) is not None)
        and len(value) >= schema.get("minLength", 0)
        and len(value) <= schema.get("maxLength", len(value))
    )


def test_every_slug_field_in_both_contracts_carries_the_rule_its_context_names():
    contracts = load_contracts()
    fields = slug_fields(contracts)
    found = {where for where, *_ in fields}
    expected = {
        pointer_text(name, pointer)
        for name, pointer in (*TENANT_SLUG_LOCATIONS, *ORGANISATION_SLUG_LOCATIONS)
    }
    assert expected <= found, "the walk no longer finds: " + "; ".join(sorted(expected - found))
    problems = slug_rule_problems(contracts)
    assert problems == [], "\n".join(problems)


def test_every_slug_field_admits_and_refuses_the_values_its_rule_decides():
    problems = []
    for where, rule, _, schema, _ in slug_fields(load_contracts()):
        assert rule in SLUG_RULES, where
        for value, accepted in SLUG_CASES[rule]:
            if slug_admits(schema, value) is not accepted:
                verb = "refuses" if accepted else "accepts"
                problems.append(f"{where} ({rule} slug) {verb} {value!r}")
    assert problems == [], "; ".join(problems)


WIDER = r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9](?![\s\S])"
# The same bounds spelled with a group, as apps/orgs/models.py spells the organisation rule.
GROUPED_WIDER = r"^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])$"


def with_schema(contracts, contract_name, schema_name, schema):
    contracts[contract_name]["components"]["schemas"][schema_name] = schema
    return contracts


def with_property(contracts, contract_name, schema_name, property_name, schema):
    properties = contracts[contract_name]["components"]["schemas"][schema_name]["properties"]
    properties[property_name] = schema
    return contracts


def with_path(contracts, path, item):
    contracts["core-api"]["paths"][path] = item
    return contracts


def with_header(contracts, name, header):
    contracts["core-api"]["components"]["headers"][name] = header
    return contracts


def widget_get(**operation):
    return {"get": {"responses": {"200": {"description": "Widgets."}}, **operation}}


SLUG_RULE_MUTATIONS = [
    pytest.param(
        lambda c: with_schema(
            c, "core-api", "TenantProbe", {"properties": {"slug": {"pattern": WIDER}}}
        ),
        f"core-api components/schemas/TenantProbe/properties/slug (tenant slug) carries pattern "
        f"{WIDER!r}, not the tenant rule {TENANT_SLUG_PATTERN!r}",
        id="a-new-tenant-schema-with-a-wider-slug",
    ),
    pytest.param(
        lambda c: with_schema(
            c, "core-api", "Widget", {"properties": {"tenant_slug": {"pattern": WIDER}}}
        ),
        "core-api components/schemas/Widget/properties/tenant_slug (tenant slug) carries pattern",
        id="a-tenant-slug-property-under-an-unrelated-schema",
    ),
    pytest.param(
        lambda c: with_schema(
            c,
            "core-api",
            "OrganisationProbe",
            {"properties": {"slug": {"pattern": TENANT_SLUG_PATTERN}}},
        ),
        "core-api components/schemas/OrganisationProbe/properties/slug (organisation slug) "
        f"carries pattern {TENANT_SLUG_PATTERN!r}, not the organisation rule",
        id="a-new-organisation-schema-with-the-tenant-slug",
    ),
    pytest.param(
        lambda c: with_schema(
            c, "core-api", "Tenant", {"properties": {"slug": {"type": "string", "maxLength": 32}}}
        ),
        "core-api components/schemas/Tenant/properties/slug (tenant slug) carries no pattern",
        id="a-tenant-slug-without-a-pattern",
    ),
    pytest.param(
        lambda c: with_schema(
            c, "core-api", "Widget", {"properties": {"slug": {"pattern": TENANT_SLUG_PATTERN}}}
        ),
        "core-api components/schemas/Widget/properties/slug carries a slug (pattern",
        id="a-slug-nobody-can-classify",
    ),
    pytest.param(
        lambda c: with_schema(
            c, "agent-api", "ConfigBundle", {"properties": {"tenant": {"pattern": WIDER}}}
        ),
        "agent-api components/schemas/ConfigBundle/properties/tenant (tenant slug) carries pattern",
        id="a-wider-tenant-in-the-agent-contract",
    ),
    pytest.param(
        lambda c: with_path(
            c,
            "/widgets/{tenant_slug}",
            {
                "get": {
                    "parameters": [
                        {"name": "tenant_slug", "in": "path", "schema": {"type": "string"}}
                    ]
                }
            },
        ),
        "core-api paths//widgets/{tenant_slug}/get/parameters/0/schema (tenant slug) carries no pattern",
        id="a-tenant-slug-parameter-without-a-pattern",
    ),
    pytest.param(
        lambda c: (
            with_schema(
                c,
                "core-api",
                "TenantRef",
                {"properties": {"slug": {"$ref": "#/components/schemas/TenantSlugValue"}}},
            )
            and with_schema(c, "core-api", "TenantSlugValue", {"pattern": WIDER})
        ),
        # The referring property names where the pattern is; the referenced schema is named too.
        "core-api components/schemas/TenantRef/properties/slug (tenant slug) carries pattern "
        f"{WIDER!r} through $ref to core-api components/schemas/TenantSlugValue, not the tenant rule"
        "\ncore-api components/schemas/TenantSlugValue (tenant slug) carries pattern "
        f"{WIDER!r}, not the tenant rule",
        id="a-tenant-slug-referencing-a-wider-pattern",
    ),
    pytest.param(
        lambda c: (
            with_schema(
                c,
                "core-api",
                "TenantRef",
                {"properties": {"slug": {"$ref": "#/components/schemas/TenantSlugAlias"}}},
            )
            and with_schema(
                c, "core-api", "TenantSlugAlias", {"$ref": "#/components/schemas/TenantSlugValue"}
            )
            and with_schema(c, "core-api", "TenantSlugValue", {"pattern": WIDER})
        ),
        # Two levels: each referrer names the whole chain down to the schema that carries it.
        "core-api components/schemas/TenantRef/properties/slug (tenant slug) carries pattern "
        f"{WIDER!r} through $ref to core-api components/schemas/TenantSlugAlias then core-api "
        "components/schemas/TenantSlugValue, not the tenant rule"
        "\ncore-api components/schemas/TenantSlugAlias (tenant slug) carries pattern "
        f"{WIDER!r} through $ref to core-api components/schemas/TenantSlugValue, not the tenant rule"
        "\ncore-api components/schemas/TenantSlugValue (tenant slug) carries pattern "
        f"{WIDER!r}, not the tenant rule",
        id="a-tenant-slug-through-two-refs-names-the-chain",
    ),
    pytest.param(
        lambda c: with_schema(
            c,
            "agent-api",
            "Metrics",
            {"properties": {"tenant": {"type": "string", "maxLength": 63}}},
        ),
        "agent-api components/schemas/Metrics/properties/tenant (tenant slug) carries no pattern",
        id="an-agent-tenant-named-by-the-entity-alone-without-a-pattern",
    ),
    pytest.param(
        lambda c: with_property(
            c, "core-api", "SupportTicket", "organisation", {"type": ["string", "null"]}
        ),
        "core-api components/schemas/SupportTicket/properties/organisation (organisation slug) "
        "carries no pattern",
        id="an-organisation-named-by-the-entity-alone-without-a-pattern",
    ),
    pytest.param(
        lambda c: with_property(
            c,
            "core-api",
            "SupportTicket",
            "tenant",
            {"oneOf": [{"type": "string"}, {"type": "null"}]},
        ),
        # Each branch is under the name; the `null` branch is not a slug.
        "core-api components/schemas/SupportTicket/properties/tenant/oneOf/0 (tenant slug) carries "
        "no pattern",
        id="a-named-oneof-puts-each-branch-under-the-name",
    ),
    pytest.param(
        lambda c: with_schema(
            c,
            "agent-api",
            "TenantMetrics",
            {"properties": {"description": {"type": "string", "pattern": WIDER}}},
        ),
        "agent-api components/schemas/TenantMetrics/properties/description (tenant slug) "
        f"carries pattern {WIDER!r}",
        id="a-property-named-like-a-keyword-is-still-walked",
    ),
    pytest.param(
        lambda c: with_schema(
            c,
            "agent-api",
            "OrganisationTenantLink",
            {"properties": {"slug": {"type": "string", "pattern": TENANT_SLUG_PATTERN}}},
        ),
        "agent-api components/schemas/OrganisationTenantLink/properties/slug carries a slug "
        f"(pattern {TENANT_SLUG_PATTERN!r}) but 'OrganisationTenantLink', the context word that "
        "decides its rule, names both a tenant and an organisation",
        id="a-context-word-naming-both-is-reported-not-guessed",
    ),
    pytest.param(
        lambda c: with_property(
            c, "core-api", "Tenant", "slugs", {"type": "array", "items": {"type": "string"}}
        ),
        "core-api components/schemas/Tenant/properties/slugs/items (tenant slug) carries no pattern",
        id="a-named-array-of-slugs-without-a-pattern",
    ),
    pytest.param(
        lambda c: (
            with_property(
                c, "core-api", "Tenant", "slugs", {"$ref": "#/components/schemas/TenantSlugList"}
            )
            and with_schema(
                c, "core-api", "TenantSlugList", {"type": "array", "items": {"type": "string"}}
            )
        ),
        "core-api components/schemas/Tenant/properties/slugs/items (tenant slug) carries no pattern",
        id="a-named-ref-to-an-array-of-slugs-without-a-pattern",
    ),
    pytest.param(
        lambda c: with_property(
            c,
            "agent-api",
            "Heartbeat",
            "tenant_label",
            {"type": "string", "pattern": GROUPED_WIDER},
        ),
        "agent-api components/schemas/Heartbeat/properties/tenant_label (tenant slug) carries "
        f"pattern {GROUPED_WIDER!r}",
        id="a-grouped-slug-pattern-under-an-unnamed-property",
    ),
    pytest.param(
        lambda c: with_schema(
            c, "core-api", "Widget", {"properties": {"org_slug": {"type": "string"}}}
        ),
        "core-api components/schemas/Widget/properties/org_slug (organisation slug) carries no pattern",
        id="an-org-slug-without-a-pattern",
    ),
    pytest.param(
        lambda c: with_schema(c, "core-api", "Widget", {"properties": {"org": {"type": "string"}}}),
        "core-api components/schemas/Widget/properties/org (organisation slug) carries no pattern",
        id="an-org-named-by-the-entity-word-alone-without-a-pattern",
    ),
    pytest.param(
        lambda c: with_schema(
            c, "core-api", "Widget", {"properties": {"organisationSlug": {"type": "string"}}}
        ),
        "core-api components/schemas/Widget/properties/organisationSlug (organisation slug) "
        "carries no pattern",
        id="a-camel-case-organisation-slug-without-a-pattern",
    ),
    pytest.param(
        lambda c: with_schema(
            c, "core-api", "Widget", {"properties": {"orgSlug": {"type": "string"}}}
        ),
        "core-api components/schemas/Widget/properties/orgSlug (organisation slug) carries no pattern",
        id="a-camel-case-org-slug-without-a-pattern",
    ),
    pytest.param(
        lambda c: with_schema(
            c,
            "core-api",
            "ForgeWidget",
            {
                "properties": {
                    "slug": {"type": "string", "pattern": TENANT_SLUG_PATTERN},
                    "forge_slug": {"type": "string"},
                }
            },
        ),
        # `org` inside `forge` names nothing: the slug is unclassified, and `forge_slug` is no slug.
        "core-api components/schemas/ForgeWidget/properties/slug carries a slug (pattern",
        id="org-inside-another-word-names-no-organisation",
    ),
    pytest.param(
        lambda c: with_schema(
            c,
            "core-api",
            "OrgTenantLink",
            {"properties": {"slug": {"type": "string", "pattern": TENANT_SLUG_PATTERN}}},
        ),
        "core-api components/schemas/OrgTenantLink/properties/slug carries a slug (pattern "
        f"{TENANT_SLUG_PATTERN!r}) but 'OrgTenantLink', the context word that decides its rule, "
        "names both a tenant and an organisation",
        id="org-and-tenant-in-one-context-word-is-reported-not-guessed",
    ),
    pytest.param(
        lambda c: with_path(
            c,
            "/widgets",
            widget_get(
                parameters=[
                    {"name": "X-Organisation-Slug", "in": "header", "schema": {"type": "string"}}
                ]
            ),
        ),
        "core-api paths//widgets/get/parameters/0/schema (organisation slug) carries no pattern",
        id="a-header-parameter-without-a-pattern",
    ),
    pytest.param(
        lambda c: with_path(
            c,
            "/widgets",
            widget_get(
                parameters=[
                    {
                        "name": "tenant_slug",
                        "in": "query",
                        "content": {"application/json": {"schema": {"type": "string"}}},
                    }
                ]
            ),
        ),
        "core-api paths//widgets/get/parameters/0/content/application/json/schema (tenant slug) "
        "carries no pattern",
        id="a-content-declared-parameter-without-a-pattern",
    ),
    pytest.param(
        lambda c: with_path(
            c,
            "/widgets",
            {
                "get": {
                    "responses": {
                        "200": {
                            "description": "Widgets.",
                            "headers": {"X-Tenant-Slug": {"schema": {"type": "string"}}},
                        }
                    }
                }
            },
        ),
        "core-api paths//widgets/get/responses/200/headers/X-Tenant-Slug/schema (tenant slug) "
        "carries no pattern",
        id="a-response-header-without-a-pattern",
    ),
    pytest.param(
        lambda c: (
            with_header(c, "WidgetHeader", {"schema": {"type": "string"}})
            and with_path(
                c,
                "/widgets",
                {
                    "get": {
                        "responses": {
                            "200": {
                                "description": "Widgets.",
                                "headers": {
                                    "X-Organisation-Slug": {
                                        "$ref": "#/components/headers/WidgetHeader"
                                    }
                                },
                            }
                        }
                    }
                },
            )
        ),
        "core-api paths//widgets/get/responses/200/headers/X-Organisation-Slug/schema "
        "(organisation slug) carries no pattern through $ref to core-api components/headers/"
        "WidgetHeader",
        id="a-referenced-response-header-is-judged-under-the-referring-name",
    ),
]


@pytest.mark.parametrize("mutate,messages", SLUG_RULE_MUTATIONS)
def test_a_slug_field_off_its_rule_is_named(mutate, messages):
    contracts = load_contracts()
    assert slug_rule_problems(contracts) == [], "the control must pass before the mutation"
    problems = slug_rule_problems(mutate(contracts))
    expected = messages.split("\n")
    assert len(problems) == len(expected), problems
    for message, problem in zip(expected, problems, strict=True):
        assert message in problem, problems


def test_customer_read_exposes_revocation_safe_conditional_contract(contract):
    operation = contract["paths"]["/me"]["get"]
    condition = next(
        (p for p in operation.get("parameters", []) if p.get("name") == "If-None-Match"), None
    )
    assert condition is not None, "customer read conditional request is absent from wire contract"
    assert condition["in"] == "header" and condition["schema"]["type"] == "string"
    assert not condition.get("required", False)
    responses = operation["responses"]
    assert responses["403"]["$ref"] == "#/components/responses/Forbidden"
    assert "content" not in responses["304"]
    for status in ("200", "304"):
        headers = responses[status]["headers"]
        assert headers["ETag"]["$ref"] == "#/components/headers/ETag"
        assert headers["X-Request-Id"]["$ref"] == "#/components/headers/XRequestId"
        assert headers["Cache-Control"]["schema"]["enum"] == ["no-store"]
    # A floor, not an equality. The intent is that the conditional read arrived with
    # this contract version or later; pinned as a literal it goes stale on the next
    # bump and the failure says nothing about the conditional read at all.
    version = tuple(int(part) for part in contract["info"]["version"].split("."))
    assert version >= (0, 8, 0), contract["info"]["version"]


N4_IDENTITY = "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d"
N4_MAXIMUM = 9007199254740991
N4_PATH = "/organisations/{organisation_id}/bootstrap"
# The contract version the 0.16.0 delta is checked in. Rebound with each later contract
# change, with N4_OLD_CONTRACT: the reviewed rest of the contract, the delta reverted.
# Rebound at 0.20.0 (2026-10-21): cancelOrder, placeOrder's one order in flight, order-in-progress.
# Rebound at 0.21.0 (2026-10-22): legal texts at their permanent URL, no Sentry, DunningView.ladder deprecated.
# Rebound at 0.22.0: the Espace structure administration (ESPACE_STRUCTURE.md) and reserved slugs.
# Rebound at 0.23.0: createChannel's channel_limit (ESPACE_STRUCTURE.md §13.2).
# Rebound at 0.24.0 (2026-10-22): cancelOrder with credit notes.
# Rebound at 0.24.1: WorkspaceAdminCategory and WorkspaceAdminChannel examples.
# Rebound at 0.25.0: the intake operation reference and the exact current-identity local-TOTP
# semantics of Identity.mfa_enrolled, plus the required_amr clarification.
# Rebound at 0.25.1: TenantStatus.decommissioning reserves a bounded future top-level export lane
# that no current API operation admits; cutoff drives destruction and a durable evidence finalizer;
# deleted distinguishes active-store deletion from later backup purge. No N4 wire shape changed.
# Rebound at 0.25.2: prose only, the Espace channel-to-room mapping section in info.description.
# No N4 wire shape changed.
# Rebound at 0.26.0: discoverRealm's 403, header-first refusals, per-client value quotas and the
# configured issuer. No N4 wire shape changed.
# Rebound at 0.27.0: the audit-action registry gains outbox_delivery.drift_detected. No N4 wire
# shape changed.
# Rebound at 0.28.0: ProblemType gains identity-unknown, the Forbidden and Unauthenticated
# responses say a verified token with no stored identity is 403 identity-unknown, and patchMe and
# checkSlugAvailability declare 403. getOrganisationBootstrap answers that case 403 through the
# shared Forbidden response; no N4 wire shape changed.
# Rebound at 0.29.0: only createOrganisation slug admission narrows; no N4 wire shape changed.
# Rebound at 0.30.0: TenantStatusView.capacity may be null; no N4 wire shape changed.
# Rebound at 0.31.0: the invitation-expired and invitation-revoked 410s; no N4 wire shape changed.
# Rebound at 0.32.0: CreditNoteReason complimentary, two audit registry keys; no N4 wire shape changed.
# Rebound at 0.32.1: the XRequestId header's prose names the caller's `c-` namespace; no N4 wire shape changed.
# Rebound at 0.32.2: checkSlugAvailability's description says its rate limit is not enforced yet; no N4 wire shape changed.
# Rebound at 0.32.3: countMemberships' and getHelpContext's descriptions say what is not built yet; no N4 wire shape changed.
# Rebound at 0.33.0: createSupportTicket's description and its 503; no N4 wire shape changed.
# Rebound at 0.34.0: the billing switch (OrganisationStatusSummary's two members, billing-disabled); no N4 wire shape changed.
# Rebound at 0.34.1: the workspace guard reads agreements accepted without an order; no N4 wire shape changed.
# Rebound at 0.35.0: createTenant, its schemas, billing-enabled and tenant-exists; no N4 wire shape changed.
# Rebound at 0.36.0: the audit action tenant.failed; no N4 wire shape changed.
# Rebound at 0.37.0: previewInvitation and its two schemas; no N4 wire shape changed.
# Rebound at 0.37.1: TenantCreation.name's description; no N4 wire shape changed.
# Rebound at 0.37.2: the Espace table names the tenant slug; no N4 wire shape changed.
# Rebound at 0.38.0: the reserved tenant slugs gain the platform labels; no N4 wire shape changed.
# Rebound at 0.39.0: the reserved organisation slugs gain errors and ops-admin; no N4 wire shape changed.
# Rebound at 0.40.0: instant claim and the reserved Community host; N4 remains unchanged.
# Rebound at 0.42.0: directory privacy, proximity and the theme vocabulary; N4 remains unchanged.
# Rebound for additive workspace surfaces; existing assurance guards are unchanged.
N4_VERSION = "0.44.0"
# Rebound at 0.19.0 (2026-10-21, on top of 0.18.1): the notice-contacts delta and the Plan example's EU hosting.
# Rebound at 0.22.0: the ten structure operations, their schemas and Problem.reason's first value;
# then room_state on WorkspaceChannel, the starter's lounge (template version 2) and AppCode messaging;
# then 429 on the ten operations, 503 on their two reads, and ChannelRoomState's wording.
# Rebound at 0.23.0: createChannel's 501st channel and Problem.reason's channel_limit;
# then channel_set_too_large and the 409 of patchChannel and patchChannelAccess.
# Rebound at 0.24.0 (2026-10-22): cancelOrder with credit notes.
# Rebound at 0.24.1: WorkspaceAdminCategory and WorkspaceAdminChannel examples.
# Rebound at 0.25.0: the operation-reference and identity-semantics contract bytes.
# Rebound at 0.25.1: the TenantStatus recovery, currently unimplemented export admission, future
# cutoff/delete, durable evidence finalization and deletion prose-only corrections; rebound again
# for the ordered-cancellation never-provisioned attestation authority and ProjectBootstrap
# operator boundary. No N4 shape changed.
# Rebound after the normative future audit-action registry moved to the valid Components extension
# path with an honest expected-red runtime boundary; the public string and N4 delta are unchanged.
# Rebound at 0.25.2: info.description gains the prose-only Espace channel-to-room mapping section.
# Rebound at 0.26.0: discoverRealm declares 403 and its rules change; no N4 bytes changed.
# Rebound at 0.27.0: x-audit-action-registry gains outbox_delivery.drift_detected; no N4 bytes changed.
# Rebound at 0.28.0: identity-unknown in ProblemType, the Forbidden, Unauthenticated and
# consumeOwnerClaim 403 prose, the acceptInvitation carve-out in Forbidden, and 403 on patchMe and
# checkSlugAvailability; no N4 bytes changed.
# Rebound for the 0.29.0 synthetic-prefix intake reservation and corresponding prose.
# Rebound at 0.30.0: TenantStatusView.capacity nullable; no N4 bytes changed.
# Rebound at 0.31.0: ProblemType gains invitation-expired and invitation-revoked, typed on the
# acceptInvitation and resendInvitation 410s, and resendInvitation declares 409; no N4 bytes changed.
# Rebound at 0.32.0: CreditNoteReason complimentary and two registry keys; no N4 bytes changed.
# Rebound at 0.32.1: the XRequestId header's prose (TRUSTED_EDGE.md §3); no N4 bytes changed.
# Rebound at 0.32.2: checkSlugAvailability's description says its rate limit is not enforced yet; no N4 bytes changed.
# Rebound at 0.32.3: countMemberships' and getHelpContext's descriptions only; no N4 bytes changed.
# Rebound at 0.33.0: createSupportTicket's description and its 503; no N4 bytes changed.
# Rebound at 0.34.0: OrganisationStatusSummary's billing_enabled and workspace_pack_code, the
# billing-disabled problem, placeOrder's and createPaymentLink's descriptions; no N4 bytes changed.
# Rebound at 0.34.1: can_initialise and initialiseWorkspace's step 4 descriptions; no N4 bytes changed.
# Rebound at 0.35.0: createTenant, TenantCreation, WorkspaceAgreement, TenantCreated, two problem
# types and Problem.suggestions; no N4 bytes changed.
# Rebound at 0.36.0: the audit action tenant.failed; no N4 bytes changed.
# Rebound at 0.37.0: previewInvitation and its two schemas; no N4 bytes changed.
# Rebound at 0.37.1: TenantCreation.name's description; no N4 bytes changed.
# Rebound at 0.37.2: the Espace table names the tenant slug; no N4 bytes changed.
# Rebound at 0.38.0: the reserved tenant slugs on SlugAvailability.reason; no N4 bytes changed.
# Rebound for open-core monorepo unification; no N4 bytes changed.
# Rebound at 0.39.0: the reserved organisation slugs gain errors and ops-admin; no N4 bytes changed.
# Rebound at 0.39.0: the staff actor of three examples is the demo crew's; no N4 bytes changed.
# Rebound at 0.42.0: Membership's private member facts, WorkspaceTemplateId, ThemeId and its
# aliases, and the reserved proximity check-in schemas; no N4 bytes changed.
N4_OLD_CONTRACT = "d8c955bf470bee11586eaef63e49e29a9b55ac126c53eaa264d9909ae19e02b5"
# Rebound at 0.20.0 (2026-10-22): CONVENTIONS.md §6 gains the order-in-progress and invoice-issued rows and a changelog line.
# Rebound at 0.24.0 (2026-10-22): CONVENTIONS.md §6's invoice-issued row narrowed, and a changelog line.
# Rebound at 0.28.0: CONVENTIONS.md §6 gains the identity-unknown row and a changelog line.
# Rebound for the 0.29.0 synthetic-prefix intake reservation and corresponding prose.
# Rebound at 0.30.0: a changelog line for the nullable tenant capacity and the tenant reads.
# Rebound at 0.31.0: CONVENTIONS.md §6 gains the two invitation 410 rows and a changelog line.
# Rebound at 0.32.0: a changelog line for the complimentary credit reason.
# Rebound at 0.32.1: §9's `c-` namespace, §11's trusted edge for discoverRealm, a changelog line.
# Rebound at 0.32.2: a changelog line for checkSlugAvailability's unenforced rate limit.
# Rebound at 0.32.3: a changelog line for countMemberships and getHelpContext.
# Rebound at 0.33.0: a changelog line for createSupportTicket.
# Rebound at 0.34.0: CONVENTIONS.md §6 gains the billing-disabled row and a changelog line.
# Rebound at 0.34.1: a changelog line for the workspace guard.
# Rebound at 0.35.0: CONVENTIONS.md §6 gains the billing-enabled and tenant-exists rows, slug-taken
# names suggestions, and a changelog line.
# Rebound at 0.36.0: a changelog line for tenant.failed.
# Rebound at 0.37.0: previewInvitation's key exception in §1, §8 and §11, and its changelog line.
# Rebound at 0.37.1: a changelog line for TenantCreation.name's description.
# Rebound at 0.37.2: a changelog line for the Espace table's tenant slug.
# Rebound at 0.38.0: a changelog line for the reserved tenant slugs.
# Rebound for open-core monorepo unification; no N4 clause changed.
# Rebound at 0.39.0: a changelog line for the reserved organisation slugs.
N4_OLD_CONVENTIONS = "c54a45a6f2fdf0d830c1bbd4d27d772cd46fff9bee078ee33c7e7bd3f876feb5"
# Rebound: FIRST_OWNER_BOOTSTRAP.md §8.2 check 4 and its decision paragraph name the recent
# `auth_time` requirement and the Console's `max_age`; no N4 clause changed. Rebound again for
# the 2 s future tolerance, the commit-time bound, `max_age=0` and "narrows"; no N4 clause changed.
# Rebound again: check 4's 320 s final-read bound and the realm-flow dependency; no N4 clause changed.
# Rebound again: one 320 s bound and the reworded realm-flow citations; no N4 clause changed.
# Rebound again: §3.7 names the deployed operator profile and its owed prerequisites; no N4 clause changed.
# Rebound again: §7.3 names 403 identity-unknown for a verified token with no Identity (contract
# 0.28.0), and a changelog line; no N4 clause changed.
# Rebound for the 0.29.0 synthetic-prefix intake reservation and corresponding prose.
# Rebound again: §5.6 rule 1 follows the 72-hour set-up link, and a changelog line; no N4 clause changed.
# Rebound for open-core monorepo unification; no N4 clause changed.
N4_OLD_SPEC = "1f7a722213005f2add26fc214642be6ebaf18131d2c289b1f1254e4a15cd10e8"
N4_OLD_INFO = "    - Timestamps are RFC 3339 with an explicit offset, always `Z` on the wire.\n"
N4_INFO = (
    "    - Timestamps are RFC 3339 with an explicit offset, always `Z` on the wire, except\n"
    "      caller_assurance.enrollment_window.evaluated_at_ms and valid_before_ms: these two\n"
    "      version1 coordinates are nonnegative integer milliseconds at most 9007199254740991\n"
    "      on the declared Core time axis, not a qualified browser deadline or renewed TTL.\n"
)
N4_OPERATION = (
    "\n"
    "        Optional caller_assurance describes a proposed customer-only signed-fact transport.\n"
    "        The current server always omits it, including for staff; examples are synthetic\n"
    "        structure only. Its presence alone never proves current identity, registered factor,\n"
    "        clock qualification or protected-use readiness. A failed /me read never falls back\n"
    "        to this operation for assurance. Existing principals and status semantics are unchanged.\n"
)
N4_PROPERTY = (
    "        caller_assurance: { $ref: '#/components/schemas/BootstrapCallerAssurance' }\n"
)
N4_COMPONENTS = r"""    BootstrapCallerAssurance:
      type: object
      additionalProperties: false
      description: |
        Synthetic contract examples only; the current server omits this optional customer-only
        transport. Structure is not signature, current-identity, registered-factor, clock or
        protected-use qualification. Staff never receive customer assurance.
      required: [version, identity_id, authentication_mfa]
      dependentRequired:
        mfa_enrolled: [enrollment_window]
        enrollment_window: [mfa_enrolled]
      properties:
        version: { type: integer, const: 1 }
        identity_id:
          type: string
          minLength: 36
          maxLength: 36
          pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])'
        authentication_mfa: { type: boolean }
        email_verified: { type: boolean }
        mfa_enrolled: { type: boolean }
        enrollment_window: { $ref: '#/components/schemas/BootstrapEnrollmentWindow' }
      examples:
        - version: 1
          identity_id: 3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d
          authentication_mfa: false
        - version: 1
          identity_id: 3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d
          authentication_mfa: true
          email_verified: false
          mfa_enrolled: false
          enrollment_window:
            evaluated_at_ms: 1000
            valid_before_ms: 2000
            profile: issuer-core-bounded-v1

    BootstrapEnrollmentWindow:
      type: object
      additionalProperties: false
      description: |
        Fixed version1 Core-axis coordinates, not arrival-relative durations or a qualified
        browser deadline. This schema does not prove evaluated_at_ms precedes valid_before_ms,
        a qualified interval clock, signature provenance or current protected-use eligibility.
        Both true and false enrollment evidence expire to omission; omission is unknown.
      required: [evaluated_at_ms, valid_before_ms, profile]
      properties:
        evaluated_at_ms: { type: integer, minimum: 0, maximum: 9007199254740991 }
        valid_before_ms: { type: integer, minimum: 0, maximum: 9007199254740991 }
        profile: { type: string, const: issuer-core-bounded-v1 }

"""
N4_OLD_TIME = (
    "- Every timestamp is RFC 3339 with an explicit `Z` offset, in UTC, with second or millisecond "
    "precision: `2027-01-14T09:30:00Z`.\n"
)
N4_TIME = (
    "- Except for caller_assurance.enrollment_window.evaluated_at_ms and valid_before_ms, every "
    "payload timestamp is RFC 3339 with an explicit `Z` offset, in UTC, with second or millisecond "
    "precision. Those two version1 coordinates alone use nonnegative integer milliseconds at "
    "most 9007199254740991 on the declared Core time axis; they convey no qualified browser "
    "deadline, renewed duration or clock-evidence guarantee.\n"
)
N4_OLD_SUNSET = (
    "- `Deprecation` and `Sunset` follow RFC 9745 and RFC 8594; `Sunset` is an HTTP-date, the only "
    "place in the API where a non-RFC-3339 time appears.\n"
)
N4_SUNSET = (
    "- `Deprecation` and `Sunset` follow RFC 9745 and RFC 8594; `Sunset` is an HTTP-date, the only "
    "place in the API where a non-RFC-3339 time appears other than the two enrollment-window "
    "coordinates explicitly named in §3.\n"
)
N4_OLD_CHECKLIST = (
    "- [ ] `snake_case` fields; timestamps RFC 3339 UTC; money as `*_minor` plus `currency`.\n"
)
N4_CHECKLIST = (
    "- [ ] `snake_case` fields; timestamps RFC 3339 UTC except only the two named version1 "
    "enrollment-window coordinates in §3; Sunset remains the §13 HTTP-date exception; money "
    "as `*_minor` plus `currency`.\n"
)
N4_SPEC = """## 13. Optional caller assurance contract

Status: CONTRACT ONLY; current server output always omits caller_assurance. Synthetic examples
validate structure, not runtime availability, signatures, current eligibility or readiness.

The existing authenticated getOrganisationBootstrap operation may later carry optional
caller_assurance for its current customer only. Existing customer identity/person enablement,
exact issuer/subject/target organisation and OwnerBinding authorization stay mandatory. It is
never a pre-auth locator, initially unbound preparation path or staff assurance projection.
No route, role, status, header, persisted BootstrapView member or emitter changes in this slice.

BootstrapCallerAssurance version1 requires canonical lower-case identity_id and strict boolean
authentication_mfa. That current-auth fact never substitutes for registered-factor evidence.
Optional email_verified preserves signed true/false/absence. Optional mfa_enrolled is present
if and only if enrollment_window is present; unknown is omission, never null or coerced false.
The window has only evaluated_at_ms, valid_before_ms and profile issuer-core-bounded-v1.
Its two nonnegative integer coordinates are at most 9007199254740991 on the declared Core axis,
under the sole additional payload timestamp exception in CONVENTIONS §3/§13/§15. Every other
timestamp/duration and Sunset HTTP-date/RFC rule remains unchanged. Both true and false facts
expire to omission, and the same token never gains a renewed window from a later arrival.

Schema structure does not prove customer lane, equality to identity_mapping, current issuer,
subject, signature, target, evaluated-before-expiry or any qualified interval/browser clock.
Actual registered-factor plus independent current-auth/contact evidence, the settled 330-second
limit, conservative nonextending mapping and effect/physical-commit acceptance remain held.
Current AMR or a /me flag alone cannot open that guard.

An unaffiliated intended prospect still receives403 from membership-bound /me. A later
prospect-assurance producer on this same bootstrap is an explicit separate source-contract
amendment, not fallback after a failed /me read. Eligible members invalidate/refetch /me on
refresh; every relevant readiness fact is invalidated and unknown/failed reads hold. Neither
branch may reuse an old proof after token/context retirement. C8 remains postconsume fresh
owner evidence only. P1, serving/copy, operator duties and mounted onboarding remain held.

"""


def _n4_copy(value):
    from copy import deepcopy

    return deepcopy(value)


def _n4_require(condition, marker):
    if not condition:
        raise AssertionError(marker)


def _n4_replace_once(text, before, after, marker):
    _n4_require(text.count(before) == 1, marker)
    return text.replace(before, after, 1)


def _n4_original_text(text):
    text = _n4_replace_once(
        text, f"  version: {N4_VERSION}\n", "  version: 0.15.1\n", "WIRE_VERSION"
    )
    text = _n4_replace_once(text, N4_INFO, N4_OLD_INFO, "WIRE_OPENAPI_EXCEPTION")
    text = _n4_replace_once(text, N4_OPERATION, "", "WIRE_OPERATION_PROVENANCE")
    text = _n4_replace_once(text, N4_COMPONENTS, "", "WIRE_COMPONENT_BYTES")
    text = _n4_replace_once(text, N4_PROPERTY, "", "WIRE_OPTIONAL_BYTES")
    _n4_require(
        hashlib.sha256(text.encode()).hexdigest() == N4_OLD_CONTRACT, "WIRE_UNRELATED_BYTES"
    )
    return text


def _n4_expected_components():
    from textwrap import dedent

    return yaml.safe_load(dedent(N4_COMPONENTS))


def _n4_structure(document):
    schemas = document["components"]["schemas"]
    _n4_require("BootstrapCallerAssurance" in schemas, "WIRE_ASSURANCE_ABSENT")
    expected = _n4_expected_components()
    _n4_require(
        schemas["BootstrapCallerAssurance"] == expected["BootstrapCallerAssurance"],
        "WIRE_ASSURANCE_SHAPE",
    )
    _n4_require(
        schemas.get("BootstrapEnrollmentWindow") == expected["BootstrapEnrollmentWindow"],
        "WIRE_WINDOW_SHAPE",
    )
    bootstrap = schemas["OrganisationBootstrap"]
    _n4_require(
        bootstrap["properties"].get("caller_assurance")
        == {"$ref": "#/components/schemas/BootstrapCallerAssurance"}
        and "caller_assurance" not in bootstrap["required"],
        "WIRE_BOOTSTRAP_OPTIONAL",
    )


def _n4_parity(document, text):
    original = yaml.safe_load(_n4_original_text(text))
    expected = _n4_copy(original)
    expected["info"]["version"] = N4_VERSION
    actual_info = yaml.safe_load(text)["info"]["description"]
    expected_info = original["info"]["description"]
    expected_info = _n4_replace_once(
        expected_info,
        N4_OLD_INFO[4:],
        "\n".join(line[4:] for line in N4_INFO.splitlines()) + "\n",
        "WIRE_OLD_INFO",
    )
    _n4_require(actual_info == expected_info, "WIRE_INFO_DELTA")
    expected["info"]["description"] = expected_info
    operation = expected["paths"][N4_PATH]["get"]
    operation["description"] += "\n".join(line[8:] for line in N4_OPERATION.splitlines()) + "\n"
    expected["components"]["schemas"].update(_n4_expected_components())
    expected["components"]["schemas"]["OrganisationBootstrap"]["properties"]["caller_assurance"] = {
        "$ref": "#/components/schemas/BootstrapCallerAssurance"
    }
    _n4_require(document == expected, "WIRE_UNRELATED_SEMANTICS")
    old_bootstrap = original["components"]["schemas"]["OrganisationBootstrap"]
    current = _n4_copy(document["components"]["schemas"]["OrganisationBootstrap"])
    del current["properties"]["caller_assurance"]
    _n4_require(current == old_bootstrap, "WIRE_OLD_BOOTSTRAP")
    current_operation = _n4_copy(document["paths"][N4_PATH]["get"])
    current_operation["description"] = original["paths"][N4_PATH]["get"]["description"]
    _n4_require(current_operation == original["paths"][N4_PATH]["get"], "WIRE_OLD_OPERATION")
    return original


def _n4_validator(document, name="BootstrapCallerAssurance"):
    import jsonschema_rs

    return jsonschema_rs.validator_for(
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$ref": "#/components/schemas/" + name,
            "components": document["components"],
        }
    )


def _n4_fact(**values):
    return {"version": 1, "identity_id": N4_IDENTITY, "authentication_mfa": False, **values}


def _n4_window(**values):
    return {
        "evaluated_at_ms": 1000,
        "valid_before_ms": 2000,
        "profile": "issuer-core-bounded-v1",
        **values,
    }


def _n4_pair(**values):
    return _n4_fact(**{"mfa_enrolled": False, "enrollment_window": _n4_window(), **values})


N4_GOOD = [
    ("minimal-false", _n4_fact()),
    ("authentication-true", _n4_fact(authentication_mfa=True)),
    ("contact-false", _n4_fact(email_verified=False)),
    ("contact-true", _n4_fact(email_verified=True)),
    ("enrollment-false", _n4_pair()),
    ("enrollment-true", _n4_pair(mfa_enrolled=True)),
    ("all-true", _n4_pair(authentication_mfa=True, email_verified=True, mfa_enrolled=True)),
    (
        "coordinate-zero",
        _n4_pair(enrollment_window=_n4_window(evaluated_at_ms=0, valid_before_ms=0)),
    ),
    (
        "coordinate-maximum",
        _n4_pair(
            enrollment_window=_n4_window(evaluated_at_ms=N4_MAXIMUM, valid_before_ms=N4_MAXIMUM)
        ),
    ),
]
N4_BAD = [
    ("missing-version", {"identity_id": N4_IDENTITY, "authentication_mfa": False}),
    ("missing-identity", {"version": 1, "authentication_mfa": False}),
    ("missing-authentication", {"version": 1, "identity_id": N4_IDENTITY}),
    ("version-boolean", _n4_fact(version=True)),
    ("version-two", _n4_fact(version=2)),
    ("version-fraction", _n4_fact(version=1.5)),
    ("identity-empty", _n4_fact(identity_id="")),
    ("identity-uppercase", _n4_fact(identity_id=N4_IDENTITY.upper())),
    ("identity-linefeed", _n4_fact(identity_id=N4_IDENTITY + "\n")),
    ("identity-number", _n4_fact(identity_id=1)),
    ("authentication-string", _n4_fact(authentication_mfa="true")),
    ("authentication-null", _n4_fact(authentication_mfa=None)),
    ("contact-string", _n4_fact(email_verified="true")),
    ("contact-null", _n4_fact(email_verified=None)),
    ("enrollment-string", _n4_pair(mfa_enrolled="true")),
    ("enrollment-null", _n4_pair(mfa_enrolled=None)),
    ("assurance-null", None),
    ("assurance-extra", _n4_fact(unexpected=True)),
    ("enrollment-without-window", _n4_fact(mfa_enrolled=False)),
    ("window-without-enrollment", _n4_fact(enrollment_window=_n4_window())),
    ("window-null", _n4_pair(enrollment_window=None)),
    ("window-extra", _n4_pair(enrollment_window=_n4_window(unexpected=True))),
    ("profile-other", _n4_pair(enrollment_window=_n4_window(profile="other"))),
    ("evaluated-fraction", _n4_pair(enrollment_window=_n4_window(evaluated_at_ms=1.5))),
    ("valid-before-fraction", _n4_pair(enrollment_window=_n4_window(valid_before_ms=1.5))),
    ("evaluated-negative", _n4_pair(enrollment_window=_n4_window(evaluated_at_ms=-1))),
    ("valid-before-negative", _n4_pair(enrollment_window=_n4_window(valid_before_ms=-1))),
    ("evaluated-unsafe", _n4_pair(enrollment_window=_n4_window(evaluated_at_ms=N4_MAXIMUM + 1))),
    ("valid-before-unsafe", _n4_pair(enrollment_window=_n4_window(valid_before_ms=N4_MAXIMUM + 1))),
    ("evaluated-boolean", _n4_pair(enrollment_window=_n4_window(evaluated_at_ms=True))),
    ("valid-before-boolean", _n4_pair(enrollment_window=_n4_window(valid_before_ms=True))),
    (
        "window-missing-evaluated",
        _n4_pair(enrollment_window={"valid_before_ms": 2000, "profile": "issuer-core-bounded-v1"}),
    ),
    (
        "window-missing-valid-before",
        _n4_pair(enrollment_window={"evaluated_at_ms": 1000, "profile": "issuer-core-bounded-v1"}),
    ),
    (
        "window-missing-profile",
        _n4_pair(enrollment_window={"evaluated_at_ms": 1000, "valid_before_ms": 2000}),
    ),
    ("profile-null", _n4_pair(enrollment_window=_n4_window(profile=None))),
    ("window-array", _n4_pair(enrollment_window=[])),
    ("assurance-array", []),
    ("profile-boolean", _n4_pair(enrollment_window=_n4_window(profile=True))),
    ("assurance-empty", {}),
]


def _n4_docs(document, conventions, specification):
    for text, clause, marker in (
        (conventions, N4_TIME, "WIRE_TIME_EXCEPTION"),
        (conventions, N4_SUNSET, "WIRE_SUNSET_EXCEPTION"),
        (conventions, N4_CHECKLIST, "WIRE_CHECKLIST_EXCEPTION"),
        (
            document["info"]["description"],
            "\n".join(line[4:] for line in N4_INFO.splitlines()) + "\n",
            "WIRE_OPENAPI_EXCEPTION",
        ),
        (
            document["paths"][N4_PATH]["get"]["description"],
            "\n".join(line[8:] for line in N4_OPERATION.splitlines()) + "\n",
            "WIRE_OPERATION_PROVENANCE",
        ),
        (specification, N4_SPEC, "WIRE_SPEC_PROVENANCE"),
    ):
        _n4_require(text.count(clause) == 1, marker)
    original_conventions = conventions
    for before, after in (
        (N4_TIME, N4_OLD_TIME),
        (N4_SUNSET, N4_OLD_SUNSET),
        (N4_CHECKLIST, N4_OLD_CHECKLIST),
    ):
        original_conventions = original_conventions.replace(before, after, 1)
    _n4_require(
        hashlib.sha256(original_conventions.encode()).hexdigest() == N4_OLD_CONVENTIONS,
        "WIRE_CONVENTIONS_DELTA",
    )
    _n4_require(
        hashlib.sha256(specification.replace(N4_SPEC, "", 1).encode()).hexdigest() == N4_OLD_SPEC,
        "WIRE_SPEC_DELTA",
    )


def _n4_refuses(action, marker):
    with pytest.raises(AssertionError) as caught:
        action()
    assert caught.value.args == (marker,)


def _n4_rejects(document, sample, marker):
    validator = _n4_validator(document)
    _n4_require(validator.is_valid(_n4_fact()) is True, "WIRE_VALID_SETUP")
    _n4_require(validator.is_valid(sample) is False, marker)


def test_n4_actual_optional_contract_structure(contract):
    _n4_structure(contract)


def test_n4_existing_bootstrap_samples_and_old_semantics_remain(contract):
    text = (ROOT / "contracts/core-api.openapi.yaml").read_text()
    original = _n4_parity(contract, text)
    samples = original["components"]["schemas"]["OrganisationBootstrap"]["examples"]
    assert len(samples) == 1, "WIRE_OLD_EXAMPLE_COUNT"
    validator = _n4_validator(contract, "OrganisationBootstrap")
    for sample in samples:
        assert "caller_assurance" not in sample, "WIRE_OLD_EXAMPLE_OMISSION"
        assert validator.is_valid(sample) is True, "WIRE_OLD_EXAMPLE_VALID"


@pytest.mark.parametrize("label,sample", N4_GOOD, ids=[row[0] for row in N4_GOOD])
def test_n4_synthetic_wire_accepts_exact_boolean_presence(contract, label, sample):
    assert _n4_validator(contract).is_valid(sample) is True, "WIRE_GOOD_" + label


@pytest.mark.parametrize("label,sample", N4_BAD, ids=[row[0] for row in N4_BAD])
def test_n4_synthetic_wire_refuses_malformed_facts(contract, label, sample):
    _n4_rejects(contract, sample, "WIRE_BAD_" + label)


def test_n4_exact_timestamp_and_unimplemented_provenance_clauses(contract):
    _n4_docs(
        contract,
        (ROOT / "docs/api/CONVENTIONS.md").read_text(),
        (ROOT / "docs/specs/FIRST_OWNER_BOOTSTRAP.md").read_text(),
    )


def test_n4_complete_old_contract_parity(contract):
    _n4_parity(contract, (ROOT / "contracts/core-api.openapi.yaml").read_text())


def test_n4_structure_health_refuses_and_restores_each_owned_guard(contract):
    _n4_structure(contract)
    for fault, marker in (
        ("absent", "WIRE_ASSURANCE_ABSENT"),
        ("assurance", "WIRE_ASSURANCE_SHAPE"),
        ("window", "WIRE_WINDOW_SHAPE"),
        ("optional", "WIRE_BOOTSTRAP_OPTIONAL"),
    ):
        changed = _n4_copy(contract)
        schemas = changed["components"]["schemas"]
        if fault == "absent":
            del schemas["BootstrapCallerAssurance"]
        elif fault == "assurance":
            schemas["BootstrapCallerAssurance"]["required"] = []
        elif fault == "window":
            schemas["BootstrapEnrollmentWindow"]["properties"]["profile"]["const"] = "other"
        else:
            schemas["OrganisationBootstrap"]["required"].append("caller_assurance")
        _n4_refuses(lambda changed=changed: _n4_structure(changed), marker)
        _n4_structure(_n4_copy(contract))
    text = (ROOT / "contracts/core-api.openapi.yaml").read_text()
    for clause, marker in (
        (f"  version: {N4_VERSION}\n", "WIRE_VERSION"),
        (N4_INFO, "WIRE_OPENAPI_EXCEPTION"),
        (N4_OPERATION, "WIRE_OPERATION_PROVENANCE"),
        (N4_COMPONENTS, "WIRE_COMPONENT_BYTES"),
        (N4_PROPERTY, "WIRE_OPTIONAL_BYTES"),
    ):
        assert text.count(clause) == 1, "WIRE_HEALTH_SETUP"
        changed_text = text.replace(clause, "", 1)
        _n4_refuses(lambda changed_text=changed_text: _n4_original_text(changed_text), marker)
        _n4_original_text(text)
    changed_text = text.replace("  title: Kodera Core API\n", "  title: Other API\n", 1)
    assert changed_text != text, "WIRE_HEALTH_SETUP"
    _n4_refuses(lambda: _n4_original_text(changed_text), "WIRE_UNRELATED_BYTES")
    _n4_original_text(text)
    conventions = (ROOT / "docs/api/CONVENTIONS.md").read_text()
    specification = (ROOT / "docs/specs/FIRST_OWNER_BOOTSTRAP.md").read_text()
    _n4_docs(contract, conventions, specification)
    _n4_refuses(
        lambda: _n4_docs(contract, conventions + "extra\n", specification),
        "WIRE_CONVENTIONS_DELTA",
    )
    _n4_docs(contract, conventions, specification)
    _n4_refuses(
        lambda: _n4_docs(contract, conventions, specification + "extra\n"),
        "WIRE_SPEC_DELTA",
    )
    _n4_docs(contract, conventions, specification)


@pytest.mark.parametrize(
    "fault,marker",
    [
        ("time", "WIRE_TIME_EXCEPTION"),
        ("sunset", "WIRE_SUNSET_EXCEPTION"),
        ("checklist", "WIRE_CHECKLIST_EXCEPTION"),
        ("info", "WIRE_OPENAPI_EXCEPTION"),
        ("operation", "WIRE_OPERATION_PROVENANCE"),
        ("specification", "WIRE_SPEC_PROVENANCE"),
    ],
)
def test_n4_each_provenance_clause_omission_refuses_and_restores(contract, fault, marker):
    conventions = (ROOT / "docs/api/CONVENTIONS.md").read_text()
    specification = (ROOT / "docs/specs/FIRST_OWNER_BOOTSTRAP.md").read_text()
    _n4_docs(contract, conventions, specification)
    changed = _n4_copy(contract)
    if fault in {"time", "sunset", "checklist"}:
        clause = {"time": N4_TIME, "sunset": N4_SUNSET, "checklist": N4_CHECKLIST}[fault]
        conventions = conventions.replace(clause, "", 1)
    elif fault == "info":
        clause = "\n".join(line[4:] for line in N4_INFO.splitlines()) + "\n"
        changed["info"]["description"] = changed["info"]["description"].replace(clause, "", 1)
    elif fault == "operation":
        clause = "\n".join(line[8:] for line in N4_OPERATION.splitlines()) + "\n"
        operation = changed["paths"][N4_PATH]["get"]
        operation["description"] = operation["description"].replace(clause, "", 1)
    else:
        specification = specification.replace(N4_SPEC, "", 1)
    _n4_refuses(lambda: _n4_docs(changed, conventions, specification), marker)
    _n4_docs(
        _n4_copy(contract),
        (ROOT / "docs/api/CONVENTIONS.md").read_text(),
        (ROOT / "docs/specs/FIRST_OWNER_BOOTSTRAP.md").read_text(),
    )


@pytest.mark.parametrize("field", ["authentication_mfa", "email_verified", "mfa_enrolled"])
def test_n4_each_boolean_schema_string_admission_exposes_fault_and_restores(contract, field):
    sample = _n4_pair(**{field: "true"}) if field == "mfa_enrolled" else _n4_fact(**{field: "true"})
    marker = "WIRE_BOOLEAN_STRING_" + field
    _n4_rejects(contract, sample, marker)
    changed = _n4_copy(contract)
    changed["components"]["schemas"]["BootstrapCallerAssurance"]["properties"][field] = {
        "type": ["boolean", "string"]
    }
    _n4_refuses(lambda: _n4_rejects(changed, sample, marker), marker)
    _n4_rejects(_n4_copy(contract), sample, marker)


@pytest.mark.parametrize(
    "fault", ["assurance-extra", "window-extra", "enrollment-only", "window-only"]
)
def test_n4_each_closure_and_presence_admission_exposes_fault_and_restores(contract, fault):
    sample = {
        "assurance-extra": _n4_fact(unexpected=True),
        "window-extra": _n4_pair(enrollment_window=_n4_window(unexpected=True)),
        "enrollment-only": _n4_fact(mfa_enrolled=False),
        "window-only": _n4_fact(enrollment_window=_n4_window()),
    }[fault]
    marker = "WIRE_CLOSED_PAIR_" + fault
    _n4_rejects(contract, sample, marker)
    changed = _n4_copy(contract)
    schemas = changed["components"]["schemas"]
    if fault == "assurance-extra":
        schemas["BootstrapCallerAssurance"]["additionalProperties"] = True
    elif fault == "window-extra":
        schemas["BootstrapEnrollmentWindow"]["additionalProperties"] = True
    else:
        key = "mfa_enrolled" if fault == "enrollment-only" else "enrollment_window"
        del schemas["BootstrapCallerAssurance"]["dependentRequired"][key]
    _n4_refuses(lambda: _n4_rejects(changed, sample, marker), marker)
    _n4_rejects(_n4_copy(contract), sample, marker)


def test_n4_unrelated_role_fault_still_hits_independent_discovery_guard_and_restores(contract):
    import test_realm_discovery_contract as discovery

    text = (ROOT / "contracts/core-api.openapi.yaml").read_text()
    discovery.assert_contract(contract)
    _n4_parity(contract, text)
    changed = _n4_copy(contract)
    changed["paths"][N4_PATH]["get"]["x-kodera-authz"]["roles"] = ["anonymous"]
    _n4_refuses(lambda: discovery.assert_contract(changed), "unrelated-surface")
    _n4_refuses(lambda: _n4_parity(changed, text), "WIRE_UNRELATED_SEMANTICS")
    discovery.assert_contract(_n4_copy(contract))
    _n4_parity(_n4_copy(contract), text)


def _assert_2xx_json_response_examples(document):
    schemas = document["components"]["schemas"]
    responses = document["components"].get("responses", {})
    for _path, methods in document["paths"].items():
        for _method, op in methods.items():
            if not isinstance(op, dict) or "responses" not in op:
                continue
            for status, resp in op["responses"].items():
                if not str(status).startswith("2"):
                    continue
                if "$ref" in resp:
                    resp = responses[resp["$ref"].split("/")[-1]]
                content = resp.get("content", {}).get("application/json", {})
                if not content:
                    continue
                schema = content.get("schema", {})
                if "$ref" in schema:
                    ref_name = schema["$ref"].split("/")[-1]
                elif "allOf" in schema:
                    ref_name = schema["allOf"][1]["properties"]["data"]["items"]["$ref"].split("/")[
                        -1
                    ]
                else:
                    ref_name = schema["properties"]["data"]["items"]["$ref"].split("/")[-1]
                target = schemas[ref_name]
                examples = target.get("examples")
                _n4_require(
                    isinstance(examples, list) and len(examples) >= 1,
                    f"MISSING_EXAMPLES_{ref_name}",
                )
                validator = _n4_validator(document, ref_name)
                for sample in examples:
                    _n4_require(validator.is_valid(sample) is True, f"INVALID_EXAMPLE_{ref_name}")


def test_every_2xx_json_response_schema_carries_valid_examples(contract):
    _assert_2xx_json_response_examples(contract)
    for name in ("WorkspaceAdminCategory", "WorkspaceAdminChannel"):
        changed = _n4_copy(contract)
        changed["components"]["schemas"][name].pop("examples", None)
        _n4_refuses(
            lambda changed=changed: _assert_2xx_json_response_examples(changed),
            f"MISSING_EXAMPLES_{name}",
        )
