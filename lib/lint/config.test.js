const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadLintConfig, CONFIG_FILENAME } = require('./config');

describe('loadLintConfig', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a directory (recursively) and return its path */
  function mkdir(...segments) {
    const dir = path.join(tmpDir, ...segments);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeConfig(dir, data) {
    const filePath = path.join(dir, CONFIG_FILENAME);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return filePath;
  }

  // 1. No config file found -> defaults
  it('returns defaults when no config file exists', () => {
    const repo = mkdir('repo');
    mkdir('repo', '.git');

    const result = loadLintConfig(repo);

    expect(result.configPath).toBeNull();
    expect(result.error).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(result.exclude).toEqual([]);
    expect(Object.keys(result.checks).sort()).toEqual([
      'branch-naming',
      'commented-code',
      'commit-message',
      'file-naming',
      'import-exists',
      'secrets',
      'todo-deadline',
    ]);
    expect(result.checks['secrets'].enabled).toBe(true);
    expect(result.checks['file-naming'].enabled).toBe(false);
    expect(result.checks['commented-code'].options.minLines).toBe(3);
    expect(result.checks['branch-naming'].options.pattern).toBe(
      '^(feat|fix|chore|docs|refactor|test|ci|perf)/[a-z0-9._-]+$'
    );
    expect(result.checks['branch-naming'].options.exempt).toEqual([
      'main',
      'master',
      'develop',
    ]);
    expect(result.checks['commit-message'].options.pattern).toBe(
      '^(feat|fix|chore|docs|refactor|test|ci|perf|revert)(\\(.+\\))?!?: .+'
    );
  });

  // 2. Partial config -> per-check shallow merge onto defaults
  it('merges partial config onto defaults per check (shallow option merge)', () => {
    const repo = mkdir('repo');
    mkdir('repo', '.git');
    const configPath = writeConfig(repo, {
      exclude: ['dist/**'],
      checks: {
        secrets: { allow: ['EXAMPLE_'] },
        'commented-code': { enabled: true },
        'branch-naming': { exempt: ['main'] },
      },
    });

    const result = loadLintConfig(repo);

    expect(result.configPath).toBe(configPath);
    expect(result.error).toBeNull();
    expect(result.exclude).toEqual(['dist/**']);
    // specified option overrides
    expect(result.checks['secrets'].options.allow).toEqual(['EXAMPLE_']);
    expect(result.checks['secrets'].enabled).toBe(true);
    // unspecified option keys keep defaults
    expect(result.checks['commented-code'].options.minLines).toBe(3);
    expect(result.checks['branch-naming'].options.exempt).toEqual(['main']);
    expect(result.checks['branch-naming'].options.pattern).toBe(
      '^(feat|fix|chore|docs|refactor|test|ci|perf)/[a-z0-9._-]+$'
    );
    // unspecified checks fall back to defaults
    expect(result.checks['file-naming'].enabled).toBe(false);
    expect(result.checks['import-exists'].enabled).toBe(true);
  });

  // 3. Broken JSON -> error, no throw
  it('returns error (does not throw) on broken JSON', () => {
    const repo = mkdir('repo');
    mkdir('repo', '.git');
    const configPath = path.join(repo, CONFIG_FILENAME);
    fs.writeFileSync(configPath, '{ "exclude": [ oops', 'utf8');

    const result = loadLintConfig(repo);

    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.configPath).toBe(configPath);
  });

  // 4. Unknown check names -> ignored but warned
  it('ignores unknown check names and reports them in warnings', () => {
    const repo = mkdir('repo');
    mkdir('repo', '.git');
    writeConfig(repo, {
      checks: {
        secrets: { enabled: true },
        'no-such-check': { enabled: true },
      },
    });

    const result = loadLintConfig(repo);

    expect(result.error).toBeNull();
    expect(result.checks['no-such-check']).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('no-such-check');
  });

  // 5. enabled: false disables a check
  it('disables a check when enabled is false', () => {
    const repo = mkdir('repo');
    mkdir('repo', '.git');
    writeConfig(repo, {
      checks: { secrets: { enabled: false } },
    });

    const result = loadLintConfig(repo);

    expect(result.checks['secrets'].enabled).toBe(false);
  });

  // 6. Search behavior
  it('finds config by walking parent directories up to the git root', () => {
    const repo = mkdir('repo');
    mkdir('repo', '.git');
    const configPath = writeConfig(repo, { exclude: ['coverage/**'] });
    const nested = mkdir('repo', 'src', 'deep', 'nested');

    const result = loadLintConfig(nested);

    expect(result.configPath).toBe(configPath);
    expect(result.exclude).toEqual(['coverage/**']);
  });

  it('does not search above the git repository root', () => {
    // config lives in the PARENT of the repo root -> must not be found
    writeConfig(tmpDir, { exclude: ['should-not-be-seen/**'] });
    const repo = mkdir('outer', 'repo');
    mkdir('outer', 'repo', '.git');
    const nested = mkdir('outer', 'repo', 'src');

    const result = loadLintConfig(nested);

    expect(result.configPath).toBeNull();
    expect(result.exclude).toEqual([]);
  });

  it('loads exactly explicitPath when given, ignoring search', () => {
    const repo = mkdir('repo');
    mkdir('repo', '.git');
    writeConfig(repo, { exclude: ['from-search/**'] });
    const other = mkdir('elsewhere');
    const explicitPath = path.join(other, 'custom-lint.json');
    fs.writeFileSync(
      explicitPath,
      JSON.stringify({ exclude: ['from-explicit/**'] }),
      'utf8'
    );

    const result = loadLintConfig(repo, explicitPath);

    expect(result.configPath).toBe(explicitPath);
    expect(result.exclude).toEqual(['from-explicit/**']);
  });

  it('returns error when explicitPath does not exist', () => {
    const repo = mkdir('repo');
    mkdir('repo', '.git');
    const missing = path.join(tmpDir, 'nope.json');

    const result = loadLintConfig(repo, missing);

    expect(typeof result.error).toBe('string');
    expect(result.configPath).toBe(missing);
  });

  // 7. Result shape
  it('always returns the documented result shape', () => {
    const repo = mkdir('repo');
    mkdir('repo', '.git');

    const result = loadLintConfig(repo);

    expect(result).toHaveProperty('configPath');
    expect(result).toHaveProperty('exclude');
    expect(result).toHaveProperty('checks');
    expect(result).toHaveProperty('warnings');
    expect(result).toHaveProperty('error');
    for (const entry of Object.values(result.checks)) {
      expect(typeof entry.enabled).toBe('boolean');
      expect(typeof entry.options).toBe('object');
    }
  });

  // Windows path handling: startDir with mixed / non-native separators
  it('accepts startDir with forward-slash and backslash separators', () => {
    const repo = mkdir('repo');
    mkdir('repo', '.git');
    const configPath = writeConfig(repo, { exclude: ['dist/**'] });
    const nested = mkdir('repo', 'src');

    const forwardSlashes = nested.split(path.sep).join('/');
    const resultFwd = loadLintConfig(forwardSlashes);
    expect(resultFwd.configPath).toBe(configPath);

    if (process.platform === 'win32') {
      const backSlashes = nested.split(path.sep).join('\\');
      const resultBack = loadLintConfig(backSlashes);
      expect(resultBack.configPath).toBe(configPath);
    }
  });
});
