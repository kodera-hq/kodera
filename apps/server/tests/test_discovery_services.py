"""Actual migrated PostgreSQL quota transactions and coherent realm selection."""

import base64
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.core.management import call_command
from django.db import DatabaseError, IntegrityError, connection, connections, transaction
from django.utils import timezone
from owner_claim_fixtures import activate_owner_history_fixture, owner_world as owner_world
from test_operator_realm_bootstrap import http_signer as http_signer, w as w

from apps.identity import discovery_quotas as quotas
from apps.identity.discovery import DiscoveryRefusedError, discover
from apps.identity.discovery_db import Deadline
from apps.identity.models import DiscoveryQuotaEvent, DiscoveryQuotaGate, User
from apps.jobs.keys import derive_key
from apps.jobs.models import Job
from apps.orgs.discovery_selectors import select_realms
from apps.orgs.models import Membership, Organisation, RealmReadiness
from services.identity.discovery_policy import (
    DiscoveryUnavailableError,
    bucket_digest,
    value_bucket,
)

pytestmark = pytest.mark.django_db(transaction=True)
KEY = bytes(range(32))
# Not the test profile's default identity provider: discovery must follow the configured one.
DEPLOYED_IDP = "https://auth.staging.kodera.io/realms/"


@pytest.fixture(autouse=True)
def quota_configuration(settings, transactional_db, monkeypatch, request):
    assert connection.vendor == "postgresql"
    settings.KODERA_DISCOVERY_HMAC_KEY = base64.b64encode(KEY).decode()
    DiscoveryQuotaGate.objects.get_or_create(singleton=True)
    # Run the synthetic operator fixture under a non-default KODERA_STAFF_ISSUER, as a
    # deployment would (staging's identity provider); its public-document fetch stays in-process.
    # Parametrized False, the test profile's default issuer is kept.
    if getattr(request, "param", True):
        import test_operator_realm_bootstrap as operator_fixture

        monkeypatch.setattr(operator_fixture, "STAFF_ISSUER", DEPLOYED_IDP + "kodera-staff")
        monkeypatch.setattr(operator_fixture, "ISSUER", DEPLOYED_IDP + operator_fixture.SLUG)
        settings.KODERA_STAFF_ISSUER = DEPLOYED_IDP + "kodera-staff"


def test_configuration_refuses_before_database_queries(settings, django_assert_num_queries):
    settings.KODERA_DISCOVERY_HMAC_KEY = "invalid"
    with django_assert_num_queries(0), pytest.raises(DiscoveryUnavailableError):
        quotas.admit_peer("192.0.2.1")
    assert DiscoveryQuotaEvent.objects.count() == 0


def test_global_and_peer_share_one_event_without_raw_inputs():
    decision = quotas.admit_peer("::ffff:192.0.2.1")
    assert decision.admitted and decision.remaining == 29
    row = DiscoveryQuotaEvent.objects.get()
    assert row.scope == "entry" and row.digest == bucket_digest(KEY, "ip", "192.0.2.1")
    assert "192.0.2.1" not in repr(row.__dict__)
    assert {f.name for f in row._meta.fields} == {"id", "scope", "digest", "occurred_at"}


def test_quota_ids_are_uuid7_and_singleton_or_id_collisions_refuse():
    gate = DiscoveryQuotaGate.objects.get(singleton=True)
    assert gate.pk.version == 7
    quotas.admit_peer("192.0.2.1")
    event = DiscoveryQuotaEvent.objects.get()
    assert event.pk.version == 7
    with pytest.raises(IntegrityError), transaction.atomic():
        DiscoveryQuotaGate.objects.create(singleton=True)
    with pytest.raises(IntegrityError), transaction.atomic():
        DiscoveryQuotaEvent.objects.create(id=event.id, scope="domain", digest="0" * 64)
    event.refresh_from_db()
    assert event.scope == "entry" and DiscoveryQuotaEvent.objects.count() == 1


