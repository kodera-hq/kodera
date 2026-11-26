"""Per-organisation (issuer, oidc_audience) pinning precedes keys and persisted authority."""

import dataclasses
import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from django.db import IntegrityError, transaction
from test_billing_orders import world

from apps.orgs.actor_selectors import TenantCallerNotFoundError, read_tenant_caller
from apps.orgs.authority_selectors import (
    MemberAuthorityNotFoundError,
    resolve_all_member_authorities,
    resolve_member_authority,
)
from apps.orgs.detail_services import OrganisationReadForbiddenError, read_organisation
from apps.orgs.models import Organisation
from services.identity.access_tokens import (
    IssuerKeySnapshot,
    TokenVerificationError,
    verify_access_token,
)
from services.identity.trusted_issuers import (
    TrustConfigurationError,
    load_trust,
    verify_configured_token,
    verify_organisation_token,
)


@pytest.fixture
def signed_trust():
    key = ec.generate_private_key(ec.SECP256R1())
    public = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(key.public_key()))
    public.update(kid="synthetic-pinning", alg="ES256", use="sig", key_ops=["verify"])
    issuer = "https://identity.invalid/realms/synthetic-org"
    audience = "synthetic-org-api"

    def entry(**changes):
        return {
            "lane": "customer",
            "issuer": issuer,
            "audience": audience,
            "generation": "synthetic-pinning",
            "expires_at": int(time.time()) + 600,
            "public_jwks": {"keys": [public]},
            **changes,
        }

    def sign(**changes):
        claims = {
            "iss": issuer,
            "sub": "synthetic-owner",
            "aud": audience,
            "iat": int(time.time()),
            "exp": int(time.time()) + 300,
            "typ": "Bearer",
            "azp": "console",
            **changes,
        }
        return jwt.encode(claims, key, algorithm="ES256", headers={"kid": public["kid"]})

    return entry, sign, issuer, audience


def test_custom_audience_is_bound_in_snapshot_and_token_verification(signed_trust):
    entry, sign, issuer, audience = signed_trust
    config = entry()
    snapshot = IssuerKeySnapshot.from_jwks(
        json.dumps(config["public_jwks"]).encode(),
        issuer=issuer,
        expected_audience=audience,
        generation="synthetic-pinning",
        expires_at=config["expires_at"],
    )
    assert snapshot.expected_audience == audience
    assert verify_access_token(sign(), admitted=snapshot, expected_audience=audience).audience == (
        audience,
    )
    with pytest.raises(TokenVerificationError):
        verify_access_token(sign(), admitted=snapshot)
    with pytest.raises(TokenVerificationError):
        verify_access_token(
            sign(aud="kodera-server"), admitted=snapshot, expected_audience=audience
        )


def test_trust_defaults_to_existing_audience_and_accepts_explicit_pins(signed_trust):
    entry, sign, issuer, audience = signed_trust
    legacy = entry()
    del legacy["audience"]
    trusted = load_trust(json.dumps([legacy, entry()]))
    assert [t.audience for t in trusted] == ["kodera-server", audience]
    assert verify_configured_token(sign(), trusted=trusted)[0].audience == (audience,)
    assert (
        verify_organisation_token(
            sign(), trusted=trusted, expected_issuer=issuer, expected_audience=audience
        )[0].issuer
        == issuer
    )
    with pytest.raises(TrustConfigurationError):
        load_trust(json.dumps([entry(), entry()]))


@pytest.mark.parametrize(
    "audience", [None, 1, "", " ", "has space", "has\ttab", "é", "x" * 256, "x\n"]
)
def test_trust_rejects_invalid_audience(signed_trust, audience):
    entry, _, _, _ = signed_trust
    with pytest.raises(TrustConfigurationError):
        load_trust(json.dumps([entry(audience=audience)]))


@pytest.mark.parametrize("mismatch", ["issuer", "audience", "staff"])
def test_pinned_pair_selects_no_foreign_keys_before_signature_work(
    signed_trust, monkeypatch, mismatch
):
    entry, sign, issuer, audience = signed_trust
    changes = (
        {"issuer": issuer + "-foreign"}
        if mismatch == "issuer"
        else ({"audience": "foreign-api"} if mismatch == "audience" else {"lane": "staff"})
    )
    trusted = load_trust(json.dumps([entry(**changes)]))

    def forbidden(*args, **kwargs):
        raise AssertionError("foreign trust entry reached signature verification")

    monkeypatch.setattr("services.identity.trusted_issuers.verify_access_token", forbidden)
    monkeypatch.setattr("services.identity.trusted_issuers.unverified_issuer", forbidden)
    with pytest.raises(TokenVerificationError):
        verify_organisation_token(
            sign(), trusted=trusted, expected_issuer=issuer, expected_audience=audience
        )


