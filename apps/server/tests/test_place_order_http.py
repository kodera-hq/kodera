"""placeOrder, listLegalDocuments, generateDpa and getDpa over HTTP, and the legal records' guards.

Real signed tokens on the workspace world (`w`), the real views and the replay store, the
disposable PostgreSQL. Every response is checked against contracts/core-api.openapi.yaml by
`call`. The order is the G1 step between the owner claim and the workspace: it carries the CGV and
the DPA, accepted with the order, and creates the tenant in status `ordered`.
"""

import hashlib
import json
import threading
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.core.exceptions import ImproperlyConfigured
from django.db import IntegrityError, connection, transaction
from django.test import Client
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_workspace_onboarding import call, person, w as w

from apps.billing import catalogue, services
from apps.billing.models import Order
from apps.billing.selectors import has_committed_order
from apps.legal import services as legal
from apps.legal.models import Acceptance, Dpa, LegalDocument
from apps.tenancy.models import Tenant
from config.environment import legal_text_origin

pytestmark = pytest.mark.django_db(transaction=True)

ROOT = Path(__file__).resolve().parents[1]
DOCUMENTS = "/legal-documents"
GENERATE = "/organisations/{organisation_id}/dpa"
DPA = "/organisations/{organisation_id}/dpa/{dpa_id}"
ORDERS = "/organisations/{organisation_id}/orders"
PROBLEMS = "https://kodera.io/problems/"


def url(template, **values):
    return "/api/v1" + template.format(**{k: str(v) for k, v in values.items()})


def auth(who):
    return {} if who is None else {"HTTP_AUTHORIZATION": "Bearer " + who.credential}


def body(response):
    return json.loads(response.content)


def problem(response, status, kind):
    assert response.status_code == status, response.content
    assert body(response)["type"] == PROBLEMS + kind
    assert response.headers["Cache-Control"] == "no-store"
    return body(response)


@pytest.fixture
def ready(w):
    from billing_fiscal_fixtures import register_test_fiscal_periods

    register_test_fiscal_periods()
    catalogue.load(catalogue.read(catalogue.PLACEHOLDER), allow_placeholder=True)
    legal.load_documents(legal.read_documents(legal.PLACEHOLDER), allow_placeholder=True)
    for organisation in (w.alpha, w.bravo):
        services.set_billing_profile(
            organisation_id=organisation.id,
            legal_name="Synthetic Customer SAS",
            address_line1="1 rue Synthétique",
            postal_code="75000",
            city="Paris",
            country="FR",
        )
    return w


def generate(w, who=None, organisation=None, key=None, payload=None):
    organisation = organisation or w.alpha
    response = w.client.post(
        url(GENERATE, organisation_id=organisation.id),
        data=json.dumps(
            payload if payload is not None else {"pack_code": "visio-docs", "locale": "fr"}
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key or f"dpa-key-{uuid4().hex}",
        **auth(who or w.owner),
    )
    return call(response, GENERATE, "post")


def order_body(dpa_id, *, slug="acme-tenant", cgv="0.0", **changes):
    payload = {
        "pack_code": "visio-docs",
        "capacity_tier_code": "M",
        "billing_period": "yearly",
        "plan_code": "essentiel",
        "tenant": {"slug": slug, "name": "Synthetic tenant", "locale": "fr"},
        "dpa_acceptance": {
            "dpa_id": str(dpa_id),
            "accepted": True,
            "accepted_by_name": "Synthetic Owner",
            "accepted_by_role": "Présidente",
        },
        "legal_acceptances": [{"code": "cgv", "version": cgv, "locale": "fr"}],
        "billing_contact": {"email": "billing@customer.test", "name": "Billing"},
    }
    payload.update(changes)
    return payload


def place(w, payload, who=None, organisation=None, key="order-key-000000001", raw=None):
    organisation = organisation or w.alpha
    headers = auth(who or w.owner)
    if key is not None:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    response = w.client.post(
        url(ORDERS, organisation_id=organisation.id),
        data=raw if raw is not None else json.dumps(payload),
        content_type="application/json",
        HTTP_USER_AGENT="synthetic-agent/1.0",
        **headers,
    )
    return call(response, ORDERS, "post")


def _denials():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT actor_type, metadata->>'required_scope' FROM audit_auditevent"
            " WHERE action = 'authz.denied' ORDER BY occurred_at, id"
        )
        return cursor.fetchall()


# --- the documents in force ---------------------------------------------------------------------


def test_the_documents_in_force_are_public(ready):
    page = body(
        call(ready.client.get(url(DOCUMENTS) + "?locale=fr&pack_code=visio-docs"), DOCUMENTS, "get")
    )
    assert sorted((d["code"], d["version"], d["locale"]) for d in page["data"]) == [
        ("aup", "0.0", "fr"),
        ("cgv", "0.0", "fr"),
        ("dpa", "0.0", "fr"),
        ("sla", "0.0", "fr"),
    ]
    assert page["has_more"] is False and all(d["download"] is None for d in page["data"])
    every = body(call(ready.client.get(url(DOCUMENTS)), DOCUMENTS, "get"))["data"]
    assert len(every) == 8


