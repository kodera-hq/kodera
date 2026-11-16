# Durable first-device HTTP admission

Status: Proposed specification and acceptance contract. No production admission implementation or execution is claimed.

Basis: immutable `6dcc6773d65f6cd0056181ff8b88fcc346d964b2`, tree `03d31a75d60e6203be07752c8a577aabda33c228`. This specifies the next first-device increment over the existing real native actor and strict browser storage. It covers one worker, one device vault, registration and one retained key package. Group authority, room/history coordination, multi-tab leadership, native bridges and media stay separate. Existing HTTP routes and the false-default relay flag are unchanged.

## Keep the two clocks separate

`N` is the generation authenticated inside native KDV1 state. `G` is the IndexedDB record generation authenticated by the existing outer AES-GCM AAD. Both are positive safe integers. The current ABI happens to use N=G=1 and only permits its first 0→1 write. It cannot safely implement an outbox-only write by assigning the next G to native N.

Choose a closed encrypted sidecar and an explicit version 2 private bridge. Outbox-only writes advance G by 1, retain exactly the same sealed KDV1 bytes and retain N. Native writes advance N by 1 and G by 1. Require G>=N, reject overflow before any send, and never derive either clock by incrementing an untrusted reply. The native store trait's expected_generation remains N; its browser adapter performs the actual IDB CAS against independently held G.

Keep the KWE1 checkpoint wrapper and KCS1 outer storage encoding unchanged. The device-vault `pendingSends` list is either empty for the existing pre-admission profile or contains exactly one KDH1 manifest. Its entry UUID equals the manifest recordId and remains stable for the lifetime of this device transport profile. This is encrypted inside the existing record; no new IDB store, localStorage record, raw seed getter or plaintext index is added. Generic room outbox limits remain 32 entries/64 KiB each/1 MiB, but this first device profile uses only one entry.

An empty legacy device outbox is accepted for this transition only with current G=1 and successfully restored native N=1/admitted=None. Creating the KDH1 entry is a strict outer CAS G1→2, N1→1. An absent manifest at a later G is not silently reconstructed. `createUniqueDeviceVault` can keep its existing empty-outbox rule. Existing KDA1 pre-admission methods keep their narrow behavior; new transport operations explicitly require the version 2 bridge and must never fall back to KDA1.

## Exact KDH1 record

Bytes: ASCII `KDH1`, then one big-endian u32 JSON byte length, then exactly that many UTF-8 bytes; no tail. Total record<=65,536 bytes. JSON uses the following closed object, fixed field order and no insignificant whitespace. Readers reject unknown/duplicate fields, noncanonical UUID/base64/hex, invalid union combinations and any decode/re-encode mismatch. The canonical storage encoding does not reserialize the HTTP body.

```typescript
// Proposed storage types; these are not existing exported APIs.
type DeviceHttpV1 = {
  version: 1;
  recordId: UUID;                         // stable random UUID, never a secret
  scope: [UUID, UUID, UUID, Hex32];        // owner, organisation, membership, public key
  nativeGeneration: SafePositive;
  sealedSha256: Hex32;                    // exact KDV1 bytes in KWE1
  admission: null | {
    operationId: UUID; bodySha256: Hex32; deviceId: UUID; responseSha256: Hex32;
  };
  pending: null | {
    operation: 'register' | 'publish-package';
    operationId: UUID;                    // also the exact HTTP Idempotency-Key
    bodyBase64: CanonicalPaddedBase64;     // exact native SignedRelayRequest.body bytes
    bodySha256: Hex32;                    // raw bytes; not the server fingerprint format
    nativePackageId: null | Hex32;
    packageWireSha256: null | Hex32;
    phase: 'prepared' | 'attempted';
    recoverySpent: 0 | 1;                // required durable one-shot recovery budget
    firstAttemptAtMs: null | SafeUnsigned;
    retryBeforeMs: null | SafeUnsigned;    // scheduling metadata, not authority or proof
  };
  publication: null | {
    operationId: UUID; nativePackageId: Hex32; bodySha256: Hex32;
    corePackageId: UUID; packageWireSha256: Hex32;
    expiresAt: Rfc3339; responseSha256: Hex32;
  };
};
```

