// The extensions catalogue is generated from the extension manifests, every starter is labelled
// a reference implementation, and wording that claims more than the repository ships is refused.
// Each refusal below mutates an in-memory copy of the tree and must be named by the check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CATALOG_PATH,
  LABEL,
  NotRead,
  README_PATH,
  build,
  collect,
  problemsIn,
  serialise,
  table,
} from '../../../extensions/catalog.mjs';

const files = await collect();
const { catalog } = build(files);

/** A copy of the tree with some paths replaced (a `null` value removes the path). */
function tree(changes) {
  const copy = new Map(files);
  for (const [path, text] of Object.entries(changes)) {
    if (text === null) copy.delete(path);
    else copy.set(path, text);
  }
  return copy;
}
/** Regenerates the catalogue and the table for a mutated tree, so only the mutation is judged. */
function regenerated(changes) {
  const mutated = tree(changes);
  const rebuilt = build(mutated).catalog;
  mutated.set(CATALOG_PATH, serialise(rebuilt));
  mutated.set(README_PATH, files.get(README_PATH).replace(table(catalog), table(rebuilt)));
  return mutated;
}
const helloManifest = 'extensions/hello-webhook/kodera-extension.json';
const edit = (path, change) => change(JSON.parse(files.get(path)));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const discoveredExtensionSlugs = new Set(
  [...files.keys()]
    .map((path) => /^extensions\/([^/]+)\/.+$/u.exec(path)?.[1])
    .filter(Boolean),
);

test('catalogue: generated from every extension manifest, with nothing to refuse', () => {
  assert.deepEqual(problemsIn(files), []);
  assert.equal(files.get(CATALOG_PATH), serialise(catalog));
  assert.equal(catalog.extensions.length, discoveredExtensionSlugs.size);
  assert.ok(catalog.extensions.length >= 17);
  for (const entry of catalog.extensions) {
    assert.equal(entry.label, LABEL);
    const manifest = JSON.parse(files.get(entry.manifest));
    assert.equal(entry.name, manifest.name);
    assert.equal(entry.description, manifest.description);
    assert.equal(entry.version, manifest.version);
    assert.ok(files.get(README_PATH).includes(`| ${entry.name.replaceAll('|', '\\|')} | *${LABEL}* |`), entry.slug);
  }
});

test('catalogue refusal: a manifest changed without regenerating is drift', () => {
  const renamed = tree({ [helloManifest]: json(edit(helloManifest, (m) => ({ ...m, name: 'Hello Webhook' }))) });
  assert.deepEqual(problemsIn(renamed), [
    `${CATALOG_PATH} drifted from the extension manifests`,
    `${README_PATH} catalogue table drifted from the extension manifests`,
  ]);
  const scoped = tree({
    [helloManifest]: json(edit(helloManifest, (m) => ({ ...m, scopes: [...m.scopes, 'threads:write'] }))),
  });
  assert.deepEqual(problemsIn(scoped), [`${CATALOG_PATH} drifted from the extension manifests`]);
});

test('catalogue refusal: a hand-edited catalogue or table is drift', () => {
  const edited = structuredClone(catalog);
  edited.extensions[0].label = 'Verified';
  assert.deepEqual(problemsIn(tree({ [CATALOG_PATH]: serialise(edited) })), [
    `${CATALOG_PATH} drifted from the extension manifests`,
  ]);
  const unlabelled = files.get(README_PATH).replace(`*${LABEL}*`, 'Available');
  assert.deepEqual(problemsIn(tree({ [README_PATH]: unlabelled })), [
    `${README_PATH} catalogue table drifted from the extension manifests`,
  ]);
  const removed = Object.fromEntries(
    [...files.keys()].filter((path) => path.startsWith('extensions/hello-webhook/')).map((path) => [path, null]),
  );
  assert.ok(problemsIn(tree(removed)).includes(`${CATALOG_PATH} drifted from the extension manifests`));
});

