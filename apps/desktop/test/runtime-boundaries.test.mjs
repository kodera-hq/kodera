import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { checkBootstrapCss, generateBootstrapCss } from '../scripts/generate-bootstrap-css.mjs';
import { verifyFrontendAssets } from '../scripts/verify-frontend-assets.mjs';

const gui = readFileSync(new URL('../src-tauri/src/gui.rs', import.meta.url), 'utf8');
const init = /const IPC_INIT_SCRIPT: &str = r#"([\s\S]*?)"#;/.exec(gui)[1];
function document(activate = true) {
  const messages = [], events = [];
  const context = vm.createContext({ crypto: webcrypto, window: { ipc: { postMessage: message => messages.push(message) } }, events });
  vm.runInContext(init, context);
  if (activate) vm.runInContext("window.__KODERA_IPC_ACTIVATE__(1, '" + 'c'.repeat(64) + "')", context);
  return { context, messages, events, id: context.window.__KODERA_DOCUMENT_ID__ };
}
function nativeScript(name, fields) {
  const fn = gui.slice(gui.indexOf(`fn ${name}(`));
  const literal = /format!\(\s*"((?:\\.|[^"\\])*)"/.exec(fn)[1];
  let script = JSON.parse(`"${literal}"`).replaceAll('{{', '{').replaceAll('}}', '}');
  for (const [key, value] of Object.entries(fields)) script = script.replaceAll(`{${key}}`, String(value));
  return script;
}

test('actual initializer uses fresh document identities and stale native events/replies cannot target reused IDs', async () => {
  const old = document(), current = document();
  assert.match(old.id, /^[a-f0-9]{32}$/);
  assert.notEqual(old.id, current.id);
  vm.runInContext("window.koderaDesktop.onEvent('kodera://deep-link', e => events.push(e.payload))", old.context);
  vm.runInContext("window.koderaDesktop.onEvent('other-event', e => events.push(e.payload))", current.context);
  assert.match(current.messages.find(message => message.includes('plugin:event|listen')), new RegExp(`^${current.id}:1:${"c".repeat(64)}:1\\tplugin:event\\|listen`));
  const event = nativeScript('dispatch_js_event', { document_id: old.id, callback_id: 1 }).replace('{}', 'previous-document');
  vm.runInContext(event, current.context);
  assert.equal(current.events.length, 0);
  vm.runInContext(event, old.context);
  assert.equal(old.events[0], 'previous-document');
  const request = vm.runInContext("window.koderaDesktop.invoke('get_app_metadata', {}).then(value => window.reply = value)", current.context);
  const reply = nativeScript('resolve_js_promise', { document_id: old.id, req_id: 2, ok_lit: 'true', raw_json_expr: '7' });
  const own = nativeScript('resolve_js_promise', { document_id: current.id, req_id: 2, ok_lit: 'true', raw_json_expr: '11' });
  vm.runInContext(reply, current.context);
  await new Promise(setImmediate);
  assert.equal(current.context.window.reply, undefined);
  vm.runInContext(own, current.context);
  await request;
  assert.equal(current.context.window.reply, 11);
  const newEvent = nativeScript('dispatch_js_event', { document_id: current.id, callback_id: 1 }).replace('{}', 'current-document');
  vm.runInContext(newEvent, current.context);
  assert.deepEqual([...current.events], ['current-document']);
});

test('actual initializer queues bounded requests until the nonce-scoped native generation handshake', async () => {
  const doc = document(false);
  assert.equal(doc.messages.length, 1);
  assert.match(doc.messages[0], new RegExp(`^${doc.id}:hello\\t__document_generation`));
  const request = vm.runInContext("window.koderaDesktop.invoke('get_app_metadata', {})", doc.context);
  assert.equal(doc.messages.length, 1);
  const activation = nativeScript('activate_js_document', { document_id: doc.id, generation: 3, capability: "c".repeat(64) });
  vm.runInContext(activation, doc.context);
  assert.match(doc.messages[1], new RegExp(`^${doc.id}:3:${"c".repeat(64)}:1\\tget_app_metadata`));
  vm.runInContext("window.__KODERA_IPC_ACTIVATE__(4, 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')", doc.context);
  const reply = nativeScript('resolve_js_promise', { document_id: doc.id, req_id: 1, ok_lit: 'true', raw_json_expr: '19' });
  vm.runInContext(reply, doc.context);
  assert.equal(await request, 19);
  const bounded = document(false);
  const requests = vm.runInContext("Array.from({length:65}, () => window.koderaDesktop.invoke('get_app_metadata', {}).catch(error => error.message))", bounded.context);
  assert.equal(await requests[64], 'ipc_pending_limit');
});