@pytest.mark.parametrize(
    "kind,value,limit", [("slug", "alpha", 60), ("domain", "example.test", 300)]
)
def test_each_value_limit_refuses_without_allocating_or_extending(kind, value, limit):
    for _ in range(limit):
        assert quotas.admit_value(kind, value, "192.0.2.1").admitted
    before = list(DiscoveryQuotaEvent.objects.values_list("id", "occurred_at"))
    refused = quotas.admit_value(kind, value, "192.0.2.1")
    assert not refused.admitted and refused.scope == kind and refused.remaining == 0
    assert 1 <= refused.retry_after_s <= 60
    assert before == list(DiscoveryQuotaEvent.objects.values_list("id", "occurred_at"))


@pytest.mark.parametrize(
    "kind,value,limit", [("slug", "alpha", 60), ("domain", "example.test", 300)]
)
def test_a_stranger_exhausting_a_value_never_locks_another_client_out(kind, value, limit):
    for _ in range(limit):
        assert quotas.admit_value(kind, value, "203.0.113.7").admitted
    assert not quotas.admit_value(kind, value, "203.0.113.7").admitted
    tenant = quotas.admit_value(kind, value, "192.0.2.1")
    assert tenant.admitted and tenant.remaining == limit - 1
    stored = set(DiscoveryQuotaEvent.objects.values_list("digest", flat=True))
    assert bucket_digest(KEY, kind, value) not in stored, "a value bucket shared by every client"


def test_one_ipv6_64_is_one_client():
    for i in range(30):
        assert quotas.admit_peer(f"2001:db8:1:2::{i + 1:x}").admitted
    assert not quotas.admit_peer("2001:db8:1:2:ffff::1").admitted
    assert quotas.admit_peer("2001:db8:1:3::1").admitted


def test_peer_and_global_limits_are_independent():
    for i in range(600):
        assert quotas.admit_peer(f"192.0.2.{i % 20 + 1}").admitted
    refused = quotas.admit_peer("198.51.100.1")
    assert not refused.admitted and refused.scope == "global"
    assert DiscoveryQuotaEvent.objects.count() == 600


def test_exact_boundary_and_cleanup_share_database_clock(monkeypatch):
    now = timezone.now()
    monkeypatch.setattr(quotas, "database_now", lambda: now)
    DiscoveryQuotaEvent.objects.bulk_create(
        [
            DiscoveryQuotaEvent(
                scope="entry",
                digest=bucket_digest(KEY, "ip", "192.0.2.1"),
                occurred_at=now - timedelta(seconds=60),
            )
            for _ in range(30)
        ]
    )
    assert quotas.admit_peer("192.0.2.1").admitted
    assert DiscoveryQuotaEvent.objects.count() == 1


def test_cap_fails_closed_without_evicting_live_events():
    now = timezone.now()
    DiscoveryQuotaEvent.objects.bulk_create(
        [DiscoveryQuotaEvent(scope="slug", digest="0" * 64, occurred_at=now) for _ in range(10000)]
    )
    with pytest.raises(DiscoveryUnavailableError) as error:
        quotas.admit_peer("192.0.2.1")
    assert error.value.reason == "capacity" and DiscoveryQuotaEvent.objects.count() == 10000


def test_cleanup_command_removes_only_expired_rows():
    now = timezone.now()
    DiscoveryQuotaEvent.objects.create(
        scope="slug", digest="0" * 64, occurred_at=now - timedelta(seconds=181)
    )
    live = DiscoveryQuotaEvent.objects.create(scope="domain", digest="1" * 64, occurred_at=now)
    call_command("cleanup_discovery_quotas")
    assert list(DiscoveryQuotaEvent.objects.values_list("id", flat=True)) == [live.id]


