export interface TauriInternalsBridge {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  transformCallback?(callback: (payload: unknown) => void, once?: boolean): number;
}

export declare function resolveTauriInternals(globalObj?: unknown): TauriInternalsBridge | null;
export declare function isTauriDesktopRuntime(globalObj?: unknown): boolean;
