const fs = require('fs');
const path = require('path');
const os = require('os');
const toml = require('@iarna/toml');
const { mergeToml } = require('./merge-toml');

describe('mergeToml', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-toml-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeToml(filePath, data) {
    fs.writeFileSync(filePath, toml.stringify(data), 'utf8');
  }

  function readToml(filePath) {
    return toml.parse(fs.readFileSync(filePath, 'utf8'));
  }

  it('creates new TOML file from template when target does not exist', () => {
    const target = path.join(tmpDir, 'config.toml');
    const template = path.join(tmpDir, 'template.toml');
    writeToml(template, { model: 'gpt-5.5', approval_policy: 'on-request' });

    mergeToml(target, template);

    const result = readToml(target);
    expect(result.model).toBe('gpt-5.5');
    expect(result.approval_policy).toBe('on-request');
  });

  it('preserves existing scalar values over template defaults', () => {
    const target = path.join(tmpDir, 'config.toml');
    const template = path.join(tmpDir, 'template.toml');
    writeToml(target, { model: 'gpt-5.4' });
    writeToml(template, { model: 'gpt-5.5', approval_policy: 'on-request' });

    mergeToml(target, template);

    const result = readToml(target);
    expect(result.model).toBe('gpt-5.4');
    expect(result.approval_policy).toBe('on-request');
  });

  it('overrides existing values for keys listed in upgradeKeys', () => {
    const target = path.join(tmpDir, 'config.toml');
    const template = path.join(tmpDir, 'template.toml');
    writeToml(target, { model: 'gpt-5.4' });
    writeToml(template, { model: 'gpt-5.5' });

    mergeToml(target, template, { upgradeKeys: ['model'] });

    expect(readToml(target).model).toBe('gpt-5.5');
  });

  it('merges rules array-of-tables by unique name', () => {
    const target = path.join(tmpDir, 'config.toml');
    const template = path.join(tmpDir, 'template.toml');
    writeToml(target, {
      rules: [
        { name: 'existing-rule', decision: 'allow' },
      ],
    });
    writeToml(template, {
      rules: [
        { name: 'existing-rule', decision: 'deny' },
        { name: 'new-rule', decision: 'deny' },
      ],
    });

    mergeToml(target, template);

    const result = readToml(target);
    expect(result.rules).toHaveLength(2);
    const byName = Object.fromEntries(result.rules.map((r) => [r.name, r]));
    expect(byName['existing-rule'].decision).toBe('allow');
    expect(byName['new-rule'].decision).toBe('deny');
  });

  it('creates backup before modifying existing file', () => {
    const target = path.join(tmpDir, 'config.toml');
    const template = path.join(tmpDir, 'template.toml');
    writeToml(target, { existing: true });
    writeToml(template, { model: 'gpt-5.5' });

    mergeToml(target, template);

    const backups = fs.readdirSync(tmpDir).filter((f) => f.includes('.backup.'));
    expect(backups.length).toBe(1);
  });

  it('creates parent directory if target path does not exist', () => {
    const target = path.join(tmpDir, 'nested', 'dir', 'config.toml');
    const template = path.join(tmpDir, 'template.toml');
    writeToml(template, { model: 'gpt-5.5' });

    mergeToml(target, template);

    expect(fs.existsSync(target)).toBe(true);
  });

  it('throws descriptive error when target contains invalid TOML', () => {
    const target = path.join(tmpDir, 'config.toml');
    const template = path.join(tmpDir, 'template.toml');
    fs.writeFileSync(target, '= invalid toml =', 'utf8');
    writeToml(template, { model: 'gpt-5.5' });

    expect(() => mergeToml(target, template)).toThrow(/Failed to parse/);
  });

  it('throws descriptive error when template contains invalid TOML', () => {
    const target = path.join(tmpDir, 'config.toml');
    const template = path.join(tmpDir, 'template.toml');
    fs.writeFileSync(template, '= invalid =', 'utf8');

    expect(() => mergeToml(target, template)).toThrow(/Failed to parse template/);
  });

  it('omits rules when template has none and existing has none', () => {
    const target = path.join(tmpDir, 'config.toml');
    const template = path.join(tmpDir, 'template.toml');
    writeToml(template, { model: 'gpt-5.5' });

    mergeToml(target, template);

    const result = readToml(target);
    expect(result.rules).toBeUndefined();
  });
});
