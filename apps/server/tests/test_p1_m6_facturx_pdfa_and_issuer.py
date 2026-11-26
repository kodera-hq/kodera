"""Always-on legal issuer and adversarial PDF/XML checks without a JVM validator."""

import io
from dataclasses import replace

import pytest
from test_billing_documents import snapshot

from apps.billing.documents import render_xml
from apps.billing.facturx_pdfa_validator import validate_facturx_pdfa3b
from apps.billing.integrity import IntegrityRefusedError
from apps.billing.issuer_validation import OPTIONAL, REQUIRED, validate_issuer
from apps.billing.rendering import OfflineRenderer


@pytest.fixture
def issuer():
    # Synthetic checksum-valid identifiers, never an operator's actual issuer.
    values = dict(
        zip(
            REQUIRED,
            (
                "Synthetic Seller",
                "1 sample street",
                "75000",
                "Paris",
                "FR",
                "123456782",
                "FR11123456782",
            ),
            strict=True,
        )
    )
    return {"SAMOURAI_BILLING_ISSUER_" + key: value for key, value in values.items()}


def test_complete_issuer_and_matching_aliases(issuer):
    values = validate_issuer(issuer)
    assert values["SIREN"] == "123456782"
    for key, value in list(issuer.items()):
        issuer[key.replace("SAMOURAI_", "KODERA_")] = value
    assert validate_issuer(issuer) == values


@pytest.mark.parametrize("field", REQUIRED)
@pytest.mark.parametrize("kind", ["missing", "blank", "disagreement"])
def test_partial_blank_or_disagreeing_alias_is_refused(issuer, field, kind):
    key = "SAMOURAI_BILLING_ISSUER_" + field
    if kind == "missing":
        del issuer[key]
    elif kind == "blank":
        issuer[key] = " "
    else:
        issuer["KODERA_BILLING_ISSUER_" + field] = "different"
    with pytest.raises(IntegrityRefusedError, match="billing_issuer_invalid"):
        validate_issuer(issuer)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("COUNTRY", "ZZ"),
        ("COUNTRY", "FRA"),
        ("COUNTRY", "fr"),
        ("SIREN", "000000000"),
        ("SIREN", "123456789"),
        ("SIREN", "１２３４５６７８２"),
        ("VAT_NUMBER", "FR00123456782"),
        ("VAT_NUMBER", "FR32123456789"),
        ("SIRET", "12345678200001"),
        ("SIRET", "00000000000000"),
        ("VAT_NUMBER", "FRII123456782"),
        ("NAME", "seller\nheader"),
    ],
)
def test_invalid_legal_inputs_fail_closed(issuer, field, value):
    issuer["SAMOURAI_BILLING_ISSUER_" + field] = value
    with pytest.raises(IntegrityRefusedError):
        validate_issuer(issuer)


@pytest.mark.parametrize("field", OPTIONAL)
def test_optional_issuer_values_must_not_be_blank(issuer, field):
    issuer["SAMOURAI_BILLING_ISSUER_" + field] = ""
    with pytest.raises(IntegrityRefusedError):
        validate_issuer(issuer)


def test_siret_and_nonnumeric_french_key_are_supported(issuer):
    issuer["SAMOURAI_BILLING_ISSUER_SIRET"] = "12345678200010"
    issuer["SAMOURAI_BILLING_ISSUER_VAT_NUMBER"] = "FRAB123456782"
    assert validate_issuer(issuer)["SIRET"].startswith("123456782")


def test_legacy_synthetic_issuer_is_accepted_without_aliases(settings):
    issuer = settings.KODERA_BILLING_ISSUER
    assert validate_issuer(
        {
            "KODERA_BILLING_ISSUER_" + key: value
            for key, value in {
                "NAME": issuer.legal_name,
                "ADDRESS": issuer.address,
                "COUNTRY": issuer.country,
                "SIREN": issuer.siren,
                "VAT_NUMBER": issuer.vat_number,
            }.items()
        }
    )
    assert validate_issuer({}) == {}


def test_render_refuses_bad_issuer_before_packaging(issuer, monkeypatch):
    for key, value in issuer.items():
        monkeypatch.setenv(key, value)
    with pytest.raises(IntegrityRefusedError, match="billing_issuer_invalid"):
        OfflineRenderer().render(snapshot(), render_xml(snapshot()))