UUID means canonical lowercase nonnil UUID; Hex32 is exactly 64 lowercase hex characters. Times are finite safe integer milliseconds; expiresAt is a strictly parsed RFC 3339 value of <=64 UTF-8 bytes. Scope must equal the current independently selected device-vault scope. No bearer, refresh token, cookie, arbitrary method/URL/header, private HPKE material or message plaintext belongs in the manifest. Request bytes are 1..32,768 bytes; their canonical base64 is <=43,692 bytes. Check the actual final encoded 65,536-byte cap before CAS, including receipts. One admission receipt and one publication receipt are retained; the first slice does not prepare a second package, evict receipts or use native's 16-package allowance.

Register requires admission=null, publication=null, package IDs=null and an exact closed RegisterDevice proof for this native signer/scope. Publish requires admission.deviceId equal the native admitted ID and body deviceId, and a genuine pending native package. `nativePackageId` is the MLS KeyPackage hash_ref; `packageWireSha256` is SHA256 of the exact published TLS wire bytes. They are different domains: Core returns the latter as its base64 reference. Never compare that response reference to the MLS package ID. Recompute both through their owning implementations, not a caller-provided mapping.

Prepared requires both times=null and recoverySpent=0. Attempted requires both times present, firstAttemptAtMs<=retryBeforeMs<=firstAttemptAtMs+24h, with the addition checked for safe-integer overflow. The recoverySpent field is required; missing/unknown values refuse, never default to 0. Before first HTTP, an outer-only CAS changes phase to attempted and records the first local dispatch time and a conservative retry scheduling deadline no later than that time+24h. Never reset those times, operationId or a spent recovery budget on retry. Subsequent attempts reuse exactly the persisted request bytes and key. A pending request cannot coexist with an accepted publication in this first profile. Admission can coexist only with a pending publication, never a pending registration. The public-key value comes from the actual native device and never changes.

## Private CAS completion, not an echoed blob

The dedicated worker/Rust actor owns the validated manifest, cached exact sealed bytes, native N, independently read host G and the closed transition intent. It computes the successor record and expected acknowledgement before calling imported host code. Caller-supplied arbitrary manifest bytes, arbitrary JSON to sign, HTTP outcomes or receipt fields are not accepted as authority. New ABI names/implementation are not claimed here.

Proposed KDA2 is exactly 276 bytes in this order:

| Field | Bytes |
|---|---:|
| ASCII KDA2 |4|
| canonical owner, organisation, membership UUID text |36+36+36|
| native Ed25519 public key |32|
| manifest recordId UUID text |36|
| expectedNativeN, nextNativeN, expectedHostG, nextHostG, all big-endian u64 |8+8+8+8|
| SHA256 exact sealed KDV1, SHA256 complete KDH1 frame |32+32|

For an outer-only transition, nextNativeN==expectedNativeN; for a native write, nextNativeN==expectedNativeN+1. nextHostG is always expectedHostG+1. Require every value safe before conversion. Rust/worker computes the expected tuple from its owned transition; the host cannot choose the digest it is being asked to echo. The host freezes the entire outgoing state before its first await and calls the existing compareAndSwap with expectedGeneration=G. It waits for strict transaction oncomplete, then rereads the unique authoritative vault through the same live owner/incarnation, matches G+1 and every frozen checkpoint/manifest byte, and rechecks the captured current context. Only then may it return exact KDA2. Rust compares all 276 bytes and repeats active/current fencing after every imported callback or await, with no live RefCell borrow across JS. Separately require the same captured Worker instance/private port and active RPC/operation identity after each await and immediately before HTTP dispatch or output. Same owner/incarnation and a still-current Core principal do not authorize a replaced worker or retired RPC; late completions from the old worker stay suppressed. This reuses the existing actor/managed-worker boundary rather than inventing a Core ticket.

This explicitly adds a new private completion contract. Current 192-byte KDA1 does not bind G or the sidecar. Neither an IDB request onsuccess nor an ACK with only KDV1's digest may unlock this profile. Host/worker are trusted bridge code; the ACK is not a server signature or a defense against arbitrary same-origin code controlling every host fence. Existing global rollback limits still apply.

Any abort, cancellation, conflicting G, wrong/missing ACK or post-commit owner/current failure quarantines the actor, even for an outer-only transition. Restore is the only recovery. No fall back to a previously live handle, no resend while the stored outcome is uncertain, and no public request/receipt/package escapes a required CAS.

