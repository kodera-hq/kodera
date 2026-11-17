
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
