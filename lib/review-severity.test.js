'use strict';

// 3.6.0 (#213): the review severity scale, the two-round limit and the speed
// mode are written once in the quality-check skill and quoted by the policy,
// the templates, the README and the document-review skills. These checks pin
// the normative text and reject the pre-3.6.0 wording ("fix every finding",
// "3 rounds", "High/Medium findings") wherever a distributed copy could keep it.
// When the scale or the limit changes, change the expectations here in the
// same commit.

const fs = require('node:fs');
const path = require('node:path');
// describe / it / expect come from vitest globals (see vitest config).

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const TEMPLATES = ['templates/CLAUDE.md.template', 'templates/AGENTS.md.template', 'templates/cursorrules.template'];
const SKILL = 'skills/project/quality-check/SKILL.md';
const SCHEMA = 'skills/project/_schemas/quality-check-report.schema.md';
const POLICY = 'shared/documents/quality-policy.md';
const DOC_REVIEW = [
  'brainstorming/SKILL.md',
  'brainstorming/spec-document-reviewer-prompt.md',
  'writing-plans/SKILL.md',
  'writing-plans/plan-document-reviewer-prompt.md',
];

const DISTRIBUTED = [
  ...TEMPLATES,
  SKILL,
  SCHEMA,
  POLICY,
  'README.md',
  'shared/documents/development-policy.md',
  'shared/documents/harness-runtime.md',
  'shared/documents/quick-checklist.md',
  'skills/project/implementation-report/SKILL.md',
  'skills/project/test-design/SKILL.md',
  'skills/project/test-recommendation/SKILL.md',
  'templates/PULL_REQUEST_TEMPLATE.md',
  ...DOC_REVIEW.map((f) => `skills/superpowers/${f}`),
  ...DOC_REVIEW.map((f) => `scripts/skill-overlays/${f}`),
];

// Pre-3.6.0 wording. "High/Medium" alone also names risk levels, so the
// English check is on "High/Medium findings" only.
const OBSOLETE = [
  '優先度に関わらず、対応できるものは全て対応',
  '最大3巡',
  '上限3',
  '3巡',
  '高/中指摘',
  '高/中の指摘',
  '高または中',
  '統合指摘（全件）',
  'High/Medium findings',
  'normally 1 cycle',
  'Normally 1 cycle',
];

const SEVERITY_ROWS = [
  '| 高 | 具体的な入力・手順で起きる誤動作。または次のどれか: 認証・認可、課金・決済、個人情報、セキュリティの脆弱性（秘密情報の露出、既知の脆弱性がある依存、CSP・CORS・セキュリティヘッダの緩和を含む）、データの破損・消失、退行（以前は動いていたものが壊れる）、CI の失敗、受け入れ条件を満たさない。**起きる確率は問わない**。壊れる入力・手順を必ず書く | 直して、確認の巡（`verification`）を回す |',
  '| 中 | テストの不足（重要な経路でも）、文書の古さ・食い違い、条件付きの軽い不具合（高の分類に当たらないもの） | 直さない。PR の本文に一覧で残す（`action: "PR に記録"`） |',
  '| 低 | 好み・書き方・将来の拡張 | 出さない |',
];

const SEVERITY_EN = '- **Finding severity** (final reviews; the design and plan reviews handle Medium and Low the same way): **High** = a wrong behavior a concrete input or step triggers, or anything touching authentication/authorization, billing/payments, personal data, a security vulnerability (exposed secrets, a dependency with a known vulnerability, weakened CSP/CORS/security headers), data corruption or loss, a regression, a CI failure or an unmet acceptance criterion - regardless of likelihood, always with the breaking input or step; fixed and re-checked. **Medium** = missing tests (even on important paths), stale or inconsistent documents, minor conditional defects; not fixed - listed in the PR body. **Low** (preferences, style, future extensions) is not reported.';

