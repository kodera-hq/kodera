"""RFC 7643 / RFC 7644 SCIM 2.0 discovery schemas (`ServiceProviderConfig`, `Schemas`, `ResourceTypes`).

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error"
SCIM_LIST_RESPONSE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
SCIM_PATCH_OP_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
SCIM_SP_CONFIG_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"
SCIM_RESOURCE_TYPE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType"
SCIM_SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema"
SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
SCIM_ENTERPRISE_USER_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"
SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group"


def build_service_provider_config(base_url: str) -> dict[str, object]:
    return {
        "schemas": [SCIM_SP_CONFIG_SCHEMA],
        "documentationUri": "https://kodera.io",
        "patch": {"supported": True},
        "bulk": {"supported": False, "maxOperations": 0, "maxPayloadSize": 0},
        "filter": {"supported": True, "maxResults": 200},
        "changePassword": {"supported": False},
        "sort": {"supported": False},
        "etag": {"supported": True},
        "authenticationSchemes": [
            {
                "type": "oauthbearertoken",
                "name": "OAuth Bearer Token",
                "description": "Per-tenant SHA-256 hashed SCIM 2.0 Bearer Token",
                "specUri": "https://www.rfc-editor.org/rfc/rfc6750",
                "primary": True,
            }
        ],
        "meta": {
            "location": f"{base_url}/ServiceProviderConfig",
            "resourceType": "ServiceProviderConfig",
        },
    }


def build_resource_types(base_url: str) -> list[dict[str, object]]:
    return [
        {
            "schemas": [SCIM_RESOURCE_TYPE_SCHEMA],
            "id": "User",
            "name": "User",
            "endpoint": "/Users",
            "description": "SCIM 2.0 User Account",
            "schema": SCIM_USER_SCHEMA,
            "schemaExtensions": [{"schema": SCIM_ENTERPRISE_USER_SCHEMA, "required": False}],
            "meta": {
                "location": f"{base_url}/ResourceTypes/User",
                "resourceType": "ResourceType",
            },
        },
        {
            "schemas": [SCIM_RESOURCE_TYPE_SCHEMA],
            "id": "Group",
            "name": "Group",
            "endpoint": "/Groups",
            "description": "SCIM 2.0 Group",
            "schema": SCIM_GROUP_SCHEMA,
            "meta": {
                "location": f"{base_url}/ResourceTypes/Group",
                "resourceType": "ResourceType",
            },
        },
    ]


def build_schemas(base_url: str) -> list[dict[str, object]]:
    return [
        {
            "schemas": [SCIM_SCHEMA_SCHEMA],
            "id": SCIM_USER_SCHEMA,
            "name": "User",
            "description": "SCIM 2.0 Core User Schema",
            "attributes": [
                {
                    "name": "userName",
                    "type": "string",
                    "multiValued": False,
                    "required": True,
                    "caseExact": False,
                    "mutability": "readWrite",
                    "returned": "default",
                    "uniqueness": "server",
                },
                {
                    "name": "displayName",
                    "type": "string",
                    "multiValued": False,
                    "required": False,
                    "caseExact": False,
                    "mutability": "readWrite",
                    "returned": "default",
                    "uniqueness": "none",
                },
                {
                    "name": "active",
                    "type": "boolean",
                    "multiValued": False,
                    "required": False,
                    "mutability": "readWrite",
                    "returned": "default",
                },
                {
                    "name": "emails",
                    "type": "complex",
                    "multiValued": True,
                    "required": False,
                    "mutability": "readWrite",
                    "returned": "default",
                },
                {
                    "name": "groups",
                    "type": "complex",
                    "multiValued": True,
                    "required": False,
                    "mutability": "readOnly",
                    "returned": "default",
                },
            ],
            "meta": {
                "resourceType": "Schema",
                "location": f"{base_url}/Schemas/{SCIM_USER_SCHEMA}",
            },
        },
        {
            "schemas": [SCIM_SCHEMA_SCHEMA],
            "id": SCIM_GROUP_SCHEMA,
            "name": "Group",
            "description": "SCIM 2.0 Core Group Schema",
            "attributes": [
                {
                    "name": "displayName",
                    "type": "string",
                    "multiValued": False,
                    "required": True,
                    "caseExact": False,
                    "mutability": "readWrite",
                    "returned": "default",
                    "uniqueness": "server",
                },
                {
                    "name": "members",
                    "type": "complex",
                    "multiValued": True,
                    "required": False,
                    "mutability": "readWrite",
                    "returned": "default",
                },
            ],
            "meta": {
                "resourceType": "Schema",
                "location": f"{base_url}/Schemas/{SCIM_GROUP_SCHEMA}",
            },
        },
    ]
