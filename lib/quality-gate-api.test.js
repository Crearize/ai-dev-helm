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

  // 3.7.2 (#234, G2 / G4 / G6): the registrations that run the gate are the other face products meet (they compare
  // their own with these). Each tool's gives the gate 25 s and stops the command (exit 2) when the gate does not start,
  // is killed or runs past it; Codex's also when it finds no gate in the repository (Codex acts on exit 2 only).
  test('the gate registrations of Claude Code, Codex and Cursor stop the command when the gate cannot finish', () => {
    const { hookCommand, declaredCommand, cursorGateCommand } = require('./runtime-hooks');
    const registrations = {
      claude: hookCommand('claude', 'quality-gate.cjs'),
      codex: hookCommand('codex', 'quality-gate.cjs'),
      cursor: cursorGateCommand(),
      claudeDeclared: declaredCommand('claude', 'quality-gate.cjs', 'scripts/gate.cjs'),
      codexDeclared: declaredCommand('codex', 'quality-gate.cjs', 'scripts/gate.cjs'),
      cursorDeclared: cursorGateCommand('scripts/gate.cjs'),
    };
    for (const [name, command] of Object.entries(registrations)) {
      expect(command, name).toContain('timeout:Math.max(1000,25000-(Date.now()-t0))');
      expect(command, name).toContain('if(child.error||child.signal');
      expect(command, name).toMatch(/process\.exit\(2\)/);
    }
    for (const name of ['codex', 'codexDeclared']) {
      expect(registrations[name], name).not.toContain('child.status??1');
      // git exiting other than 128 stops the command; 128 lets it through, but inside a .git directory (round 6).
      expect(registrations[name], name).toContain('if(e.status!==128)');
      expect(registrations[name], name).toContain("if(p.resolve('.').split(p.sep).some((x)=>x.toLowerCase()==='.git'))");
    }
    // Codex's review-budget (no gate) keeps the 3.3.0 text, so its trust stays.
    expect(hookCommand('codex', 'review-budget.cjs')).toContain('process.exit(child.status??1)');
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
