"""Provision only the fixed, document-scoped collaboration login after migrations."""

import os

from django.core.exceptions import ImproperlyConfigured
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from psycopg import sql

from apps.docs.collab_role import assert_unprivileged, credentials, grant_statements


class Command(BaseCommand):
    help = "Configure the dedicated collaboration database role on the migrated database"

    def handle(self, *args, **options):
        try:
            role, password = credentials(
                os.environ.get("KODERA_COLLAB_DATABASE_URL", ""),
                connection.settings_dict,
                os.environ.get("KODERA_API_DATABASE_URL"),
            )
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout='5s'")
                cursor.execute("SET LOCAL statement_timeout='30s'")
                # Serialize concurrent migration jobs creating or checking the fixed login.
                cursor.execute("SELECT pg_advisory_xact_lock(847218651)")
                assert_unprivileged(cursor, role)
                cursor.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", [role])
                if cursor.fetchone() is None:
                    cursor.execute(
                        sql.SQL(
                            "CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
                        ).format(sql.Identifier(role))
                    )
                cursor.execute(
                    sql.SQL("ALTER ROLE {} LOGIN CONNECTION LIMIT 5 PASSWORD {}").format(
                        sql.Identifier(role), sql.Literal(password)
                    )
                )
                cursor.execute(
                    sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                        sql.Identifier(connection.settings_dict["NAME"]), sql.Identifier(role)
                    )
                )
                for statement in grant_statements(role):
                    cursor.execute(statement)
                assert_unprivileged(cursor, role)
        except ImproperlyConfigured as error:
            raise CommandError(str(error)) from None
        self.stdout.write(self.style.SUCCESS("Dedicated collaboration database role configured"))
