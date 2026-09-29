import { defineConfig } from 'vitest/config'

/**
 * Shared by every package whose tests import a sibling workspace package.
 *
 * Without it those imports resolve through `exports` to `dist/`, so a test in one package would
 * exercise whatever was last *built* of another. `ssr.resolve` because vitest runs in node and takes
 * the SSR resolution path; `source` is prepended to vite's defaults rather than replacing them.
 */
export const sourceFirst = defineConfig({
  ssr: { resolve: { conditions: ['source', 'module', 'node', 'development|production'] } },
})

export default sourceFirst