@pytest.fixture(scope="module", params=[False, True], ids=["380", "381"])
def document(request):
    row = snapshot(number="KOD-2026-00001")
    if request.param:
        row = replace(
            row,
            number="KOD-AV-2026-00001",
            type_code="381",
            original_invoice_number=row.number,
            due_at=None,
        )
    # The frozen ledger also has legacy AV-prefixed series; exercise the PA naming
    # contract without changing the ledger or its numbering validation in this lane.
    xml = (
        render_xml(replace(row, number="AV-KOD-2026-00001")).replace(
            b"AV-KOD-2026-00001", b"KOD-AV-2026-00001"
        )
        if request.param
        else render_xml(row)
    )
    return row, xml, OfflineRenderer().render(row, xml)


def test_real_invoice_and_credit_pass_always_on_validation(document):
    row, xml, pdf = document
    validate_facturx_pdfa3b(pdf, expected_xml_bytes=xml)
    assert row.number.encode() in xml
    assert pdf.startswith(b"%PDF-1.7\n%")


def test_attachment_must_match_expected_bytes_exactly(document):
    with pytest.raises(IntegrityRefusedError):
        validate_facturx_pdfa3b(document[2], expected_xml_bytes=document[1] + b"\n")


def mutate(pdf, kind):
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import ArrayObject, DictionaryObject, NameObject, TextStringObject

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf)))
    writer.pdf_header = "%PDF-1.7"
    root = writer._root_object
    if kind in {"/AF", "/OutputIntents", "/Metadata"}:
        del root[kind]
    elif kind == "names":
        del root["/Names"]["/EmbeddedFiles"]
    elif kind == "mismatched_names":
        root["/Names"]["/EmbeddedFiles"]["/Names"][0] = TextStringObject("wrong.xml")
    elif kind in {"/JavaScript", "/Launch"}:
        root[NameObject("/OpenAction")] = DictionaryObject({NameObject("/S"): NameObject(kind)})
    elif kind == "unembedded":
        for obj in writer._objects:
            if isinstance(obj, DictionaryObject) and obj.get("/Type") == "/FontDescriptor":
                obj.pop(NameObject("/FontFile2"), None)
                obj.pop(NameObject("/FontFile3"), None)
    elif kind == "descriptor_type":
        for obj in writer._objects:
            if isinstance(obj, DictionaryObject) and obj.get("/Type") == "/FontDescriptor":
                del obj["/Type"]
    elif kind == "bare_font":
        writer._add_object(
            DictionaryObject(
                {
                    NameObject("/Type"): NameObject("/Font"),
                    NameObject("/Subtype"): NameObject("/Type1"),
                }
            )
        )
    elif kind == "indirect-javascript":
        root[NameObject("/OpenAction")] = DictionaryObject(
            {NameObject("/S"): writer._add_object(NameObject("/JavaScript"))}
        )
    elif kind in {"indirect-type0", "omitted-type1"}:
        font = DictionaryObject(
            {
                NameObject("/Subtype"): writer._add_object(
                    NameObject("/Type0" if kind == "indirect-type0" else "/Type1")
                )
            }
        )
        if kind == "indirect-type0":
            font[NameObject("/DescendantFonts")] = ArrayObject(
                [
                    writer._add_object(
                        DictionaryObject({NameObject("/Subtype"): NameObject("/CIDFontType2")})
                    )
                ]
            )
        writer._add_object(font)
    elif kind in {"diamond-names", "hybrid-names"}:
        leaf = root["/Names"]["/EmbeddedFiles"]
        leaf_reference = writer._add_object(leaf)
        if kind == "diamond-names":
            root["/Names"][NameObject("/EmbeddedFiles")] = DictionaryObject(
                {NameObject("/Kids"): ArrayObject([leaf_reference, leaf_reference])}
            )
        else:
            leaf[NameObject("/Kids")] = ArrayObject([leaf_reference])
    elif kind in {"/LZWDecode", "/JBIG2Decode", "external-stream", "decoded-budget"}:
        from pypdf.generic import DecodedStreamObject

        extra = DecodedStreamObject()
        extra.set_data(b"x" * (33 * 1024 * 1024) if kind == "decoded-budget" else b"x")
        if kind == "decoded-budget":
            extra = extra.flate_encode()
        elif kind == "external-stream":
            extra[NameObject("/F")] = TextStringObject("external.bin")
        else:
            extra[NameObject("/Filter")] = writer._add_object(NameObject(kind))
        writer._add_object(extra)
    elif kind == "cumulative-budget":
        from pypdf.generic import DecodedStreamObject

        for _ in range(2):
            extra = DecodedStreamObject()
            extra.set_data(b"x" * (17 * 1024 * 1024))
            writer._add_object(extra.flate_encode())
    elif kind == "icc":
        del root["/OutputIntents"][0].get_object()["/DestOutputProfile"]
    elif kind.startswith("xmp-"):
        stream = root["/Metadata"]
        before, after = {
            "xmp-part": (b">3<", b">2<"),
            "xmp-level": (b">EN 16931<", b">BASIC<"),
            "xmp-type": (b">INVOICE<", b">OTHER<"),
            "xmp-file": (b">factur-x.xml<", b">other.xml<"),
        }[kind]
        stream.set_data(stream.get_data().replace(before, after))
    elif kind == "encrypt":
        writer.encrypt("synthetic-password")
    else:
        spec = root["/AF"][0].get_object()
        stream = spec["/EF"]["/F"]
        if kind == "relationship":
            del spec["/AFRelationship"]
        elif kind == "subtype":
            stream[NameObject("/Subtype")] = NameObject("/application/pdf")
        elif kind == "moddate":
            del stream["/Params"]["/ModDate"]
        elif kind == "duplicate":
            root[NameObject("/AF")] = ArrayObject([root["/AF"][0], root["/AF"][0]])
        elif kind == "xml-schema":
            stream.set_data(
                stream.get_data().replace(b"ram:InvoiceCurrencyCode", b"ram:UnknownCurrencyCode")
            )
        elif kind == "xml-business":
            stream.set_data(
                stream.get_data().replace(
                    b">24.02</ram:GrandTotalAmount>", b">24.03</ram:GrandTotalAmount>"
                )
            )
    target = io.BytesIO()
    writer.write(target)
    return target.getvalue()


