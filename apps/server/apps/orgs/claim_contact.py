"""Exact local-part comparison for the recorded intended owner's contact."""

from django.core.exceptions import ValidationError
from django.core.validators import validate_email


class ContactRefusedError(ValueError):
    """An intended-owner contact cannot be compared safely."""


def normalise_contact(value: str) -> str:
    if not isinstance(value, str):
        raise ContactRefusedError("owner contact refused")
    contact = value.strip()
    if not contact or len(contact) > 320 or contact.count("@") != 1:
        raise ContactRefusedError("owner contact refused")
    if any(character.isspace() or ord(character) < 32 for character in contact):
        raise ContactRefusedError("owner contact refused")
    try:
        validate_email(contact)
    except ValidationError:
        raise ContactRefusedError("owner contact refused") from None
    local, domain = contact.rsplit("@", 1)
    return f"{local}@{domain.lower()}"
