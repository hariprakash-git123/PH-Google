import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

/**
 * ESLint flat config for the React frontend (ESM, browser).
 *
 * Formatting is Prettier's job: `eslint-config-prettier` comes last and
 * disables every stylistic rule. What remains is correctness — above all the
 * hooks rules, which catch stale-closure and dependency-array bugs that are
 * invisible in review and only show up as a component that stops updating.
 */
export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**']
  },

  js.configs.recommended,
  react.configs.flat.recommended,
  // The automatic JSX runtime means `React` need not be in scope.
  react.configs.flat['jsx-runtime'],
  reactHooks.configs.flat['recommended-latest'],

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2023
      },
      parserOptions: {
        ecmaFeatures: { jsx: true }
      }
    },
    settings: {
      react: { version: 'detect' }
    },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],

      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'object-shorthand': ['error', 'properties'],

      // The project does not use PropTypes; it is a single-team app where
      // component contracts live in the components themselves. Turning this
      // on would mean hundreds of annotations for no caught bugs.
      'react/prop-types': 'off',

      // Browser console noise reaches users' devtools. Warn rather than
      // error so a debugging session is not blocked by the linter.
      'no-console': ['warn', { allow: ['warn', 'error'] }]
    }
  },

  {
    files: ['vite.config.js', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },

  prettier
];
