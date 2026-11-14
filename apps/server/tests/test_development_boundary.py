"""Read the effective development configuration, not comments promising isolation."""

import copy
import importlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from dev.image_context import image_files, image_tree

ROOT = Path(__file__).resolve().parents[1]


def resolved_compose():
    docker = shutil.which("docker")
    if docker is None:
        raise RuntimeError("Docker Compose CLI is required for boundary acceptance")
    # Compose config is read-only and does not contact the Docker daemon.
    result = subprocess.run(  # noqa: S603
        [
            docker,
            "compose",
            "-f",
            str(ROOT / "compose.yaml"),
            "--profile",
            "app",
            "--profile",
            "worker",
            "config",
            "--format",
            "json",
            "--no-env-resolution",
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=15,
    )
    return json.loads(result.stdout)


def assert_mount_boundary(services):
    assert not services["api"].get("volumes"), "API must not mount host files"
    for mount in services["worker"].get("volumes", []):
        assert mount["source"] == str(ROOT / "dev/fakebin")
        assert mount["target"] == "/fakebin" and mount["read_only"]
    for name in ("api", "worker"):
        for mount in services[name].get("volumes", []):
            assert mount.get("source") != str(ROOT), f"{name} mounts the entire repository"
            assert mount.get("source") != "/var/run/docker.sock", f"{name} mounts Docker socket"
        assert not services[name].get("privileged", False)
        assert services[name]["read_only"]
        assert services[name]["cap_drop"] == ["ALL"]
        assert "no-new-privileges:true" in services[name]["security_opt"]


def assert_no_bulk_environment(services):
    for name in ("api", "worker"):
        assert not services[name].get("env_file"), (
            "bulk application environment files are forbidden"
        )


def test_worker_has_no_bulk_environment_file():
    # Compose omits nonexistent optional env_file entries from resolved output.
    # Inspect declarations too, without opening any declared environment file.
    declaration = yaml.safe_load((ROOT / "compose.yaml").read_text())
    assert not declaration.get("include"), "application config must be declared locally"
    for name in ("api", "worker"):
        assert not declaration["services"][name].get("extends"), (
            "application config must be declared locally"
        )
    assert_no_bulk_environment(declaration["services"])
    assert_no_bulk_environment(resolved_compose()["services"])


def assert_image_boundary(ignore):
    assert "**" in ignore, "image build context must default to excluding inputs"
    assert "!config/settings/*.py" in ignore
    included = ignore.index("!config/settings/*.py")
    for name in (
        "test.py",
        "e2e.py",
        "e2e_operator.py",
        "job_queue.py",
        "deploy_operator.py",
        "deploy_worker.py",
    ):
        assert "config/settings/" + name in ignore[included + 1 :], (
            "the image carries "
            + name
            + ", a test/operator settings profile that permits the job-queue mutant flags"
        )
    permitted = {
        "!Dockerfile",
        "!pyproject.toml",
        "!uv.lock",
        "!manage.py",
        "!config/*.py",
        "!config/settings/*.py",
        "!core/__init__.py",
        "!core/health.py",
        "!core/api/__init__.py",
        "!core/api/scopes.py",
        "!core/api/problems.py",
        "!core/api/lanes.py",
        "!core/api/edge.py",
        "!core/api/edition.py",
        "!core/api/errors.py",
        "!core/db/__init__.py",
        "!core/db/ids.py",
        "!core/db/models.py",
        "!core/db/functions.py",
        "!core/db/api_writer_role.py",
        "!core/db/api_database_boundary.py",
        "!core/db/role_acl.py",
        "!core/sealing.py",
        "!core/logs.py",
        "!core/faults.py",
        "!core/links.py",
        "!core/api/guarded_replay.py",
        "!core/api/idempotency.py",
        "!core/idempotency/__init__.py",
        "!core/idempotency/apps.py",
        "!core/idempotency/fingerprint.py",
        "!core/idempotency/models.py",
        "!core/idempotency/store.py",
        "!services/__init__.py",
        "!services/identity/__init__.py",
        "!services/identity/access_tokens.py",
        "!services/identity/trusted_issuers.py",
        "!services/identity/discovery_input.py",
        "!services/identity/discovery_policy.py",
        "!services/workspace_policy/__init__.py",
        "!services/workspace_policy/projection.py",
        "!apps/__init__.py",
        "!apps/identity/__init__.py",
        "!apps/identity/apps.py",
        "!apps/identity/models.py",
        "!apps/identity/selectors.py",
        "!apps/identity/services.py",
        "!apps/identity/api/__init__.py",
        "!apps/identity/api/permissions.py",
        "!apps/identity/api/serializers.py",
        "!apps/identity/api/views.py",
        "!apps/identity/api/discovery.py",
        "!apps/identity/api/discovery_permissions.py",
        "!apps/identity/discovery.py",
        "!apps/identity/discovery_db.py",
        "!apps/identity/discovery_quotas.py",
        "!apps/identity/staff.py",
        "!apps/identity/staff_roles.py",
        "!apps/orgs/community.py",
        "!apps/support/api/community.py",
        "!apps/support/community.py",
        "!apps/support/triage.py",
        "!apps/identity/community.py",
        "!apps/tenancy/community.py",
        "!apps/workspaces/community.py",
        "!apps/orgs/__init__.py",
        "!apps/orgs/apps.py",
        "!apps/orgs/models.py",
        "!apps/orgs/privacy_models.py",
        "!apps/orgs/selectors.py",
        "!apps/orgs/detail_selectors.py",
        "!apps/orgs/detail_services.py",
        "!apps/orgs/discovery_selectors.py",
        "!apps/orgs/api/__init__.py",
        "!apps/orgs/api/detail.py",
        "!apps/orgs/api/detail_permissions.py",
        "!apps/orgs/api/detail_serializers.py",
        "!apps/orgs/membership_selectors.py",
        "!apps/orgs/membership_services.py",
        "!apps/orgs/membership_pagination.py",
        "!apps/orgs/api/memberships.py",
        "!apps/orgs/api/membership_permissions.py",
        "!apps/orgs/api/membership_serializers.py",
        "!apps/orgs/membership_lifecycle.py",
        "!apps/orgs/member_set_hooks.py",
        "!apps/outbox/__init__.py",
        "!apps/outbox/realm_enqueue.py",
        "!apps/orgs/api/membership_detail.py",
        "!apps/orgs/invitations.py",
        "!apps/orgs/api/invitations.py",
        "!apps/orgs/api/invitation_permissions.py",
        "!apps/identity/invited.py",
        "!apps/orgs/notice_contacts.py",
        "!apps/orgs/api/notice_contacts.py",
        "!apps/orgs/api/notice_contact_permissions.py",
        "!apps/orgs/intake_services.py",
        "!apps/orgs/api/intake.py",
        "!apps/orgs/api/intake_permissions.py",
        "!apps/orgs/api/intake_serializers.py",
        "!apps/jobs/__init__.py",
        "!apps/jobs/_enqueue.py",
        "!apps/jobs/apps.py",
        "!apps/jobs/keys.py",
        "!apps/jobs/kinds.py",
        "!apps/jobs/locks.py",
        "!apps/jobs/models.py",
        "!apps/jobs/mutants.py",
        "!apps/jobs/selectors.py",
        "!apps/jobs/transactions.py",
        "!apps/orgs/actor_selectors.py",
        "!apps/orgs/bootstrap_selectors.py",
        "!apps/orgs/bootstrap_services.py",
        "!apps/orgs/claim_readiness.py",
        "!apps/orgs/api/bootstrap.py",
        "!apps/orgs/api/bootstrap_permissions.py",
        "!apps/orgs/api/bootstrap_serializers.py",
        "!apps/orgs/claim_consumption.py",
        "!apps/orgs/claim_tokens.py",
        "!apps/orgs/api/owner_claims.py",
        "!apps/orgs/api/owner_claim_permissions.py",
        "!apps/orgs/api/owner_claim_serializers.py",
        "!apps/jobs/types.py",
        "!apps/audit/__init__.py",
        "!apps/audit/apps.py",
        "!apps/audit/models.py",
        "!apps/audit/selectors.py",
        "!apps/audit/services.py",
        "!apps/workspaces/__init__.py",
        "!apps/workspaces/apps.py",
        "!apps/workspaces/models.py",
        "!apps/workspaces/services.py",
        "!apps/workspaces/quotas.py",
        "!apps/workspaces/quota_http.py",
        "!apps/workspaces/api/quotas.py",
        "!apps/workspaces/setup.py",
        "!apps/workspaces/structure.py",
        "!apps/workspaces/initialise.py",
        "!apps/workspaces/instant_claim.py",
        "!apps/workspaces/warm_pool.py",
        "!apps/workspaces/templates.py",
        "!apps/workspaces/administration.py",
        "!apps/workspaces/channel_access.py",
        "!apps/workspaces/channel_sets.py",
        "!apps/workspaces/api/__init__.py",
        "!apps/workspaces/api/permissions.py",
        "!apps/workspaces/api/serializers.py",
        "!apps/workspaces/api/views.py",
        "!apps/workspaces/api/instant_claim.py",
        "!apps/workspaces/api/administration.py",
        "!apps/workspaces/api/responses.py",
        "!tenant_agent/__init__.py",
        "!tenant_agent/__main__.py",
        "!tenant_agent/agent.py",
        "!tenant_agent/channels.py",
        "!tenant_agent/config.py",
        "!tenant_agent/core_api.py",
        "!tenant_agent/docker_exec.py",
        "!tenant_agent/engines.py",
        "!tenant_agent/federation.py",
        "!tenant_agent/guard.py",
        "!tenant_agent/handlers.py",
        "!tenant_agent/state.py",
        "!tenant_agent/synapse.py",
        "!tenant_agent/webhook.py",
        "!room_access/__init__.py",
        "!room_access/__main__.py",
        "!room_access/clients.py",
        "!room_access/config.py",
        "!room_access/rooms.py",
        "!room_access/server.py",
        "!room_access/service.py",
        "!apps/billing/__init__.py",
        "!apps/billing/apps.py",
        "!apps/billing/callers.py",
        "!apps/billing/actors.py",
        "!apps/billing/configuration.py",
        "!apps/billing/events.py",
        "!apps/billing/models.py",
        "!apps/billing/api/downloads.py",
        "!apps/billing/api/vat_status.py",
        "!apps/billing/artifacts.py",
        "!apps/billing/documents.py",
        "!apps/billing/downloads.py",
        "!apps/billing/integrity.py",
        "!apps/billing/vies.py",
        "!apps/billing/money.py",
        "!apps/billing/states.py",
        "!apps/billing/vat.py",
        "!apps/billing/services.py",
        "!apps/billing/selectors.py",
        "!apps/billing/access.py",
        "!apps/billing/pagination.py",
        "!apps/billing/representations.py",
        "!apps/billing/tenant_reads.py",
        "!apps/billing/switch.py",
        "!apps/billing/unbilled.py",
        "!apps/billing/api/__init__.py",
        "!apps/billing/api/permissions.py",
        "!apps/billing/api/views.py",
        "!apps/billing/api/tenants.py",
        "!apps/billing/api/create_tenant.py",
        "!apps/legal/__init__.py",
        "!apps/legal/apps.py",
        "!apps/legal/models.py",
        "!apps/legal/services.py",
        "!apps/legal/api/__init__.py",
        "!apps/legal/api/permissions.py",
        "!apps/legal/api/views.py",
        "!apps/tenancy/__init__.py",
        "!apps/tenancy/apps.py",
        "!apps/tenancy/models.py",
        "!apps/tenancy/services.py",
        "!apps/tenancy/selectors.py",
        "!apps/billing/api/order_request.py",
        "!apps/billing/payments/__init__.py",
        "!apps/billing/payments/port.py",
        "!apps/billing/payments/fake.py",
        "!apps/billing/payments/stripe.py",
        "!apps/billing/payments/services.py",
        "!apps/billing/slug_availability.py",
        "!apps/billing/api/slug_availability.py",
        "!apps/billing/api/membership_count.py",
        "!apps/billing/membership_count.py",
        "!apps/billing/api/help_context.py",
        "!apps/engine_intents/__init__.py",
        "!apps/engine_intents/apps.py",
        "!apps/engine_intents/models.py",
        "!apps/engine_intents/services.py",
        "!apps/engine_intents/selectors.py",
        "!apps/engine_intents/channel_sets.py",
        "!apps/engine_intents/channel_hooks.py",
        "!apps/engine_intents/api/__init__.py",
        "!apps/engine_intents/api/permissions.py",
        "!apps/engine_intents/api/views.py",
        "!apps/support/__init__.py",
        "!apps/support/apps.py",
        "!apps/support/models.py",
        "!apps/support/tickets.py",
        "!apps/support/api/__init__.py",
        "!apps/support/api/permissions.py",
        "!apps/support/api/views.py",
        "!apps/orgs/workspace_members.py",
        "!apps/workspaces/moderation.py",
        "!apps/workspaces/moderation_policy.py",
        "!apps/workspaces/moderation_wire.py",
        "!apps/workspaces/api/moderation.py",
        "!apps/workspaces/api/moderation_urls.py",
        "!apps/media/__init__.py",
        "!apps/media/apps.py",
        "!apps/media/models.py",
        "!apps/media/context.py",
        "!apps/media/outbound.py",
        "!apps/media/unfurl.py",
        "!apps/media/storage.py",
        "!apps/media/storage_gateway.py",
        "!apps/media/storage_protocol.py",
        "!apps/media/services.py",
        "!apps/media/api/__init__.py",
        "!apps/media/api/http.py",
        "!apps/media/api/responses.py",
        "!apps/media/api/urls.py",
        "!apps/media/api/views.py",
        "!apps/notifications/__init__.py",
        "!apps/notifications/apps.py",
        "!apps/notifications/models.py",
        "!apps/notifications/push.py",
        "!apps/notifications/services.py",
        "!apps/notifications/api/__init__.py",
        "!apps/notifications/api/http.py",
        "!apps/notifications/api/responses.py",
        "!apps/notifications/api/urls.py",
        "!apps/notifications/api/views.py",
        "!apps/extensions/__init__.py",
        "!apps/extensions/apps.py",
        "!apps/extensions/models.py",
        "!apps/extensions/expiry.py",
        "!apps/docs/__init__.py",
        "!apps/docs/apps.py",
        "!apps/docs/access.py",
        "!apps/docs/configuration.py",
        "!apps/docs/engine.py",
        "!apps/docs/errors.py",
        "!apps/docs/models.py",
        "!apps/docs/collection_schema.py",
        "!apps/docs/collections.py",
        "!apps/docs/api/collections.py",
        "!apps/docs/services.py",
        "!apps/docs/templates.py",
        "!apps/docs/tickets.py",
        "!apps/docs/tree.py",
        "!apps/docs/api/__init__.py",
        "!apps/docs/api/http.py",
        "!apps/docs/api/responses.py",
        "!apps/docs/api/urls.py",
        "!apps/docs/api/views.py",
    }
    assert {line for line in ignore if line.startswith("!")} == permitted, (
        "build inputs differ from the exact runtime allowlist"
    )


def test_environments_and_published_ports_are_explicit():
    services = resolved_compose()["services"]
    assert set(services["api"]["environment"]) == {
        "DATABASE_URL",
        "DJANGO_SETTINGS_MODULE",
        "DJANGO_DEBUG",
        "DJANGO_ALLOWED_HOSTS",
        "DJANGO_SECRET_KEY",
    }
    assert set(services["worker"]["environment"]) == {
        "DATABASE_URL",
        "DJANGO_SETTINGS_MODULE",
        "FAKE_TOFU_FAIL",
        "FAKE_BIN_LOG",
        "PATH",
    }
    assert not services["api"].get("env_file")
    # The worker's one network is internal and holds the database alone (tests/worker, WK-07).
    assert "network_mode" not in services["worker"]
    assert set(services["worker"]["networks"]) == {"worker-db"}
    assert not services["worker"].get("ports")
    assert services["worker"]["profiles"] == ["worker"]
    for service in services.values():
        for port in service.get("ports", []):
            assert port["host_ip"] == "127.0.0.1"


def test_application_has_no_repository_bind():
    assert_mount_boundary(resolved_compose()["services"])


def test_image_build_context_is_allowlisted():
    assert_image_boundary((ROOT / ".dockerignore").read_text().splitlines())


def test_mount_guard_refuses_a_restored_repository_bind():
    services = copy.deepcopy(resolved_compose()["services"])
    services["api"]["volumes"] = [{"type": "bind", "source": str(ROOT), "target": "/app"}]
    with pytest.raises(AssertionError, match="API must not mount host files"):
        assert_mount_boundary(services)


@pytest.mark.parametrize(
    "exception",
    [
        "!**",
        "!.env",
        "!.git",
        "!worker/**",
        "!core/",
        "!config/",
        "!apps/**",
        "!services/**",
        "!apps/identity/migrations/*.py",
    ],
)
def test_image_guard_refuses_widened_input_exceptions(exception):
    ignore = (ROOT / ".dockerignore").read_text().splitlines() + [exception]
    with pytest.raises(
        AssertionError, match="build inputs differ from the exact runtime allowlist"
    ):
        assert_image_boundary(ignore)


if __name__ == "__main__":
    test_application_has_no_repository_bind()
    test_worker_has_no_bulk_environment_file()
    test_image_build_context_is_allowlisted()
    test_environments_and_published_ports_are_explicit()


@pytest.mark.parametrize("service", ["api", "worker"])
def test_environment_guard_refuses_bulk_files(service):
    services = {"api": {}, "worker": {}}
    services[service]["env_file"] = ["synthetic.env"]
    with pytest.raises(AssertionError, match="bulk application environment files are forbidden"):
        assert_no_bulk_environment(services)


def test_image_guard_refuses_the_test_profile_in_the_image():
    ignore = (ROOT / ".dockerignore").read_text().splitlines()
    ignore.remove("config/settings/test.py")
    with pytest.raises(AssertionError, match="permits the job-queue mutant flags"):
        assert_image_boundary(ignore)


def test_api_image_excludes_deployed_operator_profile_and_detects_restoration():
    profile = "config/settings/deploy_operator.py"
    assert (ROOT / profile).is_file(), "deployed operator profile missing"
    assert profile not in image_files(ROOT), "API image carries the deployed operator profile"
    rules = (ROOT / ".dockerignore").read_text().splitlines()
    rules.remove(profile)
    with pytest.raises(AssertionError, match="image carries deploy_operator.py"):
        assert_image_boundary(rules)


@pytest.mark.parametrize(
    "path", ["services/identity/access_tokens.py", "apps/extensions/expiry.py"]
)
def test_image_guard_refuses_missing_customer_runtime_source(path):
    ignore = (ROOT / ".dockerignore").read_text().splitlines()
    ignore.remove("!" + path)
    with pytest.raises(
        AssertionError, match="build inputs differ from the exact runtime allowlist"
    ):
        assert_image_boundary(ignore)


# -------------------------------------------------------------- what the image can start ----
# The image carries exactly what .dockerignore admits into the build context and the Dockerfile's
# runtime stage copies. A settings module the image is started with must need nothing else: a
# profile that installs an application package the allowlist does not admit stops the image at
# start-up, and no CI job builds or starts the image. These tests need no Docker: they copy the
# image's files and start each profile on them alone.

# The profiles the image is started with: the default of manage.py, config/wsgi.py and the compose
# `api` service, and the one the customer HTTP qualification selects, config.settings.e2e; and the
# deployable profile that one builds on, config.settings.customer_http.
IMAGE_SETTINGS = (
    "config.settings.customer_http",
    "config.settings.dev",
    "config.settings.e2e",
    "config.settings.deploy",
)
SETTINGS_DEFAULT = re.compile(r'setdefault\("DJANGO_SETTINGS_MODULE", "([a-z_.]+)"\)')

IMAGE_START = """
import json

try:
    import django

    django.setup()
    from django.urls import get_resolver

    get_resolver().url_patterns
    for status in (404, 500):
        assert callable(get_resolver().resolve_error_handler(status))
    import config.wsgi
except Exception as error:
    print(json.dumps({"started": False, "error": f"{type(error).__name__}: {error}"}))
else:
    print(json.dumps({"started": True}))
"""


OPERATOR_MODULES = (
    "apps/audit/privacy_events.py",
    "apps/identity/privacy_selectors.py",
    "apps/docs/privacy_selectors.py",
    "apps/billing/privacy_selectors.py",
    "apps/workspaces/privacy_selectors.py",
    "apps/billing/statutory.py",
    "apps/billing/management/commands/manage_statutory_retention.py",
    "apps/orgs/account_erasure_services.py",
    "apps/orgs/erasure_services.py",
    "apps/orgs/private_export_erasure.py",
    "apps/orgs/privacy_archives.py",
    "apps/orgs/privacy_core_sources.py",
    "apps/orgs/privacy_runtime.py",
    "apps/orgs/privacy_services.py",
    "apps/orgs/privacy_sources.py",
    "apps/orgs/privacy_storage.py",
    "apps/orgs/management/commands/erase_core_workspace.py",
    "apps/workspaces/quota_policy.py",
    "apps/workspaces/management/commands/configure_workspace_quotas.py",
    "apps/identity/command_principal.py",
    "apps/orgs/realm_bootstrap.py",
    "apps/orgs/realm_readiness.py",
    "apps/orgs/management/operator.py",
    "apps/orgs/management/commands/start_realm_bootstrap.py",
    "apps/orgs/management/commands/complete_realm_bootstrap.py",
    "apps/orgs/management/commands/requeue_realm_bootstrap.py",
    "apps/jobs/management/commands/sweep_jobs.py",
    "apps/tenancy/operator_status.py",
    "apps/tenancy/management/commands/tenant_status.py",
)


def assert_operator_modules_excluded(files):
    assert set(OPERATOR_MODULES).isdisjoint(files), (
        "the API image must exclude the pilot's operator modules and staff constructor"
    )


def test_operator_modules_are_absent_from_the_effective_api_image():
    assert all((ROOT / path).is_file() for path in OPERATOR_MODULES)
    assert_operator_modules_excluded(image_files(ROOT))


@pytest.mark.parametrize("module", OPERATOR_MODULES)
def test_operator_image_boundary_refuses_each_restored_operator_module(tmp_path, module):
    (tmp_path / "Dockerfile").write_text((ROOT / "Dockerfile").read_text())
    (tmp_path / ".dockerignore").write_text((ROOT / ".dockerignore").read_text() + f"\n!{module}\n")
    restored = tmp_path / module
    restored.parent.mkdir(parents=True)
    restored.write_text("# Synthetic operator module fixture.\n")
    with pytest.raises(AssertionError, match="API image must exclude the pilot's operator"):
        assert_operator_modules_excluded(image_files(tmp_path))


def qualification_overlay(tree):
    """The legacy local provider profile is an explicit test-only overlay, never image input."""
    assert not (tree / "config/settings/e2e.py").exists()
    shutil.copy2(ROOT / "config/settings/e2e.py", tree / "config/settings/e2e.py")


def image_start_refusals(tree, modules=IMAGE_SETTINGS):
    """Why a settings module the image is started with does not start on the files in `tree`
    alone — Django set up, the URL configuration resolved, the WSGI application built — or []."""
    refusals = []
    for module in modules:
        result = subprocess.run(  # noqa: S603 - a fixed interpreter and script
            [sys.executable, "-c", IMAGE_START],
            cwd=tree,
            env={
                "PATH": os.environ.get("PATH", ""),
                "PYTHONPATH": str(tree),
                "PYTHONDONTWRITEBYTECODE": "1",
                "DJANGO_SETTINGS_MODULE": module,
                **(
                    {
                        "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
                        "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
                        "DATABASE_URL": "postgresql://synthetic:synthetic-pass@db/kodera_server",
                    }
                    if module == "config.settings.deploy"
                    else {}
                ),
            },
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        lines = result.stdout.strip().splitlines()
        if result.returncode != 0 or not lines:
            raise AssertionError(f"{module} could not be started: {result.stderr[-2000:]}")
        report = json.loads(lines[-1])
        if not report["started"]:
            refusals.append(
                f"{module} does not start from the files the image carries: {report['error']}"
            )
    return refusals


def test_the_image_carries_what_the_settings_it_starts_need(tmp_path):
    files = image_tree(ROOT, tmp_path)
    assert "config/settings/e2e.py" not in files
    assert "config/settings/job_queue.py" not in files
    qualification_overlay(tmp_path)
    for module in set(IMAGE_SETTINGS) - {"config.settings.e2e"}:
        assert module.replace(".", "/") + ".py" in files, "the image's files were not copied"
    assert not (tmp_path / "tests").exists(), "the copy holds more than the image carries"
    assert not (tmp_path / "config/settings/test.py").exists(), "the image carries the test profile"
    assert image_start_refusals(tmp_path) == [], (
        "a settings module the image starts needs a file the image does not carry"
    )


def test_the_image_start_check_fails_a_profile_that_installs_an_app_the_image_lacks(tmp_path):
    image_tree(ROOT, tmp_path)
    qualification_overlay(tmp_path)
    profile = tmp_path / "config/settings/persistence.py"
    text = profile.read_text()
    assert text.count('"apps.orgs"') == 1, "the mutation no longer finds the line it changes"
    # The image carries one module of the outbox, the realm access enqueue; the outbox's worker
    # side, its realm package among it, is installed by no profile the image starts and not carried.
    profile.write_text(text.replace('"apps.orgs"', '"apps.orgs", "apps.outbox.realm"'))
    assert image_start_refusals(tmp_path) == [
        "config.settings.customer_http does not start from the files the image carries: "
        "ModuleNotFoundError: No module named 'apps.outbox.realm'",
        "config.settings.e2e does not start from the files the image carries: "
        "ModuleNotFoundError: No module named 'apps.outbox.realm'",
    ], "the image start check passed a profile that installs an app the image does not carry"


def test_the_image_start_check_fails_a_route_whose_module_the_image_lacks(tmp_path):
    image_tree(ROOT, tmp_path)
    qualification_overlay(tmp_path)
    (tmp_path / "apps/identity/api/views.py").unlink()
    assert image_start_refusals(tmp_path) == [
        "config.settings.customer_http does not start from the files the image carries: "
        "ModuleNotFoundError: No module named 'apps.identity.api.views'",
        "config.settings.e2e does not start from the files the image carries: "
        "ModuleNotFoundError: No module named 'apps.identity.api.views'",
        "config.settings.deploy does not start from the files the image carries: "
        "ModuleNotFoundError: No module named 'apps.identity.api.views'",
    ], "the image start check passed a URL configuration whose view module is missing"


def test_the_image_start_check_covers_every_profile_the_image_is_started_with():
    compose = yaml.safe_load((ROOT / "compose.yaml").read_text())
    controller = importlib.import_module("dev.accept_customer_http")
    defaults = [
        SETTINGS_DEFAULT.search((ROOT / entry).read_text())
        for entry in ("manage.py", "config/wsgi.py")
    ]
    assert all(defaults), "an entry point no longer names its default settings module"
    started = {
        compose["services"]["api"]["environment"]["DJANGO_SETTINGS_MODULE"],
        controller.api_environment("synthetic-reader-only", "[]")["DJANGO_SETTINGS_MODULE"],
        *(found.group(1) for found in defaults),
    }
    assert started | {"config.settings.customer_http", "config.settings.deploy"} == set(
        IMAGE_SETTINGS
    ), "the image is started with a settings module the image start check does not start"


@pytest.mark.parametrize(
    "path",
    [
        "apps/orgs/membership_selectors.py",
        "apps/orgs/membership_services.py",
        "apps/orgs/membership_pagination.py",
        "apps/orgs/api/memberships.py",
        "apps/orgs/api/membership_permissions.py",
        "apps/orgs/api/membership_serializers.py",
        "apps/orgs/membership_lifecycle.py",
        "apps/orgs/member_set_hooks.py",
        "apps/outbox/realm_enqueue.py",
        "apps/orgs/api/membership_detail.py",
        "apps/orgs/notice_contacts.py",
        "apps/orgs/api/notice_contacts.py",
        "apps/orgs/api/notice_contact_permissions.py",
    ],
)
def test_image_guard_refuses_missing_directory_source(path):
    ignore = (ROOT / ".dockerignore").read_text().splitlines()
    ignore.remove("!" + path)
    with pytest.raises(
        AssertionError, match="build inputs differ from the exact runtime allowlist"
    ):
        assert_image_boundary(ignore)


@pytest.mark.parametrize(
    "path",
    [
        "core/api/errors.py",
        "apps/workspaces/instant_claim.py",
        "apps/workspaces/warm_pool.py",
        "apps/workspaces/templates.py",
        "apps/workspaces/api/instant_claim.py",
    ],
)
def test_image_guard_refuses_missing_error_or_instant_claim_source(path):
    assert path in image_files(ROOT), "the API image omits a served runtime module"
    ignore = (ROOT / ".dockerignore").read_text().splitlines()
    ignore.remove("!" + path)
    with pytest.raises(
        AssertionError, match="build inputs differ from the exact runtime allowlist"
    ):
        assert_image_boundary(ignore)


BOOTSTRAP_RUNTIME_MODULES = (
    "apps/orgs/bootstrap_selectors.py",
    "apps/orgs/bootstrap_services.py",
    "apps/orgs/claim_readiness.py",
    "apps/orgs/api/bootstrap.py",
    "apps/orgs/api/bootstrap_permissions.py",
    "apps/orgs/api/bootstrap_serializers.py",
)

BOOTSTRAP_PRIVATE_MODULES = (
    "apps/identity/owner_binding.py",
    "apps/orgs/owner_claims.py",
    "apps/orgs/claim_configuration.py",
    "apps/orgs/claim_contact.py",
    "apps/orgs/claim_delivery.py",
    "apps/orgs/claim_confirmation.py",
    "apps/orgs/management/commands/bind_intended_owner.py",
    "apps/orgs/management/commands/revoke_owner_claim.py",
    "apps/orgs/management/commands/reissue_owner_claim.py",
    "apps/orgs/management/commands/decide_claim_delivery.py",
    "apps/orgs/management/commands/confirm_owner_contact.py",
    "apps/outbox/sender.py",
)


def assert_bootstrap_private_sources_excluded(files):
    assert set(BOOTSTRAP_PRIVATE_MODULES).isdisjoint(files), (
        "the API image must exclude owner-claim operator, contact and delivery sources"
    )


@pytest.mark.parametrize("path", BOOTSTRAP_RUNTIME_MODULES)
def test_bootstrap_served_source_is_in_the_effective_image(path):
    assert (ROOT / path).is_file(), "the served bootstrap source does not exist"
    assert path in image_files(ROOT), "the effective image omits served bootstrap source"


@pytest.mark.parametrize("path", BOOTSTRAP_RUNTIME_MODULES)
def test_bootstrap_image_guard_refuses_each_missing_served_source(path):
    ignore = (ROOT / ".dockerignore").read_text().splitlines()
    ignore.remove("!" + path)
    with pytest.raises(
        AssertionError, match="build inputs differ from the exact runtime allowlist"
    ):
        assert_image_boundary(ignore)


def test_bootstrap_private_sources_are_absent_from_the_effective_image():
    assert_bootstrap_private_sources_excluded(image_files(ROOT))


@pytest.mark.parametrize("path", BOOTSTRAP_PRIVATE_MODULES)
def test_bootstrap_image_guard_refuses_each_restored_private_source(tmp_path, path):
    (tmp_path / "Dockerfile").write_text((ROOT / "Dockerfile").read_text())
    (tmp_path / ".dockerignore").write_text((ROOT / ".dockerignore").read_text() + f"\n!{path}\n")
    restored = tmp_path / path
    restored.parent.mkdir(parents=True)
    restored.write_text("# Synthetic excluded bootstrap source fixture.\n")
    with pytest.raises(AssertionError, match="API image must exclude owner-claim operator"):
        assert_bootstrap_private_sources_excluded(image_files(tmp_path))


def test_bootstrap_image_guard_refuses_fixture_build_input():
    ignore = (ROOT / ".dockerignore").read_text().splitlines()
    ignore.append("!tests/owner_claim_fixtures.py")
    with pytest.raises(
        AssertionError, match="build inputs differ from the exact runtime allowlist"
    ):
        assert_image_boundary(ignore)


def test_bootstrap_image_guard_refuses_restored_identity_creator(tmp_path):
    path = "apps/identity/owner_binding.py"
    assert path not in image_files(ROOT), "the API image carries the excluded identity creator"
    (tmp_path / "Dockerfile").write_text((ROOT / "Dockerfile").read_text())
    (tmp_path / ".dockerignore").write_text((ROOT / ".dockerignore").read_text() + f"\n!{path}\n")
    restored = tmp_path / path
    restored.parent.mkdir(parents=True)
    restored.write_text("# Synthetic excluded identity creator fixture.\n")
    with pytest.raises(AssertionError, match="API image must exclude owner-claim operator"):
        assert_bootstrap_private_sources_excluded(image_files(tmp_path))


CONSUMPTION_RUNTIME_MODULES = (
    "apps/orgs/claim_consumption.py",
    "apps/orgs/claim_tokens.py",
    "apps/orgs/api/owner_claims.py",
    "apps/orgs/api/owner_claim_permissions.py",
    "apps/orgs/api/owner_claim_serializers.py",
)


@pytest.mark.parametrize("path", CONSUMPTION_RUNTIME_MODULES)
def test_consumption_served_source_is_in_the_effective_image(path):
    assert (ROOT / path).is_file(), "the served consumption source does not exist"
    assert path in image_files(ROOT), "the effective image omits served consumption source"


def test_bootstrap_image_boundary_admits_pure_token_primitives(tmp_path):
    controller = importlib.import_module("dev.accept_bootstrap_http")
    path = tmp_path / "apps/orgs/claim_tokens.py"
    path.parent.mkdir(parents=True)
    shutil.copy2(ROOT / "apps/orgs/claim_tokens.py", path)
    # The image carries the realm access enqueue as its whole outbox (MEMBERSHIP_LIFECYCLE.md §6.1.1).
    (tmp_path / "apps/outbox").mkdir()
    for name in ("__init__.py", "realm_enqueue.py"):
        shutil.copy2(ROOT / "apps/outbox" / name, tmp_path / "apps/outbox" / name)
    controller.image_source_boundary(tmp_path)


@pytest.mark.parametrize("path", BOOTSTRAP_PRIVATE_MODULES)
def test_bootstrap_controller_refuses_restored_private_sources(tmp_path, path):
    controller = importlib.import_module("dev.accept_bootstrap_http")
    restored = tmp_path / path
    restored.parent.mkdir(parents=True, exist_ok=True)
    restored.write_text("# Synthetic forbidden source restoration.\n")
    with pytest.raises(AssertionError, match="bootstrap image source boundary refused"):
        controller.image_source_boundary(tmp_path)


@pytest.mark.parametrize("path", CONSUMPTION_RUNTIME_MODULES)
def test_consumption_image_guard_refuses_each_missing_served_source(path):
    ignore = (ROOT / ".dockerignore").read_text().splitlines()
    ignore.remove("!" + path)
    with pytest.raises(
        AssertionError, match="build inputs differ from the exact runtime allowlist"
    ):
        assert_image_boundary(ignore)


@pytest.mark.parametrize(
    "module",
    (
        "apps.identity.owner_binding",
        "apps.orgs.owner_claims",
        "apps.orgs.claim_contact",
        "apps.orgs.claim_configuration",
        "apps.orgs.claim_delivery",
        "apps.orgs.claim_confirmation",
    ),
)
def test_consumption_token_import_refuses_excluded_orchestration(tmp_path, module):
    image_tree(ROOT, tmp_path)
    qualification_overlay(tmp_path)
    pure = tmp_path / "apps/orgs/claim_tokens.py"
    pure.write_text(pure.read_text() + "\nimport " + module + "\n")
    refusals = image_start_refusals(tmp_path)
    assert len(refusals) == 3, "a profile bypassed the excluded token import"
    assert all(
        "ModuleNotFoundError: No module named '" + module + "'" in refusal for refusal in refusals
    ), "the mutation did not reach the actual token import"


# ------------------------------- the image qualifications agree with the image allowlist ----
# The three actual-image qualifications (production, bootstrap, consume) probe the running image
# for paths it must not carry. Each probe is checked here against the files the allowlist admits,
# so an allowlist change that a probe forbids fails here, without Docker, and not only in CI.

PRODUCTION_ABSENT = re.compile(r"assert not pathlib\.Path\('/app/([^']+)'\)\.exists\(\)")


def test_the_production_image_probe_forbids_nothing_the_image_carries(tmp_path):
    files = image_tree(ROOT, tmp_path)
    absent = PRODUCTION_ABSENT.findall((ROOT / "dev/accept_production_http.py").read_text())
    assert absent, "the production probe's absence checks were not found"
    carried = [
        path
        for path in absent
        if (tmp_path / path).exists() or any(f.startswith(path + "/") for f in files)
    ]
    assert carried == [], f"the production probe forbids paths the image carries: {carried}"
    # The image's outbox is exactly the realm access enqueue: the probe asserts its whole listing,
    # so an unlisted file (apps.py, a future module) fails it, and that listing is the image's.
    exact = re.search(
        r"OUTBOX_IN_IMAGE = (\[[^\]]*\])", (ROOT / "dev/accept_production_http.py").read_text()
    )
    assert exact, "the production probe does not assert the outbox's exact contents"
    import ast

    listed = sorted(ast.literal_eval(exact.group(1)))
    assert listed == ["__init__.py", "realm_enqueue.py"]
    assert sorted(p.name for p in (tmp_path / "apps/outbox").iterdir()) == listed


@pytest.mark.parametrize(
    "module", ["dev.accept_bootstrap_http", "dev.accept_owner_claim_consume_http"]
)
def test_the_bootstrap_and_consume_image_probes_accept_the_image_tree(tmp_path, module):
    import importlib

    probe = importlib.import_module(module)
    image_tree(ROOT, tmp_path)
    for name in getattr(probe, "IMAGE_REQUIRED", ()):
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text("")  # the consume overlay's own sources, not under test here
    probe.image_source_boundary(str(tmp_path))  # raises when the probe refuses the tree
    for unexpected in ("apps.py", "sender.py"):  # any file the exact listing does not name
        (tmp_path / "apps/outbox" / unexpected).write_text("")
        with pytest.raises(BaseException):  # noqa: B017 - the probe's own refusal type
            probe.image_source_boundary(str(tmp_path))
        (tmp_path / "apps/outbox" / unexpected).unlink()


# ------------------------------------------- source pins between the dev controllers ----


def test_every_dev_controller_source_pin_matches_the_pinned_file():
    """The hosted qualifications refuse to run when a controller they pin changed. Recomputed here,
    without Docker, so a changed controller fails in the normal suite, not only in the image job."""
    import hashlib

    bootstrap = importlib.import_module("dev.accept_bootstrap_http")
    consume = importlib.import_module("dev.accept_owner_claim_consume_http")
    pins = {"dev/accept_production_http.py": [bootstrap.BASELINE_SHA256]}
    for path, digest in consume.BASELINES.items():
        pins.setdefault(path, []).append(digest)
    stale = [
        path
        for path, digests in pins.items()
        for digest in digests
        if hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != digest
    ]
    assert stale == [], f"a dev controller pin is stale: {stale}"


EXTENSION_PRIVATE_SOURCES = (
    "apps/extensions/dispatcher.py",
    "apps/extensions/services.py",
    "apps/extensions/digest.py",
    "apps/extensions/imports.py",
    "apps/extensions/import_parsers.py",
    "apps/extensions/retention.py",
    "apps/extensions/wire.py",
    "apps/extensions/management/caller.py",
    "apps/extensions/management/commands/dispatch_extensions.py",
)


def test_extension_image_carries_only_inert_registration():
    files = set(image_files(ROOT))
    assert {
        "apps/extensions/__init__.py",
        "apps/extensions/apps.py",
        "apps/extensions/models.py",
    } <= files
    assert files.isdisjoint(EXTENSION_PRIVATE_SOURCES)


def test_extension_parent_directory_exception_is_not_an_inert_allowlist():
    ignore = (ROOT / ".dockerignore").read_text().splitlines()
    assert_image_boundary(ignore)
    ignore = [*ignore, "!apps/extensions/"]
    with pytest.raises(AssertionError, match="exact runtime allowlist"):
        assert_image_boundary(ignore)
