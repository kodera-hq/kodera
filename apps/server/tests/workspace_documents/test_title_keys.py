"""Unicode title-key invariants, collaboration parity, and fixture startup diagnostics."""

import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path
from urllib.parse import quote
from uuid import UUID, uuid4

import pytest
from django.core.management import call_command
from workspace_safety.test_moderation import world as world

from apps.docs import services, title_key_table, titles
from apps.docs.models import Document, DocumentLink
from workspace_documents import test_services
from workspace_documents.test_services import native_engine as native_engine


def test_title_key_table_is_in_step_with_python_unicode() -> None:
    assert titles.KEY_EXPANSION == 18
    assert titles.MAX_KEY_LENGTH == 4590
    assert title_key_table.TABLE.read_text(encoding="ascii") == title_key_table.render()


def test_every_code_point_key_stays_within_declared_expansion_bound() -> None:
    checked = 0
    for point in range(sys.maxunicode + 1):
        if 0xD800 <= point <= 0xDFFF:
            continue
        character = chr(point)
        assert 1 <= len(titles.key(character)) <= titles.KEY_EXPANSION
        assert 1 <= len(titles.key(unicodedata.normalize("NFD", character))) <= titles.KEY_EXPANSION
        checked += 1
    assert checked == 0x110000 - 0x800


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
        "I\u0323\u0307",
        "ı",
        "ΐ",
        "ﬃ",
        "ﬃ" * 255,
        "\ufdfa",
        "\ufdfa" * 255,
        "Å",
        "ᾼ",
        "\U00010400",
        "\U000104b0",
        "\U0001e900",
        # Newer-Unicode decompositions where Node 22+ ICU differs from Python 3.12/3.13 unicodedata.
        "\U000105d2\u0307",
        "\U000105da\u0307",
        "\U000105c9",
        "\U00011382\U000113c9",
        "\U0001611e\U00016129\U0001611f",
        "\U00016d63\U00016d67\U00016d67",
        # Hangul syllables, conjoining jamo, and combining-mark blocked jamo.
        "\uac00",
        "\uac01",
        "\ud7a3",
        "\u1100\u1161",
        "\u1100\u1161\u11a8",
        "\uac00\u11a8",
        "\u1100\u0301\u1161",
        "\uac00\u0301\u11a8",
        "\u1100\u1161\u11a8\u11a8",
        # Multi-mark canonical ordering, starter blocking, and leading non-starters.
        "e\u0323\u0302\u0301",
        "e\u0301\u0302\u0323",
        "e\u0302\u0301",
        "a\u0315\u0300\u05ae\u0301",
        "\u0308\u0301",
        "\u0344",
        "\u0cc6\u0cc2\u0cd5",
        "\u0cc6\u0cd5\u0cc2",
        *(chr(point) for point in title_key_table.folds()),
    ]
    root = Path(__file__).resolve().parents[2] / "yjs_collab"
    script = (
        "import { createHash } from 'node:crypto';"
        "import { nfc, titleKey } from './title-key.mjs';"
        "let raw = ''; process.stdin.setEncoding('utf8');"
        "process.stdin.on('data', chunk => { raw += chunk });"
        "process.stdin.on('end', () => {"
        "  const samples = JSON.parse(raw).map(titleKey);"
        "  const hash = createHash('sha256');"
        "  const icuDecomposed = [];"
        "  for (let cp = 0; cp <= 0x10FFFF; cp++) {"
        "    if (cp >= 0xD800 && cp <= 0xDFFF) continue;"
        "    const s = String.fromCodePoint(cp);"
        "    hash.update(titleKey(s), 'utf8');"
        "    hash.update('\\0');"
        "    hash.update(titleKey(s + '\\u0307'), 'utf8');"
        "    hash.update('\\0');"
        "    hash.update(titleKey(s + '\\u0301'), 'utf8');"
        "    hash.update('\\n');"
        "    const nfd = s.normalize('NFD');"
        "    if (nfd !== s) icuDecomposed.push([nfd, nfc(nfd), titleKey(nfd)]);"
        "  }"
        "  process.stdout.write(JSON.stringify({"
        "    samples, digest: hash.digest('hex'), icuDecomposed"
        "  }));"
        "});"
    )
    result = subprocess.run(  # noqa: S603 - resolved Node binary and inline assertion harness
        [node, "--input-type=module", "-e", script],
        cwd=root,
        env={"PATH": os.environ["PATH"]},
        input=json.dumps(samples).encode(),
        capture_output=True,
        timeout=60,
        check=True,
    )
    payload = json.loads(result.stdout)
    assert payload["samples"] == [titles.key(sample) for sample in samples]
    for decomposed, js_nfc, js_key in payload["icuDecomposed"]:
        assert js_nfc == unicodedata.normalize("NFC", decomposed)
        assert js_key == titles.key(decomposed)

    expected = hashlib.sha256()
    for point in range(sys.maxunicode + 1):
        if 0xD800 <= point <= 0xDFFF:
            continue
        character = chr(point)
        expected.update(titles.key(character).encode("utf-8"))
        expected.update(b"\0")
        expected.update(titles.key(character + "\u0307").encode("utf-8"))
        expected.update(b"\0")
        expected.update(titles.key(character + "\u0301").encode("utf-8"))
        expected.update(b"\n")
    assert payload["digest"] == expected.hexdigest()


