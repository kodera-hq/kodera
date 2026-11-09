"""Real synthetic signatures exercise the admitted profile, never mock jwt.decode."""

import base64
import dataclasses
import json
from datetime import UTC, datetime

import jwt
import pytest
import time_machine
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from services.identity.access_tokens import (
    IssuerKeySnapshot,
    TokenVerificationError,
    VerifiedAccessToken,
    evaluate_registered_factor,
    verify_access_token,
)

NOW = 2_000_000_000
ISSUER = "https://identity.invalid/realms/synthetic"


@pytest.fixture(autouse=True)
def frozen_clock():
    with time_machine.travel(datetime.fromtimestamp(NOW, UTC), tick=False):
        yield


@pytest.fixture(params=["RS256", "ES256"])
def signer(request):
    algorithm = request.param
    key = (
        rsa.generate_private_key(public_exponent=65537, key_size=2048)
        if algorithm == "RS256"
        else ec.generate_private_key(ec.SECP256R1())
    )
    method = jwt.algorithms.RSAAlgorithm if algorithm == "RS256" else jwt.algorithms.ECAlgorithm
    public = json.loads(method.to_jwk(key.public_key()))
    public.update(kid="synthetic-key", alg=algorithm, use="sig", key_ops=["verify"])
    return key, algorithm, public


def snapshot(keys, **overrides):
    return IssuerKeySnapshot.from_jwks(
        json.dumps({"keys": keys}).encode(),
        issuer=ISSUER,
        generation="synthetic-generation",
        expires_at=NOW + 600,
        **overrides,
    )


def claims(**changes):
    # `azp` is the web console's client, one the customer lane admits by default
    # (services/identity/trusted_issuers.py DEFAULT_ALLOWED_AZP); a test of its absence drops it.
    return {
        "iss": ISSUER,
        "sub": "exact-SUBJECT",
        "aud": "kodera-server",
        "iat": NOW,
        "exp": NOW + 300,
        "typ": "Bearer",
        "azp": "console",
        **changes,
    }


def sign(signer, payload=None, headers=None):
    key, algorithm, public = signer
    return jwt.encode(
        payload if payload is not None else claims(),
        key,
        algorithm=algorithm,
        headers={"kid": public["kid"], **(headers or {})},
    )


def refused(token, admitted):
    with pytest.raises(TokenVerificationError) as error:
        verify_access_token(token, admitted=admitted)
    assert str(error.value) == "access token refused"
    assert token not in str(error.value)
    assert error.value.__cause__ is None


def test_valid_access_evidence_is_immutable_and_grants_no_authority(signer):
    token = sign(signer, claims(realm_access={"roles": ["admin"]}))
    result = verify_access_token(token, admitted=snapshot([signer[2]]))
    assert result.issuer == ISSUER and result.subject == "exact-SUBJECT"
    assert result.audience == ("kodera-server",)
    assert result.amr is None and result.acr is None and result.auth_time is None
    assert not any(
        hasattr(result, field)
        for field in ("roles", "is_staff", "is_authenticated", "organisation")
    )
    assert token not in repr(result) and "exact-SUBJECT" not in repr(result)
    with pytest.raises(dataclasses.FrozenInstanceError):
        result.subject = "changed"


@pytest.mark.parametrize("fact", [True, False, "absent"])
def test_signed_contact_projection_is_boolean_and_optional(signer, fact):
    payload = claims() if fact == "absent" else claims(email_verified=fact)
    result = verify_access_token(sign(signer, payload), admitted=snapshot([signer[2]]))
    assert result.email_verified is (False if fact == "absent" else fact)
    assert result.profile == "keycloak-bearer-v1"


@pytest.mark.parametrize("fact", [None, 0, 1, "true", "false", [], {}, 1.0])
def test_signed_contact_projection_refuses_coercion(signer, fact):
    refused(sign(signer, claims(email_verified=fact)), snapshot([signer[2]]))