def test_a_newer_version_replaces_the_older_in_force(ready):
    LegalDocument.objects.create(
        code="cgv",
        version="0.1",
        locale="fr",
        title="Conditions générales (placeholder, newer)",
        sha256="1" * 64,
        published_at=timezone.now() - timedelta(minutes=1),
    )
    LegalDocument.objects.create(
        code="cgv",
        version="9.9",
        locale="fr",
        title="Not yet in force",
        sha256="9" * 64,
        published_at=timezone.now() + timedelta(days=1),
    )
    page = body(call(ready.client.get(url(DOCUMENTS) + "?locale=fr"), DOCUMENTS, "get"))
    assert [d["version"] for d in page["data"] if d["code"] == "cgv"] == ["0.1"]


@pytest.mark.parametrize(
    "query", ["locale=de", "limit=0", "cursor=x", "colour=red", "limit=1&limit=2"]
)
def test_a_documents_query_it_does_not_accept_is_malformed(ready, query):
    problem(
        call(ready.client.get(url(DOCUMENTS) + "?" + query), DOCUMENTS, "get"),
        400,
        "malformed-request",
    )


# --- generateDpa and getDpa ---------------------------------------------------------------------


def test_the_owner_generates_the_dpa_once_per_template(ready):
    first = generate(ready)
    assert first.status_code == 201
    dpa = body(first)
    assert (dpa["state"], dpa["version"], dpa["pack_code"]) == ("generated", "0.0", "visio-docs")
    assert dpa["sub_processors"][0]["name"] == "Scaleway" and dpa["accepted_by"] is None
    assert first.headers["Location"] == f"/api/v1/organisations/{ready.alpha.id}/dpa/{dpa['id']}"
    again = body(generate(ready))
    assert again["id"] == dpa["id"]
    for who in (ready.owner, ready.admin, ready.billing):
        read = call(
            ready.client.get(
                url(DPA, organisation_id=ready.alpha.id, dpa_id=dpa["id"]), **auth(who)
            ),
            DPA,
            "get",
        )
        assert body(read)["id"] == dpa["id"]


def test_a_new_template_supersedes_an_unaccepted_dpa(ready):
    old = body(generate(ready))
    LegalDocument.objects.create(
        code="dpa",
        version="0.1",
        locale="fr",
        title="DPA (placeholder, newer)",
        sha256="2" * 64,
        published_at=timezone.now() - timedelta(minutes=1),
    )
    new = body(generate(ready))
    assert new["id"] != old["id"] and new["version"] == "0.1"
    stored = Dpa.objects.get(id=old["id"])
    assert stored.state == "superseded" and str(stored.superseded_by_id) == new["id"]


def test_only_the_owner_generates_and_the_billing_roles_read(ready):
    problem(generate(ready, who=ready.admin), 403, "forbidden")
    problem(generate(ready, who=ready.staff), 403, "forbidden")
    problem(generate(ready, who=ready.foreigner), 404, "not-found")
    dpa = body(generate(ready))
    for who, status in ((ready.member, 403), (ready.staff, 403), (ready.foreigner, 404)):
        response = call(
            ready.client.get(
                url(DPA, organisation_id=ready.alpha.id, dpa_id=dpa["id"]), **auth(who)
            ),
            DPA,
            "get",
        )
        assert response.status_code == status


@pytest.mark.parametrize(
    ("payload", "status", "kind"),
    [
        ({"pack_code": "no-such-pack"}, 404, "not-found"),
        ({"locale": "fr"}, 422, "validation-error"),
        ({"pack_code": "visio-docs", "colour": "red"}, 422, "validation-error"),
        ({"pack_code": "visio-docs", "tenant_id": str(uuid4())}, 422, "validation-error"),
    ],
)
def test_a_dpa_request_it_cannot_serve_is_refused(ready, payload, status, kind):
    problem(generate(ready, payload=payload), status, kind)


# --- placeOrder ---------------------------------------------------------------------------------


def test_the_owner_places_the_order_with_its_agreements_in_one_transaction(ready):
    dpa = body(generate(ready))
    response = place(ready, order_body(dpa["id"]))
    assert response.status_code == 201, response.content
    result = body(response)
    order, tenant = result["order"], result["tenant"]
    assert response.headers["Location"] == f"/api/v1/orders/{order['id']}"
    assert (order["state"], order["tenant_id"], order["dpa_id"]) == (
        "placed",
        tenant["id"],
        dpa["id"],
    )
    assert (tenant["status"], tenant["slug"], tenant["realm"]) == (
        "ordered",
        "acme-tenant",
        ready.alpha.slug,
    )
    assert tenant["apps"] == ["visio", "docs"] and tenant["region"] == "fr-par"
    assert result["subscription"]["state"] == "pending"
    assert result["invoice"]["state"] == "issued" and result["invoice"]["number"].startswith("TST-")
    assert result["dpa"]["state"] == "accepted"
    assert result["dpa"]["accepted_by"]["name"] == "Synthetic Owner"
    assert result["payment_link"] is None and result["billing_pending"] is True
    acceptances = Acceptance.objects.filter(order_id=order["id"])
    assert sorted(a.document.code for a in acceptances) == ["cgv", "dpa"]
    assert {a.user_agent for a in acceptances} == {"synthetic-agent/1.0"}
    assert has_committed_order(organisation_id=ready.alpha.id)


def test_the_same_key_replays_the_order_and_another_body_under_it_is_refused(ready):
    dpa = body(generate(ready))
    first = place(ready, order_body(dpa["id"]))
    again = place(ready, order_body(dpa["id"]))
    assert again.status_code == 201 and again.headers["Idempotency-Replayed"] == "true"
    assert body(again) == body(first)
    problem(place(ready, order_body(dpa["id"], slug="other-tenant")), 409, "idempotency-key-reuse")
    assert Order.objects.filter(organisation_id=ready.alpha.id).count() == 1


