"""Legal documents in force, DPA generation and acceptance: the order's agreements.

A document is in force from its `published_at` until a later version of the same code and locale
is published, for that pack or for every pack; at the same instant a pack's own document wins. `generate_dpa` derives the organisation's DPA from the DPA template in force. The order
transaction calls `check_agreements` before it writes anything, refusing a version that is no
longer in force, then `record_agreements`, which records the customer's acceptance of the CGV (and
of any other document the order shows) and of the DPA, and writes `dpa.accepted`. Nothing here edits an acceptance once written.
"""

import hashlib
import ipaddress
import tomllib
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import DataError, IntegrityError, connection, transaction
from django.db.models import F, Q
from django.utils import timezone

from apps.audit.services import record_authz_denied, record_billing_event
from apps.billing.selectors import has_committed_order, pack_is_available
from apps.identity.selectors import current_staff_identity
from apps.orgs.actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    read_tenant_caller,
)
from apps.tenancy.selectors import tenants_not_deleted
from apps.tenancy.services import tenant_status_of
from services.identity.access_tokens import VerifiedAccessToken

from .models import CODES as CODES, LOCALES as LOCALES, Acceptance, Dpa, LegalDocument


class CallerUnknownError(Exception):
    """The verified token names no enabled identity: `403 identity-unknown`."""


class NotFoundError(Exception):
    """Not the caller's organisation, or no current membership in it: `404`."""


class ForbiddenError(Exception):
    """A member whose stored role does not hold the operation's scope: `403`."""

    def __init__(self, caller: TenantCaller | None = None) -> None:
        super().__init__("forbidden")
        self.caller = caller


def _caller(
    *, verified: VerifiedAccessToken, organisation_id: UUID, roles: frozenset[str]
) -> TenantCaller:
    """The caller's current membership and role, in the caller's transaction (AUTHZ.md §§2, 6)."""
    try:
        caller = read_tenant_caller(verified=verified, organisation_id=organisation_id)
    except TenantCallerUnknownError:
        raise CallerUnknownError() from None
    except TenantCallerNotFoundError:
        raise NotFoundError() from None
    if caller.role not in roles:
        raise ForbiddenError(caller)
    return caller


PLACEHOLDER = Path(__file__).with_name("documents") / "placeholder.toml"
REQUIRED = frozenset({"cgv"})
ORDER_DOCUMENTS = frozenset({"cgv", "sla", "aup"})
OWNER = frozenset({"org_owner"})
DOCUMENT_FIELDS = {
    "code",
    "version",
    "locale",
    "title",
    "pack_code",
    "html_url",
    "sha256",
    "text",
    "text_file",
    "sub_processors",
    "published_at",
}
ANNEXES = ["A", "B", "C", "D"]


class LegalValidationError(Exception):
    """A document the order needs is missing or unknown: `422 validation-error`."""

    def __init__(self, field: str, reason: str) -> None:
        super().__init__(f"{field}: {reason}")
        self.field = field
        self.reason = reason


class LegalVersionError(Exception):
    """The version accepted is not the one in force: `422 validation-error`, naming the one that is."""

    def __init__(self, code: str, allowed: tuple[str, ...]) -> None:
        super().__init__(f"{code}: not the version in force")
        self.code = code
        self.allowed = allowed


class DpaNotFoundError(Exception):
    """No DPA of this organisation by that id, or no DPA template for the pack: `404`."""


class LegalDocumentsError(Exception):
    """A documents file is malformed, a placeholder that was not allowed, or edits a stored row."""


@dataclass(frozen=True, slots=True)
class Accepted:
    """A document the customer accepted: the contract's `{code, version, locale}`."""

    code: str
    version: str
    locale: str


@dataclass(frozen=True, slots=True)
class Signatory:
    """The person accepting, resolved from current state, and where the request came from."""

    identity_id: UUID
    person_id: UUID
    email: str
    name: str
    role: str | None
    source_ip: str | None
    user_agent: str | None


def _for_pack(pack_code: str | None) -> Q:
    return (
        Q(pack_code__isnull=True) | Q(pack_code=pack_code)
        if pack_code
        else Q(pack_code__isnull=True)
    )


