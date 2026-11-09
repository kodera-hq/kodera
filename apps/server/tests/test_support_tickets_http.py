"""createSupportTicket over HTTP: real signed tokens, the real view, the disposable PostgreSQL.

`POST /support/tickets` stores a ticket about the caller's own organisation and owes a mail to the
support mailbox (docs/specs/SUPPORT_TICKETS.md). Every tenant role may open one; staff and a
person with no membership are refused and recorded. The tenant context is Core's, never the
body's. Five tickets per identity and twenty per organisation per rolling hour; past either,
`429` with `Retry-After` and nothing stored. Without a support mailbox, `503` and nothing stored.
Every response is checked against contracts/core-api.openapi.yaml by `call`. The world is the
workspace scenarios' (`w`): alpha holds one active owner, admin, billing user and member.

The last tests are the mutation proofs: without the route, and without each limit, the checks the
other tests rely on fail by name.
"""

import json
from datetime import timedelta

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.db import connection
from django.urls import clear_url_caches
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_workspace_onboarding import call, conformance_errors, person, w as w

from apps.tenancy.models import Tenant

pytestmark = pytest.mark.django_db(transaction=True)

TICKETS = "/support/tickets"
PROBLEMS = "https://kodera.io/problems/"
MAILBOX = "support@kodera.io"
BODY = {
    "subject": "Les participants tombent de l'appel",
    "body": "Depuis ce matin,\r\nplusieurs personnes sont déconnectées.\n\tSalle Direction.",
    "category": "calls",
    "severity": "degraded",
    "locale": "fr",
}


@pytest.fixture(autouse=True)
def mailbox(settings):
    settings.KODERA_SUPPORT_MAILBOX = MAILBOX


def keys():
    for n in range(1, 10_000):
        yield f"support-{n:04d}-0123456789abcdef"


KEY = iter(keys())


def post(w, who, body=None, *, key=None, raw=None, content_type="application/json"):
    headers = {} if who is None else {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    headers["HTTP_IDEMPOTENCY_KEY"] = key or next(KEY)
    data = raw if raw is not None else json.dumps(BODY if body is None else body)
    return w.client.post("/api/v1/support/tickets", data=data, content_type=content_type, **headers)


def created_errors(response):
    """Why the response is not a contract-conforming `201` ticket; empty when it is."""
    errors = conformance_errors(response, TICKETS, "post")
    if response.status_code != 201:
        errors.insert(0, f"createSupportTicket answered {response.status_code}, not 201")
    return errors


def opened(w, who, body=None, **kwargs):
    response = post(w, who, body, **kwargs)
    assert created_errors(response) == [], response.content[:300]
    assert response.headers["Cache-Control"] == "no-store"
    ticket = json.loads(response.content)
    assert response.headers["Location"] == f"/api/v1/support/tickets/{ticket['id']}"
    return ticket


def problem(response, status, kind):
    call(response, TICKETS, "post")
    assert response.status_code == status, response.content
    assert json.loads(response.content)["type"] == PROBLEMS + kind
    assert response.headers["Cache-Control"] == "no-store"
    return json.loads(response.content)


def rows():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT organisation_id, subject, body, category, severity, state, locale,"
            " reply_to_email, contact_email, tenant_id, tenant_slug, tenant_status, pack_code,"
            " mail_enqueued_at FROM support_supportticket ORDER BY created_at, id"
        )
        return cursor.fetchall()


def denials():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT actor_type, organisation_id, target_urn, metadata->>'required_scope'"
            " FROM audit_auditevent WHERE action = 'authz.denied' ORDER BY occurred_at, id"
        )
        return cursor.fetchall()


def opened_events():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT actor_type, organisation_id, target_urn, metadata"
            " FROM audit_auditevent WHERE action = 'support.ticket_opened' ORDER BY occurred_at, id"
        )
        return cursor.fetchall()


def tenant(organisation, slug, *, status="active", pack="visio-pro"):
    return Tenant.objects.create(
        organisation=organisation,
        slug=slug,
        name=slug.title(),
        status=status,
        status_changed_at=timezone.now(),
        pack_code=pack,
        capacity_tier_code="s",
        apps=["visio"],
    )


