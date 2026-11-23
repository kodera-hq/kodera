"""Three-tier OFF-by-default AI policy and consent tables with scope and GDPR erasure guards."""

import django.db.models.deletion
from django.db import migrations, models

import core.db.ids

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

GUARDS_FORWARD = """
ALTER TABLE public.workspaces_workspaceaipolicy
  ADD CONSTRAINT workspace_ai_policy_org_fk
  FOREIGN KEY (organisation_id) REFERENCES public.orgs_organisation(id) ON DELETE RESTRICT,
  ADD CONSTRAINT workspace_ai_policy_workspace_fk
  FOREIGN KEY (workspace_id) REFERENCES public.workspaces_workspace(id) ON DELETE RESTRICT;

ALTER TABLE public.workspaces_memberaiconsent
  ADD CONSTRAINT member_ai_consent_org_fk
  FOREIGN KEY (organisation_id) REFERENCES public.orgs_organisation(id) ON DELETE RESTRICT,
  ADD CONSTRAINT member_ai_consent_workspace_fk
  FOREIGN KEY (workspace_id) REFERENCES public.workspaces_workspace(id) ON DELETE RESTRICT,
  ADD CONSTRAINT member_ai_consent_membership_fk
  FOREIGN KEY (membership_id) REFERENCES public.orgs_membership(id) ON DELETE RESTRICT,
  ADD CONSTRAINT member_ai_consent_identity_fk
  FOREIGN KEY (identity_id) REFERENCES public.identity_identity(id) ON DELETE RESTRICT;

CREATE FUNCTION public.workspace_ai_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ws_org uuid; mem_org uuid; mem_user uuid; id_org uuid; id_user uuid;
BEGIN
    SELECT organisation_id INTO ws_org
    FROM public.workspaces_workspace
    WHERE id = NEW.workspace_id;
    IF ws_org IS NULL OR ws_org <> NEW.organisation_id THEN
        RAISE EXCEPTION 'AI policy workspace belongs to another organisation'
            USING ERRCODE = '23514', CONSTRAINT = 'workspace_ai_same_org';
    END IF;
    IF TG_TABLE_NAME = 'workspaces_memberaiconsent' THEN
        SELECT organisation_id, user_id INTO mem_org, mem_user
        FROM public.orgs_membership
        WHERE id = NEW.membership_id;
        SELECT organisation_id, user_id INTO id_org, id_user
        FROM public.identity_identity
        WHERE id = NEW.identity_id;
        IF mem_org IS DISTINCT FROM NEW.organisation_id
           OR id_org IS DISTINCT FROM NEW.organisation_id
           OR mem_user IS DISTINCT FROM id_user THEN
            RAISE EXCEPTION 'Member AI consent principal belongs to another scope'
                USING ERRCODE = '23514', CONSTRAINT = 'member_ai_consent_same_scope';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workspace_ai_scope_guard() FROM PUBLIC;

CREATE TRIGGER workspace_ai_policy_scope
  BEFORE INSERT OR UPDATE ON public.workspaces_workspaceaipolicy
  FOR EACH ROW EXECUTE FUNCTION public.workspace_ai_scope_guard();

CREATE TRIGGER member_ai_consent_scope
  BEFORE INSERT OR UPDATE ON public.workspaces_memberaiconsent
  FOR EACH ROW EXECUTE FUNCTION public.workspace_ai_scope_guard();

CREATE TRIGGER a_resource_binding
  BEFORE UPDATE ON public.workspaces_workspaceaipolicy
  FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
      'id', 'created_at', 'organisation_id', 'workspace_id'
  );

CREATE TRIGGER a_resource_binding
  BEFORE UPDATE ON public.workspaces_memberaiconsent
  FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
      'id', 'created_at', 'organisation_id', 'workspace_id', 'membership_id', 'identity_id'
  );

CREATE TRIGGER aa_privacy_cutoff
  BEFORE INSERT OR UPDATE OR DELETE ON public.workspaces_workspaceaipolicy
  FOR EACH ROW EXECUTE FUNCTION public.workspace_iam_cutoff_guard();

CREATE FUNCTION public.workspace_ai_account_cutoff_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target record; person uuid; org uuid;
BEGIN
    target := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD ELSE NEW END;
    org := target.organisation_id;
    IF TG_OP = 'DELETE' AND public.privacy_erasure_context(org) THEN
        RETURN OLD;
    END IF;
    SELECT user_id INTO person FROM public.orgs_membership WHERE id = target.membership_id;
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
            RAISE EXCEPTION 'durable account cutoff refuses member AI consent write'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    PERFORM pg_advisory_xact_lock_shared(
        hashtextextended('privacy_erasure_cutoff:' || org::text, 0)
    );
    IF EXISTS (SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference = org)
       AND NOT public.privacy_erasure_context(org) THEN
        RAISE EXCEPTION 'durable erasure cutoff refuses write'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workspace_ai_account_cutoff_guard() FROM PUBLIC;

CREATE TRIGGER aa_privacy_cutoff
  BEFORE INSERT OR UPDATE OR DELETE ON public.workspaces_memberaiconsent
  FOR EACH ROW EXECUTE FUNCTION public.workspace_ai_account_cutoff_guard();

CREATE FUNCTION public.workspace_ai_erasure_hook() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE org uuid := NEW.organisation_reference;
BEGIN
    IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
        IF NOT public.privacy_erasure_context(org) THEN
            RAISE EXCEPTION 'workspace AI policy erasure requires worker authority'
                USING ERRCODE = '23514';
        END IF;
        DELETE FROM public.workspaces_memberaiconsent WHERE organisation_id = org;
        DELETE FROM public.workspaces_workspaceaipolicy WHERE organisation_id = org;
        UPDATE public.workspaces_channel
        SET ai_enabled = false, version = version + 1, updated_at = clock_timestamp()
        WHERE workspace_id IN (
            SELECT id FROM public.workspaces_workspace WHERE organisation_id = org
        ) AND ai_enabled = true;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workspace_ai_erasure_hook() FROM PUBLIC;

CREATE TRIGGER aa_05_workspace_ai_erasure
  BEFORE UPDATE ON public.orgs_privacyerasure
  FOR EACH ROW EXECUTE FUNCTION public.workspace_ai_erasure_hook();

CREATE FUNCTION public.account_ai_consent_erasure_hook() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE person uuid := NEW.user_reference;
BEGIN
    IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
        IF NOT public.privacy_account_context(person) THEN
            RAISE EXCEPTION 'account AI consent erasure requires worker authority'
                USING ERRCODE = '23514';
        END IF;
        DELETE FROM public.workspaces_memberaiconsent
        WHERE membership_id IN (
            SELECT id FROM public.orgs_membership WHERE user_id = person
        ) OR identity_id IN (
            SELECT id FROM public.identity_identity WHERE user_id = person
        );
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.account_ai_consent_erasure_hook() FROM PUBLIC;

CREATE TRIGGER aa_05_account_ai_erasure
  BEFORE UPDATE ON public.orgs_accounterasure
  FOR EACH ROW EXECUTE FUNCTION public.account_ai_consent_erasure_hook();
"""

