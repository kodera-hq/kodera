"""Durable operation-key ledger for resumable WorkspaceTemplate v2 execution."""

import django.db.models.deletion
from django.db import migrations, models

import core.db.ids

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

GUARDS_FORWARD = """
ALTER TABLE public.workspaces_workspacetemplateapplication
  ADD CONSTRAINT workspace_template_app_workspace_fk
  FOREIGN KEY (workspace_id) REFERENCES public.workspaces_workspace(id) ON DELETE RESTRICT;

CREATE TRIGGER a_resource_binding
  BEFORE UPDATE ON public.workspaces_workspacetemplateapplication
  FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard(
      'id', 'created_at', 'workspace_id', 'operation_key',
      'template_id', 'template_version', 'spec_fingerprint'
  );

CREATE TRIGGER aa_privacy_cutoff
  BEFORE INSERT OR UPDATE OR DELETE ON public.workspaces_workspacetemplateapplication
  FOR EACH ROW EXECUTE FUNCTION public.workspace_iam_cutoff_guard();

CREATE FUNCTION public.workspace_template_app_erasure_hook() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE org uuid := NEW.organisation_reference;
BEGIN
    IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
        IF NOT public.privacy_erasure_context(org) THEN
            RAISE EXCEPTION 'workspace template application erasure requires worker authority'
                USING ERRCODE = '23514';
        END IF;
        DELETE FROM public.workspaces_workspacetemplateapplication
        WHERE workspace_id IN (
            SELECT id FROM public.workspaces_workspace WHERE organisation_id = org
        );
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workspace_template_app_erasure_hook() FROM PUBLIC;

CREATE TRIGGER aa_04_workspace_template_app_erasure
  BEFORE UPDATE ON public.orgs_privacyerasure
  FOR EACH ROW EXECUTE FUNCTION public.workspace_template_app_erasure_hook();
"""

GUARDS_REVERSE = """
DROP TRIGGER IF EXISTS aa_04_workspace_template_app_erasure ON public.orgs_privacyerasure;
DROP FUNCTION IF EXISTS public.workspace_template_app_erasure_hook();
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON public.workspaces_workspacetemplateapplication;
DROP TRIGGER IF EXISTS a_resource_binding ON public.workspaces_workspacetemplateapplication;
ALTER TABLE public.workspaces_workspacetemplateapplication
  DROP CONSTRAINT IF EXISTS workspace_template_app_workspace_fk;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("workspaces", "0016_upload_tombstone_quota"),
    ]

    operations = [
        migrations.RunSQL(TIMEOUTS, migrations.RunSQL.noop),
        migrations.CreateModel(
            name="WorkspaceTemplateApplication",
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
                ("operation_key", models.TextField()),
                ("template_id", models.TextField()),
                ("template_version", models.IntegerField(default=2)),
                ("spec_fingerprint", models.TextField()),
                (
                    "state",
                    models.TextField(
                        choices=[
                            ("in_progress", "In progress"),
                            ("failed", "Failed"),
                            ("completed", "Completed"),
                        ],
                        default="in_progress",
                    ),
                ),
                ("completed_steps", models.JSONField(default=list)),
                ("artefacts", models.JSONField(default=dict)),
                ("last_error", models.TextField(blank=True, default="")),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
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
                    models.Index(fields=["workspace"], name="workspace_template_app_ws_idx"),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("workspace", "operation_key"),
                        name="workspace_template_app_op_key_unique",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("operation_key__regex", "^[A-Za-z0-9._:-]{1,128}$")),
                        name="workspace_template_app_op_key_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("spec_fingerprint__regex", "^[a-f0-9]{64}$")),
                        name="workspace_template_app_fingerprint_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("state__in", ["in_progress", "failed", "completed"])),
                        name="workspace_template_app_state_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("template_version__gte", 1)),
                        name="workspace_template_app_version_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            (
                                "last_error__in",
                                [
                                    "",
                                    "structure_failed",
                                    "matrix_projection_failed",
                                    "collections_failed",
                                    "starter_docs_failed",
                                    "collab_engine_unavailable",
                                    "internal_step_failed",
                                ],
                            )
                        ),
                        name="workspace_template_app_error_code_valid",
                    ),
                ],
            },
        ),
        migrations.RunSQL(GUARDS_FORWARD, GUARDS_REVERSE),
        migrations.RunSQL(migrations.RunSQL.noop, TIMEOUTS),
    ]
