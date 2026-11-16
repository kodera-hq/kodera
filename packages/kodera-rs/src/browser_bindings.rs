//! Private worker ABI for the legacy pre-admission device and durable device HTTP profile.
//!
//! This module is not a main-thread RPC surface. The trusted worker owns the
//! wrapping seed and fixed host capability. There is no key/provider getter,
//! general signing operation, room operation or automatic signer replacement.
//! A host acknowledgement is a durability contract, not a cryptographic proof
//! against a dishonest host or rollback of all independent storage fences.
//! Returned errors use closed codes. Upstream provider construction can panic
//! on entropy failure; a trap or worker timeout must trigger worker disposal
//! and authoritative restore, not a retry on a possibly mutated live handle.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use js_sys::{futures::future_to_promise, Promise, Uint8Array};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tls_codec::SecretVLBytes;
use wasm_bindgen::prelude::*;

use crate::device_http_record::{
    DeviceHttpAck, DeviceHttpAdmission, DeviceHttpOperation, DeviceHttpPending, DeviceHttpPhase,
    DeviceHttpPublication, DeviceHttpRecord,
};
use crate::RelayStatement;
use crate::{
    Ed25519PublicKey, MlsDeviceScope, MlsDeviceStore, MlsDeviceStoreError, MlsDeviceWrite,
    NativeCryptoError, OpenMlsDevice, OrganisationId, RelayId, SealedMlsDeviceState,
    MAX_SEALED_MLS_DEVICE_BYTES,
};

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const MAX_IDENTITY: u32 = 128;
const MAX_REGISTRATION: usize = 1024;
const ACK_BYTES: usize = 192;
// The KWE1 worker capsule adds a 56-byte header inside the 17 MiB host record.
const MAX_WORKER_VAULT_BYTES: usize = MAX_SEALED_MLS_DEVICE_BYTES - 56;
const HTTP_HORIZON_MS: u64 = 86_400_000;

// Intrinsics are captured inside the private module. No input accessor is used
// before an actual ordinary typed-array view is established. The first copy is
// bounded in JS, before a Rust Vec can be allocated by a binding conversion.
// This does not defend a worker whose trusted module/intrinsics are compromised.
#[wasm_bindgen(inline_js = r#"
const U8 = Uint8Array;
const AB = ArrayBuffer;
const typed = Object.getPrototypeOf(U8.prototype);
const bufferOf = Object.getOwnPropertyDescriptor(typed, 'buffer').get;
const lengthOf = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
const resizable = Object.getOwnPropertyDescriptor(AB.prototype, 'resizable')?.get;
const view = AB.isView;
const proto = Object.getPrototypeOf;
const set = U8.prototype.set;
const fill = U8.prototype.fill;
const NativePromise = Promise;
const then = NativePromise.prototype.then;
const wallNow = Date.now.bind(Date);
const monotonicNow = performance.now.bind(performance);
const stringify = JSON.stringify;
const descriptors = Object.getOwnPropertyDescriptors;
const ownKeys = Reflect.ownKeys;
const nativeBtoa = btoa;
const fromCharCode = String.fromCharCode;
function branded(pending) {
    return new NativePromise((resolve, reject) => then.call(pending, resolve, reject));
}
function own(value, names) {
    if (!value || proto(value) !== Object.prototype) throw new Error('InvalidInput');
    const fields = descriptors(value);
    const keys = ownKeys(fields);
    if (keys.some((key) => typeof key !== 'string') ||
        keys.sort().join(',') !== names.slice().sort().join(',')) throw new Error('InvalidInput');
    const out = {};
    for (const name of names) {
        if (!Object.hasOwn(fields[name], 'value')) throw new Error('InvalidInput');
        out[name] = fields[name].value;
    }
    return out;
}
export function kdwCapture(value, min, max) {
    if (!view(value) || proto(value) !== U8.prototype) throw new Error('InvalidInput');
    const buffer = bufferOf.call(value);
    if (!(buffer instanceof AB) || (resizable && resizable.call(buffer))) throw new Error('InvalidInput');
    const length = lengthOf.call(value);
    if (length < min || length > max) throw new Error('InvalidInput');
    const copy = new U8(length);
    set.call(copy, value);
    return copy;
}
export function kdwErase(value) { fill.call(value, 0); }
export function kdwUuid(value) {
    if (typeof value !== 'string' || value.length !== 36 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ||
        value === '00000000-0000-0000-0000-000000000000') throw new Error('InvalidInput');
    return value;
}
export function kdwCurrent(host, context) {
    const result = host.checkCurrent(context);
    if (typeof result !== 'boolean') throw new Error('Context');
    return result;
}
export function kdwCas(host, metadata, sealed) {
    // Calling the captured intrinsic then enforces the native Promise brand;
    // immediate acknowledgements, plain thenables and proxy wrappers reject.
    // The host must still acknowledge only after actual transaction oncomplete.
    const pending = host.compareAndSwapDevice(metadata, sealed);
    return new NativePromise((resolve, reject) => then.call(pending, resolve, reject));
}
export function kdwPublicBytes(bytes) {
    // A fresh public output buffer never aliases WASM memory or a private input.
    const copy = new U8(lengthOf.call(bytes));
    set.call(copy, bytes);
    return copy;
}
export function kdwCasV2(host, metadata, sealed, record) {
    return branded(host.compareAndSwapDeviceV2(metadata, sealed, record));
}
export function kdwPrepareAttempt(host, metadata, body) {
    return branded(host.prepareDeviceHttpAttempt(metadata, body));
}
export function kdwAttemptInfo(host, cell) {
    const value = host.deviceHttpAttemptInfo(cell);
    if (typeof value !== 'string' || value.length > 512 || /[^\x20-\x7e]/.test(value)) throw new Error('InvalidInput');
    return value;
}
export function kdwSendAttempt(host, cell, metadata, body) {
    return branded(host.sendDeviceHttpAttempt(cell, metadata, body));
}
export function kdwOutcome(value) {
    if (!value || proto(value) !== Object.prototype) throw new Error('InvalidInput');
    const kind = descriptors(value).kind;
    if (!kind || !Object.hasOwn(kind, 'value')) throw new Error('InvalidInput');
    if (kind.value === 'unknown') { own(value, ['kind']); return '{"kind":"unknown"}'; }
    const v = own(value, ['kind', 'actorOperation', 'operationId', 'bodySha256', 'status', 'contentType', 'requestId', 'replayed', 'body']);
    if (v.kind !== 'response' || !Number.isSafeInteger(v.actorOperation) || v.actorOperation < 1 ||
        typeof v.operationId !== 'string' || v.operationId.length !== 36 ||
        typeof v.bodySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.bodySha256) ||
        !Number.isInteger(v.status) || v.status < 100 || v.status > 599 ||
        typeof v.contentType !== 'string' || v.contentType.length > 128 || /[^\x20-\x7e]/.test(v.contentType) ||
        typeof v.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(v.requestId) ||
        (v.replayed !== null && v.replayed !== 'true')) throw new Error('InvalidInput');
    const body = kdwCapture(v.body, 0, 16384);
    const result = stringify({kind:'response',actorOperation:v.actorOperation,operationId:v.operationId,
        bodySha256:v.bodySha256,status:v.status,contentType:v.contentType,requestId:v.requestId,
        replayed:v.replayed,bodyBase64:nativeBtoa(fromCharCode(...body))});
    if (result.length > 24576) throw new Error('InvalidInput');
    return result;
}
export function kdwClock() {
    const value = stringify([wallNow(), monotonicNow()]);
    if (value.length > 128) throw new Error('InvalidInput');
    return value;
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = kdwCapture)]
    fn capture(value: &JsValue, min: u32, max: u32) -> Result<Uint8Array, JsValue>;
    #[wasm_bindgen(catch, js_name = kdwErase)]
    fn erase(value: &Uint8Array) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = kdwUuid)]
    fn bounded_uuid(value: &JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = kdwCurrent)]
    fn current(host: &JsValue, context: &str) -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = kdwCas)]
    fn cas(host: &JsValue, metadata: &str, sealed: &Uint8Array) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_name = kdwPublicBytes)]
    fn public_bytes(bytes: &Uint8Array) -> Result<Uint8Array, JsValue>;
    #[wasm_bindgen(catch, js_name = kdwCasV2)]
    fn cas_v2(
        host: &JsValue,
        metadata: &str,
        sealed: &Uint8Array,
        record: &Uint8Array,
    ) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_name = kdwPrepareAttempt)]
    fn prepare_attempt(
        host: &JsValue,
        metadata: &str,
        body: &Uint8Array,
    ) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_name = kdwAttemptInfo)]
    fn attempt_info(host: &JsValue, cell: &JsValue) -> Result<String, JsValue>;
    #[wasm_bindgen(catch, js_name = kdwSendAttempt)]
    fn send_attempt(
        host: &JsValue,
        cell: &JsValue,
        metadata: &str,
        body: &Uint8Array,
    ) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_name = kdwOutcome)]
    fn captured_outcome(value: &JsValue) -> Result<String, JsValue>;
    #[wasm_bindgen(catch, js_name = kdwClock)]
    fn captured_clock() -> Result<String, JsValue>;
}