def test_competing_last_peer_slot_admits_exactly_one():
    for _ in range(29):
        assert quotas.admit_peer("192.0.2.1").admitted
    barrier = threading.Barrier(8)

    def contend(_):
        try:
            connections.close_all()
            barrier.wait(timeout=5)
            return quotas.admit_peer("192.0.2.1").admitted
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(contend, range(8)))
    assert sum(results) == 1 and DiscoveryQuotaEvent.objects.count() == 30


@pytest.mark.parametrize("scope", ["global", "slug", "domain", "capacity"])
def test_all_shared_last_slots_serialize(scope):
    now = timezone.now()
    count = {"global": 599, "slug": 59, "domain": 299, "capacity": 9999}[scope]
    stored_scope = "entry" if scope == "global" else "slug" if scope == "capacity" else scope
    value = "example.test" if scope == "domain" else "alpha"
    digest = bucket_digest(KEY, stored_scope, value_bucket("198.51.100.1", value))
    DiscoveryQuotaEvent.objects.bulk_create(
        [
            DiscoveryQuotaEvent(scope=stored_scope, digest=digest, occurred_at=now)
            for _ in range(count)
        ]
    )
    barrier = threading.Barrier(8)

    def contend(_):
        try:
            connections.close_all()
            barrier.wait(timeout=5)
            try:
                decision = (
                    quotas.admit_peer("198.51.100.1")
                    if scope in {"global", "capacity"}
                    else quotas.admit_value(scope, value, "198.51.100.1")
                )
                return decision.admitted
            except DiscoveryUnavailableError as error:
                assert scope == "capacity" and error.reason == "capacity"
                return False
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(contend, range(8)))
    assert sum(results) == 1 and DiscoveryQuotaEvent.objects.count() == count + 1


def test_manual_or_nested_transaction_refuses():
    with transaction.atomic(), pytest.raises(DiscoveryUnavailableError):
        quotas.admit_peer("192.0.2.1")
    connection.set_autocommit(False)
    try:
        with pytest.raises(DiscoveryUnavailableError):
            quotas.admit_peer("192.0.2.1")
    finally:
        connection.rollback()
        connection.set_autocommit(True)


def test_elapsed_budget_and_uncertain_commit_never_select(monkeypatch):
    with pytest.raises(DiscoveryUnavailableError):
        quotas.admit_peer("192.0.2.1", _deadline=Deadline(seconds=-1))
    commit = connection.commit

    def lost_ack():
        commit()
        raise DatabaseError("synthetic commit acknowledgement lost")

    with (
        patch.object(connection, "commit", side_effect=lost_ack),
        patch("apps.identity.discovery.select_realms") as selection,
    ):
        with pytest.raises(DiscoveryUnavailableError):
            discover(
                b'{"slug":"alpha"}',
                peer="192.0.2.1",
                content_type="application/json",
                compatibility_key="public-key-00001",
            )
    selection.assert_not_called()
    assert DiscoveryQuotaEvent.objects.count() == 1
    assert quotas.admit_peer("192.0.2.1").remaining == 28


def test_database_budget_shrinks_across_statements():
    from apps.identity.discovery_db import discovery_transaction

    with pytest.raises(DiscoveryUnavailableError), discovery_transaction(Deadline(seconds=0.15)):
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_sleep(0.1)")
            cursor.execute("SELECT pg_sleep(0.1)")


def test_commit_has_refreshed_timeout_and_joined_watchdog():
    from apps.identity.discovery_db import discovery_transaction

    original = connection.commit

    def delayed_commit():
        with connection.cursor() as cursor:
            cursor.execute("SHOW statement_timeout")
            timeout = cursor.fetchone()[0]
            assert timeout.endswith("ms") and int(timeout[:-2]) < 150
            cursor.execute("SELECT pg_sleep(0.25)")
        original()

    with patch.object(connection, "commit", side_effect=delayed_commit):
        with (
            pytest.raises(DiscoveryUnavailableError),
            discovery_transaction(Deadline(seconds=0.15)),
        ):
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_sleep(0.06)")
    assert not any(t.name == "kodera-discovery-db-deadline" for t in threading.enumerate())


