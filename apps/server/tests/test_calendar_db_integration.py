"""PostgreSQL 16 integration tests for calendar privacy, CalDAV sync, booking, and statutory erasure."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from django.db import IntegrityError, connection
from django.db.migrations.executor import MigrationExecutor
from django.test import RequestFactory, override_settings
from django.utils import timezone
from test_core_erasure import begin as begin_org_erasure, operator
from workspace_safety.test_moderation import world as world

from apps.calendar import services as calendar_services
from apps.calendar.api import views as calendar_views
from apps.calendar.caldav_sync import (
    CalDavAdapter,
    CalDavCollectionInfo,
    CalDavResourceDelta,
    CalDavSyncBatch,
)
from apps.calendar.errors import CalendarRefusalError
from apps.calendar.ics import IcsEvent, parse_calendar
from apps.calendar.models import BookingPage, BookingSlotReservation, CalDavSource, CalendarEvent
from apps.calendar.sealing import CalDavSecretConfig
from apps.docs.models import Document
from apps.orgs.account_erasure_services import begin_account_erasure, purge_account_core
from apps.orgs.erasure_services import advance_erasure, database_now
from apps.orgs.models import Membership, Organisation
from core.idempotency.models import IdempotencyRecord

pytestmark = pytest.mark.django_db(transaction=True)

TEST_CALENDAR_SEAL_KEY = bytes(range(32))


class _FakeCalDavAdapter(CalDavAdapter):
    def __init__(
        self,
        config: CalDavSecretConfig,
        *,
        batch: CalDavSyncBatch,
        info: CalDavCollectionInfo | None = None,
    ) -> None:
        super().__init__(config)
        self._batch = batch
        self._info = info or CalDavCollectionInfo(
            display_name="Agenda Souverain",
            supports_calendar=True,
            sync_token="tok-0",
            ctag="ctag-0",
        )

    def discover_collection(self) -> CalDavCollectionInfo:
        return self._info

    def sync_collection(self, *, sync_token: str | None = None) -> CalDavSyncBatch:
        _ = sync_token
        return self._batch


@override_settings(KODERA_CALENDAR_SEAL_KEY=TEST_CALENDAR_SEAL_KEY)
def test_caldav_sync_class_privacy_owner_binding_uid_isolation_and_full_resync_orphans(
    world,
) -> None:
    org, workspace, members, tokens = world
    owner_token, admin_token, member_token, _ = tokens
    owner_member, admin_member, regular_member, _ = members

    # Regular member is forbidden from listing or creating CalDAV sources (admin-only surface)
    with pytest.raises(CalendarRefusalError) as forbidden_exc:
        calendar_services.list_caldav_sources(verified=member_token, organisation_id=org.id)
    assert forbidden_exc.value.status == 403

    # Native Kodera event with shared UID — remote CalDAV sync MUST NEVER overwrite it!
    native_start = datetime(2026, 6, 15, 9, 0, tzinfo=UTC)
    native_end = datetime(2026, 6, 15, 10, 0, tzinfo=UTC)
    native_ev = CalendarEvent.objects.create(
        organisation=org,
        workspace=workspace,
        organizer_membership=regular_member,
        source=None,
        uid="shared-uid@kodera.calendar",
        title="Événement natif protégé",
        starts_at=native_start,
        ends_at=native_end,
        timezone="UTC",
        status="confirmed",
        visibility="workspace",
    )

    source_payload = calendar_services.create_caldav_source(
        verified=owner_token,
        organisation_id=org.id,
        body={
            "name": "Agenda Direction",
            "provider": "lasuite",
            "calendarUrl": "https://agenda.numerique.gouv.fr/caldav/equipe",
            "username": "owner@kodera.io",
            "password": "app-password-secret",
        },
        request_id=str(uuid4()),
    )
    assert source_payload["calendarUrl"] == "https://agenda.numerique.gouv.fr/caldav/equipe/"
    source_id = UUID(source_payload["id"])

    # Trigger sync as org_admin (NOT owner_member): synced events MUST still bind to owner_member!
    dtstamp = datetime(2026, 6, 1, 8, 0, tzinfo=UTC)
    batch_1 = CalDavSyncBatch(
        sync_token="tok-2",
        full_resync=False,
        deltas=(
            CalDavResourceDelta(
                href="https://agenda.numerique.gouv.fr/caldav/equipe/shared.ics",
                etag='"e1"',
                deleted=False,
                events=(
                    IcsEvent(
                        uid="shared-uid@kodera.calendar",
                        dtstamp=dtstamp,
                        dtstart=native_start,
                        dtend=native_end,
                        summary="Tentative collision distante PRIVÉE",
                        classification="PRIVATE",
                    ),
                ),
            ),
            CalDavResourceDelta(
                href="https://agenda.numerique.gouv.fr/caldav/equipe/conf.ics",
                etag='"e2"',
                deleted=False,
                events=(
                    IcsEvent(
                        uid="conf-uid@kodera.calendar",
                        dtstamp=dtstamp,
                        dtstart=native_start + timedelta(hours=2),
                        dtend=native_end + timedelta(hours=2),
                        summary="Comité salarial confidentiel",
                        description="Notes RH confidentielles",
                        location="Bureau 404",
                        classification="CONFIDENTIAL",
                    ),
                ),
            ),
            CalDavResourceDelta(
                href="https://agenda.numerique.gouv.fr/caldav/equipe/vanish.ics",
                etag='"e3"',
                deleted=False,
                events=(
                    IcsEvent(
                        uid="vanish-uid@kodera.calendar",
                        dtstamp=dtstamp,
                        dtstart=native_start + timedelta(hours=4),
                        dtend=native_end + timedelta(hours=4),
                        summary="Point public temporaire",
                        classification="PUBLIC",
                    ),
                ),
            ),
        ),
    )
    sync_res = calendar_services.sync_caldav_source(
        verified=admin_token,
        organisation_id=org.id,
        source_id=source_id,
        request_id=str(uuid4()),
        adapter_factory=lambda cfg, _org: _FakeCalDavAdapter(cfg, batch=batch_1),
    )
    assert sync_res["upserted"] == 3

    # Native event is 100% untouched
    native_ev.refresh_from_db()
    assert native_ev.title == "Événement natif protégé"
    assert native_ev.organizer_membership_id == regular_member.id

    # Synced events belong to source.owner_membership_id (owner_member), NOT admin_member!
    synced_private = CalendarEvent.objects.get(
        workspace=workspace, source_id=source_id, uid="shared-uid@kodera.calendar"
    )
    assert synced_private.organizer_membership_id == owner_member.id
    assert synced_private.organizer_membership_id != admin_member.id
    assert synced_private.visibility == "private"

    synced_conf = CalendarEvent.objects.get(
        workspace=workspace, source_id=source_id, uid="conf-uid@kodera.calendar"
    )
    assert synced_conf.visibility == "busy_only"

    # Regular member sees:
    # - native_ev (workspace)
    # - NOT synced_private (private to owner_member)
    # - synced_conf redacted as "Occupé" with empty description/location!
    member_list = calendar_services.list_calendar_events(
        verified=member_token,
        organisation_id=org.id,
        from_iso="2026-06-15T00:00:00Z",
        to_iso="2026-06-16T00:00:00Z",
    )["data"]
    titles_by_id = {item["id"]: item for item in member_list}
    assert str(native_ev.id) in titles_by_id
    assert str(synced_private.id) not in titles_by_id
    assert titles_by_id[str(synced_conf.id)]["title"] == "Occupé"
    assert titles_by_id[str(synced_conf.id)]["description"] == ""
    assert titles_by_id[str(synced_conf.id)]["location"] == ""

    # Owner sees full confidential summary and .ics export emits CLASS:PRIVATE / CLASS:CONFIDENTIAL
    owner_ics = calendar_services.export_workspace_ics(
        verified=owner_token,
        organisation_id=org.id,
    )["ics"]
    parsed_export = parse_calendar(owner_ics)
    classes_by_uid = {
        ev.uid: ev.classification for ev in parsed_export.events if ev.uid != native_ev.uid
    }
    assert classes_by_uid["conf-uid@kodera.calendar"] == "CONFIDENTIAL"
    assert classes_by_uid["vanish-uid@kodera.calendar"] == "PUBLIC"

    # Full resync where vanish-uid disappeared marks it cancelled AND updates conf-uid CLASS -> PRIVATE
    batch_resync = CalDavSyncBatch(
        sync_token="tok-3",
        full_resync=True,
        deltas=(
            CalDavResourceDelta(
                href="https://agenda.numerique.gouv.fr/caldav/equipe/conf.ics",
                etag='"e2-v2"',
                deleted=False,
                events=(
                    IcsEvent(
                        uid="conf-uid@kodera.calendar",
                        dtstamp=dtstamp,
                        dtstart=native_start + timedelta(hours=2),
                        dtend=native_end + timedelta(hours=2),
                        summary="Devenu strictement privé",
                        classification="PRIVATE",
                    ),
                ),
            ),
        ),
    )
    resync_out = calendar_services.sync_caldav_source(
        verified=owner_token,
        organisation_id=org.id,
        source_id=source_id,
        request_id=str(uuid4()),
        adapter_factory=lambda cfg, _org: _FakeCalDavAdapter(cfg, batch=batch_resync),
    )
    assert resync_out["fullResync"] is True
    assert resync_out["removed"] >= 2  # shared-uid & vanish-uid absent from full resync
    synced_conf.refresh_from_db()
    assert synced_conf.visibility == "private"
    vanished = CalendarEvent.objects.get(
        workspace=workspace, source_id=source_id, uid="vanish-uid@kodera.calendar"
    )
    assert vanished.status == "cancelled"


def test_public_booking_hardening_cross_page_buffers_horizon_and_zero_idempotency_pii(
    world,
) -> None:
    org, workspace, members, tokens = world
    host_token = tokens[0]
    host_member = members[0]

    # Pick next Monday >= 2 days in the future in UTC so slots are strictly future & within horizon
    now = datetime.now(tz=UTC).replace(minute=0, second=0, microsecond=0)
    days_ahead = (7 - now.weekday()) % 7
    if days_ahead < 2:
        days_ahead += 7
    target_monday = (now + timedelta(days=days_ahead)).replace(hour=0)

    # Create two booking pages for the same host:
    # Page A: 30 min, 15 min buffer
    # Page B: 30 min, 0 min buffer
    calendar_services.create_booking_page(
        verified=host_token,
        organisation_id=org.id,
        body={
            "slug": "host-page-alpha",
            "title": "A" * 160,
            "timezone": "UTC",
            "durationMinutes": 30,
            "bufferMinutes": 15,
            "availabilityWindows": [{"weekday": 0, "start": "09:00", "end": "13:00"}],
        },
        request_id=str(uuid4()),
    )
    calendar_services.create_booking_page(
        verified=host_token,
        organisation_id=org.id,
        body={
            "slug": "host-page-beta",
            "title": "Consultation rapide",
            "timezone": "UTC",
            "durationMinutes": 30,
            "bufferMinutes": 0,
            "availabilityWindows": [{"weekday": 0, "start": "09:00", "end": "13:00"}],
        },
        request_id=str(uuid4()),
    )

    slot_1000 = (target_monday + timedelta(hours=10)).isoformat().replace("+00:00", "Z")
    slot_1030 = (target_monday + timedelta(hours=10, minutes=30)).isoformat().replace("+00:00", "Z")
    far_future = (target_monday + timedelta(days=120, hours=10)).isoformat().replace("+00:00", "Z")

    # Horizon > MAX_HORIZON_DAYS (90d) is refused with 422
    with pytest.raises(CalendarRefusalError) as horizon_exc:
        calendar_services.reserve_public_booking_slot(
            booking_slug="host-page-alpha",
            body={
                "startsAt": far_future,
                "guestName": "Invité Horizon",
                "guestEmail": "horizon@kodera.io",
            },
        )
    assert horizon_exc.value.status == 422
    assert horizon_exc.value.reason == "booking_horizon_exceeded"

    # Reserve 10:00-10:30 on Page A via HTTP view to verify zero IdempotencyRecord PII persistence
    # AND long title + guestName clamped to <= 255 chars without PostgreSQL 22001 crash!
    rf = RequestFactory()
    req_reserve = rf.post(
        "/api/v1/booking/host-page-alpha/reservations",
        data=json.dumps(
            {
                "startsAt": slot_1000,
                "guestName": "B" * 160,
                "guestEmail": "invite.alpha@kodera.io",
                "guestNotes": "Notes confidentielles invité",
            }
        ).encode("utf-8"),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY="idem-public-booking-001",
    )
    resp_reserve = calendar_views.public_booking_reservations(
        req_reserve, booking_slug="host-page-alpha"
    )
    assert resp_reserve.status_code == 201
    reserved_json = json.loads(resp_reserve.content)
    assert not IdempotencyRecord.objects.exists()

    created_ev = CalendarEvent.objects.get(workspace=workspace, uid__startswith="booking-")
    assert len(created_ev.title) == 255

    # Cross-page buffer enforcement: Page A's 10:00-10:30 reservation has 15-min buffer [09:45, 10:45],
    # so reserving 10:30-11:00 on Page B (even though Page B has 0 buffer!) MUST fail with 409!
    with pytest.raises(CalendarRefusalError) as cross_page_exc:
        calendar_services.reserve_public_booking_slot(
            booking_slug="host-page-beta",
            body={
                "startsAt": slot_1030,
                "guestName": "Invité Conflit",
                "guestEmail": "conflit@kodera.io",
            },
        )
    assert cross_page_exc.value.status == 409

    # Repeat cancellation returns 409 reservation_already_cancelled
    res_id = UUID(reserved_json["reservationId"])
    cancel_tok = reserved_json["cancellationToken"]
    first_cancel = calendar_services.cancel_public_booking_reservation(
        booking_slug="host-page-alpha",
        reservation_id=res_id,
        body={"cancellationToken": cancel_tok},
    )
    assert first_cancel["status"] == "cancelled"
    with pytest.raises(CalendarRefusalError) as second_cancel_exc:
        calendar_services.cancel_public_booking_reservation(
            booking_slug="host-page-alpha",
            reservation_id=res_id,
            body={"cancellationToken": cancel_tok},
        )
    assert second_cancel_exc.value.status == 409
    assert second_cancel_exc.value.reason == "reservation_already_cancelled"

    # Inactive host membership hides public booking page with 404 (promote members[1] first so org keeps an owner)
    Membership.objects.filter(pk=members[1].id).update(role="org_owner")
    Membership.objects.filter(pk=host_member.id).update(state="removed")
    with pytest.raises(CalendarRefusalError) as removed_host_exc:
        calendar_services.get_public_booking_page(booking_slug="host-page-alpha")
    assert removed_host_exc.value.status == 404
    Membership.objects.filter(pk=host_member.id).update(state="active")

    # Suspended organisation hides public booking page with 404
    Organisation.objects.filter(pk=org.id).update(state="suspended")
    with pytest.raises(CalendarRefusalError) as suspended_org_exc:
        calendar_services.get_public_booking_page(booking_slug="host-page-alpha")
    assert suspended_org_exc.value.status == 404
    Organisation.objects.filter(pk=org.id).update(state="active")


@override_settings(KODERA_CALENDAR_SEAL_KEY=TEST_CALENDAR_SEAL_KEY)
def test_statutory_org_erasure_succeeds_with_agenda_document_fk_and_purges_calendar_rows(
    world,
) -> None:
    org, workspace, members, tokens = world
    owner_member = members[0]
    owner_token = tokens[0]

    agenda_doc = Document.objects.create(
        workspace=workspace,
        creator=owner_member,
        title="Ordre du jour du comité",
        markdown="Contenu confidentiel",
    )
    calendar_services.create_caldav_source(
        verified=owner_token,
        organisation_id=org.id,
        body={
            "name": "Source Erasure",
            "provider": "lasuite",
            "calendarUrl": "https://agenda.numerique.gouv.fr/caldav/equipe/",
            "username": "u",
            "password": "p",
        },
        request_id=str(uuid4()),
    )
    page = BookingPage.objects.create(
        organisation=org,
        workspace=workspace,
        host_membership=owner_member,
        slug="erasure-org-slug",
        title="Page Erasure",
        timezone="UTC",
        duration_minutes=30,
        buffer_minutes=0,
        availability_windows=[{"weekday": 0, "start": "09:00", "end": "12:00"}],
    )
    ev = CalendarEvent.objects.create(
        organisation=org,
        workspace=workspace,
        organizer_membership=owner_member,
        agenda_document=agenda_doc,
        uid="erasure-ev@kodera.calendar",
        title="Réunion liée à un document",
        starts_at=datetime(2026, 6, 15, 9, 0, tzinfo=UTC),
        ends_at=datetime(2026, 6, 15, 9, 30, tzinfo=UTC),
        timezone="UTC",
    )
    BookingSlotReservation.objects.create(
        organisation=org,
        workspace=workspace,
        booking_page=page,
        event=ev,
        uid="erasure-res@kodera.calendar",
        guest_name="Invité",
        guest_email="invite@kodera.io",
        starts_at=datetime(2026, 6, 15, 9, 0, tzinfo=UTC),
        ends_at=datetime(2026, 6, 15, 9, 30, tzinfo=UTC),
        buffered_starts_at=datetime(2026, 6, 15, 9, 0, tzinfo=UTC),
        buffered_ends_at=datetime(2026, 6, 15, 9, 30, tzinfo=UTC),
        cancellation_token_sha256=b"0" * 32,
    )

    erasure_row = begin_org_erasure(org)

    # Durable cutoff blocks post-cutoff mutations on calendar tables
    with pytest.raises(IntegrityError, match="durable erasure cutoff"):
        CalendarEvent.objects.filter(pk=ev.id).update(title="Mutation après cutoff")

    # Statutory purge deletes docs_document FIRST (triggering ON DELETE SET NULL on agenda_document_id)
    # and then purges all 4 calendar_* tables cleanly!
    result = advance_erasure(erasure_row.id, {})
    assert result["core_purged"] is True
    assert not Document.objects.filter(pk=agenda_doc.id).exists()
    assert not CalendarEvent.objects.filter(organisation=org).exists()
    assert not CalDavSource.objects.filter(organisation=org).exists()
    assert not BookingPage.objects.filter(organisation=org).exists()
    assert not BookingSlotReservation.objects.filter(organisation=org).exists()


def test_statutory_account_erasure_scrubs_guest_reservations_and_event_attendees(world) -> None:
    org, workspace, members, tokens = world
    # Transfer ownership to members[1] so members[0] can erase their personal account
    Membership.objects.filter(pk=members[1].id).update(role="org_owner")
    erasing_member = members[0]
    erasing_email = erasing_member.user.email.lower()
    host_member = members[1]

    ev = CalendarEvent.objects.create(
        organisation=org,
        workspace=workspace,
        organizer_membership=host_member,
        uid="acct-scrub-ev@kodera.calendar",
        title="Point équipe",
        starts_at=datetime(2026, 6, 15, 10, 0, tzinfo=UTC),
        ends_at=datetime(2026, 6, 15, 10, 30, tzinfo=UTC),
        timezone="UTC",
        attendees=[
            {
                "email": erasing_email,
                "name": "Membre Effacé",
                "partstat": "ACCEPTED",
                "role": "REQ-PARTICIPANT",
            },
            {
                "email": "conserve@kodera.io",
                "name": "Membre Conservé",
                "partstat": "ACCEPTED",
                "role": "REQ-PARTICIPANT",
            },
        ],
    )
    page = BookingPage.objects.create(
        organisation=org,
        workspace=workspace,
        host_membership=host_member,
        slug="acct-scrub-slug",
        title="Page Hôte",
        timezone="UTC",
        duration_minutes=30,
        buffer_minutes=0,
        availability_windows=[{"weekday": 0, "start": "09:00", "end": "12:00"}],
    )
    res = BookingSlotReservation.objects.create(
        organisation=org,
        workspace=workspace,
        booking_page=page,
        event=ev,
        uid="acct-scrub-res@kodera.calendar",
        guest_name="Nom Personnel Effacé",
        guest_email=erasing_email,
        guest_notes="Note personnelle à purger",
        starts_at=datetime(2026, 6, 15, 10, 0, tzinfo=UTC),
        ends_at=datetime(2026, 6, 15, 10, 30, tzinfo=UTC),
        buffered_starts_at=datetime(2026, 6, 15, 10, 0, tzinfo=UTC),
        buffered_ends_at=datetime(2026, 6, 15, 10, 30, tzinfo=UTC),
        cancellation_token_sha256=b"1" * 32,
    )

    acct_row = begin_account_erasure(
        verified=replace(tokens[0], auth_time=int(database_now().timestamp())),
        confirmation="delete",
        instruction_ref="DELCAL-200",
        instruction_sha256="9" * 64,
        purge_not_before=database_now(),
        actor_identity_id=operator().id,
    )
    purge_res = purge_account_core(acct_row.id)
    assert purge_res["core_contacts_purged"] is True

    res.refresh_from_db()
    assert res.guest_email == f"erased+{res.id}@invalid.test"
    assert res.guest_name == "Erased guest"
    assert res.guest_notes == ""
    assert res.status == "cancelled"

    ev.refresh_from_db()
    remaining_emails = [entry["email"] for entry in ev.attendees]
    assert erasing_email not in remaining_emails
    assert remaining_emails == ["conserve@kodera.io"]


def test_calendar_reverse_migration_refuses_downgrade_when_rows_exist(world) -> None:
    org, workspace, members, _ = world
    ev = CalendarEvent.objects.create(
        organisation=org,
        workspace=workspace,
        organizer_membership=members[0],
        uid="downgrade-guard@kodera.calendar",
        title="Événement persistant",
        starts_at=timezone.now(),
        ends_at=timezone.now() + timedelta(minutes=30),
        timezone="UTC",
    )
    try:
        executor = MigrationExecutor(connection)
        targets = [node for node in executor.loader.graph.leaf_nodes() if node[0] != "calendar"]
        targets.append(("calendar", None))
        with pytest.raises(IntegrityError, match="cannot downgrade calendar migration") as caught:
            executor.migrate(targets)
        assert getattr(caught.value.__cause__, "sqlstate", None) == "23514"
    finally:
        CalendarEvent.objects.filter(pk=ev.id).delete()
        restore = MigrationExecutor(connection)
        restore.migrate(restore.loader.graph.leaf_nodes())