@pytest.mark.parametrize(
    "kind",
    [
        "/AF",
        "/OutputIntents",
        "/Metadata",
        "names",
        "mismatched_names",
        "/JavaScript",
        "/Launch",
        "unembedded",
        "bare_font",
        "descriptor_type",
        "icc",
        "indirect-javascript",
        "indirect-type0",
        "omitted-type1",
        "diamond-names",
        "hybrid-names",
        "/LZWDecode",
        "/JBIG2Decode",
        "external-stream",
        "decoded-budget",
        "cumulative-budget",
        "xmp-part",
        "xmp-level",
        "xmp-type",
        "xmp-file",
        "encrypt",
        "relationship",
        "subtype",
        "moddate",
        "duplicate",
        "xml-schema",
        "xml-business",
    ],
)
def test_pdf_and_xml_mutations_are_rejected_without_verapdf(document, kind, monkeypatch):
    monkeypatch.delenv("KODERA_BILLING_VERAPDF", raising=False)
    monkeypatch.setattr("shutil.which", lambda *args, **kwargs: None)
    with pytest.raises(IntegrityRefusedError):
        validate_facturx_pdfa3b(mutate(document[2], kind))


@pytest.mark.parametrize("kind", ["header", "binary"])
def test_pdf_header_and_binary_marker_are_required(document, kind):
    pdf = document[2]
    changed = (
        pdf.replace(b"%PDF-1.7", b"%PDF-1.4", 1)
        if kind == "header"
        else pdf.replace(pdf.split(b"\n")[1], b"%aaaa", 1)
    )
    with pytest.raises(IntegrityRefusedError):
        validate_facturx_pdfa3b(changed)


