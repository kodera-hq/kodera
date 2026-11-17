import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { inflateSync } from 'node:zlib';
import { buildIconFiles } from '../scripts/generate-icons.mjs';

const script = readFileSync(new URL('../src-tauri/assets/updater.js', import.meta.url), 'utf8');
const messages = JSON.parse(readFileSync(new URL('../src-tauri/assets/updater-messages.json', import.meta.url), 'utf8'));
function harness(response, { lang = 'en', rejectRestart = false } = {}) {
  const calls = [], children = [], shadow = [], timers = [];
  let button;
  const document = {
    readyState: 'complete', documentElement: { lang },
    body: { append: node => children.push(node) },
    createElement(tag) {
      const node = { setAttribute() {}, attachShadow() { return { append: (...nodes) => shadow.push(...nodes) }; },
        remove() { children.splice(children.indexOf(node), 1); }, addEventListener(event, handler) { this[event] = handler; } };
      if (tag === 'button') button = node;
      return node;
    },
  };
  const context = vm.createContext({ messages, document, location: { protocol: 'kodera-asset:', hostname: 'localhost' },
    window: { koderaDesktop: { async invoke(cmd) { calls.push(cmd); if (cmd === 'restart_to_update') { if (rejectRestart) throw Error('refused'); return { restarting: true }; } return response; } } },
    setTimeout: fn => timers.push(fn), setInterval() {},
  });
  vm.runInContext(`(function(messages){ ${script} })(messages);`, context);
  return { calls, children, shadow, timers, get button() { return button; } };
}
const flush = () => new Promise(setImmediate);

test('pill stays absent for unsigned, unready, unsupported or malformed native status', async () => {
  for (const value of [null, {}, { supported: true }, { supported: true, updateAvailable: true }, { supported: true, updateReady: true }, { updateReady: true, verified: true }]) {
    const ui = harness(value); await flush(); assert.equal(ui.children.length, 0);
  }
});

test('verified staged update shows a localized keyboard button and invokes one restart', async () => {
  for (const lang of ['en', 'fr']) {
    const ui = harness({ supported: true, updateReady: true, verified: true }, { lang }); await flush();
    assert.equal(ui.children.length, 1); assert.equal(ui.button.type, 'button');
    assert.equal(ui.button.textContent, messages[lang].ready);
    assert.equal(ui.shadow[0].href, '/__desktop-update.css');
    const pending = ui.button.click(); void ui.button.click(); await pending;
    assert.equal(ui.button.disabled, true);
    assert.equal(ui.calls.filter(cmd => cmd === 'restart_to_update').length, 1);
  }
});

test('restart refusal removes the stale ready affordance and leaves the workspace intact', async () => {
  const ui = harness({ supported: true, updateReady: true, verified: true }, { rejectRestart: true }); await flush();
  await ui.button.click(); assert.equal(ui.button.textContent, messages.en.unavailable);
  ui.timers[0](); assert.equal(ui.children.length, 0);
});

test('native icon containers include independent official raster frames at every platform size', () => {
  const files = buildIconFiles();
  let at = 8; const icns = [];
  while (at < files.icns.length) {
    icns.push(files.icns.toString('ascii', at, at + 4));
    const size = files.icns.readUInt32BE(at + 4); assert.ok(size > 8); at += size;
  }
  assert.equal(at, files.icns.length);
  assert.deepEqual(icns, ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10']);
  assert.equal(files.ico.readUInt16LE(4), 6);
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    const png = files[`${size}x${size}.png`]; assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
    const pixels = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
    assert.equal(pixels.length, size * (size * 4 + 1));
    assert.deepEqual([...pixels.subarray(1, 5)], [43, 75, 219, 255]);
    assert.ok(pixels.includes(238), 'official Givre foreground must be present');
    assert.ok(readFileSync(new URL(`../src-tauri/icons/${size}x${size}.png`, import.meta.url)).equals(png));
  }
});

test('restart helper replaces and rolls back failed replacement with hostile path text', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  if (process.platform === 'win32') return;
  for (const candidatePresent of [true, false]) {
    const root = mkdtempSync(join(tmpdir(), 'desktop-update-handoff-'));
    try {
      const installed = join(root, 'Kodera $(touch injected).app');
      const stage = join(root, '.stage'), candidate = join(stage, 'unpacked', 'Kodera.app');
      mkdirSync(installed); writeFileSync(join(installed, 'version'), 'old');
      mkdirSync(join(stage, 'unpacked'), { recursive: true });
      if (candidatePresent) { mkdirSync(candidate); writeFileSync(join(candidate, 'version'), 'new'); }
      const helper = join(root, 'helper.sh');
      // Isolate the OS launcher; execute the unchanged handoff/rollback algorithm on real files.
      writeFileSync(helper, readFileSync(new URL('../src-tauri/assets/restart-update.sh', import.meta.url), 'utf8').replaceAll('/usr/bin/open', 'true'));
      const result = spawnSync('/bin/sh', [helper, '99999999', installed, candidate, stage], { cwd: root });
      assert.equal(result.status, candidatePresent ? 0 : 1);
      assert.equal(readFileSync(join(installed, 'version'), 'utf8'), candidatePresent ? 'new' : 'old');
      assert.equal(existsSync(stage), false); assert.equal(existsSync(join(root, 'injected')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('public bridge refuses a missing native capability and browser restart', async () => {
  const { createDesktopClient } = await import('../src/bridge.mjs');
  const malformed = createDesktopClient({ globalObject: { __TAURI_INTERNALS__: { async invoke() { return { updateAvailable: true, updateReady: true }; } } } });
  const status = await malformed.checkForAppUpdates();
  assert.equal(status.supported, false); assert.equal(status.updateReady, false);
  await assert.rejects(malformed.restartToUpdate(), /update_not_ready/);
  const browser = createDesktopClient({ globalObject: {} });
  await assert.rejects(browser.restartToUpdate(), /update_not_ready/);
});