# --- who may open one -----------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["owner", "admin", "billing", "member"])
def test_every_tenant_role_opens_a_ticket_about_its_organisation(w, role):
    who = getattr(w, role)
    ticket = opened(w, who)
    assert ticket["organisation_id"] == str(w.alpha.id)
    assert (ticket["subject"], ticket["category"], ticket["severity"], ticket["state"]) == (
        BODY["subject"],
        "calls",
        "degraded",
        "open",
    )
    assert ticket["external_ref"] is None and "sla" not in ticket
    assert (ticket["message_count"], ticket["last_message_at"]) == (1, ticket["created_at"])
    assert ticket["created_by"] == str(who.identity.id)
    (row,) = rows()
    assert row[0] == w.alpha.id and row[5:8] == ("open", "fr", who.user.email)
    # Line breaks are normalised to LF; a tab is kept.
    assert row[2] == "Depuis ce matin,\nplusieurs personnes sont déconnectées.\n\tSalle Direction."
    assert row[13] is None, "the mail is owed, not enqueued, by the API"


def test_opening_a_ticket_is_audited_without_its_text(w):
    ticket = opened(w, w.member)
    ((actor, organisation, target, metadata),) = opened_events()
    metadata = metadata if isinstance(metadata, dict) else json.loads(metadata)
    assert (actor, organisation, target) == (
        "tenant",
        w.alpha.id,
        f"urn:kodera:support_ticket:{ticket['id']}",
    )
    assert metadata == {"category": "calls", "severity": "degraded"}


def test_defaults_are_a_question_in_french(w):
    body = {"subject": "Une question", "body": "Comment ajouter un membre ?", "category": "other"}
    ticket = opened(w, w.owner, body)
    assert ticket["severity"] == "question"
    assert rows()[0][6] == "fr"


def test_a_staff_token_is_refused_until_its_lane_exists(w):
    problem(post(w, w.staff), 403, "forbidden")
    assert denials() == [("staff", None, "urn:kodera:support_ticket:new", "support_ticket:create")]
    assert rows() == []


def test_a_known_person_with_no_membership_is_refused_and_recorded(w):
    problem(post(w, w.stranger), 403, "forbidden")
    assert denials() == [
        ("tenant", w.alpha.id, "urn:kodera:support_ticket:new", "support_ticket:create")
    ]
    assert rows() == []


def test_a_body_naming_another_organisation_is_refused_and_recorded(w):
    problem(post(w, w.owner, {**BODY, "organisation_id": str(w.bravo.id)}), 403, "forbidden")
    assert denials() == [
        ("tenant", w.alpha.id, f"urn:kodera:organisation:{w.bravo.id}", "support_ticket:create")
    ]
    assert rows() == []


def test_a_body_naming_its_own_organisation_is_accepted(w):
    assert opened(w, w.owner, {**BODY, "organisation_id": str(w.alpha.id)})["organisation_id"] == (
        str(w.alpha.id)
    )


def test_without_a_token_nothing_is_said_or_stored(w):
    problem(post(w, None), 401, "unauthenticated")
    assert rows() == []


# --- the tenant context ---------------------------------------------------------------------------


def test_the_tenant_context_is_the_organisation_s_newest_tenant(w):
    tenant(w.alpha, "alpha-old", status="deleted")
    tenant(w.alpha, "alpha-visio")
    ticket = opened(w, w.owner)
    assert ticket["tenant_context"] == {
        "tenant_slug": "alpha-visio",
        "tenant_status": "active",
        "pack_code": "visio-pro",
        "capacity_tier_code": "s",
        "agent_stale": None,
        "open_incident_component_keys": [],
        "last_job_id": None,
    }


def test_a_named_tenant_of_the_organisation_is_the_context(w):
    named = tenant(w.alpha, "alpha-first", status="suspended", pack="visio-basic")
    tenant(w.alpha, "alpha-second")
    ticket = opened(w, w.owner, {**BODY, "tenant_id": str(named.id)})
    assert ticket["tenant_id"] == str(named.id)
    assert ticket["tenant_context"]["tenant_slug"] == "alpha-first"
    assert ticket["tenant_context"]["tenant_status"] == "suspended"


def test_without_a_tenant_the_context_is_empty(w):
    context = opened(w, w.owner)["tenant_context"]
    assert (context["tenant_slug"], context["tenant_status"], context["pack_code"]) == (
        None,
        None,
        None,
    )


@pytest.mark.parametrize("which", ["foreign", "deleted", "absent"])
def test_a_tenant_not_of_the_organisation_is_malformed(w, which):
    tenant_id = {
        "foreign": lambda: tenant(w.bravo, "bravo-visio").id,
        "deleted": lambda: tenant(w.alpha, "alpha-gone", status="deleted").id,
        "absent": lambda: "00000000-0000-7000-8000-000000000000",
    }[which]()
    body = problem(
        post(w, w.owner, {**BODY, "tenant_id": str(tenant_id)}), 400, "malformed-request"
    )
    assert body["errors"] == [{"pointer": "/tenant_id", "code": "unknown"}]
    assert rows() == []


