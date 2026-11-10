import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const tauriDir = join(import.meta.dirname, '..', 'src-tauri');
const requiredIcons = [
  'icons/32x32.png',
  'icons/128x128.png',
  'icons/128x128@2x.png',
  'icons/icon.png',
];
const requiredFiles = ['build.rs', 'src/main.rs', 'capabilities/default.json', ...requiredIcons];
const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
const files = new Set(requiredFiles.filter((path) => existsSync(join(tauriDir, path))));
const capability = files.has('capabilities/default.json')
  ? JSON.parse(readFileSync(join(tauriDir, 'capabilities/default.json'), 'utf8'))
  : null;

function verifyConfiguration(config, availableFiles, defaultCapability) {
  assert.equal(config.identifier, 'io.kodera.desktop', 'identifier must match the desktop app');
  assert.equal(config.productName, 'Kodera', 'productName must be Kodera');
  assert.equal(config.build?.frontendDist, '../../web/dist', 'frontendDist must use the web bundle');
  const csp = config.app?.security?.csp;
  assert.equal(typeof csp, 'string', 'CSP must be present');
  const directives = csp.split(';').map((part) => part.trim()).filter(Boolean).map((part) => part.split(/\s+/u));
  // Script loading falls back to default-src. Keep the complete source policy closed,
  // rather than proving two blob directives while overlooking an expanded script policy.
  const expectedSources = new Map([
    ['default-src', ["'self'"]],
    ['connect-src', ["'self'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['media-src', ["'self'", 'blob:']],
    ['worker-src', ["'self'", 'blob:']],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['font-src', ["'self'", 'data:']],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ]);
  for (const [name, sources] of expectedSources) {
    const matches = directives.filter(([directive]) => directive === name);
    assert.equal(matches.length, 1, `${name} must be present exactly once`);
    assert.deepEqual(matches[0].slice(1).sort(), [...sources].sort(), `${name} must use only approved sources`);
  }
  assert.equal(directives.length, expectedSources.size, 'CSP must contain only approved directives');
  assert.ok(config.app?.security?.dangerousDisableAssetCspModification === undefined
    || config.app.security.dangerousDisableAssetCspModification === false,
  'CSP asset modification must not be disabled');
  assert.deepEqual(config.app?.security?.capabilities, ['default'], 'default capability must be selected');
  assert.deepEqual(config.bundle?.icon, requiredIcons, 'all bundled icons must be selected');
  for (const path of requiredFiles) {
    assert.ok(availableFiles.has(path), `required file missing: ${path}`);
  }
  assert.equal(defaultCapability?.identifier, 'default', 'capability identifier must be default');
  assert.deepEqual(defaultCapability?.windows, ['main'], 'capability must bind only the main window');
  assert.deepEqual(defaultCapability?.permissions, ['core:default'], 'capability must remain least privilege');
  assert.equal(defaultCapability?.remote, undefined, 'capability must not grant remote origins');
  assert.ok(defaultCapability?.local === undefined || defaultCapability.local === true,
    'capability must remain local');
  const capabilityKeys = new Set(['$schema', 'identifier', 'description', 'windows', 'permissions', 'local']);
  assert.deepEqual(Object.keys(defaultCapability).filter((key) => !capabilityKeys.has(key)), [],
    'capability must contain only approved keys');
}

function selftest() {
  verifyConfiguration(conf, files, capability);
  const mutations = [
    ['wrong identifier', /identifier must match/u, (config) => { config.identifier = 'io.invalid.desktop'; }],
    ['missing media directive', /media-src must be present/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("media-src 'self' blob:;", '');
    }],
    ['missing worker directive', /worker-src must be present/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("worker-src 'self' blob:;", '');
    }],
    ['invalid frontend distribution', /frontendDist must use/u, (config) => { config.build.frontendDist = '../untrusted'; }],
    ['missing capability selection', /default capability must be selected/u, (config) => { config.app.security.capabilities = []; }],
    ['missing capability file', /required file missing: capabilities\/default.json/u, (_config, availableFiles) => {
      availableFiles.delete('capabilities/default.json');
    }],
    ['missing icon selection', /all bundled icons must be selected/u, (config) => { config.bundle.icon = []; }],
    ['missing icon file', /required file missing: icons\/icon.png/u, (_config, availableFiles) => {
      availableFiles.delete('icons/icon.png');
    }],
    ['expanded capability permissions', /capability must remain least privilege/u, (_config, _files, defaultCapability) => {
      defaultCapability.permissions.push('shell:allow-execute');
    }],
    ['wildcard default source', /default-src must use only approved sources/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("default-src 'self'", 'default-src *');
    }],
    ['missing default source', /default-src must be present exactly once/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("default-src 'self';", '');
    }],
    ['duplicate default directive', /default-src must be present exactly once/u, (config) => {
      config.app.security.csp += "; default-src 'self'";
    }],
    ['unsafe script evaluation', /CSP must contain only approved directives/u, (config) => {
      config.app.security.csp += "; script-src 'self' 'unsafe-eval'";
    }],
    ['external script source', /CSP must contain only approved directives/u, (config) => {
      config.app.security.csp += '; script-src https://scripts.example.org';
    }],
    ['wildcard connections', /connect-src must use only approved sources/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("connect-src 'self'", 'connect-src *');
    }],
    ['insecure connections', /connect-src must use only approved sources/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("connect-src 'self'", "connect-src 'self' http: ws:");
    }],
    ['external workers', /worker-src must use only approved sources/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("worker-src 'self' blob:", "worker-src 'self' blob: https:");
    }],
    ['external media', /media-src must use only approved sources/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("media-src 'self' blob:", "media-src 'self' blob: https:");
    }],
    ['insecure images', /img-src must use only approved sources/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("img-src 'self' data: blob:", "img-src 'self' data: blob: http:");
    }],
    ['external fonts', /font-src must use only approved sources/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("font-src 'self' data:", "font-src 'self' data: https:");
    }],
    ['disabled CSP asset modification', /CSP asset modification must not be disabled/u, (config) => {
      config.app.security.dangerousDisableAssetCspModification = true;
    }],
    ['missing CSP', /CSP must be present/u, (config) => { config.app.security.csp = null; }],
    ['remote capability grant', /capability must not grant remote origins/u, (_config, _files, defaultCapability) => {
      defaultCapability.remote = { urls: ['https://*.example.org'] };
    }],
    ['disabled local capability', /capability must remain local/u, (_config, _files, defaultCapability) => {
      defaultCapability.local = false;
    }],
    ['wildcard capability window', /capability must bind only the main window/u, (_config, _files, defaultCapability) => {
      defaultCapability.windows = ['*'];
    }],
    ['extra capability webviews', /capability must contain only approved keys/u, (_config, _files, defaultCapability) => {
      defaultCapability.webviews = ['*'];
    }],
    ['unreviewed capability platforms', /capability must contain only approved keys/u, (_config, _files, defaultCapability) => {
      defaultCapability.platforms = ['windows'];
    }],
  ];
  for (const directive of ['connect-src', 'img-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors']) {
    mutations.push([`expanded ${directive}`, new RegExp(`${directive} must use only approved sources`, 'u'), (config) => {
      config.app.security.csp = config.app.security.csp.replace(`${directive} `, `${directive} https: wss: `);
    }]);
  }
  for (const [name, diagnostic, mutate] of mutations) {
    const mutated = structuredClone(conf);
    const availableFiles = new Set(files);
    const defaultCapability = structuredClone(capability);
    mutate(mutated, availableFiles, defaultCapability);
    assert.throws(() => verifyConfiguration(mutated, availableFiles, defaultCapability), diagnostic,
      `selftest failed to reject ${name} for its own diagnostic`);
  }
  // Directive and source order have no policy meaning; equivalent policies remain admitted.
  const reordered = structuredClone(conf);
  reordered.app.security.csp = conf.app.security.csp.split(';').map((part) => part.trim()).filter(Boolean)
    .map((part) => {
      const [name, ...sources] = part.split(/\s+/u);
      return [name, ...sources.reverse()].join(' ');
    }).reverse().join('; ');
  verifyConfiguration(reordered, files, capability);
  console.log(`OK — ${mutations.length} in-memory desktop configuration mutations refused.`);
}

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--selftest'), 'usage: verify-config.mjs [--selftest]');
if (args[0] === '--selftest') selftest();
verifyConfiguration(conf, files, capability);
console.log('OK — @kodera/desktop Tauri v2 configuration, capabilities, and icons verified.');