#[derive(Clone, Copy)]
enum Failure {
    InvalidInput,
    Busy,
    Closed,
    RestoreRequired,
    Context,
    Storage,
    Crypto,
    Capacity,
}

impl Failure {
    fn js(self) -> JsValue {
        JsValue::from_str(match self {
            Self::InvalidInput => "InvalidInput",
            Self::Busy => "Busy",
            Self::Closed => "Closed",
            Self::RestoreRequired => "RestoreRequired",
            Self::Context => "Context",
            Self::Storage => "Storage",
            Self::Crypto => "Crypto",
            Self::Capacity => "Capacity",
        })
    }
}

impl From<NativeCryptoError> for Failure {
    fn from(value: NativeCryptoError) -> Self {
        match value {
            NativeCryptoError::InvalidInput => Self::InvalidInput,
            NativeCryptoError::Capacity => Self::Capacity,
            NativeCryptoError::Storage => Self::Storage,
            _ => Self::Crypto,
        }
    }
}

struct Binding {
    owner: RelayId,
    scope: MlsDeviceScope,
}

impl Binding {
    fn expectation(&self, key: Option<&Ed25519PublicKey>, generation: u64) -> String {
        json!({
            "version": 1,
            "ownerId": self.owner.as_str(),
            "organisationId": self.scope.organisation().as_str(),
            "membershipId": self.scope.membership().as_str(),
            "devicePublicKey": key.map(|key| hex(key)),
            "generation": generation,
            "admittedDeviceId": null,
        })
        .to_string()
    }
}

struct Actor {
    host: JsValue,
    binding: Binding,
    closed: Cell<bool>,
    busy: Cell<bool>,
    restore_required: Cell<bool>,
    operation: Cell<u64>,
    device: RefCell<Option<OpenMlsDevice>>,
    profile: Profile,
    http: RefCell<Option<HttpState>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Profile {
    Legacy,
    Http,
}

/// An empty actor is not a usable crypto session. Only a successful persisted
/// create/open enables publicKey/registrationRequest. Keep this object inside
/// the trusted dedicated worker; it is not a Core admission capability.
#[wasm_bindgen]
pub struct BrowserMlsDevice {
    actor: Rc<Actor>,
}

// Never hold a RefCell borrow across ANY JS import, including synchronous host
// predicates and input helpers. The owned device sits in this guard instead.
struct Operation {
    actor: Rc<Actor>,
    id: u64,
    device: Option<OpenMlsDevice>,
    complete: bool,
    http: Option<HttpState>,
}

impl Actor {
    fn idle(&self) -> Result<(), Failure> {
        if self.closed.get() {
            Err(Failure::Closed)
        } else if self.busy.get() {
            Err(Failure::Busy)
        } else if self.restore_required.get() {
            Err(Failure::RestoreRequired)
        } else {
            Ok(())
        }
    }

    fn begin(self: &Rc<Self>, existing: bool) -> Result<Operation, Failure> {
        self.idle()?;
        let mut slot = self.device.try_borrow_mut().map_err(|_| Failure::Busy)?;
        let mut http = self.http.try_borrow_mut().map_err(|_| Failure::Busy)?;
        if slot.is_some() != existing {
            return Err(Failure::InvalidInput);
        }
        if (self.profile == Profile::Http && http.is_some() != existing)
            || (self.profile == Profile::Legacy && http.is_some())
        {
            return Err(Failure::InvalidInput);
        }
        let id = self
            .operation
            .get()
            .checked_add(1)
            .ok_or(Failure::Capacity)?;
        let device = slot.take();
        let http = http.take();
        drop(slot);
        self.operation.set(id);
        self.busy.set(true);
        // Quarantine precedes crypto, JS reentrancy and every possible await.
        // A dropped or uncertain operation never returns the old live device.
        self.restore_required.set(true);
        Ok(Operation {
            actor: Rc::clone(self),
            id,
            device,
            complete: false,
            http,
        })
    }
}

impl Operation {
    fn active(&self) -> Result<(), Failure> {
        if self.actor.closed.get() {
            Err(Failure::Closed)
        } else if !self.actor.busy.get() || self.actor.operation.get() != self.id {
            Err(Failure::RestoreRequired)
        } else {
            Ok(())
        }
    }

    fn fence(&self, key: Option<&Ed25519PublicKey>, generation: u64) -> Result<(), Failure> {
        if self.actor.profile == Profile::Http {
            return self.http_fence(key, generation, generation, None);
        }
        self.active()?;
        let context = self.actor.binding.expectation(key, generation);
        let accepted = current(&self.actor.host, &context).map_err(|_| Failure::Context)?;
        // A host can reentrantly close the actor while returning true. Never
        // interpret its boolean without checking the live operation again.
        self.active()?;
        if !accepted {
            return Err(Failure::Context);
        }
        Ok(())
    }

    fn finish(mut self, device: OpenMlsDevice) -> Result<(), Failure> {
        self.active()?;
        if self.actor.profile != Profile::Legacy || self.http.is_some() {
            return Err(Failure::InvalidInput);
        }
        if device.requires_restore() || device.admitted_id().is_some() {
            return Err(Failure::RestoreRequired);
        }
        let mut slot = self
            .actor
            .device
            .try_borrow_mut()
            .map_err(|_| Failure::Busy)?;
        if slot.is_some() {
            return Err(Failure::RestoreRequired);
        }
        *slot = Some(device);
        drop(slot);
        self.actor.restore_required.set(false);
        self.actor.busy.set(false);
        self.complete = true;
        Ok(())
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        if !self.complete && self.actor.operation.get() == self.id {
            self.actor.restore_required.set(true);
            self.actor.busy.set(false);
        }
        // The device, if any, drops here. No failed operation reinstalls it.
    }
}

fn uuid(value: &JsValue) -> Result<String, Failure> {
    bounded_uuid(value)
        .map_err(|_| Failure::InvalidInput)?
        .as_string()
        .ok_or(Failure::InvalidInput)
}

fn bytes(value: &JsValue, min: u32, max: u32) -> Result<Vec<u8>, Failure> {
    let copy = capture(value, min, max).map_err(|_| Failure::InvalidInput)?;
    // Only the fresh, bounded, ordinary non-resizable copy reaches to_vec.
    Ok(copy.to_vec())
}

fn seed(value: &JsValue) -> Result<SecretVLBytes, Failure> {
    let copy = capture(value, 32, 32).map_err(|_| Failure::InvalidInput)?;
    let secret = SecretVLBytes::new(copy.to_vec());
    // Erase our controlled JS copy too; the worker still owns the original
    // seed. No universal JS/WASM/provider-memory wipe is promised.
    erase(&copy).map_err(|_| Failure::InvalidInput)?;
    Ok(secret)
}

fn seed_key(secret: &SecretVLBytes) -> Result<&[u8; 32], Failure> {
    secret
        .as_slice()
        .try_into()
        .map_err(|_| Failure::InvalidInput)
}

fn generation(value: &JsValue) -> Result<u64, Failure> {
    let value = value.as_f64().ok_or(Failure::InvalidInput)?;
    if !value.is_finite() || value.fract() != 0.0 || value < 1.0 || value > MAX_SAFE_INTEGER as f64
    {
        return Err(Failure::InvalidInput);
    }
    Ok(value as u64)
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        result.push(DIGITS[(byte >> 4) as usize] as char);
        result.push(DIGITS[(byte & 15) as usize] as char);
    }
    result
}

