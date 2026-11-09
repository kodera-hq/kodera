"""The operator's `tenant_status` command: docs/specs/QUICK_WORKSPACE.md §5.

Real staff identities and grants, the real command as `manage.py` parses it, the disposable
PostgreSQL test database. A tenant is created by `createTenant` on the real route, so the cases
start where the pilot starts: an unbilled tenant `ordered`, with no order.
"""

import sys
from datetime import UTC, datetime

import pytest
import time_machine
from django.core.management import load_command_class
from django.core.management.base import CommandError
from order_fixtures import commit_order
from test_access_tokens import NOW, frozen_clock as frozen_clock
from test_agent_enrolment import staff
from test_create_tenant import create, u as u
from test_workspace_onboarding import call, http_signer as http_signer, model, w as w

pytestmark = pytest.mark.django_db(transaction=True)

STATUS = "/tenants/{tenant_id}/status"


@pytest.fixture
def t(u):
    """The createTenant world, alpha's unbilled tenant created, and two staff identities."""
    created = create(u, u.owner)
    assert created.status_code == 201, created.content
    u.tenant = model("tenancy", "Tenant").objects.get(organisation_id=u.alpha.id)
    u.operator = staff("tenant-operator")
    u.reader = staff("tenant-reader", roles=("staff_support",))
    return u


def run(capsys, *argv):
    """The command as `manage.py` runs it: (exit status, out, err)."""
    command = load_command_class("apps.tenancy", "tenant_status")
    options = vars(command.create_parser("manage.py", "tenant_status").parse_args(list(argv)))
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


def move(capsys, t, to, *, tenant=None, identity=None, reason="pilot: provisioned by hand"):
    return run(
        capsys,
        "set",
        "--staff-identity",
        str((identity or t.operator).id),
        "--tenant",
        str(tenant or t.tenant.id),
        "--to",
        to,
        "--reason",
        reason,
    )


def status(t):
    return model("tenancy", "Tenant").objects.get(id=t.tenant.id).status


def rows(t):
    events = model("audit", "AuditEvent").objects.filter(
        target_urn=f"urn:kodera:tenant:{t.tenant.id}", actor_type="staff"
    )
    return list(events.order_by("occurred_at", "id").values_list("action", "actor_id", "metadata"))


def written(t):
    """The status and the tenant's staff rows: `status_changed_at` would prove nothing, as the
    frozen clock stores one instant for every write."""
    return (status(t), len(rows(t)))


def read(t):
    """The owner's `getTenantStatus`, checked against the contract."""
    response = t.client.get(
        f"/api/v1/tenants/{t.tenant.id}/status",
        HTTP_AUTHORIZATION="Bearer " + t.owner.credential,
    )
    assert response.status_code == 200, response.content
    return call(response, STATUS, "get").json()["status"]


# --- case 1: each allowed move, with its audit rows ----------------------------------------------


def test_case1_provisioning_then_active_write_one_row_per_transition(capsys, t):
    code, out, _ = move(capsys, t, "provisioning")
    assert code == 0 and "to=provisioning" in out and "outcome=moved" in out
    assert status(t) == "provisioning"
    code, out, _ = move(capsys, t, "active", reason="pilot: domain checked by hand")
    assert code == 0 and "to=ready>active" in out
    assert status(t) == "active"
    assert rows(t) == [
        (
            "tenant.provision_requested",
            t.operator.id,
            {
                "from": "ordered",
                "to": "provisioning",
                "override": True,
                "reason": "pilot: provisioned by hand",
            },
        ),
        (
            "tenant.ready",
            t.operator.id,
            {
                "from": "provisioning",
                "to": "ready",
                "override": True,
                "reason": "pilot: domain checked by hand",
            },
        ),
        (
            "tenant.activated",
            t.operator.id,
            {
                "from": "ready",
                "to": "active",
                "override": True,
                "reason": "pilot: domain checked by hand",
            },
        ),
    ]
    events = model("audit", "AuditEvent").objects.filter(actor_id=t.operator.id)
    assert set(events.values_list("organisation_id", flat=True)) == {t.alpha.id}
    assert events.count() == 3


def test_case1_failed_from_provisioning_then_retried(capsys, t):
    assert move(capsys, t, "provisioning")[0] == 0
    code, out, _ = move(capsys, t, "failed", reason="pilot: host never came up")
    assert code == 0 and "to=failed" in out
    assert status(t) == "failed"
    code, out, _ = move(capsys, t, "provisioning", reason="pilot: host rebuilt")
    assert code == 0 and "to=provisioning" in out
    assert status(t) == "provisioning"
    assert rows(t)[1:] == [
        (
            "tenant.failed",
            t.operator.id,
            {
                "from": "provisioning",
                "to": "failed",
                "override": True,
                "reason": "pilot: host never came up",
            },
        ),
        (
            "tenant.provision_requested",
            t.operator.id,
            {
                "from": "failed",
                "to": "provisioning",
                "override": True,
                "reason": "pilot: host rebuilt",
            },
        ),
    ]


def test_case1_a_mistaken_creation_is_deleted_and_its_slug_stays_taken(capsys, t):
    code, out, _ = move(capsys, t, "deleted", reason="pilot: created by mistake")
    assert code == 0 and "to=deleted" in out
    assert status(t) == "deleted"
    assert [action for action, _, _ in rows(t)] == ["tenant.deleted"]
    again = create(t, t.owner, key="00000000-0000-4000-8000-000000000511")
    assert again.status_code == 409 and again.json()["type"].endswith("/slug-taken")


# --- case 2: refused, nothing written ------------------------------------------------------------