def in_force(
    *, code: str, locale: str, pack_code: str | None, now: datetime | None = None
) -> LegalDocument | None:
    """The version of `code` in `locale` in force for `pack_code` now."""
    now = now or timezone.now()
    return (
        LegalDocument.objects.filter(code=code, locale=locale, published_at__lte=now)
        .filter(_for_pack(pack_code))
        .order_by("-published_at", F("pack_code").asc(nulls_last=True), "-id")
        .first()
    )


def documents_in_force(*, pack_code: str | None, locale: str | None) -> list[LegalDocument]:
    """Every code's version in force, for the order screen; one per code and locale."""
    found = []
    for code in CODES:
        for each in (locale,) if locale else LOCALES:
            document = in_force(code=code, locale=each, pack_code=pack_code)
            if document is not None:
                found.append(document)
    return found


def _truncate(address: str | None) -> str | None:
    """The address as the audit record keeps it: /24 for IPv4, /48 for IPv6."""
    if not address:
        return None
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return None
    prefix = 24 if parsed.version == 4 else 48
    return str(ipaddress.ip_network(f"{parsed}/{prefix}", strict=False).network_address)


def authorise(
    *, verified: VerifiedAccessToken, organisation_id: UUID, roles: frozenset[str], scope: str
) -> None:
    """The caller's current role in the organisation, in a read-only snapshot, before a write is
    handed to the replay store: `CallerUnknownError`, `NotFoundError` or `ForbiddenError`."""
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        _caller(verified=verified, organisation_id=organisation_id, roles=roles)


def record_denial(
    *,
    verified: VerifiedAccessToken,
    refused: ForbiddenError | None,
    organisation_id: UUID,
    scope: str,
    request_id: str,
) -> None:
    """`authz.denied` for a `403` of these operations (AUTHZ.md §9), in a transaction of its own:
    the member whose role holds no cell, or the staff token (`refused` None)."""
    with transaction.atomic():
        actor_id: UUID | None
        if refused is not None and refused.caller is not None:
            actor_type, actor_id = "tenant", refused.caller.identity_id
        else:
            staff = current_staff_identity(issuer=verified.issuer, subject=verified.subject)
            actor_type, actor_id = "staff", None if staff is None else staff.id
        record_authz_denied(
            actor_type=actor_type,
            actor_id=actor_id,
            organisation_id=organisation_id,
            target_urn=f"urn:kodera:organisation:{organisation_id}",
            request_id=request_id,
            required_scope=scope,
            reason="role_missing",
        )


def generate_dpa(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    pack_code: str,
    locale: str,
    tenant_id: UUID | None,
) -> tuple[Dpa, bool]:
    """The organisation's DPA for `pack_code`, from the template in force; owner only.

    An unaccepted DPA from the same template is returned as it is (created False); one from an
    older template is superseded by a new one.
    """
    if locale not in LOCALES:
        raise LegalValidationError("locale", "unknown")
    with transaction.atomic():
        _caller(verified=verified, organisation_id=organisation_id, roles=OWNER)
        if not pack_is_available(code=pack_code):
            raise DpaNotFoundError()
        return prepare_dpa(
            organisation_id=organisation_id, pack_code=pack_code, locale=locale, tenant_id=tenant_id
        )


