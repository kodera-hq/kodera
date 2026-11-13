"""Approved discovery wire contract and narrow-change refusal controls.

These are source assertions, not proof that the discovery endpoint is implemented.
"""

import copy
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
DISCOVERY_SCHEMAS = (
    "RealmDiscoveryRequest",
    "RealmDiscoveryResult",
    "DiscoveryOrganisationSummary",
    "RealmDiscoveryCandidate",
)
# The contract with only the admitted discovery surface removed, rebound at 0.14.0 (the intake's
# `slug-taken` and `intake-closed` problem types, its `503`, the reserved slug list, the
# `instruction_ref` pattern, `name`'s (and `OrganisationSummary.name`'s)
# `minLength`, and `Problem.reason` and `required_amr`; reviewed with that change).
# Rebound at 0.14.1, the reserved-slug description in the present tense once orgs.0008 lands.
# Rebound at 0.15.0 for the reviewed consume 503 and single contact new-logical-key instruction.
# Rebound at 0.16.1: billing prose (Core issues the invoice; no provider named) and provider-neutral examples
# Rebound at 0.17.0: OrderRequest.legal_acceptances (required) and LegalAcceptance; generateDpa declares 422; the workspace order step
# Rebound at 0.18.0: removeMembership answers 200 Membership, declares 400/412 and an optional If-Match; membership descriptions drop the realm job
# Rebound at 0.18.1: the Tenant.region description states the European Union hosting promise (ADR-0017); enum unchanged
# Rebound at 0.19.0 (2026-10-21, on top of 0.18.1): getNoticeContacts and patchNoticeContacts, NoticeContacts and NoticeContactsPatchRequest; the Plan example states EU hosting
# Rebound at 0.20.0 (2026-10-22): cancelOrder, placeOrder's one order in flight, problem types order-in-progress and invoice-issued
# Rebound at 0.21.0 (2026-10-22): legal texts at their permanent URL on api.kodera.io, getLegalDocumentText declares 400, Sentry removed (decision O4), DunningView.ladder deprecated
# Rebound at 0.22.0: the Espace structure administration's ten operations and schemas, Problem.reason's first value, the reserved platform slugs; then room_state on WorkspaceChannel, the starter's lounge and AppCode messaging; then 429 on the ten operations, 503 on their two reads, ChannelRoomState's wording
# Rebound at 0.23.0: createChannel's channel_limit; then channel_set_too_large and the 409 of patchChannel and patchChannelAccess
# Rebound at 0.24.0 (2026-10-22): cancelOrder credits an issued unpaid invoice with a credit note; listCreditNotes, getCreditNote, CreditNote, Invoice.credit_note_id; invoice-issued narrowed; a cancelled response example
# Rebound at 0.24.1: WorkspaceAdminCategory and WorkspaceAdminChannel carry examples matching WorkspaceAdministration.examples[0]
# Rebound at 0.25.0: the intake operation reference and the exact Identity.mfa_enrolled and required_amr semantics
# Rebound at 0.25.1: TenantStatus prose records the bounded future decommissioning export lane,
# no current API admission, future cutoff/delete and durable evidence finalization, and distinguishes
# active-store deletion from later backup purge; rebound again for ordered-cancellation
# never-provisioned evidence and the explicit ProjectBootstrap boundary without changing discovery.
# Rebound after the normative future audit-action registry moved to the valid Components extension
# path with an honest expected-red runtime boundary; the public action string and discovery remain unchanged.
# An intentional later change to another API surface must review/rebind this pin.
# Rebound at 0.27.0: x-audit-action-registry gains outbox_delivery.drift_detected (realm access bulk
# verification); discovery is unchanged.
# Rebound at 0.28.0: ProblemType gains identity-unknown, the Forbidden and Unauthenticated responses
# and consumeOwnerClaim's 403 name it (with the acceptInvitation carve-out), and patchMe and
# checkSlugAvailability declare 403;
# discovery is unchanged.
# Rebound at 0.29.0: intake reserves synth-*; discovery itself is unchanged.
# Rebound at 0.30.0: TenantStatusView.capacity may be null; discovery is unchanged.
# Rebound at 0.31.0: the typed invitation 410s and resendInvitation's 409; discovery is unchanged.
# Rebound at 0.32.0: CreditNoteReason complimentary; discovery is unchanged.
# Rebound at 0.32.1: the XRequestId header's prose names the caller's `c-` namespace; discovery's
# hashed wire shape is unchanged (its peer now comes from TRUSTED_EDGE.md's client_address).
# Rebound at 0.32.2: checkSlugAvailability's description says its rate limit is not enforced yet;
# discovery is unchanged.
# Rebound at 0.32.3: countMemberships' and getHelpContext's descriptions only.
# Rebound at 0.33.0: createSupportTicket's description and its 503; discovery is unchanged.
# Rebound at 0.34.0: the billing switch (a summary's two members, billing-disabled); discovery is
# unchanged.
# Rebound at 0.34.1: two workspace descriptions; discovery is unchanged.
# Rebound at 0.35.0: createTenant and its problems; discovery is unchanged.
# Rebound at 0.36.0: the audit action tenant.failed; discovery is unchanged.
# Rebound at 0.37.0: previewInvitation, its schemas and the key rule's second exception;
# discovery is unchanged.
# Rebound at 0.37.1: TenantCreation.name's description; discovery is unchanged.
# Rebound at 0.38.0: SlugAvailability.reason names the reserved tenant slugs; discovery is
# unchanged.
# Rebound for open-core monorepo unification; discovery is unchanged.
# Rebound at 0.39.0: OrganisationCreateRequest.slug's closed list gains errors and ops-admin;
# discovery is unchanged.
# Rebound at 0.39.0: the staff actor of three examples is the demo crew's; discovery is unchanged.
# Rebound at 0.40.0: instant claim and the Community reservation; discovery is unchanged.
# Rebound at 0.42.0: directory privacy, proximity and the theme vocabulary; discovery is
# unchanged.
# Rebound for additive workspace surfaces; discovery remains unchanged.
UNCHANGED_SHA = "a25cf6bea4219a0ce942eb98014c5979a3f52a39b5da1eece99b9a8d3714583a"
# Approved schema/key semantics; prose is removed before hashing.
# Rebound at 0.26.0: discoverRealm declares 403 forbidden, a browser request refused from its
# headers before any quota charge; the rest of the discovery wire is unchanged.
REQUIRED_OPERATION_CLAUSES = (
    "Ignore Authorization entirely",
    "4096-byte limit on received body bytes before JSON parsing",
    "duplicate object keys",
    "Exclude prospects, staff realms, closed, deleted and unready",
    "current verified organisation/domain associations",
    "distinct by organisation and ordered by slug then id",
    "issuer is exactly the configured identity provider's realm issuer",
    "Positive metadata intentionally reveals organisation existence",
    "Refuse from headers alone, before any quota charge or body read",
    "Sec-Fetch-Site is cross-site (403 forbidden)",
    "never refused for its origin",
    "A value bucket is per client",
    "count one IPv6 /64 as one client",
    "Charge global/IP before parsing",
    "Trust only the direct connection peer, or, when that peer is a configured trusted edge",
    "10000 retained-event cap fails closed",
    "two-second database budgets",
    "omit them when prerequisites fail before evaluation",
)

