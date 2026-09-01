import { defineConfig } from 'vitest/config';

// Separate from vitest.config.ts so `npm test` never needs a node. The
// integration suite is opt-in via `npm run test:integration`.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
