"""Staff identities and staff role grants against the migrated PostgreSQL tables.

docs/specs/STAFF_IDENTITY.md §1–§4: a staff identity has no organisation and is in the staff realm;
no organisation's realm is the staff realm; a staff role is granted to a staff identity only, once
at a time, revoked once and never deleted; the customer reads never see a staff identity; and the
operator commands — a one-time bootstrap, then two-person grants and revocations, each audited —
are the only writers.
"""

import json
import os
import subprocess
import sys
import time
import uuid
from datetime import timedelta
from io import StringIO
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from django.apps import apps
from django.core.exceptions import ImproperlyConfigured
from django.core.management import CommandError, call_command
from django.db import IntegrityError, OperationalError, connection
from django.utils import timezone
from test_customer_persistence_models import (
    anchor,
    anchor_models,
    identity,
    named_refusal,
    raw_delete,
    raw_update,
)

from apps.identity import selectors, staff_roles
from config.environment import staff_issuer

ROOT = Path(__file__).resolve().parents[1]
# config.settings.test's fixed KODERA_STAFF_ISSUER.
STAFF_ISSUER = "https://identity.staff.test/realms/kodera-staff"
_KEY: list[dict] = []


def trust(*entries):
    """KODERA_AUTH_TRUST's JSON for (lane, issuer) entries, with one synthetic public key."""
    if not _KEY:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
        public.update(kid="staff-identity-fixture", alg="RS256", use="sig", key_ops=["verify"])
        _KEY.append(public)
    return json.dumps(
        [
            {
                "lane": lane,
                "issuer": issuer,
                "generation": "staff-identity-fixture",
                "expires_at": int(time.time()) + 3600,
                "public_jwks": {"keys": [_KEY[0]]},
            }
            for lane, issuer in entries
        ]
    )


@pytest.fixture(name="models")
def registered_models(transactional_db, settings):
    assert connection.vendor == "postgresql", "staff identity acceptance requires PostgreSQL"
    assert settings.KODERA_STAFF_ISSUER == STAFF_ISSUER
    found = anchor_models()
    found.StaffRole = apps.get_model("identity", "StaffRole")
    found.AuditEvent = apps.get_model("audit", "AuditEvent")
    return found


def staff_identity(models, *, subject="staff-subject", issuer=STAFF_ISSUER, realm="kodera-staff"):
    user = models.User.objects.create(email="operator@staff.test", enabled=True)
    return models.Identity.objects.create(
        user=user,
        organisation=None,
        issuer=issuer,
        realm=realm,
        subject=subject,
        email="operator@staff.test",
        enabled=True,
    )


def grant(models, principal, role="staff_operator"):
    return models.StaffRole.objects.create(identity=principal, realm="kodera-staff", role=role)


def revisions(models):
    return dict(models.Organisation.objects.values_list("id", "authority_revision"))


# ------------------------------------------------------------------------ §1 the identity ----


def test_a_staff_identity_is_stored_with_no_organisation(models):
    principal = staff_identity(models)
    stored = models.Identity.objects.get(pk=principal.pk)
    assert stored.organisation_id is None and stored.realm == "kodera-staff", (
        "a staff identity was not stored without an organisation in the staff realm"
    )


def test_an_identity_with_no_organisation_must_be_in_the_staff_realm(models):
    with named_refusal("23514", "identity_staff_realm_valid"):
        staff_identity(models, realm="alpha", issuer="https://identity.staff.test/realms/alpha")


def test_a_staff_identity_issuer_must_name_the_staff_realm(models):
    with named_refusal("23514", "identity_staff_issuer_valid"):
        staff_identity(models, issuer="https://identity.staff.test/realms/other")


def bounded_issuer(length):
    suffix = "/realms/kodera-staff"
    return "https://" + "a" * (length - len("https://") - len(suffix)) + suffix


def test_a_staff_identity_issuer_is_bounded(models):
    with named_refusal("23514", "identity_staff_issuer_valid"):
        staff_identity(models, issuer=bounded_issuer(2049))
    assert len(staff_identity(models, issuer=bounded_issuer(2048)).issuer) == 2048


