"""An order settled as complimentary by a staff operator's command, on the real
database: apps/billing/complimentary.py and `settle_complimentary_order`.

The owner places the order as any other; the operator's settlement credits its unpaid invoice in
full, withdraws its payment links, moves the order `paid` and its subscription `active`, and audits
`order.complimentary` with the operator and the reason. A refusal writes nothing.
"""

import json
import os
import subprocess
import sys
import time
from datetime import timedelta
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

import jwt
import pytest
import time_machine
from cryptography.hazmat.primitives.asymmetric import ec
from django.conf import settings
from django.core.management import load_command_class
from django.core.management.base import CommandError
from django.db import connection
from django.utils import timezone
from test_billing_orders import offer, place, world
from test_billing_payments import fake as fake

from apps.audit.models import AuditEvent
from apps.billing import selectors, services
from apps.billing.models import CreditNote, Invoice, Order, Payment, PaymentLink, Subscription
from apps.billing.payments import services as payments
from apps.identity.models import Identity, StaffRole, User
from apps.tenancy.models import Tenant

pytestmark = pytest.mark.django_db(transaction=True)

STAFF_ISSUER = "https://identity.staff.test/realms/kodera-staff"
REASON = "Kodera team dogfood workspace, billing deferred"


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


def run(capsys, *argv):
    """The command as `manage.py` runs it: (exit status, out, err)."""
    name = "settle_complimentary_order"
    command = load_command_class("apps.billing", name)
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


def settle(capsys, w, placed, *, identity=None, organisation=None, order=None, reason=REASON):
    return run(
        capsys,
        "--staff-identity",
        str((identity or w.operator).id),
        "--organisation",
        organisation or w.organisation.slug,
        "--order",
        str(order or placed.order.id),
        "--reason",
        reason,
    )


@pytest.fixture
def w():
    world_ = world()
    world_.operator = staff("operator")
    return world_


def rows(placed):
    return (
        Order.objects.get(id=placed.order.id).state,
        Subscription.objects.get(id=placed.subscription.id).state,
        Invoice.objects.get(id=placed.invoice.id).state,
        Tenant.objects.get(id=placed.order.tenant_id).status,
    )


def test_an_operator_settles_an_order_as_complimentary(capsys, w, fake):
    placed = place(w, offer())
    link = payments.create_payment_link(
        invoice_id=placed.invoice.id, organisation_id=w.organisation.id
    ).link
    assert rows(placed)[0] == "awaiting_payment"

    code, out, err = settle(capsys, w, placed)

    assert (code, err) == (0, ""), out
    assert "outcome=complimentary" in out and " subscription=activated " in out
    assert rows(placed) == ("paid", "active", "credited", "ordered")
    (note,) = CreditNote.objects.filter(invoice_id=placed.invoice.id)
    assert note.reason == "complimentary" and f"credit_note={note.number}" in out
    tenant = Tenant.objects.get(id=placed.order.tenant_id)
    assert out.splitlines()[1] == (
        f"tenant={tenant.id} slug={tenant.slug} realm={tenant.realm or '-'} "
        f"host.visio={tenant.slug}.visio.customer.test"
    ), out
    assert note.total_incl_vat_minor == placed.invoice.total_incl_vat_minor
    # The link is cancelled and withdrawn at the provider once the settlement committed.
    assert PaymentLink.objects.get(id=link.id).state == "cancelled"
    assert fake.cancelled == [link.provider_ref]
    row = AuditEvent.objects.get(action="order.complimentary")
    assert (row.actor_type, row.actor_id) == ("staff", w.operator.id)
    assert row.organisation_id == w.organisation.id
    assert row.metadata == {
        "reason": REASON,
        "invoice_id": str(placed.invoice.id),
        "credit_note_id": str(note.id),
    }
    # The workspace's prerequisite holds, and nothing lapses the order later.
    assert selectors.has_committed_order(organisation_id=w.organisation.id)
    lapse = Invoice.objects.get(id=placed.invoice.id).due_at + services.UNPAID_ORDER_GRACE
    with time_machine.travel(lapse + timedelta(days=1)):
        assert services.cancel_unpaid_orders() == (0, 0)
    assert rows(placed)[0] == "paid"