## Normal transitions and atomic retirement

The numbers below illustrate a path without extra writes; implementations must use actual observed G/N.

| Durable step | N | G | Manifest/native condition |
|---|---:|---:|---|
| Existing explicit device creation |1|1|legacy empty outbox, private KWE1 persisted|
| Queue exact registration |1|2|KDH1 prepared; no HTTP yet|
| Arm first registration send |1|3|attempted; key/body/times frozen|
| Accept registration and admit |2|4|new KDV1 admitted UUID + admission receipt + pending=null, ONE CAS|
| Prepare genuine HPKE package |3|5|native package secret state sealed; no HTTP request yet|
| Queue exact publication |3|6|same sealed bytes; closed native package statement prepared|
| Arm publication |3|7|attempted; no new native package generated|
| Accept publication |3|8|same sealed native pending package, publication receipt + pending=null, ONE CAS|

Registration accepts only the fixed production-route dispatcher's freshly authenticated 201, strict ConfidentialDevice body, unchanged signingKey and a valid device UUID. A same-key 201 replay is also valid after the same checks. The actor calls the existing admit_and_persist; its HostStore callback commits native next KDV1, matching nativeGeneration/sealedSha256, admission receipt and pending retirement together in one device-vault CAS. Never write a receipt first and native admission later. If any part fails, restore and inspect the single committed record before another action.

prepare_key_package_and_persist must complete its native+host CAS before the package or publication request can be sent. If the worker dies after that native write but before queuing publication, restore and recover the one package with pending_key_packages; do not create a replacement. Sign only RelayStatement::PublishKeyPackage for that retained native ID. The second outer-only CAS stores the exact signed body/key before any fetch. This two-write preparation does not expose private HPKE state or imply a public actor package getter.

A strict publication 201 must have exactly keyPackageId/reference/expiresAt; decode and compare reference against the retained packageWireSha256. Its UUID/expiry are Core response data, not native package identity. Receipt persistence and pending retirement are one outer-only CAS. Keep the native pending HPKE record: HTTP publication acknowledgement is not a Welcome consumption or permission to cancel it.

Current Core publish_package accepts opaque keyPackage bytes and computes their SHA256 reference, stores a server expiry of its current time plus seven days, then returns that row's ISO timestamp (services.py:490–516). The request has no expiry field, and Core does not parse or compare an MLS KeyPackage lifetime. There is therefore NO request/native-lifetime equality requirement. Accept expiresAt only as strictly parsed bounded RFC 3339 response metadata, retaining the exact returned value; do not demand local-clock-plus-seven-days equality or derive admission/send authority from it. A historical replay value is not a fresh eligibility grant. Native KeyPackage validity remains the native protocol's responsibility; this first publication profile does not certify group admission.

The dispatcher belongs at the existing api/client.ts global-fetch boundary. It derives only `/api/v1/organisations/{org}/confidential/devices` or `/key-packages`, sets Content-Type and the retained UUID key, and sends the decoded immutable body bytes directly. Do not pass these requests through middleware that invents a key or through object reserialization. Keep credentials ephemeral. Capture the real accepted owner/principal/context before dispatch; recheck after transport and persistence. Renewal must preserve that same accepted identity. A matching manifest or structural CurrentContextTicket is not itself Core authority. The closed accepted-session wiring is specified below; actual implementation and qualification remain required. No new Core authority ticket or route is introduced.

## Restore, lost acknowledgements and the 24-hour boundary

ReadUniqueDeviceVault must select the unique current record under the accepted owner/org/member. Validate outer G/owner incarnation and exact scope, parse KWE1 plus the one KDH1 frame, check sealedSha256 and all unions, and restore_device(scope,key,admission?.deviceId,N,sealed,seed). Pass N, NEVER G. Native restore authenticates N in its AAD and validates the admitted ID inside the decrypted state. Keep N/G separately in the actor; do not reset the host clock. Existing openDevice passes None and existing finish rejects admitted devices, so both require explicit narrowly checked extensions. Missing/corrupt/duplicate state never creates a signer.