test('catalogue refusal: a second manifest, a live endpoint or a foreign id', () => {
  const second = tree({ 'extensions/hello-webhook/manifest.json': files.get(helloManifest) });
  assert.ok(
    problemsIn(second).includes('extensions/hello-webhook: exactly one manifest is the source (found 2)'),
  );
  const live = regenerated({
    [helloManifest]: json(edit(helloManifest, (m) => ({ ...m, webhookUrl: 'https://extensions.kodera.io/hello-webhook/webhook' }))),
  });
  assert.deepEqual(problemsIn(live), [
    `${helloManifest}: webhookUrl must be a reserved documentation host, not a live endpoint`,
  ]);
  const foreign = tree({ [helloManifest]: json(edit(helloManifest, (m) => ({ ...m, id: 'another-extension' }))) });
  assert.ok(
    problemsIn(foreign).includes(
      `${helloManifest}: manifest id must be "hello-webhook" or "io.kodera.ext.hello-webhook"`,
    ),
  );
});

test('catalogue refusal: an extension that drops the reference label', () => {
  const packagePath = 'extensions/qonto-treasury-feed/package.json';
  const unlabelled = tree({
    [packagePath]: json(edit(packagePath, (p) => ({ ...p, description: 'Streams corporate treasury movements.' }))),
  });
  assert.deepEqual(problemsIn(unlabelled), [`${packagePath}: description must start with "${LABEL}: "`]);
  const readmePath = 'extensions/hello-webhook/README.md';
  const active = tree({ [readmePath]: files.get(readmePath).replace(`Status: ${LABEL}`, 'Status: Active') });
  assert.deepEqual(problemsIn(active), [`${readmePath}: must carry "Status: ${LABEL}"`]);
});

test('catalogue refusal: forbidden claims are named wherever they reappear', () => {
  // The wording is assembled here so that this file never contains what it refuses.
  const organisation = ['DIN', 'UM'].join('');
  const consultancy = ['OC', 'TO'].join('');
  const cases = [
    [`Annonce les documents ${organisation} Docs dans un salon.`, 'an organisation named without its authorisation'],
    [`Design partner: ${consultancy} Technology.`, 'an organisation named without its authorisation'],
    [['This is a live', 'connector to the bank.'].join(' '), 'a connector presented as live'],
    [['Un connecteur', 'en direct avec la banque.'].join(' '), 'a connector presented as live'],
    [['Official', 'Kodera extension for treasury.'].join(' '), 'an extension presented as official'],
    [['Pack de connecteurs', 'officiels.'].join(' '), 'an extension presented as official'],
    [['A cert', 'ified integration.'].join(''), 'an extension presented with an endorsement it does not have'],
    [['Production', 'ready treasury feed.'].join('-'), 'an extension presented with an endorsement it does not have'],
  ];
  const manifestPath = 'extensions/qonto-treasury-feed/manifest.json';
  for (const [wording, claim] of cases) {
    const inManifest = regenerated({
      [manifestPath]: json(edit(manifestPath, (m) => ({ ...m, description: wording }))),
    });
    assert.deepEqual(
      problemsIn(inManifest),
      [`forbidden claim in ${CATALOG_PATH}: ${claim}`, `forbidden claim in ${manifestPath}: ${claim}`],
      wording,
    );
    const inSource = tree({ 'packages/extension-sdk/README.md': `${files.get('packages/extension-sdk/README.md')}\n${wording}\n` });
    assert.deepEqual(problemsIn(inSource), [`forbidden claim in packages/extension-sdk/README.md: ${claim}`], wording);
  }
  // Plain descriptions of what an example does are not claims.
  const harmless = tree({
    'extensions/git-tracker/README.md': `${files.get('extensions/git-tracker/README.md')}\nNo fixture feed is presented as live. October release notes.\n`,
  });
  assert.deepEqual(problemsIn(harmless), []);
});

