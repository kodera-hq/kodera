"""Proposed actual-source acceptance; execution requires a separate disposable-DB lease."""

from uuid import UUID

import pytest
from owner_claim_fixtures import (
    arguments,
    bind,
    owner_world as owner_world,
    written,
)
from test_operator_realm_bootstrap import http_signer as http_signer, w as w

from apps.orgs import claim_configuration as configuration

ORG = UUID("018f1234-5678-7abc-8def-0123456789ab")
OTHER = UUID("018f1234-5678-7abc-8def-0123456789ac")
BASE = "https://app.localhost/deployment/claim"
ORIGINS = frozenset({"https://app.localhost"})


def link(*, base=BASE, organisation_id=ORG, slug="alpha-org", origins=ORIGINS):
    helper = getattr(configuration, "organisation_claim_link", None)
    assert callable(helper), "per-organisation link helper is absent"
    return helper(
        {"KODERA_OWNER_CLAIM_LINK": base},
        origins,
        organisation_id=organisation_id,
        slug=slug,
    )


def test_exact_two_organisation_links_preserve_prefix_and_single_trailing_join():
    assert link() == f"{BASE}/{ORG}/alpha-org"
    assert link(base=BASE + "/") == link()
    assert link(organisation_id=OTHER, slug="bravo-org") == f"{BASE}/{OTHER}/bravo-org"


@pytest.mark.parametrize("value", [str(ORG), "../bad", None, 1])
def test_identifier_requires_uuid_instance(value):
    with pytest.raises(configuration.ClaimConfigurationError):
        link(organisation_id=value)


@pytest.mark.parametrize(
    "value",
    [
        "ab",
        "a" * 21,
        "ALPHA",
        "alpha/org",
        "alpha%2forg",
        "alpha?org",
        "alpha#org",
        "alpha_org",
        "alpha\norg",
        "-alpha",
        "alpha-",
        "",
        None,
    ],
)
def test_slug_requires_persisted_model_shape(value):
    with pytest.raises(configuration.ClaimConfigurationError):
        link(slug=value)


@pytest.mark.parametrize(
    "value",
    [
        "",
        "/claim",
        "https://other.localhost/claim",
        BASE + "?x=1",
        BASE + "#x",
        BASE + "?",
        BASE + "#",
        BASE + "\n",
        "https://user:password@app.localhost/claim",
        "https://app.localhost:0/claim",
    ],
)
def test_configuration_refuses_untrusted_or_nonpath_bases(value):
    with pytest.raises(configuration.ClaimConfigurationError):
        link(base=value)


def test_unconfigured_origin_refused():
    with pytest.raises(configuration.ClaimConfigurationError):
        link(origins=frozenset())


def test_final_link_boundary_counts_suffix_not_only_base():
    suffix = f"/{ORG}/alpha-org"
    prefix = "https://app.localhost/"
    base = prefix + "x" * (2048 - len(prefix) - len(suffix))
    assert len(link(base=base)) == 2048
    with pytest.raises(configuration.ClaimConfigurationError):
        link(base=base + "x")


def test_sender_keeps_stricter_remote_http_refusal(settings):
    from apps.outbox.sender import check_link

    origins = frozenset({"http://remote.example.test"})
    settings.KODERA_MAIL_LINK_ORIGINS = origins
    candidate = link(base="http://remote.example.test/claim", origins=origins)
    assert not check_link(candidate)


def test_refusal_is_closed_and_does_not_echo_input(capsys):
    marker = "synthetic-invalid-input@marker"
    for values in ({"slug": marker}, {"base": marker}):
        with pytest.raises(configuration.ClaimConfigurationError) as refused:
            link(**values)
        assert marker not in str(refused.value)
    assert capsys.readouterr() == ("", "")


@pytest.mark.django_db(transaction=True)
def test_actual_configuration_uses_two_persisted_organisations(owner_world, settings):
    from test_operator_realm_bootstrap import intake

    from apps.orgs.models import Organisation
    from apps.orgs.owner_claims import _issuance_configuration

    settings.KODERA_OWNER_CLAIM_LINK = BASE
    view = intake(
        owner_world.recorder,
        slug="bravo-org",
        key="00000000-0000-0000-0000-000000000002",
    )
    other = Organisation.objects.get(id=view.organisation_id)
    assert other.id != owner_world.organisation.id
    assert other.slug == "bravo-org"
    for organisation in (owner_world.organisation, other):
        lifetime, actual = _issuance_configuration(organisation=organisation)
        assert lifetime.total_seconds() == 259200
        assert actual == f"{BASE}/{organisation.id}/{organisation.slug}"