A crash before a queue CAS commits leaves no sendable request. A crash after it commits recovers exactly its key/body. A crash after HTTP acceptance but before local completion restores either the old attempted record or the single fully admitted/published successor; it must not infer a partially committed result. Exact current201 can complete the old pending request. A completed successor suppresses retransmission. Context change/revocation closes output and sending; a stored receipt is not current eligibility.

Core's replay store deletes an expired 24-hour record before reexecuting. Its response-body guarantee therefore stops at 24 hours; a local wall clock/deadline is scheduling metadata, not proof that a receipt remains. Clock rollback or unknown elapsed time pauses normal retry. Beyond that horizon, or after an ambiguous restart, the only recovery path for this pending intent is its one persisted recovery budget. If recoverySpent=0, an outer-only CAS at current G sets it to1 while preserving N, sealed bytes, operationId, exact body/key and both original times; the complete KDH1 digest is bound by KDA2. This arming CAS must finish and pass reread/current/worker/RPC fences BEFORE HTTP. A crash before send still consumes the budget. Only the same still-live operation that successfully armed 0→1 may invoke the fixed dispatcher once; it consumes its private local dispatch cell before calling fetch. Reading recoverySpent=1 after restart conveys no send permission. If the arming CAS is uncertain, restore; never CAS-retry0→1 or issue HTTP from an uncertain predecessor. Once spent, a lost/failed recovery result stays OutcomeUnknown, with no further normal or recovery retry under a changed clock. No fresh intent is minted. This uses current source-specific safety: registration finds the same active signing-key/principal device, while publication checks any retained (device,raw-wire-reference) row and has a DB unique constraint. It is not a general idempotency theorem or permission for other operations.

A fresh authenticated 201 from that one permitted in-flight dispatch matching the pending request may complete it, including persisting receipt+retirement normally. A timeout, malformed response, 403, 404 or 409 never proves nonacceptance. A second worker crash after recovery arming may permanently block this first profile even while a server replay receipt still exists; availability does not reset the durable budget. In particular post-horizon duplicate-publication 409 cannot recover the missing Core package UUID, so keep the request/native HPKE state and return a bounded OutcomeUnknown/blocked result; no cancellation, new key, new package, signer recreation or claim of publication success. The first slice may remain blocked without a real outcome source. It does not invent an outcome endpoint or resolve durable group Commit horizons.

## Focused qualification needed before implementation acceptance

- Codec: closed fields/unions, duplicate/trailing bytes, wrong scope/recordId, oversized raw body/frame, noncanonical base64, nil IDs and unsafe integers; no seed or private fixture logging.
- Real IDB: N1/G3 survives restart; using G as N fails native restore. Outer-only writes retain exact KDV1. Native admission advances N once and G once. Wrong host/native clocks and partial sidecar ACKs refuse; a calibrated sidecar-digest omission must make its refusal oracle fail.
- Atomicity: inject abort/committed-but-ACK-lost at registration admission and publication retirement. Reread must show either complete predecessor or complete successor, with no admitted receipt/native mismatch. Cancellation/current-owner switch after oncomplete publishes nothing; later authoritative restore recovers committed state.
- Real HTTP in a separate explicitly opted-in synthetic deployment: lost registration/publication ACK and worker restart retry identical body/key; wrong returned signing key/ref/device/record owner refuse. Native pending package must preexist the first publication fetch. Termination between prepare and queue recovers the SAME package. No generic signer/caller outcome path.
- Horizon: expire actual replay records, verify stable registration response and duplicate publication409. The latter remains Unknown with unchanged HPKE/pending bytes. Crash before and after the recovery-arm CAS, then restart repeatedly: before commit no HTTP was allowed; after commit recoverySpent=1 allows zero further sends. A CAS-conflicting or committed-but-unacknowledged arm never dispatches. Removing the required budget or resetting it on restore must make the test oracle fail. Wrong/rolled-back clock cannot reclassify a spent intent as normal, mint a fresh key/package or evict storage. Resource exhaustion backpressures.
- Worker lifetime: replace the worker/retire RPC while preserving the same accepted owner and current IDB incarnation; late response, CAS completion and dispatch must all refuse. Keep this independent of the existing wrong-owner/current-Core negatives.

All of these are proposed controls, not executed tests. Preserve the 50 existing ABI cases and actual Core authority negatives; future source/ABI/runtime qualification is separate from PR157's current acceptance.

