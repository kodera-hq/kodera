"""Offline PDF/A-3b + Factur-X EN16931 generation and independent conformance validation.

Optional rendering dependencies belong to the operator, never an API request. The validator
uses packaged XSD/XSL, local SaxonC and a pinned operator-installed veraPDF executable. It never
uses the library's optional HTTP validation service or treats logged validation failures as pass.
"""

from __future__ import annotations

import hashlib
import io
import os
import shutil
import subprocess
from datetime import UTC
from html import escape
from importlib.metadata import distribution
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from .documents import Snapshot, _money
from .integrity import IntegrityRefusedError

PROFILE_SHA256 = "384b832de3412066743b52a75ee906b6fb9fb8d9e09e936fc2c43223815c6e0a"
VERAPDF_JAR_SHA256 = "889075253fb9df4db5482efb8f8208fb3b4f2e00f5f7e1b1e31edf6fb4b69bb6"
SVRL = "http://purl.oclc.org/dsdl/svrl"
XMP = "http://ns.adobe.com/xap/1.0/"


def _xml_parser() -> Any:
    from lxml import etree

    return etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True)


def validate_xml(xml: bytes) -> None:
    """Evaluate local official XSD and Schematron; no remote endpoint or permissive fallback."""
    from lxml import etree
    from saxonche import PySaxonProcessor

    if len(xml) > 1_000_000:
        raise IntegrityRefusedError("document_xml_bound")
    try:
        parsed = etree.fromstring(xml, parser=_xml_parser())
        if parsed.getroottree().docinfo.doctype:
            raise IntegrityRefusedError("document_xml_doctype_refused")
        root = Path(
            str(distribution("factur-x").locate_file("facturx/xsd_and_schematron/facturx-en16931"))
        )
        schema = etree.XMLSchema(
            etree.parse(str(root / "Factur-X_EN16931.xsd"), parser=_xml_parser())
        )
        if not schema.validate(parsed):
            raise IntegrityRefusedError("document_xml_xsd_failed")
        with PySaxonProcessor(license=False) as processor:
            processor.set_configuration_property(
                "http://saxon.sf.net/feature/allow-external-functions", "false"
            )
            processor.set_configuration_property(
                "http://saxon.sf.net/feature/allowedProtocols", "file"
            )
            executable = processor.new_xslt30_processor().compile_stylesheet(
                stylesheet_file=str(root / "FACTUR-X_EN16931.xslt")
            )
            report = executable.transform_to_string(
                xdm_node=processor.parse_xml(xml_text=xml.decode("utf-8"))
            )
        if not report:
            raise IntegrityRefusedError("document_xml_schematron_report_missing")
        result = etree.fromstring(report.encode(), parser=_xml_parser())
        if result.tag != f"{{{SVRL}}}schematron-output":
            raise IntegrityRefusedError("document_xml_schematron_report_invalid")
        failures = result.findall(f".//{{{SVRL}}}failed-assert")
        # CII requires ApplicableHeaderTradeDelivery even where no physical delivery applies.
        # Its empty-element warning is not an EN16931 fatal assertion; no other failure is waived.
        if any(
            not (node.get("flag") == "warning" and node.get("id") == "PEPPOL-EN16931-R008")
            for node in failures
        ):
            raise IntegrityRefusedError("document_xml_schematron_failed")
    except IntegrityRefusedError:
        raise
    except Exception:
        # Third-party exceptions may contain the entire invoice; expose only a closed reason.
        raise IntegrityRefusedError("document_xml_validation_unavailable") from None


