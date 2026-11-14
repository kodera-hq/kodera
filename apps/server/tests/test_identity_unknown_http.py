"""A verified token Core holds no identity for is `403 identity-unknown`; a failed one is `401`.

docs/api/AUTHZ.md §2: steps 1 to 5 failing, an unknown realm or issuer included, is
`401 unauthenticated` with `WWW-Authenticate: Bearer`; a token that passes them but whose
`(iss, sub)` resolves no enabled customer identity of an enabled person is `403 identity-unknown`
with no challenge (step 6). Every customer view is driven here without a database: the
verification half through the real verifier, refused before any query, and the resolution half
with the view's own unknown-principal error raised where its service would raise it. The database
states that produce that error (no row, a disabled or deleted identity or person) are proven by the
Postgres suites: tests/test_customer_http.py, tests/test_organisation_detail.py,
tests/test_membership_directory_http.py and the consume suites.

Each refusal logs one WARNING line naming the event, the request id and the operation, and never
the issuer, the subject, an email or the token (AUTHZ.md §9). A staff token keeps the answers it had
before: `getOrganisationBootstrap` refuses an unstorable staff subject, and the staff issuer
arriving on the customer lane, with `401` and its challenge, never with `identity-unknown`.

The last tests are the mutation proof: with the one shared mapping, `core.api.problems`, put back
to the old `401`, every endpoint fails by name.
"""

import importlib
import json
import re
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.http import HttpResponse
from django.test import RequestFactory
from test_access_tokens import frozen_clock as frozen_clock

from core.api import problems
from core.db.ids import new_uuid7
from services.identity.access_tokens import VerifiedAccessToken

IDENTITY_UNKNOWN = "https://kodera.io/problems/identity-unknown"
UNAUTHENTICATED = "https://kodera.io/problems/unauthenticated"
ORGANISATION = UUID("01900000-0000-7000-8000-0000000000a1")
ROW = UUID("01900000-0000-7000-8000-0000000000b2")
TRUSTED = "https://identity.customer.test/realms/known-realm"
UNTRUSTED = "https://identity.customer.test/realms/unknown-realm"
KEY = "identity-unknown-key-0001"
REQUEST_ID = "identity-unknown-request-0001"
CREDENTIAL = "synthetic-verified-credential"
PATCH = "application/merge-patch+json"
VERIFIED = VerifiedAccessToken(
    TRUSTED, "subject-core-never-bound", ("kodera-server",), 1, 9999999999, None, ("otp",), None, 1
)


@dataclass(frozen=True)
class Case:
    """One routed customer operation and where its service raises the unknown-principal error."""

    operation: str
    view: str
    method: str
    kwargs: dict[str, Any]
    raises: str
    at: tuple[str, ...]
    content_type: str = "application/json"
    body: bytes = b"{}"
    also: dict[str, Any] = field(default_factory=dict)
    # The module that verifies the token, when the view is built by another module's factory.
    verifier: str = ""

    @property
    def module(self) -> str:
        return self.verifier or self.view.rsplit(".", 1)[0]


ORG = {"organisation_id": ORGANISATION}
IDENTITY = "apps.identity.api.views"
DETAIL = "apps.orgs.api.detail"
DIRECTORY = "apps.orgs.api.memberships"
MEMBERSHIP = "apps.orgs.api.membership_detail"
NOTICE = "apps.orgs.api.notice_contacts"
BOOTSTRAP = "apps.orgs.api.bootstrap"
CONSUME = "apps.orgs.api.owner_claims"
INVITATIONS = "apps.orgs.api.invitations"
INVITATION_SERVICE = "apps.orgs.invitations"
WORKSPACE = "apps.workspaces.api.views"
STRUCTURE = "apps.workspaces.api.administration"
BILLING = "apps.billing.api.views"
LEGAL = "apps.legal.api.views"
STRUCTURE_SERVICES = (
    STRUCTURE + ".authorise",
    STRUCTURE + ".read_administration",
    STRUCTURE + ".read_access",
)