@pytest.mark.parametrize("fact", [True, False, None, 0, 1, "true", [], {}, 1.0])
def test_registered_factor_projection_is_strict_but_wrong_types_do_not_invalidate(signer, fact):
    result = verify_access_token(
        sign(signer, claims(azp="console-client", kodera_mfa_enrolled=fact)),
        admitted=snapshot([signer[2]]),
    )
    assert result.authorized_party == "console-client"
    assert result.mfa_enrolled is (fact if type(fact) is bool else None)


def test_verified_far_future_expiry_is_bounded_before_datetime_conversion(signer):
    verified = verify_access_token(
        sign(
            signer,
            claims(
                exp=253402300799,
                email_verified=True,
                azp="console-client",
                amr=["otp"],
                kodera_mfa_enrolled=True,
            ),
        ),
        admitted=snapshot([signer[2]]),
    )
    result = evaluate_registered_factor(
        verified=verified,
        lane="customer",
        console_client_id="console-client",
        database_now=datetime.fromtimestamp(NOW, UTC),
    )
    assert result.value is True
    assert result.horizon == datetime.fromtimestamp(NOW + 290, UTC)


@pytest.mark.parametrize("party", [None, 1, True, [], {}])
def test_authorized_party_wrong_types_are_unknown_without_invalidating_token(signer, party):
    result = verify_access_token(sign(signer, claims(azp=party)), admitted=snapshot([signer[2]]))
    assert result.authorized_party is None


def test_registered_factor_duplicate_member_is_refused_with_a_valid_signature(signer):
    key, algorithm, public = signer
    payload = json.dumps(claims(kodera_mfa_enrolled=True), separators=(",", ":"))
    duplicated = payload.replace(
        '"kodera_mfa_enrolled":true',
        '"kodera_mfa_enrolled":true,"kodera_mfa_enrolled":false',
    )
    header = json.dumps(
        {"alg": algorithm, "kid": public["kid"], "typ": "JWT"}, separators=(",", ":")
    )

    def encode(raw):
        return base64.urlsafe_b64encode(raw.encode()).rstrip(b"=").decode()

    signing_input = encode(header) + "." + encode(duplicated)
    signature = jwt.algorithms.get_default_algorithms()[algorithm].sign(signing_input.encode(), key)
    compact = signing_input + "." + base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
    refused(compact, snapshot([public]))


def test_contact_projection_retains_existing_positional_profile():
    positional = VerifiedAccessToken(
        ISSUER,
        "person",
        ("kodera-server",),
        NOW,
        NOW + 300,
        None,
        None,
        None,
        None,
        "existing-explicit-profile",
    )
    assert positional.profile == "existing-explicit-profile"
    assert positional.email_verified is False
    assert positional.authorized_party is None and positional.mfa_enrolled is None


def test_signed_contact_projection_cannot_use_an_altered_unsigned_fact(signer):
    token = sign(signer, claims(email_verified=False))
    parts = token.split(".")
    payload = claims(email_verified=True)
    parts[1] = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    refused(".".join(parts), snapshot([signer[2]]))


def test_contact_projection_type_guard_has_a_meaningful_weakening(signer, monkeypatch):
    from services.identity import access_tokens

    token = sign(signer, claims(email_verified="true"))
    admitted = snapshot([signer[2]])
    refused(token, admitted)
    monkeypatch.setattr(
        access_tokens,
        "_verified_contact",
        lambda payload: bool(payload.get("email_verified", False)),
    )
    assert verify_access_token(token, admitted=admitted).email_verified is True


def test_wrong_signature_fails(signer):
    parts = sign(signer).split(".")
    raw = bytearray(base64.urlsafe_b64decode(parts[2] + "=" * (-len(parts[2]) % 4)))
    raw[0] ^= 1
    parts[2] = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    refused(".".join(parts), snapshot([signer[2]]))


