"""The bootstrap proves only local runtime/database behavior, never release readiness."""

import importlib.metadata
import tomllib
from pathlib import Path
from unittest.mock import patch

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.db import OperationalError, connection, transaction
from django.test import Client

from config.environment import (
    INFRASTRUCTURE_NAMES,
    INFRASTRUCTURE_PREFIXES,
    NONCREDENTIAL_METADATA_NAMES,
    local_database,
)


@pytest.fixture
def client():
    return Client(HTTP_HOST="localhost")


def test_liveness_needs_no_database(client):
    # pytest-django forbids database access unless requested by this test.
    response = client.get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "alive"}
    assert response["Cache-Control"] == "no-store"


@pytest.mark.django_db
def test_readiness_queries_real_postgres(client, django_assert_num_queries):
    assert connection.vendor == "postgresql"
    with django_assert_num_queries(1):
        response = client.get("/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready", "database": "reachable"}
    assert response["Cache-Control"] == "no-store"


@pytest.mark.django_db
def test_real_postgres_rolls_back_synthetic_data():
    assert connection.vendor == "postgresql"
    with connection.cursor() as cursor:
        cursor.execute("CREATE TEMP TABLE bootstrap_probe (value integer) ON COMMIT DROP")
        savepoint = transaction.savepoint_create()
        cursor.execute("INSERT INTO bootstrap_probe VALUES (7)")
        cursor.execute("SELECT value FROM bootstrap_probe")
        assert cursor.fetchone() == (7,)
        transaction.savepoint_rollback(savepoint)
        cursor.execute("SELECT count(*) FROM bootstrap_probe")
        assert cursor.fetchone() == (0,)


@pytest.mark.django_db
def test_test_database_server_does_not_wait_on_disk_syncs():
    # Every transactional test ends with a TRUNCATE flush on a connection whose
    # statement_timeout is 2 s. With fsync on, CI caught that flush waiting in
    # IO/DataFileImmediateSync until the timeout cancelled it, with no lock
    # holder at all. The test server is disposable, so it runs without fsync.
    with connection.cursor() as cursor:
        cursor.execute("SHOW fsync")
        assert cursor.fetchone() == ("off",), (
            "the test database server runs with fsync on: each test-teardown TRUNCATE "
            "then waits on disk syncs under the 2 s statement_timeout, and the suite "
            "fails on disk latency. Locally, run the suite against the disposable "
            "test-db service (`make test-db test`). On any other server you can "
            "discard, run: ALTER SYSTEM SET fsync = off; SELECT pg_reload_conf();"
        )


def test_readiness_failure_is_truthful_and_redacted(client, caplog):
    with patch(
        "core.health.connection.cursor", side_effect=OperationalError("synthetic-private-value")
    ):
        response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "not_ready", "database": "unavailable"}
    assert response["Cache-Control"] == "no-store"
    assert "synthetic-private-value" not in response.content.decode() + caplog.text
    assert client.get("/health/live").status_code == 200


@pytest.mark.parametrize("path", ["/health/live", "/health/ready"])
def test_probes_reject_mutation(client, path):
    assert client.post(path).status_code == 405


def test_no_business_api_is_implied(client):
    assert client.get("/api/v1/tenants").status_code == 404
    # The staff intake routes POST on the collection; listing it is still not served.
    listing = client.get("/api/v1/organisations")
    assert listing.status_code == 405 and listing["Allow"] == "POST"


