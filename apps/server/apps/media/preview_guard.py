"""Non-blocking cluster admission for bounded preview and push DNS work."""

from collections.abc import Iterator
from contextlib import contextmanager, suppress

from django.conf import settings
from django.db import DatabaseError, connection

from .outbound import FetchError

# Session-scoped, on a disposable connection: a crash/close releases the lease.
UNFURL_LOCK = 0x4B4F444552415546
PUSH_LOCK = 0x4B4F444552415053
PREVIEW_RATE = 10
PREVIEW_WINDOW_S = 60


@contextmanager
def cluster_lane(lock_key: int = UNFURL_LOCK) -> Iterator[None]:
    """Use a direct PostgreSQL session, or an explicit transaction-pooler fallback.

    Non-PostgreSQL callers retain outbound.request_lane() process-local admission.
    Database/lease errors fail closed rather than starting unbounded DNS work.
    """
    if connection.vendor != "postgresql":
        yield
        return
    pooled = getattr(settings, "KODERA_DATABASE_TRANSACTION_POOLER", False)
    lease = connection.copy(alias="outbound_lease")
    # Never return a session holding an advisory lock to a connection pool.
    lease.settings_dict["OPTIONS"].pop("pool", None)
    try:
        try:
            lease.set_autocommit(not pooled)
            with lease.cursor() as cursor:
                lock = "pg_try_advisory_xact_lock" if pooled else "pg_try_advisory_lock"
                cursor.execute(f"SELECT {lock}(%s)", [lock_key])
                if not cursor.fetchone()[0]:
                    raise FetchError("resolver-busy")
        except DatabaseError:
            raise FetchError("unavailable") from None
        yield
    finally:
        if pooled and lease.connection is not None:
            with suppress(DatabaseError):
                lease.rollback()
        lease.close()


def charge(principal_key: str) -> bool:
    """Atomically charge a fixed window shared by all API processes (including cache hits)."""
    with connection.cursor() as cursor:
        cursor.execute(
            """INSERT INTO media_previewadmission AS budget (key, expires_at, hits)
               VALUES (%s, statement_timestamp() + make_interval(secs => %s), 1)
               ON CONFLICT (key) DO UPDATE SET
                 hits = CASE WHEN budget.expires_at <= statement_timestamp() THEN 1
                             ELSE budget.hits + 1 END,
                 expires_at = CASE WHEN budget.expires_at <= statement_timestamp()
                                   THEN EXCLUDED.expires_at ELSE budget.expires_at END
               WHERE budget.expires_at <= statement_timestamp() OR budget.hits < %s
               RETURNING hits""",
            [principal_key, PREVIEW_WINDOW_S, PREVIEW_RATE],
        )
        admitted = cursor.fetchone() is not None
        # Bounded opportunistic expiry; neither a cron nor unbounded table scans are required.
        cursor.execute(
            """DELETE FROM media_previewadmission WHERE key IN
               (SELECT key FROM media_previewadmission WHERE expires_at <= statement_timestamp()
                ORDER BY expires_at LIMIT 100)
               AND expires_at <= statement_timestamp()"""
        )
    return admitted


def timed_out(host_key: str) -> bool:
    with connection.cursor() as cursor:
        cursor.execute(
            """SELECT 1 FROM media_previewadmission
               WHERE key=%s AND expires_at > statement_timestamp()""",
            [host_key],
        )
        return cursor.fetchone() is not None


def remember_timeout(host_key: str, ttl: int) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """INSERT INTO media_previewadmission (key, expires_at, hits)
               VALUES (%s, statement_timestamp() + make_interval(secs => %s), 0)
               ON CONFLICT (key) DO UPDATE SET expires_at=EXCLUDED.expires_at""",
            [host_key, ttl],
        )