def test_only_the_owner_places_an_order_and_staff_never_does(ready):
    dpa = body(generate(ready))
    problem(place(ready, order_body(dpa["id"]), who=ready.billing), 403, "forbidden")
    problem(place(ready, order_body(dpa["id"]), who=ready.staff), 403, "forbidden")
    problem(place(ready, order_body(dpa["id"]), who=ready.stranger), 404, "not-found")
    assert [scope for _, scope in _denials()] == ["order:create", "order:create"]
    assert not Order.objects.exists() and not Tenant.objects.exists()


@pytest.mark.parametrize(
    ("change", "pointer", "code"),
    [
        (
            {"legal_acceptances": [{"code": "sla", "version": "0.0", "locale": "fr"}]},
            "/legal_acceptances",
            "cgv_missing",
        ),
        ({"cgv": "0.9"}, "/legal_acceptances", "cgv_not_in_force"),
        (
            {"legal_acceptances": [{"code": "dpa", "version": "0.0", "locale": "fr"}]},
            "/legal_acceptances",
            "unknown_document",
        ),
        ({"tenant": {"slug": "A", "name": "x"}}, "/tenant/slug", "format"),
        ({"colour": "red"}, "/colour", "unknown_member"),
        ({"pack_code": "no-such-pack"}, "/pack_code", "unavailable"),
    ],
)
def test_an_order_it_cannot_place_is_a_validation_error_and_writes_nothing(
    ready, change, pointer, code
):
    dpa = body(generate(ready))
    cgv = change.pop("cgv", "0.0")
    refusal = problem(
        place(ready, order_body(dpa["id"], cgv=cgv, **change)), 422, "validation-error"
    )
    assert {"pointer": pointer, "code": code} in [
        {k: e[k] for k in ("pointer", "code")} for e in refusal["errors"]
    ]
    assert (
        not Order.objects.exists()
        and not Tenant.objects.exists()
        and not Acceptance.objects.exists()
    )
    assert Dpa.objects.get(id=dpa["id"]).state == "generated"


def test_a_dpa_that_is_not_the_organisations_or_not_current_is_refused(ready):
    foreign = body(generate(ready, who=ready.foreigner, organisation=ready.bravo))
    refusal = problem(place(ready, order_body(foreign["id"])), 422, "validation-error")
    assert refusal["errors"][0]["code"] == "unknown"
    old = body(generate(ready))
    LegalDocument.objects.create(
        code="dpa",
        version="0.1",
        locale="fr",
        title="DPA",
        sha256="3" * 64,
        published_at=timezone.now() - timedelta(minutes=1),
    )
    refusal = problem(
        place(ready, order_body(old["id"]), key="order-key-000000002"), 422, "validation-error"
    )
    assert refusal["errors"][0]["code"] == "dpa_not_in_force"


def test_a_slug_another_tenant_holds_is_taken_forever(ready):
    dpa = body(generate(ready))
    place(ready, order_body(dpa["id"]))
    other = body(generate(ready, who=ready.foreigner, organisation=ready.bravo))
    problem(
        place(
            ready,
            order_body(other["id"]),
            who=ready.foreigner,
            organisation=ready.bravo,
            key="order-key-000000009",
        ),
        409,
        "slug-taken",
    )


@pytest.mark.parametrize(
    ("raw", "key", "status", "kind"),
    [
        ("{not json", "order-key-000000001", 400, "malformed-request"),
        ("[]", "order-key-000000001", 400, "malformed-request"),
        (None, None, 400, "idempotency-key-missing"),
    ],
)
def test_a_body_or_key_it_cannot_read_is_malformed(ready, raw, key, status, kind):
    dpa = body(generate(ready))
    problem(place(ready, order_body(dpa["id"]), key=key, raw=raw), status, kind)


def test_an_unauthenticated_order_is_401(ready):
    response = ready.client.post(
        url(ORDERS, organisation_id=ready.alpha.id),
        data="{}",
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="order-key-000000001",
    )
    problem(call(response, ORDERS, "post"), 401, "unauthenticated")


# --- the guards on what was accepted ------------------------------------------------------------


def _refused(statement, parameters, constraint):
    with pytest.raises(IntegrityError) as refusal:
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(statement, parameters)
    assert refusal.value.__cause__.diag.constraint_name == constraint


def test_an_acceptance_a_published_document_and_an_accepted_dpa_never_change(ready):
    dpa = body(generate(ready))
    place(ready, order_body(dpa["id"]))
    acceptance = Acceptance.objects.first()
    _refused(
        "UPDATE legal_acceptance SET accepted_by_name = 'x' WHERE id = %s",
        [acceptance.id],
        "legal_acceptance_immutable",
    )
    _refused(
        "DELETE FROM legal_acceptance WHERE id = %s", [acceptance.id], "legal_acceptance_immutable"
    )
    document = LegalDocument.objects.first()
    _refused(
        "UPDATE legal_legaldocument SET title = 'x' WHERE id = %s",
        [document.id],
        "legal_legaldocument_immutable",
    )
    _refused(
        "UPDATE legal_dpa SET sha256 = %s WHERE id = %s",
        ["4" * 64, dpa["id"]],
        "legal_dpa_immutable",
    )
    _refused(
        "UPDATE legal_dpa SET state = 'generated' WHERE id = %s", [dpa["id"]], "legal_dpa_immutable"
    )
    _refused("DELETE FROM legal_dpa WHERE id = %s", [dpa["id"]], "legal_dpa_immutable")


