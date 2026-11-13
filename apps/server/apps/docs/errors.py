"""Closed document refusals, independent of HTTP and persistence adapters."""


class RefusalError(ValueError):
    def __init__(self, status: int, kind: str | None = None) -> None:
        super().__init__("document operation refused")
        self.status = status
        self.kind = kind