CASES = (
    Case(
        "getMe",
        IDENTITY + ".me",
        "get",
        {},
        "apps.identity.services.UnknownCustomerError",
        (IDENTITY + ".read_customer",),
    ),
    Case(
        "getOrganisation",
        DETAIL + ".organisation_detail",
        "get",
        ORG,
        "apps.orgs.detail_services.UnknownOrganisationCustomerError",
        (DETAIL + ".read_organisation",),
    ),
    Case(
        "getOrganisationBootstrap",
        BOOTSTRAP + ".organisation_bootstrap",
        "get",
        ORG,
        "apps.orgs.api.bootstrap_permissions.BootstrapUnknownIdentityError",
        (BOOTSTRAP + ".read_bootstrap",),
    ),
    Case(
        "listMemberships",
        DIRECTORY + ".membership_directory",
        "get",
        {"organisation_id": str(ORGANISATION)},
        "apps.orgs.membership_services.UnknownDirectoryCustomerError",
        (DIRECTORY + ".read_directory",),
    ),
    *(
        Case(
            operation,
            MEMBERSHIP + ".membership",
            method,
            {**ORG, "membership_id": ROW},
            "apps.orgs.membership_lifecycle.MembershipCallerUnknownError",
            (MEMBERSHIP + "." + service,),
            content_type=PATCH,
            also={MEMBERSHIP + ".parse_patch": lambda body: {}},
        )
        for operation, method, service in (
            ("getMembership", "get", "read_membership"),
            ("changeMembershipRole", "patch", "change_membership"),
            ("removeMembership", "delete", "remove_membership"),
        )
    ),
    *(
        Case(
            operation,
            NOTICE + ".notice_contacts",
            method,
            ORG,
            "apps.orgs.notice_contacts.NoticeCallerUnknownError",
            (NOTICE + "." + service,),
            content_type=PATCH,
            also={NOTICE + ".parse_patch": lambda body: {}},
        )
        for operation, method, service in (
            ("getNoticeContacts", "get", "read_notice_contacts"),
            ("patchNoticeContacts", "patch", "change_notice_contacts"),
        )
    ),
    Case(
        "consumeOwnerClaim",
        CONSUME + ".consume_owner_claim",
        "post",
        {},
        "apps.orgs.claim_consumption.ConsumerUnknownError",
        (CONSUME + ".consumption_operation",),
    ),
    *(
        Case(
            operation,
            INVITATIONS + "." + view,
            method,
            ids,
            INVITATION_SERVICE + ".InvitationCallerUnknownError",
            (INVITATION_SERVICE + ".authorise",),
            also={INVITATION_SERVICE + ".invitation_organisation": lambda **k: ORGANISATION},
        )
        for operation, view, method, ids in (
            ("listInvitations", "organisation_invitations", "get", ORG),
            ("inviteToOrganisation", "organisation_invitations", "post", ORG),
            ("resendInvitation", "resend_invitation", "post", {"invitation_id": ROW}),
            ("revokeInvitation", "invitation", "delete", {"invitation_id": ROW}),
        )
    ),
    Case(
        "getWorkspace",
        WORKSPACE + ".workspace",
        "get",
        ORG,
        "apps.workspaces.structure.WorkspaceCallerUnknownError",
        (WORKSPACE + ".read_workspace",),
    ),
    Case(
        "initialiseWorkspace",
        WORKSPACE + ".initialise",
        "post",
        ORG,
        "apps.workspaces.structure.WorkspaceCallerUnknownError",
        (WORKSPACE + ".authorise_initialise",),
        body=b"",
    ),
    Case(
        "createTenant",
        "apps.billing.api.create_tenant.create",
        "post",
        ORG,
        "apps.workspaces.structure.WorkspaceCallerUnknownError",
        ("apps.billing.api.create_tenant.authorise",),
    ),
    Case(
        "instantClaimWorkspace",
        "apps.workspaces.api.instant_claim.instant_claim",
        "post",
        {},
        "apps.workspaces.instant_claim.ClaimIdentityUnknownError",
        ("apps.workspaces.api.instant_claim.authorise_instant_claim",),
    ),
    *(
        Case(
            operation,
            STRUCTURE + "." + view,
            method,
            {**ORG, **ids},
            "apps.workspaces.structure.WorkspaceCallerUnknownError",
            STRUCTURE_SERVICES,
            content_type=PATCH if method == "patch" else "application/json",
        )
        for operation, view, method, ids in (
            ("getWorkspaceAdministration", "administration", "get", {}),
            ("createCategory", "categories", "post", {}),
            ("patchCategory", "category", "patch", {"category_id": ROW}),
            ("deleteCategory", "category", "delete", {"category_id": ROW}),
            ("createChannel", "channels", "post", {}),
            ("patchChannel", "channel", "patch", {"channel_id": ROW}),
            ("archiveChannel", "archive", "post", {"channel_id": ROW}),
            ("unarchiveChannel", "unarchive", "post", {"channel_id": ROW}),
            ("getChannelAccess", "access", "get", {"channel_id": ROW}),
            ("patchChannelAccess", "access", "patch", {"channel_id": ROW}),
        )
    ),
    *(
        Case(
            operation,
            BILLING + "." + view,
            method,
            ids,
            "apps.billing.callers.BillingCallerUnknownError",
            (BILLING + ".read_as_member",),
        )
        for operation, view, method, ids in (
            ("listOrders", "orders", "get", ORG),
            ("placeOrder", "orders", "post", ORG),
            ("getOrder", "order", "get", {"order_id": ROW}),
            ("cancelOrder", "cancel_order", "post", {"order_id": ROW}),
            ("listSubscriptions", "subscriptions", "get", ORG),
            ("getSubscription", "subscription", "get", {"subscription_id": ROW}),
            ("listInvoices", "invoices", "get", ORG),
            ("getInvoice", "invoice", "get", {"invoice_id": ROW}),
            ("listCreditNotes", "credit_notes", "get", ORG),
            ("getCreditNote", "credit_note", "get", {"credit_note_id": ROW}),
            ("getPaymentLink", "payment_link", "get", {"invoice_id": ROW}),
            ("createPaymentLink", "payment_link", "post", {"invoice_id": ROW}),
            ("getDunning", "dunning", "get", ORG),
        )
    ),
    *(
        Case(
            operation,
            "apps.billing.api.downloads." + view,
            "get",
            ids,
            "apps.billing.callers.BillingCallerUnknownError",
            ("apps.billing.api.downloads.read_as_member",),
        )
        for operation, view, ids in (
            ("getInvoiceDownloadLink", "invoice_download", {"invoice_id": ROW}),
            ("getCreditNoteDownloadLink", "credit_note_download", {"credit_note_id": ROW}),
        )
    ),
    Case(
        "getBillingVatStatus",
        "apps.billing.api.vat_status.billing_vat",
        "get",
        ORG,
        "apps.billing.callers.BillingCallerUnknownError",
        (BILLING + ".read_as_member",),
        verifier=BILLING,
    ),
    Case(
        "validateBillingVat",
        "apps.billing.api.vat_status.billing_vat",
        "post",
        ORG,
        "apps.billing.callers.BillingCallerUnknownError",
        ("apps.billing.api.vat_status.read_as_member",),
    ),
    *(
        Case(
            operation,
            "apps.billing.api.tenants." + view,
            method,
            ids,
            "apps.billing.callers.BillingCallerUnknownError",
            (BILLING + ".read_as_member",),
            verifier=BILLING,
        )
        for operation, view, method, ids in (
            ("listTenants", "tenants", "get", ORG),
            ("getTenant", "tenant", "get", {"tenant_id": ROW}),
            ("getTenantStatus", "tenant_status", "get", {"tenant_id": ROW}),
            ("getOrganisationStatusSummary", "status_summary", "get", ORG),
        )
    ),
    Case(
        "checkSlugAvailability",
        "apps.billing.api.slug_availability.slug_availability",
        "get",
        {},
        "apps.billing.callers.BillingCallerUnknownError",
        ("apps.billing.api.slug_availability.read_as_member",),
    ),
    Case(
        "countMemberships",
        "apps.billing.api.membership_count.membership_count",
        "get",
        ORG,
        "apps.billing.callers.BillingCallerUnknownError",
        ("apps.billing.api.membership_count.read_as_member",),
    ),
    Case(
        "getHelpContext",
        "apps.billing.api.help_context.help_context",
        "get",
        {},
        "apps.billing.callers.BillingCallerUnknownError",
        ("apps.billing.api.help_context.read_as_member",),
    ),
    Case(
        "generateDpa",
        LEGAL + ".dpa",
        "post",
        ORG,
        "apps.legal.services.CallerUnknownError",
        ("apps.legal.services.authorise",),
    ),
    Case(
        "getDpa",
        LEGAL + ".dpa_detail",
        "get",
        {**ORG, "dpa_id": ROW},
        "apps.legal.services.CallerUnknownError",
        ("apps.legal.services.read_dpa",),
    ),
    Case(
        "createCommunitySupportTicket",
        "apps.support.api.community.community_support_tickets",
        "post",
        {},
        "apps.support.tickets.TicketCallerUnknownError",
        ("apps.support.api.community.authorise_community_support",),
        verifier="apps.support.api.views",
    ),
    Case(
        "createSupportTicket",
        "apps.support.api.views.support_tickets",
        "post",
        {},
        "apps.support.tickets.TicketCallerUnknownError",
        ("apps.support.tickets.authorise",),
    ),
)