def prepare_dpa(
    *, organisation_id: UUID, pack_code: str, locale: str, tenant_id: UUID | None
) -> tuple[Dpa, bool]:
    """`generate_dpa`'s write, in the caller's transaction, for a caller that has checked the
    owner and the pack itself: `createTenant` (QUICK_WORKSPACE.md §4.3 step 2). Returns the unaccepted
    DPA from the template in force, as it is, or creates one and supersedes the older ones."""
    if not connection.in_atomic_block:
        raise RuntimeError("a DPA is prepared in the caller's transaction")
    if locale not in LOCALES:
        raise LegalValidationError("locale", "unknown")
    template = in_force(code="dpa", locale=locale, pack_code=pack_code)
    if template is None:
        raise DpaNotFoundError()
    pending = list(
        Dpa.objects.select_for_update().filter(
            organisation_id=organisation_id,
            pack_code=pack_code,
            locale=locale,
            state="generated",
        )
    )
    current = next((dpa for dpa in pending if dpa.template_id == template.id), None)
    if current is not None:
        return current, False
    for old in pending:
        old.state = "superseded"
        old.save(update_fields=["state", "updated_at"])
    try:
        with transaction.atomic():
            dpa = Dpa.objects.create(
                organisation_id=organisation_id,
                template=template,
                tenant_id=tenant_id,
                pack_code=pack_code,
                locale=locale,
                version=template.version,
                sha256=template.sha256,
                sub_processors=template.sub_processors,
            )
    except IntegrityError:
        # A concurrent generate created it first: one unaccepted DPA per pack and locale.
        raced = Dpa.objects.get(
            organisation_id=organisation_id,
            pack_code=pack_code,
            locale=locale,
            state="generated",
        )
        return raced, False
    for old in pending:
        old.superseded_by = dpa
        old.save(update_fields=["superseded_by", "updated_at"])
    return dpa, True


def read_dpa(*, verified: VerifiedAccessToken, organisation_id: UUID, dpa_id: UUID) -> Dpa:
    """One DPA of the caller's organisation, for the roles that read it (AUTHZ.md §5)."""
    with transaction.atomic():
        _caller(
            verified=verified,
            organisation_id=organisation_id,
            roles=frozenset({"org_owner", "org_admin", "org_billing"}),
        )
        dpa = Dpa.objects.filter(organisation_id=organisation_id, id=dpa_id).first()
        if dpa is None:
            raise DpaNotFoundError()
        return dpa


@dataclass(frozen=True, slots=True)
class CheckedAgreements:
    """What `check_agreements` resolved and locked, for `record_agreements` to write."""

    organisation_id: UUID
    documents: tuple[LegalDocument, ...]
    dpa: Dpa
    checked_at: datetime


def check_agreements(
    *, organisation_id: UUID, pack_code: str, documents: list[Accepted], dpa_id: UUID
) -> CheckedAgreements:
    """Every refusal of the agreements, before the order writes anything, the DPA row locked.

    Each document must be one the order may show, accepted once, at the version in force for its
    locale and the pack; the CGV is required. The DPA must be this organisation's, for this pack,
    generated from the template still in force, and not yet accepted.
    """
    if not connection.in_atomic_block:
        raise RuntimeError("the agreements are checked in the order's transaction")
    now = timezone.now()
    codes = [document.code for document in documents]
    if len(codes) != len(set(codes)):
        raise LegalValidationError("legal_acceptances", "duplicate_code")
    for document in documents:
        if document.code not in ORDER_DOCUMENTS or document.locale not in LOCALES:
            raise LegalValidationError("legal_acceptances", "unknown_document")
    missing = sorted(REQUIRED - set(codes))
    if missing:
        raise LegalValidationError("legal_acceptances", f"{missing[0]}_missing")
    resolved = []
    for document in documents:
        current = in_force(code=document.code, locale=document.locale, pack_code=pack_code, now=now)
        if current is None:
            raise LegalValidationError("legal_acceptances", f"{document.code}_not_published")
        if current.version != document.version:
            raise LegalVersionError(document.code, (current.version,))
        resolved.append(current)
    dpa = Dpa.objects.select_for_update().filter(id=dpa_id, organisation_id=organisation_id).first()
    if dpa is None:
        raise DpaNotFoundError()
    if dpa.pack_code != pack_code:
        raise LegalValidationError("dpa_acceptance/dpa_id", "dpa_other_pack")
    if dpa.state == "accepted":
        raise LegalValidationError("dpa_acceptance/dpa_id", "dpa_already_accepted")
    template = in_force(code="dpa", locale=dpa.locale, pack_code=pack_code, now=now)
    if dpa.state != "generated" or template is None or template.id != dpa.template_id:
        raise LegalVersionError("dpa", () if template is None else (template.version,))
    return CheckedAgreements(organisation_id, tuple(resolved), dpa, now)


