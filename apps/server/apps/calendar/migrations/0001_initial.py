"""Sovereign smart calendar, CalDAV sources, and booking page schema with GDPR erasure guards."""

import django.db.models.deletion
from django.db import migrations, models

import core.db.ids

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

GUARDS_FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE FUNCTION public.calendar_scope_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    ws_org uuid;
    mem_org uuid;
    src_ws uuid;
    chan_ws uuid;
    doc_ws uuid;
    page_ws uuid;
    page_org uuid;
    host_mem_id uuid;
    ev_ws uuid;
BEGIN
    SELECT organisation_id INTO ws_org
    FROM public.workspaces_workspace
    WHERE id = NEW.workspace_id;
    IF ws_org IS NULL OR ws_org IS DISTINCT FROM NEW.organisation_id THEN
        RAISE EXCEPTION 'calendar workspace belongs to another organisation'
            USING ERRCODE = '23514', CONSTRAINT = 'calendar_workspace_same_org';
    END IF;

    IF TG_TABLE_NAME = 'calendar_caldavsource' THEN
        SELECT organisation_id INTO mem_org
        FROM public.orgs_membership
        WHERE id = NEW.owner_membership_id;
        IF mem_org IS DISTINCT FROM NEW.organisation_id THEN
            RAISE EXCEPTION 'calendar source membership belongs to another organisation'
                USING ERRCODE = '23514', CONSTRAINT = 'calendar_source_same_org';
        END IF;
    ELSIF TG_TABLE_NAME = 'calendar_calendarevent' THEN
        SELECT organisation_id INTO mem_org
        FROM public.orgs_membership
        WHERE id = NEW.organizer_membership_id;
        IF mem_org IS DISTINCT FROM NEW.organisation_id THEN
            RAISE EXCEPTION 'calendar event organizer belongs to another organisation'
                USING ERRCODE = '23514', CONSTRAINT = 'calendar_event_same_org';
        END IF;
        IF NEW.source_id IS NOT NULL THEN
            SELECT workspace_id INTO src_ws
            FROM public.calendar_caldavsource
            WHERE id = NEW.source_id;
            IF src_ws IS DISTINCT FROM NEW.workspace_id THEN
                RAISE EXCEPTION 'calendar event source belongs to another workspace'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF NEW.channel_id IS NOT NULL THEN
            SELECT workspace_id INTO chan_ws
            FROM public.workspaces_channel
            WHERE id = NEW.channel_id;
            IF chan_ws IS DISTINCT FROM NEW.workspace_id THEN
                RAISE EXCEPTION 'calendar event channel belongs to another workspace'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF NEW.agenda_document_id IS NOT NULL THEN
            SELECT workspace_id INTO doc_ws
            FROM public.docs_document
            WHERE id = NEW.agenda_document_id;
            IF doc_ws IS DISTINCT FROM NEW.workspace_id THEN
                RAISE EXCEPTION 'calendar event document belongs to another workspace'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
    ELSIF TG_TABLE_NAME = 'calendar_bookingpage' THEN
        SELECT organisation_id INTO mem_org
        FROM public.orgs_membership
        WHERE id = NEW.host_membership_id;
        IF mem_org IS DISTINCT FROM NEW.organisation_id THEN
            RAISE EXCEPTION 'booking page host belongs to another organisation'
                USING ERRCODE = '23514', CONSTRAINT = 'calendar_booking_same_org';
        END IF;
    ELSIF TG_TABLE_NAME = 'calendar_bookingslotreservation' THEN
        SELECT organisation_id, workspace_id, host_membership_id
        INTO page_org, page_ws, host_mem_id
        FROM public.calendar_bookingpage
        WHERE id = NEW.booking_page_id
        FOR UPDATE;
        IF page_org IS DISTINCT FROM NEW.organisation_id OR page_ws IS DISTINCT FROM NEW.workspace_id THEN
            RAISE EXCEPTION 'booking reservation scope mismatch'
                USING ERRCODE = '23514';
        END IF;
        PERFORM 1 FROM public.orgs_membership WHERE id = host_mem_id FOR UPDATE;
        IF NEW.event_id IS NOT NULL THEN
            SELECT workspace_id INTO ev_ws
            FROM public.calendar_calendarevent
            WHERE id = NEW.event_id;
            IF ev_ws IS DISTINCT FROM NEW.workspace_id THEN
                RAISE EXCEPTION 'booking reservation event belongs to another workspace'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF NEW.status = 'confirmed' AND EXISTS (
            SELECT 1 FROM public.calendar_bookingslotreservation r
            JOIN public.calendar_bookingpage bp ON bp.id = r.booking_page_id
            WHERE bp.host_membership_id = host_mem_id
              AND r.status = 'confirmed'
              AND r.id <> NEW.id
              AND (
                  (r.starts_at < NEW.buffered_ends_at AND r.ends_at > NEW.buffered_starts_at)
                  OR (NEW.starts_at < r.buffered_ends_at AND NEW.ends_at > r.buffered_starts_at)
              )
        ) THEN
            RAISE EXCEPTION 'booking slot already reserved'
                USING ERRCODE = '23P01', CONSTRAINT = 'calendar_booking_no_overlap';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.calendar_scope_guard() FROM PUBLIC;

