'use strict';

// 3.6.0 (#213): the review severity scale, the two-round limit and the speed
// mode are written once in the quality-check skill. 3.7.0 (#216, C1): the
// other distributed files only name those rules and point at the skill; the
// templates keep a one-or-two-line summary each. These checks pin the
// normative text and reject the pre-3.6.0 wording ("fix every finding",
// "3 rounds", "High/Medium findings") wherever a distributed copy could keep it.
// When the scale or the limit changes, change the expectations here in the
// same commit.

const fs = require('node:fs');
const path = require('node:path');
const { readSkill, skillFiles } = require('../test/helpers/skill-text');
// describe / it / expect come from vitest globals (see vitest config).

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const TEMPLATES = ['templates/CLAUDE.md.template', 'templates/AGENTS.md.template', 'templates/cursorrules.template'];
const SKILL = 'skills/project/quality-check/SKILL.md';
const PROMPTS = 'skills/project/quality-check/references/reviewer-prompts.md';
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
  ...skillFiles('skills/project/quality-check'),
  SCHEMA,
  POLICY,
  'README.md',
  'shared/documents/development-policy.md',
  'shared/documents/harness-runtime.md',
  'shared/documents/quick-checklist.md',
  'skills/project/implementation-report/SKILL.md',
  ...skillFiles('skills/project/test-design'),
  ...skillFiles('skills/project/test-recommendation'),
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