# Rebound for x-kodera-authz / x-kodera-scope vendor extension rename.
APPROVED_SHA = "66cacccb41889ab16c8a2fb4120a624c8b3d5802247c3ed3df3d5da27b036a17"


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def without_prose(value):
    if isinstance(value, dict):
        return {
            k: without_prose(v) for k, v in value.items() if k not in {"description", "summary"}
        }
    if isinstance(value, list):
        return [without_prose(v) for v in value]
    return value


def unchanged_surface(contract):
    result = copy.deepcopy(contract)
    result["info"].pop("version")
    result["info"].pop("description")
    result["paths"].pop("/auth/discover")
    for name in DISCOVERY_SCHEMAS:
        result["components"]["schemas"].pop(name, None)
    result["components"]["parameters"].pop("DiscoveryCompatibilityKey", None)
    return result


def assert_contract(contract):
    version = tuple(int(part) for part in contract["info"]["version"].split("."))
    assert version >= (0, 12, 0), "breaking-version"
    description = contract["info"]["description"]
    assert "Except `discoverRealm`" in description, "named-exception"
    assert "no key, body fingerprint or response" in description, "no-replay-state"
    if not (digest(unchanged_surface(contract)) == UNCHANGED_SHA):
        raise AssertionError("unrelated-surface")
    op = contract["paths"]["/auth/discover"]["post"]
    for clause in REQUIRED_OPERATION_CLAUSES:
        assert clause in op.get("description", ""), "operation-clause: " + clause
    assert op["security"] == [], "anonymous"
    assert op["x-kodera-authz"] == {"roles": ["anonymous"]}, "anonymous-role"
    assert op["x-kodera-scope"] == "organisation:read", "scope"
    assert op["parameters"] == [{"$ref": "#/components/parameters/DiscoveryCompatibilityKey"}], (
        "dedicated-key"
    )
    assert set(op["responses"]) == {
        "200",
        "400",
        "403",
        "413",
        "415",
        "422",
        "429",
        "500",
        "503",
    }, "statuses"
    for response in op["responses"].values():
        headers = response["headers"]
        assert headers["Cache-Control"]["schema"]["const"] == "no-store", "no-store"
        assert headers["X-Request-Id"] == {"$ref": "#/components/headers/XRequestId"}, "correlation"
        assert {"RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"} <= headers.keys(), (
            "quota-headers"
        )
        assert "Idempotency-Replayed" not in headers, "no-replay-header"
    for status in ("429", "503"):
        assert op["responses"][status]["headers"]["Retry-After"]["schema"]["minimum"] == 1, "retry"
    assert op["responses"]["503"]["headers"]["Retry-After"]["schema"]["const"] == 5, "backoff"
    boundary = {
        "schemas": {name: contract["components"]["schemas"][name] for name in DISCOVERY_SCHEMAS},
        "parameter": contract["components"]["parameters"]["DiscoveryCompatibilityKey"],
        "operation": op,
    }
    # Only these newly admitted example annotations are excluded from the original wire pin.
    boundary = copy.deepcopy(boundary)
    boundary["schemas"]["RealmDiscoveryResult"].pop("examples", None)
    for response in boundary["operation"]["responses"].values():
        response["headers"]["Cache-Control"].pop("example", None)
    assert digest(without_prose(boundary)) == APPROVED_SHA, "approved-wire-semantics"


