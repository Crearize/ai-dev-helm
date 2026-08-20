import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Explicit include so Stryker's vitest-runner and a plain `vitest run`
    // agree on which specs execute.
    include: ['test/**/*.test.ts'],
  },
});