def test_no_organisation_takes_the_staff_realm(models):
    with named_refusal("23514", "organisation_realm_not_staff"):
        anchor(models, slug="kodera-staff")


def test_a_staff_identity_never_joins_an_organisation(models):
    organisation, _, _ = anchor(models)
    principal = staff_identity(models)
    with named_refusal("23514", "identity_immutable_binding"):
        models.Identity.objects.filter(pk=principal.pk).update(organisation_id=organisation.pk)


def test_a_customer_identity_keeps_its_organisation(models):
    organisation, _, owners = anchor(models)
    principal = identity(models, organisation, owners[0].user)
    with named_refusal("23514", "identity_immutable_binding"):
        models.Identity.objects.filter(pk=principal.pk).update(organisation_id=None)


def test_a_staff_identity_is_retained(models):
    principal = staff_identity(models)
    with named_refusal("23514", "identity_delete_refused"):
        raw_delete(principal)


# --------------------------------------------------------------------- §2 the role grant ----


def test_a_staff_role_is_granted_to_a_staff_identity(models):
    principal = staff_identity(models)
    granted = grant(models, principal)
    assert models.StaffRole.objects.get(pk=granted.pk).identity_id == principal.pk


def test_a_staff_role_is_never_granted_to_a_customer_identity(models):
    organisation, _, owners = anchor(models)
    customer = identity(models, organisation, owners[0].user)
    with named_refusal("23503", "staffrole_staff_identity_fk"):
        grant(models, customer)


def test_a_staff_role_grant_names_the_staff_realm(models):
    principal = staff_identity(models)
    with named_refusal("23514", "staffrole_realm_valid"):
        models.StaffRole.objects.create(identity=principal, realm="alpha", role="staff_operator")


@pytest.mark.parametrize("role", ["org_owner", "staff_admin", ""])
def test_a_staff_role_is_one_of_the_three(models, role):
    principal = staff_identity(models)
    with named_refusal("23514", "staffrole_role_valid"):
        grant(models, principal, role=role)


@pytest.mark.parametrize("role", ["staff_operator", "staff_support", "staff_security"])
def test_each_staff_role_can_be_granted(models, role):
    grant(models, staff_identity(models), role=role)


def test_a_role_is_granted_once_at_a_time(models):
    principal = staff_identity(models)
    first = grant(models, principal)
    with named_refusal("23505", "staffrole_one_current_grant"):
        grant(models, principal)
    models.StaffRole.objects.filter(pk=first.pk).update(revoked_at=timezone.now())
    grant(models, principal)
    assert models.StaffRole.objects.filter(identity=principal).count() == 2


def test_a_revocation_does_not_precede_its_grant(models):
    granted = grant(models, staff_identity(models))
    with named_refusal("23514", "staffrole_revocation_valid"):
        raw_update(granted, revoked_at=granted.created_at - timedelta(seconds=1))


def test_a_grant_is_retained(models):
    granted = grant(models, staff_identity(models))
    with named_refusal("23514", "staffrole_delete_refused"):
        raw_delete(granted)


@pytest.mark.parametrize("column", ["role", "realm", "identity_id", "created_at"])
def test_a_grant_is_immutable(models, column):
    granted = grant(models, staff_identity(models))
    other = staff_identity(models, subject="other-staff-subject")
    values = {
        "role": "staff_support",
        "realm": "alpha",
        "identity_id": other.pk,
        "created_at": granted.created_at - timedelta(days=1),
    }
    with named_refusal("23514", "staffrole_immutable_grant"):
        raw_update(granted, **{column: values[column]})


def test_a_revocation_is_final(models):
    granted = grant(models, staff_identity(models))
    revoked = timezone.now()
    raw_update(granted, revoked_at=revoked)
    with named_refusal("23514", "staffrole_revocation_final"):
        raw_update(granted, revoked_at=revoked + timedelta(seconds=1))
    with named_refusal("23514", "staffrole_revocation_final"):
        raw_update(granted, revoked_at=None)


