"""Instants as Core's mails print them: in Paris time, in the mail's language, never an ISO stamp
(a person reads « valable jusqu'au 7 novembre 2026 à 15 h 32 », not `2026-11-07T14:32:05+00:00`)."""

from datetime import datetime
from zoneinfo import ZoneInfo

PARIS = ZoneInfo("Europe/Paris")
NBSP = "\u00a0"
_MONTHS = {
    "fr": (
        "janvier",
        "février",
        "mars",
        "avril",
        "mai",
        "juin",
        "juillet",
        "août",
        "septembre",
        "octobre",
        "novembre",
        "décembre",
    ),
    "en": (
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ),
}


def mail_instant(when: datetime, locale: str) -> str:
    """`7 novembre 2026 à 15 h 32` in French, `7 November 2026 at 15:32 (Paris time)` in English.
    The time's spaces are non-breaking, so a wrapped line never splits « 15 h 32 ». A naive
    datetime is refused: it names no instant."""
    if when.tzinfo is None or when.utcoffset() is None:
        raise ValueError("a mail instant needs a timezone")
    local = when.astimezone(PARIS)
    month = _MONTHS[locale][local.month - 1]
    if locale == "fr":
        day = "1er" if local.day == 1 else str(local.day)
        return f"{day} {month} {local.year} à {local.hour}{NBSP}h{NBSP}{local.minute:02d}"
    return f"{local.day} {month} {local.year} at {local.hour:02d}:{local.minute:02d} (Paris time)"
