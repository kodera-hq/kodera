import js from '@eslint/js'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const ownerClaimNativeRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      NATIVE_FETCH_REFERENCE: 'NATIVE_FETCH_REFERENCE ({{form}})',
      NATIVE_FETCH_BOUNDARY: 'NATIVE_FETCH_BOUNDARY ({{form}})',
      NATIVE_FETCH_MULTIPLICITY: 'NATIVE_FETCH_MULTIPLICITY ({{form}})',
      NATIVE_FETCH_ESCAPE: 'NATIVE_FETCH_ESCAPE ({{form}})',
      NATIVE_FETCH_SHADOW: 'NATIVE_FETCH_SHADOW ({{form}})',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode
    const scopes = sourceCode.scopeManager?.scopes
    if (!Array.isArray(scopes) || typeof sourceCode.getDeclaredVariables !== 'function') {
      throw new Error('NATIVE_FETCH_SCOPE_UNAVAILABLE')
    }
    const properties = []
    const reports = new Map()
    const erasedTypes = new Set([
      'TSTypeAnnotation',
      'TSTypeQuery',
      'TSTypeAliasDeclaration',
      'TSInterfaceDeclaration',
      'TSTypeParameterDeclaration',
      'TSTypeParameterInstantiation',
      'TSImportType',
    ])

    function erasedNode(node) {
      for (let current = node; current; current = current.parent) {
        if (erasedTypes.has(current.type)) return true
        if (
          (current.type === 'ExportNamedDeclaration' || current.type === 'ExportSpecifier') &&
          current.exportKind === 'type'
        )
          return true
      }
      return false
    }

    function erasedReference(reference) {
      if (typeof reference.isValueReference !== 'boolean') {
        throw new Error('NATIVE_FETCH_REFERENCE_API_UNAVAILABLE')
      }
      return reference.isValueReference === false || erasedNode(reference.identifier)
    }

    function runtimeDefinition(definition) {
      if (typeof definition.isVariableDefinition !== 'boolean') {
        throw new Error('NATIVE_FETCH_DEFINITION_API_UNAVAILABLE')
      }
      if (!definition.isVariableDefinition) return false
      return !(
        definition.type === 'ImportBinding' &&
        (definition.node.importKind === 'type' || definition.parent?.importKind === 'type')
      )
    }

    function add(node, messageId, form) {
      if (!Array.isArray(node.range)) throw new Error('NATIVE_FETCH_RANGE_UNAVAILABLE')
      if (!reports.has(node)) reports.set(node, { node, messageId, data: { form } })
    }

    function directCall(identifier) {
      const parent = identifier.parent
      return parent?.type === 'CallExpression' && !parent.optional && parent.callee === identifier
    }

    function immediateFunction(node) {
      for (let current = node.parent; current; current = current.parent) {
        if (
          current.type === 'FunctionDeclaration' ||
          current.type === 'FunctionExpression' ||
          current.type === 'ArrowFunctionExpression'
        )
          return current
      }
      return undefined
    }

    function fetchProperty(node) {
      if (node.type === 'Literal') return node.value === 'fetch'
      return (
        node.type === 'TemplateLiteral' &&
        node.expressions.length === 0 &&
        node.quasis.length === 1 &&
        node.quasis[0].value.cooked === 'fetch'
      )
    }

    function collectProperty(node) {
      if (erasedNode(node)) return
      const property = node.type === 'MemberExpression' ? node.property : node.key
      if (
        (!node.computed && property.type === 'Identifier' && property.name === 'fetch') ||
        (node.computed && fetchProperty(property)) ||
        (property.type === 'Literal' && property.value === 'fetch')
      )
        properties.push(property)
    }

    return {
      MemberExpression: collectProperty,
      Property: collectProperty,
      'Program:exit'() {
        const references = new Map()
        const shadowed = new Set()
        for (const scope of scopes) {
          if (!Array.isArray(scope.variables) || !Array.isArray(scope.references)) {
            throw new Error('NATIVE_FETCH_SCOPE_API_UNAVAILABLE')
          }
          for (const variable of scope.variables) {
            if (!Array.isArray(variable.defs))
              throw new Error('NATIVE_FETCH_DEFINITIONS_UNAVAILABLE')
            if (variable.name !== 'fetch') continue
            const definitions = variable.defs.filter(runtimeDefinition)
            if (definitions.length === 0) continue
            shadowed.add(variable)
            for (const definition of definitions) {
              add(definition.name, 'NATIVE_FETCH_SHADOW', 'binding')
            }
          }
          for (const reference of scope.references) {
            if (!erasedReference(reference)) references.set(reference.identifier, reference)
          }
        }

        for (const [identifier] of references) {
          if (['window', 'globalThis', 'self'].includes(identifier.name)) {
            add(identifier, 'NATIVE_FETCH_ESCAPE', 'global-object')
          }
        }
        for (const property of properties) add(property, 'NATIVE_FETCH_ESCAPE', 'fetch-property')

        const eligible = []
        const functions = new Set()
        for (const [identifier, reference] of references) {
          if (
            identifier.name !== 'fetch' ||
            shadowed.has(reference.resolved) ||
            reports.has(identifier)
          )
            continue
          if (!directCall(identifier)) {
            const runtimeTypeof =
              identifier.parent?.type === 'UnaryExpression' &&
              identifier.parent.operator === 'typeof'
            add(
              identifier,
              'NATIVE_FETCH_REFERENCE',
              runtimeTypeof ? 'runtime-typeof' : 'value-alias'
            )
            continue
          }
          const enclosing = immediateFunction(identifier)
          let form
          if (!enclosing) form = 'outside'
          else if (
            enclosing.type !== 'FunctionDeclaration' ||
            enclosing.id?.name !== 'invokeOwnerClaimNative'
          )
            form = 'nested'
          else if (enclosing.async) form = 'async'
          else if (
            enclosing.parent?.type === 'ExportNamedDeclaration' ||
            enclosing.parent?.type === 'ExportDefaultDeclaration'
          )
            form = 'exported-declaration'
          else if (enclosing.generator || enclosing.parent?.type !== 'Program') form = 'outside'
          if (form) {
            add(identifier, 'NATIVE_FETCH_BOUNDARY', form)
            continue
          }
          eligible.push(identifier)
          functions.add(enclosing)
        }

        for (const declaration of functions) {
          const variables = sourceCode.getDeclaredVariables(declaration)
          if (!Array.isArray(variables))
            throw new Error('NATIVE_FETCH_DECLARED_VARIABLES_UNAVAILABLE')
          const variable = variables.find(
            (candidate) => candidate.name === 'invokeOwnerClaimNative'
          )
          if (!variable || variable.defs.length !== 1 || variable.defs[0].node !== declaration) {
            add(declaration.id, 'NATIVE_FETCH_BOUNDARY', 'helper-escape')
            continue
          }
          if (!Array.isArray(variable.references))
            throw new Error('NATIVE_FETCH_HELPER_REFERENCES_UNAVAILABLE')
          for (const reference of variable.references) {
            if (erasedReference(reference) || directCall(reference.identifier)) continue
            const identifier = reference.identifier
            const parent = identifier.parent
            let form = 'helper-escape'
            if (parent?.type === 'ExportSpecifier') form = 'indirect-export'
            else if (parent?.type === 'ExportDefaultDeclaration') form = 'default-export'
            add(identifier, 'NATIVE_FETCH_BOUNDARY', form)
          }
        }

        eligible.sort((left, right) => left.range[0] - right.range[0])
        for (const identifier of eligible.slice(1)) {
          add(identifier, 'NATIVE_FETCH_MULTIPLICITY', 'second-callsite')
        }
        for (const report of [...reports.values()].sort(
          (left, right) => left.node.range[0] - right.node.range[0]
        )) {
          context.report(report)
        }
      },
    }
  },
}