def _normalise_pdf(pdf: bytes, snapshot: Snapshot) -> bytes:
    from lxml import etree
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import (
        ArrayObject,
        ByteStringObject,
        DecodedStreamObject,
        DictionaryObject,
        NameObject,
        NumberObject,
        TextStringObject,
    )

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf)))
    instant = snapshot.issued_at.astimezone(UTC)
    pdf_date = instant.strftime("D:%Y%m%d%H%M%S+00'00'")
    metadata = dict(writer.metadata or {})
    metadata.update({"/CreationDate": pdf_date, "/ModDate": pdf_date})
    metadata.pop("/Trapped", None)
    if writer._info is not None:
        writer._info.get_object().clear()
    writer.add_metadata(metadata)
    stream = writer._root_object["/Metadata"].get_object()
    root = etree.fromstring(stream.get_data(), parser=_xml_parser())
    for node in root.iter():
        if node.tag in {
            f"{{{XMP}}}{name}" for name in ("CreateDate", "ModifyDate", "MetadataDate")
        }:
            node.text = instant.isoformat()
    # Mutate the existing stream: adding another would leave the old wall-clock metadata
    # serialized as an unreachable object, which still makes the PDF bytes nondeterministic.
    stream.set_data(etree.tostring(root, encoding="utf-8", xml_declaration=False))
    stream.update(
        {NameObject("/Type"): NameObject("/Metadata"), NameObject("/Subtype"): NameObject("/XML")}
    )
    # Normalise attachment dates too; the packaging library otherwise uses its wall clock.
    for entry in writer._root_object.get("/AF", []):
        params = entry.get_object()["/EF"]["/F"].get_object().get("/Params")
        if params is not None:
            params[NameObject("/ModDate")] = TextStringObject(pdf_date)
            if "/CreationDate" in params:
                params[NameObject("/CreationDate")] = TextStringObject(pdf_date)
    profile = Path(__file__).with_name("assets").joinpath("sRGB2014.icc").read_bytes()
    if hashlib.sha256(profile).hexdigest() != PROFILE_SHA256:
        raise IntegrityRefusedError("document_color_profile_integrity")
    icc = DecodedStreamObject()
    icc.set_data(profile)
    icc[NameObject("/N")] = NumberObject(3)
    output = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/OutputIntent"),
            NameObject("/S"): NameObject("/GTS_PDFA1"),
            NameObject("/OutputConditionIdentifier"): TextStringObject("sRGB2014"),
            NameObject("/RegistryName"): TextStringObject("http://www.color.org"),
            NameObject("/Info"): TextStringObject("sRGB2014"),
            NameObject("/DestOutputProfile"): writer._add_object(icc),
        }
    )
    writer._root_object[NameObject("/OutputIntents")] = ArrayObject([writer._add_object(output)])
    # The library intentionally generates random identifiers. This immutable snapshot already
    # includes its unique legal number, so derive the initial/revision identifiers from it.
    identifier = ByteStringObject(bytes.fromhex(snapshot.sha256)[:16])
    writer._ID = ArrayObject([identifier, identifier])
    target = io.BytesIO()
    writer.write(target)
    return target.getvalue()


class OfflineRenderer:
    def render(self, snapshot: Snapshot, xml: bytes) -> bytes:
        from facturx import generate_from_binary
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.pdfgen.canvas import Canvas
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

        validate_xml(xml)
        font_path = Path(str(distribution("reportlab").locate_file("reportlab/fonts/Vera.ttf")))
        font = TTFont("BillingVera", str(font_path))
        pdfmetrics.registerFont(font)
        content = [
            snapshot.number,
            snapshot.currency,
            snapshot.seller.name,
            snapshot.seller.address,
            snapshot.buyer.name,
            snapshot.buyer.address,
            *(line.description for line in snapshot.lines),
        ]
        if len(snapshot.lines) > 1000 or sum(len(value) for value in content) > 100_000:
            raise IntegrityRefusedError("document_render_bound")
        if any(
            ord(char) not in font.face.charToGlyph and char not in "\n\r\t"
            for value in content
            for char in value
        ):
            raise IntegrityRefusedError("document_font_unsupported_character")
        style = ParagraphStyle(
            "Billing", fontName="BillingVera", fontSize=9, leading=13, textColor="black"
        )
        story: list[Any] = []

        def line(value: str) -> None:
            if any(
                ord(char) not in font.face.charToGlyph and char not in "\n\r\t" for char in value
            ):
                raise IntegrityRefusedError("document_font_unsupported_character")
            story.append(Paragraph(escape(value).replace("\n", "<br/>"), style))

        line(("Credit note " if snapshot.type_code == "381" else "Invoice ") + snapshot.number)
        line("Issued: " + snapshot.issued_at.isoformat())
        if snapshot.due_at is not None:
            line("Due: " + snapshot.due_at.isoformat())
        if snapshot.original_invoice_number:
            line("Original invoice: " + snapshot.original_invoice_number)
        for label, party in (("Seller", snapshot.seller), ("Customer", snapshot.buyer)):
            story.append(Spacer(1, 12))
            line(label + ": " + party.name)
            for value in (
                party.address,
                party.address_line2,
                " ".join(v for v in (party.postal_code, party.city, party.country) if v),
                party.registration_id,
                party.vat_number,
            ):
                if value:
                    line(value)
        story.append(Spacer(1, 12))
        for item in sorted(snapshot.lines, key=lambda value: value.position):
            line(f"{item.position}. {item.description}")
            if item.period_start is not None and item.period_end is not None:
                line(
                    "Service period: "
                    + item.period_start.isoformat()
                    + " to "
                    + item.period_end.isoformat()
                )
            line(
                f"Quantity {item.quantity}; unit {snapshot.currency} {_money(item.unit_minor)}; net {_money(item.net_minor)}; VAT {_money(item.vat_minor)} ({_money(item.vat_rate_bp)}%)"
            )
        story.append(Spacer(1, 12))
        for label, amount in (
            ("Net", snapshot.net_minor),
            ("VAT", snapshot.vat_minor),
            ("Gross", snapshot.gross_minor),
        ):
            line(f"{label}: {snapshot.currency} {_money(amount)}")
        if snapshot.vat_mention:
            line(snapshot.vat_mention)
        pdf = io.BytesIO()

        def canvas(target: Any, **kwargs: Any) -> Any:
            return Canvas(
                target,
                **{
                    **kwargs,
                    "invariant": 1,
                    "pdfVersion": (1, 7),
                    "enforceColorSpace": "RGB",
                    "initialFontName": "BillingVera",
                },
            )

        SimpleDocTemplate(
            pdf, pagesize=A4, leftMargin=36, rightMargin=36, topMargin=36, bottomMargin=36
        ).build(story, canvasmaker=canvas)
        packaged = generate_from_binary(
            pdf.getvalue(),
            xml,
            flavor="factur-x",
            level="en16931",
            check_xsd=False,
            check_schematron=False,
            pdf_metadata={
                "author": snapshot.seller.name,
                "title": snapshot.number,
                "subject": "Immutable accounting snapshot " + snapshot.sha256,
                "keywords": "Factur-X EN16931",
            },
            lang="en-GB",
            afrelationship="alternative",
            xmp_compression=False,
        )
        return _normalise_pdf(bytes(packaged), snapshot)


