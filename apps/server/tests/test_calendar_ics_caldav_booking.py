"""Unit and security tests for RFC 5545 .ics, SSRF-pinned CalDAV, sealing, and sovereign booking."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

import pytest
from django.test import RequestFactory

from apps.calendar.api import views as calendar_views
from apps.calendar.booking import (
    BookingValidationError,
    compute_available_slots,
    issue_cancellation_token,
    parse_availability_windows,
    slot_matches_availability,
    validate_booking_slug,
    validate_duration_and_buffer,
    verify_cancellation_token,
)
from apps.calendar.caldav_sync import (
    CalDavAdapter,
    CalDavBlockedError,
    CalDavConflictError,
    CalDavError,
    CalDavRawResponse,
    pinned_https_transport,
)
from apps.calendar.ics import (
    MAX_ICS_BYTES,
    IcsAlarm,
    IcsAttendee,
    IcsEvent,
    IcsFormatError,
    IcsFreeBusy,
    IcsFreeBusyPeriod,
    canonicalize_rrule,
    expand_event_occurrences,
    fold_content_line,
    parse_calendar,
    parse_rrule,
    serialize_calendar,
)
from apps.calendar.sealing import (
    CalDavCredentialError,
    CalDavSecretConfig,
    canonicalize_calendar_collection_url,
    seal_caldav_credentials,
    unseal_caldav_credentials,
)
from apps.media.outbound import BlockedTargetError, Target, target as parse_target
from core.sealing import SealError

MASTER_KEY = bytes(range(32))
ORG_A = UUID("01900000-0000-7000-8000-000000000001")
ORG_B = UUID("01900000-0000-7000-8000-000000000002")
WS_A = UUID("01900000-0000-7000-8000-000000000011")
WS_B = UUID("01900000-0000-7000-8000-000000000012")
SRC_A = UUID("01900000-0000-7000-8000-000000000021")
SRC_B = UUID("01900000-0000-7000-8000-000000000022")


class TestRfc5545IcsEngine:
    def test_roundtrip_vevent_with_utf8_folding_rrule_attendees_valarm_and_kodera_links(
        self,
    ) -> None:
        long_summary = (
            "Comité souverain d'architecture — Équipe Île-de-France € "
            "avec vérification multi-octets 🗓️ et ordre du jour partagé"
        )
        ev = IcsEvent(
            uid="ev-001@kodera.calendar",
            dtstamp=datetime(2026, 6, 1, 8, 0, tzinfo=UTC),
            dtstart=datetime(2026, 6, 8, 9, 0, tzinfo=UTC),
            dtend=datetime(2026, 6, 8, 9, 45, tzinfo=UTC),
            summary=long_summary,
            description="Ligne 1\nLigne 2; avec virgule, point-virgule et antislash \\.",
            location="Salle Givre, Paris",
            status="CONFIRMED",
            sequence=2,
            timezone="Europe/Paris",
            organizer_email="organisateur@kodera.io",
            organizer_name="Camille Laurent",
            rrule="FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=6",
            attendees=(
                IcsAttendee(
                    email="invite1@kodera.io",
                    name="Nadia Benali",
                    partstat="ACCEPTED",
                    role="REQ-PARTICIPANT",
                ),
                IcsAttendee(
                    email="invite2@kodera.io",
                    name="Julien Moreau",
                    partstat="TENTATIVE",
                    role="OPT-PARTICIPANT",
                ),
            ),
            alarms=(IcsAlarm(minutes_before=15, description="Début dans 15 min"),),
            visio_url="https://visio.kodera.io/comite-architecture",
            agenda_doc_url="https://console.kodera.io/docs/01900000-0000-7000-8000-000000000099",
        )

        serialized = serialize_calendar(events=(ev,), method="REQUEST")
        assert "\r\n" in serialized
        for raw_line in serialized.split("\r\n"):
            if raw_line:
                encoded = raw_line.encode("utf-8")
                assert len(encoded) <= 75

        parsed = parse_calendar(serialized)
        assert parsed.version == "2.0"
        assert parsed.method == "REQUEST"
        assert len(parsed.events) == 1

        out = parsed.events[0]
        assert out.uid == ev.uid
        assert out.summary == long_summary
        assert out.description == ev.description
        assert out.location == ev.location
        assert out.dtstart == ev.dtstart
        assert out.dtend == ev.dtend
        assert out.sequence == 2
        assert out.rrule == "FREQ=WEEKLY;INTERVAL=2;COUNT=6;BYDAY=MO,TH"
        assert len(out.attendees) == 2
        assert out.attendees[0].email == "invite1@kodera.io"
        assert out.attendees[0].partstat == "ACCEPTED"
        assert len(out.alarms) == 1
        assert out.alarms[0].minutes_before == 15
        assert out.visio_url == "https://visio.kodera.io/comite-architecture"
        assert out.agenda_doc_url.endswith("01900000-0000-7000-8000-000000000099")

    def test_fold_ics_line_never_splits_multibyte_utf8_codepoints(self) -> None:
        # 4-byte emoji repeated across 75-octet boundary
        line = "SUMMARY:" + ("🗓" * 40)
        folded = fold_content_line(line)
        segments = [s for s in folded.split("\r\n") if s]
        assert len(segments) >= 2
        for seg in segments:
            raw = seg.encode("utf-8")
            assert len(raw) <= 75
            raw.decode("utf-8")

    def test_vfreebusy_roundtrip(self) -> None:
        fb = IcsFreeBusy(
            uid="fb-01@kodera.calendar",
            dtstamp=datetime(2026, 6, 1, 8, 0, tzinfo=UTC),
            dtstart=datetime(2026, 6, 8, 8, 0, tzinfo=UTC),
            dtend=datetime(2026, 6, 8, 18, 0, tzinfo=UTC),
            organizer_email="hote@kodera.io",
            busy_periods=(
                IcsFreeBusyPeriod(
                    starts_at=datetime(2026, 6, 8, 9, 0, tzinfo=UTC),
                    ends_at=datetime(2026, 6, 8, 10, 0, tzinfo=UTC),
                ),
                IcsFreeBusyPeriod(
                    starts_at=datetime(2026, 6, 8, 14, 0, tzinfo=UTC),
                    ends_at=datetime(2026, 6, 8, 14, 30, tzinfo=UTC),
                ),
            ),
        )
        ics_text = serialize_calendar(freebusy=(fb,), method="PUBLISH")
        parsed = parse_calendar(ics_text)
        assert len(parsed.freebusy) == 1
        assert len(parsed.freebusy[0].busy_periods) == 2
        assert parsed.freebusy[0].busy_periods[0].starts_at == datetime(
            2026, 6, 8, 9, 0, tzinfo=UTC
        )

    def test_rrule_daily_weekly_monthly_occurrence_expansion(self) -> None:
        # Weekly MO,WE expansion
        occs_weekly = expand_event_occurrences(
            starts_at=datetime(2026, 6, 1, 9, 0, tzinfo=UTC),  # Monday
            ends_at=datetime(2026, 6, 1, 9, 30, tzinfo=UTC),
            rrule="FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4",
            timezone="UTC",
            window_start=datetime(2026, 6, 1, 0, 0, tzinfo=UTC),
            window_end=datetime(2026, 6, 20, 0, 0, tzinfo=UTC),
        )
        assert [s.day for s, _ in occs_weekly] == [1, 3, 8, 10]

        # Monthly BYMONTHDAY=31 skips months without day 31 (February, April)
        occs_monthly = expand_event_occurrences(
            starts_at=datetime(2026, 1, 31, 10, 0, tzinfo=UTC),
            ends_at=datetime(2026, 1, 31, 11, 0, tzinfo=UTC),
            rrule="FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3",
            timezone="UTC",
            window_start=datetime(2026, 1, 1, 0, 0, tzinfo=UTC),
            window_end=datetime(2026, 6, 1, 0, 0, tzinfo=UTC),
        )
        assert [(s.month, s.day) for s, _ in occs_monthly] == [(1, 31), (3, 31), (5, 31)]

        # Daily with UNTIL cutoff
        occs_daily = expand_event_occurrences(
            starts_at=datetime(2026, 6, 1, 12, 0, tzinfo=UTC),
            ends_at=datetime(2026, 6, 1, 12, 15, tzinfo=UTC),
            rrule="FREQ=DAILY;UNTIL=20260603T120000Z",
            timezone="UTC",
            window_start=datetime(2026, 6, 1, 0, 0, tzinfo=UTC),
            window_end=datetime(2026, 6, 10, 0, 0, tzinfo=UTC),
        )
        assert len(occs_daily) == 3

    @pytest.mark.parametrize(
        "malicious_payload",
        [
            # Exceeds 512 KiB bound
            b"BEGIN:VCALENDAR\r\n"
            + (b"X-PAD:" + b"A" * 60 + b"\r\n") * 9000
            + b"END:VCALENDAR\r\n",
            # Bare CR header injection attempt
            (
                "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n"
                "BEGIN:VEVENT\r\nUID:1@test\r\nDTSTART:20260608T090000Z\r\nDTEND:20260608T100000Z\r\n"
                "SUMMARY:Hello\rATTENDEE:mailto:evil@attacker.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
            ),
            # Control character (NUL / ESC) injection
            (
                "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n"
                "BEGIN:VEVENT\r\nUID:1@test\r\nDTSTART:20260608T090000Z\r\nDTEND:20260608T100000Z\r\n"
                "SUMMARY:Hello\x00World\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
            ),
            # Dangling escape at end of SUMMARY
            (
                "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n"
                "BEGIN:VEVENT\r\nUID:1@test\r\nDTSTART:20260608T090000Z\r\nDTEND:20260608T100000Z\r\n"
                "SUMMARY:TrailingSlash\\\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
            ),
            # Non-HTTPS javascript: URL in X-KODERA-VISIO-URL
            (
                "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n"
                "BEGIN:VEVENT\r\nUID:1@test\r\nDTSTART:20260608T090000Z\r\nDTEND:20260608T100000Z\r\n"
                "SUMMARY:Call\r\nX-KODERA-VISIO-URL:javascript:alert(1)\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
            ),
            # Mismatched component framing
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nBEGIN:VEVENT\r\nEND:VCALENDAR\r\n",
            # Second root VCALENDAR smuggling
            (
                "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nEND:VCALENDAR\r\n"
                "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Evil//EN\r\nEND:VCALENDAR\r\n"
            ),
        ],
    )
    def test_parser_rejects_oversized_and_injection_payloads(
        self, malicious_payload: bytes | str
    ) -> None:
        assert MAX_ICS_BYTES == 512 * 1024
        with pytest.raises(IcsFormatError):
            parse_calendar(malicious_payload)

    def test_serializer_rejects_header_injection_and_unsafe_urls(self) -> None:
        dtstamp = datetime(2026, 6, 1, 8, 0, tzinfo=UTC)
        dtstart = datetime(2026, 6, 8, 9, 0, tzinfo=UTC)
        dtend = datetime(2026, 6, 8, 10, 0, tzinfo=UTC)
        with pytest.raises(IcsFormatError):
            serialize_calendar(
                events=(
                    IcsEvent(
                        uid="bad\r\nATTENDEE:mailto:evil@test",
                        summary="Normal",
                        dtstamp=dtstamp,
                        dtstart=dtstart,
                        dtend=dtend,
                    ),
                )
            )
        with pytest.raises(IcsFormatError):
            serialize_calendar(
                events=(
                    IcsEvent(
                        uid="ok@kodera.calendar",
                        summary="Bad Visio Scheme",
                        visio_url="http://visio.kodera.io/insecure",
                        dtstamp=dtstamp,
                        dtstart=dtstart,
                        dtend=dtend,
                    ),
                )
            )
        with pytest.raises(IcsFormatError):
            parse_rrule("FREQ=SECONDLY;INTERVAL=1")
        assert canonicalize_rrule("RRULE:freq=weekly;byday=fr,mo") == "FREQ=WEEKLY;BYDAY=FR,MO"

    def test_uid_colon_rfc6868_cn_quotes_class_transp_date_duration_and_lenient_inbound(
        self,
    ) -> None:
        dtstamp = datetime(2026, 6, 1, 8, 0, tzinfo=UTC)
        dtstart = datetime(2026, 6, 8, 9, 0, tzinfo=UTC)
        dtend = datetime(2026, 6, 8, 9, 30, tzinfo=UTC)
        ev = IcsEvent(
            uid="urn:uuid:01900000-0000-7000-8000-000000000999",
            dtstamp=dtstamp,
            dtstart=dtstart,
            dtend=dtend,
            summary="Entretien confidentiel",
            classification="CONFIDENTIAL",
            transp="TRANSPARENT",
            organizer_email="dir@kodera.io",
            organizer_name='Claire "Ops" Martin',
            attendees=(
                IcsAttendee(
                    email="guest@kodera.io",
                    name='Jean "Sec" Dupont',
                    partstat="ACCEPTED",
                    role="REQ-PARTICIPANT",
                ),
            ),
        )
        serialized = serialize_calendar(events=(ev,), method="PUBLISH")
        assert "UID:urn:uuid:01900000-0000-7000-8000-000000000999" in serialized
        assert "CLASS:CONFIDENTIAL" in serialized
        assert "TRANSP:TRANSPARENT" in serialized
        assert "^'" in serialized

        parsed = parse_calendar(serialized)
        out = parsed.events[0]
        assert out.uid == "urn:uuid:01900000-0000-7000-8000-000000000999"
        assert out.classification == "CONFIDENTIAL"
        assert out.transp == "TRANSPARENT"
        assert out.organizer_name == 'Claire "Ops" Martin'
        assert out.attendees[0].name == 'Jean "Sec" Dupont'

        # Inbound all-day VALUE=DATE defaults to 1 day; DURATION computes dtend; lenient_inbound
        # skips EMAIL VALARM and non-HTTPS URL/ATTACH without aborting CalDAV collection sync.
        inbound_ics = (
            "BEGIN:VCALENDAR\r\n"
            "VERSION:2.0\r\n"
            "PRODID:-//Nextcloud//CalDAV//EN\r\n"
            "BEGIN:VEVENT\r\n"
            "UID:allday-01@nextcloud.local\r\n"
            "DTSTART;VALUE=DATE:20260610\r\n"
            "SUMMARY:Journée souveraineté\r\n"
            "CLASS:PRIVATE\r\n"
            "URL:http://legacy.intranet.example/event\r\n"
            "ATTACH:http://legacy.intranet.example/doc.pdf\r\n"
            "BEGIN:VALARM\r\n"
            "ACTION:EMAIL\r\n"
            "TRIGGER:-PT30M\r\n"
            "DESCRIPTION:Email reminder\r\n"
            "END:VALARM\r\n"
            "END:VEVENT\r\n"
            "BEGIN:VEVENT\r\n"
            "UID:duration-02@nextcloud.local\r\n"
            "DTSTART:20260611T140000Z\r\n"
            "DURATION:PT45M\r\n"
            "SUMMARY:Revue 45 min\r\n"
            "END:VEVENT\r\n"
            "END:VCALENDAR\r\n"
        )
        parsed_inbound = parse_calendar(inbound_ics, lenient_inbound=True)
        assert len(parsed_inbound.events) == 2
        ev_allday, ev_dur = parsed_inbound.events
        assert ev_allday.classification == "PRIVATE"
        assert ev_allday.dtend - ev_allday.dtstart == datetime(2026, 6, 11, tzinfo=UTC) - datetime(
            2026, 6, 10, tzinfo=UTC
        )
        assert ev_allday.alarms == ()
        assert ev_allday.visio_url == ""
        assert ev_dur.dtend == datetime(2026, 6, 11, 14, 45, tzinfo=UTC)


class TestCalDavCredentialSealingAndSsrf:
    def test_hkdf_aead_roundtrip_and_cross_scope_tamper_rejection(self) -> None:
        cfg = CalDavSecretConfig(
            calendar_url="https://agenda.numerique.gouv.fr/caldav/equipe/",
            username="equipe@kodera.io",
            password="app-specific-secret-token",
            provider="lasuite",
        )
        sealed = seal_caldav_credentials(
            MASTER_KEY,
            organisation_id=ORG_A,
            workspace_id=WS_A,
            source_id=SRC_A,
            config=cfg,
        )
        assert b"app-specific-secret-token" not in sealed

        unsealed = unseal_caldav_credentials(
            MASTER_KEY,
            organisation_id=ORG_A,
            workspace_id=WS_A,
            source_id=SRC_A,
            sealed_value=sealed,
        )
        assert unsealed == cfg

        # Cross-organisation, cross-workspace, and cross-source AAD swaps fail closed
        with pytest.raises(SealError):
            unseal_caldav_credentials(
                MASTER_KEY,
                organisation_id=ORG_B,
                workspace_id=WS_A,
                source_id=SRC_A,
                sealed_value=sealed,
            )
        with pytest.raises(SealError):
            unseal_caldav_credentials(
                MASTER_KEY,
                organisation_id=ORG_A,
                workspace_id=WS_B,
                source_id=SRC_A,
                sealed_value=sealed,
            )
        with pytest.raises(SealError):
            unseal_caldav_credentials(
                MASTER_KEY,
                organisation_id=ORG_A,
                workspace_id=WS_A,
                source_id=SRC_B,
                sealed_value=sealed,
            )

        # Single-bit ciphertext tamper fails AEAD tag check
        tampered = bytearray(sealed)
        tampered[-1] ^= 0x01
        with pytest.raises(SealError):
            unseal_caldav_credentials(
                MASTER_KEY,
                organisation_id=ORG_A,
                workspace_id=WS_A,
                source_id=SRC_A,
                sealed_value=bytes(tampered),
            )

    @pytest.mark.parametrize(
        "blocked_url",
        [
            "http://agenda.numerique.gouv.fr/caldav/",
            "https://127.0.0.1/caldav/",
            "https://169.254.169.254/latest/meta-data/",
            "https://10.0.0.42/caldav/",
            "https://192.168.1.10/caldav/",
            "https://100.64.0.5/caldav/",
            "https://[::1]/caldav/",
            "https://[::ffff:127.0.0.1]/caldav/",
            "https://localhost/caldav/",
            "https://user:pass@agenda.numerique.gouv.fr/caldav/",
        ],
    )
    def test_secret_config_blocks_non_https_and_private_ip_targets(self, blocked_url: str) -> None:
        with pytest.raises(CalDavCredentialError):
            CalDavSecretConfig(
                calendar_url=blocked_url,
                username="equipe",
                password="secret",
                provider="lasuite",
            )

    def test_pinned_https_transport_refuses_redirects_and_dns_private_ips(self) -> None:
        dest = parse_target("https://agenda.numerique.gouv.fr/caldav/equipe/", https_only=True)

        # Redirect to cloud metadata IP is strictly refused (never followed)
        fake_conn = SimpleNamespace(close=lambda: None)
        fake_redirect_resp = SimpleNamespace(
            status=302,
            getheaders=lambda: [("Location", "http://169.254.169.254/latest/meta-data/")],
            read=lambda _n: b"",
        )
        with (
            patch(
                "apps.calendar.caldav_sync.outbound_request",
                return_value=(fake_conn, fake_redirect_resp),
            ),
            pytest.raises(CalDavBlockedError) as exc_info,
        ):
            pinned_https_transport(
                dest,
                method="PROPFIND",
                headers={},
                body=None,
                deadline=100.0,
            )
        assert exc_info.value.code == "redirect_refused"

        # DNS rebinding to loopback IP in outbound_request raises BlockedTargetError -> CalDavBlockedError
        cfg = CalDavSecretConfig(
            calendar_url="https://agenda.numerique.gouv.fr/caldav/equipe/",
            username="equipe",
            password="secret",
            provider="lasuite",
        )
        adapter = CalDavAdapter(cfg)
        with (
            patch(
                "apps.calendar.caldav_sync.outbound_request",
                side_effect=BlockedTargetError("private_address"),
            ),
            pytest.raises(CalDavBlockedError) as rebind_exc,
        ):
            adapter.discover_collection()
        assert rebind_exc.value.code == "private_address"

    def test_caldav_propfind_incremental_sync_token_resync_xxe_and_etag_concurrency(self) -> None:
        cfg = CalDavSecretConfig(
            calendar_url="https://agenda.numerique.gouv.fr/caldav/equipe/",
            username="equipe",
            password="secret",
            provider="lasuite",
        )
        calls: list[tuple[str, str, dict[str, str]]] = []

        sample_ics = serialize_calendar(
            events=(
                IcsEvent(
                    uid="lasuite-42@numerique.gouv.fr",
                    dtstamp=datetime(2026, 6, 1, 8, 0, tzinfo=UTC),
                    dtstart=datetime(2026, 6, 9, 14, 0, tzinfo=UTC),
                    dtend=datetime(2026, 6, 9, 15, 0, tzinfo=UTC),
                    summary="Point interministériel",
                ),
            )
        )

        def fake_transport(
            destination: Target,
            *,
            method: str,
            headers: dict[str, str],
            body: bytes | None,
            deadline: float,
        ) -> CalDavRawResponse:
            assert deadline > 0
            calls.append((method, destination.url, headers))
            if method == "PROPFIND":
                xml = (
                    '<?xml version="1.0" encoding="utf-8"?>'
                    '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" '
                    'xmlns:cs="http://calendarserver.org/ns/">'
                    "<d:response><d:href>/caldav/equipe/</d:href><d:propstat><d:prop>"
                    "<d:displayname>Équipe Souveraine</d:displayname>"
                    "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>"
                    "<d:sync-token>http://sabredav.org/ns/sync/10</d:sync-token>"
                    "<cs:getctag>ctag-10</cs:getctag>"
                    "</d:prop></d:propstat></d:response></d:multistatus>"
                )
                return CalDavRawResponse(207, {}, xml.encode("utf-8"))
            if method == "REPORT":
                assert body is not None
                if b"stale-token" in body:
                    return CalDavRawResponse(
                        410,
                        {},
                        b'<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>',
                    )
                xml = (
                    '<?xml version="1.0" encoding="utf-8"?>'
                    '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
                    "<d:response>"
                    "<d:href>/caldav/equipe/lasuite-42.ics</d:href>"
                    "<d:propstat><d:prop>"
                    '<d:getetag>"etag-v1"</d:getetag>'
                    f"<c:calendar-data>{sample_ics}</c:calendar-data>"
                    "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>"
                    "</d:response>"
                    "<d:response>"
                    "<d:href>/caldav/equipe/deleted-99.ics</d:href>"
                    "<d:status>HTTP/1.1 404 Not Found</d:status>"
                    "</d:response>"
                    "<d:sync-token>http://sabredav.org/ns/sync/11</d:sync-token>"
                    "</d:multistatus>"
                )
                return CalDavRawResponse(207, {}, xml.encode("utf-8"))
            if method == "PUT":
                if headers.get("If-Match") == '"stale"':
                    return CalDavRawResponse(412, {}, b"")
                return CalDavRawResponse(201, {"etag": '"etag-v2"'}, b"")
            if method == "DELETE":
                if headers.get("If-Match") == '"stale"':
                    return CalDavRawResponse(412, {}, b"")
                return CalDavRawResponse(204, {}, b"")
            raise AssertionError(f"unexpected method {method}")

        adapter = CalDavAdapter(cfg, transport=fake_transport)
        info = adapter.discover_collection()
        assert info.display_name == "Équipe Souveraine"
        assert info.supports_calendar is True
        assert info.sync_token == "http://sabredav.org/ns/sync/10"
        assert info.ctag == "ctag-10"

        # Incremental sync delta with 1 upsert + 1 tombstone
        batch = adapter.sync_collection(sync_token="http://sabredav.org/ns/sync/10")
        assert batch.full_resync is False
        assert batch.sync_token == "http://sabredav.org/ns/sync/11"
        assert len(batch.deltas) == 2
        assert batch.deltas[0].deleted is False
        assert batch.deltas[0].etag == '"etag-v1"'
        assert batch.deltas[0].events[0].summary == "Point interministériel"
        assert batch.deltas[1].deleted is True
        assert batch.deltas[1].href.endswith("/caldav/equipe/deleted-99.ics")

        # Expired sync-token (410) automatically falls back to full calendar-query resync
        resync_batch = adapter.sync_collection(sync_token="stale-token")
        assert resync_batch.full_resync is True
        assert len(resync_batch.deltas) == 2

        # PUT create uses If-None-Match: *, PUT update uses If-Match and raises on 412
        ev = batch.deltas[0].events[0]
        href, new_etag = adapter.put_event(ev)
        assert (
            href == "https://agenda.numerique.gouv.fr/caldav/equipe/lasuite-42numerique.gouv.fr.ics"
        )
        assert new_etag == '"etag-v2"'
        assert calls[-1][2].get("If-None-Match") == "*"

        with pytest.raises(CalDavConflictError):
            adapter.put_event(ev, remote_href=href, expected_etag='"stale"')

        with pytest.raises(CalDavConflictError):
            adapter.delete_event(remote_href=href, expected_etag='"stale"')

        adapter.delete_event(remote_href=href, expected_etag='"etag-v2"')

    def test_caldav_rejects_xxe_dtd_and_path_escape_hrefs(self) -> None:
        cfg = CalDavSecretConfig(
            calendar_url="https://agenda.numerique.gouv.fr/caldav/equipe/",
            username="equipe",
            password="secret",
        )
        xxe_xml = (
            b'<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
            b'<d:multistatus xmlns:d="DAV:"><d:sync-token>&xxe;</d:sync-token></d:multistatus>'
        )
        adapter_xxe = CalDavAdapter(
            cfg,
            transport=lambda *_a, **_kw: CalDavRawResponse(207, {}, xxe_xml),
        )
        with pytest.raises(CalDavError) as xxe_exc:
            adapter_xxe.sync_collection()
        assert xxe_exc.value.code == "xml_dtd_forbidden"

        escape_xml = (
            b'<?xml version="1.0"?>'
            b'<d:multistatus xmlns:d="DAV:">'
            b"<d:response><d:href>/caldav/autre-organisation/secret.ics</d:href>"
            b"<d:status>HTTP/1.1 404 Not Found</d:status></d:response>"
            b"</d:multistatus>"
        )
        adapter_escape = CalDavAdapter(
            cfg,
            transport=lambda *_a, **_kw: CalDavRawResponse(207, {}, escape_xml),
        )
        with pytest.raises(CalDavBlockedError) as esc_exc:
            adapter_escape.sync_collection()
        assert esc_exc.value.code == "path_escape_href"

        # P0-1: 5,000-byte XML comment before DOCTYPE/ENTITY billion-laughs payload is rejected
        padded_billion_laughs = (
            b'<?xml version="1.0"?>'
            + b"<!--"
            + (b"A" * 5000)
            + b"-->"
            + b'<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>'
            + b'<d:multistatus xmlns:d="DAV:"><d:sync-token>t</d:sync-token></d:multistatus>'
        )
        adapter_padded = CalDavAdapter(
            cfg,
            transport=lambda *_a, **_kw: CalDavRawResponse(207, {}, padded_billion_laughs),
        )
        with pytest.raises(CalDavError) as padded_exc:
            adapter_padded.sync_collection()
        assert padded_exc.value.code == "xml_dtd_forbidden"

        # P1-7: > 2,000 multistatus responses raises multistatus_too_large instead of truncating
        too_many_xml = (
            b'<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">'
            + b"".join(
                f"<d:response><d:href>/caldav/equipe/ev-{idx}.ics</d:href>"
                "<d:status>HTTP/1.1 404 Not Found</d:status></d:response>".encode()
                for idx in range(2005)
            )
            + b"<d:sync-token>tok-after-truncation</d:sync-token></d:multistatus>"
        )
        adapter_cap = CalDavAdapter(
            cfg,
            transport=lambda *_a, **_kw: CalDavRawResponse(207, {}, too_many_xml),
        )
        with pytest.raises(CalDavError) as cap_exc:
            adapter_cap.sync_collection()
        assert cap_exc.value.code == "multistatus_too_large"

        # P1-8: Canonical trailing slash + percent-encoded traversal / query / fragment rejection
        assert (
            canonicalize_calendar_collection_url("https://agenda.numerique.gouv.fr/caldav/equipe")
            == "https://agenda.numerique.gouv.fr/caldav/equipe/"
        )
        for bad_collection_url in (
            "https://agenda.numerique.gouv.fr/caldav/equipe/?x=1",
            "https://agenda.numerique.gouv.fr/caldav/equipe/#frag",
            "https://agenda.numerique.gouv.fr/caldav/%2e%2e/secret/",
            "https://agenda.numerique.gouv.fr/caldav/equipe%2f..%2fsecret/",
        ):
            with pytest.raises(CalDavCredentialError):
                canonicalize_calendar_collection_url(bad_collection_url)

        encoded_traversal_xml = (
            b'<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">'
            b"<d:response><d:href>/caldav/equipe/%2e%2e/autre/secret.ics</d:href>"
            b"<d:status>HTTP/1.1 404 Not Found</d:status></d:response></d:multistatus>"
        )
        adapter_enc = CalDavAdapter(
            cfg,
            transport=lambda *_a, **_kw: CalDavRawResponse(207, {}, encoded_traversal_xml),
        )
        with pytest.raises(CalDavBlockedError):
            adapter_enc.sync_collection()


class TestSovereignBookingCalculatorAndHttpGuards:
    def test_slot_subtraction_buffers_durations_and_zero_pii(self) -> None:
        windows = parse_availability_windows(
            [
                {"weekday": 0, "start": "09:00", "end": "12:00"},  # Monday morning UTC
            ]
        )
        # Busy event from 10:00 to 10:30 with 15-minute buffer -> blocks [09:45, 10:45]
        # Candidate 30-min slots on 2026-06-08 (Monday):
        # 09:00-09:30 -> FREE (ends 09:30 <= 09:45)
        # 09:30-10:00 -> BLOCKED (overlaps 09:45..10:45)
        # 10:00-10:30 -> BLOCKED
        # 10:30-11:00 -> BLOCKED (starts 10:30 < 10:45)
        # 11:00-11:30 -> FREE
        # 11:30-12:00 -> FREE
        slots = compute_available_slots(
            availability_windows=windows,
            timezone="UTC",
            duration_minutes=30,
            buffer_minutes=15,
            range_start=datetime(2026, 6, 8, 0, 0, tzinfo=UTC),
            range_end=datetime(2026, 6, 9, 0, 0, tzinfo=UTC),
            busy_intervals=[
                (datetime(2026, 6, 8, 10, 0, tzinfo=UTC), datetime(2026, 6, 8, 10, 30, tzinfo=UTC))
            ],
            now=datetime(2026, 6, 1, 0, 0, tzinfo=UTC),
        )
        formatted = [(s.starts_at.strftime("%H:%M"), s.ends_at.strftime("%H:%M")) for s in slots]
        assert formatted == [("09:00", "09:30"), ("11:00", "11:30"), ("11:30", "12:00")]

        for slot in slots:
            assert set(slot.__dataclass_fields__) == {"starts_at", "ends_at"}

        assert slot_matches_availability(
            availability_windows=windows,
            timezone="UTC",
            duration_minutes=30,
            buffer_minutes=15,
            starts_at=datetime(2026, 6, 8, 9, 0, tzinfo=UTC),
            ends_at=datetime(2026, 6, 8, 9, 30, tzinfo=UTC),
            busy_intervals=[
                (datetime(2026, 6, 8, 10, 0, tzinfo=UTC), datetime(2026, 6, 8, 10, 30, tzinfo=UTC))
            ],
            now=datetime(2026, 6, 1, 0, 0, tzinfo=UTC),
        )
        assert not slot_matches_availability(
            availability_windows=windows,
            timezone="UTC",
            duration_minutes=30,
            buffer_minutes=15,
            starts_at=datetime(2026, 6, 8, 9, 30, tzinfo=UTC),
            ends_at=datetime(2026, 6, 8, 10, 0, tzinfo=UTC),
            busy_intervals=[
                (datetime(2026, 6, 8, 10, 0, tzinfo=UTC), datetime(2026, 6, 8, 10, 30, tzinfo=UTC))
            ],
            now=datetime(2026, 6, 1, 0, 0, tzinfo=UTC),
        )

    @pytest.mark.parametrize("duration", [15, 30, 45, 60])
    def test_supported_booking_durations_and_validation_guards(self, duration: int) -> None:
        validate_duration_and_buffer(duration_minutes=duration, buffer_minutes=10)
        assert validate_booking_slug("point-equipe-2026") == "point-equipe-2026"

        with pytest.raises(BookingValidationError):
            validate_duration_and_buffer(duration_minutes=20, buffer_minutes=0)
        with pytest.raises(BookingValidationError):
            validate_duration_and_buffer(duration_minutes=True, buffer_minutes=0)
        with pytest.raises(BookingValidationError):
            validate_booking_slug("Invalid_Slug")
        with pytest.raises(BookingValidationError):
            parse_availability_windows(
                [
                    {"weekday": 1, "start": "09:00", "end": "12:00"},
                    {"weekday": 1, "start": "11:30", "end": "14:00"},
                ]
            )

    def test_cancellation_token_sha256_verification(self) -> None:
        token, digest = issue_cancellation_token()
        assert len(digest) == 32
        assert token.encode("ascii") != digest
        assert verify_cancellation_token(token, digest) is True
        assert verify_cancellation_token(token + "x", digest) is False
        assert verify_cancellation_token("short", digest) is False
        assert verify_cancellation_token("non-ascii-é" * 4, digest) is False

    def test_public_and_authenticated_http_admission_guards(self) -> None:
        rf = RequestFactory()

        # Public POST without Idempotency-Key is refused 400 with Cache-Control: no-store
        req_missing_key = rf.post(
            "/api/v1/booking/point-architecture/reservations",
            data=b'{"startsAt":"2026-06-08T09:00:00Z","guestName":"Alice","guestEmail":"a@kodera.io"}',
            content_type="application/json",
        )
        resp_missing = calendar_views.public_booking_reservations(
            req_missing_key, booking_slug="point-architecture"
        )
        assert resp_missing.status_code == 400
        assert resp_missing["Cache-Control"] == "no-store"
        assert resp_missing["X-Request-Id"]

        # Method not allowed returns 405 + Allow header
        req_wrong_method = rf.delete("/api/v1/booking/point-architecture")
        resp_405 = calendar_views.public_booking_page(
            req_wrong_method, booking_slug="point-architecture"
        )
        assert resp_405.status_code == 405
        assert resp_405["Allow"] == "GET"

        # Authenticated route without Bearer token returns 401 WWW-Authenticate: Bearer
        req_unauth = rf.get(f"/api/v1/organisations/{ORG_A}/workspace/calendar/events")
        resp_401 = calendar_views.events(req_unauth, organisation_id=ORG_A)
        assert resp_401.status_code == 401
        assert resp_401["WWW-Authenticate"] == "Bearer"
        assert resp_401["Cache-Control"] == "no-store"