def test_organisation_pin_refuses_cross_realm_claims_even_with_shared_signing_key(
    signed_trust, monkeypatch
):
    entry, sign, issuer, audience = signed_trust
    community_issuer = "https://identity.invalid/realms/community"
    trusted = load_trust(json.dumps([entry(issuer=community_issuer), entry()]))

    def forbidden(*args):
        raise AssertionError("organisation verification routed by unverified claims")

    monkeypatch.setattr("services.identity.trusted_issuers.unverified_issuer", forbidden)
    with pytest.raises(TokenVerificationError):
        verify_organisation_token(
            sign(iss=community_issuer),
            trusted=trusted,
            expected_issuer=issuer,
            expected_audience=audience,
        )
    with pytest.raises(TokenVerificationError):
        verify_organisation_token(
            sign(azp="foreign-client"),
            trusted=trusted,
            expected_issuer=issuer,
            expected_audience=audience,
        )
    assert verify_organisation_token(
        sign(aud=["extra-api", audience]),
        trusted=trusted,
        expected_issuer=issuer,
        expected_audience=audience,
    )[0].audience == ("extra-api", audience)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("audience", ["", " ", "a b", "a\tb", "a\nb", "é", "x" * 256, "x\x7f"])
def test_database_rejects_non_printable_or_whitespace_audience(audience):
    w = world()
    with pytest.raises(IntegrityError), transaction.atomic():
        Organisation.objects.filter(pk=w.organisation.id).update(oidc_audience=audience)
    w.organisation.refresh_from_db()
    assert w.organisation.oidc_audience == "kodera-server"


@pytest.mark.django_db(transaction=True)
def test_all_authority_readers_require_the_organisation_pinned_audience():
    w = world()
    Organisation.objects.filter(pk=w.organisation.id).update(oidc_audience="synthetic-pinned-api")
    with transaction.atomic(), pytest.raises(TenantCallerNotFoundError):
        read_tenant_caller(verified=w.token, organisation_id=w.organisation.id)
    with pytest.raises(MemberAuthorityNotFoundError):
        resolve_member_authority(verified=w.token, organisation_id=w.organisation.id)
    with pytest.raises(MemberAuthorityNotFoundError):
        resolve_all_member_authorities(verified=w.token)
    with pytest.raises(OrganisationReadForbiddenError):
        read_organisation(verified=w.token, target_id=w.organisation.id)
    verified = dataclasses.replace(w.token, audience=("extra-api", "synthetic-pinned-api"))
    with transaction.atomic():
        assert (
            read_tenant_caller(verified=verified, organisation_id=w.organisation.id).organisation_id
            == w.organisation.id
        )
    assert resolve_member_authority(verified=verified).organisation_id == w.organisation.id
    assert (
        resolve_all_member_authorities(verified=verified)[0][0].organisation_id == w.organisation.id
    )
    assert read_organisation(verified=verified, target_id=w.organisation.id) is not None


@pytest.mark.django_db(transaction=True)
def test_resolved_organisation_selects_its_exact_verifier(signed_trust):
    entry, sign, _, audience = signed_trust
    w = world()
    Organisation.objects.filter(pk=w.organisation.id).update(oidc_audience=audience)
    w.organisation.refresh_from_db()
    trusted = load_trust(json.dumps([entry(issuer=w.organisation.issuer)]))
    verified, lane = verify_organisation_token(
        sign(iss=w.organisation.issuer, sub=w.token.subject),
        trusted=trusted,
        expected_issuer=w.organisation.issuer,
        expected_audience=w.organisation.oidc_audience,
    )
    assert lane == "customer"
    assert resolve_member_authority(verified=verified).organisation_id == w.organisation.id
    with pytest.raises(TokenVerificationError):
        verify_organisation_token(
            sign(iss=w.organisation.issuer, aud="other-api"),
            trusted=trusted,
            expected_issuer=w.organisation.issuer,
            expected_audience=w.organisation.oidc_audience,
        )


