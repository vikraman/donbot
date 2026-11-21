// typescript-eslint, agda files for now
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

export const AGDA = [
  'scripts/Agda.ts',
  'scripts/lib/agda/**/*.ts',
  'agda-index/*.ts',
  'tests/Agda*.ts',
  'tests/helpers/redis.ts',
  'tests/fixtures/agda-subset.ts'
]

export default tseslint.config(
  {
    files: AGDA,
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: root }
    },
    rules: {
      // void marks fire and forget
      '@typescript-eslint/no-floating-promises': ['error', {
        ignoreVoid: true,
        // node:test runs these
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach'] }]
      }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }]
    }
  }
)
