import { defineConfig } from 'tsup';

// Two output formats, because the SDK has two consumers with different module
// systems: the Vite front end is ESM, and the Express backend is CommonJS
// (its package.json declares no "type"). The backend needs the SDK for W5's
// server-side issue_credits path, so dropping CJS would strand it.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
});
