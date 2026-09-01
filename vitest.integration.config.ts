import { defineConfig } from 'vitest/config';

// Separate from vitest.config.ts so `npm test` never needs a node. The
// integration suite is opt-in via `npm run test:integration`.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,

    // One file at a time, because a kwil account's nonces are sequential.
    // Several of these suites sign as the seeded operator to issue credits,
    // and running them in parallel makes those transactions race:
    //
    //   invalid nonce for account 70997970...: got 63, expected 64
    //
    // This is a property of the chain, not of the tests. Anything sharing one
    // signing key has to serialise its writes -- which is a real constraint on
    // W5's server-side issue_credits path, where concurrent purchases would
    // collide the same way.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