CREATE TRIGGER calendar_source_scope
    BEFORE INSERT OR UPDATE ON public.calendar_caldavsource
    FOR EACH ROW EXECUTE FUNCTION public.calendar_scope_guard();

CREATE TRIGGER calendar_event_scope
    BEFORE INSERT OR UPDATE ON public.calendar_calendarevent
    FOR EACH ROW EXECUTE FUNCTION public.calendar_scope_guard();

CREATE TRIGGER calendar_booking_scope
    BEFORE INSERT OR UPDATE ON public.calendar_bookingpage
    FOR EACH ROW EXECUTE FUNCTION public.calendar_scope_guard();

CREATE TRIGGER calendar_reservation_scope
    BEFORE INSERT OR UPDATE ON public.calendar_bookingslotreservation
    FOR EACH ROW EXECUTE FUNCTION public.calendar_scope_guard();

CREATE TRIGGER a_resource_binding
    BEFORE UPDATE ON public.calendar_caldavsource
    FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
        'id', 'created_at', 'organisation_id', 'workspace_id', 'owner_membership_id'
    );

CREATE TRIGGER a_resource_binding
    BEFORE UPDATE ON public.calendar_calendarevent
    FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
        'id', 'created_at', 'organisation_id', 'workspace_id', 'organizer_membership_id', 'uid'
    );

CREATE TRIGGER a_resource_binding
    BEFORE UPDATE ON public.calendar_bookingpage
    FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
        'id', 'created_at', 'organisation_id', 'workspace_id', 'host_membership_id', 'slug'
    );

CREATE TRIGGER a_resource_binding
    BEFORE UPDATE ON public.calendar_bookingslotreservation
    FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
        'id', 'created_at', 'organisation_id', 'workspace_id', 'booking_page_id', 'uid', 'cancellation_token_sha256'
    );

CREATE FUNCTION public.calendar_privacy_cutoff_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    target record;
    org uuid;
    mem_id uuid;
    person uuid;
    active_account_purge boolean := false;
