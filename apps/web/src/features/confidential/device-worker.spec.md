# Fixed confidential-device worker

Status: Recovered implementation; unit and compilation checks pass; browser and live Core acceptance are separate gates.

The fixed factory alone transfers two endpoints and a correlation nonce to the
worker. Control commands and dispatcher work use separate channels. Neither a
nonce, a structural principal DTO, a transport response nor this protocol codec
is an authority grant. The actual private construction and dispatcher response
path remain necessary. No token enters this worker.

The worker initializes the actual generated module before ready and before any
fresh principal request. Explicit create/restore consumes one fresh observation
after opening the real selected store. Its local invocation deadline uses the
consume round trip and independent monotonic origin. After native invocation
starts, only ordinary current-operation/deadline fences apply; a later real CAS
completion is not incorrectly constrained to the five-second start window.

Each native invocation captures one immutable RPC/native-operation pair. Every
native currentness callback checks the complete closed HTTP profile and owned
scope, public key, N/G, record/digest and admitted ID. Real strict IDB creation
and the actual V2 host must commit and reread before any ACK. N is never inferred
from G. KWE1's capsule ID and seed header survive every V2 write. The capsule ID,
KDH1 record UUID and Core device/package UUIDs remain distinct domains.

Private wrappers correlate actual native attempt identity with the same live
RPC and dispatcher cell. A cloned object cannot substitute for a wrapper.
Commands provide no body, key, receipt, URL, transport or host. Preparing a
publication persists real HPKE state before transport. Recovery budget and the
original retry horizon are interpreted by the existing native actor, never
reset or recreated here. Failure after consumed initialization or an uncertain
native/storage operation closes the worker; a fresh factory and explicit
restore are required. No automatic signer creation or retry exists.

The unit tests cover strict protocol parsing and controlled worker startup,
channel and clock orchestration. Controlled native/store oracles are labelled
as such and do not prove crypto, real IDB, main-factory authority or Core HTTP.
Required compiled-worker acceptance before integration includes:

- Actual generated initialization precedes GET; failure and delayed startup
  never create a signer. Rebootstrap, extra endpoints/fields, wrong nonce/RPC,
  cross-port replay and malformed replies close the correct operation.
- Actual native signer plus strict IDB create and fresh-process restore return
  the same public key; header/manifest/N/G changes refuse. A missing or
  tombstoned owner never becomes an implicit create.
- Separate main/worker clock origins and slow consume callbacks refuse stale
  starts. A valid start followed by a later successful CAS still completes.
- Actual competing CAS, aborted commit, lost acknowledgement and termination
  before/after every persistence boundary never acknowledge an unverified
  successor. G-only transitions preserve the native checkpoint exactly.
- Actual private dispatcher cells accept only their captured operation and
  exact persisted bytes. Late/foreign replies cannot revive retired work.
- Restart with attempted state preserves the original request/key and spent
  recovery budget. Registration/publication and post-commit lost HTTP ACKs
  additionally require the separately isolated real Core/PG acceptance.

No production flag, native API, dependency, workflow or operator configuration
is changed by this slice. Generated assets currently remain a source-bound
local bootstrap; production bundle/CSP/Docker and WebView acceptance are separate.
