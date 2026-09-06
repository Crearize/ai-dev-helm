const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../bin/cli.js');
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-diagnostics-cli-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 15000 });

test('report CLI emits parseable migration data without modifying the source', () => {
  const file = path.join(dir, 'report.json');
  const original = '\uFEFF' + JSON.stringify({ cycles: [{ findings: [
    { source: 'qa', description: 'No findings', severity: '高' },
    { source: 'qa', sources: ['integrated-reviewer'], description: 'Expired session accepted', action: '対応済' },
  ] }] });
  fs.writeFileSync(file, original);
  const result = run('quality-report', '--input', file);
  expect(result.status, result.stderr).toBe(0);
  const findings = JSON.parse(result.stdout).cycles[0].findings;
  expect(findings).toHaveLength(1);
  expect(findings[0].sources).toEqual(['qa', 'integrated-reviewer']);
  expect(findings[0].adjudication).toBe('unknown');
  expect(result.stderr).toMatch(/placeholder/);
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
});

test('malformed report fails without a successful-looking JSON result', () => {
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{"cycles":null}');
  const result = run('quality-report', '--input', file);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/cycles must be an array/);
});

test('inventory command explicitly distinguishes disk observation from runtime evidence', () => {
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'custom domain invariant');
  const result = run('harness-inventory', '--dir', dir);
  expect(result.status, result.stderr).toBe(0);
  const inventory = JSON.parse(result.stdout);
  expect(inventory.observation).toBe('on_disk_inventory');
  expect(inventory.runtime_metrics).toBeNull();
  expect(JSON.stringify(inventory)).not.toContain('custom domain invariant');
  expect(fs.readdirSync(dir)).toEqual(['CLAUDE.md']);
});
