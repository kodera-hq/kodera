import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

// The desktop preview is a companion surface: it sells nothing. No pricing, plan, upgrade or
// checkout wording, no billing SDK and no address that can reach a payment page may appear in its
// sources or configuration. `plan` alone is not listed: here it names the self-host deployment plan.
// Stems that mean commerce wherever they stand, inside an identifier included (`open_checkout`,
// `showPaywall`), then whole words that are only commercial on their own.
const COMMERCIAL_WORDING = new RegExp([
  'pricing|upgrad(?:e|es|ed|ing)|upsell|checkout|billing|invoic(?:e|es|ed|ing)|payment|purchas(?:e|es|ed|ing)',
  'paywall|subscri(?:be|bes|bed|ber|bers|ption|ptions)|premium|tarification|abonnement|facturation|paiement',
  String.raw`(?<!\p{L})(?:priced?|prices|billed|pay\s+now|free\s+trial|trial\s+period|(?:paid|pro|business|enterprise)\s+plan`
    + String.raw`|buy(?:\s+now)?|credit\s+card|per\s+(?:seat|user|month)|tarifs?|prix|mise\s+à\s+niveau|s['’]abonner`
    + String.raw`|factures?|achats?|acheter|essai\s+gratuit|carte\s+bancaire|par\s+mois)(?!\p{L})`,
].join('|'), 'iu');
const PRICE_AMOUNT = /[€$£]\s?\d|\d\s?(?:€|EUR\b|USD\b|GBP\b)/u;
const BILLING_SDK = /\b(?:stripe|paypal|revenuecat|paddle|storekit|skpaymentqueue|skproduct|billingclient)\b|com\.android\.billingclient|com\.android\.vending\.BILLING/iu;
const BILLING_PATHS = 'billing|checkout|pricing|upgrade|invoices?|orders?|subscriptions?|payments?|plans?';
const BILLING_DESTINATION = new RegExp(
  '(?:https?:)?//[^\\s"\'<>)]*\\b(?:' + BILLING_PATHS + ')\\b'
  + '|["\'`]/(?:' + BILLING_PATHS + ')(?:[/?#"\'`]|$)',
  'iu');
const COMPANION_RULES = [
  [COMMERCIAL_WORDING, 'carries commercial wording'],
  [PRICE_AMOUNT, 'states a price'],
  [BILLING_SDK, 'names a billing provider or store purchase API'],
  [BILLING_DESTINATION, 'names a billing destination'],
];

function companionSurface() {
  const surface = new Map();
  const add = (path) => surface.set(path, readFileSync(join(tauriDir, path), 'utf8'));
  for (const name of readdirSync(join(tauriDir, 'src')).sort()) if (name.endsWith('.rs')) add(`src/${name}`);
  for (const name of readdirSync(join(tauriDir, 'capabilities')).sort()) add(`capabilities/${name}`);
  for (const path of ['tauri.conf.json', 'Cargo.toml', 'build.rs', '../package.json']) add(path);
  return surface;
}

