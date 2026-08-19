const path = require('path');

// Meta test for shipped ESLint lint assets (stacks/nextjs-react/lint/eslint).
//
// Guarantee: every custom rule and the preset itself have been EXECUTED:
//   - RuleTester: each custom rule fires on violating code and stays silent
//     on conforming code (>= 3 valid / >= 3 invalid cases per rule).
//   - Preset smoke test: the real harness.config.mjs is loaded through the
//     programmatic ESLint API against a fixture mini-project; the violation
//     fixture must trigger at least one rule from EVERY rule group and the
//     ok fixture must produce zero errors AND zero warnings.
// A rule/preset that "looks right" but never ran is the failure mode this
// prevents (same contract as lib/lint-assets.test.js for ast-grep rules).

const REPO_ROOT = path.resolve(__dirname, '..');
const ESLINT_ASSET_DIR = path.join(
  REPO_ROOT,
  'stacks',
  'nextjs-react',
  'lint',
  'eslint'
);
const RULES_DIR = path.join(ESLINT_ASSET_DIR, 'rules');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'eslint');

// --- eslint resolution guard ------------------------------------------------
// Same style as lib/lint-assets.test.js: a missing dev dependency must be a
// loud failure telling the developer to install, never a silent skip.
let eslintModule = null;
let eslintResolveError = null;
try {
  // eslint-disable-next-line global-require
  eslintModule = require('eslint');
} catch (err) {
  eslintResolveError = err;
}

describe('eslint lint assets (meta smoke test)', () => {
  it('eslint is installed (this suite must never silently skip)', () => {
    if (eslintResolveError) {
      throw new Error(
        'eslint is not installed - run `npm install`. ' +
          'This test is the false-negative guard for shipped ESLint assets ' +
          'and must not be skipped.\n' +
          eslintResolveError.message
      );
    }
    expect(eslintModule).toBeTruthy();
  });
});