# ------------------------------------------------------------------------ §3 the readers ----


def test_the_customer_reads_never_see_a_staff_identity(models):
    principal = staff_identity(models)
    assert selectors.current_identity(issuer=STAFF_ISSUER, subject=principal.subject) is None, (
        "the customer identity reader returned a staff identity"
    )
    assert selectors.person_identities(user_id=principal.user_id) == (), (
        "the customer identity list returned a staff identity"
    )


def test_the_staff_reader_reads_an_enabled_staff_identity(models):
    principal = staff_identity(models)
    found = selectors.current_staff_identity(issuer=STAFF_ISSUER, subject=principal.subject)
    assert found is not None and found.id == principal.pk and found.user_id == principal.user_id


@pytest.mark.parametrize("disabled", ["identity", "identity-deleted", "person", "person-deleted"])
def test_the_staff_reader_refuses_a_disabled_staff_identity(models, disabled):
    principal = staff_identity(models)
    now = timezone.now()
    retired = {"deleted_at": now, "purge_after": now + timedelta(days=1)}
    if disabled == "identity":
        models.Identity.objects.filter(pk=principal.pk).update(enabled=False)
    elif disabled == "identity-deleted":
        models.Identity.objects.filter(pk=principal.pk).update(**retired)
    elif disabled == "person":
        models.User.objects.filter(pk=principal.user_id).update(enabled=False)
    else:
        models.User.objects.filter(pk=principal.user_id).update(**retired)
    assert (
        selectors.current_staff_identity(issuer=STAFF_ISSUER, subject=principal.subject) is None
    ), f"the staff reader returned a staff identity whose {disabled} is disabled"


def test_the_staff_reader_never_reads_a_customer_identity(models):
    organisation, _, owners = anchor(models)
    customer = identity(models, organisation, owners[0].user)
    assert (
        selectors.current_staff_identity(issuer=organisation.issuer, subject=customer.subject)
        is None
    )


# --------------------------------------------------------- the authority revision triggers ----


def test_a_staff_identity_touches_no_organisation_authority(models):
    first, _, _ = anchor(models, slug="alpha")
    second, _, _ = anchor(models, slug="bravo")
    before = revisions(models)
    principal = staff_identity(models)
    models.Identity.objects.filter(pk=principal.pk).update(enabled=False)
    models.User.objects.filter(pk=principal.user_id).update(enabled=False)
    assert revisions(models) == before, (
        "a staff identity's writes advanced a customer organisation's authority revision"
    )
    assert set(before) == {first.pk, second.pk}


# --------------------------------------------------------------- §4 the operator commands ----


def run(command, *args, **options):
    out = StringIO()
    call_command(command, *args, stdout=out, **options)
    return out.getvalue().strip()


def operator(models, subject="operator-subject"):
    principal = staff_identity(models, subject=subject)
    grant(models, principal)
    return principal


def audits(models, action):
    return list(
        models.AuditEvent.objects.filter(action=action)
        .order_by("occurred_at", "id")
        .values("actor_type", "actor_id", "organisation_id", "target_urn", "metadata")
    )


# The staff issuer setting.


@pytest.mark.parametrize(
    "value",
    [
        STAFF_ISSUER,
        "http://127.0.0.1:8081/realms/kodera-staff",
        "https://auth.kodera.io/realms/kodera-staff",
    ],
)
def test_the_staff_issuer_setting_admits_a_staff_realm_issuer(value):
    environment = {"KODERA_STAFF_ISSUER": value, "KODERA_AUTH_TRUST": trust(("staff", value))}
    assert staff_issuer(environment, loopback_issuers=True) == value


