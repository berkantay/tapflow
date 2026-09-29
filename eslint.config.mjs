import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  // `typeAssertions.ts` is deliberately outside the protocol package's build tsconfig (it declares
  // values and must not reach `dist`), which puts it outside the typed-lint project service too.
  // It is type-checked by `tsconfig.assertions.json`.
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.js', '**/*.mjs', '**/*.cjs', 'packages/protocol/src/typeAssertions.ts'] },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true },
    },
    rules: {
      'eol-last': ['error', 'always'],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
)
