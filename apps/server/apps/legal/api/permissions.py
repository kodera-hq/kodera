"""Legal declarations; the stored role and the organisation are enforced by apps/legal/services.py."""

from core.api.scopes import Operation

LIST_LEGAL_DOCUMENTS = Operation(method="GET", operation_id="listLegalDocuments", scope="plan:read")
GET_LEGAL_DOCUMENT_TEXT = Operation(
    method="GET", operation_id="getLegalDocumentText", scope="plan:read"
)
GENERATE_DPA = Operation(method="POST", operation_id="generateDpa", scope="dpa_acceptance:create")
GET_DPA = Operation(method="GET", operation_id="getDpa", scope="dpa_acceptance:read")
