"""The writer cannot admit a partially NULL first KeyPackage claim."""

import os

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone
from test_e2ee_relay import operation, relay as relay
from test_e2ee_relay_http import writer as writer
from test_intake_writer_role import acting_as
from workspace_safety.test_moderation import world as world

from apps.e2ee.models import KeyPackage

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.mark.parametrize("invalid_epoch", [None, -1])
def test_writer_first_claim_requires_a_present_nonnegative_epoch(relay, writer, invalid_epoch):
    # The real service creates an ordinary, correctly scoped, unclaimed package.
    from test_e2ee_relay import b64

    with acting_as(writer):
        operation(relay, "publish_package", 2, {"keyPackage": b64(os.urandom(64))})
    package = KeyPackage.objects.get(device_id=relay[5][2])
    original_bytes = bytes(package.package)
    original_reference = bytes(package.reference)
    assert (
        package.claimed_at,
        package.claimed_by_id,
        package.claimed_for_id,
        package.claimed_epoch,
    ) == (None, None, None, None)
    claimed_at = timezone.now()
    with acting_as(writer), pytest.raises(IntegrityError) as failure:
        with transaction.atomic():
            # Exercise the initial claim, not the separate immutable-reclaim trigger.
            KeyPackage.objects.filter(pk=package.id).update(
                claimed_at=claimed_at,
                claimed_by_id=relay[5][0],
                claimed_for_id=relay[6],
                claimed_epoch=invalid_epoch,
            )
    assert failure.value.__cause__.sqlstate == "23514"
    assert failure.value.__cause__.diag.constraint_name == "e2ee_package_claim_pair"
    package.refresh_from_db()
    assert (
        package.claimed_at,
        package.claimed_by_id,
        package.claimed_for_id,
        package.claimed_epoch,
    ) == (None, None, None, None)
    assert bytes(package.package) == original_bytes
    assert bytes(package.reference) == original_reference
    # A real writer may still make the corresponding complete claim at epoch zero.
    with acting_as(writer), transaction.atomic():
        assert (
            KeyPackage.objects.filter(pk=package.id).update(
                claimed_at=claimed_at,
                claimed_by_id=relay[5][0],
                claimed_for_id=relay[6],
                claimed_epoch=0,
            )
            == 1
        )
    package.refresh_from_db()
    assert package.claimed_at == claimed_at
    assert package.claimed_by_id == relay[5][0]
    assert package.claimed_for_id == relay[6]
    assert package.claimed_epoch == 0
    assert bytes(package.package) == original_bytes
    assert bytes(package.reference) == original_reference
