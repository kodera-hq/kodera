"""Deterministic PDF/A-3b structural and EN 16931 checks, with optional veraPDF chaining.

These always-on checks cover the billing output contract. Full ISO PDF/A conformance also
requires the independent pinned veraPDF validator when installed by the operator.
"""

from __future__ import annotations

import io
import os
import re
import zlib
from pathlib import Path
from typing import Any

from .integrity import IntegrityRefusedError

PDFA = "http://www.aiim.org/pdfa/ns/id/"
FX = "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"


def _deref(obj: Any, key: str) -> Any:
    """Dictionary.get does not resolve indirect PDF values; resolve every policy input."""
    from pypdf.generic import IndirectObject

    value = obj.get(key)
    visited: set[tuple[int, int]] = set()
    while isinstance(value, IndirectObject):
        identity = (value.idnum, value.generation)
        if identity in visited or len(visited) >= 64:
            raise ValueError
        visited.add(identity)
        value = value.get_object()
    return value


def validate_facturx_pdfa3b(
    pdf_bytes: bytes,
    *,
    expected_xml_bytes: bytes | None = None,
    run_configured_validator: bool = True,
) -> None:
    """Refuse malformed, unsafe or mismatched PDF/XML pairs without JVM dependencies."""
    from lxml import etree
    from pypdf import PdfReader
    from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, StreamObject

    from .rendering import OfflineValidator, _xml_parser, validate_xml

    try:
        if not isinstance(pdf_bytes, bytes) or not 1 <= len(pdf_bytes) <= 20 * 1024 * 1024:
            raise ValueError
        lines = pdf_bytes.split(b"\n", 2)
        if lines[0].rstrip(b"\r") != b"%PDF-1.7" or not re.match(rb"%[\x80-\xff]{4}", lines[1]):
            raise ValueError
        reader = PdfReader(io.BytesIO(pdf_bytes), strict=True)
        if reader.is_encrypted or "/Encrypt" in reader.trailer:
            raise ValueError
        decoded_bytes = 0
        decoded: dict[int, bytes] = {}

        def data(obj: Any) -> bytes:
            nonlocal decoded_bytes
            identity = id(obj)
            if identity not in decoded:
                if not isinstance(obj, StreamObject) or any(
                    name in obj for name in ("/F", "/FFilter", "/FDecodeParms")
                ):
                    raise ValueError
                filters = _deref(obj, "/Filter")
                if isinstance(filters, ArrayObject):
                    if len(filters) > 2 or any(
                        item.get_object() != "/FlateDecode" for item in filters
                    ):
                        raise ValueError
                elif filters is not None and filters != "/FlateDecode":
                    raise ValueError
                # Bound each decompression stage before pypdf applies any predictors.
                remaining = 32 * 1024 * 1024 - decoded_bytes
                raw = obj._data
                count = (
                    len(filters) if isinstance(filters, ArrayObject) else int(filters is not None)
                )
                for _ in range(count):
                    decoder = zlib.decompressobj()
                    raw = decoder.decompress(raw, remaining + 1)
                    if len(raw) > remaining or decoder.unconsumed_tail or not decoder.eof:
                        raise ValueError
                if len(raw) > remaining:
                    raise ValueError
                payload = obj.get_data()
                decoded_bytes += len(payload)
                if decoded_bytes > 32 * 1024 * 1024:
                    raise ValueError
                decoded[identity] = payload
            return decoded[identity]

        catalog: Any = reader.trailer["/Root"]
        if _deref(catalog, "/Type") != "/Catalog":
            raise ValueError
        intents = catalog["/OutputIntents"]
        if not intents or not any(
            _deref(intent.get_object(), "/S") == "/GTS_PDFA1"
            and isinstance(_deref(intent.get_object(), "/DestOutputProfile"), StreamObject)
            and data(_deref(intent.get_object(), "/DestOutputProfile"))[36:40] == b"acsp"
            for intent in intents
        ):
            raise ValueError
        metadata = catalog["/Metadata"]
        if _deref(metadata, "/Type") != "/Metadata" or _deref(metadata, "/Subtype") != "/XML":
            raise ValueError
        raw = data(metadata)
        if len(raw) > 1_000_000:
            raise ValueError
        root = etree.fromstring(raw, parser=_xml_parser())
        if root.getroottree().docinfo.doctype:
            raise ValueError
        for tag, wanted in {
            f"{{{PDFA}}}part": "3",
            f"{{{PDFA}}}conformance": "B",
            f"{{{FX}}}DocumentType": "INVOICE",
            f"{{{FX}}}DocumentFileName": "factur-x.xml",
            f"{{{FX}}}ConformanceLevel": "EN 16931",
        }.items():
            values = [node.text for node in root.iter(tag)]
            values.extend(node.attrib[tag] for node in root.iter() if tag in node.attrib)
            if values != [wanted]:
                raise ValueError
        associated = catalog["/AF"]
        if len(associated) != 1:
            raise ValueError
        spec: Any = associated[0].get_object()
        if (
            _deref(spec, "/Type") != "/Filespec"
            or _deref(spec, "/F") != "factur-x.xml"
            or _deref(spec, "/UF") != "factur-x.xml"
            or _deref(spec, "/AFRelationship") not in {"/Alternative", "/Data", "/Source"}
        ):
            raise ValueError
        stream = spec["/EF"]["/F"]
        embedded_files = _deref(spec, "/EF")
        if not isinstance(embedded_files, DictionaryObject) or not set(embedded_files) <= {
            "/F",
            "/UF",
        }:
            raise ValueError
        if any(_deref(embedded_files, key) is not stream for key in embedded_files):
            raise ValueError
        params: Any = _deref(stream, "/Params")
        if (
            not isinstance(stream, StreamObject)
            or _deref(stream, "/Type") != "/EmbeddedFile"
            or _deref(stream, "/Subtype") != "/text/xml"
            or not re.fullmatch(r"D:[0-9]{14}(?:Z|[+-][0-9]{2}'[0-9]{2}')", str(params["/ModDate"]))
        ):
            raise ValueError
        # Refuse repeated nodes, cycles, hybrid nodes and oversized embedded-file trees.
        visited: set[int] = set()

        def files(node: Any) -> list[Any]:
            node = node.get_object()
            identity = id(node)
            if identity in visited or len(visited) >= 64 or not isinstance(node, DictionaryObject):
                raise ValueError
            visited.add(identity)
            if "/Kids" in node:
                if "/Names" in node:
                    raise ValueError
                kids = _deref(node, "/Kids")
                if not isinstance(kids, ArrayObject) or not 1 <= len(kids) <= 64:
                    raise ValueError
                return [entry for child in kids for entry in files(child)]
            entries = _deref(node, "/Names")
            if not isinstance(entries, ArrayObject) or len(entries) != 2:
                raise ValueError
            return list(entries)

        names = files(catalog["/Names"]["/EmbeddedFiles"])
        if len(names) != 2 or names[0] != "factur-x.xml" or names[1].get_object() is not spec:
            raise ValueError
        seen: set[tuple[int, int] | int] = set()
        descriptors = 0

        def descriptor_embedded(obj: Any) -> bool:
            return isinstance(obj, DictionaryObject) and any(
                isinstance(_deref(obj, name), StreamObject) and bool(data(_deref(obj, name)))
                for name in ("/FontFile2", "/FontFile3")
            )

        def walk(obj: Any) -> None:
            nonlocal descriptors
            if isinstance(obj, IndirectObject):
                key: tuple[int, int] | int = (obj.idnum, obj.generation)
                if key in seen:
                    return
                seen.add(key)
                obj = obj.get_object()
            if isinstance(obj, (DictionaryObject, ArrayObject)):
                key = id(obj)
                if key in seen:
                    return
                seen.add(key)
            if len(seen) > 100_000:
                raise ValueError
            if isinstance(obj, StreamObject):
                data(obj)
            if isinstance(obj, DictionaryObject):
                if (
                    any(name in obj for name in ("/JavaScript", "/JS", "/AA", "/XFA", "/RichMedia"))
                    or _deref(obj, "/S")
                    in {
                        "/JavaScript",
                        "/Launch",
                        "/Sound",
                        "/Movie",
                        "/ImportData",
                        "/ResetForm",
                        "/Hide",
                        "/SetOCGState",
                        "/Rendition",
                        "/RichMedia",
                    }
                    or ("/EF" in obj and obj is not spec)
                ):
                    raise ValueError
                if _deref(obj, "/Type") == "/FontDescriptor":
                    descriptors += 1
                    if not descriptor_embedded(obj):
                        raise ValueError
                subtype = _deref(obj, "/Subtype")
                if _deref(obj, "/Type") == "/Font" or subtype in {
                    "/Type1",
                    "/MMType1",
                    "/TrueType",
                    "/Type3",
                    "/Type0",
                    "/CIDFontType0",
                    "/CIDFontType2",
                }:
                    if subtype == "/Type0":
                        children = _deref(obj, "/DescendantFonts")
                        if not isinstance(children, ArrayObject) or not children:
                            raise ValueError
                        for reference in children:
                            child = reference.get_object()
                            if (
                                not isinstance(child, DictionaryObject)
                                or _deref(child, "/Subtype")
                                not in {"/CIDFontType0", "/CIDFontType2"}
                                or not descriptor_embedded(_deref(child, "/FontDescriptor"))
                            ):
                                raise ValueError
                    else:
                        descriptor = _deref(obj, "/FontDescriptor")
                        if (
                            not descriptor_embedded(descriptor)
                            or _deref(descriptor, "/Type") != "/FontDescriptor"
                        ):
                            raise ValueError
                for value in obj.values():
                    walk(value)
            elif isinstance(obj, ArrayObject):
                for value in obj:
                    walk(value)

        walk(reader.trailer)
        # Inspect even unreachable objects for forbidden actions and unembedded font resources.
        for generation, objects in reader.xref.items():
            for number in objects:
                if number:
                    walk(IndirectObject(number, generation, reader))
        for number in reader.xref_objStm:
            walk(IndirectObject(number, 0, reader))
        if not descriptors:
            raise ValueError
        xml = data(stream)
        if set(reader.attachments) != {"factur-x.xml"} or reader.attachments["factur-x.xml"] != [
            xml
        ]:
            raise ValueError
        if expected_xml_bytes is not None and xml != expected_xml_bytes:
            raise ValueError
    except Exception:
        raise IntegrityRefusedError("document_facturx_pdfa3b_invalid") from None
    validate_xml(xml)
    configured = os.environ.get("KODERA_BILLING_VERAPDF")
    if configured is not None and not configured.strip():
        raise IntegrityRefusedError("document_pdfa_validator_unavailable")
    if configured and run_configured_validator:
        info: Any = reader.metadata or {}
        subject = str(info.get("/Subject", ""))
        match = re.fullmatch(r"Immutable accounting snapshot ([a-f0-9]{64})", subject)
        if match is None:
            raise IntegrityRefusedError("document_snapshot_metadata_invalid")
        OfflineValidator(verapdf=Path(configured)).validate(
            pdf=pdf_bytes, xml=xml, snapshot_sha256=match[1]
        )


class FacturXPdfaValidator:
    """Publication port usable whether the optional JVM tool is installed or absent."""

    def validate(self, *, pdf: bytes, xml: bytes, snapshot_sha256: str) -> None:
        from pypdf import PdfReader

        validate_facturx_pdfa3b(pdf, expected_xml_bytes=xml)
        reader = PdfReader(io.BytesIO(pdf), strict=True)
        metadata: Any = reader.metadata or {}
        if metadata.get("/Subject") != "Immutable accounting snapshot " + snapshot_sha256:
            raise IntegrityRefusedError("document_embedded_xml_mismatch")
