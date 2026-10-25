const gate = require('../templates/hooks/quality-gate.cjs');

// 3.7.0 (C3h): the public API of quality-gate.cjs is fixed - products and their own checks require these names
// (MovieMarketer's former receipt verifier, MasterPlan's Cursor adapter). A rename or a removal breaks them, so the
// list is pinned here; adding a name is a design change (C3h's list). No aliases (harnessOnly, speedHarnessFiles).

const API = ['classify', 'parseSimple', 'shellOf', 'isReleaseOnly', 'isHarness', 'isGateConfig', 'hasOverride', 'speedRange', 'controlHits'];

describe('quality-gate public API', () => {
  test('exports exactly the fixed list, each a function', () => {
    expect(Object.keys(gate).sort()).toEqual([...API].sort());
    for (const name of API) expect(typeof gate[name], name).toBe('function');
    expect(gate.harnessOnly).toBeUndefined();
    expect(gate.speedHarnessFiles).toBeUndefined();
  });

  test('the classifiers answer as the hook does', () => {
    expect(gate.isGateConfig('CLAUDE.md')).toBe(true);
    expect(gate.isGateConfig('apps/web/AGENTS.md')).toBe(true);
    expect(gate.isGateConfig('README.md')).toBe(false);
    expect(gate.hasOverride('+### Quality Gate Overrides')).toBe(true);
    expect(gate.hasOverride('mutation_budget_minutes: 30')).toBe(true);
    expect(gate.hasOverride('quality gate')).toBe(false);
    expect(gate.isHarness('skills/project/branch-workflow/SKILL.md')).toBe(true);
    expect(gate.isHarness('skills/project/branch-workflow/run.sh')).toBe(false);
    expect(gate.controlHits(['.claude/hooks/quality-gate.cjs', '.ai-dev-helm.json', '.mcp.json', 'src/app.js'])).toEqual(['.claude/hooks/quality-gate.cjs', '.ai-dev-helm.json', '.mcp.json']);
    expect(gate.speedRange(['CLAUDE.md', '.claude/settings.json', 'src/app.js'], false)).toEqual({ files: ['.claude/settings.json', 'CLAUDE.md'], override: false, noBase: false });
    expect(gate.isReleaseOnly(['CHANGELOG.md'], {})).toBe(true);
    expect(gate.shellOf('PowerShell')).toBe('powershell');
    expect(Array.isArray(gate.parseSimple('git status'))).toBe(true);
    expect(gate.classify('git status', {})).toEqual({ decision: 'allow' });
  });

  test('isHarness, controlHits and speedRange take a product configuration as their last argument', () => {
    const config = { controlPlane: [/^scripts\/gate\.mjs$/i], exemptDocs: [/^docs\/notes\.md$/], harness: [/^\.github\/workflows\//i] };
    expect(gate.isHarness('docs/notes.md')).toBe(false);
    expect(gate.isHarness('docs/notes.md', config)).toBe(true);
    expect(gate.controlHits(['scripts/gate.mjs'])).toEqual([]);
    expect(gate.controlHits(['scripts/gate.mjs'], config)).toEqual(['scripts/gate.mjs']);
    expect(gate.speedRange(['.github/workflows/ci.yml', 'scripts/gate.mjs'], false, false, config).files).toEqual(['scripts/gate.mjs', '.github/workflows/ci.yml']);
  });
});
