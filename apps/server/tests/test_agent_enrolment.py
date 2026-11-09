"""A tenant agent enrolled and revoked by a staff operator's command (ADR-0016), on the real database.

The token the command writes must authenticate on the Agent API's own check, reach no output and
no audit row, and stop authenticating once the credential is revoked.
"""

import os
import stat
import sys
from types import SimpleNamespace
from uuid import UUID

import pytest
from django.core.management import load_command_class
from django.core.management.base import CommandError
from django.utils import timezone
from test_customer_persistence_models import anchor, anchor_models

from apps.audit.models import AuditEvent
from apps.engine_intents import services
from apps.engine_intents.models import EngineAgentCredential
from apps.identity.models import Identity, StaffRole, User
from apps.tenancy.models import Tenant

pytestmark = pytest.mark.django_db(transaction=True)

STAFF_ISSUER = "https://identity.staff.test/realms/kodera-staff"


def staff(subject, *, roles=("staff_operator",)):
    user = User.objects.create(email=f"{subject}@staff.test", enabled=True)
    identity = Identity.objects.create(
        user=user,
        organisation=None,
        issuer=STAFF_ISSUER,
        realm="kodera-staff",
        subject=subject,
        email=f"{subject}@staff.test",
        enabled=True,
    )
    for role in roles:
        StaffRole.objects.create(identity=identity, realm="kodera-staff", role=role)
    return identity


def tenant(organisation, slug, status="active"):
    return Tenant.objects.create(
        organisation=organisation,
        slug=slug,
        name=slug,
        status=status,
        status_changed_at=timezone.now(),
        pack_code="pilot",
        capacity_tier_code="s",
        apps=["visio"],
    )


@pytest.fixture
def w(tmp_path):
    models = anchor_models()
    organisation, _, _ = anchor(models, slug="alpha")
    other, _, _ = anchor(models, slug="bravo")
    return SimpleNamespace(
        organisation=organisation,
        other=other,
        operator=staff("operator"),
        reader=staff("reader", roles=("staff_support",)),
        tenant=tenant(organisation, "alpha-visio"),
        foreign_tenant=tenant(other, "bravo-visio"),
        token_file=tmp_path / "agent.token",
    )


def run(capsys, name, *argv):
    """The command as `manage.py` runs it: (exit status, out, err)."""
    command = load_command_class("apps.engine_intents", name)
    options = vars(command.create_parser("manage.py", name).parse_args(list(argv)))
    positional = options.pop("args", ())
    capsys.readouterr()
    try:
        command.execute(*positional, **options)
        code = 0
    except CommandError as error:
        sys.stderr.write(f"CommandError: {error}\n")
        code = error.returncode
    out, err = capsys.readouterr()
    return code, out, err


def enrol(capsys, w, *extra, identity=None, organisation="alpha"):
    identity = identity or w.operator
    return run(
        capsys,
        "enrol_tenant_agent",
        "--staff-identity",
        str(identity.id),
        "--organisation",
        organisation,
        "--token-file",
        str(w.token_file),
        *extra,
    )


def field(out, name):
    return dict(part.split("=", 1) for part in out.split() if "=" in part)[name]


def test_an_operator_enrols_an_agent_whose_token_authenticates(capsys, w):
    code, out, err = enrol(capsys, w, "--tenant", str(w.tenant.id))
    assert (code, err) == (0, "")
    assert "outcome=enrolled" in out
    credential_id = UUID(field(out, "credential"))

    token = w.token_file.read_text().strip()
    assert token.startswith(f"eac1_{credential_id}_")
    assert stat.S_IMODE(os.stat(w.token_file).st_mode) == 0o600
    assert token not in out
    found = services.authenticate(token)
    assert found is not None and found.id == credential_id
    assert found.organisation_id == w.organisation.id and found.tenant_ref == w.tenant.id

    row = AuditEvent.objects.get(action="agent.enrolled")
    assert row.actor_id == w.operator.id and row.organisation_id == w.organisation.id
    assert row.target_urn == f"urn:kodera:agent:{credential_id}"
    assert row.metadata == {"tenant_id": str(w.tenant.id)}
    secret = token.removeprefix(f"eac1_{credential_id}_")
    assert len(secret) >= 32 and secret not in str(row.metadata) + row.target_urn


def test_an_agent_without_a_tenant_is_enrolled_for_the_organisation(capsys, w):
    code, out, _ = enrol(capsys, w)
    assert code == 0 and "tenant=-" in out
    assert EngineAgentCredential.objects.get().tenant_ref is None


