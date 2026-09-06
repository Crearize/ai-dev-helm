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
