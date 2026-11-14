/**
 * Tauri v2 WebView runtime detection (`window.__TAURI_INTERNALS__`).
 *
 * Safe to import in browser tabs, SSR workers, and Node.js unit tests: never throws when `window`
 * is absent or when running outside the native Tauri host.
 */

/**
 * Resolves the Tauri v2 internals bridge object when running inside the native Kodera Desktop
 * WebView, or returns `null` in ordinary browsers and headless environments.
 *
 * @param {unknown} [globalObj]
 * @returns {{ invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>, transformCallback?: (cb: (payload: unknown) => void, once?: boolean) => number } | null}
 */
export function resolveTauriInternals(globalObj = globalThis) {
  if (typeof globalObj !== 'object' || globalObj === null) {
    return null;
  }
  const candidate = /** @type {Record<string, unknown>} */ (globalObj).__TAURI_INTERNALS__;
  if (typeof candidate !== 'object' || candidate === null) {
    return null;
  }
  const internals = /** @type {Record<string, unknown>} */ (candidate);
  if (typeof internals.invoke !== 'function') {
    return null;
  }
  return /** @type {{ invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>, transformCallback?: (cb: (payload: unknown) => void, once?: boolean) => number }} */ (
    internals
  );
}

/**
 * Returns `true` strictly when executing inside a Tauri v2 native WebView with an active IPC
 * `invoke` bridge.
 *
 * @param {unknown} [globalObj]
 * @returns {boolean}
 */
export function isTauriDesktopRuntime(globalObj = globalThis) {
  return resolveTauriInternals(globalObj) !== null;
}
