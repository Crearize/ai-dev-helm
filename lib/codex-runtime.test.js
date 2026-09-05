'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const toml = require('@iarna/toml');
const { setupCodexRuntime, migrateLegacyRules } = require('./codex-runtime');

const temporaryDirectories = [];

function temporaryProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-'));
  temporaryDirectories.push(projectDir);
  return projectDir;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('setupCodexRuntime', () => {
  it('installs parseable model-routed agents while retaining custom configuration on a second install', () => {
    const projectDir = temporaryProject();
    const codexDir = path.join(projectDir, '.codex');
    const customAgent = path.join(codexDir, 'agents', 'product-specialist.toml');
    fs.mkdirSync(path.dirname(customAgent), { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'custom_key = "kept"\n', 'utf8');
    fs.writeFileSync(customAgent, [
      'name = "product-specialist"',
      'description = "User-owned agent"',
      'developer_instructions = "Keep this agent."',
    ].join('\n'), 'utf8');

    expect(setupCodexRuntime(projectDir)).toEqual([]);
    expect(setupCodexRuntime(projectDir)).toEqual([]);

    const config = toml.parse(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8'));
    expect(config.custom_key).toBe('kept');
    expect(config.agents).toEqual({
      enabled: true,
      default_subagent_model: 'gpt-5.6-terra',
      default_subagent_reasoning_effort: 'medium',
    });
    expect(fs.readFileSync(customAgent, 'utf8')).toContain('Keep this agent.');

    expect(readAgent(codexDir, 'helm-designer')).toMatchObject({
      name: 'helm-designer', model: 'gpt-6-astra', model_reasoning_effort: 'high',
    });
    expect(readAgent(codexDir, 'helm-implementer')).toMatchObject({
      name: 'helm-implementer', model: 'gpt-5.6-terra', model_reasoning_effort: 'medium',
    });
    expect(readAgent(codexDir, 'helm-explorer')).toMatchObject({
      name: 'helm-explorer', model: 'gpt-5.6-luna', model_reasoning_effort: 'medium',
    });
    expect(readAgent(codexDir, 'helm-reviewer')).toMatchObject({
      name: 'helm-reviewer', model: 'gpt-6-astra', model_reasoning_effort: 'high',
    });
    expect(fs.existsSync(path.join(codexDir, 'rules', 'ai-dev-helm-safety.rules'))).toBe(true);
  });

  it('does not create anything in dry-run mode', () => {
    const projectDir = temporaryProject();

    expect(setupCodexRuntime(projectDir, { dryRun: true })).toEqual([]);
    expect(fs.existsSync(path.join(projectDir, '.codex'))).toBe(false);
  });

  it('leaves malformed configuration intact and reports the problem', () => {
    const projectDir = temporaryProject();
    const configPath = path.join(projectDir, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'not valid = [', 'utf8');

    const warnings = setupCodexRuntime(projectDir);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not parse/i);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('not valid = [');
    expect(fs.existsSync(path.join(projectDir, '.codex', 'agents'))).toBe(false);
  });

  it('preserves a customized managed-role collision and warns instead of overwriting it', () => {
    const projectDir = temporaryProject();
    const explorerPath = path.join(projectDir, '.codex', 'agents', 'helm-explorer.toml');
    fs.mkdirSync(path.dirname(explorerPath), { recursive: true });
    fs.writeFileSync(explorerPath, 'name = "helm-explorer"\ndescription = "Custom"\ndeveloper_instructions = "Keep me"\n', 'utf8');

    const warnings = setupCodexRuntime(projectDir);

    expect(fs.readFileSync(explorerPath, 'utf8')).toContain('Keep me');
    expect(warnings).toContain('Preserved customized managed role file: helm-explorer.toml');
  });

  it('removes an empty legacy rules array so strict Codex config remains valid', () => {
    const projectDir = temporaryProject();
    const configPath = path.join(projectDir, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'rules = []\n', 'utf8');

    setupCodexRuntime(projectDir);

    expect(toml.parse(fs.readFileSync(configPath, 'utf8'))).not.toHaveProperty('rules');
  });
});

describe('migrateLegacyRules', () => {
  it('removes only exact legacy rules and warns while preserving unknown rules', () => {
    const config = {
      rules: [
        {
          name: 'block-npm-publish',
          match: { tool: 'Bash', command_regex: '(npm|pnpm|yarn)\\s+publish' },
          decision: 'deny',
          reason: 'Blocked by ai-dev-helm: package publish must be done manually',
        },
        {
          name: 'block-npm-publish',
          match: { tool: 'Bash', command_regex: 'npm publish --tag next' },
          decision: 'deny',
          reason: 'My stricter policy',
        },
      ],
    };

    const result = migrateLegacyRules(config);

    expect(result.removed).toHaveLength(1);
    expect(result.warnings).toEqual([
      'ACTION REQUIRED: preserved unknown Codex [[rules]] entry "block-npm-publish"; move it to a .rules file manually.',
    ]);
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].reason).toBe('My stricter policy');
  });

  it('recognizes a legacy rule after a real TOML roundtrip changes property ordering', () => {
    const legacySource = [
      '[[rules]]',
      'name = "block-npm-publish"',
      'decision = "deny"',
      'reason = "Blocked by ai-dev-helm: package publish must be done manually"',
      'match = { command_regex = "(npm|pnpm|yarn)\\\\s+publish", tool = "Bash" }',
    ].join('\n');
    const config = toml.parse(toml.stringify(toml.parse(legacySource)));

    const result = migrateLegacyRules(config);

    expect(result.removed).toHaveLength(1);
    expect(config).not.toHaveProperty('rules');
  });
});

function readAgent(codexDir, name) {
  return toml.parse(fs.readFileSync(path.join(codexDir, 'agents', `${name}.toml`), 'utf8'));
}
