"""Query-free stored-fact projection; unknown provider facts remain absent, and so does a contact
directory privacy withholds from the caller (apps/orgs/membership_selectors.py)."""

import json

from django.core.validators import EmailValidator

from apps.orgs.membership_services import DirectoryPage

EMAIL = EmailValidator(allowlist=[])


def _contact(email: str) -> str:
    if not isinstance(email, str) or len(email) > 320 or any(char in email for char in "\r\n"):
        raise ValueError("stored contact is outside the projection contract")
    EMAIL(email)
    return email


def serialize_page(page: DirectoryPage) -> str:
    data = []
    for row in page.rows:
        item = row.membership
        if row.display_name is not None and (
            not isinstance(row.display_name, str) or len(row.display_name) > 200
        ):
            raise ValueError("stored display name is outside the projection contract")
        entry: dict[str, object] = {
            "id": str(item.id),
            "organisation_id": str(item.organisation_id),
            "display_name": row.display_name,
            "role": item.role,
            "state": item.state,
            "created_at": item.created_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "updated_at": item.updated_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        }
        # Directory privacy: a withheld contact is absent, never null, masked or partial.
        if row.email is not None:
            entry["email"] = _contact(row.email)
        data.append(entry)
    return json.dumps(
        {"data": data, "has_more": page.has_more, "next_cursor": page.next_cursor},
        ensure_ascii=False,
        separators=(",", ":"),
    )