fn output(bytes: &[u8]) -> Result<JsValue, Failure> {
    let view = Uint8Array::from(bytes);
    public_bytes(&view)
        .map(JsValue::from)
        .map_err(|_| Failure::Storage)
}

struct HostStore<'a> {
    operation: &'a Operation,
}

impl MlsDeviceStore for HostStore<'_> {
    async fn compare_and_swap<'a>(
        &'a mut self,
        write: &'a MlsDeviceWrite<'_>,
    ) -> Result<(), MlsDeviceStoreError> {
        self.write(write)
            .await
            .map_err(|_| MlsDeviceStoreError::Unavailable)
    }
}

impl HostStore<'_> {
    async fn write(&self, write: &MlsDeviceWrite<'_>) -> Result<(), Failure> {
        let operation = self.operation;
        operation.active()?;
        // This first ABI only creates a pre-admission device. Room or later
        // lifecycle writes cannot silently use an incomplete host adapter.
        if write.initial_room.is_some()
            || write.scope != &operation.actor.binding.scope
            || write.expected_generation != 0
            || write.generation != 1
            || write.sealed.as_bytes().len() > MAX_WORKER_VAULT_BYTES
        {
            return Err(Failure::InvalidInput);
        }
        operation.fence(None, 0)?;
        // Public checkpoint hashing must not construct an entropy-seeded MLS
        // provider. This is the same pinned SHA-256 implementation it uses.
        let digest = Sha256::digest(write.sealed.as_bytes());
        let metadata = json!({
            "version": 1,
            "ownerId": operation.actor.binding.owner.as_str(),
            "organisationId": write.scope.organisation().as_str(),
            "membershipId": write.scope.membership().as_str(),
            "devicePublicKey": hex(&write.device_key),
            "expectedGeneration": write.expected_generation,
            "generation": write.generation,
            "checkpointSha256": hex(digest.as_ref()),
        })
        .to_string();
        let mut expected = Vec::with_capacity(ACK_BYTES);
        expected.extend_from_slice(b"KDA1");
        expected.extend_from_slice(operation.actor.binding.owner.as_str().as_bytes());
        expected.extend_from_slice(write.scope.organisation().as_str().as_bytes());
        expected.extend_from_slice(write.scope.membership().as_str().as_bytes());
        expected.extend_from_slice(&write.device_key);
        expected.extend_from_slice(&write.expected_generation.to_be_bytes());
        expected.extend_from_slice(&write.generation.to_be_bytes());
        expected.extend_from_slice(digest.as_ref());
        let ciphertext = Uint8Array::from(write.sealed.as_bytes());
        operation.active()?;
        let pending =
            cas(&operation.actor.host, &metadata, &ciphertext).map_err(|_| Failure::Storage)?;
        operation.active()?;
        let value = pending.await.map_err(|_| Failure::Storage)?;
        operation.active()?;
        let ack = bytes(&value, ACK_BYTES as u32, ACK_BYTES as u32)?;
        operation.active()?;
        if ack != expected {
            return Err(Failure::Storage);
        }
        // The host must verify its accepted owner/incarnation/current record
        // after oncomplete. Failure here can follow a real commit: restore.
        operation.fence(Some(&write.device_key), write.generation)?;
        Ok(())
    }
}

#[wasm_bindgen]
impl BrowserMlsDevice {
    /// Allocate an empty worker-local actor, not a usable session or signer.
    #[wasm_bindgen(constructor)]
    pub fn new(
        host: JsValue,
        owner: JsValue,
        organisation: JsValue,
        membership: JsValue,
    ) -> Result<BrowserMlsDevice, JsValue> {
        let owner = RelayId::parse(&uuid(&owner).map_err(Failure::js)?)
            .map_err(|_| Failure::InvalidInput.js())?;
        let organisation = OrganisationId::parse(&uuid(&organisation).map_err(Failure::js)?)
            .map_err(|_| Failure::InvalidInput.js())?;
        let membership = RelayId::parse(&uuid(&membership).map_err(Failure::js)?)
            .map_err(|_| Failure::InvalidInput.js())?;
        Ok(Self {
            actor: Rc::new(Actor {
                host,
                binding: Binding {
                    owner,
                    scope: MlsDeviceScope::new(organisation, membership),
                },
                closed: Cell::new(false),
                busy: Cell::new(false),
                restore_required: Cell::new(false),
                operation: Cell::new(0),
                device: RefCell::new(None),
                profile: Profile::Legacy,
                http: RefCell::new(None),
            }),
        })
    }

    /// Explicit create consent is private-worker policy, not server admission.
    /// The supplied wrapping seed never appears in an output or generic callback.
    #[wasm_bindgen(js_name = createDevice)]
    pub fn create_device(
        &self,
        identity: JsValue,
        wrapping_seed: JsValue,
        consent: JsValue,
    ) -> Result<Promise, JsValue> {
        if self.actor.profile != Profile::Legacy {
            return Err(Failure::InvalidInput.js());
        }
        self.actor.idle().map_err(Failure::js)?;
        if consent.as_bool() != Some(true) {
            return Err(Failure::InvalidInput.js());
        }
        let identity = bytes(&identity, 1, MAX_IDENTITY).map_err(Failure::js)?;
        let seed = seed(&wrapping_seed).map_err(Failure::js)?;
        let operation = self.actor.begin(false).map_err(Failure::js)?;
        Ok(future_to_promise(async move {
            let result = async {
                operation.fence(None, 0)?;
                let scope = operation.actor.binding.scope.clone();
                let device = {
                    let mut store = HostStore {
                        operation: &operation,
                    };
                    OpenMlsDevice::create_and_persist(
                        scope,
                        &identity,
                        seed_key(&seed)?,
                        &mut store,
                    )
                    .await
                    .map_err(Failure::from)?
                };
                operation.fence(Some(&device.device_key()), device.generation())?;
                // No public key or live device escapes before persistence and
                // its current-context fence. publicKey is a separate operation.
                operation.finish(device)?;
                Ok(JsValue::UNDEFINED)
            }
            .await;
            result.map_err(Failure::js)
        }))
    }

    /// Restore exactly the authoritative current pre-admission record. A missing
    /// or corrupt record is never interpreted as consent to generate a signer.
    #[wasm_bindgen(js_name = openDevice)]
    pub fn open_device(
        &self,
        public_key: JsValue,
        expected_generation: JsValue,
        sealed: JsValue,
        wrapping_seed: JsValue,
    ) -> Result<Promise, JsValue> {
        if self.actor.profile != Profile::Legacy {
            return Err(Failure::InvalidInput.js());
        }
        self.actor.idle().map_err(Failure::js)?;
        let key: Ed25519PublicKey = bytes(&public_key, 32, 32)
            .map_err(Failure::js)?
            .try_into()
            .map_err(|_| Failure::InvalidInput.js())?;
        let generation = generation(&expected_generation).map_err(Failure::js)?;
        let ciphertext = bytes(&sealed, 36, MAX_WORKER_VAULT_BYTES as u32).map_err(Failure::js)?;
        let sealed = SealedMlsDeviceState::from_bytes(&ciphertext)
            .map_err(|value| Failure::from(value).js())?;
        let seed = seed(&wrapping_seed).map_err(Failure::js)?;
        let operation = self.actor.begin(false).map_err(Failure::js)?;
        Ok(future_to_promise(async move {
            let result = (|| {
                operation.fence(Some(&key), generation)?;
                let device = OpenMlsDevice::restore_device(
                    operation.actor.binding.scope.clone(),
                    key,
                    None,
                    generation,
                    &sealed,
                    seed_key(&seed)?,
                )
                .map_err(Failure::from)?;
                operation.fence(Some(&device.device_key()), device.generation())?;
                operation.finish(device)?;
                Ok(JsValue::UNDEFINED)
            })();
            result.map_err(Failure::js)
        }))
    }

    #[wasm_bindgen(js_name = publicKey)]
    pub fn public_key(&self) -> Result<JsValue, JsValue> {
        self.public_result(false).map_err(Failure::js)
    }

