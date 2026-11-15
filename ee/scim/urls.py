"""URL routes for Enterprise SCIM 2.0 (`/api/v1/ee/scim/v2/*`).

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

from django.urls import URLPattern, path

from ee.scim.views import (
    group_detail_view,
    groups_collection_view,
    resource_types_view,
    schemas_view,
    service_provider_config_view,
    user_detail_view,
    users_collection_view,
)

urlpatterns: list[URLPattern] = [
    path("ServiceProviderConfig", service_provider_config_view, name="ee-scim-sp-config"),
    path("Schemas", schemas_view, name="ee-scim-schemas"),
    path("Schemas/<path:schema_id>", schemas_view, name="ee-scim-schema-detail"),
    path("ResourceTypes", resource_types_view, name="ee-scim-resource-types"),
    path(
        "ResourceTypes/<str:resource_type_id>",
        resource_types_view,
        name="ee-scim-resource-type-detail",
    ),
    path("Users", users_collection_view, name="ee-scim-users"),
    path("Users/<str:user_id>", user_detail_view, name="ee-scim-user-detail"),
    path("Groups", groups_collection_view, name="ee-scim-groups"),
    path("Groups/<str:group_id>", group_detail_view, name="ee-scim-group-detail"),
    # Explicit tenant-scoped SCIM base paths (`/api/v1/ee/scim/v2/tenants/<tenant_slug>/*`)
    path(
        "tenants/<slug:tenant_slug>/ServiceProviderConfig",
        service_provider_config_view,
        name="ee-scim-tenant-sp-config",
    ),
    path(
        "tenants/<slug:tenant_slug>/Schemas",
        schemas_view,
        name="ee-scim-tenant-schemas",
    ),
    path(
        "tenants/<slug:tenant_slug>/ResourceTypes",
        resource_types_view,
        name="ee-scim-tenant-resource-types",
    ),
    path(
        "tenants/<slug:tenant_slug>/Users",
        users_collection_view,
        name="ee-scim-tenant-users",
    ),
    path(
        "tenants/<slug:tenant_slug>/Users/<str:user_id>",
        user_detail_view,
        name="ee-scim-tenant-user-detail",
    ),
    path(
        "tenants/<slug:tenant_slug>/Groups",
        groups_collection_view,
        name="ee-scim-tenant-groups",
    ),
    path(
        "tenants/<slug:tenant_slug>/Groups/<str:group_id>",
        group_detail_view,
        name="ee-scim-tenant-group-detail",
    ),
]