def _attribute(dotted: str) -> tuple[Any, str]:
    module, name = dotted.rsplit(".", 1)
    return importlib.import_module(module), name


def _resolve(dotted: str) -> Any:
    """A module by its dotted name, imported if need be, or an attribute of one."""
    try:
        return importlib.import_module(dotted)
    except ModuleNotFoundError:
        owner, name = _attribute(dotted)
        return getattr(owner, name)


def _call(case: Case, *, authorization: str | None, request_id: str = REQUEST_ID) -> HttpResponse:
    headers: dict[str, str] = {
        "HTTP_IDEMPOTENCY_KEY": KEY,
        "HTTP_IF_MATCH": '"synthetic"',
        "HTTP_X_REQUEST_ID": request_id,
    }
    if authorization is not None:
        headers["HTTP_AUTHORIZATION"] = authorization
    factory = RequestFactory()
    path = "/api/v1/synthetic-identity-unknown"
    if case.method in {"get", "delete"}:
        request = getattr(factory, case.method)(path, **headers)
    else:
        request = getattr(factory, case.method)(
            path, data=case.body, content_type=case.content_type, **headers
        )
    response: HttpResponse = _resolve(case.view)(request, **case.kwargs)
    return response


def _answer_unknown(
    case: Case,
    monkeypatch: pytest.MonkeyPatch,
    *,
    signed: str | None = None,
    request_id: str = REQUEST_ID,
) -> HttpResponse:
    """The view's answer when its service finds no identity for a token that verified.

    With `signed`, the token goes through the real verifier and the real lane guard; without it,
    the view's verifier is replaced by one that admits `VERIFIED` on the customer lane."""
    error = _resolve(case.raises)

    def unknown(*args: Any, **kwargs: Any) -> Any:
        raise error()

    @contextmanager
    def unknown_operation(**kwargs: Any) -> Any:
        raise error()
        yield  # pragma: no cover

    if signed is None:
        monkeypatch.setattr(
            _resolve(case.module),
            "verify_configured_token",
            lambda *a, **k: (VERIFIED, "customer"),
        )
    for dotted in case.at:
        owner, name = _attribute(dotted)
        monkeypatch.setattr(
            owner, name, unknown_operation if dotted.endswith("_operation") else unknown
        )
    for dotted, value in case.also.items():
        owner, name = _attribute(dotted)
        monkeypatch.setattr(owner, name, value)
    return _call(case, authorization="Bearer " + (signed or CREDENTIAL), request_id=request_id)


