const { normalizeQualityReport } = require('./quality-report');

test('removes exact legacy no-finding placeholders without changing input', () => {
  const input = { cycles: [{ findings: [{ source: 'QA', severity: '高', description: '✅ 指摘なし' }] }] };
  const before = JSON.stringify(input);
  const result = normalizeQualityReport(input);
  expect(result.report.cycles[0].findings).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(JSON.stringify(input)).toBe(before);
});

test('preserves detection provenance and never infers adjudication from action', () => {
  const finding = { source: 'architect', sources: ['QA', 'QA'], description: 'real issue', action: '対応済', severity: '高', detail: 'evidence' };
  const { report } = normalizeQualityReport({ cycles: [{ findings: [finding] }], custom: true });
  expect(report.cycles[0].findings[0]).toEqual({ ...finding, sources: ['architect', 'QA'], adjudication: 'unknown', recurrence: 'unknown' });
  expect(report.custom).toBe(true);
});

test('does not merge similar descriptions or remove substantive no-findings prose', () => {
  const { report } = normalizeQualityReport([{ description: '指摘なしと誤表示する', source: 'QA' }, { description: '指摘なしと誤表示する', source: 'design' }]);
  expect(report).toHaveLength(2);
});

test.each([
  { cycles: [{ findings: null }] },
  [{ description: 'issue', sources: 'QA' }],
  [{ description: 'issue', adjudication: 'maybe' }],
  [{ description: 'issue', recurrence: 'yes' }],
  [{ description: 'issue', sources: [''] }],
])('rejects malformed findings instead of silently dropping data: %j', (input) => {
  expect(() => normalizeQualityReport(input)).toThrow();
});

test('supports top-level findings and retains explicit adjudication and recurrence', () => {
  const { report } = normalizeQualityReport({ findings: [{ description: 'issue', sources: ['QA'], adjudication: 'false_positive', recurrence: 'repeated' }] });
  expect(report.findings[0]).toMatchObject({ adjudication: 'false_positive', recurrence: 'repeated', sources: ['QA'] });
});

test('missing findings are unknown, not synthesized into an empty success result', () => {
  expect(() => normalizeQualityReport({ cycles: [{}] })).toThrow(/findings/);
  expect(() => normalizeQualityReport({})).toThrow(/findings/);
});

test('H-33: a harness-update test_design record (out_of_scope with reason) passes through; schema defines it', () => {
  const fs = require('fs');
  const path = require('path');
  const testDesign = { status: 'out_of_scope', reason: 'harness update, no product code', memo_path: null, gaps_addressed: 0 };
  const { report } = normalizeQualityReport({ test_design: testDesign, cycles: [{ findings: [] }] });
  expect(report.test_design).toEqual(testDesign);
  const schema = fs.readFileSync(path.join(__dirname, '..', 'skills', 'project', '_schemas', 'quality-check-report.schema.md'), 'utf8');
  expect(schema).toContain('"status":"out_of_scope","reason"');
  expect(schema).toContain('`retroactive` は、製品のコードのテストを実装の後に設計した場合だけ');
});