def test_the_contact_email_is_kept_as_given_and_never_the_reply_address(w):
    opened(w, w.member, {**BODY, "contact_email": "someone@elsewhere.test"})
    (row,) = rows()
    assert (row[7], row[8]) == (w.member.user.email, "someone@elsewhere.test")


# --- the request ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("change", "pointer"),
    [
        ({"subject": "ab"}, "/subject"),
        ({"subject": "x" * 201}, "/subject"),
        ({"subject": "line\nbreak"}, "/subject"),
        ({"subject": "carriage\rreturn"}, "/subject"),
        ({"subject": 42}, "/subject"),
        ({"body": "too short"}, "/body"),
        ({"body": "x" * 20_001}, "/body"),
        ({"body": "a bell \x07 in the text"}, "/body"),
        ({"body": "a null \x00 in the text"}, "/body"),
        ({"category": "printer"}, "/category"),
        ({"severity": "urgent"}, "/severity"),
        ({"locale": "de"}, "/locale"),
        ({"organisation_id": "not-a-uuid"}, "/organisation_id"),
        ({"tenant_id": "not-a-uuid"}, "/tenant_id"),
        ({"contact_email": "not an address"}, "/contact_email"),
        ({"contact_email": "a@b.test\r\nBcc: x@y.test"}, "/contact_email"),
        ({"colour": "red"}, "/colour"),
    ],
)
def test_a_malformed_field_is_named(w, change, pointer):
    body = problem(post(w, w.owner, {**BODY, **change}), 400, "malformed-request")
    assert [error["pointer"] for error in body["errors"]] == [pointer]
    assert rows() == []


@pytest.mark.parametrize("missing", ["subject", "body", "category"])
def test_a_missing_required_field_is_named(w, missing):
    body = {key: value for key, value in BODY.items() if key != missing}
    answer = problem(post(w, w.owner, body), 400, "malformed-request")
    assert answer["errors"] == [{"pointer": "/" + missing, "code": "required"}]


def test_a_body_of_twenty_thousand_characters_after_normalisation_is_accepted(w):
    # 10,000 CRLF pairs are 20,010 characters as sent and 10,010 once they are LF: within the
    # bound only when counted after the normalisation.
    opened(w, w.owner, {**BODY, "body": "\r\n" * 10_000 + "0123456789"})
    assert len(rows()[0][2]) == 10_010


@pytest.mark.parametrize(
    ("raw", "content_type"),
    [
        (b"not json", "application/json"),
        (b"[]", "application/json"),
        (json.dumps(BODY).encode(), "text/plain"),
        (b'{"subject": "' + b"x" * 140_000 + b'"}', "application/json"),
    ],
)
def test_a_body_that_is_not_one_json_object_is_malformed(w, raw, content_type):
    problem(post(w, w.owner, raw=raw, content_type=content_type), 400, "malformed-request")
    assert rows() == []


def test_the_same_key_replays_and_another_body_is_reuse(w):
    first = post(w, w.owner, key="support-replay-0123456789abcdef")
    again = post(w, w.owner, key="support-replay-0123456789abcdef")
    assert created_errors(again) == []
    assert again.headers["Idempotency-Replayed"] == "true"
    assert again.content == first.content
    other = post(
        w, w.owner, {**BODY, "subject": "Autre chose"}, key="support-replay-0123456789abcdef"
    )
    problem(other, 409, "idempotency-key-reuse")
    assert len(rows()) == 1


def test_a_missing_key_is_refused_before_anything_is_stored(w):
    response = w.client.post(
        "/api/v1/support/tickets",
        data=json.dumps(BODY),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + w.owner.credential,
    )
    problem(response, 400, "idempotency-key-missing")
    assert rows() == []


def test_the_route_answers_only_post(w):
    response = w.client.get(
        "/api/v1/support/tickets", HTTP_AUTHORIZATION="Bearer " + w.owner.credential
    )
    assert response.status_code == 405 and response.headers["Allow"] == "POST"


# --- the support mailbox --------------------------------------------------------------------------


