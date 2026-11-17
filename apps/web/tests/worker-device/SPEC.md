# Compiled fixed-worker storage acceptance slice

Status: Implemented source and production-worker compilation; browser execution is a separate gate.

This isolated browser fixture builds the actual `device.worker.ts` with Vite's
production worker bundler, actual historical generated native module and real
`local-state.ts` / `device-cas-host.ts`. Two real transferred MessagePorts carry
control and a deliberately synthetic main-thread initializer oracle. The oracle
is not Core, a fresh `/me`, or the production private dispatcher/factory. No
request URL, signing interface, seed or native ABI is injected into production.

Six served-client cases must pass once, without skips/retries or page debugger
setup. The browser spec navigates a compiled HTML/client and reads bounded public
output. New contexts isolate real IndexedDB and synthetic public scope IDs.

1. `startup-before-principal`: real native initialization completes before ready;
   no principal request occurs before an explicit command, including after ready.
2. `create-terminate-restore`: real native creation, strict IDB persistence, worker
   termination and a new worker's explicit restore preserve public key, scope,
   complete checkpoint digest, capsule-header digest and independent N/G = 1/1.
3. `prepared-terminate-restore`: actual prepare-registration and real v2 CAS reach
   N/G = 1/2; a replacement worker restores the exact native checkpoint and KDH1
   queue, including record/operation IDs and body digest. No HTTP send occurs.
4. `stale-consumed-start`: the controlled oracle delays a consumed initializer by
   5.1 seconds while returning a nominal 5-second remaining budget. Native start
   must refuse `ineligible`, and the initialized owner has no device record.
5. `aborted-record-write`: test-only worker entry aborts the first actual records
   add transaction after request success. Its real abort is observed, the fixed
   worker refuses storage, and independent real-store reread finds no device.
6. `committed-held-completion`: test-only entry suppresses delivery of the first
   records transaction's real complete event to the host. After observing the
   actual committed record, terminate the pending worker before any result/ACK;
   a new uninstrumented worker explicitly restores the exact persisted tuple.
   This is held host completion, not an injected native ACK or physical crash.

No test patches production worker/native source, imports a native mock, replaces
IDB with a fake, or evaluates operational setup through Playwright page.evaluate.
The test-only fault entry instruments only actual record-creation transactions;
normal create/restore cases use the unmodified production worker entry directly.

`provenance.json` pins the five historical generated assets recovered with this
source packet. The ordinary application browser suite builds the actual worker
and its test client with Vite into an owned temporary directory, serves only that
output with a restrictive proof CSP, and removes it after the six serial cases.
No historical asset is presented as a fresh combined native export. The fixture
manifest explicitly marks `freshCombinedNativeBuild: false`.

A fresh combined generated export, real Core/PG HTTP, production private factory,
actual credential retirement and process/browser restart remain separate gates.
The existing 85-case native component qualification still rebuilds current Rust
on hosted runners; these six browser cases prove this captured module's worker
composition and real IndexedDB behavior only. No production facade is mounted,
no dependency or workflow changes, and no operational account is contacted.
