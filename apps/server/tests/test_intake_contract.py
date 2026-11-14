"""`createOrganisation` as contract 0.40.0 declares it: docs/specs/ORGANISATION_INTAKE.md.

Reads the committed contract and docs/api/CONVENTIONS.md. Each check names the clause it holds,
and the registry check compares the contract's closed `ProblemType` enum with the §6 table in both
directions, which the enum's own description says a contract test does.
"""

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "contracts" / "core-api.openapi.yaml"
CONVENTIONS = ROOT / "docs" / "api" / "CONVENTIONS.md"
PROBLEMS = "https://kodera.io/problems/"
ROW = re.compile(r"^\| `([a-z-]+)` \| (\d{3}) \|")


def contract():
    return yaml.safe_load(CONTRACT.read_text(encoding="utf-8"))


def create_organisation(document):
    return document["paths"]["/organisations"]["post"]


def registry_rows():
    """The `type` suffixes and statuses of CONVENTIONS.md §6's table."""
    text = CONVENTIONS.read_text(encoding="utf-8")
    section = text[text.index("## 6. Errors") : text.index("## 7.")]
    return {m.group(1): int(m.group(2)) for line in section.splitlines() if (m := ROW.match(line))}


def test_the_version_is_at_least_the_one_that_aligned_the_intake():
    version = tuple(int(part) for part in contract()["info"]["version"].split("."))
    assert version == (0, 44, 2), "version"


def test_the_intake_exposes_one_bounded_non_secret_operation_reference():
    document = contract()
    schema = document["components"]["schemas"]["OperationReference"]
    assert schema == {
        "type": "string",
        "pattern": r"^[0-9a-f]{64}(?![\s\S])",
        "description": (
            "Opaque deterministic correlation reference for the intake operation; not proof "
            "of a durable row, a resource URL or an authorization capability."
        ),
    }
    example = "0123456789abcdef" * 4
    operation = create_organisation(document)
    created = operation["responses"]["201"]["headers"]["X-Operation-Ref"]
    conflict = operation["responses"]["409"]["headers"]["X-Operation-Ref"]
    assert created["required"] is True
    assert created["schema"] == {"$ref": "#/components/schemas/OperationReference"}
    assert conflict["required"] is False
    assert conflict["schema"] == {"$ref": "#/components/schemas/OperationReference"}
    assert created["example"] == conflict["example"] == example
    assert re.search(schema["pattern"], example)
    assert not re.search(schema["pattern"], example + "\n")
    conditional = " ".join(conflict["description"].split())
    assert "if and only if" in conditional
    assert all(
        name in conditional
        for name in ("idempotency-key-in-flight", "slug-taken", "idempotency-key-reuse")
    )
    for status, response in operation["responses"].items():
        if status not in {"201", "409"}:
            assert "X-Operation-Ref" not in response.get("headers", {}), status


def test_the_two_folded_semantic_corrections_are_exact():
    document = contract()
    identity = document["components"]["schemas"]["Identity"]
    described = " ".join(identity["properties"]["mfa_enrolled"]["description"].split())
    assert "signed local-TOTP registration fact" in described
    assert "exact current identity" in described
    assert "strict `false` means no qualifying local TOTP" in described
    assert "omission means unknown" in described
    assert "passkey" not in described.lower()
    required_amr = document["components"]["schemas"]["Problem"]["properties"]["required_amr"][
        "description"
    ]
    assert "every staff write" in required_amr and "consumeOwnerClaim" in required_amr


def test_the_problem_registry_and_the_conventions_table_are_one_list():
    schemas = contract()["components"]["schemas"]
    enum = {member.removeprefix(PROBLEMS) for member in schemas["ProblemType"]["enum"]}
    rows = registry_rows()
    assert len(rows) > 30, "the §6 table was not read"
    assert enum == set(rows), (
        f"only in the contract: {sorted(enum - set(rows))}; "
        f"only in CONVENTIONS: {sorted(set(rows) - enum)}"
    )
    assert rows["slug-taken"] == 409 and rows["intake-closed"] == 503
    described = schemas["ProblemType"]["description"]
    assert "| `slug-taken` | 409 |" in described and "| `intake-closed` | 503 |" in described


