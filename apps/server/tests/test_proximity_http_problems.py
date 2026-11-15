"""Token refusals conform to the canonical customer error registry without a database."""

import json
from pathlib import Path

import jsonschema_rs
import pytest
import yaml

CONTRACT = Path(__file__).resolve().parents[3] / "packages/api-contract/core-api.openapi.yaml"


@pytest.mark.parametrize(
    ("kind", "reason"),
    [
        ("invalid-proximity-proof", "invalid_beacon_proof"),
        ("expired-proximity-token", "token_epoch_expired"),
    ],
)
def test_token_refusals_use_canonical_problem_type_without_losing_reason(kind, reason):
    from apps.proximity.api.http import problem_response
    from apps.proximity.services import ProximityRefusalError

    document = yaml.safe_load(CONTRACT.read_text())
    response = problem_response(ProximityRefusalError(422, kind=kind, reason=reason), "request-123")
    body = json.loads(response.content)
    schema = document["paths"]["/proximity/checkin"]["post"]["responses"]["422"]["content"][
        "application/problem+json"
    ]["schema"]
    jsonschema_rs.validator_for({**schema, "components": document["components"]}).validate(body)
    assert response.status_code == body["status"] == 422
    assert body["reason"] == reason
