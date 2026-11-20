"""Unicode title-key invariants, collaboration parity, and fixture startup diagnostics."""

import io
import json
import os
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

import pytest
from django.core.management import call_command

from apps.docs import title_key_table, titles
from workspace_documents import test_services


def test_title_key_table_is_in_step_with_python_unicode() -> None:
    assert title_key_table.TABLE.read_text(encoding="ascii") == title_key_table.render()


def test_every_code_point_key_stays_within_declared_expansion_bound() -> None:
    for point in range(sys.maxunicode + 1):
        if 0xD800 <= point <= 0xDFFF:
            continue
        character = chr(point)
        assert len(titles.key(character)) <= titles.KEY_EXPANSION
        assert len(titles.key(unicodedata.normalize("NFD", character))) <= titles.KEY_EXPANSION


def test_collab_title_key_matches_python_across_unicode_folds() -> None:
    node = shutil.which("node")
    assert node is not None
    samples = [
        "Example",
        "Équipe",
        "équipe",
        "E\u0301QUIPE",
        "e\u0301quipe",
        "Straße",
        "STRASSE",
        "İ",
        "i\u0307",
        "ı",
        "ΐ",
        "ﬃ",
        "Å",
        "ᾼ",
        "\U00010400",
        "\U000104b0",
        "\U0001e900",
        *(chr(point) for point in title_key_table.folds()),
    ]
    root = Path(__file__).resolve().parents[2] / "yjs_collab"
    script = (
        "import { titleKey } from './title-key.mjs';"
        "let raw = ''; process.stdin.setEncoding('utf8');"
        "process.stdin.on('data', chunk => { raw += chunk });"
        "process.stdin.on('end', () => {"
        "  process.stdout.write(JSON.stringify(JSON.parse(raw).map(titleKey)));"
        "});"
    )
    result = subprocess.run(  # noqa: S603 - resolved Node binary and inline assertion harness
        [node, "--input-type=module", "-e", script],
        cwd=root,
        env={"PATH": os.environ["PATH"]},
        input=json.dumps(samples).encode(),
        capture_output=True,
        timeout=30,
        check=True,
    )
    assert json.loads(result.stdout) == [titles.key(sample) for sample in samples]


@pytest.mark.django_db
def test_docs_migrations_match_current_models() -> None:
    call_command("makemigrations", "docs", check=True, dry_run=True, verbosity=0)


def test_migration_0010_deduplicates_c_locale_collisions_and_reresolves_links(
    transactional_db, django_db_blocker
) -> None:
    from uuid import UUID

    from django.db import transaction
    from django.db.migrations.executor import MigrationExecutor
    from django.utils import timezone
    from test_customer_persistence_migrations import empty_database

    old = [("docs", "0009_link_title_lookup")]
    new = [("docs", "0010_locale_free_title_keys")]
    with django_db_blocker.unblock(), empty_database() as target:
        executor = MigrationExecutor(target)
        executor.migrate(old)
        historical = executor.loader.project_state(old).apps
        organisation_model = historical.get_model("orgs", "Organisation")
        reservation_model = historical.get_model("orgs", "SlugReservation")
        workspace_model = historical.get_model("workspaces", "Workspace")
        user_model = historical.get_model("identity", "User")
        membership_model = historical.get_model("orgs", "Membership")
        document_model = historical.get_model("docs", "Document")
        link_model = historical.get_model("docs", "DocumentLink")
        with transaction.atomic(using=target.alias):
            org = organisation_model.objects.using(target.alias).create(
                slug="docs-key-01",
                realm="docs-key-01",
                name="Docs Key",
                issuer="https://identity.example.org/realms/docs-key-01",
                state="active",
            )
            reservation_model.objects.using(target.alias).create(
                organisation=org,
                slug=org.slug,
                namespace="organisation",
                state="permanent",
                protected_at=timezone.now(),
            )
            workspace = workspace_model.objects.using(target.alias).create(organisation=org)
            user = user_model.objects.using(target.alias).create(email="owner@example.org")
            member = membership_model.objects.using(target.alias).create(
                user=user,
                organisation=org,
                role="org_owner",
                state="active",
                accepted_at=timezone.now(),
            )
            # Under LC_CTYPE=C, lower('Équipe') == 'Équipe' != 'équipe', so 0009 permitted both.
            first = document_model.objects.using(target.alias).create(
                id=UUID("01900000-0000-7000-8000-000000000001"),
                workspace=workspace,
                creator=member,
                title="Équipe",
            )
            second = document_model.objects.using(target.alias).create(
                id=UUID("01900000-0000-7000-8000-000000000002"),
                workspace=workspace,
                creator=member,
                title="équipe",
            )
            source = document_model.objects.using(target.alias).create(
                id=UUID("01900000-0000-7000-8000-000000000003"),
                workspace=workspace,
                creator=member,
                title="Source",
            )
            link_model.objects.using(target.alias).create(
                id=UUID("01900000-0000-7000-8000-000000000011"),
                source=source,
                target=None,
                target_title="Équipe",
            )
            link_model.objects.using(target.alias).create(
                id=UUID("01900000-0000-7000-8000-000000000012"),
                source=source,
                target=second,
                target_title="équipe",
            )
        MigrationExecutor(target).migrate(new)
        upgraded = MigrationExecutor(target).loader.project_state(new).apps
        new_document = upgraded.get_model("docs", "Document")
        new_link = upgraded.get_model("docs", "DocumentLink")
        docs = dict(
            new_document.objects.using(target.alias)
            .filter(pk__in=[first.pk, second.pk])
            .values_list("id", "title")
        )
        keys = dict(
            new_document.objects.using(target.alias)
            .filter(pk__in=[first.pk, second.pk])
            .values_list("id", "title_key")
        )
        assert docs == {first.pk: "Équipe", second.pk: "équipe (2)"}
        assert keys == {first.pk: "équipe", second.pk: "équipe (2)"}
        assert list(
            new_link.objects.using(target.alias)
            .filter(source_id=source.pk)
            .values_list("target_title", "target_id")
        ) == [("équipe", first.pk)]
        # Reversing and reapplying stays clean once titles no longer collide.
        MigrationExecutor(target).migrate(old)
        MigrationExecutor(target).migrate(new)


def test_native_engine_surfaces_stderr_when_child_closes_stdout_before_port(
    settings, monkeypatch
) -> None:
    class ExitedChild:
        def __init__(self, *_args, **_kwargs) -> None:
            self.stdout = io.BytesIO(b"")
            self.stderr = io.BytesIO(b"Error: missing native dependency\n")

        def wait(self, timeout: float | None = None) -> int:
            return 1

        def terminate(self) -> None:
            return None

        def kill(self) -> None:
            return None

    monkeypatch.setattr(
        "workspace_documents.test_services.select.select", lambda r, _w, _x, _t: (r, [], [])
    )
    monkeypatch.setattr("workspace_documents.test_services.subprocess.Popen", ExitedChild)
    fixture = test_services._native_engine(settings)
    with pytest.raises(
        RuntimeError,
        match=r"exited before announcing its port \(exit code 1\): Error: missing native dependency",
    ):
        next(fixture)
