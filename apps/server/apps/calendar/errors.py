"""Typed HTTP-mappable refusal errors for calendar, CalDAV, and booking operations."""

from __future__ import annotations


class CalendarRefusalError(ValueError):
    """Domain or security refusal mapped to an RFC 9457 problem response."""

    def __init__(
        self,
        status: int,
        reason: str | None = None,
        kind: str | None = None,
        *,
        current_etag: str | None = None,
    ) -> None:
        super().__init__(reason or kind or "calendar request refused")
        self.status = status
        self.reason = reason
        self.kind = kind
        self.current_etag = current_etag
