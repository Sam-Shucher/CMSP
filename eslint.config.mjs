import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// One lint setup for the whole repo: backend, frontend, and the end-to-end
// tests. Type-aware rules are on — they're what catch the mistakes that
// matter here (a forgotten await, a promise nobody handles, a needless cast).
//
//   npm run lint        # report
//   npm run lint:fix    # fix what can be fixed automatically
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**', '**/dist/**', '**/coverage/**',
      'playwright-report/**', 'test-results/**', 'tests/.auth/**', 'tests/.uploads/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Types are the point of TypeScript here; `unknown` plus a check is the
      // way to handle anything genuinely unknown (see backend/src/utils/inputs.ts).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }], // `() => {}` is a real "do nothing" callback
      '@typescript-eslint/consistent-type-definitions': 'off', // interface and type both earn their place here
      // Promises must be awaited or deliberately marked with void.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/require-await': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },

  // Backend: Node, CommonJS output.
  {
    files: ['backend/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  // Frontend: browser APIs and React's rules of hooks.
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // This app loads its data in mount effects (no data-fetching library),
      // which this rule flags wholesale. The case it's really aimed at —
      // copying props into state — is avoided by adjusting during render
      // instead (see LoanCard).
      'react-hooks/set-state-in-effect': 'off',
    },
  },

  // Tests: both suites' globals, and room for deliberately odd input.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'tests/**/*.ts', '**/src/test/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'off', // tests check what types alone promise
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/require-await': 'off',             // `async () => {}` stubs stand in for real async work
      '@typescript-eslint/unbound-method': 'off',            // passing `pool.execute` to vi.mocked() is the point
      // supertest's `.body` and a mocked fetch's JSON are `any` by design;
      // asserting on them is what a test does.
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // Plain JavaScript config and helper files (no type information to lint with).
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: false, project: false },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
