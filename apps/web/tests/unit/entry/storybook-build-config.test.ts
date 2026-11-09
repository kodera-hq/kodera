// @vitest-environment node
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Plugin, PluginOption, UserConfig } from 'vite'
import storybook from '../../../.storybook/main'
import component from '../../../.storybook/vite.config'
import application from '../../../vite.config'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const source = join(root, 'src')
const componentConfigPath = join(root, '.storybook/vite.config.ts')
const appHtml = join(root, 'index.html')

async function flatten(options: PluginOption[] = []): Promise<Plugin[]> {
  const plugins: Plugin[] = []
  for (const pending of options) {
    const option = await pending
    if (Array.isArray(option)) plugins.push(...(await flatten(option)))
    else if (option) plugins.push(option)
  }
  return plugins
}

function componentContract(plugins: Plugin[], config: UserConfig): void {
  expect(
    plugins.some((plugin) => plugin.name === 'kodera-entry-bootstrap'),
    'COMPONENT_APP_ENTRY_PLUGIN'
  ).toBe(false)
  expect(
    plugins.some((plugin) => plugin.name.startsWith('vite:react')),
    'COMPONENT_REACT_MISSING'
  ).toBe(true)
  expect(
    plugins.some((plugin) => plugin.name.startsWith('@tailwindcss/vite')),
    'COMPONENT_TAILWIND_MISSING'
  ).toBe(true)
  const alias = config.resolve?.alias
  const aliases = Array.isArray(alias)
    ? alias
    : Object.entries(alias ?? {}).map(([find, replacement]) => ({ find, replacement }))
  expect(aliases.find((entry) => entry.find === '@')?.replacement, 'COMPONENT_ALIAS').toBe(source)
  expect(config.build?.assetsInlineLimit, 'COMPONENT_ASSET_POLICY').toBe(0)
}

describe('component inventory and application entry build boundaries', () => {
  let appPlugins: Plugin[]
  let componentPlugins: Plugin[]
  beforeAll(async () => {
    appPlugins = await flatten(application.plugins)
    componentPlugins = await flatten(component.plugins)
  })

  it('selects the real component profile and retains stylesheet transforms and resolution', () => {
    const framework = storybook.framework
    if (typeof framework !== 'object' || framework === null) {
      throw Error('COMPONENT_PROFILE_NOT_SELECTED')
    }
    expect(framework.options.builder?.viteConfigPath, 'COMPONENT_PROFILE_NOT_SELECTED').toBe(
      componentConfigPath
    )
    componentContract(componentPlugins, component)
  })

  it('keeps the application recovery template and its marker/bundle guards wired', async () => {
    const guards = appPlugins.filter((plugin) => plugin.name === 'kodera-entry-bootstrap')
    expect(guards, 'APP_ENTRY_GUARD_MISSING').toHaveLength(1)
    const guard = guards[0]
    if (!guard?.transformIndexHtml) throw Error('APP_ENTRY_GUARD_MISSING')
    const hook = guard.transformIndexHtml
    const htmlHandler = typeof hook === 'function' ? hook : hook.handler
    const context = { path: '/index.html', filename: appHtml }
    const render = (markup: string): unknown => Reflect.apply(htmlHandler, {}, [markup, context])
    expect(await render('<!-- ENTRY_RECOVERY -->')).toContain('<template id="entry-recovery">')
    await expect(Promise.resolve().then(() => render('<html></html>'))).rejects.toThrow(
      'ENTRY_RECOVERY_MARKER_INVALID'
    )
    await expect(
      Promise.resolve().then(() => render('<!-- ENTRY_RECOVERY --><!-- ENTRY_RECOVERY -->'))
    ).rejects.toThrow('ENTRY_RECOVERY_MARKER_INVALID')
    const bundleGuard = guard.generateBundle
    expect(
      typeof bundleGuard === 'function' || typeof bundleGuard?.handler === 'function',
      'APP_BUNDLE_GUARD_MISSING'
    ).toBe(true)
    if (!bundleGuard) throw Error('APP_BUNDLE_GUARD_MISSING')
    const bundleHandler = typeof bundleGuard === 'function' ? bundleGuard : bundleGuard.handler
    await expect(
      Promise.resolve().then(() => Reflect.apply(bundleHandler, {}, [{}, {}, false]))
    ).rejects.toThrow('ENTRY_BUILD_MAPPING_INVALID')
  })

  it('rejects the actual application profile when substituted for the component profile', () => {
    expect(() => componentContract(appPlugins, application)).toThrow('COMPONENT_APP_ENTRY_PLUGIN')
    componentContract(componentPlugins, component)
  })

  it.each(['vite:react', '@tailwindcss/vite'])('rejects losing the %s compiler', (prefix) => {
    expect(() =>
      componentContract(
        componentPlugins.filter((plugin) => !plugin.name.startsWith(prefix)),
        component
      )
    ).toThrow(prefix === 'vite:react' ? 'COMPONENT_REACT_MISSING' : 'COMPONENT_TAILWIND_MISSING')
    componentContract(componentPlugins, component)
  })

  it('rejects a wrong source alias or a changed inline-asset policy', () => {
    expect(() =>
      componentContract(componentPlugins, { ...component, resolve: { alias: { '@': '/wrong' } } })
    ).toThrow('COMPONENT_ALIAS')
    expect(() =>
      componentContract(componentPlugins, { ...component, build: { assetsInlineLimit: 4096 } })
    ).toThrow('COMPONENT_ASSET_POLICY')
    componentContract(componentPlugins, component)
  })
})
