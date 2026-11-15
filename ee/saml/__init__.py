"""Enterprise SAML 2.0 Corporate Federation & Multi-IdP SSO (`ee/saml/`).

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

from ee.saml.service import (
    ProvisionedSamlPrincipal,
    SamlError,
    SamlIdpConfig,
    SamlService,
    default_saml_service,
)
from ee.saml.xml_security import (
    SamlSignatureError,
    SamlXmlSecurityError,
    XmlNode,
    exc_c14n,
    parse_hardened_xml,
)

__all__ = [
    "ProvisionedSamlPrincipal",
    "SamlError",
    "SamlIdpConfig",
    "SamlService",
    "SamlSignatureError",
    "SamlXmlSecurityError",
    "XmlNode",
    "default_saml_service",
    "exc_c14n",
    "parse_hardened_xml",
]