function verifyCompanionSurface(surface) {
  assert.ok(surface.size >= 7 && surface.has('src/commands.rs'), 'companion surface must include the desktop sources');
  for (const [path, text] of surface) {
    for (const [pattern, finding] of COMPANION_RULES) {
      const match = pattern.exec(text);
      assert.equal(match, null, `${path} ${finding}: ${JSON.stringify(match?.[0])}; the desktop preview sells nothing`);
    }
  }
}

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
  const plugins = config.plugins;
  assert.ok(plugins !== null && typeof plugins === 'object' && !Array.isArray(plugins),
    'plugins configuration must be present');
  assert.deepEqual(Object.keys(plugins), ['deep-link'],
    'plugins must contain only the approved deep-link handler');
  const deepLink = plugins['deep-link'];
  assert.ok(deepLink !== null && typeof deepLink === 'object' && !Array.isArray(deepLink),
    'deep-link plugin configuration must be an object');
  assert.deepEqual(Object.keys(deepLink), ['desktop'],
    'deep-link configuration must scope to desktop only');
  const desktopDeepLink = deepLink.desktop;
  assert.ok(desktopDeepLink !== null && typeof desktopDeepLink === 'object' && !Array.isArray(desktopDeepLink),
    'deep-link desktop configuration must be an object');
  assert.deepEqual(Object.keys(desktopDeepLink), ['schemes'],
    'deep-link desktop configuration must contain only schemes');
  const schemes = desktopDeepLink.schemes;
  assert.ok(Array.isArray(schemes), 'deep-link schemes must be an array');
  assert.ok(schemes.every((scheme) => typeof scheme === 'string' && /^[a-z][a-z0-9+.-]*$/u.test(scheme)),
    'deep-link schemes must be canonical lowercase RFC 3986 scheme names');
  assert.equal(new Set(schemes).size, schemes.length, 'deep-link schemes must not contain duplicates');
  assert.deepEqual([...schemes].sort(), ['kodera', 'matrix'],
    'deep-link schemes must register exactly kodera and matrix');
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
    ['missing plugins block', /plugins configuration must be present/u, (config) => {
      delete config.plugins;
    }],
    ['unapproved plugin registration', /plugins must contain only the approved deep-link handler/u, (config) => {
      config.plugins.shell = { open: true };
    }],
    ['non-object deep-link plugin config', /deep-link plugin configuration must be an object/u, (config) => {
      config.plugins['deep-link'] = true;
    }],
    ['unapproved deep-link target scope', /deep-link configuration must scope to desktop only/u, (config) => {
      config.plugins['deep-link'].mobile = [];
    }],
    ['extra deep-link desktop key', /deep-link desktop configuration must contain only schemes/u, (config) => {
      config.plugins['deep-link'].desktop.domains = ['*'];
    }],
    ['missing matrix scheme', /deep-link schemes must register exactly kodera and matrix/u, (config) => {
      config.plugins['deep-link'].desktop.schemes = ['kodera'];
    }],
    ['missing kodera scheme', /deep-link schemes must register exactly kodera and matrix/u, (config) => {
      config.plugins['deep-link'].desktop.schemes = ['matrix'];
    }],
    ['duplicate deep-link scheme', /deep-link schemes must not contain duplicates/u, (config) => {
      config.plugins['deep-link'].desktop.schemes = ['kodera', 'matrix', 'kodera'];
    }],
    ['unapproved http deep-link scheme', /deep-link schemes must register exactly kodera and matrix/u, (config) => {
      config.plugins['deep-link'].desktop.schemes = ['kodera', 'matrix', 'http'];
    }],
    ['dangerous javascript deep-link scheme', /deep-link schemes must register exactly kodera and matrix/u, (config) => {
      config.plugins['deep-link'].desktop.schemes = ['kodera', 'javascript'];
    }],
    ['non-canonical scheme delimiter', /deep-link schemes must be canonical lowercase RFC 3986 scheme names/u, (config) => {
      config.plugins['deep-link'].desktop.schemes = ['kodera://', 'matrix'];
    }],
    ['uppercase deep-link scheme', /deep-link schemes must be canonical lowercase RFC 3986 scheme names/u, (config) => {
      config.plugins['deep-link'].desktop.schemes = ['Kodera', 'matrix'];
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
  reordered.plugins['deep-link'].desktop.schemes = [...conf.plugins['deep-link'].desktop.schemes].reverse();
  verifyConfiguration(reordered, files, capability);
  console.log(`OK — ${mutations.length} in-memory desktop configuration mutations refused.`);

  // The same discipline for the companion rule: each reintroduction is refused for its own reason.
  const surface = companionSurface();
  verifyCompanionSurface(surface);
  const commercial = [
    ['an upgrade prompt', /src\/commands\.rs carries commercial wording: "Upgrade"/u, 'src/commands.rs', '\n// Upgrade to unlock more seats\n'],
    ['a pricing label', /src\/lib\.rs carries commercial wording: "pricing"/u, 'src/lib.rs', '\nconst LABEL: &str = "See pricing";\n'],
    ['a checkout route', /src\/commands\.rs carries commercial wording: "checkout"/u, 'src/commands.rs', '\n"open_checkout" => todo!(),\n'],
    ['a subscription notice', /tauri\.conf\.json carries commercial wording: "subscription"/u, 'tauri.conf.json', '\n"note": "Your subscription ends soon"\n'],
    ['a paid plan', /src\/lib\.rs carries commercial wording: "Pro plan"/u, 'src/lib.rs', '\n// Pro plan only\n'],
    ['French commercial wording', /src\/lib\.rs carries commercial wording: "abonnement"/u, 'src/lib.rs', '\n// abonnement requis\n'],
    ['French upgrade wording', /src\/lib\.rs carries commercial wording: "mise à niveau"/u, 'src/lib.rs', '\n// mise à niveau\n'],
    ['a price', /src\/lib\.rs states a price: "9 €"/u, 'src/lib.rs', '\n// 9 € each\n'],
    ['a dollar price', /Cargo\.toml states a price: "\$4"/u, 'Cargo.toml', '\n# $49 once\n'],
    ['a billing provider', /src\/lib\.rs names a billing provider or store purchase API: "Stripe"/u, 'src/lib.rs', '\n// Stripe session\n'],
    ['a store purchase API', /src\/main\.rs names a billing provider or store purchase API: "StoreKit"/u, 'src/main.rs', '\n// StoreKit\n'],
    ['a console orders address', /capabilities\/default\.json names a billing destination: "https:\/\/console\.example\.org\/acme\/order"/u,
      'capabilities/default.json', '\n"https://console.example.org/acme/order"\n'],
    ['a relative plans path', /src\/commands\.rs names a billing destination: "\\"\/plans\\""/u, 'src/commands.rs', '\nconst PATH: &str = "/plans";\n'],
  ];
  for (const [name, diagnostic, path, addition] of commercial) {
    const mutated = new Map(surface);
    assert.ok(mutated.has(path), `selftest names a file outside the companion surface: ${path}`);
    mutated.set(path, mutated.get(path) + addition);
    assert.throws(() => verifyCompanionSurface(mutated), diagnostic,
      `selftest failed to reject ${name} for its own diagnostic`);
  }
  // The self-host deployment plan and its wording stay admitted.
  const admitted = new Map(surface);
  admitted.set('src/lib.rs', admitted.get('src/lib.rs') + '\n// plan_self_host derives a deployment plan; planning is local.\n');
  verifyCompanionSurface(admitted);
  assert.throws(() => verifyCompanionSurface(new Map([['src/lib.rs', '']])), /companion surface must include/u,
    'selftest failed to reject an emptied companion surface');
  console.log(`OK — ${commercial.length + 1} in-memory commercial-surface mutations refused.`);
}

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--selftest'), 'usage: verify-config.mjs [--selftest]');
if (args[0] === '--selftest') selftest();
verifyConfiguration(conf, files, capability);
verifyCompanionSurface(companionSurface());
console.log('OK — @kodera/desktop Tauri v2 configuration, capabilities, and icons verified; no commercial wording or billing destination.');
