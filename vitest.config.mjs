import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // The quality-gate hook tests spawn real git repos and node child
    // processes per test; on Windows these can exceed the 5s default.
    testTimeout: 20000,
  },
});