def opened_delivery(outcome, settings):
    from apps.outbox.mail.seal import unseal
    from apps.outbox.models import OutboxMessage

    message = OutboxMessage.objects.get(delivery_id=outcome.delivery_id)
    opened = unseal(settings.KODERA_OUTBOX_SEAL_KEY, outcome.delivery_id, bytes(message.sealed))
    return message, opened


@pytest.mark.django_db(transaction=True)
def test_actual_bind_and_reissue_store_bound_link_and_seal_separate_token(
    owner_world,
    settings,
    capsys,
    caplog,
):
    from apps.audit.models import AuditEvent
    from apps.identity.command_principal import staff_principal_for_command
    from apps.orgs.claim_tokens import verify_claim_secret
    from apps.orgs.models import Membership, OwnerClaim
    from apps.orgs.owner_claims import reissue_owner_claim
    from apps.outbox.models import OutboxDelivery
    from apps.outbox.sender import check_link

    settings.KODERA_OWNER_CLAIM_LINK = BASE + "/"
    membership_count = Membership.objects.count()
    first = bind(owner_world)
    second = reissue_owner_claim(
        principal=staff_principal_for_command(owner_world.operator.id),
        organisation_id=owner_world.organisation.id,
        request_id="req-synthetic-link-reissue",
    )
    expected = f"{BASE}/{owner_world.organisation.id}/{owner_world.organisation.slug}"
    tokens = []
    for outcome in (first, second):
        message, opened = opened_delivery(outcome, settings)
        claim = OwnerClaim.objects.get(id=outcome.claim_id)
        assert message.link == expected and check_link(message.link)
        assert (
            OutboxDelivery.objects.get(id=outcome.delivery_id).organisation_id
            == owner_world.organisation.id
        )
        assert "?" not in message.link and "#" not in message.link
        assert opened.secret not in message.link and opened.secret not in str(message.params)
        assert verify_claim_secret(opened.secret, bytes(claim.token_hash))
        assert message.expires_at == claim.expires_at
        tokens.append(opened.secret)
    assert tokens[0] != tokens[1]
    assert OwnerClaim.objects.get(id=first.claim_id).state == "revoked"
    assert OwnerClaim.objects.get(id=second.claim_id).state == "issued"
    assert Membership.objects.count() == membership_count
    issued_metadata = list(
        AuditEvent.objects.filter(
            organisation_id=owner_world.organisation.id,
            action="owner_claim.issued",
        ).values_list("metadata", flat=True)
    )
    assert len(issued_metadata) == 2
    out, err = capsys.readouterr()
    for token in tokens:
        assert token not in out + err + caplog.text
        assert token not in str(issued_metadata)


@pytest.mark.django_db(transaction=True)
def test_derived_link_refusal_precedes_binding_and_reissue_revocation(owner_world, settings):
    from unittest.mock import patch

    from apps.identity.command_principal import staff_principal_for_command
    from apps.orgs import owner_claims
    from apps.orgs.models import OwnerClaim

    settings.KODERA_OWNER_CLAIM_LINK = "https://app.localhost/" + "x" * 2010
    before = written()
    with patch.object(
        owner_claims, "create_owner_identity", wraps=owner_claims.create_owner_identity
    ) as identity_attempt:
        with pytest.raises(owner_claims.ClaimRefusedError, match="^claim_configuration_refused$"):
            owner_claims.bind_intended_owner(**arguments(owner_world))
        identity_attempt.assert_not_called()
    assert written() == before
    settings.KODERA_OWNER_CLAIM_LINK = BASE
    first = bind(owner_world)
    before = written()
    claim_before = OwnerClaim.objects.filter(id=first.claim_id).values().get()
    settings.KODERA_OWNER_CLAIM_LINK = "https://app.localhost/" + "x" * 2010
    with patch.object(
        owner_claims, "expire_claims", wraps=owner_claims.expire_claims
    ) as expiry_attempt:
        with pytest.raises(owner_claims.ClaimRefusedError, match="^claim_configuration_refused$"):
            owner_claims.reissue_owner_claim(
                principal=staff_principal_for_command(owner_world.operator.id),
                organisation_id=owner_world.organisation.id,
                request_id="req-synthetic-invalid-link",
            )
        expiry_attempt.assert_not_called()
    assert written() == before
    assert OwnerClaim.objects.filter(id=first.claim_id).values().get() == claim_before


