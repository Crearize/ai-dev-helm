const fs = require('fs');
const path = require('path');
const os = require('os');
const { PACKAGE_ROOT, SKILL_SCOPE, copyDirSync, linkOrCopy } = require('./utils');
const {
  writeVersionManifest,
  ensureGitignoreEntries,
  copyLintAssets,
  upgradeCodexHooksFile,
  ensureClaudeGateRegistration,
  seedTestRecommendationLedger,
} = require('./init');

describe('init integration', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Claude Code setup', () => {
    it('creates .claude directory structure', () => {
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(path.join(claudeDir, 'rules'), { recursive: true });

      expect(fs.existsSync(path.join(claudeDir, 'rules'))).toBe(true);
    });

    it('copies settings.json from template', () => {
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const templatePath = path.join(PACKAGE_ROOT, 'templates', 'settings.json.template');
      const settingsDest = path.join(claudeDir, 'settings.json');

      fs.copyFileSync(templatePath, settingsDest);

      expect(fs.existsSync(settingsDest)).toBe(true);
      const content = JSON.parse(fs.readFileSync(settingsDest, 'utf8'));
      expect(content).toBeDefined();
    });

    it('copies CLAUDE.md from template', () => {
      const templatePath = path.join(PACKAGE_ROOT, 'templates', 'CLAUDE.md.template');
      const dest = path.join(tmpDir, 'CLAUDE.md');

      fs.copyFileSync(templatePath, dest);

      expect(fs.existsSync(dest)).toBe(true);
      const content = fs.readFileSync(dest, 'utf8');
      expect(content).toContain('{{PROJECT_NAME}}');
    });

    it('does not overwrite existing CLAUDE.md', () => {
      const dest = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(dest, 'existing content');

      // Simulate the check
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(
          path.join(PACKAGE_ROOT, 'templates', 'CLAUDE.md.template'),
          dest
        );
      }

      expect(fs.readFileSync(dest, 'utf8')).toBe('existing content');
    });
  });

  // mergeSettings preserves the existing `hooks` key verbatim (user hooks are
  // never clobbered), so re-running init alone would leave the gate hook
  // registered the way an older release wrote it — or not registered at all.
  // Meanwhile the hook body next to it is always overwritten with the current
  // release, whose internal deadline is 20s. A stale `timeout: 10` (or a
  // missing registration) therefore means the harness kills the gate before it
  // prints, and a PreToolUse hook that prints nothing reads as "allowed".
  describe('ensureClaudeGateRegistration', () => {
    const gateCommand = 'node .claude/hooks/quality-gate.cjs';

    function writeSettings(contents) {
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const dest = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(
        dest,
        typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2) + '\n'
      );
      return dest;
    }

    function gateHooks(parsed) {
      return (parsed.hooks?.PreToolUse || [])
        .flatMap((entry) => (Array.isArray(entry.hooks) ? entry.hooks : []))
        .filter((hook) => typeof hook.command === 'string' && hook.command.includes('quality-gate.cjs'));
    }

    it('raises a stale quality-gate timeout in settings.json', () => {
      const dest = writeSettings({
        permissions: { deny: ['Bash(rm -rf /)'], allow: [] },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: gateCommand, timeout: 10 },
                { type: 'command', command: 'node my-custom-hook.js', timeout: 5 },
              ],
            },
          ],
        },
      });

      ensureClaudeGateRegistration(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      const [gate, custom] = parsed.hooks.PreToolUse[0].hooks;
      expect(gate.timeout).toBe(30);
      expect(custom.timeout).toBe(5); // user hooks untouched
      expect(parsed.permissions.deny).toEqual(['Bash(rm -rf /)']);
    });

    it('raises a quality-gate entry that carries no timeout at all', () => {
      const dest = writeSettings({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: gateCommand }] }],
        },
      });

      ensureClaudeGateRegistration(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      expect(parsed.hooks.PreToolUse[0].hooks[0].timeout).toBe(30);
    });

    it('registers the gate when settings.json has no hooks block, preserving other keys', () => {
      const dest = writeSettings({
        permissions: { deny: ['Bash(rm -rf /)'], allow: ['Bash(ls:*)'] },
        model: 'opus',
      });

      ensureClaudeGateRegistration(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      const gates = gateHooks(parsed);
      expect(gates).toHaveLength(1);
      expect(gates[0].command).toBe(gateCommand);
      expect(gates[0].timeout).toBe(30);
      expect(parsed.permissions).toEqual({ deny: ['Bash(rm -rf /)'], allow: ['Bash(ls:*)'] });
      expect(parsed.model).toBe('opus');
    });

    it('registers the gate alongside unrelated user hooks instead of replacing them', () => {
      const dest = writeSettings({
        hooks: {
          PostToolUse: [
            { matcher: 'Write', hooks: [{ type: 'command', command: 'node format.js' }] },
          ],
          PreToolUse: [
            { matcher: 'Read', hooks: [{ type: 'command', command: 'node audit.js', timeout: 3 }] },
          ],
        },
      });

      ensureClaudeGateRegistration(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe('node format.js');
      expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('node audit.js');
      expect(parsed.hooks.PreToolUse[0].hooks[0].timeout).toBe(3);
      expect(gateHooks(parsed)).toHaveLength(1);
    });

    it('does not rewrite a settings.json that already registers the gate at the minimum timeout', () => {
      const dest = writeSettings({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: gateCommand, timeout: 30 }] },
          ],
        },
      });
      const before = fs.readFileSync(dest, 'utf8');
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      ensureClaudeGateRegistration(dest);

      expect(writeSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(dest, 'utf8')).toBe(before);
      writeSpy.mockRestore();
    });

    // The freshly distributed template already carries the gate at timeout 30,
    // so the repair must be a no-op there — never a second registration.
    it('is a no-op on a settings.json copied straight from the template', () => {
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const dest = path.join(claudeDir, 'settings.json');
      fs.copyFileSync(path.join(PACKAGE_ROOT, 'templates', 'settings.json.template'), dest);
      const before = fs.readFileSync(dest, 'utf8');
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      ensureClaudeGateRegistration(dest);

      expect(writeSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(dest, 'utf8')).toBe(before);
      writeSpy.mockRestore();
    });

    it('leaves a settings.json with a non-object "hooks" key unchanged and warns', () => {
      const dest = writeSettings({ hooks: ['junk'] });
      const before = fs.readFileSync(dest, 'utf8');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      ensureClaudeGateRegistration(dest);

      expect(fs.readFileSync(dest, 'utf8')).toBe(before);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('non-object "hooks" key'));
      warnSpy.mockRestore();
    });

    it('leaves a settings.json with a non-array "hooks.PreToolUse" unchanged and warns', () => {
      const dest = writeSettings({ hooks: { PreToolUse: { matcher: 'Bash' } } });
      const before = fs.readFileSync(dest, 'utf8');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      ensureClaudeGateRegistration(dest);

      expect(fs.readFileSync(dest, 'utf8')).toBe(before);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"hooks.PreToolUse"'));
      warnSpy.mockRestore();
    });

    it('leaves an unparsable settings.json unchanged and warns', () => {
      const dest = writeSettings('{ not json\n');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      ensureClaudeGateRegistration(dest);

      expect(fs.readFileSync(dest, 'utf8')).toBe('{ not json\n');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not parse'));
      warnSpy.mockRestore();
    });

    it('leaves a non-object settings.json root (valid JSON) unchanged and warns', () => {
      const dest = writeSettings(['not', 'an', 'object']);
      const before = fs.readFileSync(dest, 'utf8');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      ensureClaudeGateRegistration(dest);

      expect(fs.readFileSync(dest, 'utf8')).toBe(before);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a JSON object'));
      warnSpy.mockRestore();
    });

    // A registration parked under a matcher that doesn't cover Bash calls
    // (e.g. `Read`) never actually gates Bash, so it must not count as "the
    // gate is registered" — otherwise a decoy or a mis-scoped entry silently
    // leaves Bash ungated.
    it('does not treat a gate hook registered only under a non-Bash matcher as already registered', () => {
      const dest = writeSettings({
        hooks: {
          PreToolUse: [
            { matcher: 'Read', hooks: [{ type: 'command', command: gateCommand, timeout: 30 }] },
          ],
        },
      });

      ensureClaudeGateRegistration(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      // The Read-scoped entry is left alone (not touched/removed)...
      expect(parsed.hooks.PreToolUse[0].matcher).toBe('Read');
      expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe(gateCommand);
      // ...and a real Bash-scoped registration is added alongside it.
      const bashScoped = parsed.hooks.PreToolUse.find((e) => e.matcher !== 'Read');
      expect(bashScoped).toBeDefined();
      expect(gateHooks(parsed)).toHaveLength(2);
    });

    // A command that merely mentions "quality-gate.cjs" as a substring (a
    // similarly-named backup file, a log message) must not be mistaken for a
    // real invocation of the script.
    it('does not treat a command that only resembles the gate script as already registered', () => {
      const dest = writeSettings({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node quality-gate.cjs.bak' }] },
          ],
        },
      });

      ensureClaudeGateRegistration(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      // The decoy entry is left alone (not touched/removed)...
      expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('node quality-gate.cjs.bak');
      // ...and a real registration is appended as its own entry.
      const gates = gateHooks(parsed).filter((h) => h.command === gateCommand);
      expect(gates).toHaveLength(1);
      expect(gates[0].timeout).toBe(30);
    });

    it('warns with the ACTION REQUIRED format and returns the warning when the file shape is not understood', () => {
      const dest = writeSettings({ hooks: ['junk'] });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = ensureClaudeGateRegistration(dest);

      const expected =
        `ACTION REQUIRED: quality-gate hook is NOT registered in ${dest} ` +
        '(non-object "hooks" key). Register it manually or fix the file and re-run init.';
      expect(result).toBe(expected);
      expect(warnSpy).toHaveBeenCalledWith(expected);
      warnSpy.mockRestore();
    });

    // M4 (quality-check cycle 2): registerGateFromTemplate must escalate an
    // unreadable shipped template to the same ACTION REQUIRED warning as an
    // unreadable *user* file, not a bare console.warn that init's summary
    // recap never sees.
    it('returns ACTION REQUIRED and warns when settings.json.template cannot be read', () => {
      const dest = writeSettings({});
      const templatePath = path.join(PACKAGE_ROOT, 'templates', 'settings.json.template');
      const realReadFileSync = fs.readFileSync.bind(fs);
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
        if (p === templatePath) throw new Error('boom');
        return realReadFileSync(p, ...rest);
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const result = ensureClaudeGateRegistration(dest);

        const expected =
          `ACTION REQUIRED: quality-gate hook is NOT registered in ${dest} ` +
          '(the shipped hook template could not be read). Register it manually or fix the file and re-run init.';
        expect(result).toBe(expected);
        expect(warnSpy).toHaveBeenCalledWith(expected);
      } finally {
        readSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    // M5 (quality-check cycle 2): the old registration regex
    // `/(^|[\\/\s])(node\s+)?[^\s]*quality-gate\.cjs(\s|$)/` is unanchored,
    // so anything that merely *mentions* the filename anywhere in a command
    // reads as "gate already registered" - these decoys must instead be
    // treated as unrelated commands and get a real registration appended
    // alongside them.
    it.each([
      ['echo skipping quality-gate.cjs'],
      ['cat quality-gate.cjs'],
      ['true # quality-gate.cjs'],
    ])('does not treat "%s" as a real gate invocation', (decoyCommand) => {
      const dest = writeSettings({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: decoyCommand }] }],
        },
      });

      ensureClaudeGateRegistration(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe(decoyCommand);
      const gates = gateHooks(parsed).filter((h) => h.command === gateCommand);
      expect(gates).toHaveLength(1);
      expect(gates[0].timeout).toBe(30);
    });

    // The anchored regex must still recognize the exact command string the
    // shipped template registers - fixture-pinned so a future template
    // format change (quoting, path separator) is caught by this test.
    it('recognizes the exact command string from settings.json.template as already registered', () => {
      const templatePath = path.join(PACKAGE_ROOT, 'templates', 'settings.json.template');
      const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
      const templateCommand = template.hooks.PreToolUse[0].hooks[0].command;
      expect(templateCommand).toBe('node .claude/hooks/quality-gate.cjs');

      const dest = writeSettings({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: templateCommand, timeout: 30 }] }],
        },
      });
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      try {
        ensureClaudeGateRegistration(dest);

        expect(writeSpy).not.toHaveBeenCalled();
      } finally {
        writeSpy.mockRestore();
      }
    });

    // L23 (quality-check cycle 2, round 3): a quoted hook path containing a
    // space (Windows install paths commonly have one, e.g. "C:\Program
    // Files\nodejs\node.exe" or a repo checked out under "My Projects") used
    // to fail the anchored regex - `\S*[\\/]` cannot cross a space - so a
    // registration in this shape read as "not yet registered" and init
    // appended a second, redundant entry on every re-run.
    it('recognizes a quoted script path containing spaces as already registered', () => {
      const quotedCommand = 'node "C:\\My Projects\\repo\\.claude\\hooks\\quality-gate.cjs"';
      const dest = writeSettings({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: quotedCommand, timeout: 30 }] }],
        },
      });
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      try {
        ensureClaudeGateRegistration(dest);

        expect(writeSpy).not.toHaveBeenCalled();
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('recognizes a quoted node executable containing spaces as already registered', () => {
      const quotedCommand = '"C:\\Program Files\\nodejs\\node.exe" .claude/hooks/quality-gate.cjs';
      const dest = writeSettings({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: quotedCommand, timeout: 30 }] }],
        },
      });
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      try {
        ensureClaudeGateRegistration(dest);

        expect(writeSpy).not.toHaveBeenCalled();
      } finally {
        writeSpy.mockRestore();
      }
    });

    // L6 (quality-check cycle 2): matcherTargetsBash used to treat any
    // matcher string *containing* the substring "Bash" as Bash-scoped, so
    // "Bashful" or "NotBash" wrongly counted as covering Bash tool calls.
    // It must instead test the matcher as a regular expression against the
    // literal string "Bash" (falling back to an exact-match comparison for
    // an invalid regex), and treat an absent/empty matcher (Claude Code's
    // "all tools" default) as Bash-scoped.
    it.each([['NotBash'], ['Bashful']])(
      'does not treat matcher "%s" as covering Bash calls',
      (matcher) => {
        const dest = writeSettings({
          hooks: {
            PreToolUse: [{ matcher, hooks: [{ type: 'command', command: gateCommand, timeout: 30 }] }],
          },
        });

        ensureClaudeGateRegistration(dest);

        const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
        // The non-Bash-scoped entry is left alone...
        expect(parsed.hooks.PreToolUse[0].matcher).toBe(matcher);
        // ...and a real Bash-scoped registration is added alongside it.
        expect(gateHooks(parsed)).toHaveLength(2);
      }
    );

    it.each([['^Bash$'], ['Bash|Edit'], ['']])(
      'treats matcher "%s" as already covering Bash calls (no duplicate registration)',
      (matcher) => {
        const dest = writeSettings({
          hooks: {
            PreToolUse: [{ matcher, hooks: [{ type: 'command', command: gateCommand, timeout: 30 }] }],
          },
        });
        const writeSpy = vi.spyOn(fs, 'writeFileSync');

        try {
          ensureClaudeGateRegistration(dest);

          expect(writeSpy).not.toHaveBeenCalled();
        } finally {
          writeSpy.mockRestore();
        }
      }
    );

    it('treats an unspecified matcher as already covering Bash calls (no duplicate registration)', () => {
      const dest = writeSettings({
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: gateCommand, timeout: 30 }] }],
        },
      });
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      try {
        ensureClaudeGateRegistration(dest);

        expect(writeSpy).not.toHaveBeenCalled();
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('falls back to an exact-match comparison when the matcher is not a valid regular expression', () => {
      // "Bash(" is not a valid RegExp (unterminated group) - it must not be
      // treated as Bash-scoped via the invalid-regex fallback (exact match
      // against the literal string "Bash" only).
      const dest = writeSettings({
        hooks: {
          PreToolUse: [{ matcher: 'Bash(', hooks: [{ type: 'command', command: gateCommand, timeout: 30 }] }],
        },
      });

      ensureClaudeGateRegistration(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      expect(gateHooks(parsed)).toHaveLength(2);
    });
  });

  describe('ensureGitignoreEntries', () => {
    it('creates .gitignore with workflow artifact entries when absent', () => {
      ensureGitignoreEntries(tmpDir);

      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
      expect(content).toContain('.superpowers/');
      expect(content).toContain('docs/superpowers/plans/');
      expect(content).toContain('.worktrees/');
      expect(content).toContain('.quality-check-report.json');
      expect(content).toContain('.quality-check-passed');
      expect(content).toContain('.stryker-tmp/');
      expect(content).toContain('reports/mutation/');
    });

    it('appends only missing entries to an existing .gitignore', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\n.superpowers/\n');

      ensureGitignoreEntries(tmpDir);

      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toContain('node_modules/');
      expect(content.match(/^\.superpowers\/$/gm)).toHaveLength(1);
      expect(content).toContain('.quality-check-passed');
    });

    it('is idempotent across repeated runs', () => {
      ensureGitignoreEntries(tmpDir);
      const first = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');

      ensureGitignoreEntries(tmpDir);
      const second = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');

      expect(second).toBe(first);
    });

    it('does not write in dry-run mode', () => {
      ensureGitignoreEntries(tmpDir, { dryRun: true });

      expect(fs.existsSync(path.join(tmpDir, '.gitignore'))).toBe(false);
    });
  });

  describe('Cursor setup', () => {
    it('creates .cursor directory structure', () => {
      const cursorDir = path.join(tmpDir, '.cursor');
      fs.mkdirSync(path.join(cursorDir, 'rules'), { recursive: true });

      expect(fs.existsSync(path.join(cursorDir, 'rules'))).toBe(true);
    });
  });

  describe('Codex setup', () => {
    it('creates .codex directory structure', () => {
      const codexDir = path.join(tmpDir, '.codex');
      fs.mkdirSync(path.join(codexDir, 'rules'), { recursive: true });

      expect(fs.existsSync(path.join(codexDir, 'rules'))).toBe(true);
    });

    it('copies AGENTS.md from template', () => {
      const templatePath = path.join(PACKAGE_ROOT, 'templates', 'AGENTS.md.template');
      const dest = path.join(tmpDir, 'AGENTS.md');

      fs.copyFileSync(templatePath, dest);

      expect(fs.existsSync(dest)).toBe(true);
      const content = fs.readFileSync(dest, 'utf8');
      expect(content).toContain('{{PROJECT_NAME}}');
    });

    it('copies codex config.toml from template', () => {
      const codexDir = path.join(tmpDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const templatePath = path.join(PACKAGE_ROOT, 'templates', 'codex-config.toml.template');
      const dest = path.join(codexDir, 'config.toml');

      fs.copyFileSync(templatePath, dest);

      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(dest, 'utf8')).toContain('approval_policy');
    });

    it('copies codex hooks.json from template', () => {
      const codexDir = path.join(tmpDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const templatePath = path.join(PACKAGE_ROOT, 'templates', 'codex-hooks.json.template');
      const dest = path.join(codexDir, 'hooks.json');

      fs.copyFileSync(templatePath, dest);

      expect(fs.existsSync(dest)).toBe(true);
      const content = JSON.parse(fs.readFileSync(dest, 'utf8'));
      // Codex's real schema nests events under a top-level `hooks` key
      // (see #112) — a bare top-level `PreToolUse` key is silently ignored.
      const gate = content.hooks.PreToolUse[0].hooks[0];
      expect(gate.command).toBe('node .codex/hooks/quality-gate.cjs');
      expect(gate.timeout).toBe(30);
    });

    // The old template registered the gate hook with timeout 10, shorter
    // than the hook's own 20s deadline — the harness killed it mid-decision
    // and silence reads as "allowed". Re-running init must repair that.
    //
    // The old template (and any project that ran an older init) also placed
    // event names at the top level instead of under `hooks`, which Codex
    // does not recognize (#112) — re-running init must migrate the file in
    // place, not just patch the timeout inside a structure Codex ignores.
    it('migrates a legacy top-level hooks.json and raises a stale quality-gate timeout', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(
        dest,
        JSON.stringify({
          PreToolUse: [
            {
              matcher: '^Bash$',
              hooks: [
                { type: 'command', command: 'node .codex/hooks/quality-gate.cjs', timeout: 10 },
                { type: 'command', command: 'node my-custom-hook.js', timeout: 5 },
              ],
            },
          ],
        }) + '\n'
      );

      upgradeCodexHooksFile(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      expect(parsed.PreToolUse).toBeUndefined(); // legacy top-level key removed
      const [gate, custom] = parsed.hooks.PreToolUse[0].hooks;
      expect(gate.timeout).toBe(30);
      expect(custom.timeout).toBe(5); // user hooks untouched
    });

    it('migrates a legacy top-level hooks.json even when no timeout needs raising', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(
        dest,
        JSON.stringify({
          PreToolUse: [
            {
              matcher: '^Bash$',
              hooks: [
                { type: 'command', command: 'node .codex/hooks/quality-gate.cjs', timeout: 30 },
              ],
            },
          ],
        }) + '\n'
      );

      upgradeCodexHooksFile(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      expect(parsed.PreToolUse).toBeUndefined();
      expect(parsed.hooks.PreToolUse[0].hooks[0].timeout).toBe(30);
    });

    // hooks.json is user-owned: a top-level array that is not shaped like a
    // hook-event registration (no matcher entries with a `hooks` list) must
    // stay at the top level instead of being folded under `hooks`, where
    // Codex would never read it.
    it('leaves non-event top-level arrays in place while migrating legacy events', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(
        dest,
        JSON.stringify({
          PreToolUse: [
            {
              matcher: '^Bash$',
              hooks: [
                { type: 'command', command: 'node .codex/hooks/quality-gate.cjs', timeout: 30 },
              ],
            },
          ],
          trustedRoots: ['/home/me/work', '/srv/repo'],
          tags: [],
          version: 2,
        }) + '\n'
      );

      upgradeCodexHooksFile(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      expect(parsed.PreToolUse).toBeUndefined();
      expect(parsed.hooks.PreToolUse[0].hooks[0].timeout).toBe(30);
      expect(parsed.trustedRoots).toEqual(['/home/me/work', '/srv/repo']);
      expect(parsed.tags).toEqual([]);
      expect(parsed.version).toBe(2);
      expect(Object.keys(parsed.hooks)).toEqual(['PreToolUse']);
    });

    it('raises a stale quality-gate timeout in an already-current (top-level hooks) file', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(
        dest,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: '^Bash$',
                hooks: [
                  { type: 'command', command: 'node .codex/hooks/quality-gate.cjs', timeout: 10 },
                  { type: 'command', command: 'node my-custom-hook.js', timeout: 5 },
                ],
              },
            ],
          },
        }) + '\n'
      );

      upgradeCodexHooksFile(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      const [gate, custom] = parsed.hooks.PreToolUse[0].hooks;
      expect(gate.timeout).toBe(30);
      expect(custom.timeout).toBe(5); // user hooks untouched
    });

    it('leaves an unparsable hooks.json unchanged', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(dest, '{ not json\n');

      upgradeCodexHooksFile(dest);

      expect(fs.readFileSync(dest, 'utf8')).toBe('{ not json\n');
    });

    it('leaves a hooks.json with a non-object "hooks" key unchanged and warns', () => {
      // A `hooks` key that is itself an array would collide with the
      // migration's `hooksObject` and get silently overwritten if treated
      // as "no hooks key yet" — this shape must be refused instead.
      const dest = path.join(tmpDir, 'hooks.json');
      const original =
        JSON.stringify({
          hooks: ['junk'],
          PreToolUse: [
            {
              matcher: '^Bash$',
              hooks: [
                { type: 'command', command: 'node .codex/hooks/quality-gate.cjs', timeout: 10 },
              ],
            },
          ],
        }) + '\n';
      fs.writeFileSync(dest, original);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      upgradeCodexHooksFile(dest);

      expect(fs.readFileSync(dest, 'utf8')).toBe(original);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('non-object "hooks" key')
      );
      warnSpy.mockRestore();
    });

    it('leaves a non-object hooks.json root (valid JSON) unchanged and warns', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(dest, JSON.stringify(['not', 'an', 'object']) + '\n');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      upgradeCodexHooksFile(dest);

      expect(fs.readFileSync(dest, 'utf8')).toBe(
        JSON.stringify(['not', 'an', 'object']) + '\n'
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a JSON object'));
      warnSpy.mockRestore();
    });

    it('does not rewrite a hooks.json that is already current (new structure, timeout satisfied)', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      const content =
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: '^Bash$',
                  hooks: [
                    { type: 'command', command: 'node .codex/hooks/quality-gate.cjs', timeout: 30 },
                  ],
                },
              ],
            },
          },
          null,
          2
        ) + '\n';
      fs.writeFileSync(dest, content);
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      upgradeCodexHooksFile(dest);

      expect(writeSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(dest, 'utf8')).toBe(content);
      writeSpy.mockRestore();
    });

    // Parity with ensureClaudeGateRegistration's timeout condition: a gate
    // entry that carries no `timeout` key at all is just as unsafe as one
    // below the floor (the harness default may be shorter than the hook's
    // 20s internal deadline), so it must be raised too, not only entries
    // that already carry a too-low numeric timeout.
    it('raises a quality-gate entry that carries no timeout at all (parity with the Claude side)', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(
        dest,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: '^Bash$',
                hooks: [{ type: 'command', command: 'node .codex/hooks/quality-gate.cjs' }],
              },
            ],
          },
        }) + '\n'
      );

      upgradeCodexHooksFile(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      expect(parsed.hooks.PreToolUse[0].hooks[0].timeout).toBe(30);
    });

    // Symmetric with ensureClaudeGateRegistration: when hooks.PreToolUse
    // carries no Bash-scoped quality-gate entry at all, take the
    // registration from templates/codex-hooks.json.template so Codex gets
    // the same self-healing behavior Claude Code already has.
    it('registers the gate from the template into hooks.PreToolUse when hooks.json has none, preserving existing hooks', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(
        dest,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: 'Read', hooks: [{ type: 'command', command: 'node audit.js', timeout: 3 }] },
            ],
          },
        }) + '\n'
      );

      upgradeCodexHooksFile(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      // Existing user hook untouched.
      expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('node audit.js');
      // Gate appended from the template.
      const gateEntry = parsed.hooks.PreToolUse.find((e) =>
        (e.hooks || []).some(
          (h) => typeof h.command === 'string' && h.command.includes('quality-gate.cjs')
        )
      );
      expect(gateEntry).toBeDefined();
      const gateHook = gateEntry.hooks.find((h) => h.command.includes('quality-gate.cjs'));
      expect(gateHook.command).toBe('node .codex/hooks/quality-gate.cjs');
      expect(gateHook.timeout).toBe(30);
    });

    it('warns with the ACTION REQUIRED format and returns the warning when hooks.json cannot be parsed', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(dest, '{ not json\n');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = upgradeCodexHooksFile(dest);

      const expected =
        `ACTION REQUIRED: quality-gate hook is NOT registered in ${dest} ` +
        '(could not parse the file). Register it manually or fix the file and re-run init.';
      expect(result).toBe(expected);
      expect(warnSpy).toHaveBeenCalledWith(expected);
      warnSpy.mockRestore();
    });

    // M4 (quality-check cycle 2): registerGateFromTemplate must escalate an
    // unreadable shipped template to the same ACTION REQUIRED warning as an
    // unreadable *user* file (parity with ensureClaudeGateRegistration),
    // not the bare console.warn init's summary recap never sees.
    it('returns ACTION REQUIRED and warns when codex-hooks.json.template cannot be read', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(dest, JSON.stringify({}) + '\n');
      const templatePath = path.join(PACKAGE_ROOT, 'templates', 'codex-hooks.json.template');
      const realReadFileSync = fs.readFileSync.bind(fs);
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
        if (p === templatePath) throw new Error('boom');
        return realReadFileSync(p, ...rest);
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const result = upgradeCodexHooksFile(dest);

        const expected =
          `ACTION REQUIRED: quality-gate hook is NOT registered in ${dest} ` +
          '(the shipped hook template could not be read). Register it manually or fix the file and re-run init.';
        expect(result).toBe(expected);
        expect(warnSpy).toHaveBeenCalledWith(expected);
      } finally {
        readSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    // M5 (quality-check cycle 2): same anchoring fix as the Claude side -
    // a command that merely mentions "quality-gate.cjs" in passing must not
    // be mistaken for a real invocation.
    it.each([
      ['echo skipping quality-gate.cjs'],
      ['cat quality-gate.cjs'],
      ['true # quality-gate.cjs'],
    ])('does not treat "%s" as a real gate invocation (Codex)', (decoyCommand) => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(
        dest,
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: decoyCommand }] }],
          },
        }) + '\n'
      );

      upgradeCodexHooksFile(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe(decoyCommand);
      const gateEntry = parsed.hooks.PreToolUse.find((e) =>
        (e.hooks || []).some((h) => h.command === 'node .codex/hooks/quality-gate.cjs')
      );
      expect(gateEntry).toBeDefined();
    });

    // The anchored regex must still recognize the exact command string the
    // shipped template registers, fixture-pinned against the real file so a
    // future template format change is caught here.
    it('is a no-op on a hooks.json copied straight from codex-hooks.json.template', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.copyFileSync(path.join(PACKAGE_ROOT, 'templates', 'codex-hooks.json.template'), dest);
      const before = fs.readFileSync(dest, 'utf8');
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      try {
        upgradeCodexHooksFile(dest);

        expect(writeSpy).not.toHaveBeenCalled();
        expect(fs.readFileSync(dest, 'utf8')).toBe(before);
      } finally {
        writeSpy.mockRestore();
      }
    });

    // L7 (quality-check cycle 2): the existing "no timeout at all" parity
    // test only covers the already-current (new `hooks` object) shape. A
    // legacy top-level file whose quality-gate entry has no `timeout` key
    // must get both the migration AND the timeout floor in the same pass -
    // that combination was untested.
    it('migrates a legacy top-level hooks.json and raises a quality-gate entry that carries no timeout at all', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(
        dest,
        JSON.stringify({
          PreToolUse: [
            {
              matcher: '^Bash$',
              hooks: [{ type: 'command', command: 'node .codex/hooks/quality-gate.cjs' }],
            },
          ],
        }) + '\n'
      );

      upgradeCodexHooksFile(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      expect(parsed.PreToolUse).toBeUndefined(); // legacy top-level key removed
      expect(parsed.hooks.PreToolUse[0].hooks[0].timeout).toBe(30);
    });

    it('does not overwrite existing AGENTS.md', () => {
      const dest = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(dest, 'existing content');

      if (!fs.existsSync(dest)) {
        fs.copyFileSync(
          path.join(PACKAGE_ROOT, 'templates', 'AGENTS.md.template'),
          dest
        );
      }

      expect(fs.readFileSync(dest, 'utf8')).toBe('existing content');
    });
  });

  describe('skill copying', () => {
    it('copies superpowers skills', () => {
      const skillsDest = path.join(tmpDir, 'skills', 'superpowers');
      copyDirSync(
        path.join(PACKAGE_ROOT, 'skills', 'superpowers'),
        skillsDest
      );

      expect(fs.existsSync(skillsDest)).toBe(true);
      // Should contain at least one SKILL.md
      const brainstormSkill = path.join(skillsDest, 'brainstorming', 'SKILL.md');
      expect(fs.existsSync(brainstormSkill)).toBe(true);
    });

    it('copies project skills', () => {
      const skillsDest = path.join(tmpDir, 'skills', 'project');
      copyDirSync(
        path.join(PACKAGE_ROOT, 'skills', 'project'),
        skillsDest
      );

      expect(fs.existsSync(skillsDest)).toBe(true);
      const qualitySkill = path.join(skillsDest, 'quality-check', 'SKILL.md');
      expect(fs.existsSync(qualitySkill)).toBe(true);
    });
  });

  describe('template replacement', () => {
    it('replaces {{PROJECT_NAME}} placeholder', () => {
      const dest = path.join(tmpDir, 'CLAUDE.md');
      fs.copyFileSync(
        path.join(PACKAGE_ROOT, 'templates', 'CLAUDE.md.template'),
        dest
      );

      let content = fs.readFileSync(dest, 'utf8');
      const projectName = 'TestProject';
      content = content.replace(/\{\{PROJECT_NAME\}\}/g, () => projectName);
      fs.writeFileSync(dest, content, 'utf8');

      const result = fs.readFileSync(dest, 'utf8');
      expect(result).toContain('TestProject');
      expect(result).not.toContain('{{PROJECT_NAME}}');
    });

    it('replaces {{PROJECT_NAME}} placeholder in AGENTS.md', () => {
      const dest = path.join(tmpDir, 'AGENTS.md');
      fs.copyFileSync(
        path.join(PACKAGE_ROOT, 'templates', 'AGENTS.md.template'),
        dest
      );

      let content = fs.readFileSync(dest, 'utf8');
      const projectName = 'CodexTestProject';
      content = content.replace(/\{\{PROJECT_NAME\}\}/g, () => projectName);
      fs.writeFileSync(dest, content, 'utf8');

      const result = fs.readFileSync(dest, 'utf8');
      expect(result).toContain('CodexTestProject');
      expect(result).not.toContain('{{PROJECT_NAME}}');
    });

    it('handles $ characters in project name safely', () => {
      const dest = path.join(tmpDir, 'test.md');
      fs.writeFileSync(dest, 'Hello {{PROJECT_NAME}}!');

      let content = fs.readFileSync(dest, 'utf8');
      const projectName = 'Test$&Project';
      content = content.replace(/\{\{PROJECT_NAME\}\}/g, () => projectName);
      fs.writeFileSync(dest, content, 'utf8');

      const result = fs.readFileSync(dest, 'utf8');
      expect(result).toBe('Hello Test$&Project!');
    });
  });

  describe('dry-run mode', () => {
    it('copyDirSync does not create files in dry-run', () => {
      const src = path.join(tmpDir, 'src');
      const dest = path.join(tmpDir, 'dest');
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'file.txt'), 'content');

      copyDirSync(src, dest, { dryRun: true });

      expect(fs.existsSync(dest)).toBe(false);
    });

    it('linkOrCopy does not create link in dry-run', () => {
      const target = path.join(tmpDir, 'target');
      const link = path.join(tmpDir, 'link');
      fs.mkdirSync(target);

      linkOrCopy(target, link, { dryRun: true });

      expect(fs.existsSync(link)).toBe(false);
    });
  });

  describe('version manifest', () => {
    it('writes .ai-dev-helm.json with version, tools, stacks and scope', () => {
      writeVersionManifest(tmpDir, {
        tools: ['claude-code', 'cursor'],
        stacks: ['nextjs-react'],
        skillScope: SKILL_SCOPE.ALL,
      });

      const manifestPath = path.join(tmpDir, '.ai-dev-helm.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const { version } = JSON.parse(
        fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')
      );
      expect(manifest.version).toBe(version);
      expect(manifest.tools).toEqual(['claude-code', 'cursor']);
      expect(manifest.stacks).toEqual(['nextjs-react']);
      expect(manifest.skillScope).toBe('all');
      expect(new Date(manifest.appliedAt).toString()).not.toBe('Invalid Date');
    });

    it('overwrites an existing manifest on re-run', () => {
      const manifestPath = path.join(tmpDir, '.ai-dev-helm.json');
      fs.writeFileSync(manifestPath, JSON.stringify({ version: '0.0.1' }));

      writeVersionManifest(tmpDir, {
        tools: ['codex'],
        stacks: [],
        skillScope: SKILL_SCOPE.CUSTOM,
      });

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(manifest.version).not.toBe('0.0.1');
      expect(manifest.tools).toEqual(['codex']);
      expect(manifest.skillScope).toBe('custom');
    });

    it('does not write the manifest in dry-run mode', () => {
      writeVersionManifest(
        tmpDir,
        { tools: ['cursor'], stacks: [], skillScope: SKILL_SCOPE.ALL },
        { dryRun: true }
      );

      expect(fs.existsSync(path.join(tmpDir, '.ai-dev-helm.json'))).toBe(false);
    });
  });

  describe('lint asset distribution', () => {
    const GENERIC_CATEGORIES = [
      'async',
      'error-handling',
      'hardcode',
      'security',
      'test-quality',
    ];

    it('copies generic categories, stack ast-grep, eslint and README for nextjs-react', () => {
      copyLintAssets(tmpDir, ['nextjs-react']);

      // Generic ast-grep category (stack-independent)
      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'ast-grep', 'error-handling'))
      ).toBe(true);
      // Stack-specific ast-grep rules land under lint/ast-grep/<stack>/
      expect(
        fs.existsSync(
          path.join(tmpDir, 'lint', 'ast-grep', 'nextjs-react', 'no-loop-query-prisma.yml')
        )
      ).toBe(true);
      // ESLint preset and its custom rules
      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'eslint', 'harness.config.mjs'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'eslint', 'rules', 'no-forwardref.js'))
      ).toBe(true);
      // Top-level lint README from shared/lint/README.md
      expect(fs.existsSync(path.join(tmpDir, 'lint', 'README.md'))).toBe(true);
      // Stack wiring guide
      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'README-nextjs-react.md'))
      ).toBe(true);
      // java-springboot assets must not appear
      expect(fs.existsSync(path.join(tmpDir, 'lint', 'checkstyle'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'lint', 'archunit'))).toBe(false);
    });

    it('copies checkstyle and archunit for java-springboot, without eslint', () => {
      copyLintAssets(tmpDir, ['java-springboot']);

      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'checkstyle', 'checkstyle.xml'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'archunit', 'ArchitectureRulesTest.java'))
      ).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'lint', 'eslint'))).toBe(false);
      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'ast-grep', 'nextjs-react'))
      ).toBe(false);
    });

    it('copies all generic categories regardless of stack selection', () => {
      copyLintAssets(tmpDir, []);

      for (const category of GENERIC_CATEGORIES) {
        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'ast-grep', category, 'README.md'))
        ).toBe(true);
      }
      expect(fs.existsSync(path.join(tmpDir, 'lint', 'README.md'))).toBe(true);
    });

    it('does not create lint/ in dry-run mode', () => {
      copyLintAssets(tmpDir, ['nextjs-react', 'java-springboot'], { dryRun: true });

      expect(fs.existsSync(path.join(tmpDir, 'lint'))).toBe(false);
    });

    it('preserves unrelated content under lint/ (merges, does not wipe)', () => {
      // Product-owned generated rule (lint/product/ is never touched by init)
      // and an unrelated top-level note. A re-run must not delete either.
      const productRule = path.join(tmpDir, 'lint', 'product', 'ast-grep', 'my-rule.yml');
      const topLevelNote = path.join(tmpDir, 'lint', 'CUSTOM-NOTES.md');
      fs.mkdirSync(path.dirname(productRule), { recursive: true });
      fs.writeFileSync(productRule, 'id: my-rule\n', 'utf8');
      fs.writeFileSync(topLevelNote, 'my product notes\n', 'utf8');

      copyLintAssets(tmpDir, ['nextjs-react']);

      expect(fs.existsSync(productRule)).toBe(true);
      expect(fs.readFileSync(productRule, 'utf8')).toBe('id: my-rule\n');
      expect(fs.existsSync(topLevelNote)).toBe(true);
      expect(fs.readFileSync(topLevelNote, 'utf8')).toBe('my product notes\n');
      // Package-managed assets still land alongside the preserved files.
      expect(fs.existsSync(path.join(tmpDir, 'lint', 'README.md'))).toBe(true);
    });

    it('copies a lint asset with byte-identical content, not just presence', () => {
      copyLintAssets(tmpDir, ['nextjs-react']);

      const copiedReadme = fs.readFileSync(path.join(tmpDir, 'lint', 'README.md'), 'utf8');
      const sourceReadme = fs.readFileSync(
        path.join(PACKAGE_ROOT, 'shared', 'lint', 'README.md'),
        'utf8'
      );
      expect(copiedReadme).toBe(sourceReadme);

      const copiedRule = fs.readFileSync(
        path.join(tmpDir, 'lint', 'ast-grep', 'nextjs-react', 'no-loop-query-prisma.yml'),
        'utf8'
      );
      const sourceRule = fs.readFileSync(
        path.join(PACKAGE_ROOT, 'stacks', 'nextjs-react', 'lint', 'ast-grep', 'no-loop-query-prisma.yml'),
        'utf8'
      );
      expect(copiedRule).toBe(sourceRule);
    });

    describe('mutation assets', () => {
      it('distributes stryker config to lint/mutation/ for nextjs-react', () => {
        copyLintAssets(tmpDir, ['nextjs-react']);

        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'stryker.config.mjs'))
        ).toBe(true);
      });

      it('distributes the diff-scope config and its range helper next to the stryker config', () => {
        copyLintAssets(tmpDir, ['nextjs-react']);

        // stryker.diff.config.mjs imports ./stryker.config.mjs and
        // ./changed-ranges.mjs by relative path, so all three must land in
        // the same lint/mutation/ directory.
        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'stryker.diff.config.mjs'))
        ).toBe(true);
        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'changed-ranges.mjs'))
        ).toBe(true);
      });

      it('distributes pitest gradle to lint/mutation/ for java-springboot', () => {
        copyLintAssets(tmpDir, ['java-springboot']);

        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'pitest.gradle'))
        ).toBe(true);
      });

      it('does not distribute a non-selected stack mutation asset', () => {
        copyLintAssets(tmpDir, ['nextjs-react']);

        // java-springboot's mutation asset must not appear when only
        // nextjs-react is selected.
        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'pitest.gradle'))
        ).toBe(false);
      });

      it('merges both stacks mutation assets without collision (multi-stack)', () => {
        copyLintAssets(tmpDir, ['nextjs-react', 'java-springboot']);

        // Both distinct filenames coexist in the shared lint/mutation/ dir;
        // neither clobbers the other (collision regression guard).
        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'stryker.config.mjs'))
        ).toBe(true);
        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'pitest.gradle'))
        ).toBe(true);
      });

      it('does not create lint/mutation/ in dry-run mode', () => {
        copyLintAssets(tmpDir, ['nextjs-react', 'java-springboot'], { dryRun: true });

        expect(fs.existsSync(path.join(tmpDir, 'lint', 'mutation'))).toBe(false);
      });
    });
  });

  describe('skills link creation', () => {
    it('creates link or copy from skills to .claude/skills', () => {
      const skillsDir = path.join(tmpDir, 'skills');
      fs.mkdirSync(skillsDir);
      fs.writeFileSync(path.join(skillsDir, 'test.md'), 'skill content');

      const linkPath = path.join(tmpDir, '.claude', 'skills');
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });

      linkOrCopy(skillsDir, linkPath);

      expect(fs.existsSync(path.join(linkPath, 'test.md'))).toBe(true);
    });
  });

  describe('test-recommendation ledger seeding', () => {
    it('seeds the ledger when missing', () => {
      const created = seedTestRecommendationLedger(tmpDir, {});
      const dest = path.join(tmpDir, 'documents', 'development', 'test-recommendation-ledger.md');
      expect(created).toBe(true);
      const content = fs.readFileSync(dest, 'utf8');
      expect(content).toContain('# Test Recommendation Ledger');
      // The skill depends on this format contract - a truncated template
      // must fail the test rather than silently ship a broken ledger.
      expect(content).toContain('## E2E シナリオ未整備の導線');
      expect(content).toContain('## ミューテーション見送り履歴');
      expect(content).toContain('pending');
      expect(content).toContain('scenario_added');
      expect(content).toContain('dismissed');
    });

    it('never overwrites an existing ledger (accumulated history)', () => {
      const dest = path.join(tmpDir, 'documents', 'development', 'test-recommendation-ledger.md');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'PRODUCT HISTORY');
      const created = seedTestRecommendationLedger(tmpDir, {});
      expect(created).toBe(false);
      expect(fs.readFileSync(dest, 'utf8')).toBe('PRODUCT HISTORY');
    });

    it('does nothing on dry-run', () => {
      const created = seedTestRecommendationLedger(tmpDir, { dryRun: true });
      expect(fs.existsSync(path.join(tmpDir, 'documents'))).toBe(false);
      expect(created).toBe(false);
    });

    it('does not throw when the destination tree is unusable (init must not abort)', () => {
      // `documents` exists as a FILE, not a directory - mkdirSync(dirname(dest))
      // fails with ENOTDIR. seedTestRecommendationLedger must swallow this and
      // let the rest of doInit continue.
      fs.writeFileSync(path.join(tmpDir, 'documents'), 'not a directory');

      expect(() => seedTestRecommendationLedger(tmpDir, {})).not.toThrow();
      expect(seedTestRecommendationLedger(tmpDir, {})).toBe(false);
    });

    it('ledger template is NOT under shared/documents (would be clobbered by the refresh copy)', () => {
      // shared/documents/ -> documents/development/ is a copyDirSync refresh
      // that OVERWRITES on every re-init. The ledger template must live only
      // under templates/ (copy-if-missing), never under shared/documents/,
      // or a re-init would wipe accumulated ledger history.
      expect(
        fs.existsSync(path.join(PACKAGE_ROOT, 'shared', 'documents', 'test-recommendation-ledger.md'))
      ).toBe(false);
    });

    it('SKILL.md embedded ledger skeleton matches the distributed template', () => {
      // The ledger format is dual-sourced: the fenced skeleton in the
      // test-recommendation SKILL.md (generate-if-missing fallback) and
      // templates/test-recommendation-ledger.md.template (init copy-if-missing).
      // They must stay byte-equivalent (modulo line endings) or the two
      // seeding paths diverge.
      const skillSource = fs
        .readFileSync(
          path.join(PACKAGE_ROOT, 'skills', 'project', 'test-recommendation', 'SKILL.md'),
          'utf8'
        )
        .replace(/\r\n/g, '\n');
      const headingIdx = skillSource.indexOf('### 台帳雛形');
      expect(headingIdx).toBeGreaterThan(-1);
      const fenceOpen = skillSource.indexOf('```', headingIdx);
      expect(fenceOpen).toBeGreaterThan(-1);
      const contentStart = skillSource.indexOf('\n', fenceOpen) + 1;
      const fenceClose = skillSource.indexOf('\n```', contentStart);
      expect(fenceClose).toBeGreaterThan(-1);
      const embedded = skillSource.slice(contentStart, fenceClose + 1);

      const template = fs
        .readFileSync(
          path.join(PACKAGE_ROOT, 'templates', 'test-recommendation-ledger.md.template'),
          'utf8'
        )
        .replace(/\r\n/g, '\n');

      expect(embedded).toBe(template);
    });

    it('doInit wires the ledger seeding (call site exists)', () => {
      // Regression guard: deleting the doInit call site leaves every unit
      // test above green (they call seedTestRecommendationLedger directly),
      // so assert the wiring itself against the init.js source.
      const source = fs.readFileSync(path.join(__dirname, 'init.js'), 'utf8');
      expect(source).toMatch(/seedTestRecommendationLedger\(projectDir,\s*\{\s*dryRun\s*\}\)/);
    });
  });

  describe('action-required warning recap', () => {
    // ensureClaudeGateRegistration/upgradeCodexHooksFile now return an
    // ACTION REQUIRED warning when a settings.json/hooks.json shape they
    // don't understand leaves the gate unregistered. That warning must not
    // only be printed at the point of failure (easy to miss mid-run) but
    // also collected and reprinted right before the closing "Setup
    // complete!" line. doInit itself isn't unit-testable (it drives an
    // interactive prompter), so this pins the wiring the same way the
    // ledger-seeding regression guard above does.
    it('doInit collects setupClaudeCode/setupCodex warnings and reprints them before "Setup complete!" (call site exists)', () => {
      const source = fs.readFileSync(path.join(__dirname, 'init.js'), 'utf8');
      expect(source).toMatch(/actionRequiredWarnings\.push\(\.\.\.setupClaudeCode\(/);
      expect(source).toMatch(/actionRequiredWarnings\.push\(\.\.\.setupCodex\(/);

      const recapIdx = source.indexOf('actionRequiredWarnings.forEach');
      const completeIdx = source.indexOf("'Setup complete!'");
      expect(recapIdx).toBeGreaterThan(-1);
      expect(completeIdx).toBeGreaterThan(-1);
      expect(recapIdx).toBeLessThan(completeIdx);
    });
  });
});