@pytest.mark.parametrize(
    "changes",
    [
        {"iss": ISSUER + "/"},
        {"iss": "https://attacker.invalid/"},
        {"sub": ""},
        {"sub": 1},
        {"aud": "console"},
        {"aud": []},
        {"aud": ["kodera-server", 7]},
        {"typ": "ID"},
        {"typ": "Refresh"},
        {"typ": None},
        {"exp": NOW - 30},
        {"iat": NOW + 31},
        {"nbf": NOW + 31},
        {"exp": NOW},
        {"nbf": NOW + 300},
        {"amr": "mfa"},
        {"amr": [1]},
        {"acr": 1},
    ],
)
def test_signed_invalid_claims_refuse(signer, changes):
    refused(sign(signer, claims(**changes)), snapshot([signer[2]]))


@pytest.mark.parametrize(
    "value", [True, "2000000000", 2_000_000_000.0, None, NOW + 31, NOW + 10**6, [NOW]]
)
def test_signed_auth_time_is_carried_unjudged_for_the_database_guard(signer, value):
    # Owner-claim consumption judges `auth_time` on the database clock and answers `403
    # mfa-required`; the verifier keeps the signature and never refuses on this claim's shape.
    result = verify_access_token(
        sign(signer, claims(auth_time=value)), admitted=snapshot([signer[2]])
    )
    # A JSON container is not carried (the token stays hashable); like absence, it is no login time.
    assert result.auth_time == (None if isinstance(value, list) else value)


@pytest.mark.parametrize("field", ["iat", "exp", "nbf"])
@pytest.mark.parametrize("value", [True, "2000000000", 2_000_000_000.0, None])
def test_time_coercion_refuses(signer, field, value):
    refused(sign(signer, claims(**{field: value})), snapshot([signer[2]]))


@pytest.mark.parametrize("field", ["iss", "sub", "aud", "typ", "iat", "exp"])
def test_missing_required_claim_refuses(signer, field):
    payload = claims()
    del payload[field]
    refused(sign(signer, payload), snapshot([signer[2]]))


@pytest.mark.parametrize(
    "changes",
    [
        {"iat": NOW - 100, "exp": NOW - 29},
        {"iat": NOW + 30},
        {"nbf": NOW + 30},
        {"aud": ["console", "kodera-server"]},
        {"amr": ["pwd"], "acr": "0", "auth_time": NOW},
    ],
)
def test_valid_boundary_and_multi_audience(signer, changes):
    assert verify_access_token(sign(signer, claims(**changes)), admitted=snapshot([signer[2]]))


@pytest.mark.parametrize(
    "headers",
    [
        {"jku": "https://attacker.invalid/keys"},
        {"x5u": "https://attacker.invalid"},
        {"jwk": {}},
        {"crit": ["unsupported"]},
        {"b64": False},
        {"kid": "x" * 129},
        {"kid": ""},
        {"kid": "different"},
    ],
)
def test_untrusted_header_refuses_without_fetch(signer, headers, monkeypatch):
    import socket

    monkeypatch.setattr(
        socket, "create_connection", lambda *a, **k: pytest.fail("verifier performed network I/O")
    )
    refused(sign(signer, headers=headers), snapshot([signer[2]]))


def test_none_and_hmac_refuse(signer):
    for algorithm, key in [("none", ""), ("HS256", "synthetic-symmetric-key-with-adequate-length")]:
        token = jwt.encode(claims(), key, algorithm=algorithm, headers={"kid": "synthetic-key"})
        refused(token, snapshot([signer[2]]))


@pytest.mark.parametrize(
    "mutation",
    [
        "duplicate_header",
        "duplicate_payload",
        "bad_base64",
        "oversize",
        "extra_segment",
        "nonobject",
    ],
)
def test_strict_compact_json_refuses(signer, mutation):
    parts = sign(signer).split(".")
    if mutation.startswith("duplicate"):
        index = 0 if mutation == "duplicate_header" else 1
        duplicate = '"alg":"none",' if index == 0 else '"sub":"other",'
        data = base64.urlsafe_b64decode(parts[index] + "=" * (-len(parts[index]) % 4)).decode()
        parts[index] = (
            base64.urlsafe_b64encode(("{" + duplicate + data[1:]).encode()).rstrip(b"=").decode()
        )
    elif mutation == "bad_base64":
        parts[0] += "!"
    elif mutation == "oversize":
        parts = sign(signer, claims(extra="x" * 16384)).split(".")
    elif mutation == "extra_segment":
        parts.append("A")
    else:
        parts[1] = "W10"
    if mutation.startswith("duplicate"):
        signing_input = ".".join(parts[:2]).encode("ascii")
        signature = jwt.algorithms.get_default_algorithms()[signer[1]].sign(
            signing_input, signer[0]
        )
        parts[2] = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
        # The malformed-JSON probe has a VALID signature: disabling duplicate
        # refusal must not be masked by an incidental signature failure.
        jwt.decode(
            ".".join(parts),
            signer[0].public_key(),
            algorithms=[signer[1]],
            audience="kodera-server",
            issuer=ISSUER,
        )
    refused(".".join(parts), snapshot([signer[2]]))