@pytest.mark.django_db(transaction=True)
def test_saml_session_uses_live_custom_organisation_audience(monkeypatch):
    from pathlib import Path

    # Exercise the optional commercial extension when present in the monorepo checkout.
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[3]))
    from django.test import RequestFactory

    auth = pytest.importorskip("ee.auth")

    w = world()
    Organisation.objects.filter(pk=w.organisation.id).update(oidc_audience="custom-saml-api")
    compact = auth.issue_ee_saml_session_token(
        issuer=w.token.issuer,
        subject=w.token.subject,
        user_id=w.owner.user_id,
        organisation_id=w.organisation.id,
        tenant_slug=w.organisation.slug,
    )
    verified = auth.verify_ee_saml_session_token(compact)
    assert verified.audience == ("custom-saml-api",)
    request = RequestFactory().get("/", HTTP_AUTHORIZATION=f"Bearer {compact}")
    assert auth.authenticate_tenant_request(request).organisation_id == w.organisation.id
    Organisation.objects.filter(pk=w.organisation.id).update(oidc_audience="changed-saml-api")
    with pytest.raises(TokenVerificationError):
        auth.verify_ee_saml_session_token(compact)
    with pytest.raises(TokenVerificationError):
        auth.issue_ee_saml_session_token(
            issuer="https://wrong.invalid/realms/customer",
            subject=w.token.subject,
            user_id=w.owner.user_id,
            organisation_id=w.organisation.id,
            tenant_slug=w.organisation.slug,
        )


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("operation", ["preview", "accept", "replay"])
def test_invitation_audience_is_checked_before_redemption(operation, monkeypatch):
    from datetime import timedelta

    from django.utils import timezone

    from apps.orgs.invitations import (
        Accept,
        InvitationNotFoundError,
        accept,
        digest,
        format_token,
        preview,
        verify_accept_replay_authority,
    )
    from apps.orgs.models import Invitation

    w = world()
    secret = "i" * 43
    invitation = Invitation.objects.create(
        organisation=w.organisation,
        email="invitee@synthetic.invalid",
        role="org_member",
        token_digest=digest(secret),
        token_sealed=b"synthetic",
        expires_at=timezone.now() + timedelta(days=1),
        invited_by_user_id=w.owner.user_id,
        invited_by_identity_id=w.owner.id,
        issued_at=timezone.now(),
    )
    token = format_token(invitation.id, secret)
    verified = dataclasses.replace(w.token, audience=("wrong-api",), email_verified=True)

    def redeem(credential):
        if operation == "preview":
            preview(verified=credential, lane="customer", token=token)
        elif operation == "accept":
            with transaction.atomic():
                accept(
                    verified=credential,
                    lane="customer",
                    request=Accept(token, None, False),
                    request_id="r-pin",
                )
        else:
            verify_accept_replay_authority(
                verified=credential,
                lane="customer",
                request=Accept(token, None, False),
                stored_status=200,
            )

    class AudienceBoundaryPassedError(Exception):
        pass

    def reached_identity_lookup(**kwargs):
        raise AudienceBoundaryPassedError()

    monkeypatch.setattr("apps.orgs.invitations.known_subject", reached_identity_lookup)
    with pytest.raises(InvitationNotFoundError):
        redeem(verified)
    # Refusal control: the same syntactically valid invitation with the pinned audience
    # crosses the boundary and reaches identity eligibility instead of failing on its token.
    with pytest.raises(AudienceBoundaryPassedError):
        redeem(dataclasses.replace(verified, audience=w.token.audience))


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("reader", ["customer", "directory"])
@pytest.mark.parametrize("audience", ["kodera-server", "synthetic-read-api"])
def test_customer_and_directory_reads_use_the_verified_audience(reader, audience):
    from apps.identity.services import CustomerReadForbiddenError, read_customer
    from apps.orgs.membership_services import DirectoryForbiddenError, read_directory

    w = world()
    Organisation.objects.filter(pk=w.organisation.id).update(oidc_audience=audience)

    def read(verified):
        if reader == "customer":
            return read_customer(verified=verified, lane="customer", console_client_id="console")
        return read_directory(
            verified=verified, target=str(w.organisation.id), raw_query="", signing_input="17" * 32
        )

    error = CustomerReadForbiddenError if reader == "customer" else DirectoryForbiddenError
    with pytest.raises(error):
        read(dataclasses.replace(w.token, audience=("wrong-api",)))
    assert read(dataclasses.replace(w.token, audience=("extra-api", audience))) is not None