def _without_early_configuration_gate(original):
    """Change one actual Expr only; all collaborators and transaction code stay real."""
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(original))
    assert len(tree.body) == 1 and isinstance(tree.body[0], ast.FunctionDef)
    assert not tree.body[0].decorator_list
    removed = 0

    class RemoveGate(ast.NodeTransformer):
        def visit_Expr(self, node):  # noqa: N802 — standard AST visitor protocol
            nonlocal removed
            if (
                isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Name)
                and node.value.func.id == "_issuance_configuration"
            ):
                removed += 1
                return None
            return self.generic_visit(node)

    RemoveGate().visit(tree)
    assert removed == 1, "exactly one actual early configuration Expr must be removed"
    tree.body.insert(
        0,
        ast.ImportFrom(
            module="__future__",
            names=[ast.alias(name="annotations")],
            level=0,
        ),
    )
    namespace = dict(original.__globals__)
    exec(  # noqa: S102 — exact actual function mutant in disposable-DB acceptance
        compile(ast.fix_missing_locations(tree), "<actual-owner-function-gate-mutant>", "exec"),
        namespace,
    )
    return namespace[original.__name__]


def _require_no_prewrite_attempt(observer, label):
    if observer.call_count != 0:
        raise AssertionError(label)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    ("operation", "collaborator", "label"),
    [
        ("bind_intended_owner", "create_owner_identity", "CORE_LINK_BIND_PREWRITE_ATTEMPT"),
        ("reissue_owner_claim", "expire_claims", "CORE_LINK_REISSUE_PREWRITE_ATTEMPT"),
    ],
)
def test_actual_early_gate_mutations_fail_named_attempt_assertion(
    owner_world,
    settings,
    monkeypatch,
    operation,
    collaborator,
    label,
):
    from unittest.mock import Mock

    from apps.identity.command_principal import staff_principal_for_command
    from apps.orgs import owner_claims
    from apps.orgs.models import OwnerClaim

    if operation == "bind_intended_owner":
        supplied = arguments(owner_world)
    else:
        bind(owner_world)
        supplied = {
            "principal": staff_principal_for_command(owner_world.operator.id),
            "organisation_id": owner_world.organisation.id,
            "request_id": "req-synthetic-gate-reissue",
        }
    original = getattr(owner_claims, operation)
    settings.KODERA_OWNER_CLAIM_LINK = "https://app.localhost/" + "x" * 2010
    before = written()
    claims_before = list(
        OwnerClaim.objects.filter(
            organisation_id=owner_world.organisation.id,
        )
        .order_by("id")
        .values()
    )

    def unchanged_rows():
        assert written() == before
        assert (
            list(
                OwnerClaim.objects.filter(
                    organisation_id=owner_world.organisation.id,
                )
                .order_by("id")
                .values()
            )
            == claims_before
        )

    def refused_operation():
        with pytest.raises(owner_claims.ClaimRefusedError, match="^claim_configuration_refused$"):
            getattr(owner_claims, operation)(**supplied)

    with monkeypatch.context() as patch:
        observer = Mock(wraps=getattr(owner_claims, collaborator))
        patch.setattr(owner_claims, collaborator, observer)
        refused_operation()
        _require_no_prewrite_attempt(observer, label)
        unchanged_rows()
        # Copy actual globals after installing the delegating observer, so the
        # external call ledger survives the real transaction's rollback.
        mutant = _without_early_configuration_gate(original)
        patch.setattr(owner_claims, operation, mutant)
        observer.reset_mock()
        refused_operation()
        # Only this named ordinary behavior assertion is the intended mutant
        # refusal. Compilation, setup and service errors occur outside it.
        with pytest.raises(AssertionError, match="^" + label + "$") as caught:
            _require_no_prewrite_attempt(observer, label)
        assert str(caught.value) == label
        unchanged_rows()
    assert getattr(owner_claims, operation) is original
    with monkeypatch.context() as patch:
        observer = Mock(wraps=getattr(owner_claims, collaborator))
        patch.setattr(owner_claims, collaborator, observer)
        refused_operation()
        _require_no_prewrite_attempt(observer, label)
        unchanged_rows()