test('catalogue refusal: a symbolic link is named, never followed, and nothing it points to is read', async () => {
  const marker = 'OUTSIDE-FILE-CONTENT-MUST-NOT-BE-READ';
  const temporary = await mkdtemp(join(tmpdir(), 'kodera-catalog-'));
  try {
    const outside = join(temporary, 'outside.md');
    await writeFile(outside, `# Outside\n\n${marker}\n`);
    const root = join(temporary, 'repository');
    await mkdir(join(root, 'extensions/demo'), { recursive: true });
    await mkdir(join(root, 'packages/extension-sdk'), { recursive: true });
    await writeFile(join(root, 'extensions/demo/notes.txt'), 'plain notes\n');
    await writeFile(join(root, 'extensions/demo/blob.bin'), Buffer.from([0xff, 0xfe, 0x00]));
    await symlink(outside, join(root, 'extensions/demo/README.md'));
    await symlink(temporary, join(root, 'extensions/linked-directory'));
    const collected = await collect(pathToFileURL(`${root}/`));
    // Every entry is accounted for: read, or recorded as not read. None is skipped.
    assert.deepEqual([...collected.keys()].sort(), [
      'extensions/demo/README.md',
      'extensions/demo/blob.bin',
      'extensions/demo/notes.txt',
      'extensions/linked-directory',
    ]);
    assert.ok(collected.get('extensions/demo/README.md') instanceof NotRead);
    assert.ok(collected.get('extensions/linked-directory') instanceof NotRead);
    assert.equal(collected.get('extensions/demo/notes.txt'), 'plain notes\n');
    const problems = problemsIn(collected);
    for (const expected of [
      'extensions/demo/README.md: symbolic link refused: the check reads regular UTF-8 files inside the repository only',
      'extensions/linked-directory: symbolic link refused: the check reads regular UTF-8 files inside the repository only',
      'extensions/demo/blob.bin: file that is not UTF-8 text refused: the check reads regular UTF-8 files inside the repository only',
    ])
      assert.ok(problems.includes(expected), expected);
    assert.ok(!JSON.stringify([...collected.values()].filter((value) => typeof value === 'string')).includes(marker));
    assert.ok(!problems.join('\n').includes(marker));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  // The same refusal on the real tree, with one path recorded as a link.
  const linked = tree({ 'extensions/hello-webhook/NOTES.md': new NotRead('symbolic link') });
  assert.deepEqual(problemsIn(linked), [
    'extensions/hello-webhook/NOTES.md: symbolic link refused: the check reads regular UTF-8 files inside the repository only',
  ]);
  // And a file type the check never listed is read like any other.
  const unlisted = tree({ 'extensions/hello-webhook/NOTES.txt': ['A cert', 'ified integration.'].join('') + '\n' });
  assert.deepEqual(problemsIn(unlisted), [
    'forbidden claim in extensions/hello-webhook/NOTES.txt: an extension presented with an endorsement it does not have',
  ]);
});

test('catalogue refusal: a name with #, ? or %41 is read from its own path, not from the one a URL would name', async () => {
  // The wording is assembled here so that this file never contains what it refuses.
  const claim = `${['Official', 'Kodera extension.'].join(' ')}\n`;
  const temporary = await mkdtemp(join(tmpdir(), 'kodera-catalog-names-'));
  try {
    const root = join(temporary, 'repository');
    await mkdir(join(root, 'extensions/demo'), { recursive: true });
    await mkdir(join(root, 'extensions/evil#x'), { recursive: true });
    await mkdir(join(root, 'extensions/evil'), { recursive: true });
    await mkdir(join(root, 'extensions/%64emo'), { recursive: true });
    await mkdir(join(root, 'packages/extension-sdk'), { recursive: true });
    // Each clean decoy is the file a spliced URL would have opened instead.
    const entries = [
      ['extensions/demo/A.md', 'clean\n'],
      ['extensions/demo/%41.md', claim],
      ['extensions/demo/notes', 'clean\n'],
      ['extensions/demo/notes#1.md', claim],
      ['extensions/demo/what', 'clean\n'],
      ['extensions/demo/what?.md', claim],
      ['extensions/evil/README.md', 'clean\n'],
      ['extensions/evil#x/README.md', claim],
      ['extensions/%64emo/README.md', claim],
    ];
    for (const [path, text] of entries) await writeFile(join(root, ...path.split('/')), text);
    const collected = await collect(pathToFileURL(`${root}/`));
    // Every entry is listed under its own name and holds its own content.
    assert.deepEqual(
      [...collected].sort(([a], [b]) => a.localeCompare(b)),
      [...entries].sort(([a], [b]) => a.localeCompare(b)),
    );
    const problems = problemsIn(collected);
    for (const path of [
      'extensions/demo/%41.md',
      'extensions/demo/notes#1.md',
      'extensions/demo/what?.md',
      'extensions/evil#x/README.md',
      'extensions/%64emo/README.md',
    ])
      assert.ok(problems.includes(`forbidden claim in ${path}: an extension presented as official`), path);
    // And a directory so named is not an extension the catalogue can list.
    assert.ok(problems.includes('extensions/evil#x: exactly one manifest is the source (found 0)'));
    assert.ok(problems.includes('extensions/%64emo: exactly one manifest is the source (found 0)'));
    // The same holds when the root is given as a plain path.
    assert.deepEqual([...(await collect(root)).keys()].sort(), [...collected.keys()].sort());
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('catalogue refusal: a scanned directory behind a symbolic link, at any level, is named and not entered', async () => {
  const marker = 'OUTSIDE-FILE-CONTENT-MUST-NOT-BE-READ';
  const temporary = await mkdtemp(join(tmpdir(), 'kodera-catalog-parents-'));
  try {
    const elsewhere = join(temporary, 'elsewhere');
    await mkdir(join(elsewhere, 'extensions/demo'), { recursive: true });
    await mkdir(join(elsewhere, 'packages/extension-sdk'), { recursive: true });
    await writeFile(join(elsewhere, 'extensions/demo/README.md'), `${marker}\n`);
    await writeFile(join(elsewhere, 'packages/extension-sdk/README.md'), `${marker}\n`);
    const cases = [
      // [what is linked, what the check must name]
      ['extensions', 'extensions: symbolic link refused'],
      ['packages', 'packages/extension-sdk: directory reached through a symbolic link refused'],
      ['packages/extension-sdk', 'packages/extension-sdk: symbolic link refused'],
      ['extensions/demo', 'extensions/demo: symbolic link refused'],
    ];
    for (const [linked, expected] of cases) {
      const root = join(temporary, `repository-${linked.replaceAll('/', '_')}`);
      for (const directory of ['extensions/demo', 'packages/extension-sdk']) {
        if (directory === linked || directory.startsWith(`${linked}/`)) continue;
        await mkdir(join(root, directory), { recursive: true });
      }
      await mkdir(join(root, linked, '..'), { recursive: true });
      await symlink(join(elsewhere, linked), join(root, linked), 'dir');
      const collected = await collect(root);
      const problems = problemsIn(collected);
      assert.ok(problems.some((problem) => problem.startsWith(expected)), `${linked}: ${JSON.stringify(problems)}`);
      assert.ok(![...collected.values()].some((value) => typeof value === 'string' && value.includes(marker)), linked);
      assert.ok(!problems.join('\n').includes(marker), linked);
    }
    // A missing scanned directory is a refusal too, not an empty catalogue.
    const empty = join(temporary, 'repository-empty');
    await mkdir(join(empty, 'extensions'), { recursive: true });
    assert.ok(
      problemsIn(await collect(empty)).includes(
        'packages/extension-sdk: missing directory refused: the check reads regular UTF-8 files inside the repository only',
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