BEGIN
    target := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD ELSE NEW END;
    org := target.organisation_id;
    IF TG_OP = 'DELETE' AND public.privacy_erasure_context(org) THEN
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'calendar_calendarevent' THEN
        IF public.privacy_erasure_context(NEW.organisation_id)
           AND OLD.agenda_document_id IS NOT NULL
           AND NEW.agenda_document_id IS NULL
           AND (to_jsonb(NEW) - 'agenda_document_id') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'agenda_document_id') THEN
            RETURN NEW;
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('calendar_calendarevent', 'calendar_bookingslotreservation') THEN
        SELECT EXISTS (
            SELECT 1 FROM public.retention_worker_context rwc
            WHERE rwc.backend = pg_backend_pid()
              AND rwc.transaction = txid_current()
              AND rwc.purpose = 'account'
              AND rwc.source_table = 'identity_user'
              AND public.privacy_account_context(rwc.source_id)
        ) INTO active_account_purge;

        IF active_account_purge THEN
            IF TG_TABLE_NAME = 'calendar_calendarevent'
               AND (to_jsonb(NEW) - ARRAY['attendees', 'updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['attendees', 'updated_at']) THEN
                RETURN NEW;
            ELSIF TG_TABLE_NAME = 'calendar_bookingslotreservation'
               AND NEW.status = 'cancelled'
               AND NEW.guest_notes = ''
               AND NEW.guest_name = 'Erased guest'
               AND NEW.guest_email = 'erased+' || OLD.id::text || '@invalid.test'
               AND (to_jsonb(NEW) - ARRAY['guest_name', 'guest_email', 'guest_notes', 'status', 'cancelled_at', 'updated_at'])
                   IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['guest_name', 'guest_email', 'guest_notes', 'status', 'cancelled_at', 'updated_at']) THEN
                RETURN NEW;
            END IF;
        END IF;
    END IF;

    IF TG_TABLE_NAME = 'calendar_caldavsource' THEN
        mem_id := target.owner_membership_id;
    ELSIF TG_TABLE_NAME = 'calendar_calendarevent' THEN
        mem_id := target.organizer_membership_id;
    ELSIF TG_TABLE_NAME = 'calendar_bookingpage' THEN
        mem_id := target.host_membership_id;
    ELSE
        SELECT host_membership_id INTO mem_id
        FROM public.calendar_bookingpage
        WHERE id = target.booking_page_id;
    END IF;

    IF mem_id IS NOT NULL THEN
        SELECT user_id INTO person FROM public.orgs_membership WHERE id = mem_id;
    END IF;
    IF TG_OP = 'DELETE' AND person IS NOT NULL AND public.privacy_account_context(person) THEN
        RETURN OLD;
    END IF;

    IF person IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('privacy_account_cutoff:' || person::text, 0)
        );
        IF EXISTS (SELECT 1 FROM public.orgs_accounterasure WHERE user_reference = person)
           AND NOT public.privacy_account_context(person)
           AND NOT public.privacy_erasure_context(org) THEN
            RAISE EXCEPTION 'durable account cutoff refuses calendar write'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    PERFORM pg_advisory_xact_lock_shared(
        hashtextextended('privacy_erasure_cutoff:' || org::text, 0)
    );
    IF EXISTS (SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference = org)
       AND NOT public.privacy_erasure_context(org) THEN
        RAISE EXCEPTION 'durable erasure cutoff refuses calendar write'
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.calendar_privacy_cutoff_guard() FROM PUBLIC;

CREATE TRIGGER aa_privacy_cutoff
    BEFORE INSERT OR UPDATE OR DELETE ON public.calendar_caldavsource
    FOR EACH ROW EXECUTE FUNCTION public.calendar_privacy_cutoff_guard();

CREATE TRIGGER aa_privacy_cutoff
    BEFORE INSERT OR UPDATE OR DELETE ON public.calendar_calendarevent
    FOR EACH ROW EXECUTE FUNCTION public.calendar_privacy_cutoff_guard();

CREATE TRIGGER aa_privacy_cutoff
    BEFORE INSERT OR UPDATE OR DELETE ON public.calendar_bookingpage
    FOR EACH ROW EXECUTE FUNCTION public.calendar_privacy_cutoff_guard();

CREATE TRIGGER aa_privacy_cutoff
    BEFORE INSERT OR UPDATE OR DELETE ON public.calendar_bookingslotreservation
    FOR EACH ROW EXECUTE FUNCTION public.calendar_privacy_cutoff_guard();

CREATE FUNCTION public.calendar_contact_scrub_hook() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    person uuid;
    prior_email text;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.email IS DISTINCT FROM NEW.email AND NEW.email = 'erased:' || OLD.id::text THEN
        IF TG_TABLE_NAME = 'identity_user' THEN
            person := OLD.id;
        ELSE
            person := OLD.user_id;
        END IF;
        IF person IS NOT NULL AND public.privacy_account_context(person) THEN
            prior_email := lower(btrim(OLD.email));
            IF prior_email <> '' AND prior_email NOT LIKE 'erased:%' THEN
                UPDATE public.calendar_bookingslotreservation
                SET guest_name = 'Erased guest',
                    guest_email = 'erased+' || id::text || '@invalid.test',
                    guest_notes = '',
                    status = 'cancelled',
                    cancelled_at = COALESCE(cancelled_at, clock_timestamp()),
                    updated_at = clock_timestamp()
                WHERE lower(btrim(guest_email)) = prior_email;

                UPDATE public.calendar_calendarevent ce
                SET attendees = COALESCE(
                        (
                            SELECT jsonb_agg(elem)
                            FROM jsonb_array_elements(ce.attendees) AS elem
                            WHERE lower(btrim(COALESCE(elem->>'email', ''))) <> prior_email
                        ),
                        '[]'::jsonb
                    ),
                    updated_at = clock_timestamp()
                WHERE jsonb_typeof(ce.attendees) = 'array'
                  AND EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements(ce.attendees) AS elem
                      WHERE lower(btrim(COALESCE(elem->>'email', ''))) = prior_email
                  );

                DELETE FROM public.idempotency_record
                WHERE issuer = 'https://kodera.io/public-booking'
                  AND subject LIKE '%:' || encode(sha256(convert_to(prior_email, 'UTF8')), 'hex');
            END IF;
        END IF;
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.calendar_contact_scrub_hook() FROM PUBLIC;

