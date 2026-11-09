import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StorybookConfig } from '@storybook/react-vite'

// Storybook is the console's component inventory. Its component iframe uses
// an explicit Vite profile; the application bootstrap contract stays in the
// root application configuration.
const config: StorybookConfig = {
  stories: ['../src/ui/**/*.stories.tsx'],
  addons: [
    // The axe panel, for the states a person is looking at while they work.
    // The gate that runs without anyone looking is a Vitest test — see
    // `src/ui/stories-a11y.test.tsx` and docs/dev/TESTING.md §3.
    '@storybook/addon-a11y',
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {
      builder: { viteConfigPath: join(dirname(fileURLToPath(import.meta.url)), 'vite.config.ts') },
    },
  },
  core: {
    // DESIGN_SYSTEM.md §1 and ADR-0003: nothing here talks to a host that is
    // not ours. Left on, `storybook dev` posts usage data to a third party from
    // every developer machine, which is a decision nobody made.
    disableTelemetry: true,
  },
}

export default config
