"""Only the independent collaboration credential for the migrated database is admitted."""

import pytest
from django.core.exceptions import ImproperlyConfigured

from apps.docs.collab_role import credentials, grant_statements

DATABASE = {"HOST": "db", "PORT": "5432", "NAME": "kodera"}
PASSWORD = "synthetic-independent-database-password"


def test_collab_database_url_uses_its_dedicated_login():
    assert credentials(f"postgresql://kodera_collab:{PASSWORD}@db:5432/kodera", DATABASE) == (
        "kodera_collab",
        PASSWORD,
    )


def test_collab_database_url_refuses_the_owner_password():
    with pytest.raises(ImproperlyConfigured, match="dedicated login on the migrated database"):
        credentials(
            f"postgresql://kodera_collab:{PASSWORD}@db:5432/kodera",
            {**DATABASE, "PASSWORD": PASSWORD},
        )


@pytest.mark.parametrize(
    "url",
    [
        f"postgresql://owner:{PASSWORD}@db:5432/kodera",
        f"postgresql://kodera_collab:{PASSWORD}@other:5432/kodera",
        f"postgresql://kodera_collab:{PASSWORD}@db:5433/kodera",
        f"postgresql://kodera_collab:{PASSWORD}@db:0/kodera",
        f"postgresql://kodera_collab:{PASSWORD}@db:5432/other",
        f"postgresql://kodera_collab:{PASSWORD}@db:5432/kodera?options=-c%20role=owner",
        f"postgresql://kodera_collab:{PASSWORD}@db:5432/kodera#fragment",
        "postgresql://kodera_collab:short@db:5432/kodera",
        "",
    ],
)
def test_collab_database_url_refuses_privilege_or_destination_changes(url):
    with pytest.raises(ImproperlyConfigured, match="dedicated login on the migrated database"):
        credentials(url, DATABASE)


def test_collab_grants_refuse_identifier_injection():
    with pytest.raises(ValueError, match="lower-case identifier"):
        grant_statements('role"; GRANT ALL ON ALL TABLES IN SCHEMA public TO PUBLIC; --')
