const fs = require('fs');
const path = require('path');
const os = require('os');
const { mergeSettings } = require('./merge-settings');

describe('mergeSettings', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-settings-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  it('creates new settings file from template when target does not exist', () => {
    const target = path.join(tmpDir, 'settings.json');
    const template = path.join(tmpDir, 'template.json');
    writeJson(template, {
      env: { debug: false },
      permissions: { deny: ['rm -rf /'] },
    });

    mergeSettings(target, template);

    const result = readJson(target);
    expect(result.env).toEqual({ debug: false });
    expect(result.permissions.deny).toContain('rm -rf /');
    expect(result.permissions.allow).toEqual([]);
  });

  it('merges deny lists as union and sorts', () => {
    const target = path.join(tmpDir, 'settings.json');
    const template = path.join(tmpDir, 'template.json');
    writeJson(target, {
      permissions: { deny: ['git push --force', 'rm -rf /'] },
    });
    writeJson(template, {
      permissions: { deny: ['docker prune', 'rm -rf /'] },
    });

    mergeSettings(target, template);

    const result = readJson(target);
    expect(result.permissions.deny).toEqual([
      'docker prune',
      'git push --force',
      'rm -rf /',
    ]);
  });

  it('preserves existing values over template defaults', () => {
    const target = path.join(tmpDir, 'settings.json');
    const template = path.join(tmpDir, 'template.json');
    writeJson(target, { env: { debug: true } });
    writeJson(template, {
      env: { debug: false },
      newKey: 'from-template',
      permissions: { deny: [] },
    });

    mergeSettings(target, template);

    const result = readJson(target);
    expect(result.env).toEqual({ debug: true });
    expect(result.newKey).toBe('from-template');
  });

  it('creates backup before modifying existing file', () => {
    const target = path.join(tmpDir, 'settings.json');
    const template = path.join(tmpDir, 'template.json');
    writeJson(target, { original: true, permissions: { deny: [] } });
    writeJson(template, { permissions: { deny: [] } });

    mergeSettings(target, template);

    const backups = fs.readdirSync(tmpDir).filter((f) => f.includes('.backup.'));
    expect(backups.length).toBe(1);

    const backupContent = readJson(path.join(tmpDir, backups[0]));
    expect(backupContent.original).toBe(true);
  });

  it('preserves existing allow list', () => {
    const target = path.join(tmpDir, 'settings.json');
    const template = path.join(tmpDir, 'template.json');
    writeJson(target, {
      permissions: { allow: ['npm test'], deny: [] },
    });
    writeJson(template, { permissions: { deny: [] } });

    mergeSettings(target, template);

    const result = readJson(target);
    expect(result.permissions.allow).toEqual(['npm test']);
  });

  it('preserves hooks from existing file', () => {
    const target = path.join(tmpDir, 'settings.json');
    const template = path.join(tmpDir, 'template.json');
    writeJson(target, {
      hooks: { prePush: 'npm test' },
      permissions: { deny: [] },
    });
    writeJson(template, {
      hooks: { prePush: 'overwritten' },
      permissions: { deny: [] },
    });

    mergeSettings(target, template);

    const result = readJson(target);
    expect(result.hooks).toEqual({ prePush: 'npm test' });
  });

  it('creates parent directory if target path does not exist', () => {
    const target = path.join(tmpDir, 'nested', 'dir', 'settings.json');
    const template = path.join(tmpDir, 'template.json');
    writeJson(template, { permissions: { deny: [] } });

    mergeSettings(target, template);

    expect(fs.existsSync(target)).toBe(true);
  });

  it('throws descriptive error when target contains invalid JSON', () => {
    const target = path.join(tmpDir, 'settings.json');
    const template = path.join(tmpDir, 'template.json');
    fs.writeFileSync(target, '{ invalid json }', 'utf8');
    writeJson(template, { permissions: { deny: [] } });

    expect(() => mergeSettings(target, template)).toThrow(/Failed to parse/);
  });

  it('adds only the missing env variables and keeps the existing ones (H-74)', () => {
    const target = path.join(tmpDir, 'settings.json');
    const template = path.join(tmpDir, 'template.json');
    writeJson(target, { env: { MINE: '1', SUPERPOWERS_DISABLE_TELEMETRY: '0' }, permissions: { deny: [] } });
    writeJson(template, {
      env: { SUPERPOWERS_DISABLE_TELEMETRY: '1', NEW_VAR: 'x' },
      permissions: { deny: [] },
    });

    mergeSettings(target, template, { mergeEnv: true });

    expect(readJson(target).env).toEqual({ MINE: '1', SUPERPOWERS_DISABLE_TELEMETRY: '0', NEW_VAR: 'x' });
  });

  it('leaves env untouched without mergeEnv (global/personal settings merge)', () => {
    const target = path.join(tmpDir, 'settings.json');
    const template = path.join(tmpDir, 'template.json');
    writeJson(target, { env: { MINE: '1' }, permissions: { deny: [] } });
    writeJson(template, { env: { NEW_VAR: 'x' }, permissions: { deny: [] } });

    mergeSettings(target, template);

    expect(readJson(target).env).toEqual({ MINE: '1' });
  });

  it('the project settings template disables the visual companion telemetry', () => {
    const real = path.join(__dirname, '..', 'templates', 'settings.json.template');
    expect(readJson(real).env.SUPERPOWERS_DISABLE_TELEMETRY).toBe('1');
  });

  it('overrides existing values for keys listed in upgradeKeys', () => {
    const target = path.join(tmpDir, 'settings.json');
    const template = path.join(tmpDir, 'template.json');
    writeJson(target, {
      model: 'claude-opus-4-6',
      effortLevel: 'low',
      permissions: { deny: [] },
    });
    writeJson(template, {
      model: 'claude-opus-4-7',
      effortLevel: 'high',
      permissions: { deny: [] },
    });

    mergeSettings(target, template, { upgradeKeys: ['model'] });

    const result = readJson(target);
    expect(result.model).toBe('claude-opus-4-7');
    // effortLevel is NOT in upgradeKeys, so existing value is preserved
    expect(result.effortLevel).toBe('low');
  });

  it('treats missing upgradeKeys option as empty (default behavior unchanged)', () => {
    const target = path.join(tmpDir, 'settings.json');
    const template = path.join(tmpDir, 'template.json');
    writeJson(target, { model: 'claude-opus-4-6', permissions: { deny: [] } });
    writeJson(template, { model: 'claude-opus-4-7', permissions: { deny: [] } });

    mergeSettings(target, template);

    const result = readJson(target);
    expect(result.model).toBe('claude-opus-4-6');
  });

  it('throws descriptive error when template contains invalid JSON', () => {
    const target = path.join(tmpDir, 'settings.json');
    const template = path.join(tmpDir, 'template.json');
    fs.writeFileSync(template, 'not json', 'utf8');

    expect(() => mergeSettings(target, template)).toThrow(/Failed to parse template/);
  });
});
