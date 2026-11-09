"""Who a billing operation acts for."""

from dataclasses import dataclass
from uuid import UUID

ACTOR_TYPES = ("tenant", "staff", "system")


@dataclass(frozen=True, slots=True)
class Actor:
    """A tenant or staff identity, or the system, and the request it acts in when there is one."""

    type: str
    id: UUID | None
    request_id: str | None = None

    def __post_init__(self) -> None:
        if self.type not in ACTOR_TYPES:
            raise ValueError(f"{self.type!r} is not a billing actor")
        if (self.type == "system") != (self.id is None):
            raise ValueError("an identity actor names its identity; the system names none")
