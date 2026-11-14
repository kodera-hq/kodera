import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  APPROVED_CONNECT_SOURCES,
  REQUIRED_BUNDLE_ICONS,
  validateTauriSecurityInvariants,
} from '../src/security-policy.mjs';
import { buildIconFiles } from './generate-icons.mjs';

const desktopDir = join(import.meta.dirname, '..');
const tauriDir = join(desktopDir, 'src-tauri');
const srcDir = join(desktopDir, 'src');
const requiredIcons = [...REQUIRED_BUNDLE_ICONS];
const requiredFiles = ['build.rs', 'src/main.rs', 'capabilities/default.json', ...requiredIcons];
const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
const files = new Set(requiredFiles.filter((path) => existsSync(join(tauriDir, path))));
const capability = files.has('capabilities/default.json')
  ? JSON.parse(readFileSync(join(tauriDir, 'capabilities/default.json'), 'utf8'))
  : null;

// The desktop shell is a companion surface: it sells nothing. No pricing, plan, upgrade or
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
  const addTauri = (path) => surface.set(path, readFileSync(join(tauriDir, path), 'utf8'));
  for (const name of readdirSync(join(tauriDir, 'src')).sort()) {
    if (name.endsWith('.rs')) addTauri(`src/${name}`);
  }
  for (const name of readdirSync(join(tauriDir, 'capabilities')).sort()) {
    addTauri(`capabilities/${name}`);
  }
  if (existsSync(srcDir)) {
    for (const name of readdirSync(srcDir).sort()) {
      if (name.endsWith('.mjs') || name.endsWith('.d.ts')) {
        surface.set(`../src/${name}`, readFileSync(join(srcDir, name), 'utf8'));
      }
    }
  }
  for (const path of ['tauri.conf.json', 'Cargo.toml', 'build.rs', '../package.json']) {
    addTauri(path);
  }
  return surface;
}

function verifyCompanionSurface(surface) {
  assert.ok(
    surface.size >= 10 && surface.has('src/commands.rs') && surface.has('../src/bridge.mjs'),
    'companion surface must include the desktop Rust and TypeScript sources',
  );
  for (const [path, text] of surface) {
    for (const [pattern, finding] of COMPANION_RULES) {
      const match = pattern.exec(text);
      assert.equal(match, null, `${path} ${finding}: ${JSON.stringify(match?.[0])}; the desktop shell sells nothing`);
    }
  }
}

