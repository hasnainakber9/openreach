import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Engine tests simulate days of activity; on a busy machine running every file in parallel the
    // longest ones get close to vitest's 5 s default, so allow more before calling a test hung.
    testTimeout: 30_000,
  },
});