def test_missing_bounded_cancellation_refuses_before_queries(
    monkeypatch, django_assert_num_queries
):
    from apps.identity import discovery_db

    monkeypatch.setattr(discovery_db.capabilities, "has_cancel_safe", lambda: False)
    with django_assert_num_queries(0), pytest.raises(DiscoveryUnavailableError) as error:
        quotas.admit_peer("192.0.2.1")
    assert error.value.reason == "database-cancellation"


def test_malformed_request_charges_peer_only_and_same_keys_never_replay():
    for _ in range(2):
        with pytest.raises(DiscoveryRefusedError) as error:
            discover(
                b"{",
                peer="192.0.2.1",
                content_type="application/json",
                compatibility_key="public-key-00001",
            )
        assert error.value.status == 400
    assert list(DiscoveryQuotaEvent.objects.values_list("scope", flat=True)) == ["entry", "entry"]


def test_domain_lookup_is_the_zero_result_after_both_charges():
    # No verified organisation/domain association exists until its proof producer does.
    result = discover(
        b'{"email":"private-person@example.test"}',
        peer="192.0.2.1",
        content_type="application/json",
        compatibility_key="public-key-00001",
    )
    assert result.selection == dict(
        realm=None, issuer=None, openid_configuration_url=None, organisation=None, candidates=[]
    )
    assert result.quota.scope == "ip" and result.quota.remaining == 29
    assert sorted(DiscoveryQuotaEvent.objects.values_list("scope", flat=True)) == [
        "domain",
        "entry",
    ]
    assert all(
        "private-person" not in str(v) and "example.test" not in str(v)
        for v in DiscoveryQuotaEvent.objects.values()
    )