# The refusal list is the control, so its reviewed entries are restated here as
# literals. Reading them back out of config.environment would make this test
# follow the code: an entry deleted there would silently become an entry no
# longer checked here, which is how the list came to be only partly covered.
# docs/dev/SETTINGS_AND_SECRETS.md §3 bans OpenTofu's tokens, variables and state-backend
# credentials: Core never reads a TF_ variable, so the whole prefix is refused, with the state
# backends' own credentials (GOOGLE_ for gcs, CONSUL_HTTP_ for consul, PG_CONN_STR for pg).
REFUSED_PREFIXES = (
    "AGE_",
    "ARM_",
    "AWS_",
    "AZURE_",
    "CONSUL_HTTP_",
    "GOOGLE_",
    "SCW_",
    "SOPS_",
    "SSH_",
    "TF_",
)
REFUSED_NAMES = {
    "ANSIBLE_PRIVATE_KEY_FILE",
    "PG_CONN_STR",
    "KC_BOOTSTRAP_ADMIN_PASSWORD",
    "KEYCLOAK_ADMIN",
    "KEYCLOAK_ADMIN_PASSWORD",
    "KEYCLOAK_CLIENT_SECRET",
}
EXEMPT_NAMES = {"AZURE_EXTENSION_DIR"}
# One realistic credential name per refused prefix. None of them is also a
# refused exact name, so only the prefix can explain the refusal.
NAME_PER_PREFIX = {
    "AGE_": "AGE_SECRET_KEY",
    "ARM_": "ARM_CLIENT_SECRET",
    "AWS_": "AWS_SECRET_ACCESS_KEY",
    "AZURE_": "AZURE_CLIENT_SECRET",
    "SCW_": "SCW_SECRET_KEY",
    "SOPS_": "SOPS_AGE_KEY_FILE",
    "SSH_": "SSH_AUTH_SOCK",
    "CONSUL_HTTP_": "CONSUL_HTTP_TOKEN",
    "GOOGLE_": "GOOGLE_BACKEND_CREDENTIALS",
    "TF_": "TF_HTTP_PASSWORD",
}
DECLARED_VALUES = ["", "synthetic-private-value"]


@pytest.mark.parametrize(
    ("control", "declared", "reviewed"),
    [
        ("INFRASTRUCTURE_PREFIXES", INFRASTRUCTURE_PREFIXES, REFUSED_PREFIXES),
        ("INFRASTRUCTURE_NAMES", INFRASTRUCTURE_NAMES, REFUSED_NAMES),
        ("NONCREDENTIAL_METADATA_NAMES", NONCREDENTIAL_METADATA_NAMES, EXEMPT_NAMES),
    ],
)
def test_refusal_list_matches_its_reviewed_entries(control, declared, reviewed):
    added = sorted(set(declared) - set(reviewed))
    removed = sorted(set(reviewed) - set(declared))
    assert set(declared) == set(reviewed), (
        f"{control} changed without review: added {added}, removed {removed}"
    )


@pytest.mark.parametrize("prefix", REFUSED_PREFIXES)
@pytest.mark.parametrize("value", DECLARED_VALUES)
def test_every_refused_prefix_refuses_a_matching_name(prefix, value):
    name = NAME_PER_PREFIX[prefix]
    assert name.startswith(prefix) and name not in REFUSED_NAMES
    with pytest.raises(ImproperlyConfigured) as error:
        local_database({name: value})
    assert str(error.value) == "API refuses infrastructure configuration: " + name
    assert "synthetic-private-value" not in str(error.value)


@pytest.mark.parametrize("name", sorted(REFUSED_NAMES))
@pytest.mark.parametrize("value", DECLARED_VALUES)
def test_every_refused_name_is_refused(name, value):
    assert not name.startswith(REFUSED_PREFIXES)
    with pytest.raises(ImproperlyConfigured) as error:
        local_database({name: value})
    assert str(error.value) == "API refuses infrastructure configuration: " + name
    assert "synthetic-private-value" not in str(error.value)


@pytest.mark.parametrize("name", sorted(EXEMPT_NAMES))
def test_every_exempt_name_is_accepted(name):
    assert local_database({name: "/synthetic/cli/extensions"}) == local_database({})


