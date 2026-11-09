"""Database clock expressions the job queue compares and writes."""

from django.db.models import DateTimeField, Func


class ClockTimestamp(Func):
    """PostgreSQL's clock_timestamp(): the instant of evaluation, never the statement's start.

    Django's Now() renders STATEMENT_TIMESTAMP(); a lease compared against it can expire during a
    wait without the comparison seeing it.
    """

    template = "clock_timestamp()"
    output_field = DateTimeField()