    /// Closed RegisterDevice proof only. No idempotency/transport/admission is
    /// implemented here; any RPC correlation identifier stays outside Rust.
    #[wasm_bindgen(js_name = registrationRequest)]
    pub fn registration_request(&self) -> Result<JsValue, JsValue> {
        self.public_result(true).map_err(Failure::js)
    }

    /// Close is synchronous and cannot be blocked by an exported async borrow.
    /// A pending operation may still commit storage but cannot publish a result.
    pub fn close(&self) {
        self.actor.closed.set(true);
        self.actor.restore_required.set(true);
        if let Ok(mut slot) = self.actor.device.try_borrow_mut() {
            slot.take();
        }
    }
}

impl Drop for BrowserMlsDevice {
    fn drop(&mut self) {
        // Explicit free/finalization of the shell must not leave an in-flight
        // Rc operation alive as an apparently open actor.
        self.close();
    }
}

impl BrowserMlsDevice {
    fn public_result(&self, registration: bool) -> Result<JsValue, Failure> {
        if self.actor.profile != Profile::Legacy {
            return Err(Failure::InvalidInput);
        }
        let mut operation = self.actor.begin(true)?;
        let device = operation.device.take().ok_or(Failure::RestoreRequired)?;
        operation.fence(Some(&device.device_key()), device.generation())?;
        let result = if registration {
            let request = device.registration_request().map_err(Failure::from)?;
            if request.body().len() > MAX_REGISTRATION {
                return Err(Failure::Capacity);
            }
            output(request.body())?
        } else {
            output(&device.device_key())?
        };
        operation.active()?;
        operation.fence(Some(&device.device_key()), device.generation())?;
        operation.finish(device)?;
        Ok(result)
    }
}

// The HTTP shell is a separate generated class: the legacy JS prototype and
// registrationRequest proof path do not grow a transport-capable mode.
#[wasm_bindgen]
pub struct BrowserMlsHttpDevice {
    actor: Rc<Actor>,
}

struct HttpState {
    native: u64,
    host: u64,
    sealed: Vec<u8>,
    record: Option<DeviceHttpRecord>,
    frame: Vec<u8>,
    seed: SecretVLBytes,
    clock: Option<LiveAttemptClock>,
}

struct HttpSnapshot {
    native: u64,
    host: u64,
    sealed: Vec<u8>,
    record: DeviceHttpRecord,
    frame: Vec<u8>,
}

impl HttpState {
    fn install(&mut self, next: HttpSnapshot) {
        self.native = next.native;
        self.host = next.host;
        self.sealed = next.sealed;
        self.record = Some(next.record);
        self.frame = next.frame;
    }

    fn name(&self) -> &'static str {
        let Some(record) = &self.record else {
            return "pre-admission";
        };
        if record.publication.is_some() {
            return "published";
        }
        if let Some(p) = &record.pending {
            return match (p.operation, p.phase) {
                (DeviceHttpOperation::Register, DeviceHttpPhase::Prepared) => {
                    "registration-prepared"
                }
                (DeviceHttpOperation::Register, DeviceHttpPhase::Attempted) => {
                    "registration-attempted"
                }
                (DeviceHttpOperation::PublishPackage, DeviceHttpPhase::Prepared) => {
                    "publication-prepared"
                }
                (DeviceHttpOperation::PublishPackage, DeviceHttpPhase::Attempted) => {
                    "publication-attempted"
                }
            };
        }
        if record.admission.is_some() {
            "admitted"
        } else {
            "pre-admission"
        }
    }
}

#[derive(Clone, Copy)]
struct ClockReading {
    wall: u64,
    monotonic: f64,
}

fn clock_reading() -> Result<ClockReading, Failure> {
    let text = captured_clock().map_err(|_| Failure::Context)?;
    let (wall, monotonic): (u64, f64) =
        serde_json::from_str(&text).map_err(|_| Failure::Context)?;
    if wall > MAX_SAFE_INTEGER
        || !monotonic.is_finite()
        || monotonic < 0.0
        || monotonic > MAX_SAFE_INTEGER as f64
    {
        return Err(Failure::Context);
    }
    Ok(ClockReading { wall, monotonic })
}

struct LiveAttemptClock {
    operation: String,
    first: ClockReading,
    last: ClockReading,
    ambiguous: bool,
}

impl LiveAttemptClock {
    fn normal(&mut self, pending: &DeviceHttpPending, now: ClockReading) -> bool {
        let valid = !self.ambiguous
            && pending.operation_id == self.operation
            && pending.first_attempt_at_ms == Some(self.first.wall)
            && now.wall >= self.last.wall
            && now.monotonic >= self.last.monotonic
            && pending.retry_before_ms.is_some_and(|deadline| {
                deadline >= self.first.wall
                    && now.wall <= deadline
                    && (now.monotonic - self.first.monotonic).is_finite()
                    && now.monotonic - self.first.monotonic <= (deadline - self.first.wall) as f64
            });
        if valid {
            self.last = now;
        } else {
            self.ambiguous = true;
        }
        valid
    }
}

impl Binding {
    fn http_scope(&self, key: &Ed25519PublicKey) -> [String; 4] {
        [
            self.owner.as_str().to_owned(),
            self.scope.organisation().as_str().to_owned(),
            self.scope.membership().as_str().to_owned(),
            hex(key),
        ]
    }
}

impl Operation {
    fn http_fence(
        &self,
        key: Option<&Ed25519PublicKey>,
        native: u64,
        host: u64,
        record: Option<&DeviceHttpRecord>,
    ) -> Result<(), Failure> {
        self.active()?;
        if self.actor.profile != Profile::Http || self.id > MAX_SAFE_INTEGER {
            return Err(Failure::InvalidInput);
        }
        let frame = record
            .map(DeviceHttpRecord::encode)
            .transpose()
            .map_err(|_| Failure::InvalidInput)?;
        let context = json!({"version":2,"actorOperation":self.id,"profile":"http",
            "ownerId":self.actor.binding.owner.as_str(),
            "organisationId":self.actor.binding.scope.organisation().as_str(),
            "membershipId":self.actor.binding.scope.membership().as_str(),
            "devicePublicKey":key.map(|k|hex(k)),"nativeGeneration":native,"hostGeneration":host,
            "recordId":record.map(|r|r.record_id.as_str()),
            "recordSha256":frame.as_ref().map(|f|hex(&crate::sha256(f))),
            "admittedDeviceId":record.and_then(|r|r.admission.as_ref()).map(|a|a.device_id.as_str())}).to_string();
        let valid = current(&self.actor.host, &context).map_err(|_| Failure::Context)?;
        self.active()?;
        if !valid {
            return Err(Failure::Context);
        }
        Ok(())
    }

    fn state_fence(&self, device: &OpenMlsDevice, state: &HttpState) -> Result<(), Failure> {
        self.http_fence(
            Some(&device.device_key()),
            state.native,
            state.host,
            state.record.as_ref(),
        )
    }

    fn finish_http(
        mut self,
        device: OpenMlsDevice,
        state: HttpState,
        unknown: bool,
    ) -> Result<JsValue, Failure> {
        if self.actor.profile != Profile::Http
            || device.requires_restore()
            || device.generation() != state.native
            || device.admitted_id().map(RelayId::as_str)
                != state
                    .record
                    .as_ref()
                    .and_then(|r| r.admission.as_ref())
                    .map(|a| a.device_id.as_str())
        {
            return Err(Failure::RestoreRequired);
        }
        self.state_fence(&device, &state)?;
        let result = json!({"version":2,"state":if unknown {"outcome-unknown"} else {state.name()},
            "nativeGeneration":state.native,"hostGeneration":state.host})
        .to_string();
        if result.len() > 1024 {
            return Err(Failure::Capacity);
        }
        let mut slot = self
            .actor
            .device
            .try_borrow_mut()
            .map_err(|_| Failure::Busy)?;
        let mut http = self
            .actor
            .http
            .try_borrow_mut()
            .map_err(|_| Failure::Busy)?;
        if slot.is_some() || http.is_some() {
            return Err(Failure::RestoreRequired);
        }
        *slot = Some(device);
        *http = Some(state);
        drop(http);
        drop(slot);
        self.actor.restore_required.set(false);
        self.actor.busy.set(false);
        self.complete = true;
        Ok(JsValue::from_str(&result))
    }
}

