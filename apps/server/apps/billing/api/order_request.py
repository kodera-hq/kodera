"""The contract's `OrderRequest` read from a request body: its shape only, field by field.

Every unknown member, missing required member and wrong type is a `422 validation-error` entry
`{pointer, code}`; the values themselves (codes in the catalogue, versions in force, the slug's
availability) are the service's to judge. A body that is not a JSON object is the view's `400`.
"""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from apps.billing.services import Accepted, Agreements, OrderRequest, TenantRequest

TOP = {
    "pack_code",
    "capacity_tier_code",
    "billing_period",
    "plan_code",
    "tenant",
    "dpa_acceptance",
    "legal_acceptances",
    "billing_contact",
    "notes",
}
REQUIRED = (
    "pack_code",
    "capacity_tier_code",
    "billing_period",
    "tenant",
    "dpa_acceptance",
    "legal_acceptances",
)
TENANT = {"slug", "name", "locale"}
DPA = {"dpa_id", "accepted", "accepted_by_name", "accepted_by_role"}
LEGAL = {"code", "version", "locale"}
CONTACT = {"email", "name", "purchase_order_ref"}

Errors = list[dict[str, str]]


class OrderRequestError(Exception):
    def __init__(self, errors: Errors) -> None:
        super().__init__("order request refused")
        self.errors = errors


def _members(value: Any, pointer: str, allowed: set[str], errors: Errors) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        errors.append({"pointer": pointer, "code": "type"})
        return {}
    for name in sorted(set(value) - allowed):
        errors.append({"pointer": f"{pointer}/{name}", "code": "unknown_member"})
    return value


def _string(
    source: Mapping[str, Any],
    name: str,
    pointer: str,
    errors: Errors,
    *,
    required: bool,
    limit: int,
    nullable: bool = False,
) -> str | None:
    if name not in source:
        if required:
            errors.append({"pointer": f"{pointer}/{name}", "code": "required"})
        return None
    value = source[name]
    if value is None and nullable:
        return None
    if not isinstance(value, str) or len(value) > limit:
        errors.append({"pointer": f"{pointer}/{name}", "code": "type"})
        return None
    return value


def parse_order_request(body: Any) -> OrderRequest:
    errors: Errors = []
    top = _members(body, "", TOP, errors)
    for name in REQUIRED:
        if name not in top:
            errors.append({"pointer": f"/{name}", "code": "required"})
    pack = _string(top, "pack_code", "", errors, required=True, limit=64)
    tier = _string(top, "capacity_tier_code", "", errors, required=True, limit=64)
    period = _string(top, "billing_period", "", errors, required=True, limit=16)
    plan = _string(top, "plan_code", "", errors, required=False, limit=64, nullable=True)
    notes = _string(top, "notes", "", errors, required=False, limit=1000, nullable=True)

    tenant = _members(top.get("tenant", {}), "/tenant", TENANT, errors)
    slug = _string(tenant, "slug", "/tenant", errors, required=True, limit=64)
    tenant_name = _string(tenant, "name", "/tenant", errors, required=True, limit=200)
    locale = _string(tenant, "locale", "/tenant", errors, required=False, limit=2)

    dpa = _members(top.get("dpa_acceptance", {}), "/dpa_acceptance", DPA, errors)
    dpa_id: UUID | None = None
    raw_id = _string(dpa, "dpa_id", "/dpa_acceptance", errors, required=True, limit=36)
    if raw_id is not None:
        try:
            dpa_id = UUID(raw_id)
            if str(dpa_id) != raw_id.lower():
                raise ValueError(raw_id)
        except ValueError:
            errors.append({"pointer": "/dpa_acceptance/dpa_id", "code": "format"})
    if dpa.get("accepted") is not True:
        errors.append({"pointer": "/dpa_acceptance/accepted", "code": "must_be_true"})
    accepted_name = _string(
        dpa, "accepted_by_name", "/dpa_acceptance", errors, required=False, limit=200
    )
    if accepted_name is not None and not accepted_name.strip():
        errors.append({"pointer": "/dpa_acceptance/accepted_by_name", "code": "empty"})
    accepted_role = _string(
        dpa, "accepted_by_role", "/dpa_acceptance", errors, required=False, limit=100, nullable=True
    )

    documents: list[Accepted] = []
    raw_documents = top.get("legal_acceptances", [])
    if not isinstance(raw_documents, list) or not 1 <= len(raw_documents) <= 3:
        errors.append({"pointer": "/legal_acceptances", "code": "type"})
        raw_documents = []
    for index, raw in enumerate(raw_documents):
        pointer = f"/legal_acceptances/{index}"
        item = _members(raw, pointer, LEGAL, errors)
        code = _string(item, "code", pointer, errors, required=True, limit=8)
        version = _string(item, "version", pointer, errors, required=True, limit=20)
        doc_locale = _string(item, "locale", pointer, errors, required=True, limit=2)
        if code is not None and version is not None and doc_locale is not None:
            documents.append(Accepted(code=code, version=version, locale=doc_locale))

    contact = (
        _members(top["billing_contact"], "/billing_contact", CONTACT, errors)
        if "billing_contact" in top
        else {}
    )
    email = _string(contact, "email", "/billing_contact", errors, required=False, limit=254)
    contact_name = _string(
        contact, "name", "/billing_contact", errors, required=False, limit=200, nullable=True
    )
    po_ref = _string(
        contact,
        "purchase_order_ref",
        "/billing_contact",
        errors,
        required=False,
        limit=100,
        nullable=True,
    )

    if (
        errors
        or pack is None
        or tier is None
        or period is None
        or slug is None
        or tenant_name is None
        or dpa_id is None
    ):
        raise OrderRequestError(errors or [{"pointer": "", "code": "invalid"}])
    return OrderRequest(
        pack_code=pack,
        capacity_tier_code=tier,
        billing_period=period,
        plan_code=plan,
        tenant=TenantRequest(slug=slug, name=tenant_name, locale=locale or "fr"),
        agreements=Agreements(
            dpa_id=dpa_id,
            documents=tuple(documents),
            accepted_by_name=accepted_name,
            accepted_by_role=accepted_role,
        ),
        purchase_order_ref=po_ref,
        billing_contact_email=email,
        billing_contact_name=contact_name,
        notes=notes,
    )
