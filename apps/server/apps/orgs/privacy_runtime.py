"""Worker-only execution of the complete signed export protocol with concrete durable adapters."""

from dataclasses import dataclass

from .privacy_archives import (
    Request,
    Source,
    State,
    begin,
    configured,
    ready_bytes,
    step,
)
from .privacy_services import CurrentAuthority, DatabaseJournal, persist_started
from .privacy_sources import ExportSigner
from .privacy_storage import PrivateVolume


@dataclass
class ExportRuntime:
    """Construct per worker job; never install a signing key or private volume in the API.

    Source factories must explicitly supply all seven sources. No empty external-source
    fallback or default deployment path/key exists. The durable journal is the only queue
    and readiness authority; a completed filesystem write alone never publishes an archive.
    """

    sources: dict[str, Source]
    storage: PrivateVolume
    signer: ExportSigner

    def start(self, request: Request, now: int) -> State:
        authority = CurrentAuthority()
        state = begin(request, self.sources, self.storage, self.signer, authority, now)
        persist_started(state, authority)
        return state

    def advance(self, request_id: str, now: int) -> State:
        state = DatabaseJournal().load(request_id)
        return step(
            state.request,
            DatabaseJournal(),
            self.sources,
            self.storage,
            self.signer,
            CurrentAuthority(),
            now,
        )

    def artifact(self, request_id: str, now: int) -> bytes:
        configured(self.sources, self.storage, self.signer, CurrentAuthority())
        state = DatabaseJournal().load(request_id)
        return ready_bytes(state, self.sources, self.storage, self.signer, CurrentAuthority(), now)
