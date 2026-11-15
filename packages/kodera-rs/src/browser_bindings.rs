//! Private first-party worker ABI for one durable, pre-admission software device.
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

use js_sys::{futures::future_to_promise, Promise, Uint8Array};
use serde_json::json;
use sha2::{Digest, Sha256};
use tls_codec::SecretVLBytes;
use wasm_bindgen::prelude::*;

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
        if slot.is_some() != existing {
            return Err(Failure::InvalidInput);
        }
        let id = self
            .operation
            .get()
            .checked_add(1)
            .ok_or(Failure::Capacity)?;
        let device = slot.take();
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
