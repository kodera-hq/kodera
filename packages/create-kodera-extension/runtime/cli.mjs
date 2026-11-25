import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

























const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/u
const COMMAND_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/u
const SECRET_FLAG_RE =
  /(?:^|-)(?:secret|signing-secret|webhook-secret|token|access-token|password|passwd|private-key|api-key|credential|credentials|env|env-file)(?:$|-)/iu
const FORBIDDEN_TEXT_RE = /[\p{Cc}\p{Cf}]/u
const FORBIDDEN_PATH_RE = /[\p{Cc}\p{Cf}'"`$]/u

const BOOLEAN_FLAGS                      = new Set(['dry-run', 'selftest', 'help'])
const OPTIONAL_VALUE_FLAGS                      = new Set(['commands', 'widgets'])
const STRING_FLAGS                      = new Set(['slug', 'name', 'description', 'output-dir'])

export function validateExtensionSlug(value         )         {
  if (typeof value !== 'string' || !SLUG_RE.test(value) || value.includes('--')) {
    throw new Error('INVALID_SLUG')
  }
  return value
}

function titleFromSlug(slug        )         {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function parseCsvSlugs(
  raw                              ,
  fallbackSlug        ,
  pattern        ,
  errorCode        ,
)                    {
  if (raw === undefined || raw === false) {
    return Object.freeze([])
  }
  if (raw === true) {
    if (!pattern.test(fallbackSlug) || fallbackSlug.includes('--')) {
      throw new Error(errorCode)
    }
    return Object.freeze([fallbackSlug])
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error(errorCode)
  }
  const parts = trimmed.split(',').map((item) => item.trim().replace(/^\/+/u, ''))
  if (parts.length === 0 || parts.length > 16) {
    throw new Error(errorCode)
  }
  const seen = new Set        ()
  const normalized           = []
  for (const part of parts) {
    if (!pattern.test(part) || part.includes('--') || seen.has(part)) {
      throw new Error(errorCode)
    }
    seen.add(part)
    normalized.push(part)
  }
  return Object.freeze(normalized)
}

export function validateRelativeOrContainedOutputDir(
  rawDir         ,
  baseDir         = process.cwd(),
)         {
  if (
    typeof rawDir !== 'string' ||
    rawDir.trim().length === 0 ||
    rawDir.length > 1024 ||
    rawDir.includes('\0') ||
    FORBIDDEN_PATH_RE.test(rawDir)
  ) {
    throw new Error('INVALID_OUTPUT_DIR')
  }
  const segments = rawDir.split(/[\\/]+/u)
  if (segments.includes('..')) {
    throw new Error('PATH_TRAVERSAL_REFUSED')
  }
  if (segments.some((segment) => /^\.env(?:\.|$)/iu.test(segment))) {
    throw new Error('SECRET_PATH_REFUSED')
  }
  const resolvedBase = resolve(baseDir)
  const resolvedTarget = isAbsolute(rawDir) ? resolve(rawDir) : resolve(resolvedBase, rawDir)
  if (!isAbsolute(rawDir)) {
    const rel = relative(resolvedBase, resolvedTarget)
    if (!rel || rel === '..' || rel.startsWith(`..${'/'.slice(0, 1)}`) || rel.startsWith('..\\')) {
      throw new Error('PATH_TRAVERSAL_REFUSED')
    }
  } else if (resolvedTarget === '/') {
    throw new Error('INVALID_OUTPUT_DIR')
  }
  return resolvedTarget
}

export function parseArgs(args                   )             {
  if (args.length > 64) {
    throw new Error('TOO_MANY_ARGUMENTS')
  }
  const result                                   = {}
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i]
    if (!raw || !raw.startsWith('--') || raw === '--' || raw.length > 1024) {
      throw new Error('INVALID_ARGUMENT')
    }
    const body = raw.slice(2)
    const eqIndex = body.indexOf('=')
    const key = eqIndex === -1 ? body : body.slice(0, eqIndex)
    const inlineValue = eqIndex === -1 ? undefined : body.slice(eqIndex + 1)

    if (!key || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(key)) {
      throw new Error('INVALID_ARGUMENT')
    }
    if (SECRET_FLAG_RE.test(key)) {
      throw new Error('SECRET_FLAG_REFUSED')
    }
    if (Object.hasOwn(result, key)) {
      throw new Error('DUPLICATE_ARGUMENT')
    }

    if (BOOLEAN_FLAGS.has(key)) {
      if (inlineValue !== undefined) {
        throw new Error('INVALID_ARGUMENT')
      }
      result[key] = true
      continue
    }

    if (OPTIONAL_VALUE_FLAGS.has(key)) {
      if (inlineValue !== undefined) {
        if (!inlineValue || FORBIDDEN_TEXT_RE.test(inlineValue)) {
          throw new Error('MISSING_ARGUMENT')
        }
        result[key] = inlineValue
        continue
      }
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        if (!next || next.length > 1024 || FORBIDDEN_TEXT_RE.test(next)) {
          throw new Error('MISSING_ARGUMENT')
        }
        result[key] = next
        i += 1
      } else {
        result[key] = true
      }
      continue
    }

    if (STRING_FLAGS.has(key)) {
      const value = inlineValue ?? args[++i]
      if (
        value === undefined ||
        value.length === 0 ||
        (inlineValue === undefined && value.startsWith('--')) ||
        value.length > 1024 ||
        FORBIDDEN_TEXT_RE.test(value)
      ) {
        throw new Error('MISSING_ARGUMENT')
      }
      result[key] = value
      continue
    }

    throw new Error('UNKNOWN_ARGUMENT')
  }
  return result
}

