import type { AuthMode } from '../../config'

/**
 * Whether the messaging demo preview (`/__demo-messaging`) may register.
 *
 * The console does not implement a messenger. The provisionable application
 * is **Tchap**, the French state's Matrix-based messaging service from La
 * Suite (`contracts/core-api.openapi.yaml`, `TenantApp.app`
 * `enum: [visio, docs, drive, tchap, grist]`): kodera.io installs and
 * operates it for a customer, it does not build it. What sits behind this
 * gate is a *picture* of that application — fictional people, fictional
 * channels, fictional messages — for showing a customer what their suite
 * looks like. Shipping it to a customer's own console would claim a product
 * that does not exist here, which is why it is gated like simulation code
 * rather than like a feature flag.
 *
 * Same truth table as `mockIdpEnabled` (`src/auth/mock-idp-gate.ts`), and for
 * the same reason both conditions are required rather than one: `authMode`
 * alone would still ship the preview whenever someone flips `VITE_ENABLE_MSW`
 * on against a real Core API, and `mswEnabled` alone would ship it whenever a
 * mock build talks to a real identity provider.
 *
 * Kept as a pure function, isolated from `import.meta.env` and from the
 * router, so the boundary itself (`tests/unit/messaging/demo-gate.test.ts`)
 * cannot pass by accident of some other module's state. `src/app/routeTree.ts`
 * deliberately does NOT call it — see the comment there for why the condition
 * has to be written out as a literal comparison at the `import()` site.
 */
export function messagingDemoEnabled(enableMsw: boolean, mode: AuthMode): boolean {
  return enableMsw && mode === 'mock'
}