def record_agreements(
    checked: CheckedAgreements,
    *,
    order_id: UUID | None,
    tenant_id: UUID,
    signatory: Signatory,
    request_id: str | None,
) -> Dpa:
    """Record, in the order's transaction, the acceptance of each document and of the DPA, and
    write `dpa.accepted`.

    With no order (a deployment that does not bill, docs/specs/QUICK_WORKSPACE.md §3), each
    acceptance names the tenant it was given for instead; with an order it names the order only,
    so an acceptance never holds both and the unbilled guard reads only its own rows."""
    organisation_id, dpa, now = checked.organisation_id, checked.dpa, checked.checked_at
    # The tenant is the organisation's own: an acceptance is contract evidence and never changes,
    # so it never names another organisation's tenant. Checked here rather than by a foreign key,
    # which would keep the tenant row from its own purge (MODEL.md, retention).
    if tenant_status_of(organisation_id=organisation_id, tenant_id=tenant_id) is None:
        raise ValueError("the agreements name a tenant of another organisation")
    common = {
        "organisation_id": organisation_id,
        "identity_id": signatory.identity_id,
        "order_id": order_id,
        "tenant_id": tenant_id if order_id is None else None,
        "accepted_at": now,
        "accepted_by_name": signatory.name,
        "accepted_by_role": signatory.role,
        "source_ip_trunc": _truncate(signatory.source_ip),
        "user_agent": None if signatory.user_agent is None else signatory.user_agent[:500],
    }
    for current in checked.documents:
        Acceptance.objects.create(document=current, **common)
    Acceptance.objects.create(document_id=dpa.template_id, dpa=dpa, **common)
    dpa.state = "accepted"
    dpa.tenant_id = tenant_id
    dpa.accepted_at = now
    dpa.accepted_by_identity_id = signatory.identity_id
    dpa.accepted_by_person_id = signatory.person_id
    dpa.accepted_by_name = signatory.name
    dpa.accepted_by_email = signatory.email
    dpa.accepted_by_role = signatory.role
    dpa.save(
        update_fields=[
            "state",
            "tenant_id",
            "accepted_at",
            "accepted_by_identity_id",
            "accepted_by_person_id",
            "accepted_by_name",
            "accepted_by_email",
            "accepted_by_role",
            "updated_at",
        ]
    )
    record_billing_event(
        action="dpa.accepted",
        actor_type="tenant",
        actor_id=signatory.identity_id,
        organisation_id=organisation_id,
        target_urn=f"urn:kodera:organisation:{organisation_id}",
        request_id=request_id,
        metadata={
            "dpa_id": str(dpa.id),
            "version": dpa.version,
            "sha256": dpa.sha256,
            "order_id": None if order_id is None else str(order_id),
            "documents": [f"{d.code}:{d.version}:{d.locale}:{d.sha256}" for d in checked.documents],
        },
    )
    return dpa


def has_accepted_agreements(*, organisation_id: UUID) -> bool:
    """Whether the organisation has accepted the CGV and the DPA a workspace is created against
    (the G1 ruling): through an order not cancelled whose DPA is accepted (`has_committed_order`),
    or with no order, as a deployment that does not bill records them: both accepted for one tenant
    of its own that is not deleted, the DPA still `accepted` (docs/specs/QUICK_WORKSPACE.md §3).

    The second branch reads the acceptances recorded without an order, never the DPA's tenant: the
    paid path names the tenant on the DPA too, so a cancelled order whose tenant lives on would
    otherwise count. Both documents must name the same tenant."""
    if has_committed_order(organisation_id=organisation_id):
        return True
    rows = Acceptance.objects.filter(
        organisation_id=organisation_id,
        order_id__isnull=True,
        tenant_id__in=tenants_not_deleted(organisation_id).values("id"),
    ).values_list("tenant_id", "document__code", "dpa__state")
    accepted: dict[UUID | None, set[str]] = {}
    for tenant_id, code, dpa_state in rows:
        if code == "dpa" and dpa_state != "accepted":
            continue
        accepted.setdefault(tenant_id, set()).add(code)
    return any({"cgv", "dpa"} <= codes for codes in accepted.values())