CREATE TRIGGER aa_06_calendar_contact_scrub
    AFTER UPDATE OF email ON public.identity_user
    FOR EACH ROW EXECUTE FUNCTION public.calendar_contact_scrub_hook();

CREATE TRIGGER aa_06_calendar_contact_scrub
    AFTER UPDATE OF email ON public.identity_identity
    FOR EACH ROW EXECUTE FUNCTION public.calendar_contact_scrub_hook();

CREATE FUNCTION public.calendar_erasure_hook() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    org uuid;
    person uuid;
    n_res bigint := 0;
    n_ev bigint := 0;
    n_pg bigint := 0;
    n_src bigint := 0;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
        IF TG_TABLE_NAME = 'orgs_privacyerasure' THEN
            org := NEW.organisation_reference;
            IF NOT public.privacy_erasure_context(org) THEN
                RAISE EXCEPTION 'calendar organisation erasure requires worker authority'
                    USING ERRCODE = '23514';
            END IF;
            DELETE FROM public.idempotency_record ir
            WHERE ir.issuer = 'https://kodera.io/public-booking'
              AND EXISTS (
                  SELECT 1 FROM public.calendar_bookingpage bp
                  WHERE bp.organisation_id = org
                    AND (ir.subject = 'booking:' || bp.slug OR ir.subject LIKE 'booking:' || bp.slug || ':%')
              );
            DELETE FROM public.calendar_bookingslotreservation WHERE organisation_id = org;
            GET DIAGNOSTICS n_res = ROW_COUNT;
            DELETE FROM public.calendar_calendarevent WHERE organisation_id = org;
            GET DIAGNOSTICS n_ev = ROW_COUNT;
            DELETE FROM public.calendar_bookingpage WHERE organisation_id = org;
            GET DIAGNOSTICS n_pg = ROW_COUNT;
            DELETE FROM public.calendar_caldavsource WHERE organisation_id = org;
            GET DIAGNOSTICS n_src = ROW_COUNT;
            NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                'calendar_reservations', n_res,
                'calendar_events', n_ev,
                'calendar_booking_pages', n_pg,
                'calendar_sources', n_src
            );
        ELSIF TG_TABLE_NAME = 'orgs_accounterasure' THEN
            person := NEW.user_reference;
            IF NOT public.privacy_account_context(person) THEN
                RAISE EXCEPTION 'calendar account erasure requires worker authority'
                    USING ERRCODE = '23514';
            END IF;
            DELETE FROM public.idempotency_record ir
            WHERE ir.issuer = 'https://kodera.io/public-booking'
              AND EXISTS (
                  SELECT 1 FROM public.calendar_bookingpage bp
                  WHERE bp.host_membership_id IN (
                      SELECT id FROM public.orgs_membership WHERE user_id = person
                  )
                  AND (ir.subject = 'booking:' || bp.slug OR ir.subject LIKE 'booking:' || bp.slug || ':%')
              );
            DELETE FROM public.calendar_bookingslotreservation
            WHERE booking_page_id IN (
                SELECT id FROM public.calendar_bookingpage
                WHERE host_membership_id IN (
                    SELECT id FROM public.orgs_membership WHERE user_id = person
                )
            ) OR event_id IN (
                SELECT id FROM public.calendar_calendarevent
                WHERE organizer_membership_id IN (
                    SELECT id FROM public.orgs_membership WHERE user_id = person
                )
            );
            GET DIAGNOSTICS n_res = ROW_COUNT;
            DELETE FROM public.calendar_calendarevent
            WHERE organizer_membership_id IN (
                SELECT id FROM public.orgs_membership WHERE user_id = person
            );
            GET DIAGNOSTICS n_ev = ROW_COUNT;
            DELETE FROM public.calendar_bookingpage
            WHERE host_membership_id IN (
                SELECT id FROM public.orgs_membership WHERE user_id = person
            );
            GET DIAGNOSTICS n_pg = ROW_COUNT;
            DELETE FROM public.calendar_caldavsource
            WHERE owner_membership_id IN (
                SELECT id FROM public.orgs_membership WHERE user_id = person
            );
            GET DIAGNOSTICS n_src = ROW_COUNT;
            NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                'calendar_reservations', n_res,
                'calendar_events', n_ev,
                'calendar_booking_pages', n_pg,
                'calendar_sources', n_src
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.calendar_erasure_hook() FROM PUBLIC;