test('callback state is capped and native registration rejection releases callback capacity', async () => {
  const doc = document();
  for (let index = 0; index < 128; index++) {
    const unlisten = vm.runInContext("window.koderaDesktop.onEvent('invalid-event', () => {})", doc.context);
    const result = unlisten().catch(error => error.message);
    const req = Number(doc.messages.at(-1).split('\t')[0].split(':').at(-1));
    vm.runInContext(`window.__KODERA_IPC_RESOLVE__(${req}, false, {error:'registration_refused'})`, doc.context);
    assert.equal(await result, 'registration_refused');
  }
  for (let index = 0; index < 63; index++) vm.runInContext("window.__TAURI_INTERNALS__.transformCallback(() => {}, false)", doc.context);
  const once = vm.runInContext("window.__TAURI_INTERNALS__.transformCallback(() => {}, true)", doc.context);
  assert.throws(() => vm.runInContext("window.__TAURI_INTERNALS__.transformCallback(() => {}, false)", doc.context), /ipc_callback_limit/);
  vm.runInContext(`window.__KODERA_IPC_DISPATCH_EVENT__(${once}, 'synthetic')`, doc.context);
  assert.doesNotThrow(() => vm.runInContext("window.__TAURI_INTERNALS__.transformCallback(() => {}, false)", doc.context));
});

test('native activation carrying a fresh capability only reaches its intended document', () => {
  const old = document(), current = document(false);
  const activation = nativeScript('activate_js_document', { document_id: old.id, generation: 2, capability: 'd'.repeat(64) });
  vm.runInContext(activation, current.context);
  vm.runInContext("window.koderaDesktop.invoke('get_app_metadata', {})", current.context);
  assert.equal(current.messages.length, 1);
  const own = nativeScript('activate_js_document', { document_id: current.id, generation: 2, capability: 'd'.repeat(64) });
  vm.runInContext(own, current.context);
  assert.match(current.messages[1], new RegExp(`^${current.id}:2:${'d'.repeat(64)}:1\\t`));
});

test('actual update response literal declares unsupported with the complete expected payload', () => {
  const arm = gui.slice(gui.indexOf('"check_app_updates" =>'));
  const literal = /r#"([\s\S]*?)"#/.exec(arm)[1];
  const payload = JSON.parse(literal.replaceAll('{{', '{').replaceAll('}}', '}').replace('{}', 'fixture-version'));
  assert.deepEqual(payload, { supported: false, updateAvailable: false, currentVersion: 'fixture-version', latestVersion: null, channel: 'stable' });
});

test('fallback stylesheet is exact generated token output and rejects literal or missing-token styles', () => {
  checkBootstrapCss();
  for (const css of ['body {color:#fff}', 'body {color:#ffffff}', 'body {padding:12px}', 'body {font-family:Arial}', 'body {font:Arial}', 'body {color:red}', 'body {background:hsl(0 0% 0%)}', 'body {color:var(--missing-token)}']) {
    assert.throws(() => generateBootstrapCss(css));
  }
  assert.match(gui, /BOOTSTRAP_CSS: &str = include_str!/);
  assert.doesNotMatch(gui, /const BOOTSTRAP_CSS: &str = r#/);
});

test('configured resource mapping stages the complete local frontend on each supported package layout', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'desktop-resource-boundary-'));
  try {
    const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    assert.deepEqual(conf.bundle.resources, { '../../web/dist/': 'web/' });
    assert.match(conf.build.beforeBuildCommand, /verify-frontend-assets\.mjs/);
    const source = join(scratch, 'frontend');
    mkdirSync(join(source, 'assets'), { recursive: true });
    writeFileSync(join(source, 'index.html'), '<script type="module" src="/assets/main-123.js"></script>');
    writeFileSync(join(source, 'assets/main-123.js'), 'export const ready=true;');
    const inventory = verifyFrontendAssets(source);
    for (const path of ['Kodera.app/Contents/Resources/web', 'usr/lib/Kodera/web', 'AppDir/usr/lib/Kodera/web', 'windows/Kodera/web']) {
      const staged = join(scratch, path);
      cpSync(source, staged, { recursive: true });
      assert.deepEqual(verifyFrontendAssets(staged), inventory);
    }
    writeFileSync(join(source, 'index.html'), '<script src="/assets/missing.js"></script>');
    assert.throws(() => verifyFrontendAssets(source), /missing_or_uncontained/);
    writeFileSync(join(source, 'index.html'), '<script src="../outside.js"></script>');
    assert.throws(() => verifyFrontendAssets(source), /missing_or_uncontained/);
    writeFileSync(join(source, 'index.html'), '<script src="https://untrusted.example/app.js"></script>');
    assert.throws(() => verifyFrontendAssets(source), /nonlocal_reference/);
    writeFileSync(join(source, 'index.html'), '<script src="data:text/javascript,alert(1)"></script>');
    assert.throws(() => verifyFrontendAssets(source), /nonlocal_reference/);
    writeFileSync(join(source, 'index.html'), '<script src="/assets/main-123.js"></script>');
    const rootLink = join(scratch, 'root-link');
    symlinkSync(source, rootLink, 'dir');
    assert.throws(() => verifyFrontendAssets(rootLink), /symlink_root_refused/);
    assert.throws(() => verifyFrontendAssets(`${rootLink}/`), /symlink_root_refused/);
    mkdirSync(join(source, 'nested/one/two'), { recursive: true });
    assert.throws(() => verifyFrontendAssets(source, { maxDepth: 2 }), /directory_depth_limit/);
    assert.throws(() => verifyFrontendAssets(source, { maxEntries: 2 }), /entry_limit/);
    symlinkSync(join(source, 'assets/main-123.js'), join(source, 'symlink.js'));
    assert.throws(() => verifyFrontendAssets(source), /symlink_refused/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
