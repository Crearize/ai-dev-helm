import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // The quality-gate hook tests spawn real git repos and node child
    // processes per test; on Windows these can exceed the 5s default.
    testTimeout: 20000,
    // Sample projects under test/fixtures ship their own tests (e.g. the
    // Stryker mutation sample's calc.test.ts) that are meant to run only
    // under their own runner during smoke checks, never as part of the
    // harness suite. Keep vitest's defaults and exclude the fixture tree.
    // .stryker-tmp is a full sandbox copy of the repo left behind by an
    // aborted local Stryker run; without the exclude its duplicated test
    // files would all run (and fail) inside the sandbox.
    exclude: [...configDefaults.exclude, 'test/fixtures/**', '**/.stryker-tmp/**'],
  },
});
