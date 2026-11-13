"""Explicit synthetic fiscal authority for disposable order/HTTP fixtures only."""

from datetime import UTC, datetime

from django.db import connection

from apps.billing.models import FiscalPeriod


def register_test_fiscal_periods():
    """The test issuer uses UTC calendar periods; no production fiscal default is implied.

    Existing explicitly registered periods win, including noncalendar authority in clock tests.
    Tests exercising missing authority simply do not call this fixture helper.
    """
    if FiscalPeriod.objects.filter(issuer_siren="000000000").exists():
        return
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        current_year = cursor.fetchone()[0].year
    for year in range(current_year - 2, current_year + 2):
        register_test_fiscal_year(year)


def register_test_fiscal_year(year):
    """Explicitly configure one synthetic UTC fiscal year, including frozen-clock scenarios."""
    FiscalPeriod.objects.get_or_create(
        authority_ref=f"TESTFIN-{year}",
        defaults=dict(
            issuer_siren="000000000",
            starts_at=datetime(year, 1, 1, tzinfo=UTC),
            closed_at=datetime(year + 1, 1, 1, tzinfo=UTC),
            timezone="UTC",
        ),
    )