if (!eslintResolveError) {
  const { ESLint, RuleTester } = eslintModule;

  // Wire RuleTester into vitest's describe/it (globals: true in
  // vitest.config.mjs). ESLint's RuleTester auto-detects these globals, but
  // we set them explicitly so the integration never depends on detection.
  RuleTester.describe = describe;
  RuleTester.it = it;
  RuleTester.itOnly = it.only;

  // Custom rules parse JSX via espree's ecmaFeatures - they are purely
  // syntactic and need no type information.
  const ruleTester = new RuleTester({
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  });

  // --- harness/no-forwardref ------------------------------------------------
  describe('custom rule: no-forwardref', () => {
    const rule = require(path.join(RULES_DIR, 'no-forwardref.js'));

    ruleTester.run('no-forwardref', rule, {
      valid: [
        // forwardRef from a NON-react module is fine (import and call).
        "import { forwardRef } from 'redux-form'; export const X = forwardRef(fn);",
        // Other react imports are untouched.
        "import { useRef } from 'react'; export const r = useRef(null);",
        // A local function that happens to be named forwardRef.
        'const forwardRef = (x) => x; export const y = forwardRef(1);',
        // Member call on a non-React object.
        "import lib from 'lib'; export const z = lib.forwardRef(fn);",
      ],
      invalid: [
        {
          // (a) named import from 'react' + (c) call of the local binding
          code:
            "import { forwardRef } from 'react';\n" +
            'export const Input = forwardRef((props, ref) => <input ref={ref} />);',
          errors: [
            { messageId: 'noForwardRefImport' },
            { messageId: 'noForwardRefCall' },
          ],
        },
        {
          // (b) React.forwardRef(...) member call (no import needed)
          code: 'export const Input = React.forwardRef(render);',
          errors: [{ messageId: 'noForwardRefCall' }],
        },
        {
          // aliased named import: import site + aliased call site
          code:
            "import { forwardRef as fwd } from 'react';\n" +
            'export const Input = fwd(render);',
          errors: [
            { messageId: 'noForwardRefImport' },
            { messageId: 'noForwardRefCall' },
          ],
        },
        {
          // namespace import used as React.forwardRef
          code:
            "import * as React from 'react';\n" +
            'export const Input = React.forwardRef(render);',
          errors: [{ messageId: 'noForwardRefCall' }],
        },
      ],
    });
  });

  // --- harness/one-component-per-file ----------------------------------------
  describe('custom rule: one-component-per-file', () => {
    const rule = require(path.join(RULES_DIR, 'one-component-per-file.js'));

    ruleTester.run('one-component-per-file', rule, {
      valid: [
        // Single exported component.
        'export function Page() { return <div />; }',
        // Exported component + NON-exported uppercase helper (does not count).
        'function Helper() { return <span />; }\n' +
          'export function Page() { return <div><Helper /></div>; }',
        // Two exports but only one is a component (no JSX in the other).
        'export function Page() { return <div />; }\n' +
          'export function buildConfig() { return { a: 1 }; }',
        // Bottom export of a single component.
        'function Page() { return <div />; }\nexport { Page };',
        // Exported uppercase function without JSX is not a component.
        'export function Page() { return <div />; }\n' +
          'export const Factory = () => 42;',
      ],
      invalid: [
        {
          // Two exported function-declaration components -> report the second.
          code:
            'export function A() { return <div />; }\n' +
            'export function B() { return <p />; }',
          errors: [{ messageId: 'multipleComponents' }],
        },
        {
          // Three exported components -> second and third each reported.
          code:
            'export function A() { return <div />; }\n' +
            'export const B = () => <p />;\n' +
            'export function C() { return <span />; }',
          errors: [
            { messageId: 'multipleComponents' },
            { messageId: 'multipleComponents' },
          ],
        },
        {
          // Arrow-function variable + bottom-exported function declaration.
          code:
            'export const A = () => <div />;\n' +
            'function B() { return <p />; }\n' +
            'export { B };',
          errors: [{ messageId: 'multipleComponents' }],
        },
        {
          // Default-exported component + named component.
          code:
            'export default function App() { return <div />; }\n' +
            'export const Widget = () => <span />;',
          errors: [{ messageId: 'multipleComponents' }],
        },
      ],
    });
  });

  // --- harness/export-at-definition ------------------------------------------
  describe('custom rule: export-at-definition', () => {
    const rule = require(path.join(RULES_DIR, 'export-at-definition.js'));

    ruleTester.run('export-at-definition', rule, {
      valid: [
        // Export at the definition site.
        'export function foo() { return 1; }',
        'export default function main() { return 1; }',
        // Re-exports from another module are NOT reported.
        "export { foo } from './other';",
        "export { default as bar } from './other';",
        // Exporting an imported binding is a re-export, not a definition.
        "import { x } from './y'; export { x };",
      ],
      invalid: [
        {
          // Separate bottom export of a locally declared function.
          code: 'function foo() { return 1; }\nexport { foo };',
          errors: [{ messageId: 'exportAtDefinition' }],
        },
        {
          // One report per specifier that refers to a local declaration.
          code: 'const a = 1;\nclass B {}\nexport { a, B };',
          errors: [
            { messageId: 'exportAtDefinition' },
            { messageId: 'exportAtDefinition' },
          ],
        },
        {
          // export default <identifier declared earlier>.
          code: 'function main() { return 1; }\nexport default main;',
          errors: [{ messageId: 'exportDefaultAtDefinition' }],
        },
        {
          // Aliased bottom export still points at a local declaration.
          code: 'const value = 1;\nexport { value as theValue };',
          errors: [{ messageId: 'exportAtDefinition' }],
        },
      ],
    });
  });

  // --- preset smoke test ------------------------------------------------------
  describe('harness.config.mjs preset (fixture mini-project)', () => {
    const configFile = path.join(ESLINT_ASSET_DIR, 'harness.config.mjs');

    function createLinter() {
      return new ESLint({
        overrideConfigFile: configFile,
        cwd: FIXTURE_DIR,
      });
    }

    // One ruleId per rule group in harness.config.mjs; every group must
    // demonstrably fire on the violation fixture.
    const EXPECTED_RULE_IDS = [
      // correctness (A1/A2)
      'no-console',
      '@typescript-eslint/no-floating-promises',
      // type-safety (A5)
      '@typescript-eslint/no-explicit-any',
      // exhaustiveness (A7)
      '@typescript-eslint/switch-exhaustiveness-check',
      // performance (D2)
      'no-await-in-loop',
      // maintainability (C6) - severity warn
      '@typescript-eslint/no-magic-numbers',
      // harness custom (A1/C7)
      'harness/no-forwardref',
      'harness/one-component-per-file',
      'harness/export-at-definition',
    ];

    it(
      'violation.tsx triggers at least one rule from every group',
      { timeout: 90000 },
      async () => {
        const eslint = createLinter();
        const results = await eslint.lintFiles([
          path.join(FIXTURE_DIR, 'violation.tsx'),
        ]);
        expect(results).toHaveLength(1);
        const messages = results[0].messages;
        const fatal = messages.filter((m) => m.fatal);
        expect(
          fatal,
          `parse/config failure: ${JSON.stringify(fatal)}`
        ).toHaveLength(0);
        const seen = Array.from(new Set(messages.map((m) => m.ruleId)));
        for (const ruleId of EXPECTED_RULE_IDS) {
          expect(
            seen,
            `expected rule ${ruleId} to fire on violation.tsx; saw: ${seen.join(', ')}`
          ).toContain(ruleId);
        }
      }
    );

    it(
      'ok.tsx yields zero errors and zero warnings',
      { timeout: 90000 },
      async () => {
        const eslint = createLinter();
        const results = await eslint.lintFiles([
          path.join(FIXTURE_DIR, 'ok.tsx'),
        ]);
        expect(results).toHaveLength(1);
        expect(
          results[0].messages,
          `ok.tsx must be clean; got: ${JSON.stringify(results[0].messages, null, 2)}`
        ).toEqual([]);
        expect(results[0].errorCount).toBe(0);
        expect(results[0].warningCount).toBe(0);
      }
    );
  });
}