@pytest.mark.parametrize(
    ("case", "reason"),
    [
        ("no-operator-grant", "holds no current staff_operator grant"),
        ("unknown-organisation", "no organisation has that slug"),
        ("foreign-tenant", "the organisation has no tenant with that id"),
        ("deleted-tenant", "the tenant is deleted"),
        ("existing-file", "cannot create the token file"),
    ],
)
def test_a_refusal_writes_no_credential_no_audit_row_and_no_file(capsys, w, case, reason):
    extra, identity, organisation = [], None, "alpha"
    if case == "no-operator-grant":
        identity = w.reader
    elif case == "unknown-organisation":
        organisation = "charlie"
    elif case == "foreign-tenant":
        extra = ["--tenant", str(w.foreign_tenant.id)]
    elif case == "deleted-tenant":
        Tenant.objects.filter(id=w.tenant.id).update(status="deleted")
        extra = ["--tenant", str(w.tenant.id)]
    elif case == "existing-file":
        w.token_file.write_text("someone else's file\n")

    code, out, err = enrol(capsys, w, *extra, identity=identity, organisation=organisation)

    assert code == 1, out
    assert reason in err and "nothing written" in err
    assert "outcome=refused" in out
    assert not EngineAgentCredential.objects.exists()
    assert not AuditEvent.objects.filter(action__startswith="agent.").exists()
    if case == "existing-file":
        assert w.token_file.read_text() == "someone else's file\n"
    else:
        assert not w.token_file.exists()


def test_a_failed_write_leaves_no_credential(capsys, w, monkeypatch):
    def broken(_descriptor):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(os, "fsync", broken)
    with pytest.raises(OSError, match="No space left"):
        enrol(capsys, w)
    assert not EngineAgentCredential.objects.exists()
    assert not AuditEvent.objects.filter(action__startswith="agent.").exists()
    assert not w.token_file.exists()


def revoke(capsys, w, credential_id, *, identity=None, organisation="alpha"):
    identity = identity or w.operator
    return run(
        capsys,
        "revoke_tenant_agent",
        "--staff-identity",
        str(identity.id),
        "--organisation",
        organisation,
        "--credential",
        str(credential_id),
    )


def test_a_revoked_credential_stops_authenticating(capsys, w):
    _, out, _ = enrol(capsys, w, "--tenant", str(w.tenant.id))
    credential_id = UUID(field(out, "credential"))
    token = w.token_file.read_text().strip()

    code, out, err = revoke(capsys, w, credential_id)

    assert (code, err) == (0, "") and "outcome=revoked" in out
    assert services.authenticate(token) is None
    row = AuditEvent.objects.get(action="agent.revoked")
    assert row.actor_id == w.operator.id
    assert row.target_urn == f"urn:kodera:agent:{credential_id}"
    assert row.metadata == {"tenant_id": str(w.tenant.id)}


@pytest.mark.parametrize(
    ("case", "reason"),
    [
        ("no-operator-grant", "holds no current staff_operator grant"),
        ("other-organisation", "the organisation has no agent credential with that id"),
        ("already-revoked", "the agent credential is not active"),
    ],
)
def test_a_refused_revocation_changes_nothing(capsys, w, case, reason):
    _, out, _ = enrol(capsys, w)
    credential_id = UUID(field(out, "credential"))
    token = w.token_file.read_text().strip()
    identity, organisation = None, "alpha"
    if case == "no-operator-grant":
        identity = w.reader
    elif case == "other-organisation":
        organisation = "bravo"
    elif case == "already-revoked":
        services.revoke_credential(credential_id=credential_id)

    code, out, err = revoke(capsys, w, credential_id, identity=identity, organisation=organisation)

    assert code == 1 and reason in err and "outcome=refused" in out
    assert not AuditEvent.objects.filter(action="agent.revoked").exists()
    if case != "already-revoked":
        assert services.authenticate(token) is not None


def test_the_service_itself_refuses_a_principal_with_no_operator_grant(w):
    """The commands check the grant first (principal_for); the service checks it again, locked,
    so a revocation cannot land between that check and the change. Driven here alone."""
    from apps.engine_intents.enrolment import EnrolmentRefusedError, enrol_agent, revoke_agent
    from apps.identity.command_principal import staff_principal_for_command

    reader = staff_principal_for_command(w.reader.id)
    with pytest.raises(EnrolmentRefusedError, match="no current staff_operator grant"):
        enrol_agent(principal=reader, organisation_id=w.organisation.id, tenant_id=None)
    credential_id, _ = services.issue_credential(organisation_id=w.organisation.id)
    with pytest.raises(EnrolmentRefusedError, match="no current staff_operator grant"):
        revoke_agent(
            principal=reader, organisation_id=w.organisation.id, credential_id=credential_id
        )
    assert EngineAgentCredential.objects.get(id=credential_id).state == "active"
    assert not AuditEvent.objects.filter(action__startswith="agent.").exists()
