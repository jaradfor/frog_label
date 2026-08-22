import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores([
    'dist',
    'dist-*',
    'dist-pages',
    'build',
    'vendor',
    '.venv',
    '.pip-cache',
    '.yarn-cache',
    '.cache/**',
    'coverage',
    'playwright-report',
    'playwright-report-pages',
    'test-results',
    'python/froglabel_cli/resources/enterprise-bundle.js',
  ]),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // These effects synchronize stateful browser/port objects rather than derive
      // render-only values. The React Compiler is not enabled for this project.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
    },
  },
  {
    files: [
      'integration/label-studio-ce/froglabel-reactcode-ce/**/*.jsx',
      'src/enterprise/entry.tsx',
    ],
    languageOptions: { globals: { ...globals.browser, APP_SETTINGS: 'readonly' } },
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    files: ['e2e/fixture.ts'],
    rules: {
      // Playwright fixtures receive a callback named `use`; it is not React.use().
      'react-hooks/rules-of-hooks': 'off',
    },
  },
]);
