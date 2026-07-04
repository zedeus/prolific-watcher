import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: { parser: ts.parser },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        atob: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        AudioContext: 'readonly',
        AudioBuffer: 'readonly',
        AudioBufferSourceNode: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        MediaQueryListEvent: 'readonly',
        MessageEvent: 'readonly',
        Node: 'readonly',
        HTMLElement: 'readonly',
        HTMLDetailsElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLButtonElement: 'readonly',
        crypto: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      'preserve-caught-error': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'svelte/no-unused-svelte-ignore': 'off',
      'svelte/prefer-svelte-reactivity': 'off',
    },
  },
  {
    ignores: ['.output/', '.wxt/', 'node_modules/'],
  },
);