def has_accepted_dpa(*, organisation_id: UUID, dpa_id: UUID) -> bool:
    return Dpa.objects.filter(id=dpa_id, organisation_id=organisation_id, state="accepted").exists()


def dpa_representation(dpa: Dpa) -> dict[str, Any]:
    """The contract's `Dpa`."""

    def instant(value: datetime | None) -> str | None:
        return None if value is None else value.isoformat().replace("+00:00", "Z")

    accepted_by = None
    if dpa.state == "accepted" or dpa.accepted_at is not None:
        accepted_by = {
            "person_id": str(dpa.accepted_by_person_id),
            "name": dpa.accepted_by_name,
            "email": dpa.accepted_by_email,
            "role_title": dpa.accepted_by_role,
        }
    return {
        "id": str(dpa.id),
        "organisation_id": str(dpa.organisation_id),
        "tenant_id": None if dpa.tenant_id is None else str(dpa.tenant_id),
        "version": dpa.version,
        "state": dpa.state,
        "locale": dpa.locale,
        "pack_code": dpa.pack_code,
        "sha256": dpa.sha256,
        "sub_processors": list(dpa.sub_processors),
        "annexes": ANNEXES,
        "generated_at": instant(dpa.created_at),
        "accepted_at": instant(dpa.accepted_at),
        "accepted_by": accepted_by,
        "superseded_by": None if dpa.superseded_by_id is None else str(dpa.superseded_by_id),
    }


def dpa_representation_by_id(*, dpa_id: UUID) -> dict[str, Any]:
    return dpa_representation(Dpa.objects.get(id=dpa_id))


@dataclass(frozen=True)
class OrderAgreements:
    """What an order's confirmation names: who accepted, in which locale, and each document."""

    recipient: str
    locale: str
    documents: tuple[LegalDocument, ...]


def order_agreements(*, order_id: UUID) -> OrderAgreements | None:
    """The documents accepted with `order_id`, the DPA last, and the signatory's address; None when
    the order recorded no accepted DPA."""
    accepted = list(
        Acceptance.objects.select_related("document", "dpa")
        .filter(order_id=order_id)
        .order_by("dpa_id", "document__code")
    )
    dpa = next((row.dpa for row in accepted if row.dpa is not None), None)
    if dpa is None or dpa.state != "accepted" or dpa.accepted_by_email is None:
        return None
    documents = sorted((row.document for row in accepted), key=lambda d: (d.code == "dpa", d.code))
    return OrderAgreements(
        recipient=dpa.accepted_by_email, locale=dpa.locale, documents=tuple(documents)
    )


def published_text(*, code: str, version: str, locale: str) -> LegalDocument | None:
    """The published document whose text `getLegalDocumentText` serves, if Core holds its text.

    Readable from the moment it is loaded, before the date it comes into force (`published_at`):
    a new version is notified, and read, thirty days before it applies (CGV 14)."""
    return (
        LegalDocument.objects.filter(code=code, version=version, locale=locale, text__isnull=False)
        .only("code", "version", "locale", "sha256", "text")
        .first()
    )


def document_representation(document: LegalDocument) -> dict[str, Any]:
    """The contract's `LegalDocument`. No PDF is stored yet: `download` is null."""
    return {
        "code": document.code,
        "version": document.version,
        "locale": document.locale,
        "title": document.title,
        "pack_code": document.pack_code,
        "html_url": document.html_url,
        "text_url": text_url(document),
        "sha256": document.sha256,
        "download": None,
        "published_at": document.published_at.isoformat().replace("+00:00", "Z"),
    }


# --- the documents file ------------------------------------------------------------------------


