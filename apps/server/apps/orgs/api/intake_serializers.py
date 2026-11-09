"""The HTTP shape of `createOrganisation`: its request, validated by hand against
`OrganisationCreateRequest`, and its `201` body, `OrganisationIntakeResult`.

Every member the contract declares is checked here, `additionalProperties: false` included, so a
body naming a membership, a role, a DPA or an order is a `422` (FIRST_OWNER_BOOTSTRAP.md §3.4). A
body that is not JSON at all is a `400`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from django.core.exceptions import ValidationError
from django.core.validators import validate_email

from apps.orgs.intake_services import (
    INSTRUCTION_REF_PATTERN,
    SLUG,
    IntakeRequest,
    IntakeView,
    IntendedOwner,
    is_reserved_slug,
)

TOP_LEVEL = frozenset(
    {
        "slug",
        "name",
        "instruction_ref",
        "intended_owner",
        "legal_name",
        "country",
        "vat_number",
        "siren",
        "billing_email",
        "billing_address",
        "email_domains",
        "locale",
    }
)
REQUIRED = ("slug", "name", "instruction_ref", "intended_owner")
OWNER_MEMBERS = frozenset({"email", "display_name"})
ADDRESS_MEMBERS = ("line1", "line2", "postal_code", "city", "country")
COUNTRY = re.compile(r"[A-Z]{2}\Z")
SIREN = re.compile(r"[0-9]{9}\Z")
LOCALES = ("fr", "en")
MAX_EMAIL = 320
MAX_DOMAINS = 20


class MalformedBodyError(Exception):
    """The body is not one JSON document."""


@dataclass(frozen=True, slots=True)
class FieldError:
    pointer: str
    code: str


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate member")
        result[key] = value
    return result


def _no_constants(value: str) -> None:
    raise ValueError("not a JSON number")


def parse(raw: bytes) -> Any:
    try:
        return json.loads(
            raw.decode("utf-8"), object_pairs_hook=_no_duplicates, parse_constant=_no_constants
        )
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise MalformedBodyError() from None


class _Checker:
    def __init__(self) -> None:
        self.errors: list[FieldError] = []

    def fail(self, pointer: str, code: str) -> None:
        self.errors.append(FieldError(pointer, code))

    def string(
        self,
        value: Any,
        pointer: str,
        *,
        maximum: int,
        minimum: int = 0,
        nullable: bool = False,
        pattern: re.Pattern[str] | None = None,
    ) -> bool:
        if value is None and nullable:
            return True
        if not isinstance(value, str):
            self.fail(pointer, "type")
            return False
        if "\x00" in value:
            self.fail(pointer, "invalid")
        elif len(value) < minimum:
            self.fail(pointer, "min_length")
        elif len(value) > maximum:
            self.fail(pointer, "max_length")
        elif pattern is not None and pattern.fullmatch(value) is None:
            self.fail(pointer, "pattern")
        else:
            return True
        return False

    def email(self, value: Any, pointer: str, *, nullable: bool = False) -> None:
        if value is None and nullable:
            return
        if not self.string(value, pointer, maximum=MAX_EMAIL, minimum=1):
            return
        try:
            validate_email(value)
        except ValidationError:
            self.fail(pointer, "format")

    def closed(self, value: dict[str, Any], allowed: frozenset[str], pointer: str) -> None:
        for name in sorted(set(value) - allowed):
            self.fail(f"{pointer}/{_escape(name)}", "unexpected")


def _escape(name: str) -> str:
    """A member name as a JSON Pointer reference token (RFC 6901)."""
    return name.replace("~", "~0").replace("/", "~1")


def validate(document: Any) -> IntakeRequest | list[FieldError]:
    check = _Checker()
    if not isinstance(document, dict):
        check.fail("", "type")
        return check.errors
    check.closed(document, TOP_LEVEL, "")
    for name in REQUIRED:
        if name not in document:
            check.fail(f"/{name}", "required")
    slug = document.get("slug")
    if "slug" in document and check.string(slug, "/slug", maximum=20, pattern=SLUG):
        if isinstance(slug, str) and is_reserved_slug(slug):
            check.fail("/slug", "reserved")
    if "name" in document:
        check.string(document["name"], "/name", minimum=1, maximum=200)
    if "instruction_ref" in document:
        check.string(
            document["instruction_ref"],
            "/instruction_ref",
            minimum=1,
            maximum=200,
            pattern=INSTRUCTION_REF_PATTERN,
        )
    owner = document.get("intended_owner")
    if "intended_owner" in document:
        if not isinstance(owner, dict):
            check.fail("/intended_owner", "type")
        else:
            check.closed(owner, OWNER_MEMBERS, "/intended_owner")
            if "email" not in owner:
                check.fail("/intended_owner/email", "required")
            else:
                check.email(owner["email"], "/intended_owner/email")
            if "display_name" in owner:
                check.string(
                    owner["display_name"],
                    "/intended_owner/display_name",
                    maximum=200,
                    nullable=True,
                )
    profile = _profile(document, check)
    if check.errors or not isinstance(owner, dict):
        return check.errors
    return IntakeRequest(
        slug=document["slug"],
        name=document["name"],
        instruction_ref=document["instruction_ref"],
        intended_owner=IntendedOwner(email=owner["email"], display_name=owner.get("display_name")),
        profile=profile,
    )


def _profile(document: dict[str, Any], check: _Checker) -> dict[str, Any]:
    """The optional members Organisation does not store yet, validated, as received."""
    if "legal_name" in document:
        check.string(document["legal_name"], "/legal_name", maximum=200, nullable=True)
    if "country" in document:
        check.string(document["country"], "/country", maximum=2, pattern=COUNTRY)
    if "vat_number" in document:
        check.string(document["vat_number"], "/vat_number", maximum=20, nullable=True)
    if "siren" in document:
        check.string(document["siren"], "/siren", maximum=9, nullable=True, pattern=SIREN)
    if "billing_email" in document:
        check.email(document["billing_email"], "/billing_email", nullable=True)
    address = document.get("billing_address")
    if address is not None:
        if not isinstance(address, dict):
            check.fail("/billing_address", "type")
        else:
            for name in ("line1", "postal_code", "city", "country"):
                if name not in address:
                    check.fail(f"/billing_address/{name}", "required")
            limits = {"line1": 200, "line2": 200, "postal_code": 20, "city": 100, "country": 2}
            for name in ADDRESS_MEMBERS:
                if name in address:
                    check.string(
                        address[name],
                        f"/billing_address/{name}",
                        maximum=limits[name],
                        nullable=name == "line2",
                        pattern=COUNTRY if name == "country" else None,
                    )
            address = {name: address[name] for name in ADDRESS_MEMBERS if name in address}
    domains = document.get("email_domains")
    if "email_domains" in document:
        if not isinstance(domains, list):
            check.fail("/email_domains", "type")
        elif len(domains) > MAX_DOMAINS:
            check.fail("/email_domains", "max_items")
        else:
            for index, domain in enumerate(domains):
                check.string(domain, f"/email_domains/{index}", maximum=253)
    if "locale" in document and document["locale"] not in LOCALES:
        check.fail("/locale", "enum")
    profile: dict[str, Any] = {
        name: document[name]
        for name in ("legal_name", "country", "vat_number", "siren", "billing_email", "locale")
        if name in document
    }
    if "billing_address" in document:
        profile["billing_address"] = address
    if "email_domains" in document:
        profile["email_domains"] = domains
    return profile


# ------------------------------------------------------------------------------ the answer ----


def timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def intake_result(view: IntakeView) -> bytes:
    organisation_id = str(view.organisation_id)
    body = {
        "organisation": {
            "id": organisation_id,
            "slug": view.slug,
            "name": view.name,
            "state": view.state,
            # The contract's `realm` is null until the realm_create job created the realm.
            "realm": None,
            "created_at": timestamp(view.organisation_created_at),
            "updated_at": timestamp(view.organisation_updated_at),
        },
        "bootstrap": {
            "organisation_id": organisation_id,
            "slug": view.slug,
            "organisation_state": view.state,
            "intake": {
                "instruction_ref": view.instruction_ref,
                "recorded_at": timestamp(view.recorded_at),
                "intended_owner_email_masked": view.intended_owner_email_masked,
            },
            "realm": {"state": view.realm_state, "name": None, "job_id": str(view.job_id)},
            "identity_mapping": {"state": "pending", "identity_id": None, "bound_at": None},
            "claim": {
                "state": "not_issued",
                "issued_at": None,
                "expires_at": None,
                "consumed_at": None,
                "revoked_at": None,
                "membership_id": None,
            },
            "updated_at": timestamp(view.recorded_at),
        },
    }
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