def identity_unknown_refusals(case: Case, response: HttpResponse) -> list[str]:
    """Why `response` is not the `403 identity-unknown` of AUTHZ.md §2 step 6; empty when it is."""
    where = f"{case.operation} ({case.method.upper()})"
    if response.status_code != 403:
        return [
            f"{where}: a verified token with no stored identity was answered "
            f"{response.status_code}, not 403 identity-unknown"
        ]
    found = []
    body = json.loads(response.content)
    if body.get("type") != IDENTITY_UNKNOWN:
        found.append(f"{where}: the 403 is {body.get('type')}, not identity-unknown")
    if body != {
        "type": IDENTITY_UNKNOWN,
        "title": problems.IDENTITY_UNKNOWN_TITLE,
        "status": 403,
        "request_id": response["X-Request-Id"],
    }:
        found.append(f"{where}: the identity-unknown body is not the four safe members")
    if "WWW-Authenticate" in response:
        found.append(f"{where}: identity-unknown carries a WWW-Authenticate challenge")
    if response.get("Cache-Control") != "no-store":
        found.append(f"{where}: identity-unknown is not no-store")
    if response.get("Content-Type", "").split(";")[0] != "application/problem+json":
        found.append(f"{where}: identity-unknown is not a problem document")
    return found


def test_every_customer_operation_that_resolves_a_principal_is_listed():
    from django.urls import get_resolver

    declared = set()
    for pattern in get_resolver("config.customer_urls").url_patterns:
        for operation in getattr(pattern.callback, "declared_operations", ()):
            declared.add(operation.operation_id)
    anonymous_or_other_lane = {
        "discoverRealm",
        "listPlans",
        "listPacks",
        "listCapacityTiers",
        "listPrices",
        "listLegalDocuments",
        "getLegalDocumentText",
        "createOrganisation",  # the staff intake: a customer token is 403 forbidden there
        "getCommands",
        "ackCommand",
        "reportCommandResult",
        # The `invited` principal: acceptance creates the identity, so neither it nor its preview
        # answers identity-unknown (docs/specs/INVITATIONS.md §3).
        "acceptInvitation",
        "previewInvitation",
    }
    listed = {case.operation for case in CASES}
    assert declared - anonymous_or_other_lane == listed, (
        "a routed customer operation is not driven here, or a driven one is no longer routed"
    )


