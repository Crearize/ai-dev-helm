const fs = require('fs');
const os = require('os');
const path = require('path');
const { runHookSelftest } = require('./hook-selftest');

const HOOKS = path.join(__dirname, '..', 'templates', 'hooks');
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-selftest-proj-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function install(runtime = '.claude') {
  const target = path.join(dir, runtime, 'hooks');
  fs.mkdirSync(target, { recursive: true });
  for (const f of ['quality-gate.cjs', 'review-budget.cjs']) fs.copyFileSync(path.join(HOOKS, f), path.join(target, f));
  return target;
}

test('the table stays in sync with the distributed hooks (drift detector)', () => {
  install();
  const result = runHookSelftest({ dir });
  expect(result.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
  expect(result.exitCode).toBe(0);
  expect(result.ran).toBeGreaterThanOrEqual(20);
}, 60000);

test('a deliberately broken hook fails the self-test', () => {
  const hooks = install();
  fs.writeFileSync(path.join(hooks, 'quality-gate.cjs'), 'process.stdin.resume();process.stdin.on("end",()=>{});\n');
  const result = runHookSelftest({ dir });
  expect(result.exitCode).toBe(1);
  expect(result.lines.some((l) => l.startsWith('FAIL .claude/quality-gate'))).toBe(true);
}, 60000);

test('nothing installed is an action-required failure, not a silent pass', () => {
  const result = runHookSelftest({ dir });
  expect(result.exitCode).toBe(1);
  expect(result.lines.join('\n')).toContain('ACTION REQUIRED');
});
