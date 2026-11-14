"""Signed HTTP VAT status, current role fences, outage persistence and replay safety."""

import hashlib
import json

import pytest
from customer_http_fixtures import http_signer as http_signer
from test_access_tokens import frozen_clock as frozen_clock
from test_billing_http import placed as placed
from test_workspace_onboarding import call, w as w

from apps.billing import vies
from apps.billing.models import BillingProfile, ViesConsultation

pytestmark = pytest.mark.django_db(transaction=True)
TEMPLATE = "/organisations/{organisation_id}/billing/vat-status"


def request(w, who, *, method="GET", key="synthetic-vat-request-001", body=None):
    url = "/api/v1" + TEMPLATE.format(organisation_id=w.alpha.id)
    headers = {} if who is None else {"HTTP_AUTHORIZATION": "Bearer " + who.credential}
    if method == "GET":
        return w.client.get(url, **headers)
    if key is not None:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    return w.client.post(
        url,
        data=json.dumps(body or {"country_code": "DE", "vat_number": "DE000000000"}),
        content_type="application/json",
        **headers,
    )


@pytest.mark.parametrize("role", ["owner", "admin", "billing"])
def test_billing_roles_read_recorded_vat_status_without_provider_contact(
    w, placed, role, monkeypatch
):
    monkeypatch.setattr(
        vies, "consult", lambda **kwargs: pytest.fail("a status read contacted VIES")
    )
    response = call(request(w, getattr(w, role)), TEMPLATE, "get")
    assert response.status_code == 200
    assert response.json()["status"] == "not_checked"


@pytest.mark.parametrize("role", ["member", "staff"])
def test_vat_status_refuses_non_billing_and_staff_lanes(w, placed, role):
    response = call(request(w, getattr(w, role)), TEMPLATE, "get")
    assert response.status_code == 403


def test_vat_outage_is_recorded_and_same_key_replay_never_recontacts_provider(
    w, placed, monkeypatch
):
    BillingProfile.objects.filter(organisation_id=w.alpha.id).update(
        country="DE", vat_number="DE000000000"
    )
    seen = []

    def outage(**kwargs):
        seen.append(kwargs)
        return vies.Answer(
            "unavailable",
            None,
            {"outcome": "unavailable"},
            hashlib.sha256(b"synthetic-outage").hexdigest(),
        )

    monkeypatch.setattr(vies, "consult", outage)
    first = call(request(w, w.owner, method="POST"), TEMPLATE, "post")
    assert first.status_code == 200, first.content
    assert first.json()["status"] == "unavailable"
    second = call(request(w, w.owner, method="POST"), TEMPLATE, "post")
    assert second.content == first.content
    assert len(seen) == 1
    assert ViesConsultation.objects.count() == 1


def test_admin_read_role_cannot_initiate_vat_check(w, placed, monkeypatch):
    monkeypatch.setattr(vies, "consult", lambda **kwargs: pytest.fail("unauthorized VIES contact"))
    response = call(request(w, w.admin, method="POST"), TEMPLATE, "post")
    assert response.status_code == 403
