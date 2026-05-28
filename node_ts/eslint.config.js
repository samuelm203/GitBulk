// ESLint Flat Config (ESLint 9+).
//
// Ersetzt die alte .eslintrc.json. ESLint 9 erwartet standardmäßig dieses
// Format (eslint.config.js). Wir bauen die Config direkt aus den vorhandenen
// Paketen (@typescript-eslint/parser + /eslint-plugin), ohne das
// typescript-eslint-Meta-Paket, um keine zusätzliche Dependency einzuführen.

import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  // Global ignorierte Pfade (ersetzt ignorePatterns).
  {
    ignores: ['dist/**', 'node_modules/**', 'examples/**', 'coverage/**'],
  },

  // ESLint-Empfehlungen als Basis.
  js.configs.recommended,

  // TypeScript-Quellen und -Tests.
  {
    files: ['src/**/*.{ts,js}', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        // Kein `project` hier: typed-linting ist langsam und für unseren
        // Regelsatz nicht nötig. Falls später typsensitive Regeln gewünscht
        // sind, hier `project: './tsconfig.json'` ergänzen.
      },
      globals: {
        // Node-Globals (ersetzt env.node).
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        AbortController: 'readonly',
        NodeJS: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Basis-Empfehlungen des TS-Plugins übernehmen.
      ...tsPlugin.configs.recommended.rules,

      // Projekt-spezifische Anpassungen (aus der alten .eslintrc.json).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'warn',
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],

      // `no-undef` ist bei TypeScript redundant (der Compiler prüft das) und
      // kollidiert mit TS-Typ-only-Konstrukten → ausschalten.
      'no-undef': 'off',
    },
  },
];
