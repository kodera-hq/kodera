import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Storybook renders components, not the application bootstrap. Keep its
// stylesheet/transform/alias contract without inheriting application entry
// recovery and chunk-identity assertions. The production Vite config retains
// those assertions unchanged.
export default defineConfig({
  build: { assetsInlineLimit: 0 },
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: { '@': resolve(dirname(fileURLToPath(import.meta.url)), '../src') },
  },
})
