import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
// Not a new package in the tree: eslint already installs js-yaml, so this
// declares what is here rather than adding to it. Only its type stubs are
// new, and they ship no code. The install test below reads the workflow as a
// document; grepping the text passes on `npm ci || npm install` and on a
// `npm ci` that only appears inside a comment.
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

// The repo carries tooling and no application code yet, so every other gate in
// CI currently has nothing to chew on. This file is what keeps the pipeline
// honest in the meantime: it asserts the configuration agrees with itself.
//
// Each assertion below stands for a failure that is SILENT — the build stays
// green and the mistake shows up as a wrong colour, a stale runtime, or a
// variable that is simply `undefined` in the browser.

// `import.meta.dirname`, not `new URL(..., import.meta.url)`. Under the jsdom
// environment the URL constructor resolves against the document's base —
// `http://localhost:3000/` — so a relative specifier silently becomes an http
// URL and every read below would point at the wrong place.
const read = (name: string) => readFileSync(join(import.meta.dirname, '..', '..', name), 'utf8')
const readWorkspaceRoot = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', '..', '..', '..', name), 'utf8')

const pkg = JSON.parse(read('package.json')) as {
  name: string
  private: boolean
  engines: { node: string }
  scripts: Record<string, string>
}

describe('package.json', () => {
  it('is private, so it can never be published to a registry by accident', () => {
    expect(pkg.private).toBe(true)
    expect(pkg.name).toBe('@kodera/web')
  })

  it('declares every script CI and the docs invoke', () => {
    // A workflow step calling a script that does not exist fails with npm's own
    // error, which reads like an environment problem rather than a typo.
    const required = [
      'dev',
      'build',
      'build:check',
      'preview',
      'lint',
      'format',
      'format:check',
      'typecheck',
      'test',
      'test:e2e',
      'storybook',
      'build-storybook',
      'api:generate',
    ]
    expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining(required))
  })
})

type NodeToolchain = {
  nvmrc: string
  engine: string
  lockedEngine: string
  runtime: string
  workflow: string
}

// The retained jsdom engine sets the full toolchain floor; the pinned visual
// container uses Node 24 while .nvmrc still selects Node 22 for ordinary CI.
// Check these explicit supported release lines, not arbitrary semver syntax.
function assertNodeToolchain(toolchain: NodeToolchain) {
  expect(toolchain.nvmrc, 'Node selection must remain 22').toBe('22')
  expect(toolchain.engine, 'Node engine must match the supported toolchain releases').toBe(
    '^22.22.2 || ^24.15.0 || >=26.0.0'
  )
  expect(toolchain.lockedEngine, 'Lockfile Node engine must match the manifest').toBe(
    toolchain.engine
  )
  const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(toolchain.runtime)
  const major = Number(version?.[1])
  const minor = Number(version?.[2])
  const patch = Number(version?.[3])
  expect(
    version !== null &&
      ((major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) ||
        (major === 24 && minor >= 15) ||
        major >= 26),
    'Runtime must satisfy the stable Node toolchain release boundaries'
  ).toBe(true)
  expect(toolchain.workflow, 'CI must select Node from .nvmrc').toContain(
    'node-version-file: .nvmrc'
  )
}

const nodeToolchain: NodeToolchain = {
  nvmrc: readWorkspaceRoot('.nvmrc').trim(),
  engine: pkg.engines.node,
  lockedEngine: (
    JSON.parse(readWorkspaceRoot('package-lock.json')) as {
      packages: Record<string, { engines: { node: string } }>
    }
  ).packages['']!.engines.node,
  runtime: process.versions.node,
  workflow: readWorkspaceRoot('.github/workflows/ci-web.yml'),
}