fn plain_uuid(value: &str) -> Result<RelayId, Failure> {
    RelayId::parse(value).map_err(|_| Failure::InvalidInput)
}

fn pending_body(pending: &DeviceHttpPending) -> Result<Vec<u8>, Failure> {
    if pending.body_base64.len() > 43_692 {
        return Err(Failure::Capacity);
    }
    let body = STANDARD
        .decode(&pending.body_base64)
        .map_err(|_| Failure::InvalidInput)?;
    if body.is_empty()
        || body.len() > 32_768
        || STANDARD.encode(&body) != pending.body_base64
        || hex(&crate::sha256(&body)) != pending.body_sha256
    {
        return Err(Failure::InvalidInput);
    }
    Ok(body)
}

fn owned_http_record(
    device: &OpenMlsDevice,
    state: &HttpState,
    binding: &Binding,
) -> Result<(), Failure> {
    let packages = device.pending_key_packages().map_err(Failure::from)?;
    if packages.len() > 1 {
        return Err(Failure::Capacity);
    }
    let Some(record) = &state.record else {
        if state.native != 1
            || state.host != 1
            || device.admitted_id().is_some()
            || !packages.is_empty()
        {
            return Err(Failure::InvalidInput);
        }
        return Ok(());
    };
    record
        .validate_binding(
            &binding.http_scope(&device.device_key()),
            state.native,
            state.host,
            &hex(&crate::sha256(&state.sealed)),
        )
        .map_err(|_| Failure::InvalidInput)?;
    if record.encode().map_err(|_| Failure::InvalidInput)? != state.frame
        || device.admitted_id().map(RelayId::as_str)
            != record.admission.as_ref().map(|a| a.device_id.as_str())
    {
        return Err(Failure::InvalidInput);
    }
    if let Some(p) = &record.pending {
        let request = match p.operation {
            DeviceHttpOperation::Register => {
                if !packages.is_empty() {
                    return Err(Failure::InvalidInput);
                }
                device.registration_request().map_err(Failure::from)?
            }
            DeviceHttpOperation::PublishPackage => {
                let package = packages.first().ok_or(Failure::InvalidInput)?;
                if p.native_package_id.as_deref() != Some(hex(package.id().as_bytes()).as_str())
                    || p.package_wire_sha256.as_deref()
                        != Some(hex(&crate::sha256(package.as_bytes())).as_str())
                {
                    return Err(Failure::InvalidInput);
                }
                device
                    .sign_relay_request(RelayStatement::PublishKeyPackage {
                        package: package.id(),
                    })
                    .map_err(Failure::from)?
            }
        };
        if request.body() != pending_body(p)?.as_slice() {
            return Err(Failure::InvalidInput);
        }
    }
    if let Some(receipt) = &record.publication {
        let package = packages.first().ok_or(Failure::InvalidInput)?;
        let request = device
            .sign_relay_request(RelayStatement::PublishKeyPackage {
                package: package.id(),
            })
            .map_err(Failure::from)?;
        if receipt.native_package_id != hex(package.id().as_bytes())
            || receipt.package_wire_sha256 != hex(&crate::sha256(package.as_bytes()))
            || receipt.body_sha256 != hex(&crate::sha256(request.body()))
        {
            return Err(Failure::InvalidInput);
        }
    }
    if record.admission.is_none() && !packages.is_empty() {
        return Err(Failure::InvalidInput);
    }
    Ok(())
}

async fn commit_http(
    operation: &Operation,
    state: &HttpState,
    key: &Ed25519PublicKey,
    mut record: DeviceHttpRecord,
    sealed: &[u8],
    native: u64,
) -> Result<HttpSnapshot, Failure> {
    operation.active()?;
    if sealed.len() < 36
        || sealed.len() > MAX_WORKER_VAULT_BYTES
        || state.host >= MAX_SAFE_INTEGER
        || !(native == state.native || state.native.checked_add(1) == Some(native))
    {
        return Err(Failure::Capacity);
    }
    record.native_generation = native;
    record.sealed_sha256 = hex(&crate::sha256(sealed));
    let host = state.host + 1;
    record
        .validate_binding(
            &operation.actor.binding.http_scope(key),
            native,
            host,
            &record.sealed_sha256,
        )
        .map_err(|_| Failure::InvalidInput)?;
    let frame = record.encode().map_err(|_| Failure::Capacity)?;
    let expected = DeviceHttpAck {
        scope: record.scope.clone(),
        record_id: record.record_id.clone(),
        expected_native_generation: state.native,
        next_native_generation: native,
        expected_host_generation: state.host,
        next_host_generation: host,
        sealed_sha256: record.sealed_sha256.clone(),
        record_sha256: hex(&crate::sha256(&frame)),
    };
    // Validate and own the entire acknowledgement before calling imported JS.
    let expected_bytes = expected.encode().map_err(|_| Failure::InvalidInput)?;
    // Fix lexical metadata order independently of serde_json feature unification.
    let metadata = std::collections::BTreeMap::from([
        ("devicePublicKey", json!(record.scope[3])),
        ("expectedHostGeneration", json!(state.host)),
        ("expectedNativeGeneration", json!(state.native)),
        ("membershipId", json!(record.scope[2])),
        ("nextHostGeneration", json!(host)),
        ("nextNativeGeneration", json!(native)),
        ("organisationId", json!(record.scope[1])),
        ("ownerId", json!(record.scope[0])),
        ("recordId", json!(record.record_id)),
        ("recordSha256", json!(expected.record_sha256)),
        ("sealedSha256", json!(expected.sealed_sha256)),
        ("version", json!(2)),
    ]);
    let metadata = serde_json::to_string(&metadata).map_err(|_| Failure::InvalidInput)?;
    if metadata.len() > 2048 {
        return Err(Failure::Capacity);
    }
    operation.http_fence(Some(key), state.native, state.host, state.record.as_ref())?;
    let ciphertext = Uint8Array::from(sealed);
    let manifest = Uint8Array::from(frame.as_slice());
    let promise = cas_v2(&operation.actor.host, &metadata, &ciphertext, &manifest)
        .map_err(|_| Failure::Storage)?;
    operation.active()?;
    let reply = promise.await.map_err(|_| Failure::Storage)?;
    operation.active()?;
    let acknowledgement = bytes(&reply, 276, 276)?;
    if acknowledgement.as_slice() != expected_bytes
        || DeviceHttpAck::verify(&acknowledgement, &expected).is_err()
    {
        return Err(Failure::Storage);
    }
    operation.http_fence(Some(key), native, host, Some(&record))?;
    Ok(HttpSnapshot {
        native,
        host,
        sealed: sealed.to_vec(),
        record,
        frame,
    })
}

enum NativeHttpIntent {
    Admission(DeviceHttpAdmission),
    Package,
}
struct NativeHttpStore<'a> {
    operation: &'a Operation,
    state: &'a HttpState,
    key: Ed25519PublicKey,
    intent: NativeHttpIntent,
    committed: Option<HttpSnapshot>,
}
impl MlsDeviceStore for NativeHttpStore<'_> {
    async fn compare_and_swap<'a>(
        &'a mut self,
        write: &'a MlsDeviceWrite<'_>,
    ) -> Result<(), MlsDeviceStoreError> {
        let result = async {
            if self.committed.is_some()
                || write.initial_room.is_some()
                || write.scope != &self.operation.actor.binding.scope
                || write.device_key != self.key
                || write.expected_generation != self.state.native
                || self.state.native.checked_add(1) != Some(write.generation)
            {
                return Err(Failure::InvalidInput);
            }
            let mut record = self.state.record.clone().ok_or(Failure::InvalidInput)?;
            match &self.intent {
                NativeHttpIntent::Admission(receipt) => {
                    let pending = record.pending.as_ref().ok_or(Failure::InvalidInput)?;
                    if record.admission.is_some()
                        || pending.operation != DeviceHttpOperation::Register
                        || pending.phase != DeviceHttpPhase::Attempted
                        || pending.operation_id != receipt.operation_id
                        || pending.body_sha256 != receipt.body_sha256
                    {
                        return Err(Failure::InvalidInput);
                    }
                    record.admission = Some(receipt.clone());
                    record.pending = None;
                }
                NativeHttpIntent::Package => {
                    if record.admission.is_none()
                        || record.pending.is_some()
                        || record.publication.is_some()
                    {
                        return Err(Failure::InvalidInput);
                    }
                }
            }
            self.committed = Some(
                commit_http(
                    self.operation,
                    self.state,
                    &self.key,
                    record,
                    write.sealed.as_bytes(),
                    write.generation,
                )
                .await?,
            );
            Ok(())
        }
        .await;
        result.map_err(|_: Failure| MlsDeviceStoreError::Unavailable)
    }
}

