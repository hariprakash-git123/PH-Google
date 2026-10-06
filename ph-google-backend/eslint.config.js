const js = require('@eslint/js');
const globals = require('globals');
const jest = require('eslint-plugin-jest');
const prettier = require('eslint-config-prettier');

/**
 * ESLint flat config for the backend (CommonJS, Node 18+).
 *
 * Formatting is Prettier's job, not ESLint's: `eslint-config-prettier` comes
 * last and switches off every stylistic rule, so the two never disagree about
 * the same line. What is left here is correctness.
 */
module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**', 'logs/**']
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.es2023
      }
    },
    rules: {
      // An unused variable is usually a leftover or a typo. A leading
      // underscore is the escape hatch for a deliberately ignored argument.
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],

      // Express middleware and Mongoose hooks are easy places to forget a
      // return; these catch the resulting silent bugs.
      'no-unreachable': 'error',
      'no-promise-executor-return': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',

      // `==` against null is the one useful loose comparison; everything
      // else hides type bugs.
      eqeqeq: ['error', 'smart'],

      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'object-shorthand': ['error', 'properties'],
      'prefer-promise-reject-errors': 'error',
      'no-throw-literal': 'error',

      // Deliberately off: this project is a server plus a set of CLI
      // scripts, and both print to the console on purpose. `utils/logger`
      // is the wrapper for anything request-scoped.
      'no-console': 'off',

      // Also deliberately off. It flagged seven sites here and every one was
      // a false positive — module singletons assigned after an await
      // (`client`, `indexReady`, the health cache), where a concurrent
      // caller would write an equally valid value. Node is single-threaded,
      // the initialisers are idempotent, and nothing is read-modify-written.
      // Enabling it would mean seven eslint-disable comments on correct
      // code, which teaches people to ignore the linter.
      'require-atomic-updates': 'off'
    }
  },

  {
    files: ['tests/**/*.js'],
    plugins: { jest },
    languageOptions: {
      globals: { ...globals.jest }
    },
    rules: {
      ...jest.configs.recommended.rules,

      // Integration suites legitimately build a request and assert on the
      // response in a loop; conditional expects are the readable form.
      'jest/no-conditional-expect': 'off'
    }
  },

  // Ad-hoc developer scripts: not application code, not in CI.
  {
    files: ['scripts/dev/**/*.js'],
    rules: {
      'no-unused-vars': 'warn'
    }
  },

  prettier
];
