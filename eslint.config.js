import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Not import.meta.dirname: that landed in Node 20.11 and this package supports 18.
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },

  js.configs.recommended,

  // Type-aware linting, TypeScript only. Applying it to this config file too
  // would demand a type graph for a file that has none.
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: rootDir },
    },
  },

  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },

  // Last, so it switches off the stylistic rules Prettier owns.
  prettier
);