def test_configured_external_validator_is_chained(document, monkeypatch):
    calls = []

    class Validator:
        def __init__(self, **kwargs):
            calls.append(kwargs)

        def validate(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setenv("KODERA_BILLING_VERAPDF", "/synthetic/verapdf")
    monkeypatch.setattr("apps.billing.rendering.OfflineValidator", Validator)
    validate_facturx_pdfa3b(document[2], expected_xml_bytes=document[1])
    assert calls[1]["snapshot_sha256"] == document[0].sha256


def test_qonto_token_is_admitted_without_becoming_a_setting():
    from config.environment import ADMITTED_SECRET_NAMES, unadmitted_secret_names

    assert "KODERA_QONTO_PA_TOKEN" in ADMITTED_SECRET_NAMES
    assert unadmitted_secret_names({"KODERA_QONTO_PA_TOKEN": "synthetic-token"}) == []


def test_blank_external_validator_configuration_fails_closed(document, monkeypatch):
    monkeypatch.setenv("KODERA_BILLING_VERAPDF", " ")
    with pytest.raises(IntegrityRefusedError, match="document_pdfa_validator_unavailable"):
        validate_facturx_pdfa3b(document[2])


def test_valid_alias_issuer_renders_and_embeds_validated_identity(issuer, monkeypatch):
    from apps.billing.documents import Party

    for key, value in issuer.items():
        monkeypatch.setenv(key, value)
    row = snapshot(
        seller=Party(
            "Synthetic Seller",
            "1 sample street",
            "FR",
            "FR11123456782",
            "75000",
            "Paris",
            registration_id="123456782",
        )
    )
    xml = render_xml(row)
    validate_facturx_pdfa3b(OfflineRenderer().render(row, xml), expected_xml_bytes=xml)


@pytest.mark.parametrize("namespace", ["SAMOURAI", "KODERA"])
def test_issuer_typo_is_refused(issuer, namespace):
    issuer[namespace + "_BILLING_ISSUER_VAT_NUMBR"] = "typo"
    with pytest.raises(IntegrityRefusedError):
        validate_issuer(issuer)


@pytest.mark.parametrize("series", ["", "KOD"])
def test_operator_issuer_requires_complete_nonsynthetic_values(settings, issuer, series):
    settings.KODERA_INVOICE_SERIES = series
    with pytest.raises(IntegrityRefusedError):
        validate_issuer({})
    assert validate_issuer(issuer)["SIREN"] == "123456782"
    legacy = {key.replace("SAMOURAI_", "KODERA_"): value for key, value in issuer.items()}
    legacy["KODERA_BILLING_ISSUER_SIREN"] = "000000000"
    legacy["KODERA_BILLING_ISSUER_VAT_NUMBER"] = "FR00000000000"
    with pytest.raises(IntegrityRefusedError):
        validate_issuer(legacy)
    assert validate_issuer(legacy, allow_synthetic=True)
    del legacy["KODERA_BILLING_ISSUER_CITY"]
    with pytest.raises(IntegrityRefusedError):
        validate_issuer(legacy)


def test_zero_nic_is_rejected_even_with_valid_checksum(issuer):
    issuer["SAMOURAI_BILLING_ISSUER_SIREN"] = "123457004"
    issuer["SAMOURAI_BILLING_ISSUER_VAT_NUMBER"] = "FRAB123457004"
    issuer["SAMOURAI_BILLING_ISSUER_SIRET"] = "12345700400000"
    with pytest.raises(IntegrityRefusedError):
        validate_issuer(issuer)


def test_render_command_requires_explicit_validator():
    from django.core.management.base import CommandError

    from apps.billing.management.commands.render_billing_document import Command

    parser = Command().create_parser("manage.py", "render_billing_document")
    with pytest.raises(CommandError, match="--verapdf"):
        parser.parse_args(["--invoice", "00000000-0000-0000-0000-000000000001"])


def test_render_command_uses_pinned_validator_reference(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from unittest.mock import Mock
    from uuid import UUID

    from apps.billing.management.commands import render_billing_document as command

    publish = Mock(return_value=SimpleNamespace(id="artifact", pdf_sha256="pdf", xml_sha256="xml"))
    validator = Mock()
    monkeypatch.setattr(command, "require_operator_profile", lambda: None)
    monkeypatch.setattr("apps.billing.artifacts.publish", publish)
    monkeypatch.setattr("apps.billing.rendering.OfflineValidator", validator)
    instance = command.Command()
    instance.handle(
        invoice=UUID("00000000-0000-0000-0000-000000000001"),
        credit_note=None,
        verapdf=tmp_path / "verapdf",
    )
    validator.assert_called_once_with(verapdf=tmp_path / "verapdf")
    assert publish.call_args.kwargs["validator"] is validator.return_value
    assert publish.call_args.kwargs["validator_ref"].startswith("verapdf-1.30.2/")


def test_french_narrow_no_break_space_in_catalogue_description_renders_valid_pdfa3b():
    base = snapshot()
    french_line = replace(
        base.lines[0],
        description="Assistance les jours ouvrés\u202f; 2026-01-01 \u2192 2026-02-01\u2009PRO2-S.",
    )
    row = replace(base, lines=(french_line,))
    xml = render_xml(row)
    assert "\u202f".encode() in xml
    pdf = OfflineRenderer().render(row, xml)
    validate_facturx_pdfa3b(pdf, expected_xml_bytes=xml)