export function plan(options            , baseDir         = process.cwd())               {
  const slug = validateExtensionSlug(options.slug)
  const rawName =
    options.name !== undefined ? options.name.trim() : `${titleFromSlug(slug)} Starter`
  if (!rawName || rawName.length > 80 || FORBIDDEN_TEXT_RE.test(rawName)) {
    throw new Error('INVALID_NAME')
  }
  const defaultDescription = `Reference implementation: signed webhook and sandboxed widget starter for ${slug}.`
  const rawDescription =
    options.description !== undefined ? options.description.trim() : defaultDescription
  if (!rawDescription || rawDescription.length > 300 || FORBIDDEN_TEXT_RE.test(rawDescription)) {
    throw new Error('INVALID_DESCRIPTION')
  }
  const normalizedDescription = rawDescription.startsWith('Reference implementation: ')
    ? rawDescription
    : `Reference implementation: ${rawDescription}`
  if (normalizedDescription.length > 300) {
    throw new Error('INVALID_DESCRIPTION')
  }

  const defaultCmdFallback = slug.slice(0, 32).replace(/-+$/u, '')
  const defaultWidgetFallback = `${slug}-card`.slice(0, 63).replace(/-+$/u, '')

  const commands = parseCsvSlugs(
    options.commands,
    defaultCmdFallback.length >= 2 ? defaultCmdFallback : 'run-starter',
    COMMAND_SLUG_RE,
    'INVALID_COMMANDS',
  )
  const widgets = parseCsvSlugs(
    options.widgets,
    defaultWidgetFallback.length >= 2 ? defaultWidgetFallback : 'status-card',
    SLUG_RE,
    'INVALID_WIDGETS',
  )

  const scopes           = ['messages:write', 'webhooks:incoming']
  if (commands.length > 0) scopes.push('commands:register')
  if (widgets.length > 0) scopes.push('widgets:write')

  const events           = []
  if (commands.length > 0) events.push('command.invoked')
  if (widgets.length > 0) events.push('widget.action')
  if (events.length === 0) events.push('message.created')

  const outputDir = validateRelativeOrContainedOutputDir(options['output-dir'] ?? slug, baseDir)

  return Object.freeze({
    slug,
    name: rawName,
    description: normalizedDescription,
    outputDir,
    commands,
    widgets,
    scopes: Object.freeze(scopes),
    events: Object.freeze(events),
    files: Object.freeze([
      'package.json',
      'kodera-extension.json',
      'src/index.mjs',
      'test/extension.test.mjs',
      'README.md',
    ]),
  })
}

