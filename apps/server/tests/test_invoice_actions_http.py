"""createPaymentLink and getInvoiceDownloadLink over HTTP: real signed tokens, the real views, the
disposable PostgreSQL, and the fake payment provider the test profile configures.

The console's Invoices screens call both: "Payer en ligne" reads the active link and, when there is
none, `POST`s one; "Télécharger" asks for the PDF's link when `pdf_available` is true. Every
response a test receives is checked against contracts/core-api.openapi.yaml by `call`, problem
documents included. The world is the workspace scenarios' (`w`); `placed` is an order placed
through the service, with its issued invoice.

The last tests are the mutation proofs: with a route taken out of the customer urlconf, and with
the step handed no issued link, the checks the other tests rely on fail by name. That the provider
is asked outside the step's transaction is held by its own test, which watches the call.
"""

import json
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.db import connection
from django.urls import clear_url_caches
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_billing_http import placed as placed
from test_workspace_onboarding import call, conformance_errors, w as w

from apps.billing.models import Invoice, Order, Payment, PaymentLink
from apps.billing.payments import configured_provider, services as payments
from apps.billing.payments.port import ProviderRefusedError, ReturnUrlRequiredError

pytestmark = pytest.mark.django_db(transaction=True)

LINK = "/invoices/{invoice_id}/payment-link"
DOWNLOAD = "/invoices/{invoice_id}/download"
PROBLEMS = "https://kodera.io/problems/"
KEY = "link-key-0000000001"
RETURN = "https://app.localhost/alpha/invoices/back"


@pytest.fixture
def fake():
    # The configured fake is one object per process: start every test with empty records.
    provider = configured_provider()
    provider.links.clear()
    provider.cancelled.clear()
    return provider