def test_configuration_diagnostic_names_only_refused_inputs():
    environment = {
        "SCW_SECRET_KEY": "synthetic-private-value",
        "AWS_SECRET_ACCESS_KEY": "another-private-value",
        "UNRELATED_INPUT": "unrelated-private-value",
        "SCW_invalid\nsynthetic-private-name": "name-private-value",
    }
    with pytest.raises(ImproperlyConfigured) as error:
        local_database(environment)
    assert str(error.value) == (
        "API refuses infrastructure configuration: "
        "<nonconventional name>, AWS_SECRET_ACCESS_KEY, SCW_SECRET_KEY"
    )
    assert not any(value in str(error.value) for value in environment.values())
    assert "synthetic-private-name" not in str(error.value)
    assert "UNRELATED_INPUT" not in str(error.value)


def test_extension_directory_metadata_is_ignored():
    from collections import UserDict

    class UnreadableMetadata(UserDict):
        def __getitem__(self, key):
            assert key != "AZURE_EXTENSION_DIR", "metadata value must not be read"
            return super().__getitem__(key)

    environment = UnreadableMetadata({"AZURE_EXTENSION_DIR": "/synthetic/cli/extensions"})
    assert local_database(environment) == local_database({})


@pytest.mark.parametrize(
    "name",
    [
        "AZURE_CLIENT_SECRET",
        "SCW_SECRET_KEY",
        "AZURE_EXTENSION_DIR_SECRET",
        "AZURE_EXTENSION_DIR_",
        "AZURE_EXTENSION_DIRECTORY",
        "AZURE_SOMETHING",
    ],
)
@pytest.mark.parametrize("value", ["", "synthetic-private-value"])
def test_extension_metadata_does_not_allow_credentials(name, value):
    with pytest.raises(ImproperlyConfigured) as error:
        local_database({"AZURE_EXTENSION_DIR": "/synthetic/cli/extensions", name: value})
    assert str(error.value) == "API refuses infrastructure configuration: " + name
    assert "synthetic-private-value" not in str(error.value)


@pytest.mark.parametrize(
    "environment",
    [
        {"DJANGO_DEBUG": "1"},
        {"DJANGO_ALLOWED_HOSTS": "*"},
        {"DJANGO_ALLOWED_HOSTS": "external.example.test"},
        {"DATABASE_URL": "postgres://synthetic:synthetic@external.example.test/kodera_server"},
        {"DATABASE_URL": "sqlite:///local.sqlite3"},
        {"DATABASE_URL": "postgres://synthetic:synthetic@localhost:0/kodera_server"},
        {"DATABASE_URL": "postgres://synthetic:synthetic@localhost/kodera_server?options=unsafe"},
    ],
)
def test_unsafe_local_configuration_is_refused(environment):
    with pytest.raises(ImproperlyConfigured, match="local configuration"):
        local_database(environment)


def test_postgres_timeouts_are_bounded():
    database = local_database({})
    assert database["ENGINE"] == "django.db.backends.postgresql"
    assert database["OPTIONS"]["connect_timeout"] == 2
    assert database["OPTIONS"]["options"] == "-c statement_timeout=2000"


def test_runtime_versions_match_exact_pins():
    metadata = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text())
    for requirement in metadata["project"]["dependencies"]:
        name, pinned = requirement.split("==")
        assert importlib.metadata.version(name.split("[", 1)[0]) == pinned


def test_readiness_requires_the_expected_query_result(client):
    with patch("core.health.connection.cursor") as cursor:
        cursor.return_value.__enter__.return_value.fetchone.return_value = (0,)
        response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "not_ready", "database": "unavailable"}


def test_readiness_query_failure_is_redacted(client, caplog):
    with patch("core.health.connection.cursor") as cursor:
        cursor.return_value.__enter__.return_value.execute.side_effect = OperationalError(
            "synthetic-query-private-value"
        )
        response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "not_ready", "database": "unavailable"}
    assert "synthetic-query-private-value" not in response.content.decode() + caplog.text