@pytest.mark.parametrize(
    "value",
    [
        "http://127.0.0.1:8081/realms/kodera-staff",
        "http://localhost:8180/realms/kodera-staff",
        "https://localhost/realms/kodera-staff",
        "https://keycloak.localhost/realms/kodera-staff",
        "https://127.8.9.10/realms/kodera-staff",
        "https://[::1]:8443/realms/kodera-staff",
        "https://[::ffff:127.0.0.1]/realms/kodera-staff",
        "https://0.0.0.0/realms/kodera-staff",
        "https://LOCALHOST./realms/kodera-staff",
    ],
)
def test_only_a_local_profile_admits_a_loopback_staff_issuer(value):
    # The same value a local profile admits is refused by default, before the trust is read.
    environment = {"KODERA_STAFF_ISSUER": value, "KODERA_AUTH_TRUST": trust(("staff", value))}
    assert staff_issuer(environment, loopback_issuers=True) == value
    with pytest.raises(
        ImproperlyConfigured,
        match="^KODERA_STAFF_ISSUER is a plain-http or loopback issuer, "
        "which only a local profile may trust$",
    ):
        staff_issuer(environment)


def test_a_deployable_staff_issuer_is_refused_with_a_loopback_issuer_in_the_trust():
    value = "https://auth.kodera.io/realms/kodera-staff"
    environment = {
        "KODERA_STAFF_ISSUER": value,
        "KODERA_AUTH_TRUST": trust(("staff", value), ("customer", "http://localhost:8180/r/x")),
    }
    assert staff_issuer(environment, loopback_issuers=True) == value
    with pytest.raises(ImproperlyConfigured, match="^KODERA_AUTH_TRUST admits a plain-http"):
        staff_issuer(environment)


@pytest.mark.parametrize(
    "entries",
    [
        [],
        [("customer", STAFF_ISSUER)],
        [("staff", "https://identity.other.test/realms/kodera-staff")],
        [("staff", STAFF_ISSUER + "/")],
    ],
    ids=["no-trust", "customer-lane", "another-staff-issuer", "trailing-slash"],
)
def test_the_staff_issuer_must_be_on_the_staff_lane_of_the_trust(entries):
    environment = {"KODERA_STAFF_ISSUER": STAFF_ISSUER}
    if entries:
        environment["KODERA_AUTH_TRUST"] = trust(*entries)
    with pytest.raises(ImproperlyConfigured, match="not on the staff lane of KODERA_AUTH_TRUST"):
        staff_issuer(environment)


def test_a_settings_profile_refuses_to_start_with_an_untrusted_staff_issuer():
    # The real start: config.settings.persistence in a fresh interpreter, both ways.
    def start(environment):
        return subprocess.run(  # noqa: S603 - a fixed interpreter and a fixed program
            [sys.executable, "-c", "import django; django.setup(); print('started')"],
            cwd=ROOT,
            env={
                "PATH": os.environ.get("PATH", ""),
                "DJANGO_SETTINGS_MODULE": "config.settings.persistence",
                "DATABASE_URL": "postgres://u:p@127.0.0.1:5432/kodera_server",
                **environment,
            },
            capture_output=True,
            text=True,
            check=False,
        )

    refused = start({"KODERA_STAFF_ISSUER": STAFF_ISSUER})
    assert refused.returncode != 0
    assert "not on the staff lane of KODERA_AUTH_TRUST" in refused.stderr
    trusted = start(
        {
            "KODERA_STAFF_ISSUER": STAFF_ISSUER,
            "KODERA_AUTH_TRUST": trust(("staff", STAFF_ISSUER)),
        }
    )
    assert trusted.returncode == 0 and trusted.stdout.strip() == "started", trusted.stderr[-2000:]


def test_the_staff_issuer_setting_may_be_absent():
    assert staff_issuer({}) is None and staff_issuer({"KODERA_STAFF_ISSUER": ""}) is None


@pytest.mark.parametrize(
    "value",
    [
        "https://auth.kodera.io/realms/alpha",
        "http://auth.kodera.io/realms/kodera-staff",
        "ftp://auth.kodera.io/realms/kodera-staff",
        "https:///realms/kodera-staff",
        "https://auth.kodera.io/realms/kodera-staff?x=1",
        "https://auth.kodera.io/realms/kodera-staff#x",
        "https://" + "a" * 2048 + "/realms/kodera-staff",
    ],
)
def test_the_staff_issuer_setting_refuses_anything_else(value):
    with pytest.raises(ImproperlyConfigured, match="KODERA_STAFF_ISSUER"):
        staff_issuer({"KODERA_STAFF_ISSUER": value})


