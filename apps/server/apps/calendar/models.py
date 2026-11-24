"""Workspace CalDAV sources, calendar events, sovereign booking pages, and slot reservations."""

from django.db import models
from django.db.models.functions import Length

from core.db.models import StoredModel

models.BinaryField.register_lookup(Length)


class CalDavSource(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.RESTRICT)
    owner_membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    name = models.TextField()
    provider = models.TextField(default="lasuite")
    calendar_url = models.TextField()
    principal_username = models.TextField()
    sealed_credentials = models.BinaryField()
    sync_token = models.TextField(default="", blank=True)
    ctag = models.TextField(default="", blank=True)
    enabled = models.BooleanField(default=True)
    last_synced_at = models.DateTimeField(null=True, blank=True)
    last_error_code = models.TextField(default="", blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(
                    provider__in=["lasuite", "open_xchange", "nextcloud", "generic"]
                ),
                name="calendar_source_provider_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(name__length__range=(1, 128)),
                name="calendar_source_name_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(calendar_url__length__range=(8, 2048)),
                name="calendar_source_url_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(principal_username__length__range=(1, 255)),
                name="calendar_source_username_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(sealed_credentials__length__range=(29, 16384)),
                name="calendar_source_sealed_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(sync_token__length__lte=1024),
                name="calendar_source_synctoken_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(ctag__length__lte=255),
                name="calendar_source_ctag_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(last_error_code__length__lte=128),
                name="calendar_source_error_bound",
            ),
            models.UniqueConstraint(
                fields=["workspace", "calendar_url"],
                name="calendar_source_workspace_url_unique",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "-created_at"], name="calendar_source_workspace_idx"),
        ]


class CalendarEvent(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.RESTRICT)
    organizer_membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    source = models.ForeignKey(CalDavSource, on_delete=models.RESTRICT, null=True, blank=True)
    channel = models.ForeignKey(
        "workspaces.Channel", on_delete=models.RESTRICT, null=True, blank=True
    )
    agenda_document = models.ForeignKey(
        "docs.Document", on_delete=models.SET_NULL, null=True, blank=True
    )
    uid = models.TextField()
    title = models.TextField()
    description = models.TextField(default="", blank=True)
    location = models.TextField(default="", blank=True)
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
    timezone = models.TextField(default="Europe/Paris")
    rrule = models.TextField(default="", blank=True)
    status = models.TextField(default="confirmed")
    visibility = models.TextField(default="workspace")
    attendees = models.JSONField(default=list)
    alarm_minutes_before = models.IntegerField(null=True, blank=True)
    visio_url = models.TextField(default="", blank=True)
    agenda_doc_url = models.TextField(default="", blank=True)
    remote_href = models.TextField(default="", blank=True)
    remote_etag = models.TextField(default="", blank=True)
    sequence = models.IntegerField(default=0)
    revision = models.BigIntegerField(default=1)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                condition=models.Q(source__isnull=True),
                fields=["workspace", "uid"],
                name="calendar_event_native_uid_unique",
            ),
            models.UniqueConstraint(
                condition=models.Q(source__isnull=False),
                fields=["workspace", "source", "uid"],
                name="calendar_event_source_uid_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(ends_at__gt=models.F("starts_at")),
                name="calendar_event_range_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(uid__length__range=(1, 255)),
                name="calendar_event_uid_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(title__length__range=(1, 255)),
                name="calendar_event_title_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(description__length__lte=8192),
                name="calendar_event_description_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(location__length__lte=512),
                name="calendar_event_location_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(timezone__length__range=(1, 64)),
                name="calendar_event_timezone_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(rrule__length__lte=512),
                name="calendar_event_rrule_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(status__in=["confirmed", "tentative", "cancelled"]),
                name="calendar_event_status_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(visibility__in=["workspace", "private", "busy_only"]),
                name="calendar_event_visibility_valid",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(alarm_minutes_before__isnull=True)
                    | models.Q(alarm_minutes_before__range=(0, 10080))
                ),
                name="calendar_event_alarm_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(visio_url__length__lte=2048),
                name="calendar_event_visio_url_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(agenda_doc_url__length__lte=2048),
                name="calendar_event_agenda_url_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(remote_href__length__lte=2048),
                name="calendar_event_remote_href_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(remote_etag__length__lte=255),
                name="calendar_event_remote_etag_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(sequence__gte=0, revision__gte=1),
                name="calendar_event_counters_valid",
            ),
        ]
        indexes = [
            models.Index(
                fields=["workspace", "starts_at", "ends_at"],
                name="calendar_event_window_idx",
            ),
        ]


