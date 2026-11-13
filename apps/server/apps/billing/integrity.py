"""Read-only accounting series verification; no renumbering or repair is permitted."""

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from .configuration import SERIES

PARIS = ZoneInfo("Europe/Paris")


class IntegrityRefusedError(ValueError):
    """A named accounting integrity failure, without customer or provider payloads."""


@dataclass(frozen=True)
class NumberedRecord:
    number: str
    issued_at: datetime


def verify_series(records: Iterable[NumberedRecord], counters: dict[tuple[str, int], int]) -> None:
    """Verify both invoice and AV series, including missing first/last numbers and empty series.

    Sorting by the numeric suffix also proves that issue dates are monotonic. The maximum
    suffix is bounded before any range is considered: a corrupt counter cannot allocate memory.
    """
    grouped: dict[tuple[str, int], list[tuple[int, datetime]]] = defaultdict(list)
    for row in records:
        try:
            series, year_text, suffix = row.number.rsplit("-", 2)
            base = series.removeprefix("AV-")
            if (
                not SERIES.fullmatch(base)
                or base.startswith("AV")
                or len(year_text) != 4
                or not year_text.isascii()
                or not year_text.isdigit()
                or len(suffix) != 5
                or not suffix.isascii()
                or not suffix.isdigit()
                or not 1 <= int(suffix) <= 99_999
            ):
                raise ValueError
            year = int(year_text)
            if row.issued_at.tzinfo is None or row.issued_at.astimezone(PARIS).year != year:
                raise ValueError
        except (ValueError, AttributeError):
            raise IntegrityRefusedError("numbering_format_or_year") from None
        grouped[series, year].append((int(suffix), row.issued_at))
    for key in grouped.keys() | counters.keys():
        rows = sorted(grouped.get(key, []))
        counter = counters.get(key)
        if not isinstance(counter, int) or isinstance(counter, bool) or not 1 <= counter <= 99_999:
            raise IntegrityRefusedError("numbering_counter_invalid")
        if len(rows) != counter or any(n != i for i, (n, _) in enumerate(rows, start=1)):
            raise IntegrityRefusedError("numbering_gap")
        if any(right[1] < left[1] for left, right in zip(rows, rows[1:], strict=False)):
            raise IntegrityRefusedError("numbering_date_order")


def verify_database_series() -> None:
    """Take one repeatable-read snapshot; never compare counters and invoices across commits."""
    from django.db import connection, transaction

    from .models import CreditNote, Invoice, InvoiceNumberCounter

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        records = []
        for model in (Invoice, CreditNote):
            for number, issued in model.objects.exclude(number__isnull=True).values_list(
                "number", "issued_at"
            ):
                if number is None or issued is None:
                    raise IntegrityRefusedError("numbering_format_or_year")
                records.append(NumberedRecord(number, issued))
        counters = {
            (series, year): number
            for series, year, number in InvoiceNumberCounter.objects.values_list(
                "series", "year", "last_number"
            )
        }
        verify_series(records, counters)