def test_the_documents_file_loads_once_and_never_edits_a_published_document(ready):
    document = legal.read_documents(legal.PLACEHOLDER)
    assert legal.load_documents(document, allow_placeholder=True) == (0, 8)
    with pytest.raises(legal.LegalDocumentsError, match="placeholder"):
        legal.load_documents(document, allow_placeholder=False)
    document["documents"][0]["title"] = "Edited"
    with pytest.raises(legal.LegalDocumentsError, match="new version"):
        legal.load_documents(document, allow_placeholder=True)


def test_a_cancelled_order_is_not_a_committed_one(ready):
    assert not has_committed_order(organisation_id=ready.alpha.id)
    dpa = body(generate(ready))
    order_id = body(place(ready, order_body(dpa["id"])))["order"]["id"]
    Order.objects.filter(id=order_id).update(state="cancelled")
    assert not has_committed_order(organisation_id=ready.alpha.id)


def test_the_dpa_names_the_person_who_accepted_it_and_the_tenant_it_covers(ready):
    dpa = body(generate(ready))
    result = body(place(ready, order_body(dpa["id"])))
    assert result["dpa"]["accepted_by"]["person_id"] == str(ready.owner.user.id)
    assert result["dpa"]["tenant_id"] == result["tenant"]["id"]


def test_a_dpa_for_another_pack_or_already_accepted_is_refused_by_name(ready):
    visio = body(generate(ready, payload={"pack_code": "visio", "locale": "fr"}))
    refusal = problem(
        place(ready, order_body(visio["id"]), key="order-key-000000009"), 422, "validation-error"
    )
    assert refusal["errors"][0] == {"pointer": "/dpa_acceptance/dpa_id", "code": "dpa_other_pack"}
    dpa = body(generate(ready))
    place(ready, order_body(dpa["id"]), key="order-key-000000001")
    # The organisation's one live order is cancelled: what refuses the next is its DPA, accepted.
    Order.objects.filter(organisation_id=ready.alpha.id).update(state="cancelled")
    refusal = problem(
        place(ready, order_body(dpa["id"], slug="second-tenant"), key="order-key-000000002"),
        422,
        "validation-error",
    )
    assert refusal["errors"][0] == {
        "pointer": "/dpa_acceptance/dpa_id",
        "code": "dpa_already_accepted",
    }


@pytest.mark.parametrize("slug", ["www", "api", "kodera", "staging", "matrix", "xn--80ak6aa92e"])
def test_a_reserved_or_punycode_tenant_slug_is_refused(ready, slug):
    dpa = body(generate(ready))
    refusal = problem(place(ready, order_body(dpa["id"], slug=slug)), 422, "validation-error")
    assert refusal["errors"][0] == {"pointer": "/tenant/slug", "code": "format"}


def test_a_tenant_is_never_deleted_and_its_slug_never_changes(ready):
    dpa = body(generate(ready))
    tenant_id = body(place(ready, order_body(dpa["id"])))["tenant"]["id"]
    _refused(
        "DELETE FROM tenancy_tenant WHERE id = %s", [tenant_id], "tenancy_tenant_slug_permanent"
    )
    _refused(
        "UPDATE tenancy_tenant SET slug = 'renamed' WHERE id = %s",
        [tenant_id],
        "tenancy_tenant_slug_permanent",
    )


def test_one_unaccepted_dpa_per_organisation_pack_and_locale(ready):
    dpa = Dpa.objects.get(id=body(generate(ready))["id"])
    with pytest.raises(IntegrityError) as refusal, transaction.atomic():
        Dpa.objects.create(
            organisation_id=dpa.organisation_id,
            template_id=dpa.template_id,
            pack_code=dpa.pack_code,
            locale=dpa.locale,
            version=dpa.version,
            sha256=dpa.sha256,
        )
    assert refusal.value.__cause__.diag.constraint_name == "legal_dpa_one_generated"


def test_a_document_is_published_with_its_text_and_the_digest_is_the_texts(ready):
    document = legal.read_documents(legal.PLACEHOLDER)
    row = dict(document["documents"][0], version="0.2")
    del row["text"]
    with pytest.raises(legal.LegalDocumentsError, match="with its text"):
        legal.load_documents({"documents": [row]}, allow_placeholder=True)
    row.update(text="Another text")
    with pytest.raises(legal.LegalDocumentsError, match="not the digest of its text"):
        legal.load_documents({"documents": [row]}, allow_placeholder=True)
    # Given no digest, the loader takes the text's own.
    del row["sha256"]
    assert legal.load_documents({"documents": [row]}, allow_placeholder=True) == (1, 0)
    stored = LegalDocument.objects.get(code=row["code"], version="0.2", locale=row["locale"])
    assert stored.sha256 == hashlib.sha256(b"Another text").hexdigest()


def test_the_database_holds_the_digest_to_the_text(ready):
    stored = LegalDocument.objects.get(code="cgv", version="0.0", locale="fr")
    with pytest.raises(IntegrityError) as refusal, transaction.atomic():
        LegalDocument.objects.create(
            code="cgv",
            version="0.3",
            locale="fr",
            title=stored.title,
            sha256=stored.sha256,
            text="Not the text this digest covers",
            published_at=stored.published_at,
        )
    assert refusal.value.__cause__.diag.constraint_name == "legal_document_text_digest"