def assert_local_refs(value, document):
    if isinstance(value, dict):
        if "$ref" in value and value["$ref"].startswith("#/"):
            target = document
            for key in value["$ref"][2:].split("/"):
                key = key.replace("~1", "/").replace("~0", "~")
                assert isinstance(target, dict) and key in target, "dangling-reference"
                target = target[key]
        for child in value.values():
            assert_local_refs(child, document)
    elif isinstance(value, list):
        for child in value:
            assert_local_refs(child, document)


@pytest.fixture(scope="module")
def contract():
    return yaml.safe_load((ROOT / "contracts/core-api.openapi.yaml").read_text())


def test_actual_contract(contract):
    assert_contract(contract)
    assert_local_refs(contract, contract)


@pytest.mark.parametrize(
    "value,valid",
    [
        ("Person.Name+tag@EXAMPLE.invalid", True),
        ("a@b.cd", True),
        ("a" * 64 + "@example.invalid", True),
        ("a" * 65 + "@example.invalid", False),
        ("a..b@example.invalid", False),
        ("a@localhost", False),
        ("a@-example.invalid", False),
        ("a@example.invalid\n", False),
        ("é@example.invalid", False),
        ('"quoted"@example.invalid', False),
        ("a@[127.0.0.1]", False),
        ("a@" + "x" * 64 + ".invalid", False),
        ("a" * 64 + "@" + ".".join(["b" * 63] * 3), False),
    ],
)
def test_email_wire_examples(contract, value, valid):
    schema = contract["components"]["schemas"]["RealmDiscoveryRequest"]["properties"]["email"]
    accepted = (
        len(value) <= schema.get("maxLength", len(value))
        and re.search(schema["pattern"], value) is not None
    )
    assert accepted is valid