# The bootstrap.


def test_the_bootstrap_grants_the_first_two_operators_once(models):
    said = run(
        "bootstrap_staff_roles",
        "--operator", "first", "first@staff.test",
        "--operator", "second", "second@staff.test",
    )  # fmt: skip
    first, second = (
        models.Identity.objects.get(issuer=STAFF_ISSUER, subject=subject)
        for subject in ("first", "second")
    )
    assert said.splitlines() == [
        f"staff_operator granted by bootstrap to staff identity {first.pk}",
        f"staff_operator granted by bootstrap to staff identity {second.pk}",
    ]
    assert {first.organisation_id, second.organisation_id} == {None}
    assert sorted(
        models.StaffRole.objects.values_list("identity_id", "role", "revoked_at")
    ) == sorted([(first.pk, "staff_operator", None), (second.pk, "staff_operator", None)])
    rows = audits(models, "staff_role.granted")
    assert [(row["actor_type"], row["actor_id"], row["organisation_id"]) for row in rows] == [
        ("system", None, None),
        ("system", None, None),
    ]
    assert {row["target_urn"] for row in rows} == {
        f"urn:kodera:identity:{first.pk}",
        f"urn:kodera:identity:{second.pk}",
    }
    assert all(row["metadata"]["reason"] == "bootstrap" for row in rows)
    assert all(row["metadata"]["role"] == "staff_operator" for row in rows)
    with pytest.raises(CommandError, match="a staff role has been granted before"):
        run(
            "bootstrap_staff_roles", "--operator", "third", "t@s.t", "--operator", "fourth", "f@s.t"
        )
    assert models.StaffRole.objects.count() == 2


def test_the_bootstrap_is_refused_after_any_grant_even_a_revoked_one(models):
    granted = grant(models, staff_identity(models))
    raw_update(granted, revoked_at=timezone.now())
    with pytest.raises(CommandError, match="a staff role has been granted before"):
        run("bootstrap_staff_roles", "--operator", "a", "a@s.t", "--operator", "b", "b@s.t")
    assert models.StaffRole.objects.count() == 1
    assert not models.AuditEvent.objects.filter(action="staff_role.granted").exists()


@pytest.mark.parametrize(
    "arguments",
    [
        ["--operator", "only", "only@s.t"],
        ["--operator", "same", "a@s.t", "--operator", "same", "b@s.t"],
        ["--operator", "a", "a@s.t", "--operator", "b", "b@s.t", "--operator", "c", "c@s.t"],
    ],
    ids=["one", "the-same-twice", "three"],
)
def test_the_bootstrap_grants_exactly_two_distinct_identities(models, arguments):
    with pytest.raises(CommandError, match="exactly two distinct subjects"):
        run("bootstrap_staff_roles", *arguments)
    assert not models.Identity.objects.exists() and not models.StaffRole.objects.exists()


def test_the_bootstrap_writes_nothing_when_one_operator_is_refused(models):
    disabled = staff_identity(models, subject="disabled")
    models.Identity.objects.filter(pk=disabled.pk).update(enabled=False)
    with pytest.raises(CommandError, match="disabled"):
        run(
            "bootstrap_staff_roles",
            "--operator", "fresh", "fresh@staff.test",
            "--operator", "disabled", "d@staff.test",
        )  # fmt: skip
    assert not models.StaffRole.objects.exists()
    assert not models.Identity.objects.filter(subject="fresh").exists()
    assert not models.AuditEvent.objects.filter(action="staff_role.granted").exists()


def test_the_bootstrap_needs_the_staff_issuer(models, settings):
    settings.KODERA_STAFF_ISSUER = None
    with pytest.raises(CommandError, match="KODERA_STAFF_ISSUER is not set"):
        run("bootstrap_staff_roles", "--operator", "a", "a@s.t", "--operator", "b", "b@s.t")
    assert not models.Identity.objects.exists()