class BookingPage(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.RESTRICT)
    host_membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    slug = models.TextField(unique=True)
    title = models.TextField()
    description = models.TextField(default="", blank=True)
    timezone = models.TextField(default="Europe/Paris")
    duration_minutes = models.IntegerField(default=30)
    buffer_minutes = models.IntegerField(default=0)
    availability_windows = models.JSONField(default=list)
    visio_url = models.TextField(default="", blank=True)
    agenda_doc_url = models.TextField(default="", blank=True)
    active = models.BooleanField(default=True)
    revision = models.BigIntegerField(default=1)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(slug__length__range=(3, 80)),
                name="calendar_booking_slug_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(title__length__range=(1, 160)),
                name="calendar_booking_title_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(description__length__lte=2048),
                name="calendar_booking_description_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(timezone__length__range=(1, 64)),
                name="calendar_booking_timezone_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(duration_minutes__in=[15, 30, 45, 60]),
                name="calendar_booking_duration_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(buffer_minutes__range=(0, 120)),
                name="calendar_booking_buffer_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(visio_url__length__lte=2048),
                name="calendar_booking_visio_url_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(agenda_doc_url__length__lte=2048),
                name="calendar_booking_agenda_url_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(revision__gte=1),
                name="calendar_booking_revision_valid",
            ),
        ]
        indexes = [
            models.Index(
                fields=["workspace", "-created_at"], name="calendar_booking_workspace_idx"
            ),
        ]


class BookingSlotReservation(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.RESTRICT)
    booking_page = models.ForeignKey(BookingPage, on_delete=models.RESTRICT)
    event = models.OneToOneField(CalendarEvent, on_delete=models.RESTRICT, null=True, blank=True)
    uid = models.TextField()
    guest_name = models.TextField()
    guest_email = models.TextField()
    guest_notes = models.TextField(default="", blank=True)
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
    buffered_starts_at = models.DateTimeField()
    buffered_ends_at = models.DateTimeField()
    status = models.TextField(default="confirmed")
    cancellation_token_sha256 = models.BinaryField()
    cancelled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["booking_page", "uid"],
                name="calendar_reservation_uid_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    ends_at__gt=models.F("starts_at"),
                    buffered_starts_at__lte=models.F("starts_at"),
                    buffered_ends_at__gte=models.F("ends_at"),
                ),
                name="calendar_reservation_range_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(uid__length__range=(1, 255)),
                name="calendar_reservation_uid_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(guest_name__length__range=(1, 160)),
                name="calendar_reservation_guest_name_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(guest_email__length__range=(3, 254)),
                name="calendar_reservation_guest_email_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(guest_notes__length__lte=1024),
                name="calendar_reservation_notes_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(status__in=["confirmed", "cancelled"]),
                name="calendar_reservation_status_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(cancellation_token_sha256__length=32),
                name="calendar_reservation_token_digest_size",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(status="confirmed", cancelled_at__isnull=True)
                    | models.Q(status="cancelled", cancelled_at__isnull=False)
                ),
                name="calendar_reservation_cancel_pair",
            ),
        ]
        indexes = [
            models.Index(
                fields=["booking_page", "status", "buffered_starts_at", "buffered_ends_at"],
                name="calendar_reservation_slot_idx",
            ),
        ]