def test_a_text_file_is_read_beside_the_documents_file(ready, tmp_path):
    text = "# Conditions générales\n\nArticle 1 — Parties.\n"
    (tmp_path / "cgv.fr.md").write_bytes(text.encode("utf-8"))
    (tmp_path / "documents.toml").write_text(
        """[[documents]]
code = "cgv"
version = "2026-10-draft-1"
locale = "fr"
title = "Conditions générales de vente"
text_file = "cgv.fr.md"
published_at = 2026-10-01T00:00:00Z
""",
        encoding="utf-8",
    )
    assert legal.load_documents(
        legal.read_documents(tmp_path / "documents.toml"), allow_placeholder=False
    ) == (1, 0)
    stored = LegalDocument.objects.get(version="2026-10-draft-1")
    assert (stored.text, stored.sha256) == (text, hashlib.sha256(text.encode()).hexdigest())
    (tmp_path / "absolute.toml").write_text(
        f'[[documents]]\ncode = "cgv"\ntext_file = "{tmp_path / "cgv.fr.md"}"\n', encoding="utf-8"
    )
    with pytest.raises(legal.LegalDocumentsError, match="relative path"):
        legal.read_documents(tmp_path / "absolute.toml")
    folder = tmp_path / "documents"
    folder.mkdir()
    (folder / "link.md").symlink_to(tmp_path / "cgv.fr.md")
    for name in ("../cgv.fr.md", "link.md", "missing.md"):
        (folder / "documents.toml").write_text(
            f'[[documents]]\ncode = "cgv"\ntext_file = "{name}"\n', encoding="utf-8"
        )
        with pytest.raises(legal.LegalDocumentsError, match="relative path"):
            legal.read_documents(folder / "documents.toml")


def test_a_row_published_before_core_kept_texts_reloads_unchanged(w):
    document = legal.read_documents(legal.PLACEHOLDER)
    row = document["documents"][0]
    LegalDocument.objects.create(
        code=row["code"],
        version=row["version"],
        locale=row["locale"],
        title=row["title"],
        sha256=row["sha256"],
        published_at=row["published_at"],
    )
    assert legal.load_documents(document, allow_placeholder=True) == (7, 1)
    assert LegalDocument.objects.get(code=row["code"], locale=row["locale"]).text is None


@pytest.mark.parametrize("profile", ["deploy", "customer_http", "job_queue"])
def test_every_profile_that_names_a_text_reads_its_origin(profile):
    source = (ROOT / "config" / "settings" / f"{profile}.py").read_text()
    assert "KODERA_LEGAL_TEXT_ORIGIN = legal_text_origin(os.environ)" in source


TEXT = "/legal-documents/{code}/{version}/{locale}"


def test_an_accepted_text_is_public_at_its_permanent_url(ready):
    response = ready.client.get(url(TEXT, code="cgv", version="0.0", locale="fr"))
    assert response.status_code == 200
    assert response.content == b"placeholder cgv 0.0 fr"
    assert response.headers["Content-Type"] == "text/plain; charset=utf-8"
    assert response.headers["ETag"] == '"' + hashlib.sha256(response.content).hexdigest() + '"'
    assert response.headers["Cache-Control"] == "public, max-age=31536000, immutable"
    assert response.headers["X-Request-Id"]
    listed = body(call(ready.client.get(url(DOCUMENTS) + "?locale=fr"), DOCUMENTS, "get"))
    cgv = next(row for row in listed["data"] if row["code"] == "cgv")
    assert cgv["text_url"] == "https://api.localhost" + url(
        TEXT, code="cgv", version="0.0", locale="fr"
    )


def test_an_unknown_text_is_not_found(ready, django_assert_num_queries):
    with django_assert_num_queries(1):
        response = ready.client.get(url(TEXT, code="cgv", version="9.9", locale="fr"))
    problem(call(response, TEXT, "get"), 404, "not-found")


@pytest.mark.parametrize(
    ("code", "version", "locale"),
    [("cgv", "0.0", "de"), ("xyz", "0.0", "fr"), ("cgv", "a" * 21, "fr"), ("cgv", "0_0", "fr")],
)
def test_a_malformed_text_key_is_refused_without_reading(
    ready, code, version, locale, django_assert_num_queries
):
    # A key outside the contract's parameter schemas never reaches the database.
    with django_assert_num_queries(0):
        response = ready.client.get(url(TEXT, code=code, version=version, locale=locale))
    problem(call(response, TEXT, "get"), 400, "malformed-request")


def test_a_document_published_without_its_text_has_no_url(ready, settings):
    stored = LegalDocument.objects.get(code="cgv", version="0.0", locale="fr")
    LegalDocument.objects.create(
        code="cgv",
        version="0.4",
        locale="en",
        title="Without text",
        sha256=stored.sha256,
        published_at=stored.published_at,
    )
    problem(ready.client.get(url(TEXT, code="cgv", version="0.4", locale="en")), 404, "not-found")
    assert legal.text_url(LegalDocument.objects.get(version="0.4")) is None
    settings.KODERA_LEGAL_TEXT_ORIGIN = None
    assert legal.text_url(stored) is None


def test_the_text_is_read_only(ready):
    response = ready.client.post(url(TEXT, code="cgv", version="0.0", locale="fr"))
    problem(response, 405, "method-not-allowed")


def test_a_committed_order_needs_its_dpa_accepted(ready):
    dpa = body(generate(ready))
    place(ready, order_body(dpa["id"]))
    assert has_committed_order(organisation_id=ready.alpha.id)
    assert not has_committed_order(organisation_id=ready.bravo.id)