@pytest.mark.django_db
def test_docs_migrations_match_current_models() -> None:
    call_command("makemigrations", "docs", check=True, dry_run=True, verbosity=0)


@pytest.mark.django_db(transaction=True)
def test_extreme_unicode_titles_and_icu_drift_sequences_create_and_wikilink_cleanly(
    world, native_engine, settings
) -> None:
    from django.conf import settings as current_settings

    org, _, _, tokens = world
    arabic_title = "\ufdfa" * 255
    ffi_title = "ﬃ" * 255
    todhri_title = "\U000105d2\u0307"

    arabic_doc = test_services.create(world, arabic_title)
    ffi_doc = test_services.create(world, ffi_title)
    todhri_doc = test_services.create(world, todhri_title)
    rest_source = test_services.create(world, "REST Unicode Links")
    test_services.patch(
        world,
        rest_source,
        {"markdown": f"[[{arabic_title}]] [[{ffi_title}]] [[{todhri_title}]]"},
    )
    expected_targets = {
        titles.key(arabic_title): UUID(arabic_doc["id"]),
        titles.key(ffi_title): UUID(ffi_doc["id"]),
        titles.key(todhri_title): UUID(todhri_doc["id"]),
    }
    assert (
        dict(
            DocumentLink.objects.filter(source_id=rest_source["id"]).values_list(
                "target_title", "target_id"
            )
        )
        == expected_targets
    )

    collab_source = Document.objects.get(
        pk=test_services.create(world, "Collab Unicode Links")["id"]
    )
    editor = services.collab_session(
        verified=tokens[3],
        organisation_id=org.id,
        document_id=collab_source.id,
        request_id=str(uuid4()),
    )
    database = current_settings.DATABASES["default"]
    url = (
        "postgresql://"
        + quote(database["USER"], safe="")
        + ":"
        + quote(database["PASSWORD"], safe="")
        + "@"
        + database["HOST"]
        + ":"
        + str(database["PORT"])
        + "/"
        + quote(database["NAME"], safe="")
    )
    root = Path(__file__).resolve().parents[2] / "yjs_collab"
    binary = shutil.which("node")
    assert binary is not None
    result = subprocess.run(  # noqa: S603 - owned fixture against generated test database
        [binary, str(root / "test/link-store-fixture.mjs")],
        cwd=root,
        env={
            "PATH": os.environ["PATH"],
            "KODERA_TEST_DATABASE_URL": url,
            "KODERA_TEST_COLLAB_KEY": base64.urlsafe_b64encode(
                settings.KODERA_COLLAB_TICKET_KEY
            ).decode(),
        },
        input=json.dumps(
            {"editor": editor["token"], "links": [arabic_title, ffi_title, todhri_title]}
        ).encode(),
        capture_output=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr.decode()
    assert (
        dict(
            DocumentLink.objects.filter(source=collab_source).values_list(
                "target_title", "target_id"
            )
        )
        == expected_targets
    )


def test_migration_0010_deduplicates_c_locale_collisions_and_reresolves_links(
    transactional_db, django_db_blocker
) -> None:
    from django.db import transaction
    from django.db.migrations.executor import MigrationExecutor
    from django.utils import timezone
    from test_customer_persistence_migrations import empty_database

    old = [("docs", "0009_link_title_lookup")]
    new = [("docs", "0010_locale_free_title_keys")]
    ffi_max = "ﬃ" * 255
    arabic_max = "\ufdfa" * 255
    dangling_expanding = "ﬃ" * 254 + "x"
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
            ffi_doc = document_model.objects.using(target.alias).create(
                id=UUID("01900000-0000-7000-8000-000000000004"),
                workspace=workspace,
                creator=member,
                title=ffi_max,
            )
            arabic_doc = document_model.objects.using(target.alias).create(
                id=UUID("01900000-0000-7000-8000-000000000005"),
                workspace=workspace,
                creator=member,
                title=arabic_max,
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
            link_model.objects.using(target.alias).create(
                id=UUID("01900000-0000-7000-8000-000000000013"),
                source=source,
                target=ffi_doc,
                target_title=ffi_max,
            )
            link_model.objects.using(target.alias).create(
                id=UUID("01900000-0000-7000-8000-000000000014"),
                source=source,
                target=arabic_doc,
                target_title=arabic_max,
            )
            link_model.objects.using(target.alias).create(
                id=UUID("01900000-0000-7000-8000-000000000015"),
                source=source,
                target=None,
                target_title=dangling_expanding,
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
            .filter(pk__in=[first.pk, second.pk, ffi_doc.pk, arabic_doc.pk])
            .values_list("id", "title_key")
        )
        assert docs == {first.pk: "Équipe", second.pk: "équipe (2)"}
        assert keys == {
            first.pk: "équipe",
            second.pk: "équipe (2)",
            ffi_doc.pk: "ffi" * 255,
            arabic_doc.pk: titles.key(arabic_max),
        }
        assert len(keys[ffi_doc.pk]) == 765
        assert dict(
            new_link.objects.using(target.alias)
            .filter(source_id=source.pk)
            .values_list("target_title", "target_id")
        ) == {
            "équipe": first.pk,
            "ffi" * 255: ffi_doc.pk,
            titles.key(arabic_max): arabic_doc.pk,
            "ffi" * 254 + "x": None,
        }
        # Reversing rewrites expanded link keys back inside <= 255 before restoring 0009's bound,
        # and reapplying 0010 restores folded keys cleanly.
        MigrationExecutor(target).migrate(old)
        rolled_back_link = (
            MigrationExecutor(target)
            .loader.project_state(old)
            .apps.get_model("docs", "DocumentLink")
        )
        rolled_back_rows = dict(
            rolled_back_link.objects.using(target.alias)
            .filter(source_id=source.pk)
            .values_list("target_title", "target_id")
        )
        assert all(1 <= len(link_title) <= 255 for link_title in rolled_back_rows)
        assert rolled_back_rows[ffi_max] == ffi_doc.pk
        assert rolled_back_rows[arabic_max] == arabic_doc.pk
        assert rolled_back_rows[("ffi" * 254 + "x")[:255]] is None

        MigrationExecutor(target).migrate(new)
        reapplied_link = (
            MigrationExecutor(target)
            .loader.project_state(new)
            .apps.get_model("docs", "DocumentLink")
        )
        reapplied_rows = dict(
            reapplied_link.objects.using(target.alias)
            .filter(source_id=source.pk)
            .values_list("target_title", "target_id")
        )
        assert reapplied_rows["équipe"] == first.pk
        assert reapplied_rows["ffi" * 255] == ffi_doc.pk
        assert reapplied_rows[titles.key(arabic_max)] == arabic_doc.pk


def test_native_engine_surfaces_stderr_when_child_closes_stdout_before_port(
    settings, monkeypatch
) -> None:
    class ExitedChild:
        def __init__(self, *_args, **_kwargs) -> None:
            self.stdout = io.BytesIO(b"")
            self.stderr = io.BytesIO(b"Error: missing native dependency\n")

        def poll(self) -> int:
            return 1

        def wait(self, timeout: float | None = None) -> int:
            return 1

        def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
            assert timeout == 5
            return b"", self.stderr.read()

        def terminate(self) -> None:
            return None

        def kill(self) -> None:
            raise AssertionError("exited child must not be SIGKILLed")

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


def test_native_engine_kills_and_bounds_stderr_when_child_wedges_after_stdout_eof(
    settings, monkeypatch
) -> None:
    class UnboundedStderr:
        def read(self, *_args) -> bytes:
            raise AssertionError("unbounded stderr.read() must not be called")

        def close(self) -> None:
            return None

    class WedgedChild:
        def __init__(self, *_args, **_kwargs) -> None:
            self.stdout = io.BytesIO(b"")
            self.stderr = UnboundedStderr()
            self.killed = False

        def poll(self) -> int | None:
            return 0 if self.killed else None

        def wait(self, timeout: float | None = None) -> int:
            if not self.killed:
                raise subprocess.TimeoutExpired(cmd="node", timeout=timeout or 5)
            return -9

        def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
            assert self.killed, "wedged child must be killed before draining stderr"
            assert timeout == 5
            return b"", b"Error: wedged with open stderr\n"

        def terminate(self) -> None:
            return None

        def kill(self) -> None:
            self.killed = True

    monkeypatch.setattr(
        "workspace_documents.test_services.select.select", lambda r, _w, _x, _t: (r, [], [])
    )
    monkeypatch.setattr("workspace_documents.test_services.subprocess.Popen", WedgedChild)
    fixture = test_services._native_engine(settings)
    with pytest.raises(
        RuntimeError,
        match=r"exited before announcing its port \(exit code None\): Error: wedged with open stderr",
    ):
        next(fixture)