@pytest.fixture
def ready(owner_world):
    world = owner_world
    with transaction.atomic():
        user = User.objects.create(email="synthetic-owner@customer.test")
        Membership.objects.create(
            user=user,
            organisation=world.organisation,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        activate_owner_history_fixture(world.organisation.id)
    world.organisation.refresh_from_db()
    return world


def test_ready_slug_result_is_exact_and_unknown_is_equal_zero(ready):
    result = select_realms("slug", ready.organisation.slug)
    assert result["realm"] == result["organisation"]["slug"] == ready.organisation.slug
    assert result["issuer"] == ready.organisation.issuer
    assert (
        result["openid_configuration_url"]
        == ready.organisation.issuer + "/.well-known/openid-configuration"
    )
    assert result["candidates"] == []
    assert set(result["organisation"]) == {"id", "slug", "name", "realm"}
    assert select_realms("slug", "unknown") == dict(
        realm=None, issuer=None, openid_configuration_url=None, organisation=None, candidates=[]
    )


@pytest.mark.parametrize("state", ["prospect", "closed", "suspended"])
def test_only_active_and_suspended_organisations_are_visible(ready, state):
    Organisation.objects.filter(id=ready.organisation.id).update(state=state)
    assert (select_realms("slug", ready.organisation.slug)["realm"] is not None) == (
        state == "suspended"
    )


def test_trust_and_readiness_withdrawal_are_current_even_with_same_key(ready):
    args = dict(
        peer="192.0.2.1", content_type="application/json", compatibility_key="public-key-00001"
    )
    body = ('{"slug":"' + ready.organisation.slug + '"}').encode()
    assert discover(body, **args).selection["realm"]
    ready.settings.KODERA_AUTH_TRUST = ()
    assert discover(body, **args).selection["realm"] is None
    assert DiscoveryQuotaEvent.objects.count() == 4


def test_fact_revocation_and_new_job_generation_withdraw(ready):
    RealmReadiness.objects.filter(organisation=ready.organisation).update(revoked_at=timezone.now())
    assert select_realms("slug", ready.organisation.slug)["realm"] is None


def test_latest_job_replacement_cannot_reuse_old_fact(ready):
    Job.objects.create(
        organisation_id=ready.organisation.id,
        kind="realm_create",
        idempotency_key=derive_key(["new-generation", ready.job_id]),
        desired_spec_hash=derive_key(["new-spec", ready.organisation.id]),
        max_attempts=3,
        actor_type="staff",
        actor_id=ready.operator.id,
        status="succeeded",
    )
    assert select_realms("slug", ready.organisation.slug)["realm"] is None


def test_expired_customer_trust_is_not_ready(ready):
    ready.settings.KODERA_AUTH_TRUST = tuple(
        replace(entry, snapshot=replace(entry.snapshot, expires_at=1))
        for entry in ready.settings.KODERA_AUTH_TRUST
    )
    assert select_realms("slug", ready.organisation.slug)["realm"] is None


def test_the_issuer_is_the_configured_identity_providers(ready):
    assert ready.organisation.issuer == DEPLOYED_IDP + ready.organisation.slug
    assert select_realms("slug", ready.organisation.slug)["issuer"] == ready.organisation.issuer


@pytest.mark.parametrize("quota_configuration", [False], indirect=True)
def test_the_test_profiles_default_issuer_is_discoverable_too(ready):
    assert ready.organisation.issuer.startswith("https://identity.staff.test/")
    assert select_realms("slug", ready.organisation.slug)["issuer"] == ready.organisation.issuer


def test_otherwise_trusted_issuer_at_another_provider_is_not_discoverable(ready, settings):
    settings.KODERA_STAFF_ISSUER = "https://identity.staff.test/realms/kodera-staff"
    assert select_realms("slug", ready.organisation.slug)["realm"] is None


def test_no_configured_staff_issuer_is_unavailable_not_zero(ready, settings):
    settings.KODERA_STAFF_ISSUER = None
    with pytest.raises(DiscoveryUnavailableError) as error:
        select_realms("slug", ready.organisation.slug)
    assert error.value.reason == "configuration"


def test_staff_lane_only_and_deleted_organisation_are_not_discoverable(ready):
    original = ready.settings.KODERA_AUTH_TRUST
    ready.settings.KODERA_AUTH_TRUST = tuple(replace(entry, lane="staff") for entry in original)
    assert select_realms("slug", ready.organisation.slug)["realm"] is None
    ready.settings.KODERA_AUTH_TRUST = original
    now = timezone.now()
    Organisation.objects.filter(id=ready.organisation.id).update(
        deleted_at=now, purge_after=now + timedelta(days=1)
    )
    assert select_realms("slug", ready.organisation.slug)["realm"] is None


def test_missing_gate_and_storage_failure_are_safe():
    DiscoveryQuotaGate.objects.all().delete()
    with pytest.raises(DiscoveryUnavailableError) as error:
        quotas.admit_peer("192.0.2.1")
    assert error.value.reason == "quota-storage"
    DiscoveryQuotaGate.objects.create(singleton=True)
    with patch.object(
        DiscoveryQuotaEvent.objects, "count", side_effect=DatabaseError("synthetic storage failure")
    ):
        with pytest.raises(DiscoveryUnavailableError) as error:
            quotas.admit_peer("192.0.2.1")
    assert error.value.reason == "database" and "synthetic" not in str(error.value)


def test_typed_exhaustion_preserves_peer_charge_without_selection():
    for _ in range(60):
        assert quotas.admit_value("slug", "alpha", "192.0.2.1").admitted
    with patch("apps.identity.discovery.select_realms") as selection:
        with pytest.raises(DiscoveryRefusedError) as error:
            discover(
                b'{"slug":"alpha"}',
                peer="192.0.2.1",
                content_type="application/json",
                compatibility_key="public-key-00001",
            )
    assert error.value.status == 429 and error.value.quota.scope == "slug"
    selection.assert_not_called()
    assert DiscoveryQuotaEvent.objects.filter(scope="entry").count() == 1
    assert DiscoveryQuotaEvent.objects.filter(scope="slug").count() == 60


def test_typed_dependency_failure_preserves_evaluated_peer_counter():
    with patch(
        "apps.identity.discovery.admit_value", side_effect=DiscoveryUnavailableError("database")
    ):
        with pytest.raises(DiscoveryUnavailableError) as error:
            discover(
                b'{"slug":"alpha"}',
                peer="192.0.2.1",
                content_type="application/json",
                compatibility_key="public-key-00001",
            )
    assert error.value.quota.scope == "ip" and error.value.quota.remaining == 29


def test_selection_owns_a_read_only_repeatable_snapshot(ready):
    from apps.orgs import discovery_selectors as selection

    original = selection.counting_realm_ready

    def inspect_snapshot(**kwargs):
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT current_setting('transaction_isolation'), current_setting('transaction_read_only')"
            )
            assert cursor.fetchone() == ("repeatable read", "on")
        return original(**kwargs)

    with patch.object(selection, "counting_realm_ready", side_effect=inspect_snapshot):
        assert select_realms("slug", ready.organisation.slug)["realm"]