describe('Node version', () => {
  it('declares supported runtimes and keeps Node 22 selected for CI', () => {
    assertNodeToolchain(nodeToolchain)
  })

  it.each(['22.22.2', '22.22.3', '22.23.0', '24.15.0', '24.20.0', '26.0.0', '27.0.0'])(
    'accepts supported Node %s',
    (runtime) => {
      assertNodeToolchain({ ...nodeToolchain, runtime })
    }
  )

  it.each([
    '20.19.0',
    '22.0.0',
    '22.12.0',
    '22.22.1',
    '23.0.0',
    '24.14.9',
    '25.0.0',
    '26.0.0-rc.1',
    'invalid',
  ])('refuses unsupported runtime %s', (runtime) => {
    expect(() => assertNodeToolchain({ ...nodeToolchain, runtime })).toThrow(
      'Runtime must satisfy the stable Node toolchain release boundaries'
    )
  })

  it.each(['>=22', '^22.12.0', '^22.22.2', '>=22.22.2', '^24.15.0'])(
    'refuses incomplete or unsupported engine declaration %s',
    (engine) => {
      expect(() => assertNodeToolchain({ ...nodeToolchain, engine })).toThrow(
        'Node engine must match the supported toolchain releases'
      )
    }
  )

  it('refuses a different selected Node major', () => {
    expect(() => assertNodeToolchain({ ...nodeToolchain, nvmrc: '24' })).toThrow(
      'Node selection must remain 22'
    )
  })

  it('refuses a stale lockfile Node range', () => {
    expect(() => assertNodeToolchain({ ...nodeToolchain, lockedEngine: '>=22' })).toThrow(
      'Lockfile Node engine must match the manifest'
    )
  })

  it('refuses CI that no longer reads the selected runtime', () => {
    expect(() => assertNodeToolchain({ ...nodeToolchain, workflow: 'node-version: 24' })).toThrow(
      'CI must select Node from .nvmrc'
    )
  })
})

// Every npm subcommand that resolves a dependency tree from scratch. `npm i`
// is the alias nobody remembers to look for, and `npm ci || npm install` is the
// fallback wearing a disguise — so the shape is matched, never a whole command.
const RESOLVES_FRESH = /\bnpm\s+(install|i|add)\b/
// The same list plus `ci`: what makes a step an install step at all, whichever
// spelling it uses. `npx playwright install` is deliberately not one of these —
// it fetches a browser, not a package.
// `clean-install` and its aliases are `ci`; `rebuild` runs the install scripts `ci` skipped.
const INSTALLS =
  /\bnpm\s+(ci|install|i|add|clean-install|ic|install-clean|isntall-clean|cit|clean-install-test|rebuild)\b/

type Workflow = { jobs: Record<string, { steps?: { run?: string }[] }> }

