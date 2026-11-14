"""Hardened XML parser, Exclusive XML Canonicalization (`exc-c14n`), and XSW-proof verifier.

Security invariants:
- Rejects `DOCTYPE`, `!ENTITY`, `!ELEMENT`, `!ATTLIST`, `!NOTATION`, non-UTF-8 BOMs, null bytes,
  processing instructions, XInclude, and unknown entity references BEFORE invoking the parser, AND
  enforces C-level Expat declaration traps as defense in depth.
- Enforces bounded XML byte length, element count, and nesting depth.
- Preserves exact namespace prefixes and implements W3C Exclusive XML Canonicalization 1.0
  (`http://www.w3.org/2001/10/xml-exc-c14n#`) with `EnvelopedSignature` removal.
- Prevents XML Signature Wrapping (XSW1-XSW8): enforces globally unique `ID` attributes across the
  entire document, requires root `<samlp:Response>` with at most/exact single `<saml:Assertion>`
  anywhere in the tree as a direct child of `<samlp:Response>`, and verifies RSA-SHA256 or
  ECDSA-SHA256 signatures over the exact element referenced by `#ID`.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
from dataclasses import dataclass, field
from typing import Final
from xml.parsers import expat

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)

SAML_PROTOCOL_NS: Final[str] = "urn:oasis:names:tc:SAML:2.0:protocol"
SAML_ASSERTION_NS: Final[str] = "urn:oasis:names:tc:SAML:2.0:assertion"
SAML_METADATA_NS: Final[str] = "urn:oasis:names:tc:SAML:2.0:metadata"
XMLDSIG_NS: Final[str] = "http://www.w3.org/2000/09/xmldsig#"
EXC_C14N_ALG: Final[str] = "http://www.w3.org/2001/10/xml-exc-c14n#"
ENVELOPED_SIG_ALG: Final[str] = "http://www.w3.org/2000/09/xmldsig#enveloped-signature"
SHA256_DIGEST_ALG: Final[str] = "http://www.w3.org/2001/04/xmlenc#sha256"
RSA_SHA256_SIG_ALG: Final[str] = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
ECDSA_SHA256_SIG_ALG: Final[str] = "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"
XINCLUDE_NS: Final[str] = "http://www.w3.org/2001/XInclude"
XML_NS: Final[str] = "http://www.w3.org/XML/1998/namespace"
XMLNS_NS: Final[str] = "http://www.w3.org/2000/xmlns/"

MAX_SAML_XML_BYTES: Final[int] = 262_144
MAX_XML_DEPTH: Final[int] = 28
MAX_XML_ELEMENTS: Final[int] = 600

_FORBIDDEN_PROLOG_RE = re.compile(
    r"<!\s*(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)\b",
    re.IGNORECASE,
)
_XML_DECL_RE = re.compile(r"\A\s*<\?xml(?:\s+[^?]*)?\?>", re.IGNORECASE)
_PI_RE = re.compile(r"<\?(?!xml\b)", re.IGNORECASE)
_ENCODING_ATTR_RE = re.compile(r"""encoding\s*=\s*['"]([^'"]+)['"]""", re.IGNORECASE)
_ENTITY_REF_RE = re.compile(r"&([^;\s]{1,64});|&(?![a-zA-Z0-9#]{1,10};)")
_PREDEFINED_ENTITIES = frozenset({"amp", "lt", "gt", "quot", "apos"})
_NUMERIC_DEC_RE = re.compile(r"#([0-9]{1,7})\Z")
_NUMERIC_HEX_RE = re.compile(r"#x([0-9a-fA-F]{1,6})\Z")


class SamlXmlSecurityError(ValueError):
    """Raised when an XML payload violates XXE, DTD, encoding, or structural bounds."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class SamlSignatureError(ValueError):
    """Raised when XMLDSig verification or XSW structural validation fails."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(slots=True)
class XmlAttribute:
    qname: str
    prefix: str
    local_name: str
    ns_uri: str
    value: str


@dataclass(slots=True)
class XmlNode:
    qname: str
    prefix: str
    local_name: str
    ns_uri: str
    ns_decls: dict[str, str]
    in_scope_ns: dict[str, str]
    attributes: list[XmlAttribute] = field(default_factory=list)
    children: list[XmlNode | str] = field(default_factory=list)
    parent: XmlNode | None = field(default=None, repr=False)

    def attr(self, local_name: str, ns_uri: str = "") -> str | None:
        for item in self.attributes:
            if item.local_name == local_name and item.ns_uri == ns_uri:
                return item.value
        return None

    @property
    def element_children(self) -> list[XmlNode]:
        return [child for child in self.children if isinstance(child, XmlNode)]

    def find_children(self, ns_uri: str, local_name: str) -> list[XmlNode]:
        return [
            child
            for child in self.children
            if isinstance(child, XmlNode)
            and child.ns_uri == ns_uri
            and child.local_name == local_name
        ]

    def find_first_child(self, ns_uri: str, local_name: str) -> XmlNode | None:
        matches = self.find_children(ns_uri, local_name)
        return matches[0] if matches else None

    def iter_elements(self) -> list[XmlNode]:
        out: list[XmlNode] = [self]
        for child in self.children:
            if isinstance(child, XmlNode):
                out.extend(child.iter_elements())
        return out

    def text_content(self, *, forbid_child_elements: bool = False) -> str:
        parts: list[str] = []
        for child in self.children:
            if isinstance(child, XmlNode):
                if forbid_child_elements:
                    raise SamlXmlSecurityError(
                        "unexpected_child_element",
                        f"Element {self.local_name} must not contain child elements",
                    )
            else:
                parts.append(child)
        return "".join(parts)


def _split_qname(qname: str) -> tuple[str, str]:
    if ":" not in qname:
        return "", qname
    parts = qname.split(":")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise SamlXmlSecurityError("malformed_qname", "Malformed XML qualified name")
    return parts[0], parts[1]


def _validate_raw_xml_preparse(raw_xml: bytes | str) -> str:
    if isinstance(raw_xml, bytes):
        if len(raw_xml) == 0 or len(raw_xml) > MAX_SAML_XML_BYTES:
            raise SamlXmlSecurityError(
                "xml_size_limit", "SAML XML size is outside permitted bounds"
            )
        if raw_xml.startswith((b"\xff\xfe", b"\xfe\xff", b"\x00\x00\xfe\xff", b"\xff\xfe\x00\x00")):
            raise SamlXmlSecurityError(
                "forbidden_encoding", "UTF-16/UTF-32 XML encodings are forbidden"
            )
        if b"\x00" in raw_xml:
            raise SamlXmlSecurityError(
                "null_byte_forbidden", "Null bytes are forbidden in SAML XML"
            )
        raw_upper = raw_xml.upper()
        for marker in (b"<!DOCTYPE", b"<!ENTITY", b"<!ELEMENT", b"<!ATTLIST", b"<!NOTATION"):
            if marker in raw_upper:
                raise SamlXmlSecurityError(
                    "dtd_or_entity_forbidden",
                    "XML DTD and entity declarations are strictly forbidden",
                )
        try:
            text = raw_xml.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise SamlXmlSecurityError("invalid_utf8", "SAML XML must be valid UTF-8") from exc
    else:
        encoded = raw_xml.encode("utf-8")
        if len(encoded) == 0 or len(encoded) > MAX_SAML_XML_BYTES:
            raise SamlXmlSecurityError(
                "xml_size_limit", "SAML XML size is outside permitted bounds"
            )
        if "\x00" in raw_xml:
            raise SamlXmlSecurityError(
                "null_byte_forbidden", "Null bytes are forbidden in SAML XML"
            )
        text = raw_xml

    text = text.lstrip("\ufeff")
    if _FORBIDDEN_PROLOG_RE.search(text):
        raise SamlXmlSecurityError(
            "dtd_or_entity_forbidden",
            "XML DTD and entity declarations are strictly forbidden",
        )

    decl_match = _XML_DECL_RE.match(text)
    if decl_match is not None:
        enc_match = _ENCODING_ATTR_RE.search(decl_match.group(0))
        if enc_match is not None and enc_match.group(1).strip().upper() != "UTF-8":
            raise SamlXmlSecurityError(
                "forbidden_encoding", "Only UTF-8 XML declarations are allowed"
            )
        remainder = text[decl_match.end() :]
    else:
        remainder = text

    if "<?xml" in remainder.lower() or _PI_RE.search(text):
        raise SamlXmlSecurityError(
            "processing_instruction_forbidden",
            "XML processing instructions are forbidden",
        )

    if "<!--" in text:
        raise SamlXmlSecurityError(
            "xml_comments_forbidden",
            "XML comments are forbidden in SAML payloads to prevent comment-truncation attacks",
        )

    if "<![CDATA[" in text:
        raise SamlXmlSecurityError(
            "cdata_forbidden",
            "CDATA sections are forbidden in SAML assertions",
        )

    for match in _ENTITY_REF_RE.finditer(text):
        ref = match.group(1)
        if ref is None:
            raise SamlXmlSecurityError(
                "unterminated_entity", "Malformed ampersand or entity reference"
            )
        if ref in _PREDEFINED_ENTITIES:
            continue
        dec = _NUMERIC_DEC_RE.match(ref)
        hex_m = _NUMERIC_HEX_RE.match(ref)
        codepoint: int | None = None
        if dec is not None:
            codepoint = int(dec.group(1), 10)
        elif hex_m is not None:
            codepoint = int(hex_m.group(1), 16)
        if codepoint is None:
            raise SamlXmlSecurityError(
                "external_or_custom_entity_forbidden",
                f"Custom or external XML entity reference '&{ref};' is forbidden",
            )
        if codepoint == 0 or codepoint > 0x10FFFF or 0xD800 <= codepoint <= 0xDFFF:
            raise SamlXmlSecurityError("invalid_char_ref", "Invalid numeric character reference")

    return text


def parse_hardened_xml(raw_xml: bytes | str) -> XmlNode:
    """Parse XML into a prefix-preserving `XmlNode` tree with strict XXE/DTD/ID hardening."""
    text = _validate_raw_xml_preparse(raw_xml)

    parser = expat.ParserCreate("UTF-8", None)
    parser.buffer_text = True

    def _forbid_decl(*_args: object) -> None:
        raise SamlXmlSecurityError(
            "dtd_or_entity_forbidden",
            "Expat rejected forbidden DTD/entity/processing construct",
        )

    def _forbid_external_ref(*_args: object) -> int:
        raise SamlXmlSecurityError(
            "external_entity_forbidden", "External entity resolution forbidden"
        )

    parser.StartDoctypeDeclHandler = _forbid_decl
    parser.EntityDeclHandler = _forbid_decl
    parser.UnparsedEntityDeclHandler = _forbid_decl
    parser.NotationDeclHandler = _forbid_decl
    parser.ProcessingInstructionHandler = _forbid_decl
    parser.CommentHandler = _forbid_decl
    parser.StartCdataSectionHandler = _forbid_decl
    parser.ExternalEntityRefHandler = _forbid_external_ref

    stack: list[XmlNode] = []
    roots: list[XmlNode] = []
    element_count = 0
    seen_ids: set[str] = set()

    def _on_start(name: str, attrs: dict[str, str]) -> None:
        nonlocal element_count
        element_count += 1
        if element_count > MAX_XML_ELEMENTS:
            raise SamlXmlSecurityError("xml_element_limit", "XML exceeds maximum element count")
        if len(stack) + 1 > MAX_XML_DEPTH:
            raise SamlXmlSecurityError("xml_depth_limit", "XML exceeds maximum nesting depth")

        inherited_ns = dict(stack[-1].in_scope_ns) if stack else {"": "", "xml": XML_NS}
        ns_decls: dict[str, str] = {}
        raw_non_ns_attrs: list[tuple[str, str]] = []

        for attr_name, attr_val in attrs.items():
            if attr_name == "xmlns":
                ns_decls[""] = attr_val
                inherited_ns[""] = attr_val
            elif attr_name.startswith("xmlns:"):
                ns_prefix = attr_name[6:]
                if not ns_prefix or ":" in ns_prefix or ns_prefix in {"xml", "xmlns"}:
                    raise SamlXmlSecurityError("invalid_xmlns", "Invalid xmlns prefix declaration")
                if not attr_val:
                    raise SamlXmlSecurityError("empty_xmlns_uri", "Empty namespace URI on prefix")
                ns_decls[ns_prefix] = attr_val
                inherited_ns[ns_prefix] = attr_val
            else:
                raw_non_ns_attrs.append((attr_name, attr_val))

        if XINCLUDE_NS in ns_decls.values():
            raise SamlXmlSecurityError("xinclude_forbidden", "XInclude namespace is forbidden")

        el_prefix, el_local = _split_qname(name)
        if el_prefix not in inherited_ns or (el_prefix != "" and inherited_ns[el_prefix] == ""):
            raise SamlXmlSecurityError("unbound_prefix", f"Unbound XML prefix '{el_prefix}'")
        el_ns = inherited_ns[el_prefix]
        if el_ns == XINCLUDE_NS:
            raise SamlXmlSecurityError("xinclude_forbidden", "XInclude elements are forbidden")

        parsed_attrs: list[XmlAttribute] = []
        id_candidates_on_node = 0
        for attr_qname, attr_val in raw_non_ns_attrs:
            a_prefix, a_local = _split_qname(attr_qname)
            if a_prefix == "":
                a_ns = ""
            else:
                if a_prefix not in inherited_ns or inherited_ns[a_prefix] == "":
                    raise SamlXmlSecurityError(
                        "unbound_attr_prefix",
                        f"Unbound attribute prefix '{a_prefix}'",
                    )
                a_ns = inherited_ns[a_prefix]

            if (
                a_ns == ""
                and a_local in {"Id", "id"}
                and el_ns in {SAML_PROTOCOL_NS, SAML_ASSERTION_NS}
            ):
                raise SamlXmlSecurityError(
                    "ambiguous_id_attribute",
                    "SAML elements must use exact 'ID' attribute casing",
                )
            if a_ns == "" and a_local == "ID":
                id_candidates_on_node += 1
                if not attr_val or any(ch.isspace() for ch in attr_val):
                    raise SamlXmlSecurityError(
                        "invalid_xml_id", "Empty or whitespace XML ID attribute"
                    )
                if attr_val in seen_ids:
                    raise SamlXmlSecurityError(
                        "duplicate_xml_id",
                        "Duplicate XML ID attribute detected across document",
                    )
                seen_ids.add(attr_val)

            parsed_attrs.append(
                XmlAttribute(
                    qname=attr_qname,
                    prefix=a_prefix,
                    local_name=a_local,
                    ns_uri=a_ns,
                    value=attr_val,
                )
            )

        if id_candidates_on_node > 1:
            raise SamlXmlSecurityError("duplicate_xml_id", "Multiple ID attributes on one element")

        parent = stack[-1] if stack else None
        node = XmlNode(
            qname=name,
            prefix=el_prefix,
            local_name=el_local,
            ns_uri=el_ns,
            ns_decls=ns_decls,
            in_scope_ns=inherited_ns,
            attributes=parsed_attrs,
            parent=parent,
        )
        if parent is not None:
            parent.children.append(node)
        else:
            roots.append(node)
        stack.append(node)

    def _on_end(_name: str) -> None:
        stack.pop()

    def _on_char_data(data: str) -> None:
        if not stack:
            return
        cur = stack[-1]
        if cur.children and isinstance(cur.children[-1], str):
            cur.children[-1] += data
        else:
            cur.children.append(data)

    parser.StartElementHandler = _on_start
    parser.EndElementHandler = _on_end
    parser.CharacterDataHandler = _on_char_data

    try:
        parser.Parse(text.encode("utf-8"), True)
    except expat.ExpatError as exc:
        raise SamlXmlSecurityError("malformed_xml", "Malformed SAML XML document") from exc

    if len(roots) != 1:
        raise SamlXmlSecurityError(
            "malformed_xml", "XML document must contain a single root element"
        )

    return roots[0]


def _escape_c14n_text(value: str) -> str:
    return (
        value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\r", "&#xD;")
    )


def _escape_c14n_attr(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace('"', "&quot;")
        .replace("\t", "&#x9;")
        .replace("\n", "&#xA;")
        .replace("\r", "&#xD;")
    )


def exc_c14n(
    element: XmlNode,
    *,
    inclusive_prefixes: set[str] | None = None,
    strip_signature: XmlNode | None = None,
) -> bytes:
    """Serialize `element` according to W3C Exclusive XML Canonicalization 1.0 (`exc-c14n#`)."""
    inc = set() if inclusive_prefixes is None else set(inclusive_prefixes)
    if "#default" in inc:
        inc.discard("#default")
        inc.add("")

    chunks: list[str] = []

    def _render(node: XmlNode, rendered_ns: dict[str, str]) -> None:
        if strip_signature is not None and node is strip_signature:
            return

        new_rendered = dict(rendered_ns)
        utilized_prefixes: set[str] = {node.prefix}
        for attr in node.attributes:
            if attr.prefix and attr.prefix != "xml":
                utilized_prefixes.add(attr.prefix)
        for prefix in inc:
            if prefix in node.in_scope_ns:
                utilized_prefixes.add(prefix)

        ns_to_emit: list[tuple[str, str]] = []
        for prefix in sorted(utilized_prefixes):
            if prefix == "xml":
                continue
            uri = node.in_scope_ns.get(prefix, "")
            if prefix == "":
                if uri == "":
                    if new_rendered.get("", "") != "":
                        ns_to_emit.append(("", ""))
                        new_rendered[""] = ""
                elif new_rendered.get("", "") != uri:
                    ns_to_emit.append(("", uri))
                    new_rendered[""] = uri
            else:
                if uri and new_rendered.get(prefix) != uri:
                    ns_to_emit.append((prefix, uri))
                    new_rendered[prefix] = uri

        sorted_attrs = sorted(
            node.attributes,
            key=lambda a: (a.ns_uri, a.local_name),
        )

        chunks.append(f"<{node.qname}")
        for prefix, uri in ns_to_emit:
            if prefix == "":
                chunks.append(f' xmlns="{_escape_c14n_attr(uri)}"')
            else:
                chunks.append(f' xmlns:{prefix}="{_escape_c14n_attr(uri)}"')
        for attr in sorted_attrs:
            chunks.append(f' {attr.qname}="{_escape_c14n_attr(attr.value)}"')
        chunks.append(">")

        for child in node.children:
            if isinstance(child, XmlNode):
                _render(child, new_rendered)
            else:
                chunks.append(_escape_c14n_text(child))

        chunks.append(f"</{node.qname}>")

    _render(element, {"": ""})
    return "".join(chunks).encode("utf-8")


PublicVerificationKey = rsa.RSAPublicKey | ec.EllipticCurvePublicKey


def load_idp_verification_key(pem_material: str) -> PublicVerificationKey:
    """Load an RSA (>= 2048-bit) or ECDSA P-256 public key from an X.509 cert or public key PEM."""
    raw = pem_material.strip().encode("utf-8")
    pub_key: object
    if b"BEGIN CERTIFICATE" in raw:
        cert = x509.load_pem_x509_certificate(raw)
        pub_key = cert.public_key()
    else:
        pub_key = serialization.load_pem_public_key(raw)

    if isinstance(pub_key, rsa.RSAPublicKey):
        if pub_key.key_size < 2048:
            raise ValueError("SAML IdP RSA key must be at least 2048 bits")
        return pub_key
    if isinstance(pub_key, ec.EllipticCurvePublicKey):
        if not isinstance(pub_key.curve, ec.SECP256R1):
            raise ValueError("SAML IdP ECDSA key must use NIST P-256 (secp256r1)")
        return pub_key
    raise ValueError("Unsupported SAML IdP key type; only RSA and ECDSA P-256 are supported")


def _extract_inclusive_prefixes(transform_or_c14n_node: XmlNode) -> set[str]:
    prefixes: set[str] = set()
    for child in transform_or_c14n_node.element_children:
        if child.ns_uri == EXC_C14N_ALG and child.local_name == "InclusiveNamespaces":
            raw_list = child.attr("PrefixList") or ""
            prefixes.update(token for token in raw_list.split() if token)
    return prefixes


def _verify_raw_signature_bytes(
    public_key: PublicVerificationKey,
    sig_alg: str,
    signed_bytes: bytes,
    signature_bytes: bytes,
) -> None:
    if sig_alg == RSA_SHA256_SIG_ALG:
        if not isinstance(public_key, rsa.RSAPublicKey):
            raise SamlSignatureError(
                "key_algorithm_mismatch", "RSA-SHA256 signature requires RSA key"
            )
        try:
            public_key.verify(signature_bytes, signed_bytes, padding.PKCS1v15(), hashes.SHA256())
        except InvalidSignature as exc:
            raise SamlSignatureError(
                "invalid_signature", "RSA-SHA256 signature verification failed"
            ) from exc
        return

    if sig_alg == ECDSA_SHA256_SIG_ALG:
        if not isinstance(public_key, ec.EllipticCurvePublicKey):
            raise SamlSignatureError(
                "key_algorithm_mismatch",
                "ECDSA-SHA256 signature requires ECDSA P-256 key",
            )
        # XMLDSig ECDSA-SHA256 (RFC 4050 / XMLDSig 1.1) encodes raw IEEE P1363 (r || s), 64 bytes for P-256.
        if len(signature_bytes) != 64:
            raise SamlSignatureError(
                "invalid_ecdsa_signature_length",
                "XMLDSig ECDSA-SHA256 signature must be 64-byte IEEE P1363 (r || s)",
            )
        r_int = int.from_bytes(signature_bytes[:32], "big")
        s_int = int.from_bytes(signature_bytes[32:], "big")
        der_sig = encode_dss_signature(r_int, s_int)
        try:
            public_key.verify(der_sig, signed_bytes, ec.ECDSA(hashes.SHA256()))
        except InvalidSignature as exc:
            raise SamlSignatureError(
                "invalid_signature",
                "ECDSA-SHA256 signature verification failed",
            ) from exc
        return

    raise SamlSignatureError(
        "unsupported_signature_algorithm",
        f"Forbidden or unsupported SAML SignatureMethod: {sig_alg}",
    )


def _verify_enveloped_signature_on_node(
    target_node: XmlNode,
    sig_node: XmlNode,
    public_key: PublicVerificationKey,
) -> None:
    """Verify `<ds:Signature>` directly attached to `target_node` (`Assertion` or `Response`)."""
    target_id = target_node.attr("ID")
    if not target_id:
        raise SamlSignatureError(
            "missing_signed_element_id", "Signed SAML element lacks an ID attribute"
        )

    signed_infos = sig_node.find_children(XMLDSIG_NS, "SignedInfo")
    sig_values = sig_node.find_children(XMLDSIG_NS, "SignatureValue")
    # Forbid <ds:Object> inside <ds:Signature> (defeats XSW7 / XSW8 object-wrapping payloads).
    if sig_node.find_children(XMLDSIG_NS, "Object"):
        raise SamlSignatureError(
            "signature_object_forbidden",
            "ds:Object elements inside ds:Signature are forbidden (XSW7/XSW8 defense)",
        )
    if len(signed_infos) != 1 or len(sig_values) != 1:
        raise SamlSignatureError(
            "malformed_signature", "Signature requires single SignedInfo and SignatureValue"
        )

    signed_info = signed_infos[0]
    c14n_methods = signed_info.find_children(XMLDSIG_NS, "CanonicalizationMethod")
    sig_methods = signed_info.find_children(XMLDSIG_NS, "SignatureMethod")
    references = signed_info.find_children(XMLDSIG_NS, "Reference")

    if len(c14n_methods) != 1 or len(sig_methods) != 1 or len(references) != 1:
        raise SamlSignatureError(
            "malformed_signed_info",
            "SignedInfo must contain exactly one CanonicalizationMethod, SignatureMethod, and Reference",
        )

    c14n_alg = c14n_methods[0].attr("Algorithm") or ""
    if c14n_alg != EXC_C14N_ALG:
        raise SamlSignatureError(
            "unsupported_c14n_algorithm",
            "CanonicalizationMethod must be Exclusive XML Canonicalization 1.0 (exc-c14n#)",
        )
    signed_info_prefixes = _extract_inclusive_prefixes(c14n_methods[0])

    sig_alg = sig_methods[0].attr("Algorithm") or ""
    if sig_alg not in {RSA_SHA256_SIG_ALG, ECDSA_SHA256_SIG_ALG}:
        raise SamlSignatureError(
            "unsupported_signature_algorithm",
            "Only RSA-SHA256 and ECDSA-SHA256 SAML signatures are allowed",
        )

    reference = references[0]
    ref_uri = reference.attr("URI")
    if ref_uri is None or not ref_uri.startswith("#") or ref_uri != f"#{target_id}":
        raise SamlSignatureError(
            "reference_uri_mismatch",
            "ds:Reference URI must match the exact #ID of its parent signed element",
        )

    transforms_containers = reference.find_children(XMLDSIG_NS, "Transforms")
    if len(transforms_containers) != 1:
        raise SamlSignatureError(
            "missing_transforms", "ds:Reference must declare explicit Transforms"
        )
    transforms = transforms_containers[0].find_children(XMLDSIG_NS, "Transform")
    if len(transforms) != 2:
        raise SamlSignatureError(
            "invalid_transforms",
            "ds:Transforms must contain exactly enveloped-signature followed by exc-c14n#",
        )
    if (transforms[0].attr("Algorithm") or "") != ENVELOPED_SIG_ALG:
        raise SamlSignatureError(
            "invalid_transforms", "First transform must be enveloped-signature"
        )
    if (transforms[1].attr("Algorithm") or "") != EXC_C14N_ALG:
        raise SamlSignatureError("invalid_transforms", "Second transform must be exc-c14n#")
    ref_prefixes = _extract_inclusive_prefixes(transforms[1])

    digest_methods = reference.find_children(XMLDSIG_NS, "DigestMethod")
    digest_values = reference.find_children(XMLDSIG_NS, "DigestValue")
    if len(digest_methods) != 1 or len(digest_values) != 1:
        raise SamlSignatureError(
            "malformed_reference", "Reference requires DigestMethod and DigestValue"
        )
    if (digest_methods[0].attr("Algorithm") or "") != SHA256_DIGEST_ALG:
        raise SamlSignatureError("unsupported_digest_algorithm", "DigestMethod must be SHA-256")

    try:
        expected_digest = base64.b64decode(
            digest_values[0].text_content(forbid_child_elements=True).strip(),
            validate=True,
        )
        raw_signature = base64.b64decode(
            sig_values[0].text_content(forbid_child_elements=True).strip(),
            validate=True,
        )
    except Exception as exc:
        raise SamlSignatureError(
            "invalid_base64", "Invalid base64 in DigestValue or SignatureValue"
        ) from exc

    canonical_target = exc_c14n(
        target_node,
        inclusive_prefixes=ref_prefixes,
        strip_signature=sig_node,
    )
    computed_digest = hashlib.sha256(canonical_target).digest()
    if not hmac.compare_digest(computed_digest, expected_digest):
        raise SamlSignatureError(
            "digest_mismatch", "Computed SHA-256 digest does not match DigestValue"
        )

    canonical_signed_info = exc_c14n(signed_info, inclusive_prefixes=signed_info_prefixes)
    _verify_raw_signature_bytes(public_key, sig_alg, canonical_signed_info, raw_signature)


def verify_saml_response_tree(
    response_root: XmlNode,
    public_key: PublicVerificationKey,
    *,
    want_assertions_signed: bool = True,
) -> XmlNode:
    """Verify `<samlp:Response>` structure and signature(s), returning the single verified `<Assertion>`."""
    if response_root.ns_uri != SAML_PROTOCOL_NS or response_root.local_name != "Response":
        raise SamlSignatureError("invalid_root_element", "Root element must be samlp:Response")

    all_nodes = response_root.iter_elements()
    all_assertions = [
        node
        for node in all_nodes
        if node.ns_uri == SAML_ASSERTION_NS and node.local_name == "Assertion"
    ]
    encrypted_assertions = [
        node
        for node in all_nodes
        if node.ns_uri == SAML_ASSERTION_NS and node.local_name == "EncryptedAssertion"
    ]
    if encrypted_assertions:
        raise SamlSignatureError(
            "encrypted_assertion_unsupported", "EncryptedAssertion is not enabled"
        )

    if len(all_assertions) != 1:
        raise SamlSignatureError(
            "invalid_assertion_count",
            "SAML Response must contain exactly one Assertion across the entire XML tree",
        )

    assertion_node = all_assertions[0]
    if assertion_node.parent is not response_root:
        raise SamlSignatureError(
            "wrapped_assertion_detected",
            "SAML Assertion must be a direct child of root samlp:Response (XSW defense)",
        )

    # Reject any unexpected <ds:Signature> placed anywhere outside Response or Assertion direct children.
    all_signatures = [
        node for node in all_nodes if node.ns_uri == XMLDSIG_NS and node.local_name == "Signature"
    ]
    response_sigs = response_root.find_children(XMLDSIG_NS, "Signature")
    assertion_sigs = assertion_node.find_children(XMLDSIG_NS, "Signature")
    if len(response_sigs) > 1 or len(assertion_sigs) > 1:
        raise SamlSignatureError(
            "multiple_signatures", "At most one Signature per Response/Assertion allowed"
        )
    if len(all_signatures) != len(response_sigs) + len(assertion_sigs):
        raise SamlSignatureError(
            "stray_signature_detected",
            "Unexpected nested ds:Signature detected outside Response/Assertion",
        )

    if want_assertions_signed and not assertion_sigs:
        raise SamlSignatureError(
            "unsigned_assertion",
            "Tenant policy requires the SAML Assertion element itself to be signed",
        )
    if not response_sigs and not assertion_sigs:
        raise SamlSignatureError(
            "missing_signature", "Neither SAML Response nor Assertion is signed"
        )

    # Verify EVERY present signature so an attacker cannot pair one valid outer signature with a tampered inner one.
    if response_sigs:
        _verify_enveloped_signature_on_node(response_root, response_sigs[0], public_key)
    if assertion_sigs:
        _verify_enveloped_signature_on_node(assertion_node, assertion_sigs[0], public_key)

    return assertion_node


def sign_enveloped_xml(
    xml_text: str,
    target_id: str,
    private_key: rsa.RSAPrivateKey | ec.EllipticCurvePrivateKey,
) -> str:
    """Attach a W3C `exc-c14n#` enveloped RSA-SHA256 or ECDSA-SHA256 signature to element `target_id`."""
    tree = parse_hardened_xml(xml_text)
    target_node: XmlNode | None = None
    for node in tree.iter_elements():
        if node.attr("ID") == target_id:
            target_node = node
            break
    if target_node is None:
        raise ValueError(f"Target element ID={target_id!r} not found")

    digest_b64 = base64.b64encode(hashlib.sha256(exc_c14n(target_node)).digest()).decode("ascii")
    if isinstance(private_key, rsa.RSAPrivateKey):
        sig_alg = RSA_SHA256_SIG_ALG
    elif isinstance(private_key, ec.EllipticCurvePrivateKey):
        sig_alg = ECDSA_SHA256_SIG_ALG
    else:
        raise TypeError("Unsupported private key type for XML signing")

    signed_info_xml = (
        f'<ds:SignedInfo xmlns:ds="{XMLDSIG_NS}">'
        f'<ds:CanonicalizationMethod Algorithm="{EXC_C14N_ALG}"/>'
        f'<ds:SignatureMethod Algorithm="{sig_alg}"/>'
        f'<ds:Reference URI="#{target_id}">'
        "<ds:Transforms>"
        f'<ds:Transform Algorithm="{ENVELOPED_SIG_ALG}"/>'
        f'<ds:Transform Algorithm="{EXC_C14N_ALG}"/>'
        "</ds:Transforms>"
        f'<ds:DigestMethod Algorithm="{SHA256_DIGEST_ALG}"/>'
        f"<ds:DigestValue>{digest_b64}</ds:DigestValue>"
        "</ds:Reference>"
        "</ds:SignedInfo>"
    )
    signed_info_node = parse_hardened_xml(signed_info_xml)
    canonical_signed_info = exc_c14n(signed_info_node)

    if isinstance(private_key, rsa.RSAPrivateKey):
        raw_sig = private_key.sign(canonical_signed_info, padding.PKCS1v15(), hashes.SHA256())
    else:
        der_sig = private_key.sign(canonical_signed_info, ec.ECDSA(hashes.SHA256()))
        r_int, s_int = decode_dss_signature(der_sig)
        raw_sig = r_int.to_bytes(32, "big") + s_int.to_bytes(32, "big")

    sig_b64 = base64.b64encode(raw_sig).decode("ascii")
    signature_block = (
        f'<ds:Signature xmlns:ds="{XMLDSIG_NS}">'
        f"{signed_info_xml}"
        f"<ds:SignatureValue>{sig_b64}</ds:SignatureValue>"
        "</ds:Signature>"
    )

    # Insert signature right after `<saml:Issuer>...</saml:Issuer>` inside target element (SAML 2.0 schema order).
    issuer_children = target_node.find_children(SAML_ASSERTION_NS, "Issuer")
    sig_parsed = parse_hardened_xml(signature_block)
    sig_parsed.parent = target_node
    # Inherit target_node's outer in-scope namespaces while keeping ds binding.
    merged_scope = dict(target_node.in_scope_ns)
    merged_scope.update(sig_parsed.ns_decls)
    for sub in sig_parsed.iter_elements():
        updated = dict(merged_scope)
        updated.update(sub.in_scope_ns)
        sub.in_scope_ns = updated

    if issuer_children:
        idx = target_node.children.index(issuer_children[0]) + 1
        target_node.children.insert(idx, sig_parsed)
    else:
        target_node.children.insert(0, sig_parsed)

    return exc_c14n(tree).decode("utf-8")
