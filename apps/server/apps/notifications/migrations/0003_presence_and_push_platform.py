"""Add push subscription platform and bounded foreground presence leases with GDPR erasure."""

from datetime import timedelta

import django.db.models.deletion
from django.db import migrations, models

import core.db.ids

FORWARD_SQL = r"""
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TRIGGER presence_recipient_scope
    BEFORE INSERT OR UPDATE ON public.notifications_presencelease
    FOR EACH ROW EXECUTE FUNCTION public.notification_recipient_scope();

CREATE TRIGGER a_resource_binding
    BEFORE UPDATE ON public.notifications_presencelease
    FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
        'id', 'organisation_id', 'membership_id', 'device_id'
    );

CREATE TRIGGER aa_privacy_cutoff
    BEFORE INSERT OR UPDATE ON public.notifications_presencelease
    FOR EACH ROW EXECUTE FUNCTION public.privacy_cutoff_guard();

CREATE TRIGGER ab_account_cutoff
    BEFORE INSERT OR UPDATE ON public.notifications_presencelease
    FOR EACH ROW EXECUTE FUNCTION public.privacy_account_cutoff_guard();

CREATE FUNCTION public.notification_presence_erasure_hook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    deleted_count bigint := 0;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
        IF TG_TABLE_NAME = 'orgs_privacyerasure' THEN
            IF to_regclass('public.notifications_presencelease') IS NOT NULL THEN
                DELETE FROM public.notifications_presencelease
                WHERE organisation_id = NEW.organisation_reference;
                GET DIAGNOSTICS deleted_count = ROW_COUNT;
            END IF;
            NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                'presence_leases', deleted_count
            );
        ELSIF TG_TABLE_NAME = 'orgs_accounterasure' THEN
            IF to_regclass('public.notifications_presencelease') IS NOT NULL THEN
                DELETE FROM public.notifications_presencelease
                WHERE membership_id IN (
                    SELECT id FROM public.orgs_membership WHERE user_id = NEW.user_reference
                );
                GET DIAGNOSTICS deleted_count = ROW_COUNT;
            END IF;
            NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                'presence_leases', deleted_count
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notification_presence_erasure_hook() FROM PUBLIC;

CREATE TRIGGER aa_04_presence_lease_erasure
    BEFORE UPDATE ON public.orgs_privacyerasure
    FOR EACH ROW EXECUTE FUNCTION public.notification_presence_erasure_hook();

CREATE TRIGGER aa_04_presence_lease_erasure
    BEFORE UPDATE ON public.orgs_accounterasure
    FOR EACH ROW EXECUTE FUNCTION public.notification_presence_erasure_hook();
"""

REVERSE_SQL = r"""
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP TRIGGER IF EXISTS aa_04_presence_lease_erasure ON public.orgs_accounterasure;
DROP TRIGGER IF EXISTS aa_04_presence_lease_erasure ON public.orgs_privacyerasure;
DROP FUNCTION IF EXISTS public.notification_presence_erasure_hook();

DROP TRIGGER IF EXISTS ab_account_cutoff ON public.notifications_presencelease;
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.notifications_presencelease;
DROP TRIGGER IF EXISTS a_resource_binding ON public.notifications_presencelease;
DROP TRIGGER IF EXISTS presence_recipient_scope ON public.notifications_presencelease;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("notifications", "0002_recipient_scope"),
        ("orgs", "0035_ee_audit_ledger_erasure"),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddField(
            model_name="pushsubscription",
            name="platform",
            field=models.TextField(default="web"),
        ),
        migrations.CreateModel(
            name="PresenceLease",
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
                ("device_id", models.UUIDField()),
                ("platform", models.TextField()),
                ("expires_at", models.DateTimeField()),
                (
                    "membership",
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
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["organisation", "membership", "expires_at"],
                        name="presence_lease_active",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("organisation", "membership", "device_id"),
                        name="presence_lease_device_unique",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("platform__in", ["web", "desktop"])),
                        name="presence_lease_platform_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("expires_at__gt", models.F("updated_at")),
                            ("expires_at__lte", models.F("updated_at") + timedelta(seconds=90)),
                        ),
                        name="presence_lease_ttl_bound",
                    ),
                ],
            },
        ),
        migrations.AddConstraint(
            model_name="pushsubscription",
            constraint=models.CheckConstraint(
                condition=models.Q(("platform__in", ["web", "desktop", "ios", "android"])),
                name="push_subscription_platform_valid",
            ),
        ),
        migrations.RunSQL(FORWARD_SQL, reverse_sql=REVERSE_SQL),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';",
        ),
    ]