def read_documents(path: Path) -> dict[str, Any]:
    """The documents file, each `text_file` (relative to the file) read in as its `text`."""
    with path.open("rb") as handle:
        document = tomllib.load(handle)
    rows = document.get("documents", [])
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or "text_file" not in row:
            continue
        name = row.pop("text_file")
        folder = path.parent.resolve()
        file = folder / name if isinstance(name, str) else folder
        # A text is public and never removed: only a regular file inside the documents' folder,
        # never through a link, is read.
        if (
            "text" in row
            or not isinstance(name, str)
            or Path(name).is_absolute()
            or file.is_symlink()
            or not file.resolve().is_relative_to(folder)
            or not file.is_file()
        ):
            raise LegalDocumentsError(
                f"{row.get('code')} {row.get('version')}: text_file is one relative path to a "
                "file in the documents' folder, or text"
            )
        # Strict UTF-8: the stored text encodes back to exactly the bytes the digest covers.
        row["text"] = file.read_bytes().decode("utf-8")
    return document


def text_digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def text_url(document: LegalDocument) -> str | None:
    """The permanent URL of the document's text (`getLegalDocumentText`), when Core holds the text
    and knows the origin it is read at."""
    origin: str | None = settings.KODERA_LEGAL_TEXT_ORIGIN
    if document.text is None or origin is None:
        return None
    return f"{origin}/api/v1/legal-documents/{document.code}/{document.version}/{document.locale}"


def load_documents(document: dict[str, Any], *, allow_placeholder: bool) -> tuple[int, int]:
    """Publish the documents a file names: additive and idempotent, a stored row never edited.

    Returns (created, unchanged). A file declaring `placeholder = true` is refused unless allowed.
    """
    unknown = set(document) - {"placeholder", "documents"}
    if unknown:
        raise LegalDocumentsError(f"unknown sections: {', '.join(sorted(unknown))}")
    placeholder = document.get("placeholder", False)
    if not isinstance(placeholder, bool):
        raise LegalDocumentsError("placeholder is true or false")
    if placeholder and not allow_placeholder:
        raise LegalDocumentsError(
            "this is a placeholder documents file; it is loaded only where allowed"
        )
    rows = document.get("documents", [])
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise LegalDocumentsError("[documents] is a list of tables")
    created = unchanged = 0
    with transaction.atomic():
        for row in rows:
            extra = set(row) - DOCUMENT_FIELDS
            if extra:
                raise LegalDocumentsError(
                    f"[documents] has unknown keys: {', '.join(sorted(extra))}"
                )
            text = row.get("text")
            if not isinstance(text, str) or not text:
                raise LegalDocumentsError(
                    f"{row.get('code')} {row.get('version')}: a document is published with its text"
                )
            digest = text_digest(text)
            if row.get("sha256", digest) != digest:
                raise LegalDocumentsError(
                    f"{row.get('code')} {row.get('version')}: sha256 is not the digest of its text"
                )
            published_at = row.get("published_at")
            if not isinstance(published_at, datetime) or published_at.tzinfo is None:
                raise LegalDocumentsError(
                    f"{row.get('code')} {row.get('version')}: published_at has an offset"
                )
            key = {
                "code": row.get("code"),
                "version": row.get("version"),
                "locale": row.get("locale"),
                "pack_code": row.get("pack_code"),
            }
            values = {
                "title": row.get("title"),
                "html_url": row.get("html_url"),
                "sha256": digest,
                "text": text,
                "sub_processors": row.get("sub_processors", []),
                "published_at": published_at,
            }
            stored = LegalDocument.objects.filter(**key).first()
            if stored is not None:
                # A row published before Core kept texts stays without one (it is append-only):
                # the same digest is the same document, unchanged, and it has no permanent URL.
                compared = values if stored.text is not None else {**values, "text": None}
                if any(getattr(stored, name) != value for name, value in compared.items()):
                    raise LegalDocumentsError(
                        f"{key['code']} {key['version']} {key['locale']} is published with other "
                        "values: a change is a new version"
                    )
                unchanged += 1
                continue
            new = LegalDocument(**key, **values)
            try:
                new.full_clean(validate_unique=False)
                with transaction.atomic():
                    new.save()
            except (ValidationError, IntegrityError, DataError) as refused:
                raise LegalDocumentsError(f"{key['code']} {key['version']}: {refused}") from None
            created += 1
    return created, unchanged