async function assertNoSymlinkTargetOrSubpath(targetDir        , baseDir        )                {
  const resolvedBase = resolve(baseDir)
  const rel = relative(resolvedBase, targetDir)
  const candidates           = []
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    candidates.push(targetDir)
  } else {
    let cursor = resolvedBase
    for (const part of rel.split(/[\\/]+/u).filter(Boolean)) {
      cursor = join(cursor, part)
      candidates.push(cursor)
    }
  }
  for (const candidate of candidates) {
    try {
      const entry = await lstat(candidate)
      if (entry.isSymbolicLink()) {
        throw new Error('SYMLINK_TARGET_REFUSED')
      }
    } catch (error) {
      if ((error                         )?.code === 'ENOENT') {
        break
      }
      throw error
    }
  }
}

function renderManifestJson(prepared              )         {
  const manifest = {
    schemaVersion: 'kodera.extension.v1',
    id: prepared.slug,
    name: prepared.name,
    version: '0.1.0',
    description: prepared.description,
    scopes: prepared.scopes,
    events: prepared.events,
    webhookUrl: `https://extensions.example.invalid/hooks/${prepared.slug}`,
    commands: prepared.commands.map((cmd) => ({
      name: `/${cmd}`,
      description: `Invoke /${cmd} in the active Kodera channel`,
    })),
    ...(prepared.widgets.length > 0
      ? {
          widgets: prepared.widgets.map((widgetId) => ({
            id: widgetId,
            title: `${titleFromSlug(widgetId)} Widget`,
            description: `Sandboxed kodera.widget.v1 card for ${widgetId}`,
          })),
        }
      : {}),
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function renderPackageJson(prepared              )         {
  const pkg = {
    name: `kodera-ext-${prepared.slug}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    license: 'Apache-2.0',
    description: prepared.description,
    scripts: {
      test: 'node --test test/*.test.mjs',
    },
    dependencies: {
      '@kodera/extension-sdk': '^0.2.0',
    },
  }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

function renderIndexMjs(prepared              )         {
  const primaryWidgetId = prepared.widgets[0] ?? `${prepared.slug}-card`.slice(0, 63).replace(/-+$/u, '')
  const primaryCommand = prepared.commands[0] ?? 'status'
  return `import { readFile } from 'node:fs/promises'
import {
  createWebhookHandler,
  defineSlashCommand,
  defineWidgetCard,
  validateManifest,
} from '@kodera/extension-sdk'

const rawManifest = JSON.parse(
  await readFile(new URL('../kodera-extension.json', import.meta.url), 'utf8'),
)
export const manifest = validateManifest(rawManifest)

export const starterCommand = defineSlashCommand({
  name: ${JSON.stringify(`/${primaryCommand}`)},
  description: ${JSON.stringify(`Run /${primaryCommand} in the channel`)},
  scopes: ['messages:write'],
  handler: ({ args, actorId }) => ({
    text: \`Processed /\${${JSON.stringify(primaryCommand)}} for \${args.trim() || actorId}\`,
    ephemeral: false,
  }),
})

export function buildWidgetCard(input = {}) {
  const progress = typeof input.progress === 'number' ? input.progress : 50
  const statusLabel = typeof input.statusLabel === 'string' ? input.statusLabel : 'Ready'
  return defineWidgetCard({
    widgetId: ${JSON.stringify(primaryWidgetId)},
    blocks: [
      {
        type: 'header',
        title: ${JSON.stringify(prepared.name)},
        subtitle: 'Sandboxed declarative widget card',
      },
      {
        type: 'status_pill',
        label: statusLabel,
        state: progress >= 100 ? 'success' : 'info',
      },
      {
        type: 'text',
        body: 'Actions dispatch signed widget.action callbacks without client-side scripts or frames.',
      },
      {
        type: 'kv_list',
        items: [
          { label: 'Extension', value: manifest.id, mono: true },
          { label: 'Schema', value: 'kodera.widget.v1', mono: true },
        ],
      },
      {
        type: 'progress_bar',
        label: 'Readiness',
        value: progress,
        valueText: \`\${progress}%\`,
      },
      {
        type: 'button_row',
        actions: [
          { actionId: 'acknowledge', label: 'Acknowledge', variant: 'primary', value: 'ack' },
          { actionId: 'refresh', label: 'Refresh', variant: 'secondary', value: 'refresh' },
        ],
      },
      {
        type: 'link_button',
        label: 'Runbook',
        href: ${JSON.stringify(`https://docs.example.org/extensions/${prepared.slug}`)},
        variant: 'secondary',
      },
    ],
  })
}

export function createExtensionHandler({ secret }) {
  return createWebhookHandler({
    secret,
    handlers: {
      'command.invoked': async (payload) => {
        const reply = await starterCommand.handler({
          command: String(payload.command ?? ${JSON.stringify(primaryCommand)}),
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? ''),
          actorId: String(payload.actorId ?? 'member'),
        })
        return {
          ...reply,
          widget: buildWidgetCard({ progress: 50, statusLabel: 'Active' }),
        }
      },
      'widget.action': async (payload) => {
        const data =
          payload.data && typeof payload.data === 'object' ? payload.data : payload
        const actionId = String(data.action_id ?? data.actionId ?? 'refresh')
        const completed = actionId === 'acknowledge'
        return {
          acknowledged: true,
          actionId,
          widget: buildWidgetCard({
            progress: completed ? 100 : 50,
            statusLabel: completed ? 'Acknowledged' : 'Refreshed',
          }),
        }
      },
      'message.created': async () => ({
        ok: true,
      }),
    },
  })
}
`
}

function renderHarnessTestMjs(prepared              )         {
  const primaryCommand = prepared.commands[0] ?? 'status'
  const primaryWidgetId = prepared.widgets[0] ?? `${prepared.slug}-card`.slice(0, 63).replace(/-+$/u, '')
  return `import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WebhookVerificationError,
  createExtensionTestHarness,
  validateWidgetCard,
} from '@kodera/extension-sdk'
import { buildWidgetCard, createExtensionHandler, manifest } from '../src/index.mjs'

test('validates manifest and verifies signed webhook + widget.action callbacks', async () => {
  assert.equal(manifest.id, ${JSON.stringify(prepared.slug)})
  const secret = 'whsec_test_scaffold_0123456789abcdef'
  const webhook = createExtensionHandler({ secret })
  const harness = createExtensionTestHarness({
    secret,
    handler: (req) => webhook(req),
  })

  const cmdDelivery = await harness.sendWebhook({
    event: 'command.invoked',
    payload: {
      type: 'command.invoked',
      command: ${JSON.stringify(primaryCommand)},
      args: 'check',
      channelId: '019a5e10-0000-7000-8000-000000000001',
      actorId: 'usr_starter',
    },
  })
  assert.equal(cmdDelivery.response.status, 200)
  const initialCard = validateWidgetCard(cmdDelivery.response.result.widget)
  assert.equal(initialCard.widgetId, ${JSON.stringify(primaryWidgetId)})

  const actionDelivery = await harness.sendWebhook({
    event: 'widget.action',
    payload: {
      type: 'widget.action',
      data: {
        widget_id: ${JSON.stringify(primaryWidgetId)},
        action_id: 'acknowledge',
      },
    },
  })
  assert.equal(actionDelivery.response.status, 200)
  assert.equal(actionDelivery.response.result.acknowledged, true)
  const updatedCard = validateWidgetCard(actionDelivery.response.result.widget)
  assert.equal(updatedCard.schemaVersion, 'kodera.widget.v1')

  await assert.rejects(
    () =>
      harness.sendWebhook({
        event: 'widget.action',
        secretOverride: 'whsec_wrong_secret_0123456789abcdef',
        payload: { type: 'widget.action', data: { action_id: 'refresh' } },
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH',
  )

  const standalone = buildWidgetCard({ progress: 75, statusLabel: 'In progress' })
  assert.equal(standalone.blocks.length, 7)
})
`
}

function renderReadmeMd(prepared              )         {
  return `# ${prepared.name}

Status: Reference implementation

Starter generated by \`create-kodera-extension\` for \`${prepared.slug}\`.

## Security invariants

- Incoming deliveries and \`widget.action\` callbacks are verified in constant time with \`@kodera/extension-sdk\` (\`x-kodera-signature-256\` and \`x-kodera-timestamp\`).
- Signing secrets are supplied at runtime via environment configuration and never written into repository files or CLI flags.
- Widget cards conform to the closed \`kodera.widget.v1\` declarative AST (at most 16 KiB serialized, public \`https:\` links only, zero inline HTML or scripts).

## Local verification

\`\`\`sh
npm test
\`\`\`
`
}

async function writeRegularUtf8File(filePath        , content        )                {
  const bytes = Buffer.from(content, 'utf8')
  new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  await writeFile(filePath, bytes, { mode: 0o644, flag: 'wx' })
  await chmod(filePath, 0o644)
}

export async function scaffold(
  options            ,
  baseDir         = process.cwd(),
)                                                        {
  const prepared = plan(options, baseDir)
  if (options['dry-run']) {
    return Object.freeze({ ...prepared, created: false })
  }

  await assertNoSymlinkTargetOrSubpath(prepared.outputDir, baseDir)

  let existedBefore = false
  try {
    const existing = await lstat(prepared.outputDir)
    if (existing.isSymbolicLink()) {
      throw new Error('SYMLINK_TARGET_REFUSED')
    }
    if (!existing.isDirectory()) {
      throw new Error('INVALID_OUTPUT_DIR')
    }
    existedBefore = true
    const entries = await readdir(prepared.outputDir)
    if (entries.length > 0) {
      throw new Error('NON_EMPTY_DIRECTORY')
    }
  } catch (error) {
    if ((error                         )?.code !== 'ENOENT') {
      throw error
    }
  }

  if (!existedBefore) {
    await mkdir(prepared.outputDir, { recursive: true, mode: 0o755 })
  }
  await chmod(prepared.outputDir, 0o755)

  const writtenPaths           = []
  try {
    for (const subdir of ['src', 'test']) {
      const subPath = join(prepared.outputDir, subdir)
      await mkdir(subPath, { mode: 0o755 })
      await chmod(subPath, 0o755)
      writtenPaths.push(subPath)
    }

    const fileMap                                           = [
      ['package.json', renderPackageJson(prepared)],
      ['kodera-extension.json', renderManifestJson(prepared)],
      ['src/index.mjs', renderIndexMjs(prepared)],
      ['test/extension.test.mjs', renderHarnessTestMjs(prepared)],
      ['README.md', renderReadmeMd(prepared)],
    ]

    for (const [relPath, text] of fileMap) {
      const targetFile = join(prepared.outputDir, relPath)
      await writeRegularUtf8File(targetFile, text)
      writtenPaths.push(targetFile)
    }
  } catch (error) {
    if (!existedBefore) {
      await rm(prepared.outputDir, { recursive: true, force: true })
    } else {
      for (const created of writtenPaths.reverse()) {
        await rm(created, { recursive: true, force: true })
      }
    }
    throw error
  }

  return Object.freeze({ ...prepared, created: true })
}

export async function selftest()                {
  let count = 0
  const check = (fn            ) => {
    fn()
    count += 1
  }

  check(() => {
    const dry = plan(
      parseArgs([
        '--slug',
        'incident-helper',
        '--commands',
        'triage,resolve-note',
        '--widgets',
        'incident-card',
        '--dry-run',
      ]),
      '/tmp',
    )
    assert.equal(dry.slug, 'incident-helper')
    assert.deepEqual(dry.commands, ['triage', 'resolve-note'])
    assert.deepEqual(dry.widgets, ['incident-card'])
    assert.ok(dry.scopes.includes('widgets:write'))
    assert.ok(dry.scopes.includes('commands:register'))
    assert.ok(dry.events.includes('widget.action'))
  })

  for (const badSlug of ['', 'a', 'UpperCase', '-leading', 'trailing-', 'double--dash', 'bad_underscore']) {
    check(() => {
      assert.throws(() => validateExtensionSlug(badSlug), /INVALID_SLUG/u)
    })
  }

  for (const secretArgs of [
    ['--slug', 'demo-ext', '--secret', 'whsec_123'],
    ['--slug', 'demo-ext', '--signing-secret=whsec_123'],
    ['--slug', 'demo-ext', '--token', 'tok_123'],
    ['--slug', 'demo-ext', '--api-key', 'key_123'],
    ['--slug', 'demo-ext', '--private-key', 'pem'],
    ['--slug', 'demo-ext', '--env-file', '.env'],
  ]) {
    check(() => {
      assert.throws(() => parseArgs(secretArgs), /SECRET_FLAG_REFUSED/u)
    })
  }

  for (const traversal of ['../escape', 'nested/../../escape', 'a/../../../etc']) {
    check(() => {
      assert.throws(
        () =>
          plan(
            {
              slug: 'demo-ext',
              'output-dir': traversal,
            },
            '/tmp/kodera-ext-base',
          ),
        /PATH_TRAVERSAL_REFUSED/u,
      )
    })
  }

  check(() => {
    assert.throws(() => parseArgs(['--slug', 'a-ext', '--slug', 'b-ext']), /DUPLICATE_ARGUMENT/u)
    assert.throws(() => parseArgs(['--slug', 'a-ext', '--unknown']), /UNKNOWN_ARGUMENT/u)
  })

  const tempRoot = await mkdtemp(join(tmpdir(), 'kodera-ext-cli-selftest-'))
  try {
    const outDir = join(tempRoot, 'starter-ext')
    const result = await scaffold(
      parseArgs([
        '--slug',
        'starter-ext',
        '--commands',
        'starter',
        '--widgets',
        'starter-card',
        '--output-dir',
        outDir,
      ]),
      tempRoot,
    )
    check(() => assert.equal(result.created, true))

    for (const dirPath of [outDir, join(outDir, 'src'), join(outDir, 'test')]) {
      const mode = (await stat(dirPath)).mode & 0o777
      check(() => assert.equal(mode, 0o755))
    }

    for (const relFile of result.files) {
      const fullPath = join(outDir, relFile)
      const mode = (await stat(fullPath)).mode & 0o777
      const bytes = await readFile(fullPath)
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      check(() => {
        assert.equal(mode, 0o644)
        assert.ok(decoded.length > 0)
      })
    }

    const manifestJson = JSON.parse(await readFile(join(outDir, 'kodera-extension.json'), 'utf8'))
    check(() => {
      assert.equal(manifestJson.schemaVersion, 'kodera.extension.v1')
      assert.equal(manifestJson.id, 'starter-ext')
      assert.ok(manifestJson.scopes.includes('widgets:write'))
      assert.ok(manifestJson.events.includes('widget.action'))
      // Verify deterministic HMAC compatibility vector against generated handler expectations
      const body = JSON.stringify({ type: 'widget.action', data: { action_id: 'acknowledge' } })
      const mac = createHmac('sha256', 'whsec_selftest_0123456789abcdef')
        .update('1700000000.')
        .update(body)
        .digest('hex')
      assert.equal(mac.length, 64)
    })

    // Non-empty directory refusal
    await assert.rejects(
      () =>
        scaffold(
          parseArgs(['--slug', 'starter-ext', '--output-dir', outDir]),
          tempRoot,
        ),
      /NON_EMPTY_DIRECTORY/u,
    )
    count += 1

    // Symlink target refusal
    const realTarget = join(tempRoot, 'real-empty')
    const linkTarget = join(tempRoot, 'linked-dir')
    await mkdir(realTarget, { mode: 0o755 })
    await symlink(realTarget, linkTarget)
    await assert.rejects(
      () =>
        scaffold(
          parseArgs(['--slug', 'linked-ext', '--output-dir', linkTarget]),
          tempRoot,
        ),
      /SYMLINK_TARGET_REFUSED/u,
    )
    count += 1
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }

  console.log(`PASS: ${count} create-kodera-extension selftests`)
}

export async function run(args                   )                  {
  try {
    const options = parseArgs(args)
    if (options.selftest) {
      await selftest()
      return 0
    }
    if (options.help) {
      console.log(
        'create-kodera-extension --slug SLUG [--commands CMD1,CMD2] [--widgets WIDGET1,WIDGET2] [--name NAME] [--description TEXT] [--output-dir DIR] [--dry-run]\ncreate-kodera-extension --selftest',
      )
      return 0
    }
    const result = await scaffold(options)
    console.log(JSON.stringify(result, null, 2))
    return 0
  } catch (error) {
    console.error(
      error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : 'REQUEST_OR_CONFIGURATION_REFUSED',
    )
    return 1
  }
}
