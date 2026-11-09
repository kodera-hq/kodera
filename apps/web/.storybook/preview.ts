import type { Preview } from '@storybook/react-vite'
// The real stylesheet, not a copy: the tokens, the self-hosted fonts and the
// page ground. A story rendered against anything else is a screenshot of
// something the console does not ship.
import '../src/index.css'

const preview: Preview = {
  parameters: {
    // `error`, not `warn`. An accessibility violation fails the story rather
    // than colouring a panel nobody opens (AGENTS.md: accessibility is a gate).
    a11y: { test: 'error' },
    controls: { expanded: true },
  },
}

export default preview