def test_the_commands_refuse_to_run_without_the_audit_application(models, monkeypatch):
    monkeypatch.setattr(staff_roles, "_audit_installed", lambda: False)
    with pytest.raises(CommandError, match="--settings config.settings.job_queue"):
        run("bootstrap_staff_roles", "--operator", "a", "a@s.t", "--operator", "b", "b@s.t")
    assert not models.Identity.objects.exists()


# Two-person grants.


def test_an_operator_grants_a_role_to_a_new_staff_identity(models):
    acting = operator(models)
    said = run(
        "grant_staff_role",
        staff_identity=acting.pk,
        subject="new-operator",
        role="staff_operator",
        email="new@staff.test",
    )
    grantee = models.Identity.objects.get(issuer=STAFF_ISSUER, subject="new-operator")
    assert grantee.organisation_id is None and grantee.realm == "kodera-staff"
    assert said == f"staff_operator granted by staff identity {grantee.pk}"
    assert "new-operator" not in said and "new@staff.test" not in said
    (granted,) = models.StaffRole.objects.filter(identity=grantee)
    assert (granted.role, granted.revoked_at) == ("staff_operator", None)
    assert audits(models, "staff_role.granted") == [
        {
            "actor_type": "staff",
            "actor_id": acting.pk,
            "organisation_id": None,
            "target_urn": f"urn:kodera:identity:{grantee.pk}",
            "metadata": {"role": "staff_operator", "grant_id": str(granted.pk)},
        }
    ]


def test_a_role_already_held_is_neither_granted_again_nor_audited(models):
    acting = operator(models)
    options = {"staff_identity": acting.pk, "subject": "twice", "role": "staff_support"}
    run("grant_staff_role", email="t@staff.test", **options)
    said = run("grant_staff_role", **options)
    assert said.startswith("staff_support already held by staff identity ")
    assert models.StaffRole.objects.filter(identity__subject="twice").count() == 1
    assert len(audits(models, "staff_role.granted")) == 1


def test_an_operator_adds_a_second_role_to_an_existing_staff_identity(models):
    acting = operator(models)
    grantee = staff_identity(models, subject="existing")
    run("grant_staff_role", staff_identity=acting.pk, subject="existing", role="staff_security")
    run("grant_staff_role", staff_identity=acting.pk, subject="existing", role="staff_support")
    assert set(
        models.StaffRole.objects.filter(identity=grantee).values_list("role", flat=True)
    ) == {"staff_security", "staff_support"}
    assert models.Identity.objects.filter(subject="existing").count() == 1


def test_no_staff_identity_grants_itself_a_role(models):
    acting = operator(models)
    with pytest.raises(CommandError, match="two-person rule"):
        run(
            "grant_staff_role",
            staff_identity=acting.pk,
            subject=acting.subject,
            role="staff_security",
        )
    assert models.StaffRole.objects.filter(identity=acting).count() == 1
    assert not models.AuditEvent.objects.exists()


@pytest.mark.parametrize(
    "acting", ["unknown", "support-only", "revoked", "disabled", "person-disabled", "other-issuer"]
)
def test_only_a_current_operator_grants(models, acting):
    if acting == "unknown":
        actor_id = uuid.uuid4()
    elif acting == "other-issuer":
        other = staff_identity(
            models, subject="elsewhere", issuer="https://identity.old.test/realms/kodera-staff"
        )
        grant(models, other)
        actor_id = other.pk
    else:
        principal = staff_identity(models, subject="acting")
        granted = grant(
            models,
            principal,
            role="staff_support" if acting == "support-only" else "staff_operator",
        )
        if acting == "revoked":
            raw_update(granted, revoked_at=timezone.now())
        elif acting == "disabled":
            models.Identity.objects.filter(pk=principal.pk).update(enabled=False)
        elif acting == "person-disabled":
            models.User.objects.filter(pk=principal.user_id).update(enabled=False)
        actor_id = principal.pk
    with pytest.raises(CommandError, match="holds no current staff_operator grant"):
        run(
            "grant_staff_role",
            staff_identity=actor_id,
            subject="grantee",
            role="staff_support",
            email="g@staff.test",
        )
    assert not models.Identity.objects.filter(subject="grantee").exists()
    assert not models.AuditEvent.objects.exists()


