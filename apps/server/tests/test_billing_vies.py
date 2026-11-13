"""Offline VIES transport conformance and persisted outage/issue refusals."""

import json
from datetime import UTC, datetime

import pytest

from apps.billing.vies import ViesRefusedError, consult, normalise

RESPONSE = {
    "countryCode": "DE",
    "vatNumber": "000000000",
    "valid": True,
    "requestDate": "2026-11-13T12:00:00Z",
    "requestIdentifier": "synthetic-consultation",
}


def check(response=RESPONSE, status=200):
    return consult(
        country_code="DE",
        vat_number="DE000000000",
        requester="FR00000000000",
        transport=lambda body: (status, json.dumps(response).encode()),
        clock=lambda: datetime(2026, 11, 13, 12, tzinfo=UTC),
    )


def test_vies_valid_and_invalid_preserve_consultation_reference_and_digest():
    valid = check()
    assert valid.status == "valid"
    assert valid.consultation_ref == "synthetic-consultation"
    assert len(valid.response_sha256) == 64
    assert check({**RESPONSE, "valid": False}).status == "invalid"


@pytest.mark.parametrize(
    "response",
    [
        {**RESPONSE, "countryCode": "FR"},
        {**RESPONSE, "vatNumber": "000000001"},
        {**RESPONSE, "valid": "true"},
        {**RESPONSE, "requestIdentifier": ""},
        {**RESPONSE, "requestDate": "not-a-date"},
        {"errorWrappers": []},
    ],
)
def test_vies_response_mutations_never_validate_another_number_or_missing_evidence(response):
    answer = check(response)
    assert answer.status == "unavailable"
    assert answer.consultation_ref is None
    assert answer.evidence == {"outcome": "unavailable"}


def test_vies_upstream_failure_is_explicit_hold():
    def unavailable(body):
        raise TimeoutError("synthetic outage")

    answer = consult(
        country_code="DE",
        vat_number="DE000000000",
        requester="FR00000000000",
        transport=unavailable,
    )
    assert answer.status == "unavailable"
    assert check(status=503).status == "unavailable"


@pytest.mark.parametrize(
    ("country", "number", "message"),
    [
        ("US", "US000000000", "vat_country_invalid"),
        ("DE", "FR00000000000", "vat_country_mismatch"),
        ("DE", "DE123/456", "vat_number_invalid"),
    ],
)
def test_input_refusal_is_named_and_happens_before_transport(country, number, message):
    with pytest.raises(ViesRefusedError, match=message):
        normalise(country, number)


def test_greek_iso_country_maps_to_official_el_prefix():
    assert normalise("GR", "EL000000000") == ("EL", "000000000")
