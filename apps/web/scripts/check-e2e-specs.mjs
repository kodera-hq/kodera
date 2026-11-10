// Fail the end-to-end job when Playwright would run nothing.
//
// The step this replaces asked the shell whether `tests/e2e/*.spec.ts` matched
// anything and skipped the suite when it did not. Two things were wrong with
// that, and only the first is obvious.
//
//   1. A skipped suite ended the job `success`. `ci-ok` needs this job, and
//      `ci-ok` is the context branch protection requires, so "ran zero specs"
//      and "ran ninety-five specs, all green" unblocked the merge button
//      identically.
//
//   2. The glob was not Playwright's. Playwright resolves `testDir` and matches
//      recursively; the glob matched the top level only. Measured here: a spec
//      at `tests/e2e/nested/probe.spec.ts` is listed by Playwright -- 96 tests
//      in 12 files against this tree's usual 95 in 11 -- while the glob reports
//      no match at all.
//
// So this asks Playwright itself. There is one discovery implementation now,
// and it is the one that runs the tests. `--list` starts no `webServer` and
// needs no browser binary: measured at about two seconds, port 4173 never
// bound, and still correct with the browser path pointed at an empty directory.
//
// WHY THE ERROR PARTITION LOOKS LIKE THIS. Three drafts of this check reported
// a broken suite as an empty one, which is the single most expensive way for it
// to be wrong: it tells the reader to consider deleting the job.
//
//   draft 1 branched on the exit code -- Playwright exits non-zero on an empty
//           suite too, so every empty suite was called broken;
//   draft 2 branched on the "Total: 0 tests in 0 files" line, believed absent
//           from a broken suite. It is present. That belief came from output
//           truncated by `tail`;
//   draft 3 branched on whether an error carried a `location`. A *parse* error
//           does. A module-resolution failure does NOT: an import of a helper
//           that no longer exists yields two errors, `Cannot find module ...`
//           and `No tests found`, neither with a location. So the commonest
//           real breakage of all was reported as an empty suite.
//
// What actually separates them is which error it is, not what it carries. The
// empty case produces exactly one error and it is "No tests found". Anything
// else present alongside it is a load failure. That is the partition below, and
// every diagnostic is printed in both branches rather than discarded.
//
// A test Playwright lists but will not execute is the same failure through a
// different door, so skipped tests are excluded from the count.

import { spawnSync } from 'node:child_process'

// npm may relocate execution to the workspace root; retain the caller's suite.
const run = spawnSync(
  'npx',
  ['playwright', 'test', '--config', process.cwd(), '--list', '--reporter=json'],
  {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }
)

const rawOutput = [run.stdout, run.stderr].filter(Boolean).join('\n')

function refuse(message, detail) {
  if (detail) process.stderr.write(`${detail}\n`)
  process.stderr.write(`check-e2e-specs: ${message}\n`)
  process.exit(1)
}

if (run.error) {
  refuse(
    `could not run Playwright at all (${run.error.message}). This job cannot claim to have run a suite it never listed.`
  )
}

let report
try {
  report = JSON.parse(run.stdout)
} catch {
  refuse(
    'Playwright produced no readable JSON listing, so the number of tests cannot be established. Refusing rather than assuming the suite is fine.',
    rawOutput.slice(0, 4000)
  )
}

if (report === null || typeof report !== 'object' || Array.isArray(report)) {
  refuse(
    `Playwright's listing parsed as ${report === null ? 'null' : typeof report}, not a report object, so it carries no test count to read.`,
    rawOutput.slice(0, 4000)
  )
}

const errors = Array.isArray(report.errors) ? report.errors : []
const messageOf = (e) => (e && typeof e.message === 'string' ? e.message : '')
// "No tests found" is Playwright's way of saying the suite is empty. It is the
// ONE error an empty-but-healthy suite produces. Anything else is a failure to
// load, whether or not it names a file.
// Playwright's own empty-suite error, and nothing else. Two conditions, and
// both are load-bearing:
//
//   * the message is EXACTLY that sentence, anchored. A loose substring test
//     was draft 4 of this defect: a module-scope
//     `throw new Error('No tests found for the overlays directory; ...')`
//     matches `/No tests found/i`, and the suite is reported as empty with a
//     suggestion to delete the job;
//   * it carries no `location`. Playwright's own error never does; a thrown one
//     from a spec or a helper does, and the draft above discarded that.
const isEmptySuiteError = (e) =>
  !e?.location && /^(Error: )?No tests found\.?$/i.test(messageOf(e).trim())
const loadFailures = errors.filter((e) => !isEmptySuiteError(e))

const countTests = (suite) =>
  (suite.specs ?? []).reduce(
    (n, spec) =>
      n +
      // `expectedStatus` is the whole condition. Measured on this Playwright:
      // both `test.skip` and `test.fixme` set it to 'skipped', and both also
      // carry an annotation -- so an annotation check alongside this one is
      // redundant, no construct separates them, and no case could prove it
      // load-bearing. A clause nothing can prove is a claim, not a check.
      (spec.tests ?? []).filter((t) => t.expectedStatus !== 'skipped').length,
    0
  ) + (suite.suites ?? []).reduce((n, child) => n + countTests(child), 0)

const runnable = (report.suites ?? []).reduce((n, suite) => n + countTests(suite), 0)

if (loadFailures.length > 0) {
  const named = loadFailures
    .map((e) => {
      const where = e.location?.file
        ? `${e.location.file}:${e.location.line}`
        : '(no file reported)'
      return `  ${where}\n    ${messageOf(e).split('\n')[0]}`
    })
    .join('\n')
  refuse(
    `${loadFailures.length} error(s) while loading the suite. A suite that cannot load is not an empty suite, and must not be reported as one:\n${named}`,
    rawOutput.slice(0, 4000)
  )
}

if (runnable === 0) {
  refuse(
    'Playwright discovered 0 runnable tests under its own testDir. The end-to-end job would report success having run nothing, and `ci-ok` needs this job. If the suite is genuinely being removed, remove the job with it. If every test is skipped, that is the same outcome by another route.',
    rawOutput.slice(0, 4000)
  )
}

if (run.status !== 0) {
  refuse(
    `Playwright listed ${runnable} runnable tests but exited ${run.status}. A listing that cannot complete cleanly is not a suite this job should claim to have run.`,
    rawOutput.slice(0, 4000)
  )
}

process.stdout.write(
  `check-e2e-specs: Playwright discovered ${runnable} runnable tests. Running them.\n`
)
