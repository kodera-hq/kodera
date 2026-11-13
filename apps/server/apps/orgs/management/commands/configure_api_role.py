"""Provision the existing reviewed API writer grants on an independent fixed login."""

import os

from django.core.exceptions import ImproperlyConfigured
from django.core.management.base import BaseCommand, CommandError
from django.db import DatabaseError, connection, transaction
from psycopg import sql

from core.db.api_database_boundary import assert_writer_grants, credentials
from core.db.api_writer_role import grant_statements


class Command(BaseCommand):
    help = "Configure the independent API database login using reviewed writer grants"

    def handle(self, *args, **options):
        try:
            role, password = credentials(
                os.environ.get("KODERA_API_DATABASE_URL", ""),
                connection.settings_dict,
                os.environ.get("KODERA_COLLAB_DATABASE_URL"),
            )
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout='5s'")
                cursor.execute("SET LOCAL statement_timeout='30s'")
                cursor.execute("SELECT pg_advisory_xact_lock(847218652)")
                cursor.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", [role])
                if cursor.fetchone() is None:
                    cursor.execute(
                        sql.SQL(
                            "CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
                        ).format(sql.Identifier(role))
                    )
                assert_writer_grants(cursor, role)
                # Two synchronous HTTP workers need two connections. This finite
                # ceiling leaves bounded room for rolling replacement and probes.
                cursor.execute(
                    sql.SQL("ALTER ROLE {} LOGIN CONNECTION LIMIT 16 PASSWORD {}").format(
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
                assert_writer_grants(cursor, role)
        except (ImproperlyConfigured, DatabaseError):
            raise CommandError("API database role provisioning refused") from None
        self.stdout.write(self.style.SUCCESS("Independent API database role configured"))
