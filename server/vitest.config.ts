import { defineConfig } from 'vitest/config';

// TEST_DATABASE_URL runs the suite on Postgres, where every statement is a network round trip.
const pg = !!process.env.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    // Engine tests simulate days of activity; on a busy machine running every file in parallel the
    // longest ones get close to vitest's 5 s default, so allow more before calling a test hung.
    testTimeout: pg ? 300_000 : 30_000,
    hookTimeout: pg ? 60_000 : 10_000,
  },
});
