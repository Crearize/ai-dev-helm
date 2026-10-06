'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CASES_FILE = path.join(__dirname, '..', 'templates', 'hooks', 'selftest-cases.json');
const HOOK_FILES = { 'quality-gate': 'quality-gate.cjs', 'review-budget': 'review-budget.cjs' };

function decide(stdout) {
  try {
    const out = JSON.parse(stdout);
    if (out.decision === 'block' || (out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny')) return 'deny';
  } catch { /* empty or non-JSON stdout means no objection */ }
  return 'allow';
}

// A throwaway repo on a feature branch with a code commit and an origin/main ref, so the
// gates see an ordinary unreviewed feature branch (no .quality-check-passed flag).
function makeScratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-hook-selftest-'));
  const g = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'app.js'), '1\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  g('checkout', '-q', '-b', 'feat/x');
  fs.writeFileSync(path.join(dir, 'code.js'), 'x\n');
  g('add', '.');
  g('commit', '-q', '-m', 'code');
  return dir;
}

function runHookSelftest({ dir = process.cwd() } = {}) {
  const projectDir = path.resolve(dir);
  const cases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
  const lines = [];
  let failed = 0;
  let ran = 0;
  const scratch = makeScratchRepo();
  try {
    for (const [hook, file] of Object.entries(HOOK_FILES)) {
      const installed = ['.claude', '.codex']
        .map((runtime) => ({ runtime, script: path.join(projectDir, runtime, 'hooks', file) }))
        .filter((c) => fs.existsSync(c.script));
      if (!installed.length) {
        lines.push(`${hook}: not installed (.claude/hooks/${file} or .codex/hooks/${file}); skipped`);
        continue;
      }
      for (const { runtime, script } of installed) {
        let bad = 0;
        for (const c of cases[hook]) {
          const input = c.raw !== undefined ? c.raw : JSON.stringify({ cwd: scratch, hook_event_name: 'PreToolUse', ...(c.event || { tool_name: 'Bash', tool_input: { command: c.command } }) });
          const run = spawnSync(process.execPath, [script], { cwd: scratch, input, encoding: 'utf8', timeout: 30000 });
          const got = decide(run.stdout || '');
          ran += 1;
          if (got !== c.expect) {
            bad += 1;
            lines.push(`FAIL ${runtime}/${hook}: ${c.name} (expected ${c.expect}, got ${got}${run.error ? `; ${run.error.message}` : ''})`);
          }
        }
        failed += bad;
        lines.push(`${runtime}/hooks/${file}: ${cases[hook].length - bad}/${cases[hook].length} cases passed`);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  if (!ran) {
    lines.push(`ACTION REQUIRED: no installed hook found; run \`npx -y @crearize/ai-dev-helm@${require('../package.json').version} init\` (or harness-upgrade) first.`);
    return { lines, exitCode: 1, failed, ran };
  }
  lines.push(failed ? `ACTION REQUIRED: ${failed} case(s) failed; the installed hook differs from the distributed behavior. Update it (harness-upgrade).` : 'hook-selftest: all cases passed');
  return { lines, exitCode: failed ? 1 : 0, failed, ran };
}

module.exports = { runHookSelftest };
