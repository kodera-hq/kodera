"""Query-free stored-fact projection; unknown provider facts remain absent."""

import json

from django.core.validators import EmailValidator

from apps.orgs.membership_services import DirectoryPage

EMAIL = EmailValidator(allowlist=[])


def serialize_page(page: DirectoryPage) -> str:
    data = []
    for row in page.rows:
        item, person = row.membership, row.person
        if (
            not isinstance(person.email, str)
            or len(person.email) > 320
            or any(char in person.email for char in "\r\n")
        ):
            raise ValueError("stored contact is outside the projection contract")
        EMAIL(person.email)
        if person.display_name is not None and (
            not isinstance(person.display_name, str) or len(person.display_name) > 200
        ):
            raise ValueError("stored display name is outside the projection contract")
        data.append(
            {
                "id": str(item.id),
                "organisation_id": str(item.organisation_id),
                "email": person.email,
                "display_name": person.display_name,
                "role": item.role,
                "state": item.state,
                "created_at": item.created_at.isoformat(timespec="milliseconds").replace(
                    "+00:00", "Z"
                ),
                "updated_at": item.updated_at.isoformat(timespec="milliseconds").replace(
                    "+00:00", "Z"
                ),
            }
        )
    return json.dumps(
        {"data": data, "has_more": page.has_more, "next_cursor": page.next_cursor},
        ensure_ascii=False,
        separators=(",", ":"),
    )
