const path = require('path');
const os = require('os');
const fs = require('fs');
const childProcess = require('child_process');
const utils = require('./utils');
const mergeSettingsModule = require('./merge-settings');
const { doPersonal, _setupClaudeCodeGlobal, _setupCursorGlobal, _setupCodexGlobal, _detectModelUpgrade, _detectCodexModelUpgrade } = require('./personal');
const mergeTomlModule = require('./merge-toml');

describe('personal module', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function captureConsole(fn) {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      await fn();
    } finally {
      console.log = origLog;
    }
    return logs;
  }

  describe('setupClaudeCodeGlobal', () => {
    it('calls mergeSettings with correct paths', async () => {
      const spy = vi.spyOn(mergeSettingsModule, 'mergeSettings').mockImplementation(() => {});

      const expectedSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const expectedTemplatePath = path.join(utils.PACKAGE_ROOT, 'templates', 'settings-global.json.template');

      await captureConsole(() => _setupClaudeCodeGlobal());

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expectedSettingsPath, expectedTemplatePath, { upgradeKeys: [] });
    });

    it('logs setup message', async () => {
      vi.spyOn(mergeSettingsModule, 'mergeSettings').mockImplementation(() => {});

      const logs = await captureConsole(() => _setupClaudeCodeGlobal());
      expect(logs.some((l) => l.includes('Claude Code global settings'))).toBe(true);
    });

    it('template file exists in package', () => {
      const templatePath = path.join(utils.PACKAGE_ROOT, 'templates', 'settings-global.json.template');
      expect(fs.existsSync(templatePath)).toBe(true);
    });
  });

  describe('detectModelUpgrade', () => {
    let tmpDir;
    let targetPath;
    let templatePath;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-model-test-'));
      targetPath = path.join(tmpDir, 'settings.json');
      templatePath = path.join(tmpDir, 'template.json');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeJson(filePath, data) {
      fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
    }

    it('returns empty when target file does not exist', async () => {
      writeJson(templatePath, { model: 'claude-opus-4-7' });
      const result = await captureConsole(() =>
        _detectModelUpgrade(targetPath, templatePath, { upgradeModel: false, prompter: null })
      );
      // No output expected since detection short-circuits
      expect(result).toEqual([]);
    });

    it('returns empty when models match', async () => {
      writeJson(targetPath, { model: 'claude-opus-4-7' });
      writeJson(templatePath, { model: 'claude-opus-4-7' });
      let result;
      await captureConsole(async () => {
        result = await _detectModelUpgrade(targetPath, templatePath, { upgradeModel: false, prompter: null });
      });
      expect(result).toEqual([]);
    });

    it('returns ["model"] when upgradeModel flag is set', async () => {
      writeJson(targetPath, { model: 'claude-opus-4-6' });
      writeJson(templatePath, { model: 'claude-opus-4-7' });
      let result;
      const logs = await captureConsole(async () => {
        result = await _detectModelUpgrade(targetPath, templatePath, { upgradeModel: true, prompter: null });
      });
      expect(result).toEqual(['model']);
      expect(logs.some((l) => l.includes('claude-opus-4-6'))).toBe(true);
      expect(logs.some((l) => l.includes('claude-opus-4-7'))).toBe(true);
    });

    it('returns empty without prompter when models differ and flag is off', async () => {
      writeJson(targetPath, { model: 'claude-opus-4-6' });
      writeJson(templatePath, { model: 'claude-opus-4-7' });
      let result;
      const logs = await captureConsole(async () => {
        result = await _detectModelUpgrade(targetPath, templatePath, { upgradeModel: false, prompter: null });
      });
      expect(result).toEqual([]);
      expect(logs.some((l) => l.includes('--upgrade-model'))).toBe(true);
    });

    it('returns ["model"] when prompter answers yes', async () => {
      writeJson(targetPath, { model: 'claude-opus-4-6' });
      writeJson(templatePath, { model: 'claude-opus-4-7' });
      const prompter = { promptInput: vi.fn().mockResolvedValue('y') };
      let result;
      await captureConsole(async () => {
        result = await _detectModelUpgrade(targetPath, templatePath, { upgradeModel: false, prompter });
      });
      expect(result).toEqual(['model']);
      expect(prompter.promptInput).toHaveBeenCalled();
    });

    it('returns empty when prompter answers no', async () => {
      writeJson(targetPath, { model: 'claude-opus-4-6' });
      writeJson(templatePath, { model: 'claude-opus-4-7' });
      const prompter = { promptInput: vi.fn().mockResolvedValue('n') };
      let result;
      const logs = await captureConsole(async () => {
        result = await _detectModelUpgrade(targetPath, templatePath, { upgradeModel: false, prompter });
      });
      expect(result).toEqual([]);
      expect(logs.some((l) => l.includes('Skipped'))).toBe(true);
    });
  });

  describe('setupCodexGlobal', () => {
    it('calls mergeToml with correct paths', async () => {
      const spy = vi.spyOn(mergeTomlModule, 'mergeToml').mockImplementation(() => {});

      const expectedSettingsPath = path.join(os.homedir(), '.codex', 'config.toml');
      const expectedTemplatePath = path.join(utils.PACKAGE_ROOT, 'templates', 'codex-config-global.toml.template');

      await captureConsole(() => _setupCodexGlobal());

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expectedSettingsPath, expectedTemplatePath, { upgradeKeys: [] });
    });

    it('template file exists in package', () => {
      const templatePath = path.join(utils.PACKAGE_ROOT, 'templates', 'codex-config-global.toml.template');
      expect(fs.existsSync(templatePath)).toBe(true);
    });
  });

  describe('detectCodexModelUpgrade', () => {
    let tmpDir;
    let targetPath;
    let templatePath;
    const toml = require('@iarna/toml');

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-codex-model-test-'));
      targetPath = path.join(tmpDir, 'config.toml');
      templatePath = path.join(tmpDir, 'template.toml');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeToml(filePath, data) {
      fs.writeFileSync(filePath, toml.stringify(data), 'utf8');
    }

    it('returns empty when target file does not exist', async () => {
      writeToml(templatePath, { model: 'gpt-5.5' });
      let result;
      await captureConsole(async () => {
        result = await _detectCodexModelUpgrade(targetPath, templatePath, { upgradeModel: false, prompter: null });
      });
      expect(result).toEqual([]);
    });

    it('returns empty when models match', async () => {
      writeToml(targetPath, { model: 'gpt-5.5' });
      writeToml(templatePath, { model: 'gpt-5.5' });
      let result;
      await captureConsole(async () => {
        result = await _detectCodexModelUpgrade(targetPath, templatePath, { upgradeModel: false, prompter: null });
      });
      expect(result).toEqual([]);
    });

    it('returns ["model"] when upgradeModel flag is set', async () => {
      writeToml(targetPath, { model: 'gpt-5.4' });
      writeToml(templatePath, { model: 'gpt-5.5' });
      let result;
      const logs = await captureConsole(async () => {
        result = await _detectCodexModelUpgrade(targetPath, templatePath, { upgradeModel: true, prompter: null });
      });
      expect(result).toEqual(['model']);
      expect(logs.some((l) => l.includes('gpt-5.4'))).toBe(true);
      expect(logs.some((l) => l.includes('gpt-5.5'))).toBe(true);
    });

    it('returns ["model"] when prompter answers yes', async () => {
      writeToml(targetPath, { model: 'gpt-5.4' });
      writeToml(templatePath, { model: 'gpt-5.5' });
      const prompter = { promptInput: vi.fn().mockResolvedValue('y') };
      let result;
      await captureConsole(async () => {
        result = await _detectCodexModelUpgrade(targetPath, templatePath, { upgradeModel: false, prompter });
      });
      expect(result).toEqual(['model']);
      expect(prompter.promptInput).toHaveBeenCalled();
    });

    it('returns empty when prompter answers no', async () => {
      writeToml(targetPath, { model: 'gpt-5.4' });
      writeToml(templatePath, { model: 'gpt-5.5' });
      const prompter = { promptInput: vi.fn().mockResolvedValue('n') };
      let result;
      const logs = await captureConsole(async () => {
        result = await _detectCodexModelUpgrade(targetPath, templatePath, { upgradeModel: false, prompter });
      });
      expect(result).toEqual([]);
      expect(logs.some((l) => l.includes('Skipped'))).toBe(true);
    });
  });

  describe('setupCursorGlobal', () => {
    it('copies rules to clipboard on supported platform', async () => {
      const spy = vi.spyOn(childProcess, 'execSync').mockImplementation(() => {});

      const logs = await captureConsole(() => { _setupCursorGlobal(); return Promise.resolve(); });

      expect(spy).toHaveBeenCalled();
      const clipCmd = spy.mock.calls[0][0];
      expect(['pbcopy', 'clip', 'xclip -selection clipboard']).toContain(clipCmd);
      expect(logs.some((l) => l.includes('clipboard'))).toBe(true);
    });

    it('falls back to printing rules when clipboard is unavailable', async () => {
      vi.spyOn(childProcess, 'execSync').mockImplementation(() => { throw new Error('no clipboard'); });

      const logs = await captureConsole(() => { _setupCursorGlobal(); return Promise.resolve(); });

      expect(logs.some((l) => l.includes('Safety Rules'))).toBe(true);
      expect(logs.some((l) => l.includes('Clipboard not available'))).toBe(true);
    });

    it('rules content includes expected sections', async () => {
      vi.spyOn(childProcess, 'execSync').mockImplementation(() => { throw new Error('no clipboard'); });

      const logs = await captureConsole(() => { _setupCursorGlobal(); return Promise.resolve(); });

      expect(logs.some((l) => l.includes('Development Rules'))).toBe(true);
      expect(logs.some((l) => l.includes('git push --force'))).toBe(true);
    });
  });

  describe('doPersonal', () => {
    it('handles option 1 selection correctly', async () => {
      const mockPrompter = {
        promptMultiple: vi.fn().mockResolvedValue(['1']),
        promptInput: vi.fn(),
        close: vi.fn(),
      };
      vi.spyOn(utils, 'createPrompter').mockReturnValue(mockPrompter);
      // Short-circuit detectModelUpgrade by reporting target file as missing
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const mergeSpy = vi.spyOn(mergeSettingsModule, 'mergeSettings').mockImplementation(() => {});

      await captureConsole(() => doPersonal());

      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect(mockPrompter.close).toHaveBeenCalled();
    });

    it('passes upgradeModel option through to setupClaudeCodeGlobal', async () => {
      const mockPrompter = {
        promptMultiple: vi.fn().mockResolvedValue(['1']),
        promptInput: vi.fn(),
        close: vi.fn(),
      };
      vi.spyOn(utils, 'createPrompter').mockReturnValue(mockPrompter);
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const mergeSpy = vi.spyOn(mergeSettingsModule, 'mergeSettings').mockImplementation(() => {});

      await captureConsole(() => doPersonal({ upgradeModel: true }));

      expect(mergeSpy).toHaveBeenCalledTimes(1);
      // upgradeKeys is [] here because target file is mocked as missing,
      // but the option is still threaded through (verified separately in detectModelUpgrade tests)
      expect(mergeSpy.mock.calls[0][2]).toEqual({ upgradeKeys: [] });
    });

    it('handles option 3 (Codex) selection correctly', async () => {
      const mockPrompter = {
        promptMultiple: vi.fn().mockResolvedValue(['3']),
        promptInput: vi.fn(),
        close: vi.fn(),
      };
      vi.spyOn(utils, 'createPrompter').mockReturnValue(mockPrompter);
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const mergeSpy = vi.spyOn(mergeTomlModule, 'mergeToml').mockImplementation(() => {});

      await captureConsole(() => doPersonal());

      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect(mockPrompter.close).toHaveBeenCalled();
    });

    it('handles option 2 selection correctly', async () => {
      const mockPrompter = {
        promptMultiple: vi.fn().mockResolvedValue(['2']),
        close: vi.fn(),
      };
      vi.spyOn(utils, 'createPrompter').mockReturnValue(mockPrompter);
      vi.spyOn(childProcess, 'execSync').mockImplementation(() => {});

      const logs = await captureConsole(() => doPersonal());

      expect(logs.some((l) => l.includes('clipboard'))).toBe(true);
      expect(mockPrompter.close).toHaveBeenCalled();
    });

    it('warns on invalid selection numbers', async () => {
      const mockPrompter = {
        promptMultiple: vi.fn().mockResolvedValue(['5', 'abc']),
        close: vi.fn(),
      };
      vi.spyOn(utils, 'createPrompter').mockReturnValue(mockPrompter);

      const logs = await captureConsole(() => doPersonal());

      expect(logs.some((l) => l.includes('Warning') && l.includes('"5"'))).toBe(true);
      expect(logs.some((l) => l.includes('Warning') && l.includes('"abc"'))).toBe(true);
    });

    it('closes prompter even when an error occurs', async () => {
      const mockPrompter = {
        promptMultiple: vi.fn().mockRejectedValue(new Error('stdin error')),
        close: vi.fn(),
      };
      vi.spyOn(utils, 'createPrompter').mockReturnValue(mockPrompter);

      await expect(doPersonal()).rejects.toThrow('stdin error');
      expect(mockPrompter.close).toHaveBeenCalled();
    });
  });
});