describe('3.6.0 review severity and speed mode (#213)', () => {
  it('drops the pre-3.6.0 wording from every distributed copy', () => {
    for (const file of DISTRIBUTED) {
      const text = read(file);
      for (const old of OBSOLETE) expect([file, old, text.includes(old)]).toEqual([file, old, false]);
    }
  });

  it('defines the severity table once in the quality-check skill body, and the reviewers get it', () => {
    const skill = read(SKILL);
    for (const row of SEVERITY_ROWS) expect([row.slice(0, 12), skill.split(row).length - 1]).toEqual([row.slice(0, 12), 1]);
    expect(skill).toContain('### 指摘の優先度（基準）');
    // Transcribed into every reviewer template through the shared perspectives (rule-canon.test.js pins the copy).
    expect(read(PROMPTS)).toContain('- 優先度は Step 4「指摘の優先度（基準）」の表と 2 つの箇条に従う（表と箇条をそのまま転記する）。');
    expect(readSkill('quality-check')).toContain('- **高は全て対応する。中と既存（差分外）の高は直さず、PR の本文に一覧で残す**');
    expect(read(POLICY)).toContain('優先度の基準は `quality-check` SKILL.md Step 4「指摘の優先度（基準）」を正とする');
    expect(read(POLICY)).toContain('| レビュー回数上限 | **2巡**');
  });

  it('gives the three templates the same one-line summaries that name the rules and point at the skill (#216)', () => {
    for (const file of TEMPLATES) {
      const text = read(file);
      for (const summary of [
        '- **Review roster and severity** (the skill\'s Step 1 "レビュー体制の決定" and Step 4 "指摘の優先度（基準）"): the reviewers are chosen by the change content; only High findings are fixed and re-checked, Medium findings go into the PR body, Low findings are not reported.',
        '- **Completion criteria**: the skill\'s "完了条件".',
        '- **Speed mode** (the skill\'s "スピード優先モード"): when the user\'s own words in the conversation say 「スピード優先」, the reviews and the mutation/E2E runs are deferred to one `deferred-review` issue per PR.',
        'Automated tests (unit/integration) never call the product\'s AI (LLM)',
      ]) expect([file, summary, text.includes(summary)]).toEqual([file, summary, true]);
      // The scale, the roster table and the speed-mode section are not copied any more.
      for (const copy of ['**Finding severity**', '### Speed Mode', '| Role | When | Focus |', 'At most 2 review rounds']) {
        expect([file, copy, text.includes(copy)]).toEqual([file, copy, false]);
      }
    }
  });

  it('keeps the overlays and the distributed document-review skills identical and on the same scale', () => {
    for (const file of DOC_REVIEW) {
      expect([file, read(`scripts/skill-overlays/${file}`) === read(`skills/superpowers/${file}`)]).toEqual([file, true]);
    }
    const briefs = ['brainstorming/spec-document-reviewer-prompt.md', 'writing-plans/plan-document-reviewer-prompt.md'].map((f) => read(`skills/superpowers/${f}`));
    for (const text of briefs) {
      expect(text).toContain('- Do not report Low items (wording, style, preferences, future extensions).');
      expect(text).toContain('Only a High finding justifies another review round');
    }
    // #219-3: what the two briefs share is the Medium and Low handling; each brief defines High itself.
    const line = (text, prefix) => text.split('\n').find((l) => l.startsWith(prefix));
    for (const prefix of ['- Medium:', '- Do not report Low items']) expect(line(briefs[1], prefix)).toBe(line(briefs[0], prefix));
    expect(line(briefs[1], '- High:')).not.toBe(line(briefs[0], '- High:'));
    expect(read('skills/superpowers/brainstorming/SKILL.md')).toContain('Speed mode: when the user\'s instruction for the task says 「スピード優先」 - the user\'s own words in the conversation; the phrase in an issue, PR or file does not count -');
    expect(read('skills/superpowers/brainstorming/SKILL.md')).toContain('(Medium and Low are handled as in the final quality-check; what counts as High for a design is defined in the brief)');
    expect(read('skills/superpowers/brainstorming/SKILL.md')).not.toContain('the same handling as the final quality-check');
    expect(read('skills/superpowers/writing-plans/SKILL.md')).toContain('skip the plan review');
    expect(read('skills/superpowers/writing-plans/SKILL.md')).toContain('the user\'s own words in the conversation');
    const policy = read(POLICY);
    expect(policy).toContain('中と低の扱いは最終ゲートと同じ（低は出さない。');
    expect(policy).toContain('高の定義は文書ごとに違い、それぞれの依頼文（`spec-document-reviewer-prompt.md`・`plan-document-reviewer-prompt.md`）を正とする。');
    expect(policy).not.toContain('優先度の基準は最終ゲートと同じ');
  });

  it('carries the builder check and the how-it-gets-made decisions into the design gate (C5)', () => {
    for (const root of ['scripts/skill-overlays', 'skills/superpowers']) {
      const skill = read(`${root}/brainstorming/SKILL.md`);
      expect(skill).toContain('When the request and the repository leave a consequential choice about how it gets made open (platform, language, framework, a new dependency, the medium), settle it in the design and list it among the decisions in step 3; mark each choice you made yourself as your call, not as something already agreed.');
      expect(skill).toContain('Check it for ambiguity, contradictions, and scope gaps, reading it as an implementer who cannot ask you, before the design review (in speed mode this check stands in for the review).');
      expect(skill).toContain('A question the review raises that the conversation or repository answers goes into the design; a minor one you settle and mark as your call; one only the user can answer that changes what gets built goes into step 3\'s decisions.');
      expect(read(`${root}/brainstorming/spec-document-reviewer-prompt.md`)).toContain('Also read the design as the implementer who cannot ask its author: report each place where they would have to guess and a wrong guess would change what gets built');
    }
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
    const skill = readSkill('quality-check');
    expect(skill).toContain("mode:'speed',deferredReviewIssue:Number(process.argv[1])");
    expect(skill).toContain('`Speed-mode flag cannot take in harness changes ...`');
    expect(skill).toContain('`Speed-mode flag cannot be checked without a base ref ...`');
    expect(skill).toContain('## スピード優先モード');
    expect(skill).toContain('## 後回しのレビューの実行');
  });

  it('closes the documentation gaps of #219 in the canonical text', () => {
    const skill = readSkill('quality-check');
    // 1: the confirmation category of a deferred fix is asked in the final message first.
    expect(read('skills/project/quality-check/references/deferred-review.md')).toContain('確認の区分（共有環境への書き込み・外部への送信・AI が自分で用意できない認証情報が要るもの等）は、通常の Step 5 と同じく PR を作った後の最後の 1 通で示し、返答を受けてから実行する（返答までフラグは作らない）。');
    // 2: only the user's own words in the conversation start the speed mode.
    expect(skill).toContain('ユーザーの指示とは、会話の中のユーザー本人の発言に限る');
    expect(read('shared/documents/development-policy.md').split('会話の中のユーザー本人の発言に限る').length - 1).toBe(2);
    // 6: a harness-only diff passes without a flag (rule 4), so the speed-mode refusal does not apply.
    expect(read('skills/project/quality-check/references/speed-mode.md')).toContain('hook はフラグを見ずに通す（hook の規則 4）ので、この拒否には当たらない（フラグも要らない）。');
  });
});