describe('3.6.0 review severity and speed mode (#213)', () => {
  it('drops the pre-3.6.0 wording from every distributed copy', () => {
    for (const file of DISTRIBUTED) {
      const text = read(file);
      for (const old of OBSOLETE) expect([file, old, text.includes(old)]).toEqual([file, old, false]);
    }
  });

  it('defines the severity table once in the quality-check skill, and the reviewers get it', () => {
    const skill = read(SKILL);
    for (const row of SEVERITY_ROWS) expect([row.slice(0, 12), skill.split(row).length - 1]).toEqual([row.slice(0, 12), 1]);
    expect(skill).toContain('### 指摘の優先度（基準）');
    // Transcribed into every reviewer template through the shared perspectives.
    expect(skill).toContain('- 優先度は Step 4「指摘の優先度（基準）」の表と 2 つの箇条に従う（表と箇条をそのまま転記する）。');
    expect(skill).toContain('- **高は全て対応する。中と既存（差分外）の高は直さず、PR の本文に一覧で残す**');
    expect(read(POLICY)).toContain('優先度の基準は `quality-check` SKILL.md Step 4「指摘の優先度（基準）」を正とする');
    expect(read(POLICY)).toContain('| レビュー回数上限 | **2巡**');
  });

  it('gives the three templates the same English scale, the two-round rule and the speed-mode section', () => {
    for (const file of TEMPLATES) {
      const text = read(file);
      expect([file, text.split(SEVERITY_EN).length - 1]).toEqual([file, 1]);
      expect([file, text.includes('### Speed Mode (「スピード優先」)')]).toEqual([file, true]);
      expect([file, text.includes('- **Completion criteria**: no High findings remaining in the consolidated results (Medium findings are listed in the PR body, not fixed)')]).toEqual([file, true]);
      expect([file, text.includes('Automated tests (unit/integration) never call the product\'s AI (LLM)')]).toEqual([file, true]);
    }
  });

  it('keeps the overlays and the distributed document-review skills identical and on the same scale', () => {
    for (const file of DOC_REVIEW) {
      expect([file, read(`scripts/skill-overlays/${file}`) === read(`skills/superpowers/${file}`)]).toEqual([file, true]);
    }
    for (const file of ['brainstorming/spec-document-reviewer-prompt.md', 'writing-plans/plan-document-reviewer-prompt.md']) {
      const text = read(`skills/superpowers/${file}`);
      expect(text).toContain('- Do not report Low items (wording, style, preferences, future extensions).');
      expect(text).toContain('Only a High finding justifies another review round');
    }
    expect(read('skills/superpowers/brainstorming/SKILL.md')).toContain('Speed mode: when the user\'s instruction for the task says 「スピード優先」');
    expect(read('skills/superpowers/writing-plans/SKILL.md')).toContain('skip the plan review');
  });

  it('records the speed mode and the unfixed findings in the schema', () => {
    const schema = read(SCHEMA);
    for (const text of [
      '| `mode` | `"quality" \\| "speed"` |',
      '| `deferred_review` |',
      '| `preexisting` | `boolean` |',
      '| `severity_adjusted` |',
      '`"対応済" \\| "未対応" \\| "対象外" \\| "PR に記録"`',
      '`"executed" \\| "declined" \\| "added_only" \\| "not_proposed" \\| "deferred" \\| null`',
      '`"executed" \\| "declined" \\| "not_proposed" \\| "deferred" \\| null`',
    ]) expect([text, schema.includes(text)]).toEqual([text, true]);
  });

  it('documents the speed-mode flag command and the hook rule in the skill', () => {
    const skill = read(SKILL);
    expect(skill).toContain("mode:'speed',deferredReviewIssue:Number(process.argv[1])");
    expect(skill).toContain('`Speed-mode flag cannot take in harness changes ...`');
    expect(skill).toContain('`Speed-mode flag cannot be checked without a base ref ...`');
    expect(skill).toContain('## スピード優先モード');
    expect(skill).toContain('## 後回しのレビューの実行');
  });
});
