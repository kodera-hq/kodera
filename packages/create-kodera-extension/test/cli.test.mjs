import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseArgs,
  plan,
  run,
  scaffold,
  validateExtensionSlug,
} from '../src/cli.ts'

test('committed JavaScript runtime matches the TypeScript source', async () => {
  const source = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8')
  const runtime = await readFile(new URL('../runtime/cli.mjs', import.meta.url), 'utf8')
  assert.equal(runtime, stripTypeScriptTypes(source, { mode: 'strip' }).replace(/[\t ]+$/gmu, ''))
})

test('dry-run planning is deterministic and performs zero filesystem writes', async () => {
  const args = parseArgs([
    '--slug',
    'ops-digest',
    '--commands',
    'digest,ack-alert',
    '--widgets',
    'digest-card',
    '--dry-run',
  ])
  const first = await scaffold(args, '/tmp')
  const second = await scaffold(args, '/tmp')
  assert.deepEqual(first, second)
  assert.equal(first.created, false)
  assert.deepEqual(first.scopes, [
    'messages:write',
    'webhooks:incoming',
    'commands:register',
    'widgets:write',
  ])
  assert.deepEqual(first.events, ['command.invoked', 'widget.action'])
})

test('supports boolean --commands and --widgets shorthand flags', () => {
  const options = parseArgs(['--slug', 'build-monitor', '--commands', '--widgets', '--dry-run'])
  const prepared = plan(options, '/tmp')
  assert.deepEqual(prepared.commands, ['build-monitor'])
  assert.deepEqual(prepared.widgets, ['build-monitor-card'])
})

test('refuses path traversal, invalid slugs, secret flags, and non-empty directories', async () => {
  for (const invalidSlug of ['', 'x', 'BadSlug', '-start', 'end-', 'two--dashes', 'under_score']) {
    assert.throws(() => validateExtensionSlug(invalidSlug), /INVALID_SLUG/u)
  }

  for (const badPath of ['../outside', 'sub/../../outside', '.env', 'sub/.env.local']) {
    assert.throws(
      () => plan({ slug: 'valid-slug', 'output-dir': badPath }, '/tmp/workspace'),
      /(?:PATH_TRAVERSAL_REFUSED|SECRET_PATH_REFUSED)/u,
    )
  }

  for (const secretFlag of [
    ['--slug', 'valid-slug', '--secret', 'whsec_test'],
    ['--slug', 'valid-slug', '--signing-secret=whsec_test'],
    ['--slug', 'valid-slug', '--token', 'bearer_xyz'],
    ['--slug', 'valid-slug', '--api-key', 'k_123'],
    ['--slug', 'valid-slug', '--private-key', 'k_priv'],
    ['--slug', 'valid-slug', '--password', 'pw'],
  ]) {
    assert.throws(() => parseArgs(secretFlag), /SECRET_FLAG_REFUSED/u)
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'create-kodera-ext-test-'))
  try {
    const nonEmpty = join(tempRoot, 'existing')
    await mkdir(nonEmpty, { mode: 0o755 })
    await writeFile(join(nonEmpty, 'keep.txt'), 'preserve', 'utf8')
    await assert.rejects(
      () => scaffold({ slug: 'valid-slug', 'output-dir': nonEmpty }, tempRoot),
      /NON_EMPTY_DIRECTORY/u,
    )
    assert.equal(await readFile(join(nonEmpty, 'keep.txt'), 'utf8'), 'preserve')

    const targetDir = join(tempRoot, 'real-dir')
    const symlinkDir = join(tempRoot, 'symlink-dir')
    await mkdir(targetDir, { mode: 0o755 })
    await symlink(targetDir, symlinkDir)
    await assert.rejects(
      () => scaffold({ slug: 'valid-slug', 'output-dir': symlinkDir }, tempRoot),
      /SYMLINK_TARGET_REFUSED/u,
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('emits 0644/0755 UTF-8 starter whose generated handler verifies HMAC and returns a valid widget card', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tmp-ext-'))
  try {
    const outDir = join(tempRoot, 'canary-monitor')
    const created = await scaffold(
      parseArgs([
        '--slug',
        'canary-monitor',
        '--commands',
        'canary',
        '--widgets',
        'canary-status',
        '--output-dir',
        outDir,
      ]),
      tempRoot,
    )
    assert.equal(created.created, true)
    assert.equal((await stat(outDir)).mode & 0o777, 0o755)
    assert.equal((await stat(join(outDir, 'src'))).mode & 0o777, 0o755)
    assert.equal((await stat(join(outDir, 'test'))).mode & 0o777, 0o755)

    for (const file of created.files) {
      const st = await stat(join(outDir, file))
      assert.equal(st.mode & 0o777, 0o644, `expected 0644 on ${file}`)
    }

    const sdk = await import('../../extension-sdk/src/index.mjs')
    const rawManifest = JSON.parse(await readFile(join(outDir, 'kodera-extension.json'), 'utf8'))
    const validated = sdk.validateManifest(rawManifest)
    assert.equal(validated.id, 'canary-monitor')
    assert.ok(validated.scopes.includes('widgets:write'))
    assert.ok(validated.events.includes('widget.action'))

    // Rewrite bare specifier in a temp module check ONLY if node_modules is not yet linked, or import directly when linked
    const entrySource = await readFile(join(outDir, 'src/index.mjs'), 'utf8')
    const sdkUrl = new URL('../../extension-sdk/src/index.mjs', import.meta.url).href
    const resolvedEntryPath = join(outDir, 'src/resolved-index.mjs')
    await writeFile(
      resolvedEntryPath,
      entrySource.replace("'@kodera/extension-sdk'", JSON.stringify(sdkUrl)),
      'utf8',
    )
    const generatedMod = await import(pathToFileURL(resolvedEntryPath).href)
    const secret = 'whsec_generated_starter_0123456789abcdef'
    const handler = generatedMod.createExtensionHandler({ secret })
    const harness = sdk.createExtensionTestHarness({
      secret,
      handler: (req) => handler(req),
    })

    const res = await harness.sendWebhook({
      event: 'widget.action',
      payload: {
        type: 'widget.action',
        data: { widget_id: 'canary-status', action_id: 'acknowledge' },
      },
    })
    assert.equal(res.response.status, 200)
    const card = sdk.validateWidgetCard(res.response.result.widget)
    assert.equal(card.schemaVersion, 'kodera.widget.v1')
    assert.equal(card.widgetId, 'canary-status')
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('run() exits 0 on --help and 1 on refused arguments', async () => {
  assert.equal(await run(['--help']), 0)
  assert.equal(await run(['--secret', 'forbidden']), 1)
})