@pytest.mark.parametrize(
    ("case", "reason"),
    [
        ("no-operator-grant", "holds no current staff_operator grant"),
        ("unknown-organisation", "no organisation has that slug"),
        ("other-organisation", "the organisation has no order with that id"),
        ("unknown-order", "the organisation has no order with that id"),
        ("blank-reason", "a reason is required"),
        ("long-reason", "the reason is longer than 500 characters"),
        ("already-paid", "the order is paid, not awaiting payment"),
        ("draft-invoice", "the order has no single unpaid issued invoice"),
        ("payment-held", "a payment holds the order's invoice"),
        ("amount-paid", "a payment holds the order's invoice"),
        ("second-invoice", "the order has no single unpaid issued invoice"),
        ("other-series", "the invoice is numbered in series TST, not KOD"),
    ],
)
def test_a_refusal_writes_nothing(capsys, w, case, reason, monkeypatch, settings):
    if case == "draft-invoice":
        # An invoice Core has not issued yet: nothing to credit, so nothing to settle.
        monkeypatch.setattr(services, "issue_invoice", lambda invoice, **kwargs: None)
    placed = place(w, offer())
    monkeypatch.undo()
    arguments = {}
    if case == "no-operator-grant":
        arguments["identity"] = staff("reader", roles=("staff_support",))
    elif case == "unknown-organisation":
        arguments["organisation"] = "charlie-none"
    elif case == "other-organisation":
        arguments["organisation"] = world().organisation.slug
    elif case == "unknown-order":
        arguments["order"] = uuid4()
    elif case == "blank-reason":
        arguments["reason"] = "   "
    elif case == "long-reason":
        arguments["reason"] = "x" * 501
    elif case == "already-paid":
        Order.objects.filter(id=placed.order.id).update(state="paid")
    elif case == "payment-held":
        Payment.objects.create(
            organisation_id=w.organisation.id,
            invoice_id=placed.invoice.id,
            provider="fake",
            provider_ref="pay_settling",
            state="processing",
            amount_minor=placed.invoice.total_incl_vat_minor,
            currency="EUR",
            last_event_at=timezone.now(),
        )
    elif case == "amount-paid":
        # Money already received on the invoice, with no payment still settling.
        Invoice.objects.filter(id=placed.invoice.id).update(amount_paid_minor=1)
    elif case == "second-invoice":
        # A draft beside the issued invoice: the one creditable invoice is not the order's only one.
        second_invoice(w, placed)
    elif case == "other-series":
        # A valid series that is not the API's: a credit note in it would open a series of its own.
        settings.KODERA_INVOICE_SERIES = "KOD"
    before = rows(placed)

    code, out, err = settle(capsys, w, placed, **arguments)

    assert code == 1, out
    assert reason in err and "nothing written" in err and "outcome=refused" in out
    assert rows(placed) == before
    assert not CreditNote.objects.exists()
    assert not AuditEvent.objects.filter(action="order.complimentary").exists()


def second_invoice(w, placed):
    return Invoice.objects.create(
        organisation_id=w.organisation.id,
        order_id=placed.order.id,
        vat_regime="fr_standard",
        issuer_legal_name="x",
        issuer_address="x",
        issuer_siren="000000000",
        issuer_vat_number="FR00000000000",
        customer_legal_name="x",
        customer_address_line1="x",
        customer_postal_code="x",
        customer_city="x",
        customer_country="FR",
    )


def test_a_placed_order_with_no_link_is_settled_too(capsys, w):
    placed = place(w, offer())
    assert rows(placed) == ("placed", "pending", "issued", "ordered")

    code, out, err = settle(capsys, w, placed)

    assert (code, err) == (0, ""), out
    assert rows(placed) == ("paid", "active", "credited", "ordered")


def test_a_subscription_not_pending_is_left_and_named(capsys, w):
    placed = place(w, offer())
    Subscription.objects.filter(id=placed.subscription.id).update(
        state="cancelled", cancelled_at=timezone.now()
    )

    code, out, err = settle(capsys, w, placed)

    assert (code, err) == (0, ""), out
    assert " subscription=cancelled " in out
    assert rows(placed) == ("paid", "cancelled", "credited", "ordered")


def test_the_service_itself_refuses_a_principal_with_no_operator_grant(w):
    """The command checks the grant first (principal_for); the service checks it again, locked,
    so a revocation cannot land between that check and the change. Driven here alone."""
    from apps.billing.complimentary import ComplimentaryRefusedError, settle_complimentary
    from apps.identity.command_principal import staff_principal_for_command

    placed = place(w, offer())
    reader = staff_principal_for_command(staff("reader", roles=("staff_support",)).id)
    with pytest.raises(ComplimentaryRefusedError, match="no current staff_operator grant"):
        settle_complimentary(
            principal=reader,
            organisation_id=w.organisation.id,
            order_id=placed.order.id,
            reason=REASON,
        )
    assert rows(placed) == ("placed", "pending", "issued", "ordered")


def reverse_0011():
    """billing 0011's reverse SQL, in a transaction that is always rolled back."""
    from importlib import import_module

    from django.db import connection, transaction

    reverse = import_module("apps.billing.migrations.0011_complimentary_credit_reason").REVERSE
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(reverse)
        transaction.set_rollback(True)