## Approved principal mapping and exclusive production ownership

The application owner maps exactly to authenticated `Me.id`, Core's stable person UUID, not the identity UUID, an email, provider subject or Matrix ID. Select the unique identity matching the exact SDK-processed issuer/subject pair and the unique active selected organisation membership. Require the identity UUID and organisation/member UUIDs canonical lowercase and nonnil, identity IDs unique, and membership.identity_id present/canonical/equal to the matched identity.id. This strict eligibility rule does not change the public schema's optional identity_id declaration. Require customer staff=false. Keep community's existing ADR-0013 route exception: do not require every organisation realm to equal the current identity realm.

Retain identityId, issuer and subject separately in the live accepted principal. Do not add them to MlsDeviceScope or change existing sealed-state formats by inference. Bind ownerId, organisationId and membershipId to the fixed worker/store context; native device scope remains organisation/member. Switching organisation does not delete or regenerate a person's store owner. Explicit owner deletion keeps its existing all-context key/incarnation tombstone; navigation or token renewal is not owner deletion.

The dedicated production worker owns the actual ConfidentialStateStore, non-extractable outer WebCrypto key handle, KWE1 seed, native provider/actor, N/G, KDH1 and KDA2 construction. The main thread owns the existing AuthAdapter and short-lived bearer and the fixed Core dispatcher. Only public routing context and exact prepared signed HTTP request bytes cross the internal port; no checkpoint, KWE seed, private provider, generic signing callback or token is returned by the public facade. Software wrapping seed custody does not imply hardware or universal memory non-extractability.

A single closed application factory captures the real AuthLifetime from the mounted provider and the selected organisation route. It creates and exclusively retains the Worker and both internal endpoint ownership records. The public facade exposes only explicit create-or-restore intent, registration/package preparation and deliberate dispatch, bounded status, and close. It has no injectable worker, port, fetch, token provider, arbitrary currentness callback, generic scope setter or accept-http-result entrypoint. Existing qualification fixtures remain test-only and are not imported into production.

For initial create or restore, require an explicit user-owned initialization intent and the SAME fixed private GET `/me` operation used for per-attempt observations below. This is not a query-cache or deduplicated UI-loader read. Capture the intent, SDK identity, auth/credential generations, retirement stamp, selected organisation route and exclusive Worker/port before reading. Strictly resolve the real result into the exact owner/identity/organisation/membership scope and bind its one-use initialization cell to that intent, resolved scope and Worker/RPC. Consume it only to start that captured create or restore; it cannot authorize a different worker, scope, intent or POST. Load required runtime code before observing, or obtain a new observation if its five-second monotonic lifetime expires before consumption. A later POST always obtains its own fresh observation. Missing or corrupt state during restore never authorizes a new signer. A private live context captures the exact SDK issuer/subject, owner/identity/org/member IDs, auth generation, credentialGeneration, retirement stamp, Worker identity, private port and active operation/RPC identity. Subscribe to retirement before asynchronous work. Recheck after each await and any synchronous callback that can reentrantly close or change the context. The same still-current person is insufficient if the worker or RPC was replaced.

## Finite first-profile admission bounds

These are deliberate client-profile refusal limits, not claims that Core currently guarantees these maxima. Exceeding a limit backpressures/refuses; no truncation, first-row selection, dropped identity, pagination guess or new signer is permitted.

| Input/resource | Limit |
|---|---:|
| Fresh `/me` UTF-8 response bytes actually consumed |262,144|
| Identities and organisation membership entries in that response |64 each|
| Usable bearer bytes, ephemeral only |16,384|
| Issuer UTF-8 bytes |2,048|
| Exact SDK subject ASCII bytes |1..255|
| Realm and selected organisation slug UTF-8 bytes |64 each|
| Email/display-name observation, never authority/persistence |320/800 UTF-8 bytes|
| Exact prepared POST body |32,768 bytes, inherited KDH1 bound|
| Registration/publication or safe problem response bytes |16,384|
| Total native/outer checkpoint and KDH1 storage |existing 17 MiB checkpoint plus one <=65,536-byte pending entry, within existing aggregate quotas|
| Active worker/actor and HTTP attempt per facade |1 each|
| Fresh `/me` request timeout |10 seconds|
| POST request timeout |30 seconds|
| Fresh observation completion to its bound initialization or POST invocation |at most 5 seconds on a nondecreasing monotonic clock|

