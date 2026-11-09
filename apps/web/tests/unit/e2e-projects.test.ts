// @vitest-environment node
//
// The end-to-end suite runs twice, on a light device and on a dark one (`playwright.config.ts`,
// docs/specs/10-appearance.md §10): « Automatique » gives a dark device the dark theme, so the
// second pass is every flow's and every axe check's dark run. Losing that pass is SILENT — the
// e2e job stays green with half the tests — so this file makes each way of losing it fail here,
// in the unit job, by name:
//   * the dark project deleted, renamed, or its device turned light;
//   * a spec statically excluded from one project only;
//   * a filter in `npm run test:e2e`, or in the CI step that calls it.
// Acceptance test 9 (`appearance/suite`) checks the other half: that each project's pages really
// wear its device's theme.
//
// The `journey` project is set aside: it runs `tests/e2e/journey/` against its own build with the
// first-owner journey turned on (docs/specs/09-owner-claim.md), once, on a light device.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import config from '../../playwright.config'

const ROOT = join(import.meta.dirname, '..', '..')
const read = (name: string) => readFileSync(join(ROOT, name), 'utf8')

/** Flags that narrow what `playwright test` runs. `--shard` is not one: shards still cover it all. */
const FILTERS = /(^|\s)(--project|--grep|--grep-invert|-g|--only-changed|--last-failed)(=|\s|$)/

interface ListedSuite {
  title: string
  specs?: { title: string; tests: { projectName: string; expectedStatus: string }[] }[]
  suites?: ListedSuite[]
}

type Projects = typeof config.projects
interface Workflow {
  jobs: Record<string, { steps?: { run?: string }[] }>
}

const JOURNEY = 'journey'

function checkProjects(projects: Projects) {
  const schemes = Object.fromEntries(
    (projects ?? [])
      .filter((project) => project.name !== JOURNEY)
      .map((project) => [project.name, project.use?.colorScheme])
  )
  expect(schemes, 'declare exactly one light and one dark device').toEqual({
    chromium: 'light',
    'chromium-dark': 'dark',
  })
}

function checkListing(suites: ListedSuite[]) {
  const byProject = new Map<string, Set<string>>()
  const walk = (suite: ListedSuite, path: string[]) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        if (test.expectedStatus === 'skipped' || test.projectName === JOURNEY) continue
        const ids = byProject.get(test.projectName) ?? new Set<string>()
        ids.add([...path, spec.title].join(' › '))
        byProject.set(test.projectName, ids)
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...path, child.title])
  }
  for (const suite of suites) walk(suite, [suite.title])
  expect([...byProject.keys()].sort(), 'list both projects').toEqual(['chromium', 'chromium-dark'])
  const light = [...(byProject.get('chromium') ?? [])].sort()
  const dark = [...(byProject.get('chromium-dark') ?? [])].sort()
  expect(light.length, 'list at least one test').toBeGreaterThan(0)
  expect(dark, 'the dark project runs exactly the light project’s tests').toEqual(light)
}

function checkCommands(command: string | undefined, workflow: Workflow) {
  expect(command, 'the npm command runs the whole suite').toBe('playwright test')
  const runs = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => (typeof step.run === 'string' ? [step.run] : []))
  )
  // Visual tests name their own config and intentionally use one project.
  const e2e = runs.filter(
    (run) =>
      /\bnpm run test:e2e\b/.test(run) ||
      (/\bplaywright test\b/.test(run) && !/(\s-c|\s--config)(=|\s)/.test(run))
  )
  expect(
    e2e.some((run) => /\bnpm run test:e2e\b/.test(run)),
    'CI calls the suite'
  ).toBe(true)
  for (const run of e2e) expect(run, 'a CI step narrows the end-to-end suite').not.toMatch(FILTERS)
}

describe('the end-to-end suite', () => {
  it('is declared on a light device and on a dark device', () => checkProjects(config.projects))

  it('lists every test under both projects, skipped in neither', () => {
    const run = spawnSync('npx', ['playwright', 'test', '--list', '--reporter=json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    expect(run.status, run.stderr).toBe(0)
    const report = JSON.parse(run.stdout) as { suites: ListedSuite[] }
    checkListing(report.suites)
    const journey = JSON.stringify(report.suites).match(/"projectName":"journey"/g) ?? []
    expect(journey.length, 'the journey project lists its own tests').toBeGreaterThan(0)
  }, 60_000)

  it('declares the journey project apart, on a light device', () => {
    const journey = (config.projects ?? []).find((project) => project.name === JOURNEY)
    expect(journey?.use?.colorScheme).toBe('light')
    expect(journey?.use?.baseURL).not.toBe(config.use?.baseURL)
  })

  it('runs whole in CI: `test:e2e` carries no filter, and neither does the step calling it', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    checkCommands(
      pkg.scripts['test:e2e'],
      load(read('../../.github/workflows/ci-web.yml')) as Workflow
    )
  })
})

// Permanent negative fixtures exercise the very assertions used above, without mutating the
// shared checkout. Runtime conditional skips are not visible to Playwright's static listing.
describe('the suite guard refuses broken inputs', () => {
  const projects: Projects = [
    { name: 'chromium', use: { colorScheme: 'light' } },
    { name: 'chromium-dark', use: { colorScheme: 'dark' } },
  ]
  const workflow = (run = 'npm run test:e2e'): Workflow => ({ jobs: { e2e: { steps: [{ run }] } } })
  const listing = (): ListedSuite[] => [
    {
      title: 'example.spec.ts',
      specs: ['first', 'second'].map((title) => ({
        title,
        tests: ['chromium', 'chromium-dark'].map((projectName) => ({
          projectName,
          expectedStatus: 'passed',
        })),
      })),
    },
  ]

  it('accepts the unmodified controls', () => {
    checkProjects(projects)
    checkListing(listing())
    checkCommands('playwright test', workflow())
  })
  it('names a missing dark project', () => {
    expect(() => checkProjects(projects.slice(0, 1))).toThrow(
      'declare exactly one light and one dark device'
    )
  })
  it('names a dark project turned light', () => {
    const changed = structuredClone(projects)
    changed[1]!.use = { colorScheme: 'light' }
    expect(() => checkProjects(changed)).toThrow('declare exactly one light and one dark device')
  })
  it.each(['missing', 'skipped'])('names a test %s from the dark listing', (mode) => {
    const changed = listing()
    const tests = changed[0]!.specs![0]!.tests
    if (mode === 'missing') tests.pop()
    else tests[1]!.expectedStatus = 'skipped'
    expect(() => checkListing(changed)).toThrow(
      'the dark project runs exactly the light project’s tests'
    )
  })
  it('names a filtered npm command', () => {
    expect(() => checkCommands('playwright test --project=chromium', workflow())).toThrow(
      'the npm command runs the whole suite'
    )
  })
  it('names a filtered workflow command', () => {
    expect(() =>
      checkCommands('playwright test', workflow('npm run test:e2e -- --project=chromium'))
    ).toThrow('a CI step narrows the end-to-end suite')
  })
})