def test_billing_0011_is_not_reversed_while_a_complimentary_credit_note_exists(capsys, w):
    from django.db import OperationalError

    reverse_0011()  # No complimentary credit note: the reverse goes through.
    placed = place(w, offer())
    assert settle(capsys, w, placed)[0] == 0
    with pytest.raises(OperationalError, match="complimentary credit notes exist; billing 0011"):
        reverse_0011()
    assert CreditNote.objects.get().reason == "complimentary"


ROOT = Path(__file__).resolve().parents[1]


def operator_environment():
    """What the operator profile is given on a host, pointed at this test database: the fixed
    selector, synthetic secrets, the staff issuer on the staff lane of the trust, and the API's
    invoice series and application URLs."""
    db = connection.settings_dict
    url = (
        f"postgresql://{quote(db['USER'], safe='')}:{quote(db['PASSWORD'], safe='')}"
        f"@{db['HOST'] or 'localhost'}:{db['PORT'] or 5432}/{db['NAME']}"
    )
    public = json.loads(
        jwt.algorithms.ECAlgorithm.to_jwk(ec.generate_private_key(ec.SECP256R1()).public_key())
    )
    public.update(kid="operator-probe", alg="ES256", use="sig", key_ops=["verify"])
    trust = [
        {
            "lane": "staff",
            "issuer": STAFF_ISSUER,
            "generation": "operator-probe",
            "expires_at": int(time.time()) + 3600,
            "public_jwks": {"keys": [public]},
        }
    ]
    return {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": str(ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",
        "DJANGO_SETTINGS_MODULE": "config.settings.deploy_operator",
        "DJANGO_SECRET_KEY": "synthetic-operator-only-" + "abc0123456789" * 5,
        "DJANGO_ALLOWED_HOSTS": "operator.synthetic.test",
        "DATABASE_URL": url,
        "KODERA_INTAKE_ADMITTED": "1",
        "KODERA_AUTH_TRUST": json.dumps(trust),
        "KODERA_STAFF_ISSUER": STAFF_ISSUER,
        "KODERA_INVOICE_SERIES": settings.KODERA_INVOICE_SERIES,
        "KODERA_TENANT_APP_URLS": json.dumps(settings.KODERA_TENANT_APP_URLS),
    }


@pytest.mark.parametrize("with_link", [False, True], ids=["no-link", "active-link"])
def test_the_operator_profile_settles_an_order_on_the_real_database(w, request, with_link):
    """`manage.py settle_complimentary_order --settings config.settings.deploy_operator`, as the
    operator runs it on a host, end to end against this database: the profile installs billing,
    reads the API's series for the credit note and its application URLs for the tenant line. With
    an active link, the link is cancelled in the commit and, with no provider on this profile, its
    withdrawal is logged as not done, and the commit stands."""
    placed = place(w, offer())
    link = None
    if with_link:
        request.getfixturevalue("fake")
        link = payments.create_payment_link(
            invoice_id=placed.invoice.id, organisation_id=w.organisation.id
        ).link
    result = subprocess.run(  # noqa: S603 - the fixed interpreter and the repository's manage.py
        [
            sys.executable,
            "-B",
            "manage.py",
            "settle_complimentary_order",
            "--staff-identity",
            str(w.operator.id),
            "--organisation",
            w.organisation.slug,
            "--order",
            str(placed.order.id),
            "--reason",
            REASON,
        ],
        cwd=ROOT,
        env=operator_environment(),
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    withdrawal = (
        ""
        if link is None
        else f"payment link {link.provider_ref} not withdrawn: fake is not configured\n"
    )
    assert (result.returncode, result.stderr) == (0, withdrawal), result.stdout
    if link is not None:
        assert PaymentLink.objects.get(id=link.id).state == "cancelled"
    (note,) = CreditNote.objects.filter(invoice_id=placed.invoice.id)
    assert note.number.startswith(f"AV-{settings.KODERA_INVOICE_SERIES}-")
    tenant = Tenant.objects.get(id=placed.order.tenant_id)
    assert result.stdout.splitlines() == [
        f"settle_complimentary_order organisation={w.organisation.id} order={placed.order.id} "
        f"credit_note={note.number} subscription=activated staff_identity={w.operator.id} "
        "outcome=complimentary",
        f"tenant={tenant.id} slug={tenant.slug} realm={tenant.realm or '-'} "
        f"host.visio={tenant.slug}.visio.customer.test",
    ]
    assert rows(placed) == ("paid", "active", "credited", "ordered")
    row = AuditEvent.objects.get(action="order.complimentary")
    assert (row.actor_type, row.actor_id) == ("staff", w.operator.id)