def log_refusals(case: Case, records: list[Any], request_id: str = REQUEST_ID) -> list[str]:
    """Why the refusal's log is not the one WARNING line of AUTHZ.md §9; empty when it is."""
    where = f"{case.operation} ({case.method.upper()})"
    lines = [r for r in records if r.name == "core.api.problems"]
    shape = re.compile(
        r"identity-unknown correlation_id=(?P<id>[0-9a-f-]{36}) operation_id="
        + re.escape(case.operation)
        + r"\Z"
    )
    matched = shape.match(lines[0].getMessage()) if len(lines) == 1 else None
    if matched is None or lines[0].levelname != "WARNING":
        return [
            f"{where}: the refusal did not log exactly one WARNING "
            f"'identity-unknown correlation_id=<uuid7> operation_id={case.operation}'"
        ]
    if UUID(matched["id"]).version != 7 or matched["id"] == request_id:
        return [f"{where}: the refusal logged the caller's request id, not a server-generated one"]
    text = " ".join(str(r.__dict__) for r in records)
    leaked = [
        name
        for name, value in (
            ("issuer", VERIFIED.issuer),
            ("subject", VERIFIED.subject),
            ("token", CREDENTIAL),
            ("caller-supplied request id", request_id),
        )
        if value in text
    ]
    return [f"{where}: the refusal log carries the {name}" for name in leaked]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.operation)
def test_a_verified_token_with_no_stored_identity_is_403_identity_unknown(
    case, monkeypatch, caplog
):
    caplog.set_level("DEBUG")
    assert identity_unknown_refusals(case, _answer_unknown(case, monkeypatch)) == []
    assert log_refusals(case, caplog.records) == []


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.operation)
@pytest.mark.parametrize("credential", ["absent", "malformed", "unknown-realm", "untrusted-key"])
def test_a_verification_failure_is_still_401_with_a_bearer_challenge_and_no_query(
    case, credential, settings, http_signer, django_db_blocker
):
    from cryptography.hazmat.primitives.asymmetric import rsa

    configure(settings, [trust_entry(http_signer, TRUSTED)])
    stranger = (
        rsa.generate_private_key(public_exponent=65537, key_size=2048),
        "RS256",
        http_signer[2],
    )
    authorization = {
        "absent": None,
        "malformed": "Bearer not.a.token",
        "unknown-realm": "Bearer " + token(http_signer, UNTRUSTED),
        "untrusted-key": "Bearer " + token(stranger, TRUSTED),
    }[credential]
    with django_db_blocker.block():
        response = _call(case, authorization=authorization)
    assert response.status_code == 401, f"{case.operation}: {credential} was not 401"
    assert json.loads(response.content)["type"] == UNAUTHENTICATED
    assert response["WWW-Authenticate"] == "Bearer", f"{case.operation}: no Bearer challenge"
    assert response["Cache-Control"] == "no-store"


