"""URL routes for Enterprise SAML 2.0 SSO (`/api/v1/ee/sso/saml/*`).

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

from django.urls import URLPattern, path

from ee.saml.views import acs_view, login_view, metadata_view, providers_view

urlpatterns: list[URLPattern] = [
    path("<slug:tenant_slug>/metadata", metadata_view, name="ee-saml-metadata"),
    path("<slug:tenant_slug>/providers", providers_view, name="ee-saml-providers"),
    path("<slug:tenant_slug>/login", login_view, name="ee-saml-login"),
    path("<slug:tenant_slug>/acs", acs_view, name="ee-saml-acs"),
]
