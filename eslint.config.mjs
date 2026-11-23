import tsParser from '@typescript-eslint/parser';
import js from '@eslint/js';
import {defineConfig} from 'eslint/config';
import tseslint from 'typescript-eslint';


export default defineConfig([{
  ignores: ['**/dist'],
  extends: [
    js.configs.recommended,
    tseslint.configs.recommended,
    tseslint.configs.stylistic
  ],
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2018,
    sourceType: 'module',
  },
  rules: {
    quotes: ['warn', 'single'],

    indent: ['warn', 2, {
      SwitchCase: 1,
    }],
    'comma-dangle': ['warn', 'always-multiline'],
    'dot-notation': 'off',
    eqeqeq: 'warn',
    curly: ['warn', 'all'],
    'brace-style': ['warn'],
    'prefer-arrow-callback': ['warn'],
    'max-len': ['warn', 140],
    'no-console': ['warn'],
    'no-non-null-assertion': ['off'],
    'comma-spacing': ['error'],

    'no-multi-spaces': ['warn', {
      ignoreEOLComments: true,
    }],

    'no-trailing-spaces': ['warn'],

    'lines-between-class-members': ['warn', 'always', {
      exceptAfterSingleLine: true,
    }],

    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
  },
}]);