struct HttpCreateStore<'a> {
    operation: &'a Operation,
    sealed: Option<Vec<u8>>,
}
impl MlsDeviceStore for HttpCreateStore<'_> {
    async fn compare_and_swap<'a>(
        &'a mut self,
        write: &'a MlsDeviceWrite<'_>,
    ) -> Result<(), MlsDeviceStoreError> {
        if self.sealed.is_some() {
            return Err(MlsDeviceStoreError::Unavailable);
        }
        HostStore {
            operation: self.operation,
        }
        .write(write)
        .await
        .map_err(|_| MlsDeviceStoreError::Unavailable)?;
        self.sealed = Some(write.sealed.as_bytes().to_vec());
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AttemptInfo {
    version: u8,
    actor_operation: u64,
    operation_id: String,
    body_sha256: String,
    observed_wall_ms: u64,
    retry_before_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, tag = "kind")]
enum HttpOutcome {
    #[serde(rename = "unknown")]
    Unknown,
    #[serde(rename = "response")]
    Response {
        #[serde(rename = "actorOperation")]
        actor_operation: u64,
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "bodySha256")]
        body_sha256: String,
        status: u16,
        #[serde(rename = "contentType")]
        content_type: String,
        #[serde(rename = "requestId")]
        request_id: String,
        replayed: Option<String>,
        #[serde(rename = "bodyBase64")]
        body_base64: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RegistrationResponse {
    device_id: String,
    signing_key: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PublicationResponse {
    key_package_id: String,
    reference: String,
    expires_at: String,
}

fn descriptor(
    operation: &Operation,
    device: &OpenMlsDevice,
    state: &HttpState,
) -> Result<String, Failure> {
    let record = state.record.as_ref().ok_or(Failure::InvalidInput)?;
    let pending = record.pending.as_ref().ok_or(Failure::InvalidInput)?;
    let value = json!({"version":2,"actorOperation":operation.id,"recordId":record.record_id,
        "operation":match pending.operation { DeviceHttpOperation::Register=>"register",DeviceHttpOperation::PublishPackage=>"publish-package" },
        "operationId":pending.operation_id,"ownerId":record.scope[0],"organisationId":record.scope[1],
        "membershipId":record.scope[2],"devicePublicKey":hex(&device.device_key()),
        "nativeGeneration":state.native,"hostGeneration":state.host,
        "bodySha256":pending.body_sha256,"recordSha256":hex(&crate::sha256(&state.frame))}).to_string();
    if value.len() > 2048 {
        return Err(Failure::Capacity);
    }
    Ok(value)
}

async fn apply_http_outcome(
    operation: &Operation,
    device: &mut OpenMlsDevice,
    state: &mut HttpState,
    outcome: HttpOutcome,
) -> Result<bool, Failure> {
    let HttpOutcome::Response {
        actor_operation,
        operation_id,
        body_sha256,
        status,
        content_type,
        request_id,
        replayed,
        body_base64,
    } = outcome
    else {
        return Ok(false);
    };
    let record = state.record.as_ref().ok_or(Failure::InvalidInput)?;
    let pending = record.pending.clone().ok_or(Failure::InvalidInput)?;
    if actor_operation != operation.id
        || operation_id != pending.operation_id
        || body_sha256 != pending.body_sha256
        || status != 201
        || !matches!(
            content_type.as_str(),
            "application/json" | "application/json; charset=utf-8"
        )
        || !(8..=64).contains(&request_id.len())
        || !request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || replayed.as_deref().is_some_and(|v| v != "true")
        || body_base64.len() > 21_848
    {
        return Ok(false);
    }
    let Ok(body) = STANDARD.decode(&body_base64) else {
        return Ok(false);
    };
    if body.len() > 16_384 || STANDARD.encode(&body) != body_base64 {
        return Ok(false);
    }
    let response_sha = hex(&crate::sha256(&body));
    match pending.operation {
        DeviceHttpOperation::Register => {
            let Ok(response) = serde_json::from_slice::<RegistrationResponse>(&body) else {
                return Ok(false);
            };
            let Ok(id) = plain_uuid(&response.device_id) else {
                return Ok(false);
            };
            if response.signing_key != STANDARD.encode(device.device_key()) {
                return Ok(false);
            }
            let receipt = DeviceHttpAdmission {
                operation_id: pending.operation_id,
                body_sha256: pending.body_sha256,
                device_id: response.device_id,
                response_sha256: response_sha,
            };
            let key = device.device_key();
            let mut store = NativeHttpStore {
                operation,
                state,
                key,
                intent: NativeHttpIntent::Admission(receipt),
                committed: None,
            };
            device
                .admit_and_persist(id, key, seed_key(&state.seed)?, &mut store)
                .await
                .map_err(Failure::from)?;
            let committed = store.committed.take().ok_or(Failure::RestoreRequired)?;
            state.install(committed);
            state.clock = None;
        }
        DeviceHttpOperation::PublishPackage => {
            let Ok(response) = serde_json::from_slice::<PublicationResponse>(&body) else {
                return Ok(false);
            };
            if plain_uuid(&response.key_package_id).is_err() {
                return Ok(false);
            }
            let Some(wire_sha) = pending.package_wire_sha256 else {
                return Ok(false);
            };
            let Ok(reference) = STANDARD.decode(&response.reference) else {
                return Ok(false);
            };
            if reference.len() != 32
                || STANDARD.encode(&reference) != response.reference
                || hex(&reference) != wire_sha
            {
                return Ok(false);
            }
            let Some(native_id) = pending.native_package_id else {
                return Ok(false);
            };
            let mut next = state.record.clone().ok_or(Failure::InvalidInput)?;
            next.pending = None;
            next.publication = Some(DeviceHttpPublication {
                operation_id: pending.operation_id,
                native_package_id: native_id,
                body_sha256: pending.body_sha256,
                core_package_id: response.key_package_id,
                package_wire_sha256: wire_sha,
                expires_at: response.expires_at,
                response_sha256: response_sha,
            });
            // The codec checks the bounded RFC3339 spelling before any CAS.
            if next.encode().is_err() {
                return Ok(false);
            }
            let committed = commit_http(
                operation,
                state,
                &device.device_key(),
                next,
                &state.sealed,
                state.native,
            )
            .await?;
            state.install(committed);
            state.clock = None;
        }
    }
    Ok(true)
}

#[wasm_bindgen]
impl BrowserMlsHttpDevice {
    /// Private worker construction only; the production facade exposes no host injection.
    #[wasm_bindgen(constructor)]
    pub fn new(
        host: JsValue,
        owner: JsValue,
        organisation: JsValue,
        membership: JsValue,
    ) -> Result<BrowserMlsHttpDevice, JsValue> {
        let owner = plain_uuid(&uuid(&owner).map_err(Failure::js)?).map_err(Failure::js)?;
        let organisation = OrganisationId::parse(&uuid(&organisation).map_err(Failure::js)?)
            .map_err(|_| Failure::InvalidInput.js())?;
        let membership =
            plain_uuid(&uuid(&membership).map_err(Failure::js)?).map_err(Failure::js)?;
        Ok(Self {
            actor: Rc::new(Actor {
                host,
                binding: Binding {
                    owner,
                    scope: MlsDeviceScope::new(organisation, membership),
                },
                closed: Cell::new(false),
                busy: Cell::new(false),
                restore_required: Cell::new(false),
                operation: Cell::new(0),
                device: RefCell::new(None),
                profile: Profile::Http,
                http: RefCell::new(None),
            }),
        })
    }

    #[wasm_bindgen(js_name = createHttpDevice)]
    pub fn create_http_device(
        &self,
        identity: JsValue,
        wrapping_seed: JsValue,
        consent: JsValue,
    ) -> Result<Promise, JsValue> {
        self.http_profile().map_err(Failure::js)?;
        if consent.as_bool() != Some(true) {
            return Err(Failure::InvalidInput.js());
        }
        let identity = bytes(&identity, 1, MAX_IDENTITY).map_err(Failure::js)?;
        let seed = seed(&wrapping_seed).map_err(Failure::js)?;
        let operation = self.actor.begin(false).map_err(Failure::js)?;
        Ok(future_to_promise(async move {
            async {
                operation.http_fence(None, 0, 0, None)?;
                let mut store = HttpCreateStore {
                    operation: &operation,
                    sealed: None,
                };
                let device = OpenMlsDevice::create_and_persist(
                    operation.actor.binding.scope.clone(),
                    &identity,
                    seed_key(&seed)?,
                    &mut store,
                )
                .await
                .map_err(Failure::from)?;
                let sealed = store.sealed.take().ok_or(Failure::RestoreRequired)?;
                operation.finish_http(
                    device,
                    HttpState {
                        native: 1,
                        host: 1,
                        sealed,
                        record: None,
                        frame: Vec::new(),
                        seed,
                        clock: None,
                    },
                    false,
                )
            }
            .await
            .map_err(Failure::js)
        }))
    }

    #[wasm_bindgen(js_name = openHttpDevice)]
    pub fn open_http_device(
        &self,
        public_key: JsValue,
        native_generation: JsValue,
        host_generation: JsValue,
        sealed: JsValue,
        manifest: JsValue,
        wrapping_seed: JsValue,
    ) -> Result<Promise, JsValue> {
        self.http_profile().map_err(Failure::js)?;
        let key: Ed25519PublicKey = bytes(&public_key, 32, 32)
            .map_err(Failure::js)?
            .try_into()
            .map_err(|_| Failure::InvalidInput.js())?;
        let native = generation(&native_generation).map_err(Failure::js)?;
        let host = generation(&host_generation).map_err(Failure::js)?;
        if host < native {
            return Err(Failure::InvalidInput.js());
        }
        let sealed = bytes(&sealed, 36, MAX_WORKER_VAULT_BYTES as u32).map_err(Failure::js)?;
        let frame = if manifest.is_null() {
            Vec::new()
        } else {
            bytes(&manifest, 8, 65_536).map_err(Failure::js)?
        };
        let record = if manifest.is_null() {
            None
        } else {
            Some(DeviceHttpRecord::decode(&frame).map_err(|_| Failure::InvalidInput.js())?)
        };
        let seed = seed(&wrapping_seed).map_err(Failure::js)?;
        let operation = self.actor.begin(false).map_err(Failure::js)?;
        Ok(future_to_promise(async move {
            async {
                let state = HttpState {
                    native,
                    host,
                    sealed,
                    record,
                    frame,
                    seed,
                    clock: None,
                };
                if let Some(record) = &state.record {
                    record
                        .validate_binding(
                            &operation.actor.binding.http_scope(&key),
                            native,
                            host,
                            &hex(&crate::sha256(&state.sealed)),
                        )
                        .map_err(|_| Failure::InvalidInput)?;
                } else if native != 1 || host != 1 {
                    return Err(Failure::InvalidInput);
                }
                operation.http_fence(Some(&key), native, host, state.record.as_ref())?;
                let admitted = state
                    .record
                    .as_ref()
                    .and_then(|r| r.admission.as_ref())
                    .map(|a| plain_uuid(&a.device_id))
                    .transpose()?;
                let encrypted =
                    SealedMlsDeviceState::from_bytes(&state.sealed).map_err(Failure::from)?;
                let device = OpenMlsDevice::restore_device(
                    operation.actor.binding.scope.clone(),
                    key,
                    admitted,
                    native,
                    &encrypted,
                    seed_key(&state.seed)?,
                )
                .map_err(Failure::from)?;
                owned_http_record(&device, &state, &operation.actor.binding)?;
                operation.finish_http(device, state, false)
            }
            .await
            .map_err(Failure::js)
        }))
    }

    #[wasm_bindgen(js_name = prepareRegistration)]
    pub fn prepare_registration(
        &self,
        record_id: JsValue,
        operation_id: JsValue,
    ) -> Result<Promise, JsValue> {
        self.http_profile().map_err(Failure::js)?;
        let record_id = uuid(&record_id).map_err(Failure::js)?;
        let operation_id = uuid(&operation_id).map_err(Failure::js)?;
        let mut operation = self.actor.begin(true).map_err(Failure::js)?;
        Ok(future_to_promise(async move {
            async {
                let device = operation.device.take().ok_or(Failure::RestoreRequired)?;
                let mut state = operation.http.take().ok_or(Failure::RestoreRequired)?;
                operation.state_fence(&device, &state)?;
                if let Some(record) = &state.record {
                    let pending = record.pending.as_ref().ok_or(Failure::InvalidInput)?;
                    if record.record_id != record_id
                        || pending.operation_id != operation_id
                        || pending.operation != DeviceHttpOperation::Register
                    {
                        return Err(Failure::InvalidInput);
                    }
                    return operation.finish_http(device, state, false);
                }
                owned_http_record(&device, &state, &operation.actor.binding)?;
                let request = device.registration_request().map_err(Failure::from)?;
                if request.body().is_empty() || request.body().len() > 32_768 {
                    return Err(Failure::Capacity);
                }
                let record = DeviceHttpRecord {
                    version: 1,
                    record_id,
                    scope: operation.actor.binding.http_scope(&device.device_key()),
                    native_generation: state.native,
                    sealed_sha256: hex(&crate::sha256(&state.sealed)),
                    admission: None,
                    publication: None,
                    pending: Some(DeviceHttpPending {
                        operation: DeviceHttpOperation::Register,
                        operation_id,
                        body_base64: STANDARD.encode(request.body()),
                        body_sha256: hex(&crate::sha256(request.body())),
                        native_package_id: None,
                        package_wire_sha256: None,
                        phase: DeviceHttpPhase::Prepared,
                        recovery_spent: 0,
                        first_attempt_at_ms: None,
                        retry_before_ms: None,
                    }),
                };
                let next = commit_http(
                    &operation,
                    &state,
                    &device.device_key(),
                    record,
                    &state.sealed,
                    state.native,
                )
                .await?;
                state.install(next);
                operation.finish_http(device, state, false)
            }
            .await
            .map_err(Failure::js)
        }))
    }

    #[wasm_bindgen(js_name = preparePublication)]
    pub fn prepare_publication(&self, operation_id: JsValue) -> Result<Promise, JsValue> {
        self.http_profile().map_err(Failure::js)?;
        let operation_id = uuid(&operation_id).map_err(Failure::js)?;
        let mut operation = self.actor.begin(true).map_err(Failure::js)?;
        Ok(future_to_promise(async move {
            async {
                let mut device = operation.device.take().ok_or(Failure::RestoreRequired)?;
                let mut state = operation.http.take().ok_or(Failure::RestoreRequired)?;
                operation.state_fence(&device, &state)?;
                let record = state.record.as_ref().ok_or(Failure::InvalidInput)?;
                let admission = record.admission.as_ref().ok_or(Failure::InvalidInput)?;
                if record.publication.is_some() || admission.operation_id == operation_id {
                    return Err(Failure::InvalidInput);
                }
                if let Some(pending) = &record.pending {
                    if pending.operation != DeviceHttpOperation::PublishPackage
                        || pending.operation_id != operation_id
                    {
                        return Err(Failure::InvalidInput);
                    }
                    return operation.finish_http(device, state, false);
                }
                let packages = device.pending_key_packages().map_err(Failure::from)?;
                if packages.len() > 1 {
                    return Err(Failure::Capacity);
                }
                if packages.is_empty() {
                    let mut store = NativeHttpStore {
                        operation: &operation,
                        state: &state,
                        key: device.device_key(),
                        intent: NativeHttpIntent::Package,
                        committed: None,
                    };
                    device
                        .prepare_key_package_and_persist(seed_key(&state.seed)?, &mut store)
                        .await
                        .map_err(Failure::from)?;
                    let next = store.committed.take().ok_or(Failure::RestoreRequired)?;
                    state.install(next);
                }
                let packages = device.pending_key_packages().map_err(Failure::from)?;
                if packages.len() != 1 {
                    return Err(Failure::RestoreRequired);
                }
                let package = packages.first().ok_or(Failure::RestoreRequired)?;
                let request = device
                    .sign_relay_request(RelayStatement::PublishKeyPackage {
                        package: package.id(),
                    })
                    .map_err(Failure::from)?;
                if request.body().is_empty() || request.body().len() > 32_768 {
                    return Err(Failure::Capacity);
                }
                let mut next = state.record.clone().ok_or(Failure::InvalidInput)?;
                next.pending = Some(DeviceHttpPending {
                    operation: DeviceHttpOperation::PublishPackage,
                    operation_id,
                    body_base64: STANDARD.encode(request.body()),
                    body_sha256: hex(&crate::sha256(request.body())),
                    native_package_id: Some(hex(package.id().as_bytes())),
                    package_wire_sha256: Some(hex(&crate::sha256(package.as_bytes()))),
                    phase: DeviceHttpPhase::Prepared,
                    recovery_spent: 0,
                    first_attempt_at_ms: None,
                    retry_before_ms: None,
                });
                let committed = commit_http(
                    &operation,
                    &state,
                    &device.device_key(),
                    next,
                    &state.sealed,
                    state.native,
                )
                .await?;
                state.install(committed);
                operation.finish_http(device, state, false)
            }
            .await
            .map_err(Failure::js)
        }))
    }

    #[wasm_bindgen(js_name = attemptHttp)]
    pub fn attempt_http(&self) -> Result<Promise, JsValue> {
        self.http_profile().map_err(Failure::js)?;
        let mut operation = self.actor.begin(true).map_err(Failure::js)?;
        Ok(future_to_promise(async move {
            async {
                let mut device = operation.device.take().ok_or(Failure::RestoreRequired)?;
                let mut state = operation.http.take().ok_or(Failure::RestoreRequired)?;
                operation.state_fence(&device, &state)?;
                let Some(pending) = state.record.as_ref().and_then(|r| r.pending.clone()) else {
                    return operation.finish_http(device, state, false);
                };
                // A restored spent intent cannot even create another dispatch cell.
                if pending.recovery_spent != 0 {
                    return operation.finish_http(device, state, true);
                }
                let mut normal = pending.phase == DeviceHttpPhase::Prepared;
                if pending.phase == DeviceHttpPhase::Attempted {
                    let now = clock_reading()?;
                    operation.active()?;
                    normal = state
                        .clock
                        .as_mut()
                        .is_some_and(|clock| clock.normal(&pending, now));
                }
                let body = pending_body(&pending)?;
                let before = descriptor(&operation, &device, &state)?;
                let public_body = Uint8Array::from(body.as_slice());
                let promise = prepare_attempt(&operation.actor.host, &before, &public_body)
                    .map_err(|_| Failure::Context)?;
                operation.active()?;
                let cell = promise.await.map_err(|_| Failure::Context)?;
                operation.state_fence(&device, &state)?;
                let text =
                    attempt_info(&operation.actor.host, &cell).map_err(|_| Failure::Context)?;
                operation.active()?;
                let info: AttemptInfo =
                    serde_json::from_str(&text).map_err(|_| Failure::InvalidInput)?;
                if info.version != 2
                    || info.actor_operation != operation.id
                    || info.operation_id != pending.operation_id
                    || info.body_sha256 != pending.body_sha256
                    || info.observed_wall_ms > MAX_SAFE_INTEGER
                    || info.retry_before_ms > MAX_SAFE_INTEGER
                {
                    return Err(Failure::Context);
                }
                let now = clock_reading()?;
                operation.active()?;
                if pending.phase == DeviceHttpPhase::Attempted && normal {
                    normal = state
                        .clock
                        .as_mut()
                        .is_some_and(|clock| clock.normal(&pending, now));
                }
                let mut next = state.record.clone().ok_or(Failure::InvalidInput)?;
                let armed = next.pending.as_mut().ok_or(Failure::InvalidInput)?;
                let mut changed = false;
                let recovery;
                if pending.phase == DeviceHttpPhase::Prepared {
                    let limit = now
                        .wall
                        .checked_add(HTTP_HORIZON_MS)
                        .filter(|v| *v <= MAX_SAFE_INTEGER)
                        .ok_or(Failure::Capacity)?;
                    let deadline = info.retry_before_ms.min(limit);
                    if deadline < now.wall {
                        return Err(Failure::Context);
                    }
                    armed.phase = DeviceHttpPhase::Attempted;
                    armed.first_attempt_at_ms = Some(now.wall);
                    armed.retry_before_ms = Some(deadline);
                    state.clock = Some(LiveAttemptClock {
                        operation: pending.operation_id.clone(),
                        first: now,
                        last: now,
                        ambiguous: false,
                    });
                    changed = true;
                    recovery = false;
                } else if !normal {
                    armed.recovery_spent = 1;
                    changed = true;
                    recovery = true;
                } else {
                    recovery = false;
                }
                if changed {
                    let committed = commit_http(
                        &operation,
                        &state,
                        &device.device_key(),
                        next,
                        &state.sealed,
                        state.native,
                    )
                    .await?;
                    state.install(committed);
                }
                operation.state_fence(&device, &state)?;
                if !recovery {
                    let now = clock_reading()?;
                    operation.active()?;
                    let armed = state
                        .record
                        .as_ref()
                        .and_then(|r| r.pending.as_ref())
                        .ok_or(Failure::InvalidInput)?;
                    if !state
                        .clock
                        .as_mut()
                        .is_some_and(|clock| clock.normal(armed, now))
                    {
                        // Do not quietly upgrade this already-created normal cell to recovery.
                        return operation.finish_http(device, state, true);
                    }
                }
                let metadata = descriptor(&operation, &device, &state)?;
                operation.active()?;
                // Preparation may retain or mutate its public JS input copy.
                // Dispatch uses a new copy of the independently owned stored body.
                let send_body = Uint8Array::from(body.as_slice());
                operation.active()?;
                // The fixed host performs the final same-cell/current/5s check and
                // consumption synchronously with native POST, with no await gap.
                let sent = send_attempt(&operation.actor.host, &cell, &metadata, &send_body);
                operation.active()?;
                let outcome = match sent {
                    Ok(promise) => match promise.await {
                        Ok(value) => {
                            operation.state_fence(&device, &state)?;
                            let snapshot = captured_outcome(&value);
                            operation.active()?;
                            snapshot
                                .ok()
                                .and_then(|s| serde_json::from_str::<HttpOutcome>(&s).ok())
                                .unwrap_or(HttpOutcome::Unknown)
                        }
                        Err(_) => HttpOutcome::Unknown,
                    },
                    Err(_) => HttpOutcome::Unknown,
                };
                operation.state_fence(&device, &state)?;
                let accepted =
                    apply_http_outcome(&operation, &mut device, &mut state, outcome).await?;
                operation.finish_http(device, state, !accepted)
            }
            .await
            .map_err(Failure::js)
        }))
    }

    #[wasm_bindgen(js_name = publicKey)]
    pub fn public_key(&self) -> Result<JsValue, JsValue> {
        self.http_profile().map_err(Failure::js)?;
        let mut operation = self.actor.begin(true).map_err(Failure::js)?;
        let device = operation
            .device
            .take()
            .ok_or(Failure::RestoreRequired)
            .map_err(Failure::js)?;
        let state = operation
            .http
            .take()
            .ok_or(Failure::RestoreRequired)
            .map_err(Failure::js)?;
        operation
            .state_fence(&device, &state)
            .map_err(Failure::js)?;
        let value = output(&device.device_key()).map_err(Failure::js)?;
        operation
            .finish_http(device, state, false)
            .map_err(Failure::js)?;
        Ok(value)
    }

    pub fn close(&self) {
        self.actor.closed.set(true);
        self.actor.restore_required.set(true);
        if let Ok(mut device) = self.actor.device.try_borrow_mut() {
            device.take();
        }
        if let Ok(mut state) = self.actor.http.try_borrow_mut() {
            state.take();
        }
    }
}
impl BrowserMlsHttpDevice {
    fn http_profile(&self) -> Result<(), Failure> {
        if self.actor.profile != Profile::Http {
            return Err(Failure::InvalidInput);
        }
        self.actor.idle()
    }
}
impl Drop for BrowserMlsHttpDevice {
    fn drop(&mut self) {
        self.close();
    }
}