Count actual response chunks before accumulation; Content-Length is advisory and cannot substitute. Use a bounded strict UTF-8 decode and runtime object/required-field/array/type/UUID checks before selecting an identity. Observe only the allowed Core fields needed for this decision, never getters or caller-supplied objects masquerading as network data. Reject ambiguous IDs, missing/unknown enum state and wrong selected binding. The synthetic fixtures at `tests/unit/api/fixtures/confidential-device-http.responses.json` describe public parser cases only; their zero-wire keys/digests are invalid cryptographic placeholders. Real native/HTTP acceptance must generate actual keys and packages through the compiled actor.

## Fresh fixed dispatcher and one-use initialization or attempt cell

The UI `loadCurrentUser()` query is not a dispatch lease: its same-credential cache has infinite stale time. After the exact request is durably prepared, each deliberate HTTP attempt performs a new network `/me` observation through a fixed private dispatcher. This observation is not placed in or obtained from the UI query cache. The narrow ADR-0014 proposal records this same fixed private GET for explicit initialization or one prepared POST attempt, and the two exact-body POSTs; it is not a general read capability. Ordinary reads/mutations retain their existing paths.

Capture the exact current usable credential, SDK issuer/subject, both auth generations and retirement stamp before reading. Derive only the configured Core API origin/version prefix; do not accept caller-selected URL, verb, headers or fetch. Use the fixed `/me` GET with no-store, redirect refusal and ephemeral bearer custody. Parse its real bounded response and recheck all local fences. The accepted mapped IDs must equal the worker's accepted scope/person/identity; a changed principal retires the old actor rather than rescoping its native state.

Create one private runtime-owned attempt cell bound to the Worker/private port, RPC/operation, immutable operation UUID, exact body/key/digest and this fresh observation. Arm the durable attempted state before the first HTTP as described above. If its CAS/reread exceeds the 5-second observation age, abort dispatch and obtain a new observation for a later deliberate attempt without resetting persisted first-attempt times. Consume the cell once immediately before the synchronous native POST invocation, after final currentness, time, worker and RPC checks. No await, injectable callback or reentrant gap may occur between the final check/consumption and actual invocation. A new attempt requires a new observation and preserves the original durable key/body.

The native dispatcher sets only fixed method/content type, retained Idempotency-Key, current ephemeral bearer, abort signal and network policy. It sends the immutable exact body bytes, never an object that middleware reserializes or supplies a new key for. It does not retry automatically. Redirects, wrong final URL/origin, non-JSON body, over-limit/invalid UTF-8, malformed or mismatched response refuse completion. Capture only bounded safe status/error codes; do not log bearer, private state, full `/me`, names/emails or raw signed request/response payloads.

A strict actual 201 for registration has exactly deviceId/signingKey. Validate canonical nonnil device UUID and canonical 32-byte signingKey equality to this native signer before admission. A publication 201 has exactly keyPackageId/reference/expiresAt; validate the public-wire digest domain and bounded RFC 3339 expiry. Optional Idempotency-Replayed may be absent or the exact string `true`; neither its presence nor a structural Response/TypeScript shape is network provenance. Only the private response cell created by the real fixed invocation may send a correlated outcome to the worker's internal endpoint. Public main-thread messages and fabricated 201 DTOs cannot mint that cell or call native admission. Close/retirement suppresses late transport, parse, CAS and publication callbacks even if the server committed.

An application-private port and closure are not a defense against arbitrary malicious same-origin code or a compromised dispatcher. A worker accepting any caller's bootstrap port/context through its public message handler would not meet this contract. Actual construction, branding, port identity and lack of public outcome-injection paths must be reviewed and tested, not inferred from TypeScript interfaces.

The local accepted context fences actor ownership only. A membership can change remotely after `/me`; Core's existing current principal/device/permission/effect checks remain the authorization authority. A read observation, TTL, local stamp or stored receipt does not become a new server ticket, signed lease, authority revision, room READ permission or verified-human claim.

## Acceptance required before implementation acceptance

