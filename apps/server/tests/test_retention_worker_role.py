"""Named source-only refusal controls for runtime/shared/system role reuse."""

import pytest

from core.db.retention_worker_role import admission_grant_statements, grant_statements


@pytest.mark.parametrize(
    "role",
    [
        "kodera_api",
        "kodera_collab",
        "kodera_worker",
        "public",
        "postgres",
        "root",
        "kodera",
        "pg_read_all_data",
        "pg_write_all_data",
        "pg_database_owner",
        "kodera_owner",
        "kodera_migrations",
        "kodera_retention_owner",
        "kodera_retention_admin",
        "kodera_retention_superuser",
        "kodera_retention_migrations",
        "unrelated_shared_role",
        'evil";DROP ROLE public;--',
    ],
)
def test_runtime_shared_system_and_owner_alias_roles_never_receive_retention_capabilities(role):
    with pytest.raises(ValueError, match="separate statutory erasure worker role required"):
        grant_statements(role)


def test_dedicated_retention_worker_can_receive_only_explicit_optional_extension_execute():
    role = "kodera_retention_worker_control"
    baseline = grant_statements(role)
    integrated = grant_statements(role, include_extensions=True)
    assert set(integrated) - set(baseline) == {
        f'GRANT EXECUTE ON FUNCTION extension_erasure_step(uuid,uuid,timestamptz,text,integer) TO "{role}"'
    }
    assert all("DELETE ON" not in line and "OWNER" not in line for line in integrated)
    assert not any('SELECT ON TABLE "billing_statutoryrecord"' in line for line in integrated)


def test_processing_grants_cannot_create_cutoffs_fiscal_authority_or_contract_closes():
    grants = "\n".join(grant_statements("kodera_retention_worker_control", include_extensions=True))
    for forbidden in [
        "privacy_begin_erasure",
        "billing_close_contract",
        "billing_qualify_legacy_accounting",
        "INSERT ON",
        "billing_fiscalperiod",
    ]:
        assert forbidden not in grants
    admission = "\n".join(admission_grant_statements("kodera_retention_admission_control"))
    assert (
        "privacy_begin_erasure" in admission and "INSERT ON TABLE billing_fiscalperiod" in admission
    )
    for role in [
        "kodera_api",
        "kodera_collab",
        "kodera_worker",
        "postgres",
        "pg_database_owner",
        "kodera_retention_worker_control",
    ]:
        with pytest.raises(ValueError, match="separate statutory erasure admission role required"):
            admission_grant_statements(role)
    with pytest.raises(ValueError, match="separate statutory erasure worker role required"):
        grant_statements("kodera_retention_admission_control")


@pytest.mark.parametrize(
    "module_name",
    [
        "apps.orgs.management.commands.erase_core_workspace",
        "apps.billing.management.commands.manage_statutory_retention",
    ],
)
def test_operator_commands_refuse_before_any_operation_when_profile_is_unavailable(
    monkeypatch, module_name
):
    import importlib

    from django.core.management.base import CommandError

    module = importlib.import_module(module_name)

    def refuse_profile():
        raise CommandError("operator profile control unavailable")

    monkeypatch.setattr(module, "require_operator_profile", refuse_profile)
    with pytest.raises(CommandError, match="operator profile control unavailable"):
        module.Command().handle()