def test_grant_needs_the_staff_issuer(models, settings):
    acting = operator(models)
    settings.KODERA_STAFF_ISSUER = None
    with pytest.raises(CommandError, match="KODERA_STAFF_ISSUER is not set"):
        run(
            "grant_staff_role",
            staff_identity=acting.pk,
            subject="s",
            role="staff_operator",
            email="e",
        )


def test_grant_refuses_a_new_identity_without_an_email(models):
    acting = operator(models)
    with pytest.raises(CommandError, match="needs an email address"):
        run("grant_staff_role", staff_identity=acting.pk, subject="s", role="staff_operator")
    assert not models.Identity.objects.filter(subject="s").exists()


def test_grant_refuses_an_unstorable_subject(models):
    acting = operator(models)
    with pytest.raises(CommandError, match="not a storable provider subject"):
        run("grant_staff_role", staff_identity=acting.pk, subject="é", role="staff_operator")


@pytest.mark.parametrize("arguments", [["--role", "org_owner"], ["--staff-identity", "nobody"]])
def test_grant_refuses_malformed_arguments(models, arguments):
    acting = operator(models)
    options = {"--staff-identity": str(acting.pk), "--subject": "s", "--role": "staff_operator"}
    options.update(dict(zip(arguments[::2], arguments[1::2], strict=True)))
    with pytest.raises(CommandError):
        run("grant_staff_role", *[word for pair in options.items() for word in pair])
    assert not models.Identity.objects.filter(subject="s").exists()


@pytest.mark.parametrize("disabled", ["identity", "person"])
def test_grant_refuses_a_disabled_grantee(models, disabled):
    acting = operator(models)
    grantee = staff_identity(models, subject="grantee")
    if disabled == "identity":
        models.Identity.objects.filter(pk=grantee.pk).update(enabled=False)
    else:
        models.User.objects.filter(pk=grantee.user_id).update(enabled=False)
    with pytest.raises(CommandError, match="disabled"):
        run("grant_staff_role", staff_identity=acting.pk, subject="grantee", role="staff_support")
    assert not models.StaffRole.objects.filter(identity=grantee).exists()


# Two-person revocations.


def test_an_operator_revokes_another_identity_s_grant_and_keeps_it(models):
    acting = operator(models)
    grantee = staff_identity(models, subject="grantee")
    granted = grant(models, grantee)
    said = run(
        "revoke_staff_role", staff_identity=acting.pk, subject="grantee", role="staff_operator"
    )
    stored = models.StaffRole.objects.get(pk=granted.pk)
    assert stored.revoked_at is not None and said == f"staff_operator revoked: grant {granted.pk}"
    assert audits(models, "staff_role.revoked") == [
        {
            "actor_type": "staff",
            "actor_id": acting.pk,
            "organisation_id": None,
            "target_urn": f"urn:kodera:identity:{grantee.pk}",
            "metadata": {"role": "staff_operator", "grant_id": str(granted.pk)},
        }
    ]


def test_a_revocation_works_on_a_disabled_staff_identity(models):
    acting = operator(models)
    grantee = staff_identity(models, subject="grantee")
    granted = grant(models, grantee)
    models.Identity.objects.filter(pk=grantee.pk).update(enabled=False)
    run("revoke_staff_role", staff_identity=acting.pk, subject="grantee", role="staff_operator")
    assert models.StaffRole.objects.get(pk=granted.pk).revoked_at is not None


