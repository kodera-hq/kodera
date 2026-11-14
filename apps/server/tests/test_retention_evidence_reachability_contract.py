"""Executable retention-reachability guards for future and long-lived evidence models.

The retention finalizers are still planning contracts, not runtime models or migrations, so their
normative Markdown tables are the inspectable surface today. The runtime slice must replace or
extend these source guards with model reflection while preserving every refusal below.
"""

import ast
import json
import math
import re
import tempfile
from collections.abc import Callable, Mapping
from fractions import Fraction
from functools import partial
from pathlib import Path
from typing import Any, NotRequired, TypedDict, TypeGuard, cast

import jsonschema_rs
import pytest
import yaml

# Parse each input afresh: mutants change both source and policy, and callers
# mutate loaded mappings. LibYAML's safe constructors avoid the Python parser's
# repeated full-contract cost without caching either mutable data or verdicts.
# The syntax tree remains available separately to detect duplicate mapping keys.
_load_yaml = partial(yaml.load, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))
_compose_yaml = partial(yaml.compose, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))


def load_yaml(source: str) -> Any:
    try:
        return _load_yaml(source)
    except yaml.YAMLError:
        # Keep the original parser's exact refusal diagnostic on invalid input.
        return yaml.safe_load(source)


def compose_yaml(source: str) -> yaml.Node | None:
    try:
        return _compose_yaml(source)
    except yaml.YAMLError:
        return yaml.compose(source)


def dump_yaml(value: object, *, sort_keys: bool = True) -> str:
    return yaml.dump(
        value, Dumper=getattr(yaml, "CSafeDumper", yaml.SafeDumper), sort_keys=sort_keys
    )


ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "docs" / "domain" / "MODEL.md"
BILLING_MODEL = ROOT / "docs" / "domain" / "BILLING_MODEL.md"
STATE_MACHINE = ROOT / "docs" / "domain" / "TENANT_STATE_MACHINE.md"
AUDIT_TAXONOMY = ROOT / "docs" / "domain" / "AUDIT_TAXONOMY.md"
BACKUP_AND_RESTORE = ROOT / "docs" / "specs" / "BACKUP_AND_RESTORE.md"
OPENAPI = ROOT / "contracts" / "core-api.openapi.yaml"
RUNTIME_AUDIT_MODEL = ROOT / "apps" / "audit" / "models.py"

FK = re.compile(r"(?:\bFK\b|foreign[ _-]?key)", re.IGNORECASE)


def is_finite_json_number(value: object) -> TypeGuard[int | float]:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        or isinstance(value, float)
        and math.isfinite(value)
    )


def test_reachability_yaml_uses_the_available_safe_native_parser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = []
    original = yaml.SafeLoader.get_single_data

    def counted(loader: yaml.SafeLoader) -> object:
        calls.append(True)
        return original(loader)

    monkeypatch.setattr(yaml.SafeLoader, "get_single_data", counted)
    assert reachable_openapi_schema_records("paths: {}") == []
    # A source-only installation remains correct; binary wheels must not spend
    # every case reparsing the full contract through the Python parser.
    assert len(calls) == (0 if hasattr(yaml, "CSafeLoader") else 1)


def test_retention_yaml_round_trips_safely_without_sharing_mutable_results() -> None:
    source = "names: &names [alpha, bravo]\ncopy: *names\nflag: true\nnumber: 1.5\n"
    expected = yaml.safe_load(source)
    first = load_yaml(source)
    assert first == expected
    first["names"].append("changed")
    assert load_yaml(source.replace("alpha", "charlie"))["names"] == ["charlie", "bravo"]
    assert load_yaml(source) == expected
    assert yaml.safe_load(dump_yaml(expected, sort_keys=False)) == expected


@pytest.mark.parametrize(
    "source",
    ("!!python/object:builtins.object {}", "!!python/object/apply:builtins.str [unsafe]"),
)
def test_retention_yaml_native_path_rejects_unsafe_constructors(source: str) -> None:
    with pytest.raises(yaml.constructor.ConstructorError) as expected:
        yaml.safe_load(source)
    with pytest.raises(yaml.constructor.ConstructorError) as actual:
        load_yaml(source)
    assert str(actual.value) == str(expected.value)


def test_retention_yaml_preserves_malformed_input_diagnostics() -> None:
    source = "paths: [unterminated"
    with pytest.raises(yaml.YAMLError) as expected_load:
        yaml.safe_load(source)
    with pytest.raises(yaml.YAMLError) as actual_load:
        load_yaml(source)
    assert str(actual_load.value) == str(expected_load.value)
    with pytest.raises(yaml.YAMLError) as expected_compose:
        yaml.compose(source)
    with pytest.raises(yaml.YAMLError) as actual_compose:
        compose_yaml(source)
    assert str(actual_compose.value) == str(expected_compose.value)


def test_retention_yaml_actor_syntax_keeps_duplicate_keys_and_changed_source_visible() -> None:
    document = {
        "components": {
            "schemas": {
                "AuditEvent": {
                    "properties": {
                        "actor": {
                            "properties": {
                                "type": {
                                    "enum": ["human"],
                                    "x-canonical-audit-actor-map": {"human": "identity"},
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    source = dump_yaml(document, sort_keys=False)
    expected = (["human"], {"human": "identity"}, True)
    assert openapi_audit_actor_contract(source) == expected
    duplicate = source.replace("human: identity", "human: identity\n                human: system")
    assert openapi_audit_actor_contract(duplicate) == (["human"], {}, False)
    assert openapi_audit_actor_contract(source) == expected


def test_retention_table_parsing_rechecks_mutated_global_heading_policy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = (
        "### `Original`\n| Field | Type | Notes |\n|---|---|---|\n| `id` | UUID | first |\n"
        "### `Changed`\n| Field | Type | Notes |\n|---|---|---|\n| `id` | UUID | second |\n"
    )
    monkeypatch.setitem(HEADING_MARKERS, "Fixture", "### `Original`")
    assert table_fields(source, "Fixture") == {"id": ("UUID", "first")}
    monkeypatch.setitem(HEADING_MARKERS, "Fixture", "### `Changed`")
    assert table_fields(source, "Fixture") == {"id": ("UUID", "second")}
    monkeypatch.setitem(HEADING_MARKERS, "Fixture", "### `Original`")
    assert table_fields(source, "Fixture") == {"id": ("UUID", "first")}


HEADING_MARKERS = {
    "Payment and PaymentLink": "### `Payment` and `PaymentLink`",
}

CERTIFICATE_SNAPSHOT_FIELDS = {
    "initial_attestation_id": ("UUIDv7 NULL", "DeletionCertificate"),
    "exit_cutoff_reconciliation_id": ("UUIDv7 NULL", "ExitCutoffReconciliation"),
    "ordered_cancellation_order_id": ("UUIDv7 NULL", "Order"),
    "ordered_cancellation_cleanup_id": ("UUIDv7 NULL", "OrderedCancellationCleanup"),
    "identity_backup_closure_id": ("UUIDv7 NULL", "IdentityBackupClosure"),
    "organisation_id": ("UUIDv7", "Organisation"),
    "tenant_ids": ("UUIDv7[]", "Tenant"),
    "job_id": ("UUIDv7 NULL", "Job"),
}

LEGAL_AUTHORITY_FIELDS = {
    ("DpaAcceptance", "Field"): {
        "organisation_id": ("UUIDv7", "Organisation"),
        "accepted_by_identity_id": ("UUIDv7", "Identity"),
    },
    ("Subscription", "Field"): {
        "organisation_id": ("UUIDv7", "Organisation"),
        "tenant_id": ("UUIDv7 NULL", "Tenant"),
        "plan_id": ("UUIDv7", "Plan"),
        "price_id": ("UUIDv7", "Price"),
    },
    ("Order", "Field"): {
        "organisation_id": ("UUIDv7", "Organisation"),
        "dpa_id": ("UUIDv7", "DpaAcceptance"),
        "subscription_id": ("UUIDv7", "Subscription"),
        "invoice_id": ("UUIDv7", "Invoice"),
        "tenant_id": ("UUIDv7", "Tenant"),
        "placed_by": ("UUIDv7", "Identity"),
    },
    ("Invoice", "Field"): {
        "organisation_id": ("UUIDv7", "Organisation"),
        "subscription_id": ("UUIDv7 NULL", "Subscription"),
        "order_id": ("UUIDv7 NULL", "Order"),
    },
    ("InvoiceLine", "Field"): {
        "organisation_id": ("UUIDv7", "Organisation"),
        "invoice_id": ("UUIDv7", "Invoice"),
        "subscription_id": ("UUIDv7 NULL", "Subscription"),
        "snapshot_price_id": ("UUIDv7", "Price"),
    },
    ("CreditNote", "Field"): {
        "organisation_id": ("UUIDv7", "Organisation"),
        "invoice_id": ("UUIDv7", "Invoice"),
    },
    ("CreditNoteLine", "Field"): {
        "organisation_id": ("UUIDv7", "Organisation"),
        "credit_note_id": ("UUIDv7", "CreditNote"),
        "invoice_line_id": ("UUIDv7", "InvoiceLine"),
        "invoice_id": ("UUIDv7", "Invoice"),
    },
    ("Payment and PaymentLink", "Payment"): {
        "invoice_id": ("UUIDv7 NULL", "Invoice"),
        "payment_link_id": ("UUIDv7 NULL", "PaymentLink"),
        "organisation_id": ("UUIDv7", "Organisation"),
    },
}

LEGAL_EVIDENCE_FIELDS = {
    ("DpaAcceptance", "Field"): {
        "organisation_snapshot": "jsonb",
        "dpa_document_sha256": "text",
        "signatory_snapshot": "jsonb",
        "close_reason": "enum NULL",
        "close_evidence_ref": "text NULL",
    },
    ("Subscription", "Field"): {
        "customer_snapshot": "jsonb",
        "tenant_slug_snapshot": "text NULL",
    },
    ("Order", "Field"): {
        "customer_snapshot": "jsonb",
        "price_snapshot": "jsonb",
        "tenant_slug_snapshot": "text",
    },
    ("Invoice", "Field"): {"customer_snapshot": "jsonb"},
    ("InvoiceLine", "Field"): {"invoice_number_snapshot": "text NULL"},
    ("CreditNote", "Field"): {
        "invoice_number_snapshot": "text",
        "customer_snapshot": "jsonb",
        "currency": "char(3)",
    },
    ("CreditNoteLine", "Field"): {
        "credit_note_number_snapshot": "text",
        "invoice_number_snapshot": "text",
        "currency": "char(3)",
    },
    ("Payment and PaymentLink", "Payment"): {
        "invoice_number_snapshot": "text NULL",
        "customer_snapshot": "jsonb",
    },
}

PAYMENT_ALLOCATION_FIELDS = {
    "allocation_state": "enum",
    "allocation_evidence_refs": "text[]",
    "allocated_at`, `allocated_by_identity_id": "timestamptz NULL, UUIDv7 NULL",
}

SCHEMA_CRITICAL_WORKFLOW_FIELDS = {
    ("Invoice", "Field", "state"): (
        "enum",
        "`draft` \\| `issued` \\| `paid` \\| `overdue` \\| `void` \\| `credited`",
    ),
    ("InvoiceLine", "Field", "position"): (
        "int",
        "Immutable invoice-local ordinal; unique with `invoice_id`",
    ),
    ("Payment and PaymentLink", "Payment", "state"): (
        "enum",
        "`pending` \\| `processing` \\| `succeeded` \\| `failed` \\| `reversed`",
    ),
    ("Payment and PaymentLink", "Payment", "allocation_state"): (
        "enum",
        "`unmatched` \\| `on_account` \\| `allocated`; an audited monotonic projection, never moved out of `allocated`",
    ),
    ("Payment and PaymentLink", "PaymentLink", "expires_at"): ("timestamptz", ""),
}

CREDIT_NOTE_LINE_FIELDS = {
    "id": ("UUIDv7", ""),
    "organisation_id": (
        "UUIDv7",
        "Immutable non-FK subject snapshot copied from the locked credit note's organisation scope",
    ),
    "credit_note_id": (
        "UUIDv7",
        "Immutable non-FK legal-authority snapshot validated against the credit note issued in the same transaction",
    ),
    "credit_note_number_snapshot": (
        "text",
        "Immutable issued credit-note number paired with `credit_note_id`",
    ),
    "invoice_line_id": (
        "UUIDv7",
        "Immutable non-FK legal-authority snapshot validated against the locked corrected invoice line",
    ),
    "invoice_id": (
        "UUIDv7",
        "Immutable non-FK legal-authority snapshot copied from the locked invoice line",
    ),
    "invoice_number_snapshot": (
        "text",
        "Immutable issued invoice number paired with `invoice_id`",
    ),
    "position": (
        "int",
        "Immutable position copied from the corrected invoice line; unique with `credit_note_id`",
    ),
    "description": ("text", "Immutable description copied from the corrected invoice line"),
    "quantity": ("int", "Immutable quantity copied from the corrected invoice line"),
    "currency": (
        "char(3)",
        "Immutable currency copied from the locked credit note and invoice",
    ),
    "unit_amount_minor`, `total_excl_vat_minor": (
        "bigint",
        "Immutable credited amounts: `unit_amount_minor` copies the locked invoice line's `unit_amount_minor`, and `total_excl_vat_minor` copies its `net_amount_minor`",
    ),
    "vat_rate_bp`, `vat_amount_minor": (
        "int, bigint",
        "Immutable VAT rate and amount copied from the corrected invoice line",
    ),
    "period_start`, `period_end": (
        "date NULL",
        "Immutable service-period dates copied from the corrected invoice line's `period_start_date` and `period_end_date`",
    ),
    "accounting_event_at`, `financial_year_closed_at": (
        "timestamptz",
        "Immutable credit-issue event and its financial-year close copied from the locked credit note",
    ),
    "retained_until`, `purge_after": (
        "timestamptz",
        "Both exactly `financial_year_closed_at + 10 years`",
    ),
}

CREDIT_NOTE_LINE_SOURCE_EQUALITY = (
    "requires exact source equality for organisation scope; credit-note id and number; invoice id "
    "and number; invoice-line id; position; description; quantity; currency; `unit_amount_minor`; "
    "CreditNoteLine `total_excl_vat_minor` to InvoiceLine `net_amount_minor`; VAT rate and amount; "
    "service-period dates; accounting event; financial-year close; "
    "`retained_until`; and `purge_after`"
)

MANIFEST_SOURCE_ROWS = {
    "ExitCutoffReconciliation": ("cutoff_reconciliation", "exactly_one"),
    "ExitCutoffJobReconciliation": ("cutoff_reconciliation", "every_child"),
    "ExitCutoffClaimSessionReconciliation": ("cutoff_reconciliation", "every_child"),
    "OrderedCancellationCleanup": ("ordered_cancellation_cleanup", "exactly_one"),
}

FIELDS_STAR_DEFINITION = (
    "`fields = *` normatively means exactly every field in that source table's normative table "
    "above, including every field added later; an implementation may not omit, rename, transform "
    "or substitute a selected projection for any field"
)

PROJECT_BOOTSTRAP_PROJECTION_FIELDS = {
    "id",
    "tenant_id",
    "provider_project_id",
    "provider_application_id",
    "provider_policy_id",
    "policy_digest",
    "access_key_fingerprint",
    "key_expires_at",
    "operator_identity_id",
    "evidence_ref",
    "state",
    "verified_at",
    "replaced_by_id",
    "created_at",
    "updated_at",
}
PROJECT_BOOTSTRAP_EXCLUDED_FIELDS = {"secret_ref"}
PROJECT_BOOTSTRAP_PROJECTION_RULE = (
    "Each projection's source-field classifications must be pairwise disjoint and together "
    "classify every normative source field exactly once"
)

IDENTITY_CAPTURE_INCLUDED_FIELDS = {
    "kind",
    "state",
    "store_accepted_at",
    "lock_until",
}
IDENTITY_CAPTURE_DERIVED_FIELDS = {
    "id": "salted_capture_id_digest",
    "generation_id": "salted_generation_id_digest",
    "provider_snapshot_ref": "salted_provider_snapshot_digest",
    "write_slot_ref": "salted_write_slot_digest",
    "realm_slugs": "closing_realm_included",
    "realm_catalogue_sha256": "salted_realm_catalogue_commitment",
    "write_capability_ref": "salted_write_capability_digest",
    "accepted_object_ref": "salted_object_ref_digest",
    "accepted_object_version": "salted_object_version_digest",
    "accepted_write_journal_ref": "salted_journal_digest",
    "terminal_evidence_ref": "salted_terminal_evidence_digest",
}
IDENTITY_CAPTURE_PROJECTION_RULES = {
    "scope-salt": (
        "each salted digest uses a certificate-scope salt committed in the manifest",
        "each digest is unsalted",
    ),
    "no-raw-cross-scope": (
        "It never copies another realm name, the raw provider-snapshot, capture or generation "
        "identifier, write-slot reference, realm catalogue, capability, journal or object "
        "reference/version",
        "It may copy raw cross-organisation metadata",
    ),
    "exact-scope": (
        "Issuance rejects a capture outside the locked closure's generation range, any entry "
        "scoped to another organisation, any unsalted/raw cross-organisation value, and any source "
        "field left unclassified",
        "Issuance accepts cross-organisation entries",
    ),
}
BACKUP_PROJECTION_REQUIREMENT = (
    "The permanent customer-readable certificate embeds the exhaustive per-organisation "
    "projection defined in [`../domain/MODEL.md`](../domain/MODEL.md): it proves the closing "
    "realm's membership, slot outcome, lock boundary and absence/refusal evidence while replacing "
    "the closure's raw operator-only manifest/evidence references and global cutoff generation, "
    "and every shared capture's raw global capture/generation identifier, provider-snapshot and "
    "write-slot references, realm catalogues, capabilities, journals and object "
    "references/versions with certificate-salted digests"
)

IDENTITY_CLOSURE_INCLUDED_FIELDS = {
    "id",
    "organisation_id",
    "organisation_slug",
    "realm_slug",
    "closure_job_id",
    "state",
    "manifest_sha256",
    "realm_deleted_at",
    "realm_absence_verified_at",
    "sealed_at",
}
IDENTITY_CLOSURE_DERIVED_FIELDS = {
    "cutoff_generation": "salted_cutoff_generation_digest",
    "manifest_ref": "salted_closure_manifest_ref_digest",
    "realm_deletion_evidence_ref": "salted_realm_deletion_evidence_digest",
    "realm_absence_evidence_ref": "salted_realm_absence_evidence_digest",
}
IDENTITY_CLOSURE_RAW_AUTHORITY_RULE = (
    "The included closure `id` and `closure_job_id` are exact-organisation authorities exposed "
    "only to that same customer; they never identify a shared generation, capture, snapshot, slot "
    "or object and are not cross-tenant correlators"
)

CLEANUP_ACTOR_FIELDS = {
    "cancellation_actor_type": "enum",
    "cancellation_actor_identity_id": "UUIDv7 NULL",
}

RETENTION_CLOCK_FIELDS = {
    ("DpaAcceptance", "Field"): {
        "contract_ended_at": "timestamptz NULL",
        "retained_until`, `purge_after": "timestamptz NULL",
    },
    ("Subscription", "Field"): {
        "contract_ended_at": "timestamptz NULL",
        "retained_until`, `purge_after": "timestamptz NULL",
    },
    ("Order", "Field"): {
        "contract_ended_at": "timestamptz NULL",
        "retained_until`, `purge_after": "timestamptz NULL",
    },
    ("Invoice", "Field"): {
        "accounting_event_at`, `financial_year_closed_at": "timestamptz NULL",
        "retained_until`, `purge_after": "timestamptz NULL",
    },
    ("InvoiceLine", "Field"): {
        "accounting_event_at`, `financial_year_closed_at": "timestamptz NULL",
        "retained_until`, `purge_after": "timestamptz NULL",
    },
    ("CreditNote", "Field"): {
        "accounting_event_at`, `financial_year_closed_at": "timestamptz",
        "retained_until`, `purge_after": "timestamptz",
    },
    ("CreditNoteLine", "Field"): {
        "accounting_event_at`, `financial_year_closed_at": "timestamptz",
        "retained_until`, `purge_after": "timestamptz",
    },
    ("Payment and PaymentLink", "Payment"): {
        "accounting_event_at`, `financial_year_closed_at": "timestamptz",
        "retained_until`, `purge_after": "timestamptz",
    },
}

LEGAL_WRITE_GUARDS = {
    "retarget": (
        "refuses every authority or subject UUID or paired scope/identity snapshot change, "
        "including clearing a set value, replacing it with another UUID or changing the paired "
        "label while keeping the UUID",
        "permits an authority UUID to be retargeted",
    ),
    "initial-bind-allowlist": (
        "Only `Invoice.subscription_id`, `Invoice.order_id`, `InvoiceLine.subscription_id` and "
        "`Payment.payment_link_id` may make one `NULL` to UUID transition",
        "Any nullable authority may bind or rebind",
    ),
    "order-completeness": (
        "`retained_order_authority_complete` check requires `dpa_id`, `subscription_id`, "
        "`invoice_id`, `tenant_id` and `tenant_slug_snapshot` all non-null at the order commit",
        "`retained_order_authority_complete` permits partial order authority",
    ),
    "payment-pair": (
        "`retained_payment_allocation_valid` check requires `(invoice_id, "
        "invoice_number_snapshot)` to be `(null, null)` for `unmatched` or `on_account` and both "
        "non-null for `allocated`",
        "`retained_payment_allocation_valid` permits a partial payment invoice pair",
    ),
    "payment-number-source": (
        "requires `invoice_number_snapshot` to equal the locked `Invoice.number`",
        "permits the Payment invoice number snapshot to differ from its locked Invoice",
    ),
    "subscription-pair": (
        "`retained_subscription_tenant_pair` check requires `tenant_id` and "
        "`tenant_slug_snapshot` either both null or both non-null",
        "`retained_subscription_tenant_pair` permits a partial tenant pair",
    ),
    "credit-note-line-pairs": (
        "The `retained_credit_note_line_authority_complete` check requires both authority pairs "
        "(`credit_note_id`, `credit_note_number_snapshot`) and (`invoice_id`, "
        "`invoice_number_snapshot`), plus `invoice_line_id` and `organisation_id`, non-null at "
        "insertion",
        "`retained_credit_note_line_authority_complete` permits partial line authority",
    ),
    "credit-note-line-source-equality": (
        CREDIT_NOTE_LINE_SOURCE_EQUALITY,
        "permits a credit-note line to disagree with its locked sources",
    ),
    "credit-note-line-immutable": (
        "No later writer may change a line or retarget either pair",
        "A later writer may rewrite a credit-note line",
    ),
    "pre-issuance-bind": (
        "for Invoice and InvoiceLine this transition is permitted only while the locked invoice "
        "is `draft` and its `accounting_event_at`, `financial_year_closed_at`, `retained_until` "
        "and `purge_after` are all null",
        "Invoice and InvoiceLine authority may bind after issuance",
    ),
    "payment-allocation-transition": (
        "Only the audited allocation writer may move `unmatched` to `on_account` or `allocated`, "
        "or `on_account` to `allocated`",
        "Any writer may move or reverse Payment allocation state",
    ),
    "payment-allocation-immutable": (
        "refuses every reverse transition, evidence-chain rewrite, second allocation or retarget",
        "permits Payment reallocation and invoice retargeting",
    ),
    "payment-allocation-evidence": (
        "requires an empty evidence chain and null final-allocation authority for `unmatched`, a "
        "non-empty chain with null final-allocation authority for `on_account`, and a non-empty "
        "chain plus non-null `allocated_at` for `allocated`",
        "permits Payment allocation without a complete immutable evidence chain",
    ),
}

INVOICE_ISSUANCE_REQUIREMENTS = {
    "nullable-draft": (
        "permits number, `issued_at`, `due_at`, line-number snapshot, accounting event, "
        "financial-year close and both retention deadlines to be null only while the invoice is `draft`",
        "permits issuance fields to be null after draft",
    ),
    "atomic-non-null": (
        "the single issuance transaction allocates the number last and fixes every one of those "
        "values non-null, with every line clock equal to its Invoice clock, before `issued` can commit",
        "issuance may commit with partial fields",
    ),
    "line-number-source": (
        "requires every `InvoiceLine.invoice_number_snapshot` to equal the locked `Invoice.number`",
        "permits an InvoiceLine number snapshot to differ from its locked Invoice",
    ),
    "state-guard": (
        "A draft cannot carry a partial issuance field, and an issued invoice or line cannot retain "
        "a null or later-mutated issuance field",
        "draft and issued rows may carry partial clocks",
    ),
}

IDENTITY_GENERATION_FIELDS = {
    "state": (
        "enum",
        "`open` \\| `draining` \\| `sealed`; the durable "
        "`identity_backup_generation_one_open` partial unique index on `(state) WHERE state = "
        "'open'` permits at most one open generation",
    ),
    "opened_at": ("timestamptz", "Immutable generation-open instant fixed at insertion"),
    "sealed_at": (
        "timestamptz NULL",
        "Null exactly while `state` is `open` or `draining`; fixed once when `state` becomes `sealed`",
    ),
}

IDENTITY_CATALOGUE_STATE_FIELDS = {
    "singleton_key": (
        "text primary key, CHECK",
        "The durable named constraint `identity_backup_catalogue_state_singleton_key` enforces "
        "`CHECK (singleton_key = 'identity-backup-catalogue')`; with the primary key this permits "
        "exactly one possible global row",
    ),
    "initialized_at": ("timestamptz", "Immutable one-shot initialization instant"),
    "initial_head_id": (
        "UUIDv7, not FK",
        "Immutable non-FK snapshot of the head inserted by initialization",
    ),
    "initial_generation": (
        "bigint",
        "Immutable generation value of that same locked head",
    ),
}

SYSTEM_ONLY_GLOBAL_CONTROL_EVIDENCE_ROWS = (
    "IdentityBackupCatalogueState",
    "IdentityBackupGeneration",
    "IdentityBackupCapture",
)
GLOBAL_CONTROL_LIST_CLAUSE = (
    "System-only global control/evidence rows are exactly `IdentityBackupCatalogueState`, "
    "`IdentityBackupGeneration` and `IdentityBackupCapture`"
)
ORGANISATION_SCOPING_CONVENTION = (
    "every table that is neither a global catalogue nor an explicitly listed system-only global "
    "control/evidence row carries `organisation_id` directly or is reachable through its "
    "explicitly classified scope anchor"
)
GLOBAL_CATALOGUE_ROWS = (
    "Plan",
    "Price",
    "Pack",
    "CapacityTier",
    "LegalDocument",
    "Release",
)
GLOBAL_CATALOGUE_CLAUSE = (
    "Global catalogue rows are exactly `Plan`, `Price`, `Pack`, `CapacityTier`, `LegalDocument` "
    "and `Release`"
)
MODEL_ROOT_ROWS = ("User", "Organisation")
MODEL_ROOT_CLAUSE = (
    "the only model roots outside that rule are the cross-organisation `User` and the "
    "`Organisation` root itself"
)
NON_PERSISTED_MODEL_PROJECTIONS = ("Entitlement", "SupportTicket", "OrganisationBootstrap")
# The one stored projection while no helpdesk exists: the `support` app's ticket table, exempt only
# while MODEL.md's departure under `SupportTicketLink` opens with this sentence. Removing the
# departure ends the exemption, and the reflection refuses the table again.
STORED_WHILE_NO_HELPDESK_CLAUSE = (
    "**Departure while no helpdesk exists: Core stores ticket content.**"
)
STORED_WHILE_NO_HELPDESK = ("SupportTicket", "support", "support_supportticket")
# The one operation exempt in the migrations: this file's single `CreateModel(name='SupportTicket')`,
# with no `db_table`. Any other SupportTicket-named creation, in this file or another, still counts.
STORED_WHILE_NO_HELPDESK_MIGRATION = "apps/support/migrations/0001_initial.py"
STORED_WHILE_NO_HELPDESK_CREATE = "name='SupportTicket'"
STORED_WHILE_NO_HELPDESK_NEUTRAL = "name='ExemptStoredTicketCreate'"
NON_PERSISTED_MODEL_PROJECTION_CLAUSE = (
    "The only non-persisted model projections are `Entitlement`, `SupportTicket` and "
    "`OrganisationBootstrap`"
)
MIXED_SCOPE_MODEL_ROWS = ("Identity", "Incident", "MaintenanceWindow", "Secret", "AuditEvent")
MIXED_SCOPE_CLAUSE = (
    "Mixed-scope tables are exactly `Identity`, `Incident`, `MaintenanceWindow`, `Secret` and "
    "`AuditEvent`"
)
SYSTEM_GLOBAL_STAFF_CONTROL_ROWS = ("StaffRole",)
SYSTEM_GLOBAL_STAFF_CONTROL_CLAUSE = "The system-global staff control row is exactly `StaffRole`"
IDENTITY_SCOPE_ENFORCEMENT_CLAUSE = (
    "The feasible scope enforcement is deliberately split: `identity_staff_realm_valid` and "
    "`identity_staff_issuer_valid` constrain organisation-null staff identities, "
    "`organisation_realm_not_staff` prevents a customer organisation from using the staff realm, "
    "and the composite `identity_organisation_binding_fk` binds every non-null organisation to "
    "the exact issuer and realm"
)
IDENTITY_MIXED_SCOPE_FIELD = (
    "FK `Organisation` NULL",
    "The organisation whose realm the identity belongs to, bound with `issuer` and `realm` to the "
    "organisation's. Null exactly for a staff identity, which is in the staff realm `kodera-staff` "
    "([`../specs/STAFF_IDENTITY.md`](../specs/STAFF_IDENTITY.md) §1)",
)
STAFF_ROLE_IDENTITY_FIELD = (
    "FK `Identity`, restrict",
    "With `realm`, references the identity's `(id, realm)`, so only a staff identity can hold a "
    "grant",
)
STAFF_ROLE_REALM_FIELD = ("text", "Always `kodera-staff`")
INCIDENT_SCOPE_CHECK_CLAUSE = (
    "The named `incident_scope_valid` check requires `scope = platform` with both "
    "`organisation_id` and `tenant_id` null, or `scope = tenant` with both non-null"
)
MAINTENANCE_SCOPE_CLAUSE = (
    "The named `maintenance_window_scope_valid` check permits exactly one of `organisation_id` "
    "and `tenant_id` to be set, or neither for the fleet default; it refuses both non-null"
)
SECRET_FLEET_SCOPE_FIELD = ("FK `Tenant` NULL", "Null for a fleet-level secret")
MAINTENANCE_MIXED_SCOPE_FIELDS = {
    "organisation_id": ("FK `Organisation` NULL", "Null = fleet default"),
    "tenant_id": ("FK `Tenant` NULL", ""),
}
AUDIT_SCOPE_FIELD = (
    "UUIDv7 NULL",
    "The organisation the event concerns; null only for fleet-level events",
)
AUDIT_SCOPE_RUNTIME_GAP = (
    "Audit organisation scope is currently a caller convention, not an exhaustively enforced "
    "runtime boundary: writers accept nullable organisation scope and the database has no central "
    "discriminator"
)
ORGANISATION_SCOPED_MODEL_ROWS = (
    "OrganisationIntake",
    "RealmReadiness",
    "OwnerClaim",
    "Membership",
    "Invitation",
    "MemberImport",
    "EnrolmentToken",
    "Contact",
    "DpaAcceptance",
    "Subscription",
    "Order",
    "Invoice",
    "InvoiceLine",
    "CreditNote",
    "CreditNoteLine",
    "Payment",
    "PaymentLink",
    "Tenant",
    "TenantExit",
    "ExitCutoffReconciliation",
    "ExitCutoffJobReconciliation",
    "ExitCutoffClaimSessionReconciliation",
    "ProjectBootstrap",
    "OrderedCancellationCleanup",
    "Job",
    "JobLockReservation",
    "JobClaimSession",
    "JobStep",
    "JobDispatch",
    "JobReconciliationDecision",
    "OutboxDelivery",
    "OutboxDeliveryReconciliationDecision",
    "OutboxMessage",
    "OutboxDeliveryAttempt",
    "Host",
    "Ip",
    "Domain",
    "FederationProvider",
    "FederationTest",
    "TenantRelease",
    "Backup",
    "IdentityBackupClosure",
    "Probe",
    "StatusComponent",
    "Agent",
    "SupportTicketLink",
    "Export",
    "DeletionCertificate",
    "Notification",
)
ORGANISATION_SCOPE_ANCHORS = {
    "OrganisationIntake": ("organisation_id", "Organisation"),
    "RealmReadiness": ("organisation_id", "Organisation"),
    "OwnerClaim": ("organisation_id", "Organisation"),
    "Membership": ("organisation_id", "Organisation"),
    "Invitation": ("organisation_id", "Organisation"),
    "MemberImport": ("organisation_id", "Organisation"),
    "EnrolmentToken": ("organisation_id", "Organisation"),
    "Contact": ("organisation_id", "Organisation"),
    "DpaAcceptance": ("organisation_id", "Organisation"),
    "Subscription": ("organisation_id", "Organisation"),
    "Order": ("organisation_id", "Organisation"),
    "Invoice": ("organisation_id", "Organisation"),
    "InvoiceLine": ("organisation_id", "Organisation"),
    "CreditNote": ("organisation_id", "Organisation"),
    "CreditNoteLine": ("organisation_id", "Organisation"),
    "Payment": ("organisation_id", "Organisation"),
    "PaymentLink": ("organisation_id", "Organisation"),
    "Tenant": ("organisation_id", "Organisation"),
    "TenantExit": ("tenant_id", "Tenant"),
    "ExitCutoffReconciliation": ("tenant_exit_id", "TenantExit"),
    "ExitCutoffJobReconciliation": ("cutoff_reconciliation_id", "ExitCutoffReconciliation"),
    "ExitCutoffClaimSessionReconciliation": (
        "job_reconciliation_id",
        "ExitCutoffJobReconciliation",
    ),
    "ProjectBootstrap": ("tenant_id", "Tenant"),
    "OrderedCancellationCleanup": ("organisation_id", "Organisation"),
    "Job": ("organisation_id", "Organisation"),
    "JobLockReservation": ("job_id", "Job"),
    "JobClaimSession": ("job_id", "Job"),
    "JobStep": ("job_id", "Job"),
    "JobDispatch": ("job_id", "Job"),
    "JobReconciliationDecision": ("job_id", "Job"),
    "OutboxDelivery": ("organisation_id", "Organisation"),
    "OutboxDeliveryReconciliationDecision": ("delivery_id", "OutboxDelivery"),
    "OutboxMessage": ("delivery_id", "OutboxDelivery"),
    "OutboxDeliveryAttempt": ("delivery_id", "OutboxDelivery"),
    "Host": ("tenant_id", "Tenant"),
    "Ip": ("tenant_id", "Tenant"),
    "Domain": ("tenant_id", "Tenant"),
    "FederationProvider": ("tenant_id", "Tenant"),
    "FederationTest": ("organisation_id", "Organisation"),
    "TenantRelease": ("tenant_id", "Tenant"),
    "Backup": ("tenant_id", "Tenant"),
    "IdentityBackupClosure": ("organisation_id", "Organisation"),
    "Probe": ("tenant_id", "Tenant"),
    "StatusComponent": ("tenant_id", "Tenant"),
    "Agent": ("tenant_id", "Tenant"),
    "SupportTicketLink": ("organisation_id", "Organisation"),
    "Export": ("organisation_id", "Organisation"),
    "DeletionCertificate": ("organisation_id", "Organisation"),
    "Notification": ("organisation_id", "Organisation"),
}
MODEL_REFLECTION_CLAUSE = (
    "Executable source-contract reflection rejects every new normative table or model projection "
    "until it is explicitly classified, while runtime-registry and migration reflection "
    "separately refuse persistence of those three projections"
)
GLOBAL_CONTROL_ACCESS_CLAUSE = (
    "none has a customer API/queryset. `IdentityBackupCatalogueState` is initializer-only, while "
    "`IdentityBackupGeneration` and `IdentityBackupCapture` use the worker/staff-security rule in §6"
)
GLOBAL_CONTROL_OPTIONAL_ER_PROVENANCE = (
    'IdentityBackupCatalogueState o|--o| IdentityBackupGeneration : "initially snapshots non-FK"'
)
GLOBAL_CONTROL_FALSE_LIFETIME_ER_EDGE = (
    'IdentityBackupCatalogueState ||--|| IdentityBackupGeneration : "bootstraps non-FK"'
)
FORBIDDEN_CUSTOMER_BACKUP_SCHEMA_SIGNATURES = {
    "catalogue-state": frozenset(
        {"singleton_key", "initialized_at", "initial_head_id", "initial_generation"}
    ),
    "generation": frozenset({"id", "generation", "state", "opened_at", "sealed_at"}),
    "capture": frozenset(
        {
            "id",
            "generation_id",
            "kind",
            "realm_slugs",
            "provider_snapshot_ref",
            "realm_catalogue_sha256",
            "state",
            "write_slot_ref",
            "write_capability_ref",
        }
    ),
    "closure": frozenset(
        {
            "id",
            "organisation_id",
            "organisation_slug",
            "realm_slug",
            "cutoff_generation",
            "closure_job_id",
            "state",
            "manifest_ref",
            "manifest_sha256",
            "realm_deleted_at",
            "realm_deletion_evidence_ref",
            "realm_absence_verified_at",
            "realm_absence_evidence_ref",
            "sealed_at",
        }
    ),
}
FORBIDDEN_CUSTOMER_BACKUP_FIELDS = frozenset(
    {
        "singleton_key",
        "initial_head_id",
        "initial_generation",
        "generation_id",
        "realm_slugs",
        "provider_snapshot_ref",
        "realm_catalogue_sha256",
        "write_slot_ref",
        "write_capability_ref",
        "accepted_object_ref",
        "accepted_object_version",
        "accepted_write_journal_ref",
        "terminal_evidence_ref",
        "cutoff_generation",
        "manifest_ref",
        "realm_deletion_evidence_ref",
        "realm_absence_evidence_ref",
    }
)


class OpenAPIProjectionPolicy(TypedDict):
    fields: frozenset[str]
    exact: bool
    bindings: frozenset[tuple[str, str]]
    locations: frozenset[str]


OPENAPI_PROJECTION_POLICIES: dict[str, OpenAPIProjectionPolicy] = {
    "release-generation-v1": {
        "fields": frozenset({"generation", "state", "initialized_at"}),
        "exact": False,
        "bindings": frozenset(
            {
                ("getReleaseGeneration", "path:/release-generation"),
                ("receiveReleaseGeneration", "webhook:releaseGeneration"),
            }
        ),
        "locations": frozenset(
            {
                "schema-location:#/paths/~1release-generation/get/responses/200/content/"
                "application~1json/schema",
                "schema-location:#/webhooks/releaseGeneration/post/responses/200/content/"
                "application~1json/schema",
            }
        ),
    },
    "deletion-certificate-identity-backup-closure-v1": {
        "fields": frozenset(
            {
                "id",
                "organisation_id",
                "organisation_slug",
                "realm_slug",
                "closure_job_id",
                "state",
                "manifest_sha256",
                "realm_deleted_at",
                "realm_absence_verified_at",
                "sealed_at",
            }
        ),
        "exact": True,
        "bindings": frozenset(
            {
                (
                    "getDeletionCertificateSafeBackupProjection",
                    "path:/deletion-certificate-safe-backup-projection",
                )
            }
        ),
        "locations": frozenset(
            {
                "schema-location:#/paths/~1deletion-certificate-safe-backup-projection/get/"
                "responses/200/content/application~1json/schema/properties/closure"
            }
        ),
    },
    "deletion-certificate-identity-backup-capture-v1": {
        "fields": frozenset({"kind", "state", "store_accepted_at", "lock_until"}),
        "exact": True,
        "bindings": frozenset(
            {
                (
                    "getDeletionCertificateSafeBackupProjection",
                    "path:/deletion-certificate-safe-backup-projection",
                )
            }
        ),
        "locations": frozenset(
            {
                "schema-location:#/paths/~1deletion-certificate-safe-backup-projection/get/"
                "responses/200/content/application~1json/schema/properties/captures/items"
            }
        ),
    },
}
PROVENANCE_REQUIRED_OPENAPI_FIELDS = frozenset({"generation"})
OPENAPI_PROJECTION_POLICY_CLAUSE = (
    "every reachable OpenAPI schema that uses it declares an `x-kodera-projection` from the closed "
    "projection registry and stays within that entry's exact field, operation and structural "
    "location allowlists as a closed object whose declared fields are all required"
)

IDENTITY_CAPTURE_GENERATION_FIELD = (
    "FK `IdentityBackupGeneration`",
    "Bound under the shared catalogue reservation to the locked unique current `open` head; the "
    "constraint trigger refuses a non-open, stale or non-head generation",
)

BACKUP_CLOCK_REQUIREMENTS = {
    "accepted-objects": (
        "When the manifest contains at least one accepted object, `backups_locked_until` is "
        "exactly the maximum accepted-object `lock_until`, and final `backups_purged_at` is "
        "non-null and not earlier than that maximum",
        "Every non-empty manifest requires an expiry clock",
    ),
    "no-write-only": (
        "When it contains zero accepted objects, including a non-empty no-write-only manifest, "
        "`backups_locked_until` is null; final issuance skips the expiry comparison, "
        "reauthenticates every slot's no-write and terminal proof, and records non-null trusted "
        "`backups_purged_at` on completion",
        "A no-write-only manifest requires a fabricated expiry clock",
    ),
    "mixed": (
        "A mixed manifest uses the maximum accepted-object expiry and also reauthenticates every "
        "no-write proof",
        "A mixed manifest may omit its no-write proofs",
    ),
}

MODEL_BACKUP_CLOCK_REQUIREMENTS = {
    "accepted-objects": (
        "When the manifest contains at least one accepted object, the initial "
        "`backups_locked_until` is non-null and exactly the maximum accepted-object "
        "`lock_until`, and the final `backups_purged_at` must not be earlier",
        "Every non-empty manifest uses an unspecified backup clock",
    ),
    "no-write-only": (
        "When it contains zero accepted objects, including a non-empty no-write-only manifest, "
        "`backups_locked_until` is null; final issuance skips the expiry comparison, "
        "reauthenticates every slot's no-write and terminal proof, and records "
        "`backups_purged_at` as that trusted completion instant",
        "A no-write-only manifest fabricates an expiry clock",
    ),
    "mixed": (
        "A mixed manifest uses the maximum accepted-object expiry and also reauthenticates every "
        "no-write proof",
        "A mixed manifest may omit its no-write proofs",
    ),
}

DELETION_CERTIFICATE_BACKUP_CLOCK_FIELD = (
    "timestamptz NULL",
    "On an initial attestation, exactly the maximum `lock_until` when the backup manifest "
    "contains at least one accepted object; null when it contains zero accepted objects, "
    "including a non-empty no-write-only manifest",
)

IDENTITY_SOURCE_LIFECYCLE_REQUIREMENTS = {
    "unique-open-index": (
        "The durable `identity_backup_generation_one_open` partial unique index on `(state) WHERE "
        "state = 'open'` permits at most one open generation",
        "Open generations are not durably unique",
    ),
    "catalogue-singleton-check": (
        "The durable named constraint `identity_backup_catalogue_state_singleton_key` enforces "
        "`CHECK (singleton_key = 'identity-backup-catalogue')`; with the primary key this permits "
        "exactly one possible global row",
        "The catalogue state accepts arbitrary singleton keys",
    ),
    "initial-bootstrap-exclusive-empty": (
        "The one-shot initializer holds `identity-backup-catalogue` exclusive and locks and "
        "rechecks both the singleton marker and generation table. It requires the marker absent "
        "and table truly empty",
        "Bootstrap may seed a head whenever none is open",
    ),
    "initial-bootstrap-atomic-pair": (
        "inserts exactly one `open` head and the `IdentityBackupCatalogueState` row atomically; "
        "either both commit or neither does",
        "The marker and head may commit separately",
    ),
    "initial-bootstrap-authority-match": (
        "The marker's `initial_head_id` and `initial_generation` exactly equal that locked "
        "inserted head and `initialized_at` is fixed by the same transaction",
        "The marker may name a different bootstrap head",
    ),
    "concurrent-initializer-serialization": (
        "A concurrent initializer serializes behind that reservation and then refuses the "
        "existing marker",
        "Concurrent initializers may both use an empty snapshot",
    ),
    "catalogue-marker-immutable": (
        "The `identity_backup_catalogue_state_immutable` trigger refuses every update or delete, "
        "so the marker cannot clear or be rewritten",
        "The catalogue marker may be cleared",
    ),
    "no-later-zero-head-recovery": (
        "Once it exists, any zero-row or zero-open state is a fail-closed reconciliation incident; "
        "no bootstrap, recovery or cleanup path may invent a replacement head",
        "A later zero-head table may be silently bootstrapped",
    ),
    "registration-shared-reservation": (
        "Capture registration acquires the durable global `identity-backup-catalogue` reservation "
        "shared before locking the unique current `open` head, binds that generation and its "
        "deterministic slot, and retains the reservation through commit",
        "Capture registration binds a generation before acquiring the catalogue reservation",
    ),
    "registration-open-generation": (
        "The `identity_backup_capture_open_generation` constraint trigger locks and requires "
        "exactly that unique current head and refuses zero or multiple open rows, a `draining` or "
        "`sealed` target, and any stale-open, non-head or stale direct binding",
        "Registration may bind any open generation",
    ),
    "closure-generation-rotation": (
        "Closure creation atomically locks and requires exactly one old `open` head, moves exactly "
        "that row to `draining`, creates exactly one greater monotonic `open` head, fixes the "
        "draining generation as its cutoff and selects its through-cutoff source set under that "
        "reservation",
        "Closure creation records a cutoff without rotating generations",
    ),
    "closure-generation-commit-cardinality": (
        "Before commit it re-reads the generation set and proves that exactly one old head "
        "transitioned and exactly one new current head exists; zero or multiple old or new open "
        "rows roll the transaction back without writes",
        "Closure rotation does not validate its final open-generation cardinality",
    ),
    "closure-seal-final-recheck": (
        "Closure sealing reacquires the reservation exclusive and, before setting both the "
        "generation and closure to `sealed`, rechecks under the fence that every capture at or "
        "below the cutoff is in the sealed source set with its required terminal outcome",
        "Closure sealing trusts its initial source set",
    ),
    "operational-not-permanent": (
        "`IdentityBackupGeneration`, `IdentityBackupCapture` and `IdentityBackupClosure` are "
        "bounded operational closure sources, never permanent raw evidence",
        "These three rows are permanent raw evidence",
    ),
    "operator-purge-manifest": (
        "first validates the sealed operator-only exact object/version/expiry scope and retains "
        "that content-addressed manifest at the certificate's `backup_manifest_ref` for "
        "final-purge proof",
        "drops the operator-only purge scope",
    ),
    "customer-projection-before-closure-delete": (
        "It separately copies the exhaustive safe closure/capture projections into the "
        "customer-readable finalization-evidence manifest, then deletes the sealed "
        "`IdentityBackupClosure` source row before commit",
        "deletes the closure before copying selected evidence",
    ),
    "manifest-outage-fail-closed": (
        "An unavailable manifest store or failed digest/scope check leaves every source row "
        "untouched and retries",
        "a manifest outage permits source deletion",
    ),
    "capture-bounded": (
        "A raw `IdentityBackupCapture` may remain only while its locked object exists or an "
        "unfinalized through-cutoff closure still needs it",
        "A raw capture may remain indefinitely",
    ),
    "cleanup-closure-reservation": (
        "Closure creation and capture cleanup also hold `identity-backup-catalogue` exclusive. "
        "Each acquires it before reading any capture/closure selection predicate and retains it "
        "through commit",
        "Cleanup and closure creation do not share an admission reservation",
    ),
    "cleanup-final-recheck": (
        "Cleanup locks the capture and every dependent unfinalized closure, then re-reads that "
        "complete set under the same reservation immediately before deletion",
        "Cleanup trusts its first closure read",
    ),
    "cleanup-race-order": (
        "Closure-first therefore makes the capture dependent and blocks cleanup; cleanup-first "
        "commits the capture's exclusion before a later closure may establish its source set",
        "Closure creation may interleave between cleanup recheck and delete",
    ),
    "accepted-write-cleanup": (
        "For an accepted write, all of `store_accepted_at`, `accepted_object_ref`, "
        "`accepted_object_version`, `lock_until` and `accepted_write_journal_ref` are non-null; "
        "cleanup performs an authenticated read of that exact object/version",
        "Accepted-write cleanup does not authenticate the exact object",
    ),
    "selected-accepted-write-durability": (
        "If a closure selected that capture into its sealed scope, cleanup additionally requires "
        "the exact object/version/expiry scope to be durable in that closure's permanent "
        "`DeletionCertificate.backup_manifest_ref`",
        "Selected accepted-write evidence need not be durable",
    ),
    "no-write-cleanup": (
        "For a no-write outcome, those five accepted-write fields are all null; cleanup "
        "authenticates the deterministic slot's no-accepted-journal/no-object result and the "
        "capture's terminal no-snapshot/refusal evidence before the same final closure recheck",
        "No-write cleanup assumes null object fields prove absence",
    ),
    "selected-no-write-durability": (
        "If a closure selected that no-write capture, its exact slot, no-write outcome and terminal "
        "evidence must already be durable in the closure's permanent `backup_manifest_ref`",
        "Selected no-write evidence need not be durable",
    ),
    "ordinary-capture-no-certificate": (
        "An ordinary expired active-organisation capture selected by no closure requires no "
        "deletion certificate and is deleted after its matching authenticated outcome proof and "
        "no-pending-closure proof",
        "An ordinary capture waits for a deletion certificate",
    ),
    "capture-outage-fail-closed": (
        "A partial accepted-write tuple, missing slot or terminal evidence, journal/store outage, "
        "unknown outcome or object reappearance writes nothing and retries",
        "an outage is treated as absence",
    ),
    "generation-opened-at-immutable": (
        "`IdentityBackupGeneration.opened_at` is immutable from insertion",
        "A generation may rewrite its opening instant",
    ),
    "generation-state-clock": (
        "The `identity_backup_generation_state_valid` check requires `sealed_at` null exactly for "
        "`open` and `draining`, and non-null exactly for `sealed`",
        "A generation may carry any sealing timestamp in any state",
    ),
    "generation-one-way-seal": (
        "only the generation transition writer may move `open` to `draining` to `sealed`, and it "
        "fixes `sealed_at` once on sealing. No state or clock regression, clearing or rewrite is "
        "permitted",
        "A generation may reopen or rewrite its sealing instant",
    ),
    "generation-cleanup-exclusive": (
        "Generation cleanup holds `identity-backup-catalogue` exclusive through commit, locks "
        "both the candidate and unique current head",
        "Generation cleanup runs without the catalogue reservation",
    ),
    "generation-cleanup-final-recheck": (
        "immediately before deletion re-reads their identities/states plus every capture, closure "
        "and unfinalized cutoff that could reference the candidate",
        "Generation cleanup trusts its initial scan",
    ),
    "generation-cleanup-eligibility": (
        "It deletes child-last only when the candidate is `sealed`, is not the current head, has "
        "zero captures and closures and no unfinalized closure can include its cutoff",
        "Generation cleanup may delete a non-sealed or referenced generation",
    ),
    "generation-cleanup-refusals": (
        "It refuses an `open`, `draining` or current-head candidate, any changed head/state, any "
        "late child or cutoff, and any unavailable recheck without writing",
        "Generation cleanup may ignore a changed head or late child",
    ),
    "generation-idle-head-survives": (
        "The idle sole open head therefore survives indefinitely until an ordinary closure "
        "rotation replaces it; cleanup never creates a zero-head recovery condition",
        "Cleanup may delete the idle open head",
    ),
    "catalogue-marker-lifetime-scope": (
        "`IdentityBackupCatalogueState` is a lifetime non-personal control marker outside "
        "generation rows: normal cleanup never touches it, it has no foreign key, provider/customer "
        "identifier or secret, and no customer API, certificate projection or retention manifest "
        "includes it",
        "The catalogue marker may enter customer evidence or retention cleanup",
    ),
    "operator-manifest-customer-separation": (
        "The operator-only backup manifest remains lifetime-resolvable for purge verification, "
        "while no customer-readable certificate projection or customer-scoped audit row exposes "
        "raw realm lists, provider or object references, capture identifiers or generation "
        "identifiers",
        "Customer evidence may expose the operator-only raw purge scope",
    ),
    "durable-final-organisation-uniqueness": (
        "The durable `deletion_certificate_final_organisation_once` partial unique index on "
        "`(organisation_id) WHERE kind = 'active_store_attestation' AND closure_scope = "
        "'final_organisation'` refuses more than one final-organisation initial attestation for "
        "an organisation",
        "Final-organisation attestations are not durably unique",
    ),
    "closure-refuses-prior-attestation": (
        "The closure-creation writer locks the organisation and refuses a new closure when that "
        "permanent attestation already exists",
        "The closure writer may ignore an earlier permanent attestation",
    ),
}

BACKUP_SOURCE_LIFECYCLE_REQUIREMENTS = {
    "unique-open-index": (
        "The durable `identity_backup_generation_one_open` partial unique index on `(state) WHERE "
        "state = 'open'` permits at most one open generation",
        "Open generations are not durably unique",
    ),
    "catalogue-singleton-check": (
        "`IdentityBackupCatalogueState.singleton_key` is protected by the durable named constraint "
        "`identity_backup_catalogue_state_singleton_key` with `CHECK (singleton_key = "
        "'identity-backup-catalogue')`; together with its primary key, no alternate key or direct "
        "second-row insert is possible",
        "The catalogue state accepts arbitrary singleton keys",
    ),
    "initial-bootstrap-exclusive-empty": (
        "The one-shot initializer holds `identity-backup-catalogue` exclusive, locks and rechecks "
        "both the immutable `IdentityBackupCatalogueState` singleton and the generation table, "
        "requires marker absent plus a truly empty table",
        "Bootstrap may seed a head whenever none is open",
    ),
    "initial-bootstrap-atomic-pair": (
        "atomically inserts exactly one `open` head and marker or neither",
        "The marker and head may commit separately",
    ),
    "initial-bootstrap-authority-match": (
        "The marker's head id/generation exactly equal that locked inserted head and its "
        "initialization clock is fixed in the same transaction",
        "The marker may name a different bootstrap head",
    ),
    "concurrent-initializer-serialization": (
        "Concurrent initializers serialize and every later attempt refuses the existing marker",
        "Concurrent initializers may both use an empty snapshot",
    ),
    "catalogue-marker-immutable": (
        "The marker cannot clear or be rewritten",
        "The catalogue marker may be cleared",
    ),
    "no-later-zero-head-recovery": (
        "Once it exists, any zero-row or zero-open state is a fail-closed reconciliation incident; "
        "bootstrap, recovery and cleanup never invent a replacement",
        "A later zero-head table may be silently bootstrapped",
    ),
    "registration-shared-reservation": (
        "Every dump/export writer acquires the durable global `identity-backup-catalogue` "
        "reservation shared before locking the unique current `open` head, binds that generation "
        "and its deterministic slot, and retains the reservation through registration commit",
        "A writer registers before acquiring the catalogue reservation",
    ),
    "registration-open-generation": (
        "A database constraint trigger locks and requires exactly that unique current head and "
        "refuses zero or multiple open rows, a `draining` or `sealed` target, and any stale-open, "
        "non-head or stale direct binding",
        "Registration may bind any open generation",
    ),
    "closure-generation-rotation": (
        "Closure creation atomically locks and requires exactly one old `open` head, moves exactly "
        "that row to `draining`, creates exactly one greater monotonic `open` head, fixes the "
        "draining generation as its cutoff and selects its through-cutoff source set under that "
        "reservation",
        "Closure creation records a cutoff without rotating generations",
    ),
    "closure-generation-commit-cardinality": (
        "Before commit it re-reads the generation set and proves that exactly one old head "
        "transitioned and exactly one new current head exists; zero or multiple old or new open "
        "rows roll the transaction back without writes",
        "Closure rotation does not validate its final open-generation cardinality",
    ),
    "closure-seal-final-recheck": (
        "Closure sealing reacquires the reservation exclusive and, before marking the generation "
        "and closure `sealed`, rechecks that every capture at or below the cutoff is in the sealed "
        "source set with its required terminal outcome",
        "Closure sealing trusts its initial source set",
    ),
    "operational-not-permanent": (
        "The raw `IdentityBackupGeneration`, `IdentityBackupCapture` and "
        "`IdentityBackupClosure` rows are bounded operational closure sources, not permanent "
        "evidence",
        "The raw identity rows are permanent evidence",
    ),
    "operator-and-customer-manifests-before-delete": (
        "Final-organisation finalization first validates and retains the sealed operator-only "
        "exact object/version/expiry scope at the permanent `backup_manifest_ref`, and copies the "
        "safe, exhaustive projection into the customer-readable finalization-evidence manifest. "
        "It then deletes the sealed closure source in that transaction",
        "Finalization deletes source evidence before copying it",
    ),
    "outage-fail-closed": (
        "if either manifest is unavailable or its digest/scope cannot be verified, it leaves "
        "all sources unchanged and retries",
        "a manifest outage deletes sources",
    ),
    "cleanup-closure-reservation": (
        "Closure creation and capture cleanup also hold `identity-backup-catalogue` exclusive from "
        "before they read the capture/closure selection predicate through commit",
        "Cleanup and closure creation do not share an admission reservation",
    ),
    "cleanup-final-recheck": (
        "Cleanup locks the capture and every dependent unfinalized closure and re-reads the "
        "complete set immediately before deletion while still holding the reservation",
        "Cleanup trusts a stale closure set",
    ),
    "cleanup-race-order": (
        "Closure-first therefore blocks cleanup; cleanup-first commits exclusion before a later "
        "closure selects its source set",
        "Closure creation may interleave between cleanup recheck and delete",
    ),
    "accepted-write-cleanup": (
        "handles an accepted write only when all five accepted-write fields "
        "(`store_accepted_at`, `accepted_object_ref`, `accepted_object_version`, `lock_until` and "
        "`accepted_write_journal_ref`) are non-null: it authenticates exact object/version absence "
        "and, when a closure selected the capture, requires the exact object/version/expiry scope "
        "in that closure's permanent `DeletionCertificate.backup_manifest_ref`",
        "Accepted-write cleanup trusts stale inventory",
    ),
    "no-write-cleanup": (
        "For a no-write capture whose same five fields are all null, it authenticates the "
        "deterministic slot's no-accepted-journal/no-object result and terminal "
        "no-snapshot/refusal evidence; when selected, that exact slot, outcome and terminal "
        "evidence must already be durable in the closure's permanent `backup_manifest_ref`",
        "No-write cleanup assumes null fields prove absence",
    ),
    "ordinary-capture-no-certificate": (
        "ordinary expired active-organisation capture selected by no closure needs no deletion "
        "certificate",
        "Every expired capture requires a deletion certificate",
    ),
    "store-outage-fail-closed": (
        "A partial accepted-write tuple, missing slot or terminal evidence, storage/journal outage, "
        "unknown result or reappearing object writes nothing and retries",
        "A storage outage counts as absence",
    ),
    "generation-cleanup-exclusive": (
        "Generation cleanup holds `identity-backup-catalogue` exclusive through commit, locks the "
        "candidate and unique current head",
        "Generation cleanup runs without the catalogue reservation",
    ),
    "generation-cleanup-final-recheck": (
        "immediately before deletion, re-reads both plus every capture, closure and unfinalized "
        "cutoff that could reference the candidate",
        "Generation cleanup trusts its initial scan",
    ),
    "generation-cleanup-eligibility": (
        "It deletes child-last only when the candidate is `sealed`, is not the current head, has "
        "zero captures and closures and no unfinalized cutoff can include it",
        "Generation cleanup may delete a non-sealed or referenced generation",
    ),
    "generation-cleanup-refusals": (
        "It refuses an `open`, `draining` or current-head candidate, a changed head/state, any "
        "late child/cutoff or an unavailable recheck without writing",
        "Generation cleanup may ignore a changed head or late child",
    ),
    "generation-idle-head-survives": (
        "The idle sole open head remains until closure rotation; cleanup never performs zero-head "
        "recovery",
        "Cleanup may delete the idle open head",
    ),
    "catalogue-marker-lifetime-scope": (
        "`IdentityBackupCatalogueState` is a lifetime non-personal, initializer-only, "
        "system-global control row outside generation rows. Normal cleanup never touches it; it "
        "contains no foreign key, provider/customer identifier or secret, and no customer "
        "API/queryset, certificate projection or retention manifest includes it",
        "The catalogue marker may enter customer evidence or retention cleanup",
    ),
    "generation-state-clock": (
        "`IdentityBackupGeneration.opened_at` never changes. Its `sealed_at` is null in `open` and "
        "`draining`, becomes non-null exactly once on the one-way transition to `sealed`, and never "
        "clears or changes",
        "Generation state and timestamps may be rewritten",
    ),
    "operator-manifest-customer-separation": (
        "The operator-only backup manifest remains lifetime-resolvable for final-purge "
        "verification; no customer-readable certificate projection or customer-scoped audit "
        "record copies raw realm lists, provider/object references, capture identifiers or "
        "generation identifiers",
        "Customer evidence may copy raw operator scope",
    ),
}

WIRE_TO_CANONICAL_AUDIT_ACTORS = {
    "user": "tenant",
    "staff": "staff",
    "agent": "agent",
    "system": "system",
}
TAXONOMY_ACTOR_MAPPING_CLAUSE = (
    "The public `AuditEvent.actor.type` wire enum keeps `user` for compatibility. Core maps that "
    "value exactly to the canonical/runtime `tenant` actor type; `staff`, `agent` and `system` "
    "map identically"
)
TAXONOMY_AUDIT_REGISTRY_RUNTIME_BOUNDARY = (
    "An unregistered action fails the contract test. Current runtime enforcement is partial and "
    "service-specific: `AuditEvent.action` itself does not yet reject every unregistered action, "
    "and the complete writer guard remains expected-red"
)
OPENAPI_ACTOR_MAPPING_DESCRIPTION = (
    "The compatible wire value `user` maps to the canonical/runtime audit actor `tenant`; the "
    "other values map identically"
)
OPENAPI_AUDIT_REGISTRY_RUNTIME_BOUNDARY = (
    "Normative closed keys for the future Core writer guard in "
    "`docs/domain/AUDIT_TAXONOMY.md` §3; the current runtime does not yet reject an unregistered "
    "action, and this extension does not narrow the public AuditEvent wire schema"
)
OPENAPI_AUDIT_ACTION_RUNTIME_BOUNDARY = (
    "The future Core writer guard will admit only keys in `x-audit-action-registry`; the current "
    "runtime does not yet enforce that registry"
)

PAYMENT_CLASSIFICATION_REQUIREMENTS = {
    "model-continuing-finding": (
        "Every succeeded Payment with `allocation_state = unmatched` continues to produce "
        "`payment_unallocated` on every reconciliation, and that finding remains open until exactly "
        "`on_account` or `allocated` commits; provider/payment reconciliation alone cannot clear it",
        "A succeeded unmatched payment may clear its finding",
    ),
    "billing-terminal-classification": (
        "Every `Payment` with `state = succeeded` has terminal allocation classification "
        "`allocated` or `on_account`",
        "A succeeded Payment may remain unmatched",
    ),
    "billing-persistence": (
        "For every succeeded Payment still `unmatched`, `payment_unallocated` is reproduced on "
        "every reconciliation and remains open until exactly `allocated` or `on_account` commits; "
        "provider reconciliation, an unrelated finding closure or a later provider read cannot "
        "clear it",
        "A reconciliation may clear payment_unallocated",
    ),
}

AUDIT_WORKFLOW_REQUIREMENTS = {
    "payment-registry": (
        "audit",
        "| `payment.placed_on_account`, `payment.allocated` | staff, system | `payment` | standard |",
        "| `payment.allocated` | system | `payment` | standard |",
    ),
    "payment-metadata": (
        "audit",
        "Metadata is exactly `payment_id`, `organisation_id`, `previous_allocation_state`, "
        "`allocation_state` and immutable `decision_evidence_ref`, plus `invoice_id` and "
        "`invoice_number` for `payment.allocated`; those two invoice keys are absent for "
        "`payment.placed_on_account`",
        "Metadata may omit allocation evidence",
    ),
    "payment-model-transaction": (
        "model",
        "Each transition emits exactly one of `payment.placed_on_account` or `payment.allocated` "
        "in the same transaction",
        "An allocation transition need not emit an audit event",
    ),
    "payment-audit-actor-authority": (
        "audit",
        "A `staff` event records the authenticated actor identity; a `system` event records its "
        "authenticated reconciliation or job authority",
        "Payment audit actors need no authenticated authority",
    ),
    "payment-model-actor-authority": (
        "model",
        "A staff event carries its authenticated identity; a system event carries its authenticated "
        "reconciliation/job authority",
        "Payment allocation actors need no authenticated authority",
    ),
    "dpa-registry": (
        "audit",
        "| `dpa.contract_closed` | staff, tenant, system | `organisation` | standard |",
        "| `dpa.contract_closed` | system | `organisation` | standard |",
    ),
    "dpa-metadata": (
        "audit",
        "Its metadata is exactly `dpa_acceptance_id`, `order_id`, `subscription_id`, "
        "`organisation_id`, `contract_ended_at`, `close_reason` and immutable "
        "`close_evidence_ref`, copied from the locked ten-year DPA row",
        "Its metadata may omit authority evidence",
    ),
    "dpa-audit-actor-authority": (
        "audit",
        "A `staff` or `tenant` event records the authenticated actor identity; a `system` event "
        "records its authenticated job authority",
        "DPA close actors need no authenticated authority",
    ),
    "dpa-model-actor-authority": (
        "model",
        "The originating actor is exactly `staff`, `tenant` or `system`; a non-system actor carries "
        "its authenticated identity and the system actor carries its authenticated job authority",
        "DPA close actors need no authenticated authority",
    ),
    "dpa-lock-equality-atomicity": (
        "model",
        "locks the linked `Order`, `Subscription` and `DpaAcceptance` in a stable order, requires "
        "the exact authority links and organisation scope to agree, and writes one identical "
        "`contract_ended_at`, plus each row's `retained_until` and `purge_after`, atomically across "
        "all three rows",
        "updates contract clocks independently",
    ),
}

RETENTION_ROW_ANCHORS = {
    ("DpaAcceptance", "Field"): {
        "contract_ended_at": "Immutable contractual retention anchor, set only when the accepted contract ends",
        "retained_until`, `purge_after": "Set together to exactly `contract_ended_at + 10 years`; null until the contract ends",
    },
    ("Subscription", "Field"): {
        "contract_ended_at": "Immutable contractual retention anchor, set when the subscription contract ends",
        "retained_until`, `purge_after": "Set together to exactly `contract_ended_at + 10 years`; null until the contract ends",
    },
    ("Order", "Field"): {
        "contract_ended_at": "Immutable contractual retention anchor, set when the order's resulting contract ends",
        "retained_until`, `purge_after": "Set together to exactly `contract_ended_at + 10 years`; null until the contract ends",
    },
    ("Invoice", "Field"): {
        "accounting_event_at`, `financial_year_closed_at": "Null while `draft`; immutable issue event and exact financial-year close fixed atomically on `issued`",
        "retained_until`, `purge_after": "Null while `draft`; both fixed atomically on `issued` to exactly `financial_year_closed_at + 10 years`",
    },
    ("InvoiceLine", "Field"): {
        "accounting_event_at`, `financial_year_closed_at": "Null while the invoice is `draft`; immutable invoice-issue event and financial-year close copied atomically from the locked issued invoice",
        "retained_until`, `purge_after": "Null while the invoice is `draft`; both fixed atomically on issuance to exactly `financial_year_closed_at + 10 years`",
    },
    ("CreditNote", "Field"): {
        "accounting_event_at`, `financial_year_closed_at": "Immutable credit-issue event and the exact close of the financial year containing it",
        "retained_until`, `purge_after": "Both exactly `financial_year_closed_at + 10 years`",
    },
    ("CreditNoteLine", "Field"): {
        "accounting_event_at`, `financial_year_closed_at": "Immutable credit-issue event and its financial-year close copied from the locked credit note",
        "retained_until`, `purge_after": "Both exactly `financial_year_closed_at + 10 years`",
    },
    ("Payment and PaymentLink", "Payment"): {
        "accounting_event_at`, `financial_year_closed_at": "Immutable provider-payment event and the exact close of the financial year containing it",
        "retained_until`, `purge_after": "Both exactly `financial_year_closed_at + 10 years`",
    },
}

PAYMENT_LINK_REQUIREMENTS = {
    "terminal-clock": (
        "The terminal-state writer sets `deleted_at` and `purge_after = min(deleted_at + 90 "
        "days, invoice.purge_after)` in the same transaction",
        "The terminal-state writer may omit the PaymentLink purge clock",
    ),
    "creation-boundary": (
        "Creation locks its invoice and requires `expires_at < invoice.purge_after`",
        "Creation may outlive the Invoice purge boundary",
    ),
    "child-first": (
        "At Invoice purge, one transaction locks the Invoice and every PaymentLink and reads one "
        "trusted database `clock_timestamp()`",
        "The Invoice purge may ignore PaymentLink children",
    ),
    "delayed-writer-fallback": (
        "If a link is still `active` because its terminal writer was delayed or unavailable but "
        "`expires_at <=` that trusted instant, the same transaction terminalizes and deletes it "
        "before the Invoice",
        "A delayed terminal writer blocks Invoice purge forever",
    ),
    "refuse-only-unexpired": (
        "It refuses the Invoice purge only while a genuinely unexpired link has `expires_at >` "
        "that instant",
        "It refuses purge for an expired link",
    ),
    "database-guard": (
        "`billing_paymentlink_precedes_invoice_purge` trigger refuses creation or update whose "
        "`expires_at` is at or beyond the retained Invoice's exact purge boundary or whose "
        "operational `purge_after` exceeds that boundary",
        "PaymentLink has no database purge-boundary guard",
    ),
}

DPA_CLOSE_REQUIREMENTS = {
    "issued-content": (
        "Its issued acceptance content is append-only",
        "Its issued acceptance content may be updated",
    ),
    "one-close": (
        "the separate `retained_dpa_close_once` trigger permits exactly one audited transition of "
        "its five initially-null close/retention fields, in that atomic close write, requires all "
        "five to become non-null together, and refuses every other update",
        "DPA closure fields may be rewritten",
    ),
    "locked-authorities": (
        "locks the linked `Order`, `Subscription` and `DpaAcceptance` in a stable order",
        "does not lock all linked contract rows",
    ),
    "exact-clock-equality": (
        "writes one identical `contract_ended_at`, plus each row's `retained_until` and "
        "`purge_after`, atomically across all three rows",
        "writes different contract clocks",
    ),
    "durable-close-proof": (
        "On `DpaAcceptance` it also fixes non-null `close_reason` and `close_evidence_ref` in that "
        "same write; all five initially-null close fields are write-once and retained until the DPA "
        "row's ten-year purge",
        "The DPA row does not retain its close proof",
    ),
    "close-audit": (
        "emits `dpa.contract_closed` in that transaction",
        "does not audit contract close",
    ),
}

DPA_CLOSE_FIELDS = {
    "close_reason": (
        "enum NULL",
        "Immutable `termination` \\| `cancellation` \\| `expiry` \\| `replacement`; set exactly with `contract_ended_at`",
    ),
    "close_evidence_ref": (
        "text NULL",
        "Immutable authority/evidence reference for the close decision; set exactly with `contract_ended_at` and retained with this ten-year row",
    ),
}

BILLING_RETENTION_REQUIREMENTS = {
    "credit-note-append-only": (
        "An issued credit note and every one of its lines are append-only throughout retention",
        "An issued credit note may be rewritten during retention",
    ),
    "tenant-delete-exclusion": (
        "They are never targets of tenant deletion",
        "Tenant deletion may remove credit-note evidence",
    ),
    "accounting-clock": (
        "hard-purged only when its own `purge_after`, exactly the close of the financial year "
        "containing the credit-note issue event plus ten years, has passed",
        "hard-purged on an unspecified accounting clock",
    ),
    "contract-clock": (
        "Accepted contractual documents and orders each have "
        "`purge_after = contract_ended_at + 10 years`",
        "Accepted contractual documents and orders use an unspecified retention clock",
    ),
}

RETENTION_ANCHOR_REQUIREMENTS = {
    "contract-anchor": (
        "both deadlines exactly `contract_ended_at + 10 years`",
        "both deadlines from an unspecified ten-year clock",
    ),
    "accounting-anchor": (
        "both deadlines exactly `financial_year_closed_at + 10 years`",
        "both deadlines from the accounting event plus ten years",
    ),
    "early-purge": (
        "The purge writer refuses every early purge, missing anchor, mismatched deadline or "
        "attempted clock rewrite",
        "The purge writer may remove retained evidence early",
    ),
    "operational-payment-link": (
        "`PaymentLink` remains operational and does not acquire either long-lived clock or "
        "detached-retention trigger",
        "`PaymentLink` becomes ten-year evidence",
    ),
}

CLEANUP_ACTOR_REQUIREMENTS = {
    "non-system-id": (
        "`ordered_cancellation_cleanup_actor_valid` check requires a non-system actor identity "
        "and only permits a null actor identity for `system`",
        "`ordered_cancellation_cleanup_actor_valid` permits a missing non-system actor",
    ),
    "verifier-separation": (
        "`ordered_cancellation_cleanup_verifier_distinct` check requires any verifier identity "
        "to differ from both `cancellation_actor_identity_id` when present and "
        "`closed_by_identity_id`",
        "`ordered_cancellation_cleanup_verifier_distinct` permits the cancellation actor to verify",
    ),
}

LOCKED_SOURCE_CLAUSE = "locks every source row named by these snapshots before validation"
PURGED_OBLIGATION_CLAUSE = (
    "deletes the finalized `ExitCutoffClaimSessionReconciliation` and "
    "`ExitCutoffJobReconciliation` children followed by their `ExitCutoffReconciliation` parent, "
    "or the finalized `OrderedCancellationCleanup`, child-first in the same transaction"
)
LIFETIME_BOOTSTRAP_SCOPE = (
    "Immutable ordered manifest of every lifetime `ProjectBootstrap` row without exception"
)
T21_LIFETIME_SCOPE = (
    "immutable scope contains every historical provider project/application/policy/key boundary "
    "without exception"
)

FINALIZATION_REQUIREMENTS = {
    "cross-authority": (
        "for an initial attestation requires its branch authority to exactly equal the "
        "certificate's branch-selector authority snapshot",
        "allows another authority",
    ),
    "cross-scope": (
        "requires its branch scope to exactly equal the certificate scope snapshots",
        "allows another scope",
    ),
    "missing-digest": (
        "recomputes and matches `finalization_evidence_sha256`",
        "trusts the stored finalization digest",
    ),
    "missing-availability": (
        "resolves the manifest successfully from the permanent evidence store",
        "accepts an unavailable manifest",
    ),
    "final-stage-substitution": (
        "must carry the byte-identical `finalization_evidence_manifest_ref` and "
        "`finalization_evidence_sha256` from its locked initial attestation",
        "may replace the initial finalization evidence",
    ),
}

BRANCH_REQUIREMENTS = {
    "exact-xor": (
        "Initial-attestation branch selection is an exact XOR",
        "Initial-attestation branch selection may overlap",
    ),
    "missing": (
        "A missing branch",
        "Only a present branch",
    ),
    "second": (
        "a second branch",
        "a single branch",
    ),
    "wrong-authority": (
        "an authority outside its branch",
        "any authority",
    ),
    "cutoff-authority": (
        "`cutoff_reconciliation` requires `closure_scope = tenant_only`, exactly "
        "`(set, null, null, null)` and the complete cutoff tree",
        "`cutoff_reconciliation` accepts any authority",
    ),
    "immediate-authority": (
        "`ordered_cancellation_immediate` requires `closure_scope = tenant_only`, exactly "
        "`(null, set, null, null)` and zero lifetime bootstrap rows",
        "`ordered_cancellation_immediate` accepts cleanup authority",
    ),
    "cleanup-required": (
        "`ordered_cancellation_cleanup` requires `closure_scope = tenant_only`, exactly "
        "`(null, set, set, null)` and the complete lifetime bootstrap set",
        "`ordered_cancellation_cleanup` accepts incomplete authority",
    ),
    "final-organisation-authority": (
        "`final_organisation` requires `closure_scope = final_organisation`, exactly "
        "`(null, null, null, set)`",
        "`final_organisation` accepts tenant authority",
    ),
    "immediate-no-cleanup": (
        "requires zero lifetime `ProjectBootstrap` rows, and contains no "
        "`OrderedCancellationCleanup`, closer, verifier or cleanup-absence record",
        "requires an `OrderedCancellationCleanup` and verifier",
    ),
    "final-organisation-baseline": (
        "one sealed closure, every through-cutoff capture, fresh realm absence and realm-deletion "
        "evidence",
        "no closure, capture or realm evidence",
    ),
}

AUDIT_SNAPSHOT_REQUIREMENTS = {
    "actor_id": "`actor_id` is an immutable non-FK UUID pseudonym",
    "organisation_id": "`organisation_id` is an immutable non-FK UUID scope snapshot",
    "job_id": "`job_id` is an immutable non-FK UUID authority snapshot",
}
AUDIT_NO_RESTRICT_PATH = (
    "no audit column has a default-`RESTRICT` path to `Organisation`, `Tenant`, `Identity`, "
    "`Job` or another shorter-lived operational row"
)


def section(source: str, heading: str) -> str:
    marker = HEADING_MARKERS.get(heading, f"### `{heading}`")
    start = source.index(marker)
    next_heading = source.find("\n### `", start + len(marker))
    end = len(source) if next_heading == -1 else next_heading
    return source[start:end]


def table_fields(source: str, heading: str, label: str = "Field") -> dict[str, tuple[str, str]]:
    body = section(source, heading)
    header = f"| {f'`{label}` field' if label != 'Field' else 'Field'} | Type | Notes |"
    lines = body[body.index(header) :].splitlines()[2:]
    fields = {}
    for line in lines:
        if not line.startswith("|"):
            break
        cells = [cell.strip() for cell in re.split(r"(?<!\\)\|", line)[1:-1]]
        if len(cells) != 3:
            raise AssertionError(f"unparseable {heading}/{label} table row: {line}")
        name_cell, kind, notes = cells
        if not (name_cell.startswith("`") and name_cell.endswith("`")):
            raise AssertionError(f"unparseable {heading}/{label} field cell: {name_cell}")
        name = name_cell[1:-1]
        fields[name] = (kind.strip(), notes.strip())
    return fields


def named_table_fields(source: str, table_name: str) -> dict[str, tuple[str, str]]:
    header = f"| `{table_name}` field | Type | Notes |"
    lines = source[source.index(header) :].splitlines()[2:]
    fields = {}
    for line in lines:
        if not line.startswith("|"):
            break
        cells = [cell.strip() for cell in re.split(r"(?<!\\)\|", line)[1:-1]]
        if len(cells) != 3:
            raise AssertionError(f"unparseable {table_name} table row: {line}")
        name_cell, kind, notes = cells
        if not (name_cell.startswith("`") and name_cell.endswith("`")):
            raise AssertionError(f"unparseable {table_name} field cell: {name_cell}")
        fields[name_cell[1:-1]] = (kind, notes)
    return fields


def source_table_fields(source: str, table_name: str) -> dict[str, tuple[str, str]]:
    if f"| `{table_name}` field | Type | Notes |" in source:
        return named_table_fields(source, table_name)
    return table_fields(source, table_name)


def source_table_names(source: str) -> tuple[str, ...]:
    """Return every normative persisted table or non-persisted field projection in order."""
    names: list[str] = []
    current_single_table_heading = None
    for line in source.splitlines():
        if line.startswith("### "):
            physical_heading = re.match(r"^### `([^`]+)` \(`[^`]+`\)$", line)
            heading_names = (
                [physical_heading.group(1)] if physical_heading else re.findall(r"`([^`]+)`", line)
            )
            names.extend(heading_names)
            current_single_table_heading = heading_names[0] if len(heading_names) == 1 else None
            continue
        named_header = re.match(r"^\| `([^`]+)` field \| Type \| Notes \|$", line)
        if named_header:
            names.append(named_header.group(1))
        elif line in {"| Field | Type | Notes |", "| Column | Type | Notes |"} and (
            current_single_table_heading
        ):
            names.append(current_single_table_heading)
        elif "Summary of columns:" in line and current_single_table_heading:
            names.append(current_single_table_heading)
    return tuple(dict.fromkeys(names))


PURE_DELIVERY_EXPIRY = """from datetime import timedelta

from django.utils import timezone


def delivery_expiry():
    return timezone.now() + timedelta(days=7)
"""


def delivery_expiry_default_is_inspectable(root: Path) -> bool:
    """Prove the pure clock and inert importing packages without executing them."""
    try:
        helper = root.resolve(strict=True)
        for component in ("apps", "extensions", "expiry.py"):
            helper = helper / component
            if helper.is_symlink():
                return False
            if component != "expiry.py":
                initializer = helper / "__init__.py"
                if initializer.is_symlink() or not initializer.is_file():
                    return False
                statements = ast.parse(initializer.read_bytes()).body
                if statements and not (
                    len(statements) == 1
                    and isinstance(statements[0], ast.Expr)
                    and isinstance(statements[0].value, ast.Constant)
                    and isinstance(statements[0].value.value, str)
                ):
                    return False
        if not helper.is_file():
            return False
        source = helper.read_bytes()
        return ast.dump(ast.parse(source)) == ast.dump(ast.parse(PURE_DELIVERY_EXPIRY))
    except (OSError, UnicodeError, SyntaxError):
        return False


def migration_create_model_names(
    root: Path = ROOT, *, within: str | None = None, outside: str | None = None
) -> set[str]:
    """Read model/table creation from Django migration source without importing it, from every
    migration, or only those `within` one directory, or all but those of one (`outside`)."""
    names = set()
    projections = set(NON_PERSISTED_MODEL_PROJECTIONS)
    verified_expiry_default = delivery_expiry_default_is_inspectable(root)
    for path in sorted(root.glob("apps/**/migrations/*.py")):
        relative = path.relative_to(root).as_posix()

        def under(prefix: str, relative: str = relative) -> bool:
            return relative == prefix or relative.startswith(prefix + "/")

        if within is not None and not under(within):
            continue
        if outside is not None and under(outside):
            continue
        tree = ast.parse(path.read_bytes(), filename=str(path))
        create_model_aliases = set()
        run_sql_aliases = set()
        run_python_aliases = set()
        migration_operation_namespace_aliases: set[str] = set()
        known_django_operations = {
            "AddConstraint",
            "AddField",
            "AddIndex",
            "AlterConstraint",
            "AlterField",
            "AlterIndexTogether",
            "AlterModelManagers",
            "AlterModelOptions",
            "AlterModelTable",
            "AlterModelTableComment",
            "AlterOrderWithRespectTo",
            "AlterUniqueTogether",
            "CreateModel",
            "DeleteModel",
            "RemoveConstraint",
            "RemoveField",
            "RemoveIndex",
            "RenameField",
            "RenameIndex",
            "RenameModel",
            "RunPython",
            "RunSQL",
            "SeparateDatabaseAndState",
        }
        django_operation_aliases: dict[str, str] = {}
        migration_module_aliases: set[str] = set()
        django_model_module_aliases: set[str] = set()
        django_migration_class_aliases: set[str] = set()
        assignment_nodes: dict[str, list[ast.AST]] = {}
        assignment_lines: dict[str, int] = {}
        rebound_names: set[str] = set()
        function_nodes: dict[str, list[ast.FunctionDef]] = {}
        imported_names: set[str] = set()
        module_imported_names: set[str] = set()
        module_import_sources: dict[str, set[str]] = {}
        import_binding_counts: dict[str, int] = {}
        database_connection_names: set[str] = set()

        def bound_names(target: ast.AST) -> set[str]:
            """Return every name bound by an assignment/import-style target."""
            return {
                child.id
                for child in ast.walk(target)
                if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store)
            }

        def lexical_scope_nodes(
            scope: ast.Module | ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef,
        ) -> list[ast.AST]:
            """Walk one Python lexical scope without entering nested definitions."""
            nodes: list[ast.AST] = []
            stack: list[ast.AST] = list(reversed(scope.body))
            while stack:
                node = stack.pop()
                nodes.append(node)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    body_node_ids = {id(statement) for statement in node.body}
                    stack.extend(
                        reversed(
                            [
                                child
                                for child in ast.iter_child_nodes(node)
                                if id(child) not in body_node_ids
                            ]
                        )
                    )
                    continue
                if isinstance(node, ast.Lambda):
                    stack.extend(
                        reversed(
                            [
                                child
                                for child in ast.iter_child_nodes(node)
                                if child is not node.body
                            ]
                        )
                    )
                    continue
                stack.extend(reversed(list(ast.iter_child_nodes(node))))
            return nodes

        nested_scope_node_ids = {
            id(descendant)
            for scope in ast.walk(tree)
            if isinstance(
                scope,
                (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda),
            )
            for descendant in ast.walk(scope)
            if descendant is not scope
        }
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for imported in node.names:
                    if imported.name == "*":
                        continue
                    bound_name = imported.asname or imported.name.split(".", maxsplit=1)[0]
                    imported_names.add(bound_name)
                    if id(node) not in nested_scope_node_ids:
                        module_imported_names.add(bound_name)
                        source = (
                            imported.name
                            if isinstance(node, ast.Import)
                            else f"{node.module or ''}:{imported.name}"
                        )
                        module_import_sources.setdefault(bound_name, set()).add(source)
                        import_binding_counts[bound_name] = (
                            import_binding_counts.get(bound_name, 0) + 1
                        )
            if (
                isinstance(node, ast.ImportFrom)
                and node.module == "django.db"
                and id(node) not in nested_scope_node_ids
            ):
                database_connection_names.update(
                    imported.asname or imported.name
                    for imported in node.names
                    if imported.name in {"connection", "connections"}
                )
                migration_module_aliases.update(
                    imported.asname or imported.name
                    for imported in node.names
                    if imported.name == "migrations"
                )
                django_model_module_aliases.update(
                    imported.asname or imported.name
                    for imported in node.names
                    if imported.name == "models"
                )
            if isinstance(node, ast.Import) and id(node) not in nested_scope_node_ids:
                migration_module_aliases.update(
                    imported.asname
                    for imported in node.names
                    if imported.name == "django.db.migrations" and imported.asname
                )
            if (
                isinstance(node, ast.ImportFrom)
                and node.module is not None
                and node.module.startswith("django.db.migrations")
                and id(node) not in nested_scope_node_ids
            ):
                for imported in node.names:
                    alias = imported.asname or imported.name
                    if imported.name == "Migration":
                        django_migration_class_aliases.add(alias)
                    if imported.name == "operations":
                        migration_operation_namespace_aliases.add(alias)
                    if imported.name in known_django_operations:
                        django_operation_aliases[alias] = imported.name
                    if imported.name == "CreateModel":
                        create_model_aliases.add(alias)
                    elif imported.name == "RunSQL":
                        run_sql_aliases.add(alias)
                    elif imported.name == "RunPython":
                        run_python_aliases.add(alias)
        if any(
            isinstance(node, ast.ImportFrom)
            and any(imported.name == "*" for imported in node.names)
            for node in ast.walk(tree)
        ):
            names.update(projections)
        migration_class_lines = [
            statement.lineno
            for statement in tree.body
            if isinstance(statement, ast.ClassDef) and statement.name == "Migration"
        ]
        if migration_class_lines:
            forbidden_capabilities = {
                "__builtins__",
                "__import__",
                "eval",
                "exec",
                "globals",
                "locals",
                "vars",
            }

            def is_literal_shadow(node: ast.AST) -> bool:
                if isinstance(node, ast.Constant):
                    return True
                if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
                    return all(is_literal_shadow(item) for item in node.elts)
                if isinstance(node, ast.Dict):
                    return all(key is None or is_literal_shadow(key) for key in node.keys) and all(
                        is_literal_shadow(value) for value in node.values
                    )
                return False

            literal_shadow_lines: dict[str, int] = {}
            invalid_literal_shadows: set[str] = set()
            for statement in tree.body:
                if isinstance(statement, ast.Assign):
                    targets = statement.targets
                    value = statement.value
                elif isinstance(statement, ast.AnnAssign) and statement.value is not None:
                    targets = [statement.target]
                    value = statement.value
                else:
                    continue
                for target in targets:
                    if not isinstance(target, ast.Name) or target.id not in forbidden_capabilities:
                        continue
                    if target.id in literal_shadow_lines or not is_literal_shadow(value):
                        invalid_literal_shadows.add(target.id)
                    else:
                        literal_shadow_lines[target.id] = statement.lineno
            for name in invalid_literal_shadows:
                literal_shadow_lines.pop(name, None)
            # Reflective namespace access can rebind the module's exported
            # Migration class through direct, aliased, dynamic, or nested
            # writes. Dynamic code execution has the same unbounded authority.
            # Migration modules need neither primitive, so fail closed on the
            # capability instead of trying to enumerate each mutation spelling.
            if any(
                isinstance(node, ast.Name)
                and isinstance(node.ctx, ast.Load)
                and node.id in forbidden_capabilities
                and not (
                    node.id in literal_shadow_lines and literal_shadow_lines[node.id] < node.lineno
                )
                or isinstance(node, ast.Global)
                and "Migration" in node.names
                or isinstance(node, ast.Import)
                and any(
                    imported.name.split(".", maxsplit=1)[0]
                    in {"builtins", "importlib", "inspect", "sys"}
                    for imported in node.names
                )
                or isinstance(node, ast.ImportFrom)
                and node.module is not None
                and node.module.split(".", maxsplit=1)[0]
                in {"builtins", "importlib", "inspect", "sys"}
                for node in ast.walk(tree)
            ):
                names.update(projections)
            for node in ast.walk(tree):
                if not isinstance(node, (ast.Import, ast.ImportFrom)):
                    continue
                if id(node) in nested_scope_node_ids or node.lineno <= min(migration_class_lines):
                    continue
                if isinstance(node, ast.Import):
                    bound_imports = {
                        imported.asname or imported.name.split(".", maxsplit=1)[0]
                        for imported in node.names
                    }
                elif isinstance(node, ast.ImportFrom):
                    bound_imports = {
                        imported.asname or imported.name
                        for imported in node.names
                        if imported.name != "*"
                    }
                else:
                    continue
                if "Migration" in bound_imports:
                    names.update(projections)

        def collect_module_bindings(
            node: ast.AST,
            *,
            conditional: bool = False,
            _function_nodes: dict[str, list[ast.FunctionDef]] = function_nodes,
            _rebound_names: set[str] = rebound_names,
            _assignment_nodes: dict[str, list[ast.AST]] = assignment_nodes,
            _assignment_lines: dict[str, int] = assignment_lines,
        ) -> None:
            if isinstance(node, ast.FunctionDef):
                _function_nodes.setdefault(node.name, []).append(node)
                if conditional:
                    _rebound_names.add(node.name)
                definition_expressions = [
                    *node.decorator_list,
                    *node.args.defaults,
                    *(default for default in node.args.kw_defaults if default is not None),
                ]
                for expression in definition_expressions:
                    for child in ast.walk(expression):
                        if isinstance(child, ast.NamedExpr):
                            _rebound_names.update(bound_names(child.target))
                return
            if isinstance(node, ast.ClassDef):
                return
            if isinstance(node, ast.Import):
                _rebound_names.update(
                    alias.asname or alias.name.split(".", maxsplit=1)[0] for alias in node.names
                )
                return
            if isinstance(node, ast.ImportFrom):
                _rebound_names.update(alias.asname or alias.name for alias in node.names)
                return
            for child in ast.iter_child_nodes(node):
                if not isinstance(child, ast.expr):
                    continue
                for descendant in ast.walk(child):
                    if isinstance(descendant, ast.NamedExpr) and isinstance(
                        descendant.target, ast.Name
                    ):
                        _rebound_names.add(descendant.target.id)
            if isinstance(node, (ast.For, ast.AsyncFor)):
                _rebound_names.update(
                    target.id for target in ast.walk(node.target) if isinstance(target, ast.Name)
                )
                for child in [*node.body, *node.orelse]:
                    collect_module_bindings(child, conditional=True)
                return
            if isinstance(node, (ast.With, ast.AsyncWith)):
                for item in node.items:
                    if item.optional_vars is not None:
                        _rebound_names.update(
                            target.id
                            for target in ast.walk(item.optional_vars)
                            if isinstance(target, ast.Name)
                        )
                for child in node.body:
                    collect_module_bindings(child, conditional=True)
                return
            if isinstance(node, (ast.Try, ast.TryStar)):
                for handler in node.handlers:
                    if handler.name:
                        _rebound_names.add(handler.name)
                    for child in handler.body:
                        collect_module_bindings(child, conditional=True)
                for child in [*node.body, *node.orelse, *node.finalbody]:
                    collect_module_bindings(child, conditional=True)
                return
            if isinstance(node, ast.Match):
                for case in node.cases:
                    for pattern in ast.walk(case.pattern):
                        if isinstance(pattern, (ast.MatchAs, ast.MatchStar)) and pattern.name:
                            _rebound_names.add(pattern.name)
                        elif isinstance(pattern, ast.MatchMapping) and pattern.rest:
                            _rebound_names.add(pattern.rest)
                    if case.guard is not None:
                        for descendant in ast.walk(case.guard):
                            if isinstance(descendant, ast.NamedExpr):
                                _rebound_names.update(bound_names(descendant.target))
                    for child in case.body:
                        collect_module_bindings(child, conditional=True)
                return
            if isinstance(node, ast.ExceptHandler) and node.name:
                _rebound_names.add(node.name)
            if isinstance(node, ast.AugAssign):
                _rebound_names.update(bound_names(node.target))
                return
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                if isinstance(node, ast.AnnAssign) and node.value is None:
                    return
                assert node.value is not None
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    names = bound_names(target)
                    if not isinstance(target, ast.Name):
                        _rebound_names.update(names)
                        continue
                    _assignment_nodes.setdefault(target.id, []).append(node.value)
                    _assignment_lines[target.id] = node.lineno
                    if conditional:
                        _rebound_names.add(target.id)
                return
            for child in ast.iter_child_nodes(node):
                if isinstance(child, ast.stmt):
                    collect_module_bindings(child, conditional=True)

        for node in tree.body:
            collect_module_bindings(node)

        assignments = {
            name: values[0]
            for name, values in assignment_nodes.items()
            if len(values) == 1 and name not in rebound_names
        }
        functions = {
            name: nodes[0]
            for name, nodes in function_nodes.items()
            if len(nodes) == 1
            and not nodes[0].decorator_list
            and name not in assignment_nodes
            and name not in rebound_names
        }

        unresolved = object()

        def static_value(
            node: ast.AST,
            bindings: dict[str, object] | None = None,
            seen: frozenset[str] = frozenset(),
            _assignments: dict[str, ast.AST] = assignments,
            _functions: dict[str, ast.FunctionDef] = functions,
            _unresolved: object = unresolved,
        ) -> object:
            bindings = {} if bindings is None else bindings
            if isinstance(node, ast.Constant) and (
                node.value is None or isinstance(node.value, (str, bool, int, float))
            ):
                return node.value
            if isinstance(node, ast.Name):
                if node.id in bindings:
                    return bindings[node.id]
                key = f"module:{node.id}"
                if key in seen or node.id not in _assignments:
                    return _unresolved
                return static_value(_assignments[node.id], bindings, seen | {key})
            if isinstance(node, (ast.Tuple, ast.List)):
                values = tuple(static_value(item, bindings, seen) for item in node.elts)
                return _unresolved if _unresolved in values else values
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
                left = static_value(node.left, bindings, seen)
                right = static_value(node.right, bindings, seen)
                if _unresolved in (left, right):
                    return _unresolved
                try:
                    return left + right  # type: ignore[operator]
                except TypeError:
                    return _unresolved
            if isinstance(node, ast.JoinedStr):
                parts: list[str] = []
                for value in node.values:
                    rendered = static_value(
                        value.value if isinstance(value, ast.FormattedValue) else value,
                        bindings,
                        seen,
                    )
                    if rendered is _unresolved:
                        return _unresolved
                    parts.append(str(rendered))
                return "".join(parts)
            if isinstance(node, ast.IfExp):
                condition = static_value(node.test, bindings, seen)
                if not isinstance(condition, bool):
                    return _unresolved
                return static_value(node.body if condition else node.orelse, bindings, seen)
            if isinstance(node, ast.GeneratorExp) and len(node.generators) == 1:
                generator = node.generators[0]
                if generator.ifs or not isinstance(generator.target, ast.Name):
                    return _unresolved
                iterable = static_value(generator.iter, bindings, seen)
                if not isinstance(iterable, tuple):
                    return _unresolved
                generated_values: list[object] = []
                for item in iterable:
                    child_bindings = dict(bindings)
                    child_bindings[generator.target.id] = item
                    generated_value = static_value(node.elt, child_bindings, seen)
                    if generated_value is _unresolved:
                        return _unresolved
                    generated_values.append(generated_value)
                return tuple(generated_values)
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id == "reversed":
                    if len(node.args) != 1 or node.keywords:
                        return _unresolved
                    reversed_value = static_value(node.args[0], bindings, seen)
                    return (
                        tuple(reversed(reversed_value))
                        if isinstance(reversed_value, tuple)
                        else _unresolved
                    )
                if isinstance(node.func, ast.Attribute):
                    receiver = static_value(node.func.value, bindings, seen)
                    if (
                        node.func.attr == "join"
                        and isinstance(receiver, str)
                        and len(node.args) == 1
                    ):
                        joined_values = static_value(node.args[0], bindings, seen)
                        if isinstance(joined_values, tuple) and all(
                            isinstance(item, str) for item in joined_values
                        ):
                            return receiver.join(cast(tuple[str, ...], joined_values))
                    if node.func.attr == "format" and isinstance(receiver, str):
                        args = [static_value(value, bindings, seen) for value in node.args]
                        kwargs = {
                            keyword.arg: static_value(keyword.value, bindings, seen)
                            for keyword in node.keywords
                            if keyword.arg is not None
                        }
                        if _unresolved not in args and _unresolved not in kwargs.values():
                            try:
                                return receiver.format(*args, **kwargs)
                            except (IndexError, KeyError, ValueError):
                                return _unresolved
                if isinstance(node.func, ast.Name) and node.func.id in _functions:
                    return static_function_call(node, _functions[node.func.id], bindings, seen)
            return _unresolved

        def static_function_call(
            call: ast.Call,
            function: ast.FunctionDef,
            outer_bindings: dict[str, object],
            seen: frozenset[str],
            _unresolved: object = unresolved,
        ) -> object:
            function_key = f"function:{function.name}"
            if function_key in seen:
                return _unresolved
            positional_names = [argument.arg for argument in function.args.args]
            keyword_names = [argument.arg for argument in function.args.kwonlyargs]
            if len(call.args) > len(positional_names):
                return _unresolved
            local_bindings: dict[str, object] = {}
            for name, argument in zip(positional_names, call.args, strict=False):
                value = static_value(argument, outer_bindings, seen)
                if value is _unresolved:
                    return _unresolved
                local_bindings[name] = value
            for keyword in call.keywords:
                if keyword.arg not in positional_names + keyword_names:
                    return _unresolved
                value = static_value(keyword.value, outer_bindings, seen)
                if value is _unresolved:
                    return _unresolved
                local_bindings[keyword.arg] = value
            if set(positional_names + keyword_names) != set(local_bindings):
                return _unresolved
            for statement in function.body:
                if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant):
                    continue
                if (
                    isinstance(statement, ast.Assign)
                    and len(statement.targets) == 1
                    and isinstance(statement.targets[0], ast.Name)
                ):
                    value = static_value(statement.value, local_bindings, seen | {function_key})
                    if value is _unresolved:
                        return _unresolved
                    local_bindings[statement.targets[0].id] = value
                    continue
                if isinstance(statement, ast.Return) and statement.value is not None:
                    return static_value(statement.value, local_bindings, seen | {function_key})
                return _unresolved
            return _unresolved

        def bindings_are_prior(
            node: ast.AST,
            use_lineno: int,
            seen: frozenset[str] = frozenset(),
            _assignment_nodes: dict[str, list[ast.AST]] = assignment_nodes,
            _assignments: dict[str, ast.AST] = assignments,
            _assignment_lines: dict[str, int] = assignment_lines,
            _function_nodes: dict[str, list[ast.FunctionDef]] = function_nodes,
            _functions: dict[str, ast.FunctionDef] = functions,
        ) -> bool:
            for child in ast.walk(node):
                if not isinstance(child, ast.Name) or child.id in seen:
                    continue
                if child.id in _assignment_nodes and child.id not in _assignments:
                    return False
                if child.id in _assignments:
                    if _assignment_lines[child.id] >= use_lineno:
                        return False
                    if not bindings_are_prior(
                        _assignments[child.id], use_lineno, seen | {child.id}
                    ):
                        return False
                if child.id in _function_nodes and child.id not in _functions:
                    return False
                if child.id in _functions:
                    function = _functions[child.id]
                    if function.lineno >= use_lineno or not bindings_are_prior(
                        function, use_lineno, seen | {child.id}
                    ):
                        return False
            return True

        def static_sql_strings(
            node: ast.AST,
            use_lineno: int,
        ) -> tuple[str, ...] | None:
            """Resolve Django's string or list-of-(SQL, params) RunSQL forms."""
            if not bindings_are_prior(node, use_lineno):
                return None
            value = static_value(node)
            if value is None:
                return ()
            if isinstance(value, str):
                return (value,)
            if isinstance(value, tuple) and all(
                isinstance(item, tuple)
                and len(item) == 2
                and isinstance(item[0], str)
                and (item[1] is None or isinstance(item[1], tuple))
                for item in value
            ):
                return tuple(item[0] for item in value)
            return None

        def is_run_sql_noop(
            node: ast.AST,
            use_lineno: int,
            seen: frozenset[str] = frozenset(),
            _assignments: dict[str, ast.AST] = assignments,
            _run_sql_aliases: set[str] = run_sql_aliases,
        ) -> bool:
            if not bindings_are_prior(node, use_lineno):
                return False
            if isinstance(node, ast.Name) and node.id not in seen and node.id in _assignments:
                return is_run_sql_noop(_assignments[node.id], use_lineno, seen | {node.id})
            return (
                isinstance(node, ast.Attribute)
                and node.attr == "noop"
                and (
                    (isinstance(node.value, ast.Name) and node.value.id in _run_sql_aliases)
                    or (
                        isinstance(node.value, ast.Attribute)
                        and node.value.attr == "RunSQL"
                        and is_migrations_operation_namespace(node.value.value, use_lineno)
                    )
                )
            )

        def is_run_python_noop(
            node: ast.AST,
            use_lineno: int,
            seen: frozenset[str] = frozenset(),
            _assignments: dict[str, ast.AST] = assignments,
            _run_python_aliases: set[str] = run_python_aliases,
        ) -> bool:
            if not bindings_are_prior(node, use_lineno):
                return False
            if isinstance(node, ast.Name) and node.id not in seen and node.id in _assignments:
                return is_run_python_noop(_assignments[node.id], use_lineno, seen | {node.id})
            return (
                isinstance(node, ast.Attribute)
                and node.attr == "noop"
                and (
                    (isinstance(node.value, ast.Name) and node.value.id in _run_python_aliases)
                    or (
                        isinstance(node.value, ast.Attribute)
                        and node.value.attr == "RunPython"
                        and is_migrations_operation_namespace(node.value.value, use_lineno)
                    )
                )
            )

        def strip_sql_comments(sql: str) -> str:
            """Remove PostgreSQL comments without touching quoted data or identifiers."""
            output = []
            index = 0
            while index < len(sql):
                if sql.startswith("--", index):
                    newline = sql.find("\n", index + 2)
                    if newline == -1:
                        output.append(" ")
                        break
                    output.append("\n")
                    index = newline + 1
                    continue
                if sql.startswith("/*", index):
                    depth = 1
                    index += 2
                    while index < len(sql) and depth:
                        if sql.startswith("/*", index):
                            depth += 1
                            index += 2
                        elif sql.startswith("*/", index):
                            depth -= 1
                            index += 2
                        else:
                            index += 1
                    output.append(" ")
                    continue
                if sql[index] in {"'", '"'}:
                    quote = sql[index]
                    escape_string = (
                        quote == "'"
                        and index > 0
                        and sql[index - 1] in {"e", "E"}
                        and (index < 2 or not (sql[index - 2].isalnum() or sql[index - 2] == "_"))
                    )
                    start = index
                    index += 1
                    while index < len(sql):
                        if escape_string and sql[index] == "\\":
                            index += 2
                            continue
                        if sql[index] != quote:
                            index += 1
                            continue
                        if index + 1 < len(sql) and sql[index + 1] == quote:
                            index += 2
                            continue
                        index += 1
                        break
                    output.append(sql[start:index])
                    continue
                dollar = re.match(r"\$[A-Za-z_0-9]*\$", sql[index:])
                if dollar:
                    tag = dollar.group(0)
                    end = sql.find(tag, index + len(tag))
                    if end == -1:
                        output.append(sql[index:])
                        break
                    body_start = index + len(tag)
                    output.append(tag)
                    output.append(strip_sql_comments(sql[body_start:end]))
                    output.append(tag)
                    index = end + len(tag)
                    continue
                output.append(sql[index])
                index += 1
            return "".join(output)

        def sql_string_prefix_length(sql: str, quote_index: int) -> int:
            if (
                quote_index >= 2
                and sql[quote_index - 2 : quote_index].lower() == "u&"
                and (
                    quote_index < 3
                    or not (sql[quote_index - 3].isalnum() or sql[quote_index - 3] == "_")
                )
            ):
                return 2
            if (
                quote_index >= 1
                and sql[quote_index - 1] in {"e", "E", "n", "N"}
                and (
                    quote_index < 2
                    or not (sql[quote_index - 2].isalnum() or sql[quote_index - 2] == "_")
                )
            ):
                return 1
            return 0

        def sql_prefix_opens_procedural_body(prefix: str) -> bool:
            statement_start = 0
            index = 0
            while index < len(prefix):
                if prefix[index] in {"'", '"'}:
                    quote = prefix[index]
                    prefix_length = sql_string_prefix_length(prefix, index) if quote == "'" else 0
                    escape_string = prefix_length == 1 and prefix[index - 1] in {"e", "E"}
                    index += 1
                    while index < len(prefix):
                        if escape_string and prefix[index] == "\\":
                            index += 2
                            continue
                        if prefix[index] != quote:
                            index += 1
                            continue
                        if index + 1 < len(prefix) and prefix[index + 1] == quote:
                            index += 2
                            continue
                        index += 1
                        break
                    continue
                dollar = re.match(r"\$[A-Za-z_0-9]*\$", prefix[index:])
                if dollar is not None:
                    tag = dollar.group(0)
                    end = prefix.find(tag, index + len(tag))
                    index = len(prefix) if end == -1 else end + len(tag)
                    continue
                if prefix[index] == ";":
                    statement_start = index + 1
                index += 1
            statement_prefix = prefix[statement_start:]
            return bool(
                re.search(
                    r"\bDO(?:\s+LANGUAGE\s+[A-Za-z_][\w$]*)?\s*$",
                    statement_prefix,
                    re.IGNORECASE,
                )
                or re.search(
                    r"\bCREATE(?:\s+OR\s+REPLACE)?\s+"
                    r"(?:FUNCTION|PROCEDURE)\b[\s\S]*\bAS\s*$",
                    statement_prefix,
                    re.IGNORECASE,
                )
            )

        def mask_sql_string_literals(sql: str, *, preserve_procedural_bodies: bool = True) -> str:
            """Hide quoted data while retaining executable procedure bodies."""
            output = []
            index = 0
            procedural_statement_active = False
            while index < len(sql):
                if sql[index] != "'":
                    output.append(sql[index])
                    if sql[index] == ";":
                        procedural_statement_active = False
                    index += 1
                    continue
                prefix = "".join(output)
                prefix_length = sql_string_prefix_length(sql, index)
                escape_string = prefix_length == 1 and sql[index - 1] in {"e", "E"}
                procedural_body = preserve_procedural_bodies and (
                    procedural_statement_active
                    or sql_prefix_opens_procedural_body(
                        prefix[:-prefix_length] if prefix_length else prefix
                    )
                )
                if procedural_statement_active:
                    while output and output[-1].isspace():
                        output.pop()
                index += 1
                body_start = index
                while index < len(sql):
                    if escape_string and sql[index] == "\\":
                        index += 2
                        continue
                    if sql[index] != "'":
                        index += 1
                        continue
                    if index + 1 < len(sql) and sql[index + 1] == "'":
                        index += 2
                        continue
                    index += 1
                    break
                if procedural_body:
                    procedural_statement_active = True
                    if prefix_length:
                        del output[-prefix_length:]
                    if prefix_length == 2:
                        # PostgreSQL U& bodies can spell structural keywords through
                        # a caller-selected escape character; reject them wholesale.
                        output.append(" EXECUTE ")
                        continue
                    body = sql[body_start : index - 1].replace("''", "'")
                    output.append(
                        mask_sql_string_literals(
                            strip_sql_comments(body), preserve_procedural_bodies=False
                        )
                    )
                else:
                    output.append("''")
            return "".join(output)

        def mask_nonprocedural_dollar_literals(sql: str) -> str:
            """Hide dollar-quoted data while retaining executable procedure bodies."""
            output = []
            index = 0
            while index < len(sql):
                dollar = re.match(r"\$[A-Za-z_0-9]*\$", sql[index:])
                if dollar is None:
                    output.append(sql[index])
                    index += 1
                    continue
                tag = dollar.group(0)
                end = sql.find(tag, index + len(tag))
                if end == -1:
                    output.append(" " * (len(sql) - index))
                    break
                procedural_body = sql_prefix_opens_procedural_body("".join(output))
                body_end = end + len(tag)
                if procedural_body:
                    output.append(sql[index:body_end])
                else:
                    output.append(" " * (body_end - index))
                index = body_end
            return "".join(output)

        def mask_dollar_literals_except_language_names(sql: str) -> str:
            """Hide dollar-quoted bodies but retain a procedural language token."""
            output = []
            index = 0
            while index < len(sql):
                dollar = re.match(r"\$[A-Za-z_0-9]*\$", sql[index:])
                if dollar is None:
                    output.append(sql[index])
                    index += 1
                    continue
                tag = dollar.group(0)
                end = sql.find(tag, index + len(tag))
                body_end = len(sql) if end == -1 else end + len(tag)
                language_name = sql_prefix_requests_language_token("".join(output))
                output.append(sql[index:body_end] if language_name else " " * (body_end - index))
                index = body_end
            return "".join(output)

        language_string_token = (
            r"(?:[eEnN]|[uU]&)?'(?:''|[^'])*'|"
            r"\$[A-Za-z_0-9]*\$[\s\S]*?\$[A-Za-z_0-9]*\$"
        )

        def sql_prefix_requests_language_token(
            prefix: str, _language_string_token: str = language_string_token
        ) -> bool:
            if re.search(r"\b(?:LANGUAGE|UESCAPE)\s*$", prefix, re.IGNORECASE):
                return True
            statement = prefix.rsplit(";", 1)[-1]
            return bool(
                re.search(r"\bLANGUAGE\b", statement, re.IGNORECASE)
                and re.search(
                    rf"(?:{_language_string_token})(?=[ \t\r\n\f]*\r?\n)"
                    r"[ \t\r\n\f]*$",
                    statement,
                    re.IGNORECASE,
                )
            )

        def mask_sql_literals_except_language_names(sql: str) -> str:
            """Hide string data but retain a quoted procedural language token."""
            output = []
            index = 0
            while index < len(sql):
                if sql[index] != "'":
                    output.append(sql[index])
                    index += 1
                    continue
                prefix_length = sql_string_prefix_length(sql, index)
                prefix = "".join(output)
                language_name = sql_prefix_requests_language_token(
                    prefix[:-prefix_length] if prefix_length else prefix
                )
                escape_string = prefix_length == 1 and sql[index - 1] in {"e", "E"}
                start = index - prefix_length
                index += 1
                while index < len(sql):
                    if escape_string and sql[index] == "\\":
                        index += 2
                        continue
                    if sql[index] != "'":
                        index += 1
                        continue
                    if index + 1 < len(sql) and sql[index + 1] == "'":
                        index += 2
                        continue
                    index += 1
                    break
                if prefix_length:
                    del output[-prefix_length:]
                output.append(sql[start:index] if language_name else "''")
            return "".join(output)

        def projection_names_from_sql(
            sql: str, _language_string_token: str = language_string_token
        ) -> set[str]:
            inspectable_sql = strip_sql_comments(sql)

            def decode_unicode_identifier_with_escape(match: re.Match[str]) -> str:
                raw = match.group(1).replace('""', '"')
                escape_character = match.group(2) or match.group(4) or "\\"
                escaped = re.escape(escape_character)

                def decode_escape(escape: re.Match[str]) -> str:
                    if escape.group(3) is not None:
                        return escape_character
                    return chr(int(escape.group(1) or escape.group(2), 16))

                decoded = re.sub(
                    rf"{escaped}(?:\+([0-9A-Fa-f]{{6}})|([0-9A-Fa-f]{{4}})|({escaped}))",
                    decode_escape,
                    raw,
                )
                return '"' + decoded.replace('"', '""') + '"'

            inspectable_sql = re.sub(
                r'U&"((?:""|[^"])*)"(?:\s+UESCAPE\s+(?:(?:[eE])?\'([^\'])\'|'
                r"\$([A-Za-z_0-9]*)\$(.)\$\3\$))?",
                decode_unicode_identifier_with_escape,
                inspectable_sql,
                flags=re.IGNORECASE,
            )
            declaration_sql = mask_sql_literals_except_language_names(
                mask_dollar_literals_except_language_names(inspectable_sql)
            )
            procedural_declaration = re.search(
                r"\b(?:DO|CREATE(?:\s+OR\s+REPLACE)?\s+(?:FUNCTION|PROCEDURE))\b",
                declaration_sql,
                re.IGNORECASE,
            )
            procedural_language_matches = list(
                re.finditer(
                    r"\bLANGUAGE\s+(?P<language>"
                    r"\"(?:\"\"|[^\"])+\"|(?:[eEnN]|[uU]&)?'(?:''|[^'])+'|"
                    r"\$(?P<tag>[A-Za-z_0-9]*)\$[\s\S]*?\$(?P=tag)\$|"
                    r"[A-Za-z_][\w$]*)"
                    r"(?:\s+UESCAPE\s+(?P<uescape>"
                    r"(?:[eE])?'(?:\\.|''|[^'])+'|"
                    r"\$(?P<uescape_tag>[A-Za-z_0-9]*)\$[\s\S]*?"
                    r"\$(?P=uescape_tag)\$))?",
                    declaration_sql,
                    re.IGNORECASE,
                )
            )

            def normalized_procedural_language(
                language: str, unicode_escape: str | None = None
            ) -> str:
                if language.startswith("$"):
                    tag_end = language.index("$", 1) + 1
                    return language[tag_end:-tag_end].lower()
                if "'" in language:
                    quote = language.index("'")
                    value = language[quote + 1 : -1].replace("''", "'")
                    prefix = language[:quote].lower()
                    if prefix == "e":
                        value = re.sub(
                            r"\\u([0-9A-Fa-f]{4})",
                            lambda match: chr(int(match.group(1), 16)),
                            value,
                        )
                        value = re.sub(
                            r"\\U([0-9A-Fa-f]{8})",
                            lambda match: chr(int(match.group(1), 16)),
                            value,
                        )
                        value = re.sub(
                            r"\\x([0-9A-Fa-f]{1,2})",
                            lambda match: chr(int(match.group(1), 16)),
                            value,
                        )
                        value = re.sub(
                            r"\\([0-7]{1,3})",
                            lambda match: chr(int(match.group(1), 8)),
                            value,
                        )
                        value = re.sub(r"\\(.)", r"\1", value)
                    elif prefix == "u&":
                        escape = unicode_escape or "\\"
                        escaped = re.escape(escape)
                        value = re.sub(
                            rf"{escaped}(?:\+([0-9A-Fa-f]{{6}})|([0-9A-Fa-f]{{4}}))",
                            lambda match: chr(int(match.group(1) or match.group(2), 16)),
                            value,
                        ).replace(escape + escape, escape)
                    return value.lower()
                return language.strip('"').replace('""', '"').lower()

            procedural_languages = set()
            adjacent_language_token = re.compile(
                rf"(?=[ \t\r\n\f]*\r?\n)[ \t\r\n\f]*"
                rf"(?P<language>{_language_string_token})",
                re.IGNORECASE,
            )
            for match in procedural_language_matches:
                unicode_escape = (
                    normalized_procedural_language(match.group("uescape"))
                    if match.group("uescape") is not None
                    else None
                )
                language = normalized_procedural_language(match.group("language"), unicode_escape)
                offset = match.end()
                while adjacent := adjacent_language_token.match(declaration_sql, offset):
                    language += normalized_procedural_language(adjacent.group("language"))
                    offset = adjacent.end()
                procedural_languages.add(language)
            if procedural_declaration and any(
                language not in {"plpgsql", "sql"} for language in procedural_languages
            ):
                return set(projections)
            inspectable_sql = mask_nonprocedural_dollar_literals(inspectable_sql)
            inspectable_sql = mask_sql_string_literals(inspectable_sql)
            for execute in re.finditer(
                r"\bEXECUTE\s+(?!FUNCTION\b|PROCEDURE\b)",
                inspectable_sql,
                re.IGNORECASE,
            ):
                # An EXECUTE privilege grant/revocation changes an ACL, not a
                # table. Inspect every other EXECUTE independently so an ACL
                # statement cannot hide dynamic SQL later in the same migration.
                if re.search(
                    r"\b(?:GRANT|REVOKE)\s*$",
                    inspectable_sql[: execute.start()],
                    re.IGNORECASE,
                ) and re.match(
                    r"ON\s+(?:FUNCTION|PROCEDURE|ROUTINE)\b",
                    inspectable_sql[execute.end() :],
                    re.IGNORECASE,
                ):
                    continue
                return set(projections)
            persisted_targets: list[str] = []
            persisted_targets.extend(
                match.group(1)
                for match in re.finditer(
                    r"\bCREATE\s+(?:(?:UNLOGGED|FOREIGN)\s+|"
                    r"(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMPORARY|TEMP)\s+)?TABLE\s+"
                    r"(?:IF\s+NOT\s+EXISTS\s+)?"
                    r"((?:\"(?:\"\"|[^\"])+\"|(?:[^\W\d]|_)[\w$\u0080-\U0010ffff]*)"
                    r"(?:\s*\.\s*(?:\"(?:\"\"|[^\"])+\"|(?:[^\W\d]|_)[\w$\u0080-\U0010ffff]*))?)",
                    inspectable_sql,
                    re.IGNORECASE,
                )
            )
            persisted_targets.extend(
                match.group(1)
                for match in re.finditer(
                    r"\bALTER\s+(?:FOREIGN\s+TABLE|TABLE|MATERIALIZED\s+VIEW|VIEW)\s+"
                    r"(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"
                    r"(?:\"(?:\"\"|[^\"])+\"|(?:[^\W\d]|_)[\w$\u0080-\U0010ffff]*)"
                    r"(?:\s*\.\s*(?:\"(?:\"\"|[^\"])+\"|(?:[^\W\d]|_)[\w$\u0080-\U0010ffff]*))?\s+"
                    r"RENAME\s+TO\s+"
                    r"((?:\"(?:\"\"|[^\"])+\"|(?:[^\W\d]|_)[\w$\u0080-\U0010ffff]*))",
                    inspectable_sql,
                    re.IGNORECASE,
                )
            )
            persisted_targets.extend(
                match.group(1)
                for match in re.finditer(
                    r"\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMPORARY|TEMP)\s+)?"
                    r"(?:(?:MATERIALIZED|RECURSIVE)\s+)?VIEW\s+"
                    r"(?:IF\s+NOT\s+EXISTS\s+)?"
                    r"((?:\"(?:\"\"|[^\"])+\"|(?:[^\W\d]|_)[\w$\u0080-\U0010ffff]*)"
                    r"(?:\s*\.\s*(?:\"(?:\"\"|[^\"])+\"|(?:[^\W\d]|_)[\w$\u0080-\U0010ffff]*))?)",
                    inspectable_sql,
                    re.IGNORECASE,
                )
            )
            persisted_targets.extend(
                match.group(1)
                for match in re.finditer(
                    r"\bSELECT\b[\s\S]*?\bINTO\s+"
                    r"(?:(?:TEMPORARY|TEMP|UNLOGGED)\s+)?(?:TABLE\s+)?"
                    r"((?:\"(?:\"\"|[^\"])+\"|(?:[^\W\d]|_)[\w$\u0080-\U0010ffff]*)"
                    r"(?:\s*\.\s*(?:\"(?:\"\"|[^\"])+\"|(?:[^\W\d]|_)[\w$\u0080-\U0010ffff]*))?)",
                    inspectable_sql,
                    re.IGNORECASE,
                )
            )
            found = set()
            for target in persisted_targets:
                normalized_table = re.sub(r"[^a-z0-9]", "", target.lower())
                for projection in projections:
                    normalized_projection = re.sub(r"[^a-z0-9]", "", projection.lower())
                    if normalized_projection in normalized_table:
                        found.add(projection)
            return found

        def is_migrations_receiver(
            node: ast.AST,
            use_lineno: int,
            seen: frozenset[str] = frozenset(),
            _migration_module_aliases: set[str] = migration_module_aliases,
            _assignment_nodes: dict[str, list[ast.AST]] = assignment_nodes,
            _import_binding_counts: dict[str, int] = import_binding_counts,
            _assignments: dict[str, ast.AST] = assignments,
            _assignment_lines: dict[str, int] = assignment_lines,
            _functions: dict[str, ast.FunctionDef] = functions,
        ) -> bool:
            if isinstance(node, (ast.Attribute, ast.Subscript, ast.Starred)):
                return is_migrations_receiver(node.value, use_lineno, seen)
            if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
                return any(is_migrations_receiver(item, use_lineno, seen) for item in node.elts)
            if isinstance(node, ast.Dict):
                return any(
                    is_migrations_receiver(item, use_lineno, seen)
                    for item in (*node.keys, *node.values)
                    if item is not None
                )
            if isinstance(node, ast.IfExp):
                return is_migrations_receiver(
                    node.body, use_lineno, seen
                ) or is_migrations_receiver(node.orelse, use_lineno, seen)
            if isinstance(node, ast.Call):
                if (
                    isinstance(node.func, ast.Name)
                    and node.func.id in _functions
                    and f"function:{node.func.id}" not in seen
                ):
                    function_seen = seen | {f"function:{node.func.id}"}
                    if any(
                        isinstance(statement, ast.Return)
                        and statement.value is not None
                        and is_migrations_receiver(statement.value, use_lineno, function_seen)
                        for statement in ast.walk(_functions[node.func.id])
                    ):
                        return True
                if isinstance(node.func, ast.Attribute) and is_migrations_receiver(
                    node.func.value, use_lineno, seen
                ):
                    return True
                return any(
                    is_migrations_receiver(argument, use_lineno, seen) for argument in node.args
                ) or any(
                    is_migrations_receiver(keyword.value, use_lineno, seen)
                    for keyword in node.keywords
                )
            if not isinstance(node, ast.Name) or node.id in seen:
                return False
            if node.id in _migration_module_aliases:
                return node.id not in _assignment_nodes and _import_binding_counts.get(node.id) == 1
            if node.id not in _assignments or _assignment_lines[node.id] >= use_lineno:
                return False
            return is_migrations_receiver(
                _assignments[node.id], _assignment_lines[node.id], seen | {node.id}
            )

        def is_migrations_operation_namespace(
            node: ast.AST,
            use_lineno: int,
            _namespace_aliases: set[str] = migration_operation_namespace_aliases,
            _assignment_nodes: dict[str, list[ast.AST]] = assignment_nodes,
            _import_binding_counts: dict[str, int] = import_binding_counts,
        ) -> bool:
            if isinstance(node, ast.Name) and node.id in _namespace_aliases:
                return node.id not in _assignment_nodes and _import_binding_counts.get(node.id) == 1
            return is_migrations_receiver(node, use_lineno) or (
                isinstance(node, ast.Attribute)
                and node.attr == "operations"
                and is_migrations_receiver(node.value, use_lineno)
            )

        def is_selected_operation(
            node: ast.AST,
            operation: str,
            use_lineno: int,
            _unresolved: object = unresolved,
        ) -> bool:
            selector: ast.AST | None = None
            receiver: ast.AST | None = None
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "getattr"
                and len(node.args) >= 2
            ):
                receiver, selector = node.args[:2]
            elif isinstance(node, ast.Subscript):
                selector = node.slice
                if isinstance(node.value, ast.Attribute) and node.value.attr == "__dict__":
                    receiver = node.value.value
                elif (
                    isinstance(node.value, ast.Call)
                    and isinstance(node.value.func, ast.Name)
                    and node.value.func.id == "vars"
                    and len(node.value.args) == 1
                ):
                    receiver = node.value.args[0]
            if (
                receiver is None
                or selector is None
                or not is_migrations_receiver(receiver, use_lineno)
            ):
                return False
            if not bindings_are_prior(selector, use_lineno):
                return True
            resolved = static_value(selector)
            # A dynamic operation selector may resolve to any persistence primitive.
            return resolved is _unresolved or resolved == operation

        imported_callable_names = set(imported_names)
        approved_operation_import_sources = {
            "datetime",
            "datetime:timedelta",
            "core.db.ids",
            "core.db.ids:new_uuid7",
            "core.db.functions",
            "core.db.functions:ClockTimestamp",
            "django.db:migrations",
            "django.db:models",
            "django.db.migrations",
            "django.db.models",
            "django.db.models.deletion",
            "django.db.models.expressions",
            "django.db.models.functions.text",
            "django.db.models.functions:Length",
            "django.db.models.lookups:GreaterThan",
        }
        if verified_expiry_default:
            approved_operation_import_sources.add("apps.extensions.expiry")
        verified_by_value_defaults = (
            {"apps.extensions.expiry.delivery_expiry"} if verified_expiry_default else set()
        )
        trusted_operation_value_names = {
            name
            for name, sources in module_import_sources.items()
            if sources
            and sources <= approved_operation_import_sources
            and name not in assignment_nodes
        }

        approved_operation_attribute_paths = {
            "datetime.timedelta",
            "core.db.ids.new_uuid7",
            "core.db.functions.ClockTimestamp",
            "django.db.models.BigIntegerField",
            "django.db.models.BinaryField",
            "django.db.models.BooleanField",
            "django.db.models.CheckConstraint",
            "django.db.models.DateTimeField",
            "django.db.models.Deferrable.DEFERRED",
            "django.db.models.F",
            "django.db.models.ForeignKey",
            "django.db.models.Func",
            "django.db.models.GenericIPAddressField",
            "django.db.models.Index",
            "django.db.models.IntegerField",
            "django.db.models.JSONField",
            "django.db.models.OneToOneField",
            "django.db.models.PositiveBigIntegerField",
            "django.db.models.PositiveIntegerField",
            "django.db.models.Q",
            "django.db.models.RESTRICT",
            "django.db.models.TextField",
            "django.db.models.UUIDField",
            "django.db.models.UniqueConstraint",
            "django.db.models.Value",
            "django.db.models.deletion.RESTRICT",
            "django.db.models.expressions.CombinedExpression",
            "django.db.models.functions.Length",
            "django.db.models.functions.text.Concat",
            "django.db.models.lookups.GreaterThan",
        }
        approved_operation_attribute_paths.update(
            f"django.db.migrations.{operation}" for operation in known_django_operations
        )
        approved_operation_attribute_paths.update(
            {
                "django.db.migrations.Migration",
                "django.db.migrations.RunPython.noop",
                "django.db.migrations.RunSQL.noop",
            }
        )
        approved_operation_by_value_slots = {
            "core.db.ids.new_uuid7": {("django.db.models.UUIDField", "default")},
            "django.db.models.Deferrable.DEFERRED": {
                ("django.db.models.UniqueConstraint", "deferrable")
            },
            "django.db.models.RESTRICT": {
                ("django.db.models.ForeignKey", "on_delete"),
                ("django.db.models.OneToOneField", "on_delete"),
            },
            "django.db.models.deletion.RESTRICT": {
                ("django.db.models.ForeignKey", "on_delete"),
                ("django.db.models.OneToOneField", "on_delete"),
            },
        }
        if verified_expiry_default:
            approved_operation_by_value_slots["apps.extensions.expiry.delivery_expiry"] = {
                ("django.db.models.DateTimeField", "default")
            }
        approved_operation_root_values = {
            "django.db.migrations.RunPython.noop",
            "django.db.migrations.RunSQL.noop",
        }

        def attribute_path(node: ast.AST) -> tuple[str, ...] | None:
            path = []
            while isinstance(node, ast.Attribute):
                path.append(node.attr)
                node = node.value
            if not isinstance(node, ast.Name):
                return None
            return (node.id, *reversed(path))

        def canonical_import_paths(
            path: tuple[str, ...],
            _module_import_sources: dict[str, set[str]] = module_import_sources,
        ) -> set[str]:
            sources = _module_import_sources.get(path[0], set())
            canonical = set()
            for source in sources:
                if ":" in source:
                    module, symbol = source.split(":", maxsplit=1)
                    canonical.add(".".join((module, symbol, *path[1:])))
                    continue
                source_parts = tuple(source.split("."))
                if path[: len(source_parts)] == source_parts:
                    canonical.add(".".join(path))
                else:
                    canonical.add(".".join((*source_parts, *path[1:])))
            return canonical

        trusted_operation_factory_names = {
            name
            for name, function in functions.items()
            if any(
                isinstance(child, ast.Name)
                and isinstance(child.ctx, ast.Load)
                and child.id in trusted_operation_value_names
                for child in ast.walk(function)
            )
        }
        changed_trusted_factories = True
        while changed_trusted_factories:
            changed_trusted_factories = False
            for name, function in functions.items():
                if name in trusted_operation_factory_names:
                    continue
                if any(
                    isinstance(child, ast.Name)
                    and isinstance(child.ctx, ast.Load)
                    and child.id in trusted_operation_factory_names
                    for child in ast.walk(function)
                ):
                    trusted_operation_factory_names.add(name)
                    changed_trusted_factories = True

        def uses_unapproved_operation_import_access(
            node: ast.AST,
            _trusted_names: set[str] = trusted_operation_value_names,
            _trusted_factories: set[str] = trusted_operation_factory_names,
            _approved_paths: set[str] = approved_operation_attribute_paths,
            _approved_by_value_slots: dict[
                str, set[tuple[str, str]]
            ] = approved_operation_by_value_slots,
            _approved_root_values: set[str] = approved_operation_root_values,
            _verified_defaults: set[str] = verified_by_value_defaults,
            _canonical_import_paths: Callable[[tuple[str, ...]], set[str]] = (
                canonical_import_paths
            ),
        ) -> bool:
            parents = {
                id(descendant): parent
                for parent in ast.walk(node)
                for descendant in ast.iter_child_nodes(parent)
            }
            lexically_shadowed_imports = {
                name
                for child in ast.walk(node)
                if isinstance(child, ast.comprehension)
                for name in bound_names(child.target)
                if name in _trusted_names
            }
            lexically_shadowed_imports.update(
                argument.arg
                for child in ast.walk(node)
                if isinstance(child, ast.Lambda)
                for argument in (
                    *child.args.posonlyargs,
                    *child.args.args,
                    *child.args.kwonlyargs,
                )
                if argument.arg in _trusted_names
            )

            def approved_by_value_use(value_node: ast.AST, candidates: set[str]) -> bool:
                if value_node is node and any(
                    candidate in _approved_root_values for candidate in candidates
                ):
                    return True
                parent = parents.get(id(value_node))
                if not isinstance(parent, ast.keyword) or parent.arg is None:
                    return False
                call = parents.get(id(parent))
                if not isinstance(call, ast.Call):
                    return False
                consumer_path = attribute_path(call.func)
                if consumer_path is None:
                    return False
                consumers = _canonical_import_paths(consumer_path)
                return any(
                    (consumer, parent.arg) in _approved_by_value_slots.get(candidate, set())
                    for candidate in candidates
                    for consumer in consumers
                )

            contains_trusted_import = any(
                isinstance(child, ast.Name)
                and isinstance(child.ctx, ast.Load)
                and child.id in _trusted_names
                for child in ast.walk(node)
            )
            contains_trusted_factory = any(
                isinstance(child, ast.Name)
                and isinstance(child.ctx, ast.Load)
                and child.id in _trusted_factories
                for child in ast.walk(node)
            )
            if contains_trusted_import and any(
                isinstance(child, (ast.Lambda, ast.NamedExpr))
                or isinstance(child, ast.Call)
                and isinstance(child.func, ast.Name)
                and child.func.id == "getattr"
                for child in ast.walk(node)
            ):
                return True
            for comprehension in (
                child
                for child in ast.walk(node)
                if isinstance(
                    child,
                    (ast.DictComp, ast.GeneratorExp, ast.ListComp, ast.SetComp),
                )
            ):
                if any(
                    isinstance(descendant, ast.Name)
                    and isinstance(descendant.ctx, ast.Load)
                    and descendant.id in _trusted_names | _trusted_factories
                    for generator in comprehension.generators
                    for descendant in ast.walk(generator.iter)
                ):
                    return True
            if contains_trusted_factory and any(
                isinstance(child, ast.Call)
                and isinstance(child.func, ast.Name)
                and child.func.id == "getattr"
                for child in ast.walk(node)
            ):
                return True
            if (contains_trusted_import or contains_trusted_factory) and any(
                isinstance(child, ast.Attribute)
                and child.attr.startswith("__")
                and child.attr.endswith("__")
                for child in ast.walk(node)
            ):
                return True
            for child in ast.walk(node):
                if isinstance(child, ast.Attribute):
                    path = attribute_path(child)
                    if path is None:
                        if any(
                            isinstance(descendant, ast.Name)
                            and isinstance(descendant.ctx, ast.Load)
                            and descendant.id in _trusted_names | _trusted_factories
                            for descendant in ast.walk(child)
                        ):
                            return True
                        continue
                    if path[0] not in _trusted_names:
                        continue
                    if path[0] in lexically_shadowed_imports:
                        return True
                    parent = parents.get(id(child))
                    if isinstance(parent, ast.Attribute) and parent.value is child:
                        continue
                    candidates = _canonical_import_paths(path)
                    if candidates & _verified_defaults:
                        if len(candidates) != 1 or not approved_by_value_use(child, candidates):
                            return True
                        continue
                    if not any(candidate in _approved_paths for candidate in candidates):
                        return True
                    if not (
                        isinstance(parent, ast.Call) and parent.func is child
                    ) and not approved_by_value_use(child, candidates):
                        return True
                    continue
                if (
                    not isinstance(child, ast.Name)
                    or not isinstance(child.ctx, ast.Load)
                    or child.id not in _trusted_names | _trusted_factories
                ):
                    continue
                parent = parents.get(id(child))
                if isinstance(parent, ast.Attribute) and parent.value is child:
                    continue
                if child.id in _trusted_factories:
                    if not (isinstance(parent, ast.Call) and parent.func is child):
                        return True
                    call_parent = parents.get(id(parent))
                    if (
                        isinstance(call_parent, ast.Call)
                        and call_parent.func is parent
                        or isinstance(call_parent, ast.Subscript)
                        and call_parent.value is parent
                    ):
                        return True
                    continue
                candidates = _canonical_import_paths((child.id,))
                if candidates & _verified_defaults:
                    if len(candidates) != 1 or not approved_by_value_use(child, candidates):
                        return True
                    continue
                if not any(candidate in _approved_paths for candidate in candidates):
                    return True
                if not (
                    isinstance(parent, ast.Call) and parent.func is child
                ) and not approved_by_value_use(child, candidates):
                    return True
            return False

        def function_executes_unapproved_authority(
            function: ast.FunctionDef | ast.ClassDef,
            _trusted_names: set[str] = trusted_operation_value_names,
            _trusted_factories: set[str] = trusted_operation_factory_names,
            _approved_paths: set[str] = approved_operation_attribute_paths,
        ) -> bool:
            tainted_names: set[str] = set()
            scope_nodes = lexical_scope_nodes(function)
            scope_node_ids = {id(node) for node in scope_nodes}
            locally_bound_names = {
                child.id
                for child in scope_nodes
                if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store)
            }
            authority_mutator_aliases: set[str] = (
                set() if "setattr" in locally_bound_names else {"setattr"}
            )
            if isinstance(function, ast.FunctionDef):
                positional_arguments = [*function.args.posonlyargs, *function.args.args]
                for argument, default in zip(
                    positional_arguments[-len(function.args.defaults) :]
                    if function.args.defaults
                    else [],
                    function.args.defaults,
                    strict=True,
                ):
                    if binding_in_expression(default, authority_mutator_aliases):
                        authority_mutator_aliases.add(argument.arg)
                for argument, kw_default in zip(
                    function.args.kwonlyargs,
                    function.args.kw_defaults,
                    strict=True,
                ):
                    if kw_default is not None and binding_in_expression(
                        kw_default, authority_mutator_aliases
                    ):
                        authority_mutator_aliases.add(argument.arg)

            def nested_class_executes_authority() -> bool:
                return any(
                    function_executes_unapproved_authority(
                        child,
                        _trusted_names,
                        _trusted_factories,
                        _approved_paths,
                    )
                    for child in scope_nodes
                    if isinstance(child, ast.ClassDef)
                )

            def authority_bindings(
                binding_candidate: ast.AST,
            ) -> list[tuple[ast.AST, ast.AST]]:
                if isinstance(binding_candidate, ast.Assign):
                    return [
                        (target, binding_candidate.value) for target in binding_candidate.targets
                    ]
                if (
                    isinstance(binding_candidate, ast.AnnAssign)
                    and binding_candidate.value is not None
                ):
                    return [(binding_candidate.target, binding_candidate.value)]
                if isinstance(binding_candidate, (ast.NamedExpr, ast.AugAssign)):
                    return [(binding_candidate.target, binding_candidate.value)]
                if isinstance(binding_candidate, (ast.For, ast.AsyncFor, ast.comprehension)):
                    return [(binding_candidate.target, binding_candidate.iter)]
                if isinstance(binding_candidate, (ast.With, ast.AsyncWith)):
                    return [
                        (item.optional_vars, item.context_expr)
                        for item in binding_candidate.items
                        if item.optional_vars is not None
                    ]
                if isinstance(binding_candidate, ast.Match):
                    return [
                        (case.pattern, binding_candidate.subject)
                        for case in binding_candidate.cases
                    ]
                return []

            def authority_bound_names(target: ast.AST) -> set[str]:
                names = bound_names(target)
                names.update(
                    child.name
                    for child in ast.walk(target)
                    if isinstance(child, (ast.MatchAs, ast.MatchStar)) and child.name is not None
                )
                names.update(
                    child.rest
                    for child in ast.walk(target)
                    if isinstance(child, ast.MatchMapping) and child.rest is not None
                )
                return names

            changed = True
            while changed:
                changed = False
                for child in scope_nodes:
                    for target, value in authority_bindings(child):
                        if binding_in_expression(value, authority_mutator_aliases):
                            for name in authority_bound_names(target):
                                if name not in authority_mutator_aliases:
                                    authority_mutator_aliases.add(name)
                                    changed = True
                    for target, value in authority_bindings(child):
                        contains_authority = any(
                            isinstance(descendant, ast.Name)
                            and isinstance(descendant.ctx, ast.Load)
                            and descendant.id in _trusted_names | _trusted_factories | tainted_names
                            for descendant in ast.walk(value)
                        )
                        if not contains_authority:
                            continue
                        if any(
                            isinstance(descendant, (ast.Attribute, ast.Subscript))
                            for descendant in ast.walk(target)
                        ):
                            return True
                        for name in authority_bound_names(target):
                            if name not in tainted_names:
                                tainted_names.add(name)
                                changed = True
            direct_nested_functions = {
                child.name: child
                for child in scope_nodes
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
            }

            def scope_loads_authority(
                nested_scope: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef,
            ) -> bool:
                return any(
                    isinstance(descendant, ast.Name)
                    and isinstance(descendant.ctx, ast.Load)
                    and descendant.id in _trusted_names | _trusted_factories | tainted_names
                    for descendant in lexical_scope_nodes(nested_scope)
                )

            nested_authority_providers = {
                name
                for name, nested_function in direct_nested_functions.items()
                if scope_loads_authority(nested_function)
            }
            nested_classes = {
                child.name: child for child in scope_nodes if isinstance(child, ast.ClassDef)
            }
            class_authority_methods = {
                class_name: {
                    method.name
                    for method in class_node.body
                    if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and scope_loads_authority(method)
                }
                for class_name, class_node in nested_classes.items()
            }
            changed_inherited_authority = True
            while changed_inherited_authority:
                changed_inherited_authority = False
                for class_name, class_node in nested_classes.items():
                    inherited_methods = {
                        method_name
                        for base in class_node.bases
                        if (base_path := attribute_path(base)) is not None and len(base_path) == 1
                        for method_name in class_authority_methods.get(base_path[0], set())
                    }
                    if not inherited_methods.issubset(class_authority_methods[class_name]):
                        class_authority_methods[class_name].update(inherited_methods)
                        changed_inherited_authority = True
            class_authority_methods = {
                name: methods for name, methods in class_authority_methods.items() if methods
            }
            nested_authority_paths = {
                (class_name, method_name)
                for class_name, methods in class_authority_methods.items()
                for method_name in methods
            }
            changed_providers = True
            while changed_providers:
                changed_providers = False
                for name, nested_function in direct_nested_functions.items():
                    if name in nested_authority_providers:
                        continue
                    nested_function_nodes = lexical_scope_nodes(nested_function)
                    default_values = [
                        *nested_function.args.defaults,
                        *(
                            default
                            for default in nested_function.args.kw_defaults
                            if default is not None
                        ),
                    ]
                    local_nested_functions = {
                        child.name: child
                        for child in nested_function_nodes
                        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                    }
                    returns_local_authority = any(
                        isinstance(descendant, ast.Return)
                        and isinstance(descendant.value, ast.Name)
                        and (returned_function := local_nested_functions.get(descendant.value.id))
                        is not None
                        and scope_loads_authority(returned_function)
                        for descendant in nested_function_nodes
                    )
                    if (
                        any(
                            isinstance(descendant, ast.Call)
                            and (path := attribute_path(descendant.func)) is not None
                            and (
                                path[0] in nested_authority_providers
                                or path in nested_authority_paths
                            )
                            for descendant in nested_function_nodes
                        )
                        or any(
                            isinstance(descendant, ast.Return)
                            and descendant.value is not None
                            and binding_in_expression(descendant.value, nested_authority_providers)
                            for descendant in nested_function_nodes
                        )
                        or any(
                            binding_in_expression(default, nested_authority_providers)
                            for default in default_values
                        )
                        or returns_local_authority
                    ):
                        nested_authority_providers.add(name)
                        changed_providers = True
            provider_aliases = set(nested_authority_providers)
            class_alias_origins = {class_name: class_name for class_name in class_authority_methods}
            class_factory_origins: dict[str, str] = {}
            instance_alias_origins: dict[str, str] = {}
            instance_factory_origins: dict[str, str] = {}
            changed_provider_aliases = True
            while changed_provider_aliases:
                changed_provider_aliases = False
                for name, nested_function in direct_nested_functions.items():
                    nested_nodes = lexical_scope_nodes(nested_function)
                    for descendant in nested_nodes:
                        if not isinstance(descendant, ast.Return) or descendant.value is None:
                            continue
                        returned_class_path = attribute_path(descendant.value)
                        if returned_class_path is None or len(returned_class_path) != 1:
                            continue
                        returned_class_origin = class_alias_origins.get(
                            returned_class_path[0]
                        ) or class_factory_origins.get(returned_class_path[0])
                        if (
                            returned_class_origin is not None
                            and class_factory_origins.get(name) != returned_class_origin
                        ):
                            class_factory_origins[name] = returned_class_origin
                            changed_provider_aliases = True
                    local_class_origins: dict[str, str] = {}

                    def expression_class_origins(
                        class_expression: ast.AST,
                        _local_class_origins: dict[str, str] = local_class_origins,
                    ) -> set[str]:
                        expression_parents = {
                            id(descendant): parent
                            for parent in ast.walk(class_expression)
                            for descendant in ast.iter_child_nodes(parent)
                        }
                        return {
                            origin
                            for descendant in ast.walk(class_expression)
                            if isinstance(descendant, ast.Name)
                            and isinstance(descendant.ctx, ast.Load)
                            and not (
                                isinstance(
                                    parent := expression_parents.get(id(descendant)), ast.Call
                                )
                                and parent.func is descendant
                            )
                            and (
                                origin := class_alias_origins.get(descendant.id)
                                or class_factory_origins.get(descendant.id)
                                or _local_class_origins.get(descendant.id)
                            )
                            is not None
                        }

                    changed_local_classes = True
                    while changed_local_classes:
                        changed_local_classes = False
                        for descendant in nested_nodes:
                            for target, value in authority_bindings(descendant):
                                origins = expression_class_origins(value)
                                if not origins:
                                    continue
                                if len(origins) > 1:
                                    return True
                                origin = next(iter(origins))
                                for target_name in authority_bound_names(target):
                                    if local_class_origins.get(target_name) != origin:
                                        local_class_origins[target_name] = origin
                                        changed_local_classes = True
                    returned_class_origins = {
                        origin
                        for descendant in nested_nodes
                        if isinstance(descendant, ast.Return) and descendant.value is not None
                        for origin in expression_class_origins(descendant.value)
                    }
                    if returned_class_origins:
                        if len(returned_class_origins) > 1:
                            return True
                        returned_class_origin = next(iter(returned_class_origins))
                        if class_factory_origins.get(name) != returned_class_origin:
                            class_factory_origins[name] = returned_class_origin
                            changed_provider_aliases = True
                    local_instance_origins: dict[str, str] = {}

                    def expression_instance_origins(
                        instance_expression: ast.AST,
                        _local_instance_origins: dict[str, str] = local_instance_origins,
                    ) -> set[str]:
                        origins = {
                            origin
                            for descendant in ast.walk(instance_expression)
                            if isinstance(descendant, ast.Call)
                            and (path := attribute_path(descendant.func)) is not None
                            and len(path) == 1
                            and (
                                origin := class_alias_origins.get(path[0])
                                or instance_factory_origins.get(path[0])
                            )
                            is not None
                        }
                        origins.update(
                            _local_instance_origins[descendant.id]
                            for descendant in ast.walk(instance_expression)
                            if isinstance(descendant, ast.Name)
                            and isinstance(descendant.ctx, ast.Load)
                            and descendant.id in _local_instance_origins
                        )
                        return origins

                    changed_local_instances = True
                    while changed_local_instances:
                        changed_local_instances = False
                        for descendant in nested_nodes:
                            for target, value in authority_bindings(descendant):
                                origins = expression_instance_origins(value)
                                if not origins:
                                    continue
                                if len(origins) > 1:
                                    return True
                                origin = sorted(origins)[0]
                                for target_name in authority_bound_names(target):
                                    if local_instance_origins.get(target_name) != origin:
                                        local_instance_origins[target_name] = origin
                                        changed_local_instances = True
                    returned_origins = {
                        origin
                        for descendant in nested_nodes
                        if isinstance(descendant, ast.Return) and descendant.value is not None
                        for origin in expression_instance_origins(descendant.value)
                    }
                    if returned_origins:
                        if len(returned_origins) > 1:
                            return True
                        returned_origin = sorted(returned_origins)[0]
                        if instance_factory_origins.get(name) != returned_origin:
                            instance_factory_origins[name] = returned_origin
                            changed_provider_aliases = True
                for child in scope_nodes:
                    for target, value in authority_bindings(child):
                        value_path = attribute_path(value)
                        value_call_path = (
                            attribute_path(value.func) if isinstance(value, ast.Call) else None
                        )
                        provider_value = binding_in_expression(value, provider_aliases)
                        contained_class_origins = {
                            class_candidate_origin
                            for descendant in ast.walk(value)
                            if isinstance(descendant, ast.Name)
                            and isinstance(descendant.ctx, ast.Load)
                            and (
                                class_candidate_origin := class_alias_origins.get(descendant.id)
                                or class_factory_origins.get(descendant.id)
                            )
                            is not None
                        }
                        if len(contained_class_origins) > 1:
                            return True
                        class_origin = (
                            class_alias_origins.get(value_path[0])
                            or class_factory_origins.get(value_path[0])
                            if value_path is not None and len(value_path) == 1
                            else None
                        )
                        if class_origin is None and contained_class_origins:
                            class_origin = next(iter(contained_class_origins))
                        if any(
                            isinstance(descendant, ast.Attribute)
                            and (receiver_path := attribute_path(descendant.value)) is not None
                            and len(receiver_path) == 1
                            and (
                                method_origin := class_alias_origins.get(receiver_path[0])
                                or instance_alias_origins.get(receiver_path[0])
                            )
                            is not None
                            and descendant.attr in class_authority_methods.get(method_origin, set())
                            for descendant in ast.walk(value)
                        ):
                            provider_value = True
                        if (
                            value_path is not None
                            and len(value_path) == 2
                            and (method_origin := class_alias_origins.get(value_path[0]))
                            is not None
                            and value_path[1] in class_authority_methods.get(method_origin, set())
                        ):
                            provider_value = True
                        if (
                            value_path is not None
                            and len(value_path) == 2
                            and (method_origin := instance_alias_origins.get(value_path[0]))
                            is not None
                            and value_path[1] in class_authority_methods.get(method_origin, set())
                        ):
                            provider_value = True
                        instance_origin = (
                            instance_alias_origins.get(value_path[0])
                            if value_path is not None and len(value_path) == 1
                            else None
                        )
                        if value_call_path is not None and len(value_call_path) == 1:
                            instance_origin = class_alias_origins.get(
                                value_call_path[0]
                            ) or instance_factory_origins.get(value_call_path[0])
                            if instance_origin is None:
                                class_origin = class_factory_origins.get(value_call_path[0])
                        if isinstance(value, ast.Call) and isinstance(value.func, ast.Call):
                            class_factory_path = attribute_path(value.func.func)
                            if class_factory_path is not None and len(class_factory_path) == 1:
                                instance_origin = class_factory_origins.get(class_factory_path[0])
                        contained_instance_origins = {
                            instance_candidate_origin
                            for descendant in ast.walk(value)
                            if isinstance(descendant, ast.Call)
                            and (descendant_path := attribute_path(descendant.func)) is not None
                            and len(descendant_path) == 1
                            and (
                                instance_candidate_origin := class_alias_origins.get(
                                    descendant_path[0]
                                )
                                or instance_factory_origins.get(descendant_path[0])
                            )
                            is not None
                        }
                        if len(contained_instance_origins) > 1:
                            return True
                        if instance_origin is None and contained_instance_origins:
                            instance_origin = next(iter(contained_instance_origins))
                        if not provider_value and class_origin is None and instance_origin is None:
                            continue
                        if any(
                            isinstance(descendant, (ast.Attribute, ast.Subscript))
                            for descendant in ast.walk(target)
                        ):
                            return True
                        for name in authority_bound_names(target):
                            if provider_value and name not in provider_aliases:
                                provider_aliases.add(name)
                                changed_provider_aliases = True
                            if (
                                class_origin is not None
                                and class_alias_origins.get(name) != class_origin
                            ):
                                class_alias_origins[name] = class_origin
                                changed_provider_aliases = True
                            if (
                                instance_origin is not None
                                and instance_alias_origins.get(name) != instance_origin
                            ):
                                instance_alias_origins[name] = instance_origin
                                changed_provider_aliases = True
                for child in scope_nodes:
                    if (
                        not isinstance(child, ast.Call)
                        or not isinstance(child.func, ast.Attribute)
                        or child.func.attr
                        not in {
                            "add",
                            "append",
                            "extend",
                            "insert",
                            "setdefault",
                            "update",
                        }
                    ):
                        continue
                    mutated_path = attribute_path(child.func.value)
                    arguments = (
                        *child.args,
                        *(keyword.value for keyword in child.keywords),
                    )
                    mutated_origins = {
                        mutated_candidate_origin
                        for argument in arguments
                        for descendant in ast.walk(argument)
                        if isinstance(descendant, ast.Call)
                        and (descendant_path := attribute_path(descendant.func)) is not None
                        and len(descendant_path) == 1
                        and (
                            mutated_candidate_origin := class_alias_origins.get(descendant_path[0])
                            or instance_factory_origins.get(descendant_path[0])
                        )
                        is not None
                    }
                    mutated_origins.update(
                        instance_alias_origins[descendant.id]
                        for argument in arguments
                        for descendant in ast.walk(argument)
                        if isinstance(descendant, ast.Name)
                        and isinstance(descendant.ctx, ast.Load)
                        and descendant.id in instance_alias_origins
                    )
                    if not mutated_origins:
                        continue
                    if len(mutated_origins) > 1 or mutated_path is None or len(mutated_path) != 1:
                        return True
                    mutated_origin = next(iter(mutated_origins))
                    if instance_alias_origins.get(mutated_path[0]) != mutated_origin:
                        instance_alias_origins[mutated_path[0]] = mutated_origin
                        changed_provider_aliases = True
            for child in scope_nodes:
                if isinstance(child, ast.Call):
                    call_path = attribute_path(child.func)
                    if (
                        any(
                            isinstance(descendant, ast.Name)
                            and isinstance(descendant.ctx, ast.Load)
                            and descendant.id in provider_aliases
                            for descendant in ast.walk(child.func)
                        )
                        or isinstance(child.func, ast.Attribute)
                        and any(
                            isinstance(descendant, ast.Name)
                            and isinstance(descendant.ctx, ast.Load)
                            and (
                                instance_origin := instance_alias_origins.get(descendant.id)
                                or class_alias_origins.get(descendant.id)
                            )
                            is not None
                            and child.func.attr
                            in class_authority_methods.get(instance_origin, set())
                            for descendant in ast.walk(child.func.value)
                        )
                        or call_path is not None
                        and (
                            call_path in nested_authority_paths
                            or len(call_path) >= 2
                            and (class_origin := class_alias_origins.get(call_path[0])) is not None
                            and call_path[1] in class_authority_methods.get(class_origin, set())
                            or len(call_path) >= 2
                            and (instance_origin := instance_alias_origins.get(call_path[0]))
                            is not None
                            and call_path[1] in class_authority_methods.get(instance_origin, set())
                        )
                    ):
                        return True
                    arguments = (
                        *child.args,
                        *(keyword.value for keyword in child.keywords),
                    )
                    if any(
                        isinstance(descendant, ast.Name)
                        and isinstance(descendant.ctx, ast.Load)
                        and descendant.id
                        in _trusted_names
                        | _trusted_factories
                        | tainted_names
                        | provider_aliases
                        | set(class_alias_origins)
                        | set(class_factory_origins)
                        | set(instance_alias_origins)
                        for value in arguments
                        for descendant in ast.walk(value)
                    ) and (
                        call_path is None
                        or not any(
                            candidate in _approved_paths
                            for candidate in canonical_import_paths(call_path)
                        )
                    ):
                        return True
                if (
                    isinstance(child, ast.Call)
                    and (
                        isinstance(child.func, ast.Attribute)
                        and child.func.attr
                        in {
                            "__setitem__",
                            "add",
                            "append",
                            "extend",
                            "insert",
                            "setdefault",
                            "update",
                        }
                        or isinstance(child.func, ast.Name)
                        and child.func.id in authority_mutator_aliases
                    )
                    and any(
                        isinstance(descendant, ast.Name)
                        and isinstance(descendant.ctx, ast.Load)
                        and descendant.id in _trusted_names | _trusted_factories | tainted_names
                        for value in (
                            *child.args,
                            *(keyword.value for keyword in child.keywords),
                        )
                        for descendant in ast.walk(value)
                    )
                ):
                    return True
            if not tainted_names:
                return nested_class_executes_authority()
            parents = {
                id(descendant): parent
                for parent in scope_nodes
                for descendant in ast.iter_child_nodes(parent)
                if id(descendant) in scope_node_ids
            }
            for child in scope_nodes:
                if isinstance(child, ast.Attribute) and any(
                    isinstance(descendant, ast.Name)
                    and isinstance(descendant.ctx, ast.Load)
                    and descendant.id in tainted_names
                    for descendant in ast.walk(child.value)
                ):
                    return True
                if not isinstance(child, ast.Name) or child.id not in tainted_names:
                    continue
                parent = parents.get(id(child))
                if not isinstance(child.ctx, ast.Load) or isinstance(
                    parent, (ast.Attribute, ast.Return)
                ):
                    continue
                if isinstance(parent, ast.Call) and parent.func is child:
                    return True
                if isinstance(parent, (ast.keyword, ast.Starred)):
                    call = parents.get(id(parent))
                else:
                    call = parent if isinstance(parent, ast.Call) else None
                if isinstance(call, ast.Call):
                    path = attribute_path(call.func)
                    if path is not None and any(
                        candidate in _approved_paths for candidate in canonical_import_paths(path)
                    ):
                        continue
                if not isinstance(parent, (ast.Assign, ast.AnnAssign)):
                    return True
            return nested_class_executes_authority()

        def uses_imported_binding(
            node: ast.AST,
            seen: frozenset[str] = frozenset(),
            _imported_callable_names: set[str] = imported_callable_names,
            _functions: dict[str, ast.FunctionDef] = functions,
        ) -> bool:
            if isinstance(node, ast.Name):
                return node.id in _imported_callable_names
            if isinstance(node, ast.Subscript):
                if (
                    isinstance(node.value, ast.Call)
                    and isinstance(node.value.func, ast.Name)
                    and node.value.func.id == "globals"
                    and not node.value.args
                    and not node.value.keywords
                    and static_value(node.slice) in _imported_callable_names
                ):
                    return True
                return uses_imported_binding(node.value, seen)
            if isinstance(node, ast.Attribute):
                return uses_imported_binding(node.value, seen)
            if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
                return any(uses_imported_binding(item, seen) for item in node.elts)
            if isinstance(node, ast.Dict):
                return any(
                    uses_imported_binding(item, seen)
                    for item in (*node.keys, *node.values)
                    if item is not None
                )
            if isinstance(node, ast.IfExp):
                return uses_imported_binding(node.body, seen) or uses_imported_binding(
                    node.orelse, seen
                )
            if isinstance(node, ast.BoolOp):
                return any(uses_imported_binding(value, seen) for value in node.values)
            if isinstance(node, ast.BinOp):
                return uses_imported_binding(node.left, seen) or uses_imported_binding(
                    node.right, seen
                )
            if isinstance(node, (ast.NamedExpr, ast.Starred)):
                return uses_imported_binding(node.value, seen)
            if isinstance(node, ast.Call):
                if (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr in {"get", "pop", "setdefault", "__getitem__"}
                    and isinstance(node.func.value, ast.Call)
                    and isinstance(node.func.value.func, ast.Name)
                    and node.func.value.func.id == "globals"
                    and not node.func.value.args
                    and not node.func.value.keywords
                    and node.args
                    and static_value(node.args[0]) in _imported_callable_names
                ):
                    return True
                if (
                    isinstance(node.func, ast.Name)
                    and node.func.id in _functions
                    and node.func.id not in seen
                    and any(
                        isinstance(statement, ast.Return)
                        and statement.value is not None
                        and uses_imported_binding(statement.value, seen | {node.func.id})
                        for statement in ast.walk(_functions[node.func.id])
                    )
                ):
                    return True
                return (
                    uses_imported_binding(node.func, seen)
                    or any(uses_imported_binding(argument, seen) for argument in node.args)
                    or any(uses_imported_binding(keyword.value, seen) for keyword in node.keywords)
                )
            return False

        def uses_untrusted_imported_binding(
            node: ast.AST,
            _imported_names: set[str] = module_imported_names,
            _migration_modules: set[str] = migration_module_aliases,
            _model_modules: set[str] = django_model_module_aliases,
            _migration_classes: set[str] = django_migration_class_aliases,
            _operation_aliases: dict[str, str] = django_operation_aliases,
            _operation_namespaces: set[str] = migration_operation_namespace_aliases,
            _create_aliases: set[str] = create_model_aliases,
            _run_sql_aliases: set[str] = run_sql_aliases,
            _run_python_aliases: set[str] = run_python_aliases,
            _assignment_nodes: dict[str, list[ast.AST]] = assignment_nodes,
            _import_binding_counts: dict[str, int] = import_binding_counts,
            _additional_trusted: frozenset[str] | set[str] = frozenset(),
        ) -> bool:
            trusted_imported = {
                name
                for name in (
                    _migration_modules
                    | _model_modules
                    | _migration_classes
                    | set(_operation_aliases)
                    | _operation_namespaces
                )
                if name not in _assignment_nodes and _import_binding_counts.get(name) == 1
            }
            trusted_operation_aliases = {
                name
                for name in _create_aliases | _run_sql_aliases | _run_python_aliases
                if _import_binding_counts.get(name, 0) == 0
                or (name not in _assignment_nodes and _import_binding_counts.get(name) == 1)
            }
            trusted = trusted_imported | trusted_operation_aliases
            trusted.update(_additional_trusted)
            return any(
                isinstance(child, ast.Name)
                and isinstance(child.ctx, ast.Load)
                and child.id in _imported_names
                and child.id not in trusted
                for child in ast.walk(node)
            )

        def executes_imported_protocol(
            node: ast.AST,
            _known_django_operations: set[str] = known_django_operations,
        ) -> bool:
            for child in ast.walk(node):
                if isinstance(
                    child, (ast.GeneratorExp, ast.ListComp, ast.SetComp, ast.DictComp)
                ) and any(uses_imported_binding(generator.iter) for generator in child.generators):
                    return True
                if isinstance(child, ast.Starred) and uses_imported_binding(child.value):
                    return True
                if isinstance(child, ast.FormattedValue) and uses_imported_binding(child.value):
                    return True
                if isinstance(child, ast.Set) and any(
                    uses_imported_binding(item) for item in child.elts
                ):
                    return True
                if isinstance(child, ast.Dict) and any(
                    (key is None and uses_imported_binding(value))
                    or (key is not None and uses_imported_binding(key))
                    for key, value in zip(child.keys, child.values, strict=True)
                ):
                    return True
                if isinstance(child, (ast.If, ast.While, ast.Assert)) and uses_imported_binding(
                    child.test
                ):
                    return True
                if isinstance(child, ast.Compare) and any(
                    uses_imported_binding(value) for value in (child.left, *child.comparators)
                ):
                    return True
                if isinstance(child, (ast.BinOp, ast.BoolOp, ast.UnaryOp, ast.IfExp)) and (
                    uses_imported_binding(child)
                ):
                    return True
                if (
                    isinstance(child, ast.Call)
                    and (
                        any(uses_imported_binding(argument) for argument in child.args)
                        or any(uses_imported_binding(keyword.value) for keyword in child.keywords)
                    )
                    and not any(
                        is_selected_operation(child, operation, child.lineno)
                        for operation in _known_django_operations
                    )
                ):
                    return True
            return False

        migration_class_aliases = {"Migration"}
        safe_migration_base_aliases = set(django_migration_class_aliases)
        safe_migration_base_binding_node_ids: set[int] = set()
        namespace_mutator_aliases = {"setattr", "delattr"}

        def is_safe_migration_base_name(
            name: str,
            _safe_aliases: set[str] = safe_migration_base_aliases,
            _direct_aliases: set[str] = django_migration_class_aliases,
            _assignment_nodes: dict[str, list[ast.AST]] = assignment_nodes,
            _import_binding_counts: dict[str, int] = import_binding_counts,
        ) -> bool:
            if name not in _safe_aliases:
                return False
            if name in _direct_aliases:
                return name not in _assignment_nodes and _import_binding_counts.get(name) == 1
            return _import_binding_counts.get(name, 0) == 0

        def binding_in_expression(
            node: ast.AST,
            aliases: set[str],
            attribute_names: frozenset[str] = frozenset(),
        ) -> bool:
            if isinstance(node, ast.Name):
                return node.id in aliases
            if isinstance(node, (ast.Attribute, ast.Subscript)):
                return (
                    isinstance(node, ast.Attribute) and node.attr in attribute_names
                ) or binding_in_expression(node.value, aliases, attribute_names)
            if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
                return any(
                    binding_in_expression(item, aliases, attribute_names) for item in node.elts
                )
            if isinstance(node, ast.Dict):
                return any(
                    binding_in_expression(item, aliases, attribute_names)
                    for item in (*node.keys, *node.values)
                    if item is not None
                )
            if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
                return binding_in_expression(node.elt, aliases, attribute_names) or any(
                    binding_in_expression(generator.iter, aliases, attribute_names)
                    or any(
                        binding_in_expression(condition, aliases, attribute_names)
                        for condition in generator.ifs
                    )
                    for generator in node.generators
                )
            if isinstance(node, ast.DictComp):
                return (
                    binding_in_expression(node.key, aliases, attribute_names)
                    or binding_in_expression(node.value, aliases, attribute_names)
                    or any(
                        binding_in_expression(generator.iter, aliases, attribute_names)
                        or any(
                            binding_in_expression(condition, aliases, attribute_names)
                            for condition in generator.ifs
                        )
                        for generator in node.generators
                    )
                )
            if isinstance(node, ast.IfExp):
                return binding_in_expression(
                    node.body, aliases, attribute_names
                ) or binding_in_expression(node.orelse, aliases, attribute_names)
            if isinstance(node, ast.BoolOp):
                return any(
                    binding_in_expression(value, aliases, attribute_names) for value in node.values
                )
            if isinstance(node, ast.BinOp):
                return binding_in_expression(
                    node.left, aliases, attribute_names
                ) or binding_in_expression(node.right, aliases, attribute_names)
            if isinstance(node, (ast.NamedExpr, ast.Starred)):
                return binding_in_expression(node.value, aliases, attribute_names)
            if isinstance(node, ast.Lambda):
                return any(
                    binding_in_expression(value, aliases, attribute_names)
                    for value in (
                        *node.args.defaults,
                        *(value for value in node.args.kw_defaults if value is not None),
                    )
                ) or binding_in_expression(node.body, aliases, attribute_names)
            if isinstance(node, ast.Call):
                return (
                    binding_in_expression(node.func, aliases, attribute_names)
                    or any(
                        binding_in_expression(argument, aliases, attribute_names)
                        for argument in node.args
                    )
                    or any(
                        binding_in_expression(keyword.value, aliases, attribute_names)
                        for keyword in node.keywords
                    )
                )
            return False

        def uses_namespace_mutator_binding(
            node: ast.AST,
            _namespace_mutator_aliases: set[str] = namespace_mutator_aliases,
        ) -> bool:
            return binding_in_expression(
                node,
                _namespace_mutator_aliases,
                frozenset({"setattr", "delattr", "__setattr__", "__delattr__"}),
            )

        def uses_migration_class_binding(
            node: ast.AST,
            _use_lineno: int,
            _migration_class_aliases: set[str] = migration_class_aliases,
        ) -> bool:
            return binding_in_expression(node, _migration_class_aliases, frozenset({"Migration"}))

        def passes_migration_authority(
            call: ast.Call,
            _known_django_operations: set[str] = known_django_operations,
        ) -> bool:
            arguments = [*call.args, *(keyword.value for keyword in call.keywords)]
            if not any(
                is_migrations_operation_namespace(argument, call.lineno)
                or uses_migration_class_binding(argument, call.lineno)
                for argument in arguments
            ):
                return False
            if (
                isinstance(call.func, ast.Name)
                and call.func.id == "getattr"
                and len(call.args) in {2, 3}
                and is_migrations_operation_namespace(call.args[0], call.lineno)
                and static_value(call.args[1]) in _known_django_operations
                and not call.keywords
            ):
                return False
            return True

        for walked_statement in ast.walk(tree):
            if isinstance(walked_statement, ast.Assign):
                targets = walked_statement.targets
            elif isinstance(walked_statement, (ast.AnnAssign, ast.AugAssign)):
                targets = [walked_statement.target]
            else:
                continue
            for target in targets:
                if any(
                    isinstance(candidate, ast.Name)
                    and is_migrations_operation_namespace(candidate, walked_statement.lineno)
                    for candidate in ast.walk(target)
                ):
                    names.update(projections)
        changed = True
        while changed:
            changed = False
            for node in ast.walk(tree):
                if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                    continue
                if isinstance(node, ast.AnnAssign) and node.value is None:
                    continue
                assert node.value is not None
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                alias_value = node.value
                imported_callable_alias = uses_imported_binding(alias_value)
                namespace_mutator_alias = uses_namespace_mutator_binding(alias_value)
                migration_class_alias = uses_migration_class_binding(alias_value, node.lineno)
                safe_migration_base_alias = (
                    isinstance(alias_value, ast.Attribute)
                    and alias_value.attr == "Migration"
                    and is_migrations_operation_namespace(alias_value.value, node.lineno)
                ) or (
                    isinstance(alias_value, ast.Name)
                    and is_safe_migration_base_name(alias_value.id)
                )
                create_alias = (
                    (
                        isinstance(alias_value, ast.Attribute)
                        and alias_value.attr == "CreateModel"
                        and is_migrations_operation_namespace(alias_value.value, node.lineno)
                    )
                    or (
                        isinstance(alias_value, ast.Name) and alias_value.id in create_model_aliases
                    )
                    or (is_selected_operation(alias_value, "CreateModel", node.lineno))
                )
                run_sql_alias = (
                    (
                        isinstance(alias_value, ast.Attribute)
                        and alias_value.attr == "RunSQL"
                        and is_migrations_operation_namespace(alias_value.value, node.lineno)
                    )
                    or (isinstance(alias_value, ast.Name) and alias_value.id in run_sql_aliases)
                    or is_selected_operation(alias_value, "RunSQL", node.lineno)
                )
                run_python_alias = (
                    (
                        isinstance(alias_value, ast.Attribute)
                        and alias_value.attr == "RunPython"
                        and is_migrations_operation_namespace(alias_value.value, node.lineno)
                    )
                    or (isinstance(alias_value, ast.Name) and alias_value.id in run_python_aliases)
                    or (is_selected_operation(alias_value, "RunPython", node.lineno))
                )
                for target in targets:
                    if not isinstance(target, ast.Name):
                        continue
                    if imported_callable_alias and target.id not in imported_callable_names:
                        imported_callable_names.add(target.id)
                        changed = True
                    if namespace_mutator_alias and target.id not in namespace_mutator_aliases:
                        namespace_mutator_aliases.add(target.id)
                        changed = True
                    if migration_class_alias and target.id not in migration_class_aliases:
                        migration_class_aliases.add(target.id)
                        changed = True
                    if safe_migration_base_alias and target.id not in safe_migration_base_aliases:
                        safe_migration_base_aliases.add(target.id)
                        changed = True
                    if safe_migration_base_alias:
                        safe_migration_base_binding_node_ids.add(id(target))
                    if create_alias and target.id not in create_model_aliases:
                        create_model_aliases.add(target.id)
                        changed = True
                    if run_sql_alias and target.id not in run_sql_aliases:
                        run_sql_aliases.add(target.id)
                        changed = True
                    if run_python_alias and target.id not in run_python_aliases:
                        run_python_aliases.add(target.id)
                        changed = True

        for call in (node for node in ast.walk(tree) if isinstance(node, ast.Call)):
            if (
                uses_namespace_mutator_binding(call.func)
                and call.args
                and is_migrations_operation_namespace(call.args[0], call.lineno)
            ):
                names.update(projections)

        def resolved_operation_kind(
            call: ast.Call,
            _known_operations: set[str] = known_django_operations,
            _operation_aliases: dict[str, str] = django_operation_aliases,
            _assignment_nodes: dict[str, list[ast.AST]] = assignment_nodes,
            _import_binding_counts: dict[str, int] = import_binding_counts,
        ) -> str | None:
            if (
                isinstance(call.func, ast.Attribute)
                and call.func.attr in _known_operations
                and is_migrations_operation_namespace(call.func.value, call.lineno)
            ):
                return call.func.attr
            if isinstance(call.func, ast.Name):
                if (
                    call.func.id in _operation_aliases
                    and call.func.id not in _assignment_nodes
                    and _import_binding_counts.get(call.func.id) == 1
                ):
                    return _operation_aliases[call.func.id]
            return None

        def direct_operation_calls(node: ast.AST) -> list[ast.Call]:
            if isinstance(node, ast.Constant) and node.value is None:
                return []
            if isinstance(node, (ast.GeneratorExp, ast.ListComp)):
                return [node.elt] if isinstance(node.elt, ast.Call) else []
            if isinstance(node, ast.Starred):
                return direct_operation_calls(node.value)
            if not isinstance(node, (ast.List, ast.Tuple)):
                return []
            calls = [item for item in node.elts if isinstance(item, ast.Call)]
            for item in node.elts:
                if isinstance(item, ast.Starred):
                    calls.extend(direct_operation_calls(item.value))
            nested = []
            for call in calls:
                if resolved_operation_kind(call) != "SeparateDatabaseAndState":
                    continue
                for argument in call.args[:2]:
                    nested.extend(direct_operation_calls(argument))
                for keyword in call.keywords:
                    if keyword.arg in {"database_operations", "state_operations"}:
                        nested.extend(direct_operation_calls(keyword.value))
            return calls + nested

        def operation_tree_is_inspectable(node: ast.AST, _unresolved: object = unresolved) -> bool:
            if isinstance(node, ast.Constant) and node.value is None:
                return True
            if isinstance(node, (ast.GeneratorExp, ast.ListComp)):
                if len(node.generators) != 1 or not isinstance(node.elt, ast.Call):
                    return False
                generator = node.generators[0]
                return (
                    not generator.ifs
                    and isinstance(generator.target, ast.Name)
                    and static_value(generator.iter) is not _unresolved
                )
            if isinstance(node, ast.Starred):
                return operation_tree_is_inspectable(node.value)
            if not isinstance(node, (ast.List, ast.Tuple)):
                return False
            if not all(isinstance(item, (ast.Call, ast.Starred)) for item in node.elts):
                return False
            if any(
                isinstance(item, ast.Starred) and not operation_tree_is_inspectable(item)
                for item in node.elts
            ):
                return False
            for call in direct_operation_calls(node):
                if resolved_operation_kind(call) != "SeparateDatabaseAndState":
                    continue
                if any(not operation_tree_is_inspectable(argument) for argument in call.args[:2]):
                    return False
                for keyword in call.keywords:
                    if keyword.arg in {"database_operations", "state_operations"} and not (
                        operation_tree_is_inspectable(keyword.value)
                    ):
                        return False
            return True

        unsafe_local_function_aliases = {
            name
            for name, function in functions.items()
            if any(
                isinstance(child, ast.expr) and uses_imported_binding(child)
                for child in ast.walk(function)
            )
        }
        unsafe_local_class_aliases = {
            statement.name
            for statement in tree.body
            if isinstance(statement, ast.ClassDef)
            and any(
                isinstance(child, ast.expr) and uses_imported_binding(child)
                for child in ast.walk(statement)
            )
        }
        unsafe_operation_helper_aliases = {
            name
            for name, function in functions.items()
            if uses_untrusted_imported_binding(
                function,
                _additional_trusted=trusted_operation_value_names,
            )
            or name in trusted_operation_factory_names
            and (
                any(
                    uses_unapproved_operation_import_access(statement)
                    for statement in function.body
                )
                or function_executes_unapproved_authority(function)
            )
        }
        unsafe_operation_class_aliases = {
            statement.name
            for statement in tree.body
            if isinstance(statement, ast.ClassDef)
            and uses_untrusted_imported_binding(
                statement,
                _additional_trusted=trusted_operation_value_names,
            )
        }

        def is_approved_static_operation_value_container(value: ast.AST) -> bool:
            if not isinstance(value, ast.Dict) or len(value.keys) != 1:
                return False
            key_node = value.keys[0]
            if key_node is None:
                return False
            key = static_value(key_node)
            item = value.values[0]
            path = attribute_path(item)
            return (
                key == "deferrable"
                and path is not None
                and "django.db.models.Deferrable.DEFERRED" in canonical_import_paths(path)
            )

        def is_approved_static_container_forwarder(function: ast.FunctionDef) -> bool:
            if function.args.kwarg is None:
                return False
            forwarded_name = function.args.kwarg.arg
            scope_nodes = lexical_scope_nodes(function)
            scope_node_ids = {id(node) for node in scope_nodes}
            locally_bound_names = (
                {
                    child.id
                    for child in scope_nodes
                    if isinstance(child, ast.Name) and isinstance(child.ctx, (ast.Store, ast.Del))
                }
                | {
                    argument.arg
                    for argument in (
                        *function.args.posonlyargs,
                        *function.args.args,
                        *function.args.kwonlyargs,
                    )
                }
                | {
                    child.name
                    for child in scope_nodes
                    if isinstance(child, ast.ExceptHandler) and child.name is not None
                }
                | {
                    child.name
                    for child in scope_nodes
                    if isinstance(child, (ast.MatchAs, ast.MatchStar)) and child.name is not None
                }
                | {
                    child.rest
                    for child in scope_nodes
                    if isinstance(child, ast.MatchMapping) and child.rest is not None
                }
                | {
                    child.name
                    for child in scope_nodes
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                }
                | {
                    imported.asname or imported.name.split(".", maxsplit=1)[0]
                    for child in scope_nodes
                    if isinstance(child, ast.Import)
                    for imported in child.names
                }
                | {
                    imported.asname or imported.name
                    for child in scope_nodes
                    if isinstance(child, ast.ImportFrom)
                    for imported in child.names
                }
            )
            if function.args.vararg is not None:
                locally_bound_names.add(function.args.vararg.arg)
            if function.args.kwarg is not None:
                locally_bound_names.add(function.args.kwarg.arg)
            parents = {
                id(descendant): parent
                for parent in scope_nodes
                for descendant in ast.iter_child_nodes(parent)
                if id(descendant) in scope_node_ids
            }
            loads = [
                child
                for child in scope_nodes
                if isinstance(child, ast.Name)
                and isinstance(child.ctx, ast.Load)
                and child.id == forwarded_name
            ]
            if not loads:
                return False
            for load in loads:
                keyword = parents.get(id(load))
                call = parents.get(id(keyword)) if isinstance(keyword, ast.keyword) else None
                path = attribute_path(call.func) if isinstance(call, ast.Call) else None
                if (
                    not isinstance(keyword, ast.keyword)
                    or keyword.arg is not None
                    or path is None
                    or path[0] in locally_bound_names
                    or "django.db.models.UniqueConstraint" not in canonical_import_paths(path)
                ):
                    return False
            return True

        approved_static_container_forwarders = {
            name
            for name, function in functions.items()
            if is_approved_static_container_forwarder(function)
        }

        def uses_restricted_operation_value_unsafely(
            expression: ast.AST,
            restricted_aliases: set[str],
            restricted_factories: set[str],
            unsafe_restricted_factories: set[str],
            _approved_forwarders: set[str] = approved_static_container_forwarders,
        ) -> bool:
            parents = {
                id(descendant): parent
                for parent in ast.walk(expression)
                for descendant in ast.iter_child_nodes(parent)
            }
            shadowed_forwarders = (
                {
                    child.id
                    for child in ast.walk(expression)
                    if isinstance(child, ast.Name)
                    and isinstance(child.ctx, ast.Store)
                    and child.id in _approved_forwarders
                }
                | {
                    argument.arg
                    for child in ast.walk(expression)
                    if isinstance(child, ast.Lambda)
                    for argument in (
                        *child.args.posonlyargs,
                        *child.args.args,
                        *child.args.kwonlyargs,
                    )
                    if argument.arg in _approved_forwarders
                }
                | {
                    argument.arg
                    for child in ast.walk(expression)
                    if isinstance(child, ast.Lambda)
                    for argument in (child.args.vararg, child.args.kwarg)
                    if argument is not None and argument.arg in _approved_forwarders
                }
            )

            def has_safe_consumer(value_node: ast.AST) -> bool:
                keyword = parents.get(id(value_node))
                call = parents.get(id(keyword)) if isinstance(keyword, ast.keyword) else None
                return bool(
                    isinstance(keyword, ast.keyword)
                    and keyword.arg is None
                    and isinstance(call, ast.Call)
                    and isinstance(call.func, ast.Name)
                    and call.func.id not in shadowed_forwarders
                    and call.func.id in _approved_forwarders
                )

            for child in ast.walk(expression):
                if (
                    not isinstance(child, ast.Name)
                    or not isinstance(child.ctx, ast.Load)
                    or child.id not in restricted_aliases
                ):
                    continue
                if not has_safe_consumer(child):
                    return True
            for child in ast.walk(expression):
                if (
                    isinstance(child, ast.Call)
                    and isinstance(child.func, ast.Name)
                    and child.func.id in restricted_factories
                    and (
                        child.func.id in unsafe_restricted_factories or not has_safe_consumer(child)
                    )
                ):
                    return True
            return False

        def restricted_factory_has_only_direct_return_access(
            function: ast.FunctionDef,
            restricted_aliases: set[str],
            restricted_factories: set[str],
        ) -> bool:
            scope_nodes = lexical_scope_nodes(function)
            scope_node_ids = {id(node) for node in scope_nodes}
            direct_nested_functions = {
                child.name: child
                for child in scope_nodes
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
            }
            nested_restricted_providers = {
                name
                for name, nested_function in direct_nested_functions.items()
                if any(
                    isinstance(descendant, ast.Name)
                    and isinstance(descendant.ctx, ast.Load)
                    and descendant.id in restricted_aliases | restricted_factories
                    for descendant in lexical_scope_nodes(nested_function)
                )
            }
            changed_nested_providers = True
            while changed_nested_providers:
                changed_nested_providers = False
                for name, nested_function in direct_nested_functions.items():
                    if name in nested_restricted_providers:
                        continue
                    if any(
                        isinstance(descendant, ast.Call)
                        and any(
                            isinstance(callee_name, ast.Name)
                            and isinstance(callee_name.ctx, ast.Load)
                            and callee_name.id in nested_restricted_providers
                            for callee_name in ast.walk(descendant.func)
                        )
                        for descendant in lexical_scope_nodes(nested_function)
                    ):
                        nested_restricted_providers.add(name)
                        changed_nested_providers = True
            restricted_classes = {
                class_node.name: class_node
                for class_node in scope_nodes
                if isinstance(class_node, ast.ClassDef)
            }
            restricted_class_methods = {
                class_name: {
                    method.name
                    for method in class_node.body
                    if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and any(
                        isinstance(descendant, ast.Name)
                        and isinstance(descendant.ctx, ast.Load)
                        and descendant.id in restricted_aliases | restricted_factories
                        for descendant in lexical_scope_nodes(method)
                    )
                }
                for class_name, class_node in restricted_classes.items()
            }
            changed_restricted_inheritance = True
            while changed_restricted_inheritance:
                changed_restricted_inheritance = False
                for class_name, class_node in restricted_classes.items():
                    inherited_methods = {
                        method_name
                        for base in class_node.bases
                        if (base_path := attribute_path(base)) is not None and len(base_path) == 1
                        for method_name in restricted_class_methods.get(base_path[0], set())
                    }
                    if not inherited_methods.issubset(restricted_class_methods[class_name]):
                        restricted_class_methods[class_name].update(inherited_methods)
                        changed_restricted_inheritance = True
            restricted_class_methods = {
                name: methods for name, methods in restricted_class_methods.items() if methods
            }
            restricted_class_origins = {name: name for name in restricted_class_methods}
            restricted_instance_origins: dict[str, str] = {}
            restricted_method_aliases: set[str] = set()
            changed_restricted_classes = True
            while changed_restricted_classes:
                changed_restricted_classes = False
                for child in scope_nodes:
                    for target, value in (
                        [(target, child.value) for target in child.targets]
                        if isinstance(child, ast.Assign)
                        else [(child.target, child.value)]
                        if isinstance(child, (ast.AnnAssign, ast.NamedExpr))
                        and child.value is not None
                        else []
                    ):
                        value_path = attribute_path(value)
                        contained_class_origins = {
                            restricted_class_origins[descendant.id]
                            for descendant in ast.walk(value)
                            if isinstance(descendant, ast.Name)
                            and isinstance(descendant.ctx, ast.Load)
                            and descendant.id in restricted_class_origins
                        }
                        if len(contained_class_origins) > 1:
                            return False
                        class_origin = (
                            restricted_class_origins.get(value_path[0])
                            if value_path is not None and len(value_path) == 1
                            else None
                        )
                        if class_origin is None and contained_class_origins:
                            class_origin = next(iter(contained_class_origins))
                        contained_instance_origins = {
                            origin
                            for descendant in ast.walk(value)
                            if isinstance(descendant, ast.Call)
                            and (value_call_path := attribute_path(descendant.func)) is not None
                            and len(value_call_path) == 1
                            and (origin := restricted_class_origins.get(value_call_path[0]))
                            is not None
                        }
                        contained_instance_origins.update(
                            restricted_instance_origins[descendant.id]
                            for descendant in ast.walk(value)
                            if isinstance(descendant, ast.Name)
                            and isinstance(descendant.ctx, ast.Load)
                            and descendant.id in restricted_instance_origins
                        )
                        if len(contained_instance_origins) > 1:
                            return False
                        instance_origin = (
                            next(iter(contained_instance_origins))
                            if contained_instance_origins
                            else None
                        )
                        method_origin = None
                        if value_path is not None and len(value_path) == 2:
                            candidate_origin = restricted_class_origins.get(
                                value_path[0]
                            ) or restricted_instance_origins.get(value_path[0])
                            if candidate_origin is not None and value_path[
                                1
                            ] in restricted_class_methods.get(candidate_origin, set()):
                                method_origin = candidate_origin
                        if method_origin is None:
                            method_origin = next(
                                (
                                    candidate_origin
                                    for descendant in ast.walk(value)
                                    if isinstance(descendant, ast.Attribute)
                                    and (receiver_path := attribute_path(descendant.value))
                                    is not None
                                    and len(receiver_path) == 1
                                    and (
                                        candidate_origin := restricted_class_origins.get(
                                            receiver_path[0]
                                        )
                                        or restricted_instance_origins.get(receiver_path[0])
                                    )
                                    is not None
                                    and descendant.attr
                                    in restricted_class_methods.get(candidate_origin, set())
                                ),
                                None,
                            )
                        for target_name in bound_names(target):
                            if (
                                class_origin is not None
                                and restricted_class_origins.get(target_name) != class_origin
                            ):
                                restricted_class_origins[target_name] = class_origin
                                changed_restricted_classes = True
                            if (
                                instance_origin is not None
                                and restricted_instance_origins.get(target_name) != instance_origin
                            ):
                                restricted_instance_origins[target_name] = instance_origin
                                changed_restricted_classes = True
                            if (
                                method_origin is not None
                                and target_name not in restricted_method_aliases
                            ):
                                restricted_method_aliases.add(target_name)
                                changed_restricted_classes = True
            nested_restricted_aliases = set(nested_restricted_providers)
            changed_nested_aliases = True
            while changed_nested_aliases:
                changed_nested_aliases = False
                for child in scope_nodes:
                    for target, value in (
                        [(target, child.value) for target in child.targets]
                        if isinstance(child, ast.Assign)
                        else [(child.target, child.value)]
                        if isinstance(child, (ast.AnnAssign, ast.NamedExpr))
                        and child.value is not None
                        else []
                    ):
                        if not binding_in_expression(value, nested_restricted_aliases):
                            continue
                        for name in bound_names(target):
                            if name not in nested_restricted_aliases:
                                nested_restricted_aliases.add(name)
                                changed_nested_aliases = True
            if any(
                isinstance(child, ast.Call)
                and any(
                    isinstance(callee_name, ast.Name)
                    and isinstance(callee_name.ctx, ast.Load)
                    and callee_name.id in nested_restricted_aliases
                    for callee_name in ast.walk(child.func)
                )
                for child in scope_nodes
            ):
                return False
            for child in scope_nodes:
                if not isinstance(child, ast.Call):
                    continue
                if any(
                    isinstance(descendant, ast.Name)
                    and isinstance(descendant.ctx, ast.Load)
                    and descendant.id in restricted_method_aliases
                    for descendant in ast.walk(child.func)
                ):
                    return False
                if any(
                    isinstance(descendant, ast.Name)
                    and isinstance(descendant.ctx, ast.Load)
                    and descendant.id
                    in set(restricted_class_origins) | set(restricted_instance_origins)
                    for argument in (
                        *child.args,
                        *(keyword.value for keyword in child.keywords),
                    )
                    for descendant in ast.walk(argument)
                ):
                    return False
                if not isinstance(child.func, ast.Attribute):
                    continue
                receiver = child.func.value
                receiver_origin = None
                if isinstance(receiver, ast.Name):
                    receiver_origin = restricted_class_origins.get(
                        receiver.id
                    ) or restricted_instance_origins.get(receiver.id)
                elif isinstance(receiver, ast.Call):
                    receiver_path = attribute_path(receiver.func)
                    if receiver_path is not None and len(receiver_path) == 1:
                        receiver_origin = restricted_class_origins.get(receiver_path[0])
                if receiver_origin is None:
                    receiver_origin = next(
                        (
                            candidate_origin
                            for descendant in ast.walk(receiver)
                            if isinstance(descendant, ast.Name)
                            and isinstance(descendant.ctx, ast.Load)
                            and (
                                candidate_origin := restricted_class_origins.get(descendant.id)
                                or restricted_instance_origins.get(descendant.id)
                            )
                            is not None
                        ),
                        None,
                    )
                if receiver_origin is not None and child.func.attr in restricted_class_methods.get(
                    receiver_origin, set()
                ):
                    return False
            parents = {
                id(descendant): parent
                for parent in scope_nodes
                for descendant in ast.iter_child_nodes(parent)
                if id(descendant) in scope_node_ids
            }
            found = False
            for child in scope_nodes:
                if (
                    isinstance(child, ast.Name)
                    and isinstance(child.ctx, ast.Load)
                    and child.id in restricted_aliases
                ):
                    found = True
                    parent = parents.get(id(child))
                    if not isinstance(parent, ast.Return) or parent.value is not child:
                        return False
                if (
                    isinstance(child, ast.Call)
                    and isinstance(child.func, ast.Name)
                    and child.func.id in restricted_factories
                ):
                    found = True
                    parent = parents.get(id(child))
                    if not isinstance(parent, ast.Return) or parent.value is not child:
                        return False
            return found

        unsafe_operation_value_aliases: set[str] = set()
        restricted_operation_value_aliases: set[str] = set()
        restricted_operation_factory_names: set[str] = set()
        unsafe_restricted_operation_factory_names: set[str] = set()
        changed_unsafe_aliases = True
        while changed_unsafe_aliases:
            changed_unsafe_aliases = False
            for name, function in functions.items():
                if name in unsafe_operation_helper_aliases:
                    continue
                if any(
                    isinstance(descendant, ast.Name)
                    and isinstance(descendant.ctx, ast.Load)
                    and descendant.id
                    in unsafe_operation_helper_aliases | unsafe_operation_class_aliases
                    for descendant in ast.walk(function)
                ):
                    unsafe_operation_helper_aliases.add(name)
                    changed_unsafe_aliases = True
                if name not in restricted_operation_factory_names and any(
                    isinstance(descendant, ast.Name)
                    and isinstance(descendant.ctx, ast.Load)
                    and descendant.id
                    in restricted_operation_value_aliases | restricted_operation_factory_names
                    for descendant in ast.walk(function)
                ):
                    restricted_operation_factory_names.add(name)
                    changed_unsafe_aliases = True
                if (
                    name in restricted_operation_factory_names
                    and name not in unsafe_restricted_operation_factory_names
                    and not restricted_factory_has_only_direct_return_access(
                        function,
                        restricted_operation_value_aliases,
                        restricted_operation_factory_names,
                    )
                ):
                    unsafe_restricted_operation_factory_names.add(name)
                    changed_unsafe_aliases = True
            for child in lexical_scope_nodes(tree):
                if (
                    isinstance(child, ast.Call)
                    and (
                        isinstance(child.func, ast.Attribute)
                        and child.func.attr
                        in {
                            "__setitem__",
                            "add",
                            "append",
                            "extend",
                            "insert",
                            "setdefault",
                            "update",
                        }
                        or isinstance(child.func, ast.Name)
                        and child.func.id == "setattr"
                    )
                    and any(
                        binding_in_expression(value, unsafe_operation_value_aliases)
                        or binding_in_expression(value, restricted_operation_value_aliases)
                        for value in (
                            *child.args,
                            *(keyword.value for keyword in child.keywords),
                        )
                    )
                ):
                    names.update(projections)
                nonassignment_bindings: list[tuple[ast.AST, ast.AST]] = []
                if isinstance(child, (ast.For, ast.AsyncFor)):
                    nonassignment_bindings.append((child.target, child.iter))
                elif isinstance(child, (ast.With, ast.AsyncWith)):
                    nonassignment_bindings.extend(
                        (item.optional_vars, item.context_expr)
                        for item in child.items
                        if item.optional_vars is not None
                    )
                elif isinstance(child, ast.Match):
                    nonassignment_bindings.extend(
                        (case.pattern, child.subject) for case in child.cases
                    )
                for binding_target, nonassignment_value in nonassignment_bindings:
                    target_names = bound_names(binding_target)
                    target_names.update(
                        descendant.name
                        for descendant in ast.walk(binding_target)
                        if isinstance(descendant, (ast.MatchAs, ast.MatchStar))
                        and descendant.name is not None
                    )
                    target_names.update(
                        descendant.rest
                        for descendant in ast.walk(binding_target)
                        if isinstance(descendant, ast.MatchMapping) and descendant.rest is not None
                    )
                    unsafe_bound_value = binding_in_expression(
                        nonassignment_value, unsafe_operation_value_aliases
                    )
                    restricted_bound_value = binding_in_expression(
                        nonassignment_value,
                        restricted_operation_value_aliases | restricted_operation_factory_names,
                    )
                    for target_name in target_names:
                        if unsafe_bound_value and target_name not in unsafe_operation_value_aliases:
                            unsafe_operation_value_aliases.add(target_name)
                            changed_unsafe_aliases = True
                        if (
                            restricted_bound_value
                            and target_name not in restricted_operation_value_aliases
                        ):
                            restricted_operation_value_aliases.add(target_name)
                            changed_unsafe_aliases = True
                if not isinstance(child, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
                    continue
                if isinstance(child, ast.AnnAssign) and child.value is None:
                    continue
                assert child.value is not None
                targets = child.targets if isinstance(child, ast.Assign) else [child.target]
                child_value = child.value
                unsafe_function = binding_in_expression(child_value, unsafe_local_function_aliases)
                unsafe_class = binding_in_expression(child_value, unsafe_local_class_aliases)
                unsafe_operation_value = (
                    uses_unapproved_operation_import_access(child_value)
                    and not is_approved_static_operation_value_container(child_value)
                    or binding_in_expression(child_value, unsafe_operation_value_aliases)
                    or (
                        isinstance(child_value, (ast.Name, ast.Attribute))
                        and any(
                            isinstance(descendant, ast.Name)
                            and isinstance(descendant.ctx, ast.Load)
                            and descendant.id in trusted_operation_value_names
                            for descendant in ast.walk(child_value)
                        )
                    )
                )
                restricted_operation_value = is_approved_static_operation_value_container(
                    child_value
                ) or binding_in_expression(child_value, restricted_operation_value_aliases)
                for target in targets:
                    if any(
                        isinstance(descendant, (ast.Attribute, ast.Subscript))
                        for descendant in ast.walk(target)
                    ) and (unsafe_operation_value or restricted_operation_value):
                        names.update(projections)
                    for target_name in bound_names(target):
                        if unsafe_function and target_name not in unsafe_local_function_aliases:
                            unsafe_local_function_aliases.add(target_name)
                            changed_unsafe_aliases = True
                        if unsafe_class and target_name not in unsafe_local_class_aliases:
                            unsafe_local_class_aliases.add(target_name)
                            changed_unsafe_aliases = True
                        if (
                            binding_in_expression(child_value, unsafe_operation_helper_aliases)
                            and target_name not in unsafe_operation_helper_aliases
                        ):
                            unsafe_operation_helper_aliases.add(target_name)
                            changed_unsafe_aliases = True
                        if (
                            binding_in_expression(child_value, unsafe_operation_class_aliases)
                            and target_name not in unsafe_operation_class_aliases
                        ):
                            unsafe_operation_class_aliases.add(target_name)
                            changed_unsafe_aliases = True
                        if (
                            unsafe_operation_value
                            and target_name not in unsafe_operation_value_aliases
                        ):
                            unsafe_operation_value_aliases.add(target_name)
                            changed_unsafe_aliases = True
                        if (
                            restricted_operation_value
                            and target_name not in restricted_operation_value_aliases
                        ):
                            restricted_operation_value_aliases.add(target_name)
                            changed_unsafe_aliases = True
                        if (
                            binding_in_expression(child_value, restricted_operation_factory_names)
                            and target_name not in restricted_operation_factory_names
                        ):
                            restricted_operation_factory_names.add(target_name)
                            changed_unsafe_aliases = True
                        if (
                            binding_in_expression(
                                child_value, unsafe_restricted_operation_factory_names
                            )
                            and target_name not in unsafe_restricted_operation_factory_names
                        ):
                            unsafe_restricted_operation_factory_names.add(target_name)
                            changed_unsafe_aliases = True

        for class_node in (child for child in tree.body if isinstance(child, ast.ClassDef)):
            if class_node.name != "Migration":
                continue
            direct_operation_assignments = [
                statement
                for statement in class_node.body
                if isinstance(statement, (ast.Assign, ast.AnnAssign))
                and any(
                    isinstance(target, ast.Name) and target.id == "operations"
                    for target in (
                        statement.targets
                        if isinstance(statement, ast.Assign)
                        else [statement.target]
                    )
                )
            ]
            if len(direct_operation_assignments) != 1:
                names.update(projections)
                continue
            direct_assignment = direct_operation_assignments[0]
            direct_assignment_node_ids = {id(node) for node in ast.walk(direct_assignment)}
            for child in ast.walk(class_node):
                if id(child) in direct_assignment_node_ids:
                    continue
                if (
                    isinstance(child, ast.Name)
                    and child.id == "operations"
                    and not isinstance(child.ctx, ast.Del)
                ):
                    names.update(projections)
                if isinstance(child, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                    targets = child.targets if isinstance(child, ast.Assign) else [child.target]
                    if any(
                        isinstance(target, ast.Name) and target.id == "operations"
                        for target in targets
                    ):
                        names.update(projections)
                    if any(
                        isinstance(target, ast.Name)
                        and target.id
                        in migration_module_aliases | migration_operation_namespace_aliases
                        for target in targets
                    ):
                        names.update(projections)
                if (
                    isinstance(child, ast.Call)
                    and isinstance(child.func, ast.Attribute)
                    and child.func.attr in {"append", "extend", "insert"}
                    and isinstance(child.func.value, ast.Name)
                    and child.func.value.id == "operations"
                ):
                    names.update(projections)
            for statement in class_node.body:
                if not isinstance(statement, (ast.Assign, ast.AnnAssign)):
                    continue
                targets = (
                    statement.targets if isinstance(statement, ast.Assign) else [statement.target]
                )
                if not any(
                    isinstance(target, ast.Name) and target.id == "operations" for target in targets
                ):
                    continue
                if isinstance(statement, ast.AnnAssign) and statement.value is None:
                    names.update(projections)
                    continue
                assert statement.value is not None
                operation_value = statement.value
                if not operation_tree_is_inspectable(operation_value):
                    names.update(projections)
                    continue
                for operation_call in direct_operation_calls(operation_value):
                    operation_kind = resolved_operation_kind(operation_call)
                    if operation_kind not in known_django_operations:
                        names.update(projections)
                        continue
                    if any(
                        uses_untrusted_imported_binding(
                            expression,
                            _additional_trusted=trusted_operation_value_names,
                        )
                        or uses_unapproved_operation_import_access(expression)
                        or binding_in_expression(expression, unsafe_operation_value_aliases)
                        or uses_restricted_operation_value_unsafely(
                            expression,
                            restricted_operation_value_aliases,
                            restricted_operation_factory_names,
                            unsafe_restricted_operation_factory_names,
                        )
                        for expression in (
                            *operation_call.args,
                            *(keyword.value for keyword in operation_call.keywords),
                        )
                    ):
                        names.update(projections)
                        continue
                    if any(
                        isinstance(child, ast.Call)
                        and (
                            binding_in_expression(child, unsafe_operation_helper_aliases)
                            or binding_in_expression(child, unsafe_operation_class_aliases)
                        )
                        for expression in (
                            *operation_call.args,
                            *(keyword.value for keyword in operation_call.keywords),
                        )
                        for child in ast.walk(expression)
                    ):
                        names.update(projections)
        static_operations_assignment_ids = {
            id(descendant)
            for statement in ast.walk(tree)
            if isinstance(statement, (ast.Assign, ast.AnnAssign))
            and any(
                isinstance(target, ast.Name) and target.id == "operations"
                for target in (
                    statement.targets if isinstance(statement, ast.Assign) else [statement.target]
                )
            )
            for descendant in ast.walk(statement)
        }
        for child in ast.walk(tree):
            if id(child) in static_operations_assignment_ids:
                continue
            if (
                isinstance(child, ast.Name)
                and child.id == "operations"
                or isinstance(child, ast.Attribute)
                and child.attr == "operations"
                or isinstance(child, ast.Constant)
                and child.value == "operations"
            ):
                names.update(projections)
            if isinstance(child, ast.Subscript):
                selector = static_value(child.slice)
                reads_namespace_mapping = (
                    isinstance(child.value, ast.Call)
                    and isinstance(child.value.func, ast.Name)
                    and child.value.func.id == "vars"
                ) or (isinstance(child.value, ast.Attribute) and child.value.attr == "__dict__")
                if selector == "operations" or reads_namespace_mapping:
                    names.update(projections)

        def class_body_executes_untrusted(
            class_node: ast.ClassDef,
            _unsafe_local_function_aliases: set[str] = unsafe_local_function_aliases,
            _unsafe_local_class_aliases: set[str] = unsafe_local_class_aliases,
        ) -> bool:
            unsafe_class_local_functions = {
                statement.name
                for statement in class_node.body
                if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef))
                and any(
                    isinstance(child, ast.expr) and uses_imported_binding(child)
                    for child in ast.walk(statement)
                )
            }
            unsafe_class_local_classes = {
                statement.name
                for statement in class_node.body
                if isinstance(statement, ast.ClassDef)
                and any(
                    isinstance(child, ast.expr) and uses_imported_binding(child)
                    for child in ast.walk(statement)
                )
            }

            def class_scope_binding_pairs(
                binding_node: ast.AST,
            ) -> list[tuple[ast.AST, ast.AST]]:
                if isinstance(
                    binding_node,
                    (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda),
                ):
                    return []
                pairs: list[tuple[ast.AST, ast.AST]] = []
                if isinstance(binding_node, ast.Assign):
                    pairs.extend((target, binding_node.value) for target in binding_node.targets)
                elif isinstance(binding_node, ast.AnnAssign) and binding_node.value is not None:
                    pairs.append((binding_node.target, binding_node.value))
                elif isinstance(binding_node, (ast.For, ast.AsyncFor)):
                    pairs.append((binding_node.target, binding_node.iter))
                elif isinstance(binding_node, ast.comprehension):
                    pairs.append((binding_node.target, binding_node.iter))
                elif isinstance(binding_node, (ast.With, ast.AsyncWith)):
                    pairs.extend(
                        (item.optional_vars, item.context_expr)
                        for item in binding_node.items
                        if item.optional_vars is not None
                    )
                elif isinstance(binding_node, ast.NamedExpr):
                    pairs.append((binding_node.target, binding_node.value))
                elif isinstance(binding_node, ast.Match):

                    def pattern_names(pattern: ast.pattern) -> set[str]:
                        names = {
                            child.name
                            for child in ast.walk(pattern)
                            if isinstance(child, (ast.MatchAs, ast.MatchStar))
                            and child.name is not None
                        }
                        names.update(
                            child.rest
                            for child in ast.walk(pattern)
                            if isinstance(child, ast.MatchMapping) and child.rest is not None
                        )
                        return names

                    for case in binding_node.cases:
                        pairs.extend(
                            (ast.Name(id=name, ctx=ast.Store()), binding_node.subject)
                            for name in pattern_names(case.pattern)
                        )
                for descendant in ast.iter_child_nodes(binding_node):
                    pairs.extend(class_scope_binding_pairs(descendant))
                return pairs

            changed_local_aliases = True
            while changed_local_aliases:
                changed_local_aliases = False
                for statement in class_node.body:
                    if not isinstance(statement, ast.ClassDef):
                        continue
                    if statement.name in unsafe_class_local_classes:
                        continue
                    definition_edges = [
                        *statement.decorator_list,
                        *statement.bases,
                        *(keyword.value for keyword in statement.keywords),
                    ]
                    if any(
                        binding_in_expression(edge, unsafe_class_local_classes)
                        or binding_in_expression(edge, unsafe_class_local_functions)
                        for edge in definition_edges
                    ):
                        unsafe_class_local_classes.add(statement.name)
                        changed_local_aliases = True
                for statement in class_node.body:
                    if not isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        continue
                    if statement.name in unsafe_class_local_functions:
                        continue
                    if any(
                        isinstance(descendant, ast.Name)
                        and isinstance(descendant.ctx, ast.Load)
                        and descendant.id
                        in unsafe_class_local_functions | unsafe_class_local_classes
                        for descendant in ast.walk(statement)
                    ):
                        unsafe_class_local_functions.add(statement.name)
                        changed_local_aliases = True
                for statement in class_node.body:
                    for target, value in class_scope_binding_pairs(statement):
                        unsafe_function_value = binding_in_expression(
                            value, unsafe_class_local_functions
                        )
                        unsafe_class_value = binding_in_expression(
                            value, unsafe_class_local_classes
                        )
                        if isinstance(target, (ast.Attribute, ast.Subscript)) and (
                            unsafe_function_value or unsafe_class_value
                        ):
                            return True
                        for target_name in bound_names(target):
                            if (
                                unsafe_function_value
                                and target_name not in unsafe_class_local_functions
                            ):
                                unsafe_class_local_functions.add(target_name)
                                changed_local_aliases = True
                            if unsafe_class_value and target_name not in unsafe_class_local_classes:
                                unsafe_class_local_classes.add(target_name)
                                changed_local_aliases = True
            for body_statement in class_node.body:
                if isinstance(body_statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    annotations = [
                        argument.annotation
                        for argument in (
                            *body_statement.args.posonlyargs,
                            *body_statement.args.args,
                            *body_statement.args.kwonlyargs,
                        )
                        if argument.annotation is not None
                    ]
                    if (
                        body_statement.args.vararg
                        and body_statement.args.vararg.annotation is not None
                    ):
                        annotations.append(body_statement.args.vararg.annotation)
                    if (
                        body_statement.args.kwarg
                        and body_statement.args.kwarg.annotation is not None
                    ):
                        annotations.append(body_statement.args.kwarg.annotation)
                    if body_statement.returns is not None:
                        annotations.append(body_statement.returns)
                    evaluated = [
                        *body_statement.args.defaults,
                        *(value for value in body_statement.args.kw_defaults if value is not None),
                        *annotations,
                    ]
                    if (
                        any(
                            uses_untrusted_imported_binding(decorator)
                            for decorator in body_statement.decorator_list
                        )
                        or any(
                            isinstance(child, (ast.Attribute, ast.Subscript))
                            and uses_untrusted_imported_binding(child)
                            for expression in evaluated
                            for child in ast.walk(expression)
                        )
                        or any(executes_imported_protocol(expression) for expression in evaluated)
                        or any(
                            isinstance(child, ast.Call)
                            and (
                                uses_untrusted_imported_binding(child.func)
                                or passes_migration_authority(child)
                                or binding_in_expression(child.func, _unsafe_local_function_aliases)
                                or binding_in_expression(child.func, _unsafe_local_class_aliases)
                                or binding_in_expression(child, unsafe_class_local_functions)
                                or binding_in_expression(child, unsafe_class_local_classes)
                            )
                            for expression in evaluated
                            for child in ast.walk(expression)
                        )
                    ):
                        return True
                    continue
                if isinstance(body_statement, ast.ClassDef):
                    class_definition_expressions = [
                        *body_statement.decorator_list,
                        *body_statement.bases,
                        *(keyword.value for keyword in body_statement.keywords),
                    ]
                    if any(
                        uses_untrusted_imported_binding(expression)
                        or binding_in_expression(expression, unsafe_class_local_functions)
                        or binding_in_expression(expression, unsafe_class_local_classes)
                        for expression in class_definition_expressions
                    ) or class_body_executes_untrusted(body_statement):
                        return True
                    continue
                if class_node.name == "Migration" and isinstance(
                    body_statement, (ast.Assign, ast.AnnAssign)
                ):
                    targets = (
                        body_statement.targets
                        if isinstance(body_statement, ast.Assign)
                        else [body_statement.target]
                    )
                    if any(
                        isinstance(target, ast.Name) and target.id == "operations"
                        for target in targets
                    ):
                        continue
                if uses_untrusted_imported_binding(body_statement):
                    return True
                if any(
                    isinstance(child, ast.Call)
                    and (
                        binding_in_expression(child, unsafe_class_local_functions)
                        or binding_in_expression(child, unsafe_class_local_classes)
                    )
                    for child in ast.walk(body_statement)
                ):
                    return True
            return False

        for statement in tree.body:
            if id(statement) in static_operations_assignment_ids:
                if (
                    isinstance(statement, ast.AnnAssign)
                    and statement.value is None
                    and (
                        uses_untrusted_imported_binding(statement.annotation)
                        or executes_imported_protocol(statement.annotation)
                        or any(
                            isinstance(child, ast.Call)
                            and (
                                uses_untrusted_imported_binding(child.func)
                                or passes_migration_authority(child)
                                or binding_in_expression(child.func, unsafe_local_function_aliases)
                                or binding_in_expression(child.func, unsafe_local_class_aliases)
                            )
                            for child in ast.walk(statement.annotation)
                        )
                    )
                ):
                    names.update(projections)
                continue
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                annotations = [
                    argument.annotation
                    for argument in (
                        *statement.args.posonlyargs,
                        *statement.args.args,
                        *statement.args.kwonlyargs,
                    )
                    if argument.annotation is not None
                ]
                if statement.args.vararg and statement.args.vararg.annotation is not None:
                    annotations.append(statement.args.vararg.annotation)
                if statement.args.kwarg and statement.args.kwarg.annotation is not None:
                    annotations.append(statement.args.kwarg.annotation)
                if statement.returns is not None:
                    annotations.append(statement.returns)
                evaluated_expressions = [
                    *statement.args.defaults,
                    *(value for value in statement.args.kw_defaults if value is not None),
                    *annotations,
                ]
                if (
                    any(
                        uses_untrusted_imported_binding(decorator)
                        for decorator in statement.decorator_list
                    )
                    or any(
                        isinstance(child, (ast.Attribute, ast.Subscript))
                        and uses_untrusted_imported_binding(child)
                        for expression in evaluated_expressions
                        for child in ast.walk(expression)
                    )
                    or any(
                        isinstance(child, ast.Call)
                        and (
                            uses_untrusted_imported_binding(child.func)
                            or passes_migration_authority(child)
                            or binding_in_expression(child.func, unsafe_local_function_aliases)
                            or binding_in_expression(child.func, unsafe_local_class_aliases)
                        )
                        for expression in evaluated_expressions
                        for child in ast.walk(expression)
                    )
                    or any(
                        executes_imported_protocol(expression)
                        for expression in evaluated_expressions
                    )
                ):
                    names.update(projections)
                continue
            if isinstance(statement, ast.ClassDef):
                if (
                    any(
                        uses_untrusted_imported_binding(decorator)
                        for decorator in statement.decorator_list
                    )
                    or any(
                        uses_untrusted_imported_binding(keyword.value)
                        for keyword in statement.keywords
                    )
                    or any(
                        uses_untrusted_imported_binding(base)
                        and not (
                            isinstance(base, ast.Attribute)
                            and base.attr == "Migration"
                            and is_migrations_operation_namespace(base.value, statement.lineno)
                            or isinstance(base, ast.Name)
                            and is_safe_migration_base_name(base.id)
                        )
                        for base in statement.bases
                    )
                    or any(
                        isinstance(child, ast.Call) and uses_untrusted_imported_binding(child.func)
                        for expression in statement.bases
                        for child in ast.walk(expression)
                    )
                    or class_body_executes_untrusted(statement)
                ):
                    names.update(projections)
                continue
            if (
                uses_untrusted_imported_binding(statement)
                or executes_imported_protocol(statement)
                or any(
                    isinstance(child, ast.Call)
                    and (
                        uses_untrusted_imported_binding(child.func)
                        or passes_migration_authority(child)
                        or binding_in_expression(child.func, unsafe_local_function_aliases)
                        or binding_in_expression(child.func, unsafe_local_class_aliases)
                    )
                    for child in ast.walk(statement)
                )
            ):
                names.update(projections)

        changed_migration_aliases = True
        while changed_migration_aliases:
            changed_migration_aliases = False
            for child in ast.walk(tree):
                if not isinstance(child, (ast.Assign, ast.AnnAssign)):
                    continue
                if isinstance(child, ast.AnnAssign) and child.value is None:
                    continue
                assert child.value is not None
                targets = child.targets if isinstance(child, ast.Assign) else [child.target]
                if not uses_migration_class_binding(child.value, child.lineno):
                    continue
                for target in targets:
                    if isinstance(target, ast.Name) and target.id not in migration_class_aliases:
                        migration_class_aliases.add(target.id)
                        changed_migration_aliases = True
        safe_migration_base_node_ids = {
            id(base)
            for class_node in ast.walk(tree)
            if isinstance(class_node, ast.ClassDef)
            for base in class_node.bases
            if (
                isinstance(base, ast.Attribute)
                and base.attr == "Migration"
                and is_migrations_operation_namespace(base.value, class_node.lineno)
                or isinstance(base, ast.Name)
                and is_safe_migration_base_name(base.id)
            )
        }
        for child in ast.walk(tree):
            if (
                isinstance(child, ast.Subscript)
                and migration_class_lines
                and child.lineno > min(migration_class_lines)
                and static_value(child.slice) == "Migration"
                and isinstance(child.value, ast.Call)
                and isinstance(child.value.func, ast.Name)
                and child.value.func.id in {"globals", "vars"}
                and not child.value.args
                and not child.value.keywords
            ):
                names.update(projections)
            if (
                isinstance(child, ast.Name)
                and child.id in migration_class_aliases
                and id(child) not in safe_migration_base_node_ids
                and id(child) not in safe_migration_base_binding_node_ids
            ):
                names.update(projections)
            if (
                isinstance(child, ast.Attribute)
                and isinstance(child.value, ast.Name)
                and child.value.id in migration_class_aliases
                and child.attr == "operations"
            ):
                names.update(projections)
            if (
                isinstance(child, ast.Call)
                and isinstance(child.func, ast.Name)
                and child.func.id in {"getattr", "setattr", "delattr"}
                and child.args
                and isinstance(child.args[0], ast.Name)
                and child.args[0].id in migration_class_aliases
            ):
                names.update(projections)
        for class_node in (child for child in ast.walk(tree) if isinstance(child, ast.ClassDef)):
            is_custom_operation = any(
                (isinstance(base, ast.Name) and base.id == "Operation")
                or (isinstance(base, ast.Attribute) and base.attr == "Operation")
                for base in class_node.bases
            )
            if is_custom_operation and any(
                isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                and child.name == "database_forwards"
                for child in class_node.body
            ):
                names.update(projections)
        class_local_names_by_call: dict[int, frozenset[str]] = {}
        for class_node in (child for child in tree.body if isinstance(child, ast.ClassDef)):
            class_local_names: set[str] = set()
            for child in ast.walk(class_node):
                if isinstance(child, ast.Assign):
                    targets = child.targets
                elif isinstance(child, ast.AnnAssign):
                    targets = [child.target]
                elif isinstance(child, ast.AugAssign):
                    targets = [child.target]
                else:
                    continue
                class_local_names.update(name for target in targets for name in bound_names(target))
            frozen_class_names = frozenset(class_local_names)
            for child in ast.walk(class_node):
                if isinstance(child, ast.Call):
                    class_local_names_by_call[id(child)] = frozen_class_names
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            is_create_model = (
                (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "CreateModel"
                    and is_migrations_operation_namespace(node.func.value, node.lineno)
                )
                or (isinstance(node.func, ast.Name) and node.func.id in create_model_aliases)
                or (is_selected_operation(node.func, "CreateModel", node.lineno))
            )
            if is_create_model:
                if any(keyword.arg is None for keyword in node.keywords):
                    names.update(projections)
                name_node = next(
                    (keyword.value for keyword in node.keywords if keyword.arg == "name"),
                    node.args[0] if node.args else None,
                )
                if not (isinstance(name_node, ast.Constant) and isinstance(name_node.value, str)):
                    names.update(projections)
                else:
                    names.add(name_node.value)
                options_node = next(
                    (keyword.value for keyword in node.keywords if keyword.arg == "options"),
                    node.args[2] if len(node.args) >= 3 else None,
                )
                if options_node is not None and not isinstance(options_node, ast.Dict):
                    names.update(projections)
                elif isinstance(options_node, ast.Dict):
                    if any(
                        key is None or not isinstance(key, ast.Constant)
                        for key in options_node.keys
                    ):
                        names.update(projections)
                    for key, value in zip(options_node.keys, options_node.values, strict=True):
                        if not (isinstance(key, ast.Constant) and key.value == "db_table"):
                            continue
                        table_names = static_sql_strings(value, node.lineno)
                        if table_names is None or len(table_names) != 1:
                            names.update(projections)
                        else:
                            names.update(
                                projection_names_from_sql(f"CREATE TABLE {table_names[0]}")
                            )

            operation_kind = resolved_operation_kind(node)
            if operation_kind in {"AlterModelTable", "RenameModel"}:
                target_keyword = "table" if operation_kind == "AlterModelTable" else "new_name"
                target_node = next(
                    (keyword.value for keyword in node.keywords if keyword.arg == target_keyword),
                    node.args[1] if len(node.args) >= 2 else None,
                )
                if target_node is None:
                    names.update(projections)
                else:
                    table_target_names = static_sql_strings(target_node, node.lineno)
                    if table_target_names is None or len(table_target_names) != 1:
                        names.update(projections)
                    else:
                        names.update(
                            projection_names_from_sql(f"CREATE TABLE {table_target_names[0]}")
                        )

            is_run_python = (
                (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "RunPython"
                    and is_migrations_operation_namespace(node.func.value, node.lineno)
                )
                or (isinstance(node.func, ast.Name) and node.func.id in run_python_aliases)
                or (is_selected_operation(node.func, "RunPython", node.lineno))
            )
            if is_run_python:
                code_nodes = list(node.args[:2])
                code_nodes.extend(
                    keyword.value
                    for keyword in node.keywords
                    if keyword.arg in {"code", "reverse_code"}
                )
                for code_node in code_nodes:
                    if isinstance(code_node, ast.Constant) and code_node.value is None:
                        continue
                    if is_run_python_noop(code_node, node.lineno):
                        continue
                    if (
                        not bindings_are_prior(code_node, node.lineno)
                        or not isinstance(code_node, ast.Name)
                        or code_node.id not in functions
                    ):
                        names.update(projections)
                        continue
                    callback = functions[code_node.id]
                    callback_local_names = {
                        name
                        for child in ast.walk(callback)
                        if isinstance(child, (ast.Assign, ast.AnnAssign, ast.AugAssign))
                        for target in (
                            child.targets if isinstance(child, ast.Assign) else [child.target]
                        )
                        for name in bound_names(target)
                    }
                    positional_arguments = callback.args.posonlyargs + callback.args.args
                    tainted_names = {
                        argument.arg
                        for argument in positional_arguments + callback.args.kwonlyargs
                        if "schema_editor" in argument.arg
                    } | database_connection_names
                    if len(positional_arguments) >= 2:
                        tainted_names.add(positional_arguments[1].arg)
                    elif callback.args.vararg is not None:
                        tainted_names.add(callback.args.vararg.arg)

                    def uses_tainted_name(
                        expression: ast.AST, _tainted_names: set[str] = tainted_names
                    ) -> bool:
                        return any(
                            isinstance(child, ast.Name) and child.id in _tainted_names
                            for child in ast.walk(expression)
                        )

                    def produces_schema_authority(
                        expression: ast.AST, _tainted_names: set[str] = tainted_names
                    ) -> bool:
                        if isinstance(expression, ast.Name):
                            return expression.id in _tainted_names
                        if isinstance(expression, (ast.Attribute, ast.Subscript)):
                            return produces_schema_authority(expression.value)
                        if isinstance(expression, (ast.Tuple, ast.List, ast.Set)):
                            return any(produces_schema_authority(item) for item in expression.elts)
                        if isinstance(expression, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
                            return produces_schema_authority(expression.elt) or any(
                                produces_schema_authority(generator.iter)
                                or any(
                                    produces_schema_authority(condition)
                                    for condition in generator.ifs
                                )
                                for generator in expression.generators
                            )
                        if isinstance(expression, ast.DictComp):
                            return (
                                produces_schema_authority(expression.key)
                                or produces_schema_authority(expression.value)
                                or any(
                                    produces_schema_authority(generator.iter)
                                    or any(
                                        produces_schema_authority(condition)
                                        for condition in generator.ifs
                                    )
                                    for generator in expression.generators
                                )
                            )
                        if isinstance(expression, ast.Dict):
                            return any(
                                produces_schema_authority(item)
                                for item in (*expression.keys, *expression.values)
                                if item is not None
                            )
                        if isinstance(expression, ast.IfExp):
                            return produces_schema_authority(
                                expression.body
                            ) or produces_schema_authority(expression.orelse)
                        if isinstance(expression, ast.BoolOp):
                            return any(
                                produces_schema_authority(value) for value in expression.values
                            )
                        if isinstance(expression, ast.BinOp):
                            return produces_schema_authority(
                                expression.left
                            ) or produces_schema_authority(expression.right)
                        if isinstance(expression, (ast.NamedExpr, ast.Starred)):
                            return produces_schema_authority(expression.value)
                        if isinstance(expression, ast.Call):
                            if isinstance(expression.func, ast.Attribute):
                                if expression.func.attr in {"fetchone", "fetchall", "fetchmany"}:
                                    return False
                                if produces_schema_authority(expression.func.value):
                                    return True
                            if (
                                isinstance(expression.func, ast.Name)
                                and expression.func.id == "getattr"
                                and expression.args
                            ):
                                return produces_schema_authority(expression.args[0])
                            return any(
                                produces_schema_authority(argument) for argument in expression.args
                            ) or any(
                                produces_schema_authority(keyword.value)
                                for keyword in expression.keywords
                            )
                        return False

                    for child in ast.walk(callback):
                        if isinstance(child, (ast.With, ast.AsyncWith)):
                            for item in child.items:
                                if uses_tainted_name(item.context_expr) and isinstance(
                                    item.optional_vars, ast.Name
                                ):
                                    tainted_names.add(item.optional_vars.id)
                    changed_taint = True
                    while changed_taint:
                        changed_taint = False
                        for child in ast.walk(callback):
                            if not isinstance(child, (ast.Assign, ast.AnnAssign)):
                                continue
                            if isinstance(child, ast.AnnAssign) and child.value is None:
                                continue
                            assert child.value is not None
                            targets = (
                                child.targets if isinstance(child, ast.Assign) else [child.target]
                            )
                            if not produces_schema_authority(child.value):
                                continue
                            for target in targets:
                                for name in bound_names(target):
                                    if name in tainted_names:
                                        continue
                                    tainted_names.add(name)
                                    changed_taint = True
                    if any(
                        child is not callback
                        and isinstance(
                            child,
                            (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda),
                        )
                        and uses_tainted_name(child)
                        for child in ast.walk(callback)
                    ):
                        names.update(projections)
                    for callback_call in (
                        child for child in ast.walk(callback) if isinstance(child, ast.Call)
                    ):
                        if (
                            isinstance(callback_call.func, ast.Name)
                            and callback_call.func.id in functions
                            and callback_call.func.id != callback.name
                        ) or uses_imported_binding(callback_call.func):
                            # A module helper can acquire a connection independently of the
                            # callback's editor argument, so its side effects are not inspectable.
                            names.update(projections)
                            continue
                        callback_attribute = (
                            callback_call.func
                            if isinstance(callback_call.func, ast.Attribute)
                            else None
                        )
                        if callback_attribute is not None and callback_attribute.attr in {
                            "create_model",
                            "delete_model",
                            "alter_db_table",
                        }:
                            names.update(projections)
                            continue
                        is_execute = callback_attribute is not None and callback_attribute.attr in {
                            "execute",
                            "executemany",
                        }
                        is_execute = is_execute or (
                            isinstance(callback_call.func, ast.Name)
                            and callback_call.func.id in tainted_names
                        )
                        is_execute = is_execute or (
                            isinstance(
                                callback_call.func,
                                (
                                    ast.Name,
                                    ast.Subscript,
                                    ast.Call,
                                    ast.IfExp,
                                    ast.BoolOp,
                                    ast.NamedExpr,
                                ),
                            )
                            and produces_schema_authority(callback_call.func)
                        )
                        is_execute = is_execute or (
                            isinstance(callback_call.func, ast.Call)
                            and isinstance(callback_call.func.func, ast.Name)
                            and callback_call.func.func.id == "getattr"
                            and len(callback_call.func.args) >= 2
                            and uses_tainted_name(callback_call.func.args[0])
                            and isinstance(callback_call.func.args[1], ast.Constant)
                            and callback_call.func.args[1].value in {"execute", "executemany"}
                        )
                        if not is_execute:
                            if (
                                isinstance(callback_call.func, ast.Name)
                                and callback_call.func.id == "getattr"
                                and len(callback_call.args) >= 2
                                and uses_tainted_name(callback_call.args[0])
                                and isinstance(callback_call.args[1], ast.Constant)
                                and callback_call.args[1].value in {"execute", "executemany"}
                            ):
                                continue
                            if any(uses_tainted_name(argument) for argument in callback_call.args):
                                names.update(projections)
                            elif any(
                                uses_tainted_name(keyword.value)
                                for keyword in callback_call.keywords
                            ):
                                names.update(projections)
                            continue
                        if not callback_call.args:
                            names.update(projections)
                            continue
                        sql_argument = callback_call.args[0]
                        statements = (
                            None
                            if any(
                                isinstance(child, ast.Name) and child.id in callback_local_names
                                for child in ast.walk(sql_argument)
                            )
                            else static_sql_strings(sql_argument, callback_call.lineno)
                        )
                        if statements is None:
                            names.update(projections)
                            continue
                        for sql in statements:
                            names.update(projection_names_from_sql(sql))

            is_run_sql = (
                (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "RunSQL"
                    and is_migrations_operation_namespace(node.func.value, node.lineno)
                )
                or (isinstance(node.func, ast.Name) and node.func.id in run_sql_aliases)
                or is_selected_operation(node.func, "RunSQL", node.lineno)
            )
            if not is_run_sql:
                continue
            sql_nodes = list(node.args[:2])
            sql_nodes.extend(
                keyword.value for keyword in node.keywords if keyword.arg in {"sql", "reverse_sql"}
            )
            current_class_local_names = class_local_names_by_call.get(id(node), frozenset())
            shadowed_sql = [
                any(
                    isinstance(child, ast.Name) and child.id in current_class_local_names
                    for child in ast.walk(value)
                )
                for value in sql_nodes
            ]
            resolved_sql = [
                None if shadowed else static_sql_strings(value, node.lineno)
                for value, shadowed in zip(sql_nodes, shadowed_sql, strict=True)
            ]
            sql_literals = {
                sql for statements in resolved_sql if statements is not None for sql in statements
            }
            for value, statements, shadowed in zip(
                sql_nodes, resolved_sql, shadowed_sql, strict=True
            ):
                if statements is not None or (not shadowed and is_run_sql_noop(value, node.lineno)):
                    continue
                # A runtime-computed SQL string can create any protected table.
                # Treat every projection as persisted rather than guessing from source text.
                names.update(projections)
            for sql in sql_literals:
                names.update(projection_names_from_sql(sql))
    return names


def stored_while_no_helpdesk(model: object, model_source: str) -> bool:
    """Whether a runtime model is the one exempt table: the `support` app's `SupportTicket` on
    `support_supportticket`, while MODEL.md carries the departure that allows it."""
    name, app_label, table = STORED_WHILE_NO_HELPDESK
    meta = getattr(model, "_meta", None)
    return (
        STORED_WHILE_NO_HELPDESK_CLAUSE in model_source
        and getattr(model, "__name__", None) == name
        and getattr(meta, "app_label", None) == app_label
        and getattr(meta, "db_table", None) == table
    )


def migration_names_while_no_helpdesk(model_source: str, root: Path = ROOT) -> set[str]:
    """Every migration's created model and table names, but for the one exempt operation while the
    departure stands: the support app's 0001 is read with its single `CreateModel` of
    `SupportTicket` renamed, so anything else in it that creates a SupportTicket-named table or view
    still counts, as does every other migration. A second such `CreateModel`, or a `db_table` in
    that file, ends the exemption."""
    everything = migration_create_model_names(root)
    exempt = root / STORED_WHILE_NO_HELPDESK_MIGRATION
    if STORED_WHILE_NO_HELPDESK_CLAUSE not in model_source or not exempt.is_file():
        return everything
    text = exempt.read_text(encoding="utf-8")
    if text.count(STORED_WHILE_NO_HELPDESK_CREATE) != 1 or "db_table" in text:
        return everything
    others = migration_create_model_names(root, outside=STORED_WHILE_NO_HELPDESK_MIGRATION)
    with tempfile.TemporaryDirectory() as scratch:
        copy = Path(scratch) / STORED_WHILE_NO_HELPDESK_MIGRATION
        copy.parent.mkdir(parents=True)
        copy.write_text(
            text.replace(STORED_WHILE_NO_HELPDESK_CREATE, STORED_WHILE_NO_HELPDESK_NEUTRAL),
            encoding="utf-8",
        )
        exempt_file = migration_create_model_names(Path(scratch))
    return others | (exempt_file - {STORED_WHILE_NO_HELPDESK_NEUTRAL.split("'")[1]})


def non_persisted_projection_runtime_refusals(
    model_names: set[str] | None = None,
    migration_names: set[str] | None = None,
    *,
    model_source: str | None = None,
) -> list[str]:
    """Refuse a computed projection that acquired a Django model or migration table, but for the
    one table MODEL.md's departure allows while no helpdesk exists."""
    projections = set(NON_PERSISTED_MODEL_PROJECTIONS)
    if model_source is None:
        model_source = MODEL.read_text(encoding="utf-8")
    if model_names is None:
        from django.apps import apps as django_apps

        runtime_models = [
            model
            for model in django_apps.get_models()
            if not stored_while_no_helpdesk(model, model_source)
        ]
        model_names = {model.__name__ for model in runtime_models}
        for model in runtime_models:
            table_name = getattr(getattr(model, "_meta", None), "db_table", "")
            normalized_table = re.sub(r"[^a-z0-9]", "", str(table_name).lower())
            model_names.update(
                projection
                for projection in projections
                if re.sub(r"[^a-z0-9]", "", projection.lower()) in normalized_table
            )
    if migration_names is None:
        migration_names = migration_names_while_no_helpdesk(model_source)
    refusals = []
    if persisted := sorted(projections & model_names):
        refusals.append(
            "non-persisted projection registered as Django model: " + ", ".join(persisted)
        )
    if migrated := sorted(projections & migration_names):
        refusals.append(
            "non-persisted projection created by Django migration: " + ", ".join(migrated)
        )
    return refusals


def source_entity_fields(source: str, table_name: str) -> dict[str, tuple[str, str]]:
    """Return structural field contracts from an entity table or persisted summary."""
    named_header = f"| `{table_name}` field | Type | Notes |"
    if named_header in source:
        return named_table_fields(source, table_name)
    body = section(source, table_name)
    for header in ("| Field | Type | Notes |", "| Column | Type | Notes |"):
        if header not in body:
            continue
        fields = {}
        for line in body[body.index(header) :].splitlines()[2:]:
            if not line.startswith("|"):
                break
            cells = [cell.strip() for cell in re.split(r"(?<!\\)\|", line)[1:-1]]
            if len(cells) != 3:
                raise AssertionError(f"unparseable {table_name} scope row: {line}")
            name_cell, field_type, notes = cells
            fields[name_cell.strip("`")] = (field_type, notes)
        return fields
    summary = re.search(r"Summary of columns: ([^\n]+)", body)
    if summary:
        fields = {
            field_name: ("", "")
            for field_name in re.findall(r"`([a-z][a-z0-9_]*)`", summary.group(1))
        }
        for field_name, field_type in re.findall(
            r"`([a-z][a-z0-9_]*)` \((FK `[^`]+`(?:, restrict)?)\)",
            summary.group(1),
        ):
            fields[field_name] = (field_type, "Persisted summary authority")
        return fields
    return {}


def source_anchor_contract(source: str, table_name: str, field_name: str) -> tuple[str, str] | None:
    matches = [
        contract
        for names, contract in source_entity_fields(source, table_name).items()
        if field_name in expanded_field_names({names: contract})
    ]
    if len(matches) != 1:
        return None
    return matches[0]


def expanded_field_names(fields: dict[str, tuple[str, str]]) -> set[str]:
    names = set()
    for name in fields:
        names.update(re.findall(r"[a-z][a-z0-9_]*", name))
    return names


def normalized(value: str) -> str:
    return " ".join(value.split())


def reachable_openapi_schema_records(
    openapi_source: str,
) -> list[tuple[frozenset[str], frozenset[str]]]:
    """Return effective fields and provenance for schemas reachable from OpenAPI paths."""
    document = load_yaml(openapi_source)
    if not isinstance(document, dict) or not isinstance(document.get("paths"), dict):
        raise ValueError("OpenAPI root must contain a paths mapping")
    records: set[tuple[frozenset[str], frozenset[str]]] = set()
    collected_schemas: set[tuple[int, frozenset[str], tuple[str, ...], int]] = set()
    walked_objects: set[tuple[int, frozenset[str], tuple[str, ...]]] = set()

    def schema_location(parts: tuple[str, ...]) -> str:
        encoded = "/".join(part.replace("~", "~0").replace("/", "~1") for part in parts)
        return f"schema-location:#/{encoded}"

    def resolve_reference(reference: str) -> object:
        if not reference.startswith("#/"):
            raise ValueError(f"external OpenAPI reference is not inspectable: {reference}")
        target: object = document
        for segment in reference[2:].split("/"):
            segment = segment.replace("~1", "/").replace("~0", "~")
            if not isinstance(target, dict) or segment not in target:
                raise ValueError(f"unresolved local OpenAPI reference: {reference}")
            target = target[segment]
        return target

    def combine(left: list[frozenset[str]], right: list[frozenset[str]]) -> list[frozenset[str]]:
        right_options = right or [frozenset()]
        return [
            left_fields | right_fields for left_fields in left for right_fields in right_options
        ]

    def projection_contracts(
        node: object, reference_stack: frozenset[str] = frozenset()
    ) -> dict[str, bool]:
        if not isinstance(node, dict):
            return {}
        contracts: dict[str, bool] = {}
        projection = node.get("x-kodera-projection")
        if projection is not None and not isinstance(projection, str):
            raise ValueError("x-kodera-projection must be a string")
        if isinstance(projection, str):
            properties = node.get("properties")
            required = node.get("required")
            contracts[projection] = (
                node.get("type") == "object"
                and isinstance(properties, dict)
                and isinstance(required, list)
                and set(str(name) for name in required) == set(str(name) for name in properties)
                and node.get("additionalProperties") is False
                and node.get("unevaluatedProperties") is False
                and not node.get("patternProperties")
            )
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = node.get(reference_keyword)
            if not isinstance(reference, str) or reference in reference_stack:
                continue
            for marker, closed in projection_contracts(
                resolve_reference(reference), reference_stack | {reference}
            ).items():
                contracts[marker] = contracts.get(marker, True) and closed
        # Alternative branches keep independent provenance. Merging a marker into
        # their parent would let one branch attest for an unrelated sibling.
        for keyword in ("allOf",):
            children = node.get(keyword)
            if isinstance(children, list):
                for child in children:
                    for marker, closed in projection_contracts(child, reference_stack).items():
                        contracts[marker] = contracts.get(marker, True) and closed
        return contracts

    def projection_markers(
        node: object, reference_stack: frozenset[str] = frozenset()
    ) -> frozenset[str]:
        return frozenset(projection_contracts(node, reference_stack))

    def contains_alternative_composition(
        node: object, reference_stack: frozenset[str] = frozenset()
    ) -> bool:
        if not isinstance(node, dict):
            return False
        if isinstance(node.get("oneOf"), list) or isinstance(node.get("anyOf"), list):
            return True
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = node.get(reference_keyword)
            if not isinstance(reference, str) or reference in reference_stack:
                continue
            if contains_alternative_composition(
                resolve_reference(reference), reference_stack | {reference}
            ):
                return True
        all_of = node.get("allOf")
        return isinstance(all_of, list) and any(
            contains_alternative_composition(child, reference_stack) for child in all_of
        )

    def closed_object_shape(
        node: object, reference_stack: frozenset[str] = frozenset()
    ) -> tuple[frozenset[str], frozenset[str]] | None:
        if not isinstance(node, dict):
            return None
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = node.get(reference_keyword)
            if not isinstance(reference, str) or reference in reference_stack:
                continue
            structural_siblings = set(node) - {
                reference_keyword,
                "title",
                "description",
                "deprecated",
                "readOnly",
                "writeOnly",
            }
            if not structural_siblings:
                return closed_object_shape(
                    resolve_reference(reference), reference_stack | {reference}
                )
        all_of = node.get("allOf")
        if isinstance(all_of, list):
            shapes = [closed_object_shape(child, reference_stack) for child in all_of]
            if any(shape is None for shape in shapes):
                return None
            closed_shapes = [shape for shape in shapes if shape is not None]
            property_sets = {shape[0] for shape in closed_shapes}
            if len(property_sets) == 1:
                return next(iter(property_sets)), frozenset().union(
                    *(shape[1] for shape in closed_shapes)
                )
            properties = node.get("properties")
            required = node.get("required", [])
            if (
                node.get("additionalProperties") is not False
                or node.get("unevaluatedProperties") is not False
                or node.get("patternProperties")
                or not isinstance(properties, dict)
            ):
                return None
            allowed = frozenset(str(name) for name in properties)
            if any(not shape[0] <= allowed for shape in closed_shapes):
                return None
            return allowed, frozenset(str(name) for name in required).union(
                *(shape[1] for shape in closed_shapes)
            )
        if (
            node.get("type") != "object"
            or node.get("additionalProperties") is not False
            or node.get("unevaluatedProperties") is not False
            or node.get("patternProperties")
        ):
            return None
        properties = node.get("properties")
        required = node.get("required")
        if not isinstance(properties, dict) or not isinstance(required, list) or not required:
            return None
        return frozenset(str(name) for name in properties), frozenset(
            str(name) for name in required
        )

    def any_of_is_statically_exclusive(children: list[object]) -> bool:
        shapes = [closed_object_shape(child) for child in children]
        if len(shapes) < 2 or any(shape is None for shape in shapes):
            return False
        closed_shapes = [shape for shape in shapes if shape is not None]
        return all(
            (left_required - right_properties) or (right_required - left_properties)
            for index, (left_properties, left_required) in enumerate(closed_shapes)
            for right_properties, right_required in closed_shapes[index + 1 :]
        )

    def property_name_pattern_is_generic(pattern: str) -> bool:
        catchalls = {
            "",
            "^",
            "$",
            ".*",
            "^.*$",
            ".+",
            "^.+$",
            "^(?:.*)$",
            "^(?:.+)$",
            r"^[\s\S]*$",
            r"^[\s\S]{0,}$",
            r"^(?:[\s\S]*)$",
            "(?s:^.*$)",
            "(?s:.*)",
            "(?=.{0,}$)",
        }
        if pattern in catchalls:
            return True
        if re.fullmatch(r"\^\(\?!\.\*\[(?:\\.|[^\]])+\]\)\.(?:\+|\*)\$", pattern):
            return True
        try:
            re.compile(pattern)
        except re.error as error:
            raise ValueError(f"invalid OpenAPI property-name regex: {pattern}") from error
        character_class_pattern = re.fullmatch(
            r"\^?(?:\[(?:\\.|[^\]])+\](?:\+|\*|\?|\{\d+(?:,\d*)?\})?)+\$?",
            pattern,
        )
        if character_class_pattern is None:
            return False
        character_classes = re.findall(r"\[((?:\\.|[^\]])+)\]", pattern)
        if not character_classes or len(character_classes) > 2:
            return False

        def is_broad_character_class(character_class: str) -> bool:
            if character_class.startswith("^"):
                return True
            if re.search(r"\\[wWdDsS]", character_class):
                return True
            return any(
                left.isalnum() and right.isalnum() and ord(right) - ord(left) >= 9
                for left, right in re.findall(r"([A-Za-z0-9])-([A-Za-z0-9])", character_class)
            )

        return all(
            is_broad_character_class(character_class) for character_class in character_classes
        )

    def name_schema_mentions_sensitive_field(
        schema: object,
        candidate: str,
        reference_stack: frozenset[str] = frozenset(),
    ) -> bool:
        if not isinstance(schema, dict):
            return False
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = schema.get(reference_keyword)
            if isinstance(reference, str) and reference not in reference_stack:
                if name_schema_mentions_sensitive_field(
                    resolve_reference(reference),
                    candidate,
                    reference_stack | {reference},
                ):
                    return True
        if schema.get("const") == candidate:
            return True
        enum = schema.get("enum")
        if isinstance(enum, list) and candidate in enum:
            return True
        return any(
            name_schema_mentions_sensitive_field(child, candidate, reference_stack)
            for key, value in schema.items()
            if key
            not in {
                "title",
                "description",
                "deprecated",
                "readOnly",
                "writeOnly",
                "$comment",
                "default",
                "examples",
            }
            for child in (value if isinstance(value, list) else [value])
            if isinstance(child, dict)
        )

    def negative_lookahead_rejects_candidate(pattern: str, candidate: str) -> bool:
        cursor = 0
        while (start := pattern.find("(?!", cursor)) >= 0:
            depth = 1
            escaped = False
            in_character_class = False
            for index in range(start + 3, len(pattern)):
                character = pattern[index]
                if escaped:
                    escaped = False
                    continue
                if character == "\\":
                    escaped = True
                    continue
                if character == "[" and not in_character_class:
                    in_character_class = True
                    continue
                if character == "]" and in_character_class:
                    in_character_class = False
                    continue
                if in_character_class:
                    continue
                if character == "(":
                    depth += 1
                elif character == ")":
                    depth -= 1
                    if depth == 0:
                        assertion = pattern[start + 3 : index]
                        if re.match(assertion, candidate):
                            return True
                        cursor = index + 1
                        break
            else:
                return False
        return False

    def property_name_schema_accepts(
        schema: object,
        candidate: str,
        reference_stack: frozenset[str] = frozenset(),
    ) -> bool:
        if isinstance(schema, bool):
            return schema
        if not isinstance(schema, dict):
            return False
        expanded = dict(schema)
        references_accept = True
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = expanded.pop(reference_keyword, None)
            if not isinstance(reference, str) or reference in reference_stack:
                continue
            references_accept = references_accept and property_name_schema_accepts(
                resolve_reference(reference),
                candidate,
                reference_stack | {reference},
            )
        try:
            return references_accept and jsonschema_rs.is_valid(expanded, candidate)
        except (TypeError, ValueError):
            return True

    def property_name_schema_is_generic(
        schema: object,
        reference_stack: frozenset[str] = frozenset(),
    ) -> bool:
        """Admit only closed, name-agnostic constraints for free-form maps."""
        if schema is True or schema == {}:
            return True
        if not isinstance(schema, dict):
            return False
        remaining = {
            key: value
            for key, value in schema.items()
            if key
            not in {
                "title",
                "description",
                "deprecated",
                "readOnly",
                "writeOnly",
                "$comment",
                "default",
                "examples",
            }
        }
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = remaining.pop(reference_keyword, None)
            if isinstance(reference, str) and reference not in reference_stack:
                if not property_name_schema_is_generic(
                    resolve_reference(reference), reference_stack | {reference}
                ):
                    return False
            elif reference is not None:
                return False
        declared_type = remaining.pop("type", "string")
        if declared_type != "string" and not (
            isinstance(declared_type, list) and "string" in declared_type
        ):
            return False
        for keyword in ("minLength", "maxLength"):
            bound = remaining.pop(keyword, None)
            if bound is not None and (
                isinstance(bound, bool) or not isinstance(bound, int) or bound < 0
            ):
                return False
        pattern = remaining.pop("pattern", None)
        if pattern is not None and (
            not isinstance(pattern, str) or not property_name_pattern_is_generic(pattern)
        ):
            return False
        all_of = remaining.pop("allOf", None)
        if all_of is not None and (
            not isinstance(all_of, list)
            or not all(property_name_schema_is_generic(child, reference_stack) for child in all_of)
        ):
            return False
        any_of = remaining.pop("anyOf", None)
        if any_of is not None and (
            not isinstance(any_of, list)
            or not all(property_name_schema_is_generic(child, reference_stack) for child in any_of)
        ):
            return False
        return not remaining

    def property_name_schema_is_literal_selector(
        schema: object,
        reference_stack: frozenset[str] = frozenset(),
    ) -> bool:
        """Recognize schemas whose only name-specific authority is const/enum."""
        if isinstance(schema, bool):
            return True
        if not isinstance(schema, dict):
            return False
        annotations = {
            "title",
            "description",
            "deprecated",
            "readOnly",
            "writeOnly",
            "$comment",
            "default",
            "examples",
        }
        structural = {key: value for key, value in schema.items() if key not in annotations}
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = structural.pop(reference_keyword, None)
            if not isinstance(reference, str) or reference in reference_stack:
                if reference is not None:
                    return False
                continue
            if not property_name_schema_is_literal_selector(
                resolve_reference(reference), reference_stack | {reference}
            ):
                return False
        if not set(structural) <= {"type", "const", "enum", "not", "allOf", "anyOf", "oneOf"}:
            return False
        negated = structural.get("not")
        if negated is not None and not property_name_schema_is_literal_selector(
            negated, reference_stack
        ):
            return False
        for keyword in ("allOf", "anyOf", "oneOf"):
            children = structural.get(keyword)
            if children is not None and (
                not isinstance(children, list)
                or not all(
                    property_name_schema_is_literal_selector(child, reference_stack)
                    for child in children
                )
            ):
                return False
        return True

    json_type_domains = frozenset(
        {"null", "boolean", "object", "array", "string", "integer", "noninteger-number"}
    )

    def schema_possible_type_domains(
        schema: object,
        reference_stack: frozenset[str] = frozenset(),
    ) -> frozenset[str]:
        if schema is False:
            return frozenset()
        if schema is True or not isinstance(schema, dict):
            return json_type_domains
        possible = set(json_type_domains)
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = schema.get(reference_keyword)
            if isinstance(reference, str) and reference not in reference_stack:
                possible.intersection_update(
                    schema_possible_type_domains(
                        resolve_reference(reference), reference_stack | {reference}
                    )
                )
        declared_type = schema.get("type")
        if isinstance(declared_type, str):
            declared = {declared_type}
        elif isinstance(declared_type, list) and all(
            isinstance(item, str) for item in declared_type
        ):
            declared = set(declared_type)
        else:
            declared = None
        if declared is not None:
            if "number" in declared:
                declared.update({"integer", "noninteger-number"})
                declared.discard("number")
            possible.intersection_update(declared)
        negated = schema.get("not")
        annotation_keywords = {
            "title",
            "description",
            "deprecated",
            "readOnly",
            "writeOnly",
            "$comment",
            "default",
            "examples",
        }
        if isinstance(negated, dict) and set(negated) - annotation_keywords == {"type"}:
            possible.difference_update(schema_possible_type_domains(negated, reference_stack))
        all_of = schema.get("allOf")
        if isinstance(all_of, list):
            for child in all_of:
                possible.intersection_update(schema_possible_type_domains(child, reference_stack))
        for keyword in ("anyOf", "oneOf"):
            alternatives = schema.get(keyword)
            if isinstance(alternatives, list):
                alternative_types = set().union(
                    *(
                        schema_possible_type_domains(child, reference_stack)
                        for child in alternatives
                    )
                )
                possible.intersection_update(alternative_types)
        return frozenset(possible)

    def schema_is_vacuous_for_domains(
        schema: object,
        domains: frozenset[str],
        reference_stack: frozenset[str] = frozenset(),
    ) -> bool:
        """Return whether a schema accepts every value in the supplied type domains."""
        if schema is True or schema == {}:
            return True
        if schema is False or not isinstance(schema, dict):
            return False
        annotations = {
            "title",
            "description",
            "deprecated",
            "readOnly",
            "writeOnly",
            "$comment",
            "default",
            "examples",
        }
        remaining = {key: value for key, value in schema.items() if key not in annotations}
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = remaining.pop(reference_keyword, None)
            if reference is None:
                continue
            if (
                not isinstance(reference, str)
                or reference in reference_stack
                or not schema_is_vacuous_for_domains(
                    resolve_reference(reference), domains, reference_stack | {reference}
                )
            ):
                return False
        declared_type = remaining.pop("type", None)
        if declared_type is not None and not domains <= schema_possible_type_domains(
            {"type": declared_type}
        ):
            return False
        for keyword in ("minLength", "minItems", "minProperties"):
            if remaining.get(keyword) == 0:
                remaining.pop(keyword)
        if remaining.get("uniqueItems") is False:
            remaining.pop("uniqueItems")
        if remaining.get("pattern") in {"", ".*", "(?s:^.*$)", "(?s:.*)"}:
            remaining.pop("pattern")
        keyword_domains = {
            "minimum": {"integer", "noninteger-number"},
            "maximum": {"integer", "noninteger-number"},
            "exclusiveMinimum": {"integer", "noninteger-number"},
            "exclusiveMaximum": {"integer", "noninteger-number"},
            "multipleOf": {"integer", "noninteger-number"},
            "minLength": {"string"},
            "maxLength": {"string"},
            "pattern": {"string"},
            "minItems": {"array"},
            "maxItems": {"array"},
            "uniqueItems": {"array"},
            "items": {"array"},
            "prefixItems": {"array"},
            "contains": {"array"},
            "minContains": {"array"},
            "maxContains": {"array"},
            "minProperties": {"object"},
            "maxProperties": {"object"},
            "properties": {"object"},
            "patternProperties": {"object"},
            "additionalProperties": {"object"},
            "unevaluatedProperties": {"object"},
            "required": {"object"},
            "dependentRequired": {"object"},
            "dependentSchemas": {"object"},
            "propertyNames": {"object"},
        }
        for keyword in list(remaining):
            if keyword in keyword_domains and domains.isdisjoint(keyword_domains[keyword]):
                remaining.pop(keyword)
        negated = remaining.pop("not", None)
        if negated is not None and not domains.isdisjoint(
            schema_possible_type_domains(negated, reference_stack)
        ):
            return False
        all_of = remaining.pop("allOf", None)
        if all_of is not None and (
            not isinstance(all_of, list)
            or not all(
                schema_is_vacuous_for_domains(child, domains, reference_stack) for child in all_of
            )
        ):
            return False
        any_of = remaining.pop("anyOf", None)
        if any_of is not None and (
            not isinstance(any_of, list)
            or not any(
                schema_is_vacuous_for_domains(child, domains, reference_stack) for child in any_of
            )
        ):
            return False
        if_schema = remaining.pop("if", None)
        then_schema = remaining.pop("then", None)
        else_schema = remaining.pop("else", None)
        if if_schema is not None:

            def canonical_conditional_branch(
                branch: object,
                branch_reference_stack: frozenset[str] = reference_stack,
            ) -> object:
                if not isinstance(branch, dict):
                    return branch
                schema_mapping_keywords = {
                    "$defs",
                    "definitions",
                    "dependentSchemas",
                    "patternProperties",
                    "properties",
                }
                schema_list_keywords = {
                    "allOf",
                    "anyOf",
                    "oneOf",
                    "prefixItems",
                }
                schema_value_keywords = {
                    "additionalProperties",
                    "contains",
                    "else",
                    "if",
                    "items",
                    "not",
                    "propertyNames",
                    "then",
                    "unevaluatedItems",
                    "unevaluatedProperties",
                }

                def canonical_keyword_value(key: str, value: object) -> object:
                    if key in schema_mapping_keywords and isinstance(value, dict):
                        return {
                            child_key: canonical_conditional_branch(child, branch_reference_stack)
                            for child_key, child in value.items()
                        }
                    if key in schema_list_keywords and isinstance(value, list):
                        return [
                            canonical_conditional_branch(child, branch_reference_stack)
                            for child in value
                        ]
                    if key in schema_value_keywords:
                        return canonical_conditional_branch(value, branch_reference_stack)
                    return value

                structural = {
                    key: canonical_keyword_value(key, value)
                    for key, value in branch.items()
                    if key not in annotations
                }
                multiple_of = structural.get("multipleOf")
                if (
                    domains == frozenset({"integer"})
                    and is_finite_json_number(multiple_of)
                    and multiple_of > 0
                    and Fraction(str(multiple_of)).numerator == 1
                ):
                    structural.pop("multipleOf")
                for reference_keyword in ("$ref", "$dynamicRef"):
                    reference = structural.get(reference_keyword)
                    if (
                        len(structural) == 1
                        and isinstance(reference, str)
                        and reference not in branch_reference_stack
                    ):
                        return canonical_conditional_branch(
                            resolve_reference(reference),
                            branch_reference_stack | {reference},
                        )
                for composition in ("allOf", "anyOf"):
                    children = structural.get(composition)
                    if len(structural) == 1 and isinstance(children, list) and len(children) == 1:
                        return canonical_conditional_branch(children[0], branch_reference_stack)
                all_of = structural.get("allOf")
                if isinstance(all_of, list):
                    merged = {key: value for key, value in structural.items() if key != "allOf"}
                    lower_bounds = {
                        "exclusiveMinimum",
                        "minItems",
                        "minLength",
                        "minProperties",
                        "minimum",
                    }
                    upper_bounds = {
                        "exclusiveMaximum",
                        "maxItems",
                        "maxLength",
                        "maxProperties",
                        "maximum",
                    }
                    mergeable_keywords = lower_bounds | upper_bounds | {"type"}
                    if set(merged) - mergeable_keywords:
                        return structural
                    for child in all_of:
                        canonical_child = canonical_conditional_branch(
                            child, branch_reference_stack
                        )
                        if (
                            not isinstance(canonical_child, dict)
                            or set(canonical_child) - mergeable_keywords
                        ):
                            break
                        for key, value in canonical_child.items():
                            if key not in merged or merged[key] == value:
                                merged[key] = value
                            elif (
                                key in lower_bounds
                                and isinstance(merged[key], (int, float))
                                and isinstance(value, (int, float))
                            ):
                                merged[key] = max(cast(int | float, merged[key]), value)
                            elif (
                                key in upper_bounds
                                and isinstance(merged[key], (int, float))
                                and isinstance(value, (int, float))
                            ):
                                merged[key] = min(cast(int | float, merged[key]), value)
                            else:
                                break
                        else:
                            continue
                        break
                    else:
                        if domains and domains <= frozenset({"integer", "noninteger-number"}):
                            minimum = merged.get("minimum")
                            exclusive_minimum = merged.get("exclusiveMinimum")
                            if is_finite_json_number(minimum) and is_finite_json_number(
                                exclusive_minimum
                            ):
                                if exclusive_minimum >= minimum:
                                    merged.pop("minimum")
                                else:
                                    merged.pop("exclusiveMinimum")
                            maximum = merged.get("maximum")
                            exclusive_maximum = merged.get("exclusiveMaximum")
                            if is_finite_json_number(maximum) and is_finite_json_number(
                                exclusive_maximum
                            ):
                                if exclusive_maximum <= maximum:
                                    merged.pop("maximum")
                                else:
                                    merged.pop("exclusiveMaximum")
                        if domains == frozenset({"integer"}):
                            lower_candidates = []
                            minimum = merged.get("minimum")
                            exclusive_minimum = merged.get("exclusiveMinimum")
                            if is_finite_json_number(minimum):
                                lower_candidates.append(math.ceil(minimum))
                            if is_finite_json_number(exclusive_minimum):
                                lower_candidates.append(math.floor(exclusive_minimum) + 1)
                            if lower_candidates and all(
                                key not in merged or is_finite_json_number(merged[key])
                                for key in ("minimum", "exclusiveMinimum")
                            ):
                                merged["minimum"] = max(lower_candidates)
                                merged.pop("exclusiveMinimum", None)
                            upper_candidates = []
                            maximum = merged.get("maximum")
                            exclusive_maximum = merged.get("exclusiveMaximum")
                            if is_finite_json_number(maximum):
                                upper_candidates.append(math.floor(maximum))
                            if is_finite_json_number(exclusive_maximum):
                                upper_candidates.append(math.ceil(exclusive_maximum) - 1)
                            if upper_candidates and all(
                                key not in merged or is_finite_json_number(merged[key])
                                for key in ("maximum", "exclusiveMaximum")
                            ):
                                merged["maximum"] = min(upper_candidates)
                                merged.pop("exclusiveMaximum", None)
                        return merged
                return structural

            structural_if = canonical_conditional_branch(if_schema)
            structural_then = canonical_conditional_branch(then_schema)
            structural_else = canonical_conditional_branch(else_schema)

            def without_contextually_redundant_type(branch: object) -> object:
                if not isinstance(branch, dict):
                    return branch
                same_instance_list_keywords = {"allOf", "anyOf", "oneOf"}
                same_instance_value_keywords = {"else", "if", "not", "then"}
                normalized = dict(branch)
                if "type" in normalized and domains <= schema_possible_type_domains(
                    {"type": normalized["type"]}
                ):
                    normalized.pop("type")
                for key, value in tuple(normalized.items()):
                    if key in same_instance_list_keywords and isinstance(value, list):
                        normalized[key] = [
                            without_contextually_redundant_type(child) for child in value
                        ]
                    elif key in same_instance_value_keywords:
                        normalized[key] = without_contextually_redundant_type(value)
                return normalized

            structural_if = without_contextually_redundant_type(structural_if)
            structural_then = without_contextually_redundant_type(structural_then)
            structural_else = without_contextually_redundant_type(structural_else)
            exact_complement = structural_else == {"not": structural_if}
            bound_complements = {
                "minLength": "maxLength",
                "maxLength": "minLength",
                "minItems": "maxItems",
                "maxItems": "minItems",
                "minProperties": "maxProperties",
                "maxProperties": "minProperties",
                "minimum": "exclusiveMaximum",
                "exclusiveMinimum": "maximum",
                "maximum": "exclusiveMinimum",
                "exclusiveMaximum": "minimum",
            }
            bound_complement = False
            if isinstance(structural_if, dict) and len(structural_if) == 1:
                condition_keyword, condition_value = next(iter(structural_if.items()))
                complement_keyword = bound_complements.get(condition_keyword)
                complement_value = condition_value
                if condition_keyword in {
                    "minLength",
                    "minItems",
                    "minProperties",
                } and isinstance(condition_value, int):
                    complement_value = condition_value - 1
                elif condition_keyword in {
                    "maxLength",
                    "maxItems",
                    "maxProperties",
                } and isinstance(condition_value, int):
                    complement_value = condition_value + 1
                complement_candidates: list[object] = [{complement_keyword: complement_value}]
                if domains == frozenset({"integer"}) and is_finite_json_number(condition_value):
                    integer_complements = {
                        "minimum": {"maximum": math.ceil(condition_value) - 1},
                        "exclusiveMinimum": {"maximum": math.floor(condition_value)},
                        "maximum": {"minimum": math.floor(condition_value) + 1},
                        "exclusiveMaximum": {"minimum": math.ceil(condition_value)},
                    }
                    integer_complement = integer_complements.get(condition_keyword)
                    if integer_complement is not None:
                        complement_candidates.append(integer_complement)
                bound_complement = structural_else in complement_candidates
            partition_is_vacuous = structural_then == structural_if and (
                exact_complement or bound_complement
            )
            then_is_vacuous = then_schema is None or schema_is_vacuous_for_domains(
                then_schema, domains, reference_stack
            )
            else_is_vacuous = else_schema is None or schema_is_vacuous_for_domains(
                else_schema, domains, reference_stack
            )
            if partition_is_vacuous or then_is_vacuous and else_is_vacuous:
                selected = None
            elif domains.isdisjoint(schema_possible_type_domains(if_schema, reference_stack)):
                selected = else_schema
            elif schema_is_vacuous_for_domains(if_schema, domains, reference_stack):
                selected = then_schema
            else:
                return False
            if selected is not None and not schema_is_vacuous_for_domains(
                selected, domains, reference_stack
            ):
                return False
        elif then_schema is not None or else_schema is not None:
            # JSON Schema ignores then/else when if is absent.
            pass
        one_of = remaining.pop("oneOf", None)
        if one_of is not None:
            if not isinstance(one_of, list):
                return False
            always_true = sum(
                schema_is_vacuous_for_domains(child, domains, reference_stack) for child in one_of
            )
            possible = sum(
                not domains.isdisjoint(schema_possible_type_domains(child, reference_stack))
                for child in one_of
            )
            if always_true != 1 or possible != 1:
                return False
        return not remaining

    def normalized_schema_equivalence_signature(
        schema: object,
        reference_stack: frozenset[str] = frozenset(),
    ) -> str:
        if isinstance(schema, list):
            return json.dumps(
                [
                    normalized_schema_equivalence_signature(child, reference_stack)
                    for child in schema
                ],
                sort_keys=True,
                separators=(",", ":"),
            )
        if not isinstance(schema, dict):
            return json.dumps(schema, sort_keys=True, separators=(",", ":"))
        annotation_keywords = {
            "title",
            "description",
            "deprecated",
            "readOnly",
            "writeOnly",
            "$comment",
            "default",
            "examples",
        }
        normalized = {key: value for key, value in schema.items() if key not in annotation_keywords}
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = normalized.get(reference_keyword)
            if (
                isinstance(reference, str)
                and reference not in reference_stack
                and set(normalized) == {reference_keyword}
            ):
                return normalized_schema_equivalence_signature(
                    resolve_reference(reference), reference_stack | {reference}
                )
        for keyword in ("minLength", "minItems", "minProperties"):
            if normalized.get(keyword) == 0:
                normalized.pop(keyword)
        if normalized.get("uniqueItems") is False:
            normalized.pop("uniqueItems")
        if normalized.get("pattern") in {"", ".*", "(?s:^.*$)", "(?s:.*)"}:
            normalized.pop("pattern")
        double_negation = normalized.get("not")
        if (
            len(normalized) == 1
            and isinstance(double_negation, dict)
            and set(double_negation) - annotation_keywords == {"not"}
        ):
            return normalized_schema_equivalence_signature(double_negation["not"], reference_stack)
        any_of = normalized.get("anyOf")
        if isinstance(any_of, list) and any(
            child is True or isinstance(child, dict) and not (set(child) - annotation_keywords)
            for child in any_of
        ):
            normalized.pop("anyOf")
        all_of = normalized.get("allOf")
        if isinstance(all_of, list):
            live_all_of = [
                child
                for child in all_of
                if child is not True
                and not (isinstance(child, dict) and not (set(child) - annotation_keywords))
            ]
            if live_all_of:
                normalized["allOf"] = live_all_of
            else:
                normalized.pop("allOf")
        for keyword in ("allOf", "anyOf", "oneOf"):
            children = normalized.get(keyword)
            if len(normalized) == 1 and isinstance(children, list) and len(children) == 1:
                return normalized_schema_equivalence_signature(children[0], reference_stack)
        declared_type = normalized.get("type")
        if isinstance(declared_type, str):
            normalized["type"] = [declared_type]
        elif isinstance(declared_type, list) and all(
            isinstance(item, str) for item in declared_type
        ):
            normalized["type"] = sorted(set(declared_type))
        if declared_type is not None:
            applicable_domains = schema_possible_type_domains({"type": declared_type})
            keyword_domains = {
                "minimum": {"integer", "noninteger-number"},
                "maximum": {"integer", "noninteger-number"},
                "exclusiveMinimum": {"integer", "noninteger-number"},
                "exclusiveMaximum": {"integer", "noninteger-number"},
                "multipleOf": {"integer", "noninteger-number"},
                "minLength": {"string"},
                "maxLength": {"string"},
                "pattern": {"string"},
                "minItems": {"array"},
                "maxItems": {"array"},
                "uniqueItems": {"array"},
                "items": {"array"},
                "prefixItems": {"array"},
                "contains": {"array"},
                "minContains": {"array"},
                "maxContains": {"array"},
                "minProperties": {"object"},
                "maxProperties": {"object"},
                "properties": {"object"},
                "patternProperties": {"object"},
                "additionalProperties": {"object"},
                "unevaluatedProperties": {"object"},
                "required": {"object"},
                "dependentRequired": {"object"},
                "dependentSchemas": {"object"},
                "propertyNames": {"object"},
            }
            for keyword, domains in keyword_domains.items():
                if applicable_domains.isdisjoint(domains):
                    normalized.pop(keyword, None)
            negated = normalized.get("not")
            if negated is not None and schema_is_vacuous_for_domains(
                {"not": negated}, applicable_domains, reference_stack
            ):
                normalized.pop("not")
            contextual_all_of = normalized.get("allOf")
            if isinstance(contextual_all_of, list):
                live_contextual_all_of = [
                    child
                    for child in contextual_all_of
                    if not schema_is_vacuous_for_domains(child, applicable_domains, reference_stack)
                ]
                if live_contextual_all_of:
                    normalized["allOf"] = live_contextual_all_of
                else:
                    normalized.pop("allOf")
            contextual_any_of = normalized.get("anyOf")
            if isinstance(contextual_any_of, list) and any(
                schema_is_vacuous_for_domains(child, applicable_domains, reference_stack)
                for child in contextual_any_of
            ):
                normalized.pop("anyOf")
            contextual_conditional = {
                key: normalized[key] for key in ("if", "then", "else") if key in normalized
            }
            if contextual_conditional and schema_is_vacuous_for_domains(
                contextual_conditional, applicable_domains, reference_stack
            ):
                normalized.pop("if", None)
                normalized.pop("then", None)
                normalized.pop("else", None)
        if "const" in normalized and "enum" not in normalized:
            normalized["enum"] = [normalized.pop("const")]
        if isinstance(normalized.get("enum"), list):
            normalized["enum"] = sorted(
                normalized["enum"],
                key=lambda value: json.dumps(value, sort_keys=True, separators=(",", ":")),
            )
        return json.dumps(
            {
                key: normalized_schema_equivalence_signature(value, reference_stack)
                for key, value in sorted(normalized.items())
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    def schema_is_statically_true(
        schema: object,
        reference_stack: frozenset[str] = frozenset(),
    ) -> bool:
        if schema is True or schema == {}:
            return True
        if not isinstance(schema, dict):
            return False
        annotation_keywords = {
            "title",
            "description",
            "deprecated",
            "readOnly",
            "writeOnly",
            "$comment",
        }
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = schema.get(reference_keyword)
            structural_siblings = set(schema) - annotation_keywords - {reference_keyword}
            if (
                isinstance(reference, str)
                and reference not in reference_stack
                and not structural_siblings
                and schema_is_statically_true(
                    resolve_reference(reference), reference_stack | {reference}
                )
            ):
                return True
        structural_keywords = set(schema) - annotation_keywords
        if structural_keywords == {"not"} and schema_is_statically_false(
            schema["not"], reference_stack
        ):
            return True
        all_of = schema.get("allOf")
        if (
            structural_keywords == {"allOf"}
            and isinstance(all_of, list)
            and all(schema_is_statically_true(child, reference_stack) for child in all_of)
        ):
            return True
        any_of = schema.get("anyOf")
        return (
            structural_keywords == {"anyOf"}
            and isinstance(any_of, list)
            and any(schema_is_statically_true(child, reference_stack) for child in any_of)
        )

    def schema_is_statically_false(
        schema: object,
        reference_stack: frozenset[str] = frozenset(),
    ) -> bool:
        if schema is False:
            return True
        if not isinstance(schema, dict):
            return False
        possible_type_domains = schema_possible_type_domains(schema, reference_stack)
        if not possible_type_domains:
            return True
        if "const" in schema:
            try:
                if not jsonschema_rs.is_valid(schema, schema["const"]):
                    return True
            except (TypeError, ValueError):
                pass
        enum = schema.get("enum")
        if isinstance(enum, list) and enum:
            try:
                if not any(jsonschema_rs.is_valid(schema, value) for value in enum):
                    return True
            except (TypeError, ValueError):
                pass
        lower_bounds = []
        if isinstance(schema.get("minimum"), (int, float)) and not isinstance(
            schema["minimum"], bool
        ):
            lower_bounds.append((schema["minimum"], False))
        if isinstance(schema.get("exclusiveMinimum"), (int, float)) and not isinstance(
            schema["exclusiveMinimum"], bool
        ):
            lower_bounds.append((schema["exclusiveMinimum"], True))
        upper_bounds = []
        if isinstance(schema.get("maximum"), (int, float)) and not isinstance(
            schema["maximum"], bool
        ):
            upper_bounds.append((schema["maximum"], False))
        if isinstance(schema.get("exclusiveMaximum"), (int, float)) and not isinstance(
            schema["exclusiveMaximum"], bool
        ):
            upper_bounds.append((schema["exclusiveMaximum"], True))
        if (
            possible_type_domains <= {"integer", "noninteger-number"}
            and lower_bounds
            and upper_bounds
        ):
            lower_value = max(value for value, _exclusive in lower_bounds)
            upper_value = min(value for value, _exclusive in upper_bounds)
            lower_exclusive = any(
                exclusive for value, exclusive in lower_bounds if value == lower_value
            )
            upper_exclusive = any(
                exclusive for value, exclusive in upper_bounds if value == upper_value
            )
            if lower_value > upper_value or (
                lower_value == upper_value and (lower_exclusive or upper_exclusive)
            ):
                return True
        for minimum_keyword, maximum_keyword, applicable_domains in (
            ("minLength", "maxLength", {"string"}),
            ("minItems", "maxItems", {"array"}),
            ("minProperties", "maxProperties", {"object"}),
            ("minContains", "maxContains", {"array"}),
        ):
            minimum = schema.get(minimum_keyword)
            maximum = schema.get(maximum_keyword)
            if (
                isinstance(minimum, int)
                and not isinstance(minimum, bool)
                and isinstance(maximum, int)
                and not isinstance(maximum, bool)
                and minimum > maximum
                and possible_type_domains <= applicable_domains
                and (minimum_keyword != "minContains" or "contains" in schema)
            ):
                return True
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = schema.get(reference_keyword)
            if (
                isinstance(reference, str)
                and reference not in reference_stack
                and schema_is_statically_false(
                    resolve_reference(reference), reference_stack | {reference}
                )
            ):
                return True
        negated = schema.get("not")
        if negated in ({}, True) or (
            "not" in schema and schema_is_statically_true(negated, reference_stack)
        ):
            return True
        if (
            "const" in schema
            and isinstance(negated, dict)
            and "const" in negated
            and jsonschema_rs.is_valid({"const": negated["const"]}, schema["const"])
        ):
            return True
        if schema.get("enum") == []:
            return True
        any_of = schema.get("anyOf")
        if isinstance(any_of, list) and (
            not any_of
            or all(schema_is_statically_false(child, reference_stack) for child in any_of)
        ):
            return True
        one_of = schema.get("oneOf")
        live_one_of = (
            [child for child in one_of if not schema_is_statically_false(child, reference_stack)]
            if isinstance(one_of, list)
            else []
        )
        if isinstance(one_of, list) and (
            not one_of
            or all(schema_is_statically_false(child, reference_stack) for child in one_of)
            or sum(schema_is_statically_true(child, reference_stack) for child in one_of) > 1
            or len(live_one_of) > 1
            and len({normalized_schema_equivalence_signature(child) for child in live_one_of}) == 1
        ):
            return True
        all_of = schema.get("allOf")
        if not isinstance(all_of, list):
            return False
        if any(schema_is_statically_false(child, reference_stack) for child in all_of):
            return True
        declared_types = [
            {value} if isinstance(value, str) else set(value)
            for child in all_of
            if isinstance(child, dict)
            for value in [child.get("type")]
            if isinstance(value, str)
            or isinstance(value, list)
            and all(isinstance(item, str) for item in value)
        ]
        if len(declared_types) < 2:
            return False
        compatible_types = declared_types[0]
        for candidate_types in declared_types[1:]:
            intersection = compatible_types & candidate_types
            if "integer" in compatible_types and "number" in candidate_types:
                intersection.add("integer")
            if "number" in compatible_types and "integer" in candidate_types:
                intersection.add("integer")
            compatible_types = intersection
        return not compatible_types

    def explicitly_named_sensitive_fields(
        schema: object,
        sensitive_fields: set[str] | frozenset[str],
        reference_stack: frozenset[str] = frozenset(),
        *,
        negated: bool = False,
    ) -> set[str]:
        if not isinstance(schema, dict):
            return set()
        found = set()
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = schema.get(reference_keyword)
            if isinstance(reference, str) and reference not in reference_stack:
                found.update(
                    explicitly_named_sensitive_fields(
                        resolve_reference(reference),
                        sensitive_fields,
                        reference_stack | {reference},
                        negated=negated,
                    )
                )
        properties = schema.get("properties")
        if isinstance(properties, dict):
            found.update(
                str(name)
                for name, property_schema in properties.items()
                if str(name) in sensitive_fields
                and (
                    (not negated and not schema_is_statically_false(property_schema))
                    or (negated and property_schema is not True)
                )
            )
        required = schema.get("required")
        if isinstance(required, list) and (not negated or len(required) > 1):
            found.update(str(name) for name in required if str(name) in sensitive_fields)
        for keyword in ("dependentRequired", "dependentSchemas"):
            dependencies = schema.get(keyword)
            if isinstance(dependencies, dict):
                found.update(str(name) for name in dependencies if str(name) in sensitive_fields)
                if keyword == "dependentRequired":
                    found.update(
                        str(name)
                        for names in dependencies.values()
                        if isinstance(names, list)
                        for name in names
                        if str(name) in sensitive_fields
                    )
        patterns = schema.get("patternProperties")
        if isinstance(patterns, dict):
            for pattern, pattern_schema in patterns.items():
                if schema_is_statically_false(pattern_schema):
                    continue
                if property_name_pattern_is_generic(str(pattern)):
                    continue
                try:
                    found.update(
                        field for field in sensitive_fields if re.search(str(pattern), field)
                    )
                except re.error as error:
                    raise ValueError(
                        f"invalid OpenAPI patternProperties regex: {pattern}"
                    ) from error
        property_names = schema.get("propertyNames")
        if property_names is not None:
            explicitly_targeted_names = {
                field
                for field in sensitive_fields
                if name_schema_mentions_sensitive_field(property_names, field)
            }
            unclassified_name_schema = not property_name_schema_is_generic(
                property_names
            ) and not property_name_schema_is_literal_selector(property_names)
            found.update(
                field
                for field in sensitive_fields
                if (unclassified_name_schema or field in explicitly_targeted_names)
                and (
                    property_name_schema_accepts(property_names, field)
                    if not negated
                    else not property_name_schema_accepts(property_names, field)
                )
            )
        discriminator = schema.get("discriminator")
        if isinstance(discriminator, dict) and isinstance(discriminator.get("propertyName"), str):
            found.add(discriminator["propertyName"])
        children: list[object] = []
        for keyword in ("properties", "patternProperties", "dependentSchemas"):
            value = schema.get(keyword)
            if isinstance(value, dict):
                children.extend(value.values())
        for keyword in (
            "items",
            "contains",
            "contentSchema",
            "additionalProperties",
            "unevaluatedItems",
            "unevaluatedProperties",
            "if",
            "then",
            "else",
        ):
            children.append(schema.get(keyword))
        for keyword in ("prefixItems", "anyOf"):
            value = schema.get(keyword)
            if isinstance(value, list):
                children.extend(value)
        for child in children:
            found.update(
                explicitly_named_sensitive_fields(
                    child,
                    sensitive_fields,
                    reference_stack,
                    negated=negated,
                )
            )
        if negated and "if" in schema:
            then_fields = explicitly_named_sensitive_fields(
                schema.get("then"),
                sensitive_fields,
                reference_stack,
                negated=False,
            )
            else_fields = explicitly_named_sensitive_fields(
                schema.get("else"),
                sensitive_fields,
                reference_stack,
                negated=False,
            )
            found.update(then_fields ^ else_fields)
        all_of = schema.get("allOf")
        if isinstance(all_of, list):
            for child in all_of:
                found.update(
                    explicitly_named_sensitive_fields(
                        child,
                        sensitive_fields,
                        reference_stack,
                        negated=False if negated and len(all_of) > 1 else negated,
                    )
                )
        one_of = schema.get("oneOf")
        if isinstance(one_of, list):
            for child in one_of:
                found.update(
                    explicitly_named_sensitive_fields(
                        child,
                        sensitive_fields,
                        reference_stack,
                        negated=False if negated and len(one_of) > 1 else negated,
                    )
                )
        if "not" in schema:
            found.update(
                explicitly_named_sensitive_fields(
                    schema["not"],
                    sensitive_fields,
                    reference_stack,
                    negated=not negated,
                )
            )
        return found & set(sensitive_fields)

    def effective(node: object, reference_stack: frozenset[str]) -> list[frozenset[str]]:
        if not isinstance(node, dict):
            return []
        properties = node.get("properties")
        own_fields = (
            frozenset(
                str(name)
                for name, child in properties.items()
                if not schema_is_statically_false(child)
            )
            if isinstance(properties, dict)
            else frozenset()
        )
        variants = [own_fields]
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = node.get(reference_keyword)
            if not isinstance(reference, str):
                continue
            if reference in reference_stack:
                continue
            variants = combine(
                variants,
                effective(resolve_reference(reference), reference_stack | {reference}),
            )
        all_of = node.get("allOf")
        if isinstance(all_of, list):
            for member in all_of:
                variants = combine(variants, effective(member, reference_stack))
        one_of = node.get("oneOf")
        if isinstance(one_of, list):
            choices = [fields for member in one_of for fields in effective(member, reference_stack)]
            variants = combine(variants, choices)
        any_of = node.get("anyOf")
        if isinstance(any_of, list):
            choices = [fields for member in any_of for fields in effective(member, reference_stack)]
            if choices:
                choices.append(frozenset().union(*choices))
            variants = combine(variants, choices)
        return list(dict.fromkeys(variants))

    def collect_schema(
        node: object,
        context: frozenset[str],
        location: tuple[str, ...],
        reference_stack: frozenset[str] = frozenset(),
        aggregate_fields: set[str] | None = None,
    ) -> None:
        if not isinstance(node, dict):
            return
        if schema_is_statically_false(node, reference_stack):
            return
        if aggregate_fields is None:
            aggregate_fields = set()
        title = node.get("title")
        if isinstance(title, str):
            context = context | {f"title:{title}"}
        context = frozenset(
            value for value in context if not value.startswith("schema-location:")
        ) | {schema_location(location)}
        contracts = projection_contracts(node, reference_stack)
        context = (
            context
            | {f"projection:{projection}" for projection in contracts}
            | {
                f"projection-closed:{projection}"
                for projection, closed in contracts.items()
                if closed
            }
        )
        dynamic_sensitive_fields = set()
        sensitive_fields = FORBIDDEN_CUSTOMER_BACKUP_FIELDS | PROVENANCE_REQUIRED_OPENAPI_FIELDS
        properties = node.get("properties")
        explicit_fields = set().union(*effective(node, reference_stack))
        dynamic_names = explicitly_named_sensitive_fields(node, sensitive_fields)
        if node.get("additionalProperties") is not False or isinstance(
            node.get("patternProperties"), dict
        ):
            dynamic_sensitive_fields.update((dynamic_names - explicit_fields) & sensitive_fields)
        context = context | {f"dynamic-sensitive:{field}" for field in dynamic_sensitive_fields}
        identity = (id(node), context, location, id(aggregate_fields))
        if identity in collected_schemas:
            return
        collected_schemas.add(identity)
        if dynamic_sensitive_fields:
            records.add((frozenset(), context))
        if isinstance(properties, dict):
            aggregate_fields.update(
                str(name)
                for name, child in properties.items()
                if not schema_is_statically_false(child)
            )
        if not contains_alternative_composition(node, reference_stack):
            records.update(
                (fields, context) for fields in effective(node, reference_stack) if fields
            )

        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = node.get(reference_keyword)
            if not isinstance(reference, str) or reference in reference_stack:
                continue
            collect_schema(
                resolve_reference(reference),
                context | {f"reference:{reference}"},
                location,
                reference_stack | {reference},
                aggregate_fields,
            )

        for keyword in ("properties", "patternProperties", "dependentSchemas"):
            children = node.get(keyword)
            if isinstance(children, dict):
                for child_name, child in children.items():
                    collect_schema(
                        child,
                        context | {f"{keyword}:{child_name}"},
                        location + (keyword, str(child_name)),
                        reference_stack,
                        aggregate_fields,
                    )
        for keyword in (
            "items",
            "contains",
            "contentSchema",
            "additionalProperties",
            "unevaluatedItems",
            "unevaluatedProperties",
        ):
            child = node.get(keyword)
            if isinstance(child, dict):
                collect_schema(
                    child,
                    context | {f"schema:{keyword}"},
                    location + (keyword,),
                    reference_stack,
                    aggregate_fields,
                )
        for keyword in ("then", "else"):
            child = node.get(keyword)
            if isinstance(child, dict):
                branch_fields = set(aggregate_fields)
                collect_schema(
                    child,
                    context | {f"schema:{keyword}"},
                    location,
                    reference_stack,
                    branch_fields,
                )
                if branch_fields:
                    records.add((frozenset(branch_fields), context | {f"aggregate:{keyword}"}))
        for keyword in ("prefixItems", "allOf"):
            children = node.get(keyword)
            if isinstance(children, list):
                for child in children:
                    collect_schema(
                        child,
                        context | {f"schema:{keyword}"},
                        location,
                        reference_stack,
                        aggregate_fields,
                    )
        any_of = node.get("anyOf")
        if isinstance(any_of, list):
            combined_fields = set(aggregate_fields)
            combined_markers: set[str] = set()
            has_registered_projection = any(
                marker in OPENAPI_PROJECTION_POLICIES
                for child in any_of
                for marker in projection_markers(child, reference_stack)
            )
            unsafe_alternatives = has_registered_projection and not any_of_is_statically_exclusive(
                any_of
            )
            for child in any_of:
                branch_fields = set(aggregate_fields)
                child_contracts = projection_contracts(child, reference_stack)
                child_markers = frozenset(child_contracts)
                combined_markers.update(child_markers)
                branch_context = (
                    context
                    | {"schema:anyOf"}
                    | ({"projection-alternatives-unsafe"} if unsafe_alternatives else set())
                    | {f"projection:{projection}" for projection in child_markers}
                    | {
                        f"projection-closed:{projection}"
                        for projection, closed in child_contracts.items()
                        if closed
                    }
                )
                collect_schema(
                    child,
                    branch_context,
                    location,
                    reference_stack,
                    branch_fields,
                )
                combined_fields.update(branch_fields)
                if branch_fields:
                    records.add(
                        (frozenset(branch_fields), branch_context | {"aggregate:anyOf-branch"})
                    )
            if combined_fields and not any_of_is_statically_exclusive(any_of):
                combined_context = (
                    context
                    | {"aggregate:anyOf"}
                    | {f"projection:{projection}" for projection in combined_markers}
                )
                records.add((frozenset(combined_fields), combined_context))
        one_of = node.get("oneOf")
        if isinstance(one_of, list):
            has_registered_projection = any(
                marker in OPENAPI_PROJECTION_POLICIES
                for child in one_of
                for marker in projection_markers(child, reference_stack)
            )
            unsafe_alternatives = has_registered_projection and not any_of_is_statically_exclusive(
                one_of
            )
            for child in one_of:
                branch_fields = set(aggregate_fields)
                child_contracts = projection_contracts(child, reference_stack)
                branch_context = (
                    context
                    | {"schema:oneOf"}
                    | ({"projection-alternatives-unsafe"} if unsafe_alternatives else set())
                    | {f"projection:{projection}" for projection in child_contracts}
                    | {
                        f"projection-closed:{projection}"
                        for projection, closed in child_contracts.items()
                        if closed
                    }
                )
                collect_schema(
                    child,
                    branch_context,
                    location,
                    reference_stack,
                    branch_fields,
                )
                if branch_fields:
                    records.add((frozenset(branch_fields), branch_context | {"aggregate:oneOf"}))

    def walk_openapi(node: object, context: frozenset[str], location: tuple[str, ...]) -> None:
        if isinstance(node, list):
            for index, item in enumerate(node):
                walk_openapi(item, context, location + (str(index),))
            return
        if not isinstance(node, dict):
            return
        operation_id = node.get("operationId")
        if isinstance(operation_id, str):
            context = context | {f"operation:{operation_id}"}
        node_identity = (id(node), context, location)
        if node_identity in walked_objects:
            return
        walked_objects.add(node_identity)
        for reference_keyword in ("$ref", "$dynamicRef"):
            reference = node.get(reference_keyword)
            if isinstance(reference, str):
                walk_openapi(
                    resolve_reference(reference),
                    context | {f"reference:{reference}"},
                    location,
                )
        for key, value in node.items():
            if key in {"$ref", "$dynamicRef", "example", "examples"} or key.startswith("x-"):
                continue
            if key == "schema":
                aggregate_fields: set[str] = set()
                contracts = projection_contracts(value)
                schema_context = (
                    context
                    | {f"projection:{projection}" for projection in contracts}
                    | {
                        f"projection-closed:{projection}"
                        for projection, closed in contracts.items()
                        if closed
                    }
                    | {schema_location(location + (str(key),))}
                )
                collect_schema(
                    value,
                    schema_context,
                    location + (str(key),),
                    aggregate_fields=aggregate_fields,
                )
                if aggregate_fields:
                    records.add((frozenset(aggregate_fields), schema_context | {"aggregate:root"}))
            else:
                walk_openapi(value, context, location + (str(key),))

    for path, path_item in document["paths"].items():
        walk_openapi(path_item, frozenset({f"path:{path}"}), ("paths", str(path)))
    webhooks = document.get("webhooks")
    if webhooks is not None and not isinstance(webhooks, dict):
        raise ValueError("OpenAPI webhooks must be a mapping")
    for webhook, path_item in (webhooks or {}).items():
        walk_openapi(
            path_item,
            frozenset({f"webhook:{webhook}"}),
            ("webhooks", str(webhook)),
        )
    return sorted(records, key=lambda item: (len(item[0]), sorted(item[0]), sorted(item[1])))


def reachable_openapi_property_sets(openapi_source: str) -> list[frozenset[str]]:
    """Return distinct effective object fields reachable only through schema positions."""
    return sorted(
        {fields for fields, _context in reachable_openapi_schema_records(openapi_source)},
        key=lambda fields: (len(fields), sorted(fields)),
    )


def replace_clause(source: str, clause: str, replacement: str) -> str:
    pattern = re.compile(r"\s+".join(re.escape(word) for word in clause.split()))
    changed, count = pattern.subn(replacement, source, count=1)
    assert count == 1, f"mutation clause is not unique or absent: {clause!r}"
    return changed


def replace_in_section(source: str, heading: str, old: str, new: str, *, count: int = 1) -> str:
    body = section(source, heading)
    assert body.count(old) == count, (
        f"mutation anchor count for {heading!r} is {body.count(old)}, expected {count}: {old!r}"
    )
    changed_body = body.replace(old, new, count)
    start = source.index(body)
    return source[:start] + changed_body + source[start + len(body) :]


def replace_in_table(source: str, heading: str, label: str, old: str, new: str) -> str:
    body = section(source, heading)
    header = f"| {f'`{label}` field' if label != 'Field' else 'Field'} | Type | Notes |"
    table_start = body.index(header)
    table_end = body.find("\n\n", table_start)
    if table_end == -1:
        table_end = len(body)
    table = body[table_start:table_end]
    assert table.count(old) == 1, (
        f"mutation anchor count for {heading}/{label} is {table.count(old)}, expected 1: {old!r}"
    )
    changed_table = table.replace(old, new, 1)
    changed_body = body[:table_start] + changed_table + body[table_end:]
    start = source.index(body)
    return source[:start] + changed_body + source[start + len(body) :]


def replace_in_source_table(source: str, table_name: str, old: str, new: str) -> str:
    named_header = f"| `{table_name}` field | Type | Notes |"
    if named_header not in source:
        return replace_in_table(source, table_name, "Field", old, new)
    table_start = source.index(named_header)
    table_end = source.find("\n\n", table_start)
    if table_end == -1:
        table_end = len(source)
    table = source[table_start:table_end]
    assert table.count(old) == 1
    return source[:table_start] + table.replace(old, new, 1) + source[table_end:]


def replace_clause_in_section(source: str, heading: str, clause: str, replacement: str) -> str:
    body = section(source, heading)
    pattern = re.compile(r"\s+".join(re.escape(word) for word in clause.split()))
    changed_body, count = pattern.subn(replacement, body, count=1)
    assert count == 1, f"mutation clause is absent from {heading}: {clause!r}"
    start = source.index(body)
    return source[:start] + changed_body + source[start + len(body) :]


def lifetime_scope_refusals(model: str, state_machine: str) -> list[str]:
    notes = table_fields(model, "OrderedCancellationCleanup")[
        "bootstrap_snapshot_ref`, `bootstrap_scope_sha256"
    ][1]
    refusals = []
    if LIFETIME_BOOTSTRAP_SCOPE not in notes:
        refusals.append("cleanup manifest must contain every lifetime bootstrap without exception")
    if T21_LIFETIME_SCOPE not in normalized(state_machine):
        refusals.append("T21 must require every historical provider boundary without exception")
    return refusals


def manifest_schema_refusals(source: str) -> list[str]:
    certificate = normalized(section(source, "DeletionCertificate"))
    refusals = []
    if FIELDS_STAR_DEFINITION not in certificate:
        refusals.append("fields-star normative definition is missing or weakened")
    for table_name, (branch, cardinality) in MANIFEST_SOURCE_ROWS.items():
        fields = source_table_fields(source, table_name)
        if not fields:
            refusals.append(f"{table_name}: normative source table is empty")
        marker = f"`{table_name} = {{ cardinality = {cardinality}, fields = * }}`"
        branch_marker = f"- `{branch}` contains"
        branch_start = certificate.find(branch_marker)
        marker_at = certificate.find(marker)
        next_branch = certificate.find(" - `", branch_start + len(branch_marker))
        if (
            branch_start == -1
            or marker_at < branch_start
            or (next_branch != -1 and marker_at >= next_branch)
        ):
            refusals.append(
                f"{table_name}: {branch} must include cardinality={cardinality}, fields=*"
            )
    refusals.extend(project_bootstrap_projection_refusals(source))
    refusals.extend(identity_closure_projection_refusals(source))
    refusals.extend(identity_capture_projection_refusals(source))
    return refusals


def project_bootstrap_projection_refusals(
    source: str, expected_projection_fields: set[str] | None = None
) -> list[str]:
    certificate = normalized(section(source, "DeletionCertificate"))
    refusals = []
    if PROJECT_BOOTSTRAP_PROJECTION_RULE not in certificate:
        refusals.append("ProjectBootstrap: exhaustive projection rule is missing")
    pattern = re.compile(
        r"`ProjectBootstrap = \{ cardinality = every_lifetime_row, include = \[(.*?)\], "
        r"exclude = \[(.*?)\] \}`"
    )
    match = pattern.search(certificate)
    if match is None:
        return refusals + ["ProjectBootstrap: evidence projection declaration is missing"]
    included_items = [item.strip() for item in match.group(1).split(",") if item.strip()]
    excluded_items = [item.strip() for item in match.group(2).split(",") if item.strip()]
    included = set(included_items)
    excluded = set(excluded_items)
    source_fields = expanded_field_names(source_table_fields(source, "ProjectBootstrap"))
    overlap = included & excluded
    unclassified = source_fields - included - excluded
    unknown = (included | excluded) - source_fields
    if len(included_items) != len(included) or len(excluded_items) != len(excluded):
        refusals.append("ProjectBootstrap: duplicate projection classification")
    if overlap:
        refusals.append("ProjectBootstrap: fields classified as both evidence and excluded")
    if unclassified:
        refusals.append(
            "ProjectBootstrap: unclassified source fields: " + ", ".join(sorted(unclassified))
        )
    if unknown:
        refusals.append(
            "ProjectBootstrap: projection names unknown source fields: "
            + ", ".join(sorted(unknown))
        )
    if excluded != PROJECT_BOOTSTRAP_EXCLUDED_FIELDS:
        refusals.append("ProjectBootstrap: only secret_ref may be excluded")
    expected = (
        PROJECT_BOOTSTRAP_PROJECTION_FIELDS
        if expected_projection_fields is None
        else expected_projection_fields
    )
    if included != expected:
        refusals.append(
            "ProjectBootstrap: evidence projection changed without classification review"
        )
    return refusals


def identity_capture_projection_refusals(
    source: str,
    expected_source_fields: set[str] | None = None,
    expected_derivations: dict[str, str] | None = None,
) -> list[str]:
    certificate = normalized(section(source, "DeletionCertificate"))
    refusals = []
    pattern = re.compile(
        r"`IdentityBackupCapture = \{ cardinality = every_through_cutoff, include = \[(.*?)\], "
        r"derive = \[(.*?)\], exclude = \[(.*?)\] \}`"
    )
    match = pattern.search(certificate)
    if match is None:
        return ["IdentityBackupCapture: evidence projection declaration is missing"]
    included_items = [item.strip() for item in match.group(1).split(",") if item.strip()]
    included = set(included_items)
    derived = {}
    derived_sources = []
    derived_destinations = []
    for item in (part.strip() for part in match.group(2).split(",") if part.strip()):
        pieces = [piece.strip() for piece in item.split("->")]
        if len(pieces) != 2:
            refusals.append("IdentityBackupCapture: malformed derivation")
            continue
        derived_sources.append(pieces[0])
        derived_destinations.append(pieces[1])
        derived[pieces[0]] = pieces[1]
    excluded_items = [item.strip() for item in match.group(3).split(",") if item.strip()]
    excluded = set(excluded_items)
    source_fields = expanded_field_names(source_table_fields(source, "IdentityBackupCapture"))
    classified = included | set(derived) | excluded
    overlap = (included & set(derived)) | (included & excluded) | (set(derived) & excluded)
    if len(included_items) != len(included) or len(excluded_items) != len(excluded):
        refusals.append("IdentityBackupCapture: duplicate projection classification")
    if len(derived_sources) != len(set(derived_sources)):
        refusals.append("IdentityBackupCapture: duplicate derivation source")
    if len(derived_destinations) != len(set(derived_destinations)):
        refusals.append("IdentityBackupCapture: duplicate derivation destination")
    if any(
        not destination.startswith("salted_") and destination != "closing_realm_included"
        for destination in derived_destinations
    ):
        refusals.append("IdentityBackupCapture: unsafe raw derivation destination")
    if overlap:
        refusals.append("IdentityBackupCapture: source fields have overlapping classifications")
    if source_fields - classified:
        refusals.append(
            "IdentityBackupCapture: unclassified source fields: "
            + ", ".join(sorted(source_fields - classified))
        )
    if classified - source_fields:
        refusals.append(
            "IdentityBackupCapture: projection names unknown source fields: "
            + ", ".join(sorted(classified - source_fields))
        )
    if included != IDENTITY_CAPTURE_INCLUDED_FIELDS:
        refusals.append("IdentityBackupCapture: raw evidence include set changed")
    expected_derived = (
        IDENTITY_CAPTURE_DERIVED_FIELDS if expected_derivations is None else expected_derivations
    )
    if derived != expected_derived:
        refusals.append("IdentityBackupCapture: safe derivation map changed")
    if excluded:
        refusals.append("IdentityBackupCapture: source evidence may not be silently excluded")
    for label, (clause, _replacement) in IDENTITY_CAPTURE_PROJECTION_RULES.items():
        if clause not in certificate:
            refusals.append(f"IdentityBackupCapture projection rule missing: {label}")
    expected = source_fields if expected_source_fields is None else expected_source_fields
    if classified != expected:
        refusals.append("IdentityBackupCapture: projection classification changed")
    return refusals


def identity_closure_projection_refusals(
    source: str,
    expected_source_fields: set[str] | None = None,
    expected_derivations: dict[str, str] | None = None,
) -> list[str]:
    certificate = normalized(section(source, "DeletionCertificate"))
    pattern = re.compile(
        r"`IdentityBackupClosure = \{ cardinality = exactly_one, include = \[(.*?)\], "
        r"derive = \[(.*?)\], exclude = \[(.*?)\] \}`"
    )
    match = pattern.search(certificate)
    if match is None:
        return ["IdentityBackupClosure: evidence projection declaration is missing"]
    included_items = [item.strip() for item in match.group(1).split(",") if item.strip()]
    excluded_items = [item.strip() for item in match.group(3).split(",") if item.strip()]
    derived_items = [item.strip() for item in match.group(2).split(",") if item.strip()]
    included = set(included_items)
    excluded = set(excluded_items)
    pairs = []
    refusals = []
    for item in derived_items:
        pieces = tuple(piece.strip() for piece in item.split("->"))
        if len(pieces) != 2:
            refusals.append("IdentityBackupClosure: malformed derivation")
            continue
        pairs.append(pieces)
    sources = [source_name for source_name, _destination in pairs]
    destinations = [destination for _source_name, destination in pairs]
    derived = dict(pairs)
    if len(included_items) != len(included) or len(excluded_items) != len(excluded):
        refusals.append("IdentityBackupClosure: duplicate projection classification")
    if len(sources) != len(set(sources)):
        refusals.append("IdentityBackupClosure: duplicate derivation source")
    if len(destinations) != len(set(destinations)):
        refusals.append("IdentityBackupClosure: duplicate derivation destination")
    if any(not destination.startswith("salted_") for destination in destinations):
        refusals.append("IdentityBackupClosure: unsafe raw derivation destination")
    overlap = (included & set(sources)) | (included & excluded) | (set(sources) & excluded)
    if overlap:
        refusals.append("IdentityBackupClosure: source fields have overlapping classifications")
    source_fields = expanded_field_names(source_table_fields(source, "IdentityBackupClosure"))
    classified = included | set(sources) | excluded
    if source_fields - classified:
        refusals.append(
            "IdentityBackupClosure: unclassified source fields: "
            + ", ".join(sorted(source_fields - classified))
        )
    if classified - source_fields:
        refusals.append(
            "IdentityBackupClosure: projection names unknown source fields: "
            + ", ".join(sorted(classified - source_fields))
        )
    if included != IDENTITY_CLOSURE_INCLUDED_FIELDS:
        refusals.append("IdentityBackupClosure: raw evidence include set changed")
    expected_derived = (
        IDENTITY_CLOSURE_DERIVED_FIELDS if expected_derivations is None else expected_derivations
    )
    if derived != expected_derived:
        refusals.append("IdentityBackupClosure: safe derivation map changed")
    if excluded:
        refusals.append("IdentityBackupClosure: source evidence may not be silently excluded")
    if IDENTITY_CLOSURE_RAW_AUTHORITY_RULE not in certificate:
        refusals.append("IdentityBackupClosure: raw authorities are not proven exact-scope")
    expected = source_fields if expected_source_fields is None else expected_source_fields
    if classified != expected:
        refusals.append("IdentityBackupClosure: projection classification changed")
    return refusals


def cleanup_actor_refusals(source: str) -> list[str]:
    fields = table_fields(source, "OrderedCancellationCleanup")
    body = normalized(section(source, "OrderedCancellationCleanup"))
    refusals = []
    for name, expected_type in CLEANUP_ACTOR_FIELDS.items():
        row = fields.get(name)
        if row is None or row[0] != expected_type or "immutable" not in row[1].lower():
            refusals.append(f"{name}: immutable cancellation actor field is missing")
    for label, (clause, _replacement) in CLEANUP_ACTOR_REQUIREMENTS.items():
        if clause not in body:
            refusals.append(f"cleanup actor requirement missing: {label}")
    return refusals


def retention_clock_refusals(source: str) -> list[str]:
    refusals = []
    for (heading, label), expected_fields in RETENTION_CLOCK_FIELDS.items():
        fields = table_fields(source, heading, label)
        for name, expected_type in expected_fields.items():
            row = fields.get(name)
            if row is None or row[0] != expected_type:
                refusals.append(f"{heading}/{label}.{name}: retention anchor field is missing")
    for (heading, label), expected_fields in RETENTION_ROW_ANCHORS.items():
        fields = table_fields(source, heading, label)
        for name, required_note in expected_fields.items():
            row = fields.get(name)
            if row is None or normalized(required_note) != normalized(row[1]):
                refusals.append(f"{heading}/{label}.{name}: exact retention anchor is wrong")
    compact = normalized(source)
    for label, (clause, _replacement) in RETENTION_ANCHOR_REQUIREMENTS.items():
        if clause not in compact:
            refusals.append(f"retention anchor requirement missing: {label}")
    return refusals


def payment_link_refusals(source: str) -> list[str]:
    fields = table_fields(source, "Payment and PaymentLink", "PaymentLink")
    refusals = []
    row = fields.get("deleted_at`, `purge_after")
    if row is None or row[0] != "timestamptz NULL":
        refusals.append("PaymentLink: operational purge fields are missing")
    compact = normalized(section(source, "Payment and PaymentLink"))
    for label, (clause, _replacement) in PAYMENT_LINK_REQUIREMENTS.items():
        if clause not in compact:
            refusals.append(f"PaymentLink purge requirement missing: {label}")
    return refusals


def schema_critical_workflow_refusals(source: str) -> list[str]:
    refusals = []
    for (heading, label, field), (
        expected_type,
        expected_notes,
    ) in SCHEMA_CRITICAL_WORKFLOW_FIELDS.items():
        row = table_fields(source, heading, label).get(field)
        if row is None:
            refusals.append(f"{heading}/{label}.{field}: schema-critical field is missing")
        elif row[0] != expected_type or normalized(row[1]) != normalized(expected_notes):
            refusals.append(f"{heading}/{label}.{field}: schema-critical contract is wrong")
    return refusals


def dpa_close_refusals(source: str) -> list[str]:
    compact = normalized(source)
    refusals = []
    fields = table_fields(source, "DpaAcceptance")
    for name, (expected_type, expected_notes) in DPA_CLOSE_FIELDS.items():
        row = fields.get(name)
        if (
            row is None
            or row[0] != expected_type
            or normalized(row[1]) != normalized(expected_notes)
        ):
            refusals.append(f"DpaAcceptance.{name}: durable close proof field is missing")
    for label, (clause, _replacement) in DPA_CLOSE_REQUIREMENTS.items():
        if clause not in compact:
            refusals.append(f"DpaAcceptance close requirement missing: {label}")
    return refusals


def billing_retention_refusals(source: str) -> list[str]:
    compact = normalized(source)
    refusals = []
    for label, (clause, _replacement) in BILLING_RETENTION_REQUIREMENTS.items():
        if clause not in compact:
            refusals.append(f"billing retention requirement missing: {label}")
    return refusals


def credit_note_line_refusals(source: str) -> list[str]:
    fields = table_fields(source, "CreditNoteLine")
    refusals = []
    for name, (expected_type, expected_note) in CREDIT_NOTE_LINE_FIELDS.items():
        row = fields.get(name)
        if row is None:
            refusals.append(f"CreditNoteLine.{name}: required retained field is missing")
        elif row[0] != expected_type:
            refusals.append(f"CreditNoteLine.{name}: wrong type")
        elif normalized(row[1]) != normalized(expected_note):
            refusals.append(f"CreditNoteLine.{name}: wrong source-copy contract")
    unexpected = set(fields) - set(CREDIT_NOTE_LINE_FIELDS)
    if unexpected:
        refusals.append(
            "CreditNoteLine: unclassified retained fields: " + ", ".join(sorted(unexpected))
        )
    if CREDIT_NOTE_LINE_SOURCE_EQUALITY not in normalized(section(source, "CreditNoteLine")):
        refusals.append("CreditNoteLine: exhaustive source equality is missing")
    return refusals


def invoice_issuance_refusals(source: str) -> list[str]:
    refusals = []
    invoice = table_fields(source, "Invoice")
    line = table_fields(source, "InvoiceLine")
    expected = {
        ("Invoice", "number"): "text NULL",
        ("Invoice", "issued_at`, `due_at"): "timestamptz NULL",
        ("Invoice", "accounting_event_at`, `financial_year_closed_at"): "timestamptz NULL",
        ("Invoice", "retained_until`, `purge_after"): "timestamptz NULL",
        ("InvoiceLine", "invoice_number_snapshot"): "text NULL",
        ("InvoiceLine", "accounting_event_at`, `financial_year_closed_at"): "timestamptz NULL",
        ("InvoiceLine", "retained_until`, `purge_after"): "timestamptz NULL",
    }
    tables = {"Invoice": invoice, "InvoiceLine": line}
    for (table, field), expected_type in expected.items():
        row = tables[table].get(field)
        if row is None or row[0] != expected_type:
            refusals.append(f"{table}.{field}: draft-nullable issuance field is wrong")
    compact = normalized(source)
    for label, (clause, _replacement) in INVOICE_ISSUANCE_REQUIREMENTS.items():
        if clause not in compact:
            refusals.append(f"invoice issuance requirement missing: {label}")
    return refusals


def payment_classification_refusals(model: str, billing: str) -> list[str]:
    sources = {
        "model-continuing-finding": normalized(model),
        "billing-terminal-classification": normalized(billing),
        "billing-persistence": normalized(billing),
    }
    return [
        f"payment classification requirement missing: {label}"
        for label, (clause, _replacement) in PAYMENT_CLASSIFICATION_REQUIREMENTS.items()
        if clause not in sources[label]
    ]


def taxonomy_audit_actions(source: str) -> list[str]:
    registry = source[source.index("## 3. Action registry") : source.index("## 4.")]
    actions = []
    for line in registry.splitlines():
        if line.startswith("| `"):
            actions.extend(
                re.findall(r"`([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)`", line.split("|", 2)[1])
            )
    return actions


def openapi_audit_registry(source: str) -> tuple[list[str], bool]:
    try:
        document = load_yaml(source)
    except yaml.YAMLError:
        return [], False
    if not isinstance(document, dict):
        return [], False

    registry_key = "x-audit-action-registry"
    locations: list[tuple[str, ...]] = []

    def visit(value: object, path: tuple[str, ...] = ()) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                child_path = (*path, str(key))
                if key == registry_key:
                    locations.append(child_path)
                visit(child, child_path)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, (*path, str(index)))

    visit(document)
    components = document.get("components")
    registry = components.get(registry_key) if isinstance(components, dict) else None
    actions = registry.get("actions") if isinstance(registry, dict) else None
    valid_location = locations == [("components", registry_key)]
    if not isinstance(actions, list) or not all(isinstance(action, str) for action in actions):
        return [], False
    return actions, valid_location


def openapi_audit_actions(source: str) -> list[str]:
    actions, _valid_location = openapi_audit_registry(source)
    return actions


def taxonomy_audit_actor_types(source: str) -> list[str]:
    row = next(line for line in source.splitlines() if line.startswith("| `actor_type` | enum |"))
    return re.findall(r"`([a-z]+)`", row)


def runtime_audit_actor_types(source: str) -> list[str]:
    match = re.search(r"^ACTOR_TYPES\s*=\s*(\([^\n]+\))$", source, re.MULTILINE)
    assert match is not None, "runtime ACTOR_TYPES declaration is missing"
    values = ast.literal_eval(match.group(1))
    assert isinstance(values, tuple)
    return list(values)


def openapi_audit_actor_contract(source: str) -> tuple[list[str], dict[str, str], bool]:
    try:
        document = load_yaml(source)
        syntax = compose_yaml(source)
    except yaml.YAMLError:
        return [], {}, False
    if not isinstance(document, dict) or syntax is None:
        return [], {}, False

    extension = "x-canonical-audit-actor-map"
    exact_path = (
        "components",
        "schemas",
        "AuditEvent",
        "properties",
        "actor",
        "properties",
        "type",
        extension,
    )
    locations: list[tuple[str, ...]] = []
    mapping_has_duplicate_key = False

    def visit(node: yaml.Node, path: tuple[str, ...] = ()) -> None:
        nonlocal mapping_has_duplicate_key
        if isinstance(node, yaml.MappingNode):
            for key_node, child in node.value:
                key = key_node.value if isinstance(key_node, yaml.ScalarNode) else ""
                child_path = (*path, key)
                if key == extension:
                    locations.append(child_path)
                    if child_path == exact_path and isinstance(child, yaml.MappingNode):
                        mapping_keys = [
                            item.value
                            for item, _value in child.value
                            if isinstance(item, yaml.ScalarNode)
                        ]
                        mapping_has_duplicate_key = len(mapping_keys) != len(set(mapping_keys))
                visit(child, child_path)
        elif isinstance(node, yaml.SequenceNode):
            for index, child in enumerate(node.value):
                visit(child, (*path, str(index)))

    visit(syntax)
    valid_location = locations == [exact_path] and not mapping_has_duplicate_key
    try:
        actor_type = document["components"]["schemas"]["AuditEvent"]["properties"]["actor"][
            "properties"
        ]["type"]
    except (KeyError, TypeError):
        return [], {}, valid_location
    if not isinstance(actor_type, dict):
        return [], {}, valid_location
    wire = actor_type.get("enum")
    mapping_node = actor_type.get(extension)
    if not isinstance(wire, list) or not all(isinstance(item, str) for item in wire):
        return [], {}, valid_location
    if not isinstance(mapping_node, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in mapping_node.items()
    ):
        return wire, {}, valid_location
    if mapping_has_duplicate_key:
        return wire, {}, valid_location
    return wire, dict(mapping_node), valid_location


def audit_workflow_refusals(
    model: str, audit: str, openapi: str, runtime_model: str | None = None
) -> list[str]:
    sources = {
        "model": normalized(model),
        "audit": normalized(audit),
        "openapi": normalized(openapi),
    }
    refusals = [
        f"audit workflow requirement missing: {label}"
        for label, (where, clause, _replacement) in AUDIT_WORKFLOW_REQUIREMENTS.items()
        if normalized(clause) not in sources[where]
    ]
    taxonomy_actions = taxonomy_audit_actions(audit)
    openapi_actions, registry_location_valid = openapi_audit_registry(openapi)
    if not registry_location_valid:
        refusals.append("OpenAPI audit registry is not a valid Components extension")
    if len(taxonomy_actions) != len(set(taxonomy_actions)):
        refusals.append("taxonomy audit registry contains duplicate actions")
    if len(openapi_actions) != len(set(openapi_actions)):
        refusals.append("OpenAPI audit registry contains duplicate actions")
    if set(taxonomy_actions) != set(openapi_actions):
        refusals.append("OpenAPI audit registry differs from the closed taxonomy registry")
    audit_event_at = openapi.find("    AuditEvent:\n")
    action_at = openapi.find("        action:\n", audit_event_at)
    actor_at = openapi.find("        actor:\n", audit_event_at)
    action_body = openapi[action_at:actor_at] if -1 < action_at < actor_at else ""
    if (
        re.search(r"^\s+type: string$", action_body, re.MULTILINE) is None
        or re.search(r"^\s+maxLength: 100$", action_body, re.MULTILINE) is None
        or "$ref:" in action_body
        or "    AuditAction:\n" in openapi
    ):
        refusals.append("AuditEvent.action public wire schema is not the compatible bounded string")
    wire_actors, actor_map, actor_mapping_location_valid = openapi_audit_actor_contract(openapi)
    if not actor_mapping_location_valid:
        refusals.append("OpenAPI audit actor mapping is not the AuditEvent.actor.type extension")
    if len(wire_actors) != len(set(wire_actors)) or set(actor_map) != set(wire_actors):
        refusals.append("OpenAPI audit actor mapping is incomplete or duplicate")
    elif actor_map != WIRE_TO_CANONICAL_AUDIT_ACTORS:
        refusals.append("OpenAPI audit actor mapping differs from the compatibility contract")
    else:
        mapped_actors = [actor_map[value] for value in wire_actors]
        taxonomy_actors = taxonomy_audit_actor_types(audit)
        runtime_actors = runtime_audit_actor_types(
            RUNTIME_AUDIT_MODEL.read_text(encoding="utf-8")
            if runtime_model is None
            else runtime_model
        )
        if len(taxonomy_actors) != len(set(taxonomy_actors)):
            refusals.append("taxonomy audit actor vocabulary contains duplicates")
        if len(runtime_actors) != len(set(runtime_actors)):
            refusals.append("runtime audit actor vocabulary contains duplicates")
        if set(mapped_actors) != set(taxonomy_actors):
            refusals.append("mapped OpenAPI actors differ from the taxonomy vocabulary")
        if set(mapped_actors) != set(runtime_actors):
            refusals.append("mapped OpenAPI actors differ from runtime ACTOR_TYPES")
    if TAXONOMY_ACTOR_MAPPING_CLAUSE not in normalized(audit):
        refusals.append("taxonomy audit actor compatibility mapping prose is missing")
    if TAXONOMY_AUDIT_REGISTRY_RUNTIME_BOUNDARY not in normalized(audit):
        refusals.append("taxonomy audit registry runtime boundary is missing")
    if OPENAPI_ACTOR_MAPPING_DESCRIPTION not in normalized(openapi):
        refusals.append("OpenAPI audit actor compatibility description is missing")
    if OPENAPI_AUDIT_REGISTRY_RUNTIME_BOUNDARY not in normalized(openapi):
        refusals.append("OpenAPI audit registry runtime boundary is missing")
    if OPENAPI_AUDIT_ACTION_RUNTIME_BOUNDARY not in normalized(openapi):
        refusals.append("OpenAPI audit action runtime boundary is missing")
    return refusals


def backup_projection_refusals(source: str) -> list[str]:
    compact = normalized(source)
    refusals = []
    if BACKUP_PROJECTION_REQUIREMENT not in compact:
        refusals.append(
            "backup policy must use the minimized per-organisation certificate projection"
        )
    for label, (clause, _replacement) in BACKUP_SOURCE_LIFECYCLE_REQUIREMENTS.items():
        if clause not in compact:
            refusals.append(f"backup raw identity lifecycle requirement missing: {label}")
    for label, (clause, _replacement) in BACKUP_CLOCK_REQUIREMENTS.items():
        if clause not in compact:
            refusals.append(f"backup clock requirement missing: {label}")
    return refusals


def identity_generation_refusals(source: str) -> list[str]:
    fields = source_table_fields(source, "IdentityBackupGeneration")
    refusals = []
    catalogue_fields = source_table_fields(source, "IdentityBackupCatalogueState")
    if catalogue_fields != IDENTITY_CATALOGUE_STATE_FIELDS:
        refusals.append("IdentityBackupCatalogueState: exact lifetime marker schema is wrong")
    for name, expected in IDENTITY_GENERATION_FIELDS.items():
        if fields.get(name) != expected:
            refusals.append(f"IdentityBackupGeneration.{name}: exact state/clock contract is wrong")
    capture_generation = source_table_fields(source, "IdentityBackupCapture").get("generation_id")
    if capture_generation != IDENTITY_CAPTURE_GENERATION_FIELD:
        refusals.append(
            "IdentityBackupCapture.generation_id: exact open-generation binding contract is wrong"
        )
    return refusals


def identity_closure_uniqueness_refusals(source: str) -> list[str]:
    organisation = source_table_fields(source, "IdentityBackupClosure").get("organisation_id")
    expected = (
        "UUIDv7, not FK, UNIQUE",
        "Immutable organisation snapshot; `UNIQUE` permits at most one in-flight closure and the "
        "non-FK field does not block organisation purge",
    )
    if organisation != expected:
        return [
            "IdentityBackupClosure.organisation_id: exact in-flight uniqueness contract is wrong"
        ]
    return []


def organisation_scope_anchor_refusals(
    source: str,
    anchors: dict[str, tuple[str, str]] | None = None,
) -> list[str]:
    """Validate non-null FK/snapshot authority and resolve every scoped path to Organisation."""
    anchor_map = ORGANISATION_SCOPE_ANCHORS if anchors is None else anchors
    refusals = []
    resolved_targets = {}
    for table_name, (field_name, expected_parent) in anchor_map.items():
        contract = source_anchor_contract(source, table_name, field_name)
        if contract is None:
            refusals.append(f"{table_name}: organisation scope anchor {field_name} is missing")
            continue
        field_type, notes = contract
        if "NULL" in field_type:
            refusals.append(f"{table_name}.{field_name}: scope anchor must be non-null")
        target_matches = re.findall(
            r"\bFK\s+(?:`([^`]+)`|([A-Z][A-Za-z0-9]+))",
            field_type,
        )
        explicit_targets = [quoted or bare for quoted, bare in target_matches]
        if explicit_targets and set(explicit_targets) != {expected_parent}:
            refusals.append(
                f"{table_name}.{field_name}: scope anchor targets {explicit_targets}, "
                f"not {expected_parent}"
            )
        if expected_parent == "Organisation":
            is_fk = re.search(r"(?<!not )\bFK\b", field_type) is not None
            normalized_notes = notes.lower()
            is_snapshot = "UUID" in field_type and all(
                word in normalized_notes for word in ("immutable", "snapshot", "organisation")
            )
            if not (is_fk or is_snapshot):
                refusals.append(
                    f"{table_name}.{field_name}: direct scope is neither an Organisation FK "
                    "nor an immutable UUID snapshot"
                )
            if is_fk and not explicit_targets:
                refusals.append(
                    f"{table_name}.{field_name}: direct FK scope anchor does not declare its "
                    "Organisation target"
                )
        else:
            if re.search(r"(?<!not )\bFK\b", field_type) is None:
                refusals.append(
                    f"{table_name}.{field_name}: indirect scope anchor is not an FK to "
                    f"{expected_parent}"
                )
            if not explicit_targets:
                refusals.append(
                    f"{table_name}.{field_name}: indirect scope anchor does not declare its "
                    f"{expected_parent} target"
                )
        if explicit_targets:
            resolved_targets[table_name] = explicit_targets[0]
        elif expected_parent == "Organisation" and is_snapshot:
            resolved_targets[table_name] = "Organisation"

    for table_name in anchor_map:
        seen = set()
        current = table_name
        while current != "Organisation":
            if current in seen:
                refusals.append(f"{table_name}: organisation scope anchor path contains a cycle")
                break
            seen.add(current)
            target = resolved_targets.get(current)
            if target is None:
                refusals.append(
                    f"{table_name}: organisation scope anchor path does not reach Organisation"
                )
                break
            if (
                target
                in (
                    set(GLOBAL_CATALOGUE_ROWS)
                    | set(MODEL_ROOT_ROWS)
                    | set(NON_PERSISTED_MODEL_PROJECTIONS)
                    | set(MIXED_SCOPE_MODEL_ROWS)
                    | set(SYSTEM_GLOBAL_STAFF_CONTROL_ROWS)
                    | set(SYSTEM_ONLY_GLOBAL_CONTROL_EVIDENCE_ROWS)
                )
                and target != "Organisation"
            ):
                refusals.append(
                    f"{table_name}: organisation scope anchor terminates at global or nullable "
                    f"{target}"
                )
                break
            current = target
    return refusals


def global_control_evidence_refusals(
    source: str,
    openapi: str | None = None,
    audit: str | None = None,
) -> list[str]:
    compact = normalized(source)
    refusals = []
    if ORGANISATION_SCOPING_CONVENTION not in compact:
        refusals.append(
            "organisation-scoping convention does not name global control/evidence rows"
        )

    match = re.search(
        r"System-only global control/evidence rows are exactly (.*?); none has a customer API/queryset",
        compact,
    )
    listed = tuple(re.findall(r"`([^`]+)`", match.group(1))) if match else ()
    if listed != SYSTEM_ONLY_GLOBAL_CONTROL_EVIDENCE_ROWS:
        refusals.append("system-only global control/evidence row list is not exact")
    if GLOBAL_CONTROL_ACCESS_CLAUSE not in compact:
        refusals.append("global control/evidence access classification is wrong")
    if (
        GLOBAL_CATALOGUE_CLAUSE not in compact
        or MODEL_ROOT_CLAUSE not in compact
        or NON_PERSISTED_MODEL_PROJECTION_CLAUSE not in compact
        or MIXED_SCOPE_CLAUSE not in compact
        or SYSTEM_GLOBAL_STAFF_CONTROL_CLAUSE not in compact
    ):
        refusals.append("global catalogue and model-root exceptions are not exact")
    if MODEL_REFLECTION_CLAUSE not in compact:
        refusals.append("new-table scope reflection requirement is missing")

    classified_tables = set(
        GLOBAL_CATALOGUE_ROWS
        + MODEL_ROOT_ROWS
        + NON_PERSISTED_MODEL_PROJECTIONS
        + MIXED_SCOPE_MODEL_ROWS
        + SYSTEM_GLOBAL_STAFF_CONTROL_ROWS
        + ORGANISATION_SCOPED_MODEL_ROWS
        + SYSTEM_ONLY_GLOBAL_CONTROL_EVIDENCE_ROWS
    )
    reflected_tables = set(source_table_names(source))
    if reflected_tables != classified_tables:
        refusals.append("normative model tables are not exhaustively scope-classified")
    if set(ORGANISATION_SCOPE_ANCHORS) != set(ORGANISATION_SCOPED_MODEL_ROWS):
        refusals.append("organisation-scoped table anchors are not exhaustive")
    refusals.extend(organisation_scope_anchor_refusals(source))

    identity_fields = source_table_fields(source, "Identity")
    if identity_fields.get("organisation_id") != IDENTITY_MIXED_SCOPE_FIELD:
        refusals.append("Identity.organisation_id: exact tenant/staff scope field is wrong")
    if IDENTITY_SCOPE_ENFORCEMENT_CLAUSE not in compact:
        refusals.append("Identity: feasible tenant/staff scope enforcement is missing")
    staff_role_fields = source_table_fields(source, "StaffRole")
    if staff_role_fields.get("identity_id") != STAFF_ROLE_IDENTITY_FIELD:
        refusals.append("StaffRole.identity_id: exact staff-identity authority is wrong")
    if staff_role_fields.get("realm") != STAFF_ROLE_REALM_FIELD:
        refusals.append("StaffRole.realm: exact system-global staff realm is wrong")

    incident_fields = source_table_fields(source, "Incident")
    expected_incident_fields = {
        "scope": ("enum", "`platform` \\| `tenant`"),
        "organisation_id": ("FK `Organisation` NULL", "Null when `scope = platform`"),
        "tenant_id": ("FK `Tenant` NULL", "Set when `scope = tenant`"),
    }
    for field_name, expected in expected_incident_fields.items():
        if incident_fields.get(field_name) != expected:
            refusals.append(f"Incident.{field_name}: mixed-scope field contract is wrong")
    if INCIDENT_SCOPE_CHECK_CLAUSE not in compact:
        refusals.append("Incident: exact platform/tenant scope check is missing")
    maintenance_fields = source_table_fields(source, "MaintenanceWindow")
    for field_name, expected in MAINTENANCE_MIXED_SCOPE_FIELDS.items():
        if maintenance_fields.get(field_name) != expected:
            refusals.append(f"MaintenanceWindow.{field_name}: mixed-scope field contract is wrong")
    if MAINTENANCE_SCOPE_CLAUSE not in compact:
        refusals.append("MaintenanceWindow: exact organisation/tenant/fleet scope rule is missing")
    secret_fields = source_table_fields(source, "Secret")
    if secret_fields.get("tenant_id") != SECRET_FLEET_SCOPE_FIELD:
        refusals.append("Secret.tenant_id: exact tenant/fleet scope field is wrong")
    if "organisation_id" in secret_fields:
        refusals.append("Secret: undocumented organisation scope is forbidden")

    audit_source = AUDIT_TAXONOMY.read_text(encoding="utf-8") if audit is None else audit
    audit_compact = normalized(audit_source)
    audit_scope_row = (
        "| `organisation_id` | UUIDv7 NULL | The organisation the event concerns; null only for "
        "fleet-level events |"
    )
    if normalized(audit_scope_row) not in audit_compact:
        refusals.append("AuditEvent.organisation_id: exact organisation/fleet scope field is wrong")
    if AUDIT_SCOPE_RUNTIME_GAP not in audit_compact:
        refusals.append("AuditEvent: honest organisation/fleet scope runtime gap is missing")

    for table_name in SYSTEM_ONLY_GLOBAL_CONTROL_EVIDENCE_ROWS:
        if "organisation_id" in source_table_fields(source, table_name):
            refusals.append(f"{table_name}: global control/evidence row is organisation-scoped")
    if "organisation_id" not in source_table_fields(source, "IdentityBackupClosure"):
        refusals.append("IdentityBackupClosure: organisation-scoped classification is missing")
    if GLOBAL_CONTROL_OPTIONAL_ER_PROVENANCE not in source:
        refusals.append(
            "catalogue-state optional bootstrap provenance is missing from the ER diagram"
        )
    if GLOBAL_CONTROL_FALSE_LIFETIME_ER_EDGE in source:
        refusals.append(
            "catalogue-state ER provenance falsely requires the initial generation forever"
        )
    if OPENAPI_PROJECTION_POLICY_CLAUSE not in compact:
        refusals.append("customer OpenAPI projection provenance policy is missing")
    openapi_source = OPENAPI.read_text(encoding="utf-8") if openapi is None else openapi
    try:
        reachable_schemas = reachable_openapi_schema_records(openapi_source)
    except (ValueError, yaml.YAMLError) as error:
        refusals.append(f"customer OpenAPI cannot be inspected: {error}")
    else:
        for label, signature in FORBIDDEN_CUSTOMER_BACKUP_SCHEMA_SIGNATURES.items():
            minimum_raw_fields = max(2, len(signature) - 1)
            if any(
                len(signature & properties) >= minimum_raw_fields
                for properties, _context in reachable_schemas
            ):
                refusals.append(
                    f"customer OpenAPI exposes a complete or near-complete raw identity-backup "
                    f"{label} row"
                )
        exposed_fields = sorted(
            set().union(*(properties for properties, _context in reachable_schemas))
            & FORBIDDEN_CUSTOMER_BACKUP_FIELDS
        )
        if exposed_fields:
            refusals.append(
                "customer OpenAPI exposes raw identity-backup fields: " + ", ".join(exposed_fields)
            )
        dynamic_sensitive_fields = sorted(
            {
                value.removeprefix("dynamic-sensitive:")
                for _properties, context in reachable_schemas
                for value in context
                if value.startswith("dynamic-sensitive:")
            }
        )
        if dynamic_sensitive_fields:
            refusals.append(
                "customer OpenAPI dynamically exposes sensitive identity-backup fields: "
                + ", ".join(dynamic_sensitive_fields)
            )
        for properties, context in reachable_schemas:
            projection_markers = {
                value.removeprefix("projection:")
                for value in context
                if value.startswith("projection:")
            }
            if len(projection_markers) > 1:
                refusals.append("customer OpenAPI schema has conflicting projection provenance")
                continue
            projection = next(iter(projection_markers), None)
            if projection is not None:
                policy = OPENAPI_PROJECTION_POLICIES.get(projection)
                if policy is None:
                    refusals.append(
                        f"customer OpenAPI schema uses unknown projection provenance: {projection}"
                    )
                elif not properties <= policy["fields"]:
                    refusals.append(
                        f"customer OpenAPI projection {projection} exceeds its field allowlist"
                    )
                elif policy["exact"] and properties != policy["fields"]:
                    refusals.append(
                        f"customer OpenAPI projection {projection} does not match its exact field "
                        "set"
                    )
                else:
                    operations = {
                        value.removeprefix("operation:")
                        for value in context
                        if value.startswith("operation:")
                    }
                    surfaces = {
                        value for value in context if value.startswith(("path:", "webhook:"))
                    }
                    bindings = {
                        (operation, surface) for operation in operations for surface in surfaces
                    }
                    if not bindings or not bindings <= policy["bindings"]:
                        refusals.append(
                            f"customer OpenAPI projection {projection} is outside its exact "
                            "operation/surface binding"
                        )
                    locations = {value for value in context if value.startswith("schema-location:")}
                    if len(locations) != 1 or not locations <= policy["locations"]:
                        refusals.append(
                            f"customer OpenAPI projection {projection} is outside its structural "
                            "location"
                        )
                    elif "projection-alternatives-unsafe" in context:
                        refusals.append(
                            f"customer OpenAPI projection {projection} has an unsafe alternative "
                            "sibling"
                        )
                    elif f"projection-closed:{projection}" not in context:
                        refusals.append(
                            f"customer OpenAPI projection {projection} is not a closed required "
                            "object"
                        )
            elif properties & PROVENANCE_REQUIRED_OPENAPI_FIELDS:
                refusals.append(
                    "customer OpenAPI schema uses provenance-required fields without a registered "
                    "projection: "
                    + ", ".join(sorted(properties & PROVENANCE_REQUIRED_OPENAPI_FIELDS))
                )
    return refusals


def cleanup_closure_interleaving_loses_selected_source(*, common_reservation: bool) -> bool:
    capture_exists = True
    cleanup_completed_final_recheck = True
    if common_reservation:
        capture_exists = False
        closure_selected_capture = capture_exists
    else:
        assert cleanup_completed_final_recheck
        closure_selected_capture = capture_exists
        capture_exists = False
    return closure_selected_capture and not capture_exists


def registration_closure_interleaving(
    *,
    registration_started_first: bool,
    registration_holds_shared: bool = True,
    refuse_non_open_insert: bool = True,
    final_source_recheck: bool = True,
) -> tuple[str, bool, bool]:
    """Return registration outcome, cutoff membership, and evidence-loss status."""
    old_generation_state = "open"
    old_generation_captures: set[str] = set()

    if registration_started_first:
        bound_generation = "old"
        if registration_holds_shared:
            old_generation_captures.add("capture")
            old_generation_state = "draining"
            sealed_sources = set(old_generation_captures)
            outcome = "committed-old"
        else:
            old_generation_state = "draining"
            sealed_sources = set(old_generation_captures)
            if refuse_non_open_insert and old_generation_state != "open":
                outcome = "refused-stale"
            else:
                old_generation_captures.add("capture")
                outcome = "committed-old"
            if final_source_recheck:
                sealed_sources = set(old_generation_captures)
    else:
        old_generation_state = "draining"
        sealed_sources = set(old_generation_captures)
        bound_generation = "next"
        outcome = "committed-next"

    assert old_generation_state == "draining"
    capture_is_through_cutoff = bound_generation == "old" and outcome == "committed-old"
    capture_is_in_sealed_sources = "capture" in sealed_sources
    evidence_lost = capture_is_through_cutoff and not capture_is_in_sealed_sources
    return outcome, capture_is_in_sealed_sources, evidence_lost


def unique_open_index_accepts(
    generation_states: tuple[str, ...], *, enforce_partial_unique: bool = True
) -> bool:
    if not enforce_partial_unique:
        return True
    return generation_states.count("open") <= 1


def capture_registration_accepts_generation(
    *,
    open_generations: tuple[int, ...],
    target_generation: int,
    require_unique_current_head: bool = True,
) -> bool:
    if require_unique_current_head:
        return len(open_generations) == 1 and target_generation == open_generations[0]
    return target_generation in open_generations


def generation_rotation_is_valid(
    *,
    old_open_generations: tuple[int, ...],
    transitioned_to_draining: tuple[int, ...],
    created_open_generations: tuple[int, ...],
    commit_cardinality_rule: str = "exactly-one",
) -> bool:
    if len(old_open_generations) != 1:
        return False
    if transitioned_to_draining != old_open_generations:
        return False
    if any(generation <= old_open_generations[0] for generation in created_open_generations):
        return False
    remaining_old_open = set(old_open_generations) - set(transitioned_to_draining)
    final_open = remaining_old_open | set(created_open_generations)
    if commit_cardinality_rule == "at-most-one":
        return len(final_open) <= 1
    if commit_cardinality_rule == "at-least-one":
        return len(final_open) >= 1
    assert commit_cardinality_rule == "exactly-one"
    return len(created_open_generations) == 1 and final_open == {created_open_generations[0]}


def catalogue_initializer_allowed(
    *,
    marker_exists: bool,
    existing_states: tuple[str, ...],
    holds_catalogue_exclusive: bool,
    write_marker: bool = True,
    write_open_head: bool = True,
    inserted_head: tuple[str, int] = ("head-1", 1),
    marker_head: tuple[str, int] = ("head-1", 1),
    require_exclusive: bool = True,
    require_marker_absent: bool = True,
    require_atomic_pair: bool = True,
    require_marker_head_match: bool = True,
) -> bool:
    if require_exclusive and not holds_catalogue_exclusive:
        return False
    if require_marker_absent and marker_exists:
        return False
    if existing_states:
        return False
    if require_marker_head_match and marker_head != inserted_head:
        return False
    if require_atomic_pair:
        return write_marker and write_open_head
    return write_marker or write_open_head


def catalogue_marker_mutation_allowed(operation: str, *, enforce_immutable: bool = True) -> bool:
    if not enforce_immutable:
        return True
    return operation == "insert"


def catalogue_state_insert_allowed(
    *,
    existing_keys: tuple[str, ...],
    candidate_key: str,
    singleton_check: str = "exact",
) -> bool:
    if candidate_key in existing_keys:
        return False
    if singleton_check == "removed":
        return True
    if singleton_check == "widened":
        return candidate_key.startswith("identity-backup-")
    assert singleton_check == "exact"
    return candidate_key == "identity-backup-catalogue"


def generation_cleanup_allowed(
    *,
    candidate_generation: int,
    candidate_state_at_lock: str,
    candidate_state_at_recheck: str,
    head_at_lock: int | None,
    head_at_recheck: int | None,
    captures_at_lock: int = 0,
    captures_at_recheck: int = 0,
    closures_at_lock: int = 0,
    closures_at_recheck: int = 0,
    unfinalized_cutoff_at_lock: bool = False,
    unfinalized_cutoff_at_recheck: bool = False,
    holds_catalogue_exclusive: bool = True,
    require_exclusive: bool = True,
    require_sealed_non_head: bool = True,
    require_stable_head_and_state: bool = True,
    use_final_child_recheck: bool = True,
) -> bool:
    if require_exclusive and not holds_catalogue_exclusive:
        return False
    if require_stable_head_and_state and (
        head_at_lock != head_at_recheck or candidate_state_at_lock != candidate_state_at_recheck
    ):
        return False
    if require_sealed_non_head and (
        candidate_state_at_recheck != "sealed"
        or head_at_recheck is None
        or candidate_generation == head_at_recheck
    ):
        return False
    if use_final_child_recheck:
        captures = captures_at_recheck
        closures = closures_at_recheck
        has_unfinalized_cutoff = unfinalized_cutoff_at_recheck
    else:
        captures = captures_at_lock
        closures = closures_at_lock
        has_unfinalized_cutoff = unfinalized_cutoff_at_lock
    return captures == 0 and closures == 0 and not has_unfinalized_cutoff


def backup_clock_outcome(
    *,
    accepted_expiries: tuple[int, ...],
    no_write_proofs: tuple[bool, ...],
    trusted_completion: int | None,
    old_non_empty_manifest_rule: bool = False,
) -> tuple[int | None, bool]:
    locked_until = max(accepted_expiries) if accepted_expiries else None
    if old_non_empty_manifest_rule and no_write_proofs and not accepted_expiries:
        return None, False
    finalizable = (
        trusted_completion is not None
        and all(no_write_proofs)
        and (locked_until is None or trusted_completion >= locked_until)
    )
    return locked_until, finalizable


class CatalogueSplitFixture(TypedDict):
    marker_exists: bool
    existing_states: tuple[str, ...]
    holds_catalogue_exclusive: bool
    write_marker: bool
    write_open_head: bool


class CatalogueAuthorityFixture(TypedDict):
    marker_exists: bool
    existing_states: tuple[str, ...]
    holds_catalogue_exclusive: bool
    inserted_head: tuple[str, int]
    marker_head: tuple[str, int]


class GenerationCleanupFixture(TypedDict):
    candidate_generation: int
    candidate_state_at_lock: str
    candidate_state_at_recheck: str
    head_at_lock: int | None
    head_at_recheck: int | None
    holds_catalogue_exclusive: NotRequired[bool]
    captures_at_recheck: NotRequired[int]
    closures_at_recheck: NotRequired[int]
    unfinalized_cutoff_at_recheck: NotRequired[bool]


class GenerationCleanupLateReference(TypedDict, total=False):
    captures_at_recheck: int
    closures_at_recheck: int
    unfinalized_cutoff_at_recheck: bool


class BackupClockFixture(TypedDict):
    accepted_expiries: tuple[int, ...]
    no_write_proofs: tuple[bool, ...]
    trusted_completion: int | None


def identity_source_lifecycle_refusals(source: str) -> list[str]:
    compact = normalized(source)
    refusals = [
        f"raw identity lifecycle requirement missing: {label}"
        for label, (clause, _replacement) in IDENTITY_SOURCE_LIFECYCLE_REQUIREMENTS.items()
        if clause not in compact
    ]
    refusals.extend(identity_generation_refusals(source))
    refusals.extend(identity_closure_uniqueness_refusals(source))
    refusals.extend(global_control_evidence_refusals(source))
    return refusals


def certificate_refusals(source: str) -> list[str]:
    certificate = section(source, "DeletionCertificate")
    fields = table_fields(source, "DeletionCertificate")
    refusals = []
    for name, (expected_type, _source) in CERTIFICATE_SNAPSHOT_FIELDS.items():
        row = fields.get(name)
        if row is None:
            refusals.append(f"{name}: permanent evidence snapshot is missing")
            continue
        actual_type, notes = row
        if actual_type != expected_type:
            refusals.append(
                f"{name}: permanent evidence must use {expected_type}, not {actual_type}"
            )
        if "immutable non-fk" not in notes.lower() or "snapshot" not in notes.lower():
            refusals.append(f"{name}: snapshot immutability and non-FK ownership are not explicit")

    foreign_key_fields = sorted(name for name, (kind, _notes) in fields.items() if FK.search(kind))
    if foreign_key_fields:
        refusals.append(
            "DeletionCertificate retains foreign-key reachability through "
            + ", ".join(foreign_key_fields)
        )

    for name in ("finalization_evidence_manifest_ref", "finalization_evidence_sha256"):
        row = fields.get(name)
        if row is None or row[0] != "text" or "required" not in row[1].lower():
            refusals.append(f"{name}: permanent required finalization evidence field is missing")

    if fields.get("backups_locked_until") != DELETION_CERTIFICATE_BACKUP_CLOCK_FIELD:
        refusals.append("backups_locked_until: exact accepted-object clock contract is wrong")

    compact = normalized(certificate)
    if LOCKED_SOURCE_CLAUSE not in compact:
        refusals.append("certificate snapshots are not validated against locked source rows")
    if PURGED_OBLIGATION_CLAUSE not in compact:
        refusals.append("finalized operational obligations are not purged after the evidence copy")
    for label, (clause, _replacement) in FINALIZATION_REQUIREMENTS.items():
        if clause not in compact:
            refusals.append(f"finalization manifest requirement missing: {label}")
    for label, (clause, _replacement) in BRANCH_REQUIREMENTS.items():
        if clause not in compact:
            refusals.append(f"finalization branch requirement missing: {label}")
    for label, (clause, _replacement) in MODEL_BACKUP_CLOCK_REQUIREMENTS.items():
        if clause not in normalized(source):
            refusals.append(f"certificate backup clock requirement missing: {label}")
    refusals.extend(manifest_schema_refusals(source))
    return refusals


def legal_retention_refusals(source: str) -> list[str]:
    refusals = []
    for table, expected_fields in LEGAL_AUTHORITY_FIELDS.items():
        heading, label = table
        fields = table_fields(source, heading, label)
        fk_fields = sorted(name for name, (kind, _notes) in fields.items() if FK.search(kind))
        if fk_fields:
            refusals.append(f"{heading}/{label}: retained foreign keys: {', '.join(fk_fields)}")
        for name, (expected_type, _target) in expected_fields.items():
            row = fields.get(name)
            if row is None:
                refusals.append(f"{heading}/{label}.{name}: authority snapshot is missing")
                continue
            actual_type, notes = row
            if actual_type != expected_type:
                refusals.append(
                    f"{heading}/{label}.{name}: must use {expected_type}, not {actual_type}"
                )
            lowered = notes.lower()
            if "immutable non-fk" not in lowered or not (
                "snapshot" in lowered or "pseudonym" in lowered
            ):
                refusals.append(f"{heading}/{label}.{name}: detached immutable snapshot is unclear")

    for evidence_table, evidence_fields in LEGAL_EVIDENCE_FIELDS.items():
        heading, label = evidence_table
        fields = table_fields(source, heading, label)
        for name, expected_type in evidence_fields.items():
            row = fields.get(name)
            if row is None:
                refusals.append(f"{heading}/{label}.{name}: required legal snapshot is missing")
                continue
            actual_type, notes = row
            if actual_type != expected_type or not any(
                marker in notes.lower() for marker in ("immutable", "frozen")
            ):
                refusals.append(f"{heading}/{label}.{name}: legal snapshot is not immutable")
    payment_fields = table_fields(source, "Payment and PaymentLink", "Payment")
    for name, expected_type in PAYMENT_ALLOCATION_FIELDS.items():
        row = payment_fields.get(name)
        if row is None or row[0] != expected_type:
            refusals.append(f"Payment.{name}: allocation evidence field is missing")
    compact = normalized(source)
    for label, (clause, _replacement) in LEGAL_WRITE_GUARDS.items():
        if clause not in compact:
            refusals.append(f"legal write guard missing: {label}")
    return refusals


def audit_retention_refusals(source: str) -> list[str]:
    body = normalized(section(source, "AuditEvent"))
    refusals = []
    for field, clause in AUDIT_SNAPSHOT_REQUIREMENTS.items():
        if clause not in body:
            refusals.append(f"AuditEvent.{field}: detached immutable snapshot is missing")
    if AUDIT_NO_RESTRICT_PATH not in body:
        refusals.append("AuditEvent: default-RESTRICT path prohibition is missing")
    return refusals


def test_permanent_finalization_evidence_has_no_clocked_foreign_key_reachability() -> None:
    assert certificate_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_long_lived_legal_records_have_no_subject_or_operational_foreign_key() -> None:
    assert legal_retention_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_retained_audit_evidence_has_no_subject_or_operational_foreign_key() -> None:
    assert audit_retention_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_finalization_manifest_covers_every_normative_source_row() -> None:
    assert manifest_schema_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_ordered_cleanup_records_actor_and_verifier_separation() -> None:
    assert cleanup_actor_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_retained_evidence_has_explicit_legal_clock_anchors() -> None:
    assert retention_clock_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_payment_link_cannot_delay_retained_invoice_purge() -> None:
    assert payment_link_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_dpa_issued_content_is_append_only_with_one_audited_close() -> None:
    assert dpa_close_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_billing_retention_policy_matches_the_detached_legal_rows() -> None:
    assert billing_retention_refusals(BILLING_MODEL.read_text(encoding="utf-8")) == []


def test_credit_note_line_is_schema_and_source_copy_complete() -> None:
    assert credit_note_line_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_invoice_draft_to_issued_transition_is_complete_and_atomic() -> None:
    assert invoice_issuance_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_schema_critical_billing_workflow_fields_are_exact() -> None:
    assert schema_critical_workflow_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_succeeded_payment_classification_is_terminal_and_persistent() -> None:
    assert (
        payment_classification_refusals(
            MODEL.read_text(encoding="utf-8"), BILLING_MODEL.read_text(encoding="utf-8")
        )
        == []
    )


def test_payment_and_dpa_decisions_use_the_closed_audit_registry() -> None:
    assert (
        audit_workflow_refusals(
            MODEL.read_text(encoding="utf-8"),
            AUDIT_TAXONOMY.read_text(encoding="utf-8"),
            OPENAPI.read_text(encoding="utf-8"),
        )
        == []
    )


@pytest.mark.parametrize(
    "action", ("dpa.contract_closed", "payment.placed_on_account", "payment.allocated")
)
def test_each_new_decision_action_is_required_in_openapi_closed_registry(action: str) -> None:
    model = MODEL.read_text(encoding="utf-8")
    audit = AUDIT_TAXONOMY.read_text(encoding="utf-8")
    openapi = OPENAPI.read_text(encoding="utf-8")
    mutant = openapi.replace(f"      - {action}\n", "", 1)
    assert "OpenAPI audit registry differs from the closed taxonomy registry" in (
        audit_workflow_refusals(model, audit, mutant)
    )


def test_audit_event_action_wire_schema_must_remain_a_bounded_string() -> None:
    model = MODEL.read_text(encoding="utf-8")
    audit = AUDIT_TAXONOMY.read_text(encoding="utf-8")
    openapi = OPENAPI.read_text(encoding="utf-8")
    mutant = openapi.replace(
        "        action:\n          type: string\n          maxLength: 100",
        "        action:\n          type: string\n          maxLength: 1000",
        1,
    )
    assert "AuditEvent.action public wire schema is not the compatible bounded string" in (
        audit_workflow_refusals(model, audit, mutant)
    )


def test_duplicate_openapi_audit_registry_action_is_caught() -> None:
    model = MODEL.read_text(encoding="utf-8")
    audit = AUDIT_TAXONOMY.read_text(encoding="utf-8")
    openapi = OPENAPI.read_text(encoding="utf-8")
    mutant = openapi.replace(
        "      - payment.allocated\n",
        "      - payment.allocated\n      - payment.allocated\n",
        1,
    )
    assert "OpenAPI audit registry contains duplicate actions" in audit_workflow_refusals(
        model, audit, mutant
    )


def test_missing_openapi_audit_registry_is_caught_without_parser_failure() -> None:
    model = MODEL.read_text(encoding="utf-8")
    audit = AUDIT_TAXONOMY.read_text(encoding="utf-8")
    openapi = OPENAPI.read_text(encoding="utf-8")
    start = openapi.index("  x-audit-action-registry:\n")
    end = openapi.index("  securitySchemes:\n")
    mutant = openapi[:start] + openapi[end:]
    assert "OpenAPI audit registry differs from the closed taxonomy registry" in (
        audit_workflow_refusals(model, audit, mutant)
    )


@pytest.mark.parametrize("location", ("schemas", "root"))
def test_audit_registry_relocation_outside_components_extension_is_caught(location: str) -> None:
    model = MODEL.read_text(encoding="utf-8")
    audit = AUDIT_TAXONOMY.read_text(encoding="utf-8")
    openapi = OPENAPI.read_text(encoding="utf-8")
    start = openapi.index("  x-audit-action-registry:\n")
    end = openapi.index("  securitySchemes:\n")
    block = openapi[start:end]
    without_registry = openapi[:start] + openapi[end:]
    if location == "schemas":
        relocated = "\n".join(f"  {line}" if line else line for line in block.splitlines())
        mutant = without_registry.replace("  schemas:\n", f"  schemas:\n{relocated}\n", 1)
    else:
        relocated = "\n".join(
            line[2:] if line.startswith("  ") else line for line in block.splitlines()
        )
        mutant = without_registry.replace("components:\n", f"{relocated}\n\ncomponents:\n", 1)
    assert "OpenAPI audit registry is not a valid Components extension" in (
        audit_workflow_refusals(model, audit, mutant)
    )


@pytest.mark.parametrize("location", ("actor", "properties", "root"))
def test_actor_mapping_relocation_outside_actor_type_extension_is_caught(location: str) -> None:
    model = MODEL.read_text(encoding="utf-8")
    audit = AUDIT_TAXONOMY.read_text(encoding="utf-8")
    openapi = OPENAPI.read_text(encoding="utf-8")
    exact = (
        "              x-canonical-audit-actor-map: "
        "{ user: tenant, staff: staff, agent: agent, system: system }\n"
    )
    mutant = openapi.replace(exact, "", 1)
    relocated = exact.lstrip()
    audit_event_at = mutant.index("    AuditEvent:\n")
    actor_at = mutant.index("        actor:\n", audit_event_at)
    properties_at = mutant.index("          properties:\n", actor_at)
    if location == "actor":
        mutant = mutant[:properties_at] + "          " + relocated + mutant[properties_at:]
    elif location == "properties":
        insert_at = properties_at + len("          properties:\n")
        mutant = mutant[:insert_at] + "            " + relocated + mutant[insert_at:]
    else:
        components_at = mutant.index("components:\n")
        mutant = mutant[:components_at] + relocated + mutant[components_at:]
    assert "OpenAPI audit actor mapping is not the AuditEvent.actor.type extension" in (
        audit_workflow_refusals(model, audit, mutant)
    )


def test_actor_mapping_exact_path_accepts_equivalent_block_yaml() -> None:
    model = MODEL.read_text(encoding="utf-8")
    audit = AUDIT_TAXONOMY.read_text(encoding="utf-8")
    openapi = OPENAPI.read_text(encoding="utf-8")
    mutant = openapi.replace(
        "              x-canonical-audit-actor-map: "
        "{ user: tenant, staff: staff, agent: agent, system: system }",
        "              x-canonical-audit-actor-map:\n"
        "                user: tenant\n"
        "                staff: staff\n"
        "                agent: agent\n"
        "                system: system",
        1,
    )
    assert audit_workflow_refusals(model, audit, mutant) == []


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        (
            "user: tenant, staff: staff",
            "user: staff, staff: staff",
            "OpenAPI audit actor mapping differs from the compatibility contract",
        ),
        (
            "user: tenant, ",
            "",
            "OpenAPI audit actor mapping is incomplete or duplicate",
        ),
        (
            "user: tenant, staff: staff",
            "user: tenant, user: tenant, staff: staff",
            "OpenAPI audit actor mapping is incomplete or duplicate",
        ),
    ],
)
def test_openapi_actor_compatibility_mapping_is_exact(old: str, new: str, message: str) -> None:
    model = MODEL.read_text(encoding="utf-8")
    audit = AUDIT_TAXONOMY.read_text(encoding="utf-8")
    openapi = OPENAPI.read_text(encoding="utf-8")
    mutant = openapi.replace(old, new, 1)
    assert message in audit_workflow_refusals(model, audit, mutant)


@pytest.mark.parametrize(
    ("source", "clause", "message"),
    [
        (
            "taxonomy",
            TAXONOMY_ACTOR_MAPPING_CLAUSE,
            "taxonomy audit actor compatibility mapping prose is missing",
        ),
        (
            "taxonomy",
            TAXONOMY_AUDIT_REGISTRY_RUNTIME_BOUNDARY,
            "taxonomy audit registry runtime boundary is missing",
        ),
        (
            "openapi",
            OPENAPI_ACTOR_MAPPING_DESCRIPTION,
            "OpenAPI audit actor compatibility description is missing",
        ),
        (
            "openapi",
            OPENAPI_AUDIT_REGISTRY_RUNTIME_BOUNDARY,
            "OpenAPI audit registry runtime boundary is missing",
        ),
        (
            "openapi",
            OPENAPI_AUDIT_ACTION_RUNTIME_BOUNDARY,
            "OpenAPI audit action runtime boundary is missing",
        ),
    ],
)
def test_audit_actor_compatibility_mapping_is_explicitly_documented(
    source: str, clause: str, message: str
) -> None:
    model = MODEL.read_text(encoding="utf-8")
    audit = AUDIT_TAXONOMY.read_text(encoding="utf-8")
    openapi = OPENAPI.read_text(encoding="utf-8")
    if source == "taxonomy":
        audit = replace_clause(audit, clause, "The actor mapping is unspecified")
    else:
        openapi = replace_clause(openapi, clause, "The actor mapping is unspecified")
    assert message in audit_workflow_refusals(model, audit, openapi)


def test_mapped_openapi_actor_vocabulary_must_equal_runtime() -> None:
    model = MODEL.read_text(encoding="utf-8")
    audit = AUDIT_TAXONOMY.read_text(encoding="utf-8")
    openapi = OPENAPI.read_text(encoding="utf-8")
    runtime = RUNTIME_AUDIT_MODEL.read_text(encoding="utf-8").replace(
        '("staff", "tenant", "agent", "system")',
        '("staff", "user", "agent", "system")',
        1,
    )
    assert "mapped OpenAPI actors differ from runtime ACTOR_TYPES" in audit_workflow_refusals(
        model, audit, openapi, runtime
    )


def test_ordered_cancellation_scope_includes_every_lifetime_bootstrap() -> None:
    assert (
        lifetime_scope_refusals(
            MODEL.read_text(encoding="utf-8"), STATE_MACHINE.read_text(encoding="utf-8")
        )
        == []
    )


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in FINALIZATION_REQUIREMENTS.items()],
)
def test_each_finalization_manifest_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause_in_section(source, "DeletionCertificate", clause, replacement)
    assert f"finalization manifest requirement missing: {label}" in certificate_refusals(mutant)


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in BRANCH_REQUIREMENTS.items()],
)
def test_each_finalization_branch_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause_in_section(source, "DeletionCertificate", clause, replacement)
    assert f"finalization branch requirement missing: {label}" in certificate_refusals(mutant)


@pytest.mark.parametrize("table_name", MANIFEST_SOURCE_ROWS)
@pytest.mark.parametrize("mutation", ("remove", "replace"))
def test_each_full_row_manifest_marker_is_independently_required(
    table_name: str, mutation: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    branch, cardinality = MANIFEST_SOURCE_ROWS[table_name]
    marker = f"`{table_name} = {{ cardinality = {cardinality}, fields = * }}`"
    replacement = "" if mutation == "remove" else marker.replace("fields = *", "fields = id")
    mutant = replace_in_section(source, "DeletionCertificate", marker, replacement)
    assert (
        f"{table_name}: {branch} must include cardinality={cardinality}, fields=*"
        in manifest_schema_refusals(mutant)
    )


def test_weakening_the_fields_star_normative_definition_is_caught() -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause_in_section(
        source,
        "DeletionCertificate",
        FIELDS_STAR_DEFINITION,
        "`fields = *` may select currently useful source fields",
    )
    assert "fields-star normative definition is missing or weakened" in manifest_schema_refusals(
        mutant
    )


@pytest.mark.parametrize("table_name", MANIFEST_SOURCE_ROWS)
def test_fields_star_automatically_covers_a_new_normative_source_field(table_name: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    anchor = "| `id` | UUIDv7 | |\n"
    injected = anchor + "| `future_required_proof` | text | Required future proof |\n"
    mutant = replace_in_source_table(source, table_name, anchor, injected)
    assert "future_required_proof" in source_table_fields(mutant, table_name)
    assert manifest_schema_refusals(mutant) == []


def test_identity_capture_projection_is_exhaustive_and_minimized() -> None:
    assert identity_capture_projection_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_identity_closure_projection_is_exhaustive_and_minimized() -> None:
    assert identity_closure_projection_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_backup_policy_uses_the_minimized_customer_projection() -> None:
    assert backup_projection_refusals(BACKUP_AND_RESTORE.read_text(encoding="utf-8")) == []


def test_raw_identity_sources_have_a_bounded_fail_closed_lifecycle() -> None:
    assert identity_source_lifecycle_refusals(MODEL.read_text(encoding="utf-8")) == []


def test_system_only_global_control_evidence_list_is_exact_and_exhaustive() -> None:
    assert global_control_evidence_refusals(MODEL.read_text(encoding="utf-8")) == []


@pytest.mark.parametrize(
    ("replacement", "expected_message"),
    [
        (
            "System-only global control/evidence rows are exactly "
            "`IdentityBackupGeneration` and `IdentityBackupCapture`",
            "system-only global control/evidence row list is not exact",
        ),
        (
            GLOBAL_CONTROL_LIST_CLAUSE + " and `IdentityBackupClosure`",
            "system-only global control/evidence row list is not exact",
        ),
    ],
)
def test_global_control_evidence_list_rejects_omission_and_extra(
    replacement: str, expected_message: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause(source, GLOBAL_CONTROL_LIST_CLAUSE, replacement)
    assert expected_message in global_control_evidence_refusals(mutant)


def test_global_control_evidence_rows_cannot_gain_customer_exposure() -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause(
        source,
        "none has a customer API/queryset",
        "each may have a customer API/queryset",
    )
    refusals = global_control_evidence_refusals(mutant)
    assert "global control/evidence access classification is wrong" in refusals

    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    generation_fields = sorted(FORBIDDEN_CUSTOMER_BACKUP_SCHEMA_SIGNATURES["generation"])
    split = len(generation_fields) // 2
    openapi["components"]["schemas"]["SharedBackupEpochIdentity"] = {
        "type": "object",
        "properties": {field_name: {"type": "string"} for field_name in generation_fields[:split]},
    }
    openapi["components"]["schemas"]["SharedBackupEpochState"] = {
        "type": "object",
        "properties": {field_name: {"type": "string"} for field_name in generation_fields[split:]},
    }
    openapi["components"]["schemas"]["SharedBackupEpoch"] = {
        "allOf": [
            {"$ref": "#/components/schemas/SharedBackupEpochIdentity"},
            {"$ref": "#/components/schemas/SharedBackupEpochState"},
        ]
    }
    openapi["components"]["responses"]["SharedBackupEpochList"] = {
        "description": "Raw internal rows, which are forbidden",
        "content": {
            "application/json": {
                "schema": {
                    "type": "array",
                    "items": {"$ref": "#/components/schemas/SharedBackupEpoch"},
                }
            }
        },
    }
    openapi["paths"]["/shared-backup-epochs"] = {
        "get": {
            "operationId": "listSharedBackupEpochs",
            "responses": {"200": {"$ref": "#/components/responses/SharedBackupEpochList"}},
        }
    }
    exposed_openapi = dump_yaml(openapi, sort_keys=False)
    assert (
        "customer OpenAPI exposes a complete or near-complete raw identity-backup generation row"
    ) in (global_control_evidence_refusals(source, exposed_openapi))


def test_customer_openapi_rejects_partial_raw_identity_backup_capture() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    exposed_fields = {"accepted_object_ref", "accepted_object_version", "realm_slugs"}
    openapi["paths"]["/identity-backup-capture-debug"] = {
        "get": {
            "operationId": "getIdentityBackupCaptureDebug",
            "responses": {
                "200": {
                    "description": "Raw internal capture fields, which are forbidden",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    field_name: {"type": "string"}
                                    for field_name in sorted(exposed_fields)
                                },
                            }
                        }
                    },
                }
            },
        }
    }
    refusals = global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    assert (
        "customer OpenAPI exposes raw identity-backup fields: "
        "accepted_object_ref, accepted_object_version, realm_slugs"
    ) in refusals


def test_customer_openapi_fails_closed_on_external_reference() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/external-schema"] = {
        "get": {
            "operationId": "getExternalSchema",
            "responses": {
                "200": {
                    "description": "Uninspectable schema",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "https://example.invalid/raw-backup.yaml"}
                        }
                    },
                }
            },
        }
    }
    refusals = global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    assert (
        "customer OpenAPI cannot be inspected: external OpenAPI reference is not inspectable: "
        "https://example.invalid/raw-backup.yaml"
    ) in refusals


def test_customer_openapi_rejects_raw_identity_backup_closure_fields() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    exposed_fields = {
        "cutoff_generation",
        "manifest_ref",
        "realm_deletion_evidence_ref",
        "realm_absence_evidence_ref",
    }
    openapi["paths"]["/identity-backup-closure-debug"] = {
        "get": {
            "operationId": "getIdentityBackupClosureDebug",
            "responses": {
                "200": {
                    "description": "Raw closure internals",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    field_name: {"type": "string"}
                                    for field_name in sorted(exposed_fields)
                                },
                            }
                        }
                    },
                }
            },
        }
    }
    refusals = global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    assert (
        "customer OpenAPI exposes raw identity-backup fields: cutoff_generation, manifest_ref, "
        "realm_absence_evidence_ref, realm_deletion_evidence_ref"
    ) in refusals


def test_customer_openapi_requires_registered_provenance_for_generation() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["components"]["schemas"]["OpaqueEpoch"] = {
        "type": "object",
        "properties": {"generation": {"type": "integer"}, "label": {"type": "string"}},
    }
    openapi["paths"]["/opaque-debug"] = {
        "get": {
            "operationId": "getOpaqueDebug",
            "responses": {
                "200": {
                    "description": "Unregistered ambiguous generation",
                    "content": {
                        "application/json": {"schema": {"$ref": "#/components/schemas/OpaqueEpoch"}}
                    },
                }
            },
        }
    }
    assert (
        "customer OpenAPI schema uses provenance-required fields without a registered projection: "
        "generation"
        in global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    )
    documentation_mutant = replace_clause(
        source,
        OPENAPI_PROJECTION_POLICY_CLAUSE,
        "OpenAPI projection provenance is optional",
    )
    assert "customer OpenAPI projection provenance policy is missing" in (
        global_control_evidence_refusals(documentation_mutant)
    )


def test_customer_openapi_allows_ambiguous_non_generation_field() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/initialization-status"] = {
        "get": {
            "operationId": "getInitializationStatus",
            "responses": {
                "200": {
                    "description": "Unrelated initialization timestamp",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {"initialized_at": {"type": "string"}},
                            }
                        }
                    },
                }
            },
        }
    }
    assert global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False)) == []


def test_customer_openapi_rejects_dynamic_sensitive_property_names() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/dynamic-properties"] = {
        "get": {
            "operationId": "getDynamicProperties",
            "responses": {
                "200": {
                    "description": "Dynamic sensitive name",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "patternProperties": {"^generation$": {"type": "integer"}},
                            }
                        }
                    },
                }
            },
        }
    }
    assert (
        "customer OpenAPI dynamically exposes sensitive identity-backup fields: generation"
        in global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    )


@pytest.mark.parametrize(
    "schema",
    [
        {
            "type": "object",
            "required": ["generation"],
            "additionalProperties": {"type": "integer"},
        },
        {
            "type": "object",
            "dependentRequired": {"generation": ["state"]},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "propertyNames": {"enum": ["generation"]},
            "additionalProperties": {"type": "integer"},
        },
        {
            "type": "object",
            "propertyNames": {"pattern": "^(metadata|label|custom_key|region|generation)$"},
            "additionalProperties": {"type": "integer"},
        },
        {
            "type": "object",
            "propertyNames": {"pattern": "^[generation]+$"},
            "additionalProperties": {"type": "integer"},
        },
        {
            "type": "object",
            "propertyNames": {
                "anyOf": [
                    {"minLength": 20},
                    {"pattern": "^[g][e][n][e][r][a][t][i][o][n]$"},
                ]
            },
            "additionalProperties": {"type": "string"},
        },
        {
            "type": "object",
            "propertyNames": {
                "allOf": [
                    {"not": {"const": "manifest_ref"}},
                    {"pattern": "^g[e]neration$"},
                ]
            },
            "additionalProperties": {"type": "string"},
        },
        {
            "type": "object",
            "propertyNames": {"not": {"pattern": "^(?!generation$).*"}},
            "additionalProperties": {"type": "string"},
        },
        {
            "type": "object",
            "propertyNames": {"not": {"pattern": "^(?!g[e]neration$).*"}},
            "additionalProperties": {"type": "string"},
        },
        {
            "type": "object",
            "propertyNames": {"not": {"pattern": "^(?!(?:g[e]neration|xeneration)$).*"}},
            "additionalProperties": {"type": "string"},
        },
        {
            "type": "object",
            "propertyNames": {
                "not": {
                    "pattern": (
                        "^(?![gxyz0_][exyz0_][nxyz0_][exyz0_][rxyz0_]"
                        "[axyz0_][txyz0_][ixyz0_][oxyz0_][nxyz0_]$).*"
                    )
                }
            },
            "additionalProperties": {"type": "string"},
        },
        {
            "type": "object",
            "propertyNames": {
                "not": {
                    "pattern": (
                        "^(?:.{0,9}|.{11,}|"
                        + "|".join(
                            "".join(
                                f"[^{character}]" if index in {left, right} else "."
                                for index, character in enumerate("generation")
                            )
                            for left in range(len("generation"))
                            for right in range(left + 1, len("generation"))
                        )
                        + ")$"
                    )
                }
            },
            "additionalProperties": {"type": "string"},
        },
        {
            "type": "object",
            "propertyNames": {
                "not": {
                    "pattern": (
                        "^(?:.{0,9}|.{11,}|[^g].{9}|g[^e].{8}|ge[^n].{7}|gen[^e].{6}|"
                        "gene[^r].{5}|gener[^a].{4}|genera[^t].{3}|generat[^i].{2}|"
                        "generati[^o].|generatio[^n])$"
                    )
                }
            },
            "additionalProperties": {"type": "string"},
        },
        {
            "type": "object",
            "propertyNames": {"not": {"pattern": "^(?:[^g]|g(?!e[n]eration$))*$"}},
            "additionalProperties": {"type": "string"},
        },
        {
            "type": "object",
            "propertyNames": {"not": {"pattern": "^.*(?<!g[e]neration)$"}},
            "additionalProperties": {"type": "string"},
        },
        {
            "type": "object",
            "propertyNames": {
                "not": {
                    "pattern": (
                        "^(?=.{0,9}$|.{11,}$|[^g]|g[^e]|ge[^n]|gen[^e]|gene[^r]|"
                        "gener[^a]|genera[^t]|generat[^i]|generati[^o]|generatio[^n]).*$"
                    )
                }
            },
            "additionalProperties": {"type": "string"},
        },
        {
            "type": "object",
            "propertyNames": {"pattern": "^[g-g][e-e][n-n][e-e][r-r][a-a][t-t][i-i][o-o][n-n]$"},
            "additionalProperties": {"type": "integer"},
        },
        {
            "type": "object",
            "patternProperties": {
                "^[g-g][e-e][n-n][e-e][r-r][a-a][t-t][i-i][o-o][n-n]$": {"type": "integer"}
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "patternProperties": {
                "^(metadata|label|custom_key|region|generation)$": {"type": "integer"}
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "propertyNames": {
                "allOf": [
                    {"const": "generation"},
                    {
                        "not": {
                            "if": {"const": "generation"},
                            "then": False,
                            "else": False,
                        }
                    },
                ]
            },
            "additionalProperties": {"type": "integer"},
        },
        {
            "type": "object",
            "not": {"not": {"required": ["generation"]}},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "not": {"properties": {"generation": False}},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "not": {"properties": {"generation": {"const": 0}}},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "not": {"propertyNames": {"not": {"const": "generation"}}},
            "additionalProperties": {"type": "integer"},
        },
        {
            "type": "object",
            "not": {
                "oneOf": [
                    {"required": ["generation"]},
                    {"required": ["other_field"]},
                ]
            },
            "additionalProperties": True,
        },
        {
            "type": "object",
            "not": {"required": ["generation", "other_field"]},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "not": {
                "allOf": [
                    {"required": ["generation"]},
                    {"required": ["other_field"]},
                ]
            },
            "additionalProperties": True,
        },
        {
            "type": "object",
            "not": {
                "if": {"required": ["other_field"]},
                "then": {"required": ["generation"]},
                "else": {"required": ["fallback_field"]},
            },
            "additionalProperties": True,
        },
        {
            "type": "object",
            "required": ["generation"],
            "patternProperties": {".*": {"type": "integer"}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "dependentRequired": {"state": ["generation"]},
            "patternProperties": {".*": {"type": "integer"}},
            "additionalProperties": False,
        },
        {
            "oneOf": [{"type": "object"}, {"type": "string"}],
            "discriminator": {"propertyName": "generation"},
        },
        {
            "type": "object",
            "patternProperties": {"^generation$": {"not": {"anyOf": [{}], "type": "string"}}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "patternProperties": {"^generation$": {"not": {"allOf": [{}], "type": "string"}}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "patternProperties": {"^generation$": {"not": {"not": False, "type": "string"}}},
            "additionalProperties": False,
        },
    ],
)
def test_customer_openapi_rejects_schema_named_dynamic_sensitive_fields(
    schema: dict[str, object],
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/named-dynamic-properties"] = {
        "get": {
            "operationId": "getNamedDynamicProperties",
            "responses": {
                "200": {
                    "description": "Schema-named dynamic sensitive field",
                    "content": {"application/json": {"schema": schema}},
                }
            },
        }
    }
    refusals = global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    assert any(
        refusal.startswith("customer OpenAPI dynamically exposes sensitive identity-backup fields:")
        and "generation" in refusal
        for refusal in refusals
    )


def test_customer_openapi_resolves_dynamic_sensitive_name_schema_references() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["components"]["schemas"]["SensitivePropertyName"] = {"enum": ["generation"]}
    openapi["paths"]["/referenced-dynamic-properties"] = {
        "get": {
            "operationId": "getReferencedDynamicProperties",
            "responses": {
                "200": {
                    "description": "Referenced sensitive name",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "propertyNames": {
                                    "$ref": "#/components/schemas/SensitivePropertyName"
                                },
                                "additionalProperties": True,
                            }
                        }
                    },
                }
            },
        }
    }
    refusals = global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    assert any(
        refusal.startswith("customer OpenAPI dynamically exposes sensitive identity-backup fields:")
        and "generation" in refusal
        for refusal in refusals
    )


@pytest.mark.parametrize(
    "metadata_schema",
    [
        {"type": "object", "propertyNames": {"type": "string"}, "additionalProperties": True},
        {
            "type": "object",
            "propertyNames": {"type": "string", "description": "Metadata key"},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "propertyNames": {"$comment": "Generic keys", "minLength": 0},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "propertyNames": {"allOf": [{"type": "string"}]},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "propertyNames": {"pattern": "^"},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "patternProperties": {"^(?:.*)$": {"type": "string"}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "propertyNames": {
                "type": "string",
                "pattern": "^[a-z_]+$",
                "maxLength": 64,
            },
            "additionalProperties": {"type": "string"},
        },
        {
            "type": "object",
            "propertyNames": {
                "type": "string",
                "pattern": "^[A-Za-z_][A-Za-z0-9_]{0,63}$",
            },
            "additionalProperties": {"type": "string"},
        },
        {
            "type": "object",
            "patternProperties": {".*": {"type": "string"}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "patternProperties": {r"^[\s\S]*$": {"type": "string"}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "propertyNames": {"pattern": r"^[\s\S]{0,}$"},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "propertyNames": {"pattern": "(?s:^.*$)"},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "propertyNames": {"pattern": "(?s:.*)"},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "propertyNames": {"pattern": "(?=.{0,}$)"},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "propertyNames": {"pattern": "^[^/]+$"},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "propertyNames": {"pattern": "^(?!.*[/]).+$"},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "propertyNames": {"pattern": "^(?!.*[/]).*$"},
            "additionalProperties": True,
        },
    ],
)
def test_customer_openapi_allows_generic_free_form_metadata_maps(
    metadata_schema: dict[str, object],
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/generic-metadata"] = {
        "get": {
            "operationId": "getGenericMetadata",
            "responses": {
                "200": {
                    "description": "Generic metadata",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {"metadata": metadata_schema},
                            }
                        }
                    },
                }
            },
        }
    }
    assert global_control_evidence_refusals(source, dump_yaml(openapi)) == []


def test_customer_openapi_inspects_encoded_content_schema() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/encoded-backup-state"] = {
        "get": {
            "operationId": "getEncodedBackupState",
            "responses": {
                "200": {
                    "description": "Encoded raw backup state",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "string",
                                "contentMediaType": "application/json",
                                "contentSchema": {
                                    "type": "object",
                                    "properties": {
                                        "generation": {"type": "integer"},
                                        "state": {"type": "string"},
                                    },
                                },
                            }
                        }
                    },
                }
            },
        }
    }
    assert (
        "customer OpenAPI schema uses provenance-required fields without a registered projection: "
        "generation"
        in global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    )


def test_customer_openapi_inspects_unevaluated_array_items() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/extended-backup-state"] = {
        "get": {
            "operationId": "getExtendedBackupState",
            "responses": {
                "200": {
                    "description": "Additional raw backup state items",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "array",
                                "prefixItems": [{"type": "string"}],
                                "unevaluatedItems": {
                                    "type": "object",
                                    "properties": {
                                        "generation": {"type": "integer"},
                                        "state": {"type": "string"},
                                    },
                                },
                            }
                        }
                    },
                }
            },
        }
    }
    assert (
        "customer OpenAPI schema uses provenance-required fields without a registered projection: "
        "generation"
        in global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    )


def test_customer_openapi_projection_registry_fails_closed() -> None:
    source = MODEL.read_text(encoding="utf-8")

    def document(schema: Mapping[str, object]) -> str:
        openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
        openapi["paths"]["/projection-probe"] = {
            "get": {
                "operationId": "getProjectionProbe",
                "responses": {
                    "200": {
                        "description": "Projection policy probe",
                        "content": {"application/json": {"schema": schema}},
                    }
                },
            }
        }
        return dump_yaml(openapi, sort_keys=False)

    unknown = {
        "type": "object",
        "x-kodera-projection": "unknown-projection-v1",
        "properties": {"label": {"type": "string"}},
    }
    assert (
        "customer OpenAPI schema uses unknown projection provenance: unknown-projection-v1"
        in global_control_evidence_refusals(source, document(unknown))
    )

    overbroad = {
        "type": "object",
        "x-kodera-projection": "release-generation-v1",
        "properties": {
            "generation": {"type": "integer"},
            "state": {"type": "string"},
            "opened_at": {"type": "string"},
        },
    }
    assert (
        "customer OpenAPI projection release-generation-v1 exceeds its field allowlist"
        in global_control_evidence_refusals(source, document(overbroad))
    )

    conflicting = {
        "type": "object",
        "x-kodera-projection": "release-generation-v1",
        "allOf": [
            {
                "type": "object",
                "x-kodera-projection": ("deletion-certificate-identity-backup-capture-v1"),
                "properties": {"state": {"type": "string"}},
            }
        ],
    }
    assert "customer OpenAPI schema has conflicting projection provenance" in (
        global_control_evidence_refusals(source, document(conflicting))
    )


def test_customer_openapi_projection_marker_cannot_spoof_an_authorised_surface() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/identity-backup/generation"] = {
        "get": {
            "operationId": "getReleaseGeneration",
            "responses": {
                "200": {
                    "description": "Raw identity backup generation",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "x-kodera-projection": "release-generation-v1",
                                "properties": {
                                    "generation": {"type": "integer"},
                                    "state": {"type": "string"},
                                },
                            }
                        }
                    },
                }
            },
        }
    }
    refusals = global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    assert (
        "customer OpenAPI projection release-generation-v1 is outside its exact "
        "operation/surface binding" in refusals
    )

    closure_fields = OPENAPI_PROJECTION_POLICIES["deletion-certificate-identity-backup-closure-v1"][
        "fields"
    ]
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/deletion-certificate-safe-backup-projection"] = {
        "get": {
            "operationId": "getDeletionCertificateSafeBackupProjection",
            "responses": {
                "200": {
                    "description": "Marker moved outside its registered structure",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "x-kodera-projection": (
                                    "deletion-certificate-identity-backup-closure-v1"
                                ),
                                "properties": {
                                    field_name: {"type": "string"}
                                    for field_name in sorted(closure_fields)
                                },
                            }
                        }
                    },
                }
            },
        }
    }
    refusals = global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    assert (
        "customer OpenAPI projection deletion-certificate-identity-backup-closure-v1 is outside "
        "its structural location" in refusals
    )


@pytest.mark.parametrize("misplacement", ["request", "status", "media", "wrapper", "callback"])
def test_customer_openapi_projection_requires_its_exact_schema_location(
    misplacement: str,
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    closure_fields = OPENAPI_PROJECTION_POLICIES["deletion-certificate-identity-backup-closure-v1"][
        "fields"
    ]
    closure = {
        "type": "object",
        "x-kodera-projection": "deletion-certificate-identity-backup-closure-v1",
        "properties": {field_name: {"type": "string"} for field_name in sorted(closure_fields)},
    }
    schema = {"type": "object", "properties": {"closure": closure}}
    operation: dict[str, object] = {
        "operationId": "getDeletionCertificateSafeBackupProjection",
        "responses": {"204": {"description": "No certificate returned"}},
    }
    if misplacement == "request":
        operation["requestBody"] = {"content": {"application/json": {"schema": schema}}}
    elif misplacement == "callback":
        operation["callbacks"] = {
            "certificateReady": {
                "{$request.body#/callbackUrl}": {
                    "post": {
                        "responses": {
                            "200": {
                                "description": "Misplaced callback projection",
                                "content": {"application/json": {"schema": schema}},
                            }
                        }
                    }
                }
            }
        }
    else:
        status = "201" if misplacement == "status" else "200"
        media = "application/problem+json" if misplacement == "media" else "application/json"
        if misplacement == "wrapper":
            schema = {
                "type": "object",
                "properties": {
                    "closure": {
                        "type": "object",
                        "properties": {"payload": closure},
                    }
                },
            }
        operation["responses"] = {
            status: {
                "description": "Misplaced certificate projection",
                "content": {media: {"schema": schema}},
            }
        }
    openapi["paths"]["/deletion-certificate-safe-backup-projection"] = {"get": operation}
    assert (
        "customer OpenAPI projection deletion-certificate-identity-backup-closure-v1 is outside "
        "its structural location"
        in global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    )


@pytest.mark.parametrize(
    "missing_field",
    sorted(FORBIDDEN_CUSTOMER_BACKUP_SCHEMA_SIGNATURES["generation"]),
)
def test_customer_openapi_rejects_generation_projection_missing_one_field(
    missing_field: str,
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    fields = FORBIDDEN_CUSTOMER_BACKUP_SCHEMA_SIGNATURES["generation"] - {missing_field}
    openapi["components"]["schemas"]["EpochSlice"] = {
        "type": "object",
        "properties": {field_name: {"type": "string"} for field_name in sorted(fields)},
    }
    openapi["paths"]["/opaque-epoch"] = {
        "get": {
            "operationId": "getOpaqueEpoch",
            "responses": {
                "200": {
                    "description": "Partial raw generation row",
                    "content": {
                        "application/json": {"schema": {"$ref": "#/components/schemas/EpochSlice"}}
                    },
                }
            },
        }
    }
    assert (
        "customer OpenAPI exposes a complete or near-complete raw identity-backup generation row"
        in global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    )


def test_customer_openapi_rejects_generation_fields_split_across_nested_objects() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/nested-epoch"] = {
        "get": {
            "operationId": "getNestedEpoch",
            "responses": {
                "200": {
                    "description": "Raw generation fields split across nested objects",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "epoch": {
                                        "type": "object",
                                        "properties": {"generation": {"type": "integer"}},
                                    },
                                    "lifecycle": {
                                        "type": "object",
                                        "properties": {
                                            "state": {"type": "string"},
                                            "opened_at": {"type": "string"},
                                            "sealed_at": {"type": "string"},
                                        },
                                    },
                                },
                            }
                        }
                    },
                }
            },
        }
    }
    assert (
        "customer OpenAPI exposes a complete or near-complete raw identity-backup generation row"
        in global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    )


def test_customer_openapi_rejects_opaque_generation_pair() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/shared-epoch"] = {
        "get": {
            "operationId": "getSharedEpoch",
            "responses": {
                "200": {
                    "description": "Aliased partial raw generation",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "generation": {"type": "integer"},
                                    "opened_at": {"type": "string"},
                                },
                            }
                        }
                    },
                }
            },
        }
    }
    assert (
        "customer OpenAPI schema uses provenance-required fields without a registered projection: "
        "generation"
        in global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    )


def test_customer_openapi_allows_unrelated_same_name_fields_and_literal_examples() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["components"]["schemas"]["ReleaseGeneration"] = {
        "type": "object",
        "x-kodera-projection": "release-generation-v1",
        "additionalProperties": False,
        "unevaluatedProperties": False,
        "required": ["generation", "state", "initialized_at"],
        "properties": {
            "generation": {"type": "integer"},
            "state": {"type": "string"},
            "initialized_at": {"type": "string"},
        },
    }
    openapi["paths"]["/release-generation"] = {
        "get": {
            "operationId": "getReleaseGeneration",
            "x-documentation": {
                "schema": {
                    "properties": {
                        field_name: "illustrative metadata"
                        for field_name in FORBIDDEN_CUSTOMER_BACKUP_SCHEMA_SIGNATURES["generation"]
                    }
                }
            },
            "responses": {
                "200": {
                    "description": "Unrelated release metadata",
                    "content": {
                        "application/json": {
                            "schema": {
                                "allOf": [{"$ref": "#/components/schemas/ReleaseGeneration"}],
                                "example": {
                                    "$ref": "https://customer.example/document",
                                    "properties": {"accepted_object_ref": "literal customer data"},
                                },
                            },
                            "example": {
                                "$ref": "https://customer.example/document",
                                "properties": {"accepted_object_ref": "literal customer data"},
                            },
                        }
                    },
                }
            },
        }
    }
    openapi["webhooks"] = {
        "releaseGeneration": {
            "post": {
                "operationId": "receiveReleaseGeneration",
                "responses": {
                    "200": {
                        "description": "Registered release generation projection",
                        "content": {
                            "application/json": {
                                "schema": {"$dynamicRef": "#/components/schemas/ReleaseGeneration"}
                            }
                        },
                    }
                },
            }
        }
    }
    assert global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False)) == []


@pytest.mark.parametrize(
    ("condition", "complement"),
    [
        ({"minimum": 4.2}, {"maximum": 4}),
        ({"maximum": 4.2}, {"minimum": 5}),
        ({"minimum": 10**1000}, {"maximum": 10**1000 - 1}),
    ],
)
def test_customer_openapi_allows_exhaustive_integer_bound_partitions(
    condition: dict[str, object], complement: dict[str, object]
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/integer-partition-forbidden"] = {
        "get": {
            "operationId": "getIntegerPartitionForbidden",
            "responses": {
                "200": {
                    "description": "Integer partition excludes sensitive field",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "generation": {
                                        "oneOf": [
                                            {"type": "integer"},
                                            {
                                                "type": "integer",
                                                "if": condition,
                                                "then": condition,
                                                "else": complement,
                                            },
                                        ]
                                    }
                                },
                                "additionalProperties": False,
                            }
                        }
                    },
                }
            },
        }
    }
    assert global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False)) == []


@pytest.mark.parametrize(
    "schema",
    [
        {
            "type": "object",
            "not": {"required": ["generation"]},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "propertyNames": {"not": {"const": "generation"}},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "properties": {"generation": False},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"generation": {"not": {}}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "patternProperties": {"^generation$": False},
            "additionalProperties": True,
        },
        {
            "type": "object",
            "properties": {"generation": {"not": {"not": False}}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"generation": {"allOf": [{"type": "string"}, {"type": "number"}]}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"generation": {"const": 1, "not": {"const": 1}}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"generation": {"anyOf": [False, False]}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"generation": {"oneOf": [False]}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "not": {"type": "object"},
            "properties": {"generation": {"type": "integer"}},
            "additionalProperties": False,
        },
        {
            "allOf": [
                {"type": "object"},
                {"not": {"type": "object"}},
                {
                    "type": "object",
                    "properties": {"generation": {"type": "integer"}},
                    "additionalProperties": False,
                },
            ]
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "allOf": [
                        {"allOf": [{"type": "string"}]},
                        {"type": "number"},
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "integer"},
                        {
                            "type": "integer",
                            "if": {
                                "allOf": [
                                    {"minimum": 5},
                                    {"multipleOf": 1},
                                ]
                            },
                            "then": {
                                "allOf": [
                                    {"minimum": 5},
                                    {"multipleOf": 1},
                                ]
                            },
                            "else": {"maximum": 4},
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "number"},
                        {
                            "type": "number",
                            "if": {
                                "allOf": [
                                    {"minimum": 4},
                                    {"exclusiveMinimum": 4},
                                ]
                            },
                            "then": {
                                "allOf": [
                                    {"minimum": 4},
                                    {"exclusiveMinimum": 4},
                                ]
                            },
                            "else": {"maximum": 4},
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "integer"},
                        {
                            "type": "integer",
                            "if": {
                                "allOf": [
                                    {"minimum": 4},
                                    {"exclusiveMinimum": 4},
                                ]
                            },
                            "then": {
                                "allOf": [
                                    {"minimum": 4},
                                    {"exclusiveMinimum": 4},
                                ]
                            },
                            "else": {"maximum": 4},
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "integer"},
                        {
                            "type": "integer",
                            "if": {
                                "allOf": [
                                    {"type": "integer"},
                                    {"minimum": 5},
                                ]
                            },
                            "then": {
                                "allOf": [
                                    {"type": "integer"},
                                    {"minimum": 5},
                                ]
                            },
                            "else": {"maximum": 4},
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "integer"},
                        {
                            "type": "integer",
                            "if": {
                                "allOf": [
                                    {"minimum": 4},
                                    {"minimum": 5},
                                ]
                            },
                            "then": {
                                "allOf": [
                                    {"minimum": 4},
                                    {"minimum": 5},
                                ]
                            },
                            "else": {"maximum": 4},
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "integer"},
                        {
                            "type": "integer",
                            "if": {"type": "integer", "minimum": 5},
                            "then": {"type": "integer", "minimum": 5},
                            "else": {"not": {"type": "integer", "minimum": 5}},
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "integer"},
                        {
                            "type": "integer",
                            "if": {"type": "integer", "minimum": 5},
                            "then": {"type": "integer", "minimum": 5},
                            "else": {"maximum": 4},
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "integer"},
                        {
                            "type": "integer",
                            "if": {"minimum": 5},
                            "then": {"minimum": 5},
                            "else": {"maximum": 4},
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {
                            "type": "string",
                            "if": {"minLength": 5},
                            "then": {"$ref": "#/components/schemas/RetentionTestMinFive"},
                            "else": {"not": {"minLength": 5}},
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {
                            "type": "string",
                            "if": {"minLength": 5},
                            "then": {"minLength": 5},
                            "else": {"maxLength": 4},
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {
                            "type": "string",
                            "if": {"minLength": 5},
                            "then": {"allOf": [{"minLength": 5}]},
                            "else": {"not": {"minLength": 5}},
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {
                            "type": "string",
                            "if": {"pattern": "^a"},
                            "then": {"pattern": "^a"},
                            "else": {"not": {"pattern": "^a"}},
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {
                            "type": "string",
                            "allOf": [{"not": {"type": "number"}}],
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {
                            "type": "string",
                            "if": {"type": "number"},
                            "then": False,
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {
                            "type": "string",
                            "if": {"minLength": 5},
                            "then": {},
                            "else": {},
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {
                            "type": "string",
                            "anyOf": [{"type": "string"}, {"type": "number"}],
                        },
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "string", "minItems": 5},
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "string", "not": {"type": "number"}},
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "string", "allOf": [{"minItems": 5}]},
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "string", "if": {}, "then": {}},
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {"not": {"not": {"type": "string"}}},
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "string", "anyOf": [{}]},
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"generation": {"type": "number", "minimum": 5, "maximum": 4}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"generation": {"type": "string", "minLength": 2, "maxLength": 1}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"generation": {"oneOf": [{}, {}]}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"generation": {"type": "string", "enum": [1, 2]}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"generation": {"type": "string", "const": 1}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"generation": {"oneOf": [{"type": "string"}, {"type": ["string"]}]}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"generation": {"oneOf": [{"const": 1}, {"enum": [1]}]}},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string", "description": "annotation only"},
                        {"type": ["string"]},
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "string", "pattern": ".*"},
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "string", "allOf": [{}]},
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {"$ref": "#/components/schemas/RetentionTestString"},
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "string", "minLength": 0},
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {"allOf": [{"type": "string"}]},
                    ]
                }
            },
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "generation": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": ["string"]},
                        {"type": "string"},
                    ]
                }
            },
            "additionalProperties": False,
        },
    ],
)
def test_customer_openapi_allows_schemas_that_forbid_sensitive_fields(
    schema: dict[str, object],
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["components"]["schemas"]["RetentionTestString"] = {"type": "string"}
    openapi["components"]["schemas"]["RetentionTestMinFive"] = {"minLength": 5}
    openapi["paths"]["/sensitive-field-forbidden"] = {
        "get": {
            "operationId": "getSensitiveFieldForbidden",
            "responses": {
                "200": {
                    "description": "Sensitive field excluded by schema",
                    "content": {"application/json": {"schema": schema}},
                }
            },
        }
    }
    assert global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False)) == []


@pytest.mark.parametrize(
    "property_schema",
    [
        {"not": {"anyOf": [{}], "type": "string"}},
        {"not": {"allOf": [{}], "type": "string"}},
        {"not": {"not": False, "type": "string"}},
        {"minimum": 5, "maximum": 4},
        {"minItems": 2, "maxItems": 1},
        {"type": "array", "minContains": 2, "maxContains": 1},
        {
            "oneOf": [
                {"type": "string"},
                {"type": "string", "pattern": "^.*$"},
            ]
        },
        {
            "oneOf": [
                {"type": "number"},
                {
                    "type": "number",
                    "if": {"minimum": 5},
                    "then": {"minimum": 5},
                    "else": {"exclusiveMaximum": 4},
                },
            ]
        },
        {
            "oneOf": [
                {"type": "number"},
                {
                    "type": "number",
                    "if": {"maximum": 5},
                    "then": {"maximum": 5},
                    "else": {"exclusiveMinimum": 6},
                },
            ]
        },
        {
            "oneOf": [
                {"type": "integer"},
                {
                    "type": "integer",
                    "if": {
                        "allOf": [
                            {"exclusiveMinimum": 5.5},
                            {"minimum": 5},
                        ]
                    },
                    "then": {
                        "allOf": [
                            {"exclusiveMinimum": 5.5},
                            {"minimum": 5},
                        ]
                    },
                    "else": {"maximum": 4},
                },
            ]
        },
        {
            "oneOf": [
                {"type": "integer"},
                {
                    "type": "integer",
                    "if": {
                        "allOf": [
                            {"minimum": 5},
                            {"multipleOf": 0.3333333333333333},
                        ]
                    },
                    "then": {
                        "allOf": [
                            {"minimum": 5},
                            {"multipleOf": 0.3333333333333333},
                        ]
                    },
                    "else": {"maximum": 4},
                },
            ]
        },
        {
            "oneOf": [
                {"type": "object"},
                {
                    "type": "object",
                    "if": {"const": {"description": "x"}},
                    "then": {"const": {"description": "x"}},
                    "else": {"not": {"const": {"description": "y"}}},
                },
            ]
        },
        {
            "oneOf": [
                {"type": "object"},
                {
                    "type": "object",
                    "if": {
                        "properties": {"x": {"type": "object"}},
                        "required": ["x"],
                    },
                    "then": {
                        "properties": {"x": {"type": "object"}},
                        "required": ["x"],
                    },
                    "else": {
                        "not": {
                            "properties": {"x": {}},
                            "required": ["x"],
                        }
                    },
                },
            ]
        },
        {
            "oneOf": [
                {"type": "object"},
                {
                    "type": "object",
                    "if": {
                        "allOf": [
                            {"properties": {"x": {"type": "string"}}},
                            {"additionalProperties": False},
                        ]
                    },
                    "then": {
                        "allOf": [
                            {"properties": {"x": {"type": "string"}}},
                            {"additionalProperties": False},
                        ]
                    },
                    "else": {
                        "not": {
                            "properties": {"x": {"type": "string"}},
                            "additionalProperties": False,
                        }
                    },
                },
            ]
        },
    ],
)
def test_customer_openapi_requires_provenance_when_property_schema_is_reachable(
    property_schema: dict[str, object],
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/provenance-sibling-probe"] = {
        "get": {
            "operationId": "getProvenanceSiblingProbe",
            "responses": {
                "200": {
                    "description": "Reachable generation requires registered provenance",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {"generation": property_schema},
                            }
                        }
                    },
                }
            },
        }
    }
    assert (
        "customer OpenAPI schema uses provenance-required fields without a registered projection: "
        "generation"
        in global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    )


def test_customer_openapi_allows_referenced_false_sensitive_property() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["components"]["schemas"]["Never"] = False
    openapi["paths"]["/referenced-sensitive-field-forbidden"] = {
        "get": {
            "operationId": "getReferencedSensitiveFieldForbidden",
            "responses": {
                "200": {
                    "description": "Sensitive field excluded by referenced false schema",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "generation": {"$ref": "#/components/schemas/Never"}
                                },
                                "additionalProperties": False,
                            }
                        }
                    },
                }
            },
        }
    }
    assert global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False)) == []


def test_customer_openapi_resolves_multihop_name_schema_that_forbids_sensitive_field() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["components"]["schemas"]["NoGenerationName"] = {"not": {"const": "generation"}}
    openapi["components"]["schemas"]["MetadataName"] = {
        "$ref": "#/components/schemas/NoGenerationName"
    }
    openapi["paths"]["/multihop-metadata"] = {
        "get": {
            "operationId": "getMultihopMetadata",
            "responses": {
                "200": {
                    "description": "Metadata excluding the sensitive key",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "propertyNames": {"$ref": "#/components/schemas/MetadataName"},
                                "additionalProperties": True,
                            }
                        }
                    },
                }
            },
        }
    }
    assert global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False)) == []


def test_customer_openapi_keeps_registered_provenance_per_composition_branch() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["components"]["schemas"]["ReleaseGeneration"] = {
        "type": "object",
        "x-kodera-projection": "release-generation-v1",
        "additionalProperties": False,
        "unevaluatedProperties": False,
        "required": ["generation", "state"],
        "properties": {
            "generation": {"type": "integer"},
            "state": {"type": "string"},
        },
    }
    openapi["paths"]["/release-generation"] = {
        "get": {
            "operationId": "getReleaseGeneration",
            "responses": {
                "200": {
                    "description": "Exclusive release result",
                    "content": {
                        "application/json": {
                            "schema": {
                                "oneOf": [
                                    {"$ref": "#/components/schemas/ReleaseGeneration"},
                                    {
                                        "type": "object",
                                        "additionalProperties": False,
                                        "unevaluatedProperties": False,
                                        "required": ["unavailable"],
                                        "properties": {"unavailable": {"type": "boolean"}},
                                    },
                                ]
                            }
                        }
                    },
                }
            },
        }
    }
    assert global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False)) == []


@pytest.mark.parametrize(
    ("reference_keyword", "composition_keyword"),
    [("$ref", "oneOf"), ("$dynamicRef", "oneOf")],
)
def test_customer_openapi_keeps_branch_provenance_through_a_referenced_composition(
    reference_keyword: str, composition_keyword: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["components"]["schemas"]["ReleaseGeneration"] = {
        "type": "object",
        "x-kodera-projection": "release-generation-v1",
        "additionalProperties": False,
        "unevaluatedProperties": False,
        "required": ["generation", "state"],
        "properties": {
            "generation": {"type": "integer"},
            "state": {"type": "string"},
        },
    }
    openapi["components"]["schemas"]["ReleaseResult"] = {
        composition_keyword: [
            {"$ref": "#/components/schemas/ReleaseGeneration"},
            {
                "type": "object",
                "additionalProperties": False,
                "unevaluatedProperties": False,
                "required": ["unavailable"],
                "properties": {"unavailable": {"type": "boolean"}},
            },
        ]
    }
    openapi["paths"]["/release-generation"] = {
        "get": {
            "operationId": "getReleaseGeneration",
            "responses": {
                "200": {
                    "description": "Referenced release result",
                    "content": {
                        "application/json": {
                            "schema": {reference_keyword: "#/components/schemas/ReleaseResult"}
                        }
                    },
                }
            },
        }
    }
    assert global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False)) == []


def test_customer_openapi_allows_a_statically_exclusive_any_of_projection() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/release-generation"] = {
        "get": {
            "operationId": "getReleaseGeneration",
            "responses": {
                "200": {
                    "description": "Exclusive release result",
                    "content": {
                        "application/json": {
                            "schema": {
                                "anyOf": [
                                    {
                                        "type": "object",
                                        "x-kodera-projection": "release-generation-v1",
                                        "additionalProperties": False,
                                        "unevaluatedProperties": False,
                                        "required": ["generation", "state"],
                                        "properties": {
                                            "generation": {"type": "integer"},
                                            "state": {"type": "string"},
                                        },
                                    },
                                    {
                                        "type": "object",
                                        "additionalProperties": False,
                                        "unevaluatedProperties": False,
                                        "required": ["unavailable"],
                                        "properties": {"unavailable": {"type": "boolean"}},
                                    },
                                ]
                            }
                        }
                    },
                }
            },
        }
    }
    assert global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False)) == []


def test_customer_openapi_resolves_referenced_closed_shapes_for_exclusive_any_of() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["components"]["schemas"]["ClosedReleaseGeneration"] = {
        "type": "object",
        "x-kodera-projection": "release-generation-v1",
        "additionalProperties": False,
        "unevaluatedProperties": False,
        "required": ["generation", "state"],
        "properties": {
            "generation": {"type": "integer"},
            "state": {"type": "string"},
        },
    }
    openapi["components"]["schemas"]["ClosedUnavailable"] = {
        "type": "object",
        "additionalProperties": False,
        "unevaluatedProperties": False,
        "required": ["unavailable"],
        "properties": {"unavailable": {"type": "boolean"}},
    }
    openapi["paths"]["/release-generation"] = {
        "get": {
            "operationId": "getReleaseGeneration",
            "responses": {
                "200": {
                    "description": "Exclusive referenced release result",
                    "content": {
                        "application/json": {
                            "schema": {
                                "anyOf": [
                                    {
                                        "allOf": [
                                            {
                                                "$ref": (
                                                    "#/components/schemas/ClosedReleaseGeneration"
                                                )
                                            }
                                        ]
                                    },
                                    {"$dynamicRef": "#/components/schemas/ClosedUnavailable"},
                                ]
                            }
                        }
                    },
                }
            },
        }
    }
    assert global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False)) == []


def test_customer_openapi_any_of_cannot_launder_a_sibling_projection() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["paths"]["/release-generation"] = {
        "get": {
            "operationId": "getReleaseGeneration",
            "responses": {
                "200": {
                    "description": "A raw branch beside a registered branch",
                    "content": {
                        "application/json": {
                            "schema": {
                                "anyOf": [
                                    {
                                        "type": "object",
                                        "x-kodera-projection": "release-generation-v1",
                                        "properties": {
                                            "generation": {"type": "integer"},
                                            "state": {"type": "string"},
                                        },
                                    },
                                    {
                                        "type": "object",
                                        "properties": {
                                            "generation": {"type": "integer"},
                                            "state": {"type": "string"},
                                        },
                                    },
                                ]
                            }
                        }
                    },
                }
            },
        }
    }
    assert (
        "customer OpenAPI schema uses provenance-required fields without a registered projection: "
        "generation"
        in global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    )


@pytest.mark.parametrize("composition_keyword", ["oneOf", "anyOf"])
def test_customer_openapi_projection_rejects_an_open_alternative_sibling(
    composition_keyword: str,
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    fallback: dict[str, object] = {
        "type": "object",
        "properties": {"unavailable": {"type": "boolean"}},
    }
    if composition_keyword == "anyOf":
        fallback.update(
            {
                "additionalProperties": False,
                "unevaluatedProperties": False,
                "required": ["unavailable"],
                "patternProperties": {"^generation$": {"type": "integer"}},
            }
        )
    openapi["paths"]["/release-generation"] = {
        "get": {
            "operationId": "getReleaseGeneration",
            "responses": {
                "200": {
                    "description": "Unsafe alternative projection",
                    "content": {
                        "application/json": {
                            "schema": {
                                composition_keyword: [
                                    {
                                        "type": "object",
                                        "x-kodera-projection": "release-generation-v1",
                                        "additionalProperties": False,
                                        "unevaluatedProperties": False,
                                        "required": ["generation", "state"],
                                        "properties": {
                                            "generation": {"type": "integer"},
                                            "state": {"type": "string"},
                                        },
                                    },
                                    fallback,
                                ]
                            }
                        }
                    },
                }
            },
        }
    }
    assert (
        "customer OpenAPI projection release-generation-v1 has an unsafe alternative sibling"
        in global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    )


def test_customer_openapi_inspects_top_level_webhook_schemas() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    signature = FORBIDDEN_CUSTOMER_BACKUP_SCHEMA_SIGNATURES["generation"]
    openapi["webhooks"] = {
        "backupStatus": {
            "post": {
                "operationId": "receiveOpaqueStatus",
                "responses": {
                    "200": {
                        "description": "Raw row exposed from a webhook operation",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        field_name: {"type": "string"}
                                        for field_name in sorted(signature)
                                    },
                                }
                            }
                        },
                    }
                },
            }
        }
    }
    assert (
        "customer OpenAPI exposes a complete or near-complete raw identity-backup generation row"
        in global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    )


def test_customer_openapi_allows_exact_safe_final_organisation_projection() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    closure_fields = {
        "id",
        "organisation_id",
        "organisation_slug",
        "realm_slug",
        "closure_job_id",
        "state",
        "manifest_sha256",
        "realm_deleted_at",
        "realm_absence_verified_at",
        "sealed_at",
    }
    capture_fields = {"kind", "state", "store_accepted_at", "lock_until"}
    openapi["paths"]["/deletion-certificate-safe-backup-projection"] = {
        "get": {
            "operationId": "getDeletionCertificateSafeBackupProjection",
            "responses": {
                "200": {
                    "description": "Required safe customer-readable projection",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "closure": {
                                        "type": "object",
                                        "x-kodera-projection": (
                                            "deletion-certificate-identity-backup-closure-v1"
                                        ),
                                        "additionalProperties": False,
                                        "unevaluatedProperties": False,
                                        "required": sorted(closure_fields),
                                        "properties": {
                                            field_name: {"type": "string"}
                                            for field_name in sorted(closure_fields)
                                        },
                                    },
                                    "captures": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "x-kodera-projection": (
                                                "deletion-certificate-identity-backup-capture-v1"
                                            ),
                                            "additionalProperties": False,
                                            "unevaluatedProperties": False,
                                            "required": sorted(capture_fields),
                                            "properties": {
                                                field_name: {"type": "string"}
                                                for field_name in sorted(capture_fields)
                                            },
                                        },
                                    },
                                },
                            }
                        }
                    },
                }
            },
        }
    }
    assert global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False)) == []

    for field, value in (
        ("type", "string"),
        ("type", ["object", "null"]),
        ("additionalProperties", True),
        ("patternProperties", {"^raw_": {"type": "string"}}),
        ("unevaluatedProperties", True),
        ("required", sorted(closure_fields)[:-1]),
    ):
        open_projection_mutant = load_yaml(dump_yaml(openapi, sort_keys=False))
        open_projection_mutant["paths"]["/deletion-certificate-safe-backup-projection"]["get"][
            "responses"
        ]["200"]["content"]["application/json"]["schema"]["properties"]["closure"][field] = value
        assert (
            "customer OpenAPI projection deletion-certificate-identity-backup-closure-v1 is not "
            "a closed required object"
            in global_control_evidence_refusals(
                source, dump_yaml(open_projection_mutant, sort_keys=False)
            )
        )

    missing_type_mutant = load_yaml(dump_yaml(openapi, sort_keys=False))
    missing_type_mutant["paths"]["/deletion-certificate-safe-backup-projection"]["get"][
        "responses"
    ]["200"]["content"]["application/json"]["schema"]["properties"]["closure"].pop("type")
    assert (
        "customer OpenAPI projection deletion-certificate-identity-backup-closure-v1 is not "
        "a closed required object"
        in global_control_evidence_refusals(source, dump_yaml(missing_type_mutant, sort_keys=False))
    )

    response_schema = openapi["paths"]["/deletion-certificate-safe-backup-projection"]["get"][
        "responses"
    ]["200"]["content"]["application/json"]["schema"]
    closure_mutant = load_yaml(dump_yaml(openapi, sort_keys=False))
    closure_mutant["paths"]["/deletion-certificate-safe-backup-projection"]["get"]["responses"][
        "200"
    ]["content"]["application/json"]["schema"]["properties"]["closure"]["properties"].pop(
        next(iter(response_schema["properties"]["closure"]["properties"]))
    )
    assert (
        "customer OpenAPI projection deletion-certificate-identity-backup-closure-v1 does not "
        "match its exact field set"
        in global_control_evidence_refusals(source, dump_yaml(closure_mutant, sort_keys=False))
    )

    capture_mutant = load_yaml(dump_yaml(openapi, sort_keys=False))
    capture_mutant["paths"]["/deletion-certificate-safe-backup-projection"]["get"]["responses"][
        "200"
    ]["content"]["application/json"]["schema"]["properties"]["captures"]["items"]["properties"].pop(
        next(iter(response_schema["properties"]["captures"]["items"]["properties"]))
    )
    assert (
        "customer OpenAPI projection deletion-certificate-identity-backup-capture-v1 does not "
        "match its exact field set"
        in global_control_evidence_refusals(source, dump_yaml(capture_mutant, sort_keys=False))
    )


def test_customer_openapi_dynamic_reference_is_resolved_or_failed_closed() -> None:
    source = MODEL.read_text(encoding="utf-8")
    openapi = load_yaml(OPENAPI.read_text(encoding="utf-8"))
    openapi["components"]["schemas"]["IdentityBackupGenerationDebug"] = {
        "type": "object",
        "properties": {
            field_name: {"type": "string"}
            for field_name in sorted(FORBIDDEN_CUSTOMER_BACKUP_SCHEMA_SIGNATURES["generation"])
        },
        "$dynamicRef": "#/components/schemas/IdentityBackupGenerationDebug",
    }
    openapi["paths"]["/dynamic-generation"] = {
        "get": {
            "operationId": "getDynamicGeneration",
            "responses": {
                "200": {
                    "description": "Dynamic local schema",
                    "content": {
                        "application/json": {
                            "schema": {
                                "$dynamicRef": (
                                    "#/components/schemas/IdentityBackupGenerationDebug"
                                )
                            }
                        }
                    },
                }
            },
        }
    }
    local_refusals = global_control_evidence_refusals(source, dump_yaml(openapi, sort_keys=False))
    assert (
        "customer OpenAPI exposes a complete or near-complete raw identity-backup generation row"
        in local_refusals
    )

    openapi["paths"]["/dynamic-generation"]["get"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"] = {"$dynamicRef": "https://example.invalid/raw-backup.yaml"}
    external_refusals = global_control_evidence_refusals(
        source, dump_yaml(openapi, sort_keys=False)
    )
    assert (
        "customer OpenAPI cannot be inspected: external OpenAPI reference is not inspectable: "
        "https://example.invalid/raw-backup.yaml"
    ) in external_refusals


def test_openapi_effective_fields_cover_ref_siblings_and_choice_semantics() -> None:
    signature = FORBIDDEN_CUSTOMER_BACKUP_SCHEMA_SIGNATURES["catalogue-state"]
    fields = sorted(signature)
    split = len(fields) // 2

    def document(schema: Mapping[str, object]) -> str:
        return dump_yaml(
            {
                "openapi": "3.1.0",
                "info": {"title": "scope mutation", "version": "1.0.0"},
                "paths": {
                    "/scope": {
                        "get": {
                            "responses": {
                                "200": {
                                    "description": "scope",
                                    "content": {"application/json": {"schema": schema}},
                                }
                            }
                        }
                    }
                },
                "components": {
                    "schemas": {
                        "ScopeBase": {
                            "type": "object",
                            "properties": {field: {"type": "string"} for field in fields[:split]},
                        },
                        "ScopeTail": {
                            "type": "object",
                            "properties": {field: {"type": "string"} for field in fields[split:]},
                        },
                    }
                },
            },
            sort_keys=False,
        )

    ref_sibling = {
        "$ref": "#/components/schemas/ScopeBase",
        "properties": {field: {"type": "string"} for field in fields[split:]},
    }
    assert signature in reachable_openapi_property_sets(document(ref_sibling))

    one_of = {
        "oneOf": [
            {"$ref": "#/components/schemas/ScopeBase"},
            {"$ref": "#/components/schemas/ScopeTail"},
        ]
    }
    assert signature not in reachable_openapi_property_sets(document(one_of))

    any_of = {
        "anyOf": [
            {"$ref": "#/components/schemas/ScopeBase"},
            {"$ref": "#/components/schemas/ScopeTail"},
        ]
    }
    assert signature in reachable_openapi_property_sets(document(any_of))


@pytest.mark.parametrize(
    "unclassified_table",
    [
        (
            "### `UnclassifiedGlobalRow`\n\n"
            "| Field | Type | Notes |\n"
            "|---|---|---|\n"
            "| `id` | UUIDv7 | |\n\n"
        ),
        (
            "### `UnclassifiedQueueRow` (`jobs_unclassified`)\n\n"
            "| Column | Type | Notes |\n"
            "|---|---|---|\n"
            "| `id` | UUIDv7 | |\n\n"
        ),
        (
            "### `UnclassifiedAuditRow`\n\n"
            "Persisted evidence schema. Summary of columns: `id`, `payload`.\n\n"
        ),
        (
            "### `UnclassifiedProseRow`\n\n"
            "Persisted evidence table with columns `id` and `payload`.\n\n"
        ),
        (
            "### `UnclassifiedPairA` and `UnclassifiedPairB`\n\n"
            "Two persisted evidence rows described without a field table.\n\n"
        ),
    ],
)
def test_new_normative_table_requires_explicit_scope_classification(
    unclassified_table: str,
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = source.replace(
        "## 12. Entity relationships", unclassified_table + "## 12. Entity relationships", 1
    )
    assert "normative model tables are not exhaustively scope-classified" in (
        global_control_evidence_refusals(mutant)
    )


def test_computed_projections_have_no_runtime_model_or_migration_table() -> None:
    assert non_persisted_projection_runtime_refusals() == []


def test_the_stored_ticket_exemption_lapses_with_the_departure() -> None:
    source = MODEL.read_text(encoding="utf-8")
    assert source.count(STORED_WHILE_NO_HELPDESK_CLAUSE) == 1
    without = source.replace(STORED_WHILE_NO_HELPDESK_CLAUSE, "**Departure removed.**")
    assert non_persisted_projection_runtime_refusals(model_source=without) == [
        "non-persisted projection registered as Django model: SupportTicket",
        "non-persisted projection created by Django migration: SupportTicket",
    ]


@pytest.mark.parametrize(
    ("name", "app_label", "db_table"),
    [
        ("SupportTicket", "billing", "support_supportticket"),
        ("SupportTicket", "support", "support_ticket_copy"),
        ("TicketCopy", "support", "support_supportticket_copy"),
        ("Entitlement", "support", "support_supportticket"),
    ],
)
def test_the_stored_ticket_exemption_covers_one_table_of_one_app(
    monkeypatch: pytest.MonkeyPatch, name: str, app_label: str, db_table: str
) -> None:
    from django.apps import apps as django_apps

    meta = type("Meta", (), {"app_label": app_label, "db_table": db_table})()
    model = type(name, (), {"_meta": meta})
    monkeypatch.setattr(django_apps, "get_models", lambda: [model])
    assert non_persisted_projection_runtime_refusals(migration_names=set())


def _migration(root: Path, app: str, name: str, operations: str) -> None:
    folder = root / "apps" / app / "migrations"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text(
        "from django.db import migrations, models\n\n"
        "class Migration(migrations.Migration):\n"
        f"    operations = [{operations}]\n",
        encoding="utf-8",
    )


EXEMPT_CREATE = "migrations.CreateModel(name='SupportTicket', fields=[])"


@pytest.mark.parametrize(
    ("app", "name", "operations"),
    [
        ("billing", "0001_initial.py", EXEMPT_CREATE),
        (
            "support",
            "0002_archive.py",
            "migrations.RunSQL('CREATE TABLE support_ticket_archive (id bigint)')",
        ),
        (
            "support",
            "0002_view.py",
            "migrations.RunSQL('CREATE VIEW supportticket_view AS SELECT 1')",
        ),
        ("support", "0002_second.py", EXEMPT_CREATE),
    ],
)
def test_the_stored_ticket_exemption_covers_one_operation_of_one_migration(
    tmp_path: Path, app: str, name: str, operations: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    _migration(tmp_path, "support", "0001_initial.py", EXEMPT_CREATE)
    assert migration_names_while_no_helpdesk(source, tmp_path) == set()
    _migration(tmp_path, app, name, operations)
    assert migration_names_while_no_helpdesk(source, tmp_path) == {"SupportTicket"}


@pytest.mark.parametrize(
    "operations",
    [
        EXEMPT_CREATE + ", migrations.RunSQL('CREATE TABLE support_ticket_copy (id bigint)')",
        "migrations.CreateModel(name='SupportTicket', fields=[], options={'db_table': 'x'})",
        EXEMPT_CREATE + ", " + EXEMPT_CREATE,
    ],
)
def test_the_exempt_migration_carries_nothing_else_that_persists_the_ticket(
    tmp_path: Path, operations: str
) -> None:
    _migration(tmp_path, "support", "0001_initial.py", operations)
    source = MODEL.read_text(encoding="utf-8")
    assert migration_names_while_no_helpdesk(source, tmp_path) == {"SupportTicket"}


def test_the_stored_ticket_migration_exemption_lapses_with_the_departure(tmp_path: Path) -> None:
    _migration(tmp_path, "support", "0001_initial.py", EXEMPT_CREATE)
    source = MODEL.read_text(encoding="utf-8").replace(STORED_WHILE_NO_HELPDESK_CLAUSE, "")
    assert migration_names_while_no_helpdesk(source, tmp_path) == {"SupportTicket"}


def test_computed_projection_runtime_reflection_inspects_physical_table_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from django.apps import apps as django_apps

    class Meta:
        db_table = "organisation_bootstrap"

    class HarmlessCache:
        _meta = Meta()

    monkeypatch.setattr(django_apps, "get_models", lambda: [HarmlessCache])
    assert (
        "non-persisted projection registered as Django model: OrganisationBootstrap"
        in non_persisted_projection_runtime_refusals(migration_names=set())
    )
    runtime_mutant = non_persisted_projection_runtime_refusals(
        model_names={"OrganisationBootstrap"}, migration_names=set()
    )
    assert runtime_mutant == [
        "non-persisted projection registered as Django model: OrganisationBootstrap"
    ]
    migration_mutant = non_persisted_projection_runtime_refusals(
        model_names=set(), migration_names={"Entitlement", "SupportTicket"}
    )
    assert migration_mutant == [
        "non-persisted projection created by Django migration: Entitlement, SupportTicket"
    ]


def test_migration_projection_scanner_catches_aliases_and_raw_tables(tmp_path: Path) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        "from django.db.migrations import CreateModel as CM, RunSQL as SQL\n"
        'DDL = \'CREATE UNLOGGED TABLE "public"."support_ticket" (id bigint)\'\n'
        "MODEL = migrations.CreateModel\n"
        "operations = [\n"
        "    CM(name='OrganisationBootstrap', fields=[]),\n"
        "    MODEL(name='Entitlement', fields=[]),\n"
        "    SQL(DDL),\n"
        "]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == {
        "OrganisationBootstrap",
        "Entitlement",
        "SupportTicket",
    }


@pytest.mark.parametrize(
    ("declarations", "sql_expression"),
    [
        (
            "DDL = 'CREATE ' + 'TABLE organisation_bootstrap (id bigint)'\nDDL2 = DDL\n",
            "DDL2",
        ),
        (
            "NAME = 'organisation_bootstrap'\n"
            "DDL = f'CREATE FOREIGN TABLE {NAME} (id bigint) SERVER archive'\n",
            "DDL",
        ),
        ("DDL = 'SELECT 1 INTO public.organisation_bootstrap'\n", "DDL"),
        (
            "DDL = 'CREATE TABLE ' + ''.join(['organisation_', 'bootstrap'])\n",
            "DDL",
        ),
        (
            "TABLE = 'organisation_bootstrap'\nDDL = 'CREATE TABLE {} (id bigint)'.format(TABLE)\n",
            "DDL",
        ),
    ],
)
def test_migration_projection_scanner_resolves_static_sql_persistence_forms(
    tmp_path: Path, declarations: str, sql_expression: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        + declarations
        + f"operations = [migrations.RunSQL({sql_expression})]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == {"OrganisationBootstrap"}


@pytest.mark.parametrize(
    "declaration",
    [
        "from pathlib import Path\nDDL = Path('schema.sql').read_text()\n",
        "DDL = build_schema_sql()\n",
    ],
)
def test_migration_projection_scanner_fails_closed_on_runtime_sql(
    tmp_path: Path, declaration: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        + declaration
        + "operations = [migrations.RunSQL(DDL)]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) & set(NON_PERSISTED_MODEL_PROJECTIONS)


@pytest.mark.parametrize(
    "source",
    [
        (
            "from django.db import migrations\n"
            "DDL = 'CREATE TABLE support_ticket (id bigint)'\n"
            "class Migration:\n"
            "    operations = [migrations.RunSQL(DDL)]\n"
            "DDL = 'SELECT 1'\n"
        ),
        (
            "from django.db import migrations\n"
            "def decorate(function):\n    return function\n"
            "@decorate\n"
            "def build_schema_sql():\n    return 'CREATE TABLE support_ticket (id bigint)'\n"
            "DDL = build_schema_sql()\n"
            "operations = [migrations.RunSQL(DDL)]\n"
        ),
        (
            "from django.db import migrations\n"
            "def build_schema_sql():\n    return 'CREATE TABLE support_ticket (id bigint)'\n"
            "build_schema_sql = lambda: 'SELECT 1'\n"
            "DDL = build_schema_sql()\n"
            "operations = [migrations.RunSQL(DDL)]\n"
        ),
        (
            "from django.db import migrations\n"
            "DDL = 'SELECT 1'\n"
            "if True:\n    DDL = 'CREATE TABLE support_ticket (id bigint)'\n"
            "operations = [migrations.RunSQL(DDL)]\n"
        ),
        (
            "from django.db import migrations\n"
            "DDL = 'SELECT 1'\n"
            "for DDL in ['CREATE TABLE support_ticket (id bigint)']:\n    pass\n"
            "operations = [migrations.RunSQL(DDL)]\n"
        ),
        (
            "from django.db import migrations\n"
            "DDL = 'SELECT 1'\n"
            "(DDL := 'CREATE TABLE support_ticket (id bigint)')\n"
            "operations = [migrations.RunSQL(DDL)]\n"
        ),
        (
            "from django.db import migrations\n"
            "DDL = 'SELECT 1'\n"
            "match 'CREATE TABLE support_ticket (id bigint)':\n"
            "    case DDL:\n        pass\n"
            "operations = [migrations.RunSQL(DDL)]\n"
        ),
        (
            "from django.db import migrations\n"
            "DDL = 'SELECT 1'\n"
            "match object():\n"
            "    case _ if (DDL := 'CREATE TABLE support_ticket (id bigint)'):\n        pass\n"
            "operations = [migrations.RunSQL(DDL)]\n"
        ),
        (
            "from django.db import migrations\n"
            "DDL = 'SELECT 1'\n"
            "class Migration:\n"
            "    DDL = 'CREATE TABLE support_ticket (id bigint)'\n"
            "    operations = [migrations.RunSQL(DDL)]\n"
        ),
        (
            "from django.db import migrations\n"
            "DDL = 'SELECT 1'\n"
            "DDL, _ = ('CREATE TABLE support_ticket (id bigint)', None)\n"
            "operations = [migrations.RunSQL(DDL)]\n"
        ),
        (
            "from django.db import migrations\n"
            "DDL = 'SELECT 1'\n"
            "if True:\n    from payload import DDL\n"
            "operations = [migrations.RunSQL(DDL)]\n"
        ),
        (
            "from django.db import migrations\n"
            "DDL = 'SELECT 1'\n"
            "from payload import *\n"
            "operations = [migrations.RunSQL(DDL)]\n"
        ),
        (
            "from django.db import migrations\n"
            "class Migration:\n"
            "    DDL = 'SELECT 1'\n"
            "    DDL, _ = ('CREATE TABLE support_ticket (id bigint)', None)\n"
            "    operations = [migrations.RunSQL(DDL)]\n"
        ),
        (
            "from django.db import migrations\n"
            "DDL = 'SELECT 1'\n"
            "def marker(value=(DDL := 'CREATE TABLE support_ticket (id bigint)')):\n"
            "    return value\n"
            "operations = [migrations.RunSQL(DDL)]\n"
        ),
        (
            "from django.db import migrations\n"
            "DDL = 'SELECT 1'\n"
            "def decorate(value):\n    return lambda function: function\n"
            "@decorate((DDL := 'CREATE TABLE support_ticket (id bigint)'))\n"
            "def marker():\n    pass\n"
            "operations = [migrations.RunSQL(DDL)]\n"
        ),
    ],
)
def test_migration_projection_scanner_fails_closed_on_rebound_sql_bindings(
    tmp_path: Path, source: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(source, encoding="utf-8")
    assert migration_create_model_names(tmp_path) == set(NON_PERSISTED_MODEL_PROJECTIONS)


def test_migration_projection_scanner_allows_the_canonical_run_sql_noop(tmp_path: Path) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        "operations = [migrations.RunSQL(migrations.RunSQL.noop)]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set()


def test_migration_projection_scanner_allows_explicit_none_reverse_operations(
    tmp_path: Path,
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        "def forwards(apps, editor):\n    pass\n"
        "operations = [\n"
        "    migrations.RunSQL('SELECT 1', reverse_sql=None),\n"
        "    migrations.RunPython(forwards, reverse_code=None),\n"
        "]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set()


def test_migration_projection_scanner_recognises_getattr_operation_aliases(tmp_path: Path) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        "SQL = getattr(migrations, 'RunSQL')\n"
        "PYTHON = getattr(migrations, 'RunPython')\n"
        "def forwards(apps, editor):\n"
        "    editor.execute('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        "operations = [\n"
        "    SQL('CREATE TABLE support_ticket (id bigint)'),\n"
        "    PYTHON(forwards),\n"
        "]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == {
        "OrganisationBootstrap",
        "SupportTicket",
    }


def test_migration_projection_scanner_recognises_computed_getattr_operation_aliases(
    tmp_path: Path,
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        "MIGRATIONS = migrations\n"
        "MODEL = getattr(MIGRATIONS, 'Create' + 'Model')\n"
        "SQL = vars(MIGRATIONS)['Run' + 'SQL']\n"
        "PYTHON = MIGRATIONS.__dict__['Run' + 'Python']\n"
        "def forwards(apps, editor):\n"
        "    editor.execute('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        "operations = [\n"
        "    MODEL(name='Entitlement', fields=[]),\n"
        "    SQL('CREATE TABLE support_ticket (id bigint)'),\n"
        "    PYTHON(forwards),\n"
        "]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set(NON_PERSISTED_MODEL_PROJECTIONS)


@pytest.mark.parametrize(
    "operation",
    [
        (
            "migrations.CreateModel(name='HarmlessCache', fields=[], "
            "options={'db_table': 'organisation_bootstrap'})"
        ),
        "migrations.CreateModel('HarmlessCache', [], {'db_table': 'support_ticket'})",
        "migrations.CreateModel(**KWARGS)",
        "migrations.AlterModelTable(name='harmlesscache', table='support_ticket')",
        "migrations.RenameModel(old_name='HarmlessCache', new_name='Entitlement')",
    ],
)
def test_migration_projection_scanner_inspects_model_table_identity_operations(
    tmp_path: Path, operation: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n" + f"operations = [{operation}]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) & set(NON_PERSISTED_MODEL_PROJECTIONS)


def test_migration_projection_scanner_fails_closed_on_custom_database_operation(
    tmp_path: Path,
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        "class CreateProjection(migrations.operations.base.Operation):\n"
        "    def database_forwards(self, app_label, schema_editor, from_state, to_state):\n"
        "        schema_editor.execute('CREATE TABLE support_ticket (id bigint)')\n"
        "operations = [CreateProjection()]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set(NON_PERSISTED_MODEL_PROJECTIONS)


@pytest.mark.parametrize(
    "declaration",
    [
        (
            "def build_ops():\n    return []\n"
            "class Migration(migrations.Migration):\n    operations = build_ops()\n"
        ),
        "from shared import OPS\nclass Migration(migrations.Migration):\n    operations = OPS\n",
        (
            "from shared import CreateProjection\n"
            "OPS = [CreateProjection()]\n"
            "class Migration(migrations.Migration):\n    operations = OPS\n"
        ),
        (
            "from shared import CUSTOM\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [*CUSTOM]\n"
        ),
        (
            "from shared import CreateProjection\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.SeparateDatabaseAndState("
            "[CreateProjection()], [])]\n"
        ),
        (
            "from payload import migrations\n"
            "class Migration:\n"
            "    operations = [migrations.AddField()]\n"
        ),
        (
            "import payload\n"
            "migrations = payload\n"
            "class Migration:\n"
            "    operations = [migrations.AddField()]\n"
        ),
        (
            "from shared import payload\n"
            "class Migration(migrations.Migration):\n"
            "    migrations = payload\n"
            "    operations = [migrations.AddField()]\n"
        ),
        (
            "from shared import CreateProjection\n"
            "S = migrations.SeparateDatabaseAndState\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [S(database_operations=[CreateProjection()])]\n"
        ),
        (
            "class BaseMigration(migrations.Migration):\n"
            "    operations = []\n"
            "class Migration(BaseMigration):\n"
            "    pass\n"
        ),
        (
            "from django.db.migrations import AddField\n"
            "from shared import CreateProjection\n"
            "AddField = CreateProjection\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [AddField()]\n"
        ),
        (
            "from django.db.migrations import RunPython\n"
            "from shared import payload\n"
            "RunPython = payload\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [RunPython()]\n"
        ),
        (
            "from shared import ITEMS, CreateProjection\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [CreateProjection() for _ in ITEMS]\n"
        ),
    ],
)
def test_migration_projection_scanner_fails_closed_on_indirect_operation_lists(
    tmp_path: Path, declaration: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n" + declaration,
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set(NON_PERSISTED_MODEL_PROJECTIONS)


@pytest.mark.parametrize(
    "declaration",
    [
        (
            "from django.db.migrations import AddField\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [AddField(model_name='harmless', name='label', field=None)]\n"
        ),
        (
            "from django.db.migrations import AlterModelTable as AMT\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [AMT(name='harmless', table='harmless_table')]\n"
        ),
        (
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.operations.AddField("
            "model_name='harmless', name='label', field=None)]\n"
        ),
        (
            "import django.db.migrations as mig\n"
            "class Migration(mig.Migration):\n"
            "    operations = [mig.AddField("
            "model_name='harmless', name='label', field=None)]\n"
        ),
        (
            "from django.db.migrations import operations as ops\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [ops.AddField("
            "model_name='harmless', name='label', field=None)]\n"
        ),
        (
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.SeparateDatabaseAndState("
            "database_operations=None, state_operations=None)]\n"
        ),
        (
            "BaseMigration = migrations.Migration\n"
            "class Migration(BaseMigration):\n"
            "    operations = []\n"
        ),
        (
            "from django.db.migrations import Migration as BaseMigration\n"
            "def helper():\n"
            "    from shared import EvilMigration as BaseMigration\n"
            "class Migration(BaseMigration):\n"
            "    operations = []\n"
        ),
        (
            "constant = 1\n"
            "def helper():\n"
            "    from shared import mutator as constant\n"
            "value = constant\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "def helper():\n"
            "    from shared import mutator as trigger\n"
            "def trigger():\n"
            "    return 1\n"
            "trigger()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "LOCAL_ITEMS = (1, 2)\n"
            "def trigger(value=[item for item in LOCAL_ITEMS]):\n"
            "    pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "globals = ('core', '0001')\n"
            "dependency = globals\n"
            "class Migration(migrations.Migration):\n"
            "    dependencies = [dependency]\n"
            "    operations = []\n"
        ),
    ],
)
def test_migration_projection_scanner_allows_supported_django_operation_forms(
    tmp_path: Path, declaration: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n" + declaration,
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set()


@pytest.mark.parametrize(
    "declaration",
    [
        (
            "from django.db import models\n"
            "def factory():\n"
            "    value = models.Q()\n"
            "    def unused(value):\n"
            "        return value.upper()\n"
            "    return value\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    value = 'safe'\n"
            "    def unused():\n"
            "        value = models.Q()\n"
            "        return value\n"
            "    return value.upper()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    def provider():\n"
            "        def unused():\n"
            "            return models.Q()\n"
            "        return 'safe'\n"
            "    return provider().upper()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "ALIAS = 'safe'\n"
            "def unused():\n"
            "    for ALIAS in [OPTIONS]:\n"
            "        pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': ALIAS.upper()})]\n"
        ),
    ],
)
def test_migration_projection_scanner_preserves_nested_function_scope(
    tmp_path: Path, declaration: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n" + declaration,
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set()


@pytest.mark.parametrize(
    "header",
    [
        "def unused(value=(ALIAS := OPTIONS)):\n    pass\n",
        "def unused(value: (ALIAS := OPTIONS)):\n    pass\n",
        (
            "def decorator(value):\n"
            "    return lambda function: function\n"
            "@decorator((ALIAS := OPTIONS))\n"
            "def unused():\n"
            "    pass\n"
        ),
        "class Unused((ALIAS := OPTIONS).__class__):\n    pass\n",
    ],
)
def test_migration_projection_scanner_tracks_executable_nested_headers(
    tmp_path: Path, header: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations, models\n"
        "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
        + header
        + "class Migration(migrations.Migration):\n"
        "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
        "ALIAS['deferrable'].__class__.__new__.__globals__['sys']"
        ".modules['django.db'].connection.cursor().execute("
        "'CREATE TABLE entitlement (id bigint)')})]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set(NON_PERSISTED_MODEL_PROJECTIONS)


@pytest.mark.parametrize(
    ("declaration", "expected"),
    [
        (
            "ALIAS: object\nclass Migration(migrations.Migration):\n    operations = []\n",
            set(),
        ),
        (
            "operations: list[object]\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n",
            set(),
        ),
        (
            "from django.db import connection\n"
            "operations: connection.cursor().execute("
            "'CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "class Migration(migrations.Migration):\n    operations: list[object]\n",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
    ],
)
def test_migration_projection_scanner_handles_annotation_only_assignments(
    tmp_path: Path, declaration: str, expected: set[str]
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n" + declaration,
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == expected


@pytest.mark.parametrize(
    ("binding", "access"),
    [
        ("providers = [Provider()]", "providers[0].make()"),
        ("providers = {'x': Provider()}", "providers['x'].make()"),
        (
            "providers = [candidate for candidate in [Provider()]]",
            "providers[0].make()",
        ),
        ("provider = Provider() if True else None", "provider.make()"),
        ("provider, = (Provider(),)", "provider.make()"),
        (
            "providers = []\n    providers.append(Provider())",
            "providers[0].make()",
        ),
        (
            "providers = []\n    providers.extend([Provider()])",
            "providers[0].make()",
        ),
        (
            "providers = []\n    providers.insert(0, Provider())",
            "providers[0].make()",
        ),
        (
            "providers = {}\n    providers.update({'x': Provider()})",
            "providers['x'].make()",
        ),
        (
            "providers = {}\n    providers.setdefault('x', Provider())",
            "providers['x'].make()",
        ),
        (
            "provider = Provider()\n    methods = [provider.make]",
            "methods[0]()",
        ),
        ("types = [Provider]", "types[0]().make()"),
        (
            "class Child(Provider):\n        pass\n    provider = Child()",
            "provider.make()",
        ),
    ],
)
def test_migration_projection_scanner_tracks_structured_provider_instances(
    tmp_path: Path, binding: str, access: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations, models\n"
        "def factory():\n"
        "    class Provider:\n"
        "        def make(self):\n"
        "            return models.Q()\n"
        f"    {binding}\n"
        f"    value = {access}\n"
        "    return value.__class__.__init__.__globals__['connections']['default']"
        ".cursor().execute('CREATE TABLE entitlement (id bigint)')\n"
        "class Migration(migrations.Migration):\n"
        "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set(NON_PERSISTED_MODEL_PROJECTIONS)


@pytest.mark.parametrize(
    "builder_body",
    [
        "        provider = Provider()\n        return provider\n",
        "        return Provider() if True else Provider()\n",
    ],
)
def test_migration_projection_scanner_tracks_structured_instance_builders(
    tmp_path: Path, builder_body: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations, models\n"
        "def factory():\n"
        "    class Provider:\n"
        "        def make(self):\n"
        "            return models.Q()\n"
        "    def build():\n" + builder_body + "    provider = build()\n"
        "    value = provider.make()\n"
        "    return value.__class__.__init__.__globals__['connections']['default']"
        ".cursor().execute('CREATE TABLE support_ticket (id bigint)')\n"
        "class Migration(migrations.Migration):\n"
        "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set(NON_PERSISTED_MODEL_PROJECTIONS)


@pytest.mark.parametrize(
    "provider_flow",
    [
        "    provider = Provider()\n    make = provider.make\n    value = make()\n",
        (
            "    def invoke(callback):\n"
            "        return callback()\n"
            "    provider = Provider()\n"
            "    value = invoke(provider.make)\n"
        ),
        (
            "    def provider_type():\n"
            "        return Provider\n"
            "    provider = provider_type()()\n"
            "    value = provider.make()\n"
        ),
        (
            "    def provider_type():\n"
            "        selected = Provider\n"
            "        return selected\n"
            "    provider = provider_type()()\n"
            "    value = provider.make()\n"
        ),
    ],
)
def test_migration_projection_scanner_tracks_bound_and_class_provider_flows(
    tmp_path: Path, provider_flow: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations, models\n"
        "def factory():\n"
        "    class Provider:\n"
        "        def make(self):\n"
        "            return models.Q()\n"
        + provider_flow
        + "    return value.__class__.__init__.__globals__['connections']['default']"
        ".cursor().execute('CREATE TABLE entitlement (id bigint)')\n"
        "class Migration(migrations.Migration):\n"
        "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set(NON_PERSISTED_MODEL_PROJECTIONS)


def test_migration_projection_scanner_rejects_ambiguous_instance_builder_origins(
    tmp_path: Path,
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations, models\n"
        "def factory():\n"
        "    class Alpha:\n"
        "        def make_alpha(self):\n"
        "            return models.Q()\n"
        "    class Beta:\n"
        "        def make_beta(self):\n"
        "            return models.Q()\n"
        "    def build():\n"
        "        return Beta() if True else Alpha()\n"
        "    provider = build()\n"
        "    value = provider.make_beta()\n"
        "    return value.__class__.__init__.__globals__['connections']['default']"
        ".cursor().execute('CREATE TABLE entitlement (id bigint)')\n"
        "class Migration(migrations.Migration):\n"
        "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set(NON_PERSISTED_MODEL_PROJECTIONS)


@pytest.mark.parametrize(
    "provider_flow",
    [
        "    result = Provider().make()\n",
        "    providers = [Provider()]\n    result = providers[0].make()\n",
        ("    class Child(Provider):\n        pass\n    result = Child().make()\n"),
    ],
)
def test_migration_projection_scanner_tracks_restricted_nested_class_methods(
    tmp_path: Path, provider_flow: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations, models\n"
        "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
        "def get_options():\n"
        "    class Provider:\n"
        "        def make(self):\n"
        "            return OPTIONS\n"
        + provider_flow
        + "    result['deferrable'].__class__.__new__.__globals__['sys']"
        ".modules['django.db'].connection.cursor().execute("
        "'CREATE TABLE support_ticket (id bigint)')\n"
        "    return OPTIONS\n"
        "def forwarder(**kwargs):\n"
        "    return models.UniqueConstraint(**kwargs)\n"
        "class Migration(migrations.Migration):\n"
        "    operations = [migrations.AddConstraint("
        "model_name='probe', constraint=forwarder(**get_options()))]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set(NON_PERSISTED_MODEL_PROJECTIONS)


@pytest.mark.parametrize(
    "declaration",
    [
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "    operations += [ProjectionOperation()]\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "    operations.append(ProjectionOperation())\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "Migration.operations.append(ProjectionOperation())\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "    if True:\n        operations = [ProjectionOperation()]\n"
        ),
        (
            "from shared import payload_ops\n"
            "migrations.operations = payload_ops\n"
            "class Migration:\n"
            "    operations = [migrations.operations.AddField()]\n"
        ),
        (
            "from shared import custom\n"
            "migrations.RunSQL = custom\n"
            "class Migration:\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "    alias = operations\n"
            "    alias.append(ProjectionOperation())\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "alias = Migration.operations\n"
            "alias.append(ProjectionOperation())\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "    getattr(operations, 'append')(ProjectionOperation())\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "    operations[:] = [ProjectionOperation()]\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.AddField()]\n"
            "    operations[0] = ProjectionOperation()\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.AddField()]\n"
            "Migration.operations[0] = ProjectionOperation()\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "M = Migration\n"
            "M.operations.append(ProjectionOperation())\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "setattr(Migration, 'operations', [ProjectionOperation()])\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "Migration.__dict__['operations'].append(ProjectionOperation())\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "vars(Migration)['operations'].append(ProjectionOperation())\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "    vars()['operations'].append(ProjectionOperation())\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "M, = (Migration,)\n"
            "M.operations.append(ProjectionOperation())\n"
        ),
        (
            "from shared import custom\n"
            "migrations.__dict__['RunSQL'] = custom\n"
            "class Migration:\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import custom\n"
            "setattr(migrations, 'RunSQL', custom)\n"
            "class Migration:\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import custom\n"
            "setter = setattr\n"
            "setter(migrations, 'RunSQL', custom)\n"
            "class Migration:\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import custom\n"
            "setters = [setattr]\n"
            "setters[0](migrations, 'RunSQL', custom)\n"
            "class Migration:\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import custom\n"
            "modules = [migrations]\n"
            "modules[0].RunSQL = custom\n"
            "class Migration:\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import custom\n"
            "m = (migrations,)[0]\n"
            "m.RunSQL = custom\n"
            "class Migration:\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "M = (Migration,)[0]\n"
            "M.operations.append(ProjectionOperation())\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "classes = [Migration]\n"
            "classes[0].operations.append(ProjectionOperation())\n"
        ),
        (
            "from shared import ProjectionOperation\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "NAME = 'opera' + 'tions'\n"
            "vars(Migration)[NAME].append(ProjectionOperation())\n"
        ),
        (
            "from shared import mutate\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "mutate(Migration)\n"
        ),
        (
            "from shared import mutate\n"
            "@mutate\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import ImportedMutatingMeta\n"
            "class Migration(migrations.Migration, metaclass=ImportedMutatingMeta):\n"
            "    operations = []\n"
        ),
        (
            "from shared import custom\n"
            "mods = {'m': migrations}\n"
            "m = mods.get('m')\n"
            "m.RunSQL = custom\n"
            "class Migration:\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import custom\n"
            "mods = [migrations]\n"
            "m = mods.pop()\n"
            "m.RunSQL = custom\n"
            "class Migration:\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import mutate\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "def trigger(value=mutate(Migration)):\n"
            "    pass\n"
        ),
        (
            "from shared import custom\n"
            "def rebind(namespace):\n"
            "    namespace.RunSQL = custom\n"
            "rebind(migrations)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import custom\n"
            "def rebind(namespace):\n"
            "    namespace.RunSQL = custom\n"
            "helpers = {'rebind': rebind}\n"
            "helpers['rebind'](migrations)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import custom\n"
            "class Helpers:\n"
            "    @staticmethod\n"
            "    def rebind(namespace):\n"
            "        namespace.RunSQL = custom\n"
            "Helpers.rebind(migrations)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import custom\n"
            "def trigger():\n"
            "    globals()['migrations'].__dict__.update({'RunSQL': custom})\n"
            "trigger()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import mutate\n"
            "globals().pop('mutate')()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import custom\n"
            "def trigger():\n"
            "    migrations.__dict__.update({'RunSQL': custom})\n"
            "trigger()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import custom\n"
            "class Helpers:\n"
            "    @staticmethod\n"
            "    def trigger():\n"
            "        vars(migrations).update({'RunSQL': custom})\n"
            "Helpers.trigger()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import ImportedCustom\n"
            "NAME = 'opera' + 'tions'\n"
            "def mutate(migration_class):\n"
            "    getattr(migration_class, NAME).append(ImportedCustom())\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "mutate(Migration)\n"
        ),
        (
            "from shared import ImportedCustom\n"
            "NAME = 'opera' + 'tions'\n"
            "def mutate(migration_class):\n"
            "    object.__getattribute__(migration_class, NAME).append(ImportedCustom())\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "mutate(Migration)\n"
        ),
        (
            "from shared import ImportedMutatingProtocol\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "result = ImportedMutatingProtocol[Migration]\n"
        ),
        (
            "from shared import ImportedMutatingProtocol\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "result = ImportedMutatingProtocol | Migration\n"
        ),
        (
            "from shared import ImportedMutatingProtocol\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "result = ImportedMutatingProtocol == Migration\n"
        ),
        (
            "from shared import mutator\n"
            "if mutator:\n"
            "    pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "result = mutator == object()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "result = hash(mutator)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "for item in mutator:\n"
            "    pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "with mutator:\n"
            "    pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "result = f'{mutator}'\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "result = mutator[0]\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "result = mutator.payload\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "result = {mutator}\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "match mutator:\n"
            "    case 1:\n"
            "        pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    result = mutator.payload\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    class Box:\n"
            "        pass\n"
            "    Box.factory = Helper\n"
            "    result = Box.factory()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    Box = {}\n"
            "    Box['factory'] = Helper\n"
            "    result = Box['factory']()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    factory = lambda: Helper\n"
            "    result = factory()()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    factory = lambda value=Helper: value\n"
            "    result = factory()()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    values = [Alias() for Alias in (Helper,)]\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    match Helper:\n"
            "        case Alias:\n"
            "            value = Alias()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    for Alias in (Helper,):\n"
            "        pass\n"
            "    value = Alias()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    if (Alias := Helper):\n"
            "        value = Alias()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    for item in mutator:\n"
            "        pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import ImportedEvilMigration\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "Migration = ImportedEvilMigration\n"
        ),
        (
            "from shared import ImportedEvilMigration\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "Migration, = (ImportedEvilMigration,)\n"
        ),
        ("class Migration(migrations.Migration):\n    operations = []\ndel Migration\n"),
        (
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "from shared import EvilMigration as Migration\n"
        ),
        (
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "import shared as Migration\n"
        ),
        (
            "from django.db.migrations import Migration as BaseMigration\n"
            "from shared import EvilMigration\n"
            "BaseMigration = EvilMigration\n"
            "class Migration(BaseMigration):\n"
            "    operations = []\n"
        ),
        (
            "from django.db.migrations import Migration as BaseMigration\n"
            "from shared import EvilMigration as BaseMigration\n"
            "class Migration(BaseMigration):\n"
            "    operations = []\n"
        ),
        (
            "BaseMigration = migrations.Migration\n"
            "from shared import EvilMigration as BaseMigration\n"
            "class Migration(BaseMigration):\n"
            "    operations = []\n"
        ),
        (
            "from django.db.migrations import Migration as BaseMigration\n"
            "if True:\n"
            "    from shared import EvilMigration as BaseMigration\n"
            "class Migration(BaseMigration):\n"
            "    operations = []\n"
        ),
        (
            "BaseMigration = migrations.Migration\n"
            "if True:\n"
            "    from shared import EvilMigration as BaseMigration\n"
            "class Migration(BaseMigration):\n"
            "    operations = []\n"
        ),
        (
            "from django.db import models as trusted\n"
            "from shared import mutator as trusted\n"
            "result = trusted.payload\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator as trusted\n"
            "def helper():\n"
            "    from django.db import models as trusted\n"
            "result = trusted.payload\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "def helper(value=mutator.payload):\n"
            "    pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "def helper(value=f'{mutator}'):\n"
            "    pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "def helper(value={mutator}):\n"
            "    pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    def helper(self, value: mutator.payload):\n"
            "        pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    def helper(self, value=mutator()):\n"
            "        pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    def helper(self, value: mutator()):\n"
            "        pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "def helper():\n"
            "    return mutator()\n"
            "class Trigger:\n"
            "    def method(self, value=helper()):\n"
            "        pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    def helper():\n"
            "        return mutator()\n"
            "    value = helper()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    value = Helper()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    def wrapper(factory=Helper):\n"
            "        return factory()\n"
            "    value = wrapper()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    def wrapper(factory):\n"
            "        return factory()\n"
            "    value = wrapper(Helper)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    def factory():\n"
            "        return Helper\n"
            "    value = factory()()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    Alias, = (Helper,)\n"
            "    value = Alias()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    [Alias] = [Helper]\n"
            "    value = Alias()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    class Wrapper(Helper):\n"
            "        pass\n"
            "    value = Wrapper()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper(type):\n"
            "        def __new__(cls, *args, **kwargs):\n"
            "            mutator()\n"
            "            return super().__new__(cls, *args, **kwargs)\n"
            "    Alias = Helper\n"
            "    class Wrapper(metaclass=Alias):\n"
            "        pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Trigger:\n"
            "    class Helper:\n"
            "        def __new__(cls):\n"
            "            return mutator()\n"
            "    def wrapper():\n"
            "        return Helper()\n"
            "    value = wrapper()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Outer:\n"
            "    class Inner(mutator):\n"
            "        pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Outer:\n"
            "    @mutator\n"
            "    class Inner:\n"
            "        pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import mutator\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL("
            "'SELECT 1', hints={'probe': mutator.payload})]\n"
        ),
        (
            "from shared import mutator\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.CreateModel("
            "name='Entitlement', fields=[('id', mutator.payload)])]\n"
        ),
        (
            "from shared import mutator\n"
            "def make_field():\n"
            "    return mutator.payload\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.CreateModel("
            "name='Entitlement', fields=[('id', make_field())])]\n"
        ),
        (
            "from shared import mutator\n"
            "def unsafe_field():\n"
            "    return mutator.payload\n"
            "def wrapper():\n"
            "    return unsafe_field()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.CreateModel("
            "name='Entitlement', fields=[('id', wrapper())])]\n"
        ),
        (
            "from shared import mutator\n"
            "def unsafe_field():\n"
            "    return mutator.payload\n"
            "def factory():\n"
            "    return unsafe_field\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.CreateModel("
            "name='Entitlement', fields=[('id', factory()())])]\n"
        ),
        (
            "from shared import mutator\n"
            "def unsafe_field():\n"
            "    return mutator.payload\n"
            "def wrapper(factory=unsafe_field):\n"
            "    return factory()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.CreateModel("
            "name='Entitlement', fields=[('id', wrapper())])]\n"
        ),
        (
            "from shared import mutator\n"
            "def unsafe_field():\n"
            "    return mutator.payload\n"
            "def wrapper(factory):\n"
            "    return factory()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.CreateModel("
            "name='Entitlement', fields=[('id', wrapper(unsafe_field))])]\n"
        ),
        (
            "from shared import mutator\n"
            "def unsafe_field(value):\n"
            "    return mutator.payload\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL("
            "'SELECT 1', hints={'probe': list(map(unsafe_field, [1]))})]\n"
        ),
        (
            "from shared import mutator\n"
            "def unsafe_field(value):\n"
            "    return mutator.payload\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL("
            "'SELECT 1', hints={'probe': sorted([1], key=unsafe_field)})]\n"
        ),
        (
            "import django.db.models.deletion as deletion\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL("
            "'SELECT 1', hints={'probe': deletion.connections['default'].cursor().execute("
            "'CREATE TABLE entitlement (id bigint)')})]\n"
        ),
        (
            "from django.db import models\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL("
            "'SELECT 1', hints={'probe': models.signals.pre_save.send(sender=None)})]\n"
        ),
        (
            "from django.db import models\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL("
            "'SELECT 1', hints={'probe': getattr(models, 'signals').pre_save.send("
            "sender=None)})]\n"
        ),
        (
            "from django.db import models\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL("
            "'SELECT 1', hints={'probe': models.Q().resolve_expression()})]\n"
        ),
        (
            "from django.db import models\n"
            "Signals = models.signals\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL("
            "'SELECT 1', hints={'probe': Signals.pre_save.send(sender=None)})]\n"
        ),
        (
            "from django.db import models\n"
            "Safe = models.Q\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL("
            "'SELECT 1', hints={'probe': Safe().resolve_expression()})]\n"
        ),
        (
            "from django.db import models\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': ("
            "(alias := models.Q), alias.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE entitlement (id bigint)'))[1]})]\n"
        ),
        (
            "from django.db import models\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': ["
            "symbol.__init__.__globals__['connections']['default'].cursor().execute("
            "'CREATE TABLE support_ticket (id bigint)') for symbol in [models.Q]][0]})]\n"
        ),
        (
            "from django.db import models\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': ("
            "lambda symbol: symbol.__init__.__globals__['connections']['default'].cursor()"
            ".execute('CREATE TABLE entitlement (id bigint)'))(models.Q)})]\n"
        ),
        (
            "from django.db import models\n"
            "def exploit(symbol):\n"
            "    return symbol.__init__.__globals__['connections']['default'].cursor().execute("
            "'CREATE TABLE support_ticket (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL("
            "'SELECT 1', hints={'probe': exploit(models.Q)})]\n"
        ),
        (
            "from django.db import models\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': getattr("
            "getattr(getattr(getattr(models.Q, '__init__'), '__globals__')['connections']"
            "['default'], 'cursor')(), 'execute')('CREATE TABLE entitlement (id bigint)')})]\n"
        ),
        (
            "from django.db import models\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': getattr("
            "getattr(getattr(getattr(getattr(models.Q(), '__class__'), '__init__'), "
            "'__globals__')['connections']['default'], 'cursor')(), 'execute')"
            "('CREATE TABLE entitlement (id bigint)')})]\n"
        ),
        (
            "import core.db.ids\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': getattr("
            "getattr(getattr(getattr(core.db.ids.new_uuid7, '__globals__')['__builtins__']"
            "['__import__']('django.db', fromlist=['connection']), 'connection'), 'cursor')(), "
            "'execute')('CREATE TABLE support_ticket (id bigint)')})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    return models.Q()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "factory().__class__.__init__.__globals__['connections']['default'].cursor()"
            ".execute('CREATE TABLE entitlement (id bigint)')})]\n"
        ),
        (
            "import core.db.ids\n"
            "def factory():\n"
            "    return core.db.ids.new_uuid7\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "factory().__globals__['os'].system('true')})]\n"
        ),
        (
            "from django.db import models\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': ("
            "(alias := models.Q()), alias.__class__.__init__.__globals__['connections']"
            "['default'].cursor().execute('CREATE TABLE entitlement (id bigint)'))[1]})]\n"
        ),
        (
            "from django.db import models\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': ["
            "symbol.__class__.__init__.__globals__['connections']['default'].cursor().execute("
            "'CREATE TABLE support_ticket (id bigint)') for symbol in [models.Q()]][0]})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    return models.Q()\n"
            "def wrapper():\n"
            "    return factory()\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "wrapper().__class__.__init__.__globals__['connections']['default'].cursor()"
            ".execute('CREATE TABLE entitlement (id bigint)')})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    return models.signals.pre_save.send(sender=None)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    return models.Q.__init__.__globals__['connections']['default'].cursor().execute("
            "'CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "object.__getattribute__(type.__getattribute__(object.__getattribute__("
            "models.Q(), '__class__'), '__init__'), '__globals__')['connections']"
            "['default'].cursor().execute('CREATE TABLE entitlement (id bigint)')})]\n"
        ),
        (
            "import core.db.ids\n"
            "from django.db import models as Consumer\n"
            "class Evil:\n"
            "    class UUIDField:\n"
            "        def __init__(self, **kwargs):\n"
            "            kwargs['default'].__globals__['os'].system('true')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': ["
            "Consumer.UUIDField(default=core.db.ids.new_uuid7) "
            "for Consumer in [Evil]][0]})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints=OPTIONS)]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "BOX = []\n"
            "BOX += [OPTIONS]\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "BOX[0]['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE support_ticket (id bigint)')})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "for ALIAS in [OPTIONS]:\n"
            "    pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "ALIAS['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE organisation_bootstrap (id bigint)')})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "(ALIAS := OPTIONS)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "ALIAS['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE entitlement (id bigint)')})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "OPTIONS['deferrable'].__class__.__new__.__globals__['sys'].modules['django.db']"
            ".connection.cursor().execute('CREATE TABLE entitlement (id bigint)')})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "def get_options():\n"
            "    return OPTIONS\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "get_options()['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE support_ticket (id bigint)')})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "class Box:\n"
            "    pass\n"
            "Box.options = OPTIONS\n"
            "def get_options():\n"
            "    return Box.options\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "get_options()['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE support_ticket (id bigint)')})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "class Box:\n"
            "    options = {}\n"
            "Box.options['value'] = OPTIONS\n"
            "def get_options():\n"
            "    return Box.options['value']\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "get_options()['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE entitlement (id bigint)')})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "class Box:\n"
            "    options = {}\n"
            "Box.options.update({'value': OPTIONS})\n"
            "def get_options():\n"
            "    return Box.options['value']\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "get_options()['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE organisation_bootstrap (id bigint)')})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    value = models.Q()\n"
            "    return value.__class__.__init__.__globals__['connections']['default'].cursor()"
            ".execute('CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    for value in [models.Q()]:\n"
            "        pass\n"
            "    return value.__class__.__init__.__globals__['connections']['default'].cursor()"
            ".execute('CREATE TABLE support_ticket (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    class Box:\n"
            "        pass\n"
            "    Box.value = models.Q()\n"
            "    return Box.value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    class Box:\n"
            "        pass\n"
            "    setter = setattr\n"
            "    setter(Box, 'value', models.Q())\n"
            "    return Box.value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE organisation_bootstrap (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    class Box:\n"
            "        pass\n"
            "    setattr(Box, 'value', models.Q())\n"
            "    return Box.value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE support_ticket (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    box = {}\n"
            "    box['value'] = models.Q()\n"
            "    return box['value'].__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE organisation_bootstrap (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    values = []\n"
            "    values += [models.Q()]\n"
            "    return values[0].__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    class Box:\n"
            "        pass\n"
            "    (unused, Box.value) = (None, models.Q())\n"
            "    return Box.value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE support_ticket (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    match models.Q():\n"
            "        case value:\n"
            "            return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE organisation_bootstrap (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    values = set()\n"
            "    values.add(models.Q())\n"
            "    return values.pop().__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    def inner():\n"
            "        return models.Q()\n"
            "    value = inner()\n"
            "    return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE support_ticket (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    def inner():\n"
            "        return models.Q()\n"
            "    def wrapper(callback=inner):\n"
            "        return callback()\n"
            "    value = wrapper()\n"
            "    return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE organisation_bootstrap (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    def provider():\n"
            "        def inner():\n"
            "            return models.Q()\n"
            "        return inner\n"
            "    value = provider()()\n"
            "    return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    def inner():\n"
            "        return models.Q()\n"
            "    def invoke(callback):\n"
            "        return callback()\n"
            "    value = invoke(inner)\n"
            "    return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    def inner():\n"
            "        return models.Q()\n"
            "    providers = [inner]\n"
            "    value = providers[0]()\n"
            "    return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE support_ticket (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    def inner():\n"
            "        return models.Q()\n"
            "    providers = [candidate for candidate in [inner]]\n"
            "    value = providers[0]()\n"
            "    return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE organisation_bootstrap (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    def inner():\n"
            "        return models.Q()\n"
            "    alias = inner\n"
            "    value = alias()\n"
            "    return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    def inner():\n"
            "        return models.Q()\n"
            "    def wrapper():\n"
            "        return inner()\n"
            "    value = wrapper()\n"
            "    return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE organisation_bootstrap (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    class Box:\n"
            "        pass\n"
            "    box = Box()\n"
            "    value = models.Q()\n"
            "    def store():\n"
            "        box.value = value\n"
            "    store()\n"
            "    return box.value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE support_ticket (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    class Provider:\n"
            "        @staticmethod\n"
            "        def make():\n"
            "            return models.Q()\n"
            "    value = Provider.make()\n"
            "    return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    class Provider:\n"
            "        def make(self):\n"
            "            return models.Q()\n"
            "    provider = Provider()\n"
            "    value = provider.make()\n"
            "    return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    class Provider:\n"
            "        @classmethod\n"
            "        def make(cls):\n"
            "            return models.Q()\n"
            "    provider = Provider()\n"
            "    value = provider.make()\n"
            "    return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE support_ticket (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    class Provider:\n"
            "        def make(self):\n"
            "            return models.Q()\n"
            "    def build():\n"
            "        return Provider()\n"
            "    provider = build()\n"
            "    value = provider.make()\n"
            "    return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE organisation_bootstrap (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    class Provider:\n"
            "        @staticmethod\n"
            "        def make():\n"
            "            return models.Q()\n"
            "    Alias = Provider\n"
            "    value = Alias.make()\n"
            "    return value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE organisation_bootstrap (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    class Box:\n"
            "        def store(self, value):\n"
            "            self.value = value\n"
            "    box = Box()\n"
            "    box.store(models.Q())\n"
            "    return box.value.__class__.__init__.__globals__['connections']['default']"
            ".cursor().execute('CREATE TABLE organisation_bootstrap (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': factory()})]\n"
        ),
        (
            "from django.db import models\n"
            "def factory():\n"
            "    return models.Q()\n"
            "def wrapper():\n"
            "    value = factory()\n"
            "    return value.__class__.__init__.__globals__['connections']['default'].cursor()"
            ".execute('CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': wrapper()})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "class Evil:\n"
            "    class UniqueConstraint:\n"
            "        def __init__(self, **kwargs):\n"
            "            kwargs['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE support_ticket (id bigint)')\n"
            "def forward(**kwargs):\n"
            "    models = Evil\n"
            "    return models.UniqueConstraint(**kwargs)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "forward(**OPTIONS)})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "def forwarder(**kwargs):\n"
            "    return models.UniqueConstraint(**kwargs)\n"
            "class Evil:\n"
            "    def __call__(self, **kwargs):\n"
            "        return kwargs['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': ["
            "forwarder(**OPTIONS) for forwarder in [Evil()]][0]})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "def forwarder(**kwargs):\n"
            "    return models.UniqueConstraint(**kwargs)\n"
            "class Evil:\n"
            "    def __call__(self, **kwargs):\n"
            "        return kwargs['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE entitlement (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "(lambda forwarder: forwarder(**OPTIONS))(Evil())})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "def forwarder(**kwargs):\n"
            "    return models.UniqueConstraint(**kwargs)\n"
            "class Evil:\n"
            "    def __call__(self, **kwargs):\n"
            "        return kwargs['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE support_ticket (id bigint)')\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': ("
            "(forwarder := Evil()), forwarder(**OPTIONS))[1]})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "class Evil:\n"
            "    class UniqueConstraint:\n"
            "        def __init__(self, **kwargs):\n"
            "            kwargs['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE entitlement (id bigint)')\n"
            "class Context:\n"
            "    def __enter__(self):\n"
            "        return Evil\n"
            "    def __exit__(self, *args):\n"
            "        pass\n"
            "def forwarder(**kwargs):\n"
            "    with Context() as models:\n"
            "        return models.UniqueConstraint(**kwargs)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "forwarder(**OPTIONS)})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "class Evil(Exception):\n"
            "    class UniqueConstraint:\n"
            "        def __init__(self, **kwargs):\n"
            "            kwargs['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE entitlement (id bigint)')\n"
            "def forwarder(**kwargs):\n"
            "    try:\n"
            "        raise Evil()\n"
            "    except Evil as models:\n"
            "        return models.UniqueConstraint(**kwargs)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "forwarder(**OPTIONS)})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "def forwarder(**kwargs):\n"
            "    import evil as models\n"
            "    return models.UniqueConstraint(**kwargs)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "forwarder(**OPTIONS)})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "def get_options():\n"
            "    OPTIONS['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE support_ticket (id bigint)')\n"
            "    return OPTIONS\n"
            "def forwarder(**kwargs):\n"
            "    return models.UniqueConstraint(**kwargs)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "forwarder(**get_options())})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "def get_options():\n"
            "    def inner():\n"
            "        return OPTIONS\n"
            "    alias = inner\n"
            "    result = alias()\n"
            "    result['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE entitlement (id bigint)')\n"
            "    return OPTIONS\n"
            "def forwarder(**kwargs):\n"
            "    return models.UniqueConstraint(**kwargs)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "forwarder(**get_options())})]\n"
        ),
        (
            "from django.db import models\n"
            "OPTIONS = {'deferrable': models.Deferrable.DEFERRED}\n"
            "def get_options():\n"
            "    def inner():\n"
            "        return OPTIONS\n"
            "    result = inner()\n"
            "    result['deferrable'].__class__.__new__.__globals__['sys']"
            ".modules['django.db'].connection.cursor().execute("
            "'CREATE TABLE support_ticket (id bigint)')\n"
            "    return result\n"
            "def forwarder(**kwargs):\n"
            "    return models.UniqueConstraint(**kwargs)\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', hints={'probe': "
            "forwarder(**get_options())})]\n"
        ),
        (
            "import core.db.ids\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL("
            "'SELECT 1', hints={'probe': core.db.ids.os.system('true')})]\n"
        ),
        (
            "from django.db import connection\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL("
            "'SELECT 1', hints={'probe': connection.cursor().execute("
            "'CREATE TABLE entitlement (id bigint)')})]\n"
        ),
        (
            "from django.db.models.signals import pre_save\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL("
            "'SELECT 1', hints={'probe': pre_save.send(sender=None)})]\n"
        ),
        (
            "from shared import mutator\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunSQL('SELECT 1', None, mutator.payload)]\n"
        ),
        (
            "from shared import mutator\n"
            "def forwards(apps, schema_editor):\n"
            "    pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = [migrations.RunPython("
            "forwards, atomic=mutator.payload)]\n"
        ),
        (
            "from shared import EvilMigration\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "globals()['Migration'] = EvilMigration\n"
        ),
        (
            "from shared import EvilMigration\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "globals().update({'Migration': EvilMigration})\n"
        ),
        (
            "from shared import EvilMigration\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "globals().__setitem__('Migration', EvilMigration)\n"
        ),
        (
            "from shared import EvilMigration\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "vars().update({'Migration': EvilMigration})\n"
        ),
        (
            "from shared import EvilMigration\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "locals()['Migration'] = EvilMigration\n"
        ),
        (
            "from shared import EvilMigration\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "locals().update({'Migration': EvilMigration})\n"
        ),
        (
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "def replace():\n"
            "    global Migration\n"
            "    from shared import EvilMigration as Migration\n"
            "replace()\n"
        ),
        (
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "def replace():\n"
            "    global Migration\n"
            "    import shared as Migration\n"
            "replace()\n"
        ),
        (
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "exec('from shared import EvilMigration as Migration')\n"
        ),
        (
            "from shared import EvilMigration\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "namespace = globals\n"
            "namespace()['Migration'] = EvilMigration\n"
        ),
        (
            "from shared import EvilMigration\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "namespace = locals\n"
            "namespace().update({'Migration': EvilMigration})\n"
        ),
        (
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "execute = exec\n"
            "execute('from shared import EvilMigration as Migration')\n"
        ),
        (
            "import builtins\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "builtins.exec('from shared import EvilMigration as Migration')\n"
        ),
        (
            "import sys\n"
            "from shared import EvilMigration\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "setattr(sys.modules[__name__], 'Migration', EvilMigration)\n"
        ),
        (
            "import sys\n"
            "from shared import EvilMigration\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "sys.modules[__name__].Migration = EvilMigration\n"
        ),
        (
            "from shared import MutatingIterable\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "def trigger(value=[item for item in MutatingIterable]):\n"
            "    pass\n"
        ),
        (
            "from shared import mutate\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "def trigger(value: mutate(Migration)):\n"
            "    pass\n"
        ),
        (
            "from shared import mutate\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "def trigger() -> mutate(Migration):\n"
            "    pass\n"
        ),
        (
            "from shared import mutate\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "@mutate\n"
            "async def trigger():\n"
            "    pass\n"
        ),
        (
            "from shared import mutate\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
            "class Trigger(mutate(Migration)):\n"
            "    pass\n"
        ),
        (
            "from shared import mutate\n"
            "@mutate\n"
            "class Secondary:\n"
            "    pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import ImportedMutatingMeta\n"
            "class Secondary(metaclass=ImportedMutatingMeta):\n"
            "    pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import MutatingBase\n"
            "class Trigger(MutatingBase):\n"
            "    pass\n"
            "class Migration(migrations.Migration):\n"
            "    operations = []\n"
        ),
        (
            "from shared import custom\n"
            "def namespace():\n"
            "    return migrations\n"
            "m = namespace()\n"
            "m.RunSQL = custom\n"
            "class Migration:\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
        (
            "from shared import custom\n"
            "object.__setattr__(migrations, 'RunSQL', custom)\n"
            "class Migration:\n"
            "    operations = [migrations.RunSQL('SELECT 1')]\n"
        ),
    ],
)
def test_migration_projection_scanner_fails_closed_on_operation_mutation(
    tmp_path: Path, declaration: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n" + declaration,
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set(NON_PERSISTED_MODEL_PROJECTIONS)


@pytest.mark.parametrize(
    ("table_sql", "expected"),
    [
        ("CREATE INDEX harmless_idx ON harmless(id)", set()),
        ("CREATE INDEX organisation_bootstrap_idx ON harmless(id)", set()),
        ("CREATE TABLE organisation_bootstrap (id bigint)", {"OrganisationBootstrap"}),
        ("CREATE GLOBAL TEMP TABLE support_ticket (id bigint)", {"SupportTicket"}),
        ("CREATE LOCAL TEMPORARY TABLE entitlement (id bigint)", {"Entitlement"}),
        ("CREATE /* guarded */ TABLE support_ticket (id bigint)", {"SupportTicket"}),
        ("SELECT '--'; CREATE TABLE support_ticket (id bigint)", {"SupportTicket"}),
        (r"SELECT E'escaped\'--'; CREATE TABLE support_ticket (id bigint)", {"SupportTicket"}),
        ("DO $$ BEGIN -- CREATE TABLE support_ticket (id bigint)\n NULL; END $$;", set()),
        ("ALTER TABLE harmless RENAME TO support_ticket", {"SupportTicket"}),
        ("ALTER TABLE ONLY harmless RENAME TO support_ticket", {"SupportTicket"}),
        ("ALTER TABLE IF EXISTS ONLY harmless RENAME TO entitlement", {"Entitlement"}),
        (
            "ALTER FOREIGN TABLE harmless RENAME TO organisation_bootstrap",
            {"OrganisationBootstrap"},
        ),
        (
            "ALTER MATERIALIZED VIEW harmless RENAME TO organisation_bootstrap",
            {"OrganisationBootstrap"},
        ),
        (r'CREATE TABLE U&"organisation\005fbootstrap" (id bigint)', {"OrganisationBootstrap"}),
        (
            r'ALTER TABLE harmless RENAME TO U&"organisation\005fbootstrap"',
            {"OrganisationBootstrap"},
        ),
        (
            "CREATE TABLE U&\"organisation!005fbootstrap\" UESCAPE '!' (id bigint)",
            {"OrganisationBootstrap"},
        ),
        (
            "CREATE TABLE U&\"organisation!005fbootstrap\" UESCAPE E'!' (id bigint)",
            {"OrganisationBootstrap"},
        ),
        (
            'CREATE TABLE U&"organisation!005fbootstrap" UESCAPE $$!$$ (id bigint)',
            {"OrganisationBootstrap"},
        ),
        (
            "ALTER TABLE harmless RENAME TO U&\"organisation!005fbootstrap\" UESCAPE '!'",
            {"OrganisationBootstrap"},
        ),
        ('CREATE TABLE "support--ticket" (id bigint)', {"SupportTicket"}),
        ('CREATE TABLE "Entitle""ment" (id bigint)', {"Entitlement"}),
        ("CREATE TABLE entitle\u0301ment (id bigint)", {"Entitlement"}),
        (
            "CREATE MATERIALIZED VIEW support_ticket AS SELECT 1",
            {"SupportTicket"},
        ),
        ('CREATE VIEW "Support""Ticket" AS SELECT 1', {"SupportTicket"}),
        (
            "CREATE RECURSIVE VIEW entitlement(n) AS VALUES (1)",
            {"Entitlement"},
        ),
        (
            "CREATE OR REPLACE RECURSIVE VIEW support_ticket(n) AS VALUES (1)",
            {"SupportTicket"},
        ),
        (
            "CREATE TEMP RECURSIVE VIEW organisation_bootstrap(n) AS VALUES (1)",
            {"OrganisationBootstrap"},
        ),
        ("SELECT 1 INTO UNLOGGED entitlement", {"Entitlement"}),
        ("SELECT 1 INTO TEMPORARY support_ticket", {"SupportTicket"}),
        ("SELECT 1 INTO TEMP TABLE organisation_bootstrap", {"OrganisationBootstrap"}),
        ("INSERT INTO audit_log(message) VALUES ('CREATE TABLE entitlement')", set()),
        (
            "INSERT INTO audit_log(message) VALUES ($msg$CREATE TABLE entitlement$msg$)",
            set(),
        ),
        (
            "DO $$ BEGIN EXECUTE 'CREATE TABLE entitlement (id bigint)'; END $$;",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "DO $$ BEGIN EXECUTE format('CREATE TABLE %I (id bigint)', 'support_ticket'); END $$;",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "CREATE FUNCTION mutate() RETURNS void LANGUAGE plpgsql AS $$ BEGIN "
            "EXECUTE 'CREATE TABLE organisation_bootstrap (id bigint)'; END $$; "
            "SELECT mutate();",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "DO 'BEGIN EXECUTE ''CREATE TABLE entitlement (id bigint)''; END';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "DO 'BEGIN EXE'\n'CUTE ''CREATE TABLE entitlement (id bigint)''; END';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "DO E'BEGIN EXECUTE ''CREATE TABLE support_ticket (id bigint)''; END';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "DO U&'BEGIN EXECUTE ''CREATE TABLE entitlement (id bigint)''; END';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            r"DO U&'BEGIN E\0058ECUTE ''CREATE TABLE entitlement (id bigint)''; END';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "DO U&'BEGIN E!0058ECUTE ''CREATE TABLE support_ticket (id bigint)''; END' "
            "UESCAPE '!';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "DO N'BEGIN EXECUTE ''CREATE TABLE support_ticket (id bigint)''; END';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "DO LANGUAGE plpgsql U&'BEGIN EXECUTE ''CREATE TABLE "
            "organisation_bootstrap (id bigint)''; END';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "CREATE FUNCTION mutate() RETURNS void LANGUAGE plpgsql AS "
            "U&'BEGIN EXECUTE ''CREATE TABLE support_ticket (id bigint)''; END'; "
            "SELECT mutate();",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "CREATE FUNCTION mutate() RETURNS void LANGUAGE plpgsql AS "
            "'BEGIN EXECUTE ''CREATE TABLE organisation_bootstrap (id bigint)''; END'; "
            "SELECT mutate();",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "CREATE FUNCTION mutate(separator text DEFAULT ';') RETURNS void AS $$ BEGIN "
            "EXECUTE 'CREATE TABLE entitlement (id bigint)'; END $$ LANGUAGE plpgsql; "
            "SELECT mutate();",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "CREATE FUNCTION harmless() RETURNS void LANGUAGE plpgsql AS "
            "'BEGIN -- CREATE TABLE entitlement\n NULL; END'; SELECT harmless();",
            set(),
        ),
        (
            "CREATE FUNCTION harmless() RETURNS text AS $$ BEGIN "
            "RETURN 'LANGUAGE plpython3u'; END $$ LANGUAGE plpgsql;",
            set(),
        ),
        (
            "CREATE FUNCTION harmless() RETURNS text AS $$ BEGIN RETURN 'ok'; END $$ "
            "LANGUAGE 'plpgsql';",
            set(),
        ),
        (
            "CREATE FUNCTION harmless() RETURNS text AS $body$ BEGIN RETURN 'ok'; END $body$ "
            "LANGUAGE $lang$plpgsql$lang$;",
            set(),
        ),
        (
            r"CREATE FUNCTION harmless() RETURNS text AS $$ SELECT 'ok' $$ "
            r"LANGUAGE E'plpg\x73ql';",
            set(),
        ),
        (
            r"CREATE FUNCTION harmless() RETURNS text AS $$ SELECT 'ok' $$ "
            r"LANGUAGE E'plpg\u0073ql';",
            set(),
        ),
        (
            r"CREATE FUNCTION harmless() RETURNS text AS $$ SELECT 'ok' $$ "
            r"LANGUAGE E'plpg\sql';",
            set(),
        ),
        (
            r"CREATE FUNCTION harmless() RETURNS text AS $$ SELECT 'ok' $$ "
            r"LANGUAGE U&'plpg\0073ql';",
            set(),
        ),
        (
            r"CREATE FUNCTION harmless() RETURNS text AS $$ SELECT 'ok' $$ "
            r"LANGUAGE U&'plpg!0073ql' UESCAPE E'\x21';",
            set(),
        ),
        (
            r"CREATE FUNCTION harmless() RETURNS text AS $$ SELECT 'ok' $$ "
            r"LANGUAGE U&'plpg!0073ql' UESCAPE $esc$!$esc$;",
            set(),
        ),
        (
            "CREATE FUNCTION harmless() RETURNS text AS $$ SELECT 'ok' $$ LANGUAGE 'plpg'\n'sql';",
            set(),
        ),
        (
            "CREATE FUNCTION mutate() RETURNS void AS $$ SELECT 1 $$ LANGUAGE 'sql'\n'unsafe';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "CREATE FUNCTION mutate() RETURNS void AS $$ SELECT 1 $$ LANGUAGE 'sql'\n\n'unsafe';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "CREATE FUNCTION mutate() RETURNS void AS $$ SELECT 1 $$ LANGUAGE 'sql'\n\f'unsafe';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "CREATE FUNCTION mutate() RETURNS void AS $$ SELECT 1 $$ LANGUAGE 'sql'\f\n'unsafe';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "CREATE FUNCTION mutate() RETURNS void AS $$ SELECT 1 $$ "
            "LANGUAGE 'sql'\n/* separator */\n'unsafe';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "DO LANGUAGE plpython3u $$ plpy.execute('CREATE TABLE entitlement (id bigint)') $$;",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "DO LANGUAGE 'plpython3u' $$ pass $$;",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "DO LANGUAGE $lang$plpython3u$lang$ $body$ pass $body$;",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "CREATE FUNCTION mutate() RETURNS void LANGUAGE plpython3u AS $$ "
            "plpy.execute('CREATE TABLE support_ticket (id bigint)') $$; SELECT mutate();",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "CREATE FUNCTION mutate() RETURNS void AS $$ pass $$ LANGUAGE 'plpython3u';",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "CREATE FUNCTION mutate() RETURNS void AS $body$ pass $body$ "
            "LANGUAGE $lang$plpython3u$lang$;",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "DO LANGUAGE plperl $$ "
            "spi_exec_query('CREATE TABLE organisation_bootstrap (id bigint)'); $$;",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
    ],
)
def test_migration_projection_scanner_inspects_static_run_sql_parameter_lists(
    tmp_path: Path, table_sql: str, expected: set[str]
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        + f"SQL = [({table_sql!r}, None)]\n"
        + "operations = [migrations.RunSQL(SQL)]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == expected


@pytest.mark.parametrize(
    ("callback_body", "expected"),
    [
        (
            "    schema_editor.execute('CREATE TABLE organisation_bootstrap (id bigint)')\n",
            {"OrganisationBootstrap"},
        ),
        (
            "    with schema_editor.connection.cursor() as cursor:\n"
            "        cursor.execute('CREATE TABLE support_ticket (id bigint)')\n",
            {"SupportTicket"},
        ),
        (
            "    schema_editor.execute(load_schema_sql())\n",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "    DDL = 'CREATE TABLE support_ticket (id bigint)'\n    schema_editor.execute(DDL)\n",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "    execute = schema_editor.execute\n"
            "    execute('CREATE TABLE support_ticket (id bigint)')\n",
            {"SupportTicket"},
        ),
        (
            "    execute, _ = (schema_editor.execute, None)\n"
            "    execute('CREATE TABLE support_ticket (id bigint)')\n",
            {"SupportTicket"},
        ),
        (
            "    DDL, _ = ('CREATE TABLE support_ticket (id bigint)', None)\n"
            "    schema_editor.execute(DDL)\n",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "    getattr(schema_editor, 'execute')('CREATE TABLE support_ticket (id bigint)')\n",
            {"SupportTicket"},
        ),
    ],
)
def test_migration_projection_scanner_inspects_run_python_schema_changes(
    tmp_path: Path, callback_body: str, expected: set[str]
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        "def forwards(apps, schema_editor):\n"
        + callback_body
        + "operations = [migrations.RunPython(forwards)]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == expected


def test_migration_projection_scanner_fails_closed_on_run_python_schema_delegation(
    tmp_path: Path,
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        "def make_schema(editor):\n"
        "    editor.execute('CREATE TABLE support_ticket (id bigint)')\n"
        "def forwards(apps, editor):\n"
        "    make_schema(editor)\n"
        "operations = [migrations.RunPython(forwards)]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set(NON_PERSISTED_MODEL_PROJECTIONS)


@pytest.mark.parametrize(
    "callback_body",
    [
        ("    execute = editor.execute\n    execute('CREATE TABLE support_ticket (id bigint)')\n"),
        ("    getattr(editor, 'execute')('CREATE TABLE support_ticket (id bigint)')\n"),
        ("    editor.executemany('CREATE TABLE support_ticket (id bigint)', [])\n"),
    ],
)
def test_migration_projection_scanner_taints_the_run_python_editor_by_position(
    tmp_path: Path, callback_body: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        "def forwards(apps, editor):\n"
        + callback_body
        + "operations = [migrations.RunPython(forwards)]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == {"SupportTicket"}


def test_migration_projection_scanner_taints_positional_only_run_python_editor(
    tmp_path: Path,
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        "def make_schema(editor):\n"
        "    editor.execute('CREATE TABLE support_ticket (id bigint)')\n"
        "def forwards(apps, editor, /):\n"
        "    make_schema(editor)\n"
        "operations = [migrations.RunPython(forwards)]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) == set(NON_PERSISTED_MODEL_PROJECTIONS)


@pytest.mark.parametrize(
    "callback_source",
    [
        (
            "def helper(editor):\n"
            "    editor.execute('CREATE TABLE support_ticket (id bigint)')\n"
            "def forwards(apps, *args):\n"
            "    helper(args[0])\n"
        ),
        (
            "def helper(editor):\n"
            "    editor.execute('CREATE TABLE support_ticket (id bigint)')\n"
            "def forwards(*args):\n"
            "    helper(args[1])\n"
        ),
        (
            "def helper(editor):\n"
            "    editor.execute('CREATE TABLE support_ticket (id bigint)')\n"
            "def forwards(apps, /, editor):\n"
            "    helper(editor)\n"
        ),
        (
            "def helper(editor):\n"
            "    editor.execute('CREATE TABLE support_ticket (id bigint)')\n"
            "def forwards(apps, editor):\n"
            "    ignored, delegated = (None, editor)\n"
            "    helper(delegated)\n"
        ),
        (
            "def helper():\n"
            "    from django.db import connection\n"
            "    connection.cursor().execute('CREATE TABLE support_ticket (id bigint)')\n"
            "def forwards(apps, editor):\n"
            "    helper()\n"
        ),
        (
            "from django.db import connection\n"
            "def forwards(apps, editor):\n"
            "    cursor = connection.cursor()\n"
            "    execute = cursor.execute\n"
            "    execute('CREATE TABLE support_ticket (id bigint)')\n"
        ),
        (
            "from .helpers import create_projection\n"
            "def forwards(apps, editor):\n"
            "    create_projection()\n"
        ),
        (
            "from django.db import connections\n"
            "def forwards(apps, editor):\n"
            "    cursor = connections['default'].cursor()\n"
            "    cursor.execute('CREATE TABLE support_ticket (id bigint)')\n"
        ),
        ("from . import helpers\ndef forwards(apps, editor):\n    helpers.create_projection()\n"),
        (
            "from .helpers import create_projection\n"
            "HELPER = create_projection\n"
            "def forwards(apps, editor):\n"
            "    HELPER()\n"
        ),
        (
            "from .helpers import create_projection\n"
            "HELPERS = {'create': create_projection}\n"
            "def forwards(apps, editor):\n"
            "    HELPERS['create']()\n"
        ),
        (
            "from .helpers import create_projection\n"
            "ACTION = create_projection if True else print\n"
            "def forwards(apps, editor):\n"
            "    ACTION()\n"
        ),
        (
            "from .helpers import create_projection\n"
            "HELPERS = {'create': create_projection}\n"
            "ACTION = HELPERS.get('create')\n"
            "def forwards(apps, editor):\n"
            "    ACTION()\n"
        ),
        (
            "from .helpers import create_projection\n"
            "def identity(value):\n"
            "    return value\n"
            "ACTION = identity(create_projection)\n"
            "def forwards(apps, editor):\n"
            "    ACTION()\n"
        ),
        (
            "from .helpers import create_projection\n"
            "def factory():\n"
            "    return create_projection\n"
            "ACTION = factory()\n"
            "def forwards(apps, editor):\n"
            "    ACTION()\n"
        ),
        (
            "def forwards(apps, editor):\n"
            "    def factory():\n"
            "        return editor.execute\n"
            "    action = factory()\n"
            "    action('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
        (
            "def forwards(apps, editor):\n"
            "    class Holder:\n"
            "        def fetchone(self):\n"
            "            return editor.execute\n"
            "    action = Holder().fetchone()\n"
            "    action('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
    ],
)
def test_migration_projection_scanner_fails_closed_on_indirect_run_python_authority(
    tmp_path: Path, callback_source: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        + callback_source
        + "operations = [migrations.RunPython(forwards)]\n",
        encoding="utf-8",
    )
    assert migration_create_model_names(tmp_path) & set(NON_PERSISTED_MODEL_PROJECTIONS)


@pytest.mark.parametrize(
    "callback_body",
    [
        (
            "    actions = {'execute': editor.execute}\n"
            "    actions['execute']('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
        (
            "    actions = [editor.execute]\n"
            "    actions[0]('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
        (
            "    actions = (editor.execute,)\n"
            "    run = actions[0]\n"
            "    run('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
        (
            "    actions = {'nested': [editor.execute]}\n"
            "    actions['nested'][0](load_schema_sql())\n"
        ),
        (
            "    actions = {editor.execute}\n"
            "    run = actions.pop()\n"
            "    run('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
        (
            "    actions = {'run': editor.execute}\n"
            "    actions.get('run')('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
        (
            "    action = editor.execute if True else print\n"
            "    action('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
        (
            "    action = editor.execute or print\n"
            "    action('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
        (
            "    actions = {'run': editor.execute}\n"
            "    action = actions.setdefault('run', print)\n"
            "    action('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
        (
            "    actions = {'run': editor.execute}\n"
            "    _, action = actions.popitem()\n"
            "    action('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
        (
            "    actions = {'run': editor.execute}\n"
            "    action = actions.copy().pop('run')\n"
            "    action('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
        (
            "    actions = [value for value in [editor.execute]]\n"
            "    actions[0]('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
        (
            "    actions = {value for value in [editor.execute]}\n"
            "    actions.pop()('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
        (
            "    actions = (value for value in [editor.execute])\n"
            "    next(actions)('CREATE TABLE organisation_bootstrap (id bigint)')\n"
        ),
    ],
)
def test_migration_projection_scanner_tracks_containerized_database_authority(
    tmp_path: Path, callback_body: str
) -> None:
    migrations = tmp_path / "apps" / "projection_probe" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_probe.py").write_text(
        "from django.db import migrations\n"
        "def forwards(apps, editor):\n"
        + callback_body
        + "operations = [migrations.RunPython(forwards)]\n",
        encoding="utf-8",
    )
    found = migration_create_model_names(tmp_path)
    if "load_schema_sql" in callback_body or "next(actions)" in callback_body:
        assert found == set(NON_PERSISTED_MODEL_PROJECTIONS)
    else:
        assert found == {"OrganisationBootstrap"}


def test_organisation_scoped_row_must_keep_its_structural_scope_anchor() -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_in_source_table(
        source,
        "Notification",
        "| `organisation_id` | FK `Organisation` | |\n",
        "",
    )
    assert "Notification: organisation scope anchor organisation_id is missing" in (
        global_control_evidence_refusals(mutant)
    )
    untrusted_mutant = replace_in_source_table(
        source,
        "Notification",
        "| `organisation_id` | FK `Organisation` | |",
        "| `organisation_id` | text NULL | Caller-supplied label |",
    )
    untrusted_refusals = global_control_evidence_refusals(untrusted_mutant)
    assert "Notification.organisation_id: scope anchor must be non-null" in untrusted_refusals
    assert (
        "Notification.organisation_id: direct scope is neither an Organisation FK nor an "
        "immutable UUID snapshot" in untrusted_refusals
    )
    unqualified_fk_mutant = replace_in_source_table(
        source,
        "Notification",
        "| `organisation_id` | FK `Organisation` | |",
        "| `organisation_id` | FK | Unqualified target |",
    )
    assert (
        "Notification.organisation_id: direct FK scope anchor does not declare its Organisation "
        "target" in global_control_evidence_refusals(unqualified_fk_mutant)
    )
    weak_snapshot_mutant = replace_in_source_table(
        source,
        "DpaAcceptance",
        "| `organisation_id` | UUIDv7 | Immutable non-FK subject snapshot; the organisation may be purged after 30 days |",
        "| `organisation_id` | UUIDv7 | Caller-supplied identifier |",
    )
    assert (
        "DpaAcceptance.organisation_id: direct scope is neither an Organisation FK nor an "
        "immutable UUID snapshot" in global_control_evidence_refusals(weak_snapshot_mutant)
    )


def test_indirect_scope_anchor_requires_fk_target_and_acyclic_path() -> None:
    source = MODEL.read_text(encoding="utf-8")
    non_fk_mutant = replace_in_section(
        source,
        "JobLockReservation",
        "| `job_id` | FK `Job`, restrict | The job whose claim wrote it. A sub-job never has one: its parent's covers it |",
        "| `job_id` | UUIDv7 | Opaque identifier |",
    )
    assert "JobLockReservation.job_id: indirect scope anchor is not an FK to Job" in (
        global_control_evidence_refusals(non_fk_mutant)
    )
    wrong_target_mutant = replace_in_section(
        source,
        "JobLockReservation",
        "| `job_id` | FK `Job`, restrict | The job whose claim wrote it. A sub-job never has one: its parent's covers it |",
        "| `job_id` | FK User, restrict | Wrong global target |",
    )
    assert "JobLockReservation.job_id: scope anchor targets ['User'], not Job" in (
        global_control_evidence_refusals(wrong_target_mutant)
    )
    unqualified_target_mutant = replace_in_section(
        source,
        "JobLockReservation",
        "| `job_id` | FK `Job`, restrict | The job whose claim wrote it. A sub-job never has one: its parent's covers it |",
        "| `job_id` | FK | Unqualified target |",
    )
    assert (
        "JobLockReservation.job_id: indirect scope anchor does not declare its Job target"
        in global_control_evidence_refusals(unqualified_target_mutant)
    )
    nullable_endpoint_source = replace_in_section(
        source,
        "JobLockReservation",
        "| `job_id` | FK `Job`, restrict | The job whose claim wrote it. A sub-job never has one: its parent's covers it |",
        "| `job_id` | FK `Identity`, restrict | Wrong nullable-global endpoint |",
    )
    nullable_endpoint_anchors = dict(ORGANISATION_SCOPE_ANCHORS)
    nullable_endpoint_anchors["JobLockReservation"] = ("job_id", "Identity")
    assert (
        "JobLockReservation: organisation scope anchor terminates at global or nullable Identity"
        in organisation_scope_anchor_refusals(
            nullable_endpoint_source,
            nullable_endpoint_anchors,
        )
    )
    cyclic_source = replace_in_section(
        source,
        "Tenant",
        "| `organisation_id` | FK `Organisation` | |",
        "| `organisation_id` | FK `TenantExit` | Synthetic cycle |",
    )
    cyclic_anchors = dict(ORGANISATION_SCOPE_ANCHORS)
    cyclic_anchors["Tenant"] = ("organisation_id", "TenantExit")
    cyclic_anchors["TenantExit"] = ("tenant_id", "Tenant")
    assert "Tenant: organisation scope anchor path contains a cycle" in (
        organisation_scope_anchor_refusals(cyclic_source, cyclic_anchors)
    )


def test_incident_mixed_scope_requires_exact_fields_and_database_check() -> None:
    source = MODEL.read_text(encoding="utf-8")
    check_mutant = replace_clause(
        source,
        INCIDENT_SCOPE_CHECK_CLAUSE,
        "Incident scope is interpreted by callers",
    )
    assert "Incident: exact platform/tenant scope check is missing" in (
        global_control_evidence_refusals(check_mutant)
    )
    field_mutant = replace_in_source_table(
        source,
        "Incident",
        "| `organisation_id` | FK `Organisation` NULL | Null when `scope = platform` |",
        "| `organisation_id` | FK `Organisation` NULL | Optional for every incident |",
    )
    assert "Incident.organisation_id: mixed-scope field contract is wrong" in (
        global_control_evidence_refusals(field_mutant)
    )


def test_identity_staff_and_audit_global_scope_rules_are_exact() -> None:
    source = MODEL.read_text(encoding="utf-8")
    identity_mutant = replace_clause(
        source,
        IDENTITY_SCOPE_ENFORCEMENT_CLAUSE,
        "Identity organisation scope is inferred by callers",
    )
    assert "Identity: feasible tenant/staff scope enforcement is missing" in (
        global_control_evidence_refusals(identity_mutant)
    )
    staff_mutant = replace_in_source_table(
        source,
        "StaffRole",
        "| `realm` | text | Always `kodera-staff` |",
        "| `realm` | text | Any realm |",
    )
    assert "StaffRole.realm: exact system-global staff realm is wrong" in (
        global_control_evidence_refusals(staff_mutant)
    )
    audit = AUDIT_TAXONOMY.read_text(encoding="utf-8")
    audit_mutant = replace_clause(
        audit,
        AUDIT_SCOPE_RUNTIME_GAP,
        "Audit scope is selected by the caller",
    )
    assert "AuditEvent: honest organisation/fleet scope runtime gap is missing" in (
        global_control_evidence_refusals(source, audit=audit_mutant)
    )


def test_fleet_mixed_scope_rules_are_executable() -> None:
    source = MODEL.read_text(encoding="utf-8")
    maintenance_mutant = replace_clause(
        source,
        MAINTENANCE_SCOPE_CLAUSE,
        "Maintenance scope is inferred by each caller",
    )
    assert "MaintenanceWindow: exact organisation/tenant/fleet scope rule is missing" in (
        global_control_evidence_refusals(maintenance_mutant)
    )
    maintenance_field_mutant = replace_in_source_table(
        source,
        "MaintenanceWindow",
        "| `organisation_id` | FK `Organisation` NULL | Null = fleet default |",
        "",
    )
    assert "MaintenanceWindow.organisation_id: mixed-scope field contract is wrong" in (
        global_control_evidence_refusals(maintenance_field_mutant)
    )
    secret_mutant = replace_in_source_table(
        source,
        "Secret",
        "| `tenant_id` | FK `Tenant` NULL | Null for a fleet-level secret |",
        "| `tenant_id` | FK `Tenant` NULL | Optional without a scope meaning |",
    )
    assert "Secret.tenant_id: exact tenant/fleet scope field is wrong" in (
        global_control_evidence_refusals(secret_mutant)
    )
    secret_customer_scope_mutant = replace_in_source_table(
        source,
        "Secret",
        "| `tenant_id` | FK `Tenant` NULL | Null for a fleet-level secret |\n",
        "| `tenant_id` | FK `Tenant` NULL | Null for a fleet-level secret |\n"
        "| `organisation_id` | FK NULL | Ambiguous extra scope |\n",
    )
    assert "Secret: undocumented organisation scope is forbidden" in (
        global_control_evidence_refusals(secret_customer_scope_mutant)
    )


def test_global_control_evidence_row_cannot_be_misclassified_as_organisation_scoped() -> None:
    source = MODEL.read_text(encoding="utf-8")
    anchor = (
        "| `singleton_key` | text primary key, CHECK | The durable named constraint "
        "`identity_backup_catalogue_state_singleton_key` enforces `CHECK (singleton_key = "
        "'identity-backup-catalogue')`; with the primary key this permits exactly one possible "
        "global row |\n"
    )
    mutant = replace_in_source_table(
        source,
        "IdentityBackupCatalogueState",
        anchor,
        anchor + "| `organisation_id` | UUIDv7 | Incorrect customer scope |\n",
    )
    assert (
        "IdentityBackupCatalogueState: global control/evidence row is organisation-scoped"
        in global_control_evidence_refusals(mutant)
    )


def test_global_control_evidence_convention_and_er_provenance_are_required() -> None:
    source = MODEL.read_text(encoding="utf-8")
    convention_mutant = replace_clause(
        source,
        ORGANISATION_SCOPING_CONVENTION,
        "every table should eventually be scoped",
    )
    assert (
        "organisation-scoping convention does not name global control/evidence rows"
        in global_control_evidence_refusals(convention_mutant)
    )
    er_mutant = source.replace(GLOBAL_CONTROL_OPTIONAL_ER_PROVENANCE, "", 1)
    assert "catalogue-state optional bootstrap provenance is missing from the ER diagram" in (
        global_control_evidence_refusals(er_mutant)
    )
    lifetime_mutant = source.replace(
        GLOBAL_CONTROL_OPTIONAL_ER_PROVENANCE,
        GLOBAL_CONTROL_FALSE_LIFETIME_ER_EDGE,
        1,
    )
    lifetime_refusals = global_control_evidence_refusals(lifetime_mutant)
    assert "catalogue-state optional bootstrap provenance is missing from the ER diagram" in (
        lifetime_refusals
    )
    assert (
        "catalogue-state ER provenance falsely requires the initial generation forever"
        in lifetime_refusals
    )


@pytest.mark.parametrize("field_name", IDENTITY_CATALOGUE_STATE_FIELDS)
def test_each_catalogue_state_field_is_exact(field_name: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    expected_type, expected_note = IDENTITY_CATALOGUE_STATE_FIELDS[field_name]
    old = f"| `{field_name}` | {expected_type} | {expected_note} |"
    mutant = replace_in_source_table(
        source,
        "IdentityBackupCatalogueState",
        old,
        f"| `{field_name}` | text NULL | Mutable marker field |",
    )
    assert (
        "IdentityBackupCatalogueState: exact lifetime marker schema is wrong"
        in identity_source_lifecycle_refusals(mutant)
    )


def test_future_catalogue_state_field_requires_explicit_lifetime_classification() -> None:
    source = MODEL.read_text(encoding="utf-8")
    expected_type, expected_note = IDENTITY_CATALOGUE_STATE_FIELDS["singleton_key"]
    anchor = f"| `singleton_key` | {expected_type} | {expected_note} |\n"
    mutant = replace_in_source_table(
        source,
        "IdentityBackupCatalogueState",
        anchor,
        anchor + "| `future_metadata` | text | Unclassified future field |\n",
    )
    assert (
        "IdentityBackupCatalogueState: exact lifetime marker schema is wrong"
        in identity_source_lifecycle_refusals(mutant)
    )


@pytest.mark.parametrize(
    "mutated_row",
    [
        "| `singleton_key` | text primary key | Arbitrary singleton key |",
        "| `singleton_key` | text primary key, CHECK | The named check permits "
        "`singleton_key LIKE 'identity-backup-%'` |",
    ],
)
def test_catalogue_singleton_named_check_cannot_be_removed_or_widened(
    mutated_row: str,
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    expected_type, expected_note = IDENTITY_CATALOGUE_STATE_FIELDS["singleton_key"]
    old = f"| `singleton_key` | {expected_type} | {expected_note} |"
    mutant = replace_in_source_table(
        source,
        "IdentityBackupCatalogueState",
        old,
        mutated_row,
    )
    assert (
        "IdentityBackupCatalogueState: exact lifetime marker schema is wrong"
        in identity_source_lifecycle_refusals(mutant)
    )


@pytest.mark.parametrize(
    ("field_name", "mutated_type", "mutated_note"),
    [
        ("state", "enum", "`open` \\| `sealed`"),
        ("opened_at", "timestamptz", "Generation-open instant"),
        ("sealed_at", "timestamptz", "Set when sealing"),
    ],
)
def test_each_identity_generation_state_or_clock_field_is_exact(
    field_name: str, mutated_type: str, mutated_note: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    expected_type, expected_note = IDENTITY_GENERATION_FIELDS[field_name]
    old = f"| `{field_name}` | {expected_type} | {expected_note} |"
    new = f"| `{field_name}` | {mutated_type} | {mutated_note} |"
    mutant = replace_in_source_table(source, "IdentityBackupGeneration", old, new)
    assert (
        f"IdentityBackupGeneration.{field_name}: exact state/clock contract is wrong"
        in identity_source_lifecycle_refusals(mutant)
    )


def test_identity_generation_open_index_cannot_be_removed_from_the_table_contract() -> None:
    source = MODEL.read_text(encoding="utf-8")
    expected_type, expected_note = IDENTITY_GENERATION_FIELDS["state"]
    old = f"| `state` | {expected_type} | {expected_note} |"
    mutant = replace_in_source_table(
        source,
        "IdentityBackupGeneration",
        old,
        "| `state` | enum | `open` \\| `draining` \\| `sealed` |",
    )
    assert (
        "IdentityBackupGeneration.state: exact state/clock contract is wrong"
        in identity_source_lifecycle_refusals(mutant)
    )


def test_identity_capture_registration_requires_the_locked_open_generation() -> None:
    source = MODEL.read_text(encoding="utf-8")
    expected_type, expected_note = IDENTITY_CAPTURE_GENERATION_FIELD
    old = f"| `generation_id` | {expected_type} | {expected_note} |"
    mutant = replace_in_source_table(
        source,
        "IdentityBackupCapture",
        old,
        "| `generation_id` | FK `IdentityBackupGeneration` | Registered before snapshotting |",
    )
    assert (
        "IdentityBackupCapture.generation_id: exact open-generation binding contract is wrong"
        in identity_source_lifecycle_refusals(mutant)
    )


def test_identity_closure_source_uniqueness_cannot_be_removed() -> None:
    source = MODEL.read_text(encoding="utf-8")
    old = (
        "| `organisation_id` | UUIDv7, not FK, UNIQUE | Immutable organisation snapshot; `UNIQUE` "
        "permits at most one in-flight closure and the non-FK field does not block organisation "
        "purge |"
    )
    mutant = replace_in_source_table(
        source,
        "IdentityBackupClosure",
        old,
        old.replace(", UNIQUE", ""),
    )
    assert (
        "IdentityBackupClosure.organisation_id: exact in-flight uniqueness contract is wrong"
        in identity_source_lifecycle_refusals(mutant)
    )


def test_common_reservation_linearizes_cleanup_against_new_closure() -> None:
    assert not cleanup_closure_interleaving_loses_selected_source(common_reservation=True)
    assert cleanup_closure_interleaving_loses_selected_source(common_reservation=False)


def test_removing_common_reservation_exposes_the_cleanup_closure_race() -> None:
    source = MODEL.read_text(encoding="utf-8")
    clause, replacement = IDENTITY_SOURCE_LIFECYCLE_REQUIREMENTS["cleanup-closure-reservation"]
    mutant = replace_clause(source, clause, replacement)
    assert "raw identity lifecycle requirement missing: cleanup-closure-reservation" in (
        identity_source_lifecycle_refusals(mutant)
    )
    assert cleanup_closure_interleaving_loses_selected_source(common_reservation=False)


def test_registration_and_closure_interleavings_preserve_the_cutoff() -> None:
    register_first = registration_closure_interleaving(registration_started_first=True)
    assert register_first == ("committed-old", True, False)

    closure_first = registration_closure_interleaving(registration_started_first=False)
    assert closure_first == ("committed-next", False, False)

    stale_insert = registration_closure_interleaving(
        registration_started_first=True,
        registration_holds_shared=False,
    )
    assert stale_insert == ("refused-stale", False, False)


def test_partial_unique_index_refuses_a_second_open_generation() -> None:
    assert unique_open_index_accepts(("draining", "open", "sealed"))
    assert not unique_open_index_accepts(("open", "open"))
    assert unique_open_index_accepts(("open", "open"), enforce_partial_unique=False)


def test_capture_trigger_requires_the_unique_current_open_head() -> None:
    assert capture_registration_accepts_generation(open_generations=(12,), target_generation=12)
    assert not capture_registration_accepts_generation(open_generations=(), target_generation=12)
    assert not capture_registration_accepts_generation(
        open_generations=(11, 12), target_generation=11
    )
    assert capture_registration_accepts_generation(
        open_generations=(11, 12),
        target_generation=11,
        require_unique_current_head=False,
    )


@pytest.mark.parametrize(
    ("old_open", "transitioned", "created"),
    [
        ((), (), (12,)),
        ((10, 11), (10,), (12,)),
        ((11,), (), (12,)),
        ((11,), (11,), ()),
        ((11,), (11,), (12, 13)),
        ((11,), (11,), (11,)),
    ],
)
def test_generation_rotation_fails_closed_on_invalid_head_cardinality(
    old_open: tuple[int, ...],
    transitioned: tuple[int, ...],
    created: tuple[int, ...],
) -> None:
    assert not generation_rotation_is_valid(
        old_open_generations=old_open,
        transitioned_to_draining=transitioned,
        created_open_generations=created,
    )


def test_generation_rotation_commits_one_greater_open_head() -> None:
    assert generation_rotation_is_valid(
        old_open_generations=(11,),
        transitioned_to_draining=(11,),
        created_open_generations=(12,),
    )


def test_weakened_rotation_cardinality_rules_accept_zero_or_multiple_open_heads() -> None:
    assert generation_rotation_is_valid(
        old_open_generations=(11,),
        transitioned_to_draining=(11,),
        created_open_generations=(),
        commit_cardinality_rule="at-most-one",
    )
    assert generation_rotation_is_valid(
        old_open_generations=(11,),
        transitioned_to_draining=(11,),
        created_open_generations=(12, 13),
        commit_cardinality_rule="at-least-one",
    )


def test_catalogue_initializer_requires_marker_absence_empty_table_and_exclusive() -> None:
    assert catalogue_initializer_allowed(
        marker_exists=False,
        existing_states=(),
        holds_catalogue_exclusive=True,
    )
    assert not catalogue_initializer_allowed(
        marker_exists=False,
        existing_states=(),
        holds_catalogue_exclusive=False,
    )
    assert catalogue_initializer_allowed(
        marker_exists=False,
        existing_states=(),
        holds_catalogue_exclusive=False,
        require_exclusive=False,
    )


def test_catalogue_singleton_accepts_only_the_canonical_first_key() -> None:
    assert catalogue_state_insert_allowed(
        existing_keys=(), candidate_key="identity-backup-catalogue"
    )
    assert not catalogue_state_insert_allowed(
        existing_keys=(), candidate_key="identity-backup-other"
    )
    assert catalogue_state_insert_allowed(
        existing_keys=(),
        candidate_key="identity-backup-other",
        singleton_check="removed",
    )
    assert catalogue_state_insert_allowed(
        existing_keys=(),
        candidate_key="identity-backup-other",
        singleton_check="widened",
    )


def test_catalogue_singleton_refuses_same_key_and_alternate_key_second_rows() -> None:
    existing = ("identity-backup-catalogue",)
    assert not catalogue_state_insert_allowed(
        existing_keys=existing, candidate_key="identity-backup-catalogue"
    )
    assert not catalogue_state_insert_allowed(
        existing_keys=existing, candidate_key="identity-backup-other"
    )
    assert catalogue_state_insert_allowed(
        existing_keys=existing,
        candidate_key="identity-backup-other",
        singleton_check="removed",
    )
    assert catalogue_state_insert_allowed(
        existing_keys=existing,
        candidate_key="identity-backup-other",
        singleton_check="widened",
    )


def test_existing_marker_refuses_later_empty_and_zero_head_recovery() -> None:
    assert not catalogue_initializer_allowed(
        marker_exists=True,
        existing_states=(),
        holds_catalogue_exclusive=True,
    )
    assert catalogue_initializer_allowed(
        marker_exists=True,
        existing_states=(),
        holds_catalogue_exclusive=True,
        require_marker_absent=False,
    )
    assert not catalogue_initializer_allowed(
        marker_exists=True,
        existing_states=("sealed", "sealed"),
        holds_catalogue_exclusive=True,
    )


@pytest.mark.parametrize(
    ("write_marker", "write_open_head"),
    [(True, False), (False, True)],
)
def test_catalogue_initializer_refuses_marker_head_split_commit(
    write_marker: bool, write_open_head: bool
) -> None:
    kwargs: CatalogueSplitFixture = {
        "marker_exists": False,
        "existing_states": (),
        "holds_catalogue_exclusive": True,
        "write_marker": write_marker,
        "write_open_head": write_open_head,
    }
    assert not catalogue_initializer_allowed(**kwargs)
    assert catalogue_initializer_allowed(**kwargs, require_atomic_pair=False)


def test_catalogue_marker_authority_must_equal_the_inserted_head() -> None:
    kwargs: CatalogueAuthorityFixture = {
        "marker_exists": False,
        "existing_states": (),
        "holds_catalogue_exclusive": True,
        "inserted_head": ("head-1", 1),
        "marker_head": ("head-other", 2),
    }
    assert not catalogue_initializer_allowed(**kwargs)
    assert catalogue_initializer_allowed(**kwargs, require_marker_head_match=False)


@pytest.mark.parametrize("operation", ["update", "delete"])
def test_catalogue_marker_cannot_clear_or_rewrite(operation: str) -> None:
    assert not catalogue_marker_mutation_allowed(operation)
    assert catalogue_marker_mutation_allowed(operation, enforce_immutable=False)


def test_concurrent_catalogue_initializers_serialize_and_only_one_commits() -> None:
    assert catalogue_initializer_allowed(
        marker_exists=False,
        existing_states=(),
        holds_catalogue_exclusive=True,
    )
    assert not catalogue_initializer_allowed(
        marker_exists=True,
        existing_states=("open",),
        holds_catalogue_exclusive=True,
    )
    assert catalogue_initializer_allowed(
        marker_exists=False,
        existing_states=(),
        holds_catalogue_exclusive=False,
        require_exclusive=False,
    )


def test_generation_cleanup_accepts_only_an_unreferenced_sealed_non_head() -> None:
    assert generation_cleanup_allowed(
        candidate_generation=11,
        candidate_state_at_lock="sealed",
        candidate_state_at_recheck="sealed",
        head_at_lock=12,
        head_at_recheck=12,
    )


@pytest.mark.parametrize(
    ("candidate_generation", "candidate_state", "head"),
    [
        (12, "open", 12),
        (11, "draining", 12),
        (12, "sealed", 12),
    ],
)
def test_generation_cleanup_refuses_open_draining_and_current_head_candidates(
    candidate_generation: int, candidate_state: str, head: int
) -> None:
    kwargs: GenerationCleanupFixture = {
        "candidate_generation": candidate_generation,
        "candidate_state_at_lock": candidate_state,
        "candidate_state_at_recheck": candidate_state,
        "head_at_lock": head,
        "head_at_recheck": head,
    }
    assert not generation_cleanup_allowed(**kwargs)
    assert generation_cleanup_allowed(**kwargs, require_sealed_non_head=False)


def test_generation_cleanup_refuses_a_head_change_under_its_lock() -> None:
    kwargs: GenerationCleanupFixture = {
        "candidate_generation": 11,
        "candidate_state_at_lock": "sealed",
        "candidate_state_at_recheck": "sealed",
        "head_at_lock": 12,
        "head_at_recheck": 13,
    }
    assert not generation_cleanup_allowed(**kwargs)
    assert generation_cleanup_allowed(**kwargs, require_stable_head_and_state=False)


def test_generation_cleanup_requires_the_catalogue_exclusive_reservation() -> None:
    kwargs: GenerationCleanupFixture = {
        "candidate_generation": 11,
        "candidate_state_at_lock": "sealed",
        "candidate_state_at_recheck": "sealed",
        "head_at_lock": 12,
        "head_at_recheck": 12,
        "holds_catalogue_exclusive": False,
    }
    assert not generation_cleanup_allowed(**kwargs)
    assert generation_cleanup_allowed(**kwargs, require_exclusive=False)


@pytest.mark.parametrize(
    "late_reference",
    [
        {"captures_at_recheck": 1},
        {"closures_at_recheck": 1},
        {"unfinalized_cutoff_at_recheck": True},
    ],
)
def test_generation_cleanup_rechecks_late_registration_closure_and_cutoff(
    late_reference: GenerationCleanupLateReference,
) -> None:
    kwargs: GenerationCleanupFixture = {
        "candidate_generation": 11,
        "candidate_state_at_lock": "sealed",
        "candidate_state_at_recheck": "sealed",
        "head_at_lock": 12,
        "head_at_recheck": 12,
    }
    kwargs.update(late_reference)
    assert not generation_cleanup_allowed(**kwargs)
    assert generation_cleanup_allowed(**kwargs, use_final_child_recheck=False)


def test_generation_guard_and_final_recheck_close_a_missing_reservation_race() -> None:
    rechecked = registration_closure_interleaving(
        registration_started_first=True,
        registration_holds_shared=False,
        refuse_non_open_insert=False,
    )
    assert rechecked == ("committed-old", True, False)

    weakened = registration_closure_interleaving(
        registration_started_first=True,
        registration_holds_shared=False,
        refuse_non_open_insert=False,
        final_source_recheck=False,
    )
    assert weakened == ("committed-old", False, True)


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [
        (
            label,
            *IDENTITY_SOURCE_LIFECYCLE_REQUIREMENTS[label],
        )
        for label in (
            "unique-open-index",
            "registration-shared-reservation",
            "registration-open-generation",
            "closure-generation-commit-cardinality",
            "closure-seal-final-recheck",
        )
    ],
)
def test_each_registration_closure_race_safeguard_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    mutant = replace_clause(MODEL.read_text(encoding="utf-8"), clause, replacement)
    assert f"raw identity lifecycle requirement missing: {label}" in (
        identity_source_lifecycle_refusals(mutant)
    )


@pytest.mark.parametrize(
    ("accepted_expiries", "no_write_proofs", "trusted_completion", "expected"),
    [
        ((10, 20), (), 20, (20, True)),
        ((10, 20), (), 19, (20, False)),
        ((), (True, True), 5, (None, True)),
        ((), (True, False), 5, (None, False)),
        ((), (True,), None, (None, False)),
        ((10, 20), (True,), 20, (20, True)),
        ((10, 20), (False,), 20, (20, False)),
        ((10, 20), (True,), 19, (20, False)),
    ],
)
def test_backup_clock_branches_use_only_accepted_object_expiries(
    accepted_expiries: tuple[int, ...],
    no_write_proofs: tuple[bool, ...],
    trusted_completion: int | None,
    expected: tuple[int | None, bool],
) -> None:
    assert (
        backup_clock_outcome(
            accepted_expiries=accepted_expiries,
            no_write_proofs=no_write_proofs,
            trusted_completion=trusted_completion,
        )
        == expected
    )


def test_old_non_empty_manifest_clock_rule_rejects_valid_no_write_only_evidence() -> None:
    fixture: BackupClockFixture = {
        "accepted_expiries": (),
        "no_write_proofs": (True, True),
        "trusted_completion": 5,
    }
    assert backup_clock_outcome(**fixture) == (None, True)
    assert backup_clock_outcome(**fixture, old_non_empty_manifest_rule=True) == (
        None,
        False,
    )


def test_backups_locked_until_field_cannot_restore_the_non_empty_manifest_rule() -> None:
    source = MODEL.read_text(encoding="utf-8")
    expected_type, expected_note = DELETION_CERTIFICATE_BACKUP_CLOCK_FIELD
    old = f"| `backups_locked_until` | {expected_type} | {expected_note} |"
    mutant = replace_in_source_table(
        source,
        "DeletionCertificate",
        old,
        "| `backups_locked_until` | timestamptz NULL | Required on an initial attestation with a "
        "non-empty backup manifest; null only for canonical `never_provisioned`/empty-backup "
        "evidence |",
    )
    assert (
        "backups_locked_until: exact accepted-object clock contract is wrong"
        in certificate_refusals(mutant)
    )


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in MODEL_BACKUP_CLOCK_REQUIREMENTS.items()],
)
def test_each_model_backup_clock_branch_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    mutant = replace_clause(MODEL.read_text(encoding="utf-8"), clause, replacement)
    assert f"certificate backup clock requirement missing: {label}" in certificate_refusals(mutant)


def test_backup_policy_cannot_restore_raw_cross_scope_capture_evidence() -> None:
    source = BACKUP_AND_RESTORE.read_text(encoding="utf-8")
    mutant = replace_clause(
        source, BACKUP_PROJECTION_REQUIREMENT, "The certificate copies raw dumps"
    )
    assert backup_projection_refusals(mutant) == [
        "backup policy must use the minimized per-organisation certificate projection"
    ]


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in IDENTITY_SOURCE_LIFECYCLE_REQUIREMENTS.items()],
)
def test_each_raw_identity_source_lifecycle_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    mutant = replace_clause(MODEL.read_text(encoding="utf-8"), clause, replacement)
    assert f"raw identity lifecycle requirement missing: {label}" in (
        identity_source_lifecycle_refusals(mutant)
    )


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in BACKUP_SOURCE_LIFECYCLE_REQUIREMENTS.items()],
)
def test_each_backup_source_lifecycle_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    mutant = replace_clause(BACKUP_AND_RESTORE.read_text(encoding="utf-8"), clause, replacement)
    assert f"backup raw identity lifecycle requirement missing: {label}" in (
        backup_projection_refusals(mutant)
    )


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in BACKUP_CLOCK_REQUIREMENTS.items()],
)
def test_each_backup_policy_clock_branch_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    mutant = replace_clause(BACKUP_AND_RESTORE.read_text(encoding="utf-8"), clause, replacement)
    assert f"backup clock requirement missing: {label}" in backup_projection_refusals(mutant)


def test_future_identity_capture_field_must_be_classified() -> None:
    source = MODEL.read_text(encoding="utf-8")
    anchor = "| `id` | UUIDv7 | |\n"
    mutant = replace_in_source_table(
        source,
        "IdentityBackupCapture",
        anchor,
        anchor + "| `future_cross_scope_ref` | text | Future source field |\n",
    )
    assert "IdentityBackupCapture: unclassified source fields: future_cross_scope_ref" in (
        identity_capture_projection_refusals(mutant)
    )


def test_future_identity_capture_field_can_be_safely_derived() -> None:
    source = MODEL.read_text(encoding="utf-8")
    anchor = "| `id` | UUIDv7 | |\n"
    mutant = replace_in_source_table(
        source,
        "IdentityBackupCapture",
        anchor,
        anchor + "| `future_cross_scope_ref` | text | Future source field |\n",
    )
    mutant = mutant.replace(
        "terminal_evidence_ref -> salted_terminal_evidence_digest], exclude",
        "terminal_evidence_ref -> salted_terminal_evidence_digest, future_cross_scope_ref -> "
        "salted_future_cross_scope_digest], exclude",
        1,
    )
    original = dict(IDENTITY_CAPTURE_DERIVED_FIELDS)
    original["future_cross_scope_ref"] = "salted_future_cross_scope_digest"
    expected_fields = expanded_field_names(source_table_fields(mutant, "IdentityBackupCapture"))
    assert identity_capture_projection_refusals(mutant, expected_fields, original) == []


def test_future_identity_closure_field_must_be_classified() -> None:
    source = MODEL.read_text(encoding="utf-8")
    anchor = "| `id` | UUIDv7 | |\n"
    mutant = replace_in_source_table(
        source,
        "IdentityBackupClosure",
        anchor,
        anchor + "| `future_operator_ref` | text | Future source field |\n",
    )
    assert "IdentityBackupClosure: unclassified source fields: future_operator_ref" in (
        identity_closure_projection_refusals(mutant)
    )


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        (
            "include = [id, tenant_id,",
            "include = [id, id, tenant_id,",
            "ProjectBootstrap: duplicate projection classification",
        ),
        (
            "exclude = [secret_ref]",
            "exclude = [secret_ref, secret_ref]",
            "ProjectBootstrap: duplicate projection classification",
        ),
        (
            "include = [id, tenant_id,",
            "include = [secret_ref, id, tenant_id,",
            "ProjectBootstrap: fields classified as both evidence and excluded",
        ),
    ],
)
def test_project_bootstrap_projection_rejects_duplicate_or_overlap(
    old: str, new: str, message: str
) -> None:
    mutant = MODEL.read_text(encoding="utf-8").replace(old, new, 1)
    assert message in project_bootstrap_projection_refusals(mutant)


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        (
            "include = [kind, state,",
            "include = [kind, kind, state,",
            "IdentityBackupCapture: duplicate projection classification",
        ),
        (
            "id -> salted_capture_id_digest, generation_id ->",
            "id -> salted_capture_id_digest, id -> salted_duplicate_id_digest, generation_id ->",
            "IdentityBackupCapture: duplicate derivation source",
        ),
        (
            "generation_id -> salted_generation_id_digest",
            "generation_id -> salted_capture_id_digest",
            "IdentityBackupCapture: duplicate derivation destination",
        ),
        (
            "id -> salted_capture_id_digest",
            "id -> raw_capture_id",
            "IdentityBackupCapture: unsafe raw derivation destination",
        ),
        (
            "include = [kind, state,",
            "include = [id, kind, state,",
            "IdentityBackupCapture: source fields have overlapping classifications",
        ),
    ],
)
def test_identity_capture_projection_rejects_ambiguous_or_raw_mapping(
    old: str, new: str, message: str
) -> None:
    mutant = replace_clause_in_section(
        MODEL.read_text(encoding="utf-8"), "DeletionCertificate", old, new
    )
    assert message in identity_capture_projection_refusals(mutant)


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        (
            "include = [id, organisation_id,",
            "include = [id, id, organisation_id,",
            "IdentityBackupClosure: duplicate projection classification",
        ),
        (
            "manifest_ref -> salted_closure_manifest_ref_digest",
            "manifest_ref -> raw_manifest_ref",
            "IdentityBackupClosure: unsafe raw derivation destination",
        ),
        (
            "include = [id, organisation_id,",
            "include = [manifest_ref, id, organisation_id,",
            "IdentityBackupClosure: source fields have overlapping classifications",
        ),
    ],
)
def test_identity_closure_projection_rejects_ambiguous_or_raw_mapping(
    old: str, new: str, message: str
) -> None:
    mutant = replace_clause_in_section(
        MODEL.read_text(encoding="utf-8"), "DeletionCertificate", old, new
    )
    assert message in identity_closure_projection_refusals(mutant)


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in IDENTITY_CAPTURE_PROJECTION_RULES.items()],
)
def test_each_identity_capture_scope_or_minimization_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause_in_section(source, "DeletionCertificate", clause, replacement)
    assert f"IdentityBackupCapture projection rule missing: {label}" in (
        identity_capture_projection_refusals(mutant)
    )


@pytest.mark.parametrize("source_field", IDENTITY_CAPTURE_DERIVED_FIELDS)
def test_each_cross_scope_identity_capture_field_cannot_move_to_raw_include(
    source_field: str,
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    target = IDENTITY_CAPTURE_DERIVED_FIELDS[source_field]
    mutant = replace_clause_in_section(
        source,
        "DeletionCertificate",
        "lock_until], derive = [",
        f"lock_until, {source_field}], derive = [",
    )
    mutant = replace_clause_in_section(
        mutant, "DeletionCertificate", f"{source_field} -> {target}", ""
    )
    refusals = identity_capture_projection_refusals(mutant)
    assert "IdentityBackupCapture: raw evidence include set changed" in refusals
    assert "IdentityBackupCapture: safe derivation map changed" in refusals


@pytest.mark.parametrize("source_field", IDENTITY_CLOSURE_DERIVED_FIELDS)
def test_each_sensitive_identity_closure_field_cannot_move_to_raw_include(
    source_field: str,
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    target = IDENTITY_CLOSURE_DERIVED_FIELDS[source_field]
    mutant = replace_clause_in_section(
        source,
        "DeletionCertificate",
        "sealed_at], derive = [",
        f"sealed_at, {source_field}], derive = [",
    )
    mutant = replace_clause_in_section(
        mutant, "DeletionCertificate", f"{source_field} -> {target}", ""
    )
    refusals = identity_closure_projection_refusals(mutant)
    assert "IdentityBackupClosure: raw evidence include set changed" in refusals
    assert "IdentityBackupClosure: safe derivation map changed" in refusals


def test_identity_closure_raw_authorities_must_remain_exact_scope() -> None:
    mutant = replace_clause_in_section(
        MODEL.read_text(encoding="utf-8"),
        "DeletionCertificate",
        IDENTITY_CLOSURE_RAW_AUTHORITY_RULE,
        "Closure ids are globally reusable correlators",
    )
    assert "IdentityBackupClosure: raw authorities are not proven exact-scope" in (
        identity_closure_projection_refusals(mutant)
    )


def test_weakening_the_project_bootstrap_projection_rule_is_caught() -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause(
        source,
        PROJECT_BOOTSTRAP_PROJECTION_RULE,
        "Its lists may omit fields added after format 1",
    )
    assert "ProjectBootstrap: exhaustive projection rule is missing" in (
        project_bootstrap_projection_refusals(mutant)
    )


def test_a_future_unclassified_project_bootstrap_field_is_caught() -> None:
    source = MODEL.read_text(encoding="utf-8")
    anchor = "| `id` | UUIDv7 | |\n"
    mutant = replace_in_source_table(
        source,
        "ProjectBootstrap",
        anchor,
        anchor + "| `future_required_proof` | text | Required future evidence |\n",
    )
    assert "ProjectBootstrap: unclassified source fields: future_required_proof" in (
        project_bootstrap_projection_refusals(mutant)
    )


def test_a_future_classified_project_bootstrap_field_is_included() -> None:
    source = MODEL.read_text(encoding="utf-8")
    anchor = "| `id` | UUIDv7 | |\n"
    mutant = replace_in_source_table(
        source,
        "ProjectBootstrap",
        anchor,
        anchor + "| `future_required_proof` | text | Required future evidence |\n",
    )
    mutant = mutant.replace(
        "include = [id, tenant_id,",
        "include = [id, future_required_proof, tenant_id,",
        1,
    )
    expected_fields = PROJECT_BOOTSTRAP_PROJECTION_FIELDS | {"future_required_proof"}
    assert project_bootstrap_projection_refusals(mutant, expected_fields) == []


@pytest.mark.parametrize("replacement", ("", "secret_ref, evidence_ref"))
def test_project_bootstrap_secret_ref_exclusion_is_exact(replacement: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = source.replace("exclude = [secret_ref]", f"exclude = [{replacement}]", 1)
    assert "ProjectBootstrap: only secret_ref may be excluded" in (
        project_bootstrap_projection_refusals(mutant)
    )


def test_project_bootstrap_secret_ref_cannot_move_into_permanent_evidence() -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = source.replace("evidence_ref, state", "evidence_ref, secret_ref, state", 1)
    mutant = mutant.replace("exclude = [secret_ref]", "exclude = []", 1)
    refusals = project_bootstrap_projection_refusals(mutant)
    assert "ProjectBootstrap: only secret_ref may be excluded" in refusals
    assert "ProjectBootstrap: evidence projection changed without classification review" in refusals


@pytest.mark.parametrize("field", CERTIFICATE_SNAPSHOT_FIELDS)
def test_restoring_any_certificate_foreign_key_is_caught_by_its_own_field(field: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    expected_type, target = CERTIFICATE_SNAPSHOT_FIELDS[field]
    old = f"| `{field}` | {expected_type} |"
    new = f"| `{field}` | FK `{target}` NULL |"
    refusals = certificate_refusals(replace_in_section(source, "DeletionCertificate", old, new))
    assert refusals[0] == (
        f"{field}: permanent evidence must use {expected_type}, not FK `{target}` NULL"
    )


@pytest.mark.parametrize(
    "field", ("finalization_evidence_manifest_ref", "finalization_evidence_sha256")
)
def test_removing_a_required_finalization_evidence_field_is_caught(field: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    body = section(source, "DeletionCertificate")
    row = next(line for line in body.splitlines() if line.startswith(f"| `{field}` |"))
    mutant = replace_in_table(source, "DeletionCertificate", "Field", row + "\n", "")
    assert f"{field}: permanent required finalization evidence field is missing" in (
        certificate_refusals(mutant)
    )


LEGAL_MUTATIONS = [
    (heading, label, field, expected_type, target)
    for (heading, label), fields in LEGAL_AUTHORITY_FIELDS.items()
    for field, (expected_type, target) in fields.items()
]


@pytest.mark.parametrize(
    ("heading", "label", "field", "expected_type", "target"),
    LEGAL_MUTATIONS,
    ids=[f"{heading}-{label}-{field}" for heading, label, field, _kind, _target in LEGAL_MUTATIONS],
)
def test_restoring_each_legal_record_foreign_key_is_caught(
    heading: str, label: str, field: str, expected_type: str, target: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    old = f"| `{field}` | {expected_type} |"
    mutant = replace_in_table(source, heading, label, old, f"| `{field}` | FK `{target}` NULL |")
    expected = f"{heading}/{label}.{field}: must use {expected_type}, not FK `{target}` NULL"
    assert expected in legal_retention_refusals(mutant)


LEGAL_EVIDENCE_MUTATIONS = [
    (heading, label, field, expected_type)
    for (heading, label), fields in LEGAL_EVIDENCE_FIELDS.items()
    for field, expected_type in fields.items()
]


@pytest.mark.parametrize(
    ("heading", "label", "field", "expected_type"),
    LEGAL_EVIDENCE_MUTATIONS,
    ids=[f"{heading}-{label}-{field}" for heading, label, field, _kind in LEGAL_EVIDENCE_MUTATIONS],
)
def test_removing_each_required_legal_snapshot_is_caught(
    heading: str, label: str, field: str, expected_type: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    body = section(source, heading)
    row = next(line for line in body.splitlines() if line.startswith(f"| `{field}` |"))
    assert f"| {expected_type} |" in row
    mutant = replace_in_table(source, heading, label, row + "\n", "")
    expected = f"{heading}/{label}.{field}: required legal snapshot is missing"
    assert expected in legal_retention_refusals(mutant)


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in LEGAL_WRITE_GUARDS.items()],
)
def test_each_legal_retarget_or_pairing_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause(source, clause, replacement)
    assert f"legal write guard missing: {label}" in legal_retention_refusals(mutant)


@pytest.mark.parametrize("field", CREDIT_NOTE_LINE_FIELDS)
def test_deleting_each_required_credit_note_line_field_is_caught(field: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    body = section(source, "CreditNoteLine")
    row = next(line for line in body.splitlines() if line.startswith(f"| `{field}` |"))
    mutant = replace_in_table(source, "CreditNoteLine", "Field", row, "")
    assert f"CreditNoteLine.{field}: required retained field is missing" in (
        credit_note_line_refusals(mutant)
    )


@pytest.mark.parametrize("field", CREDIT_NOTE_LINE_FIELDS)
def test_wrong_type_for_each_required_credit_note_line_field_is_caught(field: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    expected_type, _note = CREDIT_NOTE_LINE_FIELDS[field]
    mutant = replace_in_table(
        source,
        "CreditNoteLine",
        "Field",
        f"| `{field}` | {expected_type} |",
        f"| `{field}` | wrong_type |",
    )
    assert f"CreditNoteLine.{field}: wrong type" in credit_note_line_refusals(mutant)


@pytest.mark.parametrize(
    "field", [field for field, (_kind, note) in CREDIT_NOTE_LINE_FIELDS.items() if note]
)
def test_wrong_source_for_each_required_credit_note_line_field_is_caught(field: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    expected_type, note = CREDIT_NOTE_LINE_FIELDS[field]
    row = f"| `{field}` | {expected_type} | {note} |"
    mutant = replace_in_table(
        source,
        "CreditNoteLine",
        "Field",
        row,
        f"| `{field}` | {expected_type} | Copied from an unrelated source |",
    )
    assert f"CreditNoteLine.{field}: wrong source-copy contract" in (
        credit_note_line_refusals(mutant)
    )


def test_weakening_exhaustive_credit_note_line_source_equality_is_caught() -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause_in_section(
        source,
        "CreditNoteLine",
        CREDIT_NOTE_LINE_SOURCE_EQUALITY,
        "requires equality for selected fields",
    )
    assert "CreditNoteLine: exhaustive source equality is missing" in (
        credit_note_line_refusals(mutant)
    )


def test_future_unclassified_credit_note_line_field_is_caught() -> None:
    source = MODEL.read_text(encoding="utf-8")
    anchor = "| `id` | UUIDv7 | |\n"
    mutant = replace_in_source_table(
        source,
        "CreditNoteLine",
        anchor,
        anchor + "| `future_amount` | bigint | Unclassified future value |\n",
    )
    assert "CreditNoteLine: unclassified retained fields: future_amount" in (
        credit_note_line_refusals(mutant)
    )


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in INVOICE_ISSUANCE_REQUIREMENTS.items()],
)
def test_each_invoice_issuance_state_or_atomicity_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause(source, clause, replacement)
    assert f"invoice issuance requirement missing: {label}" in invoice_issuance_refusals(mutant)


@pytest.mark.parametrize(
    ("table", "field"),
    [
        ("Invoice", "number"),
        ("Invoice", "issued_at`, `due_at"),
        ("Invoice", "accounting_event_at`, `financial_year_closed_at"),
        ("Invoice", "retained_until`, `purge_after"),
        ("InvoiceLine", "invoice_number_snapshot"),
        ("InvoiceLine", "accounting_event_at`, `financial_year_closed_at"),
        ("InvoiceLine", "retained_until`, `purge_after"),
    ],
)
def test_each_draft_issuance_field_rejects_wrong_non_nullable_type(table: str, field: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    fields = table_fields(source, table)
    actual_type = fields[field][0]
    assert actual_type.endswith(" NULL")
    mutant = replace_in_table(
        source,
        table,
        "Field",
        f"| `{field}` | {actual_type} |",
        f"| `{field}` | {actual_type.removesuffix(' NULL')} |",
    )
    assert f"{table}.{field}: draft-nullable issuance field is wrong" in (
        invoice_issuance_refusals(mutant)
    )


@pytest.mark.parametrize(
    ("heading", "label", "field"),
    SCHEMA_CRITICAL_WORKFLOW_FIELDS,
)
@pytest.mark.parametrize("mutation", ("delete", "weaken"))
def test_each_schema_critical_workflow_field_is_guarded(
    heading: str, label: str, field: str, mutation: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    row = next(
        line for line in section(source, heading).splitlines() if line.startswith(f"| `{field}` |")
    )
    replacement = "" if mutation == "delete" else f"| `{field}` | text | unrestricted |"
    mutant = replace_in_table(source, heading, label, row, replacement)
    assert schema_critical_workflow_refusals(mutant)


@pytest.mark.parametrize("field", PAYMENT_ALLOCATION_FIELDS)
def test_removing_each_payment_allocation_evidence_field_is_caught(field: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    body = section(source, "Payment and PaymentLink")
    row = next(line for line in body.splitlines() if line.startswith(f"| `{field}` |"))
    mutant = replace_in_table(source, "Payment and PaymentLink", "Payment", row + "\n", "")
    assert f"Payment.{field}: allocation evidence field is missing" in legal_retention_refusals(
        mutant
    )


RETENTION_CLOCK_MUTATIONS = [
    (heading, label, field, expected_type)
    for (heading, label), fields in RETENTION_CLOCK_FIELDS.items()
    for field, expected_type in fields.items()
]


@pytest.mark.parametrize(
    ("heading", "label", "field", "expected_type"),
    RETENTION_CLOCK_MUTATIONS,
)
def test_removing_each_retention_anchor_field_is_caught(
    heading: str, label: str, field: str, expected_type: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    fields = table_fields(source, heading, label)
    actual_type, notes = fields[field]
    assert actual_type == expected_type
    row = f"| `{field}` | {actual_type} | {notes} |"
    mutant = replace_in_table(source, heading, label, row, "")
    assert f"{heading}/{label}.{field}: retention anchor field is missing" in (
        retention_clock_refusals(mutant)
    )


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in RETENTION_ANCHOR_REQUIREMENTS.items()],
)
def test_wrong_or_early_retention_anchor_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause(source, clause, replacement)
    assert f"retention anchor requirement missing: {label}" in retention_clock_refusals(mutant)


RETENTION_ROW_MUTATIONS = [
    (heading, label, field, required_note)
    for (heading, label), fields in RETENTION_ROW_ANCHORS.items()
    for field, required_note in fields.items()
]


@pytest.mark.parametrize(
    ("heading", "label", "field", "required_note"),
    RETENTION_ROW_MUTATIONS,
)
def test_each_table_rejects_its_own_wrong_retention_anchor(
    heading: str, label: str, field: str, required_note: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    fields = table_fields(source, heading, label)
    actual_type, notes = fields[field]
    assert normalized(required_note) == normalized(notes)
    row = f"| `{field}` | {actual_type} | {notes} |"
    mutant = replace_in_table(
        source,
        heading,
        label,
        row,
        row.replace(required_note, "an incorrect retention anchor"),
    )
    assert f"{heading}/{label}.{field}: exact retention anchor is wrong" in (
        retention_clock_refusals(mutant)
    )


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in PAYMENT_LINK_REQUIREMENTS.items()],
)
def test_each_payment_link_purge_boundary_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause_in_section(source, "Payment and PaymentLink", clause, replacement)
    assert f"PaymentLink purge requirement missing: {label}" in payment_link_refusals(mutant)


def test_removing_payment_link_operational_purge_fields_is_caught() -> None:
    source = MODEL.read_text(encoding="utf-8")
    body = section(source, "Payment and PaymentLink")
    row = next(
        line for line in body.splitlines() if line.startswith("| `deleted_at`, `purge_after` |")
    )
    mutant = replace_in_table(source, "Payment and PaymentLink", "PaymentLink", row, "")
    assert "PaymentLink: operational purge fields are missing" in payment_link_refusals(mutant)


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in DPA_CLOSE_REQUIREMENTS.items()],
)
def test_each_dpa_append_only_close_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause(source, clause, replacement)
    assert f"DpaAcceptance close requirement missing: {label}" in dpa_close_refusals(mutant)


@pytest.mark.parametrize(
    ("field", "expected_type"),
    (("close_reason", "enum NULL"), ("close_evidence_ref", "text NULL")),
)
def test_each_dpa_durable_close_proof_field_is_required(field: str, expected_type: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    row = next(
        line
        for line in section(source, "DpaAcceptance").splitlines()
        if line.startswith(f"| `{field}` | {expected_type} |")
    )
    mutant = replace_in_table(source, "DpaAcceptance", "Field", row, "")
    assert f"DpaAcceptance.{field}: durable close proof field is missing" in dpa_close_refusals(
        mutant
    )


@pytest.mark.parametrize("field", DPA_CLOSE_FIELDS)
def test_each_dpa_close_proof_field_rejects_wrong_source_contract(field: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    expected_type, expected_notes = DPA_CLOSE_FIELDS[field]
    row = f"| `{field}` | {expected_type} | {expected_notes} |"
    mutant = replace_in_table(
        source,
        "DpaAcceptance",
        "Field",
        row,
        f"| `{field}` | {expected_type} | Mutable unrelated value |",
    )
    assert f"DpaAcceptance.{field}: durable close proof field is missing" in dpa_close_refusals(
        mutant
    )


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in PAYMENT_CLASSIFICATION_REQUIREMENTS.items()],
)
def test_each_succeeded_payment_classification_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    model = MODEL.read_text(encoding="utf-8")
    billing = BILLING_MODEL.read_text(encoding="utf-8")
    if label.startswith("model-"):
        model = replace_clause(model, clause, replacement)
    else:
        billing = replace_clause(billing, clause, replacement)
    assert f"payment classification requirement missing: {label}" in (
        payment_classification_refusals(model, billing)
    )


@pytest.mark.parametrize(
    ("label", "where", "clause", "replacement"),
    [(name, *requirement) for name, requirement in AUDIT_WORKFLOW_REQUIREMENTS.items()],
)
def test_each_payment_or_dpa_audit_contract_weakening_is_caught(
    label: str, where: str, clause: str, replacement: str
) -> None:
    model = MODEL.read_text(encoding="utf-8")
    audit = AUDIT_TAXONOMY.read_text(encoding="utf-8")
    openapi = OPENAPI.read_text(encoding="utf-8")
    if where == "model":
        model = replace_clause(model, clause, replacement)
    elif where == "audit":
        audit = replace_clause(audit, clause, replacement)
    else:
        openapi = replace_clause(openapi, clause, replacement)
    assert f"audit workflow requirement missing: {label}" in audit_workflow_refusals(
        model, audit, openapi
    )


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in BILLING_RETENTION_REQUIREMENTS.items()],
)
def test_each_billing_retention_weakening_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    source = BILLING_MODEL.read_text(encoding="utf-8")
    mutant = replace_clause(source, clause, replacement)
    assert f"billing retention requirement missing: {label}" in billing_retention_refusals(mutant)


@pytest.mark.parametrize("field", CLEANUP_ACTOR_FIELDS)
def test_removing_a_cancellation_actor_field_is_caught(field: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    body = section(source, "OrderedCancellationCleanup")
    row = next(line for line in body.splitlines() if line.startswith(f"| `{field}` |"))
    mutant = replace_in_table(source, "OrderedCancellationCleanup", "Field", row + "\n", "")
    assert f"{field}: immutable cancellation actor field is missing" in cleanup_actor_refusals(
        mutant
    )


@pytest.mark.parametrize(
    ("label", "clause", "replacement"),
    [(name, *mutation) for name, mutation in CLEANUP_ACTOR_REQUIREMENTS.items()],
)
def test_weakening_cancellation_actor_or_verifier_separation_is_caught(
    label: str, clause: str, replacement: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause_in_section(source, "OrderedCancellationCleanup", clause, replacement)
    assert f"cleanup actor requirement missing: {label}" in cleanup_actor_refusals(mutant)


@pytest.mark.parametrize("field", AUDIT_SNAPSHOT_REQUIREMENTS)
def test_restoring_each_audit_source_dependency_is_caught(field: str) -> None:
    source = MODEL.read_text(encoding="utf-8")
    clause = AUDIT_SNAPSHOT_REQUIREMENTS[field]
    mutant = replace_clause_in_section(
        source, "AuditEvent", clause, f"`{field}` is a default-RESTRICT foreign key"
    )
    assert audit_retention_refusals(mutant)[0] == (
        f"AuditEvent.{field}: detached immutable snapshot is missing"
    )


def test_weakening_the_audit_restrict_path_prohibition_is_caught() -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause_in_section(
        source,
        "AuditEvent",
        AUDIT_NO_RESTRICT_PATH,
        "audit foreign keys may delay subject purge",
    )
    assert audit_retention_refusals(mutant) == [
        "AuditEvent: default-RESTRICT path prohibition is missing"
    ]


def test_escaped_pipe_cannot_hide_a_new_forbidden_certificate_foreign_key() -> None:
    source = MODEL.read_text(encoding="utf-8")
    anchor = "| `id` | UUIDv7 | |\n| `kind`"
    mutant = replace_in_section(
        source,
        "DeletionCertificate",
        anchor,
        "| `id` | UUIDv7 | |\n| `tenant_id` | FK `Tenant` | forbidden scope A \\| B |\n| `kind`",
    )
    assert "tenant_id" in certificate_refusals(mutant)[0]


@pytest.mark.parametrize(
    ("anchor", "message"),
    [
        (
            LOCKED_SOURCE_CLAUSE,
            "certificate snapshots are not validated against locked source rows",
        ),
        (
            "child-first in the same transaction",
            "finalized operational obligations are not purged after the evidence copy",
        ),
    ],
    ids=["unlocked-source", "retained-operational-obligation"],
)
def test_source_guard_catches_each_reachability_protocol_weakening(
    anchor: str, message: str
) -> None:
    source = MODEL.read_text(encoding="utf-8")
    mutant = replace_clause_in_section(source, "DeletionCertificate", anchor, "")
    assert message in certificate_refusals(mutant)


def test_weakening_the_cleanup_table_lifetime_scope_is_caught() -> None:
    model = MODEL.read_text(encoding="utf-8")
    state_machine = STATE_MACHINE.read_text(encoding="utf-8")
    mutant = replace_clause(
        model,
        LIFETIME_BOOTSTRAP_SCOPE,
        "Immutable ordered manifest of selected lifetime `ProjectBootstrap` rows",
    )
    assert lifetime_scope_refusals(mutant, state_machine) == [
        "cleanup manifest must contain every lifetime bootstrap without exception"
    ]


def test_weakening_t21_while_the_model_stays_strong_is_caught() -> None:
    model = MODEL.read_text(encoding="utf-8")
    state_machine = STATE_MACHINE.read_text(encoding="utf-8")
    mutant = replace_clause(
        state_machine,
        T21_LIFETIME_SCOPE,
        "immutable scope contains selected historical provider boundaries",
    )
    assert lifetime_scope_refusals(model, mutant) == [
        "T21 must require every historical provider boundary without exception"
    ]


@pytest.mark.parametrize(
    ("sql", "expected"),
    [
        ("GRANT EXECUTE ON FUNCTION harmless() TO PUBLIC", set()),
        ("REVOKE EXECUTE ON FUNCTION harmless() FROM PUBLIC", set()),
        ("GRANT EXECUTE ON PROCEDURE harmless() TO writer", set()),
        ("REVOKE EXECUTE ON ROUTINE harmless() FROM writer", set()),
        (
            "GRANT EXECUTE ON FUNCTION harmless() TO PUBLIC; CREATE TABLE entitlement (id bigint)",
            {"Entitlement"},
        ),
        (
            "GRANT EXECUTE ON FUNCTION harmless() TO PUBLIC; "
            "DO $$ BEGIN EXECUTE 'CREATE TABLE entitlement (id bigint)'; END $$;",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
        (
            "DO $$ BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION harmless() TO PUBLIC'; END $$;",
            set(NON_PERSISTED_MODEL_PROJECTIONS),
        ),
    ],
)
def test_migration_projection_scanner_distinguishes_execute_privileges_from_dynamic_sql(
    tmp_path: Path, sql: str, expected: set[str]
) -> None:
    _migration(tmp_path, "projection_probe", "0001_privileges.py", f"migrations.RunSQL({sql!r})")
    assert migration_create_model_names(tmp_path) == expected


@pytest.mark.parametrize(
    ("model", "default", "expected"),
    [
        ("PrivacyExport", "", {"PrivacyExport"}),
        ("Entitlement", "", {"Entitlement"}),
        (
            "PrivacyExport",
            "default=models.PositiveBigIntegerField",
            set(NON_PERSISTED_MODEL_PROJECTIONS) | {"PrivacyExport"},
        ),
        (
            "PrivacyExport",
            "default=models.UnreviewedField()",
            set(NON_PERSISTED_MODEL_PROJECTIONS) | {"PrivacyExport"},
        ),
    ],
)
def test_migration_positive_big_integer_field_preserves_projection_detection(
    tmp_path: Path, model: str, default: str, expected: set[str]
) -> None:
    _migration(
        tmp_path,
        "orgs",
        "0001_probe.py",
        f"migrations.CreateModel(name={model!r}, fields=["
        f"('bytes', models.PositiveBigIntegerField({default}))])",
    )
    assert migration_create_model_names(tmp_path) == expected


def _pure_expiry_migration(root: Path, operation: str) -> Path:
    _migration(root, "extensions", "0001_probe.py", operation)
    migration = root / "apps/extensions/migrations/0001_probe.py"
    migration.write_text("import apps.extensions.expiry\n" + migration.read_text())
    helper = root / "apps/extensions/expiry.py"
    (root / "apps/__init__.py").write_text("")
    (root / "apps/extensions/__init__.py").write_text('"""Extension package."""\n')
    helper.write_text(PURE_DELIVERY_EXPIRY)
    return helper


PURE_EXPIRY_FIELD = (
    "migrations.AddField(model_name='Delivery', name='expires_at', "
    "field=models.DateTimeField(default=apps.extensions.expiry.delivery_expiry))"
)


def test_pure_delivery_expiry_default_is_inspectable_only_in_its_field_slot(tmp_path: Path) -> None:
    _pure_expiry_migration(tmp_path, PURE_EXPIRY_FIELD)
    assert delivery_expiry_default_is_inspectable(tmp_path)
    assert migration_create_model_names(tmp_path) == set()


@pytest.mark.parametrize(
    "mutation",
    [
        lambda source: "import os\n" + source,
        lambda source: (
            source
            + "\nimport sqlite3\nsqlite3.connect(':memory:').execute('CREATE TABLE entitlement(id)')\n"
        ),
        lambda source: source + "\ndelivery_expiry = lambda: None\n",
        lambda source: source + "\ntimezone = None\n",
        lambda source: source + "\ntimedelta = lambda **kwargs: None\n",
        lambda source: source.replace("timezone.now()", "timezone.localtime()"),
        lambda source: source.replace("days=7", "days=1"),
        lambda source: source.replace("def delivery_expiry():", "@unknown\ndef delivery_expiry():"),
        lambda source: source.replace("def delivery_expiry():", "def delivery_expiry(value=None):"),
        lambda source: source.replace(
            "return timezone.now()", "raise RuntimeError('changed')\n    return timezone.now()"
        ),
        lambda source: source.replace("return timezone.now() + timedelta(days=7)", "return None"),
    ],
)
def test_pure_delivery_expiry_proof_rejects_changed_module_authority(
    tmp_path: Path, mutation: Callable[[str], str]
) -> None:
    helper = _pure_expiry_migration(tmp_path, PURE_EXPIRY_FIELD)
    helper.write_text(mutation(PURE_DELIVERY_EXPIRY))
    assert not delivery_expiry_default_is_inspectable(tmp_path)
    assert set(NON_PERSISTED_MODEL_PROJECTIONS) <= migration_create_model_names(tmp_path)


@pytest.mark.parametrize(
    "operation",
    [
        PURE_EXPIRY_FIELD.replace("expiry.delivery_expiry)", "expiry.delivery_expiry())"),
        PURE_EXPIRY_FIELD.replace("DateTimeField", "IntegerField"),
        PURE_EXPIRY_FIELD.replace("default=", "db_default="),
        "migrations.RunPython(apps.extensions.expiry.delivery_expiry)",
    ],
)
def test_pure_delivery_expiry_proof_rejects_calls_and_other_operation_slots(
    tmp_path: Path, operation: str
) -> None:
    _pure_expiry_migration(tmp_path, operation)
    assert delivery_expiry_default_is_inspectable(tmp_path)
    assert set(NON_PERSISTED_MODEL_PROJECTIONS) <= migration_create_model_names(tmp_path)


@pytest.mark.parametrize("link_parent", [False, True])
def test_pure_delivery_expiry_proof_rejects_symlinked_source(
    tmp_path: Path, link_parent: bool
) -> None:
    helper = _pure_expiry_migration(tmp_path, PURE_EXPIRY_FIELD)
    if link_parent:
        # Keep the importing migration visible to the root glob while redirecting
        # only the helper's package path; a hidden migration is not this proof.
        probe = tmp_path / "apps/probe/migrations/0001_probe.py"
        probe.parent.mkdir(parents=True)
        probe.write_text((helper.parent / "migrations/0001_probe.py").read_text())
        original = helper.parent
        moved = tmp_path / "redirected_extensions"
        original.rename(moved)
        original.symlink_to(moved, target_is_directory=True)
    else:
        moved = tmp_path / "redirected_clock.py"
        helper.rename(moved)
        helper.symlink_to(moved)
    assert not delivery_expiry_default_is_inspectable(tmp_path)
    assert set(NON_PERSISTED_MODEL_PROJECTIONS) <= migration_create_model_names(tmp_path)


def test_delivery_expiry_runtime_and_model_alias_retain_the_seven_day_clock(monkeypatch) -> None:
    from datetime import UTC, datetime, timedelta

    from apps.extensions import expiry, models

    now = datetime(2026, 1, 1, tzinfo=UTC)
    monkeypatch.setattr("django.utils.timezone.now", lambda: now)
    assert models.delivery_expiry is expiry.delivery_expiry
    assert models.Delivery._meta.get_field("expires_at").get_default() == now + timedelta(days=7)


@pytest.mark.parametrize(
    "statement",
    [
        "apps.extensions.expiry.delivery_expiry = lambda: None",
        "apps.extensions.expiry.timezone.now = lambda: None",
        "apps.extensions.expiry.timedelta = lambda **kwargs: None",
    ],
)
def test_pure_delivery_expiry_proof_rejects_caller_dependency_rebinding(
    tmp_path: Path, statement: str
) -> None:
    _pure_expiry_migration(tmp_path, PURE_EXPIRY_FIELD)
    migration = tmp_path / "apps/extensions/migrations/0001_probe.py"
    migration.write_text(
        migration.read_text().replace("class Migration", statement + "\nclass Migration")
    )
    assert set(NON_PERSISTED_MODEL_PROJECTIONS) <= migration_create_model_names(tmp_path)


def test_pure_delivery_expiry_proof_keeps_computed_projection_detection(tmp_path: Path) -> None:
    _pure_expiry_migration(
        tmp_path,
        "migrations.CreateModel(name='Entitlement', fields=[('expires_at', "
        "models.DateTimeField(default=apps.extensions.expiry.delivery_expiry))])",
    )
    assert migration_create_model_names(tmp_path) == {"Entitlement"}


def test_pure_delivery_expiry_proof_does_not_trust_the_legacy_model_module(tmp_path: Path) -> None:
    _pure_expiry_migration(tmp_path, PURE_EXPIRY_FIELD)
    migration = tmp_path / "apps/extensions/migrations/0001_probe.py"
    migration.write_text(
        migration.read_text().replace("apps.extensions.expiry", "apps.extensions.models")
    )
    assert set(NON_PERSISTED_MODEL_PROJECTIONS) <= migration_create_model_names(tmp_path)


@pytest.mark.parametrize("package", ["apps", "apps/extensions"])
def test_pure_delivery_expiry_proof_rejects_importing_package_side_effects(
    tmp_path: Path, package: str
) -> None:
    _pure_expiry_migration(tmp_path, PURE_EXPIRY_FIELD)
    initializer = tmp_path / package / "__init__.py"
    initializer.write_text(
        "import sqlite3\nsqlite3.connect(':memory:').execute('CREATE TABLE entitlement(id)')\n"
    )
    assert not delivery_expiry_default_is_inspectable(tmp_path)
    assert set(NON_PERSISTED_MODEL_PROJECTIONS) <= migration_create_model_names(tmp_path)


@pytest.mark.parametrize("package", ["apps", "apps/extensions"])
def test_pure_delivery_expiry_proof_rejects_symlinked_package_initializer(
    tmp_path: Path, package: str
) -> None:
    _pure_expiry_migration(tmp_path, PURE_EXPIRY_FIELD)
    initializer = tmp_path / package / "__init__.py"
    target = tmp_path / "redirected_initializer.py"
    initializer.rename(target)
    initializer.symlink_to(target)
    assert not delivery_expiry_default_is_inspectable(tmp_path)
    assert set(NON_PERSISTED_MODEL_PROJECTIONS) <= migration_create_model_names(tmp_path)


ENCODED_DDL_COMMENT = (
    b"# coding: unicode_escape\n"
    b"#\\u000aimport sqlite3; sqlite3.connect(':memory:').execute('CREATE TABLE entitlement(id)')\n"
)


@pytest.mark.parametrize(
    "relative", ["apps/extensions/expiry.py", "apps/__init__.py", "apps/extensions/__init__.py"]
)
def test_pure_delivery_expiry_proof_uses_import_encoding_for_every_source(
    tmp_path: Path, relative: str
) -> None:
    _pure_expiry_migration(tmp_path, PURE_EXPIRY_FIELD)
    target = tmp_path / relative
    target.write_bytes(ENCODED_DDL_COMMENT + target.read_bytes())
    # No poison is executed. Prove the payload is a comment under a forced UTF-8
    # read but is executable import syntax under CPython's declared encoding.
    forced_utf8 = ast.parse(target.read_bytes().decode("utf-8"))
    actual_import = ast.parse(target.read_bytes())
    assert not any(
        isinstance(node, ast.Import) and any(alias.name == "sqlite3" for alias in node.names)
        for node in ast.walk(forced_utf8)
    )
    assert any(
        isinstance(node, ast.Import) and any(alias.name == "sqlite3" for alias in node.names)
        for node in ast.walk(actual_import)
    )
    assert not delivery_expiry_default_is_inspectable(tmp_path)
    assert set(NON_PERSISTED_MODEL_PROJECTIONS) <= migration_create_model_names(tmp_path)


@pytest.mark.parametrize(
    "relative", ["apps/extensions/expiry.py", "apps/__init__.py", "apps/extensions/__init__.py"]
)
@pytest.mark.parametrize("content", [b"# coding: nonexistent_codec\n", b"# coding: utf-8\n\xff"])
def test_pure_delivery_expiry_proof_refuses_invalid_import_encodings(
    tmp_path: Path, relative: str, content: bytes
) -> None:
    _pure_expiry_migration(tmp_path, PURE_EXPIRY_FIELD)
    (tmp_path / relative).write_bytes(content)
    assert not delivery_expiry_default_is_inspectable(tmp_path)
    assert set(NON_PERSISTED_MODEL_PROJECTIONS) <= migration_create_model_names(tmp_path)


def test_migration_projection_scanner_uses_the_actual_declared_source_encoding(
    tmp_path: Path,
) -> None:
    _pure_expiry_migration(tmp_path, PURE_EXPIRY_FIELD)
    migration = tmp_path / "apps/extensions/migrations/0001_probe.py"
    migration.write_bytes(ENCODED_DDL_COMMENT + migration.read_bytes())
    assert delivery_expiry_default_is_inspectable(tmp_path)
    assert set(NON_PERSISTED_MODEL_PROJECTIONS) <= migration_create_model_names(tmp_path)