All cases below are required future tests, not executed evidence. Preserve the existing 50 native/storage browser ABI cases and the reviewed codec/dual-clock/horizon controls above.

1. **Actual compiled worker and strict storage.** Compile the real reviewed WASM bridge, load its actual generated JS/declarations in a dedicated worker, create one real signer and commit KWE1 under explicit accepted-owner creation. Terminate/restart and recover the same key. Run real IndexedDB strict transaction abort, conflict, committed-but-ACK-lost and late owner/worker/RPC callback schedules; assert complete predecessor or successor only. Calibrate omission of the KDH1/KDA2 digest and N/G distinction so the negative oracle fails when its guard is disabled.
2. **Runtime principal decoder.** Prove the fixed initial GET is actually issued even when the UI query cache is populated or an earlier initialization read is in flight; each initialization cell is bound once to its captured intent/resolved scope/Worker and cannot be reused for a POST. Delayed initial replies after Worker/RPC replacement, context retirement or observation expiry create/open nothing. Use the synthetic Core response fixtures through the real closed decoder with a healthy same-credential positive. Exercise missing/mismatched identity_id, wrong person/identity/org/member IDs, duplicate/ambiguous identities and memberships, staff/inactive/unknown state, changed issuer/subject, malformed UUID/UTF-8/JSON/content type, advertised short length with oversized stream,65 entries and boundary response sizes. No refusal creates a signer, publishes bytes, re-enrolls a tombstoned owner or converts a stale cached response into authority.
3. **Actual configured transport enforcement.** Load the real public ESLint configuration. Keep owner-claim's positive and all escape/multiplicity/disabled-guard mutations intact. Add exact allowed private confidential callsite controls for the two POSTs and fresh `/me`; reject aliases, property/global-object/native export escapes, extra callsites, arbitrary URL/verb/fetch callbacks, automatic key allocation/retry and public fake-outcome setters. Static lint success alone is insufficient: qualify actual source-bound endpoint/body/key/credential/final-currentness and response work.
4. **Actual isolated Core/PG HTTP positive.** Use a separately admitted synthetic deployment with the existing relay gate explicitly opted in only for that test. Use the real customer URLConf, real authenticated synthetic token verification/current membership and PostgreSQL—not mocked dispatcher 201 responses. Register the real compiled worker signer, confirm matching stored device/scope/key, atomically persist its native admission and receipt, create one genuine HPKE package, durably queue and publish it, and confirm the retained private HPKE state and correct public-wire reference. Do not call a provider or enable an operator/production deployment.
5. **Lost acknowledgements and restart.** Drop registration and publication HTTP acknowledgements after actual Core commit; terminate the worker at the specified CAS boundaries, restart and deliberately retry the same persisted body/key. Verify one device and one retained package identity, exact request hashes and no new signer/package. Expire actual replay rows and exercise the one-shot recoverySpent 0→1 arm, including crash before/after commit and before actual send. A duplicate-publication 409 without its missing UUID remains Unknown; repeated restart does not spend another attempt or mint a new key.
6. **Real negative authority and routing.** Revoke identity/membership/device or change workspace permission between fresh read and POST; the real server refuses while local pending/native state remains recoverable. Switch account/org/issuer/subject, refresh same-identity credentials, retire RPC or replace only the Worker with the same owner/incarnation during fetch, parse, oncomplete and reread. Assert no stale native admission, send, ACK or public result. Wrong returned key/reference/device ID and cross-attempt outcome fail binding. Direct public 201 injection, wrong private-port nonce/request ID and unexpected Worker responses cannot reach the acceptance transition.
7. **Health and regression controls.** First prove each actual service/IDB/worker source healthy; distinguish setup/parser/tool failures from protocol refusal. Prove exact byte regeneration, TS strict/noUnchecked, lint, existing unit/browser/native gates and owned-resource teardown. Retain bounded public receipts with source/tool/tested-merge provenance. No skipped or retry-only control can substitute for the intended negative assertion.

This increment deliberately stops after durable real device registration and one key-package publication/recovery. Multi-client MLS room creation/Welcome/Commit/Application coordination, verified participants, durable history/receipt handoff, native platform bridges, encrypted LiveKit/Megolm media, hardware key protection and default operator enablement remain Planned. No UI badge or local demo channel is made confidential by this specification.