describe('installs', () => {
  const workflow = readWorkspaceRoot('.github/workflows/ci-web.yml')

  it('carries a lockfile, and it parses', () => {
    // The fallback this replaces was silent by construction: `npm install`
    // succeeds on a branch with no lockfile, so a run that resolved a whole
    // different dependency tree still went green.
    JSON.parse(readWorkspaceRoot('package-lock.json'))
  })

  // `--ignore-scripts`: no registry dependency runs an install script on the runner, and nothing
  // here needs one (the msw worker is committed, esbuild's binary is an optional dependency).
  // npm still runs a git dependency's own `prepare` when it packs it: `@kodera/design-tokens`
  // has none, ships `dist/` built, and is pinned to one commit by the lockfile.
  it('installs dependencies with `npm ci --ignore-scripts` and nothing else', () => {
    const runs = Object.values((load(workflow) as Workflow).jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run)
      .filter((run): run is string => run !== undefined)
    const installs = runs.filter((run) => INSTALLS.test(run))
    // A workflow that installs nowhere would satisfy the loop below without
    // running it, which is the shape of a guard that has quietly stopped
    // guarding.
    expect(installs.length).toBeGreaterThan(0)
    for (const run of installs) {
      expect(run.trim()).toBe('npm ci --ignore-scripts')
    }
  })

  it('installs the visual renderer the same way', () => {
    expect(read('scripts/visual.sh')).toMatch(/'npm ci --ignore-scripts && npx playwright test /)
  })

  it('links @kodera/design-tokens as a local workspace and locks no git dependency with lifecycle hooks', () => {
    const lock = JSON.parse(readWorkspaceRoot('package-lock.json')) as {
      packages: Record<string, { resolved?: string; link?: boolean }>
    }
    const tokensLink = lock.packages['node_modules/@kodera/design-tokens']
    expect(tokensLink?.link).toBe(true)
    expect(tokensLink?.resolved).toBe('packages/design-tokens')
    const tokenScripts = (
      JSON.parse(readWorkspaceRoot('packages/design-tokens/package.json')) as { scripts?: object }
    ).scripts
    for (const hook of ['prepare', 'prepack', 'postpack', 'preinstall', 'install', 'postinstall']) {
      expect(tokenScripts ?? {}, `@kodera/design-tokens runs \`${hook}\` when installed`).not.toHaveProperty(hook)
    }
    const fromGit = Object.entries(lock.packages)
      .filter(([, entry]) => entry.resolved?.startsWith('git+') === true)
      .map(([path]) => path)
    expect(fromGit).toEqual([])
  })

  it('serves the msw worker of the installed msw', () => {
    // Without the install script, nothing rewrites `msw/mockServiceWorker.js` when msw is bumped;
    // a stale worker only warns at runtime, so the bump has to fail here instead.
    expect(read('msw/mockServiceWorker.js')).toBe(
      readFileSync(createRequire(import.meta.url).resolve('msw/mockServiceWorker.js'), 'utf8')
    )
  })

  it('has no step that resolves a fresh tree', () => {
    // Comments stripped first: this workflow explains at length why it does not
    // use `npm install`, and a rule its own rationale trips is a rule someone
    // deletes rather than obeys.
    expect(workflow.replace(/^\s*#.*$/gm, '')).not.toMatch(RESOLVES_FRESH)
  })
})

describe('design tokens', () => {
  it('the Tailwind config declares no colour of its own', () => {
    // ADR-0004: `@kodera/design-tokens` is the single source of truth, shared
    // with kodera-web. A palette re-declared here would drift from the hub's
    // without anything failing. This test is what makes the rule enforceable
    // before the package exists; it is replaced by the token-resolution test
    // when the preset lands.
    const config = read('tailwind.config.ts')
    const withoutComments = config.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(withoutComments).not.toMatch(/\bcolors\s*:/)
  })
})

describe('.env.example', () => {
  it('documents both public variables the console reads', () => {
    // A misspelt VITE_ name is `undefined` at runtime, not an error.
    const env = read('.env.example')
    for (const name of [
      'VITE_CORE_API_URL',
      'VITE_KEYCLOAK_URL',
      'VITE_ENABLE_MSW',
      'VITE_AUTH_MODE',
      'VITE_OIDC_CLIENT_ID',
      'VITE_MATRIX_DOMAIN',
      'VITE_TENANT_DOMAIN',
      'VITE_ESPACE_DEV_HOMESERVER',
      'VITE_ESPACE_DEV_SERVER_NAME',
      'VITE_MOCK_UNSERVED',
    ]) {
      expect(env).toMatch(new RegExp(`^${name}=`, 'm'))
    }
  })

  it('carries no value that looks like a secret', () => {
    expect(read('.env.example')).not.toMatch(/(secret|token|password|api[_-]?key)\s*=\s*\S+/i)
  })
})

describe('.gitignore', () => {
  it('ignores every env file but keeps the documented example', () => {
    const ignored = read('.gitignore')
    expect(ignored).toMatch(/^\.env\.\*$/m)
    // Order matters: the negation has to come AFTER the pattern it undoes, or
    // .env.example is silently untracked and nobody notices until a fresh clone.
    expect(ignored.indexOf('!.env.example')).toBeGreaterThan(ignored.indexOf('.env.*'))
  })
})