@pytest.mark.parametrize(
    ("before", "to", "reason"),
    [
        ([], "active", "the tenant is ordered; --to active is allowed from provisioning only"),
        ([], "failed", "the tenant is ordered; --to failed is allowed from provisioning only"),
        (
            ["provisioning", "active"],
            "provisioning",
            "the tenant is active; --to provisioning is allowed from ordered or failed only",
        ),
        (["provisioning"], "deleted", "the tenant is provisioning; --to deleted is allowed from"),
        (
            ["provisioning", "failed"],
            "deleted",
            "the tenant is failed; --to deleted is allowed from ordered only",
        ),
    ],
)
def test_case2_a_move_from_the_wrong_state_is_refused_naming_the_allowed_one(
    capsys, t, before, to, reason
):
    for step in before:
        assert move(capsys, t, step)[0] == 0
    was = written(t)
    code, out, err = move(capsys, t, to)
    assert code != 0 and "outcome=refused" in out
    assert reason in err and "nothing written" in err
    assert written(t) == was


def test_case2_a_tenant_an_order_names_is_not_moved(capsys, t):
    """Every `--to`, even the one its state allows: a cancellation of the order would otherwise
    leave the tenant `active` behind a cancelled order."""
    t.settings.KODERA_BILLING_ENABLED = True
    placed = commit_order(t.bravo.id, t.bravo.issuer, "bravo-owner")
    ordered = model("tenancy", "Tenant").objects.get(id=placed.order.tenant_id)
    before = model("audit", "AuditEvent").objects.filter(actor_type="staff").count()
    for to in ("provisioning", "deleted", "active", "failed"):
        code, _, err = move(capsys, t, to, tenant=ordered.id)
        assert code != 0 and "an order names the tenant; it moves with its order" in err, (to, err)
    assert model("tenancy", "Tenant").objects.get(id=ordered.id).status == "ordered"
    assert model("audit", "AuditEvent").objects.filter(actor_type="staff").count() == before


def test_case2_an_unknown_tenant_is_refused(capsys, t):
    code, _, err = move(capsys, t, "provisioning", tenant="00000000-0000-4000-8000-0000000005ff")
    assert code != 0 and "no tenant has that id" in err


@pytest.mark.parametrize("reason", ["   ", "x" * 501, "pilot:\nsecond line", "pilot: \u202eevil"])
def test_case2_a_blank_long_or_unprintable_reason_is_refused(capsys, t, reason):
    was = written(t)
    code, _, err = move(capsys, t, "provisioning", reason=reason)
    assert code != 0 and "--reason must be 1 to 500 printable characters" in err
    assert written(t) == was


def test_case2_a_reason_of_500_characters_is_taken(capsys, t):
    assert move(capsys, t, "provisioning", reason="x" * 500)[0] == 0
    assert rows(t)[0][2]["reason"] == "x" * 500


# --- case 3: without the grant -------------------------------------------------------------------


def test_case3_without_a_staff_operator_grant_it_is_refused(capsys, t):
    was = written(t)
    code, out, err = move(capsys, t, "provisioning", identity=t.reader)
    assert code != 0 and "outcome=refused" in out
    assert "staff_operator" in err
    assert written(t) == was


def test_case3_the_service_rechecks_the_grant_itself(t):
    from apps.identity.command_principal import staff_principal_for_command
    from apps.tenancy.operator_status import StatusRefusedError, set_status

    principal = staff_principal_for_command(t.reader.id)
    with pytest.raises(StatusRefusedError, match="staff_operator"):
        set_status(principal=principal, tenant_id=t.tenant.id, to="provisioning", reason="x")
    assert status(t) == "ordered"


# --- case 4: a repeat ----------------------------------------------------------------------------


def test_case4_repeating_a_set_is_refused(capsys, t):
    assert move(capsys, t, "provisioning")[0] == 0
    assert move(capsys, t, "active")[0] == 0
    was = written(t)
    code, _, err = move(capsys, t, "active")
    assert code != 0 and "the tenant is already active" in err
    assert written(t) == was


# --- case 5: the customer's read -----------------------------------------------------------------


def test_case5_the_status_read_reflects_the_move_at_once(capsys, t):
    assert read(t) == "ordered"
    assert move(capsys, t, "provisioning")[0] == 0
    assert read(t) == "provisioning"
    assert move(capsys, t, "active")[0] == 0
    assert read(t) == "active"


def test_case5_the_status_read_reflects_failed(capsys, t):
    assert move(capsys, t, "provisioning")[0] == 0
    assert move(capsys, t, "failed")[0] == 0
    assert read(t) == "failed"


def test_case5_the_status_read_reflects_deleted(capsys, t):
    assert move(capsys, t, "deleted")[0] == 0
    assert read(t) == "deleted"


# --- list ----------------------------------------------------------------------------------------


def test_list_prints_each_tenant_oldest_first_and_filters_by_state(capsys, t):
    t.settings.KODERA_BILLING_ENABLED = True
    # A minute later, so the two `created_at` differ and the order, not the id, decides.
    with time_machine.travel(datetime.fromtimestamp(NOW + 60, UTC), tick=False):
        later = commit_order(t.bravo.id, t.bravo.issuer, "bravo-owner").order.tenant_id
    tenants = model("tenancy", "Tenant").objects
    assert tenants.get(id=later).created_at > tenants.get(id=t.tenant.id).created_at
    code, out, _ = run(capsys, "list")
    assert code == 0
    line = f"{t.tenant.id} alpha-team {t.alpha.slug} ordered visio,messaging "
    assert out.startswith(line), out
    assert [row.split()[0] for row in out.splitlines()] == [str(t.tenant.id), str(later)]
    assert run(capsys, "list", "--state", "active")[1] == ""
    assert run(capsys, "list", "--state", "ordered")[1].startswith(line)
    code, _, err = run(capsys, "list", "--state", "bogus")
    assert code != 0 and "unknown state" in err