// Each SDK behind its one Kodera layer (see the rules below that use these).
const MATRIX_SDK = {
  regex: '^matrix-js-sdk(/|$)',
  message: 'Use the Espace store (src/features/espace/matrix/store.ts).',
}
const LIVEKIT_SDK = {
  regex: '^livekit-client(/|$)',
  message: "Use Espace's audio call (src/features/espace/audio/call.ts).",
}

export default tseslint.config(
  {
    ignores: [
      // Scratch trees written by scripts/check-e2e-specs.selftest.sh. It removes
      // them itself; this covers the run interrupted before it could. They hold
      // deliberately broken specs, and ESLint's flat config does not read
      // .gitignore, so without this an interrupted self-test turns `npm run lint`
      // red on a file `git status` does not even show.
      '.e2e-selftest-*/**',
      'dist',
      'dist-journey',
      'coverage',
      'playwright-report',
      'test-results',
      'storybook-static',
      'src/api/schema.d.ts', // generated from the Core API spec; never hand-edited
      'src/api/generated', // generated with it; regeneration is the only way to change these
      'src/mocks/generated', // generated with it; regeneration is the only way to change these
      'msw/mockServiceWorker.js', // generated by `npx msw init`; never hand-edited, lives outside public/ (vite.config.ts)
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Accessibility is a gate, not polish (AGENTS.md). These rules catch the
      // subset a linter can see — a missing label, a click handler on a div, a
      // positive tabindex. The rest is axe in Storybook and Playwright.
      ...jsxA11y.flatConfigs.recommended.rules,

      // `no-noninteractive-tabindex` allows `tabpanel` and nothing else by
      // default, which rejects the one shape WCAG 2.1.1 asks for on a
      // horizontally scrolling box: a scroll container that holds no focusable
      // child is reachable by pointer only unless it is a tab stop itself, and
      // a tab stop with no role announces nothing. `Table`'s `overflow-x-auto`
      // wrapper and `CopyableCode`'s `<pre>` are both exactly that, and both
      // carry an accessible name the rule itself cannot check. `region` is the
      // only role added: a bare `<div tabIndex={0}>` is still an error, which
      // is what this rule is really for.
      'jsx-a11y/no-noninteractive-tabindex': [
        'error',
        { tags: [], roles: ['tabpanel', 'region'], allowExpressionValues: true },
      ],

      // The console holds only short-lived tokens and must never reach a host
      // other than the Core API (ADR-0003). `fetch` straight to a literal URL
      // is how that rule gets broken in a hurry, so it is called out here as
      // well as in the PR template.
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Use the generated Core API client (src/api). ADR-0003: the console talks to the Core API and nothing else.',
        },
      ],
      // The same call reached as a property, which `no-restricted-globals` does not see.
      'no-restricted-properties': [
        'error',
        ...['globalThis', 'window', 'self'].map((object) => ({
          object,
          property: 'fetch',
          message:
            'Use the generated Core API client (src/api). ADR-0003: the console talks to the Core API and nothing else.',
        })),
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The static server sends `style-src-attr 'none'` (server/static.mjs):
    // a `style` attribute is markup the browser refuses wherever the component is rendered to
    // HTML. A value known only at run time goes through the CSSOM (`src/ui/cssom.ts`), which the
    // policy does not govern; anything else is a class.
    files: ['src/**/*.tsx'],
    ignores: ['src/**/*.test.tsx', 'src/**/*.stories.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='style']",
          message:
            "No `style` prop: the CSP is style-src-attr 'none'. Use a class, or cssProperty() from src/ui/cssom.ts for a computed value.",
        },
      ],
    },
  },
  {
    // The one other backend (messaging-pilot design §2.7): the workspace's homeserver, called with
    // the member's own Matrix token, by Espace's sign-in and by its store over matrix-js-sdk, and
    // the room-access call on the homeserver's origin (`/_kodera/rooms/token`, ADR-0012), which
    // trades that token for an audio room's LiveKit token. And the homeserver's discovery
    // (`/.well-known/matrix/client` on the organisation's server name, ADR-0012), which finds it.
    // These rules catch the plain forms of `fetch` elsewhere in src/; the CSP's `connect-src` is
    // the boundary the browser enforces (tests/unit/espace-network-boundary.test.ts).
    files: [
      'src/auth/matrix.ts',
      'src/features/espace/matrix/**/*.ts',
      'src/features/espace/audio/roomAccess.ts',
      'src/features/espace/homeserver.ts',
    ],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
  {
    // matrix-js-sdk stays behind Espace's store (messaging-pilot design §2.3), and livekit-client
    // behind its call (`src/features/espace/audio/`): screens read their snapshots and call their
    // actions, so an SDK upgrade or a token rule changes one directory. Flat config replaces a
    // rule rather than merging it, so each SDK's own folder gets the other SDK's rule alone.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/features/espace/matrix/**', 'src/features/espace/audio/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [MATRIX_SDK, LIVEKIT_SDK] }],
    },
  },
  {
    files: ['src/features/espace/matrix/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [LIVEKIT_SDK] }] },
  },
  {
    files: ['src/features/espace/audio/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [MATRIX_SDK] }] },
  },
  {
    // Node-side tooling: config files and the Playwright suite run outside the
    // browser, so `globals.browser` there would hide a genuine mistake.
    files: [
      '*.config.{ts,js}',
      'scripts/**/*.ts',
      'tests/e2e/**/*.ts',
      'tests/visual/**/*.ts',
      // Espace's suite against the real stack (docs/dev/ESPACE_STACK.md) creates its members
      // through Synapse's admin API: test tooling, not the console talking to a backend.
      'tests/espace/**/*.ts',
      // The v1 smoke reads the organisation's mail through Mailpit's API: test tooling too.
      'tests/smoke/**/*.ts',
      // QA's walk of the staging environment (e2e/staging/README.md): test tooling too.
      'e2e/staging/**/*.ts',
      'tests/setup.ts',
      'tests/unit/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
  {
    // Every test file, colocated or under tests/unit: a test proving MSW
    // actually intercepts a request (the mock identity provider's handlers,
    // an overlay) has to call the real `fetch` to do it — that is what is
    // under test, not a call ADR-0003 governs. Browser globals stay on: most
    // of these run under jsdom, unlike the Node-side override above.
    files: ['**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
  {
    name: 'kodera/owner-claim-native-boundary',
    files: ['src/api/client.ts'],
    linterOptions: { noInlineConfig: true },
    plugins: { kodera: { rules: { 'owner-claim-native-fetch': ownerClaimNativeRule } } },
    rules: {
      // The owner-claim rule decides every native fetch in this file, property reads included.
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'kodera/owner-claim-native-fetch': 'error',
    },
  }
)