@pytest.mark.parametrize(
    "change",
    [
        {"d": "private-material"},
        {"kty": "oct", "k": "private-material"},
        {"alg": "HS256"},
        {"key_ops": ["sign"]},
        {"use": "enc"},
        {"kid": ""},
        {"crv": "P-384"},
    ],
)
def test_ineligible_keys_refuse(signer, change):
    if change == {"crv": "P-384"} and signer[1] == "RS256":
        change = {"kty": "EC", "crv": "P-384"}
    with pytest.raises(TokenVerificationError, match="access token refused"):
        snapshot([{**signer[2], **change}])


def test_duplicate_kid_and_bounded_jwks_refuse(signer):
    for keys in ([signer[2], signer[2]], [dict(signer[2], kid=str(i)) for i in range(33)]):
        with pytest.raises(TokenVerificationError):
            snapshot(keys)
    for raw in (b'{"keys":[],"keys":[]}', b" " * (256 * 1024 + 1), b"[]", b"{bad}"):
        with pytest.raises(TokenVerificationError):
            IssuerKeySnapshot.from_jwks(raw, issuer=ISSUER, generation="g", expires_at=NOW + 600)


def test_expiry_and_explicit_rotation_have_no_hidden_cache(signer):
    old = snapshot([signer[2]])
    new_key = dict(signer[2], kid="rotated")
    rotated = sign(signer, headers={"kid": "rotated"})
    refused(rotated, old)
    fresh = snapshot([new_key])
    assert verify_access_token(rotated, admitted=fresh)
    refused(sign(signer), fresh)
    with time_machine.travel(datetime.fromtimestamp(NOW + 600, UTC), tick=False):
        refused(sign(signer, claims(iat=NOW + 600, exp=NOW + 900)), old)


def test_mixed_jwks_never_selects_encryption_key_or_reclassifies_metadata(signer):
    if signer[1] != "RS256":
        return
    encryption = dict(
        signer[2], kid="encryption-only", use="enc", alg="RSA-OAEP-256", key_ops=["encrypt"]
    )
    admitted = snapshot([signer[2], encryption])
    assert verify_access_token(sign(signer), admitted=admitted)
    refused(sign(signer, headers={"kid": "encryption-only"}), admitted)
    for change in ({"key_ops": ["verify"]}, {"alg": "RS256"}, {"use": "unknown"}, {"n": "bad"}):
        with pytest.raises(TokenVerificationError):
            snapshot([signer[2], {**encryption, **change}])


def test_weak_rsa_public_key_refuses():
    key = rsa.generate_private_key(public_exponent=65537, key_size=1024)  # noqa: S505 - deliberate refusal fixture
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    public["kid"] = "weak"
    with pytest.raises(TokenVerificationError):
        snapshot([public])


def test_oversized_valid_jwks_refuses(signer):
    raw = json.dumps({"keys": [signer[2]], "unused": "x" * (256 * 1024)}).encode()
    with pytest.raises(TokenVerificationError):
        IssuerKeySnapshot.from_jwks(raw, issuer=ISSUER, generation="g", expires_at=NOW + 600)


def test_oversized_matching_key_id_refuses(signer):
    with pytest.raises(TokenVerificationError):
        snapshot([dict(signer[2], kid="x" * 129)])