def test_revocation_between_snapshot_queries_is_seen_on_next_read(ready):
    from apps.orgs import discovery_selectors as selection

    original = selection.counting_realm_ready

    def revoke():
        try:
            connections.close_all()
            RealmReadiness.objects.filter(organisation=ready.organisation).update(
                revoked_at=timezone.now()
            )
        finally:
            connections.close_all()

    def interleave(**kwargs):
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(revoke).result(timeout=3)
        return original(**kwargs)

    with patch.object(selection, "counting_realm_ready", side_effect=interleave):
        assert select_realms("slug", ready.organisation.slug)["realm"]
    assert select_realms("slug", ready.organisation.slug)["realm"] is None


ARGS = dict(peer="192.0.2.1", content_type="application/json", compatibility_key="public-key-00001")


@pytest.mark.parametrize(
    "headers,status,reason",
    [
        (dict(content_type="text/plain"), 415, "media-type"),
        (dict(content_type="application/x-www-form-urlencoded"), 415, "media-type"),
        (dict(compatibility_key=None), 400, "key-missing"),
        (dict(compatibility_key="short"), 400, "key-shape"),
        (dict(fetch_site="cross-site", origin="https://attacker.example"), 403, "cross-site"),
        (dict(origin="https://attacker.example"), 403, "origin"),
        (dict(origin="https://app.kodera.io", fetch_site="cross-site"), 403, "cross-site"),
    ],
)
def test_header_refusals_charge_no_quota_and_read_no_body(settings, headers, status, reason):
    settings.KODERA_CONSOLE_ORIGINS = "https://app.kodera.io"

    def body():
        raise AssertionError("the body must not be read")

    with pytest.raises(DiscoveryRefusedError) as error:
        discover(body, **{**ARGS, **headers})
    assert (error.value.status, error.value.reason, error.value.quota) == (status, reason, None)
    assert DiscoveryQuotaEvent.objects.count() == 0


@pytest.mark.parametrize(
    "headers",
    [{}, dict(origin="https://app.kodera.io", fetch_site="same-origin"), dict(fetch_site="none")],
)
def test_native_and_console_requests_are_charged(settings, headers):
    settings.KODERA_CONSOLE_ORIGINS = "https://app.kodera.io"
    result = discover(b'{"slug":"alpha"}', **{**ARGS, **headers})
    assert result.selection["realm"] is None
    assert DiscoveryQuotaEvent.objects.count() == 2


def test_malformed_console_origins_fail_browser_requests_before_quota(settings):
    settings.KODERA_CONSOLE_ORIGINS = "*"
    with pytest.raises(DiscoveryUnavailableError) as error:
        discover(b'{"slug":"alpha"}', **ARGS, origin="https://app.kodera.io")
    assert error.value.reason == "configuration" and error.value.quota is None
    assert DiscoveryQuotaEvent.objects.count() == 0
    assert discover(b'{"slug":"alpha"}', **ARGS).selection["realm"] is None
