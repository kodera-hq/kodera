import { composeStories, setProjectAnnotations } from '@storybook/react-vite'
import { render } from '@testing-library/react'
import type { ComponentType } from 'react'
import * as axe from 'axe-core'
import { describe, expect, it } from 'vitest'
import * as preview from '../../.storybook/preview'

// The accessibility gate TESTING.md §3 asks for, run headlessly by the same
// `npm run test` the `checks` job already invokes.
//
// Why not `@storybook/addon-vitest`, which is the documented route: it declares
// `@vitest/browser` and `@vitest/browser-playwright` as peers and runs every
// story in a real browser. The `checks` job installs no browser — only the
// end-to-end job does — so that route would need a workflow change, and a gate
// that cannot run is not a gate. Portable stories give the same coverage of the
// same story files in jsdom, at one cost, recorded below.

// Applied at module scope, because `composeStories` below runs while this file
// is being evaluated — a call inside `beforeAll` would land after every story
// had already been composed without the project's decorators and parameters.
//
// What this does NOT do is switch the accessibility check on: portable stories
// render the story, they do not run the addons, so `a11y: { test: 'error' }` in
// the preview governs the Storybook UI and nothing here. The explicit
// `axe.run` below is the gate. The annotations still matter — a story has to be
// judged with the decorators and parameters it actually ships with.
setProjectAnnotations([preview.default])

// Every story file is picked up by the glob, so a new primitive is covered the
// moment its stories exist rather than when somebody remembers to list it here.
const storyModules = import.meta.glob('./**/*.stories.tsx', { eager: true })

// `color-contrast` cannot run here and axe would report it as "incomplete"
// rather than as a pass or a failure: jsdom performs no layout and applies no
// stylesheet, so there is nothing to measure. Contrast is guarded where the
// values live — the contrast table in the tokens repository (ADR-0004) — and by
// hand on the states axe cannot reach.
const AXE_OPTIONS: axe.RunOptions = {
  rules: { 'color-contrast': { enabled: false } },
}

/** A story after `composeStories`: renderable, and carrying its own `play`. */
type ComposedStory = ComponentType & {
  play?: (context: { canvasElement: HTMLElement }) => Promise<void> | void
}

/**
 * Render a story, let its `play` take it to the state it is about, and judge
 * what is on screen then.
 *
 * Running `play` is the whole point: a story whose interesting state only
 * exists after a `userEvent.tab()` or an opened menu is, on first paint, a
 * different screen from the one it documents — and axe would be judging the
 * screen nobody reviewed.
 */
async function violationsOf(Story: ComposedStory): Promise<string[]> {
  const { container } = render(<Story />)

  await Story.play?.({ canvasElement: container })

  const results = await axe.run(container, AXE_OPTIONS)

  return results.violations.map((violation) => violation.id)
}

// A story that only becomes inaccessible once its `play` has run. It is defined
// here rather than as a `.stories.tsx` file precisely because it must fail: a
// real story file would be swept up by the glob above and fail the suite.
const fixtureStories = composeStories({
  default: { title: 'Fixture/PlayReachesAxe' },
  InjectsAnUnlabelledButton: {
    render: () => <div />,
    play: ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const button = document.createElement('button')
      button.type = 'button'
      canvasElement.append(button)
    },
  },
} as Parameters<typeof composeStories>[0]) as Record<string, ComposedStory>

describe('story accessibility', () => {
  const entries = Object.entries(storyModules)

  it('found the stories to judge', () => {
    // A glob that matches nothing turns this whole file green while checking
    // nothing at all — the same silent success every other gate here exists to
    // prevent. Measured at 48 story files; set at roughly 80% of that so
    // deleting a batch of stories is loud but adding a primitive is not.
    // Raise when a wave adds screens.
    expect(entries.length).toBeGreaterThanOrEqual(38)
  })

  it('reports a violation it is shown on purpose', () => {
    // The mutation TESTING.md asks for, kept rather than performed once: an
    // axe run wired to the wrong element, or an assertion reading a field that
    // no longer exists, passes every story silently. A button with no text and
    // no label is the plainest violation there is.
    const container = document.createElement('div')
    container.innerHTML = '<button type="button"></button>'
    document.body.append(container)

    return axe.run(container, AXE_OPTIONS).then((results) => {
      // Removed whether or not the assertion holds: left in place it is an
      // unlabelled button sitting in the document for every later test in this
      // file, which is exactly the leftover `cleanup()` exists to prevent.
      container.remove()

      expect(results.violations.map((violation) => violation.id)).toContain('button-name')
    })
  })

  it('judges the state a play function reaches, not only the first paint', async () => {
    // The second permanent mutation: delete the `await Story.play?.(…)` above
    // and every story still passes, because every violation this gate would
    // then miss is one that only appears after an interaction. This fixture
    // makes that deletion loud.
    const story = fixtureStories.InjectsAnUnlabelledButton
    expect(story).toBeDefined()

    expect(await violationsOf(story as ComposedStory)).toContain('button-name')
  })

  for (const [path, storyModule] of entries) {
    const stories = composeStories(storyModule as Parameters<typeof composeStories>[0]) as Record<
      string,
      ComposedStory
    >

    describe(path, () => {
      it('exports at least one story', () => {
        expect(Object.keys(stories).length).toBeGreaterThan(0)
      })

      for (const [name, Story] of Object.entries(stories)) {
        it(`${name} has no accessibility violations`, async () => {
          expect(await violationsOf(Story)).toEqual([])
        })
      }
    })
  }
})