def test_a_version_published_in_the_future_is_not_in_force_yet(ready):
    LegalDocument.objects.create(
        code="cgv",
        version="9.9",
        locale="fr",
        title="Not yet",
        sha256="8" * 64,
        published_at=timezone.now() + timedelta(days=1),
    )
    dpa = body(generate(ready))
    refusal = problem(place(ready, order_body(dpa["id"], cgv="9.9")), 422, "validation-error")
    assert refusal["errors"][0]["code"] == "cgv_not_in_force"
    assert refusal["errors"][0]["detail"] == "in force: 0.0"


def test_a_document_accepted_twice_is_refused(ready):
    dpa = body(generate(ready))
    twice = [{"code": "cgv", "version": "0.0", "locale": "fr"}] * 2
    refusal = problem(
        place(ready, order_body(dpa["id"], legal_acceptances=twice)), 422, "validation-error"
    )
    assert refusal["errors"][0] == {"pointer": "/legal_acceptances", "code": "duplicate_code"}


@pytest.mark.parametrize("contact", [[], 0, False, "", None])
def test_a_billing_contact_that_is_not_an_object_is_refused(ready, contact):
    dpa = body(generate(ready))
    refusal = problem(
        place(ready, order_body(dpa["id"], billing_contact=contact)), 422, "validation-error"
    )
    assert refusal["errors"][0]["pointer"] == "/billing_contact"


def test_the_dpa_operations_record_their_refusals(ready):
    generate(ready, who=ready.admin)
    generate(ready, who=ready.staff)
    dpa = body(generate(ready))
    ready.client.get(
        url(DPA, organisation_id=ready.alpha.id, dpa_id=dpa["id"]), **auth(ready.member)
    )
    assert _denials() == [
        ("tenant", "dpa_acceptance:create"),
        ("staff", "dpa_acceptance:create"),
        ("tenant", "dpa_acceptance:read"),
    ]


def _race(ready, monkeypatch, requests):
    """Two placements for alpha under two keys, each past its early check before either writes."""
    real = services._has_order_in_flight
    both_looked = threading.Barrier(2, timeout=60)
    looked = threading.local()

    def look_then_wait(**kwargs):
        found = real(**kwargs)
        # Only each placement's first look waits: the loser looks again once refused.
        if not getattr(looked, "done", False):
            looked.done = True
            both_looked.wait()
        return found

    monkeypatch.setattr(services, "_has_order_in_flight", look_then_wait)
    responses, failures = [None, None], []

    def submit(index):
        payload, key = requests[index]
        try:
            responses[index] = Client(raise_request_exception=False, HTTP_HOST="127.0.0.1").post(
                url(ORDERS, organisation_id=ready.alpha.id),
                data=json.dumps(payload),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=key,
                HTTP_USER_AGENT="synthetic-agent/1.0",
                **auth(ready.owner),
            )
        except BaseException as failure:  # re-raised below, on the test's own thread
            failures.append(failure)
        finally:
            connection.close()

    threads = [threading.Thread(target=submit, args=(index,)) for index in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=120)
    if failures:
        raise failures[0]
    assert all(not thread.is_alive() for thread in threads), "a placement never answered"
    return responses


@pytest.mark.parametrize("tabs", ["two-dpas-two-slugs", "two-dpas-one-slug", "one-dpa-one-slug"])
def test_two_placements_at_once_make_one_order(ready, monkeypatch, tabs):
    """Two owners ordering two tenants, or one owner's two tabs sending the same order, in the
    same instant under two keys: one order, and the other `409 order-in-progress`."""
    docs = body(generate(ready))
    first = (order_body(docs["id"], slug="first-tenant"), "order-key-race-00000001")
    if tabs == "one-dpa-one-slug":
        second = (first[0], "order-key-race-00000002")
    elif tabs == "two-dpas-one-slug":
        # The loser meets the winner's slug first: `slug-taken` without the in-flight fallback.
        visio = body(generate(ready, payload={"pack_code": "visio", "locale": "fr"}))
        payload = order_body(
            visio["id"], slug="first-tenant", pack_code="visio", capacity_tier_code="S"
        )
        second = (payload, "order-key-race-00000002")
    else:
        visio = body(generate(ready, payload={"pack_code": "visio", "locale": "fr"}))
        payload = order_body(
            visio["id"], slug="second-tenant", pack_code="visio", capacity_tier_code="S"
        )
        second = (payload, "order-key-race-00000002")
    responses = _race(ready, monkeypatch, [first, second])
    assert sorted(response.status_code for response in responses) == [201, 409]
    loser = next(response for response in responses if response.status_code == 409)
    refusal = body(call(loser, ORDERS, "post"))
    assert refusal["type"] == PROBLEMS + "order-in-progress"
    assert Order.objects.filter(organisation_id=ready.alpha.id).count() == 1
    # The loser's tenant went with its order.
    assert Tenant.objects.filter(organisation_id=ready.alpha.id).count() == 1