function extractRustCssLiterals(prodRustSource) {
  const blocks = [];
  const rawNamedCss = /const\s+[A-Z0-9_]*CSS[A-Z0-9_]*\s*:\s*&str\s*=\s*r(#*)"([\s\S]*?)"\1\s*;/gu;
  for (const match of prodRustSource.matchAll(rawNamedCss)) {
    blocks.push(match[2]);
  }
  const quotedNamedCss = /const\s+[A-Z0-9_]*CSS[A-Z0-9_]*\s*:\s*&str\s*=\s*"((?:\\.|[^"\\])*)"\s*;/gu;
  for (const match of prodRustSource.matchAll(quotedNamedCss)) {
    blocks.push(match[1]);
  }
  const genericRawStrings = /r(#+)"([\s\S]*?)"\1/gu;
  for (const match of prodRustSource.matchAll(genericRawStrings)) {
    const candidate = match[2];
    if (
      !blocks.includes(candidate)
      && /(?:^|\n)\s*(?::root|body|\.[a-z][\w-]*)\s*\{[\s\S]*?(?:background|color|font-family|padding|border-radius)\s*:/iu.test(candidate)
    ) {
      blocks.push(candidate);
    }
  }
  return blocks;
}

const EMBEDDED_STYLE_RULES = [
  [/#[0-9a-f]{3,8}\b/iu, 'embedded CSS contains raw hex color literal'],
  [/\b(?:rgba?|hsla?|oklch|oklab|color-mix)\s*\(/iu, 'embedded CSS contains raw color function'],
  [/font-family\s*:(?!\s*var\(--)\s*[^;}]+/iu, 'embedded CSS contains hardcoded font-family'],
  [/\b\d+(?:\.\d+)?px\b/iu, 'embedded CSS contains raw px literal instead of design token'],
];

function verifyRustEmbeddedUiStyles(surface) {
  const guiSource = surface.get('src/gui.rs');
  assert.equal(typeof guiSource, 'string', 'src/gui.rs must be present in desktop surface');
  assert.match(
    guiSource,
    /include_str!\(\s*"\.\.\/\.\.\/\.\.\/\.\.\/packages\/design-tokens\/dist\/tokens\.css"\s*\)/u,
    'src/gui.rs must embed @kodera/design-tokens dist/tokens.css',
  );

  let inspectedStylesheets = 0;
  for (const [path, text] of surface) {
    if (!path.startsWith('src/') || !path.endsWith('.rs')) {
      continue;
    }
    const prodText = text.split('\n#[cfg(test)]')[0];
    const inlineStyleTag = /<style\b/iu.exec(prodText);
    assert.equal(
      inlineStyleTag,
      null,
      `${path} contains inline <style> element; preserve style-src 'self' CSP`,
    );
    for (const css of extractRustCssLiterals(prodText)) {
      inspectedStylesheets += 1;
      for (const [pattern, diagnostic] of EMBEDDED_STYLE_RULES) {
        const violation = pattern.exec(css);
        assert.equal(
          violation,
          null,
          `${path} ${diagnostic}: ${JSON.stringify(violation?.[0])}`,
        );
      }
    }
  }
  assert.ok(inspectedStylesheets >= 1, 'must inspect at least one Rust-embedded UI stylesheet');
}

function verifyBundleIconBinaries() {
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const rel of ['icons/32x32.png', 'icons/128x128.png', 'icons/128x128@2x.png', 'icons/icon.png']) {
    const bytes = readFileSync(join(tauriDir, rel));
    assert.ok(bytes.length > 32 && bytes.subarray(0, 8).equals(pngSig), `${rel} must have a valid PNG header`);
  }
  const expected = buildIconFiles();
  const icnsDisk = readFileSync(join(tauriDir, 'icons/icon.icns'));
  assert.equal(icnsDisk.subarray(0, 4).toString('ascii'), 'icns', 'icons/icon.icns must have an Apple ICNS header');
  assert.equal(icnsDisk.readUInt32BE(4), icnsDisk.length, 'icons/icon.icns length field must match file size');
  assert.ok(icnsDisk.equals(expected.icns), 'icons/icon.icns must match deterministic generator output');

  const icoDisk = readFileSync(join(tauriDir, 'icons/icon.ico'));
  assert.deepEqual([...icoDisk.subarray(0, 4)], [0x00, 0x00, 0x01, 0x00], 'icons/icon.ico must have a Windows ICO header');
  assert.ok(icoDisk.readUInt16LE(4) >= 1, 'icons/icon.ico must contain at least one icon directory entry');
  assert.ok(icoDisk.equals(expected.ico), 'icons/icon.ico must match deterministic generator output');
}

function verifyConfiguration(config, availableFiles, defaultCapability) {
  validateTauriSecurityInvariants(config, defaultCapability);
  for (const path of requiredFiles) {
    assert.ok(availableFiles.has(path), `required file missing: ${path}`);
  }
}

function selftest() {
  verifyConfiguration(conf, files, capability);
  verifyBundleIconBinaries();
  const connectFirst = APPROVED_CONNECT_SOURCES[0];
  const mutations = [
    ['wrong identifier', /identifier must match/u, (config) => { config.identifier = 'io.invalid.desktop'; }],
    ['missing tray icon', /trayIcon must configure kodera-tray/u, (config) => { delete config.app.trayIcon; }],
    ['wrong tray icon path', /trayIcon must configure kodera-tray/u, (config) => { config.app.trayIcon.iconPath = 'icons/missing.png'; }],
    ['missing media directive', /media-src must be present/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("media-src 'self' blob:;", '');
    }],
    ['missing worker directive', /worker-src must be present/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("worker-src 'self' blob:;", '');
    }],
    ['invalid frontend distribution', /frontendDist must use/u, (config) => { config.build.frontendDist = '../untrusted'; }],
    ['missing bundle resources', /bundle resources must stage/u, (config) => { delete config.bundle.resources; }],
    ['wrong bundle resources target', /bundle resources must stage/u, (config) => { config.bundle.resources = { '../../web/dist/': 'wrong/' }; }],
    ['extra unreviewed bundle resource', /bundle resources must stage/u, (config) => { config.bundle.resources['../../README.md'] = 'README.md'; }],
    ['missing capability selection', /default capability must be selected/u, (config) => { config.app.security.capabilities = []; }],
    ['missing capability file', /required file missing: capabilities\/default.json/u, (_config, availableFiles) => {
      availableFiles.delete('capabilities/default.json');
    }],
    ['missing icon selection', /all bundled icons must be selected/u, (config) => { config.bundle.icon = []; }],
    ['missing png icon file', /required file missing: icons\/icon\.png/u, (_config, availableFiles) => {
      availableFiles.delete('icons/icon.png');
    }],
    ['missing icns icon file', /required file missing: icons\/icon\.icns/u, (_config, availableFiles) => {
      availableFiles.delete('icons/icon.icns');
    }],
    ['missing ico icon file', /required file missing: icons\/icon\.ico/u, (_config, availableFiles) => {
      availableFiles.delete('icons/icon.ico');
    }],
    ['expanded capability shell permission', /capability must remain least privilege/u, (_config, _files, defaultCapability) => {
      defaultCapability.permissions.push('shell:allow-execute');
    }],
    ['expanded capability fs permission', /capability must remain least privilege/u, (_config, _files, defaultCapability) => {
      defaultCapability.permissions.push('fs:allow-write-file');
    }],
    ['duplicate capability permission', /capability must remain least privilege/u, (_config, _files, defaultCapability) => {
      defaultCapability.permissions.push('core:default');
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
    ['unsafe script evaluation', /CSP must forbid 'unsafe-eval'/u, (config) => {
      config.app.security.csp += "; script-src 'self' 'unsafe-eval'";
    }],
    ['external script source', /CSP must contain only approved directives/u, (config) => {
      config.app.security.csp += '; script-src https://scripts.example.org';
    }],
    ['wildcard connections', /connect-src must use only approved sources/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace(`connect-src ${connectFirst}`, 'connect-src *');
    }],
    ['bare host wildcard connection without path', /connect-src must use only approved sources/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace(
        'https://*.kodera.io/_matrix/',
        'https://*.kodera.io',
      );
    }],
    ['insecure connections', /connect-src must use only approved sources/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace(`connect-src ${connectFirst}`, `connect-src ${connectFirst} http: ws:`);
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
    ['inline style elements', /style-src must use only approved sources/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
    }],
    ['missing style attribute directive', /style-src-attr must be present exactly once/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("style-src-attr 'unsafe-inline';", '');
    }],
    ['blocked inline style attributes', /style-src-attr must use only approved sources/u, (config) => {
      config.app.security.csp = config.app.security.csp.replace("style-src-attr 'unsafe-inline'", "style-src-attr 'none'");
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
  for (const directive of ['connect-src', 'img-src', 'style-src', 'style-src-attr', 'object-src', 'base-uri', 'form-action', 'frame-ancestors']) {
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
  // Directive, source, permission, and scheme order have no policy meaning; equivalent policies remain admitted.
  const reordered = structuredClone(conf);
  reordered.app.security.csp = conf.app.security.csp.split(';').map((part) => part.trim()).filter(Boolean)
    .map((part) => {
      const [name, ...sources] = part.split(/\s+/u);
      return [name, ...sources.reverse()].join(' ');
    }).reverse().join('; ');
  reordered.plugins['deep-link'].desktop.schemes = [...conf.plugins['deep-link'].desktop.schemes].reverse();
  const reorderedCap = structuredClone(capability);
  reorderedCap.permissions = [...capability.permissions].reverse();
  verifyConfiguration(reordered, files, reorderedCap);
  console.log(`OK — ${mutations.length} in-memory desktop configuration mutations refused.`);

  // The same discipline for the companion rule: each reintroduction is refused for its own reason.
  const surface = companionSurface();
  verifyCompanionSurface(surface);
  const commercial = [
    ['an upgrade prompt', /src\/commands\.rs carries commercial wording: "Upgrade"/u, 'src/commands.rs', '\n// Upgrade to unlock more seats\n'],
    ['a bridge commercial label', /\.\.\/src\/bridge\.mjs carries commercial wording: "pricing"/u, '../src/bridge.mjs', '\nconst LABEL = "See pricing";\n'],
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

  verifyRustEmbeddedUiStyles(surface);
  const styleMutations = [
    [
      'raw hex color in BOOTSTRAP_CSS',
      /src\/gui\.rs embedded CSS contains raw hex color literal: "#2563eb"/u,
      (src) => src.replace('var(--action-primary)', '#2563eb'),
    ],
    [
      'raw rgba color function in BOOTSTRAP_CSS',
      /src\/gui\.rs embedded CSS contains raw color function: "rgba\("/u,
      (src) => src.replace('var(--shadow-card)', '0 8px 20px rgba(15, 23, 42, 0.06)'),
    ],
    [
      'hardcoded font-family in BOOTSTRAP_CSS',
      /src\/gui\.rs embedded CSS contains hardcoded font-family/u,
      (src) => src.replace('font-family: var(--font-sans);', 'font-family: "Plus Jakarta Sans", sans-serif;'),
    ],
    [
      'raw px spacing literal in BOOTSTRAP_CSS',
      /src\/gui\.rs embedded CSS contains raw px literal instead of design token: "32px"/u,
      (src) => src.replace('padding: var(--sp-8);', 'padding: 32px;'),
    ],
    [
      'inline <style> tag in BOOTSTRAP_INDEX_HTML',
      /src\/gui\.rs contains inline <style> element/u,
      (src) => src.replace('<link rel="stylesheet" href="/tokens.css" />', '<style>body{}</style>'),
    ],
    [
      'missing @kodera/design-tokens include',
      /src\/gui\.rs must embed @kodera\/design-tokens dist\/tokens\.css/u,
      (src) => src.replace('../../../../packages/design-tokens/dist/tokens.css', './untracked.css'),
    ],
  ];
  for (const [name, diagnostic, transform] of styleMutations) {
    const mutated = new Map(surface);
    mutated.set('src/gui.rs', transform(mutated.get('src/gui.rs')));
    assert.throws(
      () => verifyRustEmbeddedUiStyles(mutated),
      diagnostic,
      `selftest failed to reject ${name} for its own diagnostic`,
    );
  }
  console.log(`OK — ${styleMutations.length} in-memory Rust UI style mutations refused.`);
}

function isDirectExecution(metaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== 'string' || argv1.length === 0) {
    return false;
  }
  return pathToFileURL(realpathSync(resolve(argv1))).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--selftest'), 'usage: verify-config.mjs [--selftest]');
  if (args[0] === '--selftest') selftest();
  const surface = companionSurface();
  verifyConfiguration(conf, files, capability);
  verifyBundleIconBinaries();
  verifyCompanionSurface(surface);
  verifyRustEmbeddedUiStyles(surface);
  console.log('OK — @kodera/desktop Tauri v2 configuration, capabilities, design-token UI styles, and icons verified; no commercial wording or billing destination.');
}