def post(w, who, invoice_id, body=None, key=KEY, raw=None, content_type="application/json"):
    headers = {} if who is None else {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    if key is not None:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    data = raw if raw is not None else ("" if body is None else json.dumps(body))
    return w.client.post(
        f"/api/v1/invoices/{invoice_id}/payment-link",
        data=data,
        content_type=content_type,
        **headers,
    )


def download(w, who, invoice_id):
    headers = {} if who is None else {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    return w.client.get(f"/api/v1/invoices/{invoice_id}/download", **headers)


def created_errors(response):
    """Why the response is not a contract-conforming `201` link; empty when it is."""
    errors = conformance_errors(response, LINK, "post")
    if response.status_code != 201:
        errors.insert(0, f"createPaymentLink answered {response.status_code}, not 201")
    return errors


def created(response):
    assert created_errors(response) == []
    assert response.headers["Cache-Control"] == "no-store"
    return json.loads(response.content)


def problem(response, template, method, status, kind):
    call(response, template, method)
    assert response.status_code == status, response.content
    assert json.loads(response.content)["type"] == PROBLEMS + kind
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Request-Id"]
    return json.loads(response.content)


def denials():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT actor_type, organisation_id, target_urn, metadata->>'required_scope'"
            " FROM audit_auditevent WHERE action = 'authz.denied' ORDER BY occurred_at, id"
        )
        return cursor.fetchall()


def links(placed):
    return sorted(
        PaymentLink.objects.filter(invoice_id=placed.invoice.id).values_list("state", flat=True)
    )


# --- createPaymentLink ---------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["owner", "billing"])
def test_an_owner_or_billing_member_gets_the_invoice_s_link(w, placed, fake, role):
    found = created(
        post(w, getattr(w, role), placed.invoice.id, {"return_url": RETURN, "locale": "en"})
    )
    link = PaymentLink.objects.get(invoice_id=placed.invoice.id)
    assert (found["id"], found["invoice_id"], found["state"]) == (
        str(link.id),
        str(placed.invoice.id),
        "active",
    )
    assert found["url"].startswith("https://pay.fake.invalid/") and "provider" not in found
    assert found["amount"] == {"amount_minor": 360_000, "currency": "EUR"}
    (asked,) = fake.links
    assert (asked.return_url, asked.locale, asked.amount_minor) == (RETURN, "en", 360_000)
    assert Order.objects.get(id=placed.order.id).state == "awaiting_payment"
    # The link the route created is the one getPaymentLink reads.
    read = call(
        w.client.get(
            f"/api/v1/invoices/{placed.invoice.id}/payment-link",
            HTTP_AUTHORIZATION="Bearer " + w.owner.credential,
        ),
        LINK,
        "get",
    )
    assert json.loads(read.content)["id"] == found["id"]


def test_no_body_is_a_french_link_with_no_return_url(w, placed, fake):
    created(post(w, w.owner, placed.invoice.id))
    (asked,) = fake.links
    assert (asked.return_url, asked.locale) == (None, "fr")


def test_the_same_key_replays_the_answer_and_asks_the_provider_once(w, placed, fake):
    first = post(w, w.owner, placed.invoice.id, {"return_url": RETURN})
    again = post(w, w.owner, placed.invoice.id, {"return_url": RETURN})
    assert created(again) == created(first)
    assert again.headers["Idempotency-Replayed"] == "true"
    assert len(fake.links) == 1 and fake.cancelled == [] and links(placed) == ["active"]


def test_a_second_press_with_a_new_key_returns_the_active_link_unchanged(w, placed, fake):
    first = created(post(w, w.owner, placed.invoice.id))
    second = created(post(w, w.billing, placed.invoice.id, key="link-key-0000000002"))
    assert second == first
    assert len(fake.links) == 1 and links(placed) == ["active"]


def test_the_same_key_with_another_body_is_refused_and_asks_nothing(w, placed, fake):
    created(post(w, w.owner, placed.invoice.id, {"locale": "fr"}))
    problem(
        post(w, w.owner, placed.invoice.id, {"locale": "en"}),
        LINK,
        "post",
        409,
        "idempotency-key-reuse",
    )
    assert len(fake.links) == 1


def test_an_invoice_that_is_not_owed_has_no_link(w, placed, fake):
    Invoice.objects.filter(id=placed.invoice.id).update(
        amount_paid_minor=placed.invoice.total_incl_vat_minor
    )
    found = problem(
        post(w, w.owner, placed.invoice.id), LINK, "post", 409, "invalid-state-transition"
    )
    assert found["allowed_states"] == ["issued", "overdue"]
    assert fake.links == [] and links(placed) == []


def test_a_debit_still_settling_gets_no_second_link(w, placed, fake):
    Payment.objects.create(
        organisation_id=w.alpha.id,
        invoice_id=placed.invoice.id,
        provider="fake",
        provider_ref="fake_payment_settling",
        state="processing",
        amount_minor=placed.invoice.total_incl_vat_minor,
        currency="EUR",
        last_event_at=timezone.now(),
    )
    found = problem(post(w, w.owner, placed.invoice.id), LINK, "post", 409, "conflict")
    assert "reason" not in found and fake.links == []


def test_an_invoice_paid_while_the_provider_answers_keeps_no_link(w, placed, fake, monkeypatch):
    real = fake.create_link

    def paid_meanwhile(request):
        issued = real(request)
        Invoice.objects.filter(id=placed.invoice.id).update(
            amount_paid_minor=placed.invoice.total_incl_vat_minor
        )
        return issued

    monkeypatch.setattr(fake, "create_link", paid_meanwhile)
    problem(post(w, w.owner, placed.invoice.id), LINK, "post", 409, "invalid-state-transition")
    # The provider's link is recorded cancelled, and withdrawn at the provider.
    (row,) = PaymentLink.objects.filter(invoice_id=placed.invoice.id)
    assert row.state == "cancelled" and fake.cancelled == [row.provider_ref]


def test_a_request_the_store_answers_from_its_record_never_reaches_the_provider(w, placed, fake):
    first = post(w, w.owner, placed.invoice.id)
    created(first)
    PaymentLink.objects.filter(invoice_id=placed.invoice.id).update(state="expired")
    # The link is gone, but the key's answer is held: a replay is that answer, byte for byte, and
    # another body under the key is a reuse. Neither asks the provider for a link.
    replay = post(w, w.owner, placed.invoice.id)
    assert replay.status_code == 201 and replay.content == first.content
    problem(
        post(w, w.owner, placed.invoice.id, {"locale": "en"}),
        LINK,
        "post",
        409,
        "idempotency-key-reuse",
    )
    assert len(fake.links) == 1 and fake.cancelled == []


def test_the_provider_is_asked_outside_any_transaction(w, placed, fake, monkeypatch):
    """IDEMPOTENCY_REPLAY.md §3: the replay store's step never calls the outside world. A
    provider call moved into the step would run inside its transaction and fail here."""
    real = fake.create_link
    seen = []

    def watched(request):
        seen.append(connection.in_atomic_block)
        return real(request)

    monkeypatch.setattr(fake, "create_link", watched)
    created(post(w, w.owner, placed.invoice.id))
    assert seen == [False]


def test_an_amount_that_moves_while_the_provider_answers_is_a_conflict(
    w, placed, fake, monkeypatch
):
    real = fake.create_link

    def part_paid_meanwhile(request):
        issued = real(request)
        Invoice.objects.filter(id=placed.invoice.id).update(amount_paid_minor=100)
        return issued

    monkeypatch.setattr(fake, "create_link", part_paid_meanwhile)
    found = problem(post(w, w.owner, placed.invoice.id), LINK, "post", 409, "conflict")
    assert "changed while the link was being created" in found["detail"]
    # The link issued for the old amount is recorded cancelled and withdrawn at the provider.
    (row,) = PaymentLink.objects.filter(invoice_id=placed.invoice.id)
    assert row.state == "cancelled" and fake.cancelled == [row.provider_ref]
    # The next press, with its own key, gets a link for the new amount.
    monkeypatch.undo()
    fresh = created(post(w, w.owner, placed.invoice.id, key="link-key-0000000002"))
    assert fresh["amount"]["amount_minor"] == 360_000 - 100


def test_a_return_url_off_the_console_is_refused_before_the_provider(w, placed, fake):
    found = problem(
        post(w, w.owner, placed.invoice.id, {"return_url": "https://evil.example/back"}),
        LINK,
        "post",
        400,
        "malformed-request",
    )
    assert found["errors"] == [{"pointer": "/return_url", "code": "origin"}]
    assert fake.links == []


@pytest.mark.parametrize(
    "raw,content_type",
    [
        ("{", "application/json"),
        ("[]", "application/json"),
        ('{"colour": "red"}', "application/json"),
        ('{"locale": "de"}', "application/json"),
        ('{"return_url": 7}', "application/json"),
        ('{"return_url": ""}', "application/json"),
        ('{"locale": "fr"}', "text/plain"),
    ],
)
def test_a_body_that_is_not_a_link_request_is_malformed(w, placed, fake, raw, content_type):
    problem(
        post(w, w.owner, placed.invoice.id, raw=raw, content_type=content_type),
        LINK,
        "post",
        400,
        "malformed-request",
    )
    assert fake.links == []


@pytest.mark.parametrize(
    "key,kind", [(None, "idempotency-key-missing"), ("short", "malformed-request")]
)
def test_a_missing_or_malformed_key_never_reaches_the_provider(w, placed, fake, key, kind):
    problem(post(w, w.owner, placed.invoice.id, key=key), LINK, "post", 400, kind)
    assert fake.links == []


def test_without_a_provider_the_answer_is_upstream_unavailable(w, placed, fake, settings):
    settings.KODERA_PAYMENT_PROVIDER = None
    found = problem(post(w, w.owner, placed.invoice.id), LINK, "post", 502, "upstream-unavailable")
    response = post(w, w.owner, placed.invoice.id)
    assert response.headers["Retry-After"] == str(found["retry_after_s"])
    assert links(placed) == []
    # Nothing was stored for the key: once a provider is configured, the same key creates the link.
    settings.KODERA_PAYMENT_PROVIDER = "fake"
    created(post(w, w.owner, placed.invoice.id))


def test_a_member_demoted_while_the_provider_answers_is_refused_and_the_link_withdrawn(
    w, placed, fake, monkeypatch
):
    real = fake.create_link

    def demoted_meanwhile(request):
        issued = real(request)
        w.models.Membership.objects.filter(pk=w.billing.member.pk).update(role="org_member")
        return issued

    monkeypatch.setattr(fake, "create_link", demoted_meanwhile)
    problem(post(w, w.billing, placed.invoice.id), LINK, "post", 403, "forbidden")
    target = f"urn:kodera:invoice:{placed.invoice.id}"
    assert denials() == [("tenant", w.alpha.id, target, "payment:create")]
    # Nothing recorded, and the link the provider issued is withdrawn there.
    assert links(placed) == [] and len(fake.links) == 1
    (withdrawn,) = fake.cancelled
    assert withdrawn.startswith("fake_link_")
    assert Order.objects.get(id=placed.order.id).state == "placed"


def test_a_provider_that_needs_a_return_url_is_answered_with_its_pointer(
    w, placed, fake, monkeypatch
):
    def needs_one(request):
        raise ReturnUrlRequiredError("a return URL is needed")

    monkeypatch.setattr(fake, "create_link", needs_one)
    found = problem(post(w, w.owner, placed.invoice.id), LINK, "post", 400, "malformed-request")
    assert found["errors"] == [{"pointer": "/return_url", "code": "required"}]
    assert links(placed) == []


def test_a_provider_refusal_is_upstream_unavailable_and_logs_no_message(
    w, placed, fake, monkeypatch, caplog
):
    def refuses(request):
        raise ProviderRefusedError("provider-said-something-private")

    monkeypatch.setattr(fake, "create_link", refuses)
    problem(post(w, w.owner, placed.invoice.id), LINK, "post", 502, "upstream-unavailable")
    assert links(placed) == []
    logged = " ".join(record.getMessage() for record in caplog.records)
    assert "ProviderRefusedError" in logged and "provider-said-something-private" not in logged
    # Nothing was stored for the key: the same key creates the link once the provider answers.
    monkeypatch.undo()
    created(post(w, w.owner, placed.invoice.id))


@pytest.mark.parametrize("role", ["admin", "member"])
def test_a_member_who_cannot_pay_is_refused_and_the_refusal_recorded(w, placed, fake, role):
    problem(post(w, getattr(w, role), placed.invoice.id), LINK, "post", 403, "forbidden")
    target = f"urn:kodera:invoice:{placed.invoice.id}"
    assert denials() == [("tenant", w.alpha.id, target, "payment:create")]
    assert fake.links == []


def test_a_staff_token_is_refused(w, placed, fake):
    problem(post(w, w.staff, placed.invoice.id), LINK, "post", 403, "forbidden")
    target = f"urn:kodera:invoice:{placed.invoice.id}"
    assert denials() == [("staff", None, target, "payment:create")]


def test_another_organisation_s_invoice_reads_as_absent(w, placed, fake):
    answers = [
        post(w, w.foreigner, placed.invoice.id),
        post(w, w.stranger, placed.invoice.id),
        post(w, w.owner, uuid4()),
    ]
    for response in answers:
        problem(response, LINK, "post", 404, "not-found")
    assert fake.links == [] and denials() == []


def test_without_a_token_nothing_is_said(w, placed, fake):
    problem(post(w, None, placed.invoice.id), LINK, "post", 401, "unauthenticated")
    problem(post(w, None, uuid4()), LINK, "post", 401, "unauthenticated")


# --- getInvoiceDownloadLink ----------------------------------------------------------------------


@pytest.mark.parametrize("role", ["owner", "admin", "billing"])
def test_an_invoice_with_no_rendered_pdf_answers_conflict(w, placed, role):
    found = problem(
        download(w, getattr(w, role), placed.invoice.id), DOWNLOAD, "get", 409, "conflict"
    )
    assert "reason" not in found and found["detail"]


def test_the_invoice_says_no_pdf_is_available_to_download(w, placed):
    read = w.client.get(
        f"/api/v1/invoices/{placed.invoice.id}", HTTP_AUTHORIZATION="Bearer " + w.owner.credential
    )
    assert json.loads(read.content)["pdf_available"] is False


def test_a_member_cannot_ask_for_the_pdf(w, placed):
    problem(download(w, w.member, placed.invoice.id), DOWNLOAD, "get", 403, "forbidden")
    target = f"urn:kodera:invoice:{placed.invoice.id}"
    assert denials() == [("tenant", w.alpha.id, target, "invoice:read")]


def test_another_organisation_s_invoice_pdf_reads_as_absent(w, placed):
    for response in (
        download(w, w.foreigner, placed.invoice.id),
        download(w, w.owner, uuid4()),
    ):
        problem(response, DOWNLOAD, "get", 404, "not-found")
    problem(download(w, None, placed.invoice.id), DOWNLOAD, "get", 401, "unauthenticated")


def test_a_stored_pdf_with_no_signer_fails_loudly_never_as_a_link(w, placed):
    # `pdf_ref` is one of the columns an issued invoice may still change (its render).
    Invoice.objects.filter(id=placed.invoice.id).update(pdf_ref="invoices/synthetic.pdf")
    problem(download(w, w.owner, placed.invoice.id), DOWNLOAD, "get", 500, "internal-error")


# --- the mutation proofs -------------------------------------------------------------------------


def _without(monkeypatch, needle):
    from config import customer_urls

    kept = [p for p in customer_urls.urlpatterns if not str(p.pattern).endswith(needle)]
    assert len(kept) == len(customer_urls.urlpatterns) - 1, f"{needle} is not routed once"
    monkeypatch.setattr(customer_urls, "urlpatterns", kept)
    clear_url_caches()


@pytest.fixture
def restore_urls():
    yield
    clear_url_caches()


def test_mutation_control_the_checks_pass_with_the_routes(w, placed, fake):
    """The control: in the same world the create check passes and the download answers its 409,
    so the mutated runs below fail because of the mutation, not because of the world."""
    assert created_errors(post(w, w.owner, placed.invoice.id)) == []
    assert download(w, w.owner, placed.invoice.id).status_code == 409


def test_mutation_without_the_download_route_the_conflict_is_a_404(
    w, placed, monkeypatch, restore_urls
):
    _without(monkeypatch, "invoices/<uuid:invoice_id>/download")
    assert download(w, w.owner, placed.invoice.id).status_code == 404


def test_mutation_a_get_only_payment_link_route_refuses_the_create(
    w, placed, fake, monkeypatch, restore_urls
):
    from django.urls import path

    from apps.billing.api import views
    from config import customer_urls

    _without(monkeypatch, "/payment-link")
    monkeypatch.setattr(
        customer_urls,
        "urlpatterns",
        [
            *customer_urls.urlpatterns,
            path("api/v1/invoices/<uuid:invoice_id>/payment-link", views._get_payment_link),
        ],
    )
    clear_url_caches()
    found = created_errors(post(w, w.owner, placed.invoice.id))
    assert found and found[0] == "createPaymentLink answered 405, not 201", found


def test_mutation_a_step_handed_no_issued_link_fails_the_create(w, placed, fake, monkeypatch):
    """The step only records what the view obtained; it never asks the provider itself. With the
    view's provider call removed, the step has no link to record, which is transient (nothing is
    stored), and the create check fails by name."""
    monkeypatch.setattr(payments, "issue_link", lambda **_: None)
    found = created_errors(post(w, w.owner, placed.invoice.id))
    assert found and found[0] == "createPaymentLink answered 500, not 201", found
    assert fake.links == [] and links(placed) == []