@pytest.mark.parametrize(
    "value,valid",
    [
        ("k" * 16, True),
        ("k" * 255, True),
        ("k" * 15, False),
        ("k" * 256, False),
        (" " + "k" * 16, False),
        ("k" * 16 + " ", False),
        ("k" * 16 + "\n", False),
        ("é" * 16, False),
        ("k" * 8 + " " + "k" * 8, True),
    ],
)
def test_compatibility_key_wire_examples(contract, value, valid):
    schema = contract["components"]["parameters"]["DiscoveryCompatibilityKey"]["schema"]
    accepted = (
        schema["minLength"] <= len(value) <= schema["maxLength"]
        and re.search(schema["pattern"], value) is not None
    )
    assert accepted is valid


@pytest.mark.parametrize(
    "mutation",
    [
        "replay",
        "conflict",
        "cache",
        "extra",
        "global-key",
        "foreign-path",
        "version",
        "exception",
        "unrelated-registry-row",
    ],
)
def test_checker_refuses_semantic_regressions(contract, mutation):
    damaged = copy.deepcopy(contract)
    op = damaged["paths"]["/auth/discover"]["post"]
    if mutation == "replay":
        op["parameters"] = [{"$ref": "#/components/parameters/IdempotencyKey"}]
    elif mutation == "conflict":
        op["responses"]["409"] = {"description": "conflict"}
    elif mutation == "cache":
        op["responses"]["200"]["headers"]["Cache-Control"]["schema"]["const"] = "public"
    elif mutation == "extra":
        damaged["components"]["schemas"]["RealmDiscoveryRequest"]["additionalProperties"] = True
    elif mutation == "global-key":
        damaged["components"]["parameters"]["IdempotencyKey"]["required"] = False
    elif mutation == "foreign-path":
        damaged["paths"].pop("/me")
    elif mutation == "unrelated-registry-row":
        description = damaged["components"]["schemas"]["ProblemType"]["description"]
        changed = description.replace("| `mfa-required` | 403 |", "| `mfa-required` | 200 |")
        assert changed != description
        damaged["components"]["schemas"]["ProblemType"]["description"] = changed
    elif mutation == "version":
        damaged["info"]["version"] = "0.11.2"
    else:
        damaged["info"]["description"] = "Every POST replays."
    reasons = {
        "replay": "dedicated-key",
        "conflict": "statuses",
        "cache": "no-store",
        "extra": "approved-wire-semantics",
        "global-key": "unrelated-surface",
        "foreign-path": "unrelated-surface",
        "unrelated-registry-row": "unrelated-surface",
        "version": "breaking-version",
        "exception": "named-exception",
    }
    with pytest.raises(AssertionError, match=reasons[mutation]):
        assert_contract(damaged)


def test_checker_refuses_dangling_reference(contract):
    damaged = copy.deepcopy(contract)
    damaged["paths"]["/auth/discover"]["post"]["requestBody"]["content"]["application/json"][
        "schema"
    ]["$ref"] = "#/components/schemas/Absent"
    with pytest.raises(AssertionError, match="dangling-reference"):
        assert_local_refs(damaged, damaged)


@pytest.mark.parametrize("clause", REQUIRED_OPERATION_CLAUSES)
def test_checker_refuses_missing_operation_rules(contract, clause):
    damaged = copy.deepcopy(contract)
    op = damaged["paths"]["/auth/discover"]["post"]
    op["description"] = op["description"].replace(clause, "")
    with pytest.raises(AssertionError, match="operation-clause"):
        assert_contract(damaged)