def test_the_intake_declares_its_slug_conflict_and_its_closed_gate():
    responses = create_organisation(contract())["responses"]
    assert {"400", "401", "403", "409", "422", "500", "503"} <= set(responses)
    conflict = responses["409"]["content"]["application/problem+json"]
    assert conflict["examples"]["slugTaken"]["value"]["type"] == PROBLEMS + "slug-taken"
    closed = responses["503"]["content"]["application/problem+json"]
    assert closed["schema"] == {"$ref": "#/components/schemas/Problem"}
    assert closed["examples"]["intakeClosed"]["value"]["type"] == PROBLEMS + "intake-closed"
    assert "Idempotency-Replayed" not in responses["503"]["headers"], (
        "the gate's refusal is not stored, so it is never replayed"
    )


def test_the_reserved_slugs_are_a_closed_list_naming_the_staff_realm():
    slug = contract()["components"]["schemas"]["OrganisationCreateRequest"]["properties"]["slug"]
    reserved = [
        "master",
        "kodera-staff",
        "kodera-probe",
        "kodera-dev",
        "kodera",
        "staff",
        "admin",
        "notify",
        "staging",
        "status",
        "support",
        "billing",
        "console",
        "developers",
        "matrix",
        "auth-admin",
        "auth-mail",
        "errors",
        "ops-admin",
        "community",
    ]
    assert slug["not"] == {"enum": reserved}
    pattern = re.compile(slug["pattern"].replace("(?![\\s\\S])", r"\Z"))
    assert all(pattern.match(name) for name in reserved), "a reserved name the pattern refuses"
    described = " ".join(slug["description"].split())
    assert "the staff realm" in described and "administration realm" in described


def test_the_instruction_reference_admits_a_ticket_and_no_contact():
    field = contract()["components"]["schemas"]["OrganisationCreateRequest"]["properties"][
        "instruction_ref"
    ]
    pattern = re.compile(field["pattern"].replace("(?![\\s\\S])", r"\Z"))
    assert pattern.match("SUP-0418") and pattern.match("FSBOOT-0001")
    for pasted in ("julie@acme.fr", "Julie Marchand", "SUP-0418 julie", "sup-0418", "SUP-0418\n"):
        assert not pattern.match(pasted), pasted


def test_an_organisation_name_holds_one_to_two_hundred_characters():
    schemas = contract()["components"]["schemas"]
    for name in (
        "Organisation",
        "OrganisationSummary",
        "OrganisationCreateRequest",
        "OrganisationPatchRequest",
    ):
        field = schemas[name]["properties"]["name"]
        assert (field.get("minLength"), field.get("maxLength")) == (1, 200), name


def test_the_problem_document_declares_reason_and_required_amr():
    properties = contract()["components"]["schemas"]["Problem"]["properties"]
    assert (
        properties["reason"]["type"] == "string"
        and "`conflict`" in (properties["reason"]["description"])
    )
    assert properties["required_amr"]["type"] == "array"
    assert "`mfa-required`" in properties["required_amr"]["description"]


def test_the_prose_says_the_contact_and_profile_are_sealed_on_the_intake():
    document = contract()
    described = " ".join(create_organisation(document)["description"].split())
    assert "sealed" in described and "there is no `Contact` row for it" in described
    assert "`Organisation` does not store them yet" in described
    assert "`Contact` rows" not in described
    owner = document["components"]["schemas"]["OrganisationCreateRequest"]["properties"][
        "intended_owner"
    ]
    assert "Sealed on the intake record" in owner["description"]


def test_the_registry_comparison_fails_on_a_member_missing_from_either_list():
    schemas = contract()["components"]["schemas"]
    enum = {member.removeprefix(PROBLEMS) for member in schemas["ProblemType"]["enum"]}
    rows = set(registry_rows())
    assert enum == rows
    assert enum - {"slug-taken"} != rows, "a member dropped from the contract went unseen"
    assert enum != rows - {"intake-closed"}, "a row dropped from CONVENTIONS went unseen"
    text = CONVENTIONS.read_text(encoding="utf-8")
    assert text.count("| `intake-closed` | 503 |") == 1, "the row this proof drops is not there"