def test_a_second_tenant_is_ordered_once_the_first_order_is_settled(ready):
    visio = body(generate(ready, payload={"pack_code": "visio", "locale": "fr"}))
    first = order_body(visio["id"], slug="first-tenant", pack_code="visio", capacity_tier_code="S")
    assert place(ready, first).status_code == 201
    docs = body(generate(ready))
    second = order_body(docs["id"], slug="second-tenant")
    refusal = problem(place(ready, second, key="order-key-000000002"), 409, "order-in-progress")
    assert "detail" in refusal and "errors" not in refusal
    Order.objects.filter(organisation_id=ready.alpha.id).update(state="fulfilled")
    # A new key: the refusal under the first is stored and replayed (CONVENTIONS.md §8).
    assert place(ready, second, key="order-key-000000003").status_code == 201
    assert sorted(
        Tenant.objects.filter(organisation_id=ready.alpha.id).values_list("pack_code", flat=True)
    ) == ["visio", "visio-docs"]


# --- cancelOrder --------------------------------------------------------------------------------

CANCEL = "/orders/{order_id}/actions/cancel"


OWNER = object()


def cancel(w, order_id, who=OWNER, key="cancel-key-000000001"):
    headers = auth(w.owner if who is OWNER else who)
    if key is not None:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    response = w.client.post(url(CANCEL, order_id=order_id), **headers)
    return call(response, CANCEL, "post")


def place_draft(w, monkeypatch, payload, key="order-key-000000001"):
    """An order whose invoice stays a draft, the one an order can be cancelled with. Its answer
    is not checked against the contract: `placeOrder` always issues the invoice."""
    with monkeypatch.context() as patched:
        patched.setattr(services, "issue_invoice", lambda invoice, **kwargs: None)
        response = w.client.post(
            url(ORDERS, organisation_id=w.alpha.id),
            data=json.dumps(payload),
            content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=key,
            HTTP_USER_AGENT="synthetic-agent/1.0",
            **auth(w.owner),
        )
    assert response.status_code == 201, response.content
    return body(response)


def test_the_owner_cancels_an_order_with_a_draft_invoice_and_orders_again(ready, monkeypatch):
    dpa = body(generate(ready))
    placed = place_draft(ready, monkeypatch, order_body(dpa["id"]))
    order_id = placed["order"]["id"]
    answered = cancel(ready, order_id)
    assert answered.status_code == 200, answered.content
    assert body(answered)["id"] == order_id and body(answered)["state"] == "cancelled"
    assert answered.headers["Cache-Control"] == "no-store"
    assert Tenant.objects.get(id=placed["tenant"]["id"]).status == "deleted"
    # The same key replays the answer; another key answers the cancelled order again.
    replayed = cancel(ready, order_id)
    assert replayed.headers["Idempotency-Replayed"] == "true"
    assert body(cancel(ready, order_id, key="cancel-key-000000002"))["state"] == "cancelled"
    # The workspace's order guard no longer counts it.
    assert has_committed_order(organisation_id=ready.alpha.id) is False
    # A new DPA and a new slug: the organisation orders again; the old slug stays taken.
    fresh = body(generate(ready))
    problem(place(ready, order_body(fresh["id"]), key="order-key-000000002"), 409, "slug-taken")
    again = place(ready, order_body(fresh["id"], slug="acme-second"), key="order-key-000000003")
    assert again.status_code == 201, again.content


def test_the_owner_cancels_a_placed_order_and_its_invoice_is_credited(ready):
    dpa = body(generate(ready))
    placed = body(place(ready, order_body(dpa["id"])))
    order_id, invoice_id = placed["order"]["id"], placed["invoice"]["id"]
    answered = cancel(ready, order_id)
    assert answered.status_code == 200, answered.content
    assert body(answered)["state"] == "cancelled"
    invoice = call(
        ready.client.get(url("/invoices/{invoice_id}", invoice_id=invoice_id), **auth(ready.owner)),
        "/invoices/{invoice_id}",
        "get",
    )
    assert body(invoice)["state"] == "credited"
    # A new DPA and a new slug: the organisation orders again.
    fresh = body(generate(ready))
    again = place(ready, order_body(fresh["id"], slug="acme-second"), key="order-key-000000002")
    assert again.status_code == 201, again.content


def test_an_order_a_payment_holds_or_that_is_paid_is_not_cancelled(ready):
    dpa = body(generate(ready))
    order_id = body(place(ready, order_body(dpa["id"])))["order"]["id"]
    # A partial payment: only a partial credit with a refund could correct it.
    Order.objects.get(id=order_id).invoices.update(amount_paid_minor=100)
    problem(cancel(ready, order_id), 409, "invoice-issued")
    Order.objects.filter(id=order_id).update(state="paid")
    refusal = problem(
        cancel(ready, order_id, key="cancel-key-000000002"), 409, "invalid-state-transition"
    )
    assert refusal["allowed_states"] == ["placed", "awaiting_payment"]
    assert Order.objects.get(id=order_id).invoices.get().state == "issued"


def test_only_the_owner_cancels_and_another_organisation_cannot_tell_the_order_exists(ready):
    dpa = body(generate(ready))
    order_id = body(place(ready, order_body(dpa["id"])))["order"]["id"]
    for who in (ready.admin, ready.billing, ready.member):
        problem(cancel(ready, order_id, who=who), 403, "forbidden")
    problem(cancel(ready, order_id, who=ready.staff), 403, "forbidden")
    problem(cancel(ready, order_id, who=ready.foreigner), 404, "not-found")
    problem(cancel(ready, uuid4()), 404, "not-found")
    problem(cancel(ready, order_id, who=None), 401, "unauthenticated")
    problem(cancel(ready, order_id, key=None), 400, "idempotency-key-missing")
    # Not a contract operation, so not checked against one: the route serves POST only.
    wrong = ready.client.get(url(CANCEL, order_id=order_id), **auth(ready.owner))
    assert problem(wrong, 405, "method-not-allowed")["allowed"] == ["POST"]
    assert wrong.headers["Allow"] == "POST"
    assert Order.objects.get(id=order_id).state == "placed"
    assert ("tenant", "order:act") in _denials() and ("staff", "order:act") in _denials()