CREATE TRIGGER aa_06_calendar_erasure
    BEFORE UPDATE ON public.orgs_privacyerasure
    FOR EACH ROW EXECUTE FUNCTION public.calendar_erasure_hook();

CREATE TRIGGER aa_06_calendar_erasure
    BEFORE UPDATE ON public.orgs_accounterasure
    FOR EACH ROW EXECUTE FUNCTION public.calendar_erasure_hook();
"""

GUARDS_REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DO $calendar_downgrade_guard$
BEGIN
    IF EXISTS (SELECT 1 FROM public.calendar_caldavsource)
       OR EXISTS (SELECT 1 FROM public.calendar_calendarevent)
       OR EXISTS (SELECT 1 FROM public.calendar_bookingpage)
       OR EXISTS (SELECT 1 FROM public.calendar_bookingslotreservation) THEN
        RAISE EXCEPTION 'cannot downgrade calendar migration with persisted calendar or booking records'
            USING ERRCODE = '23514';
    END IF;
END $calendar_downgrade_guard$;

DROP TRIGGER IF EXISTS aa_06_calendar_contact_scrub ON public.identity_identity;
DROP TRIGGER IF EXISTS aa_06_calendar_contact_scrub ON public.identity_user;
DROP FUNCTION IF EXISTS public.calendar_contact_scrub_hook();

DROP TRIGGER IF EXISTS aa_06_calendar_erasure ON public.orgs_accounterasure;
DROP TRIGGER IF EXISTS aa_06_calendar_erasure ON public.orgs_privacyerasure;
DROP FUNCTION IF EXISTS public.calendar_erasure_hook();

DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.calendar_bookingslotreservation;
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.calendar_bookingpage;
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.calendar_calendarevent;
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.calendar_caldavsource;
DROP FUNCTION IF EXISTS public.calendar_privacy_cutoff_guard();

DROP TRIGGER IF EXISTS a_resource_binding ON public.calendar_bookingslotreservation;
DROP TRIGGER IF EXISTS a_resource_binding ON public.calendar_bookingpage;
DROP TRIGGER IF EXISTS a_resource_binding ON public.calendar_calendarevent;
DROP TRIGGER IF EXISTS a_resource_binding ON public.calendar_caldavsource;

DROP TRIGGER IF EXISTS calendar_reservation_scope ON public.calendar_bookingslotreservation;
DROP TRIGGER IF EXISTS calendar_booking_scope ON public.calendar_bookingpage;
DROP TRIGGER IF EXISTS calendar_event_scope ON public.calendar_calendarevent;
DROP TRIGGER IF EXISTS calendar_source_scope ON public.calendar_caldavsource;
DROP FUNCTION IF EXISTS public.calendar_scope_guard();
"""


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("docs", "0011_collab_lock_order_and_iam_policy"),
        ("orgs", "0035_ee_audit_ledger_erasure"),
        ("workspaces", "0018_ai_policy_and_consent"),
    ]

    operations = [
        migrations.RunSQL(TIMEOUTS, reverse_sql=migrations.RunSQL.noop),
        migrations.CreateModel(
            name="CalDavSource",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("name", models.TextField()),
                ("provider", models.TextField(default="lasuite")),
                ("calendar_url", models.TextField()),
                ("principal_username", models.TextField()),
                ("sealed_credentials", models.BinaryField()),
                ("sync_token", models.TextField(blank=True, default="")),
                ("ctag", models.TextField(blank=True, default="")),
                ("enabled", models.BooleanField(default=True)),
                ("last_synced_at", models.DateTimeField(blank=True, null=True)),
                ("last_error_code", models.TextField(blank=True, default="")),
                (
                    "organisation",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.organisation",
                    ),
                ),
                (
                    "owner_membership",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.membership",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="workspaces.workspace",
                    ),
                ),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["workspace", "-created_at"],
                        name="calendar_source_workspace_idx",
                    ),
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(
                            ("provider__in", ["lasuite", "open_xchange", "nextcloud", "generic"])
                        ),
                        name="calendar_source_provider_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("name__length__range", (1, 128))),
                        name="calendar_source_name_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("calendar_url__length__range", (8, 2048))),
                        name="calendar_source_url_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("principal_username__length__range", (1, 255))),
                        name="calendar_source_username_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("sealed_credentials__length__range", (29, 16384))),
                        name="calendar_source_sealed_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("sync_token__length__lte", 1024)),
                        name="calendar_source_synctoken_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("ctag__length__lte", 255)),
                        name="calendar_source_ctag_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("last_error_code__length__lte", 128)),
                        name="calendar_source_error_bound",
                    ),
                    models.UniqueConstraint(
                        fields=("workspace", "calendar_url"),
                        name="calendar_source_workspace_url_unique",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="CalendarEvent",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("uid", models.TextField()),
                ("title", models.TextField()),
                ("description", models.TextField(blank=True, default="")),
                ("location", models.TextField(blank=True, default="")),
                ("starts_at", models.DateTimeField()),
                ("ends_at", models.DateTimeField()),
                ("timezone", models.TextField(default="Europe/Paris")),
                ("rrule", models.TextField(blank=True, default="")),
                ("status", models.TextField(default="confirmed")),
                ("visibility", models.TextField(default="workspace")),
                ("attendees", models.JSONField(default=list)),
                ("alarm_minutes_before", models.IntegerField(blank=True, null=True)),
                ("visio_url", models.TextField(blank=True, default="")),
                ("agenda_doc_url", models.TextField(blank=True, default="")),
                ("remote_href", models.TextField(blank=True, default="")),
                ("remote_etag", models.TextField(blank=True, default="")),
                ("sequence", models.IntegerField(default=0)),
                ("revision", models.BigIntegerField(default=1)),
                (
                    "agenda_document",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        to="docs.document",
                    ),
                ),
                (
                    "channel",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="workspaces.channel",
                    ),
                ),
                (
                    "organisation",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.organisation",
                    ),
                ),
                (
                    "organizer_membership",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.membership",
                    ),
                ),
                (
                    "source",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="calendar.caldavsource",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="workspaces.workspace",
                    ),
                ),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["workspace", "starts_at", "ends_at"],
                        name="calendar_event_window_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        condition=models.Q(("source__isnull", True)),
                        fields=("workspace", "uid"),
                        name="calendar_event_native_uid_unique",
                    ),
                    models.UniqueConstraint(
                        condition=models.Q(("source__isnull", False)),
                        fields=("workspace", "source", "uid"),
                        name="calendar_event_source_uid_unique",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("ends_at__gt", models.F("starts_at"))),
                        name="calendar_event_range_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("uid__length__range", (1, 255))),
                        name="calendar_event_uid_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("title__length__range", (1, 255))),
                        name="calendar_event_title_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("description__length__lte", 8192)),
                        name="calendar_event_description_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("location__length__lte", 512)),
                        name="calendar_event_location_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("timezone__length__range", (1, 64))),
                        name="calendar_event_timezone_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("rrule__length__lte", 512)),
                        name="calendar_event_rrule_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("status__in", ["confirmed", "tentative", "cancelled"])),
                        name="calendar_event_status_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("visibility__in", ["workspace", "private", "busy_only"])
                        ),
                        name="calendar_event_visibility_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("alarm_minutes_before__isnull", True),
                            ("alarm_minutes_before__range", (0, 10080)),
                            _connector="OR",
                        ),
                        name="calendar_event_alarm_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("visio_url__length__lte", 2048)),
                        name="calendar_event_visio_url_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("agenda_doc_url__length__lte", 2048)),
                        name="calendar_event_agenda_url_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("remote_href__length__lte", 2048)),
                        name="calendar_event_remote_href_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("remote_etag__length__lte", 255)),
                        name="calendar_event_remote_etag_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("revision__gte", 1), ("sequence__gte", 0)),
                        name="calendar_event_counters_valid",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="BookingPage",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("slug", models.TextField(unique=True)),
                ("title", models.TextField()),
                ("description", models.TextField(blank=True, default="")),
                ("timezone", models.TextField(default="Europe/Paris")),
                ("duration_minutes", models.IntegerField(default=30)),
                ("buffer_minutes", models.IntegerField(default=0)),
                ("availability_windows", models.JSONField(default=list)),
                ("visio_url", models.TextField(blank=True, default="")),
                ("agenda_doc_url", models.TextField(blank=True, default="")),
                ("active", models.BooleanField(default=True)),
                ("revision", models.BigIntegerField(default=1)),
                (
                    "host_membership",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.membership",
                    ),
                ),
                (
                    "organisation",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.organisation",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="workspaces.workspace",
                    ),
                ),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["workspace", "-created_at"],
                        name="calendar_booking_workspace_idx",
                    ),
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(("slug__length__range", (3, 80))),
                        name="calendar_booking_slug_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("title__length__range", (1, 160))),
                        name="calendar_booking_title_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("description__length__lte", 2048)),
                        name="calendar_booking_description_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("timezone__length__range", (1, 64))),
                        name="calendar_booking_timezone_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("duration_minutes__in", [15, 30, 45, 60])),
                        name="calendar_booking_duration_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("buffer_minutes__range", (0, 120))),
                        name="calendar_booking_buffer_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("visio_url__length__lte", 2048)),
                        name="calendar_booking_visio_url_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("agenda_doc_url__length__lte", 2048)),
                        name="calendar_booking_agenda_url_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("revision__gte", 1)),
                        name="calendar_booking_revision_valid",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="BookingSlotReservation",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("uid", models.TextField()),
                ("guest_name", models.TextField()),
                ("guest_email", models.TextField()),
                ("guest_notes", models.TextField(blank=True, default="")),
                ("starts_at", models.DateTimeField()),
                ("ends_at", models.DateTimeField()),
                ("buffered_starts_at", models.DateTimeField()),
                ("buffered_ends_at", models.DateTimeField()),
                ("status", models.TextField(default="confirmed")),
                ("cancellation_token_sha256", models.BinaryField()),
                ("cancelled_at", models.DateTimeField(blank=True, null=True)),
                (
                    "booking_page",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="calendar.bookingpage",
                    ),
                ),
                (
                    "event",
                    models.OneToOneField(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="calendar.calendarevent",
                    ),
                ),
                (
                    "organisation",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.organisation",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="workspaces.workspace",
                    ),
                ),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["booking_page", "status", "buffered_starts_at", "buffered_ends_at"],
                        name="calendar_reservation_slot_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("booking_page", "uid"),
                        name="calendar_reservation_uid_unique",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("buffered_ends_at__gte", models.F("ends_at")),
                            ("buffered_starts_at__lte", models.F("starts_at")),
                            ("ends_at__gt", models.F("starts_at")),
                        ),
                        name="calendar_reservation_range_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("uid__length__range", (1, 255))),
                        name="calendar_reservation_uid_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("guest_name__length__range", (1, 160))),
                        name="calendar_reservation_guest_name_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("guest_email__length__range", (3, 254))),
                        name="calendar_reservation_guest_email_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("guest_notes__length__lte", 1024)),
                        name="calendar_reservation_notes_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("status__in", ["confirmed", "cancelled"])),
                        name="calendar_reservation_status_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("cancellation_token_sha256__length", 32)),
                        name="calendar_reservation_token_digest_size",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            models.Q(("cancelled_at__isnull", True), ("status", "confirmed")),
                            models.Q(("cancelled_at__isnull", False), ("status", "cancelled")),
                            _connector="OR",
                        ),
                        name="calendar_reservation_cancel_pair",
                    ),
                ],
            },
        ),
        migrations.RunSQL(GUARDS_FORWARD, reverse_sql=GUARDS_REVERSE),
        migrations.RunSQL(migrations.RunSQL.noop, reverse_sql=TIMEOUTS),
    ]