def assert_example_schema(value, schema, contract):
    """Check the pinned discovery schema vocabulary without a new validator dependency."""
    assert set(schema) <= {
        "$ref",
        "type",
        "oneOf",
        "required",
        "properties",
        "additionalProperties",
        "items",
        "minItems",
        "maxItems",
        "uniqueItems",
        "minLength",
        "maxLength",
        "pattern",
        "format",
        "description",
        "examples",
    }, "unhandled-example-schema-keyword"
    if "$ref" in schema:
        target = contract
        for part in schema["$ref"][2:].split("/"):
            target = target[part]
        assert_example_schema(value, target, contract)
        return
    if "oneOf" in schema:
        matches = 0
        for branch in schema["oneOf"]:
            try:
                assert_example_schema(value, branch, contract)
            except AssertionError:
                pass
            else:
                matches += 1
        assert matches == 1, "example-oneOf"
        return
    kind = schema["type"]
    if kind == "null":
        assert value is None, "example-null"
    elif kind == "object":
        assert isinstance(value, dict), "example-object"
        assert set(schema["required"]) <= value.keys(), "example-required"
        assert schema["additionalProperties"] is False
        assert value.keys() <= schema["properties"].keys(), "example-extra-property"
        for key, item in value.items():
            assert_example_schema(item, schema["properties"][key], contract)
    elif kind == "array":
        assert isinstance(value, list), "example-array"
        assert schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", len(value))
        if schema.get("uniqueItems"):
            assert len({json.dumps(item, sort_keys=True) for item in value}) == len(value)
        for item in value:
            assert_example_schema(item, schema["items"], contract)
    elif kind == "string":
        assert isinstance(value, str), "example-string"
        assert schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", len(value))
        if "pattern" in schema:
            assert re.search(schema["pattern"], value), "example-pattern"
        if schema.get("format") == "uuid":
            assert re.fullmatch(r"[0-9a-f-]{36}", value), "example-uuid"
            try:
                assert str(UUID(value)) == value, "example-uuid"
            except ValueError as error:
                raise AssertionError("example-uuid") from error
        elif schema.get("format") == "uri":
            parsed = urlsplit(value)
            assert parsed.scheme == "https" and parsed.netloc, "example-uri"
        else:
            assert "format" not in schema, "unhandled-example-format"
    else:
        raise AssertionError("unhandled-example-type")


def assert_discovery_examples(contract):
    schema = contract["components"]["schemas"]["RealmDiscoveryResult"]
    examples = schema.get("examples", [])
    assert len(examples) == 3, "three-discovery-examples"
    zero, single, multiple = examples
    for example in examples:
        assert_example_schema(example, schema, contract)
    assert zero["realm"] is None and zero["candidates"] == [], "zero-example"
    assert single["realm"] is not None and single["candidates"] == [], "single-example"
    assert multiple["realm"] is None and len(multiple["candidates"]) >= 2, "multiple-example"
    for matches in ([single], multiple["candidates"]):
        organisations = [entry["organisation"] for entry in matches]
        assert len({org["id"] for org in organisations}) == len(organisations), "distinct-examples"
        order = [(org["slug"], org["id"]) for org in organisations]
        assert order == sorted(order), "ordered-examples"
        for entry in matches:
            assert entry["realm"] == entry["organisation"]["realm"] == entry["organisation"]["slug"]
            assert entry["issuer"] == "https://id.kodera.io/realms/" + entry["realm"]
            assert (
                entry["openid_configuration_url"]
                == entry["issuer"] + "/.well-known/openid-configuration"
            )


def test_generator_readable_discovery_examples(contract):
    assert_discovery_examples(contract)


@pytest.mark.parametrize("status", ["200", "400", "403", "413", "415", "422", "429", "500", "503"])
def test_generator_readable_no_store_example(contract, status):
    header = contract["paths"]["/auth/discover"]["post"]["responses"][status]["headers"][
        "Cache-Control"
    ]
    assert header.get("example") == header["schema"]["const"] == "no-store"


@pytest.mark.parametrize(
    "mutation",
    ["missing", "extra", "one-candidate", "duplicate", "order", "issuer", "slug", "uuid"],
)
def test_example_acceptance_refuses_regressions(contract, mutation):
    damaged = copy.deepcopy(contract)
    schema = damaged["components"]["schemas"]["RealmDiscoveryResult"]
    examples = schema.get("examples", [])
    assert len(examples) == 3, "three-discovery-examples"
    if mutation == "missing":
        schema.pop("examples")
    elif mutation == "extra":
        examples[0]["unexpected"] = True
    elif mutation == "one-candidate":
        examples[2]["candidates"].pop()
    elif mutation == "duplicate":
        examples[2]["candidates"][1] = copy.deepcopy(examples[2]["candidates"][0])
    elif mutation == "order":
        examples[2]["candidates"].reverse()
    elif mutation == "issuer":
        examples[1]["issuer"] = "https://example.invalid/foreign"
    elif mutation == "slug":
        examples[1]["organisation"]["slug"] = "bad"
    else:
        examples[1]["organisation"]["id"] = "not-a-uuid"
    with pytest.raises(AssertionError):
        assert_discovery_examples(damaged)