def test_a_staff_token_naming_no_stored_staff_identity_on_consume_is_still_401(monkeypatch):
    from apps.orgs import claim_consumption

    monkeypatch.setattr(claim_consumption, "current_staff_identity", lambda **kwargs: None)
    monkeypatch.setattr(
        claim_consumption,
        "record_authz_denied",
        lambda **kwargs: pytest.fail("an unknown staff token wrote an audit row"),
    )
    case = next(case for case in CASES if case.operation == "consumeOwnerClaim")
    monkeypatch.setattr(
        _resolve(case.module), "verify_configured_token", lambda *a, **k: (VERIFIED, "staff")
    )
    response = _call(case, authorization="Bearer synthetic-staff-credential")
    assert response.status_code == 401 and response["WWW-Authenticate"] == "Bearer"


def _legacy_401(request_id: str, operation_id: str) -> HttpResponse:
    """The mapping this change replaced: the unknown subject answered as a verification failure."""
    response = HttpResponse(
        json.dumps(
            {
                "type": UNAUTHENTICATED,
                "title": "Authentication required",
                "status": 401,
                "request_id": request_id,
            }
        ),
        status=401,
        content_type="application/problem+json",
    )
    response["WWW-Authenticate"] = "Bearer"
    return response


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.operation)
def test_mutation_mapping_the_unknown_subject_back_to_401_is_caught_by_name(case, monkeypatch):
    monkeypatch.setattr(problems, "identity_unknown", _legacy_401)
    found = identity_unknown_refusals(case, _answer_unknown(case, monkeypatch))
    assert found == [
        f"{case.operation} ({case.method.upper()}): a verified token with no stored identity was "
        "answered 401, not 403 identity-unknown"
    ], found


@pytest.mark.parametrize(
    "mutate,message",
    [
        (lambda r: r.__setitem__("WWW-Authenticate", "Bearer"), "carries a WWW-Authenticate"),
        (lambda r: setattr(r, "content", json.dumps({"type": "x"}).encode()), "is x, not"),
        (lambda r: r.__delitem__("Cache-Control"), "is not no-store"),
    ],
    ids=["challenge", "type", "cache"],
)
def test_mutation_each_property_of_the_answer_is_caught_by_name(monkeypatch, mutate, message):
    case = CASES[0]
    response = _answer_unknown(case, monkeypatch)
    assert identity_unknown_refusals(case, response) == [], "the control must pass first"
    mutate(response)
    found = identity_unknown_refusals(case, response)
    assert any(message in item for item in found), found


@pytest.mark.parametrize(
    "logged,message",
    [
        (lambda log, rid, op: None, "did not log exactly"),
        (
            lambda log, rid, op: log.info(
                "identity-unknown correlation_id=%s operation_id=%s", new_uuid7(), op
            ),
            "did not log exactly",
        ),
        (
            lambda log, rid, op: log.warning(
                "identity-unknown correlation_id=%s operation_id=%s",
                new_uuid7(),
                op,
                extra={"sub": VERIFIED.subject},
            ),
            "carries the subject",
        ),
        (
            lambda log, rid, op: log.warning(
                "identity-unknown correlation_id=%s operation_id=%s", rid, op
            ),
            "the caller's request id",
        ),
    ],
    ids=["silent", "below-warning", "subject", "caller-request-id"],
)
def test_mutation_each_property_of_the_log_line_is_caught_by_name(
    monkeypatch, caplog, logged, message
):
    import logging

    def mutated(request_id: str, operation_id: str) -> HttpResponse:
        logged(logging.getLogger("core.api.problems"), request_id, operation_id)
        return problems.answer(request_id)

    monkeypatch.setattr(problems, "identity_unknown", mutated)
    caplog.set_level("DEBUG")
    case = CASES[0]
    # A caller-supplied id shaped like a server one, so only its origin tells them apart.
    caller_id = str(new_uuid7())
    response = _answer_unknown(case, monkeypatch, request_id=caller_id)
    assert identity_unknown_refusals(case, response) == []
    found = log_refusals(case, caplog.records, request_id=caller_id)
    assert any(message in item for item in found), found