def test_no_staff_identity_revokes_its_own_grant(models):
    acting = operator(models)
    with pytest.raises(CommandError, match="two-person rule"):
        run(
            "revoke_staff_role",
            staff_identity=acting.pk,
            subject=acting.subject,
            role="staff_operator",
        )
    assert models.StaffRole.objects.get(identity=acting).revoked_at is None
    assert not models.AuditEvent.objects.exists()


def test_only_a_current_operator_revokes(models):
    support = staff_identity(models, subject="support")
    grant(models, support, role="staff_support")
    grantee = staff_identity(models, subject="grantee")
    granted = grant(models, grantee)
    with pytest.raises(CommandError, match="holds no current staff_operator grant"):
        run(
            "revoke_staff_role", staff_identity=support.pk, subject="grantee", role="staff_operator"
        )
    assert models.StaffRole.objects.get(pk=granted.pk).revoked_at is None


def test_a_revocation_needs_a_current_grant(models):
    acting = operator(models)
    grantee = staff_identity(models, subject="grantee")
    granted = grant(models, grantee, role="staff_support")
    with pytest.raises(CommandError, match="no current grant"):
        run("revoke_staff_role", staff_identity=acting.pk, subject="grantee", role="staff_operator")
    run("revoke_staff_role", staff_identity=acting.pk, subject="grantee", role="staff_support")
    with pytest.raises(CommandError, match="no current grant"):
        run("revoke_staff_role", staff_identity=acting.pk, subject="grantee", role="staff_support")
    assert models.StaffRole.objects.get(pk=granted.pk).revoked_at is not None
    assert len(audits(models, "staff_role.revoked")) == 1


def test_the_audit_writer_takes_only_the_staff_role_actions(models):
    from apps.audit.services import record_staff_role_event

    with pytest.raises(ValueError, match="not a staff role action"):
        record_staff_role_event(
            action="staff_role.deleted", actor_id=None, identity_id=uuid.uuid4(), metadata={}
        )


# What a concurrent change makes the database refuse.


class _SqlStateError(Exception):
    def __init__(self, sqlstate):
        super().__init__(sqlstate)
        self.sqlstate = sqlstate


def _database_error(kind, sqlstate):
    error = kind(f"synthetic {sqlstate}")
    error.__cause__ = _SqlStateError(sqlstate)
    return error


@pytest.mark.parametrize(
    "error",
    [
        (IntegrityError, "23505"),
        (OperationalError, "40P01"),
        (OperationalError, "40001"),
        (OperationalError, "55P03"),
    ],
    ids=["unique", "deadlock", "serialisation", "lock-not-available"],
)
@pytest.mark.parametrize("command", ["grant", "revoke", "bootstrap"])
def test_a_concurrent_refusal_is_reported_and_writes_nothing(models, monkeypatch, command, error):
    acting = operator(models) if command != "bootstrap" else None
    if command == "revoke":
        grant(models, staff_identity(models, subject="grantee"))
    before = (models.StaffRole.objects.count(), models.AuditEvent.objects.count())

    def refuse(**_):
        raise _database_error(*error)

    if command == "bootstrap":
        monkeypatch.setattr(staff_roles, "_staff_identity", refuse)
        arguments = ["--operator", "a", "a@s.t", "--operator", "b", "b@s.t"]
        options = {}
    else:
        monkeypatch.setattr(staff_roles, "_acting_operator", refuse)
        arguments = []
        options = {"staff_identity": acting.pk, "subject": "grantee", "role": "staff_operator"}
    with pytest.raises(CommandError, match="a concurrent change refused this; run it again"):
        run(
            f"{command}_staff_role" + ("s" if command == "bootstrap" else ""), *arguments, **options
        )
    assert (models.StaffRole.objects.count(), models.AuditEvent.objects.count()) == before


def test_another_operational_error_is_not_reported_as_concurrent(models, monkeypatch):
    acting = operator(models)

    def refuse(**_):
        raise _database_error(OperationalError, "57014")

    monkeypatch.setattr(staff_roles, "_acting_operator", refuse)
    with pytest.raises(OperationalError, match="57014"):
        run("grant_staff_role", staff_identity=acting.pk, subject="g", role="staff_support")