def verify_pdfa_report(raw: bytes) -> None:
    from lxml import etree

    try:
        if len(raw) > 1_000_000:
            raise ValueError
        root = etree.fromstring(raw, parser=_xml_parser())
        reports = root.findall(".//validationReport")
        batch = root.find(".//batchSummary")
        if (
            len(reports) != 1
            or reports[0].get("isCompliant") != "true"
            or reports[0].get("profileName") != "PDF/A-3b validation profile"
            or batch is None
            or any(
                batch.get(key) != expected
                for key, expected in {
                    "totalJobs": "1",
                    "failedToParse": "0",
                    "encrypted": "0",
                    "outOfMemory": "0",
                    "veraExceptions": "0",
                }.items()
            )
        ):
            raise ValueError
    except Exception:
        raise IntegrityRefusedError("document_pdfa3_conformance_failed") from None


class OfflineValidator:
    def __init__(self, *, verapdf: Path) -> None:
        if not verapdf.is_absolute() or not verapdf.is_file() or not os.access(verapdf, os.X_OK):
            raise IntegrityRefusedError("document_pdfa_validator_unavailable")
        jar = verapdf.resolve().parent / "bin" / "cli-1.30.2.jar"
        if not jar.is_file() or hashlib.sha256(jar.read_bytes()).hexdigest() != VERAPDF_JAR_SHA256:
            raise IntegrityRefusedError("document_pdfa_validator_integrity")
        java = shutil.which("java", path=os.defpath)
        if java is None:
            raise IntegrityRefusedError("document_pdfa_validator_unavailable")
        self.jar, self.java = jar, java

    def validate(self, *, pdf: bytes, xml: bytes, snapshot_sha256: str) -> None:
        from pypdf import PdfReader

        validate_xml(xml)
        try:
            reader = PdfReader(io.BytesIO(pdf), strict=True)
            if (
                reader.is_encrypted
                or set(reader.attachments) != {"factur-x.xml"}
                or reader.attachments["factur-x.xml"] != [xml]
                or reader.metadata.get("/Subject")
                != "Immutable accounting snapshot " + snapshot_sha256
            ):
                raise ValueError
        except Exception:
            raise IntegrityRefusedError("document_embedded_xml_mismatch") from None
        with TemporaryDirectory(prefix="billing-pdfa-") as directory:
            path = Path(directory) / "invoice.pdf"
            path.write_bytes(pdf)
            try:
                result = subprocess.run(  # noqa: S603 - pinned JAR and fixed arguments
                    [
                        self.java,
                        "-Djava.io.tmpdir=" + directory,
                        "-Duser.home=" + directory,
                        "-jar",
                        str(self.jar),
                        "--format",
                        "xml",
                        "--flavour",
                        "3b",
                        "--maxfailures",
                        "1",
                        str(path),
                    ],
                    capture_output=True,
                    timeout=30,
                    check=False,
                    env={"PATH": os.defpath},
                )  # noqa: S603 - verified pinned JAR, fixed flags, owned temporary input
            except (OSError, subprocess.TimeoutExpired):
                raise IntegrityRefusedError("document_pdfa_validator_unavailable") from None
            if result.returncode != 0:
                raise IntegrityRefusedError("document_pdfa3_conformance_failed")
            verify_pdfa_report(result.stdout)