@pytest.mark.parametrize("value", [None, ""])
def test_without_a_support_mailbox_nothing_is_stored(w, settings, value):
    settings.KODERA_SUPPORT_MAILBOX = value
    response = post(w, w.owner)
    body = problem(response, 503, "service-unavailable")
    assert int(response.headers["Retry-After"]) >= 1
    assert body["retry_after_s"] == int(response.headers["Retry-After"])
    assert rows() == []


def test_without_a_support_mailbox_an_unauthenticated_caller_still_gets_401(w, settings):
    settings.KODERA_SUPPORT_MAILBOX = None
    problem(post(w, None), 401, "unauthenticated")


# --- the limits -----------------------------------------------------------------------------------


def age_tickets(minutes):
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE support_supportticket SET created_at = created_at - %s",
            [timedelta(minutes=minutes)],
        )


def test_the_sixth_ticket_of_an_identity_within_the_hour_is_rate_limited(w):
    for _ in range(5):
        opened(w, w.member)
    response = post(w, w.member)
    problem(response, 429, "rate-limited")
    # Frozen clock: the five were opened now, so the first leaves the hour in exactly an hour.
    assert int(response.headers["Retry-After"]) == 3600
    assert len(rows()) == 5
    # Another identity of the same organisation is not held back by this one's limit.
    opened(w, w.admin)


def test_a_ticket_older_than_the_hour_no_longer_counts(w):
    for _ in range(5):
        opened(w, w.member)
    age_tickets(61)
    opened(w, w.member)


def test_retry_after_is_when_the_oldest_counted_ticket_leaves_the_hour(w):
    for _ in range(5):
        opened(w, w.member)
    age_tickets(50)
    response = post(w, w.member)
    problem(response, 429, "rate-limited")
    # The clock is frozen, so the oldest ticket leaves the hour exactly ten minutes from now.
    assert int(response.headers["Retry-After"]) == 10 * 60


def test_the_twenty_first_ticket_of_an_organisation_within_the_hour_is_rate_limited(w):
    people = [person(w, w.alpha, "org_member", f"alpha-crowd-{n}") for n in range(4)]
    for who in [w.owner, *people]:
        for _ in range(4):
            opened(w, who)
    assert len(rows()) == 20
    response = post(w, w.admin)
    problem(response, 429, "rate-limited")
    assert len(rows()) == 20
    # Another organisation is not held back by alpha's limit.
    opened(w, w.foreigner)


def test_a_rate_limited_key_is_not_stored_and_works_once_allowed(w):
    for _ in range(5):
        opened(w, w.member)
    problem(post(w, w.member, key="support-later-0123456789abcdef"), 429, "rate-limited")
    age_tickets(61)
    opened(w, w.member, key="support-later-0123456789abcdef")


# --- the mutation proofs --------------------------------------------------------------------------


@pytest.fixture
def without_the_route(monkeypatch):
    from config import customer_urls

    kept = [p for p in customer_urls.urlpatterns if str(p.pattern) != "api/v1/support/tickets"]
    assert len(kept) == len(customer_urls.urlpatterns) - 1, "the route is not routed once"
    monkeypatch.setattr(customer_urls, "urlpatterns", kept)
    clear_url_caches()
    yield
    monkeypatch.undo()
    clear_url_caches()


def test_mutation_control_the_checks_pass_with_the_route_and_the_limits(w):
    """The control: in the same world the create check passes, and the sixth ticket is refused,
    so the mutated runs below fail because of the mutation, not because of the world."""
    assert created_errors(post(w, w.member)) == []
    for _ in range(4):
        opened(w, w.member)
    assert post(w, w.member).status_code == 429


def test_mutation_without_the_route_the_create_check_fails(w, without_the_route):
    found = created_errors(post(w, w.owner))
    assert found and found[0] == "createSupportTicket answered 404, not 201", found


@pytest.mark.parametrize("limit", ["PER_IDENTITY", "PER_ORGANISATION"])
def test_mutation_without_a_limit_the_limit_test_fails(w, monkeypatch, limit):
    from apps.support import tickets

    monkeypatch.setattr(tickets, limit, 10_000)
    if limit == "PER_IDENTITY":
        for _ in range(5):
            opened(w, w.member)
        assert post(w, w.member).status_code == 201, "the sixth would no longer be refused"
    else:
        people = [person(w, w.alpha, "org_member", f"alpha-many-{n}") for n in range(5)]
        for who in people:
            for _ in range(4):
                opened(w, who)
        assert post(w, w.admin).status_code == 201, "the twenty-first would no longer be refused"