def test_a_replayed_cancellation_is_refused_to_an_owner_since_demoted(ready, monkeypatch):
    dpa = body(generate(ready))
    order_id = place_draft(ready, monkeypatch, order_body(dpa["id"]))["order"]["id"]
    assert cancel(ready, order_id).status_code == 200
    # A second owner first: the last owner of an active organisation cannot be demoted.
    person(ready, ready.alpha, "org_owner", "alpha-second-owner")
    ready.owner.member.__class__.objects.filter(id=ready.owner.member.id).update(role="org_admin")
    # The same key: the stored 200 is not handed to a caller who no longer holds the operation.
    problem(cancel(ready, order_id), 403, "forbidden")


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("", None),
        ("https://API.kodera.io", "https://api.kodera.io"),
        ("https://api.kodera.io/", "https://api.kodera.io"),
        ("https://api.kodera.io:8443", "https://api.kodera.io:8443"),
        ("http://api.kodera.io", ImproperlyConfigured),
        ("https://api.kodera.io/api/v1", ImproperlyConfigured),
        ("https://user@api.kodera.io", ImproperlyConfigured),
        ("https://api.kodera.io?x=1", ImproperlyConfigured),
        ("api.kodera.io", ImproperlyConfigured),
        ("https://api kodera.io", ImproperlyConfigured),
        ("https://api.kodera.io;x", ImproperlyConfigured),
        ("https://[::1]:8443", ImproperlyConfigured),
        ("https://203.0.113.7", ImproperlyConfigured),
        ("https://kodéra.io", ImproperlyConfigured),
        ("https://api.kodera.io:0", ImproperlyConfigured),
    ],
)
def test_the_text_origin_is_one_https_origin(value, expected):
    environment = {"KODERA_LEGAL_TEXT_ORIGIN": value}
    if expected is ImproperlyConfigured:
        with pytest.raises(ImproperlyConfigured):
            legal_text_origin(environment)
    else:
        assert legal_text_origin(environment) == expected


# --- credit notes ---------------------------------------------------------------------------------

CREDIT_NOTES = "/organisations/{organisation_id}/credit-notes"
CREDIT_NOTE = "/credit-notes/{credit_note_id}"
INVOICE = "/invoices/{invoice_id}"


def test_a_credit_note_is_read_by_the_organisation_and_linked_from_its_invoice(ready):
    dpa = body(generate(ready))
    placed = body(place(ready, order_body(dpa["id"])))
    assert cancel(ready, placed["order"]["id"]).status_code == 200
    page = body(
        call(
            ready.client.get(
                url(CREDIT_NOTES, organisation_id=ready.alpha.id), **auth(ready.owner)
            ),
            CREDIT_NOTES,
            "get",
        )
    )
    (note,) = page["data"]
    assert page["has_more"] is False
    # Another organisation's credit note is not in the list.
    foreign = body(generate(ready, who=ready.foreigner, organisation=ready.bravo))
    theirs = body(
        place(
            ready,
            order_body(foreign["id"], slug="bravo-tenant"),
            who=ready.foreigner,
            organisation=ready.bravo,
            key="order-key-000000009",
        )
    )
    assert (
        cancel(
            ready, theirs["order"]["id"], who=ready.foreigner, key="cancel-key-000000003"
        ).status_code
        == 200
    )
    again = body(
        call(
            ready.client.get(
                url(CREDIT_NOTES, organisation_id=ready.alpha.id), **auth(ready.owner)
            ),
            CREDIT_NOTES,
            "get",
        )
    )
    assert [row["id"] for row in again["data"]] == [note["id"]]
    assert (note["invoice_id"], note["reason"]) == (
        placed["invoice"]["id"],
        "customer_cancellation",
    )
    assert note["invoice_number"] == placed["invoice"]["number"]
    assert note["number"].startswith("AV-TST-")
    assert note["total_incl_vat"] == placed["invoice"]["total_incl_vat"]
    for who in (ready.owner, ready.admin, ready.billing):
        one = call(
            ready.client.get(url(CREDIT_NOTE, credit_note_id=note["id"]), **auth(who)),
            CREDIT_NOTE,
            "get",
        )
        assert body(one) == note
    invoice = call(
        ready.client.get(url(INVOICE, invoice_id=placed["invoice"]["id"]), **auth(ready.owner)),
        INVOICE,
        "get",
    )
    assert body(invoice)["credit_note_id"] == note["id"]
    # Another organisation cannot tell it exists; a member holds no invoice read.
    problem(
        ready.client.get(url(CREDIT_NOTE, credit_note_id=note["id"]), **auth(ready.foreigner)),
        404,
        "not-found",
    )
    problem(
        ready.client.get(url(CREDIT_NOTE, credit_note_id=note["id"]), **auth(ready.member)),
        403,
        "forbidden",
    )
    problem(
        ready.client.get(url(CREDIT_NOTE, credit_note_id=uuid4()), **auth(ready.owner)),
        404,
        "not-found",
    )
    problem(ready.client.get(url(CREDIT_NOTE, credit_note_id=note["id"])), 401, "unauthenticated")