def _staff_bootstrap(monkeypatch, settings, http_signer, django_db_blocker, *, lane, subject):
    """The real bootstrap view on a signed token, its transaction stubbed and the database blocked:
    a staff token is refused before any query."""
    from contextlib import nullcontext
    from types import SimpleNamespace

    from apps.orgs import bootstrap_services

    class Connection:
        in_atomic_block = False

        def cursor(self) -> Any:
            return nullcontext(SimpleNamespace(execute=lambda *args, **kwargs: None))

    connection = Connection()

    @contextmanager
    def atomic() -> Any:
        connection.in_atomic_block = True
        try:
            yield
        finally:
            connection.in_atomic_block = False

    monkeypatch.setattr(bootstrap_services, "connection", connection)
    monkeypatch.setattr(bootstrap_services, "transaction", SimpleNamespace(atomic=atomic))
    staff_issuer = settings.KODERA_STAFF_ISSUER
    configure(settings, [trust_entry(http_signer, staff_issuer, lane=lane)])
    signed = token(http_signer, staff_issuer, subject, amr=["otp"])
    case = next(case for case in CASES if case.operation == "getOrganisationBootstrap")
    with django_db_blocker.block():
        return _call(case, authorization="Bearer " + signed)


def test_a_signed_staff_token_with_an_unstorable_subject_keeps_its_401(
    monkeypatch, settings, http_signer, django_db_blocker
):
    response = _staff_bootstrap(
        monkeypatch, settings, http_signer, django_db_blocker, lane="staff", subject="s" * 256
    )
    assert response.status_code == 401, "a staff subject was answered as a customer identity"
    assert json.loads(response.content)["type"] == UNAUTHENTICATED
    assert response["WWW-Authenticate"] == "Bearer"


def test_the_staff_issuer_on_the_customer_lane_keeps_its_401(
    monkeypatch, settings, http_signer, django_db_blocker
):
    response = _staff_bootstrap(
        monkeypatch,
        settings,
        http_signer,
        django_db_blocker,
        lane="customer",
        subject="synthetic-staff-subject",
    )
    assert response.status_code == 401, "the staff issuer was answered as a customer identity"
    assert json.loads(response.content)["type"] == UNAUTHENTICATED
    assert response["WWW-Authenticate"] == "Bearer"


def test_a_caller_supplied_request_id_never_reaches_the_log(monkeypatch, caplog):
    """The subject sent as `X-Request-Id`, a value the response echoes, is in no log record."""
    caplog.set_level("DEBUG")
    case = CASES[0]
    response = _answer_unknown(case, monkeypatch, request_id=VERIFIED.subject)
    assert json.loads(response.content)["request_id"] == VERIFIED.subject, "the control echoes it"
    assert not any(VERIFIED.subject in str(record.__dict__) for record in caplog.records)
    assert log_refusals(case, caplog.records, request_id=VERIFIED.subject) == []


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.operation)
def test_the_staff_issuer_on_the_customer_lane_is_refused_before_customer_resolution(
    case, monkeypatch, settings, http_signer, django_db_blocker, caplog
):
    """A misconfigured trust that puts the staff issuer on the customer lane: a signed staff token
    (here with an unstorable 256-character subject) is refused `401` by the one lane guard before
    the view resolves any customer identity, never `403 identity-unknown`."""
    caplog.set_level("DEBUG")
    staff_issuer = settings.KODERA_STAFF_ISSUER
    configure(settings, [trust_entry(http_signer, staff_issuer, lane="customer")])
    signed = token(http_signer, staff_issuer, "s" * 256, amr=["otp"])
    with django_db_blocker.block():
        response = _answer_unknown(case, monkeypatch, signed=signed)
    assert response.status_code == 401, (
        f"{case.operation}: the staff issuer on the customer lane was answered "
        f"{response.status_code}, not 401"
    )
    assert json.loads(response.content)["type"] == UNAUTHENTICATED
    assert response["WWW-Authenticate"] == "Bearer"
    assert not [r for r in caplog.records if r.name == "core.api.problems"]


def test_the_shared_answer_is_the_registered_type_without_a_challenge(caplog):
    caplog.set_level("DEBUG")
    response = problems.identity_unknown("request-id-0001", "getMe")
    [record] = caplog.records
    assert (record.name, record.levelname) == ("core.api.problems", "WARNING")
    logged = re.fullmatch(
        r"identity-unknown correlation_id=([0-9a-f-]{36}) operation_id=getMe", record.getMessage()
    )
    assert logged is not None and UUID(logged[1]).version == 7
    assert "request-id-0001" not in record.getMessage()
    assert response.status_code == 403 and "WWW-Authenticate" not in response
    assert json.loads(response.content) == {
        "type": IDENTITY_UNKNOWN,
        "title": "Identity unknown",
        "status": 403,
        "request_id": "request-id-0001",
    }