GUARDS_REVERSE = """
DROP TRIGGER IF EXISTS aa_05_account_ai_erasure ON public.orgs_accounterasure;
DROP FUNCTION IF EXISTS public.account_ai_consent_erasure_hook();
DROP TRIGGER IF EXISTS aa_05_workspace_ai_erasure ON public.orgs_privacyerasure;
DROP FUNCTION IF EXISTS public.workspace_ai_erasure_hook();
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.workspaces_memberaiconsent;
DROP FUNCTION IF EXISTS public.workspace_ai_account_cutoff_guard();
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.workspaces_workspaceaipolicy;
DROP TRIGGER IF EXISTS a_resource_binding ON public.workspaces_memberaiconsent;
DROP TRIGGER IF EXISTS a_resource_binding ON public.workspaces_workspaceaipolicy;
DROP TRIGGER IF EXISTS member_ai_consent_scope ON public.workspaces_memberaiconsent;
DROP TRIGGER IF EXISTS workspace_ai_policy_scope ON public.workspaces_workspaceaipolicy;
DROP FUNCTION IF EXISTS public.workspace_ai_scope_guard();
ALTER TABLE public.workspaces_memberaiconsent
  DROP CONSTRAINT IF EXISTS member_ai_consent_identity_fk,
  DROP CONSTRAINT IF EXISTS member_ai_consent_membership_fk,
  DROP CONSTRAINT IF EXISTS member_ai_consent_workspace_fk,
  DROP CONSTRAINT IF EXISTS member_ai_consent_org_fk;
ALTER TABLE public.workspaces_workspaceaipolicy
  DROP CONSTRAINT IF EXISTS workspace_ai_policy_workspace_fk,
  DROP CONSTRAINT IF EXISTS workspace_ai_policy_org_fk;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("workspaces", "0017_workspacetemplateapplication"),
    ]

    operations = [
        migrations.RunSQL(TIMEOUTS, migrations.RunSQL.noop),
        migrations.AddField(
            model_name="channel",
            name="ai_enabled",
            field=models.BooleanField(default=False),
        ),
        migrations.AddConstraint(
            model_name="channel",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("is_confidential", False),
                    ("ai_enabled", False),
                    _connector="OR",
                ),
                name="channel_confidential_no_ai",
            ),
        ),
        migrations.CreateModel(
            name="WorkspaceAiPolicy",
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
                ("enabled", models.BooleanField(default=False)),
                ("provider", models.TextField(default="mistral")),
                ("provider_region", models.TextField(default="eu")),
                ("eu_sovereign_only", models.BooleanField(default=True)),
                ("self_hosted_endpoint", models.TextField(blank=True, default="")),
                ("model", models.TextField(default="mistral-small-latest")),
                ("sealed_byom_config", models.BinaryField(default=b"")),
                ("monthly_budget_micros", models.BigIntegerField(default=50000000)),
                ("monthly_spent_micros", models.BigIntegerField(default=0)),
                ("budget_period", models.TextField(blank=True, default="")),
                (
                    "organisation",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.organisation",
                    ),
                ),
                (
                    "workspace",
                    models.OneToOneField(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="workspaces.workspace",
                    ),
                ),
            ],
            options={
                "constraints": [
                    models.UniqueConstraint(
                        fields=("organisation",),
                        name="workspace_ai_policy_org_unique",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("provider__in", ["mistral", "self_hosted", "byom"])),
                        name="workspace_ai_policy_provider_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("provider_region__in", ["eu", "non_eu"])),
                        name="workspace_ai_policy_region_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("self_hosted_endpoint__length__lte", 2048)),
                        name="workspace_ai_policy_endpoint_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("model__length__range", (1, 128))),
                        name="workspace_ai_policy_model_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("sealed_byom_config__length__lte", 16384)),
                        name="workspace_ai_policy_sealed_bound",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("monthly_budget_micros__gte", 0)),
                        name="workspace_ai_policy_budget_nonneg",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("monthly_spent_micros__gte", 0)),
                        name="workspace_ai_policy_spent_nonneg",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("budget_period__length__lte", 7)),
                        name="workspace_ai_policy_period_bound",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="MemberAiConsent",
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
                ("enabled", models.BooleanField(default=False)),
                ("consented_at", models.DateTimeField(blank=True, null=True)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                (
                    "identity",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="identity.identity",
                    ),
                ),
                (
                    "membership",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.membership",
                    ),
                ),
                (
                    "organisation",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="orgs.organisation",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.RESTRICT,
                        to="workspaces.workspace",
                    ),
                ),
            ],
            options={
                "indexes": [
                    models.Index(fields=["membership"], name="member_ai_consent_member_idx"),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("workspace", "membership"),
                        name="member_ai_consent_unique",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("enabled", False),
                            ("consented_at__isnull", False),
                            _connector="OR",
                        ),
                        name="member_ai_consent_timestamp_required",
                    ),
                ],
            },
        ),
        migrations.RunSQL(GUARDS_FORWARD, GUARDS_REVERSE),
        migrations.RunSQL(migrations.RunSQL.noop, TIMEOUTS),
    ]
