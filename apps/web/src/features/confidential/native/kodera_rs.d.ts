/* tslint:disable */
/* eslint-disable */

/**
 * An empty actor is not a usable crypto session. Only a successful persisted
 * create/open enables publicKey/registrationRequest. Keep this object inside
 * the trusted dedicated worker; it is not a Core admission capability.
 */
export class BrowserMlsDevice {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Close is synchronous and cannot be blocked by an exported async borrow.
     * A pending operation may still commit storage but cannot publish a result.
     */
    close(): void;
    /**
     * Explicit create consent is private-worker policy, not server admission.
     * The supplied wrapping seed never appears in an output or generic callback.
     */
    createDevice(identity: any, wrapping_seed: any, consent: any): Promise<any>;
    /**
     * Allocate an empty worker-local actor, not a usable session or signer.
     */
    constructor(host: any, owner: any, organisation: any, membership: any);
    /**
     * Restore exactly the authoritative current pre-admission record. A missing
     * or corrupt record is never interpreted as consent to generate a signer.
     */
    openDevice(public_key: any, expected_generation: any, sealed: any, wrapping_seed: any): Promise<any>;
    publicKey(): any;
    /**
     * Closed RegisterDevice proof only. No idempotency/transport/admission is
     * implemented here; any RPC correlation identifier stays outside Rust.
     */
    registrationRequest(): any;
}

export class BrowserMlsHttpDevice {
    free(): void;
    [Symbol.dispose](): void;
    attemptHttp(): Promise<any>;
    close(): void;
    createHttpDevice(identity: any, wrapping_seed: any, consent: any): Promise<any>;
    /**
     * Private worker construction only; the production facade exposes no host injection.
     */
    constructor(host: any, owner: any, organisation: any, membership: any);
    openHttpDevice(public_key: any, native_generation: any, host_generation: any, sealed: any, manifest: any, wrapping_seed: any): Promise<any>;
    preparePublication(operation_id: any): Promise<any>;
    prepareRegistration(record_id: any, operation_id: any): Promise<any>;
    publicKey(): any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_browsermlsdevice_free: (a: number, b: number) => void;
    readonly __wbg_browsermlshttpdevice_free: (a: number, b: number) => void;
    readonly browsermlsdevice_close: (a: number) => void;
    readonly browsermlsdevice_createDevice: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly browsermlsdevice_new: (a: any, b: any, c: any, d: any) => [number, number, number];
    readonly browsermlsdevice_openDevice: (a: number, b: any, c: any, d: any, e: any) => [number, number, number];
    readonly browsermlsdevice_publicKey: (a: number) => [number, number, number];
    readonly browsermlsdevice_registrationRequest: (a: number) => [number, number, number];
    readonly browsermlshttpdevice_attemptHttp: (a: number) => [number, number, number];
    readonly browsermlshttpdevice_close: (a: number) => void;
    readonly browsermlshttpdevice_createHttpDevice: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly browsermlshttpdevice_new: (a: any, b: any, c: any, d: any) => [number, number, number];
    readonly browsermlshttpdevice_openHttpDevice: (a: number, b: any, c: any, d: any, e: any, f: any, g: any) => [number, number, number];
    readonly browsermlshttpdevice_preparePublication: (a: number, b: any) => [number, number, number];
    readonly browsermlshttpdevice_prepareRegistration: (a: number, b: any, c: any) => [number, number, number];
    readonly browsermlshttpdevice_publicKey: (a: number) => [number, number, number];
    readonly wasm_bindgen_b7210f85fb83d23e___convert__closures_____invoke___js_sys_61bb9bc6e98b1830___Function_fn_wasm_bindgen_b7210f85fb83d23e___JsValue_____wasm_bindgen_b7210f85fb83d23e___sys__Undefined___js_sys_61bb9bc6e98b1830___Function_fn_wasm_bindgen_b7210f85fb83d23e___JsValue_____wasm_bindgen_b7210f85fb83d23e___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_b7210f85fb83d23e___convert__closures_____invoke___wasm_bindgen_b7210f85fb83d23e___JsValue__core_d941ad8722425d2e___result__Result_____wasm_bindgen_b7210f85fb83d23e___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_b7210f85fb83d23e___convert__closures_____invoke___bool__true_: (a: number, b: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
